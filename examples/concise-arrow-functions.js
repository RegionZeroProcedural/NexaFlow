// Load this file with File → Import JS file(s)… and select a function.
// Expression-bodied arrows are implicit returns; no braces are needed.
export const double = value => value * 2;
export const total = (price, quantity) => price * quantity;
export const safePrice = value => value > 0 ? value : 0;

// This is valid JavaScript but the current restricted interpreter cannot
// compute an object literal; it imports as a visible unsupported return node.
export const record = value => ({ value, valid: true });

// Preserves normal block-bodied functions, too.
export function withStatements(x) {
  const subtotal = x * 3;
  return subtotal + 1;
}
