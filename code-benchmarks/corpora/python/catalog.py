"""In memory product catalog."""

from models import Product

_CATALOG = [
    Product("p1", "Notebook", 450),
    Product("p2", "Pen", 120),
    Product("p3", "Backpack", 3800),
]


def find_product(pid):
    """Return the Product with this id or None."""
    for prod in _CATALOG:
        if prod.pid == pid:
            return prod
    return None


def all_products():
    """Return the whole catalog."""
    return list(_CATALOG)
