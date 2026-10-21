// Import the javascript-project folder using File → Import JS folder.
import { getSubtotal, discountPrice } from './lib/pricing.js';
import { tax } from './lib/tax.js';

export function calculateCheckout(price, quantity, discount) {
  let subtotal = getSubtotal(price, quantity);
  let discounted = discountPrice(subtotal, discount);
  let taxed = tax(discounted);
  let total = taxed + 5;
  total += 2;
  return total;
}

export function checkThreshold(price, quantity) {
  const projected = getSubtotal(price, quantity) + tax(price);
  return projected >= 100;
}
