"""Kerneta .cai extractor.

Turns a folder of Python source into a plain-text code-memory store:
  - one <module>.cai file per source file (human and LLM readable)
  - manifest.jsonl : one line per file (the file-level index)
  - symbols.jsonl  : one line per defined symbol (functions, methods, classes)
  - edges.jsonl    : the code graph as a plain-text edge list

Deterministic. Standard library only. No LLM, no vector store.
Run: python cai_extract.py <corpus_dir> <store_dir>
"""

import ast
import hashlib
import json
import os
import sys


def _sig(node):
    """Build a readable signature string for a function or method."""
    parts = []
    a = node.args
    for arg in a.posonlyargs:
        parts.append(arg.arg)
    if a.posonlyargs:
        parts.append("/")
    for arg in a.args:
        parts.append(arg.arg)
    if a.vararg:
        parts.append("*" + a.vararg.arg)
    for arg in a.kwonlyargs:
        parts.append(arg.arg)
    if a.kwarg:
        parts.append("**" + a.kwarg.arg)
    return "{}({})".format(node.name, ", ".join(parts))


def _brief(node):
    """First line of a docstring, or empty."""
    doc = ast.get_docstring(node)
    if not doc:
        return ""
    return doc.strip().splitlines()[0].strip()


def _callees(node):
    """Collect callee names referenced inside a function body."""
    names = []
    for sub in ast.walk(node):
        if isinstance(sub, ast.Call):
            f = sub.func
            if isinstance(f, ast.Name):
                names.append(f.id)
            elif isinstance(f, ast.Attribute):
                names.append(f.attr)
    # de-duplicate but keep order
    seen = set()
    out = []
    for n in names:
        if n not in seen:
            seen.add(n)
            out.append(n)
    return out


def _imports(tree):
    """Return list of (module, [names]) for import and from-import."""
    out = []
    for node in tree.body:
        if isinstance(node, ast.Import):
            for alias in node.names:
                out.append((alias.name, []))
        elif isinstance(node, ast.ImportFrom):
            mod = node.module or ""
            out.append((mod, [a.name for a in node.names]))
    return out


def extract_file(path, module):
    """Parse one file into a record dict."""
    src = open(path, "r", encoding="utf-8").read()
    tree = ast.parse(src)
    sha1 = hashlib.sha1(src.encode("utf-8")).hexdigest()[:12]
    summary = _brief(tree)
    imports = _imports(tree)

    symbols = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            symbols.append({
                "kind": "fn",
                "name": node.name,
                "sig": _sig(node),
                "line": node.lineno,
                "end": getattr(node, "end_lineno", node.lineno),
                "brief": _brief(node),
                "calls": _callees(node),
            })
        elif isinstance(node, ast.ClassDef):
            methods = []
            for sub in node.body:
                if isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    methods.append({
                        "kind": "method",
                        "name": sub.name,
                        "sig": _sig(sub),
                        "line": sub.lineno,
                        "end": getattr(sub, "end_lineno", sub.lineno),
                        "brief": _brief(sub),
                        "calls": _callees(sub),
                    })
            symbols.append({
                "kind": "class",
                "name": node.name,
                "sig": node.name,
                "line": node.lineno,
                "end": getattr(node, "end_lineno", node.lineno),
                "brief": _brief(node),
                "calls": [],
                "methods": methods,
            })

    return {
        "module": module,
        "path": "shopcart/" + os.path.basename(path),
        "lang": "python",
        "sha1": sha1,
        "summary": summary,
        "imports": imports,
        "symbols": symbols,
        "loc": src.count("\n") + 1,
    }


