// Proof report: evidence that a model's fix is reliable, shown before the
// team spends anything. Strictly pass or fail: a fix is sold only if EVERY
// check passes. A check that can't run fails; nothing is skipped, and
// working around a bug instead of fixing it is a failure.
//   stress test     50 runs: 40 in parallel batches (load) + 10 inside the
//                   full suite in shuffled order. Every run must pass.
//   full suite      every other test still passes; tests that were already
//                   flaky must fail no more often than before.
//   rules           no test/CI/manifest edits, only shared files, no secrets.
//   challenge tests new tests Opus (or GPT-6 Astra, without Claude Code) writes
//                   after reading ALL the shared code
//                   and every model's fix, aimed at root causes a fix might
//                   dodge (e.g. a lock that never releases). A fix must pass
//                   every challenge test that at least one fix passes.
//   second opinion  two judges, the best Sonnet and the top OpenAI model,
//                   each read ALL the shared code with the fix applied, and
//                   both must find that every root cause is fixed.
//   track record    how this model's trials have gone on this repo (shown,
//                   not counted: it describes the model, not this fix).
//   code diff       exactly which lines would land.
// If the cheapest pick fails, the next-best model is checked, so the model
// the team can buy is always both good value and proven.
import { createSandbox, destroySandbox, getStacks, listAllFiles, readRepoFile, runTestDetail, runTestMany, runTestOnce, WORKSPACE, writeFiles } from "./repo.js";
import { challengePath, commandFor, stackFor, testHint } from "./stack.js";
import { inScope, isSecret } from "./scope.js";
import { isProtected } from "./verifier.js";
import { emit } from "./events.js";
import { state } from "./store.js";
import { MODELS, rankedOptions } from "./trials.js";
import { askClaude } from "./claude-runner.js";
import { askCodex } from "./codex-runner.js";

const STRESS_PARALLEL = 40;
const STRESS_MIXED = 10;
const BATCH = 10;
const FLAKY_RERUNS = 10;
const CHALLENGE_RUNS = 3;
// The checks a fix must pass. The trust score is the share it passed.
const CHECKS = ["stress", "suite", "rules", "challenge", "review"];

const running = new Set();
// Challenge tests per problem, reused when proving resumes after a review
// (same fixes, same tests), and the full prompt each waiting review needs.
const challenges = new Map(); // painId -> { key, challenge }
const reviewPrompts = new Map(); // trialId -> prompt

export const isProving = () => running.size > 0;

// Proof status for one problem: every candidate checked so far and the first
// one that's proven (the one the team can buy).
export function proofFor(painId) {
  const proofs = Object.values(state.proofs).filter((p) => p.painId === painId).sort((a, b) => a.rank - b.rank);
  return {
    checking: running.has(painId),
    candidates: proofs,
    proven: proofs.find((p) => p.verdict === "safe") ?? null,
    awaitingReview: proofs.find((p) => p.status === "awaiting_review") ?? null,
  };
}

// Throws away a problem's proof reports so they're built again from scratch.
export function resetProofs(painId) {
  for (const [id, p] of Object.entries(state.proofs)) {
    if (p.painId !== painId) continue;
    delete state.proofs[id];
    reviewPrompts.delete(id);
  }
  challenges.delete(painId);
}

// Writes the challenge tests, runs them against every fix, then checks
// candidates best-value first until one passes everything. Stops while a
// candidate waits for a judge; submitReview picks it up again.
export async function proveProblem(painId) {
  if (running.has(painId)) return;
  const pain = state.pains.find((p) => p.id === painId);
  const options = rankedOptions(painId);
  if (!pain || !options.length) return;
  running.add(painId);
  try {
    const code = await allSharedCode();
    const key = options.map((o) => o.trial.id).join(",");
    if (challenges.get(painId)?.key !== key) challenges.set(painId, { key, challenge: await challengeFor(pain, options, code) });
    const { challenge } = challenges.get(painId);
    for (const [rank, option] of options.entries()) {
      const existing = state.proofs[option.trial.id];
      if (existing?.status === "awaiting_review") return;
      if (existing?.status === "done") {
        if (existing.verdict === "safe") return;
        continue;
      }
      const proof = await prove(pain, option, rank, { code, challenge, options });
      if (proof.status === "awaiting_review" || proof.verdict === "safe") return;
      if (options[rank + 1]) {
        emit("proof.next", { message: `${option.name}'s fix isn't proven for ${pain.testFile}; checking ${options[rank + 1].name} next` });
      }
    }
    emit("proof.none", { message: `No model's fix for ${pain.testFile} is proven yet. Nothing is offered for sale.` });
  } finally {
    running.delete(painId);
  }
}

