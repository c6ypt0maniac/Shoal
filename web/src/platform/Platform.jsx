import { useEffect, useMemo, useRef, useState } from 'react';
import Water from '../components/Water.jsx';
import { api } from './api.js';
import { useShoal } from './useShoal.js';
import Race, { COLORS } from './Race.jsx';
import Fish from './Fish.jsx';
import Shore from './Shore.jsx';

const btn = 'inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-[15px] font-medium transition-colors disabled:cursor-default disabled:opacity-40';
const primary = btn + ' bg-accent text-paper hover:bg-ink';
const ghost = btn + ' border border-ink/15 bg-white/55 text-ink hover:bg-white/85';
const field = 'w-full rounded-xl border border-ink/15 bg-white/60 px-3 py-2.5 text-base text-ink outline-none focus:border-accent';
const card = 'glass flex flex-col gap-3 rounded-[20px] p-6';
const money = (n) => '$' + Number(n || 0).toLocaleString();
const LIVE = ['bidding', 'working', 'verifying'];
const STATUS = { open: 'Open', awaiting_funding: 'Needs funding', bidding: 'Bidding', working: 'Racing', verifying: 'Verifying', settled: 'Fixed', failed: 'No fix', payment_failed: 'Payment failed' };

// Line icons, 20px, stroke = currentColor.
const PATHS = {
  user: 'M10 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm-6 7c.6-3 3-4.5 6-4.5s5.4 1.5 6 4.5',
  card: 'M3 5.5h14v9H3zM3 8.5h14',
  play: 'M5 4l11 6-11 6z',
  repo: 'M5 3h9a1 1 0 0 1 1 1v12H6a1 1 0 0 1-1-1zM5 13.5h10M8 6h4',
  pulse: 'M2 10h4l2-5 4 10 2-5h4',
  bounty: 'M10 2.5v15M13.5 5.5H8.25a2.25 2.25 0 0 0 0 4.5h3.5a2.25 2.25 0 0 1 0 4.5H6',
  fish: 'M17 10c-2-3.5-6-4.5-9-2.5L4 5v10l4-2.5c3 2 7 1 9-2.5Z',
  plus: 'M10 4v12M4 10h12',
  chart: 'M4 16V9M8 16V5M12 16v-6M16 16V7',
  search: 'M9 15a6 6 0 1 0 0-12 6 6 0 0 0 0 12Zm4.5-1.5L17 17',
  refresh: 'M16 7a6.5 6.5 0 0 0-11.5-1.5M4 3v3h3M4 13a6.5 6.5 0 0 0 11.5 1.5M16 17v-3h-3',
  star: 'M10 2.8l2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L2.8 8.1l5-.7z',
  chip: 'M6 6h8v8H6zM8 3v3M12 3v3M8 14v3M12 14v3M3 8h3M3 12h3M14 8h3M14 12h3',
};
const Icon = ({ n, size = 20, fill = 'none', className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill={fill} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={'shrink-0 ' + className} aria-hidden="true"><path d={PATHS[n]} /></svg>
);

const NAV = [
  ['Account', [['account', 'Profile', 'user'], ['billing', 'Credits & billing', 'card']]],
  ['Workspace', [['setup', 'Get started', 'play'], ['repo', 'Repository', 'repo'], ['activity', 'Activity', 'pulse']]],
  ['Marketplace', [['bounties', 'Bounties', 'bounty'], ['agents', 'Agents for hire', 'fish'], ['selling', 'Your agents', 'plus']]],
  ['Results', [['settlement', 'Settlement', 'chart']]],
];
const TITLES = {
  account: ['Profile', 'Your GitHub account and role'],
  billing: ['Credits & billing', 'Credit packs for API fixes. Rewards are held, never charged until a fix is verified.'],
  setup: ['Get started', 'Three steps. Try everything with the demo repo first.'],
  repo: ['Repository', 'What agents can see, and how Shoal stays in sync'],
  activity: ['Activity', 'Every bid, patch, green run and rejection'],
  bounties: ['Bounties', 'Flaky tests from your repo, priced by the dev-hours they cost'],
  agents: ['Agents for hire', 'Agents built by us and by other people. Enabled agents bid on your new bounties.'],
  selling: ['Your agents', 'Agents you published to the marketplace'],
  settlement: ['Settlement', 'What was fixed, what was paid and the hours you got back'],
};

function useWide() {
  const q = () => (matchMedia('(min-width: 1024px)').matches ? 300 : 260);
  const [w, setW] = useState(q);
  useEffect(() => { const m = matchMedia('(min-width: 1024px)'), f = () => setW(q()); m.addEventListener('change', f); return () => m.removeEventListener('change', f); }, []);
  return w;
}

export default function Platform() {
  const s = useShoal();
  const [view, setView] = useState(() => location.hash.slice(1) || 'setup');
  const [open, setOpen] = useState(null);
  const [create, setCreate] = useState(null);
  const [err, setErr] = useState('');
  const [leaving, setLeaving] = useState(null), [navN, setNavN] = useState(0);
  const go = (v) => {
    if (v === view) return;
    setLeaving({ v: view, n: navN }); setNavN((n) => n + 1); setView(v);
    history.replaceState(null, '', '#' + v); scrollTo(0, 0);
    clearTimeout(go.t); go.t = setTimeout(() => setLeaving(null), 420);
  };
  const act = (fn) => async (...a) => { setErr(''); try { const r = await fn(...a); await s.refresh(); return r; } catch (e) { setErr(e.message); } };

  const lastConnect = [...s.events].reverse().find((e) => /^connect\./.test(e.type));
  const connected = lastConnect ? lastConnect.type === 'connect.done' : s.connection?.type === 'github';
  const steps = [connected, s.pains.length > 0, s.bounties.length > 0];
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
    place(); addEventListener('resize', place);
    return () => removeEventListener('resize', place);
  }, [view, viewer]);
  const page = (v) => (
    <>
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div className="flex flex-col gap-1"><h1 className="m-0 text-[clamp(28px,3vw,40px)] font-semibold tracking-[-0.035em]">{TITLES[v]?.[0]}</h1><span className="text-[17px] text-muted">{TITLES[v]?.[1]}</span></div>
              {['bounties', 'agents', 'selling'].includes(v) && <button className={primary} onClick={() => setCreate(v === 'bounties' ? 'bounty' : 'agent')}><Icon n="plus" size={18} />{v === 'bounties' ? 'Post a bounty' : 'Publish an agent'}</button>}
            </div>
            {err && <div className="glass rounded-2xl px-5 py-3 text-bad">{err}</div>}
            {v === 'setup' && <Setup s={s} act={act} steps={steps} onPost={() => setCreate('bounty')} go={go} />}
            {v === 'bounties' && <Bounties s={s} act={act} setOpen={setOpen} setup={!steps[1]} go={go} />}
            {v === 'agents' && <Agents s={s} act={act} setOpen={setOpen} />}
            {v === 'selling' && <Agents s={s} act={act} setOpen={setOpen} mine onPublish={() => setCreate('agent')} />}
            {v === 'activity' && <Activity events={s.events} />}
            {v === 'settlement' && <Settlement s={s} />}
            {v === 'billing' && <Billing s={s} act={act} />}
            {v === 'repo' && <Repo s={s} act={act} go={go} />}
            {v === 'account' && <Account s={s} />}
    </>
  );

  return (
    <>
      <Water strength={0.5} />
      <Shore width={useWide()} />
      <div className="relative z-[1] grid min-h-screen grid-cols-1 font-sans text-[16px] leading-normal text-ink md:grid-cols-[260px_minmax(0,1fr)] lg:grid-cols-[300px_minmax(0,1fr)]">
        <aside ref={asideRef} className="relative flex flex-col gap-6 bg-[#EFDFBF] px-4 py-6 shadow-[0_6px_0_-2px_rgba(255,255,255,0.85),0_14px_18px_-6px_rgba(255,255,255,0.6)] md:shadow-none md:sticky md:top-0 md:h-screen md:overflow-y-auto md:bg-transparent [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {/* Sliding highlight behind the active item */}
          <div ref={pillRef} aria-hidden="true" className="pointer-events-none absolute left-4 right-4 top-0 rounded-xl bg-white/60 opacity-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_6px_18px_rgba(120,90,40,0.12)] backdrop-blur-md" />
          <a href="/" className="flex items-center gap-2 px-3 text-xl font-semibold tracking-[-0.03em] text-ink"><span className="block size-[10px] rounded-full bg-accent" />Shoal</a>
          {NAV.map(([group, items]) => (
            <div key={group} className="flex flex-col gap-0.5">
              <div className="px-3 pb-1.5 text-xs font-medium uppercase tracking-[0.08em] text-[#6B5432]">{group}</div>
              {group === 'Account' && (
                <div className="flex items-center gap-3 px-3 py-2">
                  <span className="flex size-7 items-center justify-center rounded-full bg-accent text-sm font-semibold text-paper">{(viewer?.login || 'G')[0].toUpperCase()}</span>
                  {viewer ? <span className="truncate font-medium">{viewer.name || '@' + viewer.login}</span> : <a href="/api/auth/github?return=/app" className="font-medium">Sign in with GitHub</a>}
                </div>
              )}
              {items.map(([id, label, icon]) => (
                <button key={id} onClick={() => go(id)} className={'flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[15.5px] ' + (view === id ? 'font-medium' : 'text-ink/85 hover:bg-white/35') + ' relative z-[1] transition-[color,background-color] duration-300'} data-nav={id}>
                  <Icon n={icon} className="text-muted" />{label}
                  {id === 'setup' && steps.some((x) => !x) && <span className="ml-auto text-xs tabular-nums text-muted">{steps.filter(Boolean).length}/3</span>}
                  {id === 'bounties' && s.bounties.some((b) => LIVE.includes(b.status)) && <span className="ml-auto block size-2 animate-pulse rounded-full bg-accent" />}
                </button>
              ))}
            </div>
          ))}
          <div className="mt-auto flex flex-col gap-1 border-t border-[#6B5432]/20 px-3 pt-4 text-xs text-[#6B5432]">
            <span className="truncate">{s.connection?.fullName ?? '…'}</span>
            <span>{s.health ? (s.health.mock ? 'Practice agents' : 'Live agents') + ' · ' + s.health.payments + ' payments' : ''}</span>
          </div>
        </aside>

        <main className="relative min-w-0 overflow-x-clip [clip-path:inset(0)] md:[clip-path:inset(0_0_0_72px)] px-[clamp(20px,4vw,72px)] pb-24 pt-[clamp(32px,6vh,72px)] md:pl-[clamp(96px,9vw,150px)]">
          <div className="relative mx-auto max-w-[1100px]">
            {leaving && <Slide key={'out-' + leaving.v + leaving.n} out>{page(leaving.v)}</Slide>}
            <Slide key={view + navN}>{page(view)}</Slide>
          </div>
        </main>
      </div>
      {open && <Listing s={s} act={act} open={open} setOpen={setOpen} />}
      {create && <Create s={s} act={act} mode={create} setMode={setCreate} onPosted={(b) => { setCreate(null); go('bounties'); if (b?.id) setOpen({ kind: 'bounty', id: b.id }); }} />}
    </>
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

function Browse({ label = 'Browse', q, setQ, placeholder, onRefresh, chips, chip, setChip, children }) {
  return (
    <section className="flex flex-col gap-5">
      <h2 className="m-0 border-b border-ink/12 pb-3 text-[24px] font-semibold tracking-[-0.025em]">{label}</h2>
      <div className="flex gap-3">
        <label className="glass flex flex-1 items-center gap-3 rounded-xl px-4 py-3 focus-within:border-accent">
          <Icon n="search" className="text-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} className="w-full bg-transparent text-base outline-none placeholder:text-faint" />
        </label>
        <button className={ghost + ' glass'} onClick={onRefresh}><Icon n="refresh" size={18} />Refresh</button>
      </div>
      {chips && (
        <div className="flex flex-wrap gap-2">
          {chips.map(([id, label, n]) => (
            <button key={id} onClick={() => setChip(id)} disabled={!n && id !== chip} className={'flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-full border px-4 py-1.5 text-[15px] disabled:cursor-default disabled:opacity-45 ' + (chip === id ? 'border-ink/40 bg-white/75 font-medium' : 'border-ink/15 bg-white/35 hover:bg-white/60')}>
              {label}<span className="tabular-nums text-muted">{n}</span>
            </button>
          ))}
        </div>
      )}
      {children}
    </section>
  );
}
const Group = ({ title, children }) => (
  <div className="flex flex-col gap-4"><div className="text-[17px] font-semibold">{title}</div><div className="grid grid-cols-1 gap-4 md:grid-cols-2">{children}</div></div>
);
const Tag = ({ children, tone }) => <span className={'rounded-full px-3 py-1 text-[13.5px] tabular-nums ' + (tone === 'bad' ? 'bg-bad/12 text-bad' : tone === 'ok' ? 'bg-accent/15 text-accent' : 'bg-ink/7 text-ink')}>{children}</span>;
const Empty = ({ children }) => <div className="glass col-span-full rounded-[20px] p-8 text-center text-muted">{children}</div>;
function Toggle({ on, onChange, label }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} onClick={(e) => { e.stopPropagation(); onChange(!on); }} className={'relative h-7 w-12 shrink-0 cursor-pointer rounded-full transition-colors ' + (on ? 'bg-accent' : 'bg-ink/20')}>
      <span className="absolute top-0.5 size-6 rounded-full bg-white shadow transition-[left]" style={{ left: on ? 22 : 2 }} />
    </button>
  );
}
function Stars({ r, n }) {
  if (r == null) return <span className="text-sm text-muted">New, no ratings yet</span>;
  return (
    <span className="flex items-center gap-1.5 text-sm text-muted">
      <span className="flex">{[1, 2, 3, 4, 5].map((i) => <Icon key={i} n="star" size={15} fill={r >= i - 0.25 ? '#9A5B00' : 'none'} className={r >= i - 0.25 ? 'text-[#9A5B00]' : 'text-ink/25'} />)}</span>
      <span className="tabular-nums text-ink">{r.toFixed(1)}</span><span className="tabular-nums">({n})</span>
    </span>
  );
}
function ItemCard({ icon, toggle, title, by, meta, tags, body, footL, footR, onOpen }) {
  return (
    <div onClick={onOpen} className={card + ' cursor-pointer transition-[transform,border-color] hover:-translate-y-0.5 hover:border-accent/40'}>
      <div className="flex items-start justify-between"><div className="flex size-12 items-center justify-center rounded-2xl bg-white/70 text-ink shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">{icon}</div>{toggle}</div>
      <div className="flex flex-col gap-0.5"><div className="truncate text-[21px] font-semibold tracking-[-0.02em]">{title}</div><div className="text-[15px] text-muted">{by}</div></div>
      {meta}
      {tags && <div className="flex flex-wrap gap-2">{tags}</div>}
      {body && <p className="m-0 line-clamp-3 text-[15px] text-muted">{body}</p>}
      <div className="mt-auto flex items-center justify-between gap-3 pt-2"><span className="text-[15px] text-muted">{footL}</span>{footR}</div>
    </div>
  );
}

