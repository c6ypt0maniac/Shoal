// Shopping cart for the Aggie merch store.

const COUPONS = { GIGEM: 0.12, HOWDY: 0.05 };

// Pretend this hits a pricing service with variable latency.
function lookupDiscount(code) {
  return new Promise((resolve) => {
    setTimeout(() => resolve(COUPONS[code] ?? 0), Math.random() * 60);
  });
}

export class Cart {
  constructor() {
    this.items = [];
    this.discount = 0;
  }

  add(name, price, qty = 1) {
    this.items.push({ name, price, qty });
  }

  get subtotal() {
    return this.items.reduce((sum, i) => sum + i.price * i.qty, 0);
  }

  get total() {
    return Math.round(this.subtotal * (1 - this.discount) * 100) / 100;
  }

  // BUG: fires the lookup but never returns the promise, so callers
  // can't wait for the discount to actually be applied.
  applyCoupon(code) {
    lookupDiscount(code).then((rate) => {
      this.discount = rate;
    });
  }
}
