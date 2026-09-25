# Kerneta combined: .cai code memory + .dai document memory

One plain-text memory layer that unifies the two halves:

- **`.cai`** deterministic code graph (10 languages, tree-sitter): callers, callees,
  imports, defines, transitive deps, analysis.
- **`.dai`-lite** document memory: markdown/text split into segments (the offline slice
  of DaiDocs; real `.dai` adds LLM Understanding on top).
- **Cross-links** connect the two: every doc segment that names a code symbol or module
  is linked to it both ways (`mentions` and `documented_by`). This is the payoff neither
  half has alone: a single query returns the code *and* the prose that explains it.

## Pipeline

```
corpus/code  -> cai_ts_extract.py  -> store-code    (code graph)
corpus/docs  -> dai_lite.py        -> store-docs     (doc segments)
store-code + store-docs -> cai_dai_combine.py -> store-combined  (+ cross-links)
```

`cai_dai_combine.py` scans each doc segment for whole-word occurrences of known code
symbol and module names and emits `mentions` / `documented_by` edges. Deterministic, no
LLM (prose semantics remain the model leaf, handled by real DaiDocs).

## Query (engine/combined_query.py)

Code questions delegate to the `.cai` ops; cross-store ops use the links:

| op | answer |
|---|---|
| `callers` / `callees` / `imports` / `defines` / `tdeps` / `path` / `most_imported` | code graph (from `.cai`) |
| `docs_for <symbol>` | documents/segments that document a code symbol |
| `describes <docmod>` | code symbols a document covers |
| `why <symbol>` | code definition + what it calls + who calls it + the prose that explains it |
| `ask "<question>"` | natural-language router across code and docs |

Example (`why cart_total`) returns, in one slice: `fn cart_total defined in pricing`,
its calls (`item_price`, `loyalty_discount`, `format_money`), its caller (`cart.total`),
and the two spec segments that describe it.

## Build and test

```
PY=../kerneta-cai/.venv/Scripts/python.exe   # tree-sitter env (10 grammars)
$PY engine/cai_ts_extract.py corpus/code store-code
$PY engine/dai_lite.py        corpus/docs store-docs
$PY engine/cai_dai_combine.py store-code store-docs store-combined
$PY engine/combined_query.py  store-combined why cart_total
$PY bench/test_combined.py    # 14 assertions, all passing
```

## Status

- Built and tested: routing, doc segmentation, code<->doc cross-links, unified query,
  NL routing. `bench/test_combined.py` passes 14/14.
- The code half carries the full `.cai` engine (analysis, exporters, incremental,
  cross-repo, serve) from `engine/`.
- `.dai`-lite is the offline document slice; wiring real DaiDocs LLM Understanding in
  place of it is the one remaining upgrade for full document-semantic parity.
