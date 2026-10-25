// Checks sealed API trials (api-trials.js) in practice mode (no keys, no spend):
//   trials need credits;
//   the trial only diagnoses: step 1's diagnoses are wrong, step 2's right,
//   and the cheapest correct model is recommended with a quote; no fix is
//   written (step 3 never asked);
//   authorizing it: that model alone writes the fix, it's proven, charged
//   once (no more than the quote) and lands;
//   a model that failed is never asked again on the same bug;
//   the spend cap stops the ladder before a call that would go over it.
//   node scripts/api-trials-check.js
import { mkdtempSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const STEP_1 = ["claude-haiku-5-5", "gpt-6-luna", "gpt-5-nano"];
const ALL = [...STEP_1, "claude-sonnet-5-5", "gpt-6.1-sol", "claude-opus-5-5", "gpt-6-astra"];

process.env.PORT = "4106";
process.env.SHOAL_MOCK = "1";
process.env.SHOAL_MOCK_JUDGES = "1"; // stand-in judges: never spend anyone's Claude/ChatGPT plan or API credit
process.env.SHOAL_DATA_DIR = mkdtempSync(path.join(tmpdir(), "shoal-apitrials-"));
process.env.SHOAL_WORKSPACE = ".workspace-apitrialscheck";
process.env.CLAUDE_BIN = "/nonexistent/claude";
process.env.CODEX_BIN = "/nonexistent/codex";
process.env.SHOAL_MOCK_FAIL_MODELS = STEP_1.join(",");
delete process.env.SUPABASE_DB_URL;
delete process.env.GITHUB_CLIENT_ID;
delete process.env.SHOAL_TEAM_PLAN;
delete process.env.SHOAL_TRIAL_CAP;
delete process.env.STRIPE_SECRET_KEY;

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
await import("../src/index.js");
const { DEMO_REPO, WORKSPACE } = await import("../src/repo.js");
const { addCredits, balanceCents } = await import("../src/credits.js");
const { state } = await import("../src/store.js");

const BASE = "http://localhost:4106";
let ok = true;
const check = (label, pass, detail = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? `: ${detail}` : ""}`);
  ok &&= pass;
};
const req = async (p, body) => {
  const r = await fetch(BASE + p, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  return { status: r.status, text: await r.text() };
};
const api = async (p, body) => JSON.parse((await req(p, body)).text);
const client = new Client({ name: "api-trials-check", version: "1" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).content[0].text;

const until = async (what, fn, seconds = 240) => {
  for (let i = 0; i < seconds; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for ${what}`);
};
const problem = async (testFile) => (await api("/api/trials")).problems.find((p) => p.testFile === testFile);
const ladderDone = (testFile) => until(`${testFile} trials`, async () => {
  const p = await problem(testFile);
  return p?.ladder && p.ladder.status !== "running" && !p.proof.checking ? p : null;
});

