// Checks Shoal's Supabase storage against the real project in .env, in a
// throwaway schema (shoal_test) that's dropped at the end, so real data in
// the "shoal" schema is never touched. Runs the server as a separate process
// so it can be stopped and started again:
//   creates tables -> a bounty runs to settled, a review, an imported model ->
//   stop -> rows are in Postgres, with constraints -> start -> all restored.
//   node --env-file=.env scripts/supabase-check.js
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";

if (!process.env.SUPABASE_DB_URL) {
  console.error("Set SUPABASE_DB_URL in server/.env and run with: node --env-file=.env scripts/supabase-check.js");
  process.exit(1);
}
const SCHEMA = "shoal_test";
const PORT = "4113";
const BASE = `http://localhost:${PORT}`;
const dataDir = await mkdtemp(path.join(tmpdir(), "shoal-supabase-"));
const db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
await db.query(`drop schema if exists ${SCHEMA} cascade`);

let ok = true;
const check = (label, pass, detail = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? `: ${detail}` : ""}`);
  ok &&= pass;
};
const call = async (method, p, body, user) => {
  const res = await fetch(BASE + p, { method, headers: { "content-type": "application/json", ...(user ? { "x-shoal-test-user": user } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json() };
};

let server = null;
let logs = "";
async function start() {
  server = spawn(process.execPath, ["src/index.js"], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."),
    env: { ...process.env, PORT, SHOAL_WORKSPACE: ".workspace-supabasecheck", SHOAL_DB_SCHEMA: SCHEMA, SHOAL_DATA_DIR: dataDir, SHOAL_MOCK: "1", SHOAL_TEST_USERS: "1", SHOAL_SURVIVAL_MINUTES: "0.02", STRIPE_SECRET_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => (logs += d));
  server.stderr.on("data", (d) => (logs += d));
  for (let i = 0; i < 60; i++) {
    if (await fetch(`${BASE}/api/health`).then((r) => r.ok, () => false)) return;
    if (server.exitCode !== null) throw new Error(`server exited:\n${logs.slice(-1500)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server didn't start:\n${logs.slice(-1500)}`);
}
// SIGTERM: the server writes what's left before it exits.
const stop = () => new Promise((resolve) => {
  server.once("exit", resolve);
  server.kill("SIGTERM");
});

try {
  await start();
  check("server starts on Supabase", /Storage: Supabase \(schema shoal_test\)/.test(logs), logs.match(/Storage: .*/)?.[0]);

  console.log("Scanning the demo repo and running a bounty...");
  await call("POST", "/api/scan", {});
  const cart = (await call("GET", "/api/pains")).json.find((p) => p.testFile === "test/cart.test.js");
  const bounty = (await call("POST", "/api/bounties", { painId: cart.id, reward: 300, competitors: ["rootcause", "flakehunter"] }, "team-alice")).json;
  await call("POST", `/api/bounties/${bounty.id}/run`, {});
  for (let i = 0; i < 120; i++) {
    if ((await call("GET", `/api/bounties/${bounty.id}`)).json.status === "surviving") break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  await new Promise((r) => setTimeout(r, 1500));
  const settled = (await call("POST", `/api/bounties/${bounty.id}/survival/check`, {})).json;
  check("bounty settled", settled.status === "settled", settled.status);
  const review = await call("POST", "/api/marketplace/reviews", { listingId: "rootcause", bountyId: bounty.id, stars: 4, body: "Solid fix", aspects: { codeQuality: 5 } }, "team-alice");
  check("review saved", review.status === 201, review.json.error);
  await call("POST", `/api/marketplace/reviews/${review.json.id}/helpful`, {}, "bob");
  const imported = await call("POST", "/api/marketplace/openrouter", { id: "z-ai/glm-5.3" }, "team-alice");
  check("OpenRouter model imported", imported.status === 201, imported.json.error);

  await stop();

  const tables = (await db.query("select table_name from information_schema.tables where table_schema = $1 order by 1", [SCHEMA])).rows.map((r) => r.table_name);
  check("tables created", ["bounties", "kv", "ledger", "listings", "review_votes", "reviews", "scorecards"].every((t) => tables.includes(t)), tables.join(", "));
  const count = async (t) => Number((await db.query(`select count(*) from ${SCHEMA}.${t}`)).rows[0].count);
  check("rows written", (await count("bounties")) === 1 && (await count("ledger")) === 1 && (await count("reviews")) === 1 && (await count("review_votes")) === 1 && (await count("listings")) === 1, `bounties ${await count("bounties")}, ledger ${await count("ledger")}, reviews ${await count("reviews")}, votes ${await count("review_votes")}, listings ${await count("listings")}`);
  const row = (await db.query(`select status, winner, data->>'reward' as reward from ${SCHEMA}.bounties`)).rows[0];
  check("bounty columns filled", row.status === "settled" && row.winner === "rootcause" && row.reward === "300", JSON.stringify(row));
  const kv = (await db.query(`select key from ${SCHEMA}.kv order by 1`)).rows.map((r) => r.key);
  check("connection, credits etc. in kv", ["connection", "credits", "source"].every((k) => kv.includes(k)), kv.join(", "));
  const dup = await db.query(`insert into ${SCHEMA}.reviews (id, data, listing_id, bounty_id, reviewer, stars) values ('x', '{}', 'rootcause', $1, 'eve', 5)`, [bounty.id]).then(() => "inserted", (e) => e.code);
  check("database enforces one review per bounty", dup === "23505", dup);
  const stars = await db.query(`insert into ${SCHEMA}.reviews (id, data, listing_id, bounty_id, reviewer, stars) values ('y', '{}', 'rootcause', 'other', 'eve', 9)`).then(() => "inserted", (e) => e.code);
  check("database enforces 1-5 stars", stars === "23514", stars);
  const anon = (await db.query(`select has_schema_privilege('anon', $1, 'USAGE') as anon`, [SCHEMA])).rows[0].anon;
  check("Supabase's public API keys can't read it", anon === false, String(anon));

  logs = "";
  await start();
  check("restart restores from Supabase", /Restored .*1 bounties/.test(logs), logs.match(/Restored .*/)?.[0]);
  const back = (await call("GET", `/api/bounties/${bounty.id}`)).json;
  const listing = (await call("GET", "/api/marketplace/listing?id=rootcause")).json;
  check("bounty, scorecard and review back", back.status === "settled" && listing.shoal.survived === 1 && listing.rating.average === 4 && listing.reviews[0]?.helpful === 1, JSON.stringify({ status: back.status, survived: listing.shoal.survived, rating: listing.rating.average }));
  const glm = await call("GET", "/api/marketplace/listing?id=openrouter:z-ai/glm-5.3");
  check("imported listing back", glm.status === 200 && glm.json.name === "GLM 5.3");
  await stop();
} catch (err) {
  check("run", false, err.message);
  if (server?.exitCode === null) server.kill("SIGKILL");
} finally {
  await db.query(`drop schema if exists ${SCHEMA} cascade`);
  await db.end();
}
console.log(ok ? "\nAll Supabase checks passed (shoal_test schema dropped)" : "\nSome checks FAILED (shoal_test schema dropped)");
process.exit(ok ? 0 : 1);
