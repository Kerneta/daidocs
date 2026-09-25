"""Kerneta .cai analysis: god-nodes, import cycles, communities.

Deterministic, plain text, no LLM. Reads the .cai store (edges.jsonl / manifest.jsonl).

Usage:
  python cai_analyze.py <store> god-nodes [--top N]
  python cai_analyze.py <store> cycles
  python cai_analyze.py <store> communities
"""

import collections
import json
import os
import sys


def load(store):
    def rd(name):
        p = os.path.join(store, name)
        if not os.path.exists(p):
            return []
        with open(p, encoding="utf-8") as f:
            return [json.loads(li) for li in f if li.strip()]
    return rd("manifest.jsonl"), rd("edges.jsonl")


def god_nodes(store, top=10):
    _, edges = load(store)
    deg = collections.Counter()
    for e in edges:
        deg[e["src"]] += 1
        deg[e["dst"]] += 1
    out = ["god-nodes (most connected, by total degree)"]
    for node, d in deg.most_common(top):
        out.append("- {}  ({} edges)".format(node, d))
    return "\n".join(out)


def _module_import_graph(edges):
    adj = collections.defaultdict(set)
    for e in edges:
        if e["type"] == "imports":
            adj[e["src"]].add(e["dst"])
    return adj


def cycles(store):
    _, edges = load(store)
    adj = _module_import_graph(edges)
    found = []
    WHITE, GREY, BLACK = 0, 1, 2
    color = {}
    stack = []

    def dfs(u):
        color[u] = GREY
        stack.append(u)
        for v in sorted(adj.get(u, ())):
            if color.get(v, WHITE) == GREY:
                i = stack.index(v)
                cyc = stack[i:] + [v]
                found.append(cyc)
            elif color.get(v, WHITE) == WHITE:
                dfs(v)
        stack.pop()
        color[u] = BLACK

    for n in sorted(adj):
        if color.get(n, WHITE) == WHITE:
            dfs(n)
    # dedupe by normalized rotation
    seen, uniq = set(), []
    for c in found:
        key = tuple(sorted(set(c)))
        if key not in seen:
            seen.add(key)
            uniq.append(c)
    out = ["import cycles"]
    if not uniq:
        out.append("- (none)")
    for c in uniq:
        out.append("- " + " -> ".join(c))
    return "\n".join(out)


def communities(store):
    """Connected components of the undirected symbol graph, named by hub (LLM-free)."""
    manifest, edges = load(store)
    adj = collections.defaultdict(set)
    deg = collections.Counter()
    for e in edges:
        adj[e["src"]].add(e["dst"])
        adj[e["dst"]].add(e["src"])
        deg[e["src"]] += 1
        deg[e["dst"]] += 1
    seen, comps = set(), []
    for node in sorted(adj):
        if node in seen:
            continue
        stack, comp = [node], []
        seen.add(node)
        while stack:
            u = stack.pop()
            comp.append(u)
            for v in sorted(adj[u]):
                if v not in seen:
                    seen.add(v)
                    stack.append(v)
        comps.append(comp)
    comps.sort(key=len, reverse=True)
    out = ["communities (connected components, hub-named)"]
    for i, comp in enumerate(comps):
        hub = max(comp, key=lambda n: (deg[n], n))
        out.append("- community {} ({} nodes) hub={}: {}".format(
            i, len(comp), hub, ", ".join(sorted(comp)[:12]) + ("..." if len(comp) > 12 else "")))
    return "\n".join(out)


def _nodes(edges):
    s = set()
    for e in edges:
        s.add(e["src"]); s.add(e["dst"])
    return s


def graph_diff(store_a, store_b):
    _, ea = load(store_a)
    _, eb = load(store_b)
    na, nb = _nodes(ea), _nodes(eb)
    sa = {(e["src"], e["dst"], e["type"]) for e in ea}
    sb = {(e["src"], e["dst"], e["type"]) for e in eb}
    out = ["graph diff: {} -> {}".format(store_a, store_b)]
    out.append("nodes: +{} added, -{} removed".format(len(nb - na), len(na - nb)))
    for n in sorted(nb - na):
        out.append("  + {}".format(n))
    for n in sorted(na - nb):
        out.append("  - {}".format(n))
    out.append("edges: +{} added, -{} removed".format(len(sb - sa), len(sa - sb)))
    for e in sorted(sb - sa):
        out.append("  + {} {} {}".format(*e))
    for e in sorted(sa - sb):
        out.append("  - {} {} {}".format(*e))
    return "\n".join(out)


