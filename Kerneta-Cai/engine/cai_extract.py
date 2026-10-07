"""DEPRECATED - do not use. Legacy AST-only extractor, NOT used by the product.

The Kerneta .cai store is built by cai_ts_extract.py (tree-sitter, all languages),
which every product component imports (cai_hook_resolve.py, cai_route.py,
cai_update.py) and which the published benchmark stores were built with. That
extractor captures full imports (including `from . import x` and TYPE_CHECKING)
and the imports_from / extends / method / calls edges.

Building a store with THIS file instead yields a weaker store (no extends edges,
partial imports) that will NOT reproduce the published numbers. To build a store
or reproduce a benchmark, always use:

    python cai_ts_extract.py <corpus_dir> <store_dir>
"""
import sys

if __name__ == "__main__":
    sys.stderr.write(
        "cai_extract.py is deprecated and unused by the product. Build the store "
        "with cai_ts_extract.py instead:\n"
        "    python cai_ts_extract.py <corpus_dir> <store_dir>\n"
    )
    sys.exit(2)

