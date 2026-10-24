// MCP server: how the team's own Claude (Claude Code, Claude Desktop) takes
// part in the trial round. It can see the problems Shoal found, read the
// files the team shared, run tests on a candidate patch in a sandbox, and
// submit trial fixes tagged with the model that wrote them. It can't change
// the repo, open PRs or move money: that only happens in the paid API run
// after the team approves a model.
//
// Connect: claude mcp add --transport http shoal http://localhost:4000/mcp
// Local only: requests from other machines or web pages are refused.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createSandbox, destroySandbox, listAllFiles, readRepoFile, runTestMany, WORKSPACE, writeFiles } from "./repo.js";
import { inScope, isSecret } from "./scope.js";
import { isProtected } from "./verifier.js";
import { state } from "./store.js";
import { MODELS, MODEL_IDS, scoreboard, submitTrial } from "./trials.js";

const FileSchema = z.object({
  path: z.string().describe("Path relative to the repo root, e.g. src/cart.js"),
  content: z.string().describe("The complete new contents of the file"),
});

function buildServer() {
  const server = new McpServer({ name: "shoal", version: "1.0.0" });

  server.registerTool(
    "list_problems",
    {
      title: "List problems",
      description:
        "The flaky tests Shoal found in the connected repo, with ids, failure rates, the source files each test imports, and a sample failure log. Start here.",
      inputSchema: {},
    },
    async () => {
      const flaky = state.pains.filter((p) => !p.healthy);
      return json({
        repo: state.connection.fullName,
        models: MODEL_IDS,
        problems: flaky.map((p) => ({
          id: p.id,
          testFile: p.testFile,
          failures: `${p.failures}/${p.runs} runs`,
          sourceFiles: p.sourceFiles,
          sampleFailure: p.sampleFailure?.slice(-1200) ?? null,
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
        test_file: z.string().describe("Test file to run, e.g. test/cart.test.js"),
        files: z.array(FileSchema).optional().describe("Candidate patch: files to replace before running"),
        times: z.number().int().min(1).max(10).optional().describe("How many runs (default 5)"),
      },
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
        "Submit a fix for one problem, tagged with the model that wrote it. Shoal verifies it (10 green runs, no test edits, no regressions) and scores it, but doesn't apply it. Returns pass or fail with the failure log so you can retry.",
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
        const t = await submitTrial({ painId: problem_id, model, summary, files: files.map((f) => ({ ...f, path: cleanPath(f.path) })) });
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
    },
    async () => json(scoreboard()),
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

  return server;
}

const TRIAL_INSTRUCTIONS = `Run a Shoal model trial on the connected repo.

1. Call the shoal list_problems tool.
2. For each problem, start one subagent per model: Haiku, Sonnet and Opus (set each subagent's model). Run them in parallel.
   Tell each subagent:
   - the problem id, test file, sample failure and source files
   - to read code only through the shoal read_file and list_files tools
   - to find the real cause and fix it in application code. Test files, CI config and manifests are protected and can't change.
   - to check its patch with shoal run_tests before submitting
   - to call shoal submit_trial with model set to its own model id (${Object.entries(MODELS).slice(0, 3).map(([id, m]) => `${m.name} = ${id}`).join(", ")}), and to retry once using the failure log if the trial fails
3. When all subagents finish, call get_scoreboard and report which model did best on each problem.
The team then approves a model on the Shoal dashboard, and Shoal runs it through the API for the real fix.`;

// Rejects patches that can't pass anyway, before spending a sandbox on them.
function patchProblem(files) {
  for (const f of files) {
    const p = cleanPath(f.path);
    if (!p) return `Invalid path: ${f.path}`;
    if (isSecret(p) || !inScope(p)) return `${f.path} isn't shared with agents`;
    if (isProtected(p)) return `${f.path} is protected (tests, CI config and manifests can't change)`;
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
  const host = (req.headers.host ?? "").replace(/:\d+$/, "");
  const origin = req.headers.origin;
  return LOOPBACK.has(req.socket.remoteAddress) && ["localhost", "127.0.0.1", "[::1]"].includes(host) && !origin;
}

// Stateless Streamable HTTP: a fresh server and transport per request.
export function mountMcp(app) {
  app.post("/mcp", async (req, res) => {
    if (!isLocal(req)) return res.status(403).json({ error: "Shoal's MCP server only accepts connections from this machine" });
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  const notAllowed = (_req, res) => res.status(405).set("Allow", "POST").json({ error: "Method not allowed" });
  // MCP clients only POST here; a person opening the URL gets setup help.
  app.get("/mcp", (req, res) => {
    if (!req.accepts("html")) return notAllowed(req, res);
    const url = `${req.protocol}://${req.get("host")}/mcp`;
    res.type("html").send(`<!doctype html><meta charset="utf-8"><title>Shoal MCP</title>
<body style="font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;line-height:1.5">
<h1>🐟 Shoal MCP server is running</h1>
<p>This address is for Claude Code, not a browser. Connect it from a terminal:</p>
<pre style="background:#f3f3f3;padding:10px;border-radius:6px;overflow-x:auto">claude mcp add --transport http shoal ${url}</pre>
<p>Then in Claude Code run <code>/mcp__shoal__run_trials</code>, and watch the results on the <a href="/team">dashboard</a>.</p>
</body>`);
  });
  app.delete("/mcp", notAllowed);
}
