import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

// What each part of the page needs, and which events can change it. Events
// only refetch the parts they touch; the 40 KB marketplace list in particular
// only reloads when listings or scorecards can have changed.
const PARTS = {
  pains: () => api.pains(),
  bounties: () => api.bounties(),
  settlement: () => api.settlement(),
  ledger: () => api.ledger(),
  credits: () => api.credits().catch(() => null),
  connection: () => api.connection(),
  agents: () => api.agents(),
  market: () => api.marketplace({ limit: 200 }).then((m) => m.items).catch(() => []),
  health: () => api.health(),
  me: () => api.me().catch(() => null),
};
const ALL = Object.keys(PARTS);
const CORE = ['pains', 'bounties', 'settlement', 'ledger', 'credits'];
const partsFor = (events) => {
  const parts = new Set(CORE);
  for (const { type } of events) {
    if (/^(connect|sync|scan|reset)/.test(type)) parts.add('connection');
    if (/^(agent|marketplace|bounty\.(competing|winner|surviving|settled|clawed_back|failed)|verify\.passed|survival)/.test(type)) { parts.add('agents'); parts.add('market'); }
    if (/^auth\./.test(type)) { parts.add('me'); parts.add('health'); }
  }
  return [...parts];
};

// Follows the event log and refreshes server state when something relevant happens.
// While the tab is visible it long-polls: the server answers as soon as there's a
// new event. Hidden tabs check every few seconds instead of holding a connection.
export function useShoal() {
  const [s, setS] = useState({ events: [], pains: [], bounties: [], agents: [], market: [], settlement: null, ledger: [], credits: null, connection: null, health: null, me: null });
  const last = useRef(0);
  // One refresh at a time; parts asked for meanwhile are fetched right after it.
  const busy = useRef(null), queued = useRef(new Set());
  const load = useCallback(async (parts = ALL) => {
    parts.forEach((p) => queued.current.add(p));
    if (busy.current) return busy.current;
    busy.current = (async () => {
      try {
        while (queued.current.size) {
          const want = [...queued.current];
          queued.current.clear();
          const got = await Promise.all(want.map((p) => PARTS[p]()));
          setS((prev) => ({ ...prev, ...Object.fromEntries(want.map((p, i) => [p, got[i]])) }));
        }
      } finally {
        busy.current = null;
      }
    })();
    return busy.current;
  }, []);
  const refresh = useCallback(() => load(ALL), [load]);

  useEffect(() => {
    let alive = true, t, stale = false, waiting = false;
    // A failed load (e.g. the server was down) is retried on the next poll.
    const reload = (parts) => load(parts).then(() => { stale = false; }, () => { stale = true; });
    reload(ALL);
    const tick = async () => {
      const visible = document.visibilityState === 'visible';
      waiting = true;
      try {
        const { events, last: l } = await api.events(last.current, visible ? 20 : 0);
        waiting = false;
        if (!alive) return;
        if (l < last.current) {
          // Event ids start over when the server restarts: drop the old log and reload everything.
          last.current = 0;
          setS((p) => ({ ...p, events: [] }));
          reload(ALL);
        } else {
          last.current = l;
          if (events.length) {
            setS((p) => ({ ...p, events: [...p.events, ...events].slice(-300) }));
            reload(partsFor(events));
          } else if (stale) reload(ALL);
        }
        t = setTimeout(tick, visible ? 0 : 4000);
      } catch {
        waiting = false;
        stale = true;
        if (alive) t = setTimeout(tick, 2000);
      }
    };
    tick();
    // Coming back to the tab (say, after signing in to GitHub elsewhere) reloads
    // everything and switches from slow checks back to long-polling.
    const onShow = () => {
      if (document.visibilityState !== 'visible') return;
      reload(ALL);
      // A request already out comes back and picks the right mode by itself.
      if (waiting) return;
      clearTimeout(t);
      t = setTimeout(tick, 0);
    };
    document.addEventListener('visibilitychange', onShow);
    return () => { alive = false; clearTimeout(t); document.removeEventListener('visibilitychange', onShow); };
  }, [load]);
  return { ...s, refresh };
}
