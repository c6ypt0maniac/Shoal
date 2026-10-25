// Bounty lifecycle:
//   awaiting_funding -> open -> competing -> verifying -> surviving -> settled
//                                                               \-> clawed_back
//   (or failed: no verified fix, hold released, $0 charged)
// The team sets the reward; it sits in escrow (Stripe hold, simulated, or
// prepaid credits) before any work starts. Agents never bid on price: every
// agent attempts the fix privately and in parallel, each in its own sandbox,
// and every attempt goes through the verifier. The verified ones are judged
// best scorecard first by two judges (Claude and OpenAI, see proof.js); the
// first that both pass wins, and only its fix reaches the team (as a PR). The team is charged then, but the agent is paid only after
// the fix survives its window (survival.js); a regression claws it back.
//
// A model approved from the MCP trials (apiModel) runs the same lifecycle,
// as the only competitor, paid from credits at API cost plus Shoal's fee.
import { AGENTS, requestModelFix } from "./agents.js";
import { attemptFix } from "./competitors.js";
import { checkCompetitors, nameFor } from "./marketplace.js";
import { getStacks } from "./repo.js";
import { stackFor } from "./stack.js";
import { MODELS, costPerFix, linesChanged, providerLabel } from "./trials.js";
import { balanceCents, fixPriceCents } from "./credits.js";
import { verify } from "./verifier.js";
import { emit } from "./events.js";
import { state, newId, cardFor } from "./store.js";
import { writeFiles, WORKSPACE } from "./repo.js";
import { openPullRequest } from "./github.js";
import { chargeEscrow, newEscrow, refundEscrow, releaseEscrow } from "./escrow.js";
import { cleanSurvivalDays, startSurvival } from "./survival.js";
import { judgeAttempt } from "./proof.js";

const TAKE_RATE = 0.15;
// Statuses where the bounty is finished, one way or another.
export const DONE = ["settled", "clawed_back", "failed", "payment_failed"];

// funding: "stripe" (team pays through Checkout), "simulated" (fake money)
// or "credits". apiModel + trialId: the team approved a model from the MCP
// trials, so that model runs through the API instead of the marketplace.
// survivalDays: 7, 10 or 14 before the agent is paid. competitors: the
// marketplace listings the team picked to compete (default: Shoal's
// built-in agents); only those get the team's code. postedBy: GitHub login.
export function createBounty({ painId, reward, funding = "simulated", apiModel = null, trialId = null, survivalDays, competitors, postedBy = null }) {
  const pain = state.pains.find((p) => p.id === painId);
  if (!pain) throw httpError(404, `Unknown pain ${painId}`);
  if (pain.healthy) throw httpError(400, `${pain.testFile} isn't flaky; nothing to fix`);
  // Credit runs carry the estimated fix price (can be cents); bounties a reward.
  const amount = funding === "credits" ? Number(reward) : Math.round(Number(reward) || pain.suggestedReward);
  if (funding !== "credits" && (amount < 1 || amount > 10_000)) throw httpError(400, "Reward must be between $1 and $10,000");
  const bounty = {
    id: newId("bounty"),
    painId,
    testFile: pain.testFile,
    title: `Make ${pain.testFile} reliable`,
    reward: amount,
    survivalDays: cleanSurvivalDays(survivalDays),
    competitors: apiModel ? [apiModel] : checkCompetitors(competitors ?? AGENTS.map((a) => a.id)),
    language: stackFor(getStacks(), pain.testFile)?.def?.language ?? null,
    postedBy,
    escrow: newEscrow(amount, funding),
    attempts: [],
    winner: null,
    survival: null,
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
        ? `API fix approved: ${MODELS[apiModel].name} will ${bounty.title.replace(/^Make/, "make")} (about $${amount.toFixed(2)} from credits, only if verified, refunded if it regresses within ${bounty.survivalDays} days)`
        : `New bounty: $${bounty.reward} to ${bounty.title}, paid only if the fix survives ${bounty.survivalDays} days${bounty.status === "awaiting_funding" ? " (waiting for Stripe funding)" : ""}`,
  });
  return bounty;
}

export async function runBounty(bountyId) {
  const bounty = getBounty(bountyId);
  const pain = painFor(bounty);
  if (bounty.escrow.status !== "held") throw httpError(402, "Fund this bounty before agents can work on it");
  if (bounty.status !== "open") return bounty; // already running or done
  if (!pain) throw httpError(409, `${bounty.testFile} isn't in the latest scan; scan the repo first`);
  return bounty.apiModel ? runApprovedModel(bounty, pain) : compete(bounty, pain);
}

