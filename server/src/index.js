import express from "express";
import cors from "cors";
import compression from "compression";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { refreshSources, scan } from "./scanner.js";
import { createBounty, getBounty, leaderboard, morningSettlement, publicBounty, recoverInterrupted, runBounty } from "./bounties.js";
import { checkSurvivors } from "./survival.js";
import { loadState, saveState, storageInfo } from "./persist.js";
import { importOpenRouterModel, listing, listingExists, marketplace, ownerOf, publishAgent, refreshOpenRouter, removeListing, rotateSecret, updateAgent } from "./marketplace.js";
import { createReview, deleteReview, replyToReview, reviewsFor, voteHelpful } from "./reviews.js";
import { clearEvents, eventsAfter, emit, waitForEvents } from "./events.js";
import { state, resetState, resetRepoState, DEMO_CONNECTION } from "./store.js";
import { isActive, recentRepos, rememberRepo, unpark, wipeParked } from "./repos.js";
import { getStacks, isTestFile, listAllFiles, resetWorkspace, setSource, DEMO_REPO, REPOS_DIR, WORKSPACE } from "./repo.js";
import { describeStack } from "./stack.js";
import { zip } from "./zip.js";
import { readFile, rm } from "node:fs/promises";
import { existsSync, readdirSync, statSync } from "node:fs";
import { describeFile } from "./describe.js";
import { confirmCreditPurchase, confirmFunding, holdWithSavedCard, paymentsMode, refundEscrow, releaseEscrow, startCheckout, startCreditCheckout, stripeConfigured, stripeKeyProblem } from "./escrow.js";
import { billingFor, dismissPrompt, finishSetup, forgetBilling, removeCard, savedCard, startSetup } from "./billing.js";
import { isProtected } from "./verifier.js";
import { PROBLEMS, cleanProblems, cleanSharedPaths, isSecret } from "./scope.js";
import { AGENTS, MOCK, modelUnavailable } from "./agents.js";
import { MODELS, costPerFix, overallPick, scoreboard, trialSummary } from "./trials.js";
import { PACKS, addCredits, balanceCents, creditsSummary, fixPriceCents, isCreditAmount } from "./credits.js";
import { mountMcp } from "./mcp.js";
import { proofFor, proveProblem, resetProofs } from "./proof.js";
import { markConnected, reapplyBoughtFixes, setAutoSync, syncNow, syncStatus } from "./sync.js";
import { detectClaude, finishLogin, startLogin } from "./claude-runner.js";
import { detectCodex, startCodexLogin } from "./codex-runner.js";
import { startTrialRun, stopTrialRun, trialRun } from "./trial-runner.js";
import { integrationStatus } from "./integrations.js";
import {
  authorizeUrl, getOAuthToken, ciStats, cloneRepo, completeOAuth, getRepo, getViewer, hasToken, listRepos, oauthConfigured, parseRepo, repoFiles, revokeGrant, signedInWithEnvToken, signOut,
} from "./github.js";

const PORT = Number(process.env.PORT) || 4000;
// Where this server is reachable from outside: OAuth redirects and the MCP
// URL are built from it. On Vercel it defaults to the production domain.
const BASE_URL = (
  process.env.SHOAL_PUBLIC_URL ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : `http://localhost:${PORT}`)
).replace(/\/$/, "");
// The website, when it's hosted separately (e.g. its own Vercel project):
// those origins may call the API from the browser, with cookies.
const WEB_ORIGINS = (process.env.SHOAL_WEB_ORIGINS ?? "").split(",").map((o) => o.trim().replace(/\/$/, "")).filter(Boolean);

const app = express();
// Behind Vercel's (or any) proxy, trust X-Forwarded-* for the client IP and https.
if (process.env.VERCEL || process.env.SHOAL_TRUST_PROXY === "1") app.set("trust proxy", 1);
app.use(WEB_ORIGINS.length ? cors({ origin: WEB_ORIGINS, credentials: true }) : cors());
// Gzip pages, scripts and JSON (the platform's JavaScript shrinks to about a
// third). Not /mcp or event streams: those are streamed and must not be buffered.
app.use(compression({ filter: (req, res) => !req.path.startsWith("/mcp") && !/event-stream/.test(res.getHeader("Content-Type") ?? "") && compression.filter(req, res) }));
// Trial patches carry whole files, so allow more than the 100kb default.
app.use(express.json({ limit: "2mb" }));

// MCP endpoint for the team's own AI app (Claude, ChatGPT, Codex): the free
// trial round, plus its GitHub sign-in (see mcp.js and oauth.js).
mountMcp(app, { baseUrl: BASE_URL });

// Long-running steps run in the background; the dashboard follows along on
// the SSE stream instead of waiting on the HTTP response.
const background = (fn) => fn().catch((err) => emit("error", { message: err.message }));

