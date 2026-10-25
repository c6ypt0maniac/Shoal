import { useEffect, useRef, useState } from 'react';
import Water from '../components/Water.jsx';
import { api } from './api.js';
import { useShoal } from './useShoal.js';
import Race from './Race.jsx';
import Shore from './Shore.jsx';
import ShoreCard from './ShoreCard.jsx';
import { Agents, CompetitorPicker, ListingDetail, PublishAgent, nameOf } from './Market.jsx';
import { Repo, Setup } from './Repo.jsx';
import Trials from './Trials.jsx';
import FixReview from './FixReview.jsx';
import { overlay, Browse, Empty, Group, Icon, ItemCard, Label, LIVE, Modal, STATUS, Tag, btn, card, field, ghost, money, primary, signInHref, tone } from './ui.jsx';

// Messages for ?funding= / ?credits= when Stripe Checkout sends the team back.
const RETURNS = { 'payments=saved': ['Payment method saved. Bounties are held on this card from now on.'], 'payments=failed': ["The card wasn't saved. Try again from Profile.", true], 'funding=held': ['Reward held in escrow. The race is starting.'], 'funding=cancelled': ['Funding cancelled. The bounty is waiting for funding.', true], 'funding=failed': ["Funding didn't go through. Try again from the bounty.", true], 'credits=added': ['Credits added.'], 'credits=cancelled': ['Credit purchase cancelled.', true], 'credits=failed': ["The credit purchase didn't go through.", true], 'github=signed-in': ['Signed in with GitHub. Pick a repository to connect.'] };

const NAV = [
  ['Account', [['account', 'Profile', 'user'], ['billing', 'Credits & billing', 'card']]],
  ['Workspace', [['setup', 'Get started', 'play'], ['repo', 'Repository', 'repo'], ['activity', 'Activity', 'pulse']]],
  ['Marketplace', [['bounties', 'Bounties', 'bounty'], ['agents', 'Agents for hire', 'fish'], ['trials', 'Model trials', 'flask'], ['selling', 'Your agents', 'plus']]],
  ['Results', [['settlement', 'Settlement', 'chart']]],
];
const TITLES = {
  account: ['Profile', 'Your GitHub account and role'],
  billing: ['Credits & billing', 'Your card for bounties, and credit packs for API fixes. Rewards are held, never charged until a fix is verified.'],
  setup: ['Get started', 'Three steps to your first bounty. Pick or switch repos on the Repository page.'],
  repo: ['Repository', 'What agents can see, and how Shoal stays in sync'],
  activity: ['Activity', 'Every attempt, green run, rejection and payout'],
  bounties: ['Bounties', 'Flaky tests from your repo, priced by the dev-hours they cost'],
  agents: ['Agents for hire', 'Agents and models ranked by verified fixes that survived. Pick who competes when you post a bounty.'],
  trials: ['Model trials', 'Try models on your flaky tests for free, then buy the cheapest proven fix with credits'],
  selling: ['Your agents', 'Agents you published to the marketplace. Shoal sends bounties to their webhooks.'],
  settlement: ['Settlement', 'What was fixed, what survived, what was paid and the hours you got back'],
};

function useWide() {
  const q = () => (matchMedia('(min-width: 1024px)').matches ? 300 : 260);
  const [w, setW] = useState(q);
  useEffect(() => { const m = matchMedia('(min-width: 1024px)'), f = () => setW(q()); m.addEventListener('change', f); return () => m.removeEventListener('change', f); }, []);
  return w;
}

