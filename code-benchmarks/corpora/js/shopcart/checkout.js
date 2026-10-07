import { cart_total } from "./pricing.js";
import { format_money } from "./utils.js";

export function checkout(cart, tier) {
  const [net, human] = cart.total(tier);
  const label = format_money(net);
  return "TOTAL " + label;
}
