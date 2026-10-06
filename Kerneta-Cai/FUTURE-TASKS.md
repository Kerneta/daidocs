# Future tasks (cai+python)

## 1. Scale > 10k memories: move the retriever to Rust  [PRIORITY when store grows]

The Python retriever in `py-mem/` (manifest filter + BM25 + symbol match) is the right
tool for a personal/project store. It is stdlib-only, plain text, no server. It stays fast
and simple up to roughly **10,000 items**.

Above ~10k memories (or when query latency or concurrent access starts to matter), the
pure-Python BM25 that re-tokenizes and re-scores every doc per query becomes the bottleneck.
At that point move retrieval to **Rust**:

- Evaluate **XERJ** (Apache-2.0, Rust, Elasticsearch-API-compatible) as the drop-in
  retrieval tier: it already does BM25 + vector + hybrid over millions of docs at sub-ms
  latency. Keep `.cai`/`.dai` as the canonical plain-text source of truth and treat the
  XERJ index as a rebuildable binary cache (never committed, never shipped, rebuilt via
  `xerj autoindex`). The tested binary is cached in this session's scratchpad.
- Or a smaller in-house Rust core: a persistent inverted index (BM25) + optional dense
  vectors, exposing the same interface `mem_search.py` uses, so the router does not change.
- Migration keeps the plain-text guarantee: Rust owns only the derived index, not the store.

Decision line: **under ~10k items and mostly keyword/entity queries -> stay on Python.
Above that, or when semantic recall + low latency matter -> Rust (XERJ first, evaluate).**

## 2. Optional: neural semantic recall in Python (before committing to Rust)

The Python retriever is lexical, so it misses keyword-free intent queries ("the code that
gives ten percent off"). If those start mattering below the 10k line, add a local-embedding
+ numpy cosine fallback in the same process (one binary vector cache; source stays plain
text). This buys XERJ-neural-style recall without the server. If it is not enough at scale,
that is another signal to move to Rust (task 1).

## 3. Enrich the .cai manifest so lexical search works on intent queries

`.cai`'s manifest is identifiers only, so BM25 scores ~0 on intent queries. Adding a short
per-symbol docstring/summary to the manifest (from the existing docstrings) would let the
Python retriever handle intent queries on code too, narrowing the gap to XERJ-neural without
embeddings.

## 4. Per-file incremental re-index (surfaced by the incremental-cost benchmark)

`cai_update.py` detects changed files by SHA1, but on any change it calls
`cai_ts_extract.build()` over the WHOLE corpus, so re-index cost scales with total repo
size, not with the size of the change. Measured on httpx (17 files): no-change update
4 ms (skips rebuild, good), one-file change 197 ms (full rebuild, same as cold build).
Fine for small repos; a real cost on large ones. Fix: extract only the changed/added
files and splice their symbols + edges into the existing store, removing rows for removed
/ changed modules first. XERJ already updates at per-document granularity; this closes
that gap.

## 5. Extract external-library API usage as cross-repo edges (surfaced by the cross-repo test)

The tree-sitter extractor only emits call/reference edges to symbols it can resolve inside
the same corpus. A consumer repo that does `import httpx` then `httpx.Client(...)`,
`client.get(...)`, `resp.raise_for_status()` produced ZERO usage edges (only `contains`).
So `cai_merge`'s `same_symbol_as` bridge links same-named DEFINITIONS across repos
(fork/vendor/override detection: it correctly caught a `build_request` override), but
"where does my project use library X's API" is not answerable structurally. Fix: record
attribute-call targets (`module.Symbol(...)`, `obj.method(...)`) as unresolved-external
edges tagged with the imported module, then resolve them to the library store during merge
by module + short name. Reference-coding retrieval already works cross-repo (member-recall
ties XERJ/Graphify at lower tokens); this adds the structural usage-mapping half.
