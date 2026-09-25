"""Price computation. Sits between discounts/utils and the cart."""

from discounts import bulk_discount, loyalty_discount
from utils import format_money


def item_price(cart_item):
    """Net cents for one cart line after any bulk discount."""
    gross = cart_item.line_cents()
    saved = bulk_discount(cart_item.qty, gross)
    return gross - saved


def cart_total(items, tier):
    """Total for all items after per line and loyalty discounts.

    Returns a tuple of (net_cents, human_string).
    """
    subtotal = 0
    for it in items:
        subtotal += item_price(it)
    saved = loyalty_discount(subtotal, tier)
    net = subtotal - saved
    return net, format_money(net)
