// Verifier: the only thing that decides whether an agent gets paid.
// Rules:
//   0. Shared scope: patches may only touch folders the team shared.
//   1. Protected scope: test files, test folders, CI config and package
//      manifests can't be touched. Tests are the spec; editing them (retries,
//      longer sleeps, looser asserts, deleting the test) is tampering.
//   2. The target test file must pass verifyRuns(failure rate) times in a row:
//      enough that a fix which changes nothing would get through at most 5%
//      of the time (see verifyRuns).
//   3. Every test file that was stable at scan time must still pass (no
//      regressions). Other known-flaky files are skipped so one agent's fix
//      isn't blamed for a different bug, and so is a "stable" file that
//      fails without the fix too (the scan is out of date, e.g. a bought fix
//      it was taken with was clawed back): only a file the fix itself breaks
//      counts, and the rejection names just those files.
import { createSandbox, destroySandbox, isTestFile, runTestMany, runTestOnce, writeFiles } from "./repo.js";
import { emit } from "./events.js";
import { MANIFESTS } from "./stack.js";
import { inScope } from "./scope.js";

export const VERIFY_RUNS = 10;
const MAX_VERIFY_RUNS = 150;
const BATCH = 10;
// Accept a fix that changes nothing at most this often.
const MISS_RATE = 0.05;

// How many green runs in a row a fix needs. A test that failed at rate f
// passes n runs with no fix at all (1 - f)^n of the time; a flat 10 lets a
// 10%-flaky test through 35% of the time. So n = ln(0.05) / ln(1 - f):
// 10 at 30% (the minimum), 29 at 10%, 59 at 5%, at most 150.
export function verifyRuns(flakeRate) {
  const f = Number(flakeRate);
  if (!(f > 0) || f >= 1) return VERIFY_RUNS;
  return Math.min(MAX_VERIFY_RUNS, Math.max(VERIFY_RUNS, Math.ceil(Math.log(MISS_RATE) / Math.log(1 - f))));
}

// flakeRate: the test's failure rate at scan time (pain.flakeRate).
export async function verify({ bountyId, agentId, testFile, files, stableTestFiles = [], flakeRate = null }) {
  const outOfScope = files.filter((f) => !inScope(f.path));
  if (outOfScope.length) {
    const reason = `Patch touches files the team didn't share (${outOfScope.map((f) => f.path).join(", ")}).`;
    emit("verify.rejected", { bountyId, agentId, reason, message: `${agentId} rejected: outside shared scope` });
    return { passed: false, reason, runs: [] };
  }

  const tampered = files.filter((f) => !isAllowedPath(f.path));
  if (tampered.length) {
    const reason = `Patch modifies protected files (${tampered.map((f) => f.path).join(", ")}). Tests, CI config and manifests can't change.`;
    emit("verify.rejected", { bountyId, agentId, reason, message: `${agentId} rejected: tampering with tests` });
    return { passed: false, reason, runs: [] };
  }

  const sandbox = await createSandbox();
  try {
    await writeFiles(sandbox, files);
    const needed = verifyRuns(flakeRate);
    emit("verify.started", { bountyId, agentId, message: `Running ${testFile} up to ${needed}x with ${agentId}'s patch` });

    // In batches, stopping at the first batch with a failure: no point
    // running the rest once the fix has failed.
    const runs = [];
    while (runs.length < needed && runs.every((r) => r.passed)) runs.push(...(await runTestMany(sandbox, testFile, Math.min(BATCH, needed - runs.length))));
    const passes = runs.filter((r) => r.passed).length;
    emit("verify.runs", {
      bountyId,
      agentId,
      results: runs.map((r) => r.passed),
      message: `${passes}/${runs.length} green${runs.length < needed ? ` (stopped at the first failure; ${needed} needed)` : ""}`,
    });
    if (passes < runs.length || runs.length < needed) {
      const reason = `${testFile} still failed ${runs.length - passes} of ${runs.length} runs (${needed} green in a row needed).`;
      emit("verify.rejected", { bountyId, agentId, reason, message: `${agentId} rejected: still flaky` });
      return { passed: false, reason, runs, failureLog: runs.find((r) => !r.passed)?.log };
    }

    const others = stableTestFiles.filter((f) => f !== testFile);
    let alreadyFailing = [];
    if (others.length && !(await runTestOnce(sandbox, others)).passed) {
      const { broken, before, log } = await regressions(sandbox, others);
      alreadyFailing = before;
      if (before.length) emit("verify.note", { bountyId, agentId, message: `${before.join(", ")} also fail${before.length === 1 ? "s" : ""} without any fix, so ${before.length === 1 ? "it isn't" : "they aren't"} counted against ${agentId}. Rescan to update which tests are stable.` });
      if (broken.length) {
        const reason = `Fix broke previously stable test${broken.length === 1 ? "" : "s"}: ${broken.join(", ")}.`;
        emit("verify.rejected", { bountyId, agentId, reason, message: `${agentId} rejected: regression` });
        return { passed: false, reason, runs, failureLog: log };
      }
    }

    emit("verify.passed", { bountyId, agentId, message: `${agentId}'s fix verified: ${needed}/${needed} green, no regressions` });
    return { passed: true, runs, alreadyFailing };
  } finally {
    await destroySandbox(sandbox);
  }
}

// Which stable files failed with the fix, split into the ones the fix broke
// and the ones that fail without it too (checked twice on the unpatched
// code, so a one-off flake there doesn't excuse a real regression).
async function regressions(sandbox, files) {
  const failing = [];
  let log = "";
  for (const f of files) {
    const r = await runTestOnce(sandbox, f);
    if (!r.passed) failing.push(f), (log ||= r.log);
  }
  if (!failing.length) return { broken: [], before: [], log };
  const clean = await createSandbox();
  try {
    const before = [];
    for (const f of failing) {
      const [a, b] = [await runTestOnce(clean, f), await runTestOnce(clean, f)];
      if (!a.passed && !b.passed) before.push(f);
    }
    return { broken: failing.filter((f) => !before.includes(f)), before, log };
  } finally {
    await destroySandbox(clean);
  }
}

const PROTECTED = [
  /(^|\/)(test|tests|__tests__|spec|__mocks__|fixtures|testdata)\//, // test folders, any language
  /^\.github\/|^\.circleci\/|(^|\/)(\.gitlab-ci\.yml|azure-pipelines\.yml|Jenkinsfile|\.travis\.yml)$/, // CI config
  ...MANIFESTS, // package manifests, lockfiles and test-runner config in every language (stack.js)
  /(^|\/)(node_modules|\.venv|venv|\.shoal-venv)\//, // installed dependencies (linked into sandboxes, see repo.js)
];

// Agents can read these (if shared) but never change them.
export const isProtected = (p) => isTestFile(p) || PROTECTED.some((re) => re.test(p));

function isAllowedPath(p) {
  const normalized = p.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) return false;
  return !isProtected(normalized);
}
