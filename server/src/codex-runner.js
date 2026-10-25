// Codex CLI on this machine, the OpenAI side of the free trial round: detect
// it, sign in with ChatGPT (device code), ask it one-off questions (proof
// judge and challenge tests), and run its part of a trial (trial-runner.js
// runs the whole round). Codex has no per-model subagents, so each model gets
// its own headless `codex exec`, all in parallel, each with only Shoal's MCP
// tools: no shell, no web, no file edits.
//
// Trials run on the team's own ChatGPT login, not Shoal's API key:
// OPENAI_API_KEY and CODEX_API_KEY are removed from Codex's environment so
// the free round stays free.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { emit } from "./events.js";
import { MODELS, tokenCost } from "./trials.js";
import { agentRules, killTree } from "./claude-runner.js";

const CODEX = process.env.CODEX_BIN ?? "codex";
const IS_WIN = process.platform === "win32";

// The OpenAI models a ChatGPT sign-in can use in Codex (OpenAI retired the
// older ones from ChatGPT sign-in). A plan without one of them just fails
// that model's run. Override with SHOAL_CODEX_MODELS=id,id.
export const CODEX_MODELS = (process.env.SHOAL_CODEX_MODELS ?? "gpt-6-luna,gpt-6-sol,gpt-6.1-sol,gpt-6-astra")
  .split(",")
  .map((m) => m.trim())
  .filter((m) => MODELS[m]?.provider === "openai");

const TRIAL_TOOLS = ["list_problems", "list_files", "read_file", "run_tests", "submit_trial", "get_scoreboard"];

// Every Codex run: headless, nothing saved, the team's own config and rules
// ignored, and every built-in tool off, so Shoal's MCP tools are all it has.
// Values are TOML literal strings (single quotes, no spaces), which also
// survive the Windows shell that npm's codex.cmd needs.
const BASE_ARGS = [
  "exec", "--json", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules",
  "--sandbox", "read-only",
  ...["shell_tool", "apps", "plugins", "browser_use", "computer_use", "image_generation", "multi_agent"].flatMap((f) => ["--disable", f]),
  "-c", "web_search='disabled'",
  "-c", "approval_policy='never'",
];

const childEnv = () => {
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  return env;
};

