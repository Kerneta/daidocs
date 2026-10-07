"""Per-symbol retrieval for .cai: rank individual symbols and return each symbol's
compact .cai block, instead of packing whole module files. Cuts the pack from a
whole module (~thousands of tokens) to just the matched symbol slice (tens).

Uses the [Lx-Ly] line ranges already in the .cai files to pull per-symbol
signature / comments / string-literals from source as extra free search signal.
"""
import os
import re

import mem_search_plus as mp
import mem_search as ms

_SYM = re.compile(r"^- (\S+)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\[L(\d+)-L(\d+)\])?")
_SUB = re.compile(r"^\s+- (\S+)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\[L(\d+)-L(\d+)\])?")


def parse_cai_symbols(cai_path):
    """-> list of {kind,name,l0,l1,block}"""
    if not os.path.exists(cai_path):
        return []
    lines = open(cai_path, encoding="utf-8").read().splitlines()
    try:
        start = next(i for i, l in enumerate(lines) if l.strip() == "## symbols")
    except StopIteration:
        return []
    out = []          # top-level symbols (class/def/fn) with their full blocks
    subs = []         # nested method/property symbols, as their own retrievable docs
    cur = None
    subcur = None
    for l in lines[start + 1:]:
        if l.startswith("## "):
            break
        m = _SYM.match(l)
        if m:
            if cur:
                out.append(cur)
            if subcur:
                subs.append(subcur); subcur = None
            cur = {"kind": m.group(1), "name": m.group(2),
                   "l0": int(m.group(3)) if m.group(3) else None,
                   "l1": int(m.group(4)) if m.group(4) else None,
                   "block": [l]}
            continue
        sm = _SUB.match(l)
        if sm:
            # a nested method/property: keep it inside the class block AND as its own doc
            if subcur:
                subs.append(subcur)
            subcur = {"kind": sm.group(1), "name": sm.group(2),
                      "l0": int(sm.group(3)) if sm.group(3) else None,
                      "l1": int(sm.group(4)) if sm.group(4) else None,
                      "block": [l]}
            if cur is not None:
                cur["block"].append(l)
            continue
        if cur is not None:
            cur["block"].append(l)
        if subcur is not None:
            subcur["block"].append(l)
    if cur:
        out.append(cur)
    if subcur:
        subs.append(subcur)
    seen = {(s["name"]) for s in out}
    all_syms = out + [s for s in subs if s["name"] not in seen or True]
    for s in all_syms:
        s["block"] = "\n".join(s["block"]).rstrip()
    return all_syms


def _span_signals(src_lines, l0, l1):
    if not l0:
        return "", "", "", ""
    span = "\n".join(src_lines[l0 - 1:(l1 or l0)])
    sig = span.splitlines()[0] if span.splitlines() else ""
    comments = " ".join(re.findall(r"#(.*)", span))
    strings = " ".join(re.findall(r"['\"]([^'\"]{2,})['\"]", span))
    body = " ".join(re.findall(r"[A-Za-z_][A-Za-z0-9_]*", span))  # all identifiers in the code
    return sig, comments, strings, body


def build_symbol_docs(store, src_dir):
    manifest = ms._read_jsonl(os.path.join(store, "manifest.jsonl"))
    docs = []
    for m in manifest:
        module = m.get("module")
        path = m.get("path", "")
        cai = os.path.join(store, "files", str(module) + ".cai")
        syms = parse_cai_symbols(cai)
        srcp = os.path.join(src_dir, path)
        src_lines = open(srcp, encoding="utf-8").read().splitlines() if os.path.exists(srcp) else []
        for s in syms:
            doc = ""
            calls = ""
            for bl in s["block"].splitlines():
                t = bl.strip()
                if t.lower().startswith("doc:"):
                    doc = t[4:].strip()
                elif t.lower().startswith("calls:"):
                    calls = t[6:].strip()
            sig, com, lit, body = _span_signals(src_lines, s["l0"], s["l1"])
            fields = {"name": s["name"], "doc": doc, "sig": sig or s["name"],
                      "com": com, "lit": lit, "struct": calls, "body": body}
            docs.append({"id": module + "." + s["name"], "module": module,
                         "name": s["name"], "fields": fields, "block": s["block"]})
    return docs


def retrieve(docs, query, k):
    bm = mp.BM25F([d["fields"] for d in docs])
    qexp = mp.expand_query(query)
    scores = bm.scores(qexp)
    topN = sorted(enumerate(scores), key=lambda x: x[1], reverse=True)[:12]
    ranked = mp.rerank(topN, [d["fields"] for d in docs], qexp)[:k]
    return [docs[i] for i, _ in ranked]


