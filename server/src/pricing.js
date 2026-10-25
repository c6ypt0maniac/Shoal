// What a team pays to unlock a sealed fix: this bug's real cost to Shoal
// (fix attempts, challenge writer, judges, sandbox time; see spend.js) times
// a markup that also covers bugs that are tried but never unlocked, rounded
// up to the next .99, between a floor and a ceiling. Chosen with the margin
// simulation (sim/margin_sim.py, dynamic_price): x6 keeps a ~61% gross margin
// at a 60% unlock rate, with no sale below its own cost. Re-run it before
// changing any of these.
import { spentOn } from "./spend.js";

export const MARKUP = 6;
export const FLOOR = 2.99;
export const CEILING = 19.99;

export const unlockPrice = (painId) => priceFor(spentOn(painId));

// Shoal's spend on a bug -> the price.
export function priceFor(spend) {
  const rounded = Math.ceil(spend * MARKUP) - 0.01;
  return Math.round(Math.min(CEILING, Math.max(FLOOR, rounded)) * 100) / 100;
}
