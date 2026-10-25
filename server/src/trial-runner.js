// Runs the trial round for the team, so nobody has to touch a terminal: uses
// every AI app signed in on this machine, at the same time. Claude Code runs
// Haiku, Sonnet and Opus (claude-runner.js); Codex runs the OpenAI models
// (codex-runner.js). Both only get Shoal's MCP tools, run on the team's own
// plans, and stop when they're done (or on Stop / timeout). Then a report
// says which model did best, and proof reports start for the winners.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { emit } from "./events.js";
import { state } from "./store.js";
import { overallPick, recordModelCosts, scoreboard, trialSummary } from "./trials.js";
import { proveProblem } from "./proof.js";
import { detectClaude, killTree, startClaudeTrial } from "./claude-runner.js";
import { detectCodex, startCodexTrial } from "./codex-runner.js";

const RUN_TIMEOUT_MS = 20 * 60_000;

const RUNNERS = {
  claude: { name: "Claude Code", detect: detectClaude, start: startClaudeTrial },
  codex: { name: "Codex", detect: detectCodex, start: startCodexTrial },
};

let current = null; // child processes of the run in progress

export function trialRun() {
  return state.trialRun;
}

// Which AI apps are installed and signed in here.
export async function trialRunners({ fresh = false } = {}) {
  const entries = await Promise.all(Object.entries(RUNNERS).map(async ([id, r]) => [id, await r.detect({ fresh })]));
  return Object.fromEntries(entries);
}

// use: which runners to use ("claude", "codex"); default every one that's ready.
export async function startTrialRun(baseUrl, { use } = {}) {
  if (current) throw httpError(409, "A trial run is already in progress");
  const found = await trialRunners({ fresh: true });
  const wanted = use?.length ? use.filter((id) => RUNNERS[id]) : Object.keys(RUNNERS);
  const ready = wanted.filter((id) => found[id].installed && found[id].loggedIn);
  if (!ready.length) {
    const why = wanted.map((id) => `${RUNNERS[id].name} ${found[id].installed ? "isn't signed in" : "isn't installed"}`).join(", ");
    throw httpError(400, `No AI app is ready to run trials (${why}). Install and sign in to Claude Code or Codex first.`);
  }
  const flaky = state.pains.filter((p) => !p.healthy);
  if (!flaky.length) throw httpError(400, "No flaky tests to try. Scan the repo first.");
  // Every flaky test is tried; none is skipped. If any test imports code the
  // team didn't share, stop and say so: agents must see all the code.
  const blind = flaky.filter((p) => p.hiddenSources?.length);
  if (blind.length) {
    const files = [...new Set(blind.flatMap((p) => p.hiddenSources))];
    throw httpError(400, `Agents can't see the code these tests need (${files.join(", ")}). Share them with agents first.`);
  }
  const problems = flaky;

  const dir = await mkdtemp(path.join(tmpdir(), "shoal-trial-"));
  const run = (state.trialRun = {
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    runners: ready,
    problems: problems.map((p) => p.testFile),
    progress: [],
    // Final message per runner or model, and why any of them failed.
    summaries: {},
    errors: {},
    summary: null,
    claudeCost: null,
    // $ each model spent, from its token usage (what the API would charge).
    spentByModel: {},
    report: null,
    error: null,
  });
  const note = (message) => {
    run.progress.push({ at: new Date().toISOString(), message });
    emit("trials.progress", { message });
  };

  let started;
  try {
    started = await Promise.all(ready.map((id) => RUNNERS[id].start({ problems, baseUrl, dir, run, note, timeout: RUN_TIMEOUT_MS })));
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    run.status = "failed";
    run.error = err.message;
    finish(run);
    throw err;
  }
  current = started.flatMap((s) => s.children);

  Promise.all(started.map((s) => s.done)).then(async (results) => {
    current = null;
    await rm(dir, { recursive: true, force: true });
    const failed = results.map((r, i) => ({ ...r, runner: RUNNERS[ready[i]].name })).filter((r) => !r.ok);
    if (run.status === "running") {
      // Done if at least one runner finished; the others' errors are shown.
      run.status = failed.length < results.length ? "done" : Date.now() - Date.parse(run.startedAt) >= RUN_TIMEOUT_MS ? "timed_out" : "failed";
    }
    if (failed.length) run.error = failed.map((r) => `${r.runner}: ${r.error}`).join(" · ").slice(0, 800);
    finish(run);
  });
  return run;
}

export function stopTrialRun() {
  if (!current) throw httpError(400, "No trial run in progress");
  state.trialRun.status = "stopped";
  current.forEach(killTree);
}

function finish(run) {
  run.finishedAt = new Date().toISOString();
  run.summary = Object.values(run.summaries).filter(Boolean).join("\n\n") || null;
  recordModelCosts(run.spentByModel, run.problems.length);
  const pick = overallPick();
  const winner = pick && { model: pick.model, name: pick.name, fixed: pick.fixed, quality: pick.quality, costPerFix: pick.costPerFix, reason: pick.reason };
  run.report = { scoreboard: scoreboard(), problems: trialSummary(), winner };
  const ended = { done: "finished", stopped: "stopped", timed_out: "timed out", failed: "failed" }[run.status];
  emit(run.status === "done" ? "trials.done" : "trials.error", {
    message: `Model trial ${ended}${winner ? `: best value is ${winner.name} (quality ${winner.quality}, ~$${winner.costPerFix.toFixed(4)} per fix)` : ": no model got a fix verified"}`,
  });
  // Straight on to the proof report for every test that got a verified fix.
  (async () => {
    for (const p of run.report.problems.filter((p) => p.recommended)) await proveProblem(p.painId);
  })().catch((err) => emit("error", { message: `Proof report failed: ${err.message}` }));
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
