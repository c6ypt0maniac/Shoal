// App state. Most of it is in memory; bounties, the ledger, scorecards and
// the connection are also saved to disk (see persist.js).
import { randomBytes } from "node:crypto";

export const DEMO_CONNECTION = { type: "demo", fullName: "demo-repo (bundled)", canWrite: false };

export const state = {
  // "team" (has dev pain, posts bounties) or "builder" (publishes agents).
  role: null,
  // Which repo Shoal is pointed at; GitHub repos also carry defaultBranch/url.
  connection: DEMO_CONNECTION,
  // Real GitHub Actions telemetry for the connected repo (informational).
  ci: [],
  pains: [],
  bounties: [],
  ledger: [],
  // Trial fixes submitted over MCP, verified but never applied (see trials.js).
  trials: [],
  // The latest one-click trial run (Claude Code and Codex, see trial-runner.js).
  trialRun: null,
  // Proof reports keyed by trial id (see proof.js).
  proofs: {},
  // Test files the scan found but can't run here (toolchain missing).
  cantRun: [],
  // Auto-sync with GitHub (see sync.js).
  sync: { auto: true, checkedAt: null, syncedAt: null, waiting: null, error: null },
  // Measured API cost per fix for each model, from the latest trial run.
  // Kept across resets: it describes the models, not one repo.
  modelCost: {},
  // Public scorecards, built only from real outcomes (see bounties.js,
  // survival.js). Keyed by persona agent id or model id. Kept across resets:
  // they describe the agents, not one repo.
  agents: {},
  // Marketplace listings Shoal doesn't ship with: models imported from
  // OpenRouter and agents builders published (see marketplace.js).
  listings: [],
  // Verified-buyer reviews and their helpful votes (see reviews.js).
  reviews: [],
  reviewVotes: [],
  // Prepaid credits (see credits.js).
  credits: null,
  // Each GitHub account's saved payment method (see billing.js).
  billing: {},
  // GitHub repos connected before, most recent first (repos.js).
  recentRepos: [],
};

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
export function cardFor(id) {
  const card = (state.agents[id] ??= {});
  for (const k of ["attempts", "delivered", "verified", "verifiedMs", "wins", "survived", "clawbacks", "earned", "paid"]) card[k] ??= 0;
  return card;
}

// Switching repos: the scan, trials and proofs were about the old repo.
// Bounties and the ledger stay (each bounty keeps its own repo, repos.js).
export function resetRepoState() {
  state.pains = [];
  state.trials = [];
  state.trialRun = null;
  state.proofs = {};
  state.cantRun = [];
}

// Clears bounty activity; the connection and its CI telemetry are kept.
export function resetState() {
  state.pains = [];
  state.bounties = [];
  state.ledger = [];
  state.trials = [];
  state.trialRun = null;
  state.proofs = {};
  state.cantRun = [];
}
