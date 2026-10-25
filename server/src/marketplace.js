// Marketplace catalog: every agent and model a team can pick to compete on a
// bounty, in one list. Each listing carries:
//   shoal       the scorecard Shoal measured itself (bounties.js): verified,
//               survived, clawbacks, cost per surviving fix, time to a
//               verified fix, uptime (attempts that delivered a fix), usage
//   rating      verified-buyer stars and aspect ratings (reviews.js)
//   openrouter  for models, OpenRouter's public numbers on top: price,
//               context, release date, benchmarks, uptime, popularity
// The default order ("best") is Shoal's verified record only; stars,
// price, popularity and the rest are separate sorts.
//
// Listings come from four places:
//   - Shoal's built-in agents (agents.js)
//   - Shoal's models (trials.js: Claude, OpenAI)
//   - models imported from OpenRouter by id (importOpenRouterModel); any of
//     OpenRouter's models can be imported, which is how they all get added
//   - agents builders publish with a webhook (publishAgent; competitors.js
//     has the webhook protocol)
// Imported and published listings are kept in state.listings (persist.js).
import { AGENTS, mockNow, modelUnavailable } from "./agents.js";
import { MODELS, providerLabel } from "./trials.js";
import { scorecard } from "./bounties.js";
import { ratingFor } from "./reviews.js";
import { emit } from "./events.js";
import { state } from "./store.js";
import { encrypt, newSecret } from "./secrets.js";

const OPENROUTER = "https://openrouter.ai/api/v1";
const CATALOG_TTL_MS = 60 * 60_000;
// What a listing can fix. Flaky tests are the only bounties so far.
export const PAINS = ["flaky-tests", "ci-speed", "pr-review", "dependency-upgrades"];

// --- OpenRouter -----------------------------------------------------------------

let catalog = null; // { at, models: Map(id -> model) }

