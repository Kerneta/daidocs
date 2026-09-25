"""Core data types for the shopping cart."""


class Product:
    def __init__(self, pid, name, price_cents):
        self.pid = pid
        self.name = name
        self.price_cents = price_cents


class CartItem:
    def __init__(self, product, qty):
        self.product = product
        self.qty = qty

    def line_cents(self):
        return self.product.price_cents * self.qty
