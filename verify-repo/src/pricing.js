// Checkout math.

// Percent discount, e.g. applyDiscount(200, 25) -> 150.
export function applyDiscount(price, percent) {
  return (price * (100 - percent)) / 100;
}

// Sum of price * qty for every line item.
export function cartTotal(items) {
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    total += items[i].price * items[i].qty;
  }
  return total;
}
