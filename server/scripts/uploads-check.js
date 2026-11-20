// Checks uploaded agents (uploads.js, sandbox.js) end to end on the demo repo:
//   bundles with secrets, escaping paths or no entry file are refused; images
//   need a pinned digest -> a prompt agent's instructions stay its builder's ->
//   a Node bundle competes on a real bounty: it gets the task over stdin, asks
//   a model through Shoal, sees none of the server's environment, and its fix
//   is verified -> the process sandbox is refused in production -> API keys a
//   request brings are never saved.
//   node scripts/uploads-check.js
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.PORT = "4140";
process.env.SHOAL_MOCK = "1";
process.env.SHOAL_MOCK_JUDGES = "1";
process.env.SHOAL_TEST_USERS = "1";
process.env.SHOAL_SANDBOX = "process"; // development sandbox; production uses docker
process.env.SHOAL_AUTH_SECRET ??= "uploads-check-secret-0123456789abcdef";
process.env.SHOAL_DATA_DIR = await mkdtemp(path.join(tmpdir(), "shoal-uploads-"));
process.env.SHOAL_WORKSPACE = ".workspace-uploadscheck";
process.env.SHOAL_SURVIVAL_MINUTES = "0.02";
process.env.SHOAL_CANARY = "server-only-value"; // must never reach an agent
delete process.env.SUPABASE_DB_URL;
delete process.env.STRIPE_SECRET_KEY;

