// Checks sealed API trials (api-trials.js) in practice mode (no keys, no spend):
//   trials need credits;
//   the ladder climbs past a step whose models all fail and stops at the
//   first step with a proven fix (step 3 is never asked);
//   until unlock no fix code leaves Shoal (API, file/zip downloads, MCP);
//   unlock charges credits once, at the price shown, and lands the fix;
//   a model that failed is never asked again on the same bug;
//   the spend cap stops the ladder before a call that would go over it.
//   node scripts/api-trials-check.js
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const STEP_1 = ["claude-haiku-5-5", "gpt-6-luna", "gpt-5-nano"];
const ALL = [...STEP_1, "claude-sonnet-5-5", "gpt-6.1-sol", "claude-opus-5-5", "gpt-6-astra"];

process.env.PORT = "4106";
process.env.SHOAL_MOCK = "1";
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
const { DEMO_REPO } = await import("../src/repo.js");
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
  console.log("2. The ladder stops at the first step with a proven fix");
  const started = await req("/api/trials/sealed", { painId: cart.id });
  check("started", started.status === 202, started.text);
  let p = await ladderDone("test/cart.test.js");
  const tried = state.apiTrials[cart.id].tried;
  check("proven at step 2", p.ladder.status === "proven" && p.ladder.step === 2, JSON.stringify(p.ladder));
  check("step 1's models were each tried once and failed", STEP_1.every((m) => tried.filter((x) => x === m).length === 1));
  check("step 3 was never asked", !tried.includes("claude-opus-5-5") && !tried.includes("gpt-6-astra"), tried.join(", "));
  check("Shoal set the model tags and measured costs", state.trials.filter((t) => t.painId === cart.id).every((t) => t.sealed && t.client?.app === "Shoal API" && t.apiCost > 0));
  check("spend was recorded for this bug", state.trialSpend[cart.id]?.fix > 0, JSON.stringify(state.trialSpend[cart.id]));
  const price = p.fixPrice;
  check("a price is shown before unlocking, $2.99-$19.99, ending in .99", price >= 2.99 && price <= 19.99 && Math.round(price * 100) % 100 === 99, String(price));

  console.log("3. Sealed until unlocked");
  const proven = p.proof.proven;
  const sealedText = (await req("/api/trials")).text;
  const mine = (await api("/api/trials")).trials.find((t) => t.id === proven.trialId);
  check("the trial shows paths, not code", mine.locked && mine.files.every((f) => typeof f === "string"));
  check("the proof's diff has line counts but no lines", proven.locked && proven.checks.diff.files.every((f) => !f.hunks && f.added >= 0));
  check("file download refused", (await req(`/api/trials/${proven.trialId}/file?path=src/cart.js`)).status === 403);
  check("repo zip refused", (await req(`/api/trials/${proven.trialId}/repo`)).status === 403);
  check("MCP list_reviews shows nothing", JSON.parse(await call("list_reviews")).reviews.length === 0);
  check("MCP get_review refuses it", /No review is waiting/.test(await call("get_review", { trial_id: proven.trialId })));

  console.log("4. Unlock charges once and lands the fix");
  const before = balanceCents();
  const cartTrials = state.trials.filter((t) => t.painId === cart.id).length;
  const fixSpend = state.trialSpend[cart.id].fix;
  const unlock = await req(`/api/trials/${proven.trialId}/unlock`, {});
  check("unlock accepted", unlock.status === 202, unlock.text);
  const bountyId = JSON.parse(unlock.text).id;
  const bounty = await until("the unlock", async () => {
    const b = state.bounties.find((x) => x.id === bountyId);
    return b && !["open", "verifying"].includes(b.status) ? b : null;
  });
  check("the fix landed (survival window started)", bounty.status === "surviving", bounty.status);
  check("charged exactly the price shown", before - balanceCents() === Math.round(price * 100), `${(before - balanceCents()) / 100} vs ${price}`);
  check("no second paid run: no new model call", state.trials.filter((t) => t.painId === cart.id).length === cartTrials && state.trialSpend[cart.id].fix === fixSpend && state.trialSpend[cart.id].revenue === price);
  const again = await req(`/api/trials/${proven.trialId}/unlock`, {});
  check("a second unlock is refused and charges nothing", again.status === 409 && before - balanceCents() === Math.round(price * 100), again.text);
  const file = await req(`/api/trials/${proven.trialId}/file?path=src/cart.js`);
  check("the code is readable after unlock", file.status === 200);
  const original = new Set((await readFile(path.join(DEMO_REPO, "src/cart.js"), "utf8")).split("\n").map((l) => l.trim()));
  const changed = file.text.split("\n").map((l) => l.trim()).filter((l) => l.length > 8 && !original.has(l));
  check("none of the fix's changed lines appeared before unlock", changed.length > 0 && changed.every((l) => !sealedText.includes(JSON.stringify(l).slice(1, -1))), changed.join(" | "));

  console.log("5. The spend cap stops the ladder");
  process.env.SHOAL_MOCK_FAIL_MODELS = ALL.join(",");
  process.env.SHOAL_TRIAL_CAP = "0.0001";
  await req("/api/trials/sealed", { painId: orders.id });
  p = await ladderDone("test/orders.test.js");
  check("stopped at the cap before any call", p.ladder.stopped === "cap" && state.apiTrials[orders.id].tried.length === 0, JSON.stringify(p.ladder));
  delete process.env.SHOAL_TRIAL_CAP;

  console.log("6. A failed model is never asked again");
  await req("/api/trials/sealed", { painId: orders.id });
  p = await ladderDone("test/orders.test.js");
  const first = [...state.apiTrials[orders.id].tried];
  check("every model tried once, none proven", p.ladder.stopped === "exhausted" && first.length === ALL.length && new Set(first).size === ALL.length, first.join(", "));
  const trialsBefore = state.trials.length;
  await req("/api/trials/sealed", { painId: orders.id });
  p = await ladderDone("test/orders.test.js");
  check("running again asks no model", state.apiTrials[orders.id].tried.length === ALL.length && state.trials.length === trialsBefore);

  const margins = await req("/api/owner/margins");
  check("owner margin view (local)", margins.status === 200 && JSON.parse(margins.text).rows.some((r) => r.painId === cart.id && r.revenue === price), margins.text.slice(0, 200));
} catch (err) {
  check("run", false, err.stack);
}
console.log(ok ? "\nAll sealed-trial checks passed" : "\nSome sealed-trial checks FAILED");
process.exit(ok ? 0 : 1);
