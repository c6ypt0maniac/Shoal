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
import { emit } from "./events.js";
import { chargeCredits, refundCredits } from "./credits.js";
import { MOCK } from "./agents.js";
import { testPayments } from "./testmode.js";

const key = () => process.env.STRIPE_SECRET_KEY ?? "";
const isTestKey = () => /^(sk|rk)_test_/.test(key());
const isLiveKey = () => /^(sk|rk)_live_/.test(key());
export const stripeLive = () => isLiveKey() && process.env.STRIPE_ALLOW_LIVE === "1" && !MOCK && !testPayments();
export const stripeConfigured = () => !testPayments() && (isTestKey() || stripeLive());
export const paymentsMode = () => (testPayments() ? "test-bypass" : stripeLive() ? "stripe-live" : isTestKey() ? "stripe-test" : "simulated");

// Why a key that was set isn't being used, or null.
export function stripeKeyProblem() {
  if (!key() || stripeConfigured()) return null;
  if (!isLiveKey()) return "STRIPE_SECRET_KEY isn't a Stripe secret key";
  if (process.env.STRIPE_ALLOW_LIVE !== "1") return "STRIPE_SECRET_KEY is a LIVE key; set STRIPE_ALLOW_LIVE=1 to take real money";
  return "live payments need real agents; set ANTHROPIC_API_KEY or OPENAI_API_KEY (mock agents can't take real money)";
}

let client = null;
const stripe = () => (client ??= new Stripe(key()));

const cents = (dollars) => Math.round(dollars * 100);

export function newEscrow(reward, mode) {
  return {
    mode, // "stripe" | "simulated" | "credits" (prepaid, see credits.js)
    live: mode === "stripe" && stripeLive(),
    status: mode === "stripe" ? "awaiting_funding" : "held",
    amount: reward,
    charged: 0,
    released: 0,
    paymentIntentId: null,
    checkoutSessionId: null,
  };
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
      metadata: { bountyId: bounty.id },
    },
    metadata: { bountyId: bounty.id },
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
// clawback. Credit runs deduct the real API cost plus fee instead.
export async function chargeEscrow(bounty, amount) {
  const escrow = bounty.escrow;
  if (escrow.mode === "stripe") {
    await stripe().paymentIntents.capture(escrow.paymentIntentId, { amount_to_capture: cents(amount) });
  }
  if (escrow.mode === "credits") {
    amount = await chargeCredits({ bountyId: bounty.id, model: bounty.apiModel, apiCost: bounty.apiCost });
  }
  escrow.status = "charged";
  escrow.charged = amount;
  escrow.released = escrow.mode === "credits" ? 0 : escrow.amount - amount;
  const via = { simulated: " (simulated)", stripe: " via Stripe", credits: ` from credits (API cost $${bounty.apiCost?.toFixed(4)} + fee)` }[escrow.mode];
  emit("escrow.charged", {
    bountyId: bounty.id,
    amount,
    message: `Charged $${amount}${escrow.released ? `, released the other $${escrow.released}` : ""}${via}`,
  });
  return amount;
}

// --- Credit packs ------------------------------------------------------------

// Checkout for a credit pack: a normal, immediately captured payment.
export async function startCreditCheckout(dollars, { successUrl, cancelUrl }) {
  const session = await stripe().checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: cents(dollars),
          product_data: {
            name: `Shoal credits: $${dollars}`,
            description: "Prepaid credits for verified fixes. Each verified fix uses its real API cost plus Shoal's fee; failed fixes cost nothing.",
          },
        },
      },
    ],
    metadata: { kind: "credits", dollars: String(dollars) },
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
  return session.url;
}

// Stripe sent the team back: check the pack was actually paid, and for how much.
export async function confirmCreditPurchase(sessionId) {
  const session = await stripe().checkout.sessions.retrieve(String(sessionId ?? ""));
  if (session.metadata?.kind !== "credits") throw httpError(400, "That isn't a credit purchase");
  if (session.payment_status !== "paid") throw httpError(402, `Payment didn't complete (status: ${session.payment_status})`);
  return { dollars: session.amount_total / 100, sessionId: session.id };
}

// The fix regressed inside its survival window: give the team its money
// back. Stripe refunds the captured charge; credits go back on the balance.
export async function refundEscrow(bounty) {
  const escrow = bounty.escrow;
  if (escrow.status !== "charged") return 0;
  if (escrow.mode === "stripe") {
    const refund = await stripe().refunds.create({ payment_intent: escrow.paymentIntentId, amount: cents(escrow.charged), metadata: { bountyId: bounty.id, reason: "clawback" } });
    escrow.refundId = refund.id;
  }
  if (escrow.mode === "credits") await refundCredits({ bountyId: bounty.id });
  escrow.status = "refunded";
  escrow.refunded = escrow.charged;
  const via = { simulated: " (simulated)", stripe: " via Stripe", credits: " to credits" }[escrow.mode];
  emit("escrow.refunded", { bountyId: bounty.id, amount: escrow.refunded, message: `Refunded $${escrow.refunded}${via}: the fix didn't survive` });
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
      escrow.mode === "credits"
        ? "No verified fix: nothing taken from credits"
        : `Hold of $${escrow.amount} released: no verified fix, nothing charged${escrow.mode === "simulated" ? " (simulated)" : ""}`,
  });
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
