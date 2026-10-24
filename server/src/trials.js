// Trials: the free, limited-control round. The team's own Claude connects to
// Shoal over MCP (see mcp.js), tries fixes with several models, and submits
// each one here tagged with the model that wrote it. Shoal runs every trial
// patch through the same verifier as paid bounties, but never applies it.
// The scoreboard then shows which model to approve for the paid API run.
import { verify } from "./verifier.js";
import { emit } from "./events.js";
import { state, newId } from "./store.js";
import { readRepoFile } from "./repo.js";

// Models a trial can be tagged with: the ones Shoal can later run through
// the API. Prices are $ per million tokens (input, output).
export const MODELS = {
  "claude-haiku-5-5": { name: "Haiku 5.5", input: 0.1, output: 0.5 },
  "claude-sonnet-5-5": { name: "Sonnet 5.5", input: 2, output: 10 },
  "claude-opus-5-5": { name: "Opus 5.5", input: 4, output: 20 },
  "claude-fable-5-1": { name: "Fable 5.1", input: 10, output: 50 },
};
export const MODEL_IDS = Object.keys(MODELS);

export async function submitTrial({ painId, model, summary, files }) {
  const pain = state.pains.find((p) => p.id === painId);
  if (!pain) throw httpError(404, `Unknown problem ${painId}. Call list_problems for valid ids.`);
  if (pain.healthy) throw httpError(400, `${pain.testFile} isn't flaky; nothing to fix`);
  if (!MODELS[model]) throw httpError(400, `model must be one of ${MODEL_IDS.join(", ")}`);
  if (!files?.length) throw httpError(400, "Submit at least one changed file");

  const trial = {
    id: newId("trial"),
    painId,
    testFile: pain.testFile,
    model,
    summary: String(summary ?? "").slice(0, 500),
    files,
    linesChanged: await linesChanged(files),
    status: "verifying",
    reason: null,
    runs: [],
    submittedAt: new Date().toISOString(),
  };
  state.trials.unshift(trial);
  emit("trial.submitted", {
    trialId: trial.id,
    model,
    message: `Trial: ${MODELS[model].name} submitted a fix for ${pain.testFile} (${trial.linesChanged} lines changed)`,
  });

  const stableTestFiles = state.pains.filter((p) => p.healthy).map((p) => p.testFile);
  const result = await verify({ bountyId: trial.id, agentId: MODELS[model].name, testFile: pain.testFile, files, stableTestFiles });
  trial.status = result.passed ? "passed" : "failed";
  trial.reason = result.reason ?? null;
  trial.runs = result.runs.map((r) => r.passed);
  emit(result.passed ? "trial.passed" : "trial.failed", {
    trialId: trial.id,
    model,
    message: `Trial ${result.passed ? "PASSED" : "failed"}: ${MODELS[model].name} on ${pain.testFile}${result.passed ? "" : ` (${result.reason})`}`,
  });
  return { ...trial, failureLog: result.failureLog ?? null };
}

// --- Optimizer ---------------------------------------------------------------
// Picks the model with the best quality per dollar, so Opus doesn't win just
// because it's the biggest. Only verified trials count. Each model gets a
// quality score (0-100) and an expected API cost per fix, measured from the
// tokens it used in the trial. The pick is the cheapest model whose quality is
// within QUALITY_MARGIN points of the best; a pricier model has to be clearly
// better to win.

const QUALITY_MARGIN = 5;
// Typical tokens for one fix, used until a trial run measures the real ones
// (e.g. trials submitted from someone's own Claude Code session).
const DEFAULT_TOKENS = { input_tokens: 25_000, output_tokens: 3_000 };

// $ for one API call's usage. Cache writes bill at 1.25x input, reads at 0.1x.
export function tokenCost(model, usage) {
  const price = MODELS[model] ?? MODELS["claude-opus-5-5"];
  const input =
    (usage.input_tokens ?? 0) + 1.25 * (usage.cache_creation_input_tokens ?? 0) + 0.1 * (usage.cache_read_input_tokens ?? 0);
  return (input * price.input + (usage.output_tokens ?? 0) * price.output) / 1e6;
}

// Expected API cost of one fix with this model: measured in the latest trial
// run when there is one, otherwise a typical-size estimate.
export function costPerFix(model) {
  return state.modelCost[model]?.perFix ?? tokenCost(model, DEFAULT_TOKENS);
}

// Called by the trial runner with what each model's subagents actually spent.
export function recordModelCosts(spentByModel, problemCount) {
  for (const [model, spent] of Object.entries(spentByModel)) {
    if (spent > 0) state.modelCost[model] = { perFix: spent / Math.max(1, problemCount), measuredAt: new Date().toISOString() };
  }
}

// Quality of each model's best verified fix for one problem:
//   60 for a verified fix, + up to 20 for a small change (relative to the
//   smallest verified fix), + 20 if its first attempt passed.
function optionsFor(painId) {
  const tries = state.trials.filter((t) => t.painId === painId && t.status !== "verifying");
  const passing = tries.filter((t) => t.status === "passed");
  if (!passing.length) return [];
  const smallest = Math.max(1, Math.min(...passing.map((t) => t.linesChanged)));
  const best = {};
  for (const t of passing) if (!best[t.model] || t.linesChanged < best[t.model].linesChanged) best[t.model] = t;
  return Object.values(best).map((t) => {
    const first = tries.filter((x) => x.model === t.model).sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))[0];
    const firstTry = first.status === "passed";
    return {
      trial: t,
      model: t.model,
      name: MODELS[t.model].name,
      firstTry,
      quality: Math.round(60 + 20 * (smallest / Math.max(1, t.linesChanged)) + (firstTry ? 20 : 0)),
      cost: costPerFix(t.model),
    };
  });
}

