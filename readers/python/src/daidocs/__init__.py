"""DaiDocs: a pure-Python reader for .dai memory stores, plus a CLI shim.

    from daidocs import Store
    store = Store("~/DaiDocs")
    for entry in store.manifest():
        print(entry["id"], entry["title"])
    doc = store.read(store.ids()[0])
    print(doc["understanding"]["summary"])

The reader is pure Python (pyyaml only, no Node). The ``daidocs`` command
installed alongside it forwards to the Node engine via npx.
"""

from .parse import parse_dai, parse_frontmatter, parse_understanding, parse_segments
from .store import Store

__version__ = "0.1.1"

__all__ = [
    "Store",
    "parse_dai",
    "parse_frontmatter",
    "parse_understanding",
    "parse_segments",
    "__version__",
]