export default function Platform() {
  const s = useShoal();
  const fromHash = () => (TITLES[location.hash.slice(1)] ? location.hash.slice(1) : 'setup');
  const [view, setView] = useState(fromHash);
  const [open, setOpen] = useState(null);
  const [create, setCreate] = useState(null);
  // Every way of posting a bounty opens the one form (repo first); from a
  // flaky test, that test is preselected.
  const [createPain, setCreatePain] = useState(null);
  const postBounty = (painId = null) => { setOpen(null); setCreatePain(painId); setCreate('bounty'); };
  // Narrow windows (small screens, or zoomed in): the sidebar folds into a menu.
  const [menu, setMenu] = useState(false);
  const [err, setErr] = useState('');
  const [note, setNote] = useState(null);
  useEffect(() => {
    const q = new URLSearchParams(location.search), k = ['payments', 'funding', 'credits', 'github'].find((x) => q.has(x));
    if (q.has('github_error')) setErr('GitHub sign-in failed: ' + q.get('github_error'));
    else if (!k) return;
    const r = RETURNS[k + '=' + q.get(k)];
    if (r) r[1] ? setErr(r[0]) : setNote(r[0]);
    history.replaceState(null, '', location.pathname + location.hash);
  }, []);
  const [leaving, setLeaving] = useState(null), [navN, setNavN] = useState(0);
  // fromUrl: the URL already says where to go (back/forward, an edited #link).
  const go = (v, fromUrl) => {
    if (v === view) return;
    setErr('');
    setLeaving({ v: view, n: navN }); setNavN((n) => n + 1); setView(v);
    if (!fromUrl) history.pushState(null, '', '#' + v);
    scrollTo(0, 0);
    clearTimeout(go.t); go.t = setTimeout(() => setLeaving(null), 420);
  };
  useEffect(() => {
    const onUrl = () => go(fromHash(), true);
    addEventListener('popstate', onUrl); addEventListener('hashchange', onUrl);
    return () => { removeEventListener('popstate', onUrl); removeEventListener('hashchange', onUrl); };
  }, [view, navN]);
  const act = (fn) => async (...a) => { setErr(''); try { const r = await fn(...a); await s.refresh(); return r; } catch (e) { setErr(e.message); } };
  const pay = usePayment(s.me?.viewer);

  // Get started: [payments ready, found flaky tests, bounty posted].
  // Payments count as done once a card is saved, payments are simulated, or
  // the step was skipped ("Later"); then bounties post with simulated funding
  // until a card is saved.
  // The last step is done by posting a bounty, or by choosing to browse agents
  // or try models first (remembered per account in this browser).
  const exploredKey = 'shoal.explored.' + (s.me?.viewer?.login || '');
  const [explored, setExplored] = useState(false);
  useEffect(() => { try { setExplored(localStorage.getItem(exploredKey) === '1'); } catch { setExplored(false); } }, [exploredKey]);
  const markExplored = () => { setExplored(true); try { localStorage.setItem(exploredKey, '1'); } catch {} };
  const steps = [Boolean(pay.billing?.ready || pay.billing?.mode === 'simulated' || pay.billing?.prompted), s.pains.length > 0, s.bounties.length > 0 || explored];
  const viewer = s.me?.viewer;
  const asideRef = useRef(null), pillRef = useRef(null), pillReady = useRef(false);
  useEffect(() => {
    const place = () => {
      const el = asideRef.current?.querySelector('[data-nav="' + view + '"]'), pill = pillRef.current;
      if (!el || !pill) return;
      pill.style.transition = pillReady.current ? 'transform .45s cubic-bezier(.2,.8,.2,1), height .45s cubic-bezier(.2,.8,.2,1), opacity .2s' : 'none';
      pill.style.transform = 'translateY(' + el.offsetTop + 'px)'; pill.style.height = el.offsetHeight + 'px'; pill.style.opacity = '1';
      pillReady.current = true;
    };
    // Re-measure whenever the sidebar's layout shifts, not just on navigation:
    // rows that load later (the saved card), badges, and web fonts all move the
    // items, and a stale position highlights the wrong spot.
    const aside = asideRef.current;
    const ro = new ResizeObserver(() => place());
    const watch = () => { ro.disconnect(); if (aside) for (const c of aside.children) if (c !== pillRef.current) ro.observe(c); };
    const mo = new MutationObserver(() => { watch(); place(); });
    if (aside) { watch(); mo.observe(aside, { childList: true, subtree: true, characterData: true }); }
    document.fonts?.ready.then(place);
    place(); addEventListener('resize', place);
    return () => { removeEventListener('resize', place); ro.disconnect(); mo.disconnect(); };
  }, [view, viewer, menu]);
  const page = (v) => (
    <>
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div className="flex flex-col gap-1"><h1 className="m-0 text-[clamp(28px,3vw,40px)] font-semibold tracking-[-0.035em]">{TITLES[v]?.[0]}</h1><span className="text-[17px] text-muted">{TITLES[v]?.[1]}</span></div>
              {['bounties', 'agents', 'selling'].includes(v) && <button className={primary} onClick={() => (v === 'bounties' ? postBounty() : setCreate('agent'))}><Icon n="plus" size={18} />{v === 'bounties' ? 'Post a bounty' : 'Publish an agent'}</button>}
            </div>
            {err && <div className="glass rounded-2xl px-5 py-3 text-bad">{err}</div>}
            {note && !err && <div className="glass rounded-2xl px-5 py-3 text-accent">{note}</div>}
            {v === 'setup' && <Setup s={s} act={act} steps={steps} onPost={() => postBounty()} go={go} pay={pay} onExplore={markExplored} />}
            {v === 'bounties' && <Bounties s={s} act={act} setOpen={setOpen} setup={!steps[1]} go={go} postBounty={postBounty} />}
            {v === 'agents' && <Agents s={s} act={act} setOpen={setOpen} />}
            {v === 'selling' && <Agents s={s} act={act} setOpen={setOpen} mine onPublish={() => setCreate('agent')} />}
            {v === 'trials' && <Trials s={s} act={act} go={go} />}
            {v === 'activity' && <Activity events={s.events} />}
            {v === 'settlement' && <Settlement s={s} setOpen={setOpen} />}
            {v === 'billing' && <Billing s={s} act={act} />}
            {v === 'repo' && <Repo s={s} act={act} go={go} />}
            {v === 'account' && <Account s={s} act={act} />}
    </>
  );

  const shoreWidth = useWide();
  // Signed out: nothing of the platform is shown (no sidebar, no pages, no
  // last page or progress), only the sign-in card over the water, until
  // GitHub sign-in completes.
  const locked = !viewer;

  return (
    <>
      <Water strength={0.5} paused={Boolean(open || create || locked || pay.asking)} />
      {!locked && <div className="contents">
      <Shore width={shoreWidth} paused={Boolean(open || create || locked || pay.asking)} />
      <div className="relative z-[1] grid min-h-screen grid-cols-1 font-sans text-[16px] leading-normal text-ink md:grid-cols-[260px_minmax(0,1fr)] lg:grid-cols-[300px_minmax(0,1fr)]">
        <aside ref={asideRef} className="relative flex flex-col gap-6 bg-[#EFDFBF] px-4 py-6 shadow-[0_6px_0_-2px_rgba(255,255,255,0.85),0_14px_18px_-6px_rgba(255,255,255,0.6)] md:shadow-none md:sticky md:top-0 md:h-screen md:overflow-y-auto md:bg-transparent [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {/* Sliding highlight behind the active item */}
          <div ref={pillRef} aria-hidden="true" className="pointer-events-none absolute left-4 right-4 top-0 rounded-xl bg-white/60 opacity-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_6px_18px_rgba(120,90,40,0.12)] backdrop-blur-md" />
          <div className="flex items-center justify-between gap-3">
            <a href="/" aria-label="Shoal home page" title="Back to the home page" className="flex items-center self-start px-3"><img src="/logo-mark.png" alt="" aria-hidden="true" className="block h-8 w-auto" /></a>
            <button onClick={() => setMenu((m) => !m)} aria-expanded={menu} aria-controls="platform-nav" className="flex cursor-pointer items-center gap-2 rounded-xl px-3 py-2 text-[15.5px] text-ink hover:bg-white/35 md:hidden">
              <Icon n={menu ? 'close' : 'menu'} />{menu ? 'Close' : TITLES[view]?.[0] ?? 'Menu'}
            </button>
          </div>
          <div id="platform-nav" className={(menu ? 'flex' : 'hidden') + ' flex-1 flex-col gap-6 md:flex'}>
          {NAV.map(([group, items]) => (
            <div key={group} className="flex flex-col gap-0.5">
              <div className="px-3 pb-1.5 text-xs font-medium uppercase tracking-[0.08em] text-[#6B5432]">{group}</div>
              {group === 'Account' && (
                <div className="flex items-center gap-3 px-3 py-2">
                  <span className="flex size-7 items-center justify-center rounded-full bg-accent text-sm font-semibold text-paper">{(viewer?.login || 'G')[0].toUpperCase()}</span>
                  {viewer ? <span className="truncate font-medium">{viewer.name || '@' + viewer.login}</span> : <a href={signInHref()} className="font-medium">Sign in with GitHub</a>}
                </div>
              )}
              {items.map(([id, label, icon]) => (
                <button key={id} onClick={() => { go(id); setMenu(false); }} className={'flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[15.5px] ' + (view === id ? 'font-medium' : 'text-ink/85 hover:bg-white/35') + ' relative z-[1] transition-[color,background-color] duration-300'} data-nav={id}>
                  <Icon n={icon} className="text-muted" />{label}
                  {id === 'setup' && steps.some((x) => !x) && <span className="ml-auto text-xs tabular-nums text-muted">{steps.filter(Boolean).length}/3</span>}
                  {id === 'bounties' && s.bounties.some((b) => LIVE.includes(b.status)) && <span className="ml-auto block size-2 animate-pulse rounded-full bg-accent" />}
                </button>
              ))}
            </div>
          ))}
          </div>
        </aside>

        <main className="relative min-w-0 overflow-x-clip [clip-path:inset(0)] md:[clip-path:inset(0_0_0_32px)] px-[clamp(20px,4vw,72px)] pb-24 pt-[clamp(32px,6vh,72px)] md:pl-[clamp(96px,9vw,150px)]">
          <div className="relative mx-auto max-w-[1100px]">
            {leaving && <Slide key={'out-' + leaving.v + leaving.n} out>{page(leaving.v)}</Slide>}
            <Slide key={view + navN}>{page(view)}</Slide>
          </div>
        </main>
      </div>
      {open && <Listing s={s} act={act} open={open} setOpen={setOpen} postBounty={postBounty} />}
      {create && <Create s={s} act={act} err={err} mode={create} startPain={createPain} setMode={setCreate} onPosted={(b) => { setCreate(null); go('bounties'); if (b?.id) setOpen({ kind: 'bounty', id: b.id }); }} />}
      </div>}
      {locked && <SignInGate s={s} view={view} err={err} />}
      {!locked && pay.asking && <PaymentPrompt pay={pay} />}
    </>
  );
}

// What a signed-out visitor gets: a sign-in card over the water, with nothing
// of the platform behind it, until GitHub sign-in completes (which reloads /app with the viewer set).
function SignInGate({ s, view, err }) {
  const loading = !s.health && !s.me;
  return (
    <div className={overlay + ' font-sans text-ink'} role="dialog" aria-modal="true" aria-labelledby="gate-title">
      {/* Beach, like the sidebar, with small waves washing up its lower edge. */}
      <ShoreCard className="m-auto w-full max-w-[460px] rounded-[24px]">
        <div className="flex flex-col gap-5 p-[clamp(20px,6vw,32px)]">
          <a href="/" aria-label="Shoal home page" title="Back to the home page" className="flex items-center self-start"><img src="/logo-mark.png" alt="" aria-hidden="true" className="block h-8 w-auto" /></a>
          <h1 id="gate-title" className="m-0 text-[26px] font-semibold tracking-[-0.03em]">{loading ? 'Connecting…' : 'Sign in to use Shoal'}</h1>
          {!loading && s.me?.oauth === false ? (
            <p className="m-0 text-[15px] text-[#6B5432]">GitHub sign-in isn't set up on this server yet, so nobody can sign in. Set <code>GITHUB_CLIENT_ID</code> and <code>GITHUB_CLIENT_SECRET</code> in <code>server/.env</code> and restart the server.</p>
          ) : !loading && (
            <>
              <p className="m-0 text-[15px] text-[#6B5432]">Shoal uses your GitHub account to connect repositories, open pull requests, and keep track of your bounties and agents.</p>
              <a href={signInHref(view)} className={primary + ' text-paper hover:text-paper'}>Sign in with GitHub</a>
            </>
          )}
          {err && <span className="text-sm text-bad">{err}</span>}
          <a href="/" className="self-start text-sm text-[#6B5432] underline">Back to the home page</a>
        </div>
      </ShoreCard>
    </div>
  );
}

