"""Test the auto-setup installer: skill + Claude Code PostToolUse hook + built store.

Verifies that `cai_install.setup` makes .cai automatic for a project:
  - builds the store once (queryable immediately)
  - installs the kerneta-cai skill so Claude queries the store
  - adds a PostToolUse hook that refreshes the store after Edit/Write
  - merges into an existing settings.json without clobbering, and is idempotent

Needs tree-sitter (the store build), so run under the grammar venv.
"""

import json
import os
import shutil
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "engine"))
import cai_install

CORPUS = os.path.join(ROOT, "corpus", "code")
passed = failed = 0


def check(label, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1; print("  PASS  {}".format(label))
    else:
        failed += 1; print("  FAIL  {}\n        {}".format(label, str(detail)[:200]))


proj = tempfile.mkdtemp(prefix="cai_setup_")
try:
    # pre-seed an unrelated settings key to prove the merge preserves it
    os.makedirs(os.path.join(proj, ".claude"), exist_ok=True)
    with open(os.path.join(proj, ".claude", "settings.json"), "w", encoding="utf-8") as f:
        json.dump({"model": "opus", "hooks": {"PreToolUse": [{"matcher": "Bash"}]}}, f)

    # pre-seed a minimal .dai history store so setup links it out of the box
    didx = os.path.join(proj, ".daidocs", "store", "_index")
    os.makedirs(didx, exist_ok=True)
    with open(os.path.join(didx, "manifest.jsonl"), "w", encoding="utf-8") as f:
        f.write('{"id":"h1","title":"x","date":"2026-01-01","summary":"y"}\n')

    store = os.path.join(proj, "store-code")
    msg = cai_install.setup(proj, CORPUS, store=store, python=sys.executable)

    print("=== setup output ===")
    check("built the store", os.path.exists(os.path.join(store, "manifest.jsonl")), msg)
    check("installed the skill",
          os.path.exists(os.path.join(proj, ".claude", "skills", "kerneta-cai", "SKILL.md")))
    check("linked the history store", os.path.exists(os.path.join(store, "history.json")),
          "history.json not written")

    settings = json.load(open(os.path.join(proj, ".claude", "settings.json"), encoding="utf-8"))
    post = settings.get("hooks", {}).get("PostToolUse", [])
    cmds = [h.get("command", "") for e in post for h in e.get("hooks", [])]
    check("added a PostToolUse hook", len(post) == 1)
    check("hook matcher is Edit|Write|MultiEdit", post and post[0].get("matcher") == "Edit|Write|MultiEdit")
    check("hook runs cai_update update", any("cai_update.py" in c and "update" in c for c in cmds), cmds)
    check("hook runs quietly", any("--quiet" in c for c in cmds), cmds)

    print("\n=== merge preserves existing settings ===")
    check("unrelated key kept", settings.get("model") == "opus")
    check("existing PreToolUse hook kept", "PreToolUse" in settings.get("hooks", {}))

    print("\n=== skill points at this store ===")
    skill = open(os.path.join(proj, ".claude", "skills", "kerneta-cai", "SKILL.md"), encoding="utf-8").read()
    check("skill references the store path", store.replace("\\", "/") in skill, skill[:200])

    print("\n=== idempotent: second setup adds no duplicate hook ===")
    cai_install.setup(proj, CORPUS, store=store, python=sys.executable)
    settings2 = json.load(open(os.path.join(proj, ".claude", "settings.json"), encoding="utf-8"))
    post2 = settings2.get("hooks", {}).get("PostToolUse", [])
    check("still exactly one PostToolUse hook", len(post2) == 1, "{} entries".format(len(post2)))
finally:
    shutil.rmtree(proj, ignore_errors=True)

print("\n=== RESULT: {} passed, {} failed ===".format(passed, failed))
sys.exit(1 if failed else 0)