await import("../src/index.js");
const { zip } = await import("../src/zip.js");
const { sandboxProblem } = await import("../src/sandbox.js");
const { saveState } = await import("../src/persist.js");
const { runSandboxed } = await import("../src/sandbox.js");
const { state } = await import("../src/store.js");
const BASE = "http://localhost:4140";
const BUILDER = "builder-bo", TEAM = "team-tia";
let ok = true;
const check = (label, pass, detail = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? `: ${detail}` : ""}`);
  ok &&= pass;
};
const call = async (method, p, body, user, headers = {}) => {
  const res = await fetch(BASE + p, { method, headers: { "content-type": "application/json", ...(user && { "x-shoal-test-user": user }), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const b64 = (files) => zip(files).toString("base64");
const base = { tagline: "Uploaded", pains: ["flaky-tests"], languages: ["javascript"] };
const publish = (body) => call("POST", "/api/marketplace/agents", { ...base, ...body }, BUILDER);

// The agent: reads the task, asks a model once, fixes the missing `return`
// in src/cart.js, and reports which environment variables it could see.
const AGENT = `
const rl = require("readline").createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
let task;
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type === "task") { task = msg.task; send({ type: "model", id: 1, model: task.models[0], prompt: "Where is the bug?" }); }
  if (msg.type === "model_result") {
    const cart = task.files.find((f) => f.path === "src/cart.js");
    const content = cart.content.replace("    lookupDiscount(code).then(", "    return lookupDiscount(code).then(");
    // macOS adds __CF_USER_TEXT_ENCODING to every process; it isn't the server's.
    const env = Object.keys(process.env).filter((k) => !k.startsWith("__CF_")).sort().join(",");
    send({ type: "fix", summary: "env=" + env + " leak=" + Object.values(process.env).includes("server-only-value") + " model=" + String(msg.text ?? msg.error).slice(0, 13), files: [{ path: "src/cart.js", content }] });
    process.exit(0);
  }
});`;

try {
  console.log("1. What uploads are refused");
  let r = await publish({ name: "Leaky", runtime: "bundle", bundle: { language: "node", entry: "index.js", zip: b64([{ path: "index.js", data: AGENT }, { path: ".env", data: "OPENAI_API_KEY=x" }]) } });
  check("a bundle with a .env file", r.status === 400 && /\.env/.test(r.json.error), r.json.error);
  r = await publish({ name: "Leaky2", runtime: "bundle", bundle: { language: "node", entry: "index.js", zip: b64([{ path: "index.js", data: AGENT + "\nconst k = 'sk-ant-api03-abcdefghijklmnopqrstuv';" }]) } });
  check("a bundle with an API key in its code", r.status === 400 && /Anthropic API key/.test(r.json.error), r.json.error);
  r = await publish({ name: "Escape", runtime: "bundle", bundle: { language: "node", entry: "index.js", zip: b64([{ path: "../index.js", data: AGENT }]) } });
  check("a bundle with a path outside its folder", r.status === 400, r.json.error);
  r = await publish({ name: "NoEntry", runtime: "bundle", bundle: { language: "node", entry: "main.js", zip: b64([{ path: "index.js", data: AGENT }]) } });
  check("a bundle without its entry file", r.status === 400, r.json.error);
  r = await publish({ name: "Tagged", runtime: "image", image: "ghcr.io/bo/agent:latest" });
  check("an image by tag, not digest", r.status === 400, r.json.error);
  r = await publish({ name: "Pinned", runtime: "image", image: `ghcr.io/bo/agent@sha256:${"a".repeat(64)}` });
  check("an image pinned by digest is accepted, and can't run without docker", r.status === 201 && r.json.available === false && /docker/.test(r.json.unavailableReason), r.json.unavailableReason);
  check("only webhook agents get a signing secret", !("signingSecret" in r.json));

  console.log("2. Prompt agents");
  r = await publish({ name: "Careful Prompt", runtime: "prompt", prompt: { model: "claude-sonnet-5-5", instructions: "Fix the root cause. Keep the patch minimal." } });
  check("published", r.status === 201 && r.json.runtime === "prompt" && r.json.model === "claude-sonnet-5-5", r.json.error);
  const promptId = r.json.id;
  const theirs = (await call("GET", `/api/marketplace/listing?id=${encodeURIComponent(promptId)}`, null, TEAM)).json;
  const mine = (await call("GET", `/api/marketplace/listing?id=${encodeURIComponent(promptId)}`, null, BUILDER)).json;
  check("others see the model, not the instructions", !("prompt" in theirs) && theirs.model === "claude-sonnet-5-5");
  check("the builder sees the instructions", mine.prompt?.instructions?.startsWith("Fix the root cause"));

  console.log("3. A code bundle competes");
  r = await publish({ name: "Bundle Bot", runtime: "bundle", bundle: { language: "node", entry: "index.js", zip: b64([{ path: "index.js", data: AGENT }]) } });
  check("published", r.status === 201 && r.json.runtime === "bundle" && r.json.available, r.json.error ?? r.json.unavailableReason);
  const bundleId = r.json.id;
  await call("POST", "/api/scan", {}, TEAM);
  const cart = (await call("GET", "/api/pains", null, TEAM)).json.find((p) => p.testFile === "test/cart.test.js");
  const bounty = (await call("POST", "/api/bounties", { painId: cart.id, reward: 200, competitors: [bundleId] }, TEAM)).json;
  await call("POST", `/api/bounties/${bounty.id}/run`, {}, TEAM);
  let b;
  for (let i = 0; i < 180; i++) {
    b = (await call("GET", `/api/bounties/${bounty.id}`, null, TEAM)).json;
    if (["surviving", "failed", "settled"].includes(b.status)) break;
    await new Promise((res) => setTimeout(res, 1000));
  }
  const summary = b.winningAttempt?.summary ?? "";
  check("its fix was verified and won", b.winner === bundleId && b.status === "surviving", b.status);
  check("it asked a model through Shoal", /model=Practice mode/.test(summary), summary);
  check("it saw only PATH and HOME of the environment, nothing of the server's", /env=HOME,PATH /.test(summary) && /leak=false/.test(summary), summary);
  const bid = b.bids?.find((x) => x.agentId === bundleId);
  check("its bid was its cap, and it raced", bid?.kind === "cap" && bid.amount === 1 && bid.admitted, JSON.stringify(b.bids));
  check("the team sees what the winning fix cost", b.winningAttempt?.spent === 0 && /\$0\.00 in tokens/.test(b.winReason ?? ""), b.winReason);

  console.log("3b. Bids are enforced");
  r = await publish({ name: "Thrifty", runtime: "bundle", maxSpend: 0.05, bundle: { language: "node", entry: "index.js", zip: b64([{ path: "index.js", data: AGENT }]) } });
  check("published with its bid", r.status === 201 && r.json.maxSpend === 0.05, r.json.error);
  r = await publish({ name: "Greedy", runtime: "bundle", maxSpend: 500, bundle: { language: "node", entry: "index.js", zip: b64([{ path: "index.js", data: AGENT }]) } });
  check("a bid over $50 is refused", r.status === 400 && /maxSpend/.test(r.json.error), r.json.error);
  const thrifty = state.listings.find((l) => l.name === "Thrifty");
  const task = { models: ["claude-opus-5-5"], files: [{ path: "src/cart.js", content: "    lookupDiscount(code).then(" }], budget: 0.05 };
  const out = await runSandboxed(thrifty, task, async () => ({ text: "called", cost: 0 }), { budget: 0.05 });
  check("a model call that could go over the bid isn't made", /model=Over your bid/.test(out.fix.summary), out.fix.summary);

  console.log("4. Production and keys");
  const was = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  check("the process sandbox is refused in production", /production/.test(sandboxProblem("bundle") ?? ""), sandboxProblem("bundle"));
  process.env.NODE_ENV = was ?? "";
  if (!was) delete process.env.NODE_ENV;
  const KEY = "sk-ant-api03-never-saved-0123456789";
  await call("GET", "/api/health", null, TEAM, { "x-anthropic-key": KEY });
  await call("POST", "/api/keys/check", {}, TEAM, { "x-anthropic-key": KEY });
  await saveState();
  const saved = await readFile(path.join(process.env.SHOAL_DATA_DIR, "state.json"), "utf8");
  check("a request's API key is never saved", !saved.includes(KEY) && !saved.includes("never-saved"));
} catch (err) {
  check("run", false, err.stack);
}

console.log(ok ? "\nAll upload checks passed" : "\nSome upload checks FAILED");
process.exit(ok ? 0 : 1);