// Cheapest option within QUALITY_MARGIN of the best quality, plus why.
function cheapestNearTop(options) {
  if (!options.length) return null;
  const top = Math.max(...options.map((o) => o.quality));
  const pick = options
    .filter((o) => o.quality >= top - QUALITY_MARGIN)
    .sort((a, b) => a.cost - b.cost || b.quality - a.quality)[0];
  return { ...pick, top, reason: explain(pick, options) };
}

function explain(pick, options) {
  const pricier = options.filter((o) => o !== pick && o.cost > pick.cost).sort((a, b) => b.quality - a.quality)[0];
  if (options.length === 1) return `The only model that got a fix verified`;
  if (!pricier) return `Best quality (${pick.quality}/100) and the lowest cost`;
  const times = pricier.cost / Math.max(pick.cost, 1e-9);
  const gap = pricier.quality - pick.quality;
  return gap > 0
    ? `${pricier.name} scored ${gap} point${gap > 1 ? "s" : ""} higher, not enough to justify ${fmtTimes(times)} the cost`
    : `Same quality as ${pricier.name} at ${fmtTimes(times)} lower cost`;
}

const fmtTimes = (x) => (x >= 10 ? `${Math.round(x)}x` : `${x.toFixed(1)}x`);

// The trial to run through the API for a problem: the optimizer's pick.
export function pickForProblem(painId) {
  return cheapestNearTop(optionsFor(painId));
}

export function bestTrial(painId) {
  return pickForProblem(painId)?.trial ?? null;
}

// Every verified option for a problem, cheapest first. The proof report is
// pass or fail, so it checks them in this order and the first one that
// passes everything is the one sold: the cheapest model that truly fixed it.
// (Fix size and other quality points don't override a cheaper pass.)
export function rankedOptions(painId) {
  return optionsFor(painId)
    .sort((a, b) => a.cost - b.cost || b.quality - a.quality)
    .map((o) => ({ ...o, reason: "Cheapest model whose fix passed every check" }));
}

// One row per model that has tried anything. Its quality is the average of
// its per-problem scores over the problems it tried (0 where it got no fix
// verified). The recommended model is the cheapest one near the top.
export function scoreboard() {
  const painIds = [...new Set(state.trials.map((t) => t.painId))];
  const perProblem = Object.fromEntries(painIds.map((id) => [id, optionsFor(id)]));
  const rows = MODEL_IDS.map((model) => {
    const mine = state.trials.filter((t) => t.model === model);
    if (!mine.length) return null;
    const tried = [...new Set(mine.map((t) => t.painId))];
    const fixes = tried.map((id) => perProblem[id].find((o) => o.model === model)).filter(Boolean);
    return {
      model,
      name: MODELS[model].name,
      attempts: mine.length,
      passed: mine.filter((t) => t.status === "passed").length,
      tried: tried.length,
      fixed: fixes.length,
      avgLinesChanged: fixes.length ? Math.round(fixes.reduce((s, o) => s + o.trial.linesChanged, 0) / fixes.length) : null,
      quality: Math.round(fixes.reduce((s, o) => s + o.quality, 0) / tried.length),
      costPerFix: costPerFix(model),
      costMeasured: Boolean(state.modelCost[model]),
      picks: painIds.filter((id) => cheapestNearTop(perProblem[id])?.model === model).length,
    };
  }).filter(Boolean);

  const winner = cheapestNearTop(rows.filter((r) => r.fixed).map((r) => ({ ...r, cost: r.costPerFix })));
  for (const r of rows) r.recommended = r.model === winner?.model;
  return rows.sort((a, b) => b.recommended - a.recommended || b.quality - a.quality || a.costPerFix - b.costPerFix);
}

// The overall pick with its reason, for the trial report.
export function overallPick() {
  const rows = scoreboard().filter((r) => r.fixed);
  return cheapestNearTop(rows.map((r) => ({ ...r, cost: r.costPerFix })));
}

// Each flaky test with the optimizer's pick and what a fix should cost.
export function trialSummary() {
  return state.pains
    .filter((p) => !p.healthy)
    .map((p) => {
      const trials = state.trials.filter((t) => t.painId === p.id);
      const pick = pickForProblem(p.id);
      const run = state.bounties.find((b) => b.painId === p.id && b.apiModel && b.status !== "failed");
      return {
        painId: p.id,
        testFile: p.testFile,
        attempts: trials.length,
        recommended: pick && {
          trialId: pick.trial.id,
          model: pick.model,
          name: pick.name,
          quality: pick.quality,
          linesChanged: pick.trial.linesChanged,
          apiCost: pick.cost,
          reason: pick.reason,
        },
        bounty: run ? { id: run.id, status: run.status } : null,
      };
    });
}

// Rough size of a patch: lines added plus lines removed, compared as sets.
async function linesChanged(files) {
  let total = 0;
  for (const f of files) {
    // Ignore line endings: a patch with \n against a \r\n file isn't a rewrite.
    const before = (await readRepoFile(f.path).catch(() => "")).split(/\r?\n/);
    const after = String(f.content).split(/\r?\n/);
    const had = new Set(before);
    const has = new Set(after);
    total += after.filter((l) => !had.has(l)).length + before.filter((l) => !has.has(l)).length;
  }
  return total;
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