try {
  await api("/api/scan", {});
  const cart = state.pains.find((p) => p.testFile === "test/cart.test.js" && !p.healthy);
  const orders = state.pains.find((p) => p.testFile === "test/orders.test.js" && !p.healthy);
  check("scan found the flaky cart and orders tests", Boolean(cart && orders));

  console.log("1. Trials need credits");
  const none = await req("/api/trials/sealed", { painId: cart.id });
  check("no credits: refused with 402", none.status === 402, none.text);

  await addCredits({ dollars: 25, mode: "simulated" });
  console.log("2. The trial only diagnoses, then recommends the cheapest correct model");
  const started = await req("/api/trials/sealed", { painId: cart.id });
  check("started", started.status === 202, started.text);
  let p = await ladderDone("test/cart.test.js");
  let { diagnosed, fixed } = state.apiTrials[cart.id];
  check("stopped at step 2 waiting for the go-ahead", p.ladder.status === "awaiting_authorization" && p.ladder.step === 2, JSON.stringify({ ...p.ladder, diagnoses: undefined }));
  check("step 1's models each diagnosed once, wrongly", STEP_1.every((m) => diagnosed.filter((x) => x === m).length === 1));
  check("step 3 was never asked", !diagnosed.includes("claude-opus-5-5") && !diagnosed.includes("gpt-6-astra"), diagnosed.join(", "));
  check("a step-2 model that diagnosed it right is recommended", ["claude-sonnet-5-5", "gpt-6.1-sol"].includes(p.ladder.pick) && p.ladder.pickName, p.ladder.pick);
  check("no fix was written in the trial", fixed.length === 0 && state.trials.filter((t) => t.painId === cart.id).length === 0);
  check("the team sees what's broken, not the plan", p.ladder.diagnoses.length === 5 && p.ladder.diagnoses.every((d) => !("plan" in d) && d.file) && !JSON.stringify(p.ladder).includes("Practice mode."));
  const quote = p.ladder.quote;
  check("a quote is shown before authorizing, $2.99-$19.99, ending in .99", quote >= 2.99 && quote <= 19.99 && Math.round(quote * 100) % 100 === 99, String(quote));
  check("running the trial again leaves the recommendation alone", (await req("/api/trials/sealed", { painId: cart.id })).status === 202 && (await until("refusal", async () => (state.apiTrials[cart.id].status === "awaiting_authorization" ? true : null))));
  check("MCP list_reviews shows nothing", JSON.parse(await call("list_reviews")).reviews.length === 0);

  console.log("3. Authorizing: the recommended model writes the fix; charged once, only when proven");
  const before = balanceCents();
  const auth = await req("/api/trials/authorize", { painId: cart.id });
  check("authorize accepted", auth.status === 202, auth.text);
  check("a second authorize is refused", (await req("/api/trials/authorize", { painId: cart.id })).status === 409);
  const bounty = await until("the fix to land", async () => {
    const id = state.apiTrials[cart.id].bountyId;
    const b = id && state.bounties.find((x) => x.id === id);
    return b && !["open", "verifying"].includes(b.status) ? b : null;
  });
  ({ fixed } = state.apiTrials[cart.id]);
  const trials = state.trials.filter((t) => t.painId === cart.id);
  check("only the recommended model wrote a fix", fixed.length === 1 && fixed[0] === p.ladder.pick && trials.length === 1 && trials[0].model === p.ladder.pick, fixed.join(", "));
  check("Shoal set the model tag and measured the cost", trials[0].sealed && trials[0].client?.app === "Shoal API" && trials[0].apiCost > 0);
  check("the fix landed (survival window started)", bounty.status === "surviving", bounty.status);
  const charged = (before - balanceCents()) / 100;
  check("charged once, no more than the quote", charged > 0 && charged <= quote && charged === state.apiTrials[cart.id].price && state.trialSpend[cart.id].revenue === charged, `${charged} vs quote ${quote}`);
  const file = await req(`/api/trials/${trials[0].id}/file?path=src/cart.js`);
  check("the code is readable once it landed", file.status === 200 && /return lookupDiscount/.test(file.text));

  console.log("5. The spend cap stops the ladder");
  process.env.SHOAL_MOCK_FAIL_MODELS = ALL.join(",");
  process.env.SHOAL_TRIAL_CAP = "0.0001";
  await req("/api/trials/sealed", { painId: orders.id });
  p = await ladderDone("test/orders.test.js");
  check("stopped at the cap before any call", p.ladder.stopped === "cap" && state.apiTrials[orders.id].diagnosed.length === 0, JSON.stringify(p.ladder));
  delete process.env.SHOAL_TRIAL_CAP;

  console.log("6. A failed model is never asked again");
  await req("/api/trials/sealed", { painId: orders.id });
  p = await ladderDone("test/orders.test.js");
  const first = [...state.apiTrials[orders.id].diagnosed];
  check("every model diagnosed once, none right, so no fix written", p.ladder.stopped === "exhausted" && first.length === ALL.length && new Set(first).size === ALL.length && state.apiTrials[orders.id].fixed.length === 0, first.join(", "));
  const trialsBefore = state.trials.length;
  await req("/api/trials/sealed", { painId: orders.id });
  p = await ladderDone("test/orders.test.js");
  check("running again asks no model", state.apiTrials[orders.id].diagnosed.length === ALL.length && state.trials.length === trialsBefore);

  console.log("7. Bounties: a diagnosis race, then the winner writes the fix when the team says go");
  process.env.SHOAL_MOCK_FAIL_MODELS = "claude-haiku-5-5";
  // A "stable" test that fails without any fix (a stale scan): the verifier
  // mustn't blame the fix for it.
  await writeFile(path.join(WORKSPACE, "test/stale.test.js"), 'import { test } from "node:test";\ntest("stale", () => { throw new Error("broken before any fix"); });\n');
  const posted = JSON.parse((await req("/api/bounties", { painId: orders.id, reward: 20 })).text);
  check("bounty defaults to the Claude models", JSON.stringify(posted.competitors) === JSON.stringify(["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]), JSON.stringify(posted.competitors));
  state.bounties.find((b) => b.id === posted.id).stableTestFiles.push("test/stale.test.js");
  await req(`/api/bounties/${posted.id}/run`, {});
  let b = await until("the diagnosis race", async () => { const x = JSON.parse((await req(`/api/bounties/${posted.id}`)).text); return ["awaiting_go_ahead", "failed"].includes(x.status) ? x : null; });
  check("the race only diagnoses, then waits for the team", b.status === "awaiting_go_ahead" && b.competition.attempts === 0 && !b.winningAttempt, b.status);
  check("the cheapest correct model is recommended (Haiku was wrong)", b.recommended === "claude-sonnet-5-5" && b.diagnoses.find((d) => d.model === "claude-haiku-5-5")?.correct === false, b.recommended);
  check("diagnoses show what's broken, not the plan", b.diagnoses.length === 3 && b.diagnoses.every((d) => !("plan" in d)));
  check("a model with a wrong diagnosis can't be picked", (await req(`/api/bounties/${posted.id}/build`, { model: "claude-haiku-5-5" })).status === 400);
  check("go-ahead accepted", (await req(`/api/bounties/${posted.id}/build`, {})).status === 202);
  b = await until("the fix", async () => { const x = JSON.parse((await req(`/api/bounties/${posted.id}`)).text); return ["surviving", "failed"].includes(x.status) ? x : null; });
  check("only the chosen model wrote the fix, and it won", b.status === "surviving" && b.winner === "claude-sonnet-5-5" && b.competition.attempts === 1, `${b.status} ${b.failReason ?? ""}`);
  await rm(path.join(WORKSPACE, "test/stale.test.js"), { force: true });

  console.log("9. Best value: the cheapest model within a point of the best diagnosis");
  const { rankDiagnoses } = await import("../src/api-trials.js");
  const d = (model, score, fixCost) => ({ model, correct: true, score, fixCost });
  const ranked = rankDiagnoses([d("claude-opus-5-5", 9, 0.4), d("claude-sonnet-5-5", 8, 0.2), d("claude-haiku-5-5", 6, 0.01), { model: "gpt-5-nano", correct: false, score: 0, fixCost: 0.001 }]);
  check("a much weaker cheap diagnosis isn't picked; Sonnet (8/10) beats Opus (9/10) on price", ranked.map((x) => x.model).join(",") === "claude-sonnet-5-5,claude-opus-5-5,claude-haiku-5-5", ranked.map((x) => x.model).join(","));
  const { practiceOnly } = await import("../src/agents.js");
  check("practice mode works on the demo repo only", practiceOnly("demo") === null && /practice mode/.test(practiceOnly("github") ?? ""));

  console.log("8. Deleting bounties");
  const del = async (id) => { const r = await fetch(`${BASE}/api/bounties/${id}`, { method: "DELETE" }); return { status: r.status, body: await r.json() }; };
  const gone = await del(posted.id);
  check("a bounty in its survival window is deleted and refunded", gone.status === 200 && gone.body.escrow === "refunded" && !state.bounties.some((x) => x.id === posted.id), JSON.stringify(gone.body));
  const held = JSON.parse((await req("/api/bounties", { painId: orders.id, reward: 15 })).text);
  const gone2 = await del(held.id);
  check("an unstarted bounty is deleted and its hold released", gone2.status === 200 && gone2.body.escrow === "released", JSON.stringify(gone2.body));

  const margins = await req("/api/owner/margins");
  check("owner margin view (local)", margins.status === 200 && JSON.parse(margins.text).rows.some((r) => r.painId === cart.id && r.revenue === charged), margins.text.slice(0, 200));
} catch (err) {
  check("run", false, err.stack);
}
console.log(ok ? "\nAll sealed-trial checks passed" : "\nSome sealed-trial checks FAILED");
process.exit(ok ? 0 : 1);
