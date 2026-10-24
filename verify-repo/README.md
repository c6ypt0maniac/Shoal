# Shoal verify repo

A tiny repo for testing Shoal's verifier. The results are easy to check by hand.

| File | State | Its test | What Shoal should do |
|---|---|---|---|
| `src/pricing.js` | **Wrong** (2 bugs) | `test/pricing.test.js` fails every run | Flag it, and accept only a fix that makes the test pass 10/10 |
| `src/text.js` | **Correct** | `test/text.test.js` passes every run | Mark it healthy, and reject any fix that breaks it |

The bugs in `src/pricing.js`:
1. `applyDiscount(200, 25)` returns `175` instead of `150` (subtracts dollars, not percent).
2. `cartTotal` skips the last item, so it returns `25` instead of `37`.

Run the tests: `npm test`
