import { Product } from "./models.js";

const CATALOG = [
  new Product("p1", "Notebook", 450),
  new Product("p2", "Pen", 120),
  new Product("p3", "Backpack", 3800),
];

export function find_product(pid) {
  for (const prod of CATALOG) {
    if (prod.pid === pid) {
      return prod;
    }
  }
  return null;
}

export function all_products() {
  return CATALOG.slice();
}
