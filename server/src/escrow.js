// Escrow for bounty rewards, backed by Stripe (test or live) or simulated.
//
// Stripe flow: the team pays through Stripe Checkout with capture_method
// "manual", so the card is only authorized (held), not charged. When a fix is
// verified we capture just the winning amount; if no fix passes we cancel the
// authorization and the hold is released. Card holds expire after ~7 days.
//
// Setup: put a secret key in .env as STRIPE_SECRET_KEY. Test keys (sk_test_)
// work as is. Live keys (sk_live_) take real money, so they also need
// STRIPE_ALLOW_LIVE=1 and real Claude agents: charging a real card for a
// mock agent's scripted fix would be taking money for nothing.
import Stripe from "stripe";
import { currentWorkspace } from "./store.js";
import { emit } from "./events.js";

const key = () => process.env.STRIPE_SECRET_KEY ?? "";
const isTestKey = () => /^(sk|rk)_test_/.test(key());
const isLiveKey = () => /^(sk|rk)_live_/.test(key());
export const stripeLive = () => isLiveKey() && process.env.STRIPE_ALLOW_LIVE === "1" && process.env.SHOAL_MOCK !== "1";
export const stripeConfigured = () => isTestKey() || stripeLive();
export const paymentsMode = () => (stripeLive() ? "stripe-live" : isTestKey() ? "stripe-test" : "simulated");

// Why a key that was set isn't being used, or null.
export function stripeKeyProblem() {
  if (!key() || stripeConfigured()) return null;
  if (!isLiveKey()) return "STRIPE_SECRET_KEY isn't a Stripe secret key";
  if (process.env.STRIPE_ALLOW_LIVE !== "1") return "STRIPE_SECRET_KEY is a LIVE key; set STRIPE_ALLOW_LIVE=1 to take real money";
  return "live payments need real agents; unset SHOAL_MOCK=1 (mock agents can't take real money)";
}

let client = null;
export const stripe = () => (client ??= new Stripe(key()));

const cents = (dollars) => Math.round(dollars * 100);
export const isFree = (escrow) => escrow.mode === "free" || escrow.mode === "credits";
// Whose checkout this is: the webhook and the return page credit that user.
const owner = () => currentWorkspace().login;

export function newEscrow(reward, mode) {
  return {
    // "stripe" | "simulated" | "free": unlocking a trial fix moves no money
    // (the team's tokens, on their own keys, are its only cost). Bounties
    // saved before trials were free say "credits"; they're treated as free.
    mode,
    live: mode === "stripe" && stripeLive(),
    status: mode === "stripe" ? "awaiting_funding" : "held",
    amount: reward,
    charged: 0,
    released: 0,
    paymentIntentId: null,
    checkoutSessionId: null,
  };
}

// Puts the reward on hold on the team's saved card (billing.js), with no
// Checkout page. Throws with needsCheckout when the card needs its holder to
// confirm (3-D Secure); the bounty then falls back to Checkout.
export async function holdWithSavedCard(bounty, card) {
  try {
    const intent = await stripe().paymentIntents.create({
      amount: cents(bounty.reward),
      currency: "usd",
      customer: card.customerId,
      payment_method: card.paymentMethodId,
      capture_method: "manual",
      off_session: true,
      confirm: true,
      description: `Shoal bounty ${bounty.id}`,
      metadata: { bountyId: bounty.id, owner: owner() },
    }, { idempotencyKey: `shoal-hold-${bounty.id}` });
    if (intent.status !== "requires_capture") throw Object.assign(new Error(`Payment isn't on hold (status: ${intent.status})`), { needsCheckout: true });
    bounty.escrow.paymentIntentId = intent.id;
    bounty.escrow.status = "held";
    emit("escrow.held", { bountyId: bounty.id, amount: bounty.reward, message: `$${bounty.reward} held on your saved card (not charged yet)` });
  } catch (err) {
    if (err.code === "authentication_required" || err.needsCheckout) throw Object.assign(err, { needsCheckout: true });
    throw err;
  }
}

