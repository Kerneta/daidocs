"""Option A test: does folding docstrings into the .cai search surface give it
semantic recall? Runs the 10 intent questions (no symbol names) before and after
enrichment, measuring gold-file hit rate and pack tokens. chars/4 estimator.

  python test_semantic_cai.py <cai_store> <semq.json>
"""
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mem_search as ms


def toks(t):
    return max(1, math.ceil(len(t) / 4))


def run(store, semq_path):
    qs = json.load(open(semq_path, encoding="utf-8"))
    for label, enrich in (("BEFORE (identifiers only)", False),
                          ("AFTER  (Option A: + docstrings)", True)):
        docs, _ = ms.load_cai(store, enrich=enrich)
        print("\n=== .cai semantic recall, {} ===".format(label))
        for K in (1, 3):
            hit = 0
            tot_tok = 0
            for q in qs:
                res_hits = ms.bm25_search(q["q"], docs, K)
                got = {docs[i]["id"] for i, _ in res_hits}
                gold = os.path.splitext(q["gold_file"])[0]
                if gold in got:
                    hit += 1
                tot_tok += toks(ms.pack_cai(store, docs, res_hits))
            print("  top-{}: gold-file {}/{}  |  pack {:.1f} tok/q".format(
                K, hit, len(qs), tot_tok / len(qs)))
    print("\n  reference (measured earlier): XERJ neural gold@1 8/10 @117 tok, gold@3 9/10 @378 tok")


if __name__ == "__main__":
    run(sys.argv[1], sys.argv[2])
