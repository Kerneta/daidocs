"""Tests for the combined .cai + .dai store: build, cross-links, and unified query."""

import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _python():
    """Prefer a local venv, then a sibling kerneta-cai venv, else this interpreter."""
    for cand in (os.path.join(ROOT, ".venv", "Scripts", "python.exe"),
                 os.path.join(ROOT, ".venv", "bin", "python"),
                 os.path.join(ROOT, "..", "kerneta-cai", ".venv", "Scripts", "python.exe")):
        if os.path.exists(cand):
            return cand
    return sys.executable


PY = _python()
ENG = os.path.join(ROOT, "engine")
STORE = os.path.join(ROOT, "store-combined")
passed = failed = 0


def q(op, *args):
    r = subprocess.run([PY, os.path.join(ENG, "combined_query.py"), STORE, op] + list(args),
                       capture_output=True, text=True)
    return r.stdout


def check(label, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1; print("  PASS  {}".format(label))
    else:
        failed += 1; print("  FAIL  {}\n        {}".format(label, detail.replace("\n", " ")[:200]))


# rebuild fresh
subprocess.run([PY, os.path.join(ENG, "cai_ts_extract.py"), os.path.join(ROOT, "corpus/code"), os.path.join(ROOT, "store-code")], check=True)
subprocess.run([PY, os.path.join(ENG, "dai_lite.py"), os.path.join(ROOT, "corpus/docs"), os.path.join(ROOT, "store-docs")], check=True)
subprocess.run([PY, os.path.join(ENG, "cai_dai_combine.py"), os.path.join(ROOT, "store-code"), os.path.join(ROOT, "store-docs"), STORE], check=True)

print("=== combined build + cross-links ===")
edges = open(os.path.join(STORE, "edges.jsonl"), encoding="utf-8").read()
check("mentions cross-links exist", '"mentions"' in edges)
check("documented_by cross-links exist", '"documented_by"' in edges)
check("code edges preserved (calls)", '"calls"' in edges)

print("\n=== cross-store queries ===")
o = q("docs_for", "cart_total")
check("docs_for cart_total finds both docs", "pricing_spec#totals" in o and "architecture#checkout" in o, o)

o = q("docs_for", "all_products")
check("docs_for undocumented symbol says none", "no documentation references it" in o, o)

o = q("describes", "pricing_spec")
check("describes pricing_spec lists the code it covers",
      all(x in o for x in ["cart_total", "item_price", "loyalty_discount", "format_money", "bulk_discount"]), o)

o = q("why", "cart_total")
check("why cart_total returns code definition", "defined in pricing" in o, o)
check("why cart_total returns what it calls", "loyalty_discount" in o and "item_price" in o, o)
check("why cart_total returns explaining prose", "computes the order total" in o, o)

print("\n=== code ops still work on combined store ===")
o = q("callers", "cart_total")
check("callers cart_total = cart.total", "cart.total calls pricing.cart_total" in o, o)
o = q("imports", "pricing")
check("imports pricing = discounts, utils", "discounts" in o and "utils" in o, o)

print("\n=== NL routing ===")
o = q("ask", "why", "does", "cart_total", "work")
check("ask 'why ...' routes to why (code+doc)", "routed: why cart_total" in o and "defined in pricing" in o, o)
o = q("ask", "which", "docs", "explain", "format_money")
check("ask 'which docs ...' routes to docs_for", "routed: docs_for format_money" in o, o)
o = q("ask", "what", "calls", "format_money")
check("ask 'what calls ...' routes to code callers", "callers" in o and "cart_total" in o, o)

print("\n=== RESULT: {} passed, {} failed ===".format(passed, failed))
sys.exit(1 if failed else 0)
