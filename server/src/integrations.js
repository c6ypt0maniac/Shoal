// Where Shoal meets the tools a team already lives in.
//
// Outbound (Shoal tells them): Slack posts bounty milestones; Jira and Linear
// get a ticket per bounty that is commented on and closed with the outcome.
// Inbound (they tell Shoal): assigning a Jira issue to the Shoal agent, mentioning
// @shoal on a GitHub issue or Bitbucket/GitLab comment, opens a bounty for the
// matching problem. Shoal also serves an agent card at
// /.well-known/agent-card.json describing what it is and where to call it.
//
// Setup (every piece is optional and silent when unset):
//   SLACK_WEBHOOK_URL                                  Slack incoming webhook
//   JIRA_BASE_URL JIRA_EMAIL JIRA_API_TOKEN JIRA_PROJECT   Jira Cloud tickets
//   JIRA_AGENT_ACCOUNT_ID                              assignee that means "Shoal, take this"
//   LINEAR_API_KEY LINEAR_TEAM_ID                      Linear tickets
//   SHOAL_WEBHOOK_SECRET                               required for any inbound webhook
//   SHOAL_PUBLIC_URL                                   address of this server, for the agent card
//
// Registering in Jira's assignee list, Bitbucket's agent hooks or GitHub Agent
// HQ is done in those products' own admin pages; those registration APIs aren't
// public to rely on yet, so this file implements the receiving side.
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, rename, writeFile } from "node:fs/promises";
import { emit, onEvent } from "./events.js";
import { state } from "./store.js";
import { createBounty } from "./bounties.js";
import { CLASSES, createClassBounty } from "./pain-classes.js";

const env = (k) => process.env[k];
const TIMEOUT_MS = 10_000;
const here = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = () => process.env.SHOAL_ENV_FILE || path.resolve(here, "../.env");
const NOTIFY = /^(bounty\.(created|settled|failed)|verify\.(passed|rejected)|pr\.opened|escrow\.(charged|released)|class\.remeasured)$/;

export const integrationStatus = () => ({
  slack: Boolean(env("SLACK_WEBHOOK_URL")),
  jira: Boolean((env("JIRA_ACCESS_TOKEN") && env("JIRA_CLOUD_ID") && env("JIRA_PROJECT")) || (env("JIRA_BASE_URL") && env("JIRA_EMAIL") && env("JIRA_API_TOKEN") && env("JIRA_PROJECT"))),
  linear: Boolean(env("LINEAR_API_KEY") && env("LINEAR_TEAM_ID")),
  gitlab: Boolean(env("GITLAB_TOKEN")),
  bitbucket: Boolean(env("BITBUCKET_TOKEN") || (env("BITBUCKET_USERNAME") && env("BITBUCKET_APP_PASSWORD"))),
  inboundWebhooks: Boolean(env("SHOAL_WEBHOOK_SECRET")),
  jiraDetails: {
    name: env("JIRA_SITE_NAME") ?? env("JIRA_BASE_URL") ?? "",
    project: env("JIRA_PROJECT") ?? "",
    available: Boolean(env("JIRA_CLIENT_ID") && env("JIRA_CLIENT_SECRET")),
  },
  gitlabDetails: {
    account: env("GITLAB_ACCOUNT") ?? "",
    available: Boolean(env("GITLAB_CLIENT_ID") && env("GITLAB_CLIENT_SECRET")),
  },
});

const oauthStates = new Map();
const oauthError = (message, status = 400) => Object.assign(new Error(message), { status });
const callbackUrl = (provider, baseUrl) => `${env("SHOAL_PUBLIC_URL") || baseUrl}/api/auth/${provider}/callback`;
const rememberState = (provider) => {
  const state = crypto.randomBytes(24).toString("hex");
  oauthStates.set(state, { provider, expires: Date.now() + 10 * 60_000 });
  return state;
};
const consumeState = (provider, state) => {
  const saved = oauthStates.get(String(state ?? ""));
  oauthStates.delete(String(state ?? ""));
  if (!saved || saved.provider !== provider || saved.expires < Date.now()) throw oauthError("This sign-in expired. Please connect again.");
};