async function prove(pain, option, rank, { code, challenge, options }) {
  const { trial } = option;
  const proof = (state.proofs[trial.id] = {
    trialId: trial.id,
    painId: pain.id,
    testFile: pain.testFile,
    model: trial.model,
    name: MODELS[trial.model].name,
    rank,
    status: "checking",
    startedAt: new Date().toISOString(),
    checks: {},
    score: null,
    verdict: null,
    failures: [],
  });
  emit("proof.started", { message: `Proof: checking ${proof.name}'s fix for ${pain.testFile} (stress test, every other test, rules, challenge tests, review)` });

  proof.checks.rules = checkRules(trial.files);
  proof.checks.diff = await diffFiles(trial.files);
  proof.checks.record = trackRecord(trial.model);
  proof.checks.challenge = challengeCheck(challenge, trial.id);

  const sandbox = await createSandbox();
  try {
    await writeFiles(sandbox, trial.files);
    proof.checks.stress = await stressTest(sandbox, pain);
    proof.checks.suite = await fullSuite(sandbox, pain);
  } finally {
    await destroySandbox(sandbox);
  }
  proof.checks.review = await startReview(pain, trial, proof.checks.diff, { code, options });
  const waiting = proof.checks.review.judges.filter((j) => j.status === "waiting");
  if (waiting.length) {
    proof.status = "awaiting_review";
    emit("proof.awaiting_review", {
      message: `Proof: ${proof.name}'s fix for ${pain.testFile} needs a review from ${waiting.map((j) => j.name).join(" and ")}. In ${waiting.map((j) => (j.provider === "openai" ? "ChatGPT or Codex" : "Claude")).join(" / ")}, connected to Shoal, ask it to review the fixes.`,
    });
    return proof;
  }
  return finishProof(proof, pain);
}

function finishProof(proof, pain) {
  finishReview(proof.checks.review);
  score(proof);
  proof.status = "done";
  proof.finishedAt = new Date().toISOString();
  emit(proof.verdict === "safe" ? "proof.safe" : "proof.not_proven", {
    message:
      proof.verdict === "safe"
        ? `Proof: ${proof.name}'s fix for ${pain.testFile} is SAFE TO BUY (trust ${proof.score}/100)`
        : `Proof: ${proof.name}'s fix for ${pain.testFile} is not proven: ${proof.failures.join("; ")}`,
  });
  return proof;
}

// --- Checks -------------------------------------------------------------------

async function stressTest(dir, pain) {
  const runs = [];
  for (let i = 0; i < STRESS_PARALLEL; i += BATCH) runs.push(...(await runTestMany(dir, pain.testFile, BATCH)));
  const stable = state.pains.filter((p) => p.healthy && p.testFile !== pain.testFile).map((p) => p.testFile);
  for (let i = 0; i < STRESS_MIXED; i++) {
    const order = shuffle([pain.testFile, ...stable]);
    runs.push(await runTestOnce(dir, order));
  }
  const passed = runs.filter((r) => r.passed).length;
  return {
    passed,
    total: runs.length,
    before: { failures: pain.failures, runs: pain.runs },
    results: runs.map((r) => r.passed),
    failureLog: runs.find((r) => !r.passed)?.log ?? null,
    ok: passed === runs.length,
  };
}

