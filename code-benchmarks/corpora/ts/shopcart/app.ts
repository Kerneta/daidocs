import { all_products } from "./catalog.js";
import { Cart } from "./cart.js";
import { checkout } from "./checkout.js";

export function main() {
  const products = all_products();
  const cart = new Cart();
  cart.add("p1", 6);
  cart.add("p2", 2);
  const receipt = checkout(cart, "gold");
  return [receipt, products.length];
}
