import { useEffect, useMemo, useRef, useState } from 'react';
import { animate } from '../lib/animation.js';
import Fish from './Fish.jsx';

export const COLORS = ['#0A7470', '#0B2A40', '#9A5B00', '#B83A2B', '#3D5B70', '#2F7D4F'];

// Each stage owns a band of the track. While a stage is running the fish keeps
// swimming through its band (easing toward the end, never stopping), so the
// lane reads like a live progress bar instead of jumping between points.
// Every competitor starts at once (bounty.competing). The verifier names
// competitors by display name, other events by listing id, so lanes are keyed by name.
const WAITING = ['open', 'awaiting_funding'], FINISHED = ['surviving', 'settled', 'clawed_back', 'failed', 'payment_failed'];
function lanes(bounty, events, names) {
  const map = new Map();
  const lane = (name) => { if (!map.has(name)) map.set(name, { id: name, name, lo: 0, hi: 0.04, since: Date.now(), tau: 6, state: 'waiting', note: 'waiting' }); return map.get(name); };
  const stage = (L, lo, hi, tau, at, state, note) => Object.assign(L, { lo, hi, tau, since: Date.parse(at) || Date.now(), state, note });
  for (const id of bounty.competitors || []) lane(names(id));
  for (const e of events) {
    if (e.bountyId !== bounty.id) continue;
    if (e.type === 'bounty.competing') { for (const L of map.values()) stage(L, 0.04, 0.6, 8, e.at, 'working', 'in sandbox'); continue; }
    if (!e.agentId) continue;
    // names() maps a listing id to its name and leaves a name as it is.
    const L = lane(names(e.agentId));
    switch (e.type) {
      // Diagnosis race (server/src/bounties.js diagnosisRace): no fix until the team picks.
      case 'diagnosis.done': stage(L, 0.45, 0.5, 2, e.at, 'working', 'diagnosed'); break;
      // A correct diagnosis finishes its race: all the way to the line.
      case 'diagnosis.graded': stage(L, e.correct ? 1 : L.lo, e.correct ? 1 : L.lo, 0.6, e.at, e.correct ? 'verified' : 'out', e.correct ? 'correct diagnosis' : 'wrong diagnosis'); break;
      case 'bounty.recommended': stage(L, 1, 1, 0.6, e.at, 'verified', 'recommended'); break;
      // The chosen model's fix is a second race: it swims again from the start.
      case 'bounty.building': stage(L, 0.04, 0.6, 8, e.at, 'working', 'writing the fix'); break;
      case 'work.submitted': stage(L, 0.6, 0.66, 2, e.at, 'working', 'patch in'); break;
      case 'work.error': stage(L, L.lo, L.lo, 1, e.at, 'out', 'no patch'); break;
      case 'verify.started': stage(L, 0.66, 0.7, 2, e.at, 'verifying', 'verifying'); break;
      case 'verify.runs': { const n = e.results ? e.results.filter(Boolean).length : e.passed ?? 0, t = e.results ? e.results.length : e.total ?? 10; stage(L, 0.66 + 0.32 * (n / t), 0.66 + 0.32 * ((n + 1) / t), 1.2, e.at, 'verifying', n + '/' + t + ' green'); break; }
      case 'verify.rejected': stage(L, L.lo, L.lo, 1, e.at, 'out', 'rejected' + (e.reason ? ': ' + e.reason : '')); break;
      // Passing the tests isn't the finish: the judges still review it, and
      // only the winner (fix accepted, PR opened) reaches the line.
      case 'verify.passed': stage(L, 0.85, 0.95, 10, e.at, 'judging', 'tests passed · judges reviewing'); break;
      case 'bounty.winner': stage(L, 1, 1, 0.6, e.at, 'won', 'winner'); break;
    }
  }
  // The event log doesn't survive a server restart, but the bounty knows its
  // diagnoses and its winner.
  for (const d of bounty.diagnoses || []) { const L = lane(names(d.model)); if (L.state === 'waiting') Object.assign(L, { lo: d.correct ? 1 : 0.45, hi: d.correct ? 1 : 0.45, state: d.correct ? 'verified' : 'out', note: d.model === bounty.recommended ? 'recommended' : d.correct ? 'correct diagnosis' : 'wrong diagnosis' }); }
  if (bounty.winner) Object.assign(lane(names(bounty.winner)), { lo: 1, hi: 1, state: 'won', note: 'winner' });
  const rows = [...map.values()];
  // After the race, anyone still swimming never delivered a verified fix.
  if (FINISHED.includes(bounty.status)) for (const L of rows) {
    if (L.state === 'judging') Object.assign(L, { lo: 0.9, hi: 0.9, state: 'verified', note: 'passed tests, not picked' });
    else if (!['won', 'verified', 'out'].includes(L.state)) Object.assign(L, { state: 'out', note: 'no fix' });
  }
  if (WAITING.includes(bounty.status)) for (const L of rows) Object.assign(L, { note: bounty.status === 'open' ? 'ready' : 'waiting for funding' });
  return rows;
}

export default function Race({ bounty, events, names = (id) => id, compact = false }) {
  const rows = useMemo(() => (bounty ? lanes(bounty, events, names) : []), [bounty, events, names]);
  const pos = useRef({}), container = useRef(null);
  const [, setFrame] = useState(0);
  const moving = rows.some(r => ['working','verifying','judging'].includes(r.state));
  useEffect(() => animate(() => setFrame(x => x + 1), { paused: !moving, element: container.current }), [moving]);
  if (!bounty) return null;
  const now = Date.now(), t = now / 1000;
  return (
    <div ref={container} className="flex flex-col">
      {rows.length === 0 && <div className="py-8 text-center text-muted">Agents are reviewing the test…</div>}
      {rows.map((r, i) => {
        const out = r.state === 'out', moving = ['working', 'verifying', 'judging'].includes(r.state);
        const k = Math.max(0, (now - r.since) / 1000);
        const target = moving ? r.lo + (r.hi - r.lo) * (1 - Math.exp(-k / r.tau)) : r.hi;
        const prev = pos.current[r.id] ?? 0;
        const p = (pos.current[r.id] = !moving || out ? target : prev + (target - prev) * 0.12);
        return (
          <div key={r.id} className={'grid items-center gap-3 border-t border-ink/10 py-2.5 ' + (compact ? 'grid-cols-[96px_minmax(0,1fr)]' : 'grid-cols-[120px_minmax(0,1fr)_120px]')}>
            <div className="truncate text-[15px] font-medium">{r.name}</div>
            <div className="relative h-10 overflow-hidden rounded-full bg-white/35">
              <div className="absolute inset-y-0 left-0 rounded-full bg-accent/15" style={{ width: 'calc(' + p * 100 + '% + 10px)' }} />
              <div className="absolute inset-y-0 right-3 w-px bg-accent/60" />
              <div className="absolute top-1/2 -translate-y-1/2" style={{ left: 'calc(' + p * 100 + '% - ' + p * 54 + 'px + 2px)' }}>
                <Fish size={50} color={COLORS[i % COLORS.length]} tail={moving ? Math.sin(t * 9 + i) * 0.45 : 0} opacity={out ? 0.3 : 1} />
              </div>
            </div>
            {!compact && <div title={r.note} className={'line-clamp-2 text-right text-sm tabular-nums ' + (r.state === 'won' ? 'font-medium text-accent' : r.state === 'verified' ? 'text-accent' : out ? 'text-bad' : 'text-muted')}>{r.note}</div>}
          </div>
        );
      })}
    </div>
  );
}