def name_index(store):
    """symbol name -> modules, from symbols.jsonl (includes methods that per-symbol
    .cai blocks may omit)."""
    idx = {}
    for s in ms._read_jsonl(os.path.join(store, "symbols.jsonl")):
        idx.setdefault(s.get("name", "").lower(), set()).add(s.get("module"))
    return idx


# Tier-2 static code/CLI concept map: turns intent paraphrase into candidate identifiers.
# General code-domain concepts (not tied to any one project's symbol names).
CONCEPT = {
    "ask": ["prompt", "input", "read"], "question": ["prompt", "confirm"],
    "reply": ["input", "response", "answer"], "console": ["terminal", "tty", "stdout"],
    "print": ["echo", "write", "output"], "color": ["style", "ansi"], "colored": ["style", "ansi"],
    "styled": ["style"], "bold": ["style"], "bar": ["progress", "progressbar"],
    "progress": ["progressbar"], "editor": ["edit"], "open": ["launch", "file"],
    "url": ["launch"], "screen": ["clear", "terminal"], "keypress": ["getchar"],
    "mistake": ["error", "usage", "invalid", "badparameter"],
    "error": ["exception", "usageerror", "abort", "fail"], "wrong": ["usage", "error"],
    "stop": ["abort", "exit", "raise"], "quit": ["abort", "exit"],
    "file": ["open", "path"], "path": ["file", "filename"],
    "allowed": ["choice", "enum"], "values": ["choice"], "restrict": ["choice", "range"],
    "minimum": ["range", "intrange"], "maximum": ["range", "intrange"], "number": ["int", "range"],
    "width": ["length", "columns", "terminal", "wcwidth", "wcswidth"], "wide": ["width", "wcwidth"],
    "visible": ["width", "strip", "ansi"], "wrap": ["wrap", "textwrap", "format"],
    "help": ["formatter", "format", "usage"], "columns": ["terminal", "width", "size"],
    "escape": ["ansi", "strip"], "strip": ["ansi", "clean"],
    "completion": ["complete", "shell"], "tab": ["complete", "completion"], "shell": ["complete"],
    "state": ["context"], "nested": ["context", "subcommand"], "command": ["command", "group"],
    "option": ["option", "flag", "parameter"], "flag": ["option"], "argument": ["argument", "param"],
    "environment": ["envvar", "env"], "confirm": ["confirm", "yes"], "encoding": ["encode", "charset"],
    "cache": ["cache", "memo"], "retry": ["retry", "backoff"], "redirect": ["redirect", "stream"],
}


def expand_concepts(query):
    import mem_search_plus as _mp
    toks = _mp.tokenize(query)
    extra = []
    for t in toks:
        for c in CONCEPT.get(t, ()):
            extra.append(c)
    return query + " " + " ".join(extra) if extra else query


def is_hard(docs, nidx, query, thresh=22.0):
    """Cheap paraphrase signal: no query token exactly matches a known symbol name,
    and the best lexical score is modest."""
    import mem_search_plus as _mp
    qtoks = set(_mp.tokenize(query))
    if any(t in nidx for t in qtoks):
        return False
    bm = _mp.BM25F([d["fields"] for d in docs])
    top = max(bm.scores(_mp.expand_query(query)) or [0.0])
    return top < thresh


def retrieve_escalate(docs, nidx, query, k=8, hard_k=15):
    """Tier 1: normal retrieve_hybrid. Tier 2 (only when the query looks like a hard
    paraphrase): expand with the code-concept map and widen k. Returns (mods, pack, escalated)."""
    if is_hard(docs, nidx, query):
        mods, pack = retrieve_hybrid(docs, nidx, expand_concepts(query), hard_k)
        return mods, pack, True
    mods, pack = retrieve_hybrid(docs, nidx, query, k)
    return mods, pack, False


def retrieve_hybrid(docs, nidx, query, k=5):
    """Recommended default: per-symbol BM25F top-k, plus a module-fallback that
    surfaces the module for any query token that exactly matches a known symbol
    name (recovers method lookups). Dedupes by module; returns (modules, pack)."""
    res = retrieve(docs, query, max(k, 5))
    qtoks = set(mp.tokenize(query))
    seen, ordered = set(), []
    for tok in qtoks:                       # exact-name module fallback first
        for m in nidx.get(tok, ()):
            if m not in seen:
                seen.add(m); ordered.append((m, "- %s  (defined in %s)" % (tok, m)))
    for d in res:                           # then the ranked symbol slices
        if d["module"] not in seen:
            seen.add(d["module"]); ordered.append((d["module"], d["block"]))
    ordered = ordered[:k]
    return [m for m, _ in ordered], "\n".join(p for _, p in ordered)
