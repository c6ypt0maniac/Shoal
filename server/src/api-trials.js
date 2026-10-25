// Sealed API trials: Shoal finds the right model on its own Anthropic and
// OpenAI keys and pays every token; the team pays only to unlock a proven fix.
//   step 1  Haiku 5.5, GPT-6 Luna, GPT-5 nano
//   step 2  Sonnet 5.5, GPT-6.1 Sol
//   step 3  Opus 5.5, GPT-6 Astra
// The trial is small: each of a step's models only DIAGNOSES the bug (which
// file and function, why, and a one-line plan; no code, low effort). A grader
// (Sonnet 5.5, else GPT-6.1 Sol, else Opus 5.5) reads the test, the code it
// imports and the diagnoses, labelled A, B, C... never by model, and marks
// each correct or not. Only then does a model write the full fix: the
// cheapest one whose diagnosis was correct, with its own diagnosis in hand.
// That fix is verified and goes through the proof report (proof.js); if it
// isn't proven, the next correct model writes one, then the next step
// diagnoses. A model is never asked twice for a diagnosis or a fix. Every
// call is checked against the bug's spend cap first (spend.js).
//
// Sealed: until the team unlocks, no fix code leaves Shoal. The API, the MCP
// tools and the dashboard show what's broken and where (the winning
// diagnosis, cut down), diff stats, which checks passed and short judge
// verdicts (sealTrial, sealProof, publicLadder). Unlocking charges credits
// once at the price shown (pricing.js), then the proven fix lands as a PR,
// the same way a bounty's does (bounties.js).
import { emit } from "./events.js";
import { state } from "./store.js";
import { MODELS, costPerFix, submitTrial } from "./trials.js";
import { MOCK, contextFiles, diagnosisPrompt, fixPrompt, judgeViaApi, modelUnavailable, requestDiagnosis, requestModelFix } from "./agents.js";
import { proofFor, proveProblem } from "./proof.js";
import { addSpend, estimate, fitsCap, spentOn, trialCap } from "./spend.js";
import { balanceCents } from "./credits.js";
import { FLOOR, unlockPrice } from "./pricing.js";

export const STEPS = [
  ["claude-haiku-5-5", "gpt-6-luna", "gpt-5-nano"],
  ["claude-sonnet-5-5", "gpt-6.1-sol"],
  ["claude-opus-5-5", "gpt-6-astra"],
];
const GRADERS = ["claude-sonnet-5-5", "gpt-6.1-sol", "claude-opus-5-5"];

// Ladder state per bug: which models diagnosed and which wrote a fix, their
// diagnoses and grades, where it stopped and why, and the unlock price, fixed
// when a fix is proven.
const ladderFor = (painId) => (state.apiTrials[painId] ??= { status: "idle", step: null, diagnosed: [], fixed: [], diagnoses: [], stopped: null, price: null });

export const ladderStatus = (painId) => state.apiTrials[painId] ?? null;

// The ladder as the team sees it: no plans, and causes cut down.
export function publicLadder(painId) {
  const l = state.apiTrials[painId];
  if (!l) return null;
  const { diagnoses, ...rest } = l;
  return { ...rest, diagnoses: diagnoses.map((d) => ({ model: d.model, name: MODELS[d.model].name, file: d.file, location: brief(d.location), cause: brief(d.cause), correct: d.correct, wroteFix: l.fixed.includes(d.model) })) };
}

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
    const prompt = await diagnosisPrompt(pain);
    for (const [i, models] of STEPS.entries()) {
      ladder.step = i + 1;
      const fresh = models.filter((m) => !ladder.diagnosed.includes(m) && !modelUnavailable(m));
      if (fresh.length) {
        if (spentOn(painId) >= trialCap()) return stop(ladder, pain, "cap");
        emit("trials.step", { message: `Sealed trials, step ${i + 1}: ${fresh.map((m) => MODELS[m].name).join(", ")} diagnose ${pain.testFile}` });
        // The step's calls run at once, so each one's estimate is reserved
        // before the next is checked against the cap.
        let reserved = 0;
        const go = fresh.filter((m) => {
          const cost = estimate(m, prompt, 1_500);
          if (!fitsCap(painId, reserved + cost)) return false;
          reserved += cost;
          return true;
        });
        if (!go.length) return stop(ladder, pain, "cap");
        const found = (await Promise.all(go.map((m) => diagnose(pain, m, prompt, ladder)))).filter(Boolean);
        if (found.length) await grade(pain, found);
      }
      // Full fixes only from correct diagnoses, cheapest model first.
      const ready = ladder.diagnoses.filter((d) => d.correct && !ladder.fixed.includes(d.model)).sort((a, b) => costPerFix(a.model) - costPerFix(b.model));
      for (const d of ready) {
        if (!fitsCap(painId, estimate(d.model, await fixPrompt(pain, { diagnosis: d }), 8_000))) return stop(ladder, pain, "cap");
        if ((await writeFix(pain, d, ladder)) !== "verified") continue;
        await proveProblem(painId);
        if (proofFor(painId).proven) {
          ladder.price = unlockPrice(painId);
          return stop(ladder, pain, "proven");
        }
      }
    }
    return stop(ladder, pain, "exhausted");
  } catch (err) {
    ladder.status = "failed";
    ladder.stopped = err.message;
    throw err;
  }
}

