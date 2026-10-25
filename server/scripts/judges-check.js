// Checks the two-judge review over MCP on the bundled demo repo: a trial fix
// tagged GPT-6 Astra must be judged by Sonnet 5.5 and GPT-6.1 Sol (never by
// itself), the proof waits for both, and finishes once both have answered.
// Claude Code and Codex are hidden (CLAUDE_BIN, CODEX_BIN) so both judges
// answer over MCP and nothing runs on anyone's Claude or ChatGPT plan.
//   node scripts/judges-check.js
process.env.PORT = "4103";
process.env.SHOAL_MOCK = "1";
// Its own data folder, so test bounties and credits never touch the real .data/.
process.env.SHOAL_DATA_DIR = (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "shoal-check-"));
process.env.SHOAL_WORKSPACE = ".workspace-judgescheck";
// The MCP review flow is the opt-in "team's own plan" route; by default
// judges run on Shoal's API keys.
process.env.SHOAL_TEAM_PLAN = "1";
process.env.CLAUDE_BIN = "/nonexistent/claude";
process.env.CODEX_BIN = "/nonexistent/codex";
delete process.env.GITHUB_CLIENT_ID;

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
await import("../src/index.js");

const BASE = "http://localhost:4103";
let ok = true;
const check = (label, pass, detail = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? `: ${detail}` : ""}`);
  ok &&= pass;
};
const api = async (path, body) => (await fetch(BASE + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {})).json();

console.log("Scanning the demo repo...");
await api("/api/scan", {});
const client = new Client({ name: "check", version: "1" });
// Sent the way codex-runner.js connects, so submissions are labelled Codex.
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { "X-Shoal-Client": "Codex" } } }));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { error: r.isError, text: r.content[0].text, json: (() => { try { return JSON.parse(r.content[0].text); } catch { return null; } })() };
};

const { json: listed } = await call("list_problems");
const cart = listed.problems.find((p) => p.testFile === "test/cart.test.js");
check("scan found the flaky cart test", Boolean(cart));

const src = (await call("read_file", { path: "src/cart.js" })).text;
const fixed = src.replace("    lookupDiscount(code).then(", "    return lookupDiscount(code).then(");
const trial = await call("submit_trial", { problem_id: cart.id, model: "gpt-6-astra", summary: "Return the lookup promise.", files: [{ path: "src/cart.js", content: fixed }] });
check("OpenAI-tagged trial verified", trial.json?.result === "passed", trial.text.slice(0, 200));
const trials = await api("/api/trials");
const mine = trials.trials.find((t) => t.id === trial.json.trialId);
check("trial records the MCP client", mine?.client?.app === "Codex (this machine)", JSON.stringify(mine?.client));

await api("/api/proofs", { painId: cart.id });
let reviews = [];
for (let i = 0; i < 240 && !reviews.length; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  reviews = (await call("list_reviews")).json.reviews;
}
check("proof waits for judges", reviews.length === 1);
const needs = reviews[0]?.needs.map((n) => n.model).sort() ?? [];
check("judges are Sonnet 5.5 + GPT-6.1 Sol (Astra can't judge itself)", JSON.stringify(needs) === JSON.stringify(["claude-sonnet-5-5", "gpt-6.1-sol"]), needs.join(", "));

const request = await call("get_review", { trial_id: trial.json.trialId });
check("get_review returns diff + all code", /unified diff/.test(request.text) && /===== src\/cart.js =====/.test(request.text));

const self = await call("submit_review", { trial_id: trial.json.trialId, model: "gpt-6-astra", verdict: "pass", summary: "Looks good." });
check("self-review refused", self.error === true, self.text);
const first = await call("submit_review", { trial_id: trial.json.trialId, model: "gpt-6.1-sol", verdict: "pass", summary: "Root cause fixed." });
check("OpenAI judge recorded, still waiting for Claude", first.json?.proofStatus === "awaiting_review" && first.json.stillWaitingFor.join() === "Sonnet 5.5", first.text);
const second = await call("submit_review", { trial_id: trial.json.trialId, model: "claude-sonnet-5-5", verdict: "fail", summary: "Coupon errors still swallowed.", remaining_bugs: ["src/cart.js: rejected lookup is unhandled"] });
check("both judges in -> proof finished", second.json?.proofStatus === "done", second.text);

const proof = (await api("/api/trials")).problems.find((p) => p.painId === cart.id).proof.candidates[0];
check("review check fails if either judge fails", proof.checks.review.ok === false && proof.failures.some((f) => f.startsWith("Sonnet 5.5's review")), proof.failures.join(" | "));
check("passing judge doesn't add a failure", !proof.failures.some((f) => f.startsWith("GPT-6.1 Sol")));

await client.close();
console.log(ok ? "\nAll judge checks passed" : "\nSome checks FAILED");
process.exit(ok ? 0 : 1);
