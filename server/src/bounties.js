// Bounty lifecycle:
//   awaiting_funding -> open -> bidding -> awarded -> working -> verifying -> settled | failed
// The reward sits in escrow (Stripe hold or simulated) before any work starts.
// If the winning agent's patch fails verification, the bounty moves on to the
// next-best bidder. Nobody gets paid unless the verifier says the fix is real:
// a verified fix charges the escrow, no verified fix releases it.
import { AGENTS, getAgent, requestBid, requestFix, requestModelFix } from "./agents.js";
import { MODELS, costPerFix, providerLabel } from "./trials.js";
import { balanceCents, fixPriceCents } from "./credits.js";
import { verify } from "./verifier.js";
import { emit } from "./events.js";
import { state, newId } from "./store.js";
import { writeFiles, WORKSPACE } from "./repo.js";
import { openPullRequest } from "./github.js";
import { chargeEscrow, newEscrow, releaseEscrow } from "./escrow.js";

const TAKE_RATE = 0.15;

// funding: "stripe" (team pays through Checkout) or "simulated" (fake money).
// apiModel + trialId: the team approved a model from the MCP trials, so that
// model runs through the API instead of the agents bidding.
export function createBounty({ painId, reward, funding = "simulated", apiModel = null, trialId = null }) {
  const pain = state.pains.find((p) => p.id === painId);
  if (!pain) throw httpError(404, `Unknown pain ${painId}`);
  if (pain.healthy) throw httpError(400, `${pain.testFile} isn't flaky; nothing to fix`);
  // Credit runs carry the estimated fix price (can be cents); bounties a reward.
  const amount = funding === "credits" ? Number(reward) : Math.round(Number(reward) || pain.suggestedReward);
  if (funding !== "credits" && (amount < 1 || amount > 10_000)) throw httpError(400, "Reward must be between $1 and $10,000");
  const bounty = {
    id: newId("bounty"),
    painId,
    title: `Make ${pain.testFile} reliable`,
    reward: amount,
    escrow: newEscrow(amount, funding),
    bids: [],
    attempts: [],
    winner: null,
    apiModel,
    trialId,
    apiCost: 0,
    createdAt: new Date().toISOString(),
  };
  bounty.status = bounty.escrow.status === "held" ? "open" : "awaiting_funding";
  state.bounties.unshift(bounty);
  emit("bounty.created", {
    bountyId: bounty.id,
    reward: bounty.reward,
    message:
      funding === "credits"
        ? `API fix approved: ${MODELS[apiModel].name} will ${bounty.title.replace(/^Make/, "make")} (about $${amount.toFixed(2)} from credits, only if verified)`
        : `New bounty: $${bounty.reward} to ${bounty.title}${bounty.status === "awaiting_funding" ? " (waiting for Stripe funding)" : ""}`,
  });
  return bounty;
}

export async function collectBids(bountyId) {
  const bounty = getBounty(bountyId);
  const pain = painFor(bounty);
  bounty.status = "bidding";
  emit("bounty.bidding", { bountyId, message: `Agents are reviewing ${pain.testFile}` });

  await Promise.all(
    AGENTS.map(async (agent) => {
      try {
        const bid = await requestBid(agent, bounty, pain);
        if (!bid.bid || bid.price > bounty.reward) {
          emit("bid.passed", { bountyId, agentId: agent.id, message: `${agent.name} passed` });
          return;
        }
        const entry = { agentId: agent.id, price: Math.round(bid.price), confidence: clamp01(bid.confidence), plan: bid.plan, score: 0 };
        entry.score = scoreBid(entry);
        bounty.bids.push(entry);
        emit("bid.placed", { bountyId, ...entry, message: `${agent.name} bid $${entry.price} (${Math.round(entry.confidence * 100)}% confident)` });
      } catch (err) {
        emit("bid.error", { bountyId, agentId: agent.id, message: `${agent.name} errored: ${err.message}` });
      }
    }),
  );

  bounty.bids.sort((a, b) => b.score - a.score);
  bounty.status = bounty.bids.length ? "awarding" : "failed";
  return bounty;
}

