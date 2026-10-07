# Reproducing the Kerneta .cai benchmarks (read this first)

Build every .cai store with the TREE-SITTER extractor, which is the one the product
uses and the one the published numbers were produced with:

    python engine/cai_ts_extract.py <corpus_dir> <store_dir>

Do NOT build stores with `engine/cai_extract.py`. That file is deprecated, AST-only,
and used by nothing in the product. A store built with it is missing `extends` edges
and has partial import capture, so subclasses queries return nothing and import rows
under-score. This will look like a regression but is only a wrong-extractor mistake.

Quick check that a store was built correctly: `grep -c '"type": "extends"'
<store>/edges.jsonl` should be > 0 on any corpus that has class inheritance.

The product itself always uses cai_ts_extract.py (see engine/cai_hook_resolve.py,
engine/cai_route.py, engine/cai_update.py, engine/cai_install.py).
