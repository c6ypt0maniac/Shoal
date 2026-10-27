// The marketplace: every agent and model a team can pick to compete on a bounty
// (server/src/marketplace.js), its reviews, and publishing your own agent.
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, apiHref } from './api.js';
import { COLORS } from './Race.jsx';
import Fish from './Fish.jsx';
import { Browse, Empty, Group, Icon, ItemCard, Label, Modal, Stars, Tag, card, field, ghost, money, primary, signInHref } from './ui.jsx';

const PROVIDERS = { shoal: 'Shoal', anthropic: 'Anthropic', openai: 'OpenAI', openrouter: 'OpenRouter', builder: 'Community' };
const SORT_LABELS = { best: 'Best record', top_rated: 'Top rated', cheapest: 'Cheapest', most_used: 'Most used', fastest: 'Fastest fix', newest: 'Newest', popular: 'Most popular', context: 'Longest context', coding: 'Best at coding', uptime: 'Best uptime' };
const PAINS = { 'flaky-tests': 'Flaky tests', 'ci-speed': 'Slow CI', 'pr-review': 'PR review', 'dependency-upgrades': 'Dependency upgrades' };
const pct = (v) => (v == null ? '–' : Math.round(v * 100) + '%');
const secs = (ms) => (ms == null ? '–' : ms < 60_000 ? Math.round(ms / 1000) + 's' : Math.round(ms / 60_000) + ' min');
const usd = (n) => '$' + Number(n).toFixed(2);
// A model's token prices, labelled. How many tokens a fix uses varies too
// much to quote a cost per fix until a trial has measured one (perFix).
const tokenPrice = (p) => (p?.input == null ? null : usd(p.input) + ' input · ' + usd(p.output) + ' output per 1M tokens');
const TOKEN_HOW = 'What the model provider charges your API keys: input is what Shoal sends (your code and the failing test), output is what the model writes back.';
const perFix = (f) => (!f?.measured ? null : (f.amount < 0.01 ? 'Under 1¢' : usd(f.amount)) + ' per fix, measured');
const PER_FIX_HOW = 'Average token cost of this model’s fixes in Shoal’s trials so far.';

// A listing's display name, from the marketplace or the leaderboard.
export const nameOf = (s, id) => s.market.find((l) => l.id === id)?.name || s.agents.find((a) => a.id === id)?.name || id;
const mineOf = (s) => s.market.filter((l) => l.provider === 'builder' && l.owner && l.owner === s.me?.viewer?.login);

// How much a score can be trusted, by the attempts behind it (bounties.js confidence).
const CONFIDENCE = { new: 'Too few attempts to judge yet.', low: 'Low confidence: under 10 attempts.', medium: 'Medium confidence: 10 to 29 attempts.', high: 'High confidence: 30 or more attempts.' };

// Each agent keeps one fish colour everywhere, from its id (not its place in a list).
const colorOf = (id) => COLORS[[...String(id)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0) % COLORS.length];
// An agent's picture: its uploaded image, the fish its builder picked, or a
// fish in its own colour. Models get a chip.
export function AgentAvatar({ l, size = 36 }) {
  if (l.kind === 'model') return <Icon n="chip" size={Math.round(size * 0.72)} />;
  if (l.avatar?.image) return <img src={apiHref('/api/marketplace/avatar?id=' + encodeURIComponent(l.id) + '&v=' + l.avatar.v)} alt="" className="size-full rounded-[inherit] object-cover" />;
  const preset = /^fish-(\d)$/.exec(l.avatar?.preset || '');
  return <Fish size={size} color={preset ? COLORS[+preset[1]] : colorOf(l.id)} tail={0.15} />;
}
const ListingIcon = ({ l }) => <AgentAvatar l={l} size={36} />;

// Picking an agent's picture: one of Shoal's fish, or an uploaded image
// (cropped square and shrunk here, so uploads stay small).
// value: { preset } | { image: dataUrl } | null (the default fish).
const PRESETS = COLORS.map((_, i) => 'fish-' + i);
async function squareImage(file, side = 256) {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('Choose a PNG, JPEG or WebP image');
  const img = await createImageBitmap(file);
  const crop = Math.min(img.width, img.height);
  const canvas = Object.assign(document.createElement('canvas'), { width: side, height: side });
  canvas.getContext('2d').drawImage(img, (img.width - crop) / 2, (img.height - crop) / 2, crop, crop, 0, 0, side, side);
  return canvas.toDataURL('image/webp', 0.85);
}
export function AvatarPicker({ value, onChange }) {
  const [err, setErr] = useState('');
  const tile = (on) => 'flex size-14 cursor-pointer items-center justify-center overflow-hidden rounded-2xl border-2 bg-white/70 ' + (on ? 'border-accent' : 'border-transparent hover:border-ink/20');
  return (
    <div className="flex flex-col gap-1.5 text-sm text-muted">Picture
      <div className="flex flex-wrap items-center gap-2">
        {PRESETS.map((id, i) => <button type="button" key={id} aria-label={'Fish ' + (i + 1)} aria-pressed={value?.preset === id} className={tile(value?.preset === id)} onClick={() => onChange({ preset: id })}><Fish size={36} color={COLORS[i]} tail={0.15} /></button>)}
        <label className={tile(Boolean(value?.image)) + ' relative text-muted'} title="Upload your own image">
          {value?.image ? <img src={value.image} alt="Your image" className="size-full object-cover" /> : <Icon n="plus" size={22} />}
          <input type="file" accept="image/png,image/jpeg,image/webp" className="absolute inset-0 cursor-pointer opacity-0" onChange={async (e) => {
            const file = e.target.files?.[0]; e.target.value = '';
            if (!file) return;
            try { setErr(''); onChange({ image: await squareImage(file) }); } catch (x) { setErr(x.message); }
          }} />
        </label>
        {value && <button type="button" className="cursor-pointer text-sm text-accent underline" onClick={() => onChange(null)}>Use the default</button>}
      </div>
      <span>{err ? <span className="text-bad">{err}</span> : 'Pick a fish, or upload a PNG, JPEG or WebP. It\'s cropped to a square.'}</span>
    </div>
  );
}

// The signed-in account's library (server/src/library.js): saved listings and pods of them.
const savedIds = (s) => (s.library?.saved ?? []).filter((x) => !x.missing).map((x) => x.id);
const isSaved = (s, id) => (s.library?.saved ?? []).some((x) => x.id === id);
const isFavorite = (s, id) => (s.library?.favorites ?? []).includes(id);

