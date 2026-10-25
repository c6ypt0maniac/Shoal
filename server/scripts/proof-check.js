// Checks that the proof report only asks the judges about a fix that passed
// every test-based check (judges are the expensive part, on Shoal's keys):
//   a fix for the cart test that also breaks orders.js passes the 10-run
//   verifier (it only re-runs tests that were stable, and the orders test
//   was already flaky) but the proof's suite check catches it getting worse
//   -> review skipped, no judge asked, not proven;
//   a clean fix passes the tests -> the judges are asked -> proven.
// Practice mode (no API keys): judges are stand-ins that pass.
//   node scripts/proof-check.js
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.PORT = "4105";
process.env.SHOAL_MOCK = "1";
process.env.SHOAL_DATA_DIR = mkdtempSync(path.join(tmpdir(), "shoal-proof-"));
process.env.SHOAL_WORKSPACE = ".workspace-proofcheck";
delete process.env.SUPABASE_DB_URL;
delete process.env.GITHUB_CLIENT_ID;

await import("../src/index.js");
const { DEMO_REPO } = await import("../src/repo.js");

const BASE = "http://localhost:4105";
let ok = true;
const check = (label, pass, detail = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? `: ${detail}` : ""}`);
  ok &&= pass;
};
const api = async (p, body) => (await fetch(BASE + p, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {})).json();
const { state } = await import("../src/store.js");
const { submitTrial } = await import("../src/trials.js");
// A trial fix, straight into Shoal's trial verifier (sealed trials do the
// same with a model's API answer, api-trials.js).
const trial = async ({ model, summary, files }) => {
  const t = await submitTrial({ painId: cart.id, model, summary, files, client: { app: "proof-check" } });
  return { result: t.status, reason: t.reason, trialId: t.id };
};
let cart;

// The proof for a problem, once it's finished checking.
async function proofOf(painId) {
  for (let i = 0; i < 180; i++) {
    const p = (await api("/api/trials")).problems.find((x) => x.painId === painId)?.proof;
    if (p && !p.checking && p.candidates?.length && p.candidates.every((c) => c.status === "done")) return p;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("proof never finished");
}

try {
  await api("/api/scan", {});
  cart = state.pains.find((p) => p.testFile === "test/cart.test.js" && !p.healthy);
  check("scan found the flaky cart test", Boolean(cart));

  const cartFixed = (await readFile(path.join(DEMO_REPO, "src/cart.js"), "utf8")).replace("    lookupDiscount(code).then(", "    return lookupDiscount(code).then(");
  // Every order gets the same ID, so the (already flaky) orders test always fails.
  const ordersBroken = (await readFile(path.join(DEMO_REPO, "src/orders.js"), "utf8")).replace("`ORD-${Math.floor(Math.random() * 200)}`", '"ORD-1"');

  console.log("1. A fix that passes the verifier but makes the orders test worse");
  const bad = await trial({ model: "claude-haiku-5-5", summary: "Return the lookup promise; simplify order ids.", files: [{ path: "src/cart.js", content: cartFixed }, { path: "src/orders.js", content: ordersBroken }] });
  check("verifier passes it (it only re-runs tests that were stable)", bad.result === "passed", bad.reason);
  await api("/api/proofs", { painId: cart.id });
  let proof = await proofOf(cart.id);
  let mine = proof.candidates.find((c) => c.trialId === bad.trialId);
  check("proof's suite check catches it", mine?.checks.suite.ok === false, JSON.stringify(mine?.checks.suite.flaky));
  check("judges were not asked (review skipped)", mine?.checks.review.skipped === true && mine.checks.review.judges.length === 0, mine?.checks.review.reason);
  check("not proven", mine?.verdict === "not_proven", mine?.failures.join("; "));

  console.log("2. A clean fix: the judges are asked");
  const good = await trial({ model: "claude-sonnet-5-5", summary: "Return the lookup promise so callers can await it.", files: [{ path: "src/cart.js", content: cartFixed }] });
  check("verifier passes it", good.result === "passed", good.reason);
  await api("/api/proofs", { painId: cart.id, fresh: true });
  proof = await proofOf(cart.id);
  mine = proof.candidates.find((c) => c.trialId === good.trialId);
  check("judges were asked", mine?.checks.review.skipped !== true && mine?.checks.review.judges.length === 2, mine?.checks.review.judges.map((j) => j.name).join(" + "));
  check("proven safe", mine?.verdict === "safe", mine?.failures.join("; "));
} catch (err) {
  check("run", false, err.stack);
}
console.log(ok ? "\nAll proof checks passed" : "\nSome proof checks FAILED");
process.exit(ok ? 0 : 1);
