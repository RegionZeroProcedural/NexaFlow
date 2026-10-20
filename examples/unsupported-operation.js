// Safe import demonstration: the external call is NEVER executed in Nexa Flow.
import { notifyAccounting } from './accounting.js';
export function processOrder(price, quantity) {
  const total = price * quantity;
  if (total > 500) {
    notifyAccounting(total); // Preserved in exports, blocked in simulation.
  }
  return total;
}
