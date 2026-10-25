// Private verification tests live outside the checked-out repository. Agents
// can neither list nor read them. They are copied into a disposable verifier
// sandbox only after a candidate passes the public test.
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isTestFile, runTestMany } from "./repo.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const HIDDEN_TESTS_ROOT = path.resolve(process.env.SHOAL_HIDDEN_TESTS_DIR || path.join(here, "..", ".data", "hidden-tests"));

const clean = (value) => String(value ?? "").replace(/\\/g, "/").replace(/^\.\//, "");

export async function installHiddenTests(sandbox, publicTestFile) {
  const publicPath = clean(publicTestFile);
  const relativeDir = path.posix.dirname(publicPath);
  const sourceDir = path.resolve(HIDDEN_TESTS_ROOT, relativeDir === "." ? "" : relativeDir);
  if (!inside(HIDDEN_TESTS_ROOT, sourceDir) || !(await exists(sourceDir))) return [];

  const copied = [];
  for (const source of await walk(sourceDir)) {
    const relative = clean(path.relative(HIDDEN_TESTS_ROOT, source));
    if (!isTestFile(relative)) continue;
    const target = path.resolve(sandbox, relative);
    if (!inside(sandbox, target)) continue;
    // A repository file can never replace a private verifier test.
    if (await exists(target)) throw new Error(`Private verification path collides with repository file: ${relative}`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await readFile(source));
    copied.push(relative);
  }
  return copied;
}

export async function runHiddenTests(sandbox, publicTestFile, { runs = 3 } = {}) {
  const tests = await installHiddenTests(sandbox, publicTestFile);
  let passed = 0;
  for (const test of tests) {
    const results = await runTestMany(sandbox, test, runs);
    if (results.every((result) => result.passed)) passed += 1;
  }
  return { found: tests.length, passed, runs, ok: passed === tests.length };
}

async function walk(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

const exists = async (value) => access(value).then(() => true, () => false);
const inside = (root, candidate) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};