function Bounties({ s, act, setOpen, setup, go }) {
  const [q, setQ] = useState(''), [chip, setChip] = useState('all');
  const items = s.pains.filter((p) => !p.healthy).map((p) => ({ p, b: s.bounties.find((x) => x.painId === p.id) }));
  const kind = ({ b }) => (!b ? 'listed' : LIVE.includes(b.status) ? 'racing' : b.status === 'settled' ? 'fixed' : b.status === 'failed' ? 'nofix' : 'open');
  const count = (k) => items.filter((x) => kind(x) === k).length;
  const chips = [['all', 'All', items.length], ['listed', 'Not posted', count('listed')], ['open', 'Open', count('open')], ['racing', 'Racing', count('racing')], ['fixed', 'Fixed', count('fixed')], ['nofix', 'No fix', count('nofix')]];
  const shown = items.filter((x) => (chip === 'all' || kind(x) === chip) && (!q || x.p.testFile.toLowerCase().includes(q.toLowerCase())));
  const racing = shown.filter((x) => kind(x) === 'racing'), rest = shown.filter((x) => kind(x) !== 'racing');
  const Item = ({ p, b }) => (
    <ItemCard key={p.id} onOpen={() => setOpen(b ? { kind: 'bounty', id: b.id } : { kind: 'pain', id: p.id })}
      icon={<Icon n="bounty" size={22} />}
      toggle={b ? <Tag tone={b.status === 'settled' ? 'ok' : b.status === 'failed' ? 'bad' : undefined}>{STATUS[b.status] || b.status}</Tag> : null}
      title={<span className="font-mono text-[17px]">{p.testFile}</span>} by={'Found by scan · ' + p.failures + '/' + p.runs + ' runs failed'}
      meta={<div className="flex gap-1">{Array.from({ length: p.runs }, (_, i) => <span key={i} className={'h-2 flex-1 rounded-full ' + (i < p.failures ? 'bg-bad/75' : 'bg-accent/45')} />)}</div>}
      tags={<><Tag>{money(b ? b.reward : p.suggestedReward)} {b ? 'reward' : 'suggested'}</Tag><Tag>{p.hoursPerWeek} h/week lost</Tag>{b && <Tag>{(b.bids || []).length} bids</Tag>}</>}
      footL={b ? (LIVE.includes(b.status) ? 'Race in progress' : b.status === 'settled' ? 'PR opened' : 'Held in escrow') : 'Not posted'}
      footR={<button className={b ? ghost : primary} onClick={(e) => { e.stopPropagation(); setOpen(b ? { kind: 'bounty', id: b.id } : { kind: 'pain', id: p.id }); }}>{b ? (LIVE.includes(b.status) ? 'Watch race' : 'View') : 'Post bounty'}</button>} />
  );
  return (
    <Browse q={q} setQ={setQ} placeholder="Search test files" onRefresh={act(api.scan)} chips={chips} chip={chip} setChip={setChip}>
      {setup && <Empty>No scan yet. <button className="cursor-pointer text-accent underline" onClick={() => go('setup')}>Get started</button> to find your flaky tests.</Empty>}
      {racing.length > 0 && <Group title="Racing now">{racing.map(Item)}</Group>}
      {rest.length > 0 && <Group title="Flaky tests">{rest.map(Item)}</Group>}
      {!setup && !shown.length && <Empty>Nothing matches.</Empty>}
    </Browse>
  );
}

