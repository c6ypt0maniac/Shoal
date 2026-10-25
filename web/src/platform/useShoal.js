import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

// Polls the event log and refreshes server state when something relevant happens.
export function useShoal() {
  const [s, setS] = useState({ events: [], pains: [], bounties: [], agents: [], settlement: null, ledger: [], credits: null, connection: null, health: null, me: null });
  const last = useRef(0);
  const refresh = useCallback(async () => {
    const [pains, bounties, agents, settlement, ledger, credits, connection, health, me] = await Promise.all([
      api.pains(), api.bounties(), api.agents(), api.settlement(), api.ledger(), api.credits().catch(() => null), api.connection(), api.health(), api.me().catch(() => null),
    ]);
    setS((p) => ({ ...p, pains, bounties, agents, settlement, ledger, credits, connection, health, me }));
  }, []);
  useEffect(() => {
    let alive = true, t;
    refresh().catch(() => {});
    const tick = async () => {
      try {
        const { events, last: l } = await api.events(last.current);
        last.current = l;
        if (alive && events.length) {
          setS((p) => ({ ...p, events: [...p.events, ...events].slice(-300) }));
          refresh().catch(() => {});
        }
      } catch {}
      if (alive) t = setTimeout(tick, 900);
    };
    tick();
    return () => { alive = false; clearTimeout(t); };
  }, [refresh]);
  return { ...s, refresh };
}