def _norm(label):
    return label.lower().replace("_", "").replace("-", "").split(".")[-1]


# ---- MinHash + LSH + Jaro-Winkler dedup (Graphify-style) --------------------
import hashlib as _hashlib
import random as _random
import re as _re

_MERSENNE = (1 << 61) - 1
_NUM_PERM = 64
_BANDS = 16
_ROWS = 4  # BANDS*ROWS == NUM_PERM


def _shingles(s, k=3):
    s = _norm(s)
    if len(s) < k:
        return {s} if s else set()
    return {s[i:i + k] for i in range(len(s) - k + 1)}


def _hash_shingle(sh):
    return int.from_bytes(_hashlib.sha1(sh.encode("utf-8")).digest()[:8], "big")


def _perms(num_perm=_NUM_PERM, seed=42):
    rnd = _random.Random(seed)
    return [(rnd.randrange(1, _MERSENNE), rnd.randrange(0, _MERSENNE)) for _ in range(num_perm)]


def _minhash(name, perms):
    shs = [_hash_shingle(x) for x in _shingles(name)]
    if not shs:
        return [0] * len(perms)
    return [min((a * h + b) % _MERSENNE for h in shs) for a, b in perms]


def _lsh_candidates(sigs):
    buckets = collections.defaultdict(list)
    for nid, sig in sigs.items():
        for b in range(_BANDS):
            buckets[(b, tuple(sig[b * _ROWS:(b + 1) * _ROWS]))].append(nid)
    cands = set()
    for ids in buckets.values():
        if len(ids) > 1:
            ids = sorted(ids)
            for i in range(len(ids)):
                for j in range(i + 1, len(ids)):
                    cands.add((ids[i], ids[j]))
    return cands


def _jaro(a, b):
    if a == b:
        return 1.0
    la, lb = len(a), len(b)
    if la == 0 or lb == 0:
        return 0.0
    window = max(la, lb) // 2 - 1
    a_match = [False] * la
    b_match = [False] * lb
    matches = 0
    for i in range(la):
        lo, hi = max(0, i - window), min(i + window + 1, lb)
        for j in range(lo, hi):
            if not b_match[j] and a[i] == b[j]:
                a_match[i] = b_match[j] = True
                matches += 1
                break
    if matches == 0:
        return 0.0
    t = 0
    k = 0
    for i in range(la):
        if a_match[i]:
            while not b_match[k]:
                k += 1
            if a[i] != b[k]:
                t += 1
            k += 1
    t /= 2
    return (matches / la + matches / lb + (matches - t) / matches) / 3


def _jaro_winkler(a, b, p=0.1):
    j = _jaro(a, b)
    prefix = 0
    for ca, cb in zip(a, b):
        if ca == cb and prefix < 4:
            prefix += 1
        else:
            break
    return j + prefix * p * (1 - j)


def _digits(s):
    return "".join(_re.findall(r"\d+", s))


def dedup(store, threshold=0.90):
    """MinHash/LSH blocking + Jaro-Winkler verification, numeric-differ guarded.

    Each symbol occurrence is a distinct entry keyed by module.name, so the same
    name in several modules is compared (and grouped), not collapsed away.
    """
    manifest, _ = load(store)
    entries = {}  # id "module.name" -> (name, module)
    for m in manifest:
        for s in m.get("symbols", []):
            if s.startswith("__") and s.endswith("__"):
                continue  # skip dunder/boilerplate names (noise)
            entries["{}.{}".format(m["module"], s)] = (s, m["module"])
    ids = sorted(entries)
    perms = _perms()
    sigs = {i: _minhash(entries[i][0], perms) for i in ids}
    cands = _lsh_candidates(sigs)

    parent = {i: i for i in ids}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        parent[find(a)] = find(b)

    verified = 0
    for ia, ib in cands:
        na, nb = entries[ia][0], entries[ib][0]
        if _norm(na) == _norm(nb):
            union(ia, ib); verified += 1; continue
        if _digits(na) != _digits(nb):  # block numeric-differ (item1 vs item2)
            continue
        if _jaro_winkler(_norm(na), _norm(nb)) >= threshold:
            union(ia, ib); verified += 1
    groups = collections.defaultdict(list)
    for i in ids:
        groups[find(i)].append(i)
    out = ["near-duplicate symbols (MinHash/LSH + Jaro-Winkler, threshold {})".format(threshold)]
    found = False
    for root, members in sorted(groups.items()):
        if len(members) > 1:
            found = True
            names = sorted({entries[x][0] for x in members})
            mods = sorted({entries[x][1] for x in members})
            out.append("- {}  (in {})".format(", ".join(names), ", ".join(mods)))
    if not found:
        out.append("- (none)")
    out.append("[candidate pairs from LSH: {}, verified merges: {}]".format(len(cands), verified))
    return "\n".join(out)