// Save (bookmark): keep it in your library.
export function SaveButton({ s, act, id, className = '' }) {
  if (!s.library?.signedIn) return null;
  const saved = isSaved(s, id);
  return (
    <button aria-pressed={saved} title={saved ? 'Remove from your library' : 'Save to your library'} className={ghost + ' ' + className} onClick={(e) => { e.stopPropagation(); act(() => (saved ? api.unsaveListing(id) : api.saveListing(id)))(); }}>
      <Icon n="bookmark" size={16} fill={saved ? 'currentColor' : 'none'} className={saved ? 'text-accent' : ''} />{saved ? 'Saved' : 'Save'}
    </button>
  );
}

// Favorite (star): shown first in your library. Starring also saves.
export function FavoriteButton({ s, act, id }) {
  if (!s.library?.signedIn) return null;
  const on = isFavorite(s, id);
  return (
    <button aria-pressed={on} aria-label={on ? 'Remove from favorites' : 'Add to favorites'} title={on ? 'Remove from favorites' : 'Add to favorites'} className="flex size-9 cursor-pointer items-center justify-center rounded-xl text-ink/45 hover:bg-white/60 hover:text-[#9A5B00]" onClick={(e) => { e.stopPropagation(); act(() => api.favorite(id, !on))(); }}>
      <Icon n="star" size={20} fill={on ? 'currentColor' : 'none'} className={on ? 'text-[#9A5B00]' : ''} />
    </button>
  );
}

// A marketplace listing as a card: in the marketplace and in your library.
function ListingCard({ s, act, setOpen, l, i }) {
  const c = l.shoal || {};
  return (
    <ItemCard onOpen={() => setOpen({ kind: 'listing', id: l.id })}
      icon={<ListingIcon l={l} i={i} />}
      toggle={<span className="flex items-center gap-1"><Tag tone={l.available ? 'ok' : undefined}>{l.available ? 'Available' : 'Unavailable'}</Tag><FavoriteButton s={s} act={act} id={l.id} /></span>}
      title={l.name} by={'By ' + l.builder + ' · ' + (PROVIDERS[l.provider] || l.provider)}
      meta={<Stars r={l.rating?.average} n={l.rating?.count} />}
      tags={<>
        <Tag>{c.verified ?? 0} verified</Tag>
        {c.survivalRate != null && <Tag tone="ok">{pct(c.survivalRate)} survived</Tag>}
        {c.clawbacks > 0 && <Tag tone="bad">{c.clawbacks} clawbacks</Tag>}
        {c.costPerOutcome != null && <Tag>{money(c.costPerOutcome)} per surviving fix</Tag>}
        {c.costPerOutcome == null && (perFix(l.fixCost) ? <Tag title={PER_FIX_HOW}>{perFix(l.fixCost)}</Tag> : tokenPrice(l.openrouter?.price) && <Tag title={TOKEN_HOW}>{tokenPrice(l.openrouter.price)}</Tag>)}
        {l.openrouter?.contextLength && <Tag>{Math.round(l.openrouter.contextLength / 1000)}k context</Tag>}
      </>}
      body={l.tagline || l.description}
      footL={l.available ? (c.attempts ? 'Score ' + c.score + ' · ' + c.attempts + ' attempt' + (c.attempts === 1 ? '' : 's') : 'No bounties yet') : l.unavailableReason}
      footR={<><SaveButton s={s} act={act} id={l.id} /><button className={ghost} onClick={(e) => { e.stopPropagation(); setOpen({ kind: 'listing', id: l.id }); }}>Details</button></>} />
  );
}

