// Which languages and test frameworks a repo uses, learned from the repo's own
// setup instead of assuming Node. A repo can hold several projects (say a
// Python API and a JS frontend); each is a "stack" rooted at the folder of its
// manifest. For each stack we know: which files are tests, how to run one test
// file, how to install dependencies, how to read per-test results, and which
// toolchain must be installed. Evidence comes from manifests (package.json,
// pyproject.toml, go.mod, Cargo.toml, pom.xml, build.gradle, Gemfile,
// composer.json, *.csproj), test configs (pytest.ini, conftest.py, ...) and
// the commands the repo's CI workflow actually runs.
import { access, readdir, readFile } from "node:fs/promises";
import { exec } from "node:child_process";
import path from "node:path";

export const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "coverage", ".next", "__pycache__", ".pytest_cache",
  ".venv", "venv", ".shoal-venv", ".tox", "target", "vendor", "bin", "obj", ".gradle", ".idea", ".vscode",
]);

const IS_WIN = process.platform === "win32";
const q = (s) => JSON.stringify(s);
const base = (p) => p.slice(p.lastIndexOf("/") + 1);
const stem = (p) => base(p).replace(/\.[^.]+$/, "");
const dirOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".");
const inDir = (dir, file) => (dir === "." ? file : `${dir}/${file}`);

// Test files in any supported language. Used everywhere a file is labelled a
// test (the setup picker, the scan, the "tests are read-only" rule).
const TEST_PATTERNS = [
  /\.(test|spec)\.[cm]?[jt]sx?$/, // JS/TS: cart.test.js, cart.spec.ts
  /(^|\/)__tests__\/.+\.[cm]?[jt]sx?$/, // JS/TS: __tests__/cart.js
  /(^|\/)test_[^/]+\.py$|_test\.py$/, // Python: test_cart.py, cart_test.py
  /_test\.go$/, // Go
  /(^|\/)tests\/[^/]+\.rs$/, // Rust integration tests
  /(^|\/)src\/test\/.+\.(java|kt|kts|scala|groovy)$|[A-Z]\w*Tests?\.(java|kt)$/, // JVM
  /_spec\.rb$|_test\.rb$|(^|\/)test_[^/]+\.rb$/, // Ruby
  /Test\.php$/, // PHP
  /[A-Z]\w*Tests?\.cs$/, // C#
];
export const isTestPath = (p) => TEST_PATTERNS.some((re) => re.test(p.replace(/\\/g, "/")));

