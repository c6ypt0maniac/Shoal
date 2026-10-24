import { test } from "node:test";
import assert from "node:assert/strict";
import { Cart } from "../src/cart.js";

// A stable test, so the Pain Graph has something healthy to compare against.
test("subtotal adds up item prices", () => {
  const cart = new Cart();
  cart.add("Corps boots sticker", 3, 4);
  cart.add("12th Man towel", 10);
  assert.equal(cart.subtotal, 22);
});
