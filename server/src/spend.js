// What each bug (a flaky test) costs during sealed API trials, split into
// fix attempts (diagnoses and fixes), the challenge-test writer, the judges
// and sandbox compute. Tokens run on the team's own keys (user-keys.js), so
// they're the team's cost (tokensOn); sandbox compute is Shoal's
// (shoalCostOn), and the unlock price is built on that (pricing.js).
// A token cap per bug (SHOAL_TRIAL_CAP, default $2.00) is checked BEFORE each
// call: a call whose estimated cost would take the bug over the cap isn't
// made. The owner sees Shoal's cost against revenue per bug (marginView).
import { state } from "./store.js";
import { tokenCost } from "./trials.js";
import { weeklyCost } from "./scanner.js";

// The token cap scales with what the bug costs the team: 5% of a week of its
// dev-hours, between $2 and $10. At $2 a big repo's context could stop the
// ladder before step 3 (Opus, Astra) or before their fix; even at $10 it's a
// small share of what the test wastes. SHOAL_TRIAL_CAP sets it flat. Read
// each time, so a check script can lower it mid-run.
export const trialCap = (painId) => {
  if (Number(process.env.SHOAL_TRIAL_CAP) > 0) return Number(process.env.SHOAL_TRIAL_CAP);
  const pain = painId && state.pains.find((p) => p.id === painId);
  return Math.min(10, Math.max(2, 0.05 * weeklyCost(pain)));
};
// A sandbox slot: $0.10 per hour (the margin simulation's assumption).
const COMPUTE_PER_SECOND = 0.1 / 3600;
const KINDS = ["fix", "writer", "judges", "compute"];
const TOKENS = ["fix", "writer", "judges"];

const entry = (painId) => (state.trialSpend[painId] ??= { fix: 0, writer: 0, judges: 0, compute: 0, revenue: 0, testFile: null });

export function addSpend(painId, kind, dollars) {
  if (!painId || !(dollars > 0)) return;
  const e = entry(painId);
  e[kind] = (e[kind] ?? 0) + dollars;
}

export const addCompute = (painId, seconds) => addSpend(painId, "compute", seconds * COMPUTE_PER_SECOND);
const sum = (painId, kinds) => kinds.reduce((s, k) => s + (state.trialSpend[painId]?.[k] ?? 0), 0);
// Tokens on the team's keys, and Shoal's own sandbox compute.
export const tokensOn = (painId) => sum(painId, TOKENS);
export const shoalCostOn = (painId) => sum(painId, ["compute"]);

// A call's cost before making it: the prompt's tokens (about 4 characters
// each) in, `outTokens` out, at the model's price.
export const estimate = (model, prompt, outTokens = 4_000) => tokenCost(model, { input_tokens: Math.ceil(String(prompt).length / 4), output_tokens: outTokens });

// Whether a call costing about `dollars` still fits under this bug's token cap.
export const fitsCap = (painId, dollars) => !painId || tokensOn(painId) + dollars <= trialCap(painId);

export function recordRevenue(painId, dollars, testFile) {
  const e = entry(painId);
  e.revenue += dollars;
  if (testFile) e.testFile = testFile;
}

// For the owner: per bug, the team's tokens, what Shoal spent and earned.
export function marginView() {
  const rows = Object.entries(state.trialSpend).map(([painId, e]) => {
    const tokens = TOKENS.reduce((s, k) => s + (e[k] ?? 0), 0);
    const spend = e.compute ?? 0;
    return { painId, testFile: e.testFile, cap: trialCap(painId), ...Object.fromEntries(KINDS.map((k) => [k, round(e[k] ?? 0)])), tokens: round(tokens), spend: round(spend), revenue: round(e.revenue), margin: round(e.revenue - spend) };
  });
  const total = (k) => round(rows.reduce((s, r) => s + r[k], 0));
  return { cap: trialCap(), bugs: rows.length, tokens: total("tokens"), spend: total("spend"), revenue: total("revenue"), margin: total("margin"), rows };
}

const round = (n) => Math.round(n * 10_000) / 10_000;
