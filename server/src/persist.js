// Durable state: what has to outlive a restart because it spans days or
// involves money. Bounties (and their survival windows), the ledger, agent
// scorecards, credits, marketplace listings, reviews, helpful votes,
// measured model costs, the repo connection and its last scan. Trials and
// proofs are not: they're rebuilt by running them again.
//
// Two backends, same data:
//   Supabase Postgres  when SUPABASE_DB_URL is set. Shoal creates its own
//                      schema (SHOAL_DB_SCHEMA, default "shoal") and tables
//                      at startup. The schema isn't exposed through
//                      Supabase's public API, so browser keys can't read it;
//                      only this server, with the database password, can.
//   JSON file          otherwise: .data/state.json (gitignored).
//
// The app works on the in-memory copy in store.js; changed rows are written
// back every few seconds, and right away for money (credits.js awaits
// saveState). One server instance at a time: two would overwrite each other.
import { suggestReward } from "./scanner.js";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { state } from "./store.js";
import { getSource, setSource } from "./repo.js";

const DATA_DIR = process.env.SHOAL_DATA_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.data");
const FILE = path.join(DATA_DIR, "state.json");
const SAVE_EVERY_MS = 3000;
const SCHEMA = process.env.SHOAL_DB_SCHEMA || "shoal";
if (!/^[a-z_][a-z0-9_]*$/.test(SCHEMA)) throw new Error(`SHOAL_DB_SCHEMA must be a plain lowercase name, not "${SCHEMA}"`);

// Row collections: each item becomes one row keyed by `key`. `columns` are
// copied out of the JSON into real columns, for constraints and for anyone
// querying the database directly.
const COLLECTIONS = {
  bounties: {
    get: () => state.bounties,
    set: (rows) => (state.bounties = rows.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))),
    key: (b) => b.id,
    columns: { status: (b) => b.status, test_file: (b) => b.testFile, winner: (b) => b.winner },
  },
  ledger: {
    get: () => state.ledger,
    set: (rows) => (state.ledger = rows.sort((a, b) => (b.chargedAt ?? "").localeCompare(a.chargedAt ?? ""))),
    key: (t) => t.id,
    columns: { bounty_id: (t) => t.bountyId, agent_id: (t) => t.agentId, status: (t) => t.status },
  },
  scorecards: {
    get: () => Object.entries(state.agents).map(([id, card]) => ({ id, ...card })),
    set: (rows) => (state.agents = Object.fromEntries(rows.map(({ id, ...card }) => [id, card]))),
    key: (c) => c.id,
    columns: {},
  },
  listings: {
    get: () => state.listings,
    set: (rows) => (state.listings = rows.sort((a, b) => (a.addedAt ?? "").localeCompare(b.addedAt ?? ""))),
    key: (l) => l.id,
    columns: { kind: (l) => l.kind, provider: (l) => l.provider, owner: (l) => l.owner ?? null },
  },
  reviews: {
    get: () => state.reviews,
    set: (rows) => (state.reviews = rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt))),
    key: (r) => r.id,
    columns: { listing_id: (r) => r.listingId, bounty_id: (r) => r.bountyId, reviewer: (r) => r.reviewer, stars: (r) => r.stars },
  },
  review_votes: {
    get: () => state.reviewVotes,
    set: (rows) => (state.reviewVotes = rows),
    key: (v) => `${v.reviewId}:${v.voter}`,
    columns: { review_id: (v) => v.reviewId, voter: (v) => v.voter },
  },
};

// Single values, one row each in the kv table.
const VALUES = {
  connection: { get: () => state.connection, set: (v) => (state.connection = v) },
  // The last scan: the bounties page lists bounties under their flaky test.
  // Suggested rewards are recomputed, so a saved scan picks up a change to the formula.
  pains: { get: () => state.pains, set: (v) => (state.pains = (v ?? []).map((p) => ({ ...p, suggestedReward: suggestReward(p.hoursPerWeek ?? 0) }))) },
  source: { get: () => ({ dir: getSource().dir, testCommand: getSource().testCommand }), set: () => {} },
  sync: { get: () => ({ auto: state.sync?.auto ?? true }), set: (v) => (state.sync = { ...state.sync, auto: v.auto }) },
  modelCost: { get: () => state.modelCost, set: (v) => (state.modelCost = v ?? {}) },
  credits: { get: () => state.credits, set: (v) => (state.credits = v) },
  billing: { get: () => state.billing, set: (v) => (state.billing = v ?? {}) },
  recentRepos: { get: () => state.recentRepos, set: (v) => (state.recentRepos = v ?? []) },
  trialSpend: { get: () => state.trialSpend, set: (v) => (state.trialSpend = v ?? {}) },
  useTeamPlan: { get: () => state.useTeamPlan, set: (v) => { if (typeof v === "boolean") state.useTeamPlan = v; } },
};

