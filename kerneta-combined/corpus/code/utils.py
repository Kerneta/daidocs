"""Low level helpers used across the package."""


def format_money(cents):
    """Render an integer number of cents as a dollar string."""
    return "${:.2f}".format(cents / 100)


def pct(value, percent):
    """Return `percent` percent of value, rounded to whole cents."""
    return round(value * percent / 100)