// Pages: / (landing, built from web/), /start (sign in + choose path), /team (dashboard), /builder
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
const hasLanding = existsSync(path.join(WEB_DIR, "index.html"));
// Only the root `npm start` rebuilds web/. Starting the server any other way
// serves whatever was built last, so say so when the source is newer.
const staleLanding = (() => {
  const web = path.join(WEB_DIR, "..");
  if (!hasLanding || !existsSync(path.join(web, "src"))) return false;
  const built = statSync(path.join(WEB_DIR, "index.html")).mtimeMs;
  const sources = ["index.html", "app.html", "vite.config.js", ...readdirSync(path.join(web, "src"), { recursive: true }).map((f) => path.join("src", f))];
  return sources.some((f) => existsSync(path.join(web, f)) && statSync(path.join(web, f)).mtimeMs > built);
})();
// Where Stripe sends the team back to: the React dashboard when it is built, else the old one.
const dashboard = (query, view) => (hasLanding ? `/app?${query}#${view}` : `/team?${query}`);
// Older GitHub sign-ins return to "/?github=…"; that, ?switch and a missing build all go to the sign-in page.
app.get("/", (req, res) => {
  const signIn = !hasLanding || "github" in req.query || "github_error" in req.query || "switch" in req.query;
  res.sendFile(path.join(signIn ? PUBLIC_DIR : WEB_DIR, "index.html"));
});
app.get("/start", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
// The platform (marketplace, races, settlement), built from web/app.html.
app.get("/app", (_req, res) => res.sendFile(hasLanding ? path.join(WEB_DIR, "app.html") : path.join(PUBLIC_DIR, "team.html")));
app.use(express.static(PUBLIC_DIR, { index: false }));
// Built files in assets/ have a content hash in their name, so browsers can
// keep them for good instead of re-checking each one on every page load.
const cacheAssets = (res, file) => file.includes(`${path.sep}assets${path.sep}`) && res.set("Cache-Control", "public, max-age=31536000, immutable");
if (hasLanding) app.use(express.static(WEB_DIR, { index: false, setHeaders: cacheAssets }));

app.get("/api/health", (_req, res) =>
  res.json({
    ok: true,
    mock: MOCK,
    // Which paid-run APIs Shoal has keys for.
    providers: { anthropic: Boolean(process.env.ANTHROPIC_API_KEY), openai: Boolean(process.env.OPENAI_API_KEY) },
    // Which outside APIs have their keys set (npm run keys -- --check tests them).
    integrations: integrationStatus(),
    githubToken: hasToken(),
    payments: paymentsMode(),
    // Demo mode: every survival window lasts this many minutes (survival.js).
    survivalMinutes: Number(process.env.SHOAL_SURVIVAL_MINUTES) > 0 ? Number(process.env.SHOAL_SURVIVAL_MINUTES) : null,
  }),
);

// --- Repo connection -------------------------------------------------------

app.get("/api/connection", (_req, res) => res.json({ ...state.connection, githubToken: hasToken(), tests: getStacks().map(describeStack), sync: syncStatus(), recent: recentRepos() }));
app.get("/api/ci", (_req, res) => res.json(state.ci));

app.get("/api/github/me", async (_req, res) =>
  res.json({ token: hasToken(), oauth: oauthConfigured(), viewer: await getViewer().catch(() => null) }),
);
app.get("/api/github/repos", async (_req, res) => res.json(await listRepos()));

// Files in a repo (or the demo repo), for the "what can agents see" picker.
// Secrets are flagged so the UI can show them as never shared.
// Always the latest commit: pass fresh=1 to skip even the few-second cache.
app.get("/api/repo-files", async (req, res) => {
  const { files, truncated, head = null } =
    req.query.repo === "demo"
      ? { files: await listAllFiles(DEMO_REPO), truncated: false }
      : await repoFiles(parseRepo(req.query.repo), { fresh: req.query.fresh === "1" });
  res.json({
    head,
    files: files.map((p) => ({
      path: p,
      description: describeFile(p),
      secret: isSecret(p),
      test: isTestFile(p),
      protected: isProtected(p),
    })),
    truncated,
  });
});

app.get("/api/problems", (_req, res) => res.json(Object.entries(PROBLEMS).map(([id, p]) => ({ id, ...p }))));

// Sign in with GitHub: redirect to GitHub's login/consent page, then GitHub
// redirects back to the callback with a one-time code. Always built from
// BASE_URL, never the host the page was opened on: GitHub only accepts the
// callback registered on the OAuth App, so 127.0.0.1 vs localhost must not matter.
const callbackUrl = () => `${BASE_URL}/api/auth/github/callback`;

// Only same-site paths or the website's own origins, so the redirect can't
// be pointed at another site.
const safeReturn = (p) => {
  if (typeof p !== "string") return "/";
  if (/^\/(?!\/)/.test(p)) return p;
  try {
    return WEB_ORIGINS.includes(new URL(p).origin) ? p : "/";
  } catch {
    return "/";
  }
};

app.get("/api/auth/github", (req, res) => {
  if (!oauthConfigured()) return res.status(400).send("GitHub sign-in isn't set up: start the server with GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.");
  res.redirect(authorizeUrl(callbackUrl(req), safeReturn(req.query.return)));
});

app.get("/api/auth/github/callback", async (req, res) => {
  let returnTo = "/";
  try {
    returnTo = safeReturn(await completeOAuth({ code: req.query.code, state: req.query.state, callbackUrl: callbackUrl(req) }));
    const viewer = await getViewer();
    emit("auth.signed_in", { message: `Signed in to GitHub as @${viewer.login}` });
    res.redirect(withQuery(returnTo, "github=signed-in"));
  } catch (err) {
    res.redirect(withQuery(returnTo, `github_error=${encodeURIComponent(err.message)}`));
  }
});

// The query goes before any #fragment, so "/app#account" becomes "/app?github=…#account".
const withQuery = (url, query) => {
  const [base, hash] = url.split("#");
  return `${base}${base.includes("?") ? "&" : "?"}${query}${hash ? `#${hash}` : ""}`;
};

app.post("/api/auth/github/logout", (_req, res) => {
  signOut();
  state.role = null;
  emit("auth.signed_out", { message: "Signed out of GitHub" });
  res.json({ ok: true });
});

// Delete your Shoal account: everything tied to your GitHub login goes
// (published agents and imported models, your reviews, replies and helpful
// votes, reviews of your agents), you're unlinked from bounties you posted
// (bounties and the ledger stay: they're payment records), Shoal's access
// on GitHub is revoked, and you're signed out.
app.delete("/api/me", async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.status(401).json({ error: "Sign in to delete your account" });
  const testUser = process.env.SHOAL_TEST_USERS === "1" && !process.env.VERCEL && req.get("x-shoal-test-user");
  if (signedInWithEnvToken() && !testUser) {
    return res.status(400).json({ error: "This server signs in with GITHUB_TOKEN from server/.env, not a GitHub sign-in. Remove it from .env to sign out." });
  }
  const login = user.login;
  // Shoal is your workspace: deleting the account wipes all of it, back to a
  // fresh start. The wipe itself is in memory and saved before answering;
  // the slow, outside parts (Stripe, deleting the clone, revoking GitHub
  // access) run right after, in the background, so this answers quickly.
  // Money is settled, not dropped: held rewards are released and a fix still
  // in its survival window is refunded, so nothing is charged after you leave.
  const settle = state.bounties.filter((b) => b.escrow?.status === "held" || (b.escrow?.status === "charged" && b.status === "surviving"));
  const listings = state.listings.filter((l) => (l.owner ?? l.addedBy) === login).map((l) => l.id);
  const removed = { listings: listings.length, reviews: state.reviews.length, bounties: state.bounties.length };
  // Every repo's copy goes: clones and the parked working copies (repos.js).
  const token = getOAuthToken();
  const billing = state.billing[login];
  setSource(DEMO_REPO);
  await resetWorkspace();
  resetState();
  Object.assign(state, {
    connection: DEMO_CONNECTION,
    ci: [],
    sync: { auto: true, checkedAt: null, syncedAt: null, waiting: null, error: null },
    modelCost: {},
    agents: {},
    listings: [],
    reviews: [],
    reviewVotes: [],
    credits: null,
    role: null,
    recentRepos: [],
  });
  delete state.billing[login];
  clearEvents();
  signOut();
  await saveState();
  emit("auth.account_deleted", { message: `Account deleted: everything was wiped (${removed.bounties} bounties, ${removed.listings} listings, ${removed.reviews} reviews, the repo connection and credits)` });
  res.json({ ok: true, removed });

  // Afterwards, in parallel: release/refund held money, delete the Stripe
  // customer, the clone on disk, and Shoal's access on GitHub.
  Promise.allSettled([
    ...settle.map((b) => (b.escrow.status === "held" ? releaseEscrow(b) : refundEscrow(b)).catch((err) => emit("escrow.error", { bountyId: b.id, message: `Couldn't release or refund ${b.id} after deleting the account: ${err.message}. Do it by hand in Stripe.` }))),
    forgetBilling(login, billing),
    rm(REPOS_DIR, { recursive: true, force: true }),
    wipeParked(),
    revokeGrant(token),
  ]).then(() => console.log(`Finished cleaning up after @${login}'s account deletion`));
});

