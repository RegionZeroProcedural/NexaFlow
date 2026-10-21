export function getSubtotal(price, quantity) {
  return price * quantity;
}

export function discountPrice(total, discount) {
  if (discount > 0) return total - discount;
  return total;
}
