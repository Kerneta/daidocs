#!/usr/bin/env python
"""Reproduce the Kerneta .cai vs Graphify vs raw code-retrieval benchmarks (no XERJ).

Self-contained and offline. For every suite it REBUILDS the .cai store from the corpus
source with the tree-sitter extractor (engine/cai_ts_extract.py, the extractor the product
uses), queries each system, grades programmatically against the suite's own gold, and
measures token cost (chars/4, applied identically to all systems). No API key, no network.

  python run_all.py

Writes results/RESULTS.md and results/results.json. Graphify must be installed
(https://graphify.dev) at ~/.local/bin/graphify; the corpus graphs are pre-built on disk.

This runner covers the deterministic suites: the headline accuracy/token tables (nine
languages, deep multi-hop, real-code retrieval, psf/requests), the httpx structural
queries, and the CPython stdlib scale test. The semantic/lookup and the end-to-end
(make-this-change, hard-paraphrase) suites live in run_semantic.py and run_e2e.py because
they need the MiniLM embedder and a blind answerer respectively.
"""
import json, math, os, re, subprocess, sys, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.join(HERE, "engine")
TS = os.path.join(ENGINE, "cai_ts_extract.py")
CAI_QUERY = os.path.join(ENGINE, "cai_query.py")
GF = os.path.expanduser("~/.local/bin/graphify")
if not os.path.exists(GF) and os.path.exists(GF + ".exe"):
    GF = GF + ".exe"
STORES = os.path.join(HERE, "results", "stores")
TOKRE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def toks(t):
    return max(1, math.ceil(len(t) / 4))


def tokenset(t):
    return {w.lower() for w in TOKRE.findall(t)}


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


def gf_run(graph, args):
    return subprocess.run([GF] + list(args) + ["--graph", graph], capture_output=True, text=True).stdout or ""


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
    if q.get("gtype") == "any":
        return any(g in ts for g in gold)
    return has_gold


# label, build-corpus, raw-corpus, graph, questions, ext, raw_all(force whole-corpus raw)
SUMMARY = [
    ("psf/requests (ast oracle)", "corpora/requests", "corpora/requests",
     "corpora/requests/graphify-out/graph.json", "questions/questions_realrepo.json", ".py", False),
    ("Real-code retrieval", "corpora/cbench", "corpora/cbench",
     "corpora/cbench/graphify-out/graph.json", "questions/questions_contextbench.json", ".py", False),
    ("Deep multi-hop (constructed)", "corpora/longmemcode", "corpora/longmemcode",
     "corpora/longmemcode/graphify-out/graph.json", "questions/questions_longmemcode.json", ".py", False),
]
# whole-set languages: multi-file shopcart + questions2 (structural)
LANGS = [("python", ".py", "corpora/python", "corpora/python/graphify-out/graph.json", "questions/questions2.json", False),
         ("js", ".js", "corpora/js/shopcart", "corpora/js/graphify-out/graph.json", "questions/questions2.json", False),
         ("ts", ".ts", "corpora/ts/shopcart", "corpora/ts/graphify-out/graph.json", "questions/questions2.json", False),
         ("ruby", ".rb", "corpora/ruby/shopcart", "corpora/ruby/graphify-out/graph.json", "questions/questions2.json", False)]
# call-graph languages: single-file shop + questions_calls (raw reads the whole shop dir)
LANGS_CALLS = [("go", ".go", "corpora/go/shop", "corpora/go/shop/graphify-out/graph.json", "questions/questions_calls.json", True),
               ("rust", ".rs", "corpora/rust/shop", "corpora/rust/shop/graphify-out/graph.json", "questions/questions_calls.json", True),
               ("java", ".java", "corpora/java/shop", "corpora/java/shop/graphify-out/graph.json", "questions/questions_calls.json", True),
               ("csharp", ".cs", "corpora/csharp/shop", "corpora/csharp/shop/graphify-out/graph.json", "questions/questions_calls.json", True),
               ("cpp", ".cpp", "corpora/cpp/shop", "corpora/cpp/shop/graphify-out/graph.json", "questions/questions_calls.json", True)]

# the 10 stdlib symbols for the scale test (reverse traversal: who calls this)
SCALE_SYMS = ["partial", "wraps", "ArgumentParser", "reduce", "total_ordering",
              "lru_cache", "namedtuple", "OrderedDict", "Counter", "deque"]