// Page transition: the old page slides out to the left, the new one slides in from the right.
function Slide({ out, children }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { el.style.opacity = out ? '0' : '1'; return; }
    el.animate(out
      ? [{ transform: 'translateX(0)', opacity: 1 }, { transform: 'translateX(-120px)', opacity: 0 }]
      : [{ transform: 'translateX(120px)', opacity: 0 }, { transform: 'translateX(0)', opacity: 1 }],
      { duration: out ? 320 : 420, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'forwards', delay: out ? 0 : 60 });
  }, [out]);
  return <div ref={ref} className={'flex flex-col gap-10 ' + (out ? 'pointer-events-none absolute inset-x-0 top-0' : '')} style={out ? undefined : { opacity: 0 }} aria-hidden={out || undefined}>{children}</div>;
}

function Bounties({ s, act, setOpen, setup, go, postBounty }) {
  const [q, setQ] = useState(''), [chip, setChip] = useState('all');
  // Bounties remember their repo. The active repo's are matched to the latest
  // scan by test file (a rescan makes new ids); other repos' are listed with
  // the test as it was when posted, under their repo's name.
  const activeKey = s.connection?.type === 'github' ? s.connection.fullName : 'demo';
  const onActive = (b) => (b.repo?.key ?? activeKey) === activeKey;
  const items = [
    ...s.pains.filter((p) => !p.healthy).map((p) => ({ p, b: s.bounties.find((x) => onActive(x) && (x.painId === p.id || x.testFile === p.testFile)) })),
    ...s.bounties.filter((b) => !onActive(b)).map((b) => ({ p: { id: b.id, testFile: b.testFile, failures: 0, runs: 0, hoursPerWeek: 0, ...b.pain }, b, repo: b.repo?.fullName || 'Demo repo' })),
  ];
  const kind = ({ b }) => (!b ? 'listed' : LIVE.includes(b.status) ? 'racing' : b.status === 'surviving' ? 'surviving' : b.status === 'settled' ? 'fixed' : ['failed', 'clawed_back'].includes(b.status) ? 'nofix' : 'open');
  const count = (k) => items.filter((x) => kind(x) === k).length;
  const chips = [['all', 'All', items.length], ['listed', 'Not posted', count('listed')], ['open', 'Open', count('open')], ['racing', 'Racing', count('racing')], ['surviving', 'Survival window', count('surviving')], ['fixed', 'Fixed', count('fixed')], ['nofix', 'No fix', count('nofix')]];
  const shown = items.filter((x) => (chip === 'all' || kind(x) === chip) && (!q || x.p.testFile.toLowerCase().includes(q.toLowerCase())));
  const racing = shown.filter((x) => kind(x) === 'racing'), rest = shown.filter((x) => kind(x) !== 'racing');
  const Item = ({ p, b, repo }) => (
    <ItemCard key={(repo || '') + p.id + (b?.id || '')} onOpen={() => setOpen(b ? { kind: 'bounty', id: b.id } : { kind: 'pain', id: p.id })}
      icon={<Icon n="bounty" size={22} />}
      toggle={b ? <Tag tone={tone(b.status)}>{STATUS[b.status] || b.status}</Tag> : null}
      title={<span className="font-mono text-[17px]">{p.testFile}</span>} by={(repo ? 'In ' + repo + ' · ' : 'Found by scan · ') + p.failures + '/' + p.runs + ' runs failed'}
      meta={<div className="flex gap-1">{Array.from({ length: p.runs }, (_, i) => <span key={i} className={'h-2 flex-1 rounded-full ' + (i < p.failures ? 'bg-bad/75' : 'bg-accent/45')} />)}</div>}
      tags={<><Tag>{money(b ? b.reward : p.suggestedReward)} {b ? 'reward' : 'suggested'}</Tag><Tag>{p.hoursPerWeek} h/week lost</Tag>{b && <Tag>{b.competitors.length} competing</Tag>}</>}
      footL={b ? footer(b) : 'Not posted'}
      footR={<button className={b ? ghost : primary} onClick={(e) => { e.stopPropagation(); setOpen(b ? { kind: 'bounty', id: b.id } : { kind: 'pain', id: p.id }); }}>{b ? (LIVE.includes(b.status) ? 'Watch race' : 'View fixes') : 'View problem & fixes'}</button>} />
  );
  return (
    <Browse q={q} setQ={setQ} placeholder="Search test files" onRefresh={act(api.scan)} chips={chips} chip={chip} setChip={setChip}>
      {setup && <Empty>No scan yet. <button className="cursor-pointer text-accent underline" onClick={() => go('setup')}>Get started</button> to find your flaky tests.</Empty>}
      {racing.length > 0 && <Group title="Racing now">{racing.map(Item)}</Group>}
      {rest.filter((x) => !x.repo).length > 0 && <Group title="Flaky tests">{rest.filter((x) => !x.repo).map(Item)}</Group>}
      {rest.filter((x) => x.repo).length > 0 && <Group title="On your other repos">{rest.filter((x) => x.repo).map(Item)}</Group>}
      {!setup && !shown.length && <Empty>Nothing matches.</Empty>}
    </Browse>
  );
}

