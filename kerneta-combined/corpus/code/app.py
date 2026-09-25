"""Entry point that wires the whole flow together."""

from catalog import all_products
from cart import Cart
from checkout import checkout


def main():
    products = all_products()
    cart = Cart()
    cart.add("p1", 6)
    cart.add("p2", 2)
    receipt = checkout(cart, "gold")
    return receipt, len(products)


if __name__ == "__main__":
    print(main())
