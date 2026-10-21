const PRICES = { pen: 1.5, book: 12, lamp: 30 };

export function priceOrder(items, rates) {
  let subtotal = 0;
  for (let i = 0; i < items.length; i++) {
    const { sku, qty } = items[i];
    const unit = PRICES[sku];
    subtotal += qty >= 10 ? unit * qty * 0.9 : unit * qty;
  }
  return round(subtotal * (1 + rates.tax));
}

export function applyCoupon(total, code) {
  switch (code) {
    case 'SAVE10': return round(total * 0.9);
    case 'HALF': return round(total / 2);
    default: return total;
  }
}

export const round = n => Math.round(n * 100) / 100;