// A date, or a time of day when it's within a day (short demo survival windows).
const day = (iso) => { const d = new Date(iso); return Math.abs(d - Date.now()) < 86_400_000 ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' }); };
const footer = (b) => ({
  awaiting_funding: 'Waiting for funding', awaiting_go_ahead: 'Diagnosed: pick the winner', surviving: 'Paid out ' + (b.survival ? day(b.survival.endsAt) : 'later') + ' if it holds',
  settled: b.pullRequest?.url ? 'PR #' + b.pullRequest.number + ' opened' : 'Fix survived', clawed_back: 'Regressed, refunded', failed: 'No fix, $0 charged', payment_failed: 'Charge failed',
}[b.status] || (LIVE.includes(b.status) ? 'Race in progress' : 'Held in escrow'));
const Runs = ({ runs, tall }) => <div className="flex gap-1">{runs.map((ok, i) => <span key={i} className={(tall ? 'h-3' : 'h-2') + ' flex-1 rounded-full ' + (ok ? 'bg-accent/60' : 'bg-bad/75')} />)}</div>;
const Section = ({ t, children }) => <div className="flex flex-col gap-2 border-t border-ink/10 pt-3"><span className="text-sm font-medium text-muted">{t}</span>{children}</div>;

// How each competitor did once the race is over, and why the winner won, as
// the server decided it (bounties.js compete): fixes that pass 10 runs with no
// regressions are ranked by track record, then the smaller change, and the
// first one both judges pass wins.
function Results({ b, name }) {
  const won = b.results.find((r) => r.won);
  const verifiedCount = b.results.filter((r) => r.verified).length;
  const record = (r) => (r.rank ? `#${r.rank} of ${verifiedCount} on track record (score ${r.score})` : null);
  const why = (r) => {
    const runs = r.runs.length ? `${r.runs.filter(Boolean).length}/${r.runs.length} runs` : 'its runs';
    if (r.won) return `Passed ${runs} with no regressions and both judges passed it. Ranked ${record(r) ?? 'first'}, so it was judged first.`;
    if (!r.verified) return r.reason || 'Its fix didn’t pass verification.';
    if (r.judged && r.judges.some((j) => !j.ok)) return `Passed ${runs}, but ${r.judges.filter((j) => !j.ok).map((j) => j.name).join(' and ')} failed it in review.`;
    if (won && r.score != null && won.score != null && r.score < won.score) return `Passed ${runs}, but ranked ${record(r)} against ${won.score} for ${name(won.agentId)}, which was judged first and won.`;
    if (won && r.linesChanged != null && won.linesChanged != null && r.linesChanged > won.linesChanged) return `Passed ${runs} with the same track record as ${name(won.agentId)}, but changed more lines (${r.linesChanged} vs ${won.linesChanged}), so ${name(won.agentId)} was judged first and won.`;
    // A full tie keeps the order the competitors were picked in.
    if (won && r.score === won.score) return `Passed ${runs} and tied with ${name(won.agentId)} on track record and change size, so the order competitors were picked in decided: ${name(won.agentId)} was judged first and both judges passed it.`;
    return won ? `Passed ${runs}, but ${name(won.agentId)} ranked higher and won first.` : `Passed ${runs}.`;
  };
  const order = (r) => (r.won ? 0 : r.verified ? 1 + (r.rank ?? 50) : 100);
  const label = (r) => (r.won ? ['Winner', 'ok'] : r.verified ? ['Verified'] : [/^No fix delivered/.test(r.reason ?? '') ? 'No fix' : 'Rejected', 'bad']);
  return (
    <Section t={won ? `Why ${name(won.agentId)} won` : 'How each agent did'}>
      {[...b.results].sort((x, y) => order(x) - order(y)).map((r) => (
        <div key={r.agentId} className="flex flex-col gap-1.5 rounded-xl border border-ink/10 bg-white/40 p-3">
          <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{name(r.agentId)}</span><Tag tone={label(r)[1]}>{label(r)[0]}</Tag>
            <span className="ml-auto text-sm tabular-nums text-muted">{[r.linesChanged != null && r.linesChanged + ' lines', r.durationMs != null && Math.round(r.durationMs / 1000) + ' s'].filter(Boolean).join(' · ')}</span></div>
          <span className="text-sm">{why(r)}</span>
          {r.runs.length > 0 && <Runs runs={r.runs} />}
          {r.judges.map((j) => <span key={j.name} className="text-sm"><span className={j.ok ? 'text-accent' : 'text-bad'}>{j.ok ? 'Pass' : 'Fail'}</span> · {j.name}{j.via ? ' via ' + j.via : ''}: <span className="text-muted">{j.summary}</span></span>)}
        </div>
      ))}
      <span className="text-sm text-muted">Fixes that pass 10 runs in a row with no regressions are ranked by each agent’s record of verified and surviving fixes, never by price, and ties go to the smaller change. Judges review them in that order; the first both pass wins. Other agents’ code stays private.</span>
    </Section>
  );
}
const ESCROW = { awaiting_funding: 'Waiting for funding', held: 'Held in escrow, not charged', charged: 'Charged', released: 'Hold released, $0 charged', refunded: 'Refunded', charge_failed: 'Charge failed', refund_failed: 'Refund failed' };

// One open thing in a modal: a marketplace listing, a posted bounty, or a flaky test not posted yet.
function Listing({ s, act, open, setOpen, postBounty }) {
  const [reviewMode,setReviewMode]=useState(()=>{try{return localStorage.getItem('shoal.bounty-view')==='classic'?'classic':'review';}catch{return 'review';}});
  const chooseView=value=>{setReviewMode(value);try{localStorage.setItem('shoal.bounty-view',value);}catch{}};
  const close = () => setOpen(null);
  if (open.kind === 'listing') return <Modal onClose={close}><ListingDetail s={s} act={act} id={open.id} onClose={close} /></Modal>;
  const b = open.kind === 'bounty' ? s.bounties.find((x) => x.id === open.id) : null;
  const p = s.pains.find((x) => x.id === (b ? b.painId : open.id));
  if (!p && !b) return null;
  const name = (id) => nameOf(s, id);
  const w = b?.winningAttempt, sv = b?.survival;
  return (
    <Modal onClose={close} wide>
      <div className="flex flex-wrap gap-2 border-b border-ink/10 px-6 py-5 pr-16" role="group" aria-label="Bounty display style">
        <button className={reviewMode==='review'?primary:ghost} aria-pressed={reviewMode==='review'} onClick={()=>chooseView('review')}>Model review</button>
        <button className={reviewMode==='classic'?primary:ghost} aria-pressed={reviewMode==='classic'} onClick={()=>chooseView('classic')}>Classic bounty</button>
      </div>
      {reviewMode==='review'&&<FixReview key={b?.id||p.id} painId={b?.painId||p.id} bountyId={b?.id} events={s.events} onTrials={()=>{close();location.hash='trials';}}/>}
      <details key={reviewMode} open={reviewMode==='classic'} className="border-t border-ink/15">
      <summary className={'cursor-pointer px-8 py-5 text-[17px] font-medium '+(reviewMode==='classic'?'hidden':'')}>{b?'Bounty details, funding & race':'Problem details & post a bounty'}</summary>
      <div className={'grid grid-cols-1 overflow-hidden rounded-[24px] md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]'}>
        <div className="flex min-h-[340px] flex-col gap-4 bg-gradient-to-b from-white/60 to-accent/20 p-6 md:overflow-hidden">
          {b ? <><div className="text-sm font-medium text-muted">{LIVE.includes(b.status) ? 'Live race' : 'Race'}</div><Race bounty={b} events={s.events} names={name} /></> : <div className="my-auto flex flex-col items-center gap-4"><div className="flex w-[80%] gap-1">{Array.from({ length: p.runs }, (_, i) => <span key={i} className={'h-8 flex-1 rounded-md ' + (i < p.failures ? 'bg-bad/80' : 'bg-accent/45')} />)}</div><span className="text-sm text-muted">{p.failures} of {p.runs} scan runs failed</span></div>}
        </div>
        <div className="flex flex-col gap-4 p-8">
          <div className="flex flex-col gap-1"><span className="text-[30px] font-semibold tabular-nums tracking-[-0.03em]">{b?.escrow?.mode === 'credits' ? '$' + Number(b.reward).toFixed(2) : money(b ? b.reward : p.suggestedReward)}</span><span className="break-all font-mono text-[15px]">{b?.testFile ?? p.testFile}</span>
            {/* The repo the bounty is on, linked to GitHub (the bundled demo repo isn't on GitHub). */}
            {b?.repo && (b.repo.url
              ? <a className="text-sm text-accent underline" href={b.repo.url} target="_blank" rel="noreferrer">{b.repo.fullName} on GitHub</a>
              : <span className="text-sm text-muted">{b.repo.fullName}</span>)}</div>
          {b && <div className="flex flex-wrap gap-2"><Tag tone={tone(b.status)}>{STATUS[b.status] || b.status}</Tag><Tag>{s.health?.survivalMinutes ? s.health.survivalMinutes + '-minute demo survival' : b.survivalDays + '-day survival'}</Tag>{b.language && <Tag>{b.language}</Tag>}{b.apiModel && <Tag>API fix · {name(b.apiModel)}</Tag>}</div>}
          {p && <div className="grid grid-cols-2 gap-4 border-y border-ink/10 py-4 tabular-nums">
            <div className="flex flex-col"><span className="text-xl font-semibold">{Math.round((p.failures / p.runs) * 100)}%</span><span className="text-sm text-muted">Flake rate</span></div>
            <div className="flex flex-col"><span className="text-xl font-semibold">{p.hoursPerWeek} h</span><span className="text-sm text-muted">Lost per week</span></div>
          </div>}
          {!b && <button className={primary + ' self-start'} onClick={() => postBounty(p.id)}>Post a bounty</button>}
          {b?.status === 'awaiting_funding' && <button className={primary} onClick={act(async () => { const r = await api.fund(b.id); if (r?.checkoutUrl) location.href = r.checkoutUrl; })}>Fund with Stripe</button>}
          {b?.status === 'open' && b.escrow?.status === 'held' && <button className={primary} onClick={act(() => api.run(b.id))}>Start the race</button>}
          {b && <Section t="Competitors">
            <div className="flex flex-wrap gap-2">{b.competitors.map((id) => <button key={id} className="cursor-pointer" onClick={() => setOpen({ kind: 'listing', id })}><Tag tone={b.winner === id ? 'ok' : undefined}>{name(id)}{b.winner === id ? ' · winner' : ''}</Tag></button>)}</div>
            {b.competition?.attempts > 0 && <span className="text-sm text-muted">{b.competition.attempts} attempt{b.competition.attempts === 1 ? '' : 's'} · {b.competition.verified} verified. Only the winning fix's code is shared with you.</span>}
          </Section>}
          {b?.diagnoses?.length > 0 && <Section t="Diagnoses">
            {b.diagnoses.map((d) => <span key={d.model} className="text-sm"><span className={d.correct ? 'text-accent' : 'text-bad'}>{d.correct ? 'Correct' : 'Wrong'}</span> · {name(d.model)}{d.model === b.recommended ? ' (recommended)' : ''}{d.correct && d.score ? ' · ' + d.score + '/10' : ''}{d.fixCost != null ? ' · fix ~$' + d.fixCost.toFixed(3) : ''}: <span className="font-mono">{d.file}</span>{d.location ? ' · ' + d.location : ''}</span>)}
            {b.pickReason && <span className="text-sm text-muted">Why {name(b.recommended)}: {b.pickReason}.</span>}
            {b.recommended && ['competing', 'verifying', 'judging'].includes(b.status) && <span className="text-sm text-muted">{{
              competing: 'Step 1 of 3: the chosen model is writing the fix.',
              verifying: 'Step 2 of 3: running the tests on the fix.',
              judging: 'Step 3 of 3: the tests passed; two judges are reviewing the fix. The PR opens only if both pass it.',
            }[b.status]}</span>}
            {b.status === 'awaiting_go_ahead' && <>
              <span className="text-sm text-muted">No fix has been written yet. The chosen model writes it now; you're charged only if it's verified and both judges pass it.</span>
              <div className="flex flex-wrap gap-2">
                <button className={primary} onClick={act(() => api.buildFix(b.id, b.recommended))}>Run {name(b.recommended)} to make the fix</button>
                {b.diagnoses.filter((d) => d.correct && d.model !== b.recommended).map((d) => <button key={d.model} className={ghost} onClick={act(() => api.buildFix(b.id, d.model))}>Use {name(d.model)} instead</button>)}
              </div>
            </>}
          </Section>}
          {w && <Section t={'Winning fix · ' + name(w.agentId)}>
            <span className="text-[15px]">{w.summary}</span>
            <span className="text-sm text-muted">{w.files.join(', ')}{w.linesChanged != null ? ' · ' + w.linesChanged + ' lines changed' : ''}</span>
            {w.runs?.length > 0 && <Runs runs={w.runs} />}
            {w.judges?.map((j) => <span key={j.model} className="text-sm"><span className={j.ok ? 'text-accent' : 'text-bad'}>{j.ok ? 'Pass' : 'Fail'}</span> · {j.name}{j.via ? ' via ' + j.via : ''}: <span className="text-muted">{j.summary}</span></span>)}
          </Section>}
          {!b?.apiModel && b?.results?.length > 0 && <Results b={b} name={name} />}
          {b?.failures?.length > 0 && <Section t="Why the tries failed">{b.failures.map((f, i) => <span key={i} className="text-sm text-bad">{f}</span>)}</Section>}
          {sv && <Section t={'Survival window · ' + day(sv.startedAt) + ' to ' + day(sv.endsAt)}>
            {sv.checks.length === 0 && <span className="text-sm text-muted">No checks yet. Shoal re-runs the test after each new commit and on a schedule.</span>}
            {sv.checks.slice(-5).reverse().map((c, i) => <span key={i} className="text-sm"><span className={c.ok ? 'text-accent' : 'text-bad'}>{c.ok ? 'Still fixed' : 'Regressed'}</span> · {c.passed}/{c.runs} runs · <span className="text-muted">{c.trigger}, {day(c.at)}</span></span>)}
            {sv.reason && <span className="text-sm text-bad">{sv.reason}</span>}
            {b.status === 'surviving' && <button className={ghost + ' self-start'} onClick={act(() => api.survivalCheck(b.id))}>Re-check now</button>}
          </Section>}
          {b?.pullRequest && <Section t="Pull request">
            {b.pullRequest.url
              ? <a className="text-[15px] text-accent underline" href={b.pullRequest.url} target="_blank" rel="noreferrer">PR #{b.pullRequest.number} on GitHub: {b.pullRequest.title}</a>
              : <>
                <span className="text-[15px] font-medium">{b.pullRequest.title}</span>
                <span className="text-sm text-muted">Not opened on GitHub: {b.pullRequest.reason}</span>
                {b.repo?.url && <a className="text-sm text-accent underline" href={b.repo.url + '/compare'} target="_blank" rel="noreferrer">Open a PR yourself on {b.repo.fullName}</a>}
                <pre className="m-0 max-h-56 overflow-auto whitespace-pre-wrap rounded-xl bg-white/50 p-3 text-xs">{b.pullRequest.body}</pre>
              </>}
            <span className="flex flex-wrap gap-3 text-sm">{(b.pullRequest.files || []).map((f) => <a key={f} className="text-accent underline" href={'/api/bounties/' + encodeURIComponent(b.id) + '/file?path=' + encodeURIComponent(f)}>{f}</a>)}</span>
          </Section>}
          {b?.status === 'failed' && <p className="m-0 text-[15px]">{b.competition?.verified ? `${b.competition.verified} fix${b.competition.verified === 1 ? '' : 'es'} passed the tests, but the judges didn't pass any.` : 'No fix passed the tests.'} The hold was released and you paid $0.</p>}
          {b?.status === 'failed' && (b.failReason || b.failures?.length > 0) && <div className="flex flex-col gap-1">{(b.failReason ? [b.failReason] : b.failures.slice(-3)).map((f, i) => <span key={i} className="text-sm text-muted">{f}</span>)}</div>}
          {b?.status === 'clawed_back' && <p className="m-0 text-[15px]">The fix regressed during its survival window. You were refunded and the agent was paid $0.</p>}
          {b?.status === 'payment_failed' && <p className="m-0 text-[15px] text-bad">The fix was verified but the charge failed.</p>}
          {b?.winner && ['settled', 'clawed_back'].includes(b.status) && <ReviewForm s={s} act={act} b={b} />}
          {b && !LIVE.includes(b.status) && <button className={ghost + ' self-start text-bad! hover:text-bad!'} onClick={act(async () => {
            const note = b.escrow?.status === 'held' ? ' The held reward is released.' : b.status === 'surviving' ? ' The fix is still in its survival window, so you are refunded and the agent is not paid.' : '';
            if (!confirm('Delete this bounty?' + note)) return;
            await api.deleteBounty(b.id);
            close();
          })}>Delete bounty</button>}
          {b && <p className="m-0 text-sm text-muted">{ESCROW[b.escrow?.status] || b.escrow?.status}{b.escrow?.mode === 'stripe' ? ' · Stripe' + (b.escrow.live ? '' : ' test mode') : b.escrow?.mode === 'credits' ? ' · from credits' : ' · simulated'}.{['held', 'awaiting_funding'].includes(b.escrow?.status) ? ' No surviving fix, $0 charged.' : b.escrow?.status === 'charged' && b.status === 'surviving' ? ' Refunded if the fix regresses in its survival window.' : ''}</p>}
        </div>
      </div>
      </details>
    </Modal>
  );
}

function QuickPost({ p, s, act, onPosted }) {
  const [reward, setReward] = useState(String(p.suggestedReward));
  const [days, setDays] = useState(7);
  const [picks, setPicks] = useState(null);
  const post = act(async () => {
    let b;
    try {
      b = await api.postBounty(p.id, Number(reward) || p.suggestedReward, { survivalDays: days, competitors: picks });
    } catch (e) {
      // No card yet: ask for one instead of showing an error.
      // "Later" there posts this bounty right away (simulated funding).
      if (e.data?.needsPaymentMethod) { dispatchEvent(new CustomEvent('shoal:need-payment', { detail: { retry: post } })); return; }
      throw e;
    }
    if (b.checkoutUrl) { location.href = b.checkoutUrl; return; }
    if (b.escrow?.status === 'held') await api.run(b.id);
    onPosted(b);
  });
  return (
    <div className="flex flex-col gap-3">
      <Label t="Your reward"><div className="flex gap-2"><span className="flex items-center rounded-xl border border-ink/15 bg-white/60 px-3 text-muted">$</span><input type="number" min="1" max="10000" className={field + ' tabular-nums'} value={reward} onChange={(e) => setReward(e.target.value)} /></div></Label>
      <div role="group" aria-label="Survival window" className="flex flex-col gap-1.5 text-sm text-muted">Survival window: the agent is paid only if the fix holds this long
        <div className="flex gap-2">{[7, 10, 14].map((d) => <button key={d} aria-pressed={days === d} onClick={() => setDays(d)} className={'flex-1 cursor-pointer rounded-xl border px-3 py-2 text-[15px] ' + (days === d ? 'border-ink bg-ink text-paper' : 'border-ink/15 bg-white/60 text-ink')}>{d} days</button>)}</div>
        {s.health?.survivalMinutes && <span className="text-accent">Demo mode: this server shortens every window to {s.health.survivalMinutes} minutes.</span>}
      </div>
      <CompetitorPicker s={s} value={picks} onChange={setPicks} />
      <button className={primary} disabled={picks?.length === 0} onClick={post}>Post bounty and start the race</button>
    </div>
  );
}

// Only the team that posted the bounty can review its winner, once, after the survival window.
function ReviewForm({ s, act, b }) {
  const [stars, setStars] = useState(0), [body, setBody] = useState(''), [done, setDone] = useState(false);
  if (!s.me?.viewer) return <p className="m-0 text-sm text-muted"><a className="text-accent underline" href={signInHref('bounties')}>Sign in with GitHub</a> to review {nameOf(s, b.winner)}.</p>;
  if (done) return <p className="m-0 text-sm text-accent">Thanks, your review is on {nameOf(s, b.winner)}'s listing.</p>;
  return (
    <Section t={'Review ' + nameOf(s, b.winner)}>
      <div className="flex gap-1">{[1, 2, 3, 4, 5].map((n) => <button key={n} aria-label={n + ' stars'} onClick={() => setStars(n)} className="cursor-pointer"><Icon n="star" size={22} fill={stars >= n ? '#9A5B00' : 'none'} className={stars >= n ? 'text-[#9A5B00]' : 'text-ink/30'} /></button>)}</div>
      <textarea rows="3" className={field + ' resize-y'} value={body} onChange={(e) => setBody(e.target.value)} placeholder="How was the fix and the PR?" />
      <button className={ghost + ' self-start'} disabled={!stars} onClick={act(async () => { await api.review({ listingId: b.winner, bountyId: b.id, stars, body }); setDone(true); })}>Post review</button>
    </Section>
  );
}

function Create({ s, act, err, mode, startPain, setMode, onPosted }) {
  const close = () => setMode(null);
  // A bounty is on a repo: pick it first. Picking another one switches Shoal
  // to it and scans it, then its flaky tests are listed. Bounties keep their
  // repo after that (server/src/repos.js).
  const activeKey = s.connection?.type === 'github' ? s.connection.fullName : 'demo';
  const [repos, setRepos] = useState(null), [switchingTo, setSwitchingTo] = useState(null), [repoErr, setRepoErr] = useState('');
  // The newest event when a switch began: only a scan finishing after it counts.
  const [switchFrom, setSwitchFrom] = useState(0);
  useEffect(() => { if (mode === 'bounty') api.repos().then(setRepos, () => setRepos([])); }, [mode]);
  // Every repo you can see. One you can't push to still works: its winning
  // fix comes as a draft PR to download instead of a GitHub PR.
  const listed = (repos || []).filter((r) => !r.archived);
  const choices = [...new Set([...(activeKey !== 'demo' ? [activeKey] : []), ...listed.map((r) => r.fullName)])];
  const readOnly = (name) => name === activeKey ? s.connection?.canWrite === false : listed.find((r) => r.fullName === name)?.canWrite === false;
  const lastScan = [...s.events].reverse().find((e) => /^scan\./.test(e.type));
  const scanning = ['scan.started', 'scan.file'].includes(lastScan?.type);
  const ready = switchingTo === null;
  useEffect(() => { if (switchingTo !== null && activeKey === switchingTo && lastScan?.type === 'scan.completed' && lastScan.id > switchFrom) setSwitchingTo(null); }, [activeKey, switchingTo, lastScan?.id, switchFrom]);
  const pickRepo = async (key) => {
    if (key === activeKey) return;
    setRepoErr(''); setSwitchFrom(s.events.at(-1)?.id ?? 0); setSwitchingTo(key);
    try { await (key === 'demo' ? api.connectDemo() : api.connect(key)); await s.refresh(); if (key === 'demo') await api.scan(); }
    catch (e) { setRepoErr(e.message); setSwitchingTo(null); }
  };
  const onActive = (b) => (b.repo?.key ?? activeKey) === activeKey;
  const flaky = s.pains.filter((p) => !p.healthy && !s.bounties.some((b) => onActive(b) && (b.painId === p.id || b.testFile === p.testFile) && !['failed', 'clawed_back'].includes(b.status)));
  const [painId, setPainId] = useState(startPain || '');
  const pain = flaky.find((p) => p.id === painId) || flaky[0];
  if (mode === 'agent') return <Modal onClose={close}><PublishAgent s={s} act={act} onDone={close} /></Modal>;
  return (
    <Modal onClose={close}>
      <div className="flex flex-col gap-5 p-8">
        <h2 className="m-0 text-[26px] font-semibold tracking-[-0.03em]">Post a bounty</h2>
        <Label t="Repository">
          <select className={field} value={switchingTo ?? activeKey} disabled={switchingTo !== null} onChange={(e) => pickRepo(e.target.value)}>
            <option value="demo">Bundled demo repo</option>
            {choices.map((r) => <option key={r} value={r}>{r}{readOnly(r) ? ' · read-only (draft PR)' : ''}</option>)}
            {repos === null && <option disabled>Loading your GitHub repos…</option>}
          </select>
        </Label>
        {repoErr && <span className="text-sm text-bad">{repoErr}</span>}
        {s.health?.mock && activeKey !== 'demo' && !switchingTo && <span className="text-sm text-bad">This server has no API keys (practice mode), which only works on the bundled demo repo. Add ANTHROPIC_API_KEY or OPENAI_API_KEY to fix {activeKey}.</span>}
        {activeKey !== 'demo' && readOnly(activeKey) && !switchingTo && <span className="text-sm text-muted">You can't push to {activeKey}, so the winning fix comes as a draft PR you can download. Get write access (and reconnect) for real PRs.</span>}
        {err && <span className="text-sm text-bad">{err}</span>}
        {!ready ? (
          <div className="text-muted">Switching to {switchingTo === 'demo' ? 'the demo repo' : switchingTo} and scanning for flaky tests…</div>
        ) : flaky.length === 0 ? (
          <div className="flex flex-col gap-3 text-muted">{s.pains.length ? 'Every flaky test in this repo already has a bounty.' : scanning ? 'Scanning for flaky tests…' : 'No scan of this repo yet.'}{!s.pains.length && !scanning && <button className={primary + ' self-start'} onClick={act(api.scan)}>Scan for flaky tests</button>}</div>
        ) : (<>
          <Label t="Which test?"><select className={field} value={pain?.id} onChange={(e) => setPainId(e.target.value)}>{flaky.map((p) => <option key={p.id} value={p.id}>{p.testFile} · {p.failures}/{p.runs} failed</option>)}</select></Label>
          {pain && <QuickPost key={pain.id} p={pain} s={s} act={act} onPosted={onPosted} />}
        </>)}
      </div>
    </Modal>
  );
}

function Activity({ events }) {
  const [q, setQ] = useState(''), [chip, setChip] = useState('all');
  const grp = (t) => /^(bid|bounty|work)\./.test(t) ? 'race' : /^(verify|survival|proof)\./.test(t) ? 'verify' : /^(escrow|credits|pr)\./.test(t) ? 'money' : /^(trials|claude|codex|marketplace|agent)\./.test(t) ? 'market' : 'setup';
  const all = events.slice(-150).reverse();
  const n = (g) => all.filter((e) => grp(e.type) === g).length;
  const chips = [['all', 'All', all.length], ['race', 'Races', n('race')], ['verify', 'Verification', n('verify')], ['money', 'Money & PRs', n('money')], ['market', 'Marketplace & trials', n('market')], ['setup', 'Repo', n('setup')]];
  const rows = all.filter((e) => (chip === 'all' || grp(e.type) === chip) && (!q || (e.message || '').toLowerCase().includes(q.toLowerCase())));
  return (
    <Browse label="Log" q={q} setQ={setQ} placeholder="Search activity" onRefresh={() => {}} chips={chips} chip={chip} setChip={setChip}>
      <div className="glass rounded-[20px] px-6 py-2">
        {rows.length === 0 && <div className="py-6 text-muted">Nothing yet.</div>}
        {rows.map((e) => (
          <div key={e.id} className="grid grid-cols-[80px_minmax(0,1fr)] gap-4 border-t border-ink/10 py-3 first:border-t-0">
            <span className="text-sm tabular-nums text-muted">{new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
            <span className={/rejected|failed|error/.test(e.type) ? 'text-bad' : /passed|settled|opened/.test(e.type) ? 'text-accent' : ''}>{e.message}</span>
          </div>
        ))}
      </div>
    </Browse>
  );
}

function Settlement({ s, setOpen }) {
  const m = s.settlement || {};
  const stats = [['Fixed and survived', m.bountiesSettled], ['In survival window', m.inSurvival?.length], ['Clawed back', m.bountiesClawedBack], ['No fix', m.bountiesFailed], ['In escrow', money(m.heldInEscrow)], ['Pending payouts', money(m.pendingPayouts)], ['Paid to agents', money(m.totalPaid)], ['Hours / week back', m.hoursReturnedPerWeek], ['Top earner', m.topEarner || '–']];
  const LEDGER = { pending: ['In survival window'], paid: ['Paid', 'ok'], clawed_back: ['Clawed back', 'bad'] };
  return (
    <section className="flex flex-col gap-5">
      <h2 className="m-0 border-b border-ink/12 pb-3 text-[24px] font-semibold tracking-[-0.025em]">This morning</h2>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">{stats.map(([k, v]) => <div key={k} className={card}><span className="text-[26px] font-semibold tabular-nums tracking-[-0.03em]">{v ?? 0}</span><span className="text-sm text-muted">{k}</span></div>)}</div>
      {(m.clearedToday?.length > 0 || m.clawedBackToday?.length > 0) && <div className="glass rounded-[20px] px-6 py-4 text-[15px]">
        {m.clearedToday.map((t) => <div key={t.bountyId}><span className="text-accent">Cleared</span> · {t.agent} was paid {money(t.agentPayout)}</div>)}
        {m.clawedBackToday.map((t) => <div key={t.bountyId}><span className="text-bad">Clawed back</span> · {t.agent}'s fix regressed, {money(t.amount)} refunded</div>)}
      </div>}
      <div className="text-[17px] font-semibold">Ledger</div>
      <div className="glass rounded-[20px] px-6 py-2">
        {s.ledger.length === 0 && <div className="py-4 text-muted">Nothing settled yet.</div>}
        {s.ledger.map((t, i) => <button key={i} onClick={() => setOpen({ kind: 'bounty', id: t.bountyId })} className="grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto_90px_110px] items-center gap-4 border-t border-ink/10 py-3 text-left tabular-nums first:border-t-0"><span className="truncate">{t.title || s.bounties.find((b) => b.id === t.bountyId)?.title || t.bountyId} <span className="text-muted">· {t.agentName || t.agentId}</span></span><Tag tone={LEDGER[t.status]?.[1]}>{LEDGER[t.status]?.[0] || t.status}</Tag><span>{money(t.amount)}</span><span className="text-right text-muted">fee {money(t.platformFee)}</span></button>)}
      </div>
    </section>
  );
}

function Billing({ s, act }) {
  const c = s.credits;
  return (
    <section className="flex flex-col gap-5">
      {s.me?.viewer && <PaymentMethod act={act} from="billing" />}
      <h2 className="m-0 border-b border-ink/12 pb-3 text-[24px] font-semibold tracking-[-0.025em]">Credits</h2>
      <div className="glass-dark flex flex-wrap items-center gap-4 rounded-[20px] p-6 text-paper">
        <div className="flex flex-col"><span className="text-[32px] font-semibold tabular-nums">{c ? '$' + Number(c.balance ?? 0).toFixed(2) : '—'}</span><span className="text-sm text-mist">Balance for API fixes · {c?.payments || s.health?.payments} payments</span></div>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {[10, 25, 50].map((p) => (
          <div key={p} className={card}><span className="text-[26px] font-semibold">{money(p)}</span><span className="text-[15px] text-muted">A verified fix uses its real API cost plus the 15% fee. Unverified costs nothing.</span>
            <button className={ghost + ' mt-2 self-start'} onClick={act(async () => { const r = await api.buyCredits(p); if (r?.checkoutUrl) location.href = r.checkoutUrl; })}>Buy</button></div>
        ))}
        <CustomCredits act={act} />
      </div>
      {(c?.purchases?.length > 0 || c?.charges?.length > 0) && <>
        <div className="text-[17px] font-semibold">History</div>
        <div className="glass rounded-[20px] px-6 py-2">
          {[...(c.purchases || []).map((x) => ({ ...x, k: 'Bought credits', sign: '+' })), ...(c.charges || []).map((x) => ({ ...x, k: 'API fix' + (x.model ? ' · ' + x.model : ''), sign: '−' }))]
            .sort((a, b) => String(b.at ?? b.createdAt ?? '').localeCompare(String(a.at ?? a.createdAt ?? '')))
            .map((x, i) => <div key={i} className="grid grid-cols-[minmax(0,1fr)_100px] gap-4 border-t border-ink/10 py-3 tabular-nums first:border-t-0"><span className="truncate">{x.k}</span><span className={'text-right ' + (x.sign === '+' ? 'text-accent' : '')}>{x.sign}${Number(x.amount).toFixed(2)}</span></div>)}
        </div>
      </>}
    </section>
  );
}

function CustomCredits({ act }) {
  const [v, setV] = useState('');
  const n = Number(v), ok = Number.isInteger(n) && n >= 5 && n <= 1000;
  return (
    <div className={card}>
      <span className="text-[26px] font-semibold">Custom</span>
      <span className="text-[15px] text-muted">Any whole amount from $5 to $1,000.</span>
      <div className="mt-2 flex gap-2">
        <label className="flex min-w-0 flex-1 items-center gap-1 rounded-xl border border-ink/15 bg-white/60 px-3 focus-within:border-accent">
          <span className="text-muted">$</span>
          <input type="number" inputMode="numeric" min="5" max="1000" step="1" value={v} onChange={(e) => setV(e.target.value)} placeholder="75" aria-label="Custom credit amount in dollars" className="w-full min-w-0 bg-transparent py-2.5 tabular-nums outline-none" />
        </label>
        <button className={ghost} disabled={!ok} onClick={act(async () => { const r = await api.buyCredits(n); if (r?.checkoutUrl) location.href = r.checkoutUrl; else setV(''); })}>Buy</button>
      </div>
      {v && !ok && <span className="text-sm text-bad">Enter a whole amount from $5 to $1,000.</span>}
    </div>
  );
}

function Account({ s, act }) {
  const v = s.me?.viewer, role = s.me?.role;
  const signIn = s.me?.oauth === false
    ? <span className="text-sm text-muted">GitHub sign-in isn't set up on this server. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.</span>
    : <a href={signInHref('account')} className={primary + ' text-paper hover:text-paper'}>Sign in with GitHub</a>;
  return (
    <section className="flex flex-col gap-5">
      <h2 className="m-0 border-b border-ink/12 pb-3 text-[24px] font-semibold tracking-[-0.025em]">GitHub</h2>
      <div className={card + ' md:flex-row md:items-center'}>
        {v?.avatarUrl ? <img src={v.avatarUrl} alt="" className="size-14 rounded-full" /> : <span className="flex size-14 items-center justify-center rounded-full bg-accent text-xl font-semibold text-paper">{(v?.login || 'G')[0].toUpperCase()}</span>}
        <div className="flex flex-1 flex-col"><span className="text-[21px] font-semibold">{v ? v.name || '@' + v.login : 'Not signed in'}</span><span className="text-[15px] text-muted">{v ? '@' + v.login : 'Sign in to connect private repos, open pull requests, publish agents and write reviews.'}</span></div>
        {v ? <button className={ghost} onClick={act(async () => { await api.signOut(); location.href = '/app'; })}>Sign out</button> : signIn}
      </div>
      <h2 className="m-0 border-b border-ink/12 pb-3 text-[24px] font-semibold tracking-[-0.025em]">How you use Shoal</h2>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {[['team', 'I have dev pain', 'Find flaky tests, post bounties, pay only for fixes that survive.'], ['builder', 'I build agents', 'Publish an agent with a webhook and earn from verified fixes.']].map(([id, t, b]) => (
          <button key={id} onClick={act(() => api.setRole(id))} className={card + ' cursor-pointer text-left ' + (role === id ? 'ring-2 ring-accent/60' : '')}><span className="text-[19px] font-semibold">{t}</span><span className="text-[15px] text-muted">{b}</span>{role === id && <span className="text-sm text-accent">Selected</span>}</button>
        ))}
      </div>
      {v && <DeleteAccount login={v.login} act={act} />}
    </section>
  );
}

// The signed-in user's saved card (server/src/billing.js). A new account (or
// one that never set up payments) is asked right after signing in; asked
// again whenever a bounty needs a card and there isn't one.
function usePayment(viewer) {
  const [billing, setBilling] = useState(null);
  const [needed, setNeeded] = useState(false);
  const retry = useRef(null);
  useEffect(() => { if (viewer) api.billing().then(setBilling, () => setBilling(null)); else setBilling(null); }, [viewer?.login]);
  useEffect(() => {
    const ask = (e) => { retry.current = e.detail?.retry ?? null; setNeeded(true); };
    addEventListener('shoal:need-payment', ask);
    return () => removeEventListener('shoal:need-payment', ask);
  }, []);
  const asking = Boolean(billing && !billing.ready && (needed || !billing.prompted));
  return {
    billing, asking, needed,
    later: async () => {
      setNeeded(false); setBilling(await api.billingLater());
      const again = retry.current; retry.current = null;
      if (again) await again();
    },
    setup: async (from) => {
      const r = await api.setupBilling(from);
      if (r.url) { location.href = r.url; return; }
      setNeeded(false); setBilling(r.billing);
    },
  };
}

const cardLine = (c) => c ? c.brand.charAt(0).toUpperCase() + c.brand.slice(1) + ' •••• ' + c.last4 + ' · expires ' + String(c.expMonth).padStart(2, '0') + '/' + String(c.expYear).slice(-2) : null;

// For a new account (or posting a bounty without a card): add a payment
// method once, so bounties never need a Checkout page.
function PaymentPrompt({ pay }) {
  const [busy, setBusy] = useState(false), [err, setErr] = useState('');
  const run = (fn) => async () => { setBusy(true); setErr(''); try { await fn(); } catch (e) { setErr(e.message); } finally { setBusy(false); } };
  const simulated = pay.billing?.mode === 'simulated';
  return (
    <div className={overlay + ' font-sans text-ink'} role="dialog" aria-modal="true" aria-labelledby="pay-title">
      <ShoreCard className="m-auto w-full max-w-[460px] rounded-[24px]">
        <div className="flex flex-col gap-5 p-[clamp(20px,6vw,32px)]">
          <span role="img" aria-label="Shoal" className="flex items-center self-start"><img src="/logo-mark.png" alt="" aria-hidden="true" className="block h-8 w-auto" /></span>
          <h1 id="pay-title" className="m-0 text-[26px] font-semibold tracking-[-0.03em]">{pay.needed ? 'Add a payment method to post bounties' : 'Set up payments'}</h1>
          <p className="m-0 text-[15px] text-[#6B5432]">
            Save a card once with Stripe. When you post a bounty, its reward is held on this card and charged only if an agent's fix is verified. It's refunded if the fix doesn't survive. Nothing is charged now.
            {simulated && ' (Payments are simulated on this server, so no real card is needed.)'}
          </p>
          <button className={primary} disabled={busy} onClick={run(() => pay.setup('bounties'))}>{busy ? 'Opening Stripe…' : simulated ? 'Use a test card' : 'Add a card with Stripe'}</button>
          {err && <span className="text-sm text-bad">{err}</span>}
          <button className="cursor-pointer self-start text-sm text-[#6B5432] underline" disabled={busy} onClick={run(pay.later)}>Later</button>
          {!simulated && <span className="-mt-3 text-sm text-[#6B5432]">With Later you can post bounties right away; their rewards are simulated (nothing held or charged) until you add a card.</span>}
        </div>
      </ShoreCard>
    </div>
  );
}

// The saved card, and changing or removing it. from: the page Stripe sends you back to.
function PaymentMethod({ act, from = 'account' }) {
  const [b, setB] = useState(null);
  useEffect(() => { api.billing().then(setB, () => setB(null)); }, []);
  const change = act(async () => { const r = await api.setupBilling(from); if (r.url) location.href = r.url; else setB(r.billing); });
  const remove = act(async () => setB(await api.removeBilling()));
  return (
    <>
      <h2 className="m-0 border-b border-ink/12 pb-3 text-[24px] font-semibold tracking-[-0.025em]">Payment method</h2>
      <div className={card + ' md:flex-row md:items-center'}>
        <span className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-accent/12 text-accent"><Icon n="card" size={24} /></span>
        <div className="flex flex-1 flex-col">
          <span className="text-[19px] font-semibold">{b?.ready ? cardLine(b.card) || 'Card saved' : 'No card saved'}</span>
          <span className="text-[15px] text-muted">{b?.ready ? 'Bounty rewards are held on this card and charged only for verified fixes.' + (b.simulated ? ' Simulated: no real money moves.' : '') : 'Add a card so you can post bounties. Nothing is charged until a fix is verified.'}</span>
        </div>
        <div className="flex gap-2">
          <button className={b?.ready ? ghost : primary} onClick={change}>{b?.ready ? 'Change card' : 'Add a card'}</button>
          {b?.ready && <button className={ghost} onClick={remove}>Remove</button>}
        </div>
      </div>
    </>
  );
}

// Typing your GitHub username unlocks the button, so it can't be hit by accident.
function DeleteAccount({ login, act }) {
  const [typed, setTyped] = useState('');
  return (
    <>
      <h2 className="m-0 border-b border-ink/12 pb-3 text-[24px] font-semibold tracking-[-0.025em]">Delete account</h2>
      <div className={card + ' border-bad/30'}>
        <span className="text-[15px]">This can't be undone. It wipes everything: the connected repository and its scans, your bounties (held rewards are released and fixes still in their survival window are refunded), model trials, activity, unused credits (they're forfeited), your saved card, and the agents, models and reviews in the marketplace. Shoal's access to your GitHub account is revoked and you're signed out, so signing in again starts fresh.</span>
        <Label t={'Type ' + login + ' to confirm'}><input className={field} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck="false" /></Label>
        <button className={btn + ' self-start bg-bad text-paper hover:bg-ink'} disabled={typed.trim() !== login} onClick={act(async () => { await api.deleteAccount(); try { localStorage.removeItem('shoal.explored.' + login); } catch {} location.href = '/app'; })}>Delete my account</button>
      </div>
    </>
  );
}
