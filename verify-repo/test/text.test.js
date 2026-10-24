import { test } from "node:test";
import assert from "node:assert/strict";
import { capitalize, slugify } from "../src/text.js";

test("slugify makes URL-safe slugs", () => {
  assert.equal(slugify("Hello World!"), "hello-world");
  assert.equal(slugify("  Gig 'em, Aggies  "), "gig-em-aggies");
  assert.equal(slugify("---"), "");
});

test("capitalize uppercases the first letter", () => {
  assert.equal(capitalize("aggie"), "Aggie");
  assert.equal(capitalize("A"), "A");
  assert.equal(capitalize(""), "");
});
