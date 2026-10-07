export class Product {
  constructor(pid, name, price_cents) {
    this.pid = pid;
    this.name = name;
    this.price_cents = price_cents;
  }
}

export class CartItem {
  constructor(product, qty) {
    this.product = product;
    this.qty = qty;
  }
  line_cents() {
    return this.product.price_cents * this.qty;
  }
}