export function Agents({ s, act, setOpen, mine, onPublish }) {
  const [q, setQ] = useState(''), [type, setType] = useState('all'), [provider, setProvider] = useState(''), [sort, setSort] = useState('best');
  const [minStars, setMinStars] = useState(0), [available, setAvailable] = useState(false), [res, setRes] = useState(null), [err, setErr] = useState('');
  useEffect(() => {
    if (mine) return;
    let live = true;
    const t = setTimeout(() => api.marketplace({ q, type: type === 'all' ? '' : type, provider, sort, minStars: minStars || '', available, limit: 200 })
      .then((r) => { if (live) { setRes(r); setErr(''); } }).catch((e) => live && setErr(e.message)), 200);
    return () => { live = false; clearTimeout(t); };
  }, [mine, q, type, provider, sort, minStars, available, s.market]);
  const items = mine ? mineOf(s).filter((l) => !q || l.name.toLowerCase().includes(q.toLowerCase())) : res?.items ?? [];
  const all = s.market;
  const chips = [['all', 'All', all.length], ['agent', 'Agents', all.filter((l) => l.kind === 'agent').length], ['model', 'Models', all.filter((l) => l.kind === 'model').length]];
  const pick = 'h-9 rounded-lg border border-ink/15 bg-white/60 pl-3 text-[15px] text-ink outline-none focus:border-accent';
  const Item = (l, i) => <ListingCard key={l.id} s={s} act={act} setOpen={setOpen} l={l} i={i} />;
  if (mine && !s.me?.viewer) return <Empty>{s.me?.oauth === false ? "GitHub sign-in isn't set up on this server, so agents can't be published yet." : <><a className="text-accent underline" href={signInHref('selling')}>Sign in with GitHub</a> to publish an agent.</>}</Empty>;
  return (
    <Browse q={q} setQ={setQ} placeholder={mine ? 'Search your agents' : 'Search agents, models and builders'} onRefresh={act(async () => { if (!mine) await api.marketplace({ limit: 1 }); })} chips={mine ? null : chips} chip={type} setChip={setType}>
      {!mine && <div className="glass flex flex-wrap items-center gap-x-6 gap-y-3 rounded-2xl px-5 py-4 text-[15px]">
        <div className="flex items-center gap-2"><span className="text-muted">Rating</span>
          <div className="flex gap-1">{[[0, 'Any'], [3, '3+'], [4, '4+'], [4.5, '4.5+']].map(([v, lbl]) => <button key={v} onClick={() => setMinStars(v)} className={'flex cursor-pointer items-center gap-1 rounded-lg px-2.5 py-1.5 ' + (minStars === v ? 'bg-ink text-paper' : 'hover:bg-white/60')}>{v > 0 && <Icon n="star" size={13} fill="currentColor" />}{lbl}</button>)}</div>
        </div>
        <label className="flex items-center gap-2"><span className="text-muted">From</span><select className={pick} value={provider} onChange={(e) => setProvider(e.target.value)}><option value="">Anyone</option>{Object.entries(PROVIDERS).map(([v, lbl]) => <option key={v} value={v}>{lbl}</option>)}</select></label>
        <label className="flex cursor-pointer items-center gap-2"><input type="checkbox" checked={available} onChange={(e) => setAvailable(e.target.checked)} className="size-4 accent-[#0A7470]" />Available now</label>
        <label className="ml-auto flex items-center gap-2"><span className="text-muted">Sort</span><select className={pick} value={sort} onChange={(e) => setSort(e.target.value)}>{(res?.sorts || Object.keys(SORT_LABELS)).map((v) => <option key={v} value={v}>{SORT_LABELS[v] || v}</option>)}</select></label>
      </div>}
      {err && <div className="glass rounded-2xl px-5 py-3 text-bad">{err}</div>}
      {items.length > 0 && <Group title={mine ? 'Published · ' + items.length : (res?.total ?? items.length) + ' listings'}>{items.map(Item)}</Group>}
      {!mine && res && <ImportModel act={act} />}
      {mine && !items.length && <Empty>You haven't published an agent yet. <button className="cursor-pointer text-accent underline" onClick={onPublish}>Publish one</button>.</Empty>}
      {!mine && res && !items.length && <Empty>No listings match these filters.</Empty>}
    </Browse>
  );
}

// Any OpenRouter model with structured output can be added by its id.
function ImportModel({ act }) {
  const [id, setId] = useState('');
  return (
    <div className={card + ' md:flex-row md:items-center'}>
      <div className="flex flex-1 flex-col gap-1"><span className="text-[17px] font-semibold">Add a model from OpenRouter</span><span className="text-[15px] text-muted">Paste its id, like z-ai/glm-5.3. It competes through your OpenRouter key (API keys).</span></div>
      <div className="flex gap-2 md:w-[380px]"><input className={field} value={id} onChange={(e) => setId(e.target.value)} placeholder="provider/model" /><button className={ghost} disabled={!id.trim()} onClick={act(async () => { await api.importModel(id.trim()); setId(''); })}>Add</button></div>
    </div>
  );
}

// Who competes on a bounty. null = the server's default (Shoal's built-in agents).
const CLAUDE_DEFAULTS = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'];

export function CompetitorPicker({ s, value, onChange }) {
  const [open, setOpen] = useState(false);
  // Default: the Claude models that can run (server/src/marketplace.js
  // defaultCompetitors), else Shoal's built-in agents.
  const claude = s.market.filter((l) => CLAUDE_DEFAULTS.includes(l.id) && l.available).map((l) => l.id);
  const defaults = claude.length ? claude : s.market.filter((l) => l.provider === 'shoal' && l.available).map((l) => l.id);
  const picked = value ?? defaults;
  const toggle = (id) => onChange(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);
  // Saved listings come first; a pod (or all saved) replaces the picks
  // with its members that can compete right now.
  const saved = savedIds(s);
  const runnable = (ids) => ids.filter((id) => s.market.some((l) => l.id === id && l.available)).slice(0, 12);
  const shortcuts = [
    ...(saved.length ? [['saved', 'All saved', saved]] : []),
    ...(s.library?.pods ?? []).map((p) => [p.id, p.name, p.listings, p.description]),
  ].map(([key, label, ids, about]) => ({ key, label, about, ids: runnable(ids) }));
  const list = [...s.market].sort((a, b) => b.available - a.available || saved.includes(b.id) - saved.includes(a.id) || (b.shoal?.score ?? 0) - (a.shoal?.score ?? 0));
  return (
    <div className="flex flex-col gap-2">
      <button onClick={() => setOpen(!open)} className="flex cursor-pointer items-center justify-between text-left text-sm text-muted">
        <span>Competing: <span className="text-ink">{picked.length ? picked.map((id) => nameOf(s, id)).slice(0, 4).join(', ') + (picked.length > 4 ? ' +' + (picked.length - 4) : '') : 'nobody yet'}</span></span>
        <span className="text-accent">{open ? 'Done' : 'Change'}</span>
      </button>
      {shortcuts.length > 0 && <div className="flex flex-wrap items-center gap-2 text-sm"><span className="text-muted">From your library:</span>
        {shortcuts.map((x) => <button key={x.key} disabled={!x.ids.length} title={(x.about ? x.about + '\n' : '') + (x.ids.length ? 'Compete with ' + x.ids.map((id) => nameOf(s, id)).join(', ') : 'Nothing in it can compete right now')} onClick={() => onChange(x.ids)} className={'cursor-pointer rounded-full border px-3 py-1 disabled:cursor-default disabled:opacity-45 ' + (x.ids.length && x.ids.length === picked.length && x.ids.every((id) => picked.includes(id)) ? 'border-ink bg-ink text-paper' : 'border-ink/15 bg-white/60 hover:bg-white/85')}>{x.label} <span className="tabular-nums opacity-70">{x.ids.length}</span></button>)}
      </div>}
      {open && <div className="flex max-h-[260px] flex-col overflow-y-auto rounded-xl border border-ink/15 bg-white/50">
        {list.map((l) => (
          <label key={l.id} className={'flex items-start gap-3 border-t border-ink/10 px-3 py-2 text-[15px] first:border-t-0 ' + (l.available ? 'cursor-pointer' : 'opacity-50')}>
            <input type="checkbox" className="mt-1 size-4 accent-[#0A7470]" disabled={!l.available} checked={picked.includes(l.id)} onChange={() => toggle(l.id)} />
            <span className="flex min-w-0 flex-col"><span>{l.name} <span className="text-sm text-muted">{saved.includes(l.id) ? '· saved ' : ''}· {PROVIDERS[l.provider] || l.provider}{l.shoal?.verified ? ' · ' + l.shoal.verified + ' verified' : ''}</span></span>{!l.available && <span className="text-sm text-muted">Can't compete: {l.unavailableReason}</span>}</span>
          </label>
        ))}
      </div>}
      {picked.length > 12 && <span className="text-sm text-bad">Pick at most 12.</span>}
      <span className="text-sm text-muted">Only the agents you pick get your code. Each one attempts the fix in a private sandbox.</span>
    </div>
  );
}

export function ListingDetail({ s, act, id, onClose }) {
  const [d, setD] = useState(null), [sort, setSort] = useState('helpful'), [err, setErr] = useState(''), [secret, setSecret] = useState(null), [n, setN] = useState(0);
  useEffect(() => { api.listing(id, sort).then(setD).catch((e) => setErr(e.message)); }, [id, sort, n, s.market]);
  const reload = () => setN((x) => x + 1);
  const me = s.me?.viewer?.login;
  if (err) return <div className="p-8 text-bad">{err}</div>;
  if (!d) return <div className="p-8 text-muted">Loading…</div>;
  const c = d.shoal || {}, r = d.rating || {}, o = d.openrouter;
  const owner = d.owner && d.owner === me, remover = owner || (d.provider === 'openrouter' && (!d.addedBy || d.addedBy === me));
  const stats = [['Score', c.score ?? 0], ['Verified', c.verified ?? 0], ['Survived', c.survived ?? 0], ['Clawbacks', c.clawbacks ?? 0], ['Survival rate', pct(c.survivalRate)], ['Judge approval', pct(c.judgeApproval)], ['Diagnosis accuracy', pct(c.diagnosisAccuracy)], ['Uptime', pct(c.uptime)], ['Time to fix', secs(c.avgTimeToFixMs)], ['Lines per fix', c.avgLinesChanged ?? '–'], ['Per surviving fix', c.costPerOutcome == null ? '–' : money(c.costPerOutcome)], ['Earned', money(c.earned)]];
  return (
    <div className="flex flex-col gap-5 p-8">
      <div className="flex items-center gap-4"><div className="flex size-16 items-center justify-center rounded-2xl bg-white/70"><ListingIcon l={d} i={s.market.findIndex((l) => l.id === id)} /></div><div className="flex flex-col"><span className="text-[26px] font-semibold tracking-[-0.03em]">{d.name}</span><span className="text-muted">By {d.builder} · {PROVIDERS[d.provider] || d.provider}</span></div></div>
      <AddToLibrary s={s} act={act} id={id} />
      <div className="flex flex-wrap items-center gap-2"><Stars r={r.average} n={r.count} /><Tag tone={d.available ? 'ok' : undefined}>{d.available ? 'Available' : "Can't compete: " + d.unavailableReason}</Tag>{(d.pains || []).map((p) => <Tag key={p}>{PAINS[p] || p}</Tag>)}{[...new Set([...(d.languages || []), ...(d.verifiedLanguages || [])])].map((x) => <Tag key={x}>{x}</Tag>)}</div>
      {(d.description || d.tagline) && <p className="m-0 whitespace-pre-line text-[15px]">{d.description || d.tagline}</p>}
      <div className="grid grid-cols-2 gap-4 border-y border-ink/10 py-4 tabular-nums sm:grid-cols-4">{stats.map(([k, v]) => <div key={k} className="flex flex-col"><span className="text-xl font-semibold">{v}</span><span className="text-sm text-muted">{k}</span></div>)}</div>
      <span className="-mt-2 text-sm text-muted">Measured by Shoal from real bounties and trials, never self-reported. The score counts each rate only as far as the number of attempts backs it, so a short lucky streak can't top the board. {CONFIDENCE[c.confidence] || ''}</span>
      {(o || perFix(d.fixCost)) && <div className="flex flex-wrap gap-2 text-sm">{perFix(d.fixCost) && <Tag title={PER_FIX_HOW}>{perFix(d.fixCost)}</Tag>}{tokenPrice(o?.price) && <Tag title={TOKEN_HOW}>{tokenPrice(o.price)}</Tag>}{o?.contextLength && <Tag>{o?.contextLength.toLocaleString()} context</Tag>}{o?.benchmarks?.coding != null && <Tag>Coding index {o?.benchmarks.coding}</Tag>}{o?.uptime1d != null && <Tag>{Math.round(o?.uptime1d)}% uptime today</Tag>}{o?.popularityRank && <Tag>#{o?.popularityRank} on OpenRouter</Tag>}{o?.releasedAt && <Tag>Released {o?.releasedAt.slice(0, 10)}</Tag>}</div>}
      {owner && <BuilderTools d={d} act={act} onSecret={setSecret} reload={reload} />}
      {secret && <SecretBox secret={secret} />}
      {remover && <button className={ghost + ' self-start text-bad! hover:text-bad!'} onClick={act(async () => { await api.removeListing(id); onClose(); })}>Remove from the marketplace</button>}
      <div className="flex items-center justify-between border-t border-ink/10 pt-4"><span className="text-[17px] font-semibold">Reviews{r.count ? ' · ' + r.count : ''}</span>
        {d.reviews.length > 1 && <select className="rounded-xl border border-ink/15 bg-white/60 px-3 py-1.5 text-sm" value={sort} onChange={(e) => setSort(e.target.value)}>{[['helpful', 'Most helpful'], ['newest', 'Newest'], ['highest', 'Highest'], ['lowest', 'Lowest']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>}</div>
      {r.count > 0 && <div className="flex flex-wrap gap-2">{Object.entries(r.aspects || {}).filter(([, v]) => v != null).map(([k, v]) => <Tag key={k}>{{ codeQuality: 'Code quality', prClarity: 'PR clarity', speed: 'Speed' }[k] || k} {v}/5</Tag>)}</div>}
      {d.reviews.length === 0 && <span className="text-[15px] text-muted">No reviews yet. Only teams whose bounty this listing won can review it.</span>}
      {d.reviews.map((rv) => <Review key={rv.id} rv={rv} me={me} owner={owner} act={act} reload={reload} />)}
    </div>
  );
}

// On a listing: save it, and put it in or take it out of your pods.
function AddToLibrary({ s, act, id }) {
  const lists = s.library?.pods ?? [], max = s.library?.limits?.perPod ?? 12;
  if (!s.library?.signedIn) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <SaveButton s={s} act={act} id={id} />
      <FavoriteButton s={s} act={act} id={id} />
      {lists.map((p) => {
        const inIt = p.listings.includes(id), full = !inIt && p.listings.length >= max;
        return <button key={p.id} aria-pressed={inIt} disabled={full} title={full ? 'This pod is full (' + max + ')' : inIt ? 'Remove from ' + p.name : 'Add to ' + p.name}
          onClick={act(() => api.updatePod(p.id, { listings: inIt ? p.listings.filter((x) => x !== id) : [...p.listings, id] }))}
          className={'cursor-pointer rounded-full border px-3 py-1.5 text-sm disabled:cursor-default disabled:opacity-45 ' + (inIt ? 'border-ink bg-ink text-paper' : 'border-ink/15 bg-white/60 hover:bg-white/85')}>{inIt ? '✓ ' : '+ '}{p.name}</button>;
      })}
    </div>
  );
}

// Your library: saved agents and models, and pods that group them for bounties.
export function Library({ s, act, setOpen, go }) {
  const [composing, setComposing] = useState(false);
  const lib = s.library;
  if (!lib) return <div className="text-muted">Loading…</div>;
  if (!lib.signedIn) return <Empty><a className="text-accent underline" href={signInHref('library')}>Sign in with GitHub</a> to save agents and make pods.</Empty>;
  const byId = (id) => s.market.find((l) => l.id === id);
  const saved = lib.saved.map((x) => byId(x.id)).filter(Boolean);
  const favorites = (lib.favorites ?? []).map(byId).filter(Boolean);
  // Favorites are saved too; they're shown once, above.
  const others = saved.filter((l) => !lib.favorites?.includes(l.id));
  const missing = lib.saved.filter((x) => x.missing);
  const grid = (list) => <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">{list.map((l, i) => <ListingCard key={l.id} s={s} act={act} setOpen={setOpen} l={l} i={i} />)}</div>;
  return (
    <section className="flex flex-col gap-10">
      <div className="flex flex-col gap-5">
        <h2 className="m-0 border-b border-ink/12 pb-3 text-[24px] font-semibold tracking-[-0.025em]">Favorites · {favorites.length}</h2>
        {favorites.length ? grid(favorites) : <Empty>No favorites yet. Star an agent or model to keep it here, at the top of your library.</Empty>}
      </div>

      <div className="flex flex-col gap-5">
        <h2 className="m-0 border-b border-ink/12 pb-3 text-[24px] font-semibold tracking-[-0.025em]">Saved · {others.length}</h2>
        {others.length ? grid(others)
          : <Empty>Nothing saved yet. Find agents and models in <button className="cursor-pointer text-accent underline" onClick={() => go('agents')}>Agents for hire</button> and press Save.</Empty>}
        {missing.length > 0 && <span className="text-sm text-muted">{missing.length} saved listing{missing.length === 1 ? ' was' : 's were'} removed from the marketplace. <button className="cursor-pointer text-accent underline" onClick={act(async () => { for (const x of missing) await api.unsaveListing(x.id); })}>Clear</button></span>}
      </div>

      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-ink/12 pb-3">
          <h2 className="m-0 text-[24px] font-semibold tracking-[-0.025em]">Pods · {lib.pods.length}</h2>
          <button className={primary} onClick={() => setComposing(true)}><Icon n="plus" size={18} />New pod</button>
        </div>
        <span className="-mt-2 text-[15px] text-muted">Group agents you like to use together. When you post a bounty, pick a pod and its agents compete. Up to {lib.limits.perPod} per pod.</span>
        {lib.pods.length ? <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2">{lib.pods.map((p) => <Pod key={p.id} s={s} act={act} p={p} setOpen={setOpen} />)}</div>
          : <div className="glass flex flex-col items-center gap-4 rounded-[20px] px-8 py-10 text-center">
              <span className="flex items-center -space-x-3">{[0, 1, 2].map((i) => <span key={i} className="flex size-12 items-center justify-center rounded-full bg-white/80 ring-4 ring-[#e3f3ee]"><Fish size={30} color={COLORS[i % COLORS.length]} tail={0.15} /></span>)}</span>
              <div className="flex max-w-[460px] flex-col gap-1.5">
                <span className="text-[19px] font-semibold">No pods yet</span>
                <span className="text-[15px] text-muted">A pod is a group of agents and models that race on a bounty together. Make one for each kind of bug, like “Fast and cheap” or “Best for Python”.</span>
              </div>
              <button className={primary} onClick={() => setComposing(true)}><Icon n="plus" size={18} />Create your first pod</button>
            </div>}
        {/* At the top of the page: inside the page's slide-in transform a fixed dialog isn't fixed to the window. */}
        {composing && createPortal(<Modal onClose={() => setComposing(false)}><NewPod act={act} limits={lib.limits} saved={saved} onDone={() => setComposing(false)} /></Modal>, document.body)}
      </div>
    </section>
  );
}

// Text that reads as text and edits in place: no box until hovered or focused.
const inline = 'w-full rounded-lg border border-transparent bg-transparent px-2 -mx-2 py-1 text-ink outline-none transition-colors placeholder:text-ink/40 hover:border-ink/12 focus:border-accent/60 focus:bg-white/60';

// Making a pod, in a dialog: a name, an optional description, and (to start
// with) any of the saved agents.
function NewPod({ act, limits, saved, onDone }) {
  const [name, setName] = useState(''), [about, setAbout] = useState(''), [picked, setPicked] = useState([]);
  const toggle = (id) => setPicked((x) => (x.includes(id) ? x.filter((y) => y !== id) : x.length < limits.perPod ? [...x, id] : x));
  const create = (e) => { e.preventDefault(); act(async () => { await api.createPod(name.trim(), about, picked); onDone(); })(); };
  return (
    <form onSubmit={create} className="flex flex-col gap-5 p-8">
      <div className="flex flex-col gap-1 pr-10">
        <h2 className="m-0 text-[26px] font-semibold tracking-[-0.03em]">New pod</h2>
        <span className="text-[15px] text-[#6B5432]">A group of agents that race on a bounty together. You can change all of this later.</span>
      </div>
      <Label t="Name"><input autoFocus className={field} value={name} onChange={(e) => setName(e.target.value)} maxLength={limits.name} placeholder="e.g. Fast and cheap" /></Label>
      <Label t="Description (optional)"><input className={field} value={about} onChange={(e) => setAbout(e.target.value)} maxLength={limits.description} placeholder="e.g. Low-cost models for quick JavaScript fixes" /></Label>
      {saved.length > 0 && <div className="flex flex-col gap-2">
        <span className="text-sm text-muted">Add saved agents now (optional) · {picked.length} of {limits.perPod}</span>
        <div className="flex flex-wrap gap-2">{saved.map((l, i) => {
          const on = picked.includes(l.id);
          return <button type="button" key={l.id} aria-pressed={on} onClick={() => toggle(l.id)} className={'inline-flex cursor-pointer items-center gap-1.5 rounded-full border py-1 pl-1 pr-3 text-[14.5px] ' + (on ? 'border-accent bg-accent/12 text-ink' : 'border-ink/15 bg-white/60 text-ink/80 hover:bg-white')}>
            <MemberIcon l={l} i={i} />{l.name}{on && <Icon n="close" size={12} className="text-muted" />}
          </button>;
        })}</div>
      </div>}
      <div className="flex flex-wrap items-center gap-2">
        <button className={primary} disabled={!name.trim()}>Create pod</button>
        <button type="button" className={ghost} onClick={onDone}>Cancel</button>
        {!name.trim() && <span className="text-sm text-muted">Give it a name to create it.</span>}
      </div>
    </form>
  );
}

// A closed pod shows this many members' icons, stacked.
const STACKED = 4;

const MemberIcon = ({ l, i, ring = false }) => (
  <span className={'flex size-6 shrink-0 items-center justify-center rounded-full bg-white text-ink' + (ring ? ' ring-2 ring-[#eaf6f2]' : '')}>
    {!l ? <Icon n="close" size={12} className="text-muted" /> : <AgentAvatar l={l} size={18} />}
  </span>
);

function Pod({ s, act, p, setOpen }) {
  const [name, setName] = useState(p.name), [about, setAbout] = useState(p.description), [expanded, setExpanded] = useState(false);
  useEffect(() => setName(p.name), [p.name]);
  useEffect(() => setAbout(p.description), [p.description]);
  const max = s.library.limits.perPod;
  const listed = (id) => s.market.find((l) => l.id === id);
  // Anything saved can be added; the rest of the marketplace through a listing's own page.
  const choices = savedIds(s).filter((id) => !p.listings.includes(id)).map(listed).filter(Boolean);
  const set = (listings) => act(() => api.updatePod(p.id, { listings }))();
  const full = p.listings.length >= max;
  return (
    <div className={card + ' gap-4'}>
      <div className="flex flex-col">
        <div className="flex items-center gap-2">
          <input aria-label="Pod name" className={inline + ' min-w-0 flex-1 text-[21px] font-semibold tracking-[-0.02em]'} value={name} maxLength={s.library.limits.name} onChange={(e) => setName(e.target.value)} onBlur={() => (name.trim() && name !== p.name ? act(() => api.updatePod(p.id, { name }))() : setName(p.name))} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
          <Tag tone={full ? 'ok' : undefined}>{p.listings.length} of {max}</Tag>
          <button aria-label={'Delete the pod ' + p.name} title="Delete pod" className="flex size-9 cursor-pointer items-center justify-center rounded-xl text-ink/40 hover:bg-bad/10 hover:text-bad" onClick={() => confirm('Delete the pod "' + p.name + '"? The agents stay saved.') && act(() => api.deletePod(p.id))()}><Icon n="trash" size={18} /></button>
        </div>
        <textarea aria-label="Pod description" rows={1} className={inline + ' resize-none text-[15px] text-muted [field-sizing:content]'} value={about} maxLength={s.library.limits.description} placeholder="Add a description" onChange={(e) => setAbout(e.target.value)} onBlur={() => about !== p.description && act(() => api.updatePod(p.id, { description: about }))()} />
      </div>
      {/* Closed: a summary that opens the pod. Open: its members and the add picker. */}
      <button aria-expanded={expanded} className="-mx-2 flex cursor-pointer items-center gap-3 rounded-xl px-2 py-1.5 text-left hover:bg-white/50" onClick={() => setExpanded((x) => !x)}>
        {p.listings.length > 0 && <span className="flex shrink-0 -space-x-2">{p.listings.slice(0, STACKED).map((id, i) => <MemberIcon key={id} l={listed(id)} i={i} ring />)}</span>}
        <span className="min-w-0 flex-1 truncate text-[15px] text-muted">
          {p.listings.length ? p.listings.length + (p.listings.length === 1 ? ' agent' : ' agents') + ': ' + p.listings.map((id) => listed(id)?.name ?? id).join(', ') : 'Empty. Open it to add agents.'}
        </span>
        <span className="shrink-0 text-[14px] text-accent">{expanded ? 'Hide' : 'Show'}</span>
      </button>
      {expanded && <>
        {p.listings.length > 0 && <div className="flex flex-wrap gap-2">
          {p.listings.map((id, i) => {
            const l = listed(id);
            return <span key={id} className="group inline-flex max-w-full items-center gap-1.5 rounded-full border border-ink/10 bg-white/60 py-1 pl-1 pr-1.5 text-[14.5px]">
              <MemberIcon l={l} i={i} />
              {l ? <button title={l.name + ' · ' + (PROVIDERS[l.provider] || l.provider) + (l.available ? '' : ' · unavailable')} className={'min-w-0 cursor-pointer truncate ' + (l.available ? '' : 'text-muted line-through')} onClick={() => setOpen({ kind: 'listing', id })}>{l.name}</button>
                : <span className="min-w-0 truncate text-muted" title="Removed from the marketplace">{id}</span>}
              <button aria-label={'Remove ' + (l?.name || id) + ' from this pod'} title="Remove from pod" className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-ink/35 hover:bg-bad/10 hover:text-bad" onClick={() => set(p.listings.filter((x) => x !== id))}><Icon n="close" size={13} /></button>
            </span>;
          })}
        </div>}
        {!full && (choices.length > 0
          ? <label className="relative flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-ink/25 px-3 py-2.5 text-[15px] text-muted hover:border-accent/50 hover:text-accent">
              <Icon n="plus" size={18} />Add a saved agent
              <select aria-label="Add a saved agent" className="absolute inset-0 cursor-pointer opacity-0" value="" onChange={(e) => e.target.value && set([...p.listings, e.target.value])}>
                <option value="">Add a saved agent…</option>{choices.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </label>
          : <span className="rounded-xl border border-dashed border-ink/20 px-3 py-2.5 text-[14px] text-muted">{p.listings.length ? 'Everything you saved is in this pod. Save more agents to add them.' : 'Empty. Save agents in Agents for hire, then add them here.'}</span>)}
      </>}
    </div>
  );
}

function Review({ rv, me, owner, act, reload }) {
  const [reply, setReply] = useState('');
  return (
    <div className="flex flex-col gap-1.5 border-t border-ink/10 pt-3 text-[15px]">
      <div className="flex flex-wrap items-center gap-2"><Stars r={rv.stars} n={1} /><span className="font-medium">@{rv.reviewer}</span><span className="text-sm text-muted">· {rv.testFile} · {rv.outcome === 'settled' ? 'fix survived' : 'fix regressed'} · {rv.createdAt.slice(0, 10)}</span></div>
      {rv.body && <p className="m-0">{rv.body}</p>}
      {rv.reply && <p className="m-0 border-l-2 border-accent/40 pl-3 text-muted"><span className="text-ink">@{rv.reply.by}:</span> {rv.reply.body}</p>}
      <div className="flex items-center gap-3 text-sm text-muted">
        <span>{rv.helpful} found this helpful</span>
        {me && me !== rv.reviewer && <button className="cursor-pointer text-accent" onClick={act(async () => { await api.helpful(rv.id, true); reload(); })}>Helpful</button>}
      </div>
      {owner && !rv.reply && <div className="flex gap-2"><input className={field} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Reply publicly as the builder" /><button className={ghost} disabled={!reply.trim()} onClick={act(async () => { await api.reply(rv.id, reply); setReply(''); reload(); })}>Reply</button></div>}
    </div>
  );
}

// The builder's own controls: change the webhook, get a new signing secret.
function BuilderTools({ d, act, onSecret, reload }) {
  const [url, setUrl] = useState(d.webhookUrl || '');
  // Changing the picture saves it right away.
  const [avatar, setAvatar] = useState(d.avatar?.preset ? { preset: d.avatar.preset } : null);
  const pick = (v) => { setAvatar(v); act(async () => { await api.updateListing(d.id, { avatar: v }); reload(); })(); };
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-ink/15 bg-white/50 p-4">
      <span className="text-sm font-medium text-muted">You built this agent</span>
      <AvatarPicker value={avatar ?? (d.avatar?.image ? { image: apiHref('/api/marketplace/avatar?id=' + encodeURIComponent(d.id) + '&v=' + d.avatar.v) } : null)} onChange={pick} />
      <Label t="Webhook URL"><div className="flex gap-2"><input className={field} value={url} onChange={(e) => setUrl(e.target.value)} /><button className={ghost} disabled={url === d.webhookUrl} onClick={act(async () => { await api.updateListing(d.id, { webhookUrl: url }); reload(); })}>Save</button></div></Label>
      <button className={ghost + ' self-start'} onClick={act(async () => onSecret((await api.rotateSecret(d.id)).signingSecret))}>New signing secret</button>
    </div>
  );
}

// The agent's signing secret, shown once. Copy says it worked; the technical
// details are tucked away for whoever writes the webhook.
function SecretBox({ secret }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(secret); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setCopied(false); }
  };
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-[#6B5432]/20 bg-white/45 p-4">
      <span className="text-[15px] font-semibold">Signing secret</span>
      <div className="flex gap-2">
        <code className="min-w-0 flex-1 select-all break-all rounded-xl border border-[#6B5432]/15 bg-white/80 px-3 py-2.5 font-mono text-sm">{secret}</code>
        <button className={(copied ? primary : ghost) + ' shrink-0'} onClick={copy}>{copied ? 'Copied ✓' : 'Copy'}</button>
      </div>
      <span className="text-sm text-[#6B5432]">Copy it now: Shoal won't show it again. Your webhook uses it to check that requests really come from Shoal. Lost it? Make a new one from Your agents.</span>
      <details className="text-sm text-[#6B5432]">
        <summary className="cursor-pointer select-none font-medium">How to check a request</summary>
        <p className="mb-0 mt-2">Each request has an <code>X-Shoal-Timestamp</code> header and an <code>X-Shoal-Signature</code> header of the form <code>v1=&lt;HMAC-SHA256 of "timestamp.body"&gt;</code>, keyed with this secret. Compute the same HMAC and compare; reject old timestamps.</p>
      </details>
    </div>
  );
}

// The webhook address as the server will read it (https:// added when left
// out), and what's wrong with it, if anything.
function checkWebhook(raw) {
  let text = raw.trim();
  if (!text) return { url: '', problem: null };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = (/^(localhost|127\.0\.0\.1)(:|\/|$)/.test(text) ? 'http://' : 'https://') + text;
  let u;
  try { u = new URL(text); } catch { return { url: text, problem: "That isn't a web address. Use something like https://agent.example.com/shoal" }; }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (!local && !u.hostname.includes('.')) return { url: text, problem: 'Use a full domain, like agent.example.com' };
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return { url: text, problem: 'The address must start with https://' };
  return { url: u.href, problem: null };
}

// The ways a builder's agent can run (server/src/uploads.js).
const RUNTIME_CHOICES = [
  ['webhook', 'Webhook', 'Your server, your code'],
  ['prompt', 'Prompt', 'Instructions on a model'],
  ['bundle', 'Code bundle', 'Node or Python .zip'],
  ['image', 'Container', 'Public image by digest'],
];
const Note = ({ children }) => <span className="-mt-2 text-sm text-[#6B5432]">{children}</span>;

export function PublishAgent({ s, act, onDone }) {
  const [f, setF] = useState({ name: '', tagline: '', description: '', webhookUrl: '', languages: '' }), [avatar, setAvatar] = useState(null);
  const [pains, setPains] = useState(['flaky-tests']), [secret, setSecret] = useState(null);
  const [busy, setBusy] = useState(false), [err, setErr] = useState('');
  const [runtime, setRuntime] = useState('webhook'), [prompt, setPrompt] = useState({ model: '', instructions: '' });
  const [bundle, setBundle] = useState({ language: 'node', entry: 'index.js', zip: '', file: '' }), [image, setImage] = useState('');
  const hook = checkWebhook(f.webhookUrl);
  const models = s.market.filter((l) => l.kind === 'model' && ['anthropic', 'openai'].includes(l.provider));
  const ready = { webhook: hook.url && !hook.problem, prompt: prompt.model && prompt.instructions.trim(), bundle: bundle.zip && bundle.entry.trim(), image: /@sha256:[a-f0-9]{64}$/.test(image.trim()) }[runtime];
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  if (secret) return (
    <div className="flex flex-col gap-5 p-8">
      <h2 className="m-0 text-[26px] font-semibold tracking-[-0.03em]">{f.name} is live</h2>
      <SecretBox secret={secret} />
      <span className="text-[15px] text-[#6B5432]">When a team picks your agent, Shoal sends the bounty to your webhook: the failing test and the code it uses. Your agent replies with the fixed files before the deadline.</span>
      <button className={primary + ' self-start'} onClick={onDone}>Done</button>
    </div>
  );
  if (!s.me?.viewer) return <div className="p-8 text-muted">{s.me?.oauth === false ? "GitHub sign-in isn't set up on this server." : <><a className="text-accent underline" href={signInHref('selling')}>Sign in with GitHub</a> to publish an agent.</>}</div>;
  return (
    <div className="flex flex-col gap-5 p-8">
      <h2 className="m-0 text-[26px] font-semibold tracking-[-0.03em]">Publish an agent</h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Label t="Name"><input className={field} value={f.name} onChange={set('name')} placeholder="TideTurner" /></Label>
        <Label t="Languages (comma separated)"><input className={field} value={f.languages} onChange={set('languages')} placeholder="javascript, python" /></Label>
      </div>
      <AvatarPicker value={avatar} onChange={setAvatar} />
      <Label t="One-line pitch"><input className={field} value={f.tagline} onChange={set('tagline')} placeholder="Fixes races in async code" /></Label>
      <Label t="How it fixes tests"><textarea rows="4" className={field + ' resize-y'} value={f.description} onChange={set('description')} placeholder="Finds the race condition in the app code. Never touches the tests." /></Label>
      <div className="flex flex-col gap-1.5 text-sm text-muted">How it runs
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{RUNTIME_CHOICES.map(([id, label, hint]) => (
          <button type="button" key={id} aria-pressed={runtime === id} onClick={() => setRuntime(id)} className={'flex cursor-pointer flex-col items-start gap-0.5 rounded-xl border px-3 py-2 text-left ' + (runtime === id ? 'border-accent bg-accent/10' : 'border-ink/15 bg-white/50 hover:bg-white/80')}>
            <span className="text-[15px] font-medium text-ink">{label}</span><span className="text-[12.5px] leading-snug">{hint}</span>
          </button>))}
        </div>
      </div>
      {runtime === 'webhook' && <>
        <Label t="Webhook URL (https)">
          <input className={field + (hook.problem ? ' border-bad/60' : '')} value={f.webhookUrl} onChange={set('webhookUrl')} placeholder="https://agent.example.com/shoal" inputMode="url" autoComplete="off" spellCheck="false" />
          {hook.problem ? <span className="text-sm text-bad">{hook.problem}</span> : hook.url && hook.url !== f.webhookUrl.trim() && <span className="text-sm text-muted">Will be saved as {hook.url}</span>}
        </Label>
      </>}
      {runtime === 'prompt' && <>
        <Label t="Model"><select className={field} value={prompt.model} onChange={(e) => setPrompt((p) => ({ ...p, model: e.target.value }))}><option value="">Choose a model…</option>{models.map((m) => <option key={m.id} value={m.id}>{m.name} · {PROVIDERS[m.provider] || m.provider}</option>)}</select></Label>
        <Label t="Instructions"><textarea rows="6" className={field + ' resize-y'} value={prompt.instructions} maxLength={8000} onChange={(e) => setPrompt((p) => ({ ...p, instructions: e.target.value }))} placeholder="You fix flaky tests caused by timing. Find the race in the application code and fix it properly; never add sleeps or retries." /></Label>
        <Note>Shoal runs it on the team's own API keys. Only you see the instructions; teams see the model. Shoal's rules always apply on top of yours.</Note>
      </>}
      {runtime === 'bundle' && <>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Label t="Language"><select className={field} value={bundle.language} onChange={(e) => setBundle((b) => ({ ...b, language: e.target.value, entry: e.target.value === 'python' ? 'main.py' : 'index.js' }))}><option value="node">Node 22</option><option value="python">Python 3.12</option></select></Label>
          <Label t="Entry file"><input className={field} value={bundle.entry} onChange={(e) => setBundle((b) => ({ ...b, entry: e.target.value }))} /></Label>
        </div>
        <label className="relative flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-ink/25 px-4 py-3 text-[15px] text-muted hover:border-accent/50 hover:text-accent">
          <Icon n="plus" size={18} />{bundle.file ? bundle.file + ' · ' + Math.round(bundle.zip.length * 0.75 / 1024) + ' KB' : 'Upload a .zip (up to 4 MB)'}
          <input type="file" accept=".zip,application/zip" className="absolute inset-0 cursor-pointer opacity-0" onChange={async (e) => {
            const file = e.target.files?.[0]; e.target.value = '';
            if (!file) return;
            if (file.size > 4 * 1024 * 1024) return setErr('Bundles are at most 4 MB zipped');
            const bytes = new Uint8Array(await file.arrayBuffer());
            let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
            setErr(''); setBundle((b) => ({ ...b, zip: btoa(bin), file: file.name }));
          }} />
        </label>
        <Note>Runs in Shoal's sandbox with no internet access. It reads the task as JSON on stdin and writes its fix to stdout; to use a model it asks Shoal, which answers on the team's keys. Don't include API keys or secrets: bundles with them are refused.</Note>
      </>}
      {runtime === 'image' && <>
        <Label t="Container image (pinned by digest)"><input className={field} value={image} onChange={(e) => setImage(e.target.value)} placeholder="ghcr.io/you/agent@sha256:…" autoComplete="off" spellCheck="false" /></Label>
        <Note>A public image, pinned to an exact digest so what runs is what you published. Same sandbox and stdin/stdout protocol as a code bundle; no registry passwords are stored.</Note>
      </>}
      <div className="flex flex-col gap-1.5 text-sm text-muted">What it fixes
        <div className="flex flex-wrap gap-2">{Object.entries(PAINS).map(([id, lbl]) => <button key={id} onClick={() => setPains((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))} className={'cursor-pointer rounded-full border px-3 py-1.5 text-[15px] ' + (pains.includes(id) ? 'border-ink bg-ink text-paper' : 'border-ink/15 bg-white/60 text-ink')}>{lbl}</button>)}</div>
      </div>
      {/* Errors from the server show here, in the form, not at the top of the page. */}
      {err && <span className="text-sm text-bad">{err}</span>}
      <button className={primary} disabled={busy || !f.name.trim() || !ready || !pains.length} onClick={async () => {
        setBusy(true); setErr('');
        try {
          const how = { webhook: { webhookUrl: hook.url }, prompt: { prompt }, bundle: { bundle: { language: bundle.language, entry: bundle.entry, zip: bundle.zip } }, image: { image: image.trim() } }[runtime];
          const r = await api.publishListing({ ...f, webhookUrl: undefined, ...how, runtime, avatar, pains, languages: f.languages.split(',').map((x) => x.trim()).filter(Boolean) });
          await s.refresh?.();
          // Only webhook agents get a signing secret to keep; the rest are live now.
          if (r.signingSecret) setSecret(r.signingSecret); else onDone();
        } catch (e) { setErr(e.message); } finally { setBusy(false); }
      }}>{busy ? 'Publishing…' : 'Publish'}</button>
      <span className="text-sm text-muted">Agents can never edit tests, CI config or package manifests, and only see code from teams that pick them.</span>
    </div>
  );
}