// One model's diagnosis, or null. Counted as tried from here: a model isn't
// asked to diagnose the same bug twice.
async function diagnose(pain, model, prompt, ladder) {
  ladder.diagnosed.push(model);
  try {
    const { diagnosis, cost } = await requestDiagnosis(model, pain, prompt);
    addSpend(pain.id, "fix", cost);
    const entry = { model, ...diagnosis, correct: null };
    ladder.diagnoses.push(entry);
    return entry;
  } catch (err) {
    addSpend(pain.id, "fix", err.cost ?? 0);
    emit("trial.failed", { model, message: `Sealed trial: ${MODELS[model].name} returned no diagnosis for ${pain.testFile} (${err.message})` });
    return null;
  }
}

// Marks each diagnosis correct or not, blind (labelled A, B, C...). Practice
// mode: correct when it names a file the test imports.
async function grade(pain, entries) {
  if (MOCK) {
    for (const d of entries) d.correct = (pain.sourceFiles ?? []).includes(d.file);
    return report(pain, entries);
  }
  const code = (await contextFiles(pain)).map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n");
  const prompt = [
    `The test ${pain.testFile} is flaky: it failed ${pain.failures}/${pain.runs} runs.`,
    pain.sampleFailure ? `Sample failure output:\n${pain.sampleFailure}` : "",
    `The test and the code it imports:\n${code}`,
    `Engineers diagnosed it:\n${entries.map((d, i) => `Diagnosis ${label(i)}: ${d.file} (${d.location}). Cause: ${d.cause} Plan: ${d.plan}`).join("\n")}`,
    "Read the code yourself and decide, for each diagnosis, whether it names the real cause in the right place and its plan would fix it in application code (not by retrying, sleeping longer or loosening the test).",
    'Reply with only JSON: {"grades": [{"label": "A", "correct": true | false}, ...]}',
  ].join("\n\n");
  for (const model of GRADERS) {
    if (modelUnavailable(model) || !fitsCap(pain.id, estimate(model, prompt, 3_000))) continue;
    try {
      const r = await judgeViaApi(model, prompt);
      addSpend(pain.id, "judges", r.cost);
      const grades = JSON.parse(r.text.slice(r.text.indexOf("{"), r.text.lastIndexOf("}") + 1)).grades ?? [];
      entries.forEach((d, i) => (d.correct = grades.find((g) => g.label === label(i))?.correct === true));
      return report(pain, entries, MODELS[model].name);
    } catch (err) {
      emit("trials.warning", { message: `Sealed trials: ${MODELS[model].name} couldn't grade the diagnoses (${String(err.message).slice(0, 120)})` });
    }
  }
  for (const d of entries) d.correct = false;
  emit("trials.error", { message: `Sealed trials: no grader could run for ${pain.testFile}` });
}

function report(pain, entries, by = "practice-mode grader") {
  const right = entries.filter((d) => d.correct).map((d) => MODELS[d.model].name);
  emit("trials.graded", { message: `Sealed trials: ${by} graded ${entries.length} diagnoses for ${pain.testFile}; correct: ${right.join(", ") || "none"}` });
}

// The full fix, from a model whose diagnosis was correct: "verified" or "failed".
async function writeFix(pain, diagnosis, ladder) {
  const { model } = diagnosis;
  ladder.fixed.push(model);
  emit("trials.fixing", { model, message: `Sealed trials: ${MODELS[model].name} diagnosed ${pain.testFile} correctly and is writing the fix` });
  let out;
  try {
    out = await requestModelFix(model, null, pain, { diagnosis });
    addSpend(pain.id, "fix", out.cost);
  } catch (err) {
    addSpend(pain.id, "fix", err.cost ?? 0);
    emit("trial.failed", { model, message: `Sealed trial: ${MODELS[model].name} returned no fix for ${pain.testFile} (${err.message})` });
    return "failed";
  }
  const trial = await submitTrial({ painId: pain.id, model, summary: out.fix.summary, files: out.fix.files, client: { app: "Shoal API", login: null }, sealed: true, apiCost: out.cost });
  return trial.status === "passed" ? "verified" : "failed";
}

const label = (i) => String.fromCharCode(65 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) : "");

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

// Prose about a fix, cut down to what needs fixing: quoted code out, then
// the first sentence, at most 200 characters. The how stays with the fix.
export function brief(text) {
  if (text == null) return text;
  const cut = cutCode(text).trim();
  const first = cut.split(/(?<=[.!?])\s/)[0];
  return first.length > 200 ? first.slice(0, 199).trimEnd() + "…" : first;
}

// A trial as the team sees it: file paths and size, no contents while sealed.
export function sealTrial({ files, ...t }) {
  if (!isSealed(t)) return { ...t, files: files.map((f) => f.path) };
  return { ...t, summary: brief(t.summary), files: files.map((f) => f.path), locked: true };
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
      summary: brief(checks.review.summary),
      remaining: checks.review.remaining?.map(brief),
      risks: checks.review.risks?.map(brief),
      judges: checks.review.judges?.map((j) => ({ ...j, summary: brief(j.summary), remaining: j.remaining?.map(brief), risks: j.risks?.map(brief) })),
    };
    const noLogs = (check) => check && Object.fromEntries(Object.entries(check).filter(([k]) => !/log/i.test(k)));
    return { ...c, locked: true, failures: c.failures.map(brief), checks: { ...checks, diff, review, stress: noLogs(checks.stress), suite: noLogs(checks.suite) } };
  };
  return { ...proof, candidates: proof.candidates.map(seal), proven: proof.proven && seal(proof.proven), awaitingReview: proof.awaitingReview && seal(proof.awaitingReview) };
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
