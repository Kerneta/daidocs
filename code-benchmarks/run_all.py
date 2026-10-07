#!/usr/bin/env python
"""Reproduce the Kerneta .cai vs Graphify vs raw code-retrieval benchmarks.

Self-contained and offline. For every suite it REBUILDS the .cai store from the corpus
source with the tree-sitter extractor (engine/cai_ts_extract.py, the extractor the product
uses), queries each system, grades programmatically against the suite's own gold, and
measures token cost (chars/4, applied identically to all systems). No API key, no network.

  python run_all.py

Writes results/RESULTS.md and results/results.json. Graphify must be installed
(https://graphify.dev) at ~/.local/bin/graphify; the corpus graphs are pre-built on disk.
"""
import json, math, os, subprocess, sys, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.join(HERE, "engine")
TS = os.path.join(ENGINE, "cai_ts_extract.py")
CAI_QUERY = os.path.join(ENGINE, "cai_query.py")
GF = os.path.expanduser("~/.local/bin/graphify")
if not os.path.exists(GF) and os.path.exists(GF + ".exe"):
    GF = GF + ".exe"
STORES = os.path.join(HERE, "results", "stores")
TOKRE_SPLIT = __import__("re").compile(r"[A-Za-z_][A-Za-z0-9_]*")


def toks(t):
    return max(1, math.ceil(len(t) / 4))


def tokenset(t):
    return {w.lower() for w in TOKRE_SPLIT.findall(t)}


def build(corpus, name):
    dest = os.path.join(STORES, name)
    if os.path.isdir(dest):
        shutil.rmtree(dest)
    subprocess.run([sys.executable, TS, corpus, dest], capture_output=True, text=True)
    return dest


def cai_pack(store, op, args):
    return subprocess.run([sys.executable, CAI_QUERY, store, op] + [str(a) for a in args],
                          capture_output=True, text=True).stdout


def raw_pack(corpus, ext, raw):
    names = ([f for f in sorted(os.listdir(corpus)) if f.endswith(ext)]
             if raw == ["ALL"] else [m + ext for m in raw])
    parts = []
    for n in names:
        p = os.path.join(corpus, n)
        if os.path.isfile(p):
            parts.append("### {}\n{}".format(n, open(p, encoding="utf-8", errors="replace").read()))
    return "\n".join(parts)


def gf_pack(graph, gf, ext):
    args = [a.replace("{ext}", ext) for a in gf]
    return subprocess.run([GF, args[0]] + args[1:] + ["--graph", graph],
                          capture_output=True, text=True).stdout or ""


def grade(pack, q):
    ts = tokenset(pack)
    gold = [g.lower() for g in q["gold"]]
    distract = [d.lower() for d in q.get("distract", [])]
    has_gold = all(g in ts for g in gold)
    has_distract = any(d in ts for d in distract)
    if q.get("gtype") == "empty":
        return not has_distract
    if q.get("gtype") == "set":
        return has_gold and not has_distract
    if q.get("gtype") == "any":   # correct if ANY listed gold is present (e.g. a tie)
        return any(g in ts for g in gold)
    return has_gold


# label, build-corpus, raw-corpus, graph, questions, ext
SUMMARY = [
    ("psf/requests (ast oracle)", "corpora/requests", "corpora/requests",
     "corpora/requests/graphify-out/graph.json", "questions/questions_realrepo.json", ".py"),
    ("Real-code retrieval", "corpora/cbench", "corpora/cbench",
     "corpora/cbench/graphify-out/graph.json", "questions/questions_contextbench.json", ".py"),
    ("Deep multi-hop (constructed)", "corpora/longmemcode", "corpora/longmemcode",
     "corpora/longmemcode/graphify-out/graph.json", "questions/questions_longmemcode.json", ".py"),
]
LANGS = [("python", ".py", "corpora/python"), ("js", ".js", "corpora/js/shopcart"),
         ("ts", ".ts", "corpora/ts/shopcart"), ("ruby", ".rb", "corpora/ruby/shopcart")]