// Runs bidders best-first until one passes verification or we run out.
export async function runBounty(bountyId) {
  const bounty = getBounty(bountyId);
  const pain = painFor(bounty);
  if (bounty.escrow.status !== "held") throw httpError(402, "Fund this bounty before agents can work on it");
  if (bounty.apiModel) return runApprovedModel(bounty, pain);
  if (!bounty.bids.length) await collectBids(bountyId);
  if (!bounty.bids.length) return fail(bounty, "No agent bid on this bounty. Hold released, $0 charged.");

  for (const bid of bounty.bids) {
    if (bounty.attempts.some((a) => a.agentId === bid.agentId)) continue;
    const agent = getAgent(bid.agentId);
    const card = state.agents[agent.id];
    bounty.status = "working";
    emit("bounty.awarded", { bountyId, agentId: agent.id, price: bid.price, message: `${agent.name} won at $${bid.price} and is working in a sandbox` });

    let fix;
    try {
      fix = await requestFix(agent, bounty, pain, bid);
    } catch (err) {
      bounty.attempts.push({ agentId: agent.id, passed: false, reason: err.message });
      emit("work.error", { bountyId, agentId: agent.id, message: `${agent.name} failed to deliver: ${err.message}` });
      continue;
    }
    emit("work.submitted", {
      bountyId,
      agentId: agent.id,
      files: fix.files.map((f) => f.path),
      message: `${agent.name} submitted a patch: ${fix.summary}`,
    });

    bounty.status = "verifying";
    const stableTestFiles = state.pains.filter((p) => p.healthy).map((p) => p.testFile);
    const result = await verify({ bountyId, agentId: agent.id, testFile: pain.testFile, files: fix.files, stableTestFiles });
    card.jobs += 1;
    bounty.attempts.push({
      agentId: agent.id,
      price: bid.price,
      summary: fix.summary,
      files: fix.files,
      passed: result.passed,
      reason: result.reason ?? null,
      runs: result.runs.map((r) => r.passed),
    });

    if (result.passed) {
      await writeFiles(WORKSPACE, fix.files);
      await settle(bounty, pain, agent, bid);
      await surfacePullRequest(bounty, pain, agent, fix);
      return bounty;
    }
    card.rollbacks += 1;
  }

  return fail(bounty, "No agent delivered a verified fix. Hold released, $0 charged.");
}

const API_ATTEMPTS = 3;

// The paid round: the approved model fixes the problem through the API with
// Shoal driving, retrying with the verifier's failure output. Same rules as
// any bounty: charged only if a fix is verified, otherwise the hold is released.
async function runApprovedModel(bounty, pain) {
  const name = MODELS[bounty.apiModel].name;
  const payee = { id: bounty.apiModel, name, builder: providerLabel(bounty.apiModel) };
  const trial = state.trials.find((t) => t.id === bounty.trialId);
  let lastFailure = null;

  for (let attempt = 1; attempt <= API_ATTEMPTS; attempt++) {
    // Don't start an attempt the team's credits couldn't pay for if it passes.
    if (bounty.escrow.mode === "credits" && fixPriceCents(bounty.apiCost + costPerFix(bounty.apiModel)) > balanceCents()) {
      return fail(bounty, `Not enough credits for ${attempt > 1 ? "another" : "an"} attempt. Nothing charged; buy credits to continue.`);
    }
    bounty.status = "working";
    emit("bounty.awarded", {
      bountyId: bounty.id,
      agentId: bounty.apiModel,
      message: `${name} is fixing ${pain.testFile} through the API (attempt ${attempt}/${API_ATTEMPTS})`,
    });
    let fix;
    try {
      const out = await requestModelFix(bounty.apiModel, bounty, pain, { trial, lastFailure });
      fix = out.fix;
      bounty.apiCost += out.cost;
    } catch (err) {
      bounty.apiCost += err.cost ?? 0;
      bounty.attempts.push({ agentId: bounty.apiModel, passed: false, reason: err.message });
      emit("work.error", { bountyId: bounty.id, agentId: bounty.apiModel, message: `${name} failed to deliver: ${err.message}` });
      lastFailure = err.message;
      continue;
    }
    emit("work.submitted", {
      bountyId: bounty.id,
      agentId: bounty.apiModel,
      files: fix.files.map((f) => f.path),
      message: `${name} submitted a patch: ${fix.summary} (API cost so far $${bounty.apiCost.toFixed(4)})`,
    });

    bounty.status = "verifying";
    const stableTestFiles = state.pains.filter((p) => p.healthy).map((p) => p.testFile);
    const result = await verify({ bountyId: bounty.id, agentId: name, testFile: pain.testFile, files: fix.files, stableTestFiles });
    bounty.attempts.push({
      agentId: bounty.apiModel,
      price: bounty.reward,
      summary: fix.summary,
      files: fix.files,
      passed: result.passed,
      reason: result.reason ?? null,
      runs: result.runs.map((r) => r.passed),
    });
    if (result.passed) {
      await writeFiles(WORKSPACE, fix.files);
      await settle(bounty, pain, payee, { price: bounty.reward });
      await surfacePullRequest(bounty, pain, payee, fix);
      return bounty;
    }
    lastFailure = [result.reason, result.failureLog].filter(Boolean).join("\n");
  }
  return fail(bounty, `${name} didn't deliver a verified fix in ${API_ATTEMPTS} tries. $0 charged.`);
}

async function fail(bounty, message) {
  bounty.status = "failed";
  try {
    await releaseEscrow(bounty);
  } catch (err) {
    emit("escrow.error", { bountyId: bounty.id, message: `Couldn't release the Stripe hold: ${err.message}` });
  }
  emit("bounty.failed", { bountyId: bounty.id, message });
  return bounty;
}

