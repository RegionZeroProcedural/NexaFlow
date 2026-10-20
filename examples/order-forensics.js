// Nexa Flow v0.4 demonstration: valid JavaScript, incorrect business logic.
// Import using File > Import JavaScript function. Nothing in this file is executed by Nexa Flow.
export function calculateOrder(price, quantity, discount) {
  const subtotal = price * quantity;
  const discounted = subtotal - discount;
  const tax = discounted * 0.08;
  const total = discounted + tax;

  if (total < 0) {
    return total;
  }
  return total;
}
