// Claude Code on this machine: detect it, sign in, ask it one-off questions,
// and run its part of a trial (trial-runner.js runs the whole round): one
// headless Claude Code with only Shoal's MCP tools, where one subagent per
// model (Haiku, Sonnet, Opus) tries every flaky test.
//
// Trials run on the team's own Claude login, not Shoal's API key: the key is
// removed from Claude Code's environment so the free round stays free.
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { emit } from "./events.js";
import { MODELS, tokenCost } from "./trials.js";

const CLAUDE = process.env.CLAUDE_BIN ?? "claude";
const IS_WIN = process.platform === "win32";

// Subagent alias -> the model id its trials are tagged with.
const TRIAL_MODELS = [
  { alias: "haiku", id: "claude-haiku-5-5" },
  { alias: "sonnet", id: "claude-sonnet-5-5" },
  { alias: "opus", id: "claude-opus-5-5" },
];
const SHOAL_TOOLS = ["list_problems", "list_files", "read_file", "run_tests", "submit_trial", "get_scoreboard"].map((t) => `mcp__shoal__${t}`);

const childEnv = () => {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  return env;
};

// Runs claude with simple arguments (no spaces or quotes, so it's safe
// through the Windows shell that npm's claude.cmd needs).
function claude(args, { input, onLine, timeout } = {}) {
  const child = spawn(CLAUDE, args, { shell: IS_WIN, windowsHide: true, env: childEnv(), cwd: tmpdir() });
  let out = "";
  let buffered = "";
  const timer = timeout && setTimeout(() => killTree(child), timeout);
  child.stdout.on("data", (d) => {
    out += d;
    if (!onLine) return;
    buffered += d;
    const lines = buffered.split("\n");
    buffered = lines.pop();
    lines.forEach((l) => l.trim() && onLine(l));
  });
  child.stderr.on("data", (d) => (out += d));
  if (input !== undefined) child.stdin.end(input);
  const done = new Promise((resolve) => {
    child.on("error", () => resolve({ ok: false, out }));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, out });
    });
  });
  return { child, done };
}

export function killTree(child) {
  if (child.exitCode !== null) return;
  if (IS_WIN) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  else child.kill("SIGTERM");
}

// --- Detect -----------------------------------------------------------------

let detected = null;
let detectedAt = 0;

export async function detectClaude({ fresh = false } = {}) {
  if (!fresh && detected && Date.now() - detectedAt < 30_000) return detected;
  const version = await claude(["--version"], { timeout: 20_000 }).done;
  if (!version.ok) {
    detected = { installed: false };
  } else {
    const status = await claude(["auth", "status"], { timeout: 20_000 }).done;
    let auth = {};
    try {
      auth = JSON.parse(status.out.slice(status.out.indexOf("{")));
    } catch {}
    detected = {
      installed: true,
      version: version.out.trim().split("\n").pop().split(" ")[0],
      loggedIn: Boolean(auth.loggedIn),
      email: auth.email ?? null,
      plan: auth.subscriptionType ?? auth.authMethod ?? null,
    };
  }
  detectedAt = Date.now();
  return detected;
}

// --- Sign in ------------------------------------------------------------------

let login = null;

// Starts `claude auth login`, which opens the browser sign-in page. Resolves
// with the sign-in URL too, in case the browser didn't open by itself.
export async function startLogin() {
  if (login?.child.exitCode === null) return { url: login.url };
  const run = claude(["auth", "login"], { timeout: 10 * 60_000 });
  login = { child: run.child, url: null };
  run.done.then(() => {
    detected = null;
    emit("claude.login", { message: "Claude Code sign-in finished" });
  });
  const url = await new Promise((resolve) => {
    const onData = (d) => {
      const m = String(d).match(/https:\/\/\S+/);
      if (m && !login.url) {
        login.url = m[0];
        resolve(m[0]);
      }
    };
    run.child.stdout.on("data", onData);
    run.child.stderr.on("data", onData);
    setTimeout(() => resolve(login.url), 15_000);
  });
  return { url };
}