def run_suite(label, build_corpus, raw_corpus, graph, qfile, ext):
    store = build(os.path.join(HERE, build_corpus), label.replace("/", "_").replace(" ", "_"))
    qs = json.load(open(os.path.join(HERE, qfile), encoding="utf-8"))
    acc = {"cai": 0, "gfy": 0, "raw": 0}
    tok = {"cai": 0, "gfy": 0, "raw": 0}
    for q in qs:
        cp = cai_pack(store, q["op"], q["args"])
        rp = raw_pack(os.path.join(HERE, raw_corpus), ext, q["raw"])
        gp = gf_pack(os.path.join(HERE, graph), q["gf"], ext)
        for sysn, pack in (("cai", cp), ("raw", rp), ("gfy", gp)):
            acc[sysn] += 1 if grade(pack, q) else 0
            tok[sysn] += toks(pack)
    n = len(qs)
    return {"n": n, "acc": acc, "avg": {k: round(tok[k] / n, 1) for k in tok}}


def main():
    os.makedirs(STORES, exist_ok=True)
    results = {"summary": {}, "multilang": {}, "httpx_structural": {}}

    print("Summary suites...")
    for label, bc, rc, g, qf, ext in SUMMARY:
        results["summary"][label] = run_suite(label, bc, rc, g, qf, ext)
        print(" ", label, results["summary"][label]["acc"])

    print("Multi-language (12 questions each)...")
    ml_acc = {"cai": 0, "gfy": 0, "raw": 0}
    ml_tok = {"cai": 0, "gfy": 0, "raw": 0}
    ml_n = 0
    for lang, ext, src in LANGS:
        r = run_suite("lang_" + lang, src, src, "corpora/%s/graphify-out/graph.json" % lang,
                      "questions/questions2.json", ext)
        results["multilang"][lang] = r
        for k in ml_acc:
            ml_acc[k] += r["acc"][k]
            ml_tok[k] += r["avg"][k] * r["n"]
        ml_n += r["n"]
        print(" ", lang, r["acc"])
    results["multilang"]["_aggregate"] = {"n": ml_n, "acc": ml_acc,
                                          "avg": {k: round(ml_tok[k] / ml_n, 1) for k in ml_tok}}

    print("httpx structural...")
    results["httpx_structural"] = run_httpx()

    json.dump(results, open(os.path.join(HERE, "results", "results.json"), "w"), indent=2)
    write_md(results)
    print("\nwrote results/RESULTS.md and results/results.json")


def cai_subclasses(store, base):
    out = []
    for l in open(os.path.join(store, "edges.jsonl"), encoding="utf-8"):
        e = json.loads(l)
        if e.get("type") == "extends" and e.get("dst", "").split(".")[-1] == base:
            out.append(e.get("src", "").split(".")[-1])
    return out


def run_httpx():
    store = build(os.path.join(HERE, "corpora/httpx/src"), "httpx")
    graph = os.path.join(HERE, "corpora/httpx/graphify/graphify-out/graph.json")
    qs = [q for q in json.load(open(os.path.join(HERE, "questions/questions_hx.json"), encoding="utf-8"))
          if "gold_set" in q]
    agg = {}
    for q in qs:
        sub = q.get("sub")
        if sub == "subclasses":
            subs = cai_subclasses(store, q["args"][0])
            cp = "\n".join("- %s extends %s" % (s, q["args"][0]) for s in subs)
            ct = toks(cp) if cp else 1
        else:
            cp = cai_pack(store, q["op"], q["args"])
            ct = toks(cp)
        gp = subprocess.run([GF, "query", q["q"], "--graph", graph], capture_output=True, text=True).stdout or ""
        gt = toks(gp)
        gl = [x.lower() for x in q["gold_set"]]
        crec = sum(1 for g in gl if g in cp.lower()) / len(gl)
        grec = sum(1 for g in gl if g in gp.lower()) / len(gl)
        a = agg.setdefault(sub, {"n": 0, "ct": 0, "gt": 0, "cr": 0.0, "gr": 0.0})
        a["n"] += 1; a["ct"] += ct; a["gt"] += gt; a["cr"] += crec; a["gr"] += grec
    return agg


