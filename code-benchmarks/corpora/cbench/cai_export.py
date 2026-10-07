"""Kerneta .cai exporters: mermaid, dot, graphml, obsidian.

Turns the plain-text .cai store into other plain-text graph formats.
Deterministic, no LLM.

Usage:
  python cai_export.py <store> mermaid [--level module|symbol]
  python cai_export.py <store> dot     [--level module|symbol]
  python cai_export.py <store> graphml [--level module|symbol]
  python cai_export.py <store> obsidian <out_dir>
"""

import json
import os
import sys
import xml.sax.saxutils as sx


def load(store):
    def rd(name):
        p = os.path.join(store, name)
        if not os.path.exists(p):
            return []
        with open(p, encoding="utf-8") as f:
            return [json.loads(li) for li in f if li.strip()]
    return rd("manifest.jsonl"), rd("edges.jsonl")


def _edges_for(edges, level):
    if level == "module":
        out, seen = [], set()
        for e in edges:
            if e["type"] in ("imports",):
                k = (e["src"], e["dst"], e["type"])
                if k not in seen:
                    seen.add(k)
                    out.append(e)
        return out
    return edges  # symbol level: everything


def _safe(s):
    return s.replace(".", "_").replace("-", "_").replace("/", "_")


def mermaid(store, level):
    _, edges = load(store)
    lines = ["graph LR"]
    for e in _edges_for(edges, level):
        lines.append("  {}[\"{}\"] -->|{}| {}[\"{}\"]".format(
            _safe(e["src"]), e["src"], e["type"], _safe(e["dst"]), e["dst"]))
    return "\n".join(lines)


def dot(store, level):
    _, edges = load(store)
    lines = ["digraph cai {", "  rankdir=LR;"]
    for e in _edges_for(edges, level):
        lines.append('  "{}" -> "{}" [label="{}"];'.format(e["src"], e["dst"], e["type"]))
    lines.append("}")
    return "\n".join(lines)


def graphml(store, level):
    manifest, edges = load(store)
    es = _edges_for(edges, level)
    nodes = set()
    for e in es:
        nodes.add(e["src"])
        nodes.add(e["dst"])
    out = ['<?xml version="1.0" encoding="UTF-8"?>',
           '<graphml xmlns="http://graphml.graphdrawing.org/xmlns">',
           '  <key id="rel" for="edge" attr.name="relation" attr.type="string"/>',
           '  <graph edgedefault="directed">']
    for n in sorted(nodes):
        out.append('    <node id={}/>'.format(sx.quoteattr(n)))
    for i, e in enumerate(es):
        out.append('    <edge id="e{}" source={} target={}><data key="rel">{}</data></edge>'.format(
            i, sx.quoteattr(e["src"]), sx.quoteattr(e["dst"]), sx.escape(e["type"])))
    out += ['  </graph>', '</graphml>']
    return "\n".join(out)


