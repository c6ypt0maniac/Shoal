// Git hosts besides GitHub: GitLab (gitlab.com or self-hosted) and Bitbucket
// Cloud. Each host knows how to look a repo up, clone it, open a change for
// review (a merge request or pull request), and report its CI and review
// telemetry, so the rest of Shoal doesn't care where the code lives.
//
// Credentials (all optional for public repos, required to open changes):
//   GITLAB_TOKEN   personal access token with api scope; GITLAB_URL for self-hosted
//   BITBUCKET_USERNAME + BITBUCKET_APP_PASSWORD, or BITBUCKET_TOKEN (repository access token)
//
// These adapters follow the hosts' public REST docs but have not been run
// against live accounts yet: try them on a throwaway repo first.
import * as github from "./github.js";

const TIMEOUT_MS = 15_000;
const GITLAB_URL = () => (process.env.GITLAB_URL ?? "https://gitlab.com").replace(/\/$/, "");
const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const round1 = (n) => Math.round(n * 10) / 10;

// "owner/name", a GitHub/GitLab/Bitbucket URL, or "gitlab:group/sub/name" / "bitbucket:ws/slug".
export function parseRemote(input) {
  const text = String(input ?? "").trim().replace(/\.git$/, "").replace(/\/$/, "");
  const prefixed = text.match(/^(gitlab|bitbucket|github):(.+)$/i);
  if (prefixed) return finish(prefixed[1].toLowerCase(), prefixed[2]);
  const gitlabHost = new URL(GITLAB_URL()).host.replace(/\./g, "\\.");
  const url = text.match(new RegExp(`^(?:https?://|git@)(?:[^@/]+@)?(github\\.com|bitbucket\\.org|gitlab\\.com|${gitlabHost})[/:](.+)$`, "i"));
  if (url) {
    const host = /github\.com/i.test(url[1]) ? "github" : /bitbucket\.org/i.test(url[1]) ? "bitbucket" : "gitlab";
    return finish(host, url[2].replace(/\/-\/.*$/, ""));
  }
  return { host: "github", fullName: github.parseRepo(text) };
}

function finish(host, name) {
  if (host === "github") return { host, fullName: github.parseRepo(name) };
  const clean = name.replace(/^\/+/, "");
  if (!/^[\w.-]+(\/[\w.-]+)+$/.test(clean)) throw bad(`Expected "owner/name", got "${name}"`);
  if (host === "bitbucket" && clean.split("/").length !== 2) throw bad(`Bitbucket repos look like "workspace/repo", got "${name}"`);
  return { host, fullName: clean };
}

async function call(base, headers, endpoint, { method = "GET", body, form } = {}) {
  const res = await fetch(base + endpoint, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    method,
    headers: { ...headers, ...(body && { "Content-Type": "application/json" }), ...(form && { "Content-Type": "application/x-www-form-urlencoded" }) },
    body: body ? JSON.stringify(body) : form ? new URLSearchParams(form).toString() : undefined,
  });
  if (res.status === 404) return null;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw Object.assign(new Error(`${method} ${endpoint}: ${data?.message ?? data?.error?.message ?? res.status}`), { status: res.status });
  return data;
}

// --- GitLab ----------------------------------------------------------------------

const glToken = () => process.env.GITLAB_TOKEN;
const glHeaders = () => !glToken() ? {} : process.env.GITLAB_TOKEN_KIND === "oauth" ? { Authorization: `Bearer ${glToken()}` } : { "PRIVATE-TOKEN": glToken() };
const gl = (endpoint, opts) => call(`${GITLAB_URL()}/api/v4`, glHeaders(), endpoint, opts);
const glId = (fullName) => encodeURIComponent(fullName);

