import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

// Polls the event log and refreshes server state when something relevant happens.
export function useShoal() {
  const [s, setS] = useState({ events: [], pains: [], bounties: [], agents: [], market: [], settlement: null, ledger: [], credits: null, connection: null, health: null, me: null });
  const last = useRef(0);
  const refresh = useCallback(async () => {
    const [pains, bounties, agents, market, settlement, ledger, credits, connection, health, me] = await Promise.all([
      api.pains(), api.bounties(), api.agents(), api.marketplace({ limit: 200 }).then((m) => m.items).catch(() => []), api.settlement(), api.ledger(), api.credits().catch(() => null), api.connection(), api.health(), api.me().catch(() => null),
    ]);
    setS((p) => ({ ...p, pains, bounties, agents, market, settlement, ledger, credits, connection, health, me }));
  }, []);
  useEffect(() => {
    let alive = true, t, stale = false;
    // A failed load (e.g. the server was down) is retried on the next poll.
    const load = () => refresh().then(() => { stale = false; }, () => { stale = true; });
    load();
    const tick = async () => {
      try {
        const { events, last: l } = await api.events(last.current);
        if (l < last.current) {
          // Event ids start over when the server restarts: drop the old log and reload everything.
          last.current = 0;
          if (alive) setS((p) => ({ ...p, events: [] }));
          load();
        } else {
          last.current = l;
          if (alive && events.length) {
            setS((p) => ({ ...p, events: [...p.events, ...events].slice(-300) }));
            load();
          } else if (stale) load();
        }
      } catch { stale = true; }
      if (alive) t = setTimeout(tick, 900);
    };
    tick();
    // Coming back to the tab (say, after signing in to GitHub elsewhere) reloads too.
    const onShow = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onShow);
    return () => { alive = false; clearTimeout(t); document.removeEventListener('visibilitychange', onShow); };
  }, [refresh]);
  return { ...s, refresh };
}
