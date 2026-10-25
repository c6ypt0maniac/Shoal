// Survival window: a verified fix isn't paid for until it has held up for
// 7-14 days. The team is charged when the fix verifies, but the agent's
// payout stays pending. During the window Shoal re-measures the bounty's
// test on the current code (with whatever the team has committed since):
// after a new commit that touches the test or the code it imports (sync.js;
// at most once an hour per fix) and on a schedule. If it regresses, the
// bounty is clawed back: the team is refunded and the agent's scorecard
// takes the hit. If it holds to the end, the payout clears.
//
// Measured in a sandbox with the repo's own test runner, never with numbers
// an agent or platform reports.
import { access } from "node:fs/promises";
import path from "node:path";
import { createSandbox, destroySandbox, runTestMany, workspaceDir } from "./repo.js";
import { inRepo, isActive, refreshParked } from "./repos.js";
import { emit } from "./events.js";
import { state } from "./store.js";
import { clawBack, releasePayout } from "./bounties.js";

export const SURVIVAL_DAYS = [7, 10, 14];
export const DEFAULT_SURVIVAL_DAYS = 7;
const DAY_MS = 24 * 60 * 60_000;
// A check: CHECK_RUNS runs; any failure gets CONFIRM_RUNS more. It regressed
// if MAX_FAILURES or more of them failed (one stray failure in 30 isn't).
const CHECK_RUNS = 10;
const CONFIRM_RUNS = 20;
const MAX_FAILURES = 2;
// Commit-triggered checks per fix, at most one per this long. A relevant
// commit inside it moves the next scheduled check up to when it ends.
const COMMIT_CHECK_GAP_MS = 60 * 60_000;

// For demos and tests: SHOAL_SURVIVAL_MINUTES makes every window that long,
// and SHOAL_SURVIVAL_CHECK_MINUTES sets how often it's re-measured.
const windowMs = (days) => (Number(process.env.SHOAL_SURVIVAL_MINUTES) > 0 ? Number(process.env.SHOAL_SURVIVAL_MINUTES) * 60_000 : days * DAY_MS);
const checkEveryMs = (window) =>
  Number(process.env.SHOAL_SURVIVAL_CHECK_MINUTES) > 0 ? Number(process.env.SHOAL_SURVIVAL_CHECK_MINUTES) * 60_000 : Math.min(6 * 60 * 60_000, window / 6);

export function cleanSurvivalDays(days) {
  const n = Number(days ?? DEFAULT_SURVIVAL_DAYS);
  if (!SURVIVAL_DAYS.includes(n)) throw httpError(400, `The survival window must be ${SURVIVAL_DAYS.join(", ")} days`);
  return n;
}

// Starts the window for a bounty whose fix just verified.
export function startSurvival(bounty) {
  const now = Date.now();
  const length = windowMs(bounty.survivalDays);
  bounty.survival = {
    status: "watching",
    days: bounty.survivalDays,
    startedAt: new Date(now).toISOString(),
    endsAt: new Date(now + length).toISOString(),
    nextCheckAt: new Date(now + checkEveryMs(length)).toISOString(),
    checks: [],
  };
}

// Demo mode (SHOAL_SURVIVAL_MINUTES) also shortens windows that started before
// it was turned on, so an old 7-14 day window doesn't hold the repo hostage.
function shortenForDemo(bounty) {
  if (!(Number(process.env.SHOAL_SURVIVAL_MINUTES) > 0)) return;
  const s = bounty.survival;
  const end = Date.parse(s.startedAt) + windowMs(s.days);
  if (end >= Date.parse(s.endsAt)) return;
  s.endsAt = new Date(end).toISOString();
  if (Date.parse(s.nextCheckAt) > end) s.nextCheckAt = s.endsAt;
}

let checking = false;
export const isCheckingSurvival = () => checking;