def run_suite(label, bc, rc, graph, qfile, ext, raw_all):
    store = build(os.path.join(HERE, bc), label.replace("/", "_").replace(" ", "_"))
    qs = json.load(open(os.path.join(HERE, qfile), encoding="utf-8"))
    acc = {"cai": 0, "gfy": 0, "raw": 0}
    tok = {"cai": 0, "gfy": 0, "raw": 0}
    for q in qs:
        cp = cai_pack(store, q["op"], q["args"])
        rp = raw_pack(os.path.join(HERE, rc), ext, ["ALL"] if raw_all else q["raw"])
        gp = gf_run(os.path.join(HERE, graph), [q["gf"][0].replace("{ext}", ext)] + [a.replace("{ext}", ext) for a in q["gf"][1:]])
        for sysn, pack in (("cai", cp), ("raw", rp), ("gfy", gp)):
            acc[sysn] += 1 if grade(pack, q) else 0
            tok[sysn] += toks(pack)
    n = len(qs)
    return {"n": n, "acc": acc, "avg": {k: round(tok[k] / n, 1) for k in tok}}


def cai_subclasses(store, base):
    out = []
    for l in open(os.path.join(store, "edges.jsonl"), encoding="utf-8"):
        e = json.loads(l)
        if e.get("type") == "extends" and e.get("dst", "").split(".")[-1] == base:
            out.append(e.get("src", "").split(".")[-1])
    return out


def run_httpx():
    src = os.path.join(HERE, "corpora/httpx/src")
    store = build(src, "httpx")
    graph = os.path.join(HERE, "corpora/httpx/graphify/graphify-out/graph.json")
    raw_dump = raw_pack(src, ".py", ["ALL"]); raw_t = toks(raw_dump); raw_lc = raw_dump.lower()
    qs = [q for q in json.load(open(os.path.join(HERE, "questions/questions_hx.json"), encoding="utf-8")) if "gold_set" in q]
    agg = {}
    for q in qs:
        sub = q.get("sub")
        if sub == "subclasses":
            subs = cai_subclasses(store, q["args"][0])
            cp = "\n".join("- %s extends %s" % (s, q["args"][0]) for s in subs); ct = toks(cp) if cp else 1
        else:
            cp = cai_pack(store, q["op"], q["args"]); ct = toks(cp)
        gp = gf_run(graph, ["query", q["q"]]); gt = toks(gp)
        gl = [x.lower() for x in q["gold_set"]]
        a = agg.setdefault(sub, {"n": 0, "ct": 0, "gt": 0, "rt": 0, "cr": 0.0, "gr": 0.0, "rr": 0.0})
        a["n"] += 1; a["ct"] += ct; a["gt"] += gt; a["rt"] += raw_t
        a["cr"] += sum(1 for g in gl if g in cp.lower()) / len(gl)
        a["gr"] += sum(1 for g in gl if g in gp.lower()) / len(gl)
        a["rr"] += sum(1 for g in gl if g in raw_lc) / len(gl)
    return agg


def run_scale():
    store = build(os.path.join(HERE, "corpora/stdlib"), "stdlib")
    graph = os.path.join(HERE, "corpora/stdlib/graphify-out/graph.json")
    rows = []
    for sym in SCALE_SYMS:
        ct = toks(cai_pack(store, "callers", [sym]))
        gt = toks(gf_run(graph, ["affected", sym]))
        rows.append({"sym": sym, "cai_tok": ct, "gfy_tok": gt})
    return {"rows": rows, "symbols": len(SCALE_SYMS)}


def xfewer(big, small):
    return "%.0fx" % (big / small) if small else "n/a"


def main():
    os.makedirs(STORES, exist_ok=True)
    results = {"summary": {}, "multilang": {}, "httpx_structural": {}, "scale": {}}

    print("Summary suites...")
    for row in SUMMARY:
        results["summary"][row[0]] = run_suite(*row); print(" ", row[0], results["summary"][row[0]]["acc"])

    print("Nine languages...")
    ml_acc = {"cai": 0, "gfy": 0, "raw": 0}; ml_tok = {"cai": 0, "gfy": 0, "raw": 0}; ml_n = 0
    for lang, ext, src, graph, qf, ra in LANGS + LANGS_CALLS:
        r = run_suite("lang_" + lang, src, src, graph, qf, ext, ra)
        results["multilang"][lang] = r
        for k in ml_acc:
            ml_acc[k] += r["acc"][k]; ml_tok[k] += r["avg"][k] * r["n"]
        ml_n += r["n"]; print(" ", lang, r["acc"])
    results["multilang"]["_aggregate"] = {"n": ml_n, "acc": ml_acc, "avg": {k: round(ml_tok[k] / ml_n, 1) for k in ml_tok}}

    print("httpx structural..."); results["httpx_structural"] = run_httpx()
    print("stdlib scale..."); results["scale"] = run_scale()

    json.dump(results, open(os.path.join(HERE, "results", "results.json"), "w"), indent=2)
    write_md(results)
    print("\nwrote results/RESULTS.md and results/results.json")


