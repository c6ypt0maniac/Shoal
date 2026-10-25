// What Shoal spends on each bug (a flaky test) during sealed API trials:
// every token is on Shoal's keys, so every call is counted here, split into
// fix attempts, the challenge-test writer, the judges and sandbox compute.
// A spend cap per bug (SHOAL_TRIAL_CAP, default $2.00) is checked BEFORE each
// call: a call whose estimated cost would take the bug over the cap isn't
// made. The owner sees spend against revenue per bug (marginView); teams
// never see what Shoal spent.
import { state } from "./store.js";
import { tokenCost } from "./trials.js";

export const TRIAL_CAP = Number(process.env.SHOAL_TRIAL_CAP) > 0 ? Number(process.env.SHOAL_TRIAL_CAP) : 2.0;
// A sandbox slot: $0.10 per hour (the margin simulation's assumption).
const COMPUTE_PER_SECOND = 0.1 / 3600;
const KINDS = ["fix", "writer", "judges", "compute"];

const entry = (painId) => (state.trialSpend[painId] ??= { fix: 0, writer: 0, judges: 0, compute: 0, revenue: 0, testFile: null });

export function addSpend(painId, kind, dollars) {
  if (!painId || !(dollars > 0)) return;
  const e = entry(painId);
  e[kind] = (e[kind] ?? 0) + dollars;
}

export const addCompute = (painId, seconds) => addSpend(painId, "compute", seconds * COMPUTE_PER_SECOND);
export const spentOn = (painId) => KINDS.reduce((s, k) => s + (state.trialSpend[painId]?.[k] ?? 0), 0);

// A call's cost before making it: the prompt's tokens (about 4 characters
// each) in, `outTokens` out, at the model's price.
export const estimate = (model, prompt, outTokens = 4_000) => tokenCost(model, { input_tokens: Math.ceil(String(prompt).length / 4), output_tokens: outTokens });

// Whether a call costing about `dollars` still fits under this bug's cap.
export const fitsCap = (painId, dollars) => !painId || spentOn(painId) + dollars <= TRIAL_CAP;

export function recordRevenue(painId, dollars, testFile) {
  const e = entry(painId);
  e.revenue += dollars;
  if (testFile) e.testFile = testFile;
}

// For the owner: per bug, what Shoal spent and earned.
export function marginView() {
  const rows = Object.entries(state.trialSpend).map(([painId, e]) => {
    const spend = KINDS.reduce((s, k) => s + (e[k] ?? 0), 0);
    return { painId, testFile: e.testFile, ...Object.fromEntries(KINDS.map((k) => [k, round(e[k] ?? 0)])), spend: round(spend), revenue: round(e.revenue), margin: round(e.revenue - spend) };
  });
  const total = (k) => round(rows.reduce((s, r) => s + r[k], 0));
  return { cap: TRIAL_CAP, bugs: rows.length, spend: total("spend"), revenue: total("revenue"), margin: total("margin"), rows };
}

const round = (n) => Math.round(n * 10_000) / 10_000;
