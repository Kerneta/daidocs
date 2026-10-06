"""`kerneta` command line: one entry point over the whole engine.

After `pip install kerneta`, this console script drives every tier from the interpreter
pip installed into (the one that has the tree-sitter grammars), so nothing hard-codes a
python path. It locates the installed engine and runs each tool with that directory on
sys.path, so the engine's flat intra-imports keep working.

  kerneta setup <project_dir> --corpus <code_dir> [--docs <docs_dir>] [--store <dir>]
                      make .cai automatic in a project (skill + PostToolUse hook + build)
  kerneta build  <corpus> <store>              build a code store
  kerneta update <corpus> <store> [--quiet]    incremental rebuild
  kerneta watch  <corpus> <store> [interval]   rebuild on change
  kerneta query  <store> <op> [args...]        code graph query (callers, callees, ...)
  kerneta ask    <combined_store> <question>   router over code / docs / history
  kerneta history <dai_store> <question>       answer from past sessions
  kerneta doctor                               check the install (grammars + interpreter)
"""

import os
import runpy
import sys


def _engine_dir():
    try:
        import kerneta_engine  # installed package (engine/ shipped as kerneta_engine)
        return os.path.dirname(os.path.abspath(kerneta_engine.__file__))
    except Exception:
        # running from a source checkout
        return os.path.join(os.path.dirname(os.path.abspath(__file__)), "engine")


# subcommand -> (engine script, tokens injected before the user's args)
SCRIPTS = {
    "build":   ("cai_ts_extract.py", []),
    "update":  ("cai_update.py", ["update"]),
    "watch":   ("cai_update.py", ["watch"]),
    "query":   ("cai_query.py", []),
    "combined": ("combined_query.py", []),
    "history": ("dai_history.py", []),
    "setup":   ("cai_install.py", ["setup"]),
    "skill":   ("cai_install.py", ["skill"]),
    "hook":    ("cai_install.py", ["hook"]),
}


def _doctor():
    eng = _engine_dir()
    print("kerneta doctor")
    print("  interpreter : {}".format(sys.executable))
    print("  engine      : {}".format(eng))
    sys.path.insert(0, eng)
    ok = True
    try:
        import cai_ts_extract  # imports every grammar
        print("  grammars    : OK ({} languages)".format(len(cai_ts_extract.LANGS)))
    except Exception as e:
        ok = False
        print("  grammars    : MISSING ({})".format(e))
        print("                run: pip install kerneta   (installs the tree-sitter grammars)")
    # stdlib tiers always available
    print("  doc tier    : OK (dai_lite, stdlib)")
    print("  history tier: OK (dai_history, stdlib)")
    print("  status      : {}".format("ready" if ok else "code tier unavailable"))
    return 0 if ok else 1


def main():
    argv = sys.argv[1:]
    if not argv or argv[0] in ("-h", "--help", "help"):
        print(__doc__)
        return 0
    cmd, rest = argv[0], argv[1:]
    if cmd == "doctor":
        return _doctor()
    if cmd == "ask":
        # convenience: kerneta ask <store> <question...> -> combined_query <store> ask <q>
        if len(rest) < 2:
            print("usage: kerneta ask <combined_store> <question>")
            return 2
        script, injected, rest = "combined_query.py", [], [rest[0], "ask"] + rest[1:]
    elif cmd in SCRIPTS:
        script, injected = SCRIPTS[cmd]
    else:
        print("unknown command: {}\n".format(cmd) + __doc__)
        return 2
    eng = _engine_dir()
    path = os.path.join(eng, script)
    sys.argv = [path] + injected + rest
    runpy.run_path(path, run_name="__main__")
    return 0


if __name__ == "__main__":
    sys.exit(main())
