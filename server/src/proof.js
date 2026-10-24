// Proof report: evidence that a model's fix is reliable, shown before the
// team spends anything. For each flaky test it checks the optimizer's pick:
//   stress test   50 runs: 40 in parallel batches (load) + 10 inside the full
//                 suite in shuffled order. Every run must pass.
//   full suite    every previously stable test still passes with the fix.
//   code diff     exactly which lines would land.
//   rules         no test/CI/manifest edits, only shared files, no secrets.
//   second opinion  a different model reviews the diff: root cause or a
//                 symptom patch (sleep, retry, looser assert)? Runs through
//                 Claude Code on the team's plan; skipped if it isn't there.
//   track record  how this model's trials have gone on this repo.
// These add up to a trust score. Hard failures (a red run, a regression, a
// rule broken, a symptom patch) mean "Not proven" whatever the score. If the
// cheapest pick isn't proven, the next-best model is checked, so the model
// the team can buy is always both good value and proven.
import { createSandbox, destroySandbox, readRepoFile, runTestMany, runTestOnce, writeFiles } from "./repo.js";
import { inScope, isSecret } from "./scope.js";
import { isProtected } from "./verifier.js";
import { emit } from "./events.js";
import { state } from "./store.js";
import { MODELS, rankedOptions } from "./trials.js";
import { askClaude } from "./claude-runner.js";

const STRESS_PARALLEL = 40;
const STRESS_MIXED = 10;
const BATCH = 10;
const SAFE_SCORE = 80;
const WEIGHTS = { stress: 30, suite: 20, rules: 15, review: 20, record: 15 };

const running = new Set();

// Proof status for one problem: every candidate checked so far and the first
// one that's proven (the one the team can buy).
export function proofFor(painId) {
  const proofs = Object.values(state.proofs).filter((p) => p.painId === painId).sort((a, b) => a.rank - b.rank);
  return {
    checking: running.has(painId),
    candidates: proofs,
    proven: proofs.find((p) => p.verdict === "safe") ?? null,
  };
}

// Checks candidates best-value first until one is proven.
export async function proveProblem(painId) {
  if (running.has(painId)) return;
  const pain = state.pains.find((p) => p.id === painId);
  const options = rankedOptions(painId);
  if (!pain || !options.length) return;
  running.add(painId);
  try {
    for (const [rank, option] of options.entries()) {
      const existing = state.proofs[option.trial.id];
      if (existing?.status === "done") {
        if (existing.verdict === "safe") return;
        continue;
      }
      const proof = await prove(pain, option, rank);
      if (proof.verdict === "safe") return;
      if (options[rank + 1]) {
        emit("proof.next", { message: `${option.name}'s fix isn't proven for ${pain.testFile}; checking ${options[rank + 1].name} next` });
      }
    }
    emit("proof.none", { message: `No model's fix for ${pain.testFile} is proven yet. Nothing is offered for sale.` });
  } finally {
    running.delete(painId);
  }
}