// Real columns and constraints per table, on top of id + data.
const DDL = {
  bounties: "status text, test_file text, winner text",
  ledger: "bounty_id text, agent_id text, status text",
  scorecards: "",
  listings: "kind text, provider text, owner text",
  // One review per bounty; stars 1-5.
  reviews: "listing_id text not null, bounty_id text not null unique, reviewer text not null, stars int not null check (stars between 1 and 5)",
  review_votes: "review_id text not null, voter text not null, unique (review_id, voter)",
};

export const storageInfo = () => (pool ? { backend: "supabase", schema: SCHEMA } : { backend: "file", file: FILE });

// --- Postgres ---------------------------------------------------------------------

let pool = null;
const q = (name) => `"${SCHEMA}"."${name}"`;

async function connectPostgres() {
  const { default: pg } = await import("pg");
  // Supabase requires TLS; its certificate chain isn't in Node's default store.
  pool = new pg.Pool({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false }, max: 4, connectionTimeoutMillis: 15_000 });
  pool.on("error", (err) => console.error(`Supabase connection error: ${err.message}`));
  const client = await pool.connect();
  try {
    await client.query(`create schema if not exists "${SCHEMA}"`);
    for (const [table, extra] of Object.entries(DDL)) {
      await client.query(`create table if not exists ${q(table)} (id text primary key, data jsonb not null${extra ? `, ${extra}` : ""}, updated_at timestamptz not null default now())`);
    }
    await client.query(`create table if not exists ${q("kv")} (key text primary key, value jsonb, updated_at timestamptz not null default now())`);
    // Keep it off Supabase's public (anon/authenticated) API.
    await client.query(`revoke all on schema "${SCHEMA}" from anon, authenticated`).catch(() => {});
  } finally {
    client.release();
  }
}

async function loadPostgres() {
  const saved = {};
  for (const name of Object.keys(COLLECTIONS)) saved[name] = (await pool.query(`select data from ${q(name)}`)).rows.map((r) => r.data);
  const kv = Object.fromEntries((await pool.query(`select key, value from ${q("kv")}`)).rows.map((r) => [r.key, r.value]));
  return { ...saved, ...kv, empty: !Object.keys(kv).length && Object.values(saved).every((rows) => !rows.length) };
}

