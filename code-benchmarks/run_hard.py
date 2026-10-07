#!/usr/bin/env python
"""Hard paraphrase end-to-end (section 4): .cai vs Graphify (no XERJ).

12 behaviour questions about httpx that never name the target symbol, so the answerer must
reason from retrieved code. Gold-in-pack is the solvability ceiling (was the right code
retrieved at all); solved is a blind agent's answer graded against the parser's gold.

This dumps each tool's blind pack and reports gold-in-pack; run the blind agent over the
packs and grade with grade_hard.py.

Needs: sentence-transformers (MiniLM, offline). Graphify installed.

  python run_hard.py
"""
import json, math, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.join(HERE, "engine")
sys.path.insert(0, ENGINE)
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
K = 8


def toks(t):
    return max(1, math.ceil(len(t) / 4))


def main():
    if not os.path.isdir(STORE):
        subprocess.run([sys.executable, TS, SRC, STORE], capture_output=True, text=True)
    docs = cs.build_symbol_docs(STORE, SRC)
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
        return "\n".join(docs[i]["block"] for i in picked)

    gold = json.load(open(os.path.join(HERE, "questions/hard_gold.json"), encoding="utf-8"))
    cai_b, gf_b, rows = [], [], []
    for t in gold:
        cp = cai_retrieve(t["q"]); ct = toks(cp)
        gp = subprocess.run([GF, "query", t["q"], "--graph", GRAPH], capture_output=True, text=True).stdout or ""
        gt = toks(gp)
        cai_b.append({"n": t["n"], "question": t["q"], "context": cp})
        gf_b.append({"n": t["n"], "question": t["q"], "context": gp})
        rows.append({"n": t["n"], "gold_sym": t["gold_sym"],
                     "cai_tok": ct, "gf_tok": gt,
                     "cai_in_pack": t["gold_sym"].lower() in cp.lower(),
                     "gf_in_pack": t["gold_sym"].lower() in gp.lower()})
    out = os.path.join(HERE, "results")
    json.dump(cai_b, open(os.path.join(out, "hardblind_cai.json"), "w", encoding="utf-8"), indent=1)
    json.dump(gf_b, open(os.path.join(out, "hardblind_gf.json"), "w", encoding="utf-8"), indent=1)
    json.dump(rows, open(os.path.join(out, "hard_pack.json"), "w", encoding="utf-8"), indent=1)
    n = len(gold)
    cip = sum(1 for r in rows if r["cai_in_pack"]); gip = sum(1 for r in rows if r["gf_in_pack"])
    print("hard paraphrase: %d questions" % n)
    print("  gold-in-pack: .cai %d/%d  Graphify %d/%d" % (cip, n, gip, n))
    print("  avg tokens:   .cai %d  Graphify %d" % (sum(r["cai_tok"] for r in rows) // n, sum(r["gf_tok"] for r in rows) // n))


if __name__ == "__main__":
    main()
