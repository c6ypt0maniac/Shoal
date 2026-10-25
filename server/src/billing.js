// A saved payment method per GitHub account, set up once (right after first
// sign-in) instead of on every bounty.
//
// Setup: Stripe Checkout in "setup" mode saves a card to a Stripe Customer
// for the login, without charging anything. Changing it runs the same flow
// again and replaces the default. After that, posting a bounty puts the
// reward on hold on the saved card directly (escrow.js holdWithSavedCard):
// no Checkout page per bounty. A card that needs the holder to confirm
// (3-D Secure) falls back to Checkout for that bounty.
// Without Stripe (simulated payments), a simulated card stands in.
import { state } from "./store.js";
import { stripe, stripeConfigured } from "./escrow.js";

const httpError = (status, message) => Object.assign(new Error(message), { status });

// state.billing: { [login]: { customerId, paymentMethodId, card, simulated, prompted, updatedAt } }
const entry = (login) => (state.billing[login] ??= {});

// What the platform shows: whether a card is saved, and which.
export function billingFor(login) {
  const b = state.billing[login];
  return {
    ready: Boolean(b?.paymentMethodId),
    card: b?.card ?? null,
    simulated: Boolean(b?.simulated),
    // Asked once after first sign-in. "Later" stops the prompt, and bounties
    // post with simulated funding until a card is saved (index.js openBounty).
    prompted: Boolean(b?.prompted),
    mode: stripeConfigured() ? "stripe" : "simulated",
  };
}

export function dismissPrompt(login) {
  entry(login).prompted = true;
  return billingFor(login);
}

async function customerFor(login) {
  const b = entry(login);
  if (b.customerId && !b.simulated) return b.customerId;
  const customer = await stripe().customers.create({ description: `Shoal: @${login}`, metadata: { github: login } });
  b.customerId = customer.id;
  return customer.id;
}

// Starts saving (or replacing) the card. -> { url } for Stripe Checkout, or
// the billing state right away when payments are simulated.
export async function startSetup(login, { successUrl, cancelUrl }) {
  if (!login) throw httpError(401, "Sign in with GitHub first");
  if (!stripeConfigured()) {
    Object.assign(entry(login), { paymentMethodId: "pm_simulated", card: { brand: "visa", last4: "4242", expMonth: 12, expYear: new Date().getFullYear() + 3 }, simulated: true, prompted: true, updatedAt: new Date().toISOString() });
    return { billing: billingFor(login) };
  }
  const session = await stripe().checkout.sessions.create({
    mode: "setup",
    // Which card types show is set in the Stripe dashboard (dynamic payment methods).
    currency: "usd",
    customer: await customerFor(login),
    metadata: { github: login, kind: "billing-setup" },
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
  return { url: session.url };
}

// Stripe sent the user back: make the new card the default, and remember it.
export async function finishSetup(login, sessionId) {
  const session = await stripe().checkout.sessions.retrieve(String(sessionId ?? ""), { expand: ["setup_intent.payment_method"] });
  if (session.metadata?.github !== login || session.metadata?.kind !== "billing-setup") throw httpError(400, "That setup isn't yours");
  const pm = session.setup_intent?.payment_method;
  if (session.setup_intent?.status !== "succeeded" || !pm?.id) throw httpError(402, "The card wasn't saved");
  await stripe().customers.update(session.customer, { invoice_settings: { default_payment_method: pm.id } });
  // The old card isn't needed any more.
  const old = state.billing[login]?.paymentMethodId;
  if (old && old !== pm.id && !state.billing[login].simulated) await stripe().paymentMethods.detach(old).catch(() => {});
  Object.assign(entry(login), {
    customerId: session.customer,
    paymentMethodId: pm.id,
    card: pm.card ? { brand: pm.card.brand, last4: pm.card.last4, expMonth: pm.card.exp_month, expYear: pm.card.exp_year } : null,
    simulated: false,
    prompted: true,
    updatedAt: new Date().toISOString(),
  });
  return billingFor(login);
}

export async function removeCard(login) {
  const b = state.billing[login];
  if (b?.paymentMethodId && !b.simulated) await stripe().paymentMethods.detach(b.paymentMethodId).catch(() => {});
  if (b) Object.assign(b, { paymentMethodId: null, card: null, simulated: false });
  return billingFor(login);
}

// Everything Stripe and Shoal know about this login's payments: the card is
// detached and the Stripe customer deleted (account deletion).
// b: the login's billing record, when it was already taken out of state.
export async function forgetBilling(login, b = state.billing[login]) {
  if (b && !b.simulated && stripeConfigured()) {
    // Deleting the customer also removes its cards; both run at once.
    await Promise.all([
      b.paymentMethodId && stripe().paymentMethods.detach(b.paymentMethodId).catch(() => {}),
      b.customerId && stripe().customers.del(b.customerId).catch(() => {}),
    ]);
  }
  // Only this record: a new account with the same login may have saved a card since.
  if (state.billing[login] === b) delete state.billing[login];
}

// The saved card to charge for this login, or null.
export function savedCard(login) {
  const b = state.billing[login];
  return b?.paymentMethodId ? { customerId: b.customerId, paymentMethodId: b.paymentMethodId, simulated: Boolean(b.simulated) } : null;
}