def obsidian(store, out_dir):
    manifest, edges = load(store)
    os.makedirs(out_dir, exist_ok=True)
    imports = {}
    for e in edges:
        if e["type"] == "imports":
            imports.setdefault(e["src"], []).append(e["dst"])
    written = 0
    for m in manifest:
        mod = m["module"]
        lines = ["# {}".format(mod), "",
                 "- file: `{}`".format(m.get("path", mod)),
                 "- language: {}".format(m.get("lang", "")),
                 "- symbols: {}".format(", ".join(m.get("symbols", []))), ""]
        deps = sorted(set(imports.get(mod, [])))
        if deps:
            lines.append("## imports")
            lines += ["- [[{}]]".format(d) for d in deps]
        with open(os.path.join(out_dir, mod + ".md"), "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
        written += 1
    return "wrote {} obsidian notes to {}".format(written, out_dir)


def html(store, level, title="Kerneta .cai graph"):
    _, edges = load(store)
    es = _edges_for(edges, level)
    nodeset = sorted(_nodes_from(es))
    idx = {n: i for i, n in enumerate(nodeset)}
    nodes_js = json.dumps([{"id": i, "label": n} for i, n in enumerate(nodeset)])
    edges_js = json.dumps([{"from": idx[e["src"]], "to": idx[e["dst"]], "label": e["type"],
                            "arrows": "to"} for e in es])
    return """<!doctype html><html><head><meta charset="utf-8"><title>%s</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/vis-network/9.1.9/dist/vis-network.min.js"></script>
<style>#g{width:100%%;height:90vh;border:1px solid #ccc}body{font:14px sans-serif;margin:12px}</style>
</head><body><h3>%s</h3><div id="g"></div><script>
var nodes=new vis.DataSet(%s);var edges=new vis.DataSet(%s);
new vis.Network(document.getElementById('g'),{nodes:nodes,edges:edges},
{physics:{stabilization:true},edges:{font:{size:10}}});
</script></body></html>""" % (title, title, nodes_js, edges_js)


def _nodes_from(es):
    s = set()
    for e in es:
        s.add(e["src"]); s.add(e["dst"])
    return s


def tree(store):
    manifest, edges = load(store)
    contains = {}
    for e in edges:
        if e["type"] == "contains":
            contains.setdefault(e["src"], []).append(e["dst"].split(".")[-1])
    out = ["<!doctype html><meta charset=\"utf-8\"><style>body{font:14px sans-serif}"
           "summary{cursor:pointer;font-weight:600}li{margin:2px 0}</style><h3>.cai tree</h3>"]
    for m in manifest:
        out.append("<details open><summary>{} ({})</summary><ul>".format(m["module"], m.get("lang", "")))
        for s in sorted(contains.get(m["module"], [])):
            out.append("<li>{}</li>".format(s))
        out.append("</ul></details>")
    return "\n".join(out)


def svg(store, level):
    import math
    _, edges = load(store)
    es = _edges_for(edges, level)
    nodes = sorted(_nodes_from(es))
    n = max(1, len(nodes))
    R, cx, cy = 220, 300, 300
    pos = {}
    for i, node in enumerate(nodes):
        a = 2 * math.pi * i / n
        pos[node] = (cx + R * math.cos(a), cy + R * math.sin(a))
    out = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 640" font-family="sans-serif" font-size="11">']
    out.append('<marker id="a" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">'
               '<path d="M0,0 L7,3 L0,6 Z" fill="#666"/></marker>')
    for e in es:
        x1, y1 = pos[e["src"]]; x2, y2 = pos[e["dst"]]
        out.append('<line x1="{:.0f}" y1="{:.0f}" x2="{:.0f}" y2="{:.0f}" stroke="#999" marker-end="url(#a)"/>'.format(x1, y1, x2, y2))
    for node, (x, y) in pos.items():
        out.append('<circle cx="{:.0f}" cy="{:.0f}" r="5" fill="#3a55c6"/>'.format(x, y))
        out.append('<text x="{:.0f}" y="{:.0f}">{}</text>'.format(x + 7, y + 3, node))
    out.append('</svg>')
    return "\n".join(out)


def cypher(store):
    _, edges = load(store)
    out = []
    for n in sorted(_nodes_from(edges)):
        out.append("MERGE (:Node {{id:{}}});".format(json.dumps(n)))
    for e in edges:
        out.append("MATCH (a:Node {{id:{}}}),(b:Node {{id:{}}}) MERGE (a)-[:{}]->(b);".format(
            json.dumps(e["src"]), json.dumps(e["dst"]), e["type"].upper()))
    return "\n".join(out)


if __name__ == "__main__":
    store, fmt = sys.argv[1], sys.argv[2]
    level = "module"
    if "--level" in sys.argv:
        level = sys.argv[sys.argv.index("--level") + 1]
    if fmt == "obsidian":
        print(obsidian(store, sys.argv[3]))
    elif fmt == "mermaid":
        print(mermaid(store, level))
    elif fmt == "dot":
        print(dot(store, level))
    elif fmt == "graphml":
        print(graphml(store, level))
    elif fmt == "html":
        print(html(store, level))
    elif fmt == "callflow":
        print(html(store, "symbol", "Kerneta call flow"))
    elif fmt == "tree":
        print(tree(store))
    elif fmt == "svg":
        print(svg(store, level))
    elif fmt == "cypher":
        print(cypher(store))
    else:
        print("unknown format:", fmt)
