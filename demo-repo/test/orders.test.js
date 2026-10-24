import { test } from "node:test";
import assert from "node:assert/strict";
import { generateOrderId } from "../src/orders.js";

test("order IDs are unique across a busy minute", () => {
  const ids = new Set();
  for (let i = 0; i < 15; i++) ids.add(generateOrderId());
  assert.equal(ids.size, 15);
});

test("order IDs start with ORD-", () => {
  assert.match(generateOrderId(), /^ORD-/);
});
