// Order ID generation for the Aggie merch store.

// BUG: only 200 possible IDs, so collisions are common under load.
export function generateOrderId() {
  return `ORD-${Math.floor(Math.random() * 200)}`;
}
