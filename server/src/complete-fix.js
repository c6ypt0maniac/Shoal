// Builds one reviewable repository from the best proven trial for every
// failing test. Nothing is pushed until the person approves the final result.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSandbox, destroySandbox, listAllFiles, readRepoFile, runTestOnce, sh, WORKSPACE, writeFiles } from "./repo.js";
import { diffFiles, proofFor } from "./proof.js";
import { canOpenChanges, openChange } from "./hosts.js";
import { isSecret } from "./scope.js";
import { emit } from "./events.js";
import { state } from "./store.js";
import { MODELS } from "./trials.js";

let building = false;

export function completeFixStatus() {
  const flaky = state.pains.filter((p) => !p.healthy);
  const proven = flaky.filter((p) => proofFor(p.id).proven).length;
  const value = state.completeFix ?? { status: "idle" };
  const { files: _files, ...publicValue } = value;
  return { ...publicValue, eligible: flaky.length > 0 && proven === flaky.length, proven, total: flaky.length };
}

export async function buildCompleteFix() {
  if (building) return completeFixStatus();
  const pains = state.pains.filter((p) => !p.healthy);
  const picks = pains.map((pain) => ({ pain, proof: proofFor(pain.id).proven }));
  const missing = picks.filter((x) => !x.proof).map((x) => x.pain.testFile);
  if (!pains.length) throw Object.assign(new Error("No failing tests are available to fix"), { status: 409 });
  if (missing.length) throw Object.assign(new Error(`Wait for a proven fix for: ${missing.join(", ")}`), { status: 409 });

  building = true;
  state.completeFix = { status: "building", startedAt: new Date().toISOString(), selected: [] };
  emit("complete.started", { message: `Building one complete repo from ${picks.length} proven fix${picks.length === 1 ? "" : "es"}` });
  const sandbox = await createSandbox();
  try {
    const combined = new Map();
    const conflicts = [];
    const selected = [];
    for (const { pain, proof } of picks) {
      const trial = state.trials.find((t) => t.id === proof.trialId);
      if (!trial) throw new Error(`The proven trial for ${pain.testFile} is no longer available`);
      selected.push({ painId: pain.id, testFile: pain.testFile, trialId: trial.id, model: trial.model, name: MODELS[trial.model]?.name ?? trial.model });
      for (const file of trial.files) {
        const filePath = clean(file.path);
        const base = await readRepoFile(filePath).catch(() => "");
        const current = combined.get(filePath) ?? base;
        const merged = await mergeContents(base, current, String(file.content));
        if (merged.conflict) conflicts.push({ path: filePath, tests: selected.filter((s) => state.trials.find((t) => t.id === s.trialId)?.files.some((f) => clean(f.path) === filePath)).map((s) => s.testFile) });
        else combined.set(filePath, merged.content);
      }
    }
    if (conflicts.length) {
      state.completeFix = { status: "conflict", selected, conflicts, finishedAt: new Date().toISOString() };
      emit("complete.conflict", { message: `Complete repo needs a choice: ${conflicts.map((c) => c.path).join(", ")} contains conflicting fixes` });
      return completeFixStatus();
    }

    const files = [...combined].map(([filePath, content]) => ({ path: filePath, content }));
    await writeFiles(sandbox, files);
    const suite = await runTestOnce(sandbox);
    const diff = await diffFiles(files);
    state.completeFix = {
      status: suite.passed ? "ready" : "failed",
      selected,
      files,
      diff,
      suite: { passed: suite.passed, log: suite.log },
      finishedAt: new Date().toISOString(),
      pullRequest: null,
    };
    emit(suite.passed ? "complete.ready" : "complete.failed", {
      message: suite.passed
        ? `Complete repo is ready: ${selected.length} fixes combined, ${diff.files.length} files changed, full test suite passed`
        : "Selected fixes did not pass together, so the complete repo cannot be approved",
    });
    return completeFixStatus();
  } finally {
    building = false;
    await destroySandbox(sandbox);
  }
}

export async function completeRepoFiles() {
  if (state.completeFix?.status !== "ready") throw Object.assign(new Error("Build and verify the complete fix first"), { status: 409 });
  const fixed = new Map(state.completeFix.files.map((f) => [f.path, f.content]));
  const paths = [...new Set([...(await listAllFiles(WORKSPACE)), ...fixed.keys()])].filter((p) => !isSecret(p));
  return Promise.all(paths.map(async (p) => ({ path: p, data: fixed.get(p) ?? (await readFile(path.join(WORKSPACE, p))) })));
}

export async function approveCompleteFix() {
  const complete = state.completeFix;
  if (complete?.status !== "ready") throw Object.assign(new Error("The complete repository has not passed its full test suite"), { status: 409 });
  if (complete.pullRequest) return complete.pullRequest;
  const repo = state.connection;
  if (!canOpenChanges(repo) || !repo.canWrite) throw Object.assign(new Error("The connected repository cannot accept a pull request from this account"), { status: 403 });
  const body = [
    "## Complete Shoal fix",
    "",
    ...complete.selected.map((s) => `- \`${s.testFile}\` — ${s.name}`),
    "",
    `All ${complete.selected.length} selected fixes were combined and the complete test suite passed before this pull request was opened.`,
  ].join("\n");
  const pr = await openChange(repo, {
    branch: `shoal/complete-${Date.now()}`,
    title: `[Shoal] Complete verified fix for ${complete.selected.length} problem${complete.selected.length === 1 ? "" : "s"}`,
    body,
    files: complete.files,
  });
  complete.pullRequest = pr;
  emit("complete.approved", { url: pr.url, message: `Complete fix approved: opened review #${pr.number}` });
  return pr;
}

async function mergeContents(base, current, incoming) {
  if (current === incoming) return { content: current, conflict: false };
  if (current === base) return { content: incoming, conflict: false };
  if (incoming === base) return { content: current, conflict: false };
  const dir = await mkdtemp(path.join(tmpdir(), "shoal-merge-"));
  const names = ["current", "base", "incoming"].map((n) => path.join(dir, n));
  try {
    await Promise.all([writeFile(names[0], current), writeFile(names[1], base), writeFile(names[2], incoming)]);
    const result = await sh(`git merge-file -p ${names.map((n) => JSON.stringify(n)).join(" ")}`, dir);
    return result.ok ? { content: result.output, conflict: false } : { content: null, conflict: true };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const clean = (p) => String(p).replace(/\\/g, "/").replace(/^\.\//, "");
