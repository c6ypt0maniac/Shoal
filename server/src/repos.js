// Several repos, one active. The Repository page connects one repo at a time
// (scans, trials and proofs are about it), but switching never strands a
// bounty: each bounty remembers its repo when it's posted, and its race,
// verification, survival checks and pull request run on that repo.
//
// A bounty on the active repo uses the active working copy (.workspace). A
// bounty on another repo gets that repo's own working copy, "parked" under
// .workspace-repos/, built from its clone in .repos/ plus the fixes the team already
// bought there. Survival checks pull new commits into a parked repo first, so
// a regression upstream is still caught after you've switched away.
import path from "node:path";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { state } from "./store.js";
import { WORKSPACE, buildWorkspace, getSource, withRepo, writeFiles } from "./repo.js";
import { pullRepo } from "./github.js";

// Next to the active working copy (.workspace -> .workspace-repos).
// A function: WORKSPACE can move at startup (repo.js claimWorkspace).
const parkedDir = () => WORKSPACE + "-repos";

// "owner/name" for a GitHub repo, "demo" for the bundled one.
export const repoKey = (conn = state.connection) => (conn?.type === "github" ? conn.fullName : "demo");

// What a bounty remembers about the repo it was posted on.
export function repoSnapshot() {
  const c = state.connection, src = getSource();
  return {
    key: repoKey(c),
    type: c.type,
    fullName: c.fullName,
    defaultBranch: c.defaultBranch ?? null,
    canWrite: Boolean(c.canWrite),
    url: c.url ?? null,
    dir: src.dir,
    testCommand: src.testCommand ?? null,
  };
}

// Bounties from before repos were remembered belong to the active repo.
export const isActive = (b) => !b.repo || b.repo.key === repoKey();
const keyOf = (b) => b.repo?.key ?? repoKey();

// The fix a bounty bought, if any.
export const boughtFiles = (b) => (["surviving", "settled"].includes(b.status) ? (b.attempts.find((a) => a.passed && a.agentId === b.winner)?.files ?? []) : []);
export const boughtOn = (key) => state.bounties.filter((b) => keyOf(b) === key && boughtFiles(b).length);

const parked = new Map(); // repo key -> Promise<{ workspace, stacks, testCommand }>

async function park(repo) {
  if (!existsSync(repo.dir)) throw Object.assign(new Error(`${repo.fullName ?? repo.key} isn't on this machine any more. Connect it again to finish this bounty.`), { status: 409 });
  const workspace = path.join(parkedDir(), repo.key.replace(/[^\w.-]+/g, "__"));
  const stacks = await buildWorkspace(repo.dir, workspace);
  for (const b of boughtOn(repo.key)) await writeFiles(workspace, boughtFiles(b));
  return { workspace, stacks, testCommand: repo.testCommand };
}

// Runs fn with the bounty's repo as the current one (see withRepo in repo.js).
export function inRepo(bounty, fn) {
  if (isActive(bounty)) return fn();
  const key = bounty.repo.key;
  let ready = parked.get(key);
  if (!ready) {
    ready = park(bounty.repo);
    parked.set(key, ready);
    ready.catch(() => parked.delete(key));
  }
  return ready.then((repo) => withRepo(repo, fn));
}

// A parked GitHub repo, brought up to its branch's latest commit. Returns the
// files that changed (its working copy is rebuilt next time it's used).
export async function refreshParked(bounty) {
  if (isActive(bounty) || bounty.repo.type !== "github" || !existsSync(bounty.repo.dir)) return [];
  const { changed } = await pullRepo(bounty.repo.dir, bounty.repo.fullName, bounty.repo.defaultBranch);
  if (changed.length) parked.delete(bounty.repo.key);
  return changed;
}

// The repo just became active: its parked copy is replaced by .workspace.
export const unpark = (key) => parked.delete(key);

// Everything parked, gone (account deletion).
export async function wipeParked() {
  parked.clear();
  await rm(parkedDir(), { recursive: true, force: true });
}

// Repos you've connected, most recent first, for switching back in one click.
export function rememberRepo() {
  const key = repoKey();
  if (key === "demo") return;
  const c = state.connection;
  state.recentRepos = [{ fullName: c.fullName, private: Boolean(c.private), connectedAt: new Date().toISOString() }, ...(state.recentRepos ?? []).filter((r) => r.fullName !== c.fullName)].slice(0, 12);
}

export function recentRepos() {
  const active = repoKey();
  return (state.recentRepos ?? []).map((r) => ({
    ...r,
    active: r.fullName === active,
    bounties: state.bounties.filter((b) => b.repo?.fullName === r.fullName).length,
  }));
}
