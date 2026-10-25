// Verifier: the only thing that decides whether an agent gets paid.
// Rules:
//   0. Shared scope: patches may only touch folders the team shared.
//   1. Protected scope: test files, test folders, CI config and package
//      manifests can't be touched. Tests are the spec; editing them (retries,
//      longer sleeps, looser asserts, deleting the test) is tampering.
//   2. The target test file must pass VERIFY_RUNS times in a row.
//   3. Every test file that was stable at scan time must still pass (no
//      regressions). Other known-flaky files are skipped so one agent's fix
//      isn't blamed for a different bug.
import { createSandbox, destroySandbox, isTestFile, runTestMany, runTestOnce, writeFiles } from "./repo.js";
import { emit } from "./events.js";
import { MANIFESTS } from "./stack.js";
import { inScope } from "./scope.js";
import { runHiddenTests } from "./hidden-tests.js";

export const VERIFY_RUNS = 10;

export async function verify({ bountyId, agentId, testFile, files, stableTestFiles = [] }) {
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
    emit("verify.started", { bountyId, agentId, message: `Running ${testFile} ${VERIFY_RUNS}x with ${agentId}'s patch` });

    const runs = await runTestMany(sandbox, testFile, VERIFY_RUNS);
    const passes = runs.filter((r) => r.passed).length;
    emit("verify.runs", {
      bountyId,
      agentId,
      results: runs.map((r) => r.passed),
      message: `${passes}/${VERIFY_RUNS} green`,
    });
    if (passes < VERIFY_RUNS) {
      const reason = `${testFile} still failed ${VERIFY_RUNS - passes}/${VERIFY_RUNS} runs.`;
      emit("verify.rejected", { bountyId, agentId, reason, message: `${agentId} rejected: still flaky` });
      return { passed: false, reason, runs, failureLog: runs.find((r) => !r.passed)?.log };
    }

    const hidden = await runHiddenTests(sandbox, testFile);
    if (!hidden.ok) {
      const reason = "Failed private verification checks.";
      emit("verify.rejected", { bountyId, agentId, reason, message: `${agentId} rejected: private checks failed` });
      return { passed: false, reason, runs, hidden };
    }

    const others = stableTestFiles.filter((f) => f !== testFile);
    if (others.length) {
      const suite = await runTestOnce(sandbox, others);
      if (!suite.passed) {
        const reason = `Fix broke previously stable tests (${others.join(", ")}).`;
        emit("verify.rejected", { bountyId, agentId, reason, message: `${agentId} rejected: regression` });
        return { passed: false, reason, runs, failureLog: suite.log };
      }
    }

    const privateNote = hidden.found ? `, ${hidden.found} private check${hidden.found === 1 ? "" : "s"} passed` : "";
    emit("verify.passed", { bountyId, agentId, message: `${agentId}'s fix verified: ${VERIFY_RUNS}/${VERIFY_RUNS} green${privateNote}, no regressions` });
    return { passed: true, runs, hidden };
  } finally {
    await destroySandbox(sandbox);
  }
}

const PROTECTED = [
  /(^|\/)(test|tests|__tests__|spec|__mocks__|fixtures|testdata)\//, // test folders, any language
  /^\.github\/|^\.circleci\/|(^|\/)(\.gitlab-ci\.yml|azure-pipelines\.yml|Jenkinsfile|\.travis\.yml)$/, // CI config
  ...MANIFESTS, // package manifests, lockfiles and test-runner config in every language (stack.js)
];

// Agents can read these (if shared) but never change them.
export const isProtected = (p) => isTestFile(p) || PROTECTED.some((re) => re.test(p));

function isAllowedPath(p) {
  const normalized = p.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) return false;
  return !isProtected(normalized);
}