// OpenRouter's public model list (no key needed), cached for an hour. Its
// order is most popular first, which gives each model a popularity rank.
async function openRouterCatalog() {
  if (catalog && Date.now() - catalog.at < CATALOG_TTL_MS) return catalog.models;
  const res = await fetch(`${OPENROUTER}/models?sort=most-popular`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw httpError(502, `OpenRouter's model list didn't load (HTTP ${res.status})`);
  const { data } = await res.json();
  catalog = { at: Date.now(), models: new Map(data.map((m, i) => [m.id, { ...m, popularityRank: i + 1 }])) };
  return catalog.models;
}

// Live uptime, latency and throughput, from the model's best endpoint.
async function openRouterLive(id) {
  const res = await fetch(`${OPENROUTER}/models/${id}/endpoints`, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
  if (!res?.ok) return {};
  const endpoints = (await res.json()).data?.endpoints ?? [];
  const best = endpoints.reduce((a, e) => ((e.uptime_last_1d ?? -1) > (a?.uptime_last_1d ?? -1) ? e : a), null);
  return {
    providers: endpoints.length,
    uptime1d: best?.uptime_last_1d ?? null,
    latencyMs: best?.latency_last_30m ?? null,
    throughputTps: best?.throughput_last_30m ?? null,
  };
}

const perMillion = (v) => (v == null ? null : Math.round(Number(v) * 1e6 * 1e4) / 1e4);

// OpenRouter's numbers for one model, in the shape listings use.
function openRouterMetrics(m, live) {
  const params = m.supported_parameters ?? [];
  return {
    id: m.id,
    popularityRank: m.popularityRank,
    contextLength: m.context_length ?? null,
    maxOutput: m.top_provider?.max_completion_tokens ?? null,
    releasedAt: m.created ? new Date(m.created * 1000).toISOString() : null,
    knowledgeCutoff: m.knowledge_cutoff ?? null,
    price: { input: perMillion(m.pricing?.prompt), output: perMillion(m.pricing?.completion), cachedInput: perMillion(m.pricing?.input_cache_read) },
    supports: { tools: params.includes("tools"), structuredOutputs: params.includes("structured_outputs"), reasoning: params.includes("reasoning") },
    benchmarks: {
      intelligence: m.benchmarks?.artificial_analysis?.intelligence_index ?? null,
      coding: m.benchmarks?.artificial_analysis?.coding_index ?? null,
      agentic: m.benchmarks?.artificial_analysis?.agentic_index ?? null,
    },
    ...live,
    fetchedAt: new Date().toISOString(),
  };
}

// Adds an OpenRouter model to the marketplace, e.g. "z-ai/glm-5.3". Only
// text-only models with structured output can return a patch (image and
// audio generators are left out).
export async function importOpenRouterModel(openRouterId, { by = null } = {}) {
  const ref = String(openRouterId ?? "").trim();
  const id = `openrouter:${ref}`;
  if (allListings().some((l) => l.id === id)) throw httpError(409, `${ref} is already in the marketplace`);
  const m = (await openRouterCatalog()).get(ref);
  if (!m) throw httpError(404, `OpenRouter has no model "${ref}". Ids look like z-ai/glm-5.3.`);
  const outputs = m.architecture?.output_modalities ?? [];
  if (outputs.length !== 1 || outputs[0] !== "text") throw httpError(400, `${ref} outputs ${outputs.join(" + ") || "nothing"}, not just text, so it isn't a coding model`);
  if (!(m.supported_parameters ?? []).includes("structured_outputs")) throw httpError(400, `${ref} doesn't support structured output, so Shoal can't read a patch from it`);
  const listing = {
    id,
    kind: "model",
    provider: "openrouter",
    builder: m.id.split("/")[0],
    name: m.name.replace(/^[^:]+:\s*/, ""),
    tagline: (m.description ?? "").split(/(?<=\.)\s/)[0].slice(0, 160),
    description: m.description ?? "",
    pains: ["flaky-tests"],
    languages: [],
    openrouter: openRouterMetrics(m, await openRouterLive(ref)),
    addedAt: new Date().toISOString(),
    addedBy: by,
  };
  state.listings.push(listing);
  emit("marketplace.added", { listingId: id, message: `Added ${listing.name} (${ref}) to the marketplace from OpenRouter` });
  return entry(listing);
}

// Refreshes OpenRouter's numbers on every imported listing (and attaches
// them to Shoal's own models that OpenRouter also serves).
export async function refreshOpenRouter() {
  catalog = null;
  const models = await openRouterCatalog();
  for (const l of state.listings) {
    const m = l.provider === "openrouter" && models.get(l.openrouter?.id);
    if (m) l.openrouter = openRouterMetrics(m, await openRouterLive(m.id));
  }
  const next = {};
  for (const id of Object.keys(MODELS)) {
    const m = models.get(openRouterIdFor(id));
    if (m) next[id] = openRouterMetrics(m, {});
  }
  modelMetrics = next;
}
let modelMetrics = {};

// Shoal's model ids -> OpenRouter's: claude-sonnet-5-5 -> anthropic/claude-sonnet-5.5.
const openRouterIdFor = (id) => (MODELS[id]?.provider === "anthropic" ? `anthropic/${id.replace(/-(\d+)-(\d+)$/, "-$1.$2")}` : `openai/${id}`);

// OpenRouter's numbers go stale (uptime, popularity, prices): refresh at
// startup and every 6 hours. A failed refresh keeps the last numbers.
const refreshQuietly = () => refreshOpenRouter().catch((err) => emit("marketplace.error", { message: `OpenRouter refresh failed: ${err.message}` }));
setTimeout(refreshQuietly, 0).unref?.();
setInterval(refreshQuietly, 6 * 60 * 60_000).unref();

// --- Builder agents -------------------------------------------------------------------

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

// Webhooks must be https; plain http only to this machine, for local testing.
function cleanWebhook(raw) {
  let url;
  try {
    url = new URL(String(raw ?? ""));
  } catch {
    throw httpError(400, "webhookUrl must be a full URL, like https://agent.example.com/shoal");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local && !process.env.VERCEL)) throw httpError(400, "webhookUrl must use https");
  if (url.username || url.password) throw httpError(400, "webhookUrl can't contain a username or password");
  return url.href;
}

const cleanList = (v, allowed) => {
  const list = [...new Set((Array.isArray(v) ? v : []).map((x) => String(x).trim().toLowerCase()).filter(Boolean))].slice(0, 20);
  const bad = allowed ? list.filter((x) => !allowed.includes(x)) : [];
  if (bad.length) throw httpError(400, `Unknown ${bad.join(", ")}; pick from ${allowed.join(", ")}`);
  return list;
};

// A builder publishes an agent. Returns its signing secret once: Shoal signs
// every webhook request with it, and won't show it again (rotate to get a
// new one).
export function publishAgent({ name, tagline, description, webhookUrl, pains, languages }, user) {
  if (!user) throw httpError(401, "Sign in with GitHub to publish an agent");
  const title = String(name ?? "").trim().slice(0, 60);
  if (!title) throw httpError(400, "Give the agent a name");
  const id = `agent:${user.login}/${slug(title)}`;
  if (allListings().some((l) => l.id === id)) throw httpError(409, `You already have an agent called ${title}`);
  const secret = newSecret();
  const listing = {
    id,
    kind: "agent",
    provider: "builder",
    owner: user.login,
    builder: `@${user.login}`,
    name: title,
    tagline: String(tagline ?? "").trim().slice(0, 160),
    description: String(description ?? "").trim().slice(0, 4000),
    pains: cleanList(pains ?? ["flaky-tests"], PAINS),
    languages: cleanList(languages),
    webhookUrl: cleanWebhook(webhookUrl),
    secretSealed: encrypt(secret),
    addedAt: new Date().toISOString(),
  };
  state.listings.push(listing);
  emit("marketplace.published", { listingId: id, message: `@${user.login} published ${title} to the marketplace` });
  return { ...entry(listing, user), signingSecret: secret };
}

export function updateAgent(id, patch, user) {
  const listing = ownListing(id, user);
  if (patch.name != null) listing.name = String(patch.name).trim().slice(0, 60) || listing.name;
  if (patch.tagline != null) listing.tagline = String(patch.tagline).trim().slice(0, 160);
  if (patch.description != null) listing.description = String(patch.description).trim().slice(0, 4000);
  if (patch.pains != null) listing.pains = cleanList(patch.pains, PAINS);
  if (patch.languages != null) listing.languages = cleanList(patch.languages);
  if (patch.webhookUrl != null) listing.webhookUrl = cleanWebhook(patch.webhookUrl);
  return entry(listing, user);
}

export function rotateSecret(id, user) {
  const listing = ownListing(id, user);
  const secret = newSecret();
  listing.secretSealed = encrypt(secret);
  return { id, signingSecret: secret };
}

// Builders remove their own agents; an imported model can be removed by
// whoever imported it (or anyone, if it was imported without signing in).
export function removeListing(id, user) {
  const listing = state.listings.find((l) => l.id === id);
  if (!listing) throw httpError(404, `No published or imported listing ${id}`);
  const owner = listing.owner ?? listing.addedBy;
  if (owner && owner !== user?.login) throw httpError(403, "Only whoever added this listing can remove it");
  state.listings = state.listings.filter((l) => l.id !== id);
}

function ownListing(id, user) {
  const listing = state.listings.find((l) => l.id === id && l.provider === "builder");
  if (!listing) throw httpError(404, `No published agent ${id}`);
  if (listing.owner !== user?.login) throw httpError(403, "Only the agent's builder can change it");
  return listing;
}

// --- Catalog ----------------------------------------------------------------------

// Every listing: built-in agents, Shoal's models, imported and published.
function allListings() {
  return [
    ...AGENTS.map((a) => ({ id: a.id, kind: "agent", provider: "shoal", builder: a.builder, name: a.name, tagline: a.tagline, pains: ["flaky-tests"], languages: [] })),
    ...Object.entries(MODELS).map(([id, m]) => ({ id, kind: "model", provider: m.provider, builder: providerLabel(id), name: m.name, tagline: null, pains: ["flaky-tests"], languages: [], openrouter: modelMetrics[id] ?? null })),
    ...state.listings,
  ];
}

export const listingExists = (id) => allListings().some((l) => l.id === id);
export const ownerOf = (id) => state.listings.find((l) => l.id === id)?.owner ?? null;
export const nameFor = (id) => allListings().find((l) => l.id === id)?.name ?? id;

// Why a listing can't compete right now, or null.
function unavailable(l) {
  if (l.provider === "shoal") return mockNow() || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY ? null : "needs ANTHROPIC_API_KEY or OPENAI_API_KEY";
  if (MODELS[l.id]) return modelUnavailable(l.id);
  if (l.provider === "openrouter") return mockNow() || process.env.OPENROUTER_API_KEY ? null : "needs OPENROUTER_API_KEY";
  if (l.provider === "builder") return l.webhookUrl ? null : "has no webhook";
  return "unknown kind of listing";
}

// Checks a team's picks for a bounty: they must exist and be able to run.
export function checkCompetitors(ids) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(String))];
  if (!list.length) throw httpError(400, "Pick at least one agent or model to compete");
  if (list.length > 12) throw httpError(400, "Pick at most 12 competitors per bounty");
  for (const id of list) {
    const l = allListings().find((x) => x.id === id);
    if (!l) throw httpError(404, `No marketplace listing ${id}`);
    const why = unavailable(l);
    if (why) throw httpError(400, `${l.name} can't compete yet: it ${why}`);
  }
  return list;
}

