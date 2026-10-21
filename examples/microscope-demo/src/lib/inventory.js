export class Inventory {
  constructor(stock) {
    this.stock = { ...stock };
    this.log = [];
  }
  available(sku) {
    return this.stock[sku] ?? 0;
  }
  reserve(items) {
    for (const { sku, qty } of items) {
      if (this.available(sku) < qty) throw new Error(`not enough ${sku}`);
    }
    for (const { sku, qty } of items) {
      this.stock[sku] -= qty;
      this.log.push(`${sku} -${qty}`);
    }
    return true;
  }
}
