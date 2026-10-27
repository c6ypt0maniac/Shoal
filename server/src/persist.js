// Durable state: what has to outlive a restart because it spans days or
// involves money. Per user: bounties (and their survival windows), the
// ledger, credits, the repo connection and its last scan. Shared: agent
// scorecards, marketplace listings, reviews, helpful votes, measured model
// costs, saved cards, libraries and sign-in sessions. Trials and proofs are
// kept per user as a convenience; they're rebuilt by running them again.
//
// Two backends, same data:
//   Supabase Postgres  when SUPABASE_DB_URL is set. Shoal creates its own
//                      schema (SHOAL_DB_SCHEMA, default "shoal") and tables
//                      at startup. The schema isn't exposed through
//                      Supabase's public API, so browser keys can't read it;
//                      only this server, with the database password, can.
//                      User rows carry an owner column (the GitHub login).
//   JSON file          otherwise: .data/state.json (gitignored).
//
// The app works on the in-memory copy in store.js. Shared state is loaded at
// startup; a user's workspace is loaded the first time they show up
// (openWorkspace), plus, at startup, every user with work still running, so
// survival windows keep being checked. Changed rows are written back every
// few seconds, or right away when a caller awaits saveState. One
// server instance at a time: two would overwrite each other.
//
// Data from before Shoal had users belongs to SHOAL_LEGACY_OWNER (a GitHub
// login), or to the local user when that's unset.
import { suggestReward } from "./scanner.js";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LOCAL, onOpen, openWorkspace, state, withWorkspace, workspaces } from "./store.js";
import { getSource, setSource } from "./repo.js";
import { loadLibraries } from "./library.js";
import { savedSessions } from "./sessions.js";

const DATA_DIR = process.env.SHOAL_DATA_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.data");
const FILE = path.join(DATA_DIR, "state.json");
const SAVE_EVERY_MS = 3000;
const SCHEMA = process.env.SHOAL_DB_SCHEMA || "shoal";
if (!/^[a-z_][a-z0-9_]*$/.test(SCHEMA)) throw new Error(`SHOAL_DB_SCHEMA must be a plain lowercase name, not "${SCHEMA}"`);

// Row collections: each item becomes one row keyed by `key`. `columns` are
// copied out of the JSON into real columns, for constraints and for anyone
// querying the database directly. `user`: one set of rows per user (the
// current workspace's), with an owner column.
const COLLECTIONS = {
  bounties: {
    user: true,
    get: () => state.bounties,
    set: (rows) => (state.bounties = rows.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))),
    key: (b) => b.id,
    columns: { status: (b) => b.status, test_file: (b) => b.testFile, winner: (b) => b.winner },
  },
  ledger: {
    user: true,
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
  sessions: {
    get: () => savedSessions(state.sessions),
    set: (rows) => (state.sessions = rows),
    key: (s) => s.id,
    columns: { login: (s) => s.login },
  },
};

// Single values: one row each in the kv table (shared) or user_kv (per user).
const VALUES = {
  connection: { user: true, get: () => state.connection, set: (v) => (state.connection = v) },
  // The last scan: the bounties page lists bounties under their flaky test.
  // Suggested rewards are recomputed, so a saved scan picks up a change to the formula.
  pains: { user: true, get: () => state.pains, set: (v) => (state.pains = (v ?? []).map((p) => ({ ...p, suggestedReward: suggestReward(p.hoursPerWeek ?? 0) }))) },
  source: { user: true, get: () => ({ dir: getSource().dir, testCommand: getSource().testCommand }), set: () => {} },
  sync: { user: true, get: () => ({ auto: state.sync?.auto ?? true }), set: (v) => (state.sync = { ...state.sync, auto: v.auto }) },
  role: { user: true, get: () => state.role, set: (v) => (state.role = v ?? null) },
  trials: { user: true, get: () => state.trials, set: (v) => (state.trials = (v ?? []).map(t => t.status === 'verifying' ? { ...t, status: 'failed', reason: 'Verification was interrupted by a server restart. Run this model again.' } : t)) },
  proofs: { user: true, get: () => Object.fromEntries(Object.entries(state.proofs).filter(([,p]) => p.status === 'done')), set: (v) => (state.proofs = v ?? {}) },
  usage: { user: true, get: () => state.usage, set: (v) => (state.usage = v ?? {}) },
  recentRepos: { user: true, get: () => state.recentRepos, set: (v) => (state.recentRepos = v ?? []) },
  trialSpend: { user: true, get: () => state.trialSpend, set: (v) => (state.trialSpend = v ?? {}) },
  modelCost: { get: () => state.modelCost, set: (v) => (state.modelCost = v ?? {}) },
  billing: { get: () => state.billing, set: (v) => (state.billing = v ?? {}) },
  libraries: { get: () => state.libraries, set: (v) => (state.libraries = loadLibraries(v)) },
};
const pick = (o, user) => Object.entries(o).filter(([, c]) => Boolean(c.user) === user);
const USER_ROWS = pick(COLLECTIONS, true), SHARED_ROWS = pick(COLLECTIONS, false);
const USER_VALUES = pick(VALUES, true), SHARED_VALUES = pick(VALUES, false);