// --- Who you are on Shoal: a team with dev pain, or an agent builder -------

const ROLES = ["team", "builder"];

// Who's signed in: the dashboard's GitHub sign-in. Test scripts can play
// several people with an X-Shoal-Test-User header, only when the server was
// started with SHOAL_TEST_USERS=1, and never on Vercel.
async function currentUser(req) {
  const test = process.env.SHOAL_TEST_USERS === "1" && !process.env.VERCEL && req.get("x-shoal-test-user");
  if (test) return { login: String(test) };
  return getViewer().catch(() => null);
}

app.get("/api/me", async (_req, res) => {
  const viewer = await getViewer().catch(() => null);
  res.json({ viewer, oauth: oauthConfigured(), role: state.role });
});

app.post("/api/me/role", (req, res) => {
  const role = req.body?.role;
  if (!ROLES.includes(role)) return res.status(400).json({ error: `role must be one of ${ROLES.join(", ")}` });
  state.role = role;
  res.json({ role });
});

app.get("/team", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "team.html")));
app.get("/setup", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "setup.html")));
app.get("/builder", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "builder.html")));

// Point Shoal at a GitHub repo: read metadata + Actions history, clone,
// install, then rescan. Body: { repo: "owner/name" | url, testCommand?,
// problems?: [{ id, note? }], sharedPaths?: ["src", "test", ...] }
// Each stage emits a connect.step event so the dashboard can show progress.
app.post("/api/connect", async (req, res) => {
  const step = (name, message) => emit("connect.step", { step: name, message });
  try {
    await connect(req.body, step, res);
  } catch (err) {
    emit("connect.failed", { message: `Connect failed: ${err.message}` });
    throw err;
  }
});

// Switching rebuilds the active working copy, so not in the middle of a race
// on it. Bounties in their survival window are fine: they keep their own
// repo (repos.js) and are checked there.
function assertNoRaceOnActiveRepo() {
  const racing = state.bounties.filter((b) => ["competing", "verifying", "judging"].includes(b.status) && isActive(b));
  if (racing.length) {
    throw Object.assign(new Error(`Agents are working on ${racing[0].testFile} in ${state.connection.fullName} right now. Switch repos when that finishes (usually a few minutes).`), { status: 409 });
  }
}

