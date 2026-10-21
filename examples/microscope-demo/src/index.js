import { Inventory } from './lib/inventory.js';
import { priceOrder, applyCoupon } from './lib/pricing.js';
import { fetchRates } from './lib/rates.js';

const ORDERS = [
  { id: 'A1', items: [{ sku: 'pen', qty: 3 }, { sku: 'book', qty: 1 }], coupon: 'SAVE10' },
  { id: 'B2', items: [{ sku: 'lamp', qty: 1 }, { sku: 'ghost', qty: 2 }] },
  { id: 'C3', items: [{ sku: 'pen', qty: 40 }] },
];

export async function main() {
  const inventory = new Inventory({ pen: 50, book: 4, lamp: 0 });
  const rates = await fetchRates();
  const report = [];
  for (const order of ORDERS) {
    const result = processOrder(order, inventory, rates);
    report.push(result);
    if (!result.ok) console.warn(`order ${order.id} rejected: ${result.reason}`);
  }
  const revenue = report.filter(r => r.ok).reduce((sum, r) => sum + r.total, 0);
  console.log('revenue', revenue);
  return { revenue, report };
}

function processOrder(order, inventory, rates) {
  try {
    inventory.reserve(order.items);
  } catch (error) {
    return { id: order.id, ok: false, reason: error.message };
  }
  let total = priceOrder(order.items, rates);
  if (order.coupon) total = applyCoupon(total, order.coupon);
  return { id: order.id, ok: true, total };
}

main();