export function beginIntegrationAuth(provider, baseUrl) {
  const redirectUri = callbackUrl(provider, baseUrl);
  const state = rememberState(provider);
  if (provider === "jira") {
    if (!env("JIRA_CLIENT_ID") || !env("JIRA_CLIENT_SECRET")) throw oauthError("Jira sign-in is not available on this Shoal installation yet.", 503);
    const query = new URLSearchParams({ audience: "api.atlassian.com", client_id: env("JIRA_CLIENT_ID"), scope: "offline_access read:jira-work write:jira-work read:jira-user", redirect_uri: redirectUri, state, response_type: "code", prompt: "consent" });
    return `https://auth.atlassian.com/authorize?${query}`;
  }
  if (provider === "gitlab") {
    if (!env("GITLAB_CLIENT_ID") || !env("GITLAB_CLIENT_SECRET")) throw oauthError("GitLab sign-in is not available on this Shoal installation yet.", 503);
    const query = new URLSearchParams({ client_id: env("GITLAB_CLIENT_ID"), redirect_uri: redirectUri, response_type: "code", state, scope: "api" });
    return `${cleanUrl(env("GITLAB_URL"), "https://gitlab.com")}/oauth/authorize?${query}`;
  }
  throw oauthError("Unknown integration", 404);
}

async function exchange(url, values, label) {
  const res = await fetch(url, { method: "POST", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: new URLSearchParams(values) });
  return responseJson(res, label);
}

export async function finishIntegrationAuth(provider, query, baseUrl) {
  if (query.error) throw oauthError(String(query.error_description || query.error));
  consumeState(provider, query.state);
  const redirectUri = callbackUrl(provider, baseUrl);
  if (provider === "jira") {
    const token = await exchange("https://auth.atlassian.com/oauth/token", { grant_type: "authorization_code", client_id: env("JIRA_CLIENT_ID"), client_secret: env("JIRA_CLIENT_SECRET"), code: required(query.code, "Authorization code"), redirect_uri: redirectUri }, "Jira sign-in failed");
    const headers = { Authorization: `Bearer ${token.access_token}`, Accept: "application/json" };
    const resources = await responseJson(await fetch("https://api.atlassian.com/oauth/token/accessible-resources", { headers, signal: AbortSignal.timeout(TIMEOUT_MS) }), "Jira site lookup failed");
    const site = resources?.[0];
    if (!site) throw oauthError("No Jira site is available for this account.");
    const api = `https://api.atlassian.com/ex/jira/${site.id}/rest/api/3`;
    const projects = await responseJson(await fetch(`${api}/project/search?maxResults=50`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) }), "Jira project lookup failed");
    const project = projects?.values?.[0];
    if (!project) throw oauthError("No Jira project is available for this account.");
    await persistEnv({ JIRA_ACCESS_TOKEN: token.access_token, JIRA_REFRESH_TOKEN: token.refresh_token, JIRA_TOKEN_EXPIRES_AT: Date.now() + Number(token.expires_in || 3600) * 1000, JIRA_CLOUD_ID: site.id, JIRA_SITE_NAME: site.name || site.url, JIRA_BASE_URL: site.url, JIRA_PROJECT: project.key, JIRA_EMAIL: null, JIRA_API_TOKEN: null });
    return { provider, account: site.name || site.url, project: project.key };
  }
  if (provider === "gitlab") {
    const root = cleanUrl(env("GITLAB_URL"), "https://gitlab.com");
    const token = await exchange(`${root}/oauth/token`, { client_id: env("GITLAB_CLIENT_ID"), client_secret: env("GITLAB_CLIENT_SECRET"), code: required(query.code, "Authorization code"), grant_type: "authorization_code", redirect_uri: redirectUri }, "GitLab sign-in failed");
    const user = await responseJson(await fetch(`${root}/api/v4/user`, { headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) }), "GitLab account lookup failed");
    await persistEnv({ GITLAB_TOKEN: token.access_token, GITLAB_REFRESH_TOKEN: token.refresh_token, GITLAB_TOKEN_EXPIRES_AT: Date.now() + Number(token.expires_in || 7200) * 1000, GITLAB_TOKEN_KIND: "oauth", GITLAB_ACCOUNT: user.username || user.name || "connected" });
    return { provider, account: user.username || user.name || "connected" };
  }
  throw oauthError("Unknown integration", 404);
}