// /api/reset wipes bounties, so it still waits for every survival verdict.
function assertNothingSurviving() {
  const watched = state.bounties.filter((b) => b.status === "surviving");
  if (watched.length) {
    throw Object.assign(new Error(`${watched.length} fix${watched.length > 1 ? "es are" : " is"} still in the survival window on ${state.connection.fullName}. Wait for ${watched.length > 1 ? "them" : "it"} to settle first.`), { status: 409 });
  }
}

async function connect(body, step, res) {
  assertNoRaceOnActiveRepo();
  const fullName = parseRepo(body?.repo);
  step("repo", `Looking up ${fullName} on GitHub`);
  const repo = await getRepo(fullName);
  // The Actions history is read while the code downloads, not before it.
  step("clone", `Getting ${fullName} (${repo.defaultBranch}) and its CI history, and installing dependencies`);
  const [ci, dir] = await Promise.all([
    ciStats(fullName).catch((err) => {
      emit("connect.warning", { message: `Couldn't read GitHub Actions history: ${err.message}` });
      return [];
    }),
    cloneRepo(fullName, (message) => step("install", message), repo.defaultBranch),
  ]);

  setSource(dir, body?.testCommand);
  await resetWorkspace();
  // This repo's scan, trials and proofs start over; bounties and payment
  // records (on any repo) stay.
  resetRepoState();
  unpark(fullName);
  const connectedTo = dir;
  state.connection = {
    type: "github",
    ...repo,
    testCommand: body?.testCommand || null,
    problems: cleanProblems(body?.problems),
    sharedPaths: cleanSharedPaths(body?.sharedPaths),
    connectedAt: new Date().toISOString(),
  };
  state.ci = ci;
  await markConnected(connectedTo);
  // Fixes already bought on this repo go back into its working copy.
  await reapplyBoughtFixes();
  rememberRepo();
  emit("connect.done", {
    message: `Connected to ${repo.fullName}: ${describeTests()}, ${ci.length} CI workflows found, ${describeScope()}, ${repo.canWrite ? "can open PRs" : "read-only (no PRs)"}`,
    connection: state.connection,
  });
  res.json({ connection: state.connection, ci });
  step("scan", `Scanning ${repo.fullName} for flaky tests`);
  background(() => scan());
}

app.post("/api/connect/demo", async (req, res) => {
  assertNoRaceOnActiveRepo();
  setSource(DEMO_REPO);
  await resetWorkspace();
  resetRepoState();
  unpark("demo");
  state.connection = { ...DEMO_CONNECTION, problems: cleanProblems(req.body?.problems), sharedPaths: cleanSharedPaths(req.body?.sharedPaths) };
  state.ci = [];
  await reapplyBoughtFixes();
  emit("connect.done", { message: `Using the bundled demo repo, ${describeScope()}`, connection: state.connection });
  res.json({ connection: state.connection });
});

// e.g. "tests: Python (pytest) in api/, JavaScript/TypeScript (vitest)"
function describeTests() {
  const stacks = getStacks();
  if (!stacks.length) return "no test setup found";
  return `tests: ${stacks.map((s) => `${s.def.language} (${s.framework})${s.root === "." ? "" : ` in ${s.root}/`}${s.toolOk ? "" : " [toolchain missing]"}`).join(", ")}`;
}

function describeScope() {
  const shared = state.connection.sharedPaths;
  return shared?.length ? `agents can see ${shared.map(pathLabel).join(", ")}` : "agents can see the whole repo";
}

// Live ticker: pages poll this with the last event id they've seen. Short
// requests instead of a held-open stream, because browsers allow only ~6
// open connections per site and a few open tabs would otherwise starve new
// page loads.
// With ?wait=N (seconds, up to 25) the request is held until a new event
// arrives, so pages see changes at once instead of on their next poll.
// One held request per tab stays well under the per-site connection limit.
app.get("/api/events/poll", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const after = Number(req.query.after) || 0;
  const wait = Math.min(25, Number(req.query.wait) || 0);
  if (wait > 0) await waitForEvents(after, wait * 1000, (done) => res.on("close", done));
  if (!res.writableEnded && !res.destroyed) res.json(eventsAfter(after));
});

// Retired streaming endpoint. Tabs still running old page code reconnect
// here; tell them to wait 10 minutes and close at once to free the slot.
app.get("/api/events", (_req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  res.end("retry: 600000\n\n");
});

app.post("/api/scan", async (_req, res) => res.json(await scan()));
app.get("/api/pains", (_req, res) => res.json(state.pains));

app.get("/api/bounties", (_req, res) => res.json(state.bounties.map(publicBounty)));
app.get("/api/bounties/:id", (req, res) => res.json(publicBounty(getBounty(req.params.id))));
// Post a bounty. With Stripe set up, the reward is held via Checkout first:
// the response carries checkoutUrl and the bounty runs once funding clears.
// Body: { painId, reward, survivalDays?: 7 | 10 | 14, competitors?: [listing ids] }
// competitors: who may compete (and see the shared code); default Shoal's
// built-in agents. Any marketplace listing that's available can be picked.
app.post("/api/bounties", async (req, res) =>
  openBounty(req, res, {
    painId: req.body?.painId,
    reward: req.body?.reward,
    survivalDays: req.body?.survivalDays,
    competitors: req.body?.competitors,
    postedBy: (await currentUser(req))?.login ?? null,
  }),
);

// --- Model trials (MCP) and the approved API run --------------------------