async function settle(bounty, pain, agent, bid) {
  let charged;
  try {
    charged = await chargeEscrow(bounty, bid.price);
  } catch (err) {
    // The fix is real but we couldn't collect: don't pay the agent from thin air.
    bounty.escrow.status = "charge_failed";
    bounty.status = "payment_failed";
    emit("escrow.error", { bountyId: bounty.id, message: `Fix verified but the charge failed: ${err.message}` });
    return bounty;
  }
  // Credit runs: the API cost goes to the model provider, the rest is Shoal's fee.
  const credits = bounty.escrow.mode === "credits";
  // Kept to 4 decimals: fixes can cost fractions of a cent.
  const round4 = (n) => Math.round(n * 1e4) / 1e4;
  const fee = credits ? round4(charged - bounty.apiCost) : Math.round(charged * TAKE_RATE);
  const entry = {
    id: newId("tx"),
    bountyId: bounty.id,
    agentId: agent.id,
    amount: charged,
    agentPayout: round4(charged - fee),
    platformFee: fee,
    savedUnderReward: credits ? 0 : bounty.reward - charged,
    funding: bounty.escrow.mode,
    paymentIntentId: bounty.escrow.paymentIntentId,
    hoursReturnedPerWeek: pain.hoursPerWeek,
    apiModel: bounty.apiModel,
    apiCost: bounty.apiCost,
    settledAt: new Date().toISOString(),
  };
  state.ledger.unshift(entry);
  // Persona agents keep a scorecard; an approved API model doesn't have one.
  const card = state.agents[agent.id];
  if (card) {
    card.wins += 1;
    card.earnings += entry.agentPayout;
  }
  bounty.status = "settled";
  bounty.winner = agent.id;
  emit("bounty.settled", {
    bountyId: bounty.id,
    agentId: agent.id,
    amount: entry.amount,
    hoursReturnedPerWeek: entry.hoursReturnedPerWeek,
    message: `SETTLED: ${agent.name} paid $${entry.amount}. ~${entry.hoursReturnedPerWeek} dev-hours/week returned`,
  });
  return bounty;
}

// Only the winning, verified fix ever reaches the team: as a PR on the
// connected GitHub repo, when the token has write access.
async function surfacePullRequest(bounty, pain, agent, fix) {
  const repo = state.connection;
  if (repo.type !== "github") return;
  if (!repo.canWrite) {
    emit("pr.skipped", { bountyId: bounty.id, message: `Fix verified but not pushed: GITHUB_TOKEN can't write to ${repo.fullName}` });
    return;
  }
  const attempt = bounty.attempts.find((a) => a.agentId === agent.id && a.passed);
  const body = [
    `**Shoal bounty ${bounty.id}**: ${bounty.title}`,
    "",
    `Fixed by **${agent.name}** (${agent.builder}). ${fix.summary}`,
    "",
    "### Verification",
    `- Before: \`${pain.testFile}\` failed ${pain.failures}/${pain.runs} runs`,
    `- After: ${attempt.runs.filter(Boolean).length}/${attempt.runs.length} green, previously stable tests still passing`,
    "- Only non-test files were changed (tests, CI config and manifests are protected)",
    `- Estimated time returned: ~${pain.hoursPerWeek} dev-hours/week`,
  ].join("\n");
  try {
    const pr = await openPullRequest(repo, {
      branch: `shoal/${bounty.id}-${agent.id}`,
      title: `[Shoal] ${bounty.title}`,
      body,
      files: fix.files,
    });
    bounty.pullRequest = pr;
    emit("pr.opened", { bountyId: bounty.id, url: pr.url, message: `Opened PR #${pr.number} on ${repo.fullName}` });
  } catch (err) {
    emit("pr.error", { bountyId: bounty.id, message: `Couldn't open PR: ${err.message}` });
  }
}

// Value per dollar, weighted by the agent's verified track record.
function scoreBid(bid) {
  const card = state.agents[bid.agentId];
  const reputation = (card.wins + 1) / (card.jobs + 2);
  return (bid.confidence * reputation * 1000) / bid.price;
}

export function leaderboard() {
  return AGENTS.map((a) => {
    const c = state.agents[a.id];
    return {
      ...a,
      ...c,
      successRate: c.jobs ? c.wins / c.jobs : 0,
      rollbackRate: c.jobs ? c.rollbacks / c.jobs : 0,
    };
  }).sort((a, b) => b.earnings - a.earnings);
}

export function morningSettlement() {
  const settled = state.ledger;
  return {
    bountiesSettled: settled.length,
    bountiesFailed: state.bounties.filter((b) => b.status === "failed").length,
    heldInEscrow: state.bounties.filter((b) => b.escrow?.status === "held").reduce((s, b) => s + b.escrow.amount, 0),
    totalPaid: settled.reduce((s, t) => s + t.amount, 0),
    platformRevenue: settled.reduce((s, t) => s + t.platformFee, 0),
    hoursReturnedPerWeek: Math.round(settled.reduce((s, t) => s + t.hoursReturnedPerWeek, 0) * 10) / 10,
    topEarner: leaderboard()[0]?.name ?? null,
  };
}

export function getBounty(id) {
  const bounty = state.bounties.find((b) => b.id === id);
  if (!bounty) throw httpError(404, `Unknown bounty ${id}`);
  return bounty;
}

function painFor(bounty) {
  return state.pains.find((p) => p.id === bounty.painId);
}

const clamp01 = (n) => Math.min(1, Math.max(0, Number(n) || 0));

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