const cleanUrl = (value, fallback = "") => String(value ?? fallback).trim().replace(/\/$/, "");
const required = (value, label) => {
  const out = String(value ?? "").trim();
  if (!out) throw Object.assign(new Error(`${label} is required`), { status: 400 });
  return out;
};

async function responseJson(res, label) {
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) throw Object.assign(new Error(`${label}: ${res.status} ${data?.errorMessages?.[0] ?? data?.message ?? text.slice(0, 180)}`), { status: 400 });
  return data;
}

async function checkJira(config) {
  const auth = Buffer.from(`${config.email}:${config.token}`).toString("base64");
  const headers = { Authorization: `Basic ${auth}`, Accept: "application/json" };
  const myself = await fetch(`${config.baseUrl}/rest/api/3/myself`, { signal: AbortSignal.timeout(TIMEOUT_MS), headers });
  const user = await responseJson(myself, "Jira sign-in failed");
  const projectRes = await fetch(`${config.baseUrl}/rest/api/3/project/${encodeURIComponent(config.project)}`, { signal: AbortSignal.timeout(TIMEOUT_MS), headers });
  const project = await responseJson(projectRes, "Jira project check failed");
  return { provider: "jira", account: user.displayName ?? user.emailAddress ?? config.email, project: project.key ?? config.project };
}

async function checkGitLab(config) {
  const res = await fetch(`${config.url}/api/v4/user`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "PRIVATE-TOKEN": config.token, Accept: "application/json" },
  });
  const user = await responseJson(res, "GitLab sign-in failed");
  return { provider: "gitlab", account: user.username ?? user.name ?? "connected", url: config.url };
}

const jiraConfig = (input = {}) => ({
  baseUrl: cleanUrl(input.baseUrl ?? env("JIRA_BASE_URL")),
  email: String(input.email ?? env("JIRA_EMAIL") ?? "").trim(),
  token: String(input.token || env("JIRA_API_TOKEN") || "").trim(),
  project: String(input.project ?? env("JIRA_PROJECT") ?? "").trim().toUpperCase(),
});
const gitlabConfig = (input = {}) => ({
  url: cleanUrl(input.url ?? env("GITLAB_URL"), "https://gitlab.com"),
  token: String(input.token || env("GITLAB_TOKEN") || "").trim(),
});

export async function testIntegration(provider, input = {}) {
  if (provider === "jira") {
    const config = jiraConfig(input);
    required(config.baseUrl, "Jira site URL"); required(config.email, "Jira email"); required(config.token, "Jira API token"); required(config.project, "Jira project key");
    return checkJira(config);
  }
  if (provider === "gitlab") {
    const config = gitlabConfig(input);
    required(config.url, "GitLab URL"); required(config.token, "GitLab token");
    return checkGitLab(config);
  }
  throw Object.assign(new Error("Only Jira and GitLab can be configured here"), { status: 404 });
}

