#!/usr/bin/env python
"""Make-this-change end-to-end (section 3): .cai vs Graphify vs raw, no XERJ.

Given a change request, the real test is whether a tool surfaces every function that must be
edited (the target plus its direct callers, from the AST). This dumps the context pack each
tool produces, so a blind agent can list the edit set from each pack alone; the answer is
graded against questions/change_gold.json (the AST impact set) by grade_change.py.

  python run_change.py        # writes results/changeblind_{cai,gf,raw}.json + change_tokens.json
"""
import json, math, os, subprocess, sys, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.join(HERE, "engine")
TS = os.path.join(ENGINE, "cai_ts_extract.py")
CAI_QUERY = os.path.join(ENGINE, "cai_query.py")
GF = os.path.expanduser("~/.local/bin/graphify")
if not os.path.exists(GF) and os.path.exists(GF + ".exe"):
    GF = GF + ".exe"


def toks(t):
    return max(1, math.ceil(len(t) / 4))


def main():
    src = os.path.join(HERE, "corpora/httpx/src")
    store = os.path.join(HERE, "results", "stores", "httpx")
    if not os.path.isdir(store):
        subprocess.run([sys.executable, TS, src, store], capture_output=True, text=True)
    graph = os.path.join(HERE, "corpora/httpx/graphify/graphify-out/graph.json")
    raw_dump = "\n".join("### %s\n%s" % (f, open(os.path.join(src, f), encoding="utf-8", errors="replace").read())
                         for f in sorted(os.listdir(src)) if f.endswith(".py"))
    tasks = json.load(open(os.path.join(HERE, "questions/change_gold.json"), encoding="utf-8"))
    cai_b, gf_b, raw_b, tokrows = [], [], [], []
    for t in tasks:
        cai = subprocess.run([sys.executable, CAI_QUERY, store, "callers", t["target"]],
                             capture_output=True, text=True).stdout
        gf = subprocess.run([GF, "query", t["q"], "--graph", graph], capture_output=True, text=True).stdout or ""
        cai_b.append({"n": t["n"], "question": t["q"], "context": cai})
        gf_b.append({"n": t["n"], "question": t["q"], "context": gf})
        raw_b.append({"n": t["n"], "question": t["q"], "context": raw_dump})
        tokrows.append({"n": t["n"], "target": t["target"], "cai_tok": toks(cai), "gf_tok": toks(gf), "raw_tok": toks(raw_dump)})
    out = os.path.join(HERE, "results")
    json.dump(cai_b, open(os.path.join(out, "changeblind_cai.json"), "w", encoding="utf-8"), indent=1)
    json.dump(gf_b, open(os.path.join(out, "changeblind_gf.json"), "w", encoding="utf-8"), indent=1)
    json.dump(raw_b, open(os.path.join(out, "changeblind_raw.json"), "w", encoding="utf-8"), indent=1)
    json.dump(tokrows, open(os.path.join(out, "change_tokens.json"), "w", encoding="utf-8"), indent=1)
    print("make-this-change: %d tasks; blind packs written to results/" % len(tasks))
    for r in tokrows:
        print("  t%d %s: cai=%d gf=%d raw=%d tok" % (r["n"], r["target"], r["cai_tok"], r["gf_tok"], r["raw_tok"]))


if __name__ == "__main__":
    main()
