// App state. Most of it is in memory; bounties, the ledger, scorecards and
// the connection are also saved (see persist.js).
//
// Shoal has many users, each with their own workspace (one per GitHub login):
// their repo connection, scan, bounties, ledger, trials, usage... The
// marketplace is shared: scorecards, listings, reviews, measured model costs,
// and the per-login maps (billing, libraries). Every request runs inside its
// user's workspace (withWorkspace, set up by index.js from the session), so
// `state.bounties` is always the current user's bounties while
// `state.listings` is everyone's. Code that isn't serving a request (timers,
// startup) loops over workspaces() and runs each in withWorkspace.
import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

export const DEMO_CONNECTION = { type: "demo", fullName: "demo-repo (bundled)", canWrite: false };

// One user's part of the state, fresh.
export const userDefaults = () => ({
  // "team" (has dev pain, posts bounties) or "builder" (publishes agents).
  role: null,
  // Which repo Shoal is pointed at; GitHub repos also carry defaultBranch/url.
  connection: DEMO_CONNECTION,
  // Real GitHub Actions telemetry for the connected repo (informational).
  ci: [],
  pains: [],
  bounties: [],
  ledger: [],
  // Sealed trial fixes run on the user's API keys, verified but never applied
  // until the team authorizes one (trials.js, api-trials.js).
  trials: [],
  // Proof reports keyed by trial id (see proof.js).
  proofs: {},
  // Test files the scan found but can't run here (toolchain missing).
  cantRun: [],
  // Auto-sync with GitHub (see sync.js).
  sync: { auto: true, checkedAt: null, syncedAt: null, waiting: null, error: null },
  // Fair-use counts: when this user last started trials and scans (usage.js).
  usage: {},
  // GitHub repos connected before, most recent first (repos.js).
  recentRepos: [],
  // What was spent and earned per bug in sealed API trials (spend.js).
  trialSpend: {},
  // The sealed trial ladder per bug (api-trials.js).
  apiTrials: {},
});
export const USER_KEYS = new Set(Object.keys(userDefaults()));

const shared = {
  // Measured API cost per fix for each model, from the latest trial runs.
  // It describes the models, not one repo or user.
  modelCost: {},
  // Public scorecards, built only from real outcomes (see bounties.js,
  // survival.js). Keyed by persona agent id or model id.
  agents: {},
  // Marketplace listings Shoal doesn't ship with: models imported from
  // OpenRouter and agents builders published (see marketplace.js).
  listings: [],
  // Verified-buyer reviews and their helpful votes (see reviews.js).
  reviews: [],
  reviewVotes: [],
  // Each GitHub account's saved payment method (see billing.js).
  billing: {},
  // Each GitHub account's saved agents and pods (see library.js).
  libraries: {},
  // Signed-in browsers (see sessions.js).
  sessions: [],
};

// --- Workspaces --------------------------------------------------------------
// login -> { login, data, locals, token }. data: userDefaults() fields.
// locals: other per-user things modules keep in memory (see scoped).
// token: the user's GitHub token (github.js), from their session.

const current = new AsyncLocalStorage();
const open = new Map();

// Code with no signed-in user (startup, a signed-out page) gets this one: on
// a local server it's the one person using it ("local", saved like any
// other); deployed, it's an empty, unsaved stand-in that index.js keeps
// read-only.
export const LOCAL = "local";
const blank = (login) => ({ login, data: userDefaults(), locals: {}, token: null });
let guest = blank(LOCAL);
export const setGuest = (ws) => (guest = ws);

export const currentWorkspace = () => current.getStore() ?? guest;
export const withWorkspace = (ws, fn) => current.run(ws, fn);
export const workspaces = () => [...open.values()];
export const isOpen = (login) => open.has(login);

// Per-user module state: scoped("events", () => ({ ... })) is this user's copy.
export const scoped = (name, init) => (currentWorkspace().locals[name] ??= init());

// A user's workspace, loaded on first use. load(ws) fills it in (persist.js
// registers it, then index.js adds the startup steps: working copy, fixes...).
const opening = new Map();
const openers = [];
export const onOpen = (fn) => openers.push(fn);
export function openWorkspace(login) {
  if (open.has(login)) return Promise.resolve(open.get(login));
  if (!opening.has(login)) {
    const ws = login === LOCAL && guest.login === LOCAL ? guest : blank(login);
    const ready = (async () => {
      for (const fn of openers) await withWorkspace(ws, () => fn(ws));
      open.set(login, ws);
      return ws;
    })().finally(() => opening.delete(login));
    opening.set(login, ready);
  }
  return opening.get(login);
}
// Forgets a workspace that's been saved (account deletion, idle eviction).
export const closeWorkspace = (login) => open.delete(login);

// The current user's fields come from their workspace; the rest are shared.
export const state = new Proxy(shared, {
  get: (t, k) => (USER_KEYS.has(k) ? currentWorkspace().data[k] : t[k]),
  set: (t, k, v) => {
    if (USER_KEYS.has(k)) currentWorkspace().data[k] = v;
    else t[k] = v;
    return true;
  },
  has: (t, k) => USER_KEYS.has(k) || k in t,
  ownKeys: (t) => [...USER_KEYS, ...Reflect.ownKeys(t)],
  getOwnPropertyDescriptor: (t, k) => (USER_KEYS.has(k) ? { value: currentWorkspace().data[k], writable: true, enumerable: true, configurable: true } : Reflect.getOwnPropertyDescriptor(t, k)),
});

// Unique across restarts, since bounties and the ledger are kept on disk.
let nextId = 1;
const run = randomBytes(3).toString("hex");
export const newId = (prefix) => `${prefix}_${run}${nextId++}`;

// An agent's scorecard, created empty the first time it competes.
//   attempts  bounties it tried
//   verified  attempts whose fix passed the verifier
//   wins      verified attempts picked as the winner (surfaced to the team)
//   survived  wins that held through the survival window and were paid
//   clawbacks wins that regressed inside the window and were refunded
//   earned    payouts after Shoal's fee; paid: what teams paid for them
//   delivered attempts that returned a fix at all (the rest errored)
//   verifiedMs total time from start to verified fix, over verified attempts
//   verifiedLines total lines changed, over verified attempts
//   judged / judgedPassed  verified fixes both judges reviewed, and passed
//   diagnoses / diagnosesCorrect  diagnoses graded, and graded correct
//   spent         the team's tokens over every attempt ($)
//   spentVerified / pricedFixes  tokens over verified fixes whose spend was measured, and how many
//   overBid       attempts that spent more than their bid (bids.js)
export const CARD_COUNTS = ["attempts", "delivered", "verified", "verifiedMs", "verifiedLines", "judged", "judgedPassed", "diagnoses", "diagnosesCorrect", "wins", "survived", "clawbacks", "earned", "paid", "spent", "spentVerified", "pricedFixes", "overBid"];
export function cardFor(id) {
  const card = (state.agents[id] ??= {});
  for (const k of CARD_COUNTS) card[k] ??= 0;
  return card;
}

// Switching repos: the scan, trials and proofs were about the old repo.
// Bounties and the ledger stay (each bounty keeps its own repo, repos.js).
export function resetRepoState() {
  state.pains = [];
  state.trials = [];
  state.proofs = {};
  state.apiTrials = {};
  state.cantRun = [];
}

// Clears bounty activity; the connection and its CI telemetry are kept.
export function resetState() {
  state.pains = [];
  state.bounties = [];
  state.ledger = [];
  state.trials = [];
  state.proofs = {};
  state.apiTrials = {};
  state.cantRun = [];
}