async function persistEnv(updates) {
  const file = ENV_FILE();
  const original = await readFile(file, "utf8").catch((error) => error.code === "ENOENT" ? "# Shoal local configuration\n" : Promise.reject(error));
  // Replace existing settings without duplicating them.
  const kept = original.split(/\r?\n/).filter((line) => !Object.keys(updates).some((key) => line.startsWith(`${key}=`)));
  for (const [key, value] of Object.entries(updates)) if (value != null && value !== "") kept.push(`${key}=${JSON.stringify(String(value))}`);
  const next = kept.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n*$/, "\n");
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, next, { mode: 0o600 });
  await rename(temp, file);
  for (const [key, value] of Object.entries(updates)) value == null || value === "" ? delete process.env[key] : (process.env[key] = String(value));
}

export async function configureIntegration(provider, input = {}) {
  const checked = await testIntegration(provider, input);
  if (provider === "jira") {
    const config = jiraConfig(input);
    await persistEnv({ JIRA_BASE_URL: config.baseUrl, JIRA_EMAIL: config.email, JIRA_API_TOKEN: config.token, JIRA_PROJECT: config.project });
  } else {
    const config = gitlabConfig(input);
    await persistEnv({ GITLAB_URL: config.url, GITLAB_TOKEN: config.token });
  }
  return { ...checked, connected: true, status: integrationStatus() };
}

export async function disconnectIntegration(provider) {
  if (provider === "jira") await persistEnv({ JIRA_ACCESS_TOKEN: null, JIRA_REFRESH_TOKEN: null, JIRA_TOKEN_EXPIRES_AT: null, JIRA_CLOUD_ID: null, JIRA_SITE_NAME: null, JIRA_BASE_URL: null, JIRA_EMAIL: null, JIRA_API_TOKEN: null, JIRA_PROJECT: null });
  else if (provider === "gitlab") await persistEnv({ GITLAB_TOKEN: null, GITLAB_REFRESH_TOKEN: null, GITLAB_TOKEN_EXPIRES_AT: null, GITLAB_TOKEN_KIND: null, GITLAB_ACCOUNT: null });
  else throw Object.assign(new Error("Only Jira and GitLab can be configured here"), { status: 404 });
  return integrationStatus();
}

// --- Outbound ----------------------------------------------------------------------

