"""Kerneta .cai PR impact review.

Given changed symbols, report the blast radius: everything that (transitively)
depends on them via calls/imports/references. Deterministic, no LLM.

Usage: python cai_pr.py <store> <changed_symbol> [<changed_symbol> ...]
"""

import collections
import json
import os
import sys


def load(store):
    def rd(name):
        p = os.path.join(store, name)
        return [json.loads(l) for l in open(p, encoding="utf-8") if l.strip()] if os.path.exists(p) else []
    return rd("symbols.jsonl"), rd("edges.jsonl")


IMPACT_RELS = {"calls", "indirect_call", "imports", "imports_from", "references",
               "extends", "implements", "dispatches_to"}


def impact(store, changed):
    symbols, edges = load(store)
    rev = collections.defaultdict(set)  # dst -> {srcs}
    for e in edges:
        if e["type"] in IMPACT_RELS:
            rev[e["dst"]].add(e["src"])
    # resolve changed short names to ids
    seeds = set()
    for s in symbols:
        if s["name"] in changed:
            seeds.add("{}.{}".format(s["module"], s["name"]))
    out = ["PR impact: changed {}".format(", ".join(changed))]
    if not seeds:
        out.append("- (no matching symbols in store)")
        return "\n".join(out)
    seen, queue, impacted = set(seeds), list(seeds), []
    while queue:
        cur = queue.pop()
        for dep in sorted(rev.get(cur, ())):
            if dep not in seen:
                seen.add(dep)
                impacted.append((dep, cur))
                queue.append(dep)
    if not impacted:
        out.append("- nothing depends on the changed symbols")
    for dep, via in impacted:
        out.append("- {} is impacted (depends on {})".format(dep, via))
    return "\n".join(out)


if __name__ == "__main__":
    print(impact(sys.argv[1], set(sys.argv[2:])))
