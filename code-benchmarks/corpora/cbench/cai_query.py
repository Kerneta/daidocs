"""Kerneta .cai query layer.

Answers structural code questions by returning a small retrieved slice of the
plain-text store (manifest.jsonl / symbols.jsonl / edges.jsonl), the same way
Graphify returns a subgraph instead of raw files. The model then reads the
slice to answer.

Ops:
  callers <sym>        edges that call <sym>            (reverse calls)
  callees <sym>        what <sym> calls                 (forward calls)
  imports <mod>        modules <mod> imports
  defines <sym>        where <sym> is defined
  tdeps <mod>          transitive import dependencies
  path <a> <b>         an import path from <a> to <b>
  most_imported        module with highest import in-degree

Run: python cai_query.py <store_dir> <op> [args...]
"""

import json
import os
import sys
import collections


def load(store):
    def rd(name):
        p = os.path.join(store, name)
        with open(p, encoding="utf-8") as f:
            return [json.loads(li) for li in f if li.strip()]
    return rd("manifest.jsonl"), rd("symbols.jsonl"), rd("edges.jsonl")


def sym_module(edges_endpoint):
    """'pricing.item_price' -> ('pricing','item_price')."""
    mod, _, name = edges_endpoint.partition(".")
    return mod, name


def op_callers(manifest, symbols, edges, sym):
    out = ["slice: callers of {} (reverse calls)".format(sym)]
    hits = [e for e in edges if e["type"] == "calls" and e["dst"].split(".")[-1] == sym]
    if not hits:
        out.append("- (no project function calls it)")
    for e in hits:
        out.append("- {} calls {}".format(e["src"], e["dst"]))
    return "\n".join(out)


def op_callees(manifest, symbols, edges, sym):
    out = ["slice: callees of {} (forward calls)".format(sym)]
    hits = [e for e in edges if e["type"] == "calls" and e["src"].split(".")[-1] == sym]
    if not hits:
        out.append("- (calls no project function)")
    for e in hits:
        out.append("- {} calls {}".format(e["src"], e["dst"]))
    return "\n".join(out)


def op_imports(manifest, symbols, edges, mod):
    rec = next((m for m in manifest if m["module"] == mod), None)
    out = ["slice: imports of {}".format(mod)]
    if rec is None:
        out.append("- (unknown module)")
    else:
        internal = [i for i in rec["imports"] if any(m["module"] == i for m in manifest)]
        out.append("- {} imports: {}".format(mod, ", ".join(internal) if internal else "(none internal)"))
    return "\n".join(out)


def op_defines(manifest, symbols, edges, sym):
    out = ["slice: definition of {}".format(sym)]
    hits = [s for s in symbols if s["name"] == sym]
    if not hits:
        out.append("- (not defined in project)")
    mod_path = {m["module"]: m.get("path", m["module"]) for m in manifest}
    for s in hits:
        sig = s.get("sig", s["name"])
        brief = s.get("brief", "")
        loc = mod_path.get(s["module"], s["module"])
        tail = "  ({})".format(brief) if brief else ""
        out.append("- {} {} defined in {} (module {}) at L{}{}".format(
            s["kind"], sig, loc, s["module"], s["line"], tail))
    return "\n".join(out)


def _import_adj(manifest, edges):
    adj = collections.defaultdict(set)
    for e in edges:
        if e["type"] == "imports":
            adj[e["src"]].add(e["dst"])
    return adj


def op_tdeps(manifest, symbols, edges, mod):
    adj = _import_adj(manifest, edges)
    seen, order, stack = set(), [], [mod]
    while stack:
        cur = stack.pop()
        for nxt in sorted(adj.get(cur, ())):
            if nxt not in seen:
                seen.add(nxt)
                order.append(nxt)
                stack.append(nxt)
    out = ["slice: transitive import deps of {}".format(mod)]
    out.append("- edges: " + "; ".join("{}->{}".format(e["src"], e["dst"]) for e in edges if e["type"] == "imports" and (e["src"] == mod or e["src"] in seen)))
    out.append("- reachable: {}".format(", ".join(sorted(seen))))
    return "\n".join(out)


def op_path(manifest, symbols, edges, a, b):
    adj = _import_adj(manifest, edges)
    q = collections.deque([[a]])
    seen = {a}
    while q:
        p = q.popleft()
        if p[-1] == b:
            return "slice: import path {} -> {}\n- {}".format(a, b, " -> ".join(p))
        for nxt in sorted(adj.get(p[-1], ())):
            if nxt not in seen:
                seen.add(nxt)
                q.append(p + [nxt])
    return "slice: import path {} -> {}\n- (no path)".format(a, b)


def op_most_imported(manifest, symbols, edges, *_):
    indeg = collections.Counter(e["dst"] for e in edges if e["type"] == "imports")
    out = ["slice: import in-degree (most imported module)"]
    for mod, n in indeg.most_common():
        out.append("- {}: imported by {}".format(mod, n))
    return "\n".join(out)


OPS = {
    "callers": op_callers, "callees": op_callees, "imports": op_imports,
    "defines": op_defines, "tdeps": op_tdeps, "path": op_path,
    "most_imported": op_most_imported,
}


def parse_nl(manifest, symbols, question):
    """Map a natural-language question to (op, args) using the store's names."""
    import re
    q = question.lower()
    names = {s["name"] for s in symbols} | {m["module"] for m in manifest}
    canon = {n.lower(): n for n in names}
    toks = re.findall(r"[A-Za-z_][A-Za-z0-9_]*", question)
    mentioned = [canon[t.lower()] for t in toks if t.lower() in canon]
    if "most" in q and "import" in q:
        return "most_imported", []
    if "path" in q and len(mentioned) >= 2:
        return "path", mentioned[:2]
    if ("transitive" in q or "depend" in q) and mentioned:
        return "tdeps", [mentioned[0]]
    if "import" in q and mentioned:
        return "imports", [mentioned[0]]
    if ("defined" in q or "define" in q or "where" in q) and mentioned:
        return "defines", [mentioned[0]]
    if "call" in q and mentioned:
        return ("callees" if "does" in q else "callers"), [mentioned[0]]
    if mentioned:
        return "defines", [mentioned[0]]
    return "most_imported", []


def run(store, op, args):
    manifest, symbols, edges = load(store)
    return OPS[op](manifest, symbols, edges, *args)


if __name__ == "__main__":
    store = sys.argv[1]
    op = sys.argv[2]
    args = sys.argv[3:]
    if op == "ask":
        manifest, symbols, edges = load(store)
        question = " ".join(args)
        op, args = parse_nl(manifest, symbols, question)
        print("(interpreted as: {} {})".format(op, " ".join(args)))
    print(run(store, op, args))
