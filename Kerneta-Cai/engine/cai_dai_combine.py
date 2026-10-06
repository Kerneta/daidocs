"""Combine a .cai code store and a .dai-lite doc store into one unified store,
adding the code<->doc cross-links (mentions / documented_by).

Cross-links are deterministic: each doc segment's text is scanned for whole-word
occurrences of known code symbol names and module names; a match links the segment
to the code node both ways. This is what lets a single query return code plus the
prose that explains it.

Run: python cai_dai_combine.py <code_store> <doc_store> <combined_store>
"""

import json
import os
import re
import sys


def _load(store, name):
    p = os.path.join(store, name)
    return [json.loads(l) for l in open(p, encoding="utf-8") if l.strip()] if os.path.exists(p) else []


def build(code_store, doc_store, out):
    os.makedirs(os.path.join(out, "files"), exist_ok=True)
    code_man, code_sym, code_edg = (_load(code_store, "manifest.jsonl"),
                                    _load(code_store, "symbols.jsonl"),
                                    _load(code_store, "edges.jsonl"))
    doc_man, doc_sym, doc_edg = (_load(doc_store, "manifest.jsonl"),
                                 _load(doc_store, "symbols.jsonl"),
                                 _load(doc_store, "edges.jsonl"))
    segments = _load(doc_store, "segments.jsonl")

    # code indexes
    code_name_ids = {}          # symbol name -> [code ids "module.name"]
    for s in code_sym:
        code_name_ids.setdefault(s["name"], []).append("{}.{}".format(s["module"], s["name"]))
    code_mods = {m["module"] for m in code_man}

    # matchable names (skip very short to avoid noise)
    names = sorted([n for n in code_name_ids if len(n) >= 4] +
                   [m for m in code_mods if len(m) >= 4], key=len, reverse=True)

    cross = []
    for seg in segments:
        text = seg["text"]
        sid = seg["id"]
        linked = set()
        for name in names:
            if name in linked:
                continue
            if re.search(r"\b" + re.escape(name) + r"\b", text):
                targets = code_name_ids.get(name) or (["{}".format(name)] if name in code_mods else [])
                for tgt in targets:
                    cross.append({"src": sid, "dst": tgt, "type": "mentions", "confidence": "EXTRACTED"})
                    cross.append({"src": tgt, "dst": sid, "type": "documented_by", "confidence": "EXTRACTED"})
                linked.add(name)

    # write unified store
    with open(os.path.join(out, "manifest.jsonl"), "w", encoding="utf-8") as f:
        for r in code_man + doc_man:
            f.write(json.dumps(r) + "\n")
    with open(os.path.join(out, "symbols.jsonl"), "w", encoding="utf-8") as f:
        for r in code_sym + doc_sym:
            f.write(json.dumps(r) + "\n")
    with open(os.path.join(out, "edges.jsonl"), "w", encoding="utf-8") as f:
        seen = set()
        for e in code_edg + doc_edg + cross:
            k = (e["src"], e["dst"], e["type"])
            if k not in seen:
                seen.add(k)
                f.write(json.dumps(e) + "\n")
    with open(os.path.join(out, "segments.jsonl"), "w", encoding="utf-8") as f:
        for r in segments:
            f.write(json.dumps(r) + "\n")
    return len(code_man), len(doc_man), len(cross) // 2


if __name__ == "__main__":
    c, d, x = build(sys.argv[1], sys.argv[2], sys.argv[3])
    print("combined: {} code modules + {} docs, {} code<->doc cross-links -> {}".format(c, d, x, sys.argv[3]))
