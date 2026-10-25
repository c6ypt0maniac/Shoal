// Sealed API trials: Shoal tries fixes on its own Anthropic and OpenAI keys
// and pays every token; the team pays only to unlock a proven fix.
//   step 1  Haiku 5.5, GPT-6 Luna, GPT-5 nano
//   step 2  Sonnet 5.5, GPT-6.1 Sol
//   step 3  Opus 5.5, GPT-6 Astra
// Each step's models run at once; their verified fixes go through the proof
// report (proof.js), and the ladder stops at the first step with a proven
// fix. A model that failed is never asked again on the same bug. Every call
// is checked against the bug's spend cap first (spend.js); a call that would
// go over isn't made and the ladder stops.
//
// Sealed: until the team unlocks, no fix code leaves Shoal. The API, the MCP
// tools and the dashboard show diff stats, which checks passed and the
// judges' summaries with quoted code cut (sealTrial, sealProof). Unlocking
// charges credits once at the price shown (pricing.js), then the exact
// proven fix lands as a PR, the same way a bounty's does (bounties.js).
import { emit } from "./events.js";
import { state } from "./store.js";
import { MODELS, submitTrial } from "./trials.js";
import { fixPrompt, modelUnavailable, requestModelFix } from "./agents.js";
import { proofFor, proveProblem } from "./proof.js";
import { addSpend, estimate, fitsCap, spentOn, trialCap } from "./spend.js";
import { balanceCents } from "./credits.js";
import { FLOOR, unlockPrice } from "./pricing.js";

export const STEPS = [
  ["claude-haiku-5-5", "gpt-6-luna", "gpt-5-nano"],
  ["claude-sonnet-5-5", "gpt-6.1-sol"],
  ["claude-opus-5-5", "gpt-6-astra"],
];

// Ladder state per bug: which models were tried, where it stopped and why,
// and the unlock price, fixed when a fix is proven.
const ladderFor = (painId) => (state.apiTrials[painId] ??= { status: "idle", step: null, tried: [], stopped: null, price: null });

export const ladderStatus = (painId) => state.apiTrials[painId] ?? null;

// A trial Shoal paid for and the team hasn't unlocked: its code stays hidden.
export const isSealed = (trial) => Boolean(trial?.sealed && !trial.unlockedAt);

// Trials need credits: at least the lowest unlock price, so a proven fix can
// always be bought.
export function canStart() {
  if (balanceCents() < Math.round(FLOOR * 100)) return `Trials need credits: add at least $${FLOOR.toFixed(2)} first`;
  return null;
}

// Runs the ladder for one bug. Resolves when it stops.
export async function runSealedTrials(painId) {
  const pain = state.pains.find((p) => p.id === painId);
  if (!pain) throw httpError(404, `Unknown problem ${painId}`);
  if (pain.healthy) throw httpError(400, `${pain.testFile} isn't flaky; nothing to fix`);
  const ladder = ladderFor(painId);
  if (ladder.status === "running") throw httpError(409, `Trials for ${pain.testFile} are already running`);
  if (proofFor(painId).proven) throw httpError(409, `${pain.testFile} already has a proven fix`);
  const noCredits = canStart();
  if (noCredits) throw httpError(402, noCredits);

  Object.assign(ladder, { status: "running", stopped: null, startedAt: new Date().toISOString() });
  try {
    const prompt = await fixPrompt(pain);
    for (const [i, models] of STEPS.entries()) {
      ladder.step = i + 1;
      const fresh = models.filter((m) => !ladder.tried.includes(m));
      if (!fresh.length) continue;
      if (spentOn(painId) >= trialCap()) return stop(ladder, pain, "cap");
      emit("trials.step", { message: `Sealed trials, step ${i + 1}: ${fresh.map((m) => MODELS[m].name).join(", ")} on ${pain.testFile}` });
      // The step's calls run at once, so each one's estimate is reserved
      // before the next is checked against the cap.
      let reserved = 0;
      const go = [];
      let capped = false;
      for (const m of fresh) {
        if (modelUnavailable(m)) continue;
        const cost = estimate(m, prompt, 8_000);
        if (!fitsCap(painId, reserved + cost)) capped = true;
        else (reserved += cost), go.push(m);
      }
      const results = await Promise.all(go.map((m) => attempt(pain, m, ladder)));
      if (capped && !results.includes("verified")) return stop(ladder, pain, "cap");
      if (!results.includes("verified")) continue;
      await proveProblem(painId);
      if (proofFor(painId).proven) {
        ladder.price = unlockPrice(painId);
        return stop(ladder, pain, "proven");
      }
    }
    return stop(ladder, pain, "exhausted");
  } catch (err) {
    ladder.status = "failed";
    ladder.stopped = err.message;
    throw err;
  }
}

