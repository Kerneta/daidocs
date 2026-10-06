"""Test recursive corpus indexing: nested source dirs are discovered and linked.

Builds the committed corpus/nested fixture (api/, core/, app.py) and asserts that
files in subdirectories are indexed with path-qualified module names and that calls
across subdirectories resolve. Needs tree-sitter (grammar venv).
"""

import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "engine"))
import cai_ts_extract
import cai_update

CORPUS = os.path.join(ROOT, "corpus", "nested")
passed = failed = 0


def check(label, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1; print("  PASS  {}".format(label))
    else:
        failed += 1; print("  FAIL  {}\n        {}".format(label, str(detail)[:200]))


# 1. discover() finds nested files with path-qualified modules
mods = {m for _p, m, _l in cai_ts_extract.discover(CORPUS)}
print("=== discover ===")
check("finds nested module api/handlers", "api/handlers" in mods, mods)
check("finds nested module core/service", "core/service" in mods, mods)
check("finds top-level module app", "app" in mods, mods)

# 2. build + query across subdirectories
store = tempfile.mkdtemp(prefix="cai_rec_")
try:
    cai_ts_extract.build(CORPUS, store)
    print("\n=== build + cross-subdir query ===")
    out = subprocess.run([sys.executable, os.path.join(ROOT, "engine", "cai_query.py"),
                          store, "callees", "handle"], capture_output=True, text=True).stdout
    check("handle (api/) calls service_call (core/)", "service_call" in out, out)
    out = subprocess.run([sys.executable, os.path.join(ROOT, "engine", "cai_query.py"),
                          store, "defines", "service_call"], capture_output=True, text=True).stdout
    check("service_call is defined in core/service", "core/service" in out, out)

    # 3. incremental update keys by nested module path
    print("\n=== recursive incremental update ===")
    cai_update.update(CORPUS, store, quiet=True)   # seed the SHA index
    dirty_again = cai_update.update(CORPUS, store, quiet=True)
    check("no change on a clean re-scan", dirty_again is False, "dirty={}".format(dirty_again))
    newf = os.path.join(CORPUS, "core", "extra.py")
    try:
        open(newf, "w").write("def added():\n    return 1\n")
        dirty = cai_update.update(CORPUS, store, quiet=True)
        check("detects a new file in a subdir", dirty is True)
    finally:
        if os.path.exists(newf):
            os.remove(newf)
    cai_update.update(CORPUS, store, quiet=True)  # settle back
finally:
    shutil.rmtree(store, ignore_errors=True)

print("\n=== RESULT: {} passed, {} failed ===".format(passed, failed))
sys.exit(1 if failed else 0)