// Bounty statuses with work still under way: their owners are loaded at
// startup so races recover and survival windows keep being checked.
const RUNNING = ["diagnosing", "awaiting_go_ahead", "competing", "verifying", "judging", "surviving"];
const LEGACY_OWNER = () => process.env.SHOAL_LEGACY_OWNER?.trim() || LOCAL;

// Real columns and constraints per table, on top of id + data.
const DDL = {
  bounties: "status text, test_file text, winner text, owner text",
  ledger: "bounty_id text, agent_id text, status text, owner text",
  scorecards: "",
  listings: "kind text, provider text, owner text",
  // One review per bounty; stars 1-5.
  reviews: "listing_id text not null, bounty_id text not null unique, reviewer text not null, stars int not null check (stars between 1 and 5)",
  review_votes: "review_id text not null, voter text not null, unique (review_id, voter)",
  sessions: "login text not null",
};

// For blobs.js: the Supabase connection (null without one), and where files go otherwise.
export const database = () => pool;
export const dataDir = () => DATA_DIR;
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
    await client.query(`create table if not exists ${q("user_kv")} (owner text not null, key text not null, value jsonb, updated_at timestamptz not null default now(), primary key (owner, key))`);
    // Tables from before Shoal had users: add the owner column, give
    // unowned rows and per-user kv values to the legacy owner.
    for (const [name] of USER_ROWS) {
      await client.query(`alter table ${q(name)} add column if not exists owner text`);
      await client.query(`update ${q(name)} set owner = $1 where owner is null`, [LEGACY_OWNER()]);
      await client.query(`create index if not exists ${name}_owner on ${q(name)} (owner)`);
    }
    const legacy = USER_VALUES.map(([name]) => name);
    await client.query(
      `insert into ${q("user_kv")} (owner, key, value) select $1, key, value from ${q("kv")} where key = any($2) on conflict do nothing`,
      [LEGACY_OWNER(), legacy],
    );
    await client.query(`delete from ${q("kv")} where key = any($1)`, [legacy]);
    // Keep it off Supabase's public (anon/authenticated) API.
    await client.query(`revoke all on schema "${SCHEMA}" from anon, authenticated`).catch(() => {});
  } finally {
    client.release();
  }
}

async function loadSharedPostgres() {
  const saved = {};
  for (const [name] of SHARED_ROWS) saved[name] = (await pool.query(`select data from ${q(name)}`)).rows.map((r) => r.data);
  const kv = Object.fromEntries((await pool.query(`select key, value from ${q("kv")}`)).rows.map((r) => [r.key, r.value]));
  return { ...saved, ...kv, empty: !Object.keys(kv).length && Object.values(saved).every((rows) => !rows.length) };
}

async function loadUserPostgres(login) {
  const saved = {};
  for (const [name] of USER_ROWS) saved[name] = (await pool.query(`select data from ${q(name)} where owner = $1`, [login])).rows.map((r) => r.data);
  for (const r of (await pool.query(`select key, value from ${q("user_kv")} where owner = $1`, [login])).rows) saved[r.key] = r.value;
  // Nothing saved yet: a new user, written in full on the first save.
  return Object.values(saved).some((v) => !Array.isArray(v) || v.length) ? saved : {};
}

const runningOwnersPostgres = async () =>
  (await pool.query(`select distinct owner from ${q("bounties")} where status = any($1) and owner is not null`, [RUNNING])).rows.map((r) => r.owner);