app.get("/api/trials", (_req, res) =>
  res.json({
    scoreboard: scoreboard(),
    pick: overallPick(),
    problems: trialSummary().map((p) => {
      const proof = proofFor(p.painId);
      return { ...p, proof, fixPrice: proof.proven ? fixPriceCents(costPerFix(proof.proven.model)) / 100 : null };
    }),
    trials: state.trials.slice(0, 40).map(({ files, ...t }) => ({ ...t, files: files.map((f) => f.path) })),
    models: MODELS,
    run: trialRun(),
  }),
);

// The corrected code a trial wrote: one fixed file, or the whole repo with
// the fix applied as a .zip. Trials never touch the real repo, so this is how
// the team gets the result without buying the fix.
app.get("/api/trials/:id/file", (req, res) => {
  const trial = state.trials.find((t) => t.id === req.params.id);
  const file = trial?.files.find((f) => f.path === req.query.path);
  if (!file) return res.status(404).json({ error: "No such file in this trial" });
  res.attachment(path.basename(file.path)).type("text/plain").send(file.content);
});

app.get("/api/trials/:id/repo", async (req, res) => {
  const trial = state.trials.find((t) => t.id === req.params.id);
  if (!trial) return res.status(404).json({ error: "No such trial" });
  const fixed = new Map(trial.files.map((f) => [f.path, f.content]));
  const paths = [...new Set([...(await listAllFiles(WORKSPACE)), ...fixed.keys()])].filter((p) => !isSecret(p));
  const files = await Promise.all(paths.map(async (p) => ({ path: p, data: fixed.get(p) ?? (await readFile(path.join(WORKSPACE, p))) })));
  const name = `${(state.connection.fullName ?? "repo").replace(/[^\w.-]+/g, "-")}-fixed-by-${(MODELS[trial.model]?.name ?? "agent").replace(/\s+/g, "-")}.zip`;
  res.attachment(name).type("application/zip").send(zip(files));
});

// One-click trial: Shoal finds Claude Code here, runs it against its own MCP
// server, and stops when it's done (see trial-runner.js). Codex does the same
// for the OpenAI models, on the team's ChatGPT plan.
app.get("/api/claude", async (req, res) => res.json(await detectClaude({ fresh: req.query.fresh === "1" })));
app.post("/api/claude/login", async (_req, res) => res.json(await startLogin()));
app.post("/api/claude/login/code", async (req, res) => res.json(await finishLogin(req.body?.code)));
app.get("/api/codex", async (req, res) => res.json(await detectCodex({ fresh: req.query.fresh === "1" })));
app.post("/api/codex/login", async (_req, res) => res.json(await startCodexLogin()));
// Body: { use?: ["claude", "codex"] }; default every app that's signed in.
app.post("/api/trials/run", async (req, res) => {
  await startTrialRun(`http://localhost:${PORT}`, { use: Array.isArray(req.body?.use) ? req.body.use : undefined });
  res.status(202).json(trialRun());
});
app.post("/api/trials/stop", (_req, res) => {
  stopTrialRun();
  res.json(trialRun());
});

// Approve a model for a problem: by default the best passing trial. That
// model then fixes it through the API, funded and charged like any bounty.
// The optimizer's pick fixes it through the API, paid from prepaid credits:
// only a verified fix is charged (real API cost + Shoal's fee).
// Only a fix the proof report marked "Safe to buy" can be bought.
app.post("/api/trials/approve", (req, res) => {
  const { painId } = req.body ?? {};
  const proof = proofFor(painId);
  const trial = proof.proven && state.trials.find((t) => t.id === proof.proven.trialId);
  if (!trial) {
    return res.status(409).json({
      error: proof.checking ? "Still building the proof report for this test" : "No fix for this test is proven yet, so it can't be bought",
    });
  }
  const unavailable = modelUnavailable(trial.model);
  if (unavailable) return res.status(503).json({ error: `${MODELS[trial.model].name} can't run yet: ${unavailable}` });
  if (state.bounties.some((b) => b.painId === painId && b.apiModel && !["failed", "settled", "clawed_back", "payment_failed"].includes(b.status))) {
    return res.status(409).json({ error: "An API fix for this problem is already running" });
  }
  const estimate = fixPriceCents(costPerFix(trial.model));
  if (estimate > balanceCents()) {
    return res.status(402).json({ error: `Not enough credits: this fix should cost about $${(estimate / 100).toFixed(2)}. Buy a credit pack first.` });
  }
  const bounty = createBounty({ painId, reward: estimate / 100, funding: "credits", apiModel: trial.model, trialId: trial.id, survivalDays: req.body?.survivalDays });
  background(() => runBounty(bounty.id));
  res.status(202).json(publicBounty(bounty));
});

// Shared paths are folders or single files; files have an extension.
const pathLabel = (p) => (p === "." ? "root files" : /\.[^/]+$/.test(p) ? p : `${p}/`);

// Share more folders or files with agents (e.g. code tests import but agents can't see),
// without re-cloning or re-running the scan.
app.post("/api/connection/share", async (req, res) => {
  const add = cleanSharedPaths(req.body?.add);
  const current = state.connection.sharedPaths ?? [];
  if (current.length) state.connection.sharedPaths = [...new Set([...current, ...add])];
  await refreshSources();
  state.connection.newPaths = (state.connection.newPaths ?? []).filter((p) => !state.connection.sharedPaths.includes(p));
  emit("connect.done", { message: `Agents can now also see ${add.map(pathLabel).join(", ")}`, connection: state.connection });
  res.json({ sharedPaths: state.connection.sharedPaths, pains: state.pains });
});

