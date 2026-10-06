"""v4 semantic + lookup search over a .cai store.

Adds token-cheap "find the code that does X" and "where is X" retrieval on top of
the deterministic .cai graph. Uses retrieve_hybrid: per-symbol BM25F ranking over a
body-enriched surface (name + docstring + signature + comments + string-literals +
body identifiers), plus a module-fallback that surfaces the module for any query token
that exactly matches a known symbol name (recovers methods). Returns compact per-symbol
slices, not whole files.

Run: python cai_search.py <cai_store> <src_dir> "<query>" [k]
  <cai_store>  a store built by cai_ts_extract.py
  <src_dir>    the source directory the store was built from (for signatures/body)
  k            number of slices to return (default 5)
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cai_symbol as cs


def main():
    if len(sys.argv) < 4:
        print(__doc__)
        return
    store, src, query = sys.argv[1], sys.argv[2], sys.argv[3]
    k = int(sys.argv[4]) if len(sys.argv) > 4 else 5
    docs = cs.build_symbol_docs(store, src)
    nidx = cs.name_index(store)
    mods, pack = cs.retrieve_hybrid(docs, nidx, query, k)
    print("slice: v4 search for '{}' (top {})".format(query, k))
    print(pack if pack else "- (no match)")


if __name__ == "__main__":
    main()
