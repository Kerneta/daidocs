"""Kerneta .dai-lite: a deterministic document extractor for the combined store.

Segments markdown/text documents by heading and keeps each segment's text so the
combined query can return prose. This is the offline, no-LLM slice of DaiDocs: it
does structure and (via the combine step) code-symbol cross-links, not prose
semantics (which is the model leaf). Real .dai adds LLM Understanding on top.

Run: python dai_lite.py <docs_dir> <doc_store>
"""

import json
import os
import re
import sys

DOC_EXT = {".md", ".mdx", ".txt", ".rst"}


def _slug(title):
    return re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-") or "seg"


def segment(text):
    """Split into (title, body) segments by level-2 headings; preamble kept."""
    lines = text.splitlines()
    doc_title = ""
    segs = []
    cur_title, cur_body = "preamble", []
    for ln in lines:
        h1 = re.match(r"^#\s+(.*)", ln)
        h2 = re.match(r"^##\s+(.*)", ln)
        if h1:
            doc_title = h1.group(1).strip()
            continue
        if h2:
            if cur_body:
                segs.append((cur_title, "\n".join(cur_body).strip()))
            cur_title, cur_body = h2.group(1).strip(), []
        else:
            cur_body.append(ln)
    if cur_body and "".join(cur_body).strip():
        segs.append((cur_title, "\n".join(cur_body).strip()))
    return doc_title, [(t, b) for t, b in segs if b]


def build(docs_dir, store):
    os.makedirs(os.path.join(store, "files"), exist_ok=True)
    manifest, symbols, edges, segments = [], [], [], []
    for name in sorted(os.listdir(docs_dir)):
        ext = os.path.splitext(name)[1].lower()
        if ext not in DOC_EXT:
            continue
        mod = os.path.splitext(name)[0]
        text = open(os.path.join(docs_dir, name), encoding="utf-8", errors="replace").read()
        title, segs = segment(text)
        seg_ids = []
        for t, body in segs:
            sid = "{}#{}".format(mod, _slug(t))
            seg_ids.append(sid)
            symbols.append({"name": sid, "kind": "doc_segment", "module": mod, "line": 1})
            edges.append({"src": mod, "dst": sid, "type": "contains", "confidence": "EXTRACTED"})
            segments.append({"id": sid, "module": mod, "title": t, "text": body})
        manifest.append({"module": mod, "path": name, "lang": "doc", "title": title,
                         "summary": (segs[0][1][:120] if segs else ""), "symbols": seg_ids,
                         "imports": [], "loc": text.count("\n") + 1})
        with open(os.path.join(store, "files", mod + ".dai"), "w", encoding="utf-8") as f:
            f.write("# .dai-lite  {}\ntitle: {}\n\n".format(mod, title) +
                    "\n".join("## {}\n{}".format(t, b) for t, b in segs) + "\n")
    for fn, rows in (("manifest.jsonl", manifest), ("symbols.jsonl", symbols),
                     ("edges.jsonl", edges), ("segments.jsonl", segments)):
        with open(os.path.join(store, fn), "w", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(r) + "\n")
    return len(manifest), len(segments)


if __name__ == "__main__":
    n, s = build(sys.argv[1], sys.argv[2])
    print("built {} doc files, {} segments into {}".format(n, s, sys.argv[2]))