// Every other test runs. Stable ones must pass. Ones that were already flaky
// run FLAKY_RERUNS times and must fail no more often than at scan time (plus
// 2 for run-to-run noise): a fix can't make an unrelated test worse.
async function fullSuite(dir, pain) {
  const stable = state.pains.filter((p) => p.healthy && p.testFile !== pain.testFile).map((p) => p.testFile);
  const flaky = state.pains.filter((p) => !p.healthy && p.testFile !== pain.testFile);
  const stableRun = stable.length ? await runTestOnce(dir, stable) : { passed: true, log: null };
  const flakyRuns = [];
  for (const p of flaky) {
    const runs = await runTestMany(dir, p.testFile, FLAKY_RERUNS);
    const failures = runs.filter((r) => !r.passed).length;
    const allowed = Math.round((p.failures / p.runs) * FLAKY_RERUNS) + 2;
    flakyRuns.push({ testFile: p.testFile, before: `${p.failures}/${p.runs}`, after: `${failures}/${FLAKY_RERUNS}`, ok: failures <= allowed });
  }
  return {
    ok: stableRun.passed && flakyRuns.every((r) => r.ok),
    files: stable,
    stableOk: stableRun.passed,
    flaky: flakyRuns,
    failureLog: stableRun.passed ? null : stableRun.log,
    note: stable.length || flaky.length ? null : "This is the only test in the shared code",
  };
}

function checkRules(files) {
  const rules = [
    { label: "No test files, CI config or package manifests changed", bad: files.filter((f) => isProtected(clean(f.path))).map((f) => f.path) },
    { label: "Only files the team shared", bad: files.filter((f) => !inScope(clean(f.path))).map((f) => f.path) },
    { label: "No secrets or credential files touched", bad: files.filter((f) => isSecret(clean(f.path))).map((f) => f.path) },
    { label: "No paths outside the repo", bad: files.filter((f) => /(^|\/)\.\.(\/|$)|^\/|^[a-z]:/i.test(f.path.replace(/\\/g, "/"))).map((f) => f.path) },
  ];
  return { ok: rules.every((r) => !r.bad.length), rules: rules.map((r) => ({ label: r.label, ok: !r.bad.length, files: r.bad })) };
}

function trackRecord(model) {
  const mine = state.trials.filter((t) => t.model === model && t.status !== "verifying");
  const verified = mine.filter((t) => t.status === "passed").length;
  const problems = [...new Set(mine.map((t) => t.painId))];
  const firstTry = problems.filter((id) => mine.filter((t) => t.painId === id).sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))[0].status === "passed").length;
  return { attempts: mine.length, verified, problems: problems.length, firstTry, rate: mine.length ? verified / mine.length : 0 };
}

// --- All the shared code ------------------------------------------------------

// Every file the team shared, in full: the reviewer and the challenge-test
// writer always see the whole codebase, never just the files a fix touched.
// Lockfiles and binaries aren't code, so they're left out.
const NOT_CODE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$|\.(png|jpe?g|gif|ico|webp|pdf|zip|gz|woff2?|ttf|mp4|mp3)$/i;

async function allSharedCode() {
  const paths = (await listAllFiles(WORKSPACE)).filter((p) => inScope(p) && !NOT_CODE.test(p)).sort();
  return Promise.all(paths.map(async (p) => ({ path: p, content: await readRepoFile(p) })));
}

// The shared code with a fix applied on top.
const withFix = (code, files) => {
  const fixed = new Map(files.map((f) => [clean(f.path), f.content]));
  const out = code.map((f) => ({ path: f.path, content: fixed.get(f.path) ?? f.content }));
  for (const [p, content] of fixed) if (!code.some((f) => f.path === p)) out.push({ path: p, content });
  return out;
};

const dump = (files) => files.map((f) => `===== ${f.path} =====\n${f.content}`).join("\n\n");
const diffText = (diff) => diff.files.map((f) => `--- ${f.path}\n${f.hunks.map((h) => h.lines.map((l) => l.type + l.text).join("\n")).join("\n...\n")}`).join("\n\n");

