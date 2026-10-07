"""Plain-text memory retriever for .cai and .dai stores (stdlib only).

The "search my memory first, then the LLM+YAML reads the top-k" step. No server,
no binary index, no dependencies. Three retrieval stages, each usable alone so the
benchmark can measure them with and without:

  1. manifest_filter  cheap substring/regex prefilter over the manifest
  2. bm25_search      Okapi BM25 lexical ranking over the searchable text
  3. symbol_match     exact/substring symbol-name match (.cai only)

Covers what XERJ's *lexical* mode plus the routing/planning step give you, in
plain text. It does NOT do neural semantic recall (that needs embeddings, i.e. a
binary vector index) - see FUTURE-TASKS.md.

CLI:
  python mem_search.py cai <store> "<query>" [-k N] [--pack] [--stage all|manifest|bm25|symbol]
  python mem_search.py dai <store> "<query>" [-k N] [--pack] [--stage all|manifest|bm25]
"""

import argparse
import json
import math
import os
import re
import sys

TOKEN_RE = re.compile(r"[A-Za-z0-9]+")
_CAMEL = re.compile(r"(?<=[a-z0-9])(?=[A-Z])")


def tokenize(text):
    """Lowercase word/identifier tokens, split on camelCase and snake_case."""
    out = []
    for raw in TOKEN_RE.findall(text or ""):
        parts = _CAMEL.sub(" ", raw).split()
        for p in parts:
            for seg in p.split("_"):
                if seg:
                    out.append(seg.lower())
        out.append(raw.lower())
    return out


# ----------------------------------------------------------------------------
# BM25 (Okapi), pure python
# ----------------------------------------------------------------------------
class BM25:
    def __init__(self, docs_tokens, k1=1.5, b=0.75):
        self.k1, self.b = k1, b
        self.docs = docs_tokens
        self.N = len(docs_tokens)
        self.dl = [len(d) for d in docs_tokens]
        self.avgdl = (sum(self.dl) / self.N) if self.N else 0.0
        self.tf = []
        df = {}
        for d in docs_tokens:
            counts = {}
            for t in d:
                counts[t] = counts.get(t, 0) + 1
            self.tf.append(counts)
            for t in counts:
                df[t] = df.get(t, 0) + 1
        self.idf = {}
        for t, n in df.items():
            # BM25+ style idf, floored at a small positive value
            self.idf[t] = max(1e-6, math.log(1 + (self.N - n + 0.5) / (n + 0.5)))

    def scores(self, query_tokens):
        out = [0.0] * self.N
        for i in range(self.N):
            tf = self.tf[i]
            denom_dl = self.k1 * (1 - self.b + self.b * (self.dl[i] / self.avgdl if self.avgdl else 0))
            s = 0.0
            for t in query_tokens:
                f = tf.get(t)
                if not f:
                    continue
                s += self.idf.get(t, 0.0) * (f * (self.k1 + 1)) / (f + denom_dl)
            out[i] = s
        return out


# ----------------------------------------------------------------------------
# Store loaders -> a common list of docs: {id, text, meta}
# ----------------------------------------------------------------------------
def _read_jsonl(path):
    if not os.path.exists(path):
        return []
    rows = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def _cai_docstrings(store, path):
    """Pull the 'doc:' lines already present in a module's .cai file (Option A surface)."""
    base = os.path.splitext(os.path.basename(path or ""))[0]
    f = os.path.join(store, "files", base + ".cai")
    if not os.path.exists(f):
        return ""
    docs = []
    for line in open(f, encoding="utf-8"):
        s = line.strip()
        if s.lower().startswith("doc:"):
            docs.append(s[4:].strip())
    return " ".join(docs)


def load_cai(store, enrich=False):
    """One doc per module. Searchable text = module + symbols + imports + summary.
    enrich=True also folds in the docstrings already stored in the .cai files
    (Option A: index the meaning that was there but unsearched)."""
    manifest = _read_jsonl(os.path.join(store, "manifest.jsonl"))
    symbols = _read_jsonl(os.path.join(store, "symbols.jsonl"))
    docs = []
    for m in manifest:
        parts = [
            m.get("module", ""), m.get("path", ""), m.get("summary", ""),
            " ".join(m.get("symbols", [])), " ".join(m.get("imports", [])),
        ]
        if enrich:
            parts.append(_cai_docstrings(store, m.get("path", "")))
        docs.append({"id": m.get("module", m.get("path", "?")),
                     "text": " ".join(parts),
                     "meta": {"path": m.get("path"), "symbols": m.get("symbols", [])}})
    return docs, symbols


def _dai_understanding(path):
    """Extract the frontmatter + '# Understanding' block from a .dai file (zoom 2)."""
    if not os.path.exists(path):
        return ""
    txt = open(path, encoding="utf-8").read()
    # frontmatter between the first two '---'
    fm = ""
    parts = txt.split("---")
    if len(parts) >= 3:
        fm = parts[1]
    m = re.search(r"# Understanding\s*```json\s*(\{.*?\})\s*```", txt, re.S)
    und = m.group(1) if m else ""
    return (fm + "\n" + und).strip()


