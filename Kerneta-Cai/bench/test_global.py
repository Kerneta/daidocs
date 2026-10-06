"""Test the global opt-in flow: `kerneta init` + the project-aware PostToolUse resolver.

Verifies that init builds a store and a marker, that the resolver refreshes exactly the
project whose file was edited (and no-ops outside any store), and that setup_global
writes the skill + hook into a (temp) home without clobbering existing settings.
Needs tree-sitter (the store build), so run under the grammar venv.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENG = os.path.join(ROOT, "engine")
sys.path.insert(0, ENG)
import cai_install

passed = failed = 0


def check(label, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1; print("  PASS  {}".format(label))
    else:
        failed += 1; print("  FAIL  {}\n        {}".format(label, str(detail)[:200]))


proj = tempfile.mkdtemp(prefix="kcai_init_")
try:
    with open(os.path.join(proj, "mod.py"), "w", encoding="utf-8") as f:
        f.write("def alpha():\n    return beta()\n\ndef beta():\n    return 1\n")

    print("=== kerneta init ===")
    cai_install.init(proj)
    store = os.path.join(proj, ".cai-store")
    check("built the store", os.path.exists(os.path.join(store, "manifest.jsonl")))
    marker = os.path.join(store, ".kerneta.json")
    check("wrote the marker", os.path.exists(marker))
    cfg = json.load(open(marker, encoding="utf-8"))
    check("marker records corpus + store", cfg.get("corpus") and cfg.get("store"))

    print("\n=== resolver refreshes the edited project ===")
    with open(os.path.join(proj, "mod.py"), "a", encoding="utf-8") as f:
        f.write("\ndef gamma():\n    return alpha()\n")
    payload = json.dumps({"tool_input": {"file_path": os.path.join(proj, "mod.py")}})
    r = subprocess.run([sys.executable, os.path.join(ENG, "cai_hook_resolve.py")],
                       input=payload, capture_output=True, text=True)
    check("resolver exits 0", r.returncode == 0, r.stderr)
    o = subprocess.run([sys.executable, os.path.join(ENG, "cai_query.py"), store, "callees", "gamma"],
                       capture_output=True, text=True).stdout
    check("gamma was indexed by the hook", "mod.gamma calls mod.alpha" in o, o)

    print("\n=== resolver no-ops outside any store ===")
    payload2 = json.dumps({"tool_input": {"file_path": os.path.join(tempfile.gettempdir(), "nope", "x.py")}})
    r2 = subprocess.run([sys.executable, os.path.join(ENG, "cai_hook_resolve.py")],
                        input=payload2, capture_output=True, text=True)
    check("no-op exits 0", r2.returncode == 0, r2.stderr)

    print("\n=== zero-touch: --auto builds a store on first edit in a git repo ===")
    repo = tempfile.mkdtemp(prefix="kcai_auto_")
    subprocess.run(["git", "init", "-q"], cwd=repo)
    with open(os.path.join(repo, "app.py"), "w", encoding="utf-8") as f:
        f.write("def one():\n    return two()\n\ndef two():\n    return 1\n")
    pl = json.dumps({"tool_input": {"file_path": os.path.join(repo, "app.py")}})
    subprocess.run([sys.executable, os.path.join(ENG, "cai_hook_resolve.py"), "--auto"],
                   input=pl, capture_output=True, text=True)
    check("auto-built a store in the git repo", os.path.exists(os.path.join(repo, ".cai-store", "manifest.jsonl")))
    check("auto marker records auto:true",
          json.load(open(os.path.join(repo, ".cai-store", ".kerneta.json"), encoding="utf-8")).get("auto") is True)
    norepo = tempfile.mkdtemp(prefix="kcai_norepo_")
    with open(os.path.join(norepo, "loose.py"), "w", encoding="utf-8") as f:
        f.write("def x():\n    return 1\n")
    pl2 = json.dumps({"tool_input": {"file_path": os.path.join(norepo, "loose.py")}})
    subprocess.run([sys.executable, os.path.join(ENG, "cai_hook_resolve.py"), "--auto"],
                   input=pl2, capture_output=True, text=True)
    check("no store built outside a git repo", not os.path.exists(os.path.join(norepo, ".cai-store")))
    shutil.rmtree(repo, ignore_errors=True); shutil.rmtree(norepo, ignore_errors=True)

    print("\n=== setup_global writes skill + hook into a temp home, keeps existing ===")
    home = tempfile.mkdtemp(prefix="kcai_home_")
    os.makedirs(os.path.join(home, ".claude"), exist_ok=True)
    with open(os.path.join(home, ".claude", "settings.json"), "w", encoding="utf-8") as f:
        json.dump({"model": "opus", "hooks": {"SessionStart": [{"matcher": ""}]}}, f)
    old = os.environ.get("USERPROFILE"), os.environ.get("HOME")
    try:
        os.environ["USERPROFILE"] = home; os.environ["HOME"] = home
        # expanduser caches nothing problematic; call through a subprocess-free path
        cai_install.setup_global()
        s = json.load(open(os.path.join(home, ".claude", "settings.json"), encoding="utf-8"))
        check("global skill written", os.path.exists(os.path.join(home, ".claude", "skills", "kerneta-cai", "SKILL.md")))
        post = s.get("hooks", {}).get("PostToolUse", [])
        check("global PostToolUse hook added", any("cai_hook_resolve.py" in h.get("command", "")
              for e in post for h in e.get("hooks", [])), post)
        check("existing SessionStart hook preserved", "SessionStart" in s.get("hooks", {}))
        check("unrelated key preserved", s.get("model") == "opus")
    finally:
        for k, v in (("USERPROFILE", old[0]), ("HOME", old[1])):
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(home, ignore_errors=True)
finally:
    shutil.rmtree(proj, ignore_errors=True)

print("\n=== RESULT: {} passed, {} failed ===".format(passed, failed))
sys.exit(1 if failed else 0)
