"""Does the retriever survive when docstrings are absent? Build four search
surfaces from source and compare intent-query recall:

  S0  identifiers only              (module + symbols + imports)      = the floor
  S1  free signals, NO docstrings   (S0 + signatures + body strings + comments)
  S2  Option A                      (S0 + docstrings)
  S3  all free                      (S0 + signatures + strings + comments + docstrings)

Only the SEARCH text changes; the pack (the .cai file) is unchanged. chars/4.
  python test_nodocstring.py <cai_store> <corpus_dir> <semq.json>
"""
import ast
import io
import json
import os
import sys
import tokenize as tk

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mem_search as ms


def extract(src):
    """Return dict of free signals from one python source string."""
    out = {"sig": [], "docs": [], "strings": [], "comments": []}
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return out
    doc_nodes = set()
    md = ast.get_docstring(tree)
    if md:
        out["docs"].append(md)
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            d = ast.get_docstring(node)
            if d:
                out["docs"].append(d)
            # mark the docstring Constant node so we don't double-count it as a literal
            if (node.body and isinstance(node.body[0], ast.Expr)
                    and isinstance(node.body[0].value, ast.Constant)
                    and isinstance(node.body[0].value.value, str)):
                doc_nodes.add(id(node.body[0].value))
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            args = [a.arg for a in (node.args.posonlyargs + node.args.args + node.args.kwonlyargs)]
            if node.args.vararg:
                args.append(node.args.vararg.arg)
            if node.args.kwarg:
                args.append(node.args.kwarg.arg)
            out["sig"].append("{}({})".format(node.name, ", ".join(args)))
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in doc_nodes:
            if node.value.strip():
                out["strings"].append(node.value)
    try:
        for t in tk.generate_tokens(io.StringIO(src).readline):
            if t.type == tk.COMMENT:
                out["comments"].append(t.string.lstrip("#").strip())
    except tk.TokenError:
        pass
    return out


def surfaces(store, corpus):
    manifest = ms._read_jsonl(os.path.join(store, "manifest.jsonl"))
    rows = []
    for m in manifest:
        base = " ".join([m.get("module", ""), " ".join(m.get("symbols", [])),
                         " ".join(m.get("imports", []))])
        path = os.path.join(corpus, m.get("path", ""))
        e = extract(open(path, encoding="utf-8").read()) if os.path.exists(path) else \
            {"sig": [], "docs": [], "strings": [], "comments": []}
        free = " ".join(e["sig"] + e["strings"] + e["comments"])
        docs = " ".join(e["docs"])
        rows.append({
            "id": m.get("module"),
            "S0": base,
            "S1": base + " " + free,
            "S2": base + " " + docs,
            "S3": base + " " + free + " " + docs,
        })
    return rows


def run(store, corpus, semq_path):
    qs = json.load(open(semq_path, encoding="utf-8"))
    rows = surfaces(store, corpus)
    labels = {"S0": "identifiers only (floor)",
              "S1": "free signals, NO docstrings",
              "S2": "Option A (docstrings)",
              "S3": "all free (signals + docstrings)"}
    print("surface                                   top-1   top-3")
    for key in ("S0", "S1", "S2", "S3"):
        docs = [{"id": r["id"], "text": r[key], "meta": {}} for r in rows]
        line = []
        for K in (1, 3):
            hit = 0
            for q in qs:
                got = {docs[i]["id"] for i, _ in ms.bm25_search(q["q"], docs, K)}
                if os.path.splitext(q["gold_file"])[0] in got:
                    hit += 1
            line.append("{}/{}".format(hit, len(qs)))
        print("{:<41} {:<7} {}".format(labels[key], line[0], line[1]))


if __name__ == "__main__":
    run(sys.argv[1], sys.argv[2], sys.argv[3])
