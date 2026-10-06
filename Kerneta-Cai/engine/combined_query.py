"""Unified query over the combined .cai + .dai store (code + docs + history).

Delegates code questions to the .cai ops and adds cross-store ops that use the
code<->doc cross-links, plus a history tier over a live DaiDocs .dai session store:
  docs_for <symbol>   documents/segments that document a code symbol
  describes <docmod>  code symbols a document describes
  why <symbol>        code definition + what it calls + the prose that explains it
  history "<q>"       answer from past sessions (DaiDocs .dai store); alias: recall
  link-history <path> register the .dai session store for this combined store
  ask "<question>"    natural-language router across code, docs AND history

Run: python combined_query.py <combined_store> <op> [args...]

History store resolution (first that exists wins):
  1. $KERNETA_HISTORY_STORE
  2. <combined_store>/history.json  ->  {"dai_store": "<path>"}  (link-history writes this)
  3. a sibling ".daidocs/store" beside the combined store or its parent
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cai_query
import dai_history


def _load(store, name):
    p = os.path.join(store, name)
    return [json.loads(l) for l in open(p, encoding="utf-8") if l.strip()] if os.path.exists(p) else []


def _segments(store):
    return {s["id"]: s for s in _load(store, "segments.jsonl")}


def op_docs_for(store, sym):
    edges = _load(store, "edges.jsonl")
    segs = _segments(store)
    out = ["slice: documents that mention/document '{}'".format(sym)]
    hits = [e for e in edges if e["type"] == "documented_by" and e["src"].split(".")[-1] == sym]
    if not hits:
        out.append("- (no documentation references it)")
    seen = set()
    for e in hits:
        sid = e["dst"]
        if sid in seen:
            continue
        seen.add(sid)
        seg = segs.get(sid, {})
        out.append("- {} ({}): {}".format(sid, seg.get("title", ""), (seg.get("text", "")[:100] + "...")))
    return "\n".join(out)


def op_describes(store, docmod):
    edges = _load(store, "edges.jsonl")
    out = ["slice: code that '{}' describes".format(docmod)]
    hits = sorted({e["dst"] for e in edges if e["type"] == "mentions" and e["src"].startswith(docmod + "#")})
    if not hits:
        out.append("- (documents no known code)")
    for h in hits:
        out.append("- {}".format(h))
    return "\n".join(out)


def op_why(store, sym):
    symbols = _load(store, "symbols.jsonl")
    edges = _load(store, "edges.jsonl")
    segs = _segments(store)
    out = ["combined answer: why / what is '{}'".format(sym)]
    # code definition
    defs = [s for s in symbols if s["name"] == sym and s.get("kind") != "doc_segment"]
    for s in defs:
        out.append("- code: {} {} defined in {} at L{}".format(s.get("kind", "symbol"), sym, s["module"], s.get("line", "?")))
    # what it calls
    callees = [e for e in edges if e["type"] == "calls" and e["src"].split(".")[-1] == sym]
    if callees:
        out.append("- calls: " + ", ".join(sorted(e["dst"] for e in callees)))
    # who calls it
    callers = [e for e in edges if e["type"] == "calls" and e["dst"].split(".")[-1] == sym]
    if callers:
        out.append("- called by: " + ", ".join(sorted(e["src"] for e in callers)))
    # documentation
    docs = [e for e in edges if e["type"] == "documented_by" and e["src"].split(".")[-1] == sym]
    for e in docs:
        seg = segs.get(e["dst"], {})
        out.append("- doc [{}]: {}".format(seg.get("title", e["dst"]), seg.get("text", "")[:160]))
    if len(out) == 1:
        out.append("- (unknown symbol)")
    return "\n".join(out)


CODE_OPS = {"callers", "callees", "imports", "defines", "tdeps", "path", "most_imported"}

# explicit cues that a question is about past sessions, not code or docs
HISTORY_CUES = ("remember", "recall", "last time", "previously", "earlier session",
                "past session", "we decided", "we discussed", "did we ", "what did i",
                "what did you", "in the past", "before we", "when did we",
                "how many times did we", "last thing we", "what have we")


def history_store(store):
    """Resolve the .dai session store for this combined store, or None."""
    env = os.environ.get("KERNETA_HISTORY_STORE")
    if env and dai_history.is_history_store(env):
        return env
    link = os.path.join(store, "history.json")
    if os.path.exists(link):
        try:
            p = json.load(open(link, encoding="utf-8")).get("dai_store")
            if p and dai_history.is_history_store(p):
                return p
        except Exception:
            pass
    for cand in (os.path.join(store, "..", ".daidocs", "store"),
                 os.path.join(store, "..", "..", ".daidocs", "store")):
        if dai_history.is_history_store(cand):
            return os.path.normpath(cand)
    return None


def op_link_history(store, path):
    if not dai_history.is_history_store(path):
        return "not a .dai store (no _index/manifest.jsonl): {}".format(path)
    with open(os.path.join(store, "history.json"), "w", encoding="utf-8") as f:
        json.dump({"dai_store": os.path.abspath(path)}, f, indent=2)
    return "linked history store: {}".format(os.path.abspath(path))


def op_history(store, question):
    hs = history_store(store)
    if not hs:
        return ("(no .dai history store linked; run `link-history <path>` "
                "or set KERNETA_HISTORY_STORE)")
    return dai_history.answer(hs, question)


def run(store, op, args):
    if op == "docs_for":
        return op_docs_for(store, args[0])
    if op == "describes":
        return op_describes(store, args[0])
    if op == "why":
        return op_why(store, args[0])
    if op in ("history", "recall"):
        return op_history(store, " ".join(args))
    if op == "link-history":
        return op_link_history(store, args[0])
    if op in CODE_OPS:
        return cai_query.run(store, op, args)
    if op == "ask":
        return _ask(store, " ".join(args))
    return "unknown op: {}".format(op)


def _ask(store, question):
    q = question.lower()
    # history first: an explicit "past sessions" cue routes to the .dai history tier,
    # but only when a history store is actually linked (else fall through to code/docs)
    if any(c in q for c in HISTORY_CUES):
        hs = history_store(store)
        if hs:
            return "(routed: history)\n" + dai_history.answer(hs, question)
    manifest = _load(store, "manifest.jsonl")
    symbols = _load(store, "symbols.jsonl")
    docmods = [m["module"] for m in manifest if m.get("lang") == "doc"]
    code_names = {s["name"] for s in symbols if s.get("kind") != "doc_segment"}
    mentioned_docmod = next((d for d in docmods if d.lower() in q), None)
    mentioned_sym = next((n for n in sorted(code_names, key=len, reverse=True)
                          if n.lower() in q.replace("_", "").replace(" ", "") or n.lower() in q), None)
    if ("document" in q or "doc" in q or "explain" in q or "spec" in q) and mentioned_sym and "describe" not in q:
        return "(routed: docs_for {})\n".format(mentioned_sym) + op_docs_for(store, mentioned_sym)
    if "describe" in q and mentioned_docmod:
        return "(routed: describes {})\n".format(mentioned_docmod) + op_describes(store, mentioned_docmod)
    if "why" in q and mentioned_sym:
        return "(routed: why {})\n".format(mentioned_sym) + op_why(store, mentioned_sym)
    # fall back to code NL router
    op, cargs = cai_query.parse_nl(manifest, symbols, question)
    return "(routed: {} {})\n".format(op, " ".join(cargs)) + cai_query.run(store, op, cargs)


if __name__ == "__main__":
    store = sys.argv[1]
    op = sys.argv[2]
    print(run(store, op, sys.argv[3:]))