// Writes only what changed since the last save, in one transaction.
async function savePostgres(snap) {
  const changes = diff(snap);
  if (!changes.length) return;
  const client = await pool.connect();
  try {
    await client.query("begin");
    for (const c of changes) {
      if (c.kind === "value") {
        await client.query(`insert into ${q("kv")} (key, value, updated_at) values ($1, $2, now()) on conflict (key) do update set value = excluded.value, updated_at = now()`, [c.name, c.json]);
      } else if (c.op === "delete") {
        await client.query(`delete from ${q(c.name)} where id = $1`, [c.id]);
      } else {
        const cols = Object.entries(COLLECTIONS[c.name].columns);
        const names = ["id", "data", ...cols.map(([col]) => col)];
        const values = [c.id, c.json, ...cols.map(([, get]) => get(c.item) ?? null)];
        const set = names.slice(1).map((n) => `${n} = excluded.${n}`).join(", ");
        await client.query(
          `insert into ${q(c.name)} (${names.join(", ")}, updated_at) values (${values.map((_, i) => `$${i + 1}`).join(", ")}, now()) on conflict (id) do update set ${set}, updated_at = now()`,
          values,
        );
      }
    }
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  last = snap;
}

// --- JSON file ----------------------------------------------------------------------

function loadFile() {
  if (!existsSync(FILE)) return { empty: true };
  return JSON.parse(readFileSync(FILE, "utf8"));
}

async function saveFile(snap) {
  if (!diff(snap).length) return;
  const out = { version: 2 };
  for (const name of Object.keys(COLLECTIONS)) out[name] = [...snap.rows[name].values()].map((r) => r.item);
  for (const name of Object.keys(VALUES)) out[name] = snap.values[name] === undefined ? null : JSON.parse(snap.values[name]);
  await mkdir(DATA_DIR, { recursive: true });
  // Write then rename, so a crash mid-write can't corrupt anything.
  await writeFile(FILE + ".tmp", JSON.stringify(out));
  await rename(FILE + ".tmp", FILE);
  last = snap;
}

// --- Change tracking ------------------------------------------------------------------

let last = null; // the last snapshot written

function snapshot() {
  const rows = {};
  for (const [name, c] of Object.entries(COLLECTIONS)) rows[name] = new Map(c.get().map((item) => [c.key(item), { item, json: JSON.stringify(item) }]));
  const values = {};
  for (const [name, v] of Object.entries(VALUES)) {
    const value = v.get();
    values[name] = value === undefined ? undefined : JSON.stringify(value);
  }
  return { rows, values };
}

function diff(snap) {
  const out = [];
  for (const [name, rows] of Object.entries(snap.rows)) {
    const before = last?.rows[name] ?? new Map();
    for (const [id, r] of rows) if (before.get(id)?.json !== r.json) out.push({ name, id, item: r.item, json: r.json, op: "upsert" });
    for (const id of before.keys()) if (!rows.has(id)) out.push({ name, id, op: "delete" });
  }
  for (const [name, json] of Object.entries(snap.values)) if (json !== undefined && last?.values[name] !== json) out.push({ kind: "value", name, json });
  return out;
}

// --- Public ---------------------------------------------------------------------------

let saving = Promise.resolve();

// Writes whatever changed. Saves are queued, so a caller can await "my
// change is stored" (credits do, before they report success).
export function saveState() {
  saving = saving.catch(() => {}).then(() => (pool ? savePostgres(snapshot()) : saveFile(snapshot())));
  return saving;
}

// Connects (creating the schema on Supabase if needed), loads the saved
// state into `state` and points the workspace back at the repo it was
// connected to. Returns true if anything was restored. A GitHub clone
// that's gone from disk falls back to the demo repo; its bounties are kept
// but can't be checked until the repo is connected again.
export async function loadState() {
  if (process.env.SUPABASE_DB_URL) {
    try {
      await connectPostgres();
    } catch (err) {
      throw new Error(`Couldn't connect to Supabase (SUPABASE_DB_URL): ${err.message.replace(/postgres(ql)?:\/\/[^@]*@/g, "postgresql://…@")}`);
    }
  }
  let saved = pool ? await loadPostgres() : loadFile();
  // First start on Supabase: bring over what the JSON file had.
  if (pool && saved.empty && existsSync(FILE)) saved = { ...loadFile(), imported: true };
  saved.credits ??= legacyCredits();

  for (const [name, c] of Object.entries(COLLECTIONS)) if (Array.isArray(saved[name])) c.set(saved[name]);
  // Before version 2 the scorecards were saved under "agents".
  if (saved.agents && !saved.scorecards) state.agents = saved.agents;
  if (saved.source?.dir && existsSync(saved.source.dir)) {
    setSource(saved.source.dir, saved.source.testCommand);
    if (saved.connection) VALUES.connection.set(saved.connection);
    if (saved.pains) VALUES.pains.set(saved.pains);
    if (saved.sync) VALUES.sync.set(saved.sync);
  }
  VALUES.modelCost.set(saved.modelCost);
  if (saved.credits) VALUES.credits.set(saved.credits);
  VALUES.billing.set(saved.billing);
  VALUES.recentRepos.set(saved.recentRepos);
  VALUES.trialSpend.set(saved.trialSpend);
  VALUES.useTeamPlan.set(saved.useTeamPlan);

  // A fresh or imported store gets everything written now; otherwise only
  // what changes from here on.
  last = saved.empty || saved.imported ? null : snapshot();
  if (!last) await saveState();
  return !saved.empty || Boolean(saved.imported);
}

// Balances from before credits moved into the state store.
function legacyCredits() {
  const file = path.join(DATA_DIR, "credits.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

// Whatever's left when the process is asked to stop.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => saveState().finally(() => process.exit(0)));
}

setInterval(() => saveState().catch((err) => console.error(`Couldn't save state: ${err.message}`)), SAVE_EVERY_MS).unref();
