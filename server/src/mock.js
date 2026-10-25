// Canned agent behaviour for offline demos (no API keys), or as a
// backup if the API is slow on stage. Each persona fails or succeeds the same
// way every time, so the demo story is predictable:
//   FlakeHunter edits the test        -> rejected for tampering
//   Speedy ships a shallow src patch  -> rejected, still flaky
//   RootCause fixes the real bug      -> verified and paid
// Mock agents only know the demo repo; connected GitHub repos need real Claude.
import { readRepoFile } from "./repo.js";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min, max) => min + Math.random() * (max - min);

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
