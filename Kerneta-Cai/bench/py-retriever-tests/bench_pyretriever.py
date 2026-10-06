"""With/without benchmark for the Python retriever, on .cai and .dai.

Shows what each retrieval stage buys versus the no-retriever baseline (dump).
Token estimate chars/4, identical across configs, so ratios are fair.

  python bench_pyretriever.py <cai_store> <dai_store> <cai_questions.json>
"""

import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mem_search as ms


def toks(t):
    return max(1, math.ceil(len(t) / 4))


# ---------------------------------------------------------------- .cai
def bench_cai(store, questions_path):
    qs = json.load(open(questions_path, encoding="utf-8"))
    docs, symbols = ms.load_cai(store)
    # baseline pack = dump every .cai file
    dump = ms.pack_cai(store, docs, [(i, 0.0) for i in range(len(docs))])
    dump_tok = toks(dump)

    print("\n================ .cai (shopcart, {} questions) ================".format(len(qs)))
    print("baseline 'dump all .cai files': {} tok/query (gold always present)".format(dump_tok))
    for K in (1, 3):
        bm_tok = 0
        bm_recall = 0
        sym_hit = 0
        for q in qs:
            res, _ = ms.retrieve("cai", store, q["question"], k=K, stage="bm25")
            pack = ms.pack_cai(store, docs, res["hits"])
            bm_tok += toks(pack)
            gold_files = {os.path.splitext(f)[0] for f in q.get("raw", []) if f != "ALL"}
            got = {docs[i]["id"] for i, _ in res["hits"]}
            if gold_files and gold_files & got:
                bm_recall += 1
            # symbol stage
            sres, _ = ms.retrieve("cai", store, q["question"], k=K, stage="symbol")
            gsym = q["gold"].lower()
            if any(n.lower() in gsym or n.lower() in q["question"].lower()
                   for _, n in sres["symbol_hits"]):
                sym_hit += 1
        n = len(qs)
        print("  BM25 top-{}:   {:.1f} tok/q  ({:.1f}x vs dump)  gold-file hit {}/{}  | symbol-match hit {}/{}".format(
            K, bm_tok / n, dump_tok / (bm_tok / n), bm_recall, n, sym_hit, n))
    print("  note: .cai manifest is identifiers only (no prose), so BM25 helps only when the")
    print("        query names a symbol/keyword; intent-only queries need symbol/structural ops or XERJ-neural.")


# ---------------------------------------------------------------- .dai
DAI_QUERIES = [
    "token reduction benchmark versus graphify",
    "manifest scan cost and the three zoom reading protocol",
    "longmemeval accuracy score",
    "payments migration from stripe to adyen deadline",
    "how the observer extracts facts and events",
    "em dash writing style rule",
]


def bench_dai(store):
    docs = ms.load_dai(store)
    # baseline A: dump the whole manifest (the naive 'plan by reading everything')
    manifest_path = os.path.join(store, "_index", "manifest.jsonl")
    manifest_tok = toks(open(manifest_path, encoding="utf-8").read())
    # baseline B: dump the whole corpus (all .dai understanding blocks)
    whole = ms.pack_dai(store, docs, [(i, 0.0) for i in range(len(docs))])
    whole_tok = toks(whole)

    print("\n================ .dai ({} memories) ================".format(len(docs)))
    print("baseline 'dump whole manifest': {} tok   |   'dump all Understanding blocks': {} tok".format(
        manifest_tok, whole_tok))
    for K in (3, 5):
        tot = 0
        for q in DAI_QUERIES:
            res, _ = ms.retrieve("dai", store, q, k=K, stage="all")
            pack = ms.pack_dai(store, docs, res["hits"])
            tot += toks(pack)
        avg = tot / len(DAI_QUERIES)
        print("  retriever top-{} (manifest-filter + BM25 -> read Understanding): {:.0f} tok/q  "
              "({:.0f}x vs manifest-dump, {:.0f}x vs corpus-dump)".format(
                  K, avg, manifest_tok / avg, whole_tok / avg))
    print("  sample query -> top hits:")
    for q in DAI_QUERIES[:3]:
        res, _ = ms.retrieve("dai", store, q, k=3, stage="all")
        print("   '{}' -> {}".format(q[:44], ", ".join(docs[i]["id"] for i, _ in res["hits"])))


if __name__ == "__main__":
    cai_store, dai_store, cai_q = sys.argv[1], sys.argv[2], sys.argv[3]
    bench_cai(cai_store, cai_q)
    bench_dai(dai_store)
