"""Checkout flow. Turns a cart into a receipt line."""

from pricing import cart_total
from utils import format_money


def checkout(cart, tier):
    """Produce a receipt string for the given cart and tier."""
    net, human = cart.total(tier)
    label = format_money(net)
    return "TOTAL {}".format(label)
