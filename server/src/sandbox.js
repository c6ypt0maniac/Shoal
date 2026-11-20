// Runs an uploaded agent (a code bundle or a container image, uploads.js) on
// one bounty, locked down:
//   docker   (SHOAL_SANDBOX=docker) a throwaway container with no network,
//            a read-only filesystem, no capabilities, an unprivileged user,
//            and CPU, memory, process and time limits.
//   process  (SHOAL_SANDBOX=process) a plain child process with an empty
//            environment. Development and check scripts only: refused when
//            NODE_ENV=production, since it isn't isolated.
// Without either, uploaded agents are listed but can't compete.
//
// The agent talks to Shoal over stdin/stdout, one JSON object per line:
//   Shoal -> agent  {"type":"task","task":{bounty, files, rules, models, budget}}
//   agent -> Shoal  {"type":"model","id":1,"model":"claude-sonnet-5-5","system":"...","prompt":"..."}
//   Shoal -> agent  {"type":"model_result","id":1,"text":"..."}  (or "error")
//   agent -> Shoal  {"type":"fix","summary":"...","files":[{"path","content"}]}
// Model calls run on the team's API keys (user-keys.js) and only their text
// comes back, so no key, token or network access ever enters the sandbox.
// budget: the agent's bid in dollars (bids.js). A call that could take its
// spend past it (its prompt plus the most it may write) is refused, not made.
// Anything else on stdout is ignored; stderr is dropped.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LANGUAGES, bundleFiles } from "./uploads.js";
import { estimate } from "./spend.js";

const TIMEOUT_MS = Number(process.env.SHOAL_AGENT_TIMEOUT_MS) || 10 * 60_000;
const MAX_MODEL_CALLS = 20;
const MAX_PROMPT_CHARS = 400_000;
const MAX_STDOUT = 8 * 1024 * 1024;
// The most one answer may write (askModel), for the budget check.
const MODEL_OUTPUT = 16_000;

export const sandboxMode = () => process.env.SHOAL_SANDBOX ?? null;

// Why uploaded agents of this kind can't run here, or null.
export function sandboxProblem(runtime) {
  const mode = sandboxMode();
  if (mode === "docker") return null;
  if (mode === "process") {
    if (process.env.NODE_ENV === "production") return "this server's sandbox (SHOAL_SANDBOX=process) isn't isolated, so it's off in production; use SHOAL_SANDBOX=docker";
    return runtime === "image" ? "container images need SHOAL_SANDBOX=docker" : null;
  }
  return "this server has no sandbox for uploaded agents yet (SHOAL_SANDBOX=docker)";
}

// listing: a builder listing with runtime "bundle" or "image". task: what
// webhooks get (competitors.js). ask(model, system, prompt) -> { text, cost }.
// -> { fix (unchecked JSON), cost }. budget: the most it may spend, in $.
export async function runSandboxed(listing, task, ask, { budget = Infinity } = {}) {
  const why = sandboxProblem(listing.runtime);
  if (why) throw new Error(`${listing.name} can't run: ${why}`);
  const dir = await mkdtemp(path.join(tmpdir(), "shoal-agent-"));
  try {
    let cmd, args;
    if (listing.runtime === "bundle") {
      for (const f of await bundleFiles(listing.bundle.sha)) {
        await mkdir(path.join(dir, path.dirname(f.path)), { recursive: true });
        await writeFile(path.join(dir, f.path), f.data);
      }
      const lang = LANGUAGES[listing.bundle.language];
      [cmd, args] = sandboxMode() === "docker"
        ? ["docker", [...dockerArgs(), "-v", `${dir}:/agent:ro`, "-w", "/agent", lang.image, ...lang.run, `/agent/${listing.bundle.entry}`]]
        : [lang.run[0], [...lang.run.slice(1), path.join(dir, listing.bundle.entry)]];
    } else {
      [cmd, args] = ["docker", [...dockerArgs(), "--pull", "missing", listing.image.image]];
    }
    return await converse(listing, cmd, args, dir, task, ask, budget);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const dockerArgs = () => [
  "run", "--rm", "-i",
  "--network", "none",
  "--read-only", "--tmpfs", "/tmp:rw,size=64m",
  "--memory", "1g", "--memory-swap", "1g", "--cpus", "1", "--pids-limit", "256",
  "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
  "--user", "65534:65534",
  "-e", "HOME=/tmp",
];

function converse(listing, cmd, args, dir, task, ask, budget) {
  return new Promise((resolve, reject) => {
    // An empty environment: nothing of the server's (keys, database URL) leaks in.
    const child = spawn(cmd, args, { cwd: dir, env: { PATH: process.env.PATH, HOME: dir }, stdio: ["pipe", "pipe", "ignore"] });
    let cost = 0, calls = 0, seen = 0, buf = "", done = false;
    const finish = (err, fix) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      err ? reject(Object.assign(err, { cost })) : resolve({ fix, cost });
    };
    const timer = setTimeout(() => finish(new Error(`${listing.name} ran out of time (${Math.round(TIMEOUT_MS / 60_000)} min)`)), TIMEOUT_MS);
    const send = (msg) => child.stdin.writable && child.stdin.write(JSON.stringify(msg) + "\n");
    child.stdin.on("error", () => {});
    child.on("error", (err) => finish(new Error(`${listing.name} couldn't start: ${err.message}`)));
    child.on("exit", (code) => finish(new Error(`${listing.name} exited${code == null ? "" : ` with code ${code}`} without returning a fix`)));
    child.stdout.on("data", async (chunk) => {
      seen += chunk.length;
      if (seen > MAX_STDOUT) return finish(new Error(`${listing.name} wrote more than 8 MB`));
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg?.type === "fix") return finish(null, { summary: msg.summary, files: msg.files });
        if (msg?.type !== "model") continue;
        if (++calls > MAX_MODEL_CALLS) return finish(new Error(`${listing.name} asked for more than ${MAX_MODEL_CALLS} model answers`));
        const prompt = String(msg.prompt ?? ""), system = String(msg.system ?? "");
        if (prompt.length + system.length > MAX_PROMPT_CHARS) {
          send({ type: "model_result", id: msg.id, error: `Prompts are at most ${MAX_PROMPT_CHARS} characters` });
          continue;
        }
        const could = estimate(String(msg.model ?? ""), system + prompt, MODEL_OUTPUT);
        if (cost + could > budget) {
          send({ type: "model_result", id: msg.id, error: `Over your bid: this call could cost $${could.toFixed(2)} and $${Math.max(0, budget - cost).toFixed(2)} of your $${budget.toFixed(2)} bid is left` });
          continue;
        }
        try {
          const r = await ask(String(msg.model ?? ""), system, prompt);
          cost += r.cost ?? 0;
          send({ type: "model_result", id: msg.id, text: r.text });
        } catch (err) {
          cost += err.cost ?? 0;
          send({ type: "model_result", id: msg.id, error: String(err.message ?? err).slice(0, 300) });
        }
      }
    });
    send({ type: "task", task });
  });
}