// Without a terminal, Claude's sign-in page shows a code to paste back into
// Claude Code. The dashboard sends it here and we pass it to `claude auth login`.
export async function finishLogin(code) {
  if (!login || login.child.exitCode !== null) throw httpError(400, "Click Sign in to Claude first");
  const clean = String(code ?? "").trim();
  if (!clean || clean.length > 500 || /\s/.test(clean)) throw httpError(400, "That doesn't look like a sign-in code");
  login.child.stdin.write(clean + "\n");
  const exited = await new Promise((resolve) => {
    login.child.once("close", (exitCode) => resolve(exitCode));
    setTimeout(() => resolve(null), 20_000);
  });
  detected = null;
  const info = await detectClaude({ fresh: true });
  if (!info.loggedIn) throw httpError(400, exited === null ? "Claude Code didn't accept the code yet. Try again." : "Sign-in failed. Start again and paste the newest code.");
  return info;
}

// --- One-off question -------------------------------------------------------

// Asks Claude Code one question on the team's plan, with every tool off.
// Used for the proof report's second opinion. Returns null if Claude Code
// isn't installed or signed in, or the call fails.
export async function askClaude(prompt, { model = "sonnet", timeout = 4 * 60_000 } = {}) {
  const info = await detectClaude();
  if (!info.installed || !info.loggedIn) return null;
  const { out } = await claude(
    [
      "-p", "--output-format", "json", "--model", model,
      "--strict-mcp-config", "--permission-mode", "dontAsk", "--no-session-persistence",
      "--disallowedTools", "Bash", "Edit", "Write", "Read", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "Agent", "NotebookEdit",
    ],
    { input: prompt, timeout },
  ).done;
  const line = out.split("\n").reverse().find((l) => l.trim().startsWith("{"));
  try {
    const res = JSON.parse(line);
    return res.is_error ? null : { text: String(res.result ?? ""), cost: res.total_cost_usd ?? null };
  } catch {
    return null;
  }
}

// --- Trial run ------------------------------------------------------------------

// Starts Claude Code's part of a trial run. Its notes, token spend and
// summary go into `run`; done resolves with { ok, error } when it exits.
export async function startClaudeTrial({ problems, baseUrl, dir, run, note, timeout }) {
  const mcpFile = path.join(dir, "claude-mcp.json");
  const agentsFile = path.join(dir, "claude-agents.json");
  await writeFile(mcpFile, JSON.stringify({ mcpServers: { shoal: { type: "http", url: `${baseUrl}/mcp`, headers: { "X-Shoal-Client": "Claude Code" } } } }));
  await writeFile(agentsFile, JSON.stringify(Object.fromEntries(TRIAL_MODELS.map((m) => [`trial-${m.alias}`, subagent(m)]))));
  note(`Claude Code started: ${TRIAL_MODELS.map((m) => MODELS[m.id].name).join(", ")} will each try ${problems.length} flaky test${problems.length > 1 ? "s" : ""}`);

  const tracking = { taskModel: new Map(), seen: new Set() };
  const proc = claude(
    [
      "-p",
      "--output-format", "stream-json", "--verbose",
      "--mcp-config", mcpFile, "--strict-mcp-config",
      "--agents", agentsFile,
      // The subagent tool is "Task" (older name "Agent"); allow both.
      "--tools", "Task",
      "--allowedTools", "Task", "Agent", "mcp__shoal",
      "--permission-mode", "dontAsk",
      "--no-session-persistence",
    ],
    { input: leadPrompt(problems), timeout, onLine: (line) => onStreamLine(line, run, note, tracking) },
  );
  return {
    children: [proc.child],
    done: proc.done.then(({ ok, out }) => ({
      ok,
      error: ok ? null : run.errors.claude ?? (out.trim().split("\n").filter((l) => !l.startsWith("{")).slice(-3).join(" ").slice(0, 300) || "Claude Code exited with an error"),
    })),
  };
}