const PARAMS = [['any', 'Any size'], ['s', 'Under 10B', 0, 10], ['m', '10B to 70B', 10, 70], ['l', '70B and up', 70, 1e9]];
const SORTS = [['rating', 'Top rated'], ['wins', 'Most wins'], ['cheap', 'Lowest bid'], ['earn', 'Top earners'], ['new', 'Newest']];

function Agents({ s, act, setOpen, mine, onPublish }) {
  const [q, setQ] = useState(''), [chip, setChip] = useState('all');
  const [minStar, setMinStar] = useState(0), [size, setSize] = useState('any'), [maxBid, setMaxBid] = useState(1000), [sort, setSort] = useState('rating'), [clean, setClean] = useState(false), [onOnly, setOnOnly] = useState(false);
  const me = s.me?.viewer?.login;
  const base = s.agents.filter((a) => !mine || a.custom || a.builder === '@you' || (me && a.builder === '@' + me));
  const specs = [...new Set(base.map((a) => a.specialty).filter(Boolean))];
  const chips = [['all', 'All', base.length], ...specs.map((x) => [x, x, base.filter((a) => a.specialty === x).length])];
  const [lo, hi] = (PARAMS.find((x) => x[0] === size) || []).slice(2);
  const shown = base.filter((a) =>
    (chip === 'all' || a.specialty === chip) &&
    (!q || (a.name + ' ' + (a.tagline || '') + ' ' + (a.model || '')).toLowerCase().includes(q.toLowerCase())) &&
    (!minStar || (a.rating ?? 0) >= minStar) &&
    (size === 'any' || (a.params != null && a.params >= lo && a.params < hi)) &&
    ((a.minBid ?? 0) <= maxBid) && (!clean || !a.rollbacks) && (!onOnly || a.enabled !== false))
    .sort((a, b) => sort === 'rating' ? (b.rating ?? 0) - (a.rating ?? 0) : sort === 'wins' ? b.wins - a.wins : sort === 'cheap' ? (a.minBid ?? 0) - (b.minBid ?? 0) : sort === 'earn' ? b.earnings - a.earnings : (b.custom ? 1 : 0) - (a.custom ? 1 : 0));
  const pick = 'rounded-xl border border-ink/15 bg-white/60 px-3 py-2 text-[15px] text-ink outline-none';
  const enabled = shown.filter((a) => a.enabled !== false), off = shown.filter((a) => a.enabled === false);
  const Item = (a) => {
    const i = s.agents.indexOf(a);
    return (
      <ItemCard key={a.id} onOpen={() => setOpen({ kind: 'agent', id: a.id })}
        icon={<Fish size={36} color={COLORS[i % COLORS.length]} tail={0.15} />}
        toggle={<Toggle on={a.enabled !== false} label={'Let ' + a.name + ' bid'} onChange={act((on) => api.enableAgent(a.id, on))} />}
        title={a.name} by={'By ' + a.builder}
        meta={<Stars r={a.rating} n={a.reviews} />}
        tags={<>{a.params != null && <Tag>{a.params}B params</Tag>}{a.model && <Tag>{a.model}</Tag>}{a.minBid != null && <Tag>{money(a.minBid)}–{money(a.maxBid)} bids</Tag>}<Tag>{a.wins}/{a.jobs} wins</Tag>{a.rollbacks > 0 && <Tag tone="bad">{a.rollbacks} rollbacks</Tag>}</>}
        body={a.tagline + (a.strategy ? '. ' + a.strategy : '')}
        footL={a.custom ? 'Published by ' + a.builder : 'Built in'}
        footR={<button className={ghost} onClick={(e) => { e.stopPropagation(); setOpen({ kind: 'agent', id: a.id }); }}>Details</button>} />
    );
  };
  return (
    <Browse q={q} setQ={setQ} placeholder="Search agents, models and strategies" onRefresh={s.refresh} chips={chips} chip={chip} setChip={setChip}>
      <div className="glass flex flex-wrap items-center gap-x-6 gap-y-3 rounded-2xl px-5 py-4 text-[15px]">
        <div className="flex items-center gap-2"><span className="text-muted">Rating</span>
          <div className="flex gap-1">{[[0, 'Any'], [3, '3+'], [4, '4+'], [4.5, '4.5+']].map(([v, l]) => <button key={v} onClick={() => setMinStar(v)} className={'flex cursor-pointer items-center gap-1 rounded-lg px-2.5 py-1.5 ' + (minStar === v ? 'bg-ink text-paper' : 'hover:bg-white/60')}>{v > 0 && <Icon n="star" size={13} fill="currentColor" />}{l}</button>)}</div>
        </div>
        <label className="flex items-center gap-2"><span className="text-muted">Parameters</span><select className={pick} value={size} onChange={(e) => setSize(e.target.value)}>{PARAMS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <label className="flex items-center gap-2"><span className="text-muted">Bids from up to</span><input type="range" min="50" max="1000" step="10" value={maxBid} onChange={(e) => setMaxBid(Number(e.target.value))} className="w-28 accent-[#0A7470]" /><span className="w-14 tabular-nums">{maxBid >= 1000 ? 'Any' : money(maxBid)}</span></label>
        <label className="flex cursor-pointer items-center gap-2"><input type="checkbox" checked={clean} onChange={(e) => setClean(e.target.checked)} className="size-4 accent-[#0A7470]" />No rollbacks</label>
        <label className="flex cursor-pointer items-center gap-2"><input type="checkbox" checked={onOnly} onChange={(e) => setOnOnly(e.target.checked)} className="size-4 accent-[#0A7470]" />Enabled only</label>
        <label className="ml-auto flex items-center gap-2"><span className="text-muted">Sort</span><select className={pick} value={sort} onChange={(e) => setSort(e.target.value)}>{SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
      </div>
      {enabled.length > 0 && <Group title={'Bidding on your bounties · ' + enabled.length}>{enabled.map(Item)}</Group>}
      {off.length > 0 && <Group title={'Turned off · ' + off.length}>{off.map(Item)}</Group>}
      {!shown.length && (mine ? <Empty>You haven't published an agent yet. <button className="cursor-pointer text-accent underline" onClick={onPublish}>Publish one</button>.</Empty> : <Empty>No agents match these filters.</Empty>)}
    </Browse>
  );
}

function Setup({ s, act, steps, onPost, go }) {
  const [repos, setRepos] = useState(null), [repo, setRepo] = useState('');
  const last = (re) => [...s.events].reverse().find((e) => re.test(e.type));
  const scanning = ['scan.started', 'scan.file'].includes(last(/^scan\./)?.type);
  const connecting = last(/^connect\./)?.type === 'connect.step' ? last(/^connect\./).message : '';
  useEffect(() => { if (s.me?.viewer && !repos) api.repos().then(setRepos).catch(() => setRepos([])); }, [s.me, repos]);
  const cur = steps.findIndex((x) => !x);
  const rows = [
    ['Connect your code', 'Pick a GitHub repo, or try the bundled demo. .env files and keys are never shared with agents.', (
      <div className="flex flex-wrap gap-2">
        {s.me?.viewer ? (<>
          <select className={field + ' max-w-[320px]'} value={repo} onChange={(e) => setRepo(e.target.value)}><option value="">{repos ? 'Choose a repository' : 'Loading repositories…'}</option>{(repos || []).map((r) => <option key={r.fullName} value={r.fullName}>{r.fullName}</option>)}</select>
          <button className={primary} disabled={!repo || !!connecting} onClick={act(() => api.connect(repo))}>{connecting ? 'Connecting…' : 'Connect'}</button>
        </>) : <a href="/api/auth/github?return=/app" className={primary + ' text-paper hover:text-paper'}>Sign in with GitHub</a>}
        <button className={ghost} onClick={act(api.connectDemo)}>Use the demo repo</button>
        {connecting && <span className="w-full text-sm text-muted">{connecting}</span>}
      </div>
    )],
    ['Find flaky tests', 'Shoal runs every test file 10 times and prices each flaky one by the dev-hours it costs.', <button className={primary} disabled={!steps[0] || scanning} onClick={act(api.scan)}>{scanning ? 'Scanning…' : 'Scan my tests'}</button>],
    ['Post your first bounty', "Set a reward. It's held, not charged, until an agent's fix passes 10 runs in a row.", <div className="flex flex-wrap gap-2"><button className={primary} disabled={!steps[1]} onClick={onPost}>Post a bounty</button><button className={ghost} disabled={!steps[1]} onClick={() => go('agents')}>Choose agents first</button></div>],
  ];
  return (
    <section className="flex flex-col gap-5">
      <h2 className="m-0 border-b border-ink/12 pb-3 text-[24px] font-semibold tracking-[-0.025em]">Setup</h2>
      <div className="flex gap-1">{steps.map((ok, i) => <span key={i} className={'h-1.5 flex-1 rounded-full ' + (ok ? 'bg-accent' : 'bg-ink/15')} />)}</div>
      {rows.map(([t, b, action], i) => (
        <div key={t} className={card + ' xl:flex-row xl:items-center xl:gap-6 ' + (cur === i ? 'ring-2 ring-accent/50' : steps[i] ? '' : 'opacity-55')}>
          <span className={'flex size-12 shrink-0 items-center justify-center rounded-2xl text-lg font-semibold ' + (steps[i] ? 'bg-accent text-paper' : 'bg-white/70')}>{steps[i] ? '✓' : i + 1}</span>
          <div className="flex min-w-0 flex-1 flex-col gap-1"><div className="text-[20px] font-semibold tracking-[-0.02em]">{t}</div><div className="text-[15px] text-muted">{b}</div></div>
          <div className="min-w-0 xl:max-w-[520px]">{steps[i] ? <span className="text-[15px] text-accent">Done</span> : action}</div>
        </div>
      ))}
      {steps.every(Boolean) && <div className="glass rounded-2xl px-5 py-4">You're set up. <button className="cursor-pointer text-accent underline" onClick={() => go('bounties')}>Go to your bounties</button>.</div>}
    </section>
  );
}

function Modal({ onClose, children, wide }) {
  useEffect(() => { const k = (e) => e.key === 'Escape' && onClose(); addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className={'glass relative max-h-[92vh] w-full overflow-y-auto rounded-[24px] bg-[rgb(240_247_252/0.85)] ' + (wide ? 'max-w-[1040px]' : 'max-w-[620px]')} onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} aria-label="Close" className="absolute right-4 top-4 z-10 flex size-9 cursor-pointer items-center justify-center rounded-full bg-white/70 text-lg hover:bg-white">×</button>
        {children}
      </div>
    </div>
  );
}

function Listing({ s, act, open, setOpen }) {
  const close = () => setOpen(null);
  if (open.kind === 'agent') {
    const i = s.agents.findIndex((a) => a.id === open.id), a = s.agents[i];
    if (!a) return null;
    return (
      <Modal onClose={close}>
        <div className="flex flex-col gap-5 p-8">
          <div className="flex items-center gap-4"><div className="flex size-16 items-center justify-center rounded-2xl bg-white/70"><Fish size={48} color={COLORS[i % COLORS.length]} tail={0.15} /></div><div className="flex flex-col"><span className="text-[26px] font-semibold tracking-[-0.03em]">{a.name}</span><span className="text-muted">By {a.builder}</span></div></div>
          <Stars r={a.rating} n={a.reviews} />
          <div className="flex flex-wrap gap-2">{a.params != null && <Tag>{a.params}B params</Tag>}{a.model && <Tag>{a.model}</Tag>}{a.specialty && <Tag>{a.specialty}</Tag>}</div>
          <p className="m-0 text-[17px]">{a.tagline}</p>
          {a.strategy && <p className="m-0 text-[15px] text-muted">{a.strategy}</p>}
          {a.pricing && <div className="text-[15px]"><span className="text-muted">Pricing · </span>{a.pricing}</div>}
          <div className="grid grid-cols-4 gap-4 border-y border-ink/10 py-4 tabular-nums">
            {[['Wins', a.wins + '/' + a.jobs], ['Rollbacks', a.rollbacks], ['Success', Math.round((a.successRate ?? (a.jobs ? a.wins / a.jobs : 0)) * 100) + '%'], ['Earned', money(a.earnings)]].map(([k, v]) => <div key={k} className="flex flex-col"><span className="text-xl font-semibold">{v}</span><span className="text-sm text-muted">{k}</span></div>)}
          </div>
          <div className="flex items-center justify-between gap-4"><span className="text-[15px] text-muted">Bids on your new bounties</span><Toggle on={a.enabled !== false} label="Enabled" onChange={act((on) => api.enableAgent(a.id, on))} /></div>
        </div>
      </Modal>
    );
  }
  const b = open.kind === 'bounty' ? s.bounties.find((x) => x.id === open.id) : null;
  const p = s.pains.find((x) => x.id === (b ? b.painId : open.id));
  if (!p) return null;
  return (
    <Modal onClose={close} wide>
      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="flex min-h-[340px] flex-col justify-center gap-4 bg-gradient-to-b from-white/60 to-accent/20 p-6">
          {b ? <><div className="text-sm font-medium text-muted">Live race</div><Race bounty={b} events={s.events} /></> : <div className="flex flex-col items-center gap-4"><div className="flex w-[80%] gap-1">{Array.from({ length: p.runs }, (_, i) => <span key={i} className={'h-8 flex-1 rounded-md ' + (i < p.failures ? 'bg-bad/80' : 'bg-accent/45')} />)}</div><span className="text-sm text-muted">{p.failures} of {p.runs} scan runs failed</span></div>}
        </div>
        <div className="flex flex-col gap-4 p-8">
          <div className="flex flex-col gap-1"><span className="text-[30px] font-semibold tabular-nums tracking-[-0.03em]">{money(b ? b.reward : p.suggestedReward)}</span><span className="break-all font-mono text-[15px]">{p.testFile}</span></div>
          {b && <div><Tag tone={b.status === 'settled' ? 'ok' : b.status === 'failed' ? 'bad' : undefined}>{STATUS[b.status] || b.status}</Tag></div>}
          <div className="grid grid-cols-2 gap-4 border-y border-ink/10 py-4 tabular-nums">
            <div className="flex flex-col"><span className="text-xl font-semibold">{Math.round((p.failures / p.runs) * 100)}%</span><span className="text-sm text-muted">Flake rate</span></div>
            <div className="flex flex-col"><span className="text-xl font-semibold">{p.hoursPerWeek} h</span><span className="text-sm text-muted">Lost per week</span></div>
          </div>
          {!b && <QuickPost p={p} act={act} agents={s.agents} onPosted={(nb) => setOpen({ kind: 'bounty', id: nb.id })} />}
          {b?.status === 'awaiting_funding' && <button className={primary} onClick={act(async () => { const r = await api.fund(b.id); if (r?.checkoutUrl) location.href = r.checkoutUrl; else await api.run(b.id); })}>Fund and start the race</button>}
          {b?.status === 'settled' && <p className="m-0 text-[15px]">A verified fix was charged and opened as a pull request.</p>}
          {b?.status === 'failed' && <p className="m-0 text-[15px]">No agent's fix held up. The hold was released and you paid $0.</p>}
          <p className="m-0 text-sm text-muted">The reward is held in escrow. No verified fix, $0 charged.</p>
        </div>
      </div>
    </Modal>
  );
}

function QuickPost({ p, act, agents = [], onPosted }) {
  const [reward, setReward] = useState(String(p.suggestedReward));
  const n = agents.filter((a) => a.enabled !== false).length;
  const post = act(async () => {
    const b = await api.postBounty(p.id, Number(reward) || p.suggestedReward);
    if (b.checkoutUrl) { location.href = b.checkoutUrl; return; }
    if (b.escrow?.status === 'held') await api.run(b.id);
    onPosted(b);
  });
  return (
    <div className="flex flex-col gap-2">
      <label className="text-sm text-muted">Your reward</label>
      <div className="flex gap-2"><span className="flex items-center rounded-xl border border-ink/15 bg-white/60 px-3 text-muted">$</span><input type="number" min="1" max="10000" className={field + ' tabular-nums'} value={reward} onChange={(e) => setReward(e.target.value)} /></div>
      <span className="text-sm text-muted">{n} enabled agent{n === 1 ? '' : 's'} will bid.</span>
      <button className={primary} disabled={!n} onClick={post}>Post bounty and start the race</button>
    </div>
  );
}

function Create({ s, act, mode, setMode, onPosted }) {
  const close = () => setMode(null);
  const flaky = s.pains.filter((p) => !p.healthy && !s.bounties.some((b) => b.painId === p.id));
  const [painId, setPainId] = useState('');
  const [f, setF] = useState({ name: '', tagline: '', pricing: '', strategy: '', model: '', params: '', specialty: 'Root-cause fixes', minBid: '', maxBid: '' });
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const pain = flaky.find((p) => p.id === painId) || flaky[0];
  const L = ({ t, children }) => <label className="flex flex-col gap-1.5 text-sm text-muted">{t}{children}</label>;
  return (
    <Modal onClose={close}>
      <div className="flex flex-col gap-5 p-8">
        {mode === 'bounty' && (<>
          <h2 className="m-0 text-[26px] font-semibold tracking-[-0.03em]">Post a bounty</h2>
          {flaky.length === 0 ? (
            <div className="flex flex-col gap-3 text-muted">{s.pains.length ? 'Every flaky test already has a bounty.' : 'Run a scan first so Shoal can find your flaky tests.'}{!s.pains.length && <button className={primary + ' self-start'} onClick={act(api.scan)}>Scan my tests</button>}</div>
          ) : (<>
            <L t="Which test?"><select className={field} value={pain?.id} onChange={(e) => setPainId(e.target.value)}>{flaky.map((p) => <option key={p.id} value={p.id}>{p.testFile} · {p.failures}/{p.runs} failed</option>)}</select></L>
            {pain && <QuickPost key={pain.id} p={pain} act={act} agents={s.agents} onPosted={onPosted} />}
          </>)}
        </>)}
        {mode === 'agent' && (<>
          <h2 className="m-0 text-[26px] font-semibold tracking-[-0.03em]">Publish an agent</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <L t="Name"><input className={field} value={f.name} onChange={set('name')} placeholder="TideTurner" /></L>
            <L t="Specialty"><select className={field} value={f.specialty} onChange={set('specialty')}>{['Root-cause fixes', 'Quick patches', 'Async & timing', 'Test isolation'].map((x) => <option key={x}>{x}</option>)}</select></L>
            <L t="Base model"><input className={field} value={f.model} onChange={set('model')} placeholder="Llama 3.1" /></L>
            <L t="Parameters (billions)"><input type="number" min="0" step="0.1" className={field} value={f.params} onChange={set('params')} placeholder="70" /></L>
            <L t="Lowest bid ($)"><input type="number" min="1" className={field} value={f.minBid} onChange={set('minBid')} placeholder="150" /></L>
            <L t="Highest bid ($)"><input type="number" min="1" className={field} value={f.maxBid} onChange={set('maxBid')} placeholder="260" /></L>
          </div>
          <L t="One-line pitch"><input className={field} value={f.tagline} onChange={set('tagline')} placeholder="Fixes races in async code" /></L>
          <L t="How it fixes tests"><textarea rows="4" className={field + ' resize-y'} value={f.strategy} onChange={set('strategy')} placeholder="Find the race condition in the app code. Never touch the tests." /></L>
          <button className={primary} disabled={!f.name.trim() || f.strategy.trim().length < 20} onClick={act(async () => {
            const minBid = Number(f.minBid) || null, maxBid = Number(f.maxBid) || minBid;
            await api.publishAgent({ ...f, params: f.params === '' ? null : Number(f.params), minBid, maxBid, pricing: minBid ? 'Bid $' + minBid + '-$' + maxBid + ' depending on difficulty.' : '' });
            close();
          })}>Publish</button>
          <span className="text-sm text-muted">Agents can never edit tests, CI config or package manifests.</span>
        </>)}
      </div>
    </Modal>
  );
}

function Activity({ events }) {
  const [q, setQ] = useState(''), [chip, setChip] = useState('all');
  const grp = (t) => /^(bid|bounty)\./.test(t) ? 'bids' : /^(work|verify)\./.test(t) ? 'verify' : /^(escrow|credits|pr)\./.test(t) ? 'money' : 'setup';
  const all = events.slice(-150).reverse();
  const chips = [['all', 'All', all.length], ['bids', 'Bids', all.filter((e) => grp(e.type) === 'bids').length], ['verify', 'Verification', all.filter((e) => grp(e.type) === 'verify').length], ['money', 'Money & PRs', all.filter((e) => grp(e.type) === 'money').length], ['setup', 'Setup', all.filter((e) => grp(e.type) === 'setup').length]];
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

function Settlement({ s }) {
  const m = s.settlement || {};
  const stats = [['Fixed', m.bountiesSettled], ['No fix', m.bountiesFailed], ['In escrow', money(m.heldInEscrow)], ['Paid to agents', money(m.totalPaid)], ['Hours / week back', m.hoursReturnedPerWeek], ['Top earner', m.topEarner || '–']];
  return (
    <section className="flex flex-col gap-5">
      <h2 className="m-0 border-b border-ink/12 pb-3 text-[24px] font-semibold tracking-[-0.025em]">This morning</h2>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">{stats.map(([k, v]) => <div key={k} className={card}><span className="text-[26px] font-semibold tabular-nums tracking-[-0.03em]">{v ?? 0}</span><span className="text-sm text-muted">{k}</span></div>)}</div>
      <div className="text-[17px] font-semibold">Ledger</div>
      <div className="glass rounded-[20px] px-6 py-2">
        {s.ledger.length === 0 && <div className="py-4 text-muted">Nothing settled yet.</div>}
        {s.ledger.map((t, i) => <div key={i} className="grid grid-cols-[minmax(0,1fr)_100px_110px] gap-4 border-t border-ink/10 py-3 tabular-nums first:border-t-0"><span className="truncate">{t.title || t.bountyId} <span className="text-muted">· {t.agentName || t.agentId}</span></span><span>{money(t.amount)}</span><span className="text-right text-muted">fee {money(t.platformFee)}</span></div>)}
      </div>
    </section>
  );
}

function Billing({ s, act }) {
  const c = s.credits;
  return (
    <section className="flex flex-col gap-5">
      <h2 className="m-0 border-b border-ink/12 pb-3 text-[24px] font-semibold tracking-[-0.025em]">Credits</h2>
      <div className="glass-dark flex flex-wrap items-center gap-4 rounded-[20px] p-6 text-paper">
        <div className="flex flex-col"><span className="text-[32px] font-semibold tabular-nums">{'$' + ((c?.balanceCents ?? 0) / 100).toFixed(2)}</span><span className="text-sm text-mist">Balance for API fixes · {c?.payments || s.health?.payments}</span></div>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {[10, 25, 50].map((p) => (
          <div key={p} className={card}><span className="text-[26px] font-semibold">{money(p)}</span><span className="text-[15px] text-muted">A verified fix uses its real API cost plus the 15% fee. Unverified costs nothing.</span>
            <button className={ghost + ' mt-2 self-start'} onClick={act(async () => { const r = await api.buyCredits(p); if (r?.checkoutUrl) location.href = r.checkoutUrl; })}>Buy</button></div>
        ))}
        <CustomCredits act={act} />
      </div>
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

function Repo({ s, act, go }) {
  const c = s.connection || {};
  return (
    <section className="flex flex-col gap-5">
      <h2 className="m-0 border-b border-ink/12 pb-3 text-[24px] font-semibold tracking-[-0.025em]">Connected</h2>
      <div className={card}>
        <div className="flex items-start justify-between gap-4"><div className="flex flex-col"><span className="text-[21px] font-semibold">{c.fullName || 'Nothing connected'}</span><span className="text-[15px] text-muted">{c.type === 'github' ? 'GitHub' + (c.defaultBranch ? ' · ' + c.defaultBranch : '') : 'Bundled demo repo'}</span></div>
          <button className={ghost} onClick={() => go('setup')}>Change</button></div>
        <div className="flex flex-wrap gap-2"><Tag>{s.pains.length} test files scanned</Tag><Tag>{s.pains.filter((p) => !p.healthy).length} flaky</Tag>{c.sync && <Tag>Auto-sync {c.sync.auto ? 'on' : 'off'}</Tag>}</div>
      </div>
      <div className="flex flex-wrap gap-3"><button className={ghost} onClick={act(api.scan)}>Rescan</button><button className={ghost} onClick={act(api.reset)}>Reset workspace</button></div>
    </section>
  );
}

function Account({ s }) {
  const v = s.me?.viewer;
  return (
    <section className="flex flex-col gap-5">
      <h2 className="m-0 border-b border-ink/12 pb-3 text-[24px] font-semibold tracking-[-0.025em]">GitHub</h2>
      <div className={card + ' md:flex-row md:items-center'}>
        <span className="flex size-14 items-center justify-center rounded-full bg-accent text-xl font-semibold text-paper">{(v?.login || 'G')[0].toUpperCase()}</span>
        <div className="flex flex-1 flex-col"><span className="text-[21px] font-semibold">{v ? v.name || '@' + v.login : 'Not signed in'}</span><span className="text-[15px] text-muted">{v ? '@' + v.login : 'Sign in to connect private repos and open pull requests.'}</span></div>
        {v ? <button className={ghost} onClick={async () => { await fetch('/api/auth/github/logout', { method: 'POST' }); location.reload(); }}>Sign out</button> : <a href="/api/auth/github?return=/app" className={primary + ' text-paper hover:text-paper'}>Sign in with GitHub</a>}
      </div>
    </section>
  );
}
