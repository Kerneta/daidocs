"""Measure the free Python enhancements vs plain BM25 free-signals, on documented
and stripped corpora. Accuracy (gold-file @top-k) + pack tokens (chars/4).

  python test_plus.py <cai_store> <documented_corpus> <stripped_corpus> <semq.json>
"""
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mem_search as ms
import mem_search_plus as mp


def toks(t):
    return max(1, math.ceil(len(t) / 4))


def load(store, corpus):
    manifest = ms._read_jsonl(os.path.join(store, "manifest.jsonl"))
    docs = []
    for m in manifest:
        path = os.path.join(corpus, m.get("path", ""))
        src = open(path, encoding="utf-8").read() if os.path.exists(path) else ""
        f = mp.extract_fields(src, m.get("module", ""), m.get("symbols", []), m.get("imports", []))
        docs.append({"id": m.get("module"), "fields": f,
                     "flat": " ".join(f[k] for k in mp.FIELDS)})
    return docs


def pack(store, ids, strip_doc):
    parts = []
    for mid in ids:
        p = os.path.join(store, "files", mid + ".cai")
        if not os.path.exists(p):
            continue
        txt = open(p, encoding="utf-8").read()
        if strip_doc:
            txt = "\n".join(l for l in txt.splitlines() if not l.strip().lower().startswith("doc:"))
        parts.append(txt)
    return toks("\n".join(parts))


def baseline(docs, q, k):
    # plain equal-weight BM25 over all free-signal text, no expansion, no rerank
    toklists = [ms.tokenize(d["flat"]) for d in docs]
    bm = ms.BM25(toklists)
    scores = bm.scores(ms.tokenize(q))
    ranked = sorted(range(len(docs)), key=lambda i: scores[i], reverse=True)[:k]
    return [docs[i]["id"] for i in ranked]


def enhanced(docs, q, k):
    bm = mp.BM25F([d["fields"] for d in docs])
    qexp = mp.expand_query(q)
    scores = bm.scores(qexp)
    topN = sorted(enumerate(scores), key=lambda x: x[1], reverse=True)[:8]
    reranked = mp.rerank(topN, [d["fields"] for d in docs], qexp)[:k]
    return [docs[i]["id"] for i, _ in reranked]


def run(store, doc_corpus, strip_corpus, semq):
    qs = json.load(open(semq, encoding="utf-8"))
    for world, corpus, strip in (("DOCUMENTED", doc_corpus, False),
                                 ("STRIPPED (no docstrings)", strip_corpus, True)):
        docs = load(store, corpus)
        print("\n=== {} ===".format(world))
        print("  {:<34} top-1   top-3   tok1  tok3".format("method"))
        for name, fn in (("baseline plain BM25 (free-signals)", baseline),
                         ("enhanced BM25F+expand+rerank", enhanced)):
            row = []
            for K in (1, 3):
                hit = 0
                tot = 0
                for q in qs:
                    ids = fn(docs, q["q"], K)
                    if os.path.splitext(q["gold_file"])[0] in set(ids):
                        hit += 1
                    tot += pack(store, ids, strip)
                row.append((hit, tot / len(qs)))
            print("  {:<34} {}/10    {}/10    {:.0f}   {:.0f}".format(
                name, row[0][0], row[1][0], row[0][1], row[1][1]))


if __name__ == "__main__":
    run(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4])
