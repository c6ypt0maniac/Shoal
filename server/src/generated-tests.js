// Shared code with no tests can't be scanned for flaky behavior, so Claude
// writes the tests. For every shared source file that no test file covers,
// Opus reads the code and writes a test file for it in the repo's own
// language and framework. The file is saved into the workspace (never pushed
// to the team's repo), marked as a Shoal-written test, and scanned like any
// other: Shoal runs it 10 times, and whatever fails or flips becomes a problem
// the models try to fix. Agents can't edit it, like every test file.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { askClaude } from "./claude-runner.js";
import { commandFor, isTestPath, NO_TESTS, testHint } from "./stack.js";
import { createSandbox, destroySandbox, getStacks, listAllFiles, runTestOnce, sourcesForTest, WORKSPACE } from "./repo.js";
import { emit } from "./events.js";
import { state } from "./store.js";
import { inScope, isSecret } from "./scope.js";

const MAX_FILES_PER_STACK = 6;
const MAX_FILE_BYTES = 30_000;
// Languages whose generated tests we know how to name and run.
const STEMS = {
  python: (dir, stem) => `${dir}/test_shoal_${stem}.py`,
  node: (dir, stem) => `${dir}/shoal-${stem}.test.js`,
  go: (dir, stem) => `${dir}/shoal_${stem}_test.go`,
};
const LANGUAGE = [[/\.py$/, "python"], [/\.[cm]?js$/, "node"], [/\.go$/, "go"]];

// The project (stack) a source file belongs to: the deepest root of its language.
const stackForSource = (stacks, file) => {
  const lang = LANGUAGE.find(([re]) => re.test(file))?.[1];
  return stacks
    .filter((s) => s.def.id === lang && (s.root === "." || file.startsWith(s.root + "/")))
    .sort((a, b) => b.root.length - a.root.length)[0] ?? null;
};
const CODE = /\.(?:py|[cm]?js|go)$/;
const norm = (p) => p.replace(/\\/g, "/");
const dirOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".");
const stemOf = (p) => path.posix.basename(p).replace(/\.[^.]+$/, "");
const NOT_SOURCE = /(^|\/)(setup\.py|conftest\.py|__init__\.py|manage\.py|[^/]*\.config\.[cm]?js)$/;

// Shared source files that no existing shared test imports.
async function uncovered() {
  const files = (await listAllFiles(WORKSPACE)).map(norm).filter((p) => inScope(p) && !isSecret(p));
  const covered = new Set();
  for (const t of files.filter(isTestPath)) for (const s of await sourcesForTest(t).catch(() => [])) covered.add(norm(s));
  return files.filter((p) => CODE.test(p) && !isTestPath(p) && !NOT_SOURCE.test(p) && !covered.has(p) && !state.generatedTests.includes(p));
}

export async function generateTests() {
  // Tests written on an earlier scan stay (they are in the workspace), so a rescan reuses them.
  const sources = await uncovered();
  if (!sources.length) return [];
  const stacks = getStacks();
  const byStack = new Map();
  for (const file of sources) {
    const stack = stackForSource(stacks, file);
    if (!stack || !STEMS[stack.def.id]) continue;
    if (!stack.toolOk) {
      emit("scan.error", { message: `Can't write tests for ${file}: ${stack.toolMessage}` });
      continue;
    }
    byStack.set(stack, [...(byStack.get(stack) ?? []), file]);
  }
  if (!byStack.size) return [];

  const written = [];
  for (const [stack, all] of byStack) {
    const picked = all.slice(0, MAX_FILES_PER_STACK);
    const code = [];
    for (const p of picked) {
      const text = await readFile(path.join(WORKSPACE, p), "utf8");
      if (text.length <= MAX_FILE_BYTES) code.push({ path: p, text });
    }
    if (!code.length) continue;
    if (all.length > picked.length) emit("scan.warning", { message: `Writing tests for the first ${picked.length} of ${all.length} uncovered files in ${stack.root === "." ? "the repo root" : stack.root + "/"}` });

    const dir = dirOf(code[0].path);
    const target = STEMS[stack.def.id](dir, stemOf(code[0].path)).replace(/^\.\//, "");
    emit("scan.generating", { message: `No tests cover ${code.map((c) => c.path).join(", ")}: Opus is writing ${target}` });
    const prompt = [
      `Write a test file that checks the behavior of this code, saved as ${target}, in ${testHint(stack)}. It must run with: ${commandFor(stack, [target]).cmd}`,
      "Shoal will run it many times to find flaky or buggy behavior, so focus on what breaks intermittently or under unusual conditions: concurrent or overlapping calls, timing and ordering, shared state that isn't reset, errors partway through, retries, boundary values.",
      "Test behavior the code's names, comments or docstrings promise, and normal usage. Do not assert implementation details or exact error text you are guessing at. Don't depend on luck with random timing: repeat racy scenarios many times inside one test. Give each test a clear name and a timeout where the framework supports it, so a deadlock fails instead of hanging.",
      "Import the code the way the repo's other files do (same relative paths), never mock the code under test, and don't install anything. 4 to 10 tests.",
      `The code:\n\n${code.map((c) => `===== ${c.path} =====\n${c.text}`).join("\n\n")}`,
      "Reply with only the test file, in one fenced code block.",
    ].join("\n\n");

    const answer = await askClaude(prompt, { model: "opus", timeout: 8 * 60_000 });
    const source = answer?.text.match(/```[\w#+.-]*\s*\n([\s\S]*?)```/)?.[1];
    if (!source) {
      emit("scan.warning", { message: answer ? `Claude didn't return a test file for ${code[0].path}` : "Claude Code isn't installed or signed in, so no tests could be written for the untested code" });
      continue;
    }

    // The file must at least load and contain tests; assertion failures are findings, not breakage.
    const sandbox = await createSandbox();
    try {
      await writeFile(path.join(sandbox, target), source);
      const run = await runTestOnce(sandbox, [target]);
      if (NO_TESTS.test(run.log ?? "") || /SyntaxError|ModuleNotFoundError|ImportError|Cannot find module|cannot find package|undefined: |expected '(?:EOF|\()/i.test(run.log ?? "")) {
        emit("scan.warning", { message: `The test Claude wrote for ${code[0].path} doesn't load, so it was discarded: ${(run.log ?? "").trim().split("\n").slice(-2).join(" ").slice(0, 200)}` });
        continue;
      }
    } finally {
      await destroySandbox(sandbox);
    }

    await writeFile(path.join(WORKSPACE, target), source);
    if (!state.generatedTests.includes(target)) state.generatedTests.push(target);
    written.push({ testFile: target, covers: code.map((c) => c.path) });
    emit("scan.generated", { message: `Wrote ${target}, covering ${code.map((c) => c.path).join(", ")}`, testFile: target });
  }
  Object.assign(state.generatedCovers, Object.fromEntries(written.map((w) => [w.testFile, w.covers])));
  return written;
}