def load_dai(store):
    """One doc per memory. Searchable text = title + summary + topics + entities + tags."""
    manifest = _read_jsonl(os.path.join(store, "_index", "manifest.jsonl"))
    docs = []
    for m in manifest:
        ents = m.get("entities", {})
        if isinstance(ents, dict):
            ent_text = " ".join(str(v) for vs in ents.values()
                                for v in (vs if isinstance(vs, list) else [vs]))
        else:
            ent_text = " ".join(map(str, ents)) if isinstance(ents, list) else str(ents)
        text = " ".join([
            m.get("title", ""), m.get("summary", ""),
            " ".join(m.get("topics", []) or []), ent_text,
            " ".join(m.get("tags", []) or []),
        ])
        docs.append({"id": m.get("id", m.get("path", "?")),
                     "text": text,
                     "meta": {"path": m.get("path"), "title": m.get("title")}})
    return docs


# ----------------------------------------------------------------------------
# Retrieval stages
# ----------------------------------------------------------------------------
def manifest_filter(query, docs):
    """Cheap prefilter: keep docs whose text contains any query token as a substring.
    Returns (kept_indices). Falls back to all docs if nothing matches."""
    qtok = set(tokenize(query))
    kept = []
    for i, d in enumerate(docs):
        low = d["text"].lower()
        if any(t in low for t in qtok):
            kept.append(i)
    return kept if kept else list(range(len(docs)))


def bm25_search(query, docs, k, candidates=None):
    idxs = candidates if candidates is not None else list(range(len(docs)))
    sub = [tokenize(docs[i]["text"]) for i in idxs]
    bm = BM25(sub)
    scores = bm.scores(tokenize(query))
    ranked = sorted(zip(idxs, scores), key=lambda x: x[1], reverse=True)
    return [(i, s) for i, s in ranked[:k]]


def symbol_match(query, symbols, k):
    """.cai only: match query tokens against symbol names. Returns list of (module, name)."""
    qtok = set(tokenize(query))
    hits = []
    for s in symbols:
        name = s.get("name", "")
        ntok = set(tokenize(name))
        if ntok & qtok or name.lower() in query.lower():
            hits.append((s.get("module"), name))
    return hits[:k]


def retrieve(kind, store, query, k=3, stage="all"):
    if kind == "cai":
        docs, symbols = load_cai(store)
    else:
        docs, symbols = load_dai(store), []

    result = {"stage": stage, "hits": [], "symbol_hits": []}

    if stage in ("symbol",) and kind == "cai":
        result["symbol_hits"] = symbol_match(query, symbols, k)
        return result, docs

    cand = None
    if stage in ("all", "manifest"):
        cand = manifest_filter(query, docs)
    if stage == "manifest":
        # prefilter only, no ranking: return the candidates (capped)
        result["hits"] = [(i, 0.0) for i in cand[:k]]
    else:  # all or bm25
        result["hits"] = bm25_search(query, docs, k, candidates=cand)
    if stage == "all" and kind == "cai":
        result["symbol_hits"] = symbol_match(query, symbols, k)
    return result, docs


# ----------------------------------------------------------------------------
# Pack builders (what the LLM would then read)
# ----------------------------------------------------------------------------
def pack_cai(store, docs, hits):
    parts = []
    for i, _ in hits:
        p = docs[i]["meta"].get("path", "")
        cai = os.path.join(store, "files", os.path.splitext(os.path.basename(p))[0] + ".cai")
        if os.path.exists(cai):
            parts.append("### {}\n{}".format(docs[i]["id"], open(cai, encoding="utf-8").read()))
    return "\n".join(parts)


def pack_dai(store, docs, hits):
    parts = []
    for i, _ in hits:
        p = docs[i]["meta"].get("path", "")
        full = p if os.path.isabs(p) else os.path.join(store, p)
        parts.append("### {}\n{}".format(docs[i]["id"], _dai_understanding(full)))
    return "\n".join(parts)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("kind", choices=["cai", "dai"])
    ap.add_argument("store")
    ap.add_argument("query")
    ap.add_argument("-k", type=int, default=3)
    ap.add_argument("--stage", default="all", choices=["all", "manifest", "bm25", "symbol"])
    ap.add_argument("--pack", action="store_true")
    a = ap.parse_args()
    res, docs = retrieve(a.kind, a.store, a.query, a.k, a.stage)
    print("stage:", res["stage"])
    for i, s in res["hits"]:
        print("  {:<40} score={:.3f}".format(str(docs[i]["id"]), s))
    if res["symbol_hits"]:
        print("symbols:", ", ".join("{}.{}".format(m, n) for m, n in res["symbol_hits"]))
    if a.pack:
        pack = pack_cai(a.store, docs, res["hits"]) if a.kind == "cai" else pack_dai(a.store, docs, res["hits"])
        print("\n--- PACK ({} chars ~{} tok) ---".format(len(pack), max(1, len(pack) // 4)))
        print(pack)


if __name__ == "__main__":
    main()
