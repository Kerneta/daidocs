"""History tier: query a live DaiDocs .dai session store from kerneta.

This is the third half of the unified memory. `.cai` holds code, `.dai`-lite holds
documents, and this reads the full semantic DaiDocs session store (the Node product's
output: `.dai` files plus `_index/` JSONL) so one router can answer questions about
past conversations and decisions, not just code and docs.

It is a pure-stdlib reader over the store's indexes, following the DaiDocs reading
protocol (classify the question, then answer from the shallowest index that resolves
it). No LLM, no server: the semantic Understanding was written at capture time; this
retrieves and shapes it.

  _index/manifest.jsonl  one row per session  (id, title, date, summary, topics, ...)
  _index/facts.jsonl     one row per dated fact (kind = event|attribute|preference|plan)
  _index/events.jsonl    one row per countable real-world occurrence
  _index/profile.jsonl   stated / implied user preferences

Question types (each answered in its own style, per the protocol):
  lookup    single fact  -> best-matching memory summary, cited
  timeline  when/first/last/order -> relevant facts sorted by date, with day arithmetic
  tally     how many/list all     -> deduplicated count from events
  advice    recommend/should I    -> preferences + a named past item to build on

CLI:
  python dai_history.py <dai_store> "<question>" [-k N] [--type auto|lookup|timeline|tally|advice]
"""

import argparse
import datetime
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mem_search  # tokenize, BM25, load_dai, _read_jsonl


# ---------------------------------------------------------------------------
# loaders
# ---------------------------------------------------------------------------
def _idx(store, name):
    return mem_search._read_jsonl(os.path.join(store, "_index", name))


def load_facts(store):
    return _idx(store, "facts.jsonl")


def load_events(store):
    return _idx(store, "events.jsonl")


def load_profile(store):
    return _idx(store, "profile.jsonl")


def is_history_store(store):
    """A directory is a DaiDocs .dai store if it has _index/manifest.jsonl."""
    return os.path.exists(os.path.join(store, "_index", "manifest.jsonl"))


# ---------------------------------------------------------------------------
# question classification (DaiDocs reading protocol)
# ---------------------------------------------------------------------------
TALLY_CUES = ("how many", "how much", "how often", "total number", " total ",
              "count", "list all", "list every", "which ones", "number of",
              "how many times")
TIMELINE_CUES = ("when ", "when did", "what date", "first", "last", "latest",
                 "earliest", "before", "after", "how long", "what order",
                 "in order", "since", "until", "most recent", "previous")
ADVICE_CUES = ("recommend", "suggest", "should i", "should we", "any tips",
               "any idea", "ideas", "advice", "what should", "help me pick",
               "which should")


def classify(question):
    q = " " + question.lower().strip() + " "
    if any(c in q for c in TALLY_CUES):
        return "tally"
    if any(c in q for c in TIMELINE_CUES):
        return "timeline"
    if any(c in q for c in ADVICE_CUES):
        return "advice"
    return "lookup"


# ---------------------------------------------------------------------------
# ranking helpers (reuse the BM25 retriever over whichever rows are relevant)
# ---------------------------------------------------------------------------
def _rank(rows, textof, query, k):
    """Return the top-k rows by BM25 over textof(row). Keeps row + score."""
    if not rows:
        return []
    toks = [mem_search.tokenize(textof(r)) for r in rows]
    bm = mem_search.BM25(toks)
    scores = bm.scores(mem_search.tokenize(query))
    ranked = sorted(zip(rows, scores), key=lambda x: x[1], reverse=True)
    return [(r, s) for r, s in ranked[:k] if s > 0] or [(ranked[0][0], ranked[0][1])]


def _date(row):
    return row.get("date") or ""


def _days_between(a, b):
    try:
        da = datetime.date.fromisoformat(a[:10])
        db = datetime.date.fromisoformat(b[:10])
        return abs((db - da).days)
    except Exception:
        return None


# ---------------------------------------------------------------------------
# answerers
# ---------------------------------------------------------------------------
def answer_lookup(store, question, k=3):
    docs = mem_search.load_dai(store)
    res, docs = mem_search.retrieve("dai", store, question, k=k, stage="all")
    out = []
    manifest = {m.get("id", m.get("path")): m
                for m in mem_search._read_jsonl(os.path.join(store, "_index", "manifest.jsonl"))}
    for i, s in res["hits"][:k]:
        mid = docs[i]["id"]
        m = manifest.get(mid, {})
        out.append("- {} ({}): {}".format(m.get("title", mid), mid, m.get("summary", "")[:240]))
    # also surface the single best matching fact, if any
    facts = load_facts(store)
    fr = _rank(facts, lambda r: r.get("fact", ""), question, 1)
    if fr and fr[0][1] > 0:
        f = fr[0][0]
        out.append("- fact [{}]: {}".format(f.get("src", "?"), f.get("fact", "")[:240]))
    if not out:
        return "There is no information about that."
    return "\n".join(out)


