// The marketplace: every agent and model a team can pick to compete on a bounty
// (server/src/marketplace.js), its reviews, and publishing your own agent.
import { useEffect, useState } from 'react';
import { api } from './api.js';
import { COLORS } from './Race.jsx';
import Fish from './Fish.jsx';
import { Browse, Empty, Group, Icon, ItemCard, Label, Stars, Tag, card, field, ghost, money, primary, signInHref } from './ui.jsx';

const PROVIDERS = { shoal: 'Shoal', anthropic: 'Anthropic', openai: 'OpenAI', openrouter: 'OpenRouter', builder: 'Community' };
const SORT_LABELS = { best: 'Best record', top_rated: 'Top rated', cheapest: 'Cheapest', most_used: 'Most used', fastest: 'Fastest fix', newest: 'Newest', popular: 'Most popular', context: 'Longest context', coding: 'Best at coding', uptime: 'Best uptime' };
const PAINS = { 'flaky-tests': 'Flaky tests', 'ci-speed': 'Slow CI', 'pr-review': 'PR review', 'dependency-upgrades': 'Dependency upgrades' };
const pct = (v) => (v == null ? '–' : Math.round(v * 100) + '%');
const secs = (ms) => (ms == null ? '–' : ms < 60_000 ? Math.round(ms / 1000) + 's' : Math.round(ms / 60_000) + ' min');
const perM = (p) => (p?.input == null ? null : '$' + p.input + ' / $' + p.output + ' per M tokens');

// A listing's display name, from the marketplace or the leaderboard.
export const nameOf = (s, id) => s.market.find((l) => l.id === id)?.name || s.agents.find((a) => a.id === id)?.name || id;
const mineOf = (s) => s.market.filter((l) => l.provider === 'builder' && l.owner && l.owner === s.me?.viewer?.login);

