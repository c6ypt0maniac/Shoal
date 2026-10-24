// GitHub integration: repo metadata, CI telemetry from GitHub Actions,
// cloning, and opening a pull request with a verified fix.
// Auth: "Sign in with GitHub" (OAuth) sets the token; the GITHUB_TOKEN env var
// is a fallback. Public repos can be read without either (60 requests/hour);
// opening PRs needs a token with write access.
import path from "node:path";
import { randomUUID } from "node:crypto";
import { rm, mkdir, readdir } from "node:fs/promises";
import { REPOS_DIR, sh } from "./repo.js";
import { detectStacks, installCommand } from "./stack.js";

const API = "https://api.github.com";

// Shoal runs locally for one person, so the signed-in token lives in memory.
let oauthToken = null;
const token = () => oauthToken ?? process.env.GITHUB_TOKEN;
export const hasToken = () => Boolean(token());

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
  cache.clear();
  // Warm the caches now so the pages after sign-in don't wait on GitHub.
  listRepos().catch(() => {});
  return returnTo;
}

export function signOut() {
  oauthToken = null;
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
export async function repoFiles(fullName) {
  return cached(`files:${fullName}`, 5 * 60_000, async () => {
    const repo = await getRepo(fullName);
    const tree = await gh(`/repos/${repo.fullName}/git/trees/${encodeURIComponent(repo.defaultBranch)}?recursive=1`);
    return {
      files: (tree?.tree ?? []).filter((e) => e.type === "blob").map((e) => e.path),
      truncated: Boolean(tree?.truncated),
    };
  });
}

// Shallow-clones the repo and installs each project's dependencies the way
// its language does (npm, pip into a private venv, go mod, cargo, bundler,
// composer, dotnet...). Returns the clone folder and a note per project.
export async function cloneRepo(fullName, onStep = () => {}) {
  const dir = path.join(REPOS_DIR, fullName.replace("/", "__"));
  await rm(dir, { recursive: true, force: true });
  await mkdir(REPOS_DIR, { recursive: true });
  const auth = token() ? `x-access-token:${token()}@` : "";
  const clone = await sh(`git clone --depth 1 "https://${auth}github.com/${fullName}.git" "${dir}"`, REPOS_DIR);
  if (!clone.ok) throw new Error(`git clone failed: ${redact(clone.output).slice(-400)}`);

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