// One model's try: "verified" or "failed".
async function attempt(pain, model, ladder) {
  // Tried counts from here: a model that fails isn't asked again.
  ladder.tried.push(model);
  let out;
  try {
    out = await requestModelFix(model, null, pain);
    addSpend(pain.id, "fix", out.cost);
  } catch (err) {
    addSpend(pain.id, "fix", err.cost ?? 0);
    emit("trial.failed", { model, message: `Sealed trial: ${MODELS[model].name} returned no fix for ${pain.testFile} (${err.message})` });
    return "failed";
  }
  const trial = await submitTrial({ painId: pain.id, model, summary: out.fix.summary, files: out.fix.files, client: { app: "Shoal API", login: null }, sealed: true, apiCost: out.cost });
  return trial.status === "passed" ? "verified" : "failed";
}

const STOPS = {
  proven: (l) => `proven; unlock for $${l.price.toFixed(2)}`,
  cap: () => "stopped at this bug's spend cap",
  exhausted: () => "no model's fix was proven",
};

function stop(ladder, pain, why) {
  ladder.status = why === "proven" ? "proven" : "stopped";
  ladder.stopped = why;
  ladder.finishedAt = new Date().toISOString();
  emit(why === "proven" ? "trials.done" : "trials.error", { message: `Sealed trials for ${pain.testFile}: ${STOPS[why](ladder)}` });
  return ladder;
}

// --- Sealing ------------------------------------------------------------------

// Quoted code out of prose (judge summaries, a model's own summary): fenced
// blocks and inline `code` both go.
export const cutCode = (text) =>
  text == null ? text : String(text).replace(/```[\s\S]*?(```|$)/g, "[code hidden until unlock]").replace(/`[^`\n]+`/g, "[code]");

// A trial as the team sees it: file paths and size, no contents while sealed.
export function sealTrial({ files, ...t }) {
  if (!isSealed(t)) return { ...t, files: files.map((f) => f.path) };
  return { ...t, summary: cutCode(t.summary), files: files.map((f) => f.path), locked: true };
}

// A proof report with sealed candidates' code taken out: the diff becomes
// per-file line counts, judge notes lose their quoted code, and logs (which
// can print the fixed code) go.
export function sealProof(proof) {
  const seal = (c) => {
    if (!isSealed(state.trials.find((t) => t.id === c.trialId))) return c;
    const { checks } = c;
    const diff = checks.diff && { added: checks.diff.added, removed: checks.diff.removed, files: checks.diff.files.map(({ hunks, ...f }) => f) };
    const review = checks.review && {
      ...checks.review,
      summary: cutCode(checks.review.summary),
      remaining: checks.review.remaining?.map(cutCode),
      risks: checks.review.risks?.map(cutCode),
      judges: checks.review.judges?.map((j) => ({ ...j, summary: cutCode(j.summary), remaining: j.remaining?.map(cutCode), risks: j.risks?.map(cutCode) })),
    };
    const noLogs = (check) => check && Object.fromEntries(Object.entries(check).filter(([k]) => !/log/i.test(k)));
    return { ...c, locked: true, failures: c.failures.map(cutCode), checks: { ...checks, diff, review, stress: noLogs(checks.stress), suite: noLogs(checks.suite) } };
  };
  return { ...proof, candidates: proof.candidates.map(seal), proven: proof.proven && seal(proof.proven), awaitingReview: proof.awaitingReview && seal(proof.awaitingReview) };
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
