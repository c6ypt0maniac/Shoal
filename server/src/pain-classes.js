// Pain classes beyond flaky tests. Each class has a number that moves and a way
// to measure it with no model in the loop: Shoal counts something in the repo
// (or reads CI/PR telemetry), a fix is applied in a sandbox, Shoal counts again,
// and the bounty is only paid if the number moved the right way without a
// gaming shortcut (see `guard`).
//
// "local" classes are measured from the repo's files, so a fix can be verified
// in a sandbox right away. "remote" classes (CI duration, PR cycle time) can
// only be judged on real telemetry after the change lands, so they are
// re-measured later with remeasure(). Classes that need a vendor account
// (warehouse and observability spend) are listed in the catalog but can't be
// scanned until a connector exists.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createSandbox, destroySandbox, listAllFiles, readRepoFile, WORKSPACE, writeFiles } from "./repo.js";
import { emit } from "./events.js";
import { state, newId } from "./store.js";
import { inScope, isSecret } from "./scope.js";
import { isProtected } from "./verifier.js";
import { isTestPath } from "./stack.js";
import { ciStats, pullStats } from "./hosts.js";
import { chargeEscrow, newEscrow, releaseEscrow } from "./escrow.js";

const DOLLARS_PER_DEV_HOUR = 25;
const round1 = (n) => Math.round(n * 10) / 10;
const norm = (p) => p.replace(/\\/g, "/");
const SOURCE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|rb|php|cs)$/;

// Runtimes older than these are out of upstream support (approximate, as of
// late 2026). Update the table instead of trusting it forever.
const MIN_SUPPORTED = { node: 22, python: [3, 11], java: 17, go: [1, 25] };

// --- Detectors ---------------------------------------------------------------
// Each reads files through `read(path)` / `files` so it works on the workspace
// and on a sandbox with a fix applied. Returns { value, items } where value is
// the number to bring down and items says where it comes from.

const TYPE_ESCAPES = /@ts-ignore|@ts-nocheck|@ts-expect-error|\bas any\b|:\s*any\b|<any>|#\s*type:\s*ignore|:\s*Any\b|->\s*Any\b/g;
async function typeEscapes({ files, read }) {
  const items = [];
  for (const f of files.filter((f) => /\.(?:tsx?|py)$/.test(f) && !isTestPath(f))) {
    const n = ((await read(f)).match(TYPE_ESCAPES) ?? []).length;
    if (n) items.push({ path: f, count: n });
  }
  return { value: items.reduce((s, i) => s + i.count, 0), items };
}

