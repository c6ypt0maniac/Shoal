// Workspace + sandbox helpers. The source is either the bundled demo-repo or
// a GitHub repo cloned into .repos/. The workspace is a working copy of the
// source that settled fixes get merged into; sandboxes are throwaway copies
// of the workspace where agent patches are tested.
import { cp, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { lstatSync } from "node:fs";
import { SKIP_DIRS, commandFor, detectStacks, isTestPath, parseResults, sourcesFor, stackFor } from "./stack.js";
import { exec } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { testEvidence } from './test-evidence.js';
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEMO_REPO = path.resolve(here, "../../demo-repo");
// SHOAL_REPOS_DIR: where clones go (default server/.repos), e.g. for a test server.
export const REPOS_DIR = path.resolve(here, "..", process.env.SHOAL_REPOS_DIR || ".repos");
// SHOAL_WORKSPACE lets a second server (e.g. a preview) run without
// clobbering the main one's checkout. A let, not a const: claimWorkspace
// moves it if another server already has it (importers see the change).
export let WORKSPACE = path.resolve(here, "..", process.env.SHOAL_WORKSPACE || ".workspace");

// testCommand: only when the team typed one in setup; otherwise each test runs
// with the command its stack calls for (see stack.js).
let source = { dir: DEMO_REPO, testCommand: null, stacks: [] };

export function setSource(dir, testCommand) {
  source = { dir, testCommand: testCommand?.trim() || null, stacks: [] };
}

export const getSource = () => source;

// Which repo a piece of work is about. Normally the active one (connected on
// the Repository page), but each bounty keeps its own repo: its race,
// verification, survival checks and PR run inside withRepo(thatRepo, ...)
// (see repos.js), and every helper below then reads that repo's working copy
// and runs its tests, without each caller passing it along.
const current = new AsyncLocalStorage();
const ctx = () => current.getStore() ?? { workspace: WORKSPACE, stacks: source.stacks, testCommand: source.testCommand };
export const withRepo = (repo, fn) => current.run(repo, fn);
export const workspaceDir = () => ctx().workspace;
export const getStacks = () => ctx().stacks;

// A working copy of `from` at `to` (dependencies linked), and how its tests run.
export async function buildWorkspace(from, to) {
  await rm(to, { recursive: true, force: true });
  await copyTree(from, to);
  return detectStacks(to);
}

// One server per working copy. A second one on the same folder (a check
// script, a preview, the desktop app) would copy its own repo in under this
// one, and this server's scan would then find tests it has no setup for. So
// if another live server has it, this one quietly takes its own folder next
// to it (.workspace-<port>) instead of failing to start.
async function claimWorkspace() {
  const holder = async (dir) => {
    const pid = Number(await readFile(`${dir}.lock`, "utf8").catch(() => ""));
    return pid && pid !== process.pid && isAlive(pid) ? pid : null;
  };
  const pid = await holder(WORKSPACE);
  if (pid) {
    const own = `${WORKSPACE}-${process.env.PORT || process.pid}`;
    const other = await holder(own);
    WORKSPACE = other ? `${WORKSPACE}-${process.pid}` : own;
    console.log(`Another Shoal server (pid ${pid}) is using the default working folder; this one uses ${WORKSPACE}`);
  }
  await writeFile(`${WORKSPACE}.lock`, String(process.pid));
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// Fresh working copy of the source, then learn how its tests run.
export async function resetWorkspace() {
  await claimWorkspace();
  await rm(WORKSPACE, { recursive: true, force: true });
  await copyTree(source.dir, WORKSPACE);
  source.stacks = await detectStacks(WORKSPACE);
}

// Installed dependencies are linked, not copied: tests only read them, and
// copying them made every start and every test sandbox slow (a JS repo's
// node_modules can be 100+ MB and tens of thousands of files).
const LINKED = new Set(["node_modules", ".shoal-venv", ".venv", "venv"]);

async function copyTree(from, to) {
  const linked = [];
  await cp(from, to, {
    recursive: true,
    filter: (src) => {
      const name = path.basename(src);
      if (name === ".git") return false;
      if (LINKED.has(name) && src !== from) {
        linked.push(src);
        return false;
      }
      return true;
    },
  });
  for (const src of linked) {
    const target = path.join(to, path.relative(from, src));
    await mkdir(path.dirname(target), { recursive: true });
    // realpath: a sandbox's links point at the clone, not at another link.
    await symlink(await realpath(src), target, "dir").catch(() => {});
  }
}

// A test file in any supported language (see stack.js).
export const isTestFile = (relPath) => isTestPath(relPath);

// Every test file in the repo, as posix paths relative to root.
export async function listTestFiles(dir = workspaceDir(), rel = "") {
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

export function readRepoFile(relPath, dir = workspaceDir()) {
  return readFile(path.join(dir, relPath), "utf8");
}

// Every local source file a test depends on, in whatever language: imports are
// followed through the files they import too (a bug can sit several files away
// from the test). See sourcesFor in stack.js.
export async function sourcesForTest(testFile, dir = workspaceDir()) {
  return sourcesFor(stackFor(getStacks(), testFile), testFile, dir, await listAllFiles(dir));
}

// Installed dependencies are linked into sandboxes, not copied: copying a
// real node_modules takes seconds to minutes, and every scan, verification,
// proof and survival check makes a sandbox. Agents can't write into them
// (verifier.js protects these folders). SHOAL_COPY_DEPS=1 copies them again.
export const DEPENDENCY_DIRS = new Set(["node_modules", ".venv", "venv", ".shoal-venv"]);

export async function createSandbox() {
  const WORKSPACE = workspaceDir();
  const dir = await mkdtemp(path.join(tmpdir(), "shoal-sandbox-"));
  const linked = [];
  const filter = (src) => {
    if (process.env.SHOAL_COPY_DEPS === "1" || !DEPENDENCY_DIRS.has(path.basename(src)) || !lstatSync(src).isDirectory()) return true;
    linked.push(path.relative(WORKSPACE, src));
    return false;
  };
  await cp(WORKSPACE, dir, { recursive: true, filter });
  // "junction" needs no admin rights on Windows; elsewhere it's a plain symlink.
  for (const rel of linked) await symlink(path.join(WORKSPACE, rel), path.join(dir, rel), "junction");
  return dir;
}

export function destroySandbox(dir) {
  return rm(dir, { recursive: true, force: true });
}

export async function writeFiles(dir, files) {
  for (const f of files) {
    // Dependency folders are shared links in sandboxes: a write would leak into every later run.
    if (f.path.split(/[\\/]/).some((part) => DEPENDENCY_DIRS.has(part))) throw new Error(`Can't write into installed dependencies: ${f.path}`);
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

// Runs test files once (or, if omitted, every test file), each with its own
// stack's command, from that stack's folder. Resolves with pass/fail and a
// trimmed log. A test whose toolchain is missing fails with a clear reason
// rather than looking like a broken test.
export async function runTestOnce(dir, testFiles) {
  const { testCommand, stacks } = ctx();
  const files = testFiles ? [testFiles].flat() : await listTestFiles(dir);
  if (testCommand) {
    const { ok, output } = await sh([testCommand, ...files.map((f) => JSON.stringify(f))].join(" "), dir, 120_000);
    return { passed: ok, log: testEvidence(output) };
  }
  const groups = new Map();
  for (const f of files) {
    const stack = stackFor(stacks, f);
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
  return { passed, log: testEvidence(log) };
}

// One test file with per-test results where the framework reports them:
// { passed, log, results: { testName: passed } | null }.
export async function runTestDetail(dir, testFile) {
  const { testCommand, stacks } = ctx();
  const stack = stackFor(stacks, testFile);
  if (testCommand || !stack?.toolOk) return { ...(await runTestOnce(dir, testFile)), results: null };
  const { cmd, cwd } = commandFor(stack, [testFile], { detail: true });
  const run = await sh(cmd, path.join(dir, cwd), 180_000);
  return { passed: run.ok, log: testEvidence(run.output), results: parseResults(stack, run.output) };
}

// Each run gets its own copy of the sandbox, so parallel runs can't trip over
// each other's temp files, caches or ports and make a good fix look flaky (or
// one run's leftovers make a bad fix look fine). Dependency folders are links
// in a sandbox and stay links in the copy (verbatimSymlinks), so a copy is cheap.
export async function runTestMany(dir, testFile, times) {
  return Promise.all(
    Array.from({ length: times }, async () => {
      const copy = await mkdtemp(path.join(tmpdir(), "shoal-run-"));
      try {
        await cp(dir, copy, { recursive: true, verbatimSymlinks: true });
        return await runTestOnce(copy, testFile);
      } finally {
        await destroySandbox(copy);
      }
    }),
  );
}
