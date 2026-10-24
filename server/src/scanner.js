// Pain Graph scanner: runs every test file repeatedly in a sandbox and turns
// flake rates into a ranked, priced list of pain points.
import { createSandbox, destroySandbox, listTestFiles, runTestMany, sourcesForTest, WORKSPACE } from "./repo.js";
import { emit } from "./events.js";
import { state, newId } from "./store.js";
import { inScope, isSecret } from "./scope.js";

const RUNS_PER_FILE = 10;
const MAX_TEST_FILES = 20;
// Rough cost model, shown in the UI so judges can see the math.
const CI_RUNS_PER_WEEK = 150;
const HOURS_LOST_PER_FLAKE = 0.25; // rerun + "is it me?" investigation
const DOLLARS_PER_DEV_HOUR = 25;

export async function scan() {
  emit("scan.started", { message: `Running each test file ${RUNS_PER_FILE}x to detect flakes` });
  const sandbox = await createSandbox();
  try {
    // Only tests inside the folders the team shared with agents.
    const allTestFiles = (await listTestFiles(sandbox)).filter(inScope);
    const testFiles = allTestFiles.slice(0, MAX_TEST_FILES);
    if (allTestFiles.length > MAX_TEST_FILES) {
      emit("scan.warning", { message: `Repo has ${allTestFiles.length} test files; scanning the first ${MAX_TEST_FILES}` });
    }
    if (!testFiles.length) emit("scan.warning", { message: "No *.test.* or *.spec.* files found in the shared folders" });

    // One file at a time (its runs in parallel) so big repos don't spawn
    // hundreds of test processes at once.
    const results = [];
    for (const testFile of testFiles) {
      const runs = await runTestMany(sandbox, testFile, RUNS_PER_FILE);
      const failures = runs.filter((r) => !r.passed).length;
      const sampleFailure = runs.find((r) => !r.passed)?.log ?? null;
      results.push({ testFile, failures, runs: runs.length, sampleFailure });
      emit("scan.file", { testFile, failures, message: `${testFile}: ${failures}/${runs.length} failed` });
    }

    const pains = [];
    for (const r of results) {
      const flakeRate = r.failures / r.runs;
      const existing = state.pains.find((p) => p.testFile === r.testFile);
      const hoursPerWeek = round1(flakeRate * CI_RUNS_PER_WEEK * HOURS_LOST_PER_FLAKE);
      const pain = {
        id: existing?.id ?? newId("pain"),
        kind: "flaky-test",
        title: `Flaky tests in ${r.testFile}`,
        testFile: r.testFile,
        ...(await splitSources(r.testFile, sandbox)),
        flakeRate,
        failures: r.failures,
        runs: r.runs,
        hoursPerWeek,
        suggestedReward: Math.max(50, Math.round((hoursPerWeek * DOLLARS_PER_DEV_HOUR) / 10) * 10),
        sampleFailure: r.sampleFailure,
        healthy: r.failures === 0,
        scannedAt: new Date().toISOString(),
      };
      pains.push(pain);
    }
    pains.sort((a, b) => b.hoursPerWeek - a.hoursPerWeek);
    state.pains = pains;

    const total = round1(pains.reduce((s, p) => s + p.hoursPerWeek, 0));
    emit("scan.completed", {
      message: `Found ${pains.filter((p) => !p.healthy).length} flaky test files costing ~${total} dev-hours/week`,
      pains: pains.map(({ sampleFailure, ...p }) => p),
      totalHoursPerWeek: total,
    });
    return pains;
  } finally {
    await destroySandbox(sandbox);
  }
}

const round1 = (n) => Math.round(n * 10) / 10;

// The files a test imports, split into the ones agents can see and the ones
// the team didn't share. Hidden ones mean agents can't fix that test.
export async function splitSources(testFile, dir) {
  const all = await sourcesForTest(testFile, dir).catch(() => []);
  return { sourceFiles: all.filter(inScope), hiddenSources: all.filter((p) => !inScope(p) && !isSecret(p)) };
}

// After the shared folders change, recompute what each test's agents can see
// without re-running the tests.
export async function refreshSources() {
  for (const pain of state.pains) Object.assign(pain, await splitSources(pain.testFile, WORKSPACE));
}
