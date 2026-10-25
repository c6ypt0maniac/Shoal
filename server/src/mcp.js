// MCP server: how the team's own AI app takes part in the free trial round,
// on the team's own plan (Shoal pays nothing). Works with Claude Code,
// Claude, ChatGPT (developer-mode connector) and Codex. It can see the
// problems Shoal found, read the files the team shared, run tests on a
// candidate patch in a sandbox, submit trial fixes tagged with the model
// that wrote them, and judge other models' fixes for the proof report. It
// can't change the repo, open PRs or move money: that only happens in the
// paid API run after the team approves a model.
//
// Connect (hosted):  <SHOAL_PUBLIC_URL>/mcp, signing in with GitHub (oauth.js).
//   Only GitHub accounts that can read the connected repo get in.
// Connect (local):   claude mcp add --transport http shoal http://localhost:4000/mcp
//   Requests from this machine with no token skip sign-in, as before
//   (that's how claude-runner.js drives Claude Code). Never on Vercel.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { z } from "zod";
import { createSandbox, destroySandbox, listAllFiles, readRepoFile, runTestMany, WORKSPACE, writeFiles } from "./repo.js";
import { inScope, isSecret } from "./scope.js";
import { isProtected } from "./verifier.js";
import { state } from "./store.js";
import { MODELS, MODEL_IDS, scoreboard, submitTrial } from "./trials.js";
import { pendingReviews, reviewRequest, submitReview } from "./proof.js";
import { canAccessRepo, oauthConfigured } from "./github.js";
import { finishMcpSignIn, MCP_CALLBACK_PATH, oauthProvider } from "./oauth.js";

const FileSchema = z.object({
  path: z.string().describe("Path relative to the repo root, e.g. src/cart.js"),
  content: z.string().describe("The complete new contents of the file"),
});

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const WRITES = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