def diagnose(store):
    _, edges = load(store)
    nodes = _nodes(edges)
    pair_rels = collections.defaultdict(set)
    exact = collections.Counter()
    selfloops = 0
    for e in edges:
        pair_rels[(e["src"], e["dst"])].add(e["type"])
        exact[(e["src"], e["dst"], e["type"])] += 1
        if e["src"] == e["dst"]:
            selfloops += 1
    multi = {k: v for k, v in pair_rels.items() if len(v) > 1}
    dups = {k: v for k, v in exact.items() if v > 1}
    out = ["diagnostics for {}".format(store)]
    out.append("- edges: {}, nodes: {}".format(len(edges), len(nodes)))
    out.append("- exact duplicate edges: {}".format(len(dups)))
    out.append("- same-endpoint pairs with multiple relations (collapse risk): {}".format(len(multi)))
    for (a, b), rels in list(multi.items())[:5]:
        out.append("    {} <-> {}: {}".format(a, b, ", ".join(sorted(rels))))
    out.append("- self loops: {}".format(selfloops))
    return "\n".join(out)


def suggest_questions(store):
    _, edges = load(store)
    deg = collections.Counter()
    for e in edges:
        deg[e["src"]] += 1; deg[e["dst"]] += 1
    out = ["suggested questions"]
    for e in edges:
        if e.get("confidence") == "AMBIGUOUS":
            out.append("- '{}' is ambiguous: which definition does {} use?".format(
                e["dst"].split(".")[-1], e["src"]))
    for node, d in deg.most_common(3):
        out.append("- {} is a hub ({} edges): what is its role?".format(node, d))
    contained_only = [n for n in _nodes(edges)
                      if deg[n] == 1 and all(e["type"] == "contains" for e in edges
                                             if e["src"] == n or e["dst"] == n)]
    for n in sorted(contained_only)[:3]:
        out.append("- {} is only contained, never used: is it dead?".format(n))
    return "\n".join(dict.fromkeys(out))


def surprising_connections(store):
    _, edges = load(store)
    mod_pairs = collections.defaultdict(list)
    for e in edges:
        if e["type"] in ("calls", "references", "imports_from"):
            sm, dm = e["src"].split(".")[0], e["dst"].split(".")[0]
            if sm != dm:
                mod_pairs[(sm, dm)].append(e)
    out = ["surprising connections (lone cross-module edges)"]
    lone = [(k, v[0]) for k, v in mod_pairs.items() if len(v) == 1]
    if not lone:
        out.append("- (none)")
    for (sm, dm), e in sorted(lone)[:10]:
        out.append("- {} -> {}: only link is {} {}".format(sm, dm, e["type"], e["dst"]))
    return "\n".join(out)


if __name__ == "__main__":
    store, cmd = sys.argv[1], sys.argv[2]
    if cmd == "diff":
        print(graph_diff(store, sys.argv[3]))
    elif cmd == "dedup":
        print(dedup(store))
    elif cmd == "diagnose":
        print(diagnose(store))
    elif cmd == "suggest":
        print(suggest_questions(store))
    elif cmd == "surprising":
        print(surprising_connections(store))
    elif cmd == "god-nodes":
        top = 10
        if "--top" in sys.argv:
            top = int(sys.argv[sys.argv.index("--top") + 1])
        print(god_nodes(store, top))
    elif cmd == "cycles":
        print(cycles(store))
    elif cmd == "communities":
        print(communities(store))
    else:
        print("unknown command:", cmd)