function codex(args, { input, onLine, timeout } = {}) {
  const child = spawn(CODEX, args, { shell: IS_WIN, windowsHide: true, env: childEnv(), cwd: tmpdir() });
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

// --- Detect -----------------------------------------------------------------

let detected = null;
let detectedAt = 0;

export async function detectCodex({ fresh = false } = {}) {
  if (!fresh && detected && Date.now() - detectedAt < 30_000) return detected;
  const version = await codex(["--version"], { timeout: 20_000 }).done;
  if (!version.ok) {
    detected = { installed: false };
  } else {
    // Exit 0 when signed in, e.g. "Logged in using ChatGPT".
    const status = await codex(["login", "status"], { timeout: 20_000 }).done;
    const how = status.out.match(/logged in using (.+)/i)?.[1]?.trim() ?? null;
    detected = {
      installed: true,
      version: version.out.trim().split(/\s+/).pop(),
      loggedIn: status.ok,
      plan: how,
      // Signed in with an API key, trials bill that key instead of a ChatGPT plan.
      usesApiKey: /api key/i.test(how ?? ""),
      models: CODEX_MODELS.map((id) => ({ id, name: MODELS[id].name })),
    };
  }
  detectedAt = Date.now();
  return detected;
}

// --- Sign in ------------------------------------------------------------------

let login = null;

// Device-code sign-in: Codex prints a link and a one-time code; the person
// opens the link, enters the code, and Codex finishes on its own.
export async function startCodexLogin() {
  if (login?.child.exitCode === null && login.code) return { url: login.url, code: login.code };
  const run = codex(["login", "--device-auth"], { timeout: 15 * 60_000 });
  login = { child: run.child, url: null, code: null };
  run.done.then(({ ok }) => {
    detected = null;
    emit("codex.login", { message: ok ? "Codex sign-in finished" : "Codex sign-in didn't finish" });
  });
  return new Promise((resolve) => {
    let text = "";
    const onData = (d) => {
      // Strip terminal colors before matching.
      text += String(d).replace(/\x1b\[[0-9;]*m/g, "");
      login.url ??= text.match(/https:\/\/\S+/)?.[0] ?? null;
      login.code ??= text.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\b/)?.[0] ?? null;
      if (login.url && login.code) resolve({ url: login.url, code: login.code });
    };
    run.child.stdout.on("data", onData);
    run.child.stderr.on("data", onData);
    setTimeout(() => resolve({ url: login.url, code: login.code }), 15_000);
  });
}

// --- One-off question -------------------------------------------------------

// Asks Codex one question on the team's plan, with every tool off. Used for
// the proof report's OpenAI judge and as a fallback challenge-test writer.
// Returns null if Codex isn't installed or signed in, or the call fails.
export async function askCodex(prompt, { model = "gpt-6-astra", timeout = 8 * 60_000 } = {}) {
  const info = await detectCodex();
  if (!info.installed || !info.loggedIn) return null;
  const dir = await mkdtemp(path.join(tmpdir(), "shoal-codex-"));
  const outFile = path.join(dir, "answer.txt");
  try {
    const { ok } = await codex([...BASE_ARGS, "-m", model, "-c", "model_reasoning_effort='high'", "-o", outFile, "-"], { input: prompt, timeout }).done;
    const text = await readFile(outFile, "utf8").catch(() => "");
    return ok && text.trim() ? { text } : null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// --- Trial run ------------------------------------------------------------------

// Starts Codex's part of a trial run: one `codex exec` per model. Notes,
// token spend (what the same tokens would cost on the API) and summaries go
// into `run`; done resolves with { ok, error } when every model has finished.
export async function startCodexTrial({ problems, baseUrl, run, note, timeout }) {
  note(`Codex started: ${CODEX_MODELS.map((id) => MODELS[id].name).join(", ")} will each try ${problems.length} flaky test${problems.length > 1 ? "s" : ""}`);
  const mcp = [
    `mcp_servers.shoal.url='${baseUrl}/mcp'`,
    "mcp_servers.shoal.required=true",
    "mcp_servers.shoal.default_tools_approval_mode='approve'",
    // run_tests and submit_trial run the test many times.
    "mcp_servers.shoal.tool_timeout_sec=900",
    "mcp_servers.shoal.startup_timeout_sec=30",
    `mcp_servers.shoal.enabled_tools=[${TRIAL_TOOLS.map((t) => `'${t}'`).join(",")}]`,
    "mcp_servers.shoal.http_headers={X-Shoal-Client='Codex'}",
  ].flatMap((c) => ["-c", c]);

  const procs = CODEX_MODELS.map((model) => {
    const proc = codex([...BASE_ARGS, ...mcp, "-m", model, "-c", "model_reasoning_effort='high'", "-"], {
      input: codexPrompt(model, problems),
      timeout,
      onLine: (line) => onEvent(line, model, run, note),
    });
    return {
      child: proc.child,
      done: proc.done.then(({ ok, out }) => {
        const error = friendly(run.errors[model] ?? (ok ? null : lastError(out) ?? "Codex exited with an error"));
        if (error) note(`${MODELS[model].name} (Codex) stopped: ${error}`);
        return { model, ok: ok && !run.errors[model], error };
      }),
    };
  });
  return {
    children: procs.map((p) => p.child),
    done: Promise.all(procs.map((p) => p.done)).then((results) => {
      const failed = results.filter((r) => !r.ok);
      return {
        ok: failed.length < results.length,
        error: failed.length ? failed.map((r) => `${MODELS[r.model].name}: ${r.error}`).join("; ").slice(0, 600) : null,
      };
    }),
  };
}

// Codex's --json events: note each fix submitted, add up token usage per
// model, keep the final message as that model's summary.
function onEvent(line, model, run, note) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  const item = event.item;
  if (event.type === "item.started" && item?.type === "mcp_tool_call" && item.tool === "submit_trial") {
    note(`${MODELS[model].name} (Codex) submitted a fix`);
  }
  if (event.type === "item.completed" && item?.type === "agent_message" && item.text) {
    run.summaries[model] = String(item.text).slice(0, 1000);
  }
  // Like the API, cached tokens are part of input_tokens and reasoning is
  // part of output_tokens; tokenCost wants cached input apart.
  if (event.type === "turn.completed" && event.usage) {
    const cached = event.usage.cached_input_tokens ?? 0;
    const usage = { input_tokens: (event.usage.input_tokens ?? 0) - cached, cache_read_input_tokens: cached, output_tokens: event.usage.output_tokens ?? 0 };
    run.spentByModel[model] = (run.spentByModel[model] ?? 0) + tokenCost(model, usage);
  }
  if (event.type === "turn.failed") run.errors[model] = String(event.error?.message ?? "turn failed").slice(0, 300);
}

// The last readable error line from Codex's output.
function lastError(out) {
  const lines = out.trim().split("\n").filter((l) => l.trim());
  for (const l of lines.reverse()) {
    try {
      const e = JSON.parse(l);
      if (e.type === "error" || e.type === "turn.failed") return String(e.message ?? e.error?.message).slice(0, 300);
    } catch {
      if (/error/i.test(l)) return l.replace(/^\S+Z\s+ERROR\s+\S+:\s*/, "").slice(0, 300);
    }
  }
  return null;
}

// Common failures in words the team can act on.
function friendly(error) {
  if (!error) return null;
  if (/401|unauthorized/i.test(error)) return "Codex isn't signed in to ChatGPT. Sign in with ChatGPT and run again.";
  if (/model.*(not (found|supported|available))|does not exist|access to model/i.test(error)) return `this model isn't available on your ChatGPT plan (${error.slice(0, 120)})`;
  if (/usage limit|rate limit|429/i.test(error)) return "your ChatGPT plan's usage limit was reached; try again later";
  return error;
}

function codexPrompt(model, problems) {
  return [
    `You are a Shoal trial agent running on ${MODELS[model].name} (model id "${model}"). Try to fix each of these flaky tests, one at a time:`,
    ...problems.map((p) => `- problem id ${p.id}: ${p.testFile} (failed ${p.failures}/${p.runs} runs; imports ${p.sourceFiles.join(", ") || "nothing local"})`),
    "",
    ...agentRules(model),
    "Then go on to the next problem.",
    "When you've tried them all, reply with one line per test: passed or failed, and what you changed.",
  ].join("\n");
}
