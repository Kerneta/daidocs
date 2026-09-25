"""The shopping cart. Ties catalog, models and pricing together."""

from models import CartItem
from catalog import find_product
from pricing import cart_total


class Cart:
    def __init__(self):
        self.items = []

    def add(self, pid, qty):
        """Look up a product by id and add a line to the cart."""
        product = find_product(pid)
        if product is None:
            raise KeyError(pid)
        self.items.append(CartItem(product, qty))

    def total(self, tier):
        """Net total for the cart at a loyalty tier."""
        return cart_total(self.items, tier)
