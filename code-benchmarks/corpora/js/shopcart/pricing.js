import { bulk_discount, loyalty_discount } from "./discounts.js";
import { format_money } from "./utils.js";

export function item_price(cart_item) {
  const gross = cart_item.line_cents();
  const saved = bulk_discount(cart_item.qty, gross);
  return gross - saved;
}

export function cart_total(items, tier) {
  let subtotal = 0;
  for (const it of items) {
    subtotal += item_price(it);
  }
  const saved = loyalty_discount(subtotal, tier);
  const net = subtotal - saved;
  return [net, format_money(net)];
}
