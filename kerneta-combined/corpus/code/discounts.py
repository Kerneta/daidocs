"""Discount rules. Depends only on utils."""

from utils import pct


def bulk_discount(qty, price_cents):
    """Ten percent off when buying five or more of one line."""
    if qty >= 5:
        return pct(price_cents, 10)
    return 0


def loyalty_discount(price_cents, tier):
    """Tier based discount applied to the whole order."""
    rates = {"silver": 2, "gold": 5, "platinum": 8}
    return pct(price_cents, rates.get(tier, 0))