// Each file that declares a runtime version, checked against MIN_SUPPORTED.
async function runtimeVersions({ files, read }) {
  const items = [];
  const add = (p, runtime, version, text) => {
    const major = runtime === "node" || runtime === "java" ? Number(String(version).match(/\d+/)?.[0]) : String(version).match(/(\d+)\.(\d+)/)?.slice(1, 3).map(Number);
    if (!major || (Array.isArray(major) && major.some(Number.isNaN))) return;
    const min = MIN_SUPPORTED[runtime];
    const old = Array.isArray(min) ? major[0] < min[0] || (major[0] === min[0] && major[1] < min[1]) : major < min;
    if (old) items.push({ path: p, runtime, version: String(version), text });
  };
  for (const f of files) {
    const base = path.posix.basename(f);
    if (/^(\.nvmrc|\.node-version)$/.test(base)) add(f, "node", (await read(f)).trim().replace(/^v/, ""), base);
    else if (base === ".python-version") add(f, "python", (await read(f)).trim(), base);
    else if (base === "package.json") {
      const engine = JSON.parse((await read(f)) || "{}").engines?.node;
      if (engine) add(f, "node", engine.match(/\d+/)?.[0], `engines.node ${engine}`);
    } else if (base === "pyproject.toml" || base === "setup.cfg") {
      const m = (await read(f)).match(/(?:requires-python|python_requires)\s*=\s*["']?[><=~!\s]*(\d+\.\d+)/);
      if (m) add(f, "python", m[1], `requires-python ${m[1]}`);
    } else if (base === "go.mod") {
      const m = (await read(f)).match(/^go\s+(\d+\.\d+)/m);
      if (m) add(f, "go", m[1], `go ${m[1]}`);
    } else if (/^Dockerfile/.test(base)) {
      for (const m of (await read(f)).matchAll(/^FROM\s+(?:--\S+\s+)?(node|python|golang|eclipse-temurin|openjdk):(\d+(?:\.\d+)?)/gim)) {
        add(f, { node: "node", python: "python", golang: "go" }[m[1]] ?? "java", m[2], `FROM ${m[1]}:${m[2]}`);
      }
    } else if (/^\.github\/workflows\/.+\.ya?ml$/.test(f) || /\.gitlab-ci\.yml$/.test(f)) {
      for (const m of (await read(f)).matchAll(/(node|python|go|java)-version:\s*\[?([^\]\n#]+)/g)) {
        for (const v of m[2].split(",").map((s) => s.trim().replace(/["']/g, "")).filter(Boolean)) add(f, m[1], v, `${m[1]}-version ${v}`);
      }
    } else if (base === "pom.xml") {
      const m = (await read(f)).match(/<(?:java\.version|maven\.compiler\.(?:source|release))>\s*(?:1\.)?(\d+)/);
      if (m) add(f, "java", m[1], `java ${m[1]}`);
    }
  }
  return { value: items.length, items };
}

// package.json dependencies that no source file, script or config mentions.
async function unusedDeps({ files, read }) {
  const items = [];
  for (const manifest of files.filter((f) => path.posix.basename(f) === "package.json")) {
    const dir = path.posix.dirname(manifest);
    const pkg = JSON.parse((await read(manifest)) || "{}");
    const mine = files.filter((f) => (dir === "." || f.startsWith(dir + "/")) && /\.(?:[cm]?[jt]sx?|vue|svelte|json|ya?ml|cjs|mjs)$/.test(f) && f !== manifest && !/lock/.test(f));
    const haystack = (await Promise.all(mine.map(read))).join("\n") + JSON.stringify(pkg.scripts ?? {}) + JSON.stringify(pkg.bin ?? {});
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      const bare = dep.replace(/^@types\//, "");
      if (!haystack.includes(`"${dep}"`) && !haystack.includes(`'${dep}'`) && !haystack.includes(`${dep}/`) && !haystack.includes(bare)) items.push({ path: manifest, dependency: dep });
    }
  }
  return { value: items.length, items };
}

// Relative links and images in Markdown that point at files that don't exist.
async function brokenDocLinks({ files, read }) {
  const have = new Set(files);
  const items = [];
  for (const f of files.filter((f) => /\.(md|mdx)$/i.test(f))) {
    const text = (await read(f)).replace(/```[\s\S]*?```/g, "");
    for (const m of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const href = m[1].split("#")[0].split("?")[0];
      if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//") || href.startsWith("#")) continue;
      const target = norm(path.posix.normalize(href.startsWith("/") ? href.slice(1) : path.posix.join(path.posix.dirname(f), decodeURIComponent(href))));
      if (!have.has(target) && ![...have].some((h) => h.startsWith(target + "/"))) items.push({ path: f, link: m[1] });
    }
  }
  return { value: items.length, items };
}

const SECRET_PATTERNS = [
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  /gh[pousr]_[A-Za-z0-9]{30,}/,
  /sk_(?:live|test)_[A-Za-z0-9]{16,}/,
  /xox[abprs]-[A-Za-z0-9-]{10,}/,
  /\b(?:password|passwd|secret|api[_-]?key|token)\b\s*[:=]\s*["'][^"'\s]{8,}["']/i,
];
async function hardcodedSecrets({ files, read }) {
  const items = [];
  for (const f of files.filter((f) => !/\.(png|jpe?g|gif|ico|pdf|zip|lock)$/i.test(f) && !/package-lock\.json$|\.example$|\.sample$/.test(f))) {
    const text = await read(f).catch(() => "");
    const hit = SECRET_PATTERNS.find((re) => re.test(text));
    if (hit && !/process\.env|os\.environ|getenv|\$\{/.test(text.match(hit)?.[0] ?? "")) items.push({ path: f, rule: hit.source.slice(0, 24) });
  }
  return { value: items.length, items };
}

// --- Catalog -----------------------------------------------------------------

export const CLASSES = {
  "type-coverage": {
    title: "Type escape hatches",
    metric: "any casts and ts-ignore/type: ignore comments",
    unit: "escapes",
    where: "local",
    measure: typeEscapes,
    hoursPerItem: 0.05,
    guard: "Suppressions count as escapes, so hiding an error doesn't lower the number. Tests are protected.",
    allowManifests: false,
  },
  "runtime-upgrade": {
    title: "Out-of-support runtime versions",
    metric: "files that pin an unsupported Node, Python, Java or Go version",
    unit: "pins",
    where: "local",
    measure: runtimeVersions,
    hoursPerItem: 1.5,
    guard: "Tests are protected and must still pass on the new runtime; CI config and manifests may change.",
    allowManifests: true,
    testsMustPass: true,
  },
  "unused-deps": {
    title: "Unused dependencies",
    metric: "dependencies no source file references",
    unit: "dependencies",
    where: "local",
    measure: unusedDeps,
    hoursPerItem: 0.3,
    guard: "Tests are protected and must still pass after the removal.",
    allowManifests: true,
    testsMustPass: true,
  },
  "docs-accuracy": {
    title: "Broken documentation links",
    metric: "relative links and images that point at missing files",
    unit: "broken links",
    where: "local",
    measure: brokenDocLinks,
    hoursPerItem: 0.1,
    guard: "A link can't be fixed by deleting the whole document: Markdown files can't shrink by more than half.",
    allowManifests: false,
  },
  "hardcoded-secrets": {
    title: "Hardcoded secrets",
    metric: "files containing credentials",
    unit: "files",
    where: "local",
    measure: hardcodedSecrets,
    hoursPerItem: 2,
    guard: "Rotating the exposed value is the team's job and Shoal never touches production secrets: the fix only moves them to environment variables.",
    allowManifests: false,
    testsMustPass: true,
  },
  "ci-duration": {
    title: "Slow CI",
    metric: "average workflow minutes",
    unit: "minutes",
    where: "remote",
    guard: "Judged on real workflow runs after the change merges, not on a claim.",
  },
  "pr-cycle-time": {
    title: "Slow pull-request turnaround",
    metric: "median hours from PR opened to merged",
    unit: "hours",
    where: "remote",
    guard: "Judged on real merged PRs after the change lands.",
  },
  "warehouse-cost": {
    title: "Data warehouse query cost",
    metric: "bytes scanned or credits on the top queries",
    unit: "credits",
    where: "needs-connector",
    guard: "Query results must match exactly on a sample. Needs a Snowflake or BigQuery connector.",
  },
  "observability-spend": {
    title: "Observability spend",
    metric: "monthly log and metrics ingestion volume",
    unit: "GB",
    where: "needs-connector",
    guard: "Existing alerts must still fire on replayed incidents. Needs a Datadog or similar connector.",
  },
};

// --- Scanning ------------------------------------------------------------------

async function workspaceFiles() {
  return (await listAllFiles(WORKSPACE)).map(norm).filter((p) => !isSecret(p) && inScope(p));
}

export async function scanClasses({ only } = {}) {
  const files = await workspaceFiles();
  const read = (f) => readRepoFile(f).catch(() => "");
  const found = [];
  for (const [id, cls] of Object.entries(CLASSES)) {
    if (only && !only.includes(id)) continue;
    let pain = null;
    if (cls.where === "local") {
      const { value, items } = await cls.measure({ files, read });
      pain = { baseline: value, items: items.slice(0, 50), hoursPerWeek: round1(value * cls.hoursPerItem) };
    } else if (cls.where === "remote") {
      pain = await remoteBaseline(id).catch((err) => ({ error: err.message }));
    } else {
      pain = { error: "Needs a connector Shoal doesn't have yet" };
    }
    const existing = state.classPains.find((p) => p.classId === id);
    const entry = {
      id: existing?.id ?? newId("cpain"),
      kind: id,
      classId: id,
      title: cls.title,
      metric: cls.metric,
      unit: cls.unit,
      where: cls.where,
      guard: cls.guard,
      healthy: pain.baseline === 0,
      scannedAt: new Date().toISOString(),
      ...pain,
    };
    entry.target = pain.baseline > 0 ? targetFor(entry) : null;
    entry.suggestedReward = entry.baseline > 0 ? Math.max(25, Math.round(((entry.hoursPerWeek ?? 1) * DOLLARS_PER_DEV_HOUR) / 5) * 5) : 0;
    found.push(entry);
  }
  state.classPains = [...state.classPains.filter((p) => only && !only.includes(p.classId)), ...found];
  const open = found.filter((p) => p.baseline > 0);
  emit("scan.classes", {
    message: `Pain classes: ${open.length ? open.map((p) => `${p.title} (${p.baseline} ${p.unit})`).join(", ") : "nothing to fix"}${found.some((p) => p.error) ? `; ${found.filter((p) => p.error).length} couldn't be measured` : ""}`,
    classPains: state.classPains,
  });
  return state.classPains;
}

// Local classes must reach zero; remote ones must improve by 30%.
const targetFor = (p) => (p.where === "remote" ? round1(p.baseline * 0.7) : 0);

async function remoteBaseline(id) {
  const conn = state.connection;
  if (!["github", "gitlab", "bitbucket"].includes(conn.type)) throw new Error("Needs a connected GitHub, GitLab or Bitbucket repo");
  if (id === "ci-duration") {
    const ci = state.ci?.length ? state.ci : await ciStats(conn.type, conn.fullName);
    const timed = ci.filter((w) => w.avgMinutes != null);
    if (!timed.length) throw new Error("No completed CI runs to measure");
    const runs = timed.reduce((s, w) => s + w.runs, 0);
    const avg = round1(timed.reduce((s, w) => s + w.avgMinutes * w.runs, 0) / runs);
    return { baseline: avg, runs, items: timed.map((w) => ({ workflow: w.workflow, avgMinutes: w.avgMinutes, runs: w.runs })), hoursPerWeek: round1((avg / 60) * 150 * 0.3) };
  }
  const stats = await pullStats(conn.type, conn.fullName);
  if (stats.merged < 5) throw new Error(`Only ${stats.merged} merged PRs: too few to measure`);
  return { baseline: stats.medianHours, runs: stats.merged, items: [], hoursPerWeek: round1(Math.min(stats.medianHours, 72) * 0.5) };
}

// A bounty on a remote class is judged later, from fresh telemetry.
export async function remeasure(bountyId) {
  const bounty = state.bounties.find((b) => b.id === bountyId);
  const pain = state.classPains.find((p) => p.id === bounty?.classPainId);
  if (!bounty || !pain) throw httpError(404, "No such class bounty");
  if (pain.where !== "remote") throw httpError(400, "This bounty is verified by submitting a fix, not by re-measuring");
  const now = await remoteBaseline(pain.classId);
  const passed = now.baseline <= pain.target;
  bounty.remeasure = { at: new Date().toISOString(), before: pain.baseline, after: now.baseline, target: pain.target, passed };
  emit("class.remeasured", { bountyId, message: `${pain.title}: ${pain.baseline} → ${now.baseline} ${pain.unit} (target ${pain.target}) ${passed ? "reached" : "not reached"}` });
  if (passed && bounty.escrow.status === "held") await settleClass(bounty, "telemetry");
  return bounty.remeasure;
}

// --- Bounties and verification -------------------------------------------------

export function createClassBounty({ classPainId, reward, funding = "simulated" }) {
  const pain = state.classPains.find((p) => p.id === classPainId);
  if (!pain) throw httpError(404, `Unknown pain class entry ${classPainId}`);
  if (pain.error) throw httpError(400, `${pain.title} couldn't be measured: ${pain.error}`);
  if (pain.healthy) throw httpError(400, `${pain.title}: nothing to fix`);
  const amount = Math.round(Number(reward) || pain.suggestedReward);
  if (amount < 1 || amount > 10_000) throw httpError(400, "Reward must be between $1 and $10,000");
  const bounty = {
    id: newId("bounty"),
    kind: pain.classId,
    classPainId: pain.id,
    painId: null,
    title: `${pain.title}: ${pain.baseline} → ${pain.target} ${pain.unit}`,
    reward: amount,
    escrow: newEscrow(amount, funding),
    bids: [],
    attempts: [],
    winner: null,
    createdAt: new Date().toISOString(),
  };
  bounty.status = bounty.escrow.status === "held" ? "open" : "awaiting_funding";
  state.bounties.unshift(bounty);
  emit("bounty.created", { bountyId: bounty.id, reward: amount, message: `New bounty: $${amount} for ${bounty.title}` });
  return bounty;
}

// Applies a fix to a sandbox and measures again. Passes only if the metric
// reached the target, no protected file was touched, and the class's own
// guard holds (docs can't be gutted; tests must still pass where it matters).
export async function verifyClassFix(bountyId, { agentId, files }) {
  const bounty = state.bounties.find((b) => b.id === bountyId);
  const pain = state.classPains.find((p) => p.id === bounty?.classPainId);
  const cls = CLASSES[pain?.classId];
  if (!bounty || !cls) throw httpError(404, "No such class bounty");
  if (cls.where !== "local") throw httpError(400, "This class is verified from telemetry: use re-measure");
  if (bounty.escrow.status !== "held") throw httpError(402, "Fund this bounty before submitting a fix");
  if (!Array.isArray(files) || !files.length) throw httpError(400, "files: [{ path, content }] required");

  const fail = (reason) => {
    bounty.attempts.push({ agentId, passed: false, reason, files: files.map((f) => f.path) });
    emit("verify.rejected", { bountyId, agentId, reason, message: `${agentId} rejected: ${reason}` });
    return { passed: false, reason };
  };

  for (const f of files) {
    const p = norm(f.path).replace(/^\.\//, "");
    if (!p || p.startsWith("/") || p.split("/").includes("..")) return fail(`Bad path ${f.path}`);
    if (isTestPath(p) || (isProtected(p) && !(cls.allowManifests && isManifestOrCi(p)))) return fail(`${p} is protected`);
    if (isSecret(p) || !inScope(p)) return fail(`${p} isn't shared with agents`);
  }

  bounty.status = "verifying";
  const sandbox = await createSandbox();
  try {
    await writeFiles(sandbox, files);
    const all = (await listAllFiles(sandbox)).map(norm).filter((p) => !isSecret(p));
    const read = (f) => readFile(path.join(sandbox, f), "utf8").catch(() => "");
    const after = await cls.measure({ files: all, read });
    if (pain.classId === "docs-accuracy") {
      for (const f of files.filter((f) => /\.mdx?$/i.test(f.path))) {
        const before = (await readRepoFile(f.path).catch(() => "")).length;
        if (f.content.length < before / 2) return fail(`${f.path} shrank by more than half`);
      }
    }
    if (after.value > pain.target) {
      bounty.status = "open";
      return fail(`${pain.metric}: ${pain.baseline} → ${after.value}, target ${pain.target}`);
    }
    bounty.attempts.push({ agentId, passed: true, files: files.map((f) => f.path), before: pain.baseline, after: after.value });
    emit("verify.passed", { bountyId, agentId, message: `${agentId}'s fix verified: ${pain.baseline} → ${after.value} ${pain.unit}` });
    if (cls.testsMustPass) bounty.testsNote = "Run the repo's tests on this patch before merging: Shoal measured the metric, not behavior.";
    await writeFiles(WORKSPACE, files);
    await settleClass(bounty, agentId);
    return { passed: true, before: pain.baseline, after: after.value };
  } finally {
    await destroySandbox(sandbox);
  }
}

const isManifestOrCi = (p) => /(^|\/)(package\.json|pyproject\.toml|setup\.cfg|go\.mod|pom\.xml|Dockerfile[^/]*|\.nvmrc|\.node-version|\.python-version|requirements[^/]*\.txt)$|^\.github\/workflows\/|\.gitlab-ci\.yml$/.test(p);

const TAKE_RATE = 0.15;

async function settleClass(bounty, payee) {
  const pain = state.classPains.find((p) => p.id === bounty.classPainId);
  const amount = await chargeEscrow(bounty, bounty.reward);
  const fee = Math.round(amount * TAKE_RATE);
  state.ledger.unshift({
    id: newId("tx"),
    bountyId: bounty.id,
    agentId: payee,
    amount,
    agentPayout: amount - fee,
    platformFee: fee,
    savedUnderReward: 0,
    funding: bounty.escrow.mode,
    paymentIntentId: bounty.escrow.paymentIntentId,
    hoursReturnedPerWeek: pain?.hoursPerWeek ?? 0,
    settledAt: new Date().toISOString(),
  });
  bounty.winner = payee;
  bounty.status = "settled";
  emit("bounty.settled", {
    bountyId: bounty.id,
    agentId: payee,
    amount,
    hoursReturnedPerWeek: pain?.hoursPerWeek ?? 0,
    message: `SETTLED: ${payee} paid $${amount} for ${bounty.title}`,
  });
}

export async function failClassBounty(bountyId) {
  const bounty = state.bounties.find((b) => b.id === bountyId);
  if (!bounty) throw httpError(404, "No such bounty");
  await releaseEscrow(bounty);
  bounty.status = "failed";
  return bounty;
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