const gitlab = {
  label: "GitLab",
  async getRepo(fullName) {
    const p = await gl(`/projects/${glId(fullName)}`);
    if (!p) throw bad(`Repo ${fullName} not found on GitLab (private repos need GITLAB_TOKEN)`, 404);
    const level = Math.max(p.permissions?.project_access?.access_level ?? 0, p.permissions?.group_access?.access_level ?? 0);
    return { fullName: p.path_with_namespace, defaultBranch: p.default_branch, private: p.visibility !== "public", url: p.web_url, canWrite: level >= 30 };
  },
  remote: (fullName) => ({ url: `${GITLAB_URL().replace("://", `://${glToken() ? `oauth2:${glToken()}@` : ""}`)}/${fullName}.git`, secret: glToken() }),
  async openChange(repo, { branch, title, body, files }) {
    const id = glId(repo.fullName);
    const actions = [];
    for (const f of files) {
      const exists = await gl(`/projects/${id}/repository/files/${encodeURIComponent(f.path)}?ref=${encodeURIComponent(repo.defaultBranch)}`);
      actions.push({ action: exists ? "update" : "create", file_path: f.path, content: f.content });
    }
    await gl(`/projects/${id}/repository/commits`, {
      method: "POST",
      body: { branch, start_branch: repo.defaultBranch, commit_message: `Shoal: ${title}`, actions },
    });
    const mr = await gl(`/projects/${id}/merge_requests`, {
      method: "POST",
      body: { source_branch: branch, target_branch: repo.defaultBranch, title, description: body },
    });
    return { number: mr.iid, url: mr.web_url };
  },
  async files(fullName) {
    const repo = await gitlab.getRepo(fullName);
    const files = [];
    for (let page = 1; page <= 30; page++) {
      const tree = (await gl(`/projects/${glId(fullName)}/repository/tree?recursive=true&per_page=100&page=${page}&ref=${encodeURIComponent(repo.defaultBranch)}`)) ?? [];
      files.push(...tree.filter((t) => t.type === "blob").map((t) => t.path));
      if (tree.length < 100) return { files, truncated: false };
    }
    return { files, truncated: true };
  },
  async ciStats(fullName) {
    const runs = (await gl(`/projects/${glId(fullName)}/pipelines?per_page=100`)) ?? [];
    return summarizeCi(
      runs.filter((r) => ["success", "failed"].includes(r.status)).map((r) => ({ name: r.source ?? "pipeline", failed: r.status === "failed", minutes: (new Date(r.updated_at) - new Date(r.created_at)) / 60_000 })),
    );
  },
  async pullStats(fullName) {
    const mrs = (await gl(`/projects/${glId(fullName)}/merge_requests?state=merged&per_page=100`)) ?? [];
    return medianHours(mrs.map((m) => [m.created_at, m.merged_at]));
  },
};

// --- Bitbucket Cloud -------------------------------------------------------------

const bbAuth = () => {
  const { BITBUCKET_TOKEN: token, BITBUCKET_USERNAME: user, BITBUCKET_APP_PASSWORD: pass } = process.env;
  if (token) return { Authorization: `Bearer ${token}` };
  if (user && pass) return { Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}` };
  return {};
};
const bb = (endpoint, opts) => call("https://api.bitbucket.org/2.0", bbAuth(), endpoint, opts);

const bitbucket = {
  label: "Bitbucket",
  async getRepo(fullName) {
    const r = await bb(`/repositories/${fullName}`);
    if (!r) throw bad(`Repo ${fullName} not found on Bitbucket (private repos need BITBUCKET_USERNAME and BITBUCKET_APP_PASSWORD)`, 404);
    const perms = Object.keys(bbAuth()).length
      ? await bb(`/user/permissions/repositories?q=repository.full_name%3D%22${encodeURIComponent(fullName)}%22`).catch(() => null)
      : null;
    return {
      fullName: r.full_name,
      defaultBranch: r.mainbranch?.name ?? "main",
      private: r.is_private,
      url: r.links?.html?.href,
      canWrite: ["write", "admin"].includes(perms?.values?.[0]?.permission),
    };
  },
  remote(fullName) {
    const { BITBUCKET_TOKEN: token, BITBUCKET_USERNAME: user, BITBUCKET_APP_PASSWORD: pass } = process.env;
    const creds = token ? `x-token-auth:${token}@` : user && pass ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@` : "";
    return { url: `https://${creds}bitbucket.org/${fullName}.git`, secret: token ?? pass };
  },
  async openChange(repo, { branch, title, body, files }) {
    const form = { branch, message: `Shoal: ${title}` };
    for (const f of files) form[f.path] = f.content;
    await bb(`/repositories/${repo.fullName}/src`, { method: "POST", form });
    const pr = await bb(`/repositories/${repo.fullName}/pullrequests`, {
      method: "POST",
      body: { title, description: body, source: { branch: { name: branch } }, destination: { branch: { name: repo.defaultBranch } } },
    });
    return { number: pr.id, url: pr.links?.html?.href };
  },
  async files(fullName) {
    const files = [];
    let next = `/repositories/${fullName}/src/HEAD/?max_depth=12&pagelen=100`;
    for (let page = 0; next && page < 30; page++) {
      const data = await bb(next.replace("https://api.bitbucket.org/2.0", ""));
      files.push(...(data?.values ?? []).filter((v) => v.type === "commit_file").map((v) => v.path));
      next = data?.next ?? null;
    }
    return { files, truncated: Boolean(next) };
  },
  async ciStats(fullName) {
    const data = await bb(`/repositories/${fullName}/pipelines/?pagelen=100&sort=-created_on`);
    return summarizeCi(
      (data?.values ?? [])
        .filter((p) => p.state?.name === "COMPLETED" && p.duration_in_seconds != null)
        .map((p) => ({ name: p.target?.selector?.pattern ?? "pipeline", failed: p.state.result?.name !== "SUCCESSFUL", minutes: p.duration_in_seconds / 60 })),
    );
  },
  async pullStats(fullName) {
    const data = await bb(`/repositories/${fullName}/pullrequests?state=MERGED&pagelen=50`);
    // Bitbucket doesn't expose the merge time on the list, so the last update stands in for it.
    return medianHours((data?.values ?? []).map((p) => [p.created_on, p.updated_on]));
  },
};

// --- Shared helpers --------------------------------------------------------------

// Same shape as github.ciStats so the dashboard and ci-duration class work unchanged.
function summarizeCi(runs) {
  const byName = new Map();
  for (const r of runs) {
    const w = byName.get(r.name) ?? { workflow: r.name, runs: 0, failures: 0, reruns: 0, minutes: [] };
    w.runs += 1;
    if (r.failed) w.failures += 1;
    if (r.minutes > 0) w.minutes.push(r.minutes);
    byName.set(r.name, w);
  }
  return [...byName.values()].map(({ minutes, ...w }) => ({
    ...w,
    failureRate: w.failures / w.runs,
    rerunRate: 0,
    avgMinutes: minutes.length ? round1(minutes.reduce((a, b) => a + b, 0) / minutes.length) : null,
  }));
}

function medianHours(pairs) {
  const hours = pairs.filter(([, end]) => end).map(([start, end]) => (new Date(end) - new Date(start)) / 3_600_000).sort((a, b) => a - b);
  const mid = Math.floor(hours.length / 2);
  const median = hours.length ? (hours.length % 2 ? hours[mid] : (hours[mid - 1] + hours[mid]) / 2) : 0;
  return { merged: hours.length, medianHours: round1(median) };
}

const ADAPTERS = { gitlab, bitbucket };
const adapter = (host) => ADAPTERS[host] ?? null;

// --- What the rest of Shoal calls ------------------------------------------------

export const getRepo = (host, fullName) => (adapter(host) ? adapter(host).getRepo(fullName) : github.getRepo(fullName));
export const hostLabel = (host) => adapter(host)?.label ?? "GitHub";

export function cloneRepo(host, fullName, onStep) {
  return adapter(host) ? github.cloneRepo(fullName, onStep, { ...adapter(host).remote(fullName), host }) : github.cloneRepo(fullName, onStep);
}

export const repoFiles = async (host, fullName, opts) => {
  if (!adapter(host)) return github.repoFiles(fullName, opts);
  const { files, truncated } = await adapter(host).files(fullName);
  return { files, truncated };
};
export const ciStats = (host, fullName) => (adapter(host) ? adapter(host).ciStats(fullName) : github.ciStats(fullName));
export const pullStats = (host, fullName) => (adapter(host) ? adapter(host).pullStats(fullName) : github.pullStats(fullName));

// Opens the winning fix for review wherever the repo lives.
export function openChange(repo, opts) {
  return adapter(repo.type) ? adapter(repo.type).openChange(repo, opts) : github.openPullRequest(repo, opts);
}

export const canOpenChanges = (repo) => ["github", "gitlab", "bitbucket"].includes(repo.type);