def render_cai(rec):
    """Render a record as a .cai plain-text file."""
    lines = []
    lines.append("# .cai  kerneta code-ai memory  v1")
    lines.append("file: {}".format(rec["path"]))
    lines.append("lang: {}".format(rec["lang"]))
    lines.append("sha1: {}".format(rec["sha1"]))
    lines.append("loc: {}".format(rec["loc"]))
    lines.append("summary: {}".format(rec["summary"]))
    lines.append("")
    lines.append("## imports")
    if rec["imports"]:
        for mod, names in rec["imports"]:
            if names:
                lines.append("- {}: {}".format(mod, ", ".join(names)))
            else:
                lines.append("- {}".format(mod))
    else:
        lines.append("- (none)")
    lines.append("")
    lines.append("## symbols")
    for s in rec["symbols"]:
        if s["kind"] == "class":
            lines.append("- class {}  [L{}-L{}]".format(s["name"], s["line"], s["end"]))
            if s["brief"]:
                lines.append("    brief: {}".format(s["brief"]))
            for m in s.get("methods", []):
                lines.append("  - method {}  [L{}-L{}]".format(m["sig"], m["line"], m["end"]))
                if m["brief"]:
                    lines.append("      brief: {}".format(m["brief"]))
                if m["calls"]:
                    lines.append("      calls: {}".format(", ".join(m["calls"])))
        else:
            lines.append("- fn {}  [L{}-L{}]".format(s["sig"], s["line"], s["end"]))
            if s["brief"]:
                lines.append("    brief: {}".format(s["brief"]))
            if s["calls"]:
                lines.append("    calls: {}".format(", ".join(s["calls"])))
    lines.append("")
    return "\n".join(lines)


def build(corpus_dir, store_dir):
    files_dir = os.path.join(store_dir, "files")
    os.makedirs(files_dir, exist_ok=True)

    records = []
    for name in sorted(os.listdir(corpus_dir)):
        if name.endswith(".py"):
            module = name[:-3]
            rec = extract_file(os.path.join(corpus_dir, name), module)
            records.append(rec)

    # global symbol table: name -> defining module
    defined = {}
    for rec in records:
        for s in rec["symbols"]:
            defined[s["name"]] = rec["module"]
            for m in s.get("methods", []):
                defined[m["name"]] = rec["module"]

    # write .cai files + manifest + symbols
    manifest = open(os.path.join(store_dir, "manifest.jsonl"), "w", encoding="utf-8")
    symbols = open(os.path.join(store_dir, "symbols.jsonl"), "w", encoding="utf-8")
    edges = []

    for rec in records:
        cai = render_cai(rec)
        with open(os.path.join(files_dir, rec["module"] + ".cai"), "w", encoding="utf-8") as f:
            f.write(cai)

        sym_names = []
        for s in rec["symbols"]:
            sym_names.append(s["name"])
            for m in s.get("methods", []):
                sym_names.append(m["name"])
        manifest.write(json.dumps({
            "module": rec["module"],
            "path": rec["path"],
            "summary": rec["summary"],
            "symbols": sym_names,
            "imports": [m for m, _ in rec["imports"]],
            "loc": rec["loc"],
        }) + "\n")

        # import edges (module -> module)
        for mod, _names in rec["imports"]:
            if mod in {r["module"] for r in records}:
                edges.append({"src": rec["module"], "dst": mod, "type": "imports"})

        # symbol + call edges
        for s in rec["symbols"]:
            symbols.write(json.dumps({
                "name": s["name"], "kind": s["kind"], "module": rec["module"],
                "sig": s["sig"], "line": s["line"], "brief": s["brief"],
            }) + "\n")
            for callee in s["calls"]:
                if callee in defined:
                    edges.append({
                        "src": "{}.{}".format(rec["module"], s["name"]),
                        "dst": "{}.{}".format(defined[callee], callee),
                        "type": "calls",
                    })
            for m in s.get("methods", []):
                symbols.write(json.dumps({
                    "name": m["name"], "kind": m["kind"], "module": rec["module"],
                    "sig": m["sig"], "line": m["line"], "brief": m["brief"],
                }) + "\n")
                for callee in m["calls"]:
                    if callee in defined:
                        edges.append({
                            "src": "{}.{}".format(rec["module"], m["name"]),
                            "dst": "{}.{}".format(defined[callee], callee),
                            "type": "calls",
                        })

    manifest.close()
    symbols.close()

    with open(os.path.join(store_dir, "edges.jsonl"), "w", encoding="utf-8") as f:
        # de-duplicate edges deterministically
        seen = set()
        for e in edges:
            key = (e["src"], e["dst"], e["type"])
            if key not in seen:
                seen.add(key)
                f.write(json.dumps(e) + "\n")

    return len(records), len(edges)


if __name__ == "__main__":
    corpus = sys.argv[1] if len(sys.argv) > 1 else "../corpus/shopcart"
    store = sys.argv[2] if len(sys.argv) > 2 else "../cai-store"
    n, e = build(corpus, store)
    print("built {} .cai files, {} edges into {}".format(n, e, store))