// Languages a listing has verified fixes in, from the bounties it entered.
function verifiedLanguages(id) {
  const langs = state.bounties.filter((b) => b.language && b.attempts?.some((a) => a.agentId === id && a.passed)).map((b) => b.language);
  return [...new Set(langs)];
}

// What the public sees of a listing. Secrets never leave the server; the
// webhook URL only to its builder.
function entry(l, user = null) {
  const { secretSealed, webhookUrl, ...pub } = l;
  const why = unavailable(l);
  return {
    ...pub,
    ...(l.owner && l.owner === user?.login ? { webhookUrl } : {}),
    verifiedLanguages: verifiedLanguages(l.id),
    shoal: scorecard(l.id),
    rating: ratingFor(l.id),
    available: !why,
    unavailableReason: why,
  };
}

// Cost per surviving fix when Shoal has measured one, else the list price
// (input + output per million tokens) for models.
const price = (l) => l.shoal.costPerOutcome ?? (l.openrouter?.price?.input != null ? l.openrouter.price.input + l.openrouter.price.output : listPrice(l.id));
const listPrice = (id) => (MODELS[id] ? MODELS[id].input + MODELS[id].output : null);
const last = (v) => v ?? Infinity;
const first = (v) => v ?? -Infinity;

const SORTS = {
  best: (a, b) => b.shoal.score - a.shoal.score || b.shoal.survived - a.shoal.survived,
  top_rated: (a, b) => first(b.rating.average) - first(a.rating.average) || b.rating.count - a.rating.count,
  cheapest: (a, b) => last(price(a)) - last(price(b)),
  most_used: (a, b) => b.shoal.attempts - a.shoal.attempts,
  fastest: (a, b) => last(a.shoal.avgTimeToFixMs) - last(b.shoal.avgTimeToFixMs),
  newest: (a, b) => (b.openrouter?.releasedAt ?? b.addedAt ?? "").localeCompare(a.openrouter?.releasedAt ?? a.addedAt ?? ""),
  popular: (a, b) => last(a.openrouter?.popularityRank) - last(b.openrouter?.popularityRank),
  context: (a, b) => first(b.openrouter?.contextLength) - first(a.openrouter?.contextLength),
  coding: (a, b) => first(b.openrouter?.benchmarks?.coding) - first(a.openrouter?.benchmarks?.coding),
  uptime: (a, b) => first(b.openrouter?.uptime1d ?? (b.shoal.uptime == null ? null : b.shoal.uptime * 100)) - first(a.openrouter?.uptime1d ?? (a.shoal.uptime == null ? null : a.shoal.uptime * 100)),
};

