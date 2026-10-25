// Model trials, sealed and on Shoal's API keys (server/src/api-trials.js):
// models diagnose each flaky test, the best-value model is recommended, and
// once the team authorizes it, it writes the fix, which is proven (proof.js)
// and charged only if proven.
import { useEffect, useState } from 'react';
import { api } from './api.js';
import { Empty, Tag, card, field, ghost, primary, STATUS, tone } from './ui.jsx';

const usd = (n) => (n == null ? '–' : '$' + Number(n).toFixed(n < 1 ? 4 : 2));
const H = ({ children }) => <h2 className="m-0 border-b border-ink/12 pb-3 text-[24px] font-semibold tracking-[-0.025em]">{children}</h2>;

export default function Trials({ s, act, go }) {
  const [t, setT] = useState(null), [loadErr, setLoadErr] = useState(null), [n, setN] = useState(0);
  // Trials and proofs report progress as events; refetch when they arrive.
  useEffect(() => { const h = setTimeout(() => api.trials().then((x) => { setT(x); setLoadErr(null); }, (e) => setLoadErr(e.message)), 150); return () => clearTimeout(h); }, [s.events.length, n]);
  // Couldn't load: try again every few seconds, so it recovers once the server is back.
  useEffect(() => { if (!loadErr) return; const h = setTimeout(() => setN((x) => x + 1), 4000); return () => clearTimeout(h); }, [loadErr, n]);
  if (!s.pains.some((p) => !p.healthy)) return <Empty>No flaky tests yet. <button className="cursor-pointer text-accent underline" onClick={() => go('setup')}>Scan for flaky tests</button> first.</Empty>;
  if (!t) return loadErr
    ? <Empty>{loadErr} <button className="cursor-pointer text-accent underline" onClick={() => setN((x) => x + 1)}>Retry</button></Empty>
    : <div className="text-muted">Loading…</div>;
  const balance = Number(s.credits?.balance ?? 0);
  const trialAct = (fn) => act(async (...a) => { await fn(...a); setN((x) => x + 1); });
  return (
    <section className="flex flex-col gap-5">
      <div className={card}>
        <span className="text-[19px] font-semibold">Sealed trials</span>
        <span className="text-[15px] text-muted">Shoal's own models diagnose each flaky test, cheapest first, and recommend the best value. Nothing is written until you authorize it; you're charged only if the fix is proven. Trials need credits.</span>
      </div>
      {t.scoreboard.length > 0 && <>
        <H>Scoreboard</H>
        <div className="glass rounded-[20px] px-6 py-2">
          <div className="grid grid-cols-[minmax(0,1fr)_80px_80px_110px] gap-4 py-3 text-sm text-muted"><span>Model</span><span>Fixed</span><span>Quality</span><span className="text-right">Cost per fix</span></div>
          {t.scoreboard.map((r) => <div key={r.model} className="grid grid-cols-[minmax(0,1fr)_80px_80px_110px] gap-4 border-t border-ink/10 py-3 tabular-nums"><span className="truncate">{r.name}{r.recommended && <span className="text-accent"> · best value</span>}</span><span>{r.fixed}/{r.tried}</span><span>{r.quality}</span><span className="text-right">{usd(r.costPerFix)}{r.costMeasured ? '' : '*'}</span></div>)}
        </div>
        {t.pick && <span className="-mt-2 text-sm text-muted">{t.pick.reason}. * estimated from list prices until a trial measures it.</span>}
      </>}

      <H>Your flaky tests</H>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {t.problems.map((p) => {
          const pr = p.proof || {}, price = p.fixPrice;
          return (
            <div key={p.painId} className={card}>
              <span className="truncate font-mono text-[17px]">{p.testFile}</span>
              <span className="text-[15px] text-muted">{p.attempts ? p.attempts + ' trial fix' + (p.attempts === 1 ? '' : 'es') : 'No trials yet'}{p.recommended ? ' · best: ' + p.recommended.name + ', quality ' + p.recommended.quality + ', ' + p.recommended.linesChanged + ' lines' : ''}</span>
              <div className="flex flex-wrap gap-2">
                {pr.checking && <Tag>Building proof report…</Tag>}
                {pr.proven && <Tag tone="ok">Proven safe: {pr.proven.name}{pr.proven.score != null ? ' · trust ' + pr.proven.score : ''}</Tag>}
                {!pr.checking && !pr.proven && pr.candidates?.length > 0 && <Tag tone="bad">No fix proven</Tag>}
                {p.bounty && <Tag tone={tone(p.bounty.status)}>API fix: {STATUS[p.bounty.status] || p.bounty.status}</Tag>}
                {p.ladder?.status === 'running' && <Tag>Diagnosing: step {p.ladder.step}</Tag>}
                {p.ladder?.status === 'awaiting_authorization' && <Tag tone="ok">Best model: {p.ladder.pickName}</Tag>}
                {p.ladder?.status === 'fixing' && <Tag>{p.ladder.pickName} is writing the fix…</Tag>}
                {p.ladder?.status === 'stopped' && <Tag tone="bad">{{ cap: 'Stopped at the spend cap', exhausted: 'No model diagnosed it', not_proven: 'No fix proven · $0 charged' }[p.ladder.stopped] || 'Stopped'}</Tag>}
              </div>
              {p.ladder?.diagnoses?.length > 0 && (() => {
                // The small trial: who diagnosed what. The winner's diagnosis says
                // what needs fixing; how stays sealed until unlock.
                const won = p.ladder.diagnoses.find((d) => d.model === p.ladder.pick);
                return <div className="flex flex-col gap-1 text-sm">
                  {won && <span><span className="text-muted">Needs fixing:</span> <span className="font-mono">{won.file}</span>{won.location ? ' · ' + won.location : ''}</span>}
                  <span className="text-muted">Diagnosed: {p.ladder.diagnoses.map((d) => d.name + (d.correct ? ' ✓ ' + (d.score ?? '') + '/10' : d.correct === false ? ' ✗' : '')).join(', ')}{won && p.ladder.pickReason ? ' · picked ' + won.name + ': ' + p.ladder.pickReason : ''}</span>
                  {p.ladder.status === 'awaiting_authorization' && <span className="text-muted">No fix has been written yet. Authorize {p.ladder.pickName} and it writes the fix; you're charged only if the fix is proven, never more than the quote.</span>}
                </div>;
              })()}
              {pr.candidates?.filter((c) => c.checks?.review?.skipped).map((c) => <span key={c.trialId} className="text-sm text-muted">{c.name}: {c.checks.review.reason}</span>)}
              <div className="mt-auto flex flex-wrap gap-2 pt-2">
                {/* Only if the charge after authorizing failed: retry it. */}
                {pr.proven && !p.bounty && p.sealed && <button className={primary} disabled={price > balance} onClick={trialAct(() => api.unlock(pr.proven.trialId))}>Unlock fix · {usd(price)}</button>}
                {p.ladder?.status === 'awaiting_authorization' && <button className={primary} disabled={p.ladder.quote > balance} onClick={trialAct(() => api.authorize(p.painId))}>Authorize {p.ladder.pickName} to fix · up to {usd(p.ladder.quote)}</button>}
                {p.ladder?.status === 'awaiting_authorization' && p.ladder.quote > balance && <button className={ghost} onClick={() => go('billing')}>Add credits</button>}
                {!pr.proven && !['running', 'awaiting_authorization', 'fixing'].includes(p.ladder?.status) && <button className={ghost} disabled={t.canRunTrials !== true} title={t.canRunTrials === true ? '' : t.canRunTrials} onClick={trialAct(() => api.sealedTrials(p.painId))}>Run sealed trials</button>}
                {pr.proven && !p.bounty && price > balance && <button className={ghost} onClick={() => go('billing')}>Add credits</button>}
                {p.attempts > 0 && !pr.checking && !pr.proven && <button className={ghost} onClick={trialAct(() => api.prove(p.painId))}>Build proof report</button>}
              </div>
            </div>
          );
        })}
      </div>

      {t.trials.length > 0 && <>
        <H>Trial fixes</H>
        <div className="glass rounded-[20px] px-6 py-2">
          {t.trials.map((x) => (
            <div key={x.id} className="flex flex-col gap-1 border-t border-ink/10 py-3 text-[15px] first:border-t-0">
              <span><span className={x.status === 'passed' ? 'text-accent' : x.status === 'failed' ? 'text-bad' : 'text-muted'}>{x.status === 'passed' ? 'Passed' : x.status === 'failed' ? 'Failed' : 'Verifying'}</span> · {t.models[x.model]?.name || x.model} on <span className="font-mono text-sm">{x.testFile}</span>{x.linesChanged != null ? ' · ' + x.linesChanged + ' lines' : ''}</span>
              <span className="text-sm text-muted">{x.status === 'failed' ? x.reason : x.summary}</span>
              {x.locked ? <span className="text-sm text-muted">Sealed: {x.files.length} file{x.files.length === 1 ? '' : 's'} changed. Unlock to see the code.</span> : <span className="flex flex-wrap gap-3 text-sm">{x.files.map((f) => <a key={f} className="text-accent underline" href={'/api/trials/' + x.id + '/file?path=' + encodeURIComponent(f)}>{f}</a>)}<a className="text-accent underline" href={'/api/trials/' + x.id + '/repo'}>Whole repo with this fix (.zip)</a></span>}
            </div>
          ))}
        </div>
      </>}

    </section>
  );
}