// --- Challenge tests ----------------------------------------------------------

// Opus reads all the shared code and every model's fix, then writes
// new tests aimed at the root causes, especially ones a fix could dodge
// instead of fixing. They run against every fix. A test only counts if at
// least one fix passes it (so it's a fair test); a fix must pass all of those.
async function challengeFor(pain, options, code) {
  // Same language, framework and folder as the failing test (see stack.js).
  const stack = stackFor(getStacks(), pain.testFile);
  if (!stack?.toolOk) return { ok: false, file: null, error: stack ? stack.toolMessage : `No supported test setup for ${pain.testFile}` };
  const file = challengePath(stack, pain.testFile);
  emit("proof.challenge", { message: `Proof: a judge model is reading all ${code.length} shared files and writing challenge tests for ${pain.testFile}` });

  const fixes = await Promise.all(options.map(async (o) => `### ${o.name} changed ${o.trial.files.map((f) => f.path).join(", ")}\n${diffText(await diffFiles(o.trial.files))}`));
  const prompt = [
    `The test ${pain.testFile} failed ${pain.failures}/${pain.runs} runs. Several AI models each submitted a fix, and every fix makes that test pass.`,
    "Your job: write NEW tests that check whether each root cause is really fixed. A fix that only avoids triggering a bug, instead of fixing it, must fail your tests.",
    "Read the whole codebase. Look at the contracts stated in comments and names (for example \"callers run one at a time\" or \"one failing listener mustn't stop the others\") and test them directly, including after errors. If some fixes changed a file that others didn't, test the behavior that change fixes.",
    `All the shared code, before any fix:\n\n${dump(code)}`,
    `The fixes:\n\n${fixes.join("\n\n")}`,
    `Write one test file, saved as ${file}, in ${testHint(stack)}, matching the style and imports of ${pain.testFile}. It must run with: ${commandFor(stack, [file]).cmd}`,
    "Rules: 3 to 8 tests, each one short and with a timeout if the framework supports it, so a deadlock fails instead of hanging. Don't depend on luck with random timing: repeat racy scenarios many times in one test. Don't repeat what the existing test already checks. Test behavior, not implementation details. Give each test a clear, descriptive name.",
    "Reply with only the file, in one fenced code block.",
  ].join("\n\n");

  // Opus through Claude Code, or GPT-6 Astra through Codex when Claude Code
  // isn't here: either way on the team's own plan.
  const writers = [
    { author: "Opus 5.5", ask: () => askClaude(prompt, { model: "opus", timeout: 8 * 60_000 }) },
    { author: MODELS["gpt-6-astra"].name, ask: () => askCodex(prompt, { model: "gpt-6-astra", timeout: 8 * 60_000 }) },
  ];
  let answer = null;
  let author = null;
  for (const w of writers) {
    answer = await w.ask();
    if (answer) {
      author = w.author;
      break;
    }
  }
  const source = answer?.text.match(/```[\w#+.-]*\s*\n([\s\S]*?)```/)?.[1];
  if (!source) {
    return { ok: false, file, error: answer ? `${author} didn't return a test file` : "Neither Claude Code nor Codex is available and signed in, so no challenge tests could be written" };
  }

  const original = await runChallenge([], { path: file, content: source });
  const results = {};
  for (const o of options) results[o.trial.id] = await runChallenge(o.trial.files, { path: file, content: source });
  const names = [...new Set([...Object.keys(original), ...Object.values(results).flatMap((r) => Object.keys(r))])];
  const fair = names.filter((n) => Object.values(results).some((r) => r[n] === true));
  emit("proof.challenge", {
    message: `Proof: ${fair.length} challenge test${fair.length === 1 ? "" : "s"} for ${pain.testFile}${names.length > fair.length ? ` (${names.length - fair.length} no fix passes, not counted)` : ""}`,
  });
  return { ok: true, file, source, author, original, results, fair, unfair: names.filter((n) => !fair.includes(n)) };
}

