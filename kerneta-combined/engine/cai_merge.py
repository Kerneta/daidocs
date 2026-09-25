"""Kerneta .cai cross-repo merge.

Merges several .cai stores into one combined store: node ids are prefixed with
`<tag>::`, and symbols that share a short name across repos are linked with
`same_symbol_as` edges (the cross-repo bridge, like Graphify's same_type_as).

Usage: python cai_merge.py <out_store> <tag1>=<store1> <tag2>=<store2> ...
"""

import collections
import json
import os
import sys


def load(store):
    def rd(name):
        p = os.path.join(store, name)
        return [json.loads(l) for l in open(p, encoding="utf-8") if l.strip()] if os.path.exists(p) else []
    return rd("manifest.jsonl"), rd("symbols.jsonl"), rd("edges.jsonl")


def merge(pairs, out):
    os.makedirs(os.path.join(out, "files"), exist_ok=True)
    man, sym, edges = [], [], []
    short_index = collections.defaultdict(list)
    for tag, store in pairs:
        m, s, elist = load(store)
        for r in m:
            r = dict(r); r["module"] = tag + "::" + r["module"]; man.append(r)
        for r in s:
            r = dict(r)
            sid = "{}::{}.{}".format(tag, r["module"], r["name"])
            r["module"] = tag + "::" + r["module"]
            sym.append(r)
            short_index[r["name"]].append(sid)
        for e in elist:
            edges.append({"src": tag + "::" + e["src"], "dst": tag + "::" + e["dst"],
                          "type": e["type"], "confidence": e.get("confidence", "EXTRACTED")})
    # cross-repo bridges
    bridges = 0
    for name, ids in short_index.items():
        repos = {i.split("::")[0] for i in ids}
        if len(repos) > 1:
            ids = sorted(ids)
            for i in range(len(ids)):
                for j in range(i + 1, len(ids)):
                    if ids[i].split("::")[0] != ids[j].split("::")[0]:
                        edges.append({"src": ids[i], "dst": ids[j], "type": "same_symbol_as",
                                      "confidence": "INFERRED"})
                        bridges += 1
    with open(os.path.join(out, "manifest.jsonl"), "w", encoding="utf-8") as f:
        for r in man:
            f.write(json.dumps(r) + "\n")
    with open(os.path.join(out, "symbols.jsonl"), "w", encoding="utf-8") as f:
        for r in sym:
            f.write(json.dumps(r) + "\n")
    with open(os.path.join(out, "edges.jsonl"), "w", encoding="utf-8") as f:
        seen = set()
        for e in edges:
            k = (e["src"], e["dst"], e["type"])
            if k not in seen:
                seen.add(k); f.write(json.dumps(e) + "\n")
    return len(man), len(edges), bridges


if __name__ == "__main__":
    out = sys.argv[1]
    pairs = [(a.split("=", 1)[0], a.split("=", 1)[1]) for a in sys.argv[2:]]
    m, e, b = merge(pairs, out)
    print("merged {} repos -> {} modules, {} edges, {} cross-repo bridges into {}".format(
        len(pairs), m, e, b, out))
