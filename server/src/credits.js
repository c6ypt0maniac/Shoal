// Prepaid credits for API fixes. A team buys a pack ($10/$25/$50) through
// Stripe Checkout; each verified fix then deducts its real API cost plus
// Shoal's fee. A fix that isn't verified costs nothing. The balance is kept
// in .data/credits.json (gitignored) so a server restart never loses money
// someone paid. Amounts are stored in cents to avoid rounding drift.
import { mkdir, rename, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { emit } from "./events.js";
import { newId } from "./store.js";

export const PACKS = [10, 25, 50];
export const SHOAL_FEE = 0.15;
const MIN_CHARGE_CENTS = 1;

// SHOAL_DATA_DIR lets a test server keep its own balance file.
const DATA_DIR = process.env.SHOAL_DATA_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.data");
const FILE = path.join(DATA_DIR, "credits.json");

const book = existsSync(FILE)
  ? JSON.parse(readFileSync(FILE, "utf8"))
  : { balanceCents: 0, purchases: [], charges: [] };

async function save() {
  await mkdir(DATA_DIR, { recursive: true });
  // Write then rename, so a crash mid-write can't corrupt the balance.
  await writeFile(FILE + ".tmp", JSON.stringify(book, null, 2));
  await rename(FILE + ".tmp", FILE);
}

const toCents = (dollars) => Math.round(dollars * 100);
const toDollars = (cents) => cents / 100;

// What a verified fix costs the team: API cost plus Shoal's fee, at least 1c.
export const fixPriceCents = (apiCost) => Math.max(MIN_CHARGE_CENTS, Math.ceil(apiCost * (1 + SHOAL_FEE) * 100));

export const balanceCents = () => book.balanceCents;

export function creditsSummary() {
  return {
    balance: toDollars(book.balanceCents),
    packs: PACKS,
    fee: SHOAL_FEE,
    purchases: book.purchases.slice(0, 10).map((p) => ({ ...p, amount: toDollars(p.cents) })),
    charges: book.charges.slice(0, 10).map((c) => ({ ...c, amount: toDollars(c.cents), apiCost: c.apiCost })),
  };
}

// Adds a paid pack. Idempotent per Stripe session, so a refreshed return page
// can't add the same payment twice.
export async function addCredits({ dollars, mode, stripeSessionId = null }) {
  if (!PACKS.includes(dollars)) throw httpError(400, `Pick a pack: ${PACKS.map((p) => `$${p}`).join(", ")}`);
  if (stripeSessionId && book.purchases.some((p) => p.stripeSessionId === stripeSessionId)) return creditsSummary();
  const cents = toCents(dollars);
  book.balanceCents += cents;
  book.purchases.unshift({ id: newId("credit"), cents, mode, stripeSessionId, at: new Date().toISOString() });
  await save();
  emit("credits.added", { message: `Added $${dollars} of credits${mode === "simulated" ? " (simulated)" : " via Stripe"}. Balance $${toDollars(book.balanceCents).toFixed(2)}` });
  return creditsSummary();
}

// Deducts a verified fix. Called only after the verifier passes it.
export async function chargeCredits({ bountyId, model, apiCost }) {
  const cents = fixPriceCents(apiCost);
  if (cents > book.balanceCents) throw httpError(402, "Not enough credits for this fix");
  book.balanceCents -= cents;
  book.charges.unshift({ id: newId("charge"), bountyId, model, apiCost, cents, at: new Date().toISOString() });
  await save();
  return toDollars(cents);
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