def write_md(results):
    L = ["# Kerneta .cai vs Graphify vs raw files: reproducible results\n",
         "Built offline from source with the tree-sitter extractor (`engine/cai_ts_extract.py`). "
         "Accuracy is correct answers against each suite's own gold; tokens are the average a query "
         "puts in front of the model (chars/4, applied identically to every system). Rebuild and "
         "verify with `python run_all.py`. XERJ is not included.\n"]

    L.append("## Headline suites\n")
    L.append("| Suite | Q | .cai | Graphify | raw | .cai tok | Graphify tok | raw tok | .cai vs Graphify | .cai vs raw |")
    L.append("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    agg = results["multilang"]["_aggregate"]
    rows = [("Local, 9 languages", agg)]
    rows += [(lbl, results["summary"][lbl]) for lbl in
             ["Deep multi-hop (constructed)", "Real-code retrieval", "psf/requests (ast oracle)"]]
    for lbl, r in rows:
        a, av = r["acc"], r["avg"]
        L.append("| {} | {} | {}/{} | {}/{} | {}/{} | {} | {} | {} | **{} less** | **{} less** |".format(
            lbl, r["n"], a["cai"], r["n"], a["gfy"], r["n"], a["raw"], r["n"],
            av["cai"], av["gfy"], av["raw"], xfewer(av["gfy"], av["cai"]), xfewer(av["raw"], av["cai"])))

    L.append("\n## Per-language\n")
    L.append("| Language | Q | .cai | Graphify | raw | .cai tok | Graphify tok | raw tok | .cai vs Graphify | .cai vs raw |")
    L.append("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for lang in ["python", "js", "ts", "ruby", "go", "rust", "java", "csharp", "cpp"]:
        r = results["multilang"][lang]; a, av = r["acc"], r["avg"]
        L.append("| {} | {} | {}/{} | {}/{} | {}/{} | {} | {} | {} | {} less | {} less |".format(
            lang, r["n"], a["cai"], r["n"], a["gfy"], r["n"], a["raw"], r["n"],
            av["cai"], av["gfy"], av["raw"], xfewer(av["gfy"], av["cai"]), xfewer(av["raw"], av["cai"])))

    L.append("\n## httpx deep-dive: structural queries (.cai vs Graphify vs raw)\n")
    L.append("Member-recall of the ast-derived answer set; tokens chars/4. raw is the naive dump of "
             "every source file (what an agent with no tool reads).\n")
    L.append("| Query type | n | .cai recall | Graphify recall | raw recall | .cai tok | Graphify tok | raw tok | .cai vs Graphify | .cai vs raw |")
    L.append("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    hs = results["httpx_structural"]
    for op in ["imports", "callers", "callees", "tdeps", "subclasses", "most_imported"]:
        if op not in hs: continue
        a = hs[op]; ct, gt, rt = a["ct"] / a["n"], a["gt"] / a["n"], a["rt"] / a["n"]; grec = a["gr"] / a["n"] * 100
        adv = (xfewer(gt, ct) + " less") if gt >= ct else "GF smaller but %.0f%% recall" % grec
        L.append("| {} | {} | {:.0f}% | {:.0f}% | {:.0f}% | {:.0f} | {:.0f} | {:.0f} | {} | {} less |".format(
            op, a["n"], a["cr"] / a["n"] * 100, grec, a["rr"] / a["n"] * 100, ct, gt, rt, adv, xfewer(rt, ct)))

    L.append("\n## Scale: CPython standard library (who calls this)\n")
    L.append("153 modules, 7,469 symbols. Tokens for one reverse-traversal query per symbol: "
             ".cai `callers`, Graphify `affected`. Per-query cost tracks the symbol's fan-in, not the store size.\n")
    L.append("| callers of (stdlib symbol) | .cai tok | Graphify tok | .cai vs Graphify |")
    L.append("| --- | --- | --- | --- |")
    sc = results["scale"]["rows"]
    for r in sc:
        adv = (xfewer(r["gfy_tok"], r["cai_tok"]) + " less") if r["gfy_tok"] >= r["cai_tok"] \
            else "GF smaller (near-zero fan-in)"
        L.append("| {} | {} | {} | {} |".format(r["sym"], r["cai_tok"], r["gfy_tok"], adv))
    ca = sum(r["cai_tok"] for r in sc) / len(sc); ga = sum(r["gfy_tok"] for r in sc) / len(sc)
    L.append("| **average, {} symbols** | **{:.0f}** | **{:.0f}** | **{} less** |".format(len(sc), ca, ga, xfewer(ga, ca)))

    open(os.path.join(HERE, "results", "RESULTS.md"), "w", encoding="utf-8").write("\n".join(L) + "\n")


if __name__ == "__main__":
    main()