// Sync with GitHub: pull new commits now, or turn the every-minute check on/off.
app.get("/api/sync", (_req, res) => res.json(syncStatus()));
app.post("/api/sync", async (_req, res) => res.json(await syncNow()));
app.post("/api/sync/auto", (req, res) => res.json(setAutoSync(req.body?.on)));

// Build (or rebuild) the proof report for a test, e.g. after manual trials.
app.post("/api/proofs", (req, res) => {
  const painId = req.body?.painId;
  if (!state.trials.some((t) => t.painId === painId && t.status === "passed")) {
    return res.status(400).json({ error: "This test has no verified trial fix to prove yet" });
  }
  if (req.body?.fresh) resetProofs(painId);
  background(() => proveProblem(painId));
  res.status(202).json(proofFor(painId));
});

// --- Credits -----------------------------------------------------------------

app.get("/api/credits", (_req, res) => res.json({ ...creditsSummary(), payments: paymentsMode() }));

// Buy a pack: Stripe Checkout when Stripe is set up, otherwise simulated.
app.post("/api/credits/buy", async (req, res) => {
  const dollars = Number(req.body?.dollars);
  if (!isCreditAmount(dollars)) return res.status(400).json({ error: "Choose a pack or a whole amount from $5 to $1,000" });
  // Credits are bought, never given: without Stripe there's no payment, so no
  // credits. ("Buy" used to add them for free in simulated mode, which is how
  // a balance appeared from nowhere.)
  if (!stripeConfigured()) return res.status(409).json({ error: "Buying credits needs Stripe, which isn't set up on this server" });
  const base = `${req.protocol}://${req.get("host")}`;
  const checkoutUrl = await startCreditCheckout(dollars, {
    successUrl: `${base}/api/credits/return?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${base}${dashboard("credits=cancelled", "billing")}`,
  });
  res.json({ checkoutUrl });
});

app.get("/api/credits/return", async (req, res) => {
  try {
    const { dollars, sessionId } = await confirmCreditPurchase(req.query.session_id);
    await addCredits({ dollars, mode: paymentsMode(), stripeSessionId: sessionId });
    res.redirect(dashboard("credits=added", "billing"));
  } catch (err) {
    emit("credits.error", { message: `Credit purchase didn't go through: ${err.message}` });
    res.redirect(dashboard("credits=failed", "billing"));
  }
});

// With Stripe, the reward is held on the team's saved card (set up once,
// see billing.js); no card yet: 402 with needsPaymentMethod, so the platform
// asks for one. A card that needs confirming (3-D Secure) gets Checkout.
async function openBounty(req, res, opts) {
  const funding = stripeConfigured() && req.body?.funding !== "simulated" ? "stripe" : "simulated";
  const card = funding === "stripe" && opts.postedBy ? savedCard(opts.postedBy) : null;
  if (funding === "stripe" && (!card || card.simulated)) {
    return res.status(402).json({ error: "Add a payment method before posting a bounty", needsPaymentMethod: true });
  }
  const bounty = createBounty({ ...opts, funding });
  let checkoutUrl = null;
  if (funding === "stripe") {
    try {
      await holdWithSavedCard(bounty, card);
      bounty.status = "open";
    } catch (err) {
      if (err.needsCheckout) {
        checkoutUrl = await startCheckout(bounty, checkoutUrls(req, bounty));
      } else {
        // Declined, or Stripe failed: don't leave an unfundable bounty behind.
        state.bounties = state.bounties.filter((b) => b !== bounty);
        emit("escrow.error", { bountyId: bounty.id, message: `Couldn't hold the reward on your card: ${err.message}` });
        throw Object.assign(new Error(`Your card couldn't hold $${bounty.reward}: ${err.message.replace(/\.$/, "")}. Update your card in Credits & billing.`), { status: 402 });
      }
    }
  }
  res.status(201).json({ ...publicBounty(bounty), checkoutUrl });
}

// --- Payment method (see billing.js) -------------------------------------------

const signedInUser = async (req) => {
  const user = await currentUser(req);
  if (!user) throw Object.assign(new Error("Sign in with GitHub first"), { status: 401 });
  return user;
};

app.get("/api/billing", async (req, res) => res.json(billingFor((await signedInUser(req)).login)));
// Save or replace the card: { url } to Stripe Checkout (setup mode), or the
// billing state at once when payments are simulated.
app.post("/api/billing/setup", async (req, res) => {
  const user = await signedInUser(req);
  const base = `${req.protocol}://${req.get("host")}`;
  // Back to the page they started from (a platform view name).
  const view = /^[a-z]{1,20}$/.test(req.body?.from ?? "") ? req.body.from : "bounties";
  res.json(await startSetup(user.login, {
    successUrl: `${base}/api/billing/return?view=${view}&session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${base}${dashboard("payments=cancelled", view)}`,
  }));
});
app.get("/api/billing/return", async (req, res) => {
  const view = /^[a-z]{1,20}$/.test(req.query.view ?? "") ? req.query.view : "bounties";
  try {
    const user = await signedInUser(req);
    await finishSetup(user.login, req.query.session_id);
    res.redirect(dashboard("payments=saved", view));
  } catch (err) {
    res.redirect(dashboard(`payments=failed&reason=${encodeURIComponent(err.message)}`, view));
  }
});
// "Later" on the new-account prompt.
app.post("/api/billing/later", async (req, res) => res.json(dismissPrompt((await signedInUser(req)).login)));
app.delete("/api/billing", async (req, res) => res.json(await removeCard((await signedInUser(req)).login)));