// Every competitor the team picked attempts the bounty at once, privately.
// Nobody sees another's attempt, and the team only ever sees the winner's.
async function compete(bounty, pain) {
  const field = bounty.competitors;
  bounty.status = "competing";
  emit("bounty.competing", {
    bountyId: bounty.id,
    message: `${field.length} competitor${field.length > 1 ? "s are" : " is"} attempting ${pain.testFile} in private sandboxes. $${bounty.reward} goes to the best-ranked verified fix, after it survives ${bounty.survivalDays} days.`,
  });

  const fixes = await Promise.all(
    field.map(async (id) => {
      const card = cardFor(id);
      card.attempts += 1;
      const started = Date.now();
      try {
        const { fix, cost } = await attemptFix(id, bounty, pain);
        card.delivered += 1;
        bounty.apiCost += cost ?? 0;
        return { id, fix, started };
      } catch (err) {
        bounty.apiCost += err.cost ?? 0;
        bounty.attempts.push({ agentId: id, passed: false, reason: `No fix delivered: ${err.message}`, durationMs: Date.now() - started });
        emit("work.error", { bountyId: bounty.id, message: `An attempt on ${pain.testFile} didn't deliver a fix` });
        return null;
      }
    }),
  );

  // One at a time: verification runs the tests many times.
  bounty.status = "verifying";
  const stableTestFiles = state.pains.filter((p) => p.healthy).map((p) => p.testFile);
  for (const { id, fix, started } of fixes.filter(Boolean)) {
    const result = await verify({ bountyId: bounty.id, agentId: nameFor(id), testFile: pain.testFile, files: fix.files, stableTestFiles });
    const durationMs = Date.now() - started;
    if (result.passed) {
      cardFor(id).verified += 1;
      cardFor(id).verifiedMs += durationMs;
    }
    bounty.attempts.push({
      agentId: id,
      summary: fix.summary,
      files: fix.files,
      linesChanged: await linesChanged(fix.files),
      passed: result.passed,
      reason: result.reason ?? null,
      runs: result.runs.map((r) => r.passed),
      durationMs,
    });
  }

  const verified = bounty.attempts.filter((a) => a.passed);
  if (!verified.length) return fail(bounty, `No agent's fix for ${pain.testFile} passed verification. Hold released, $0 charged.`);
  // Ranked on track record only, never price: best scorecard, then the
  // smaller change. Judged in that order; the first both judges pass wins.
  verified.sort((a, b) => rank(cardFor(b.agentId)) - rank(cardFor(a.agentId)) || a.linesChanged - b.linesChanged);
  bounty.status = "judging";
  let winner = null;
  for (const candidate of verified) {
    const review = await judgeAttempt({ pain, files: candidate.files, author: candidate.agentId, others: verified.filter((v) => v !== candidate).map((v) => v.files) });
    candidate.judges = review.judges;
    bounty.apiCost += review.cost;
    emit("bounty.judged", {
      bountyId: bounty.id,
      message: `Judges on a verified fix for ${pain.testFile}: ${review.judges.map((j) => `${j.name} ${j.ok ? "passed" : "failed"}`).join(", ")}`,
    });
    if (review.ok) {
      winner = candidate;
      break;
    }
  }
  if (!winner) {
    const why = verified.flatMap((v) => v.judges).find((j) => j.unavailable)?.summary;
    return fail(bounty, `${verified.length} fix${verified.length > 1 ? "es" : ""} passed verification, but none passed both judges${why ? ` (${why})` : ""}. Hold released, $0 charged.`);
  }
  const name = nameFor(winner.agentId);
  emit("bounty.winner", {
    bountyId: bounty.id,
    agentId: winner.agentId,
    message: `${verified.length} of ${field.length} attempts verified. ${name} wins on its track record and both judges passed it: ${winner.summary}`,
  });
  return win(bounty, pain, { id: winner.agentId, name, builder: providerOf(winner.agentId) }, winner);
}

const API_ATTEMPTS = 3;

