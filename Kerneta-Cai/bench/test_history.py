"""Benchmark for the history tier: .dai session-store retrieval + router integration.

Deterministic, stdlib only, no API calls. Runs against the committed fixture store
at corpus/history (known ground truth) and, if present, smoke-tests the live local
.daidocs store too. Validates:
  1. question classification (lookup / timeline / tally / advice)
  2. each answerer returns the correct cited source on the fixture
  3. the unified combined_query router sends history-cue questions to the history tier
     while code and doc questions still route to their own tiers
"""

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "engine"))
import dai_history
import combined_query

FIX = os.path.join(ROOT, "corpus", "history")
passed = failed = 0


def check(label, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1; print("  PASS  {}".format(label))
    else:
        failed += 1; print("  FAIL  {}\n        {}".format(label, str(detail).replace("\n", " ")[:220]))


print("=== 1. classify ===")
check("'how many times' -> tally", dai_history.classify("how many times did we add a redis cache") == "tally")
check("'when did' -> timeline", dai_history.classify("when did we migrate auth to jwt") == "timeline")
check("'any tips' -> advice", dai_history.classify("any tips on picking a stack") == "advice")
check("plain what -> lookup", dai_history.classify("what database did we choose for orders") == "lookup")

print("\n=== 2. fixture answers (known ground truth) ===")
o = dai_history.answer(FIX, "what database did we choose for the orders service")
check("lookup orders DB -> Postgres / hist_001", "Postgres" in o and "hist_001" in o, o)

o = dai_history.answer(FIX, "which payment provider did we pick")
check("lookup payment provider -> Stripe / hist_006", "Stripe" in o and "hist_006" in o, o)

o = dai_history.answer(FIX, "when did we first add a redis cache")
check("timeline first redis -> 2026-02-15", "ANSWER:" in o and "2026-02-15" in o.split("ANSWER:")[1], o)

o = dai_history.answer(FIX, "when did we migrate auth to jwt")
check("timeline when jwt -> 2026-03-20", "2026-03-20" in o.split("ANSWER:")[1], o)

o = dai_history.answer(FIX, "how long between choosing postgres and picking stripe")
check("timeline how long -> 142 days", "142 days" in o, o)

o = dai_history.answer(FIX, "how many times did we add a redis cache")
check("tally redis caches -> 2 occurrences", "2 matching occurrence" in o, o)
check("tally excludes the 'Discussed' row", "Discussed Redis vs Memcached" not in o, o)

o = dai_history.answer(FIX, "any tips on picking a database or tech stack")
check("advice names the Postgres/boring-tech preference",
      "Postgres" in o or "boring" in o, o)

print("\n=== 3. unified router (code / docs / history in one ask) ===")
# force the fixture as the history store so the router test is deterministic
os.environ["KERNETA_HISTORY_STORE"] = FIX
STORE = os.path.join(ROOT, "store-combined")

o = combined_query._ask(STORE, "what did we decide about the orders database")
check("history cue -> routed: history + Postgres", "routed: history" in o and "Postgres" in o, o)

o = combined_query._ask(STORE, "remember how many times did we add a redis cache")
check("history+tally cue -> routed: history + 2", "routed: history" in o and "2 matching occurrence" in o, o)

# code/doc questions must NOT be stolen by the history tier (needs a built combined store)
if os.path.exists(os.path.join(STORE, "symbols.jsonl")):
    o = combined_query._ask(STORE, "what calls format_money")
    check("code question still routes to code", "routed: history" not in o and "format_money" in o, o)
    o = combined_query._ask(STORE, "which docs explain cart_total")
    check("doc question still routes to docs", "routed: history" not in o and "docs_for" in o, o)
else:
    print("  SKIP  code/doc non-interference (run test_combined.py first to build store-combined)")

print("\n=== 4. live local .daidocs store smoke test (optional) ===")
live = None
for cand in (os.path.join(ROOT, "..", ".daidocs", "store"),
             os.path.join(ROOT, "..", "..", ".daidocs", "store")):
    if dai_history.is_history_store(cand):
        live = os.path.normpath(cand); break
if live:
    o = dai_history.answer(live, "what was discussed recently")
    check("live store returns a cited memory", "chat_" in o, o[:200])
    print("        (live store: {})".format(live))
else:
    print("  SKIP  no live .daidocs store beside kerneta")

print("\n=== RESULT: {} passed, {} failed ===".format(passed, failed))
sys.exit(1 if failed else 0)