app.post("/api/bounties/:id/fund", async (req, res) => {
  const bounty = getBounty(req.params.id);
  if (bounty.escrow.status !== "awaiting_funding") return res.status(400).json({ error: "This bounty is already funded" });
  res.json({ checkoutUrl: await startCheckout(bounty, checkoutUrls(req, bounty)) });
});

const checkoutUrls = (req, bounty) => {
  const base = `${req.protocol}://${req.get("host")}`;
  return {
    successUrl: `${base}/api/escrow/return?bounty=${bounty.id}&session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${base}${dashboard("funding=cancelled", "bounties")}`,
  };
};

// Stripe sends the team back here after Checkout; confirm the hold, then run.
app.get("/api/escrow/return", async (req, res) => {
  const bounty = getBounty(req.query.bounty);
  try {
    if (bounty.escrow.status === "awaiting_funding") await confirmFunding(bounty, req.query.session_id);
    // Opening this link again later (or for a bounty that's already racing or
    // done) must not reset or rerun it: only a bounty waiting to start starts.
    const starting = ["awaiting_funding", "open"].includes(bounty.status);
    if (starting) {
      bounty.status = "open";
      background(() => runBounty(bounty.id));
    }
    res.redirect(starting ? dashboard("funding=held", "bounties") : hasLanding ? "/app#bounties" : "/team");
  } catch (err) {
    emit("escrow.error", { bountyId: bounty.id, message: `Funding didn't go through: ${err.message}` });
    res.redirect(dashboard("funding=failed", "bounties"));
  }
});

// Re-measure a fix in its survival window right now (normally after every
// new commit and on a schedule; see survival.js).
app.post("/api/bounties/:id/survival/check", async (req, res) => {
  const bounty = getBounty(req.params.id);
  if (bounty.status !== "surviving") return res.status(400).json({ error: "This bounty isn't in its survival window" });
  await checkSurvivors({ trigger: "requested", bountyId: bounty.id });
  res.json(publicBounty(bounty));
});

app.post("/api/bounties/:id/run", (req, res) => {
  const bounty = getBounty(req.params.id);
  if (bounty.escrow.status !== "held") return res.status(402).json({ error: "Fund this bounty before agents can work on it" });
  background(() => runBounty(bounty.id));
  res.status(202).json({ accepted: true, bountyId: bounty.id });
});

// One-click demo: post a bounty for the worst pain point and run it to settlement.
app.post("/api/demo", async (req, res) => {
  if (!state.pains.length) await scan();
  const pain = state.pains.find((p) => !p.healthy && (!req.body?.painId || p.id === req.body.painId));
  if (!pain) return res.status(400).json({ error: "No flaky tests left to fix" });
  const bounty = createBounty({ painId: pain.id, reward: req.body?.reward ?? 400 });
  background(() => runBounty(bounty.id));
  res.status(202).json(publicBounty(bounty));
});

app.get("/api/agents", (_req, res) => res.json(leaderboard()));
app.get("/api/agents", (_req, res) => res.json(leaderboard()));

// Publish a custom agent to the marketplace. It bids on new bounties like the seeded ones.
app.post("/api/agents", async (req, res) => {
  const { name, tagline = "", strategy, model = "", params = null, specialty = "", minBid = null, maxBid = null } = req.body ?? {};
  if (!name?.trim() || !strategy?.trim() || strategy.trim().length < 20) return res.status(400).json({ error: "An agent needs a name and a strategy (20+ characters)" });
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "agent";
  if (AGENTS.some((a) => a.id === id)) return res.status(409).json({ error: `An agent called ${name} already exists` });
  const viewer = await getViewer().catch(() => null);
  const lo = Number(minBid) || null, hi = Number(maxBid) || lo;
  const agent = {
    id, name: name.trim().slice(0, 40), builder: viewer ? `@${viewer.login}` : "@you",
    tagline: String(tagline).slice(0, 80),
    pricing: lo ? `Bid $${lo}-$${hi} depending on difficulty.` : "Bid what the fix is worth.",
    strategy: strategy.slice(0, 1200), model: String(model).slice(0, 40),
    params: params == null || params === "" ? null : Number(params), specialty: String(specialty).slice(0, 40),
    minBid: lo, maxBid: hi, rating: null, reviews: 0, enabled: true, custom: true,
  };
  AGENTS.push(agent);
  state.agents[id] = { jobs: 0, wins: 0, rollbacks: 0, earnings: 0 };
  emit("agent.published", { agentId: id, message: `${agent.name} by ${agent.builder} joined the marketplace` });
  res.status(201).json(agent);
});
// Turn an agent on or off for new bounties.
app.post("/api/agents/:id/enabled", (req, res) => {
  const agent = AGENTS.find((a) => a.id === req.params.id);
  if (!agent) return res.status(404).json({ error: "Unknown agent" });
  agent.enabled = Boolean(req.body?.enabled);
  emit("agent.toggled", { agentId: agent.id, message: `${agent.name} ${agent.enabled ? "will bid on" : "won't bid on"} new bounties` });
  res.json(agent);
});