// Re-measures every bounty in its window (or just one), then pays out the
// ones whose window has ended and claws back the ones that regressed.
// trigger: why it ran, shown with each check ("new commit", "scheduled", ...).
// changed: the files a new commit changed; then only fixes on the active
// repo whose test or imported code changed are checked (see commitDue).
export async function checkSurvivors({ trigger, bountyId = null, onlyDue = false, changed = null } = {}) {
  if (checking) return [];
  checking = true;
  const now = Date.now();
  state.bounties.filter((b) => b.status === "surviving").forEach(shortenForDemo);
  const due = (b) => !onlyDue || now >= Date.parse(b.survival.nextCheckAt) || now >= Date.parse(b.survival.endsAt);
  const watched = state.bounties.filter((b) => b.status === "surviving" && (!bountyId || b.id === bountyId) && due(b) && (!changed || commitDue(b, changed, now)));
  try {
    for (const bounty of watched) await checkOne(bounty, trigger);
    return watched.map((b) => b.id);
  } finally {
    checking = false;
  }
}

// A commit is worth a check only if it touched the fix's test or the code the
// test imports (as of the latest scan, or when the bounty was posted), and
// only once an hour: otherwise the next scheduled check comes no later than
// the end of that hour.
function commitDue(bounty, changed, now) {
  if (!isActive(bounty)) return false;
  const live = state.pains.find((p) => p.testFile === bounty.testFile);
  const watched = new Set([bounty.testFile, ...(bounty.pain?.sourceFiles ?? []), ...(live?.sourceFiles ?? [])]);
  if (!changed.some((f) => watched.has(f))) return false;
  const last = Date.parse(bounty.survival.lastCommitCheckAt ?? 0);
  if (now - last >= COMMIT_CHECK_GAP_MS) {
    bounty.survival.lastCommitCheckAt = new Date(now).toISOString();
    return true;
  }
  const soon = new Date(last + COMMIT_CHECK_GAP_MS).toISOString();
  if (soon < bounty.survival.nextCheckAt) bounty.survival.nextCheckAt = soon;
  return false;
}

async function checkOne(bounty, trigger) {
  // A bounty on a repo that isn't active: bring its copy up to date first, so
  // new commits upstream are still checked.
  await refreshParked(bounty).catch((err) => emit("survival.warning", { bountyId: bounty.id, message: `Couldn't pull new commits for ${bounty.repo?.fullName}: ${err.message}. Checking the code Shoal has.` }));
  const result = await inRepo(bounty, () => measure(bounty.testFile));
  const check = { at: new Date().toISOString(), trigger, commit: isActive(bounty) ? (state.connection.head?.sha ?? null) : null, ...result };
  bounty.survival.checks.push(check);
  emit("survival.check", {
    bountyId: bounty.id,
    message: `Survival check (${trigger}) for ${bounty.testFile}: ${result.ok ? "still fixed" : "REGRESSED"} (${result.passed}/${result.runs} runs passed)`,
  });
  if (!result.ok) return clawBack(bounty, result.reason);
  if (Date.now() >= Date.parse(bounty.survival.endsAt)) return releasePayout(bounty);
  bounty.survival.nextCheckAt = new Date(Date.now() + checkEveryMs(windowMs(bounty.survival.days))).toISOString();
}

// Runs the test on the current workspace. A test that's gone can't confirm
// the fix, so it counts as a regression too.
async function measure(testFile) {
  try {
    await access(path.join(workspaceDir(), testFile));
  } catch {
    return { ok: false, passed: 0, runs: 0, reason: `${testFile} no longer exists, so the fix can't be confirmed` };
  }
  const sandbox = await createSandbox();
  try {
    let runs = await runTestMany(sandbox, testFile, CHECK_RUNS);
    if (runs.some((r) => !r.passed)) runs = [...runs, ...(await runTestMany(sandbox, testFile, CONFIRM_RUNS))];
    const failures = runs.filter((r) => !r.passed).length;
    const ok = failures < MAX_FAILURES;
    return {
      ok,
      passed: runs.length - failures,
      runs: runs.length,
      reason: ok ? null : `${testFile} failed ${failures} of ${runs.length} runs again`,
      failureLog: runs.find((r) => !r.passed)?.log?.slice(0, 2000) ?? null,
    };
  } finally {
    await destroySandbox(sandbox);
  }
}

// Scheduled checks and payouts, once a minute. Skipped while the code is
// changing under it (a sync) or the scan/trial machinery is busy.
setInterval(() => {
  if (checking || !state.bounties.some((b) => b.status === "surviving")) return;
  checkSurvivors({ trigger: "scheduled", onlyDue: true }).catch((err) => emit("error", { message: `Survival check failed: ${err.message}` }));
}, 60_000).unref();

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