// Creates a Checkout page where the team authorizes the full reward.
export async function startCheckout(bounty, { successUrl, cancelUrl }) {
  const session = await stripe().checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: cents(bounty.reward),
          product_data: {
            name: `Shoal bounty: ${bounty.title}`,
            description: "Held in escrow. Charged only when an agent's fix is verified, refunded if the fix regresses within the survival window; otherwise the hold is released.",
          },
        },
      },
    ],
    payment_intent_data: {
      capture_method: "manual",
      description: `Shoal bounty ${bounty.id}`,
      metadata: { bountyId: bounty.id, owner: owner() },
    },
    metadata: { bountyId: bounty.id, owner: owner() },
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
  bounty.escrow.checkoutSessionId = session.id;
  return session.url;
}

// Called when Stripe redirects back: confirms the money is actually on hold.
export async function confirmFunding(bounty, sessionId) {
  if (sessionId !== bounty.escrow.checkoutSessionId) throw httpError(400, "Checkout session doesn't match this bounty");
  const session = await stripe().checkout.sessions.retrieve(sessionId);
  const intentId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
  const intent = intentId && (await stripe().paymentIntents.retrieve(intentId));
  if (intent?.status !== "requires_capture") throw httpError(402, `Payment isn't on hold (status: ${intent?.status ?? session.status})`);
  bounty.escrow.paymentIntentId = intent.id;
  bounty.escrow.status = "held";
  emit("escrow.held", { bountyId: bounty.id, amount: bounty.reward, message: `$${bounty.reward} held in escrow via Stripe (not charged yet)` });
}

// Fix verified: charge the team. Shoal holds it through the survival window
// (the agent is paid only after; see survival.js) and refunds it on a
// clawback. A free bounty charges nothing.
export async function chargeEscrow(bounty, amount) {
  const escrow = bounty.escrow;
  if (escrow.mode === "stripe") {
    await stripe().paymentIntents.capture(escrow.paymentIntentId, { amount_to_capture: cents(amount) });
  }
  const free = isFree(escrow);
  if (free) amount = 0;
  escrow.status = "charged";
  escrow.charged = amount;
  escrow.released = free ? 0 : escrow.amount - amount;
  const via = { simulated: " (simulated)", stripe: " via Stripe" }[escrow.mode] ?? "";
  emit("escrow.charged", {
    bountyId: bounty.id,
    amount,
    message: free ? "Fix verified: free on Shoal (the model ran on your API keys)" : `Charged $${amount}${escrow.released ? `, released the other $${escrow.released}` : ""}${via}`,
  });
  return amount;
}

// The fix regressed inside its survival window: give the team its money
// back. Stripe refunds the captured charge; a free bounty has nothing to refund.
export async function refundEscrow(bounty) {
  const escrow = bounty.escrow;
  if (escrow.status !== "charged") return 0;
  if (escrow.mode === "stripe") {
    const refund = await stripe().refunds.create({ payment_intent: escrow.paymentIntentId, amount: cents(escrow.charged), metadata: { bountyId: bounty.id, reason: "clawback" } });
    escrow.refundId = refund.id;
  }
  escrow.status = "refunded";
  escrow.refunded = escrow.charged;
  const via = { simulated: " (simulated)", stripe: " via Stripe" }[escrow.mode] ?? "";
  emit("escrow.refunded", { bountyId: bounty.id, amount: escrow.refunded, message: isFree(escrow) ? "The fix didn't survive (it was free, so nothing to refund)" : `Refunded $${escrow.refunded}${via}: the fix didn't survive` });
  return escrow.refunded;
}

// No verified fix: cancel the authorization so the team pays nothing.
export async function releaseEscrow(bounty) {
  const escrow = bounty.escrow;
  if (escrow.status !== "held") return;
  if (escrow.mode === "stripe") await stripe().paymentIntents.cancel(escrow.paymentIntentId);
  escrow.status = "released";
  escrow.released = escrow.amount;
  emit("escrow.released", {
    bountyId: bounty.id,
    message:
      isFree(escrow)
        ? "No verified fix: nothing charged"
        : `Hold of $${escrow.amount} released: no verified fix, nothing charged${escrow.mode === "simulated" ? " (simulated)" : ""}`,
  });
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
