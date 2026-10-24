import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDiscount, cartTotal } from "../src/pricing.js";

test("applyDiscount takes a percentage off", () => {
  assert.equal(applyDiscount(200, 25), 150);
  assert.equal(applyDiscount(80, 50), 40);
  assert.equal(applyDiscount(99, 0), 99);
});

test("cartTotal counts every line item", () => {
  const items = [
    { price: 10, qty: 2 },
    { price: 5, qty: 1 },
    { price: 3, qty: 4 },
  ];
  assert.equal(cartTotal(items), 37);
  assert.equal(cartTotal([{ price: 7, qty: 1 }]), 7);
  assert.equal(cartTotal([]), 0);
});