// Runs the challenge file CHALLENGE_RUNS times with a fix applied, using the
// repo's own test runner. A test passes only if it passed every time. Returns
// { testName: passed }; frameworks without per-test output count as one test.
async function runChallenge(fixFiles, challengeFile) {
  const sandbox = await createSandbox();
  try {
    await writeFiles(sandbox, [...fixFiles, challengeFile]);
    const tally = {};
    for (let i = 0; i < CHALLENGE_RUNS; i++) {
      const run = await runTestDetail(sandbox, challengeFile.path);
      const results = run.results ?? { "all challenge tests": run.passed };
      // A file that crashes before reporting any test fails as a whole.
      if (!run.passed && Object.values(results).every(Boolean)) results["challenge file runs cleanly"] = false;
      for (const [name, ok] of Object.entries(results)) tally[name] = (tally[name] ?? true) && ok;
    }
    return tally;
  } finally {
    await destroySandbox(sandbox);
  }
}

function challengeCheck(challenge, trialId) {
  if (!challenge.ok) return { ok: false, error: challenge.error, tests: [] };
  const mine = challenge.results[trialId] ?? {};
  const tests = challenge.fair.map((name) => ({ name, passed: mine[name] === true, failsOnOriginal: challenge.original[name] === false }));
  return {
    ok: tests.length > 0 && tests.every((t) => t.passed),
    author: challenge.author,
    file: challenge.file,
    source: challenge.source,
    tests,
    unfair: challenge.unfair,
    error: tests.length ? null : "No usable challenge tests",
  };
}

// --- Second opinion -----------------------------------------------------------

// Two judges from different labs, both on the team's own plan, never the
// model that wrote the fix: the best Sonnet (Opus for Sonnet's fixes) and the
// top OpenAI model (GPT-6.1 Sol for GPT-6 Astra's). Claude Code and Codex are
// asked directly when they're signed in here; otherwise each judge answers
// over MCP (list_reviews / get_review / submit_review in mcp.js). Both must pass.
const JUDGES = {
  anthropic: [{ id: "claude-sonnet-5-5", alias: "sonnet" }, { id: "claude-opus-5-5", alias: "opus" }],
  openai: [{ id: "gpt-6-astra" }, { id: "gpt-6.1-sol" }],
};

const judgesFor = (model) => Object.entries(JUDGES).map(([provider, [best, backup]]) => ({ provider, ...(model === best.id ? backup : best) }));

async function startReview(pain, trial, diff, { code, options }) {
  const prompt = reviewPrompt(pain, trial, diff, { code, options });
  reviewPrompts.set(trial.id, prompt);
  const judges = judgesFor(trial.model).map((j) => ({ provider: j.provider, model: j.id, alias: j.alias ?? null, name: MODELS[j.id].name, status: "waiting" }));
  const ask = {
    anthropic: (j) => askClaude(prompt, { model: j.alias, timeout: 8 * 60_000 }).then((a) => a && [a, "Claude Code"]),
    openai: (j) => askCodex(prompt, { model: j.model, timeout: 8 * 60_000 }).then((a) => a && [a, "Codex"]),
  };
  await Promise.all(
    judges.map(async (j) => {
      const got = await ask[j.provider](j);
      if (got) recordVerdict(j, parseVerdict(got[0].text), got[1]);
    }),
  );
  return { ok: null, filesSeen: code.length, judges };
}

