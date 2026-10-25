// Workspace + sandbox helpers. The source is either the bundled demo-repo or
// a GitHub repo cloned into .repos/. The workspace is a working copy of the
// source that settled fixes get merged into; sandboxes are throwaway copies
// of the workspace where agent patches are tested.
import { cp, mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { SKIP_DIRS, commandFor, detectStacks, isTestPath, parseResults, sourcesFor, stackFor } from "./stack.js";
import { exec } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEMO_REPO = path.resolve(here, "../../demo-repo");
export const REPOS_DIR = path.resolve(here, "../.repos");
// SHOAL_WORKSPACE lets a second server (e.g. a preview) run without
// clobbering the main one's checkout.
export const WORKSPACE = path.resolve(here, "..", process.env.SHOAL_WORKSPACE || ".workspace");

// testCommand: only when the team typed one in setup; otherwise each test runs
// with the command its stack calls for (see stack.js).
let source = { dir: DEMO_REPO, testCommand: null, stacks: [] };

export function setSource(dir, testCommand) {
  source = { dir, testCommand: testCommand?.trim() || null, stacks: [] };
}

export const getSource = () => source;
export const getStacks = () => source.stacks;

// Fresh working copy of the source, then learn how its tests run.
export async function resetWorkspace() {
  // Retries: a scan or pip install from an earlier connect may still be releasing files.
  await rm(WORKSPACE, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  await cp(source.dir, WORKSPACE, { recursive: true, filter: (src) => path.basename(src) !== ".git" });
  source.stacks = await detectStacks(WORKSPACE);
}

// A test file in any supported language (see stack.js).
export const isTestFile = (relPath) => isTestPath(relPath);

// Every test file in the repo, as posix paths relative to root.
export async function listTestFiles(dir = WORKSPACE, rel = "") {
  const found = [];
  for (const entry of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...(await listTestFiles(dir, relPath)));
    else if (isTestFile(relPath)) found.push(relPath);
  }
  return found.sort();
}

// Every file path under dir (skipping .git, node_modules, build output).
export async function listAllFiles(dir, rel = "") {
  const found = [];
  for (const entry of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...(await listAllFiles(dir, relPath)));
    else found.push(relPath);
  }
  return found;
}

export function readRepoFile(relPath, dir = WORKSPACE) {
  return readFile(path.join(dir, relPath), "utf8");
}

// Every local source file a test depends on, in whatever language: imports are
// followed through the files they import too (a bug can sit several files away
// from the test). See sourcesFor in stack.js.
export async function sourcesForTest(testFile, dir = WORKSPACE) {
  return sourcesFor(stackFor(source.stacks, testFile), testFile, dir, await listAllFiles(dir));
}

export async function createSandbox() {
  const dir = await mkdtemp(path.join(tmpdir(), "shoal-sandbox-"));
  await cp(WORKSPACE, dir, { recursive: true });
  return dir;
}

export function destroySandbox(dir) {
  return rm(dir, { recursive: true, force: true });
}

export async function writeFiles(dir, files) {
  for (const f of files) {
    const target = path.join(dir, f.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, f.content);
  }
}

// Runs a shell command and resolves with ok/output (never rejects).
export function sh(command, cwd, timeout = 120_000) {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout, maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: stdout + stderr });
    });
  });
}

// A saved setup command may predate multi-language detection. Never feed a
// test file to a runner for another language (for example, `node --test x.py`).
// Unknown custom commands are left alone because they may be project wrappers.
function testCommandFits(command, files) {
  const cmd = command.toLowerCase();
  const all = (pattern) => files.every((file) => pattern.test(file));
  if (/\b(node|npm|npx|yarn|pnpm|bun)\b/.test(cmd)) return all(/\.[cm]?[jt]sx?$/i);
  if (/\b(python|python3|pytest|py\s+-3)\b/.test(cmd)) return all(/\.py$/i);
  if (/\b(go\s+test)\b/.test(cmd)) return all(/\.go$/i);
  if (/\b(cargo\s+test)\b/.test(cmd)) return all(/\.rs$/i);
  return true;
}

// Runs test files once (or, if omitted, every test file), each with its own
// stack's command, from that stack's folder. Resolves with pass/fail and a
// trimmed log. A test whose toolchain is missing fails with a clear reason
// rather than looking like a broken test.
export async function runTestOnce(dir, testFiles) {
  const files = testFiles ? [testFiles].flat() : await listTestFiles(dir);
  if (source.testCommand && testCommandFits(source.testCommand, files)) {
    const { ok, output } = await sh([source.testCommand, ...files.map((f) => JSON.stringify(f))].join(" "), dir, 120_000);
    return { passed: ok, log: output.slice(-1500) };
  }
  const groups = new Map();
  for (const f of files) {
    const stack = stackFor(source.stacks, f);
    if (!groups.has(stack)) groups.set(stack, []);
    groups.get(stack).push(f);
  }
  let passed = true;
  let log = "";
  for (const [stack, group] of groups) {
    if (!stack) {
      passed = false;
      log += `Shoal doesn't know how to run ${group.join(", ")} (no supported test setup found).\n`;
      continue;
    }
    if (!stack.toolOk) {
      passed = false;
      log += `${stack.toolMessage}.\n`;
      continue;
    }
    const { cmd, cwd } = commandFor(stack, group);
    const run = await sh(cmd, path.join(dir, cwd), 180_000);
    passed &&= run.ok;
    log += run.output;
  }
  return { passed, log: log.slice(-1500) };
}

// One test file with per-test results where the framework reports them:
// { passed, log, results: { testName: passed } | null }.
export async function runTestDetail(dir, testFile) {
  const stack = stackFor(source.stacks, testFile);
  if (source.testCommand || !stack?.toolOk) return { ...(await runTestOnce(dir, testFile)), results: null };
  const { cmd, cwd } = commandFor(stack, [testFile], { detail: true });
  const run = await sh(cmd, path.join(dir, cwd), 180_000);
  return { passed: run.ok, log: run.output.slice(-3000), results: parseResults(stack, run.output) };
}

export async function runTestMany(dir, testFile, times) {
  return Promise.all(Array.from({ length: times }, () => runTestOnce(dir, testFile)));
}