async function slack(text) {
  if (!env("SLACK_WEBHOOK_URL")) return;
  await fetch(env("SLACK_WEBHOOK_URL"), {
    method: "POST",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

const jiraHeaders = () => ({
  Authorization: env("JIRA_ACCESS_TOKEN") ? `Bearer ${env("JIRA_ACCESS_TOKEN")}` : `Basic ${Buffer.from(`${env("JIRA_EMAIL")}:${env("JIRA_API_TOKEN")}`).toString("base64")}`,
  "Content-Type": "application/json",
  Accept: "application/json",
});
const adf = (text) => ({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

async function jira(path, body, method = "POST") {
  const base = env("JIRA_ACCESS_TOKEN") ? `https://api.atlassian.com/ex/jira/${env("JIRA_CLOUD_ID")}` : env("JIRA_BASE_URL").replace(/\/$/, "");
  const res = await fetch(`${base}/rest/api/3${path}`, {
    method,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: jiraHeaders(),
    body: body && JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Jira ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? null : res.json();
}

async function linear(query, variables) {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { Authorization: env("LINEAR_API_KEY"), "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (!res.ok || data.errors) throw new Error(`Linear: ${data.errors?.[0]?.message ?? res.status}`);
  return data.data;
}

// One ticket per bounty: opened with it, commented on as it progresses.
const tickets = new Map(); // bountyId -> { jira?: key, linear?: id }

async function track(event) {
  const bounty = state.bounties.find((b) => b.id === event.bountyId);
  if (!bounty) return;
  const done = event.type === "bounty.settled";
  const failed = event.type === "bounty.failed";
  const line = event.message ?? event.type;

  if (integrationStatus().jira) {
    let ticket = tickets.get(bounty.id) ?? {};
    if (!ticket.jira && event.type === "bounty.created") {
      const issue = await jira("/issue", {
        fields: { project: { key: env("JIRA_PROJECT") }, summary: `[Shoal] ${bounty.title}`, issuetype: { name: "Task" }, description: adf(`${line}\nBounty ${bounty.id}, reward $${bounty.reward}.`) },
      });
      ticket = { ...ticket, jira: issue.key };
      tickets.set(bounty.id, ticket);
      bounty.tickets = { ...bounty.tickets, jira: issue.key };
    } else if (ticket.jira) {
      await jira(`/issue/${ticket.jira}/comment`, { body: adf(line) });
      if (done || failed) {
        const next = await jira(`/issue/${ticket.jira}/transitions`, null, "GET").catch(() => null);
        const to = next?.transitions?.find((t) => (done ? /done|resolved|closed/i : /won't|cancel|closed|done/i).test(t.name));
        if (to) await jira(`/issue/${ticket.jira}/transitions`, { transition: { id: to.id } });
      }
    }
  }

  if (integrationStatus().linear) {
    let ticket = tickets.get(bounty.id) ?? {};
    if (!ticket.linear && event.type === "bounty.created") {
      const data = await linear(
        "mutation($t:String!,$d:String,$team:String!){issueCreate(input:{teamId:$team,title:$t,description:$d}){issue{id identifier}}}",
        { t: `[Shoal] ${bounty.title}`, d: `${line}\n\nBounty ${bounty.id}, reward $${bounty.reward}.`, team: env("LINEAR_TEAM_ID") },
      );
      ticket = { ...ticket, linear: data.issueCreate.issue.id };
      tickets.set(bounty.id, ticket);
      bounty.tickets = { ...bounty.tickets, linear: data.issueCreate.issue.identifier };
    } else if (ticket.linear) {
      await linear("mutation($i:String!,$b:String!){commentCreate(input:{issueId:$i,body:$b}){success}}", { i: ticket.linear, b: line });
    }
  }
}

export function startIntegrations() {
  onEvent(async (event) => {
    if (!NOTIFY.test(event.type)) return;
    const results = await Promise.allSettled([slack(`*Shoal*: ${event.message ?? event.type}`), track(event)]);
    for (const r of results) if (r.status === "rejected") console.warn(`[integration] ${r.reason.message}`);
  });
}

// --- Inbound -----------------------------------------------------------------------

// GitHub signs the raw body; Jira, Bitbucket and GitLab let you put a secret in
// the webhook URL (?secret=...) or, for GitLab, the X-Gitlab-Token header.
export function authorize(req) {
  const secret = env("SHOAL_WEBHOOK_SECRET");
  if (!secret) return { ok: false, status: 503, error: "Set SHOAL_WEBHOOK_SECRET to accept webhooks" };
  const equal = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const signature = req.get("x-hub-signature-256");
  if (signature && req.rawBody) {
    const expected = "sha256=" + crypto.createHmac("sha256", secret).update(req.rawBody).digest("hex");
    return equal(signature, expected) ? { ok: true } : { ok: false, status: 401, error: "Bad signature" };
  }
  const given = req.query.secret ?? req.get("x-gitlab-token") ?? "";
  return given && equal(String(given), secret) ? { ok: true } : { ok: false, status: 401, error: "Bad secret" };
}

// Turns a request ("fix X") into a bounty for the matching problem: a flaky
// test file named in the text, or a pain class named by a `shoal:<class>`
// label or mention. Anything it can't match is reported back, never guessed.
export function openFromRequest({ source, text, ref }) {
  const haystack = String(text ?? "");
  const lower = haystack.toLowerCase();
  const flaky = state.pains.find((p) => !p.healthy && lower.includes(p.testFile.toLowerCase()));
  if (flaky) {
    const bounty = createBounty({ painId: flaky.id, reward: flaky.suggestedReward });
    emit("hook.bounty", { bountyId: bounty.id, message: `${source} request ${ref ?? ""} opened a bounty for ${flaky.testFile}` });
    return { bounty };
  }
  const classId = Object.keys(CLASSES).find((id) => lower.includes(`shoal:${id}`) || lower.includes(id));
  const pain = classId && state.classPains.find((p) => p.classId === classId && !p.error && !p.healthy);
  if (pain) {
    const bounty = createClassBounty({ classPainId: pain.id });
    emit("hook.bounty", { bountyId: bounty.id, message: `${source} request ${ref ?? ""} opened a bounty for ${pain.title}` });
    return { bounty };
  }
  const known = [...state.pains.filter((p) => !p.healthy).map((p) => p.testFile), ...state.classPains.filter((p) => !p.error && !p.healthy).map((p) => `shoal:${p.classId}`)];
  return { bounty: null, reason: "Couldn't match this to a problem Shoal found", known };
}

// Normalizes each product's payload to { text, ref } or null when the event isn't a call for Shoal.
const MENTION = /@shoal\b/i;
export const parsers = {
  jira(body) {
    const assignee = body.issue?.fields?.assignee?.accountId ?? body.changelog?.items?.find((i) => i.field === "assignee")?.to;
    if (!env("JIRA_AGENT_ACCOUNT_ID") || assignee !== env("JIRA_AGENT_ACCOUNT_ID")) return null;
    const f = body.issue.fields;
    const labels = (f.labels ?? []).map((l) => l.replace(/^shoal[-:]/i, "shoal:")).join(" ");
    return { ref: body.issue.key, text: `${f.summary}\n${typeof f.description === "string" ? f.description : JSON.stringify(f.description ?? "")}\n${labels}` };
  },
  github(body, event) {
    if (event === "issues" && body.action === "assigned" && /shoal/i.test(body.assignee?.login ?? "")) return { ref: `#${body.issue.number}`, text: `${body.issue.title}\n${body.issue.body ?? ""}` };
    if (event === "issue_comment" && body.action === "created" && MENTION.test(body.comment?.body ?? "")) return { ref: `#${body.issue.number}`, text: `${body.issue.title}\n${body.issue.body ?? ""}\n${body.comment.body}` };
    return null;
  },
  bitbucket(body) {
    const text = body.comment?.content?.raw ?? "";
    if (!MENTION.test(text)) return null;
    return { ref: `#${body.pullrequest?.id ?? body.issue?.id ?? ""}`, text: `${body.pullrequest?.title ?? body.issue?.title ?? ""}\n${text}` };
  },
  gitlab(body) {
    const text = body.object_attributes?.note ?? body.object_attributes?.description ?? "";
    if (!MENTION.test(text)) return null;
    return { ref: `!${body.object_attributes?.iid ?? ""}`, text: `${body.issue?.title ?? body.merge_request?.title ?? ""}\n${text}` };
  },
};

// --- Agent card ----------------------------------------------------------------------

export function agentCard(baseUrl) {
  const url = env("SHOAL_PUBLIC_URL") || baseUrl;
  return {
    name: "Shoal",
    description: "Neutral referee for developer-pain bounties. Finds flaky tests, type escapes, unsupported runtimes, unused dependencies, broken docs, hardcoded secrets, slow CI and slow reviews, then pays agents only for fixes that measurably hold.",
    url,
    version: "1.0.0",
    capabilities: { streaming: true, pushNotifications: false },
    authentication: { schemes: ["shared-secret"], note: "Webhook calls carry SHOAL_WEBHOOK_SECRET" },
    skills: Object.entries(CLASSES).map(([id, c]) => ({ id, name: c.title, description: `${c.metric}. ${c.guard}`, tags: [c.where] })),
    endpoints: {
      mcp: `${url}/mcp`,
      webhooks: ["jira", "github", "bitbucket", "gitlab"].map((p) => `${url}/api/hooks/${p}`),
      painClasses: `${url}/api/pain-classes`,
    },
  };
}
