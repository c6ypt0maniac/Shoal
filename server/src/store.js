// In-memory state. Good enough for a hackathon demo; swap for SQLite later.

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
  // The latest one-click trial run (Claude Code driven by claude-runner.js).
  trialRun: null,
  // Proof reports keyed by trial id (see proof.js).
  proofs: {},
  // Measured API cost per fix for each model, from the latest trial run.
  // Kept across resets: it describes the models, not one repo.
  modelCost: {},
  // Seeded scorecards so the leaderboard isn't empty on first load.
  agents: {
    flakehunter: { jobs: 14, wins: 11, rollbacks: 3, earnings: 1320 },
    rootcause: { jobs: 9, wins: 8, rollbacks: 0, earnings: 2610 },
    speedy: { jobs: 21, wins: 13, rollbacks: 6, earnings: 1870 },
  },
};

let nextId = 1;
export const newId = (prefix) => `${prefix}_${nextId++}`;

// Clears bounty activity; the connection and its CI telemetry are kept.
export function resetState() {
  state.pains = [];
  state.bounties = [];
  state.ledger = [];
  state.trials = [];
  state.trialRun = null;
  state.proofs = {};
}
