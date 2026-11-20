// Get started (server/src/index.js).
import { card, ghost, primary } from './ui.jsx';

// Two steps: add API keys, post a bounty.
// steps: [keys added or skipped, bounty posted]. Repos are picked and
// switched in the Post a bounty form, which also scans them; the card is
// asked for when the first bounty is posted.
export function Setup({ steps, hasKeys, onSkipKeys, onPost, go, pay, onExplore }) {
  const cur = steps.findIndex((x) => !x);
  const needsCard = pay?.billing?.mode === 'stripe' && !pay.billing.ready && !pay.billing.prompted;
  const rows = [
    ['Add your API keys', 'Every model call runs on your own Anthropic, OpenAI or OpenRouter keys, so you pay your provider directly. Without any, Shoal runs in practice mode on the demo repo.', (
      <div className="flex flex-wrap items-center gap-3">
        <button className={primary} onClick={() => go('keys')}>Add API keys</button>
        <button className="cursor-pointer text-[15px] text-muted underline" onClick={onSkipKeys}>Skip: try the demo</button>
      </div>
    )],
    ['Post your first bounty', "Pick the repo and test, set a reward and pick who competes. It's held, not charged, until a fix is verified; the winner is paid only after the fix survives its 7, 10 or 14-day window.", <div className="flex flex-wrap gap-2"><button className={primary} onClick={needsCard ? () => dispatchEvent(new Event('shoal:need-payment')) : onPost}>Post a bounty</button><button className={ghost} onClick={() => { onExplore?.(); go('agents'); }}>Browse agents first</button><button className={ghost} onClick={() => { onExplore?.(); go('trials'); }}>Try models for free</button></div>],
  ];
  return (
    <section className="flex flex-col gap-5">
      <h2 className="m-0 border-b border-ink/12 pb-3 text-[24px] font-semibold tracking-[-0.025em]">Setup</h2>
      <div className="flex gap-1">{steps.map((ok, i) => <span key={i} className={'h-1.5 flex-1 rounded-full ' + (ok ? 'bg-accent' : 'bg-ink/15')} />)}</div>
      {rows.map(([t, b, action], i) => (
        <div key={t} className={card + ' xl:flex-row xl:items-center xl:gap-6 ' + (cur === i ? 'ring-2 ring-accent/50' : steps[i] ? '' : 'opacity-55')}>
          <span className={'flex size-12 shrink-0 items-center justify-center rounded-2xl text-lg font-semibold ' + (steps[i] ? 'bg-accent text-paper' : 'bg-white/70')}>{steps[i] ? '✓' : i + 1}</span>
          <div className="flex min-w-0 flex-1 flex-col gap-1"><div className="text-[20px] font-semibold tracking-[-0.02em]">{t}</div><div className="text-[15px] text-muted">{b}</div></div>
          <div className="min-w-0 xl:max-w-[520px]">{steps[i] ? <span className="flex flex-wrap items-center gap-3 text-[15px] text-accent">{i === 0 && !hasKeys ? <><span className="text-muted">Skipped: practice mode on the demo repo.</span><button className="cursor-pointer text-accent underline" onClick={() => go('keys')}>Add API keys</button></> : 'Done'}</span> : action}</div>
        </div>
      ))}
      {steps.every(Boolean) && <div className="glass rounded-2xl px-5 py-4">You're set up. <button className="cursor-pointer text-accent underline" onClick={() => go('bounties')}>Go to your bounties</button>.</div>}
    </section>
  );
}
