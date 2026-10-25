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
// The trial stops at the first step with a correct diagnosis and recommends
// the cheapest model that got it right, with a quote. Nothing more happens
// until the team authorizes it (authorizeFix): only then does that model
// write the full fix, which is verified and goes through the proof report
// (proof.js). Proven: credits are charged (never more than the quote) and the
// fix lands as a PR. Not proven: the next correct model tries; if none
// proves one, nothing is charged. A model is never asked twice for a
// diagnosis or a fix. Every call is checked against the bug's spend cap
// first (spend.js).
//
// Sealed: until the team unlocks, no fix code leaves Shoal. The API and the
// dashboard show what's broken and where (the winning
// diagnosis, cut down), diff stats, which checks passed and short judge
// verdicts (sealTrial, sealProof, publicLadder). Unlocking charges credits
// once at the price shown (pricing.js), then the proven fix lands as a PR,
// the same way a bounty's does (bounties.js).
import { emit } from "./events.js";
import { state } from "./store.js";
import { MODELS, submitTrial } from "./trials.js";
import { MOCK, contextFiles, diagnosisPrompt, practiceOnly, fixPrompt, judgeViaApi, modelUnavailable, requestDiagnosis, requestModelFix } from "./agents.js";
import { proofFor, proveProblem } from "./proof.js";
import { addSpend, estimate, fitsCap, spentOn, trialCap } from "./spend.js";
import { balanceCents } from "./credits.js";
import { FLOOR, priceFor, unlockPrice } from "./pricing.js";
import { createBounty, runBounty } from "./bounties.js";

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

// The ladder as the team sees it: which file and functions, never the cause or plan.
export function publicLadder(painId) {
  const l = state.apiTrials[painId];
  if (!l) return null;
  const { diagnoses, ...rest } = l;
  return { ...rest, pickName: l.pick ? MODELS[l.pick].name : null, diagnoses: diagnoses.map((d) => ({ model: d.model, name: MODELS[d.model].name, file: d.file, location: where(d.location), correct: d.correct, score: d.score ?? null, fixCost: d.fixCost ?? null, wroteFix: l.fixed.includes(d.model) })) };
}

