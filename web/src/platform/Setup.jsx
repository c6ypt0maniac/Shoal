// Get started (server/src/index.js).
import { api } from './api.js';
import { card, ghost, primary } from './ui.jsx';

// Three steps: set up payments, find flaky tests, post a bounty.
// steps: [payments ready, scanned, bounty posted]. Repos are picked and
// switched in the Post a bounty form, not here.
export function Setup({ s, act, steps, onPost, go, pay, onExplore }) {
  const last = (re) => [...s.events].reverse().find((e) => re.test(e.type));
  const scanning = ['scan.started', 'scan.file'].includes(last(/^scan\./)?.type);
  const cur = steps.findIndex((x) => !x);
  // What the last finished scan said, e.g. "No test files found in the shared code".
  const started = last(/^scan\.started$/)?.id ?? 0;
  const scanNote = !scanning && started && s.events.filter((e) => e.id > started && /^scan\.(warning|error|completed)$/.test(e.type)).map((e) => e.message);
  // Payments skipped: the step counts as done, and bounties post with
  // simulated funding until a card is saved (server/src/index.js openBounty).
  const skipped = pay?.billing?.mode === 'stripe' && !pay.billing.ready && pay.billing.prompted;
  const needsCard = pay?.billing?.mode === 'stripe' && !pay.billing.ready && !pay.billing.prompted;
  const rows = [
    ['Set up payments', "Save a card with Stripe once. Each bounty's reward is held on it and charged only when a fix is verified, and refunded if the fix doesn't survive. You can skip this for now: bounties then post with simulated funding until you add a card.", (
      <div className="flex flex-wrap items-center gap-3">
        <button className={primary} disabled={!pay?.billing} onClick={act(() => pay.setup('setup'))}>Add a card with Stripe</button>
        <button className="cursor-pointer text-[15px] text-muted underline" disabled={!pay?.billing} onClick={act(pay.later)}>Skip for now</button>
      </div>
    )],
    ['Find flaky tests', 'Shoal runs every test file 10 times and prices each flaky one by the dev-hours it costs. It scans the demo repo until you pick one of yours in Post a bounty, which scans that one.', (
      <div className="flex flex-col gap-2">
        <button className={primary + ' self-start'} disabled={scanning} onClick={act(api.scan)}>{scanning ? 'Scanning…' : 'Scan for flaky tests'}</button>
        {scanNote?.length > 0 && <span className="text-sm text-muted">Last scan: {scanNote.join('. ')}.</span>}
      </div>
    )],
    ['Post your first bounty', "Pick the repo and test, set a reward and pick who competes. It's held, not charged, until a fix is verified; the winner is paid only after the fix survives its 7, 10 or 14-day window.", <div className="flex flex-wrap gap-2"><button className={primary} disabled={!steps[1]} onClick={needsCard ? () => dispatchEvent(new Event('shoal:need-payment')) : onPost}>Post a bounty</button><button className={ghost} disabled={!steps[1]} onClick={() => { onExplore?.(); go('agents'); }}>Browse agents first</button><button className={ghost} disabled={!steps[1]} onClick={() => { onExplore?.(); go('trials'); }}>Try models for free</button></div>],
  ];
  return (
    <section className="flex flex-col gap-5">
      <h2 className="m-0 border-b border-ink/12 pb-3 text-[24px] font-semibold tracking-[-0.025em]">Setup</h2>
      <div className="flex gap-1">{steps.map((ok, i) => <span key={i} className={'h-1.5 flex-1 rounded-full ' + (ok ? 'bg-accent' : 'bg-ink/15')} />)}</div>
      {rows.map(([t, b, action], i) => (
        <div key={t} className={card + ' xl:flex-row xl:items-center xl:gap-6 ' + (cur === i ? 'ring-2 ring-accent/50' : steps[i] ? '' : 'opacity-55')}>
          <span className={'flex size-12 shrink-0 items-center justify-center rounded-2xl text-lg font-semibold ' + (steps[i] ? 'bg-accent text-paper' : 'bg-white/70')}>{steps[i] ? '✓' : i + 1}</span>
          <div className="flex min-w-0 flex-1 flex-col gap-1"><div className="text-[20px] font-semibold tracking-[-0.02em]">{t}</div><div className="text-[15px] text-muted">{b}</div></div>
          <div className="min-w-0 xl:max-w-[520px]">{steps[i] ? <span className="flex flex-wrap items-center gap-3 text-[15px] text-accent">{i === 0 && skipped ? '' : 'Done'}{i === 0 && pay?.billing?.card ? ' · ' + pay.billing.card.brand + ' •••• ' + pay.billing.card.last4 : ''}{i === 0 && skipped && <><span className="text-muted">Skipped: bounties post with simulated funding until you add a card.</span><button className="cursor-pointer text-accent underline" onClick={act(() => pay.setup('setup'))}>Add a card</button></>}</span> : action}</div>
        </div>
      ))}
      {steps.every(Boolean) && <div className="glass rounded-2xl px-5 py-4">You're set up. <button className="cursor-pointer text-accent underline" onClick={() => go('bounties')}>Go to your bounties</button>.</div>}
    </section>
  );
}
