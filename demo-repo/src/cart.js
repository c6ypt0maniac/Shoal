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

  // Returns a promise that resolves once the discount has been applied.
  applyCoupon(code) {
    return lookupDiscount(code).then((rate) => {
      this.discount = rate;
    });
  }
}