// Where the bug is, cut to names only: quoted code, parentheses and line
// numbers out, the first clause, at most 60 characters. The team learns what
// needs fixing (this file, these functions), never the cause or the fix.
export function where(location) {
  if (location == null) return location;
  // Parentheses can nest ("(calls lookup(code) ...)"): innermost first, and
  // an unclosed one drops the rest.
  let text = cutCode(location);
  for (let prev = null; prev !== text; ) (prev = text), (text = text.replace(/\([^()]*\)/g, ""));
  const plain = text.replace(/\(.*$/, "").replace(/\b(on |at )?lines? \d+(\s*[-–]\s*\d+)?/gi, "").replace(/\s+/g, " ").trim();
  const first = plain.split(/[.;:]\s|,\s(?=[a-z]+ (?:is|was|does|doesn't|never|uses|returns))/)[0].trim();
  return first.length > 60 ? first.slice(0, 59).trimEnd() + "…" : first;
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
  if (["awaiting_authorization", "fixing"].includes(ladder.status)) throw httpError(409, `${MODELS[ladder.pick].name} is already recommended for ${pain.testFile}`);
  if (proofFor(painId).proven) throw httpError(409, `${pain.testFile} already has a proven fix`);
  const noCredits = canStart();
  if (noCredits) throw httpError(402, noCredits);
  const practice = practiceOnly(state.connection.type);
  if (practice) throw httpError(409, practice);

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
      // A correct diagnosis: recommend the cheapest model that got it right,
      // and wait for the team to authorize it. No fix is written yet.
      const ready = correctUnfixed(ladder);
      if (ready.length) {
        ladder.pick = ready[0].model;
        ladder.pickReason = pickReason(ladder.diagnoses);
        ladder.quote = await quote(pain, ready[0]);
        return stop(ladder, pain, "diagnosed");
      }
    }
    return stop(ladder, pain, "exhausted");
  } catch (err) {
    ladder.status = "failed";
    ladder.stopped = err.message;
    throw err;
  }
}

// Best value first: among correct diagnoses, the ones within SCORE_MARGIN
// of the best score, cheapest for this bug first; then the rest, best score
// first. A pricier model has to diagnose clearly better to be picked. Bounties
// use the same order (bounties.js).
const SCORE_MARGIN = 1;
export function rankDiagnoses(entries) {
  const right = entries.filter((d) => d.correct);
  if (!right.length) return [];
  const top = Math.max(...right.map((d) => d.score ?? 0));
  const near = right.filter((d) => (d.score ?? 0) >= top - SCORE_MARGIN).sort((a, b) => (a.fixCost ?? 0) - (b.fixCost ?? 0) || b.score - a.score);
  return [...near, ...right.filter((d) => !near.includes(d)).sort((a, b) => b.score - a.score || (a.fixCost ?? 0) - (b.fixCost ?? 0))];
}

// Why the top one was picked, for the team.
export function pickReason(entries) {
  const [pick, ...rest] = rankDiagnoses(entries);
  if (!pick) return null;
  const better = rest.filter((d) => d.score > pick.score).sort((a, b) => b.score - a.score)[0];
  if (better) return `${MODELS[better.model].name} scored ${better.score - pick.score} point higher (${better.score}/10 vs ${pick.score}/10), not enough for ${((better.fixCost ?? 0) / Math.max(pick.fixCost ?? 0, 1e-9)).toFixed(1)}x the cost`;
  return rest.length ? `Best diagnosis (${pick.score}/10) at the lowest cost` : `The only correct diagnosis (${pick.score}/10)`;
}

const correctUnfixed = (ladder) => rankDiagnoses(ladder.diagnoses).filter((d) => !ladder.fixed.includes(d.model));

// The most the team will pay if it authorizes this model: Shoal's spend so
// far plus an estimate of the fix and its proof (two judges and the challenge
// writer at about $0.10 each), priced like any fix. The charge never goes
// over it.
async function quote(pain, diagnosis) {
  const fix = estimate(diagnosis.model, await fixPrompt(pain, { diagnosis }), 8_000);
  return priceFor(spentOn(pain.id) + fix + 0.3);
}

// The team authorized the recommended model: it writes the fix now, which
// is verified and proven; proven, it's charged and lands as a PR (the bounty
// flow, bounties.js runUnlock). If it isn't proven, the next model with a
// correct diagnosis tries. Nothing is charged unless one is proven.
export async function authorizeFix(painId, { survivalDays, postedBy = null } = {}) {
  const pain = state.pains.find((p) => p.id === painId);
  const ladder = state.apiTrials[painId];
  if (!pain || !ladder) throw httpError(404, "Run the trial for this test first");
  if (ladder.status !== "awaiting_authorization") throw httpError(409, ladder.status === "fixing" ? "The fix is already being written" : "There's no recommended model waiting for your go-ahead");
  if (balanceCents() < Math.round(ladder.quote * 100)) throw httpError(402, `Not enough credits: this fix costs up to $${ladder.quote.toFixed(2)}. Add credits first.`);
  Object.assign(ladder, { status: "fixing", authorizedAt: new Date().toISOString(), authorizedBy: postedBy });
  try {
    for (const d of correctUnfixed(ladder)) {
      if (!fitsCap(painId, estimate(d.model, await fixPrompt(pain, { diagnosis: d }), 8_000))) return stop(ladder, pain, "cap");
      if ((await writeFix(pain, d, ladder)) !== "verified") continue;
      await proveProblem(painId);
      const proven = proofFor(painId).proven;
      if (!proven) continue;
      ladder.price = Math.min(unlockPrice(painId), ladder.quote);
      stop(ladder, pain, "proven");
      const bounty = createBounty({ painId, reward: ladder.price, funding: "credits", apiModel: proven.model, trialId: proven.trialId, unlock: true, survivalDays, postedBy });
      ladder.bountyId = bounty.id;
      await runBounty(bounty.id);
      return ladder;
    }
    return stop(ladder, pain, "not_proven");
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
// mode: correct when it names a file the test imports. Bounties use it too
// (bounties.js diagnosisRace).
export async function grade(pain, entries) {
  const code = (await contextFiles(pain)).map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n");
  // What each model would cost to write this bug's fix: its prices on this
  // bug's code and diagnosis, not a generic estimate.
  for (const d of entries) d.fixCost = estimate(d.model, `${code}\n${d.cause}\n${d.plan}`, 8_000);
  if (MOCK) {
    for (const d of entries) {
      d.correct = (pain.sourceFiles ?? []).includes(d.file);
      d.score = d.correct ? 7 : 0;
    }
    return report(pain, entries);
  }
  const prompt = [
    `The test ${pain.testFile} is flaky: it failed ${pain.failures}/${pain.runs} runs.`,
    pain.sampleFailure ? `Sample failure output:\n${pain.sampleFailure}` : "",
    `The test and the code it imports:\n${code}`,
    `Engineers diagnosed it:\n${entries.map((d, i) => `Diagnosis ${label(i)}: ${d.file} (${d.location}). Cause: ${d.cause} Plan: ${d.plan}`).join("\n")}`,
    "Read EVERY test case and the source code yourself. Decide whether each diagnosis identifies ALL independent root causes needed to make the ENTIRE test file pass. Mark correct=false for a partial diagnosis even when the one bug it names is real. A plan that only repairs the last failure or one faulty function while leaving other failing cases cannot qualify. Never accept retrying, sleeping longer or loosening tests.",
    "For a complete correct diagnosis, score clarity and precision from 1 to 10. An incorrect or incomplete diagnosis scores 0. A high score never compensates for missed root causes.",
    'Reply with only JSON: {"grades": [{"label": "A", "correct": true | false, "score": 0-10}, ...]}',
  ].join("\n\n");
  for (const model of GRADERS) {
    if (modelUnavailable(model) || !fitsCap(pain.id, estimate(model, prompt, 3_000))) continue;
    try {
      const r = await judgeViaApi(model, prompt);
      addSpend(pain.id, "judges", r.cost);
      const grades = JSON.parse(r.text.slice(r.text.indexOf("{"), r.text.lastIndexOf("}") + 1)).grades ?? [];
      entries.forEach((d, i) => {
        const g = grades.find((x) => x.label === label(i));
        d.correct = g?.correct === true;
        d.score = d.correct ? Math.max(1, Math.min(10, Number(g.score) || 5)) : 0;
      });
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
  diagnosed: (l) => `${MODELS[l.pick].name} diagnosed it correctly at the lowest cost. Authorize it to write the fix (up to $${l.quote.toFixed(2)}, charged only if the fix is proven).`,
  proven: (l) => `proven; charging $${l.price.toFixed(2)} and opening the PR`,
  not_proven: () => "no model's fix was proven; nothing charged",
  cap: () => "stopped at this bug's spend cap",
  exhausted: () => "no model diagnosed it correctly",
};

const STATUS_AFTER = { diagnosed: "awaiting_authorization", proven: "proven" };

function stop(ladder, pain, why) {
  ladder.status = STATUS_AFTER[why] ?? "stopped";
  ladder.stopped = why;
  ladder.finishedAt = new Date().toISOString();
  emit(STATUS_AFTER[why] ? "trials.done" : "trials.error", { message: `Sealed trials for ${pain.testFile}: ${STOPS[why](ladder)}` });
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