const ListingIcon = ({ l, i }) => (l.kind === 'model' ? <Icon n="chip" size={26} /> : <Fish size={36} color={COLORS[i % COLORS.length]} tail={0.15} />);

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
  const pick = 'rounded-xl border border-ink/15 bg-white/60 px-3 py-2 text-[15px] text-ink outline-none';
  const Item = (l, i) => {
    const c = l.shoal || {};
    return (
      <ItemCard key={l.id} onOpen={() => setOpen({ kind: 'listing', id: l.id })}
        icon={<ListingIcon l={l} i={i} />}
        toggle={<Tag tone={l.available ? 'ok' : undefined}>{l.available ? 'Available' : 'Unavailable'}</Tag>}
        title={l.name} by={'By ' + l.builder + ' · ' + (PROVIDERS[l.provider] || l.provider)}
        meta={<Stars r={l.rating?.average} n={l.rating?.count} />}
        tags={<>
          <Tag>{c.verified ?? 0} verified</Tag>
          {c.survivalRate != null && <Tag tone="ok">{pct(c.survivalRate)} survived</Tag>}
          {c.clawbacks > 0 && <Tag tone="bad">{c.clawbacks} clawbacks</Tag>}
          {c.costPerOutcome != null && <Tag>{money(c.costPerOutcome)} per surviving fix</Tag>}
          {perM(l.openrouter?.price) && <Tag>{perM(l.openrouter.price)}</Tag>}
          {l.openrouter?.contextLength && <Tag>{Math.round(l.openrouter.contextLength / 1000)}k context</Tag>}
        </>}
        body={l.tagline || l.description}
        footL={l.available ? (c.attempts ? c.attempts + ' attempts · score ' + c.score : 'No bounties yet') : l.unavailableReason}
        footR={<button className={ghost} onClick={(e) => { e.stopPropagation(); setOpen({ kind: 'listing', id: l.id }); }}>Details</button>} />
    );
  };
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
      <div className="flex flex-1 flex-col gap-1"><span className="text-[17px] font-semibold">Add a model from OpenRouter</span><span className="text-[15px] text-muted">Paste its id, like z-ai/glm-5.3. It competes through OPENROUTER_API_KEY.</span></div>
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
  const list = [...s.market].sort((a, b) => b.available - a.available || (b.shoal?.score ?? 0) - (a.shoal?.score ?? 0));
  return (
    <div className="flex flex-col gap-2">
      <button onClick={() => setOpen(!open)} className="flex cursor-pointer items-center justify-between text-left text-sm text-muted">
        <span>Competing: <span className="text-ink">{picked.length ? picked.map((id) => nameOf(s, id)).slice(0, 4).join(', ') + (picked.length > 4 ? ' +' + (picked.length - 4) : '') : 'nobody yet'}</span></span>
        <span className="text-accent">{open ? 'Done' : 'Change'}</span>
      </button>
      {open && <div className="flex max-h-[260px] flex-col overflow-y-auto rounded-xl border border-ink/15 bg-white/50">
        {list.map((l) => (
          <label key={l.id} className={'flex items-start gap-3 border-t border-ink/10 px-3 py-2 text-[15px] first:border-t-0 ' + (l.available ? 'cursor-pointer' : 'opacity-50')}>
            <input type="checkbox" className="mt-1 size-4 accent-[#0A7470]" disabled={!l.available} checked={picked.includes(l.id)} onChange={() => toggle(l.id)} />
            <span className="flex min-w-0 flex-col"><span>{l.name} <span className="text-sm text-muted">· {PROVIDERS[l.provider] || l.provider}{l.shoal?.verified ? ' · ' + l.shoal.verified + ' verified' : ''}</span></span>{!l.available && <span className="text-sm text-muted">Can't compete: {l.unavailableReason}</span>}</span>
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
  const stats = [['Verified', c.verified ?? 0], ['Survived', c.survived ?? 0], ['Clawbacks', c.clawbacks ?? 0], ['Survival rate', pct(c.survivalRate)], ['Uptime', pct(c.uptime)], ['Time to fix', secs(c.avgTimeToFixMs)], ['Per surviving fix', c.costPerOutcome == null ? '–' : money(c.costPerOutcome)], ['Earned', money(c.earned)]];
  return (
    <div className="flex flex-col gap-5 p-8">
      <div className="flex items-center gap-4"><div className="flex size-16 items-center justify-center rounded-2xl bg-white/70"><ListingIcon l={d} i={s.market.findIndex((l) => l.id === id)} /></div><div className="flex flex-col"><span className="text-[26px] font-semibold tracking-[-0.03em]">{d.name}</span><span className="text-muted">By {d.builder} · {PROVIDERS[d.provider] || d.provider}</span></div></div>
      <div className="flex flex-wrap items-center gap-2"><Stars r={r.average} n={r.count} /><Tag tone={d.available ? 'ok' : undefined}>{d.available ? 'Available' : "Can't compete: " + d.unavailableReason}</Tag>{(d.pains || []).map((p) => <Tag key={p}>{PAINS[p] || p}</Tag>)}{[...new Set([...(d.languages || []), ...(d.verifiedLanguages || [])])].map((x) => <Tag key={x}>{x}</Tag>)}</div>
      {(d.description || d.tagline) && <p className="m-0 whitespace-pre-line text-[15px]">{d.description || d.tagline}</p>}
      <div className="grid grid-cols-2 gap-4 border-y border-ink/10 py-4 tabular-nums sm:grid-cols-4">{stats.map(([k, v]) => <div key={k} className="flex flex-col"><span className="text-xl font-semibold">{v}</span><span className="text-sm text-muted">{k}</span></div>)}</div>
      <span className="-mt-2 text-sm text-muted">Measured by Shoal from real bounties, never self-reported.</span>
      {o && <div className="flex flex-wrap gap-2 text-sm">{perM(o.price) && <Tag>{perM(o.price)}</Tag>}{o.contextLength && <Tag>{o.contextLength.toLocaleString()} context</Tag>}{o.benchmarks?.coding != null && <Tag>Coding index {o.benchmarks.coding}</Tag>}{o.uptime1d != null && <Tag>{Math.round(o.uptime1d)}% uptime today</Tag>}{o.popularityRank && <Tag>#{o.popularityRank} on OpenRouter</Tag>}{o.releasedAt && <Tag>Released {o.releasedAt.slice(0, 10)}</Tag>}</div>}
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
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-ink/15 bg-white/50 p-4">
      <span className="text-sm font-medium text-muted">You built this agent</span>
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

export function PublishAgent({ s, act, onDone }) {
  const [f, setF] = useState({ name: '', tagline: '', description: '', webhookUrl: '', languages: '' });
  const [pains, setPains] = useState(['flaky-tests']), [secret, setSecret] = useState(null);
  const [busy, setBusy] = useState(false), [err, setErr] = useState('');
  const hook = checkWebhook(f.webhookUrl);
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
      <Label t="One-line pitch"><input className={field} value={f.tagline} onChange={set('tagline')} placeholder="Fixes races in async code" /></Label>
      <Label t="How it fixes tests"><textarea rows="4" className={field + ' resize-y'} value={f.description} onChange={set('description')} placeholder="Finds the race condition in the app code. Never touches the tests." /></Label>
      <Label t="Webhook URL (https)">
        <input className={field + (hook.problem ? ' border-bad/60' : '')} value={f.webhookUrl} onChange={set('webhookUrl')} placeholder="https://agent.example.com/shoal" inputMode="url" autoComplete="off" spellCheck="false" />
        {hook.problem ? <span className="text-sm text-bad">{hook.problem}</span> : hook.url && hook.url !== f.webhookUrl.trim() && <span className="text-sm text-muted">Will be saved as {hook.url}</span>}
      </Label>
      <div className="flex flex-col gap-1.5 text-sm text-muted">What it fixes
        <div className="flex flex-wrap gap-2">{Object.entries(PAINS).map(([id, lbl]) => <button key={id} onClick={() => setPains((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))} className={'cursor-pointer rounded-full border px-3 py-1.5 text-[15px] ' + (pains.includes(id) ? 'border-ink bg-ink text-paper' : 'border-ink/15 bg-white/60 text-ink')}>{lbl}</button>)}</div>
      </div>
      {/* Errors from the server show here, in the form, not at the top of the page. */}
      {err && <span className="text-sm text-bad">{err}</span>}
      <button className={primary} disabled={busy || !f.name.trim() || !hook.url || !!hook.problem || !pains.length} onClick={async () => {
        setBusy(true); setErr('');
        try {
          const r = await api.publishListing({ ...f, webhookUrl: hook.url, pains, languages: f.languages.split(',').map((x) => x.trim()).filter(Boolean) });
          setSecret(r.signingSecret);
          await s.refresh?.();
        } catch (e) { setErr(e.message); } finally { setBusy(false); }
      }}>{busy ? 'Publishing…' : 'Publish'}</button>
      <span className="text-sm text-muted">Agents can never edit tests, CI config or package manifests, and only see code from teams that pick them.</span>
    </div>
  );
}
