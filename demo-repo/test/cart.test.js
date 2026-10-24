import { test } from "node:test";
import assert from "node:assert/strict";
import { Cart } from "../src/cart.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("GIGEM coupon takes 12% off", async () => {
  const cart = new Cart();
  cart.add("Reveille plush", 25, 2);
  await cart.applyCoupon("GIGEM");
  await sleep(30); // "should be enough time"
  assert.equal(cart.total, 44);
});

test("unknown coupon leaves the total unchanged", async () => {
  const cart = new Cart();
  cart.add("Maroon hoodie", 50);
  await cart.applyCoupon("NOPE");
  assert.equal(cart.total, 50);
});
