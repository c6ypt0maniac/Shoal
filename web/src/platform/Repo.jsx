// Get started, and the connected repo: what agents can see and keeping it in
// sync (server/src/index.js, scope.js, sync.js).
import { useEffect, useState } from 'react';
import { api } from './api.js';
import { Tag, Toggle, card, ghost, primary } from './ui.jsx';

const label = (d) => (d === '.' ? 'Files in the repo root' : d + '/');
const ago = (iso) => { if (!iso) return 'never'; const m = Math.round((Date.now() - Date.parse(iso)) / 60_000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : Math.round(m / 60) + ' h ago'; };

// Three steps: set up payments, find flaky tests, post a bounty.
// steps: [payments ready, scanned, bounty posted]. Repos are picked and
// switched on the Repository page, not here.
export function Setup({ s, act, steps, onPost, go, pay, onExplore }) {
  const last = (re) => [...s.events].reverse().find((e) => re.test(e.type));
  const scanning = ['scan.started', 'scan.file'].includes(last(/^scan\./)?.type);
  const cur = steps.findIndex((x) => !x);
  // What the last finished scan said, e.g. "No test files found in the shared code".
  const started = last(/^scan\.started$/)?.id ?? 0;
  const scanNote = !scanning && started && s.events.filter((e) => e.id > started && /^scan\.(warning|completed)$/.test(e.type)).map((e) => e.message);
  // Payments skipped: the step counts as done, but a bounty still needs a card,
  // so posting asks for one first.
  const skipped = pay?.billing?.mode === 'stripe' && !pay.billing.ready && pay.billing.prompted;
  const needsCard = pay?.billing?.mode === 'stripe' && !pay.billing.ready;
  const rows = [
    ['Set up payments', "Save a card with Stripe once. Each bounty's reward is held on it and charged only when a fix is verified and survives. You can skip this for now, but you'll need a card to post a bounty.", (
      <div className="flex flex-wrap items-center gap-3">
        <button className={primary} disabled={!pay?.billing} onClick={act(() => pay.setup('setup'))}>Add a card with Stripe</button>
        <button className="cursor-pointer text-[15px] text-muted underline" disabled={!pay?.billing} onClick={act(pay.later)}>Skip for now</button>
      </div>
    )],
    ['Find flaky tests', 'Shoal runs every test file 10 times and prices each flaky one by the dev-hours it costs.', (
      <div className="flex flex-col gap-2">
        <button className={primary + ' self-start'} disabled={scanning} onClick={act(api.scan)}>{scanning ? 'Scanning…' : 'Scan for flaky tests'}</button>
        {scanNote?.length > 0 && <span className="text-sm text-muted">Last scan: {scanNote.join('. ')}.</span>}
      </div>
    )],
    ['Post your first bounty', "Set a reward and pick who competes. It's held, not charged, until a fix passes its runs in a row and survives.", <div className="flex flex-wrap gap-2"><button className={primary} disabled={!steps[1]} onClick={needsCard ? () => dispatchEvent(new Event('shoal:need-payment')) : onPost}>Post a bounty</button><button className={ghost} disabled={!steps[1]} onClick={() => { onExplore?.(); go('agents'); }}>Browse agents first</button><button className={ghost} disabled={!steps[1]} onClick={() => { onExplore?.(); go('trials'); }}>Try models for free</button></div>],
  ];
  return (
    <section className="flex flex-col gap-5">
      <h2 className="m-0 border-b border-ink/12 pb-3 text-[24px] font-semibold tracking-[-0.025em]">Setup</h2>
      <div className="flex gap-1">{steps.map((ok, i) => <span key={i} className={'h-1.5 flex-1 rounded-full ' + (ok ? 'bg-accent' : 'bg-ink/15')} />)}</div>
      {rows.map(([t, b, action], i) => (
        <div key={t} className={card + ' xl:flex-row xl:items-center xl:gap-6 ' + (cur === i ? 'ring-2 ring-accent/50' : steps[i] ? '' : 'opacity-55')}>
          <span className={'flex size-12 shrink-0 items-center justify-center rounded-2xl text-lg font-semibold ' + (steps[i] ? 'bg-accent text-paper' : 'bg-white/70')}>{steps[i] ? '✓' : i + 1}</span>
          <div className="flex min-w-0 flex-1 flex-col gap-1"><div className="text-[20px] font-semibold tracking-[-0.02em]">{t}</div><div className="text-[15px] text-muted">{b}</div></div>
          <div className="min-w-0 xl:max-w-[520px]">{steps[i] ? <span className="flex flex-wrap items-center gap-3 text-[15px] text-accent">{i === 0 && skipped ? '' : 'Done'}{i === 0 && pay?.billing?.card ? ' · ' + pay.billing.card.brand + ' •••• ' + pay.billing.card.last4 : ''}{i === 0 && skipped && <><span className="text-muted">Skipped: add a card before posting a bounty.</span><button className="cursor-pointer text-accent underline" onClick={act(() => pay.setup('setup'))}>Add a card</button></>}</span> : action}</div>
        </div>
      ))}
      {steps.every(Boolean) && <div className="glass rounded-2xl px-5 py-4">You're set up. <button className="cursor-pointer text-accent underline" onClick={() => go('bounties')}>Go to your bounties</button>.</div>}
    </section>
  );
}

export function Repo({ s, act, go }) {
  const c = s.connection || {}, sync = c.sync || {}, gh = c.type === 'github';

  const [ci, setCi] = useState(null);
  useEffect(() => { api.ci().then(setCi).catch(() => setCi([])); }, [c.fullName]);
  const hiddenSources = [...new Set(s.pains.flatMap((p) => p.hiddenSources || []))];
  const shared = c.sharedPaths || [];
  const H = ({ children }) => <h2 className="m-0 border-b border-ink/12 pb-3 text-[24px] font-semibold tracking-[-0.025em]">{children}</h2>;
  return (
    <section className="flex flex-col gap-5">
      <H>Connected</H>
      <div className={card}>
        <div className="flex items-start justify-between gap-4"><div className="flex min-w-0 flex-col"><span className="truncate text-[21px] font-semibold">{c.fullName || 'Nothing connected'}</span><span className="text-[15px] text-muted">{gh ? 'GitHub' + (c.defaultBranch ? ' · ' + c.defaultBranch : '') + (c.private ? ' · private' : '') : 'Bundled demo repo'}{c.head ? ' · ' + c.head.sha.slice(0, 7) + ' ' + c.head.message : ''}</span></div>
</div>
        <span className="text-sm text-muted">The repo is chosen when you post a bounty: the Post a bounty form starts with it.</span>
        <div className="flex flex-wrap gap-2">
          <Tag>{s.pains.length} test files scanned</Tag><Tag>{s.pains.filter((p) => !p.healthy).length} flaky</Tag>
          {gh && <Tag tone={c.canWrite ? 'ok' : undefined}>{c.canWrite ? 'Can open PRs' : 'Read-only, no PRs'}</Tag>}
          {(c.problems || []).map((p) => <Tag key={p.id}>{p.label}</Tag>)}
        </div>
        {c.tests?.length > 0 && <div className="flex flex-col gap-1 border-t border-ink/10 pt-3 text-[15px]">{c.tests.map((t) => <span key={t.id + t.root}>{t.language} · {t.framework}{t.root !== '.' ? ' in ' + t.root + '/' : ''} {t.toolOk ? <span className="text-muted">· <code className="text-sm">{t.example}</code></span> : <span className="text-bad">· {t.toolMessage || 'toolchain missing'}</span>}</span>)}</div>}
      </div>

      <H>What agents can see</H>
      <div className={card}>
        <span className="text-[15px]">{shared.length ? shared.map(label).join(', ') : 'The whole repo, except secrets.'}</span>
        {hiddenSources.length > 0 && <div className="flex flex-col gap-2 rounded-xl border border-bad/30 bg-bad/5 p-3 text-[15px]">
          <span>Your flaky tests import code agents can't see: <span className="font-mono text-sm">{hiddenSources.join(', ')}</span></span>
          <button className={ghost + ' self-start'} onClick={act(() => api.share(hiddenSources))}>Share these files with agents</button>
        </div>}
        {sync.newPaths?.length > 0 && <div className="flex flex-col gap-2 rounded-xl border border-ink/15 bg-white/50 p-3 text-[15px]">
          <span>New folders since you connected: <span className="font-mono text-sm">{sync.newPaths.map(label).join(', ')}</span></span>
          <button className={ghost + ' self-start'} onClick={act(() => api.share(sync.newPaths))}>Share them too</button>
        </div>}
      </div>

      {gh && <>
        <H>Sync with GitHub</H>
        <div className={card + ' md:flex-row md:items-center'}>
          <div className="flex flex-1 flex-col gap-1 text-[15px]">
            <span>Last checked {ago(sync.checkedAt)} · last pulled {ago(sync.syncedAt)}</span>
            {sync.waiting && <span className="text-muted">Waiting for {sync.waiting} to finish</span>}
            {sync.error && <span className="text-bad">{sync.error}</span>}
          </div>
          <label className="flex items-center gap-3 text-[15px]">Auto-sync every minute<Toggle on={Boolean(sync.auto)} label="Auto-sync" onChange={act((on) => api.autoSync(on))} /></label>
          <button className={ghost} disabled={sync.syncing} onClick={act(api.sync)}>{sync.syncing ? 'Syncing…' : 'Sync now'}</button>
        </div>
        <H>GitHub Actions</H>
        <div className="glass rounded-[20px] px-6 py-2">
          {ci === null && <div className="py-4 text-muted">Loading…</div>}
          {ci?.length === 0 && <div className="py-4 text-muted">No completed workflow runs found.</div>}
          {ci?.map((w) => <div key={w.workflow} className="grid grid-cols-[minmax(0,1fr)_repeat(3,90px)] gap-4 border-t border-ink/10 py-3 tabular-nums first:border-t-0"><span className="truncate">{w.workflow}</span><span className={w.failureRate > 0.1 ? 'text-bad' : ''}>{Math.round(w.failureRate * 100)}% fail</span><span>{Math.round(w.rerunRate * 100)}% rerun</span><span className="text-right text-muted">{w.avgMinutes != null ? w.avgMinutes + ' min' : '–'}</span></div>)}
        </div>
      </>}
      <div className="flex flex-wrap gap-3"><button className={ghost} onClick={act(api.scan)}>Rescan</button><button className={ghost} onClick={act(api.reset)}>Reset workspace</button></div>
    </section>
  );
}
