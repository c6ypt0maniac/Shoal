// GitHub integration: repo metadata, CI telemetry from GitHub Actions,
// cloning, and opening a pull request with a verified fix.
// Auth: "Sign in with GitHub" (OAuth) sets the token; the GITHUB_TOKEN env var
// is a fallback. Public repos can be read without either (60 requests/hour);
// opening PRs needs a token with write access.
import path from "node:path";
import { randomUUID } from "node:crypto";
import { rm, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { REPOS_DIR, sh } from "./repo.js";
import { MANIFESTS, detectStacks, installCommand } from "./stack.js";

const API = "https://api.github.com";

// Shoal runs locally for one person, so the signed-in token lives in memory.
let oauthToken = process.env.GITHUB_OAUTH_TOKEN ?? null;
const token = () => oauthToken ?? process.env.GITHUB_TOKEN;
export const hasToken = () => Boolean(token());
const envFile = process.env.SHOAL_ENV_FILE || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env");

async function persistOAuthToken(value) {
  const original = await readFile(envFile, "utf8").catch((error) => error.code === "ENOENT" ? "# Shoal local configuration\n" : Promise.reject(error));
  const lines = original.split(/\r?\n/).filter((line) => !line.startsWith("GITHUB_OAUTH_TOKEN="));
  if (value) lines.push(`GITHUB_OAUTH_TOKEN=${JSON.stringify(value)}`);
  const next = lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n*$/, "\n");
  const temp = `${envFile}.${process.pid}.tmp`;
  await writeFile(temp, next, { mode: 0o600 });
  await rename(temp, envFile);
  value ? (process.env.GITHUB_OAUTH_TOKEN = value) : delete process.env.GITHUB_OAUTH_TOKEN;
}

// --- Sign in with GitHub (OAuth web flow) ---------------------------------
// Setup: github.com/settings/developers -> New OAuth App, callback URL
// http://localhost:4000/api/auth/github/callback, then start the server with
// GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET set.
const OAUTH_SCOPES = "repo read:user";
const pendingStates = new Map(); // state -> page to return to after sign-in

export const oauthConfigured = () => Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);

export function authorizeUrl(callbackUrl, returnTo = "/") {
  const state = randomUUID();
  pendingStates.set(state, returnTo);
  const params = new URLSearchParams({
    client_id: process.env.GITHUB_CLIENT_ID,
    redirect_uri: callbackUrl,
    scope: OAUTH_SCOPES,
    state,
    allow_signup: "true",
  });
  return `https://github.com/login/oauth/authorize?${params}`;
}

