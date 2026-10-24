// Canned agent behaviour for offline demos (no ANTHROPIC_API_KEY), or as a
// backup if the API is slow on stage. Each persona fails or succeeds the same
// way every time, so the demo story is predictable:
//   FlakeHunter edits the test        -> rejected for tampering
//   Speedy ships a shallow src patch  -> rejected, still flaky
//   RootCause fixes the real bug      -> verified and paid
// Mock agents only know the demo repo; connected GitHub repos need real Claude.
import { readRepoFile } from "./repo.js";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min, max) => min + Math.random() * (max - min);

const BIDS = {
  flakehunter: {
    "test/cart.test.js": { price: 90, confidence: 0.92, plan: "Bump the sleep in the test from 30ms to 200ms so the coupon always lands." },
    "test/orders.test.js": { price: 70, confidence: 0.9, plan: "Relax the uniqueness assertion to tolerate the occasional duplicate." },
  },
  speedy: {
    "test/cart.test.js": { price: 140, confidence: 0.7, plan: "Make the pricing lookup latency constant so timing is predictable." },
    "test/orders.test.js": { price: 120, confidence: 0.72, plan: "Use the current timestamp for order IDs instead of a small random range." },
  },
  rootcause: {
    "test/cart.test.js": { price: 310, confidence: 0.88, plan: "applyCoupon never returns its promise, so awaiting it does nothing. Return the promise so callers wait for the discount." },
    "test/orders.test.js": { price: 260, confidence: 0.9, plan: "Only 200 possible IDs means collisions are guaranteed at volume. Switch to crypto.randomUUID()." },
  },
};

export async function mockBid(agent, pain) {
  await delay(jitter(600, 1800));
  const bid = BIDS[agent.id]?.[pain.testFile];
  if (!bid) return { bid: false, price: 0, confidence: 0, plan: "Not my kind of job." };
  return { bid: true, ...bid };
}

export async function mockFix(agent, pain) {
  await delay(jitter(1500, 3000));
  const file = pain.testFile;

  if (agent.id === "flakehunter") {
    const test = await readRepoFile(file);
    const content =
      file === "test/cart.test.js"
        ? test.replace("await sleep(30);", "await sleep(200);")
        : test.replace("assert.equal(ids.size, 15);", "assert.ok(ids.size >= 13);");
    return { summary: "Gave the test more breathing room.", files: [{ path: file, content }] };
  }

  if (agent.id === "speedy") {
    if (file === "test/cart.test.js") {
      const src = await readRepoFile("src/cart.js");
      return {
        summary: "Pinned pricing-service latency to a constant 40ms.",
        files: [{ path: "src/cart.js", content: src.replace("Math.random() * 60", "40") }],
      };
    }
    const src = await readRepoFile("src/orders.js");
    return {
      summary: "Order IDs now use Date.now().",
      files: [{ path: "src/orders.js", content: src.replace("Math.floor(Math.random() * 200)", "Date.now()") }],
    };
  }

  if (file === "test/cart.test.js") {
    const src = await readRepoFile("src/cart.js");
    const content = src
      .replace(
        "  // BUG: fires the lookup but never returns the promise, so callers\n  // can't wait for the discount to actually be applied.\n",
        "  // Returns the promise so callers can await the discount being applied.\n",
      )
      .replace("    lookupDiscount(code).then(", "    return lookupDiscount(code).then(");
    return { summary: "Return the lookup promise from applyCoupon so `await cart.applyCoupon()` actually waits.", files: [{ path: "src/cart.js", content }] };
  }
  return {
    summary: "Order IDs use crypto.randomUUID() instead of a 200-value random range.",
    files: [
      {
        path: "src/orders.js",
        content:
          '// Order ID generation for the Aggie merch store.\nimport { randomUUID } from "node:crypto";\n\nexport function generateOrderId() {\n  return `ORD-${randomUUID()}`;\n}\n',
      },
    ],
  };
}