function reviewPrompt(pain, trial, diff, { code, options }) {
  const mine = new Set(trial.files.map((f) => clean(f.path)));
  const othersTouched = [...new Set(options.filter((o) => o.trial.id !== trial.id).flatMap((o) => o.trial.files.map((f) => clean(f.path))))].filter((p) => !mine.has(p));
  return [
    `You are reviewing a fix for the failing test ${pain.testFile}, written by another AI model. Be strict.`,
    `The test failed ${pain.failures}/${pain.runs} runs before the fix.`,
    pain.sampleFailure ? `Sample failure:\n${pain.sampleFailure}` : "",
    `The change (unified diff):\n${diffText(diff)}`,
    othersTouched.length ? `Other models' verified fixes also changed ${othersTouched.join(", ")}. This fix didn't. Decide whether those files still contain a bug this fix only avoids.` : "",
    `All the shared code WITH this fix applied:\n\n${dump(withFix(code, trial.files))}`,
    "Pass it only if every root cause behind the failures is fixed. Fail it if it hides a symptom (longer sleeps, retries, looser assertions, swallowed errors) or works around a bug instead of fixing it, leaving broken code that the test just doesn't reach.",
    'Reply with only JSON: {"verdict": "pass" | "fail", "summary": "one or two sentences", "remaining_bugs": ["file: what is still broken", ...], "risks": ["short risk", ...]}',
  ].join("\n\n");
}

function parseVerdict(text) {
  let parsed = null;
  try {
    parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  } catch {}
  return {
    verdict: parsed?.verdict === "pass" ? "pass" : "fail",
    summary: String(parsed?.summary ?? `Unreadable review, counted as a fail: ${text}`),
    remaining: Array.isArray(parsed?.remaining_bugs) ? parsed.remaining_bugs : [],
    risks: Array.isArray(parsed?.risks) ? parsed.risks : [],
  };
}

function recordVerdict(judge, { verdict, summary, remaining, risks }, via) {
  Object.assign(judge, {
    status: "done",
    verdict,
    ok: verdict === "pass",
    summary: String(summary).slice(0, 2000),
    remaining: remaining.map(String).slice(0, 20),
    risks: risks.map(String).slice(0, 20),
    via,
    at: new Date().toISOString(),
  });
}

// Both judges answered: the check passes only if both passed.
function finishReview(review) {
  const { judges } = review;
  review.ok = judges.every((j) => j.ok);
  review.verdict = review.ok ? "pass" : "fail";
  review.reviewer = judges.map((j) => j.name).join(" + ");
  review.summary = judges.map((j) => `${j.name}: ${j.summary}`).join(" ");
  review.remaining = judges.flatMap((j) => j.remaining.map((r) => `${r} (${j.name})`));
  review.risks = judges.flatMap((j) => j.risks);
}

// Reviews waiting on a judge, for the MCP's list_reviews.
export function pendingReviews() {
  return Object.values(state.proofs)
    .filter((p) => p.status === "awaiting_review")
    .map((p) => ({
      trialId: p.trialId,
      testFile: p.testFile,
      fixBy: p.name,
      needs: p.checks.review.judges.filter((j) => j.status === "waiting").map((j) => ({ model: j.model, name: j.name })),
    }));
}

// Everything a judge needs to review one fix (MCP get_review).
export function reviewRequest(trialId) {
  const proof = state.proofs[trialId];
  if (proof?.status !== "awaiting_review" || !reviewPrompts.has(trialId)) throw httpError(404, `No review is waiting for ${trialId}. Call list_reviews.`);
  return { ...pendingReviews().find((r) => r.trialId === trialId), instructions: reviewPrompts.get(trialId) };
}

// A judge's verdict over MCP. When the last judge answers the proof finishes,
// and if the fix isn't proven the next-best model's fix is checked.
export function submitReview({ trialId, model, verdict, summary, remaining = [], risks = [], via }) {
  const proof = state.proofs[trialId];
  if (proof?.status !== "awaiting_review") throw httpError(404, `No review is waiting for ${trialId}. Call list_reviews.`);
  const waiting = proof.checks.review.judges.filter((j) => j.status === "waiting");
  const judge = waiting.find((j) => j.model === model);
  if (!judge) {
    throw httpError(400, `This review needs ${waiting.map((j) => `${j.name} (model "${j.model}")`).join(" or ")}. Switch to that model and submit again, tagged with its id.`);
  }
  recordVerdict(judge, { verdict, summary, remaining, risks }, via);
  emit("proof.review", { message: `Proof: ${judge.name} ${judge.ok ? "passed" : "failed"} ${proof.name}'s fix for ${proof.testFile}${via ? ` (via ${via})` : ""}` });
  const left = proof.checks.review.judges.filter((j) => j.status === "waiting");
  if (!left.length) {
    finishProof(proof, state.pains.find((p) => p.id === proof.painId));
    if (proof.verdict !== "safe") proveProblem(proof.painId).catch((err) => emit("error", { message: `Proof report failed: ${err.message}` }));
  }
  return { trialId, judge: judge.name, recorded: judge.verdict, proofStatus: proof.status, verdict: proof.verdict, stillWaitingFor: left.map((j) => j.name) };
}

