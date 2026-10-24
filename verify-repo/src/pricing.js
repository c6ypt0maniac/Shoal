// Checkout math. This file is WRONG on purpose: Shoal should flag it.

// Percent discount, e.g. applyDiscount(200, 25) -> 150.
export function applyDiscount(price, percent) {
  // BUG: subtracts the percent as dollars instead of a percentage.
  return price - percent;
}

// Sum of price * qty for every line item.
export function cartTotal(items) {
  let total = 0;
  // BUG: off by one, the last item is never counted.
  for (let i = 0; i < items.length - 1; i++) {
    total += items[i].price * items[i].qty;
  }
  return total;
}