// Per-test results, so a challenge test file can report each test separately.
const parsers = {
  tap: (out) => pick(out, /^(not )?ok \d+ - (.+?)(?:\s+#.*)?$/gm, (m) => [m[2], !m[1]]),
  jest: (out) => pick(out, /^\s*(✓|√|✕|×)\s+(.+?)(?:\s+\(\d+\s*ms\))?$/gm, (m) => [m[2], m[1] === "✓" || m[1] === "√"]),
  pytest: (out) => pick(out, /^(PASSED|FAILED|ERROR) (\S+)/gm, (m) => [m[2].split("::").slice(1).join("::") || m[2], m[1] === "PASSED"]),
  unittest: (out) => pick(out, /^(\w+) \(([\w.]+)\)[^\n]*?\.\.\. (ok|FAIL|ERROR)/gm, (m) => [m[1], m[3] === "ok"]),
  go: (out) => pick(out, /^\s*--- (PASS|FAIL): (\S+)/gm, (m) => [m[2], m[1] === "PASS"]),
  cargo: (out) => pick(out, /^test (\S+) \.\.\. (ok|FAILED)/gm, (m) => [m[1], m[2] === "ok"]),
};
function pick(out, re, toPair) {
  const results = {};
  for (const m of out.matchAll(re)) {
    const [name, ok] = toPair(m);
    results[name] = (results[name] ?? true) && ok;
  }
  return Object.keys(results).length ? results : null;
}

// --- Stack definitions --------------------------------------------------------
// files are relative to the stack root. Each command runs with cwd = root.

const STACKS = [
  {
    id: "node",
    language: "JavaScript/TypeScript",
    marker: (names) => names.includes("package.json"),
    async framework(root, ctx) {
      const pkg = JSON.parse((await ctx.read(inDir(root, "package.json"))) || "{}");
      const script = pkg.scripts?.test ?? "";
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const ci = ctx.ciCommand ?? "";
      const has = (name) => new RegExp(`\\b${name}\\b`).test(script) || new RegExp(`\\b${name}\\b`).test(ci) || deps[name];
      if (ctx.names(root).includes("bun.lockb") || /\bbun test\b/.test(script)) return { framework: "bun", evidence: "bun.lockb / bun test" };
      if (has("vitest")) return { framework: "vitest", evidence: script ? `package.json test script: ${script}` : "vitest in package.json" };
      if (has("jest")) return { framework: "jest", evidence: script ? `package.json test script: ${script}` : "jest in package.json" };
      if (has("mocha")) return { framework: "mocha", evidence: script ? `package.json test script: ${script}` : "mocha in package.json" };
      if (/node\s+--test/.test(script)) return { framework: "node", evidence: `package.json test script: ${script}` };
      if (script && !/no test specified/.test(script)) return { framework: "npm", evidence: `package.json test script: ${script}` };
      return { framework: "node", evidence: "package.json without a test runner: Node's built-in test runner" };
    },
    files: (fw, files, detail) => {
      const f = files.map(q).join(" ");
      return {
        node: `node --test ${detail ? "--test-reporter=tap " : ""}${f}`,
        jest: `npx --no-install jest --runInBand ${detail ? "--verbose " : ""}${f}`,
        vitest: `npx --no-install vitest run ${detail ? "--reporter=verbose " : ""}${f}`,
        mocha: `npx --no-install mocha ${detail ? "--reporter tap " : ""}${f}`,
        bun: `bun test ${f}`,
        npm: `npm test --silent -- ${f}`,
      }[fw];
    },
    parser: (fw) => ({ node: "tap", mocha: "tap", jest: "jest", vitest: "jest" })[fw],
    tool: (fw) => (fw === "bun" ? "bun --version" : "node --version"),
    install: (root, ctx) =>
      ctx.names(root).includes("pnpm-lock.yaml") ? "pnpm install --frozen-lockfile"
      : ctx.names(root).includes("yarn.lock") ? "yarn install --frozen-lockfile"
      : ctx.names(root).includes("bun.lockb") ? "bun install"
      : "npm install --no-audit --no-fund",
    challenge: (testFile) => `${dirOf(testFile)}/shoal-challenge.test${testFile.match(/\.[cm]?[jt]sx?$/)?.[0] ?? ".js"}`.replace(/^\.\//, ""),
    hint: (fw) => ({ node: "node:test and node:assert/strict", jest: "Jest (describe/test/expect)", vitest: "Vitest (import { test, expect } from 'vitest')", mocha: "Mocha with node:assert", bun: "bun:test" })[fw] ?? "the repo's existing test style",
  },
  {
    id: "python",
    language: "Python",
    marker: (names) => names.some((n) => ["pyproject.toml", "setup.py", "setup.cfg", "pytest.ini", "tox.ini", "Pipfile"].includes(n) || /^requirements.*\.txt$/.test(n)),
    async framework(root, ctx) {
      const names = ctx.names(root);
      const text = async (n) => (names.includes(n) ? (await ctx.read(inDir(root, n))) || "" : "");
      if (names.includes("pytest.ini")) return { framework: "pytest", evidence: "pytest.ini" };
      if (names.includes("conftest.py")) return { framework: "pytest", evidence: "conftest.py" };
      if (/\[tool\.pytest/.test(await text("pyproject.toml"))) return { framework: "pytest", evidence: "[tool.pytest] in pyproject.toml" };
      if (/\[tool:pytest\]/.test(await text("setup.cfg"))) return { framework: "pytest", evidence: "[tool:pytest] in setup.cfg" };
      if (/\[pytest\]/.test(await text("tox.ini"))) return { framework: "pytest", evidence: "[pytest] in tox.ini" };
      if (/\bpytest\b/.test(ctx.ciCommand ?? "")) return { framework: "pytest", evidence: `CI runs: ${ctx.ciCommand}` };
      for (const n of names.filter((n) => /^requirements.*\.txt$|^pyproject\.toml$|^Pipfile$/.test(n))) {
        if (/^\s*pytest\b|["']pytest/m.test(await text(n))) return { framework: "pytest", evidence: `pytest listed in ${n}` };
      }
      if (await ctx.anyTestImports(root, /^\s*import pytest|^\s*from pytest/m)) return { framework: "pytest", evidence: "tests import pytest" };
      return { framework: "unittest", evidence: "no pytest config: Python's built-in unittest" };
    },
    files: (fw, files, detail, ctx) =>
      fw === "pytest"
        ? `${ctx.python} -m pytest -q -p no:cacheprovider ${detail ? "-rA " : ""}${files.map(q).join(" ")}`
        : `${ctx.python} -m unittest ${detail ? "-v " : ""}${files.map(q).join(" ")}`,
    parser: (fw) => (fw === "pytest" ? "pytest" : "unittest"),
    tool: (fw, ctx) => (fw === "pytest" ? `${ctx.python} -m pytest --version` : `${ctx.python} --version`),
    // Dependencies go into a private virtualenv inside the clone, never into
    // the machine's own Python.
    install: (root, ctx) => {
      const names = ctx.names(root);
      const venvPy = IS_WIN ? ".shoal-venv\\Scripts\\python" : ".shoal-venv/bin/python";
      const steps = [`${ctx.basePython} -m venv .shoal-venv`];
      if (names.includes("requirements.txt")) steps.push(`${venvPy} -m pip install -q -r requirements.txt`);
      for (const n of names.filter((n) => /^requirements[-_.](dev|test)\w*\.txt$/.test(n))) steps.push(`${venvPy} -m pip install -q -r ${n}`);
      if (names.includes("pyproject.toml") || names.includes("setup.py")) steps.push(`${venvPy} -m pip install -q -e .`);
      steps.push(`${venvPy} -m pip install -q pytest`);
      return steps.join(" && ");
    },
    challenge: (testFile) => `${dirOf(testFile)}/test_shoal_challenge.py`.replace(/^\.\//, ""),
    hint: (fw) => (fw === "pytest" ? "pytest (plain assert, test_ functions)" : "unittest (unittest.TestCase)"),
  },
  {
    id: "go",
    language: "Go",
    marker: (names) => names.includes("go.mod"),
    framework: async () => ({ framework: "go test", evidence: "go.mod" }),
    files: (fw, files, detail) => `go test -count=1 ${detail ? "-v " : ""}${[...new Set(files.map((f) => `./${dirOf(f) === "." ? "" : dirOf(f)}`))].map(q).join(" ")}`,
    parser: () => "go",
    tool: () => "go version",
    install: () => "go mod download",
    challenge: (testFile) => `${dirOf(testFile)}/shoal_challenge_test.go`.replace(/^\.\//, ""),
    hint: () => "Go's testing package, in the same package as the code under test",
  },
  {
    id: "rust",
    language: "Rust",
    marker: (names) => names.includes("Cargo.toml"),
    framework: async () => ({ framework: "cargo test", evidence: "Cargo.toml" }),
    files: (fw, files) => {
      const integration = files.filter((f) => /^tests\/[^/]+\.rs$/.test(f));
      return integration.length === files.length ? `cargo test ${integration.map((f) => `--test ${q(stem(f))}`).join(" ")}` : "cargo test";
    },
    parser: () => "cargo",
    tool: () => "cargo --version",
    install: () => "cargo fetch",
    challenge: () => "tests/shoal_challenge.rs",
    hint: () => "a Rust integration test in tests/ using the crate's public API (#[test] functions)",
  },
  {
    id: "maven",
    language: "Java/Kotlin (Maven)",
    marker: (names) => names.includes("pom.xml"),
    framework: async () => ({ framework: "maven", evidence: "pom.xml" }),
    files: (fw, files) => `mvn -q -B test -Dtest=${files.map(stem).join(",")} -DfailIfNoTests=false -Dsurefire.failIfNoSpecifiedTests=false`,
    parser: () => null,
    tool: () => "mvn -v",
    install: () => "mvn -q -B -DskipTests dependency:go-offline",
    challenge: (testFile) => `${dirOf(testFile)}/ShoalChallengeTest.${testFile.endsWith(".kt") ? "kt" : "java"}`,
    hint: () => "JUnit in the same package as the existing test (keep its package line and imports style)",
  },
  {
    id: "gradle",
    language: "Java/Kotlin (Gradle)",
    marker: (names) => names.some((n) => /^build\.gradle(\.kts)?$/.test(n)),
    framework: async (root, ctx) => ({ framework: "gradle", evidence: ctx.names(root).find((n) => /^build\.gradle/.test(n)) }),
    files: (fw, files, detail, ctx) => `${ctx.gradle} test ${files.map((f) => `--tests ${q(stem(f))}`).join(" ")}`,
    parser: () => null,
    tool: (fw, ctx) => `${ctx.gradle} --version`,
    install: () => null,
    challenge: (testFile) => `${dirOf(testFile)}/ShoalChallengeTest.${testFile.endsWith(".kt") ? "kt" : "java"}`,
    hint: () => "JUnit in the same package as the existing test (keep its package line and imports style)",
  },
  {
    id: "ruby",
    language: "Ruby",
    marker: (names) => names.includes("Gemfile") || names.includes(".rspec"),
    async framework(root, ctx) {
      const gemfile = (await ctx.read(inDir(root, "Gemfile"))) || "";
      if (ctx.names(root).includes(".rspec") || /rspec/.test(gemfile)) return { framework: "rspec", evidence: ".rspec / rspec in Gemfile" };
      return { framework: "minitest", evidence: "Gemfile without rspec: minitest" };
    },
    files: (fw, files) =>
      fw === "rspec" ? `bundle exec rspec ${files.map(q).join(" ")}` : files.map((f) => `bundle exec ruby -Itest -Ilib ${q(f)}`).join(" && "),
    parser: () => null,
    tool: () => "ruby -v",
    install: () => "bundle install",
    challenge: (testFile, fw) => `${dirOf(testFile)}/${fw === "rspec" ? "shoal_challenge_spec.rb" : "shoal_challenge_test.rb"}`.replace(/^\.\//, ""),
    hint: (fw) => (fw === "rspec" ? "RSpec" : "Minitest"),
  },
  {
    id: "php",
    language: "PHP",
    marker: (names) => names.includes("composer.json") || names.some((n) => /^phpunit\.xml/.test(n)),
    framework: async () => ({ framework: "phpunit", evidence: "composer.json / phpunit.xml" }),
    files: (fw, files) => files.map((f) => `${IS_WIN ? "vendor\\bin\\phpunit" : "vendor/bin/phpunit"} ${q(f)}`).join(" && "),
    parser: () => null,
    tool: () => "php -v",
    install: () => "composer install --no-interaction --no-progress",
    challenge: (testFile) => `${dirOf(testFile)}/ShoalChallengeTest.php`,
    hint: () => "PHPUnit (a class extending TestCase, same namespace style as the existing test)",
  },
  {
    id: "dotnet",
    language: "C# (.NET)",
    marker: (names) => names.some((n) => /\.(csproj|sln|fsproj)$/.test(n)),
    framework: async (root, ctx) => ({ framework: "dotnet test", evidence: ctx.names(root).find((n) => /\.(csproj|sln|fsproj)$/.test(n)) }),
    files: (fw, files) => `dotnet test --filter ${q(files.map((f) => `FullyQualifiedName~${stem(f)}`).join("|"))}`,
    parser: () => null,
    tool: () => "dotnet --version",
    install: () => "dotnet restore",
    challenge: (testFile) => `${dirOf(testFile)}/ShoalChallengeTests.cs`,
    hint: () => "the same test framework and namespace as the existing tests (xUnit/NUnit/MSTest)",
  },
];

// Which language a lone test file belongs to, for repos with tests but no
// manifest (e.g. a folder of Python scripts with test_*.py).
const LANGUAGE_OF = [
  [/\.[cm]?[jt]sx?$/, "node"],
  [/\.py$/, "python"],
  [/\.go$/, "go"],
  [/\.rs$/, "rust"],
  [/\.rb$/, "ruby"],
  [/\.php$/, "php"],
  [/\.cs$/, "dotnet"],
  [/\.(java|kt)$/, "maven"],
];

// --- Detection ----------------------------------------------------------------

function sh(command, cwd, timeout = 20_000) {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout, windowsHide: true }, (err, stdout, stderr) => resolve({ ok: !err, output: `${stdout}${stderr}` }));
  });
}

async function walk(dir, rel = "", depth = 0, out = []) {
  if (depth > 6) return out;
  let entries = [];
  try {
    entries = await readdir(path.join(dir, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) await walk(dir, p, depth + 1, out);
    else out.push(p);
  }
  return out;
}

// Test commands the repo's CI runs, e.g. "pytest -q" from a `run:` step.
const TEST_COMMAND = /\b(npm (run )?test|yarn test|pnpm test|npx (jest|vitest|mocha)|jest|vitest|mocha|node --test|bun test|pytest|python -m (pytest|unittest)|go test|cargo test|mvn\b.*\btest|gradlew? .*\btest|\bgradle test|rspec|rake test|phpunit|dotnet test)\b/;
async function ciCommands(dir, files) {
  const found = [];
  for (const f of files.filter((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p))) {
    const text = await readFile(path.join(dir, f), "utf8").catch(() => "");
    for (const line of text.split(/\r?\n/)) {
      const cmd = line.replace(/^\s*-?\s*(run:\s*)?/, "").replace(/^["']|["']$/g, "").trim();
      if (TEST_COMMAND.test(cmd) && !cmd.startsWith("#") && !/^(name|uses|with):/.test(cmd)) found.push({ file: f, command: cmd });
    }
  }
  return found;
}

// All the projects in a repo, deepest first so a test file maps to the
// nearest one. Also reports whether each one's toolchain is installed here.
export async function detectStacks(dir) {
  const files = await walk(dir);
  const ci = await ciCommands(dir, files);
  const byDir = new Map();
  for (const f of files) {
    const d = dirOf(f);
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d).push(base(f));
  }
  const ctx = {
    names: (root) => byDir.get(root) ?? [],
    read: (rel) => readFile(path.join(dir, rel), "utf8").catch(() => ""),
    async anyTestImports(root, re) {
      for (const f of files.filter((p) => (root === "." || p.startsWith(root + "/")) && isTestPath(p) && p.endsWith(".py"))) {
        if (re.test(await this.read(f))) return true;
      }
      return false;
    },
  };

  // What CI runs is evidence for every stack, with or without a manifest.
  ctx.ciCommand = ci.map((c) => c.command).join("\n") || undefined;
  const stacks = [];
  for (const [root, names] of byDir) {
    for (const def of STACKS) {
      if (!def.marker(names)) continue;
      if (stacks.some((s) => s.root === root && s.def.id === def.id)) continue;
      stacks.push({ def, root, ...(await def.framework(root, ctx)) });
    }
  }
  // Test files that no manifest claims still need a way to run, from the
  // right folder: a Python project without a manifest is rooted at the folder
  // holding its tests/ folder, so `from inventory import ...` resolves the way
  // it does when you run the tests yourself.
  for (const f of files.filter(isTestPath)) {
    if (stacks.some((s) => !s.fallback && owns(s, f))) continue;
    const id = LANGUAGE_OF.find(([re]) => re.test(f))?.[1];
    if (!id) continue;
    const root = id === "python" ? pythonRoot(f) : ".";
    if (stacks.some((s) => s.root === root && languageId(s.def.id) === languageId(id))) continue;
    const def = STACKS.find((s) => s.id === id);
    const found = await def.framework(root, ctx);
    stacks.push({ def, root, fallback: true, ...found, evidence: `test files like ${f} (no ${def.language} manifest); ${found.evidence}` });
  }

  const basePython = (await sh("python --version", dir)).ok ? "python" : (await sh("python3 --version", dir)).ok ? "python3" : "py -3";
  for (const s of stacks) {
    const venv = path.join(dir, s.root, ".shoal-venv", IS_WIN ? "Scripts" : "bin", IS_WIN ? "python.exe" : "python");
    s.ctx = {
      basePython,
      // Commands run inside the stack's root, so the venv path is relative to it.
      python: (await exists(venv)) ? (IS_WIN ? ".shoal-venv\\Scripts\\python" : ".shoal-venv/bin/python") : basePython,
      gradle: (await exists(path.join(dir, s.root, IS_WIN ? "gradlew.bat" : "gradlew"))) ? (IS_WIN ? "gradlew.bat" : "./gradlew") : "gradle",
    };
    const toolCmd = s.def.tool(s.framework, s.ctx);
    const tool = await sh(toolCmd, path.join(dir, s.root));
    s.toolOk = tool.ok;
    s.toolMessage = tool.ok ? null : `${s.def.language} tests need \`${toolCmd.split(" ").slice(0, s.framework === "pytest" ? 3 : 1).join(" ")}\`, which isn't available on this computer`;
    s.ci = ci.map((c) => c.command);
  }
  return stacks.sort((a, b) => b.root.length - a.root.length);
}

const exists = (p) => access(p).then(() => true, () => false);

// "seatkeeper/tests/test_booking.py" -> "seatkeeper"; "test_util.py" -> ".".
function pythonRoot(file) {
  const parts = dirOf(file) === "." ? [] : dirOf(file).split("/");
  const at = parts.map((p) => p.toLowerCase()).lastIndexOf("tests") >= 0 ? parts.map((p) => p.toLowerCase()).lastIndexOf("tests") : parts.map((p) => p.toLowerCase()).lastIndexOf("test");
  if (at >= 0) return parts.slice(0, at).join("/") || ".";
  return parts.join("/") || ".";
}
const owns = (s, file) => (s.root === "." || file.startsWith(s.root + "/")) && isTestPath(file) && (LANGUAGE_OF.find(([re]) => re.test(file))?.[1] ?? s.def.id) === languageId(s.def.id);
const languageId = (id) => (id === "gradle" ? "maven" : id);

// The stack a test file belongs to: the nearest project of the file's language.
export function stackFor(stacks, file) {
  return stacks.find((s) => owns(s, file)) ?? null;
}

// The shell command that runs these test files (paths relative to the repo
// root) and the folder to run it in.
export function commandFor(stack, files, { detail = false } = {}) {
  const rel = files.map((f) => (stack.root === "." ? f : f.slice(stack.root.length + 1)));
  return { cmd: stack.def.files(stack.framework, rel, detail, stack.ctx), cwd: stack.root };
}

// The runner found no tests in the file at all. That's a setup mismatch (say
// pytest-style tests run with unittest), never a failing test.
export const NO_TESTS = /NO TESTS RAN|\bRan 0 tests\b|collected 0 items|no tests ran|No tests found|no test files|0 examples, 0 failures|No tests executed|testsuites? empty/i;

export function parseResults(stack, output) {
  const parser = parsers[stack.def.parser(stack.framework)];
  return parser ? parser(output) : null;
}

export const installCommand = (stack, names) => stack.def.install(stack.root, { names: () => names, basePython: stack.ctx.basePython });
export const challengePath = (stack, testFile) => stack.def.challenge(testFile, stack.framework);
export const testHint = (stack) => `${stack.def.language}, ${stack.def.hint(stack.framework)}`;

// What the setup page and dashboard show.
export const describeStack = (s) => ({
  id: s.def.id,
  language: s.def.language,
  framework: s.framework,
  root: s.root,
  evidence: s.evidence,
  ci: s.ci,
  toolOk: s.toolOk,
  toolMessage: s.toolMessage,
  example: commandFor(s, [inDir(s.root, "<test file>")]).cmd,
});

// Manifests and test configs in every language: agents can read them but a
// fix may never change them (that would change the rules, not the code).
export const MANIFESTS = [
  /(^|\/)(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb)$/,
  /(^|\/)(jest|vitest|mocha|karma|playwright)\.config\.[cm]?[jt]s$|(^|\/)\.mocharc/,
  /(^|\/)(pyproject\.toml|setup\.py|setup\.cfg|tox\.ini|pytest\.ini|conftest\.py|Pipfile(\.lock)?|poetry\.lock|requirements[^/]*\.txt)$/,
  /(^|\/)(go\.mod|go\.sum|Cargo\.toml|Cargo\.lock)$/,
  /(^|\/)(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|gradle\.properties|gradlew(\.bat)?)$/,
  /(^|\/)(Gemfile(\.lock)?|\.rspec|composer\.(json|lock)|phpunit\.xml(\.dist)?)$/,
  /\.(csproj|sln|fsproj)$|(^|\/)(packages\.lock\.json|Directory\.Build\.props)$/,
];

// --- Related source files -----------------------------------------------------

// The code a test exercises, by language. Follows imports where the language
// makes that easy; otherwise uses the language's conventions (same package,
// same name minus "test"). Paths are relative to the repo root.
export async function sourcesFor(stack, testFile, dir, allFiles) {
  const id = stack?.def.id ?? LANGUAGE_OF.find(([re]) => re.test(testFile))?.[1];
  const files = allFiles ?? (await walk(dir));
  const code = (p) => !isTestPath(p) && files.includes(p);
  const read = (p) => readFile(path.join(dir, p), "utf8").catch(() => "");
  const sameDir = (ext) => files.filter((p) => dirOf(p) === dirOf(testFile) && p.endsWith(ext) && code(p));
  const named = (ext) => {
    const want = stem(testFile).replace(/^test_|_test$|_spec$|Tests?$|\.(test|spec)$/g, "").toLowerCase();
    return files.filter((p) => p.endsWith(ext) && code(p) && stem(p).toLowerCase() === want);
  };
  const follow = async (start, imports) => {
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length && seen.size < 300) {
      for (const p of await imports(queue.shift())) {
        if (p && !seen.has(p) && files.includes(p)) {
          seen.add(p);
          queue.push(p);
        }
      }
    }
    return [...seen].filter(code);
  };

  if (id === "node") {
    const exts = ["", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", "/index.js", "/index.ts"];
    return follow(testFile, async (f) => {
      const text = await read(f);
      return [...text.matchAll(/(?:from\s+|require\(\s*|import\(\s*)["'](\.{1,2}\/[^"']+)["']/g)].flatMap((m) => {
        const p = path.posix.normalize(path.posix.join(dirOf(f), m[1]));
        return exts.map((e) => p + e).filter((c) => files.includes(c)).slice(0, 1);
      });
    });
  }
  if (id === "python") {
    const root = stack?.root ?? ".";
    return follow(testFile, async (f) => {
      const text = await read(f);
      const mods = [...text.matchAll(/^\s*(?:from\s+(\.*[\w.]*)\s+import|import\s+([\w.]+))/gm)].map((m) => m[1] ?? m[2]);
      return mods.flatMap((mod) => {
        const dots = mod.match(/^\.*/)[0].length;
        const parts = mod.slice(dots).split(".").filter(Boolean);
        const bases = dots ? [path.posix.join(dirOf(f), ...Array(dots - 1).fill(".."))] : [root, dirOf(f), inDir(root, "src")];
        return bases.flatMap((b) => [`${path.posix.join(b, ...parts)}.py`, path.posix.join(b, ...parts, "__init__.py")].map((p) => path.posix.normalize(p)));
      });
    });
  }
  if (id === "go") {
    const mod = ((await read(inDir(stack?.root ?? ".", "go.mod"))).match(/^module\s+(\S+)/m) ?? [])[1];
    return follow(testFile, async (f) => {
      const text = await read(f);
      const pkgDirs = [dirOf(f), ...[...text.matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((i) => mod && i.startsWith(mod + "/")).map((i) => inDir(stack.root, i.slice(mod.length + 1)))];
      return files.filter((p) => p.endsWith(".go") && pkgDirs.includes(dirOf(p)));
    });
  }
  if (id === "rust") return files.filter((p) => p.endsWith(".rs") && code(p) && p.startsWith(inDir(stack?.root ?? ".", "src") + "/"));
  if (id === "ruby") {
    return follow(testFile, async (f) => {
      const text = await read(f);
      return [...text.matchAll(/require(_relative)?\s+['"]([^'"]+)['"]/g)].flatMap((m) => (m[1] ? [path.posix.normalize(path.posix.join(dirOf(f), m[2]) + ".rb")] : [`lib/${m[2]}.rb`, inDir(stack?.root ?? ".", `lib/${m[2]}.rb`)]));
    });
  }
  const ext = { maven: [".java", ".kt"], gradle: [".java", ".kt"], php: [".php"], dotnet: [".cs"] }[id] ?? [];
  if (ext.length) {
    const mainDir = dirOf(testFile).replace(/(^|\/)src\/test\//, "$1src/main/");
    return [...new Set([...ext.flatMap(named), ...files.filter((p) => dirOf(p) === mainDir && ext.some((e) => p.endsWith(e)) && code(p)), ...ext.flatMap(sameDir)])];
  }
  return [];
}