// client: { app, login } for whoever is connected, recorded on what they submit.
function buildServer(client) {
  const server = new McpServer({ name: "shoal", version: "1.1.0" }, { instructions: SERVER_INSTRUCTIONS });

  server.registerTool(
    "list_problems",
    {
      title: "List problems",
      description:
        "The flaky tests Shoal found in the connected repo, with ids, failure rates, the source files each test imports, and a sample failure log, plus the model ids to tag submissions with. Start here.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const flaky = state.pains.filter((p) => !p.healthy);
      return json({
        repo: state.connection.fullName,
        models: Object.fromEntries(MODEL_IDS.map((id) => [id, MODELS[id].name])),
        reviewsWaiting: pendingReviews().length,
        problems: flaky.map((p) => ({
          id: p.id,
          testFile: p.testFile,
          failures: `${p.failures}/${p.runs} runs`,
          sourceFiles: p.sourceFiles,
          sampleFailure: p.sampleFailure ?? null,
        })),
        note: flaky.length ? undefined : "No flaky tests yet. Ask the team to click Scan repo on the Shoal dashboard.",
      });
    },
  );

  server.registerTool(
    "list_files",
    {
      title: "List shared files",
      description: "Files the team shared with agents. Protected files (tests, CI config, manifests) can be read but not changed.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const files = (await listAllFiles(WORKSPACE)).filter(inScope);
      return json(files.map((p) => (isProtected(p) ? `${p} (protected)` : p)));
    },
  );

  server.registerTool(
    "read_file",
    {
      title: "Read file",
      description: "Read one shared file from the repo.",
      inputSchema: { path: z.string().describe("Path relative to the repo root") },
      annotations: READ_ONLY,
    },
    async ({ path }) => {
      const p = cleanPath(path);
      if (!p || !inScope(p)) return error(`${path} isn't shared with agents`);
      try {
        return text(await readRepoFile(p));
      } catch {
        return error(`${path} doesn't exist`);
      }
    },
  );

  server.registerTool(
    "run_tests",
    {
      title: "Run tests",
      description:
        "Run a test file several times in a throwaway sandbox, optionally with your candidate patch applied. Use it to check a fix before submitting. Nothing is saved.",
      inputSchema: {
        test_file: z.string().describe("Test file to run, as list_problems shows it (any language, e.g. test/cart.test.js or tests/test_api.py)"),
        files: z.array(FileSchema).optional().describe("Candidate patch: files to replace before running"),
        times: z.number().int().min(1).max(10).optional().describe("How many runs (default 5)"),
      },
      // Runs code, but only in a throwaway sandbox: nothing is kept.
      annotations: READ_ONLY,
    },
    async ({ test_file, files = [], times = 5 }) => {
      const bad = patchProblem(files);
      if (bad) return error(bad);
      const sandbox = await createSandbox();
      try {
        await writeFiles(sandbox, files.map((f) => ({ ...f, path: cleanPath(f.path) })));
        const runs = await runTestMany(sandbox, test_file, times);
        const passes = runs.filter((r) => r.passed).length;
        return json({ passed: passes, of: times, failureLog: runs.find((r) => !r.passed)?.log ?? null });
      } finally {
        await destroySandbox(sandbox);
      }
    },
  );

  server.registerTool(
    "submit_trial",
    {
      title: "Submit trial fix",
      description:
        "Submit a fix for one problem, tagged with the model that wrote it. Shoal verifies it (green runs in a row, at least 10 and more for rarely failing tests; no test edits, no regressions) and scores it, but doesn't apply it. Returns pass or fail with the failure log so you can retry.",
      inputSchema: {
        problem_id: z.string().describe("Problem id from list_problems"),
        model: z.enum(MODEL_IDS).describe("The model that wrote this fix"),
        summary: z.string().describe("One or two sentences: what was wrong and how this fixes it"),
        files: z.array(FileSchema).min(1).describe("Every file you changed, with its complete new contents"),
      },
    },
    async ({ problem_id, model, summary, files }) => {
      const bad = patchProblem(files);
      if (bad) return error(bad);
      try {
        const t = await submitTrial({ painId: problem_id, model, summary, client, files: files.map((f) => ({ ...f, path: cleanPath(f.path) })) });
        return json({
          trialId: t.id,
          result: t.status,
          reason: t.reason,
          greenRuns: `${t.runs.filter(Boolean).length}/${t.runs.length}`,
          linesChanged: t.linesChanged,
          failureLog: t.failureLog,
        });
      } catch (err) {
        return error(err.message);
      }
    },
  );

  server.registerTool(
    "get_scoreboard",
    {
      title: "Model scoreboard",
      description: "How each model has done in the trials so far.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => json(scoreboard()),
  );

  server.registerTool(
    "list_reviews",
    {
      title: "List reviews waiting",
      description:
        "Fixes in Shoal's proof report waiting for a judge. Each one names the model that must review it (`needs`). Only review ones whose `needs` includes the model you are running as.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const reviews = pendingReviews();
      return json({ reviews, note: reviews.length ? undefined : "No reviews are waiting." });
    },
  );

  server.registerTool(
    "get_review",
    {
      title: "Get review",
      description: "The full review request for one fix: the diff, all the shared code with the fix applied, and how to judge it.",
      inputSchema: { trial_id: z.string().describe("trialId from list_reviews") },
      annotations: READ_ONLY,
    },
    async ({ trial_id }) => {
      try {
        const { instructions, ...about } = reviewRequest(trial_id);
        return text(`${JSON.stringify(about, null, 2)}\n\n${instructions}`);
      } catch (err) {
        return error(err.message);
      }
    },
  );

  server.registerTool(
    "submit_review",
    {
      title: "Submit review",
      description:
        "Your verdict on a fix from get_review. Pass only if every root cause is fixed; fail if it hides a symptom or works around a bug. The fix is proven only if every judge passes it.",
      inputSchema: {
        trial_id: z.string().describe("trialId from list_reviews"),
        model: z.enum(MODEL_IDS).describe("The exact id of the model you are running as; it must be one the review needs"),
        verdict: z.enum(["pass", "fail"]),
        summary: z.string().describe("One or two sentences"),
        remaining_bugs: z.array(z.string()).optional().describe('What is still broken, as "file: problem"'),
        risks: z.array(z.string()).optional().describe("Short risks of landing this fix"),
      },
      annotations: WRITES,
    },
    async ({ trial_id, model, verdict, summary, remaining_bugs = [], risks = [] }) => {
      try {
        return json(submitReview({ trialId: trial_id, model, verdict, summary, remaining: remaining_bugs, risks, via: viaLabel(client) }));
      } catch (err) {
        return error(err.message);
      }
    },
  );

  server.registerPrompt(
    "run_trials",
    {
      title: "Run Shoal model trials",
      description: "Try every flaky test with several models and submit each model's fix to Shoal.",
    },
    () => ({
      messages: [{ role: "user", content: { type: "text", text: TRIAL_INSTRUCTIONS } }],
    }),
  );

  server.registerPrompt(
    "review_fixes",
    {
      title: "Review fixes for Shoal",
      description: "Judge other models' fixes for Shoal's proof report, as the model you're running as.",
    },
    () => ({
      messages: [{ role: "user", content: { type: "text", text: REVIEW_INSTRUCTIONS } }],
    }),
  );

  return server;
}

const viaLabel = (client) => [client?.app, client?.login && `@${client.login}`].filter(Boolean).join(" ") || null;

const TRIAL_INSTRUCTIONS = `Run a Shoal model trial on the connected repo.

1. Call the shoal list_problems tool.
2. For each problem:
   - read ALL the shared code with list_files and read_file, not just the files the test imports
   - find the real cause and fix it in application code. Test files, CI config and manifests are protected and can't change.
   - check the patch with run_tests before submitting
   - call submit_trial with model set to the exact id of the model you are running as (list_problems lists the ids), and retry once using the failure log if the trial fails
   If you can start subagents on different models (Claude Code can: ${Object.entries(MODELS).slice(0, 3).map(([id, m]) => `${m.name} = ${id}`).join(", ")}), run one per model in parallel instead, each tagging its own model id.
   OpenAI model ids: ${Object.entries(MODELS).filter(([, m]) => m.provider === "openai").slice(0, 4).map(([id, m]) => `${m.name} = ${id}`).join(", ")} (list_problems lists every id).
   In ChatGPT or Codex one chat is one model: to compare models, run this again after switching models.
3. Call get_scoreboard and report which model did best on each problem.
4. Call list_reviews. If a review needs the model you are running as, do it (see review_fixes).
The team then approves a model on the Shoal dashboard, and Shoal runs it through the API for the real fix.`;

const REVIEW_INSTRUCTIONS = `Judge fixes for Shoal's proof report.

1. Call list_reviews. Only take reviews whose \`needs\` includes the model you are running as. If none do, say which model each review needs and stop.
2. For each one, call get_review and follow its instructions exactly: read all the code it contains and be strict.
3. Call submit_review with model set to your own model id, your verdict, a one or two sentence summary, remaining_bugs and risks.`;

const SERVER_INSTRUCTIONS = `Shoal finds flaky tests in a team's repo and verifies AI fixes for them. Through these tools you take part in the free trial round:
- To try fixes: ${TRIAL_INSTRUCTIONS.split("\n").slice(2, 9).join(" ").replace(/\s+/g, " ")}
- To judge fixes: call list_reviews, then get_review and submit_review for reviews that need your model.
Always tag submissions with the exact id of the model you are running as. Shoal never applies trial fixes; the team approves a model afterwards for the paid run.`;

// Rejects patches that can't pass anyway, before spending a sandbox on them.
function patchProblem(files) {
  for (const f of files) {
    const p = cleanPath(f.path);
    if (!p) return `Invalid path: ${f.path}`;
    if (isSecret(p) || !inScope(p)) return `${f.path} isn't shared with agents`;
    if (isProtected(p)) return `${f.path} is protected (tests, CI config, manifests and installed dependencies can't change)`;
  }
  return null;
}

function cleanPath(p) {
  const n = String(p ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
  return !n || n.startsWith("/") || /^[a-z]:/i.test(n) || n.split("/").includes("..") ? null : n;
}

const text = (t) => ({ content: [{ type: "text", text: t }] });
const json = (v) => text(JSON.stringify(v, null, 2));
const error = (message) => ({ content: [{ type: "text", text: message }], isError: true });

// Only this machine: no other hosts, and no web pages (which send an Origin).
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
function isLocal(req) {
  if (process.env.VERCEL) return false;
  const host = (req.headers.host ?? "").replace(/:\d+$/, "");
  const origin = req.headers.origin;
  return LOOPBACK.has(req.socket.remoteAddress) && ["localhost", "127.0.0.1", "[::1]"].includes(host) && !origin;
}

// Shoal's own runners say which app they are (X-Shoal-Client); anything
// else local is just "an AI app on this machine". Only used as a label.
const LOCAL_APPS = new Set(["Claude Code", "Codex"]);
const localApp = (req) => `${LOCAL_APPS.has(req.headers["x-shoal-client"]) ? req.headers["x-shoal-client"] : "AI app"} (this machine)`;

// A signed-in MCP user gets in if their GitHub account can read the repo
// Shoal is connected to. The bundled demo repo is open to any signed-in user.
async function repoAllowed(githubToken) {
  if (state.connection.type === "demo" || !state.connection.fullName) return true;
  return canAccessRepo(state.connection.fullName, githubToken);
}

// Stateless Streamable HTTP: a fresh server and transport per request.
async function handle(req, res, client) {
  const server = buildServer(client);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

// baseUrl: Shoal's public origin, e.g. https://shoal-api.vercel.app. The OAuth
// endpoints (/authorize, /token, /register, /.well-known/...) are mounted at
// its root, as MCP clients expect.
export function mountMcp(app, { baseUrl }) {
  const mcpUrl = new URL("/mcp", baseUrl);
  const remote = oauthConfigured();
  const provider = oauthProvider({ mcpUrl, baseUrl });
  if (remote) {
    app.use(mcpAuthRouter({ provider, issuerUrl: new URL(baseUrl), resourceServerUrl: mcpUrl, resourceName: "Shoal" }));
    app.get(MCP_CALLBACK_PATH, async (req, res) => {
      try {
        res.redirect(await finishMcpSignIn({ code: req.query.code, state: req.query.state, baseUrl }));
      } catch (err) {
        res.status(err.status ?? 500).type("text").send(err.message);
      }
    });
  }
  const bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl), expectedResource: mcpUrl });

  app.post("/mcp", (req, res, next) => {
    if (!req.headers.authorization && isLocal(req)) return handle(req, res, { app: localApp(req), login: null }).catch(next);
    if (!remote) {
      return res.status(403).json({ error: "This Shoal server only accepts MCP connections from this machine. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET to allow sign-in from ChatGPT, Codex and Claude." });
    }
    bearer(req, res, async (err) => {
      if (err) return next(err);
      try {
        const { login, githubToken, clientName } = req.auth.extra;
        if (!(await repoAllowed(githubToken))) {
          return res.status(403).json({ error: `@${login} can't read ${state.connection.fullName} on GitHub, so it can't take part in this team's trials` });
        }
        await handle(req, res, { app: clientName ?? "MCP client", login });
      } catch (e) {
        next(e);
      }
    });
  });
  const notAllowed = (_req, res) => res.status(405).set("Allow", "POST").json({ error: "Method not allowed" });
  // MCP clients only POST here; a person opening the URL gets setup help.
  app.get("/mcp", (req, res) => {
    if (!req.accepts("html")) return notAllowed(req, res);
    const url = mcpUrl.href;
    res.type("html").send(`<!doctype html><meta charset="utf-8"><title>Shoal MCP</title>
<body style="font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;line-height:1.5">
<h1>🐟 Shoal MCP server is running</h1>
<p>This address is for your AI app, not a browser. Connect it with:</p>
${connectHelp(url, remote)
  .map((c) => `<h3>${c.app}</h3><p>${c.steps}</p>${c.command ? `<pre style="background:#f3f3f3;padding:10px;border-radius:6px;overflow-x:auto">${c.command}</pre>` : ""}`)
  .join("")}
<p>Then ask it to run Shoal's trials (prompt <code>run_trials</code>), and watch the results on the <a href="/team">dashboard</a>.</p>
</body>`);
  });
  app.delete("/mcp", notAllowed);
  // For the website: how to connect each app.
  app.get("/api/mcp", (_req, res) => res.json({ url: mcpUrl.href, signIn: remote ? "github" : "local-only", clients: connectHelp(mcpUrl.href, remote) }));
}

function connectHelp(url, remote) {
  const local = [{ app: "Claude Code", command: `claude mcp add --transport http shoal ${url}`, steps: "Run this in a terminal, then type /mcp__shoal__run_trials in Claude Code." }];
  if (!remote) return local;
  return [
    { app: "Claude Code", command: `claude mcp add --transport http shoal ${url}`, steps: "Run this, then /mcp in Claude Code to sign in with GitHub, then /mcp__shoal__run_trials." },
    { app: "Claude", command: url, steps: "Settings → Connectors → Add custom connector, paste this URL, and sign in with GitHub." },
    { app: "Codex", command: `codex mcp add shoal --url ${url}`, steps: "Run this; Codex opens GitHub sign-in (or run codex mcp login shoal). Then ask Codex to run Shoal's trials." },
    {
      app: "ChatGPT",
      command: url,
      steps: "Settings → Apps & Connectors → Advanced → turn on Developer mode, then Create a connector with this URL (authentication: OAuth) and sign in with GitHub. In a chat, add the Shoal connector and ask it to run Shoal's trials.",
    },
  ];
}