// Writes only what changed since the last save, in one transaction.
async function savePostgres(changes) {
  if (!changes.length) return;
  const client = await pool.connect();
  try {
    await client.query("begin");
    for (const c of changes) {
      if (c.kind === "value") {
        if (c.owner) await client.query(`insert into ${q("user_kv")} (owner, key, value, updated_at) values ($1, $2, $3, now()) on conflict (owner, key) do update set value = excluded.value, updated_at = now()`, [c.owner, c.name, c.json]);
        else await client.query(`insert into ${q("kv")} (key, value, updated_at) values ($1, $2, now()) on conflict (key) do update set value = excluded.value, updated_at = now()`, [c.name, c.json]);
      } else if (c.op === "delete") {
        await client.query(`delete from ${q(c.name)} where id = $1${c.owner ? " and owner = $2" : ""}`, c.owner ? [c.id, c.owner] : [c.id]);
      } else {
        const cols = Object.entries(COLLECTIONS[c.name].columns);
        if (c.owner) cols.push(["owner", () => c.owner]);
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
}

// --- JSON file ----------------------------------------------------------------------
// { version: 3, <shared collections and values>, users: { login: { <user rows and values> } } }

let fileUsers = {}; // what the file holds per user, for users not loaded yet

function loadFile() {
  if (!existsSync(FILE)) return { empty: true, users: {} };
  const saved = JSON.parse(readFileSync(FILE, "utf8"));
  if ((saved.version ?? 1) < 3) {
    // Before users: the per-user parts sat at the top level.
    const legacy = Object.fromEntries([...USER_ROWS, ...USER_VALUES].map(([name]) => [name, saved[name]]).filter(([, v]) => v != null));
    for (const name of Object.keys(legacy)) delete saved[name];
    saved.users = { [LEGACY_OWNER()]: legacy };
  }
  saved.users ??= {};
  return saved;
}

async function saveFile() {
  const out = { version: 3 };
  for (const [name, c] of SHARED_ROWS) out[name] = c.get();
  for (const [name, v] of SHARED_VALUES) out[name] = v.get() ?? null;
  out.users = { ...fileUsers };
  for (const ws of saveable()) out.users[ws.login] = withWorkspace(ws, userObject);
  await mkdir(DATA_DIR, { recursive: true });
  // Write then rename, so a crash mid-write can't corrupt anything.
  await writeFile(FILE + ".tmp", JSON.stringify(out));
  await rename(FILE + ".tmp", FILE);
}

const userObject = () => Object.fromEntries([...USER_ROWS.map(([name, c]) => [name, c.get()]), ...USER_VALUES.map(([name, v]) => [name, v.get() ?? null])]);

// --- Change tracking ------------------------------------------------------------------
// One snapshot for the shared state and one per workspace (ws.locals.saved).

let lastShared = null;

function snapshot(rowsOf, valuesOf) {
  const rows = {};
  for (const [name, c] of rowsOf) rows[name] = new Map(c.get().map((item) => [c.key(item), { item, json: JSON.stringify(item) }]));
  const values = {};
  for (const [name, v] of valuesOf) {
    const value = v.get();
    values[name] = value === undefined ? undefined : JSON.stringify(value);
  }
  return { rows, values };
}

function diff(snap, last, owner = null) {
  const out = [];
  for (const [name, rows] of Object.entries(snap.rows)) {
    const before = last?.rows[name] ?? new Map();
    for (const [id, r] of rows) if (before.get(id)?.json !== r.json) out.push({ name, id, item: r.item, json: r.json, op: "upsert", owner });
    for (const id of before.keys()) if (!rows.has(id)) out.push({ name, id, op: "delete", owner });
  }
  for (const [name, json] of Object.entries(snap.values)) if (json !== undefined && last?.values[name] !== json) out.push({ kind: "value", name, json, owner });
  return out;
}

// Workspaces whose data is saved: every open one except a deployed server's
// signed-out stand-in (index.js), which has nothing of anyone's.
const saveable = () => workspaces().filter((ws) => !ws.unsaved);

// --- Public ---------------------------------------------------------------------------

let saving = Promise.resolve();

async function saveNow() {
  const shared = snapshot(SHARED_ROWS, SHARED_VALUES);
  const users = saveable().map((ws) => ({ ws, snap: withWorkspace(ws, () => snapshot(USER_ROWS, USER_VALUES)) }));
  const changes = [diff(shared, lastShared), ...users.map(({ ws, snap }) => diff(snap, ws.locals.saved, ws.login))].flat();
  if (!changes.length) return;
  if (pool) await savePostgres(changes);
  else await saveFile();
  lastShared = shared;
  for (const { ws, snap } of users) ws.locals.saved = snap;
}

// Writes whatever changed, for everyone. Saves are queued, so a caller can
// await "my change is stored" (credits do, before they report success).
export function saveState() {
  saving = saving.catch(() => {}).then(saveNow);
  return saving;
}

// A user's saved data -> their workspace (the current one). A GitHub clone
// that's gone from disk falls back to the demo repo; its bounties are kept
// but can't be checked until the repo is connected again.
function restoreUser(saved, ws) {
  for (const [name, c] of USER_ROWS) if (Array.isArray(saved[name])) c.set(saved[name]);
  if (saved.source?.dir && existsSync(saved.source.dir)) {
    setSource(saved.source.dir, saved.source.testCommand);
    for (const name of ["connection", "pains", "sync", "trials", "proofs"]) if (saved[name]) VALUES[name].set(saved[name]);
  }
  // (Older saves also have "credits": prepaid balances from before trials were free; ignored.)
  for (const name of ["role", "usage", "recentRepos", "trialSpend"]) if (saved[name] != null) VALUES[name].set(saved[name]);
  // A brand-new user has nothing to compare against: written on first change.
  ws.locals.saved = saved.fresh ? null : snapshot(USER_ROWS, USER_VALUES);
  return Object.keys(saved).some((k) => k !== "fresh");
}

// Loads a workspace's saved data the first time it's opened (store.js).
onOpen(async (ws) => {
  if (ws.unsaved) return;
  // From the JSON file (no Supabase, or importing it into Supabase), else Supabase.
  const saved = fileUsers[ws.login] ?? (pool ? await loadUserPostgres(ws.login) : {});
  delete fileUsers[ws.login];
  ws.restored = restoreUser(Object.keys(saved).length ? saved : { fresh: true }, ws);
});

// Connects (creating the schema on Supabase if needed), loads the shared
// state, then opens the workspace of every user with work still running.
// Returns those workspaces.
export async function loadState() {
  if (process.env.SUPABASE_DB_URL) {
    try {
      await connectPostgres();
    } catch (err) {
      throw new Error(`Couldn't connect to Supabase (SUPABASE_DB_URL): ${err.message.replace(/postgres(ql)?:\/\/[^@]*@/g, "postgresql://…@")}`);
    }
  }
  let saved = pool ? await loadSharedPostgres() : loadFile();
  // First start on Supabase: bring over what the JSON file had.
  const imported = pool && saved.empty && existsSync(FILE);
  if (imported) saved = loadFile();
  if (!pool || imported) fileUsers = saved.users ?? {};

  for (const [name, c] of SHARED_ROWS) if (Array.isArray(saved[name])) c.set(saved[name]);
  // Before version 2 the scorecards were saved under "agents".
  if (saved.agents && !saved.scorecards) state.agents = saved.agents;
  for (const [name, v] of SHARED_VALUES) v.set(saved[name]);
  lastShared = saved.empty || imported ? null : snapshot(SHARED_ROWS, SHARED_VALUES);

  const owners = imported ? Object.keys(fileUsers) : pool ? await runningOwnersPostgres() : Object.entries(fileUsers).filter(([, u]) => (u.bounties ?? []).some((b) => RUNNING.includes(b.status))).map(([login]) => login);
  const opened = [];
  for (const login of owners) {
    const ws = await openWorkspace(login);
    if (imported) ws.locals.saved = null; // write all of it to Supabase
    opened.push(ws);
  }
  if (!lastShared || imported) await saveState();
  if (imported) fileUsers = {};
  return opened;
}

// Whatever's left when the process is asked to stop.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => saveState().finally(() => process.exit(0)));
}

setInterval(() => saveState().catch((err) => console.error(`Couldn't save state: ${err.message}`)), SAVE_EVERY_MS).unref();
