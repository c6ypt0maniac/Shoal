// Keeps the connected repo in step with GitHub instead of a one-time snapshot.
// Every minute (auto-sync), or when the team clicks Sync now, Shoal checks the
// branch's latest commit. If it moved: pull it, reinstall dependencies only if
// a manifest changed, refresh the workspace (re-detecting languages), put back
// fixes the team already bought, drop trials and proofs that were judged on
// code that has since changed, flag new folders the team hasn't shared,
// rescan, and re-measure every fix still in its survival window (survival.js). Nothing happens mid-run: while a trial, proof or fix is in progress
// the sync waits and runs right after.
import { emit } from "./events.js";
import { state } from "./store.js";
import { getSource, resetWorkspace, sh, writeFiles, WORKSPACE } from "./repo.js";
import { headSha, pullRepo, reinstall } from "./github.js";
import { inScope, isSecret } from "./scope.js";
import { scan } from "./scanner.js";
import { isProving } from "./proof.js";
import { checkSurvivors, isCheckingSurvival } from "./survival.js";

const CHECK_EVERY_MS = 60_000;
let syncing = false;

const short = (sha) => (sha ? sha.slice(0, 7) : "?");
const dirOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".");

// Something is using the current code, so swapping it now would mix versions.
function busy() {
  if (state.trialRun?.status === "running") return "a model trial is running";
  if (isProving()) return "a proof report is being built";
  if (isCheckingSurvival()) return "a survival check is running";
  if (state.bounties.some((b) => ["competing", "verifying", "judging"].includes(b.status))) return "a fix is being made";
  return null;
}

// Called right after connecting: remember which commit the clone is at.
export async function markConnected(dir) {
  const head = (await sh("git rev-parse HEAD", dir)).output.trim();
  const message = (await sh("git log -1 --format=%s", dir)).output.trim();
  state.connection.head = { sha: head, message };
  state.connection.newPaths = [];
  state.sync = { auto: state.sync?.auto ?? true, checkedAt: new Date().toISOString(), syncedAt: new Date().toISOString(), waiting: null, error: null };
}

export function syncStatus() {
  return { ...state.sync, head: state.connection.head ?? null, newPaths: state.connection.newPaths ?? [], syncing };
}

export function setAutoSync(on) {
  state.sync.auto = Boolean(on);
  emit("sync.auto", { message: `Auto-sync ${state.sync.auto ? "on: Shoal checks GitHub for new commits every minute" : "off: use Sync now to pull new commits"}` });
  return syncStatus();
}

export async function syncNow({ source = "manual" } = {}) {
  const conn = state.connection;
  if (conn.type !== "github") throw httpError(400, "Only GitHub repos can sync. The demo repo doesn't change.");
  if (syncing) return syncStatus();
  const reason = busy();
  if (reason) {
    state.sync.waiting = reason;
    if (source === "manual") emit("sync.waiting", { message: `Sync will run as soon as ${reason.replace(/^a /, "the ")} finishes` });
    return syncStatus();
  }
  syncing = true;
  try {
    const head = await headSha(conn.fullName, conn.defaultBranch, { fresh: true });
    state.sync.checkedAt = new Date().toISOString();
    state.sync.waiting = null;
    state.sync.error = null;
    if (head.sha === conn.head?.sha) {
      if (source === "manual") emit("sync.current", { message: `Already up to date with ${conn.defaultBranch} (${short(head.sha)})` });
      return syncStatus();
    }

    emit("sync.started", { message: `New commit on ${conn.defaultBranch}: ${short(head.sha)} "${head.message}". Pulling it…` });
    const dir = getSource().dir;
    const { after, changed } = await pullRepo(dir, conn.fullName, conn.defaultBranch);
    await reinstall(dir, changed, (message) => emit("sync.step", { message }));
    await resetWorkspace();
    await reapplyBoughtFixes(changed);
    const stale = dropStaleResults(changed);
    conn.head = { sha: after, message: head.message };
    conn.newPaths = unsharedNewPaths(changed);
    state.sync.syncedAt = new Date().toISOString();

    const added = changed.length;
    emit("sync.done", {
      message: `Synced to ${short(after)}: ${added} file${added === 1 ? "" : "s"} changed${stale ? `; cleared trials and proofs for ${stale} test${stale === 1 ? "" : "s"} whose code changed` : ""}${conn.newPaths.length ? `; new and not shared with agents: ${conn.newPaths.map((p) => `${p}/`).join(", ")}` : ""}`,
    });
    await scan();
    // New code is exactly when a held fix might break.
    await checkSurvivors({ trigger: `new commit ${short(after)}` });
    return syncStatus();
  } catch (err) {
    state.sync.error = err.message;
    emit("sync.error", { message: `Sync failed: ${err.message}` });
    throw err;
  } finally {
    syncing = false;
  }
}

// Fixes the team bought live in the workspace, not on GitHub until their PR
// merges. Put them back unless the same files changed upstream. Also called
// at startup, after the workspace is rebuilt from the clone.
export async function reapplyBoughtFixes(changed = []) {
  for (const b of state.bounties.filter((b) => ["surviving", "settled"].includes(b.status))) {
    const files = b.attempts.find((a) => a.passed && a.agentId === b.winner)?.files ?? [];
    const clash = files.filter((f) => changed.includes(f.path)).map((f) => f.path);
    if (clash.length) {
      emit("sync.step", { message: `${b.title}: ${clash.join(", ")} also changed on GitHub, so the bought fix wasn't re-applied. Check its pull request.` });
    } else if (files.length) {
      await writeFiles(WORKSPACE, files);
    }
  }
}

// Trials and proofs only count for the code they were judged on. Drop them
// for every test whose test file or related code changed. Returns how many.
function dropStaleResults(changed) {
  const touched = new Set(changed);
  const stale = state.pains.filter((p) => [p.testFile, ...(p.sourceFiles ?? []), ...(p.hiddenSources ?? [])].some((f) => touched.has(f))).map((p) => p.id);
  if (!stale.length) return 0;
  state.trials = state.trials.filter((t) => !stale.includes(t.painId));
  for (const [id, proof] of Object.entries(state.proofs)) if (stale.includes(proof.painId)) delete state.proofs[id];
  return stale.length;
}

// Folders with new files that the team's sharing choices leave out.
function unsharedNewPaths(changed) {
  if (!state.connection.sharedPaths?.length) return []; // sharing the whole repo: new files are included
  const fresh = changed.filter((p) => !inScope(p) && !isSecret(p));
  const previous = state.connection.newPaths ?? [];
  return [...new Set([...previous, ...fresh.map(dirOf)])].filter((d) => d !== ".git" && !state.connection.sharedPaths.includes(d));
}

// Background check. Also catches up on a sync that had to wait.
setInterval(() => {
  if (state.connection.type !== "github" || !state.connection.head || syncing) return;
  if (!state.sync?.auto && !state.sync?.waiting) return;
  syncNow({ source: "auto" }).catch(() => {});
}, CHECK_EVERY_MS).unref();

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
