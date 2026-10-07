#!/usr/bin/env python
"""httpx semantic + lookup retrieval (section 2 tail): .cai vs Graphify (no XERJ).

semantic: a natural-language description of a behaviour, answer is the symbol/module that
implements it. lookup: "where is X defined". For .cai this is the hybrid retrieval the
product uses (lexical BM25F fused with MiniLM embeddings, returning compact symbol slices);
for Graphify it is a native graph query. Metric is recall (gold file in the retrieved set)
and top-1, plus average pack tokens.

Needs: pip install sentence-transformers (MiniLM runs locally, offline). Graphify installed.

  python run_semantic.py   # writes results/semantic.json and prints the table
"""
import json, math, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.join(HERE, "engine")
sys.path.insert(0, ENGINE)
os.environ.setdefault("HF_HUB_OFFLINE", "0")
import cai_symbol as cs
import mem_search_plus as mp
import numpy as np
from sentence_transformers import SentenceTransformer

TS = os.path.join(ENGINE, "cai_ts_extract.py")
GF = os.path.expanduser("~/.local/bin/graphify")
if not os.path.exists(GF) and os.path.exists(GF + ".exe"):
    GF = GF + ".exe"
SRC = os.path.join(HERE, "corpora/httpx/src")
STORE = os.path.join(HERE, "results", "stores", "httpx")
GRAPH = os.path.join(HERE, "corpora/httpx/graphify/graphify-out/graph.json")
K = 10  # re-calibrated for method-level symbol docs (keeps the ~700-token budget)


def toks(t):
    return max(1, math.ceil(len(t) / 4))


def stem(f):
    return os.path.splitext(os.path.basename(str(f)))[0]


def main():
    if not os.path.isdir(STORE):
        subprocess.run([sys.executable, TS, SRC, STORE], capture_output=True, text=True)
    docs = cs.build_symbol_docs(STORE, SRC)
    nidx = cs.name_index(STORE)
    model = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")
    texts = [" ".join([d["fields"]["name"], d["fields"].get("doc", ""), d["fields"].get("sig", ""),
                       d["fields"].get("struct", "")]) for d in docs]
    E = np.asarray(model.encode(texts, normalize_embeddings=True, batch_size=64, show_progress_bar=False))

    def cai_retrieve(q):
        lex = cs.retrieve(docs, q, 15); lex_idx = [docs.index(d) for d in lex]
        qv = model.encode([q], normalize_embeddings=True)[0]
        emb_idx = list(np.argsort(-(E @ qv))[:15])
        score = {}
        for r, i in enumerate(lex_idx): score[i] = score.get(i, 0) + 1.0 / (r + 1)
        for r, i in enumerate(emb_idx): score[i] = score.get(i, 0) + 1.0 / (r + 1)
        qtoks = set(mp.tokenize(q))
        name_hits = [i for i, d in enumerate(docs) if d["name"].lower() in qtoks]
        order = name_hits + [i for i in sorted(score, key=lambda i: score[i], reverse=True) if i not in name_hits]
        picked, seen = [], set()
        for i in order:
            if i not in seen:
                seen.add(i); picked.append(i)
            if len(picked) >= K:
                break
        mods = [docs[i]["module"] for i in picked]
        pack = "\n".join(docs[i]["block"] for i in picked)
        return pack, toks(pack), mods

    qs = json.load(open(os.path.join(HERE, "questions/questions_hx.json"), encoding="utf-8"))
    agg = {}
    for q in qs:
        sub = q.get("sub")
        if sub not in ("semantic", "lookup"):
            continue
        gfile = stem(q.get("gold_file", "")); gsym = str(q.get("gold_sym", ""))
        cp, ct, cmods = cai_retrieve(q["q"])
        gp = subprocess.run([GF, "query", q["q"], "--graph", GRAPH], capture_output=True, text=True).stdout or ""
        gt = toks(gp)
        cai_hit = gfile in [stem(m) for m in cmods]
        cai_top1 = bool(cmods) and stem(cmods[0]) == gfile
        gf_hit = (gfile and gfile in gp) or (gsym and gsym in gp)
        a = agg.setdefault(sub, {"n": 0, "ct": 0, "gt": 0, "ch": 0, "c1": 0, "gh": 0})
        a["n"] += 1; a["ct"] += ct; a["gt"] += gt
        a["ch"] += 1 if cai_hit else 0; a["c1"] += 1 if cai_top1 else 0; a["gh"] += 1 if gf_hit else 0

    json.dump(agg, open(os.path.join(HERE, "results", "semantic.json"), "w"), indent=2)
    print("\nhttpx semantic + lookup (.cai vs Graphify, no XERJ)\n")
    print("  %-9s n  cai_recall cai_top1 gf_recall  cai_tok gf_tok" % "sub")
    for sub in ("semantic", "lookup"):
        if sub not in agg:
            continue
        a = agg[sub]; n = a["n"]
        print("  %-9s %-2d  %5.0f%%     %5.0f%%   %5.0f%%     %5.0f  %5.0f" % (
            sub, n, a["ch"] / n * 100, a["c1"] / n * 100, a["gh"] / n * 100, a["ct"] / n, a["gt"] / n))


if __name__ == "__main__":
    main()