// Claude Code's stream-json output: note subagent launches, add up what each
// model's subagents spend (messages carry parent_tool_use_id = the Task call
// that started them), and keep the final result.
function onStreamLine(line, run, note, tracking) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === "assistant" && !msg.parent_tool_use_id) {
    for (const block of msg.message?.content ?? []) {
      if (block.type === "tool_use" && ["Task", "Agent"].includes(block.name)) {
        const model = TRIAL_MODELS.find((m) => block.input?.subagent_type === `trial-${m.alias}`);
        if (model) tracking.taskModel.set(block.id, model.id);
        note(`${model ? MODELS[model.id].name : "A subagent"} started: ${block.input?.description ?? "trial"}`);
      }
    }
  }
  // One API message can arrive as several lines (one per content block) with
  // the same id and usage, so count each message once.
  const model = msg.parent_tool_use_id && tracking.taskModel.get(msg.parent_tool_use_id);
  const id = msg.message?.id;
  if (msg.type === "assistant" && model && msg.message?.usage && !tracking.seen.has(id)) {
    tracking.seen.add(id);
    run.spentByModel[model] = (run.spentByModel[model] ?? 0) + tokenCost(model, msg.message.usage);
  }
  if (msg.type === "result") {
    run.summaries.claude = msg.result ?? null;
    run.claudeCost = msg.total_cost_usd ?? null;
    if (msg.is_error) run.errors.claude = String(msg.result ?? msg.subtype).slice(0, 300);
  }
}

function subagent({ alias, id }) {
  return {
    description: `Shoal trial agent on ${MODELS[id].name}: tries to fix one flaky test and submits the fix to Shoal.`,
    model: alias,
    tools: SHOAL_TOOLS,
    prompt: [`You are a Shoal trial agent running on ${MODELS[id].name}. You get one flaky test to fix.`, ...agentRules(id), "Reply with one line: passed or failed, and what you changed."].join("\n"),
  };
}

// How a trial agent works, for Claude subagents and Codex alike.
export function agentRules(id) {
  return [
    "Use only the Shoal tools: list_files and read_file to read the code, run_tests to check a candidate patch.",
    "Read ALL the shared code first (list_files, then read_file on every file), not just the files the test imports.",
    "Fix every root cause in application code. Working around a bug instead of fixing it, or leaving a related bug the test happens not to reach, counts as a FAILED fix: Shoal runs hidden challenge tests on the whole codebase.",
    "Test files, test folders, CI config and package manifests are protected; changing them fails the trial.",
    `When run_tests passes, call submit_trial with model "${id}", the problem id, a one-sentence summary and the complete new contents of every file you changed.`,
    "If the trial fails, read the failure log, fix the patch and submit once more. Then stop.",
  ];
}

function leadPrompt(problems) {
  return [
    "You are running a Shoal model trial. Don't fix anything yourself.",
    "Problems to try:",
    ...problems.map((p) => `- id ${p.id}: ${p.testFile} (failed ${p.failures}/${p.runs} runs; imports ${p.sourceFiles.join(", ") || "nothing local"})`),
    "",
    `For every problem, launch the three subagents ${TRIAL_MODELS.map((m) => `trial-${m.alias}`).join(", ")}, all in parallel (one subagent call each, in the same message).`,
    "Tell each one the problem id and test file. They read the code and submit their fixes through Shoal themselves.",
    "When every subagent has finished, call mcp__shoal__get_scoreboard and write a short report for the team:",
    "which model did best overall and on each test, and why (passed or failed, lines changed). Five sentences at most, no markdown headings.",
  ].join("\n");
}

// "src/easy.js, lib/x.js" -> "src/, lib/"
function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
