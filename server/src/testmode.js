// Test payments: a switch for testing that bypasses Stripe and every cost.
// While it's on, bounties and credit packs are simulated (no Checkout), any
// amount is allowed, verified credit fixes cost $0, and every agent runs in
// mock mode so no API key is billed either. It can't be turned on when the
// server takes real money (STRIPE_ALLOW_LIVE=1 with a live key).
import { state } from "./store.js";

export const testPayments = () => state.testPayments === true;
export const testPaymentsAllowed = () => process.env.STRIPE_ALLOW_LIVE !== "1";