const num = (v, name) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw httpError(400, `${name} must be a number`);
  return n;
};
const yes = (v) => v === true || v === "true" || v === "1";

// The marketplace, filtered, sorted and paged. Filters (all optional):
//   type agent|model, provider shoal|anthropic|openai|openrouter|builder, q,
//   pain, language, minSurvival (0-1), maxClawback (0-1), minVerified,
//   maxCost ($), minStars, hasReviews, available, minContext, tools,
//   structuredOutputs, releasedAfter (YYYY-MM-DD)
export function marketplace(query = {}, user = null) {
  const sort = query.sort ?? "best";
  if (!SORTS[sort]) throw httpError(400, `sort must be one of ${Object.keys(SORTS).join(", ")}`);
  const f = {
    minSurvival: num(query.minSurvival, "minSurvival"),
    maxClawback: num(query.maxClawback, "maxClawback"),
    minVerified: num(query.minVerified, "minVerified"),
    maxCost: num(query.maxCost, "maxCost"),
    minStars: num(query.minStars, "minStars"),
    minContext: num(query.minContext, "minContext"),
  };
  const text = String(query.q ?? "").toLowerCase();
  const language = String(query.language ?? "").toLowerCase();
  const releasedAfter = query.releasedAfter ? Date.parse(query.releasedAfter) : null;
  if (releasedAfter !== null && Number.isNaN(releasedAfter)) throw httpError(400, "releasedAfter must be a date like 2026-01-01");

  const items = allListings()
    .filter((l) => (!query.type || l.kind === query.type) && (!query.provider || l.provider === query.provider))
    .filter((l) => !text || `${l.id} ${l.name} ${l.builder} ${l.tagline ?? ""} ${l.description ?? ""}`.toLowerCase().includes(text))
    .filter((l) => !query.pain || (l.pains ?? []).includes(query.pain))
    .map((l) => entry(l, user))
    .filter((l) => !language || [...l.languages, ...l.verifiedLanguages].some((x) => x.toLowerCase() === language))
    .filter((l) => f.minSurvival == null || (l.shoal.survivalRate ?? -1) >= f.minSurvival)
    .filter((l) => f.maxClawback == null || (l.shoal.clawbackRate != null && l.shoal.clawbackRate <= f.maxClawback))
    .filter((l) => f.minVerified == null || l.shoal.verified >= f.minVerified)
    .filter((l) => f.maxCost == null || (price(l) != null && price(l) <= f.maxCost))
    .filter((l) => f.minStars == null || (l.rating.average ?? 0) >= f.minStars)
    .filter((l) => !yes(query.hasReviews) || l.rating.count > 0)
    .filter((l) => !yes(query.available) || l.available)
    .filter((l) => f.minContext == null || (l.openrouter?.contextLength ?? 0) >= f.minContext)
    .filter((l) => !yes(query.tools) || l.openrouter?.supports?.tools)
    .filter((l) => !yes(query.structuredOutputs) || l.openrouter?.supports?.structuredOutputs)
    .filter((l) => releasedAfter === null || Date.parse(l.openrouter?.releasedAt ?? 0) >= releasedAfter)
    .sort(SORTS[sort]);

  const limit = Math.min(200, Math.max(1, num(query.limit, "limit") ?? 50));
  const offset = Math.max(0, num(query.offset, "offset") ?? 0);
  return { total: items.length, offset, limit, sort, sorts: Object.keys(SORTS), items: items.slice(offset, offset + limit) };
}

export function listing(id, user = null) {
  const l = allListings().find((x) => x.id === id);
  if (!l) throw httpError(404, `No marketplace listing ${id}`);
  return entry(l, user);
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