// --- Marketplace -------------------------------------------------------------
// Every agent and model a team can pick, with Shoal's scorecard, verified-
// buyer ratings and (for models) OpenRouter's numbers. See marketplace.js
// for the filters and sorts. Listing ids contain slashes
// (openrouter:z-ai/glm-5.3), so single listings go by ?id=.
app.get("/api/marketplace", async (req, res) => res.json(marketplace(req.query, await currentUser(req))));
app.get("/api/marketplace/listing", async (req, res) => {
  const user = await currentUser(req);
  res.json({ ...listing(req.query.id, user), reviews: reviewsFor(req.query.id, req.query.reviewSort) });
});
// Import an OpenRouter model by id. Body: { id: "z-ai/glm-5.3" }
app.post("/api/marketplace/openrouter", async (req, res) => {
  const user = await currentUser(req);
  res.status(201).json(await importOpenRouterModel(req.body?.id, { by: user?.login ?? null }));
});
app.post("/api/marketplace/openrouter/refresh", async (_req, res) => {
  await refreshOpenRouter();
  res.json({ ok: true });
});
// Builders publish agents with a webhook. The response has the signing
// secret, shown this once. Body: { name, tagline, description, webhookUrl,
// pains, languages }
app.post("/api/marketplace/agents", async (req, res) => res.status(201).json(publishAgent(req.body ?? {}, await currentUser(req))));
app.patch("/api/marketplace/agents", async (req, res) => res.json(updateAgent(req.query.id, req.body ?? {}, await currentUser(req))));
app.post("/api/marketplace/agents/rotate-secret", async (req, res) => res.json(rotateSecret(req.query.id, await currentUser(req))));
app.delete("/api/marketplace/listing", async (req, res) => {
  removeListing(req.query.id, await currentUser(req));
  res.json({ ok: true });
});

// Reviews: verified buyers only (see reviews.js).
// Body: { listingId, bountyId, stars, body, aspects: { codeQuality, prClarity, speed } }
app.post("/api/marketplace/reviews", async (req, res) => res.status(201).json(createReview(req.body ?? {}, await currentUser(req), listingExists)));
app.delete("/api/marketplace/reviews/:id", async (req, res) => {
  deleteReview(req.params.id, await currentUser(req));
  res.json({ ok: true });
});
app.post("/api/marketplace/reviews/:id/reply", async (req, res) => res.json(replyToReview(req.params.id, req.body?.body, await currentUser(req), ownerOf)));
app.post("/api/marketplace/reviews/:id/helpful", async (req, res) => res.json(voteHelpful(req.params.id, await currentUser(req), true)));
app.delete("/api/marketplace/reviews/:id/helpful", async (req, res) => res.json(voteHelpful(req.params.id, await currentUser(req), false)));
app.get("/api/ledger", (_req, res) => res.json(state.ledger));
app.get("/api/settlement", (_req, res) => res.json(morningSettlement()));

app.post("/api/reset", async (_req, res) => {
  assertNothingSurviving();
  await resetWorkspace();
  resetState();
  emit("reset", { message: `Workspace restored to the original ${state.connection.fullName}` });
  res.json({ ok: true });
});

app.use((err, _req, res, _next) => {
  res.status(err.status ?? 500).json({ error: err.message });
});

// Pick up where the last run left off: the repo connection, and bounties
// whose survival windows are still running (with their fixes re-applied).
const restored = await loadState();
// The repo connected before repos were remembered shows up in the recent list too.
if (state.connection.type === "github" && !state.recentRepos.some((r) => r.fullName === state.connection.fullName)) rememberRepo();
if (restored) recoverInterrupted();
await resetWorkspace();
if (restored) await reapplyBoughtFixes();

// On Vercel the platform serves the exported app; locally we listen.
export default app;
if (!process.env.VERCEL) app.listen(PORT, (err) => {
  // Express 5 hands listen errors (e.g. the port is taken) to this callback.
  if (err) {
    console.error(err.code === "EADDRINUSE" ? `Port ${PORT} is already in use. Stop whatever is using it or set PORT.` : `Couldn't start the server: ${err.message}`);
    process.exit(1);
  }
  const keys = [process.env.ANTHROPIC_API_KEY && "Claude", process.env.OPENAI_API_KEY && "OpenAI"].filter(Boolean);
  console.log(`Shoal server on http://localhost:${PORT} (${MOCK ? "MOCK agents: set ANTHROPIC_API_KEY / OPENAI_API_KEY for real paid runs" : `paid runs: ${keys.join(" + ")} API`})`);
  console.log(
    oauthConfigured()
      ? `MCP: ${BASE_URL}/mcp (ChatGPT, Codex and Claude sign in with GitHub)${process.env.SHOAL_AUTH_SECRET ? "" : "; set SHOAL_AUTH_SECRET so sign-ins survive restarts"}`
      : `MCP: claude mcp add --transport http shoal http://localhost:${PORT}/mcp (local only; set GITHUB_CLIENT_ID/SECRET for ChatGPT and Codex)`,
  );
  const watching = state.bounties.filter((b) => b.status === "surviving").length;
  const store = storageInfo();
  console.log(`Storage: ${store.backend === "supabase" ? `Supabase (schema ${store.schema})` : `${store.file} (set SUPABASE_DB_URL for Supabase)`}`);
  if (restored) console.log(`Restored ${state.connection.fullName}: ${state.bounties.length} bounties, ${watching} in their survival window`);
  console.log(`GitHub:${hasToken() ? "GITHUB_TOKEN set" : "no GITHUB_TOKEN (public repos read-only, no PRs)"}`);
  if (staleLanding) console.warn("Web: web/dist is older than web/src, so /app and / are out of date. Run `npm run build` from the repo root, or start with `npm start` there.");
  console.log(
    `Payments: ${{ "stripe-live": "Stripe LIVE escrow: REAL MONEY", "stripe-test": "Stripe TEST mode escrow" }[paymentsMode()] ?? (stripeKeyProblem() ? `${stripeKeyProblem()}; using simulated escrow` : "simulated escrow (set STRIPE_SECRET_KEY for Stripe)")}`,
  );
});