async function prove(pain, option, rank) {
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
  emit("proof.started", { message: `Proof: checking ${proof.name}'s fix for ${pain.testFile} (50-run stress test, full suite, rules, review)` });

  proof.checks.rules = checkRules(trial.files);
  proof.checks.diff = await diffFiles(trial.files);
  proof.checks.record = trackRecord(trial.model);

  const sandbox = await createSandbox();
  try {
    await writeFiles(sandbox, trial.files);
    proof.checks.stress = await stressTest(sandbox, pain);
    proof.checks.suite = await fullSuite(sandbox, pain);
  } finally {
    await destroySandbox(sandbox);
  }
  proof.checks.review = await secondOpinion(pain, trial, proof.checks.diff);

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

async function fullSuite(dir, pain) {
  const others = state.pains.filter((p) => p.healthy && p.testFile !== pain.testFile).map((p) => p.testFile);
  const skipped = state.pains.filter((p) => !p.healthy && p.testFile !== pain.testFile).map((p) => p.testFile);
  if (!others.length) return { ok: true, files: [], skipped, note: "No other stable tests in the shared folders" };
  const run = await runTestOnce(dir, others);
  return { ok: run.passed, files: others, skipped, failureLog: run.passed ? null : run.log };
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

// A different model reviews the change. Sonnet reviews by default; Opus
// reviews Sonnet's fixes, so nobody grades their own work.
async function secondOpinion(pain, trial, diff) {
  const reviewer = trial.model === "claude-sonnet-5-5" ? { alias: "opus", id: "claude-opus-5-5" } : { alias: "sonnet", id: "claude-sonnet-5-5" };
  const test = await readRepoFile(pain.testFile).catch(() => "");
  const prompt = [
    `You are reviewing a fix for the flaky test ${pain.testFile}, written by another AI model. Be skeptical.`,
    `The test failed ${pain.failures}/${pain.runs} runs before the fix.`,
    pain.sampleFailure ? `Sample failure:\n${pain.sampleFailure.slice(-1200)}` : "",
    `Test file:\n${test}`,
    `The change (unified diff):\n${diff.files.map((f) => `--- ${f.path}\n${f.hunks.map((h) => h.lines.map((l) => l.type + l.text).join("\n")).join("\n...\n")}`).join("\n\n")}`,
    `Each changed file in full, after the fix:\n${trial.files.map((f) => `--- ${f.path} ---\n${String(f.content).slice(0, 8000)}`).join("\n\n")}`,
    "Does it fix the real cause, or does it hide the symptom (longer sleeps, retries, looser assertions, catching and ignoring errors)?",
    'Reply with only JSON: {"verdict": "root_cause" | "symptom_patch" | "unclear", "summary": "one or two sentences", "risks": ["short risk", ...]}',
  ].join("\n\n");
  const answer = await askClaude(prompt, { model: reviewer.alias });
  if (!answer) return { ok: null, skipped: true, reviewer: MODELS[reviewer.id].name, summary: "Skipped: Claude Code isn't available or signed in on this computer" };
  let parsed = null;
  try {
    parsed = JSON.parse(answer.text.slice(answer.text.indexOf("{"), answer.text.lastIndexOf("}") + 1));
  } catch {}
  const verdict = ["root_cause", "symptom_patch", "unclear"].includes(parsed?.verdict) ? parsed.verdict : "unclear";
  return {
    ok: verdict === "root_cause" ? true : verdict === "symptom_patch" ? false : null,
    reviewer: MODELS[reviewer.id].name,
    verdict,
    summary: String(parsed?.summary ?? answer.text).slice(0, 500),
    risks: (Array.isArray(parsed?.risks) ? parsed.risks : []).slice(0, 4).map((r) => String(r).slice(0, 160)),
  };
}

// --- Score --------------------------------------------------------------------

function score(proof) {
  const c = proof.checks;
  const earned = {
    stress: c.stress.ok ? WEIGHTS.stress : 0,
    suite: c.suite.ok ? WEIGHTS.suite : 0,
    rules: c.rules.ok ? WEIGHTS.rules : 0,
    review: c.review.skipped ? null : c.review.verdict === "root_cause" ? WEIGHTS.review : c.review.verdict === "unclear" ? WEIGHTS.review / 2 : 0,
    record: Math.round(WEIGHTS.record * c.record.rate),
  };
  // A skipped review doesn't count for or against: score over what ran.
  const counted = Object.entries(earned).filter(([, v]) => v !== null);
  const max = counted.reduce((s, [k]) => s + WEIGHTS[k], 0);
  proof.score = Math.round((100 * counted.reduce((s, [, v]) => s + v, 0)) / max);
  proof.breakdown = Object.fromEntries(Object.entries(earned).map(([k, v]) => [k, { earned: v, max: WEIGHTS[k] }]));

  if (!c.stress.ok) proof.failures.push(`failed ${c.stress.total - c.stress.passed}/${c.stress.total} stress runs`);
  if (!c.suite.ok) proof.failures.push("broke previously passing tests");
  if (!c.rules.ok) proof.failures.push("broke Shoal's rules");
  if (c.review.verdict === "symptom_patch") proof.failures.push(`${c.review.reviewer} says it hides the symptom`);
  if (!proof.failures.length && proof.score < SAFE_SCORE) proof.failures.push(`trust score ${proof.score} is under ${SAFE_SCORE}`);
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

const clean = (p) => String(p).replace(/\\/g, "/").replace(/^\.\//, "");

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