def xfewer(big, small):
    return "%.0fx" % (big / small) if small else "n/a"


def write_md(results):
    L = []
    L.append("# Kerneta .cai vs Graphify vs raw files: reproducible results\n")
    L.append("Built offline from source with the tree-sitter extractor "
             "(`engine/cai_ts_extract.py`). Accuracy is correct answers against each "
             "suite's own gold; tokens are the average a query puts in front of the model "
             "(chars/4, applied identically to every system). Rebuild and verify with "
             "`python run_all.py`.\n")

    L.append("## Headline suites\n")
    L.append("| Suite | Q | .cai | Graphify | raw | .cai tok | Graphify tok | raw tok | .cai vs Graphify | .cai vs raw |")
    L.append("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    agg = results["multilang"]["_aggregate"]
    rows = [("Local, multi-language (4 of 9 langs)", agg)]
    rows += [(lbl, results["summary"][lbl]) for lbl in
             ["Deep multi-hop (constructed)", "Real-code retrieval", "psf/requests (ast oracle)"]]
    for lbl, r in rows:
        a, av = r["acc"], r["avg"]
        L.append("| {} | {} | {}/{} | {}/{} | {}/{} | {} | {} | {} | **{} less** | **{} less** |".format(
            lbl, r["n"], a["cai"], r["n"], a["gfy"], r["n"], a["raw"], r["n"],
            av["cai"], av["gfy"], av["raw"], xfewer(av["gfy"], av["cai"]), xfewer(av["raw"], av["cai"])))
    L.append("\n*Local, 9 languages* aggregates the 4 reproducible languages in this kit "
             "(python, js, ts, ruby; 12 questions each). The call-graph languages "
             "(go/rust/java/csharp/cpp) need their single-file corpora, not bundled here.\n")

    L.append("## Per-language (11 questions each)\n")
    L.append("| Language | .cai | Graphify | raw | .cai tok | Graphify tok | raw tok | .cai vs Graphify | .cai vs raw |")
    L.append("| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for lang in ["python", "js", "ts", "ruby"]:
        r = results["multilang"][lang]; a, av = r["acc"], r["avg"]
        L.append("| {} | {}/{} | {}/{} | {}/{} | {} | {} | {} | {} less | {} less |".format(
            lang, a["cai"], r["n"], a["gfy"], r["n"], a["raw"], r["n"],
            av["cai"], av["gfy"], av["raw"], xfewer(av["gfy"], av["cai"]), xfewer(av["raw"], av["cai"])))

    L.append("\n## httpx deep-dive: structural queries (.cai vs Graphify)\n")
    L.append("Member-recall of the ast-derived answer set; tokens chars/4.\n")
    L.append("| Query type | n | .cai recall | Graphify recall | .cai tok | Graphify tok | .cai vs Graphify |")
    L.append("| --- | --- | --- | --- | --- | --- | --- |")
    order = ["imports", "callers", "callees", "tdeps", "subclasses", "most_imported"]
    hs = results["httpx_structural"]
    for op in order:
        if op not in hs:
            continue
        a = hs[op]; ct, gt = a["ct"] / a["n"], a["gt"] / a["n"]
        grec = a["gr"] / a["n"] * 100
        adv = (xfewer(gt, ct) + " less") if gt >= ct else "Graphify smaller but %.0f%% recall" % grec
        L.append("| {} | {} | {:.0f}% | {:.0f}% | {:.0f} | {:.0f} | {} |".format(
            op, a["n"], a["cr"] / a["n"] * 100, grec, ct, gt, adv))
    open(os.path.join(HERE, "results", "RESULTS.md"), "w", encoding="utf-8").write("\n".join(L) + "\n")


if __name__ == "__main__":
    main()
