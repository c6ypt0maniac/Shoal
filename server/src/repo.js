// Workspace + sandbox helpers. The source is either the bundled demo-repo or
// a GitHub repo cloned into .repos/. The workspace is a working copy of the
// source that settled fixes get merged into; sandboxes are throwaway copies
// of the workspace where agent patches are tested.
import { access, cp, mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
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

const DEFAULT_TEST_COMMAND = "node --test";
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".next"]);
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

let source = { dir: DEMO_REPO, testCommand: DEFAULT_TEST_COMMAND };

export function setSource(dir, testCommand) {
  source = { dir, testCommand: testCommand?.trim() || DEFAULT_TEST_COMMAND };
}

export const getSource = () => source;

export async function resetWorkspace() {
  await rm(WORKSPACE, { recursive: true, force: true });
  await cp(source.dir, WORKSPACE, { recursive: true, filter: (src) => path.basename(src) !== ".git" });
}

export const isTestFile = (relPath) => TEST_FILE.test(relPath);

// Every *.test.* / *.spec.* file in the repo, as posix paths relative to root.
export async function listTestFiles(dir = WORKSPACE, rel = "") {
  const found = [];
  for (const entry of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...(await listTestFiles(dir, relPath)));
    else if (isTestFile(entry.name)) found.push(relPath);
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

// Local files a test imports, resolved to repo-relative paths,
// e.g. test/cart.test.js importing "../src/cart.js" -> "src/cart.js".
// Every local file a test depends on, following imports through the files it
// imports too (a bug can sit several files away from the test).
export async function sourcesForTest(testFile, dir = WORKSPACE) {
  const seen = new Set([testFile]);
  const queue = [testFile];
  while (queue.length && seen.size < 200) {
    const file = queue.shift();
    const code = await readRepoFile(file, dir).catch(() => "");
    const specifiers = [...code.matchAll(/(?:from\s+|require\(\s*|import\(\s*)["'](\.{1,2}\/[^"']+)["']/g)].map((m) => m[1]);
    for (const p of await Promise.all(specifiers.map((s) => resolveImport(dir, path.posix.dirname(file), s)))) {
      if (p && !seen.has(p)) {
        seen.add(p);
        queue.push(p);
      }
    }
  }
  return [...seen].filter((p) => p !== testFile && !isTestFile(p));
}

async function resolveImport(dir, fromDir, specifier) {
  const base = path.posix.normalize(path.posix.join(fromDir, specifier));
  for (const candidate of [base, ...[".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", "/index.js", "/index.ts"].map((ext) => base + ext)]) {
    try {
      await access(path.join(dir, candidate));
      if (path.posix.extname(candidate)) return candidate;
    } catch {}
  }
  return null;
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

// Runs the repo's test command once on one file, a list of files, or (if
// omitted) the whole suite. Resolves with pass/fail and a trimmed log.
export async function runTestOnce(dir, testFiles) {
  const files = [testFiles ?? []].flat().map((f) => JSON.stringify(f));
  const { ok, output } = await sh([source.testCommand, ...files].join(" "), dir, 60_000);
  return { passed: ok, log: output.slice(-1500) };
}

export async function runTestMany(dir, testFile, times) {
  return Promise.all(Array.from({ length: times }, () => runTestOnce(dir, testFile)));
}