// --- Verdict ------------------------------------------------------------------

// Pass or fail: safe only if every check passed.
function score(proof) {
  const c = proof.checks;
  const passed = CHECKS.filter((k) => c[k]?.ok === true);
  proof.score = Math.round((100 * passed.length) / CHECKS.length);
  proof.breakdown = Object.fromEntries(CHECKS.map((k) => [k, c[k]?.ok === true]));

  if (!c.stress.ok) proof.failures.push(`failed ${c.stress.total - c.stress.passed}/${c.stress.total} stress runs`);
  if (!c.suite.ok) proof.failures.push(c.suite.stableOk ? "made an already-flaky test worse" : "broke other tests");
  if (!c.rules.ok) proof.failures.push("broke Shoal's rules");
  if (!c.challenge.ok) {
    const failed = c.challenge.tests.filter((t) => !t.passed);
    proof.failures.push(failed.length ? `failed challenge test${failed.length > 1 ? "s" : ""}: ${failed.map((t) => `"${t.name}"`).join(", ")}` : c.challenge.error);
  }
  for (const j of c.review.judges.filter((j) => !j.ok)) {
    proof.failures.push(`${j.name}'s review: ${j.remaining.length ? `still broken: ${j.remaining.join("; ")}` : "not every root cause is fixed"}`);
  }
  proof.verdict = proof.failures.length ? "not_proven" : "safe";
}

// --- Diff ---------------------------------------------------------------------

async function diffFiles(files) {
  const out = [];
  for (const f of files) {
    const before = (await readRepoFile(clean(f.path)).catch(() => "")).split(/\r?\n/);
    const after = String(f.content).split(/\r?\n/);
    const ops = lineDiff(before, after);
    out.push({
      path: f.path,
      added: ops.filter((o) => o.type === "+").length,
      removed: ops.filter((o) => o.type === "-").length,
      hunks: hunks(ops),
    });
  }
  return { files: out, added: out.reduce((s, f) => s + f.added, 0), removed: out.reduce((s, f) => s + f.removed, 0) };
}

// Longest-common-subsequence line diff; fine for source-file sizes.
function lineDiff(a, b) {
  if (a.length * b.length > 4_000_000) return [...a.map((text) => ({ type: "-", text })), ...b.map((text) => ({ type: "+", text }))];
  const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) ops.push({ type: " ", text: a[i++], line: j++ + 1 });
    else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ type: "-", text: a[i++] });
    else ops.push({ type: "+", text: b[j], line: ++j });
  }
  while (i < a.length) ops.push({ type: "-", text: a[i++] });
  while (j < b.length) ops.push({ type: "+", text: b[j], line: ++j });
  return ops;
}

// Changed lines with 2 lines of context around them.
function hunks(ops, context = 2) {
  const keep = new Set();
  ops.forEach((o, k) => {
    if (o.type !== " ") for (let d = -context; d <= context; d++) keep.add(k + d);
  });
  const out = [];
  let current = null;
  ops.forEach((o, k) => {
    if (!keep.has(k)) return (current = null);
    if (!current) out.push((current = { lines: [] }));
    current.lines.push({ type: o.type, text: o.text });
  });
  return out;
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

const clean = (p) => String(p).replace(/\\/g, "/").replace(/^\.\//, "");

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