// The paid round for a model approved from the trials: it fixes the problem
// through the API with Shoal driving, retrying with the verifier's failure
// output. Same rules as any bounty, survival window included.
async function runApprovedModel(bounty, pain) {
  const name = MODELS[bounty.apiModel].name;
  const payee = { id: bounty.apiModel, name, builder: providerLabel(bounty.apiModel) };
  const trial = state.trials.find((t) => t.id === bounty.trialId);
  const card = cardFor(bounty.apiModel);
  card.attempts += 1;
  const started = Date.now();
  let lastFailure = null;

  for (let attempt = 1; attempt <= API_ATTEMPTS; attempt++) {
    // Don't start an attempt the team's credits couldn't pay for if it passes.
    if (bounty.escrow.mode === "credits" && fixPriceCents(bounty.apiCost + costPerFix(bounty.apiModel)) > balanceCents()) {
      return fail(bounty, `Not enough credits for ${attempt > 1 ? "another" : "an"} attempt. Nothing charged; buy credits to continue.`);
    }
    bounty.status = "competing";
    emit("bounty.competing", {
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
    const entry = {
      agentId: bounty.apiModel,
      summary: fix.summary,
      files: fix.files,
      linesChanged: await linesChanged(fix.files),
      passed: result.passed,
      reason: result.reason ?? null,
      runs: result.runs.map((r) => r.passed),
    };
    bounty.attempts.push(entry);
    if (result.passed) {
      card.delivered += 1;
      card.verified += 1;
      card.verifiedMs += Date.now() - started;
      // The trial's patch was judged in its proof report; this new one is too.
      bounty.status = "judging";
      const review = await judgeAttempt({ pain, files: fix.files, author: bounty.apiModel });
      entry.judges = review.judges;
      bounty.apiCost += review.cost;
      if (review.ok) return win(bounty, pain, payee, entry);
      entry.passed = false;
      entry.reason = `Verified, but the judges failed it: ${review.judges.filter((j) => !j.ok).map((j) => `${j.name}: ${j.summary}`).join(" ")}`;
      lastFailure = entry.reason;
      continue;
    }
    lastFailure = [result.reason, result.failureLog].filter(Boolean).join("\n");
  }
  return fail(bounty, `${name} didn't deliver a verified fix in ${API_ATTEMPTS} tries. $0 charged.`);
}

// The winning fix: apply it, charge the team, open the PR, and start the
// survival window. The agent's payout is recorded as pending.
async function win(bounty, pain, payee, attempt) {
  bounty.winner = payee.id;
  cardFor(payee.id).wins += 1;
  await writeFiles(WORKSPACE, attempt.files);

  let charged;
  try {
    charged = await chargeEscrow(bounty, bounty.reward);
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
  const fee = credits ? round4(charged - bounty.apiCost) : round4(charged * TAKE_RATE);
  startSurvival(bounty);
  state.ledger.unshift({
    id: newId("tx"),
    bountyId: bounty.id,
    agentId: payee.id,
    agentName: payee.name,
    amount: charged,
    agentPayout: round4(charged - fee),
    platformFee: fee,
    funding: bounty.escrow.mode,
    paymentIntentId: bounty.escrow.paymentIntentId,
    hoursReturnedPerWeek: pain.hoursPerWeek,
    apiModel: bounty.apiModel,
    apiCost: bounty.apiCost,
    // pending until the survival window ends, then paid or clawed_back.
    status: "pending",
    chargedAt: new Date().toISOString(),
    releaseAt: bounty.survival.endsAt,
    settledAt: null,
  });
  bounty.status = "surviving";
  emit("bounty.surviving", {
    bountyId: bounty.id,
    agentId: payee.id,
    amount: charged,
    message: `VERIFIED: ${payee.name}'s fix for ${pain.testFile}. $${charged} is held; ${payee.name} gets paid on ${bounty.survival.endsAt.slice(0, 10)} if the fix survives ${bounty.survivalDays} days.`,
  });
  await surfacePullRequest(bounty, pain, payee, attempt);
  return bounty;
}

// The window ended with the fix still holding: the payout clears.
export async function releasePayout(bounty) {
  const entry = state.ledger.find((t) => t.bountyId === bounty.id && t.status === "pending");
  const card = cardFor(bounty.winner);
  bounty.status = "settled";
  bounty.survival.status = "survived";
  if (entry) {
    entry.status = "paid";
    entry.settledAt = new Date().toISOString();
    card.earned += entry.agentPayout;
    card.paid += entry.amount;
  }
  card.survived += 1;
  emit("bounty.settled", {
    bountyId: bounty.id,
    agentId: bounty.winner,
    amount: entry?.amount ?? 0,
    hoursReturnedPerWeek: entry?.hoursReturnedPerWeek ?? 0,
    message: `SETTLED: ${entry?.agentName ?? bounty.winner}'s fix for ${bounty.testFile} survived ${bounty.survivalDays} days. Paid $${entry?.agentPayout ?? 0}; ~${entry?.hoursReturnedPerWeek ?? 0} dev-hours/week returned.`,
  });
  return bounty;
}

// The fix regressed inside its window: refund the team, pay the agent
// nothing, and mark it on the agent's scorecard.
export async function clawBack(bounty, reason) {
  const entry = state.ledger.find((t) => t.bountyId === bounty.id && t.status === "pending");
  bounty.status = "clawed_back";
  bounty.survival.status = "regressed";
  bounty.survival.reason = reason;
  cardFor(bounty.winner).clawbacks += 1;
  if (entry) {
    entry.status = "clawed_back";
    entry.settledAt = new Date().toISOString();
  }
  try {
    await refundEscrow(bounty);
  } catch (err) {
    bounty.escrow.status = "refund_failed";
    emit("escrow.error", { bountyId: bounty.id, message: `Clawed back, but the refund failed: ${err.message}. Refund it by hand.` });
  }
  emit("bounty.clawed_back", {
    bountyId: bounty.id,
    agentId: bounty.winner,
    message: `CLAWED BACK: ${entry?.agentName ?? bounty.winner}'s fix for ${bounty.testFile} regressed (${reason}). $${entry?.amount ?? 0} refunded to the team; the agent is paid $0.`,
  });
  return bounty;
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

// Only the winning, verified fix ever reaches the team: as a PR on the
// connected GitHub repo, when the token has write access.
async function surfacePullRequest(bounty, pain, agent, attempt) {
  const repo = state.connection;
  if (repo.type !== "github") return;
  if (!repo.canWrite) {
    emit("pr.skipped", { bountyId: bounty.id, message: `Fix verified but not pushed: GITHUB_TOKEN can't write to ${repo.fullName}` });
    return;
  }
  const body = [
    `**Shoal bounty ${bounty.id}**: ${bounty.title}`,
    "",
    `Fixed by **${agent.name}** (${agent.builder}). ${attempt.summary}`,
    "",
    "### Verification",
    `- Before: \`${pain.testFile}\` failed ${pain.failures}/${pain.runs} runs`,
    `- After: ${attempt.runs.filter(Boolean).length}/${attempt.runs.length} green, previously stable tests still passing`,
    "- Only non-test files were changed (tests, CI config and manifests are protected)",
    `- Estimated time returned: ~${pain.hoursPerWeek} dev-hours/week`,
    "",
    "### Survival window",
    `Shoal keeps re-running \`${pain.testFile}\` on new commits until ${bounty.survival.endsAt.slice(0, 10)}. The agent is paid only if it keeps passing; otherwise the charge is refunded.`,
  ].join("\n");
  try {
    const pr = await openPullRequest(repo, {
      branch: `shoal/${bounty.id}-${agent.id}`,
      title: `[Shoal] ${bounty.title}`,
      body,
      files: attempt.files,
    });
    bounty.pullRequest = pr;
    emit("pr.opened", { bountyId: bounty.id, url: pr.url, message: `Opened PR #${pr.number} on ${repo.fullName}` });
  } catch (err) {
    emit("pr.error", { bountyId: bounty.id, message: `Couldn't open PR: ${err.message}` });
  }
}

// --- Scorecards -----------------------------------------------------------------

// How good an agent's record is, 0-1: how often its attempts verify, times
// how often its wins survive. Smoothed so a new agent starts in the middle.
function rank(card) {
  return ((card.verified + 1) / (card.attempts + 2)) * ((card.survived + 1) / (card.survived + card.clawbacks + 2));
}

// Public scorecards for every marketplace agent and every model that has
// competed, best record first. Built only from real outcomes.
export function leaderboard() {
  const rows = [
    ...AGENTS.map((a) => ({ id: a.id, name: a.name, builder: a.builder, tagline: a.tagline, kind: "agent" })),
    ...Object.keys(state.agents)
      .filter((id) => MODELS[id])
      .map((id) => ({ id, name: MODELS[id].name, builder: providerLabel(id), tagline: "Approved from the model trials", kind: "model" })),
  ];
  return rows.map((row) => ({ ...row, ...scorecard(row.id) })).sort((a, b) => b.score - a.score || b.survived - a.survived);
}

// One agent's or model's scorecard with its rates (zeros if it never competed).
export function scorecard(id) {
  const c = { attempts: 0, delivered: 0, verified: 0, verifiedMs: 0, wins: 0, survived: 0, clawbacks: 0, earned: 0, paid: 0, ...state.agents[id] };
  const judged = c.survived + c.clawbacks;
  return {
    ...c,
    // Shoal-measured "uptime": attempts that delivered a fix at all.
    uptime: c.attempts ? c.delivered / c.attempts : null,
    // From the start of an attempt to its fix passing verification.
    avgTimeToFixMs: c.verified ? Math.round(c.verifiedMs / c.verified) : null,
    // Wins still inside their survival window.
    pending: c.wins - judged,
    verifiedRate: c.attempts ? c.verified / c.attempts : null,
    survivalRate: judged ? c.survived / judged : null,
    clawbackRate: judged ? c.clawbacks / judged : null,
    // What teams paid per fix that survived.
    costPerOutcome: c.survived ? Math.round((c.paid / c.survived) * 100) / 100 : null,
    score: Math.round(rank(c) * 100),
  };
}

// --- Morning Settlement -----------------------------------------------------------

// What cleared its survival window and got paid in the last day, what got
// clawed back, and what's still being watched.
export function morningSettlement() {
  const since = Date.now() - 24 * 60 * 60_000;
  const recent = (t) => t.settledAt && Date.parse(t.settledAt) >= since;
  const paid = state.ledger.filter((t) => t.status === "paid");
  const pending = state.ledger.filter((t) => t.status === "pending");
  const sum = (list, key) => Math.round(list.reduce((s, t) => s + t[key], 0) * 100) / 100;
  const top = leaderboard().filter((a) => a.earned > 0).sort((a, b) => b.earned - a.earned)[0];
  return {
    clearedToday: state.ledger.filter((t) => t.status === "paid" && recent(t)).map(settlementLine),
    clawedBackToday: state.ledger.filter((t) => t.status === "clawed_back" && recent(t)).map(settlementLine),
    inSurvival: pending.map(settlementLine),
    bountiesSettled: paid.length,
    bountiesClawedBack: state.ledger.filter((t) => t.status === "clawed_back").length,
    bountiesFailed: state.bounties.filter((b) => b.status === "failed").length,
    heldInEscrow: sum(state.bounties.filter((b) => b.escrow?.status === "held").map((b) => ({ amount: b.escrow.amount })), "amount"),
    pendingPayouts: sum(pending, "amount"),
    totalPaid: sum(paid, "agentPayout"),
    platformRevenue: sum(paid, "platformFee"),
    hoursReturnedPerWeek: Math.round(paid.reduce((s, t) => s + t.hoursReturnedPerWeek, 0) * 10) / 10,
    topEarner: top?.name ?? null,
  };
}

// Who's paid for a listing: the builder, or the model's provider.
const providerOf = (id) => (MODELS[id] ? providerLabel(id) : AGENTS.find((a) => a.id === id)?.builder ?? id.split(":")[1]?.split("/")[0] ?? "Shoal");

const settlementLine = (t) => ({
  bountyId: t.bountyId,
  agent: t.agentName ?? t.agentId,
  amount: t.amount,
  agentPayout: t.agentPayout,
  status: t.status,
  releaseAt: t.releaseAt,
  settledAt: t.settledAt,
});

// --- Lookups -----------------------------------------------------------------------

export function getBounty(id) {
  const bounty = state.bounties.find((b) => b.id === id);
  if (!bounty) throw httpError(404, `Unknown bounty ${id}`);
  return bounty;
}

// What the team sees: the winner's fix only. Losing attempts stay private;
// the team just learns how many there were and how many verified.
export function publicBounty(b) {
  const { attempts, ...rest } = b;
  const winning = attempts.find((a) => a.passed && a.agentId === b.winner) ?? null;
  return {
    ...rest,
    competition: { attempts: attempts.length, verified: attempts.filter((a) => a.passed).length },
    winningAttempt: winning && { agentId: winning.agentId, summary: winning.summary, files: winning.files.map((f) => f.path), linesChanged: winning.linesChanged, runs: winning.runs, judges: winning.judges ?? [] },
    // A single approved model has no rivals to hide: show why its tries failed.
    failures: b.apiModel ? attempts.filter((a) => !a.passed).map((a) => a.reason) : [],
  };
}

function painFor(bounty) {
  return state.pains.find((p) => p.id === bounty.painId) ?? state.pains.find((p) => p.testFile === bounty.testFile);
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