// Exchanges the one-time code from GitHub's redirect for an access token.
// Resolves with the page the user started sign-in from.
export async function completeOAuth({ code, state, callbackUrl }) {
  const returnTo = pendingStates.get(state);
  if (!pendingStates.delete(state)) throw Object.assign(new Error("Sign-in expired or was tampered with; try again"), { status: 400 });
  const res = await fetch("https://github.com/login/oauth/access_token", {
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: callbackUrl,
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw Object.assign(new Error(data.error_description ?? "GitHub sign-in failed"), { status: 401 });
  oauthToken = data.access_token;
  await persistOAuthToken(oauthToken);
  cache.clear();
  // Warm the caches now so the pages after sign-in don't wait on GitHub.
  listRepos().catch(() => {});
  return returnTo;
}

export async function signOut() {
  oauthToken = null;
  await persistOAuthToken(null);
  cache.clear();
}

// --- Cache ------------------------------------------------------------------
// GitHub's API can take seconds per call, and every page asks "who's signed
// in?", so answers are kept in memory. Within maxAge a cached value is
// returned as-is; after that it's still returned instantly while a fresh copy
// loads in the background (stale-while-revalidate). Cleared on sign-in/out.
const cache = new Map(); // key -> { value, at, refreshing }

async function cached(key, maxAgeMs, load) {
  const hit = cache.get(key);
  if (hit && "value" in hit) {
    if (Date.now() - hit.at > maxAgeMs && !hit.refreshing) {
      hit.refreshing = load()
        .then((value) => cache.set(key, { value, at: Date.now() }))
        .catch(() => (hit.refreshing = null));
    }
    return hit.value;
  }
  if (hit?.pending) return hit.pending; // share one in-flight request
  const pending = load();
  cache.set(key, { pending });
  try {
    const value = await pending;
    cache.set(key, { value, at: Date.now() });
    return value;
  } catch (err) {
    cache.delete(key);
    throw err;
  }
}

const GITHUB_TIMEOUT_MS = 15_000;

async function gh(endpoint, { method = "GET", body } = {}) {
  const res = await fetch(API + endpoint, {
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    method,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "shoal-hackathon",
      ...(token() && { Authorization: `Bearer ${token()}` }),
      ...(body && { "Content-Type": "application/json" }),
    },
    body: body && JSON.stringify(body),
  });
  if (res.status === 404) return null;
  const data = res.status === 204 ? null : await res.json();
  if (!res.ok) throw Object.assign(new Error(`GitHub ${method} ${endpoint}: ${data?.message ?? res.status}`), { status: res.status });
  return data;
}

export function parseRepo(input) {
  const match = String(input ?? "").trim().replace(/\.git$/, "").match(/(?:github\.com[/:])?([\w.-]+)\/([\w.-]+)\/?$/);
  if (!match) throw Object.assign(new Error(`Expected "owner/repo" or a GitHub URL, got "${input}"`), { status: 400 });
  return `${match[1]}/${match[2]}`;
}

// Who the token belongs to, or null without a token. A profile doesn't
// change mid-session, so it's fetched once per sign-in.
export async function getViewer() {
  if (!hasToken()) return null;
  return cached("viewer", Infinity, async () => {
    const me = await gh("/user");
    return me && { login: me.login, name: me.name, avatarUrl: me.avatar_url, via: oauthToken ? "oauth" : "env" };
  });
}

// Repos the signed-in user owns, most recently pushed first.
export async function listRepos() {
  if (!hasToken()) return [];
  return cached("repos", 60_000, async () => {
    const repos = await gh("/user/repos?per_page=100&sort=pushed&affiliation=owner");
    return (repos ?? []).map((r) => ({
      fullName: r.full_name,
      private: r.private,
      language: r.language,
      pushedAt: r.pushed_at,
      canWrite: Boolean(r.permissions?.push),
    }));
  });
}

export async function getRepo(fullName) {
  return cached(`repo:${fullName}`, 60_000, async () => {
    const repo = await gh(`/repos/${fullName}`);
    if (!repo) throw Object.assign(new Error(`Repo ${fullName} not found (private repos need GITHUB_TOKEN)`), { status: 404 });
    return {
      fullName: repo.full_name,
      defaultBranch: repo.default_branch,
      private: repo.private,
      url: repo.html_url,
      canWrite: Boolean(repo.permissions?.push),
    };
  });
}

// Every file path in the repo's default branch, for the "what can agents
// see" folder picker. Large repos may come back truncated by GitHub.
// The latest commit on a branch. A cheap call, so new pushes are noticed
// within seconds; everything keyed on it refreshes by itself.
export async function headSha(fullName, branch, { fresh = false } = {}) {
  if (fresh) cache.delete(`head:${fullName}:${branch}`);
  return cached(`head:${fullName}:${branch}`, 10_000, async () => {
    const commit = await gh(`/repos/${fullName}/commits/${encodeURIComponent(branch)}`);
    if (!commit) {
      const hint = hasToken()
        ? "The repository or branch was not found, or the signed-in GitHub account cannot access it."
        : "Sign in with GitHub to sync this private repository.";
      throw Object.assign(new Error(`Cannot sync ${fullName}:${branch}. ${hint}`), { status: 404 });
    }
    return { sha: commit.sha, message: commit.commit?.message?.split("\n")[0] ?? "", at: commit.commit?.committer?.date ?? null };
  });
}

// Every file on the default branch. Keyed by the branch's latest commit, so a
// push shows up right away instead of after a cache timeout.
export async function repoFiles(fullName, { fresh = false } = {}) {
  const repo = await getRepo(fullName);
  const head = await headSha(repo.fullName, repo.defaultBranch, { fresh });
  return cached(`files:${repo.fullName}:${head.sha}`, Infinity, async () => {
    const tree = await gh(`/repos/${repo.fullName}/git/trees/${head.sha}?recursive=1`);
    return {
      files: (tree?.tree ?? []).filter((e) => e.type === "blob").map((e) => e.path),
      truncated: Boolean(tree?.truncated),
      head,
    };
  });
}

// Brings an existing clone up to the branch's latest commit. Returns the old
// and new commit and which files changed between them.
export async function pullRepo(dir, fullName, branch) {
  const before = (await sh("git rev-parse HEAD", dir)).output.trim();
  const auth = token() ? `x-access-token:${token()}@` : "";
  const fetch = await sh(`git fetch --depth 50 "https://${auth}github.com/${fullName}.git" ${JSON.stringify(branch)}`, dir, 300_000);
  if (!fetch.ok) throw new Error(`git fetch failed: ${redact(fetch.output).slice(-400)}`);
  const after = (await sh("git rev-parse FETCH_HEAD", dir)).output.trim();
  if (after === before) return { before, after, changed: [] };
  // Which files changed; if history is too shallow to compare, treat every file as changed.
  const diff = await sh(`git diff --name-only ${before} ${after}`, dir);
  const reset = await sh(`git reset --hard ${after}`, dir);
  if (!reset.ok) throw new Error(`git reset failed: ${reset.output.slice(-300)}`);
  const changed = diff.ok ? diff.output.split(/\r?\n/).filter(Boolean) : (await sh("git ls-files", dir)).output.split(/\r?\n/).filter(Boolean);
  return { before, after, changed };
}

// Re-runs dependency installs for projects whose manifest changed.
export async function reinstall(dir, changed, onStep = () => {}) {
  for (const stack of await detectStacks(dir)) {
    const mine = changed.filter((f) => (stack.root === "." || f.startsWith(stack.root + "/")) && MANIFESTS.some((re) => re.test(f)));
    if (!mine.length || !stack.toolOk) continue;
    const cwd = path.join(dir, stack.root);
    const cmd = installCommand(stack, await readdir(cwd));
    if (!cmd) continue;
    onStep(`${mine.join(", ")} changed: reinstalling ${stack.def.language} dependencies`);
    const install = await sh(cmd, cwd, 600_000);
    if (!install.ok) onStep(`Dependency install failed; some tests may fail for that reason: ${install.output.slice(-300)}`);
  }
}

// Shallow-clones the repo and installs each project's dependencies the way
// its language does (npm, pip into a private venv, go mod, cargo, bundler,
// composer, dotnet...). Returns the clone folder and a note per project.
export async function cloneRepo(fullName, onStep = () => {}, remote = null) {
  const dir = path.join(REPOS_DIR, `${remote?.host ? remote.host + "__" : ""}${fullName.replaceAll("/", "__")}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(REPOS_DIR, { recursive: true });
  const auth = token() ? `x-access-token:${token()}@` : "";
  const url = remote?.url ?? `https://${auth}github.com/${fullName}.git`;
  const clone = await sh(`git clone --depth 1 "${url}" "${dir}"`, REPOS_DIR);
  if (!clone.ok) throw new Error(`git clone failed: ${(remote?.secret ? clone.output.replaceAll(remote.secret, "***") : redact(clone.output)).slice(-400)}`);

  for (const stack of await detectStacks(dir)) {
    const where = stack.root === "." ? "" : ` in ${stack.root}/`;
    if (!stack.toolOk) {
      onStep(`Can't install ${stack.def.language} dependencies${where}: ${stack.toolMessage}`);
      continue;
    }
    const cwd = path.join(dir, stack.root);
    const cmd = installCommand(stack, await readdir(cwd));
    if (!cmd) continue;
    onStep(`Installing ${stack.def.language} dependencies${where}: ${cmd}`);
    const install = await sh(cmd, cwd, 600_000);
    if (!install.ok) onStep(`Dependency install${where} failed; some tests may fail for that reason: ${install.output.slice(-300)}`);
  }
  return dir;
}

// Real CI telemetry: recent GitHub Actions runs grouped by workflow.
export async function ciStats(fullName, perPage = 100) {
  const data = await gh(`/repos/${fullName}/actions/runs?per_page=${perPage}&status=completed`);
  const byWorkflow = new Map();
  for (const run of data?.workflow_runs ?? []) {
    const w = byWorkflow.get(run.name) ?? { workflow: run.name, runs: 0, failures: 0, reruns: 0, minutes: [] };
    w.runs += 1;
    if (run.conclusion === "failure") w.failures += 1;
    if (run.run_attempt > 1) w.reruns += 1;
    const started = new Date(run.run_started_at ?? run.created_at);
    const minutes = (new Date(run.updated_at) - started) / 60_000;
    if (minutes > 0) w.minutes.push(minutes);
    byWorkflow.set(run.name, w);
  }
  return [...byWorkflow.values()]
    .map(({ minutes, ...w }) => ({
      ...w,
      failureRate: w.failures / w.runs,
      rerunRate: w.reruns / w.runs,
      avgMinutes: minutes.length ? Math.round((minutes.reduce((a, b) => a + b, 0) / minutes.length) * 10) / 10 : null,
    }))
    .sort((a, b) => b.failureRate - a.failureRate || (b.avgMinutes ?? 0) - (a.avgMinutes ?? 0));
}

// How long merged PRs took from opened to merged (median hours).
export async function pullStats(fullName, perPage = 100) {
  const prs = (await gh(`/repos/${fullName}/pulls?state=closed&per_page=${perPage}`)) ?? [];
  const hours = prs
    .filter((pr) => pr.merged_at)
    .map((pr) => (new Date(pr.merged_at) - new Date(pr.created_at)) / 3_600_000)
    .sort((a, b) => a - b);
  const mid = Math.floor(hours.length / 2);
  const median = hours.length ? (hours.length % 2 ? hours[mid] : (hours[mid - 1] + hours[mid]) / 2) : 0;
  return { merged: hours.length, medianHours: Math.round(median * 10) / 10 };
}

// Opens a PR containing the given full-file contents on a new branch.
export async function openPullRequest(repo, { branch, title, body, files }) {
  const base = await gh(`/repos/${repo.fullName}/git/ref/heads/${repo.defaultBranch}`);
  await gh(`/repos/${repo.fullName}/git/refs`, { method: "POST", body: { ref: `refs/heads/${branch}`, sha: base.object.sha } });

  for (const file of files) {
    const filePath = file.path.split("/").map(encodeURIComponent).join("/");
    const existing = await gh(`/repos/${repo.fullName}/contents/${filePath}?ref=${branch}`);
    await gh(`/repos/${repo.fullName}/contents/${filePath}`, {
      method: "PUT",
      body: {
        message: `Shoal: update ${file.path}`,
        content: Buffer.from(file.content, "utf8").toString("base64"),
        branch,
        ...(existing?.sha && { sha: existing.sha }),
      },
    });
  }

  const pr = await gh(`/repos/${repo.fullName}/pulls`, {
    method: "POST",
    body: { title, head: branch, base: repo.defaultBranch, body },
  });
  return { number: pr.number, url: pr.html_url };
}

const redact = (text) => (token() ? text.replaceAll(token(), "***") : text);
