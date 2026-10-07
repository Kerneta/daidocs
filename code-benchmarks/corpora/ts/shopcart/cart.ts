import { CartItem } from "./models.js";
import { find_product } from "./catalog.js";
import { cart_total } from "./pricing.js";

export class Cart {
  constructor() {
    this.items = [];
  }
  add(pid, qty) {
    const product = find_product(pid);
    if (!product) {
      throw new Error(pid);
    }
    this.items.push(new CartItem(product, qty));
  }
  total(tier) {
    return cart_total(this.items, tier);
  }
}