def answer_timeline(store, question, k=8):
    facts = load_facts(store)
    hits = _rank(facts, lambda r: r.get("fact", "") + " " + " ".join(r.get("entities", []) or []),
                 question, k)
    hits = [h for h in hits if h[1] > 0]
    best = hits[0][0] if hits else None            # most relevant (BM25 top)
    rows = sorted([h[0] for h in hits], key=_date)  # chronological, for display
    out = ["timeline for: {}".format(question)]
    for r in rows:
        out.append("  {}  [{}] {} ({})".format(_date(r), r.get("kind", "?"),
                                                r.get("fact", "")[:160], r.get("src", "?")))
    q = question.lower()
    if rows:
        first, last = rows[0], rows[-1]
        if "how long" in q and len(rows) >= 2:
            d = _days_between(_date(first), _date(last))
            out.append("ANSWER: {} to {} = {} days.".format(_date(first), _date(last),
                                                             d if d is not None else "?"))
        elif "first" in q or "earliest" in q:
            out.append("ANSWER: {} ({}).".format(first.get("fact", "")[:160], _date(first)))
        elif "last" in q or "latest" in q or "most recent" in q:
            out.append("ANSWER: {} ({}).".format(last.get("fact", "")[:160], _date(last)))
        else:  # plain "when did X": the date of the most relevant fact, not the oldest
            out.append("ANSWER: {} ({}).".format(best.get("fact", "")[:160], _date(best)))
    else:
        out.append("ANSWER: There is no information about that.")
    return "\n".join(out)


def answer_tally(store, question, k=None):
    events = load_events(store)
    # exclude conversation-topic rows, per the protocol
    real = [e for e in events
            if not (e.get("what", "").lower().startswith(("asked about", "discussed", "asked ", "talked about")))]
    # rank over everything, then keep genuine matches (score within half of the top),
    # so the count reflects real occurrences, not an arbitrary k cap
    hits = _rank(real, lambda r: r.get("what", ""), question, k or len(real) or 1)
    top = hits[0][1] if hits else 0.0
    floor = max(0.0, top * 0.5)
    rows = [h[0] for h in hits if h[1] > 0 and h[1] >= floor]
    # dedupe by (date, what)
    seen, uniq = set(), []
    for r in rows:
        key = (r.get("date"), r.get("what", "").strip().lower())
        if key in seen:
            continue
        seen.add(key)
        uniq.append(r)
    out = ["tally for: {}".format(question)]
    for r in uniq:
        out.append("  {}  {} ({})".format(_date(r), r.get("what", "")[:140], r.get("src", "?")))
    out.append("ANSWER: {} matching occurrence(s).".format(len(uniq)))
    return "\n".join(out)


def answer_advice(store, question, k=4):
    prof = load_profile(store)
    prefs = []
    for p in prof:
        for pref in (p.get("preferences") or []):
            prefs.append(pref)
    # rank preferences by relevance, keep a few
    ranked = _rank([{"p": p} for p in prefs], lambda r: r["p"], question, k) if prefs else []
    picked = [r[0]["p"] for r in ranked] or prefs[:k]
    # name a concrete past item to build on
    res, docs = mem_search.retrieve("dai", store, question, k=2, stage="all")
    manifest = {m.get("id", m.get("path")): m
                for m in mem_search._read_jsonl(os.path.join(store, "_index", "manifest.jsonl"))}
    building_on = []
    for i, s in res["hits"][:2]:
        m = manifest.get(docs[i]["id"], {})
        if m:
            building_on.append(m.get("title", docs[i]["id"]))
    out = ["advice for: {}".format(question)]
    if picked:
        out.append("known preferences: " + "; ".join(picked[:k]))
    if building_on:
        out.append("building on past work: " + "; ".join(building_on))
    return "\n".join(out)


ANSWERERS = {"lookup": answer_lookup, "timeline": answer_timeline,
             "tally": answer_tally, "advice": answer_advice}


def answer(store, question, qtype="auto", k=None):
    if not is_history_store(store):
        return "(no .dai history store at {})".format(store)
    t = classify(question) if qtype == "auto" else qtype
    fn = ANSWERERS[t]
    head = "(history: {} | {})\n".format(t, os.path.basename(os.path.normpath(store)))
    return head + (fn(store, question, k) if k else fn(store, question))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("store")
    ap.add_argument("question")
    ap.add_argument("-k", type=int, default=None)
    ap.add_argument("--type", default="auto",
                    choices=["auto", "lookup", "timeline", "tally", "advice"])
    a = ap.parse_args()
    print(answer(a.store, a.question, a.type, a.k))


if __name__ == "__main__":
    main()
