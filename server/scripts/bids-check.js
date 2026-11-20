// Checks bids.js: what each kind of competitor bids, who gets to race, and
// the order fixes are judged in (cheapest first, close calls by record).
//   node --test scripts/bids-check.js
import test from "node:test";
import assert from "node:assert/strict";

process.env.SHOAL_MOCK = "1";
const { admit, bidFor, cleanMaxSpend, cleanRaceSize, winReason, winnerOrder, DEFAULT_MAX_SPEND } = await import("../src/bids.js");

const PROMPT = "x".repeat(40_000); // about 10k tokens in
const records = { strong: 0.9, weak: 0.3, fresh: 0 };
const recordOf = (id) => records[id] ?? 0;
const byRecord = (a, b) => recordOf(b) - recordOf(a) || a.localeCompare(b);

test("Shoal-run models bid their estimate, and a pricier model bids more", () => {
  const haiku = bidFor("claude-haiku-5-5", null, PROMPT), opus = bidFor("claude-opus-5-5", null, PROMPT);
  assert.equal(haiku.kind, "estimate");
  assert.ok(haiku.amount > 0 && opus.amount > haiku.amount, `${haiku.amount} < ${opus.amount}`);
});

test("uploaded code bids its cap, webhooks cost the team nothing", () => {
  assert.deepEqual(bidFor("agent:bo/x", { provider: "builder", runtime: "bundle", maxSpend: 0.4 }, PROMPT), { amount: 0.4, kind: "cap" });
  assert.deepEqual(bidFor("agent:bo/y", { provider: "builder", runtime: "image" }, PROMPT), { amount: DEFAULT_MAX_SPEND, kind: "cap" });
  assert.deepEqual(bidFor("agent:bo/z", { provider: "builder", runtime: "webhook" }, PROMPT), { amount: 0, kind: "own" });
  const prompt = bidFor("agent:bo/p", { provider: "builder", runtime: "prompt", prompt: { model: "claude-sonnet-5-5", instructions: "Be careful." } }, PROMPT);
  assert.equal(prompt.kind, "estimate");
});

test("maxSpend and raceSize are checked", () => {
  assert.equal(cleanMaxSpend(undefined), DEFAULT_MAX_SPEND);
  assert.equal(cleanMaxSpend("2.5"), 2.5);
  assert.throws(() => cleanMaxSpend(0.01), /between/);
  assert.throws(() => cleanMaxSpend(500), /between/);
  assert.equal(cleanRaceSize(null), null);
  assert.equal(cleanRaceSize(4), 4);
  assert.throws(() => cleanRaceSize(0));
  assert.throws(() => cleanRaceSize(2.5));
});

test("the best value races: a strong record's higher bid beats a lowball from nobody", () => {
  const bids = [
    { agentId: "fresh", amount: 0.3 }, // 0.3 / 0.25 floor = 1.2
    { agentId: "strong", amount: 0.6 }, // 0.6 / 0.9 = 0.67
    { agentId: "weak", amount: 0.5 }, // 0.5 / 0.3 = 1.67
  ];
  assert.deepEqual(admit(bids, 2, recordOf, byRecord), ["strong", "fresh"]);
  assert.equal(bids.find((b) => b.agentId === "weak").admitted, false);
});

test("an unknown price counts as the priciest", () => {
  const bids = [{ agentId: "fresh", amount: null }, { agentId: "new", amount: 1 }];
  assert.deepEqual(admit(bids, 1, recordOf, byRecord), ["new"]);
});

test("the cheapest fix is judged first; within 20% the better record goes first", () => {
  const v = (agentId, spent, linesChanged = 5) => ({ agentId, spent, linesChanged });
  assert.deepEqual(winnerOrder([v("strong", 0.5), v("weak", 0.2)], byRecord).map((x) => x.agentId), ["weak", "strong"]);
  assert.deepEqual(winnerOrder([v("weak", 0.2), v("strong", 0.23)], byRecord).map((x) => x.agentId), ["strong", "weak"]);
  // All free (webhooks): record decides, then the smaller change.
  assert.deepEqual(winnerOrder([v("weak", 0, 3), v("strong", 0, 9)], byRecord).map((x) => x.agentId), ["strong", "weak"]);
  assert.deepEqual(winnerOrder([v("a", 0, 9), v("b", 0, 3)], () => 0).map((x) => x.agentId), ["b", "a"]);
});

test("the win is explained", () => {
  const cheap = { agentId: "weak", spent: 0.2, judged: true }, pricier = { agentId: "strong", spent: 0.5 };
  assert.match(winReason(cheap, [cheap, pricier]), /cheapest/);
  assert.match(winReason(pricier, [cheap, pricier]), /failed the judges/);
  assert.match(winReason({ ...pricier, spent: 0.23 }, [{ ...cheap, judged: false }, { ...pricier, spent: 0.23 }]), /better track record/);
});
