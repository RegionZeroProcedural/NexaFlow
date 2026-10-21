// Nexa Flow v0.9: import this file and choose which function to investigate.
// NOTE: Code is parsed, NEVER executed by Nexa Flow.
export function calculateShipping(weight, distance) {
  const base = weight * 2;
  const travel = distance * 0.25;
  const total = base + travel;
  return total;
}

export const calculateCheckout = (price, quantity, discount) => {
  const subtotal = price * quantity;
  const discounted = subtotal - discount;
  // This operation is unsupported. Nexa Flow skips it and marks potentially
  // affected state UNKNOWN rather than calling the external function.
  notifyAccounting(discounted);
  const tax = discounted * 0.08;
  const finalTotal = discounted + tax;
  return finalTotal;
};

export function isolatedUncertainty(amount) {
  let result = someExternalCalculation(amount); // result becomes UNKNOWN
  let independent = 5 * 4; // safe; still simulated and tracked
  return result + independent; // UNKNOWN (not falsely reported as 20)
}
