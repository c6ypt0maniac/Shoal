// Bids: what each competitor may spend of the team's tokens on one bounty.
// The team pays every competitor's tokens, so the race should be cheap as
// well as good:
//   1. Before the race each competitor has a bid (bidFor):
//        Shoal-run (models, built-in and prompt agents, OpenRouter): Shoal's
//          estimate of the one call it makes, its prompt plus the most it may
//          write, at the model's prices. "estimate".
//        uploaded code (bundle, image): the builder's maxSpend on the listing,
//          enforced in the sandbox: a model call that could go over it isn't
//          made (sandbox.js). "cap".
//        webhooks: $0 to the team. They run on the builder's own servers and
//          keys, so there's nothing of the team's to cap. "own".
//   2. Only the best-value bids race (admit): bid divided by track record,
//      so a reliable agent's higher bid can beat a cheap unknown's.
//      SHOAL_RACE_SIZE (default 3), or the bounty's raceSize, sets how many.
//   3. Fixes must pass verification and both judges. Of those, the cheapest
//      wins; within PRICE_BAND of the cheapest, the better record (winnerOrder).
import { personaModel, getAgent, FIX_SYSTEM } from "./agents.js";
import { MODELS } from "./trials.js";
import { estimate } from "./spend.js";
import { envLimit } from "./limit.js";

export const DEFAULT_MAX_SPEND = 1;
export const MIN_SPEND = 0.05, MAX_SPEND = 50;
// A new agent counts as this good when weighing its bid, so it can't win a
// place on a lowball alone.
const RECORD_FLOOR = 0.25;
// Fixes within 20% (or a cent) of the cheapest are a close call.
const PRICE_BAND = 0.2, PRICE_FLOOR = 0.01;

const round = (v) => Math.round(v * 10_000) / 10_000;
const outFor = (model) => (MODELS[model]?.provider === "openai" ? MODELS[model].maxOutput ?? 32_000 : 16_000);

// A builder's maxSpend: dollars of the team's tokens per bounty.
export function cleanMaxSpend(v) {
  if (v == null || v === "") return DEFAULT_MAX_SPEND;
  const n = Number(v);
  if (!(n >= MIN_SPEND && n <= MAX_SPEND)) throw Object.assign(new Error(`maxSpend must be between $${MIN_SPEND} and $${MAX_SPEND}`), { status: 400 });
  return round(n);
}

// -> { amount, kind: "estimate" | "cap" | "own" }. listing: a marketplace
// listing from state (null for models and built-in agents). prompt: the fix
// prompt for this bug (fixPrompt), shared by everyone Shoal runs.
export function bidFor(id, listing, prompt) {
  const call = (model, system = FIX_SYSTEM) => ({ amount: round(estimate(model, system + prompt, outFor(model))), kind: "estimate" });
  if (MODELS[id]) return call(id);
  if (getAgent(id)) return call(personaModel());
  if (listing?.provider === "openrouter") {
    const p = listing.openrouter?.price;
    const out = Math.min(32_000, listing.openrouter?.maxOutput ?? 32_000);
    const tokensIn = Math.ceil((FIX_SYSTEM + prompt).length / 4);
    return { amount: p?.input == null || p.output == null ? null : round((tokensIn * p.input + out * p.output) / 1e6), kind: "estimate" };
  }
  const runtime = listing?.runtime ?? "webhook";
  if (runtime === "prompt") return call(listing.prompt.model, listing.prompt.instructions + FIX_SYSTEM);
  if (runtime === "bundle" || runtime === "image") return { amount: listing.maxSpend ?? DEFAULT_MAX_SPEND, kind: "cap" };
  return { amount: 0, kind: "own" };
}

// Who races: the best value first, at most `size`. bids: [{ agentId, amount }]
// (amount null: no price known, counted as the priciest). recordOf(id) -> the
// 0-1 rank score; byRecord breaks ties. Marks each bid admitted or not, with
// its value, and returns the admitted ids.
export function admit(bids, size, recordOf, byRecord) {
  const priciest = Math.max(0, ...bids.map((b) => b.amount ?? 0));
  for (const b of bids) b.value = round((b.amount ?? priciest * 2 + 1) / Math.max(recordOf(b.agentId), RECORD_FLOOR));
  const order = [...bids].sort((a, b) => a.value - b.value || byRecord(a.agentId, b.agentId));
  order.forEach((b, i) => (b.admitted = i < size));
  return order.filter((b) => b.admitted).map((b) => b.agentId);
}

export const raceSize = (bounty) => bounty.raceSize ?? envLimit("SHOAL_RACE_SIZE", 3);

// A bounty's raceSize: 1-10 competitors, or null for the default.
export function cleanRaceSize(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 10) throw Object.assign(new Error("raceSize must be a whole number from 1 to 10"), { status: 400 });
  return n;
}

// The order verified fixes are judged in; the first both judges pass wins.
// Cheapest first, but fixes within PRICE_BAND of the cheapest go by record
// (byRecord), then the smaller change.
export function winnerOrder(verified, byRecord) {
  if (!verified.length) return [];
  const cheapest = Math.min(...verified.map((v) => v.spent ?? 0));
  const limit = Math.max(cheapest * (1 + PRICE_BAND), cheapest + PRICE_FLOOR);
  const close = verified.filter((v) => (v.spent ?? 0) <= limit);
  const better = (a, b) => byRecord(a.agentId, b.agentId) || a.linesChanged - b.linesChanged;
  return [...close.sort(better), ...verified.filter((v) => !close.includes(v)).sort((a, b) => (a.spent ?? 0) - (b.spent ?? 0) || better(a, b))];
}

// Why the winner won, for the team.
export function winReason(winner, verified) {
  const money = `$${(winner.spent ?? 0).toFixed(2)}`;
  const cheaper = verified.filter((v) => v !== winner && (v.spent ?? 0) < (winner.spent ?? 0));
  if (verified.length === 1) return `the only fix that passed, at ${money} in tokens`;
  if (!cheaper.length) return `the cheapest fix that passed, at ${money} in tokens`;
  return cheaper.every((v) => v.judged)
    ? `${money} in tokens; the cheaper fixes failed the judges`
    : `${money} in tokens, within ${Math.round(PRICE_BAND * 100)}% of the cheapest, with a better track record`;
}
