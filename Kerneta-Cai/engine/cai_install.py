"""Kerneta .cai installers: agent skill + git / Claude Code hooks.

  skill <out_dir>   write a SKILL.md describing the .cai commands (install-as-skill)
  hook  <repo_dir>  write a git pre-commit hook that runs `cai update`
  setup <project_dir> --corpus <dir> [--store <dir>] [--python <path>]
                    make .cai automatic in Claude Code: install the skill, add a
                    PostToolUse hook that refreshes the store after every Edit/Write,
                    and build the store once. This is the recommended default: Claude
                    then queries .cai instead of reading files (fewer tokens) and the
                    store stays current with no manual step.

Deterministic, no LLM.
"""

import json
import os
import sys
import stat

SKILL_MD = """---
name: kerneta-cai
description: Query a plain-text .cai code-memory store: callers, callees, imports, defines, transitive deps, paths, analysis, and exports.
---

# Kerneta .cai

A deterministic, plain-text code-memory store. Build it, then query it instead of
re-reading source files.

## Build / update
- `python cai_ts_extract.py <corpus> <store>` build a store (10 languages)
- `python cai_update.py update <corpus> <store>` incremental rebuild on change

## Query (cai_query.py <store> <op> [args])
- `ask "<question>"` natural language, mapped to an op
- `callers <sym>` / `callees <sym>` reverse / forward calls
- `imports <mod>` / `defines <sym>` / `tdeps <mod>` / `path <a> <b>` / `most_imported`

## Analyze (cai_analyze.py <store> <cmd>)
- `god-nodes` / `cycles` / `communities` / `dedup` / `diagnose` / `suggest` / `surprising`

## Export (cai_export.py <store> <fmt>)
- `mermaid` / `dot` / `graphml` / `obsidian <dir>` / `html` / `svg` / `tree` / `cypher`

Always prefer a query slice over loading raw files: it is far fewer tokens.
"""

HOOK_SH = """#!/bin/sh
# Kerneta .cai pre-commit hook: refresh the code-memory store on changed files.
python "%s/cai_update.py" update . .cai-store >/dev/null 2>&1 || true
exit 0
"""


def install_skill(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    p = os.path.join(out_dir, "SKILL.md")
    with open(p, "w", encoding="utf-8") as f:
        f.write(SKILL_MD)
    return "wrote skill to {}".format(p)


def install_hook(repo_dir):
    hooks = os.path.join(repo_dir, ".git", "hooks")
    if not os.path.isdir(os.path.join(repo_dir, ".git")):
        os.makedirs(hooks, exist_ok=True)  # allow non-git dirs for testing
    os.makedirs(hooks, exist_ok=True)
    engine = os.path.dirname(os.path.abspath(__file__))
    p = os.path.join(hooks, "pre-commit")
    with open(p, "w", encoding="utf-8", newline="\n") as f:
        f.write(HOOK_SH % engine.replace("\\", "/"))
    try:
        os.chmod(p, os.stat(p).st_mode | stat.S_IEXEC)
    except OSError:
        pass
    return "wrote git pre-commit hook to {}".format(p)


PROJECT_SKILL = """---
name: kerneta-cai
description: Query this project's plain-text .cai code-memory store instead of reading source files, to answer questions about code with far fewer tokens.
---

# Kerneta .cai (this project)

A deterministic, plain-text code-memory store for this project is kept fresh
automatically after every edit. Before reading a source file to understand the code,
query the store: a slice is a tiny fraction of the tokens of the raw file.

Store:   `{store}`
Engine:  `{engine}`
Python:  `{python}`

## Query (run from anywhere)
Code graph and history, in one router (routes code vs past-session questions):
- `"{python}" "{engine}/combined_query.py" "{store}" ask "<question>"`
- code ops: `"{python}" "{engine}/cai_query.py" "{store}" callers <sym>`
  (also `callees` / `imports <mod>` / `defines <sym>` / `tdeps <mod>` / `why <sym>`)
- past sessions: `"{python}" "{engine}/combined_query.py" "{store}" history "<question>"`
- documents (if a combined store was built): `combined_query.py "{store_combined}" docs_for <sym>`

Always prefer a query slice over loading the raw file. The store is refreshed by a
PostToolUse hook, so it reflects the latest edits.
"""

# One PostToolUse hook entry. {cmd} refreshes the store incrementally after an edit.
def _hook_entry(cmd):
    return {"matcher": "Edit|Write|MultiEdit",
            "hooks": [{"type": "command", "command": cmd}]}


def _merge_settings(settings_path, cmd):
    data = {}
    if os.path.exists(settings_path):
        try:
            data = json.load(open(settings_path, encoding="utf-8"))
        except Exception:
            data = {}
    hooks = data.setdefault("hooks", {})
    post = hooks.setdefault("PostToolUse", [])
    # idempotent: skip if an entry with this exact command already exists
    for entry in post:
        for h in entry.get("hooks", []):
            if h.get("command") == cmd:
                return False
    post.append(_hook_entry(cmd))
    os.makedirs(os.path.dirname(settings_path), exist_ok=True)
    with open(settings_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    return True


def _find_history(project_dir):
    """Discover a DaiDocs .dai session store near the project (for the history tier)."""
    import dai_history
    here = os.path.abspath(project_dir)
    for base in (here, os.path.dirname(here), os.path.dirname(os.path.dirname(here))):
        cand = os.path.join(base, ".daidocs", "store")
        if dai_history.is_history_store(cand):
            return os.path.normpath(cand)
    return None


def setup(project_dir, corpus, store=None, python=None):
    engine = os.path.dirname(os.path.abspath(__file__))
    python = os.path.abspath(python) if python else sys.executable
    corpus = os.path.abspath(corpus)
    store = os.path.abspath(store) if store else os.path.join(os.path.abspath(project_dir), ".cai-store")
    store_combined = os.path.join(os.path.dirname(store), "store-combined")
    out = []

    # 1. build the store once (so queries work immediately)
    sys.path.insert(0, engine)
    import cai_update
    cai_update.update(corpus, store, quiet=True)
    out.append("built store: {}".format(store))

    # 1b. link a DaiDocs session-history store if one is near the project, so `ask`
    # covers history out of the box (capturing sessions stays the DaiDocs product's job)
    hist = _find_history(project_dir)
    if hist:
        with open(os.path.join(store, "history.json"), "w", encoding="utf-8") as f:
            json.dump({"dai_store": hist}, f, indent=2)
        out.append("linked history store: {}".format(hist))
    else:
        out.append("history: no .dai store found yet (install DaiDocs capture and it auto-links)")

    # 2. install the project skill so Claude queries the store by default
    skill_dir = os.path.join(project_dir, ".claude", "skills", "kerneta-cai")
    os.makedirs(skill_dir, exist_ok=True)
    body = PROJECT_SKILL.format(store=store.replace("\\", "/"),
                                store_combined=store_combined.replace("\\", "/"),
                                engine=engine.replace("\\", "/"),
                                python=python.replace("\\", "/"))
    with open(os.path.join(skill_dir, "SKILL.md"), "w", encoding="utf-8") as f:
        f.write(body)
    out.append("installed skill: {}".format(os.path.join(skill_dir, "SKILL.md")))

    # 3. add the PostToolUse auto-refresh hook to the project's Claude Code settings
    cmd = '"{}" "{}/cai_update.py" update "{}" "{}" --quiet'.format(
        python.replace("\\", "/"), engine.replace("\\", "/"),
        corpus.replace("\\", "/"), store.replace("\\", "/"))
    settings = os.path.join(project_dir, ".claude", "settings.json")
    added = _merge_settings(settings, cmd)
    out.append(("added PostToolUse hook to {}" if added
                else "PostToolUse hook already present in {}").format(settings))
    out.append("\n.cai is now automatic for this project: Claude queries it (skill) and\n"
               "it refreshes after every edit (PostToolUse hook).")
    return "\n".join(out)


GLOBAL_SKILL = """---
name: kerneta-cai
description: In any project that has a .cai code store, query it for code questions (callers, callees, definitions, impact, why) instead of reading whole source files, to answer with far fewer tokens.
---

# Kerneta .cai (global)

Many of this user's projects carry a plain-text `.cai` code-memory store at
`<project>/.cai-store`, kept fresh automatically after every edit. When a project has
one, prefer querying it over reading source files: a query slice is a tiny fraction of
the tokens.

## Use it when a `.cai-store` exists in the project
- `kerneta ask ./.cai-store "<question>"`   (router over code, and history if linked)
- `kerneta query ./.cai-store callers <sym>`   (also callees / imports / defines / tdeps)
- `kerneta query ./.cai-store why <sym>` / `kerneta history ./.cai-store "<question>"`

If the project has no store yet and it is worth indexing, build one once with
`kerneta init .` (then the global auto-refresh hook keeps it current). If `kerneta` is
not on PATH, call the engine scripts with the project's Python directly.

Prefer a query slice over loading a raw file whenever the store can answer.
"""


def init(project, corpus=None, store=None, python=None):
    """Opt a single project in: build its store once and drop a marker the global
    auto-refresh hook reads. Writes no per-project skill or hook (those are global)."""
    engine = os.path.dirname(os.path.abspath(__file__))
    project = os.path.abspath(project)
    corpus = os.path.abspath(corpus) if corpus else project
    store = os.path.abspath(store) if store else os.path.join(project, ".cai-store")
    python = os.path.abspath(python) if python else sys.executable
    out = []
    sys.path.insert(0, engine)
    import cai_update
    cai_update.update(corpus, store, quiet=True)
    os.makedirs(store, exist_ok=True)
    with open(os.path.join(store, ".kerneta.json"), "w", encoding="utf-8") as f:
        json.dump({"corpus": corpus, "store": store, "python": python}, f, indent=2)
    out.append("built + marked store: {}".format(store))
    hist = _find_history(project)
    if hist:
        with open(os.path.join(store, "history.json"), "w", encoding="utf-8") as f:
            json.dump({"dai_store": hist}, f, indent=2)
        out.append("linked history store: {}".format(hist))
    out.append("project opted in; the global hook will keep this store fresh after edits.")
    return "\n".join(out)


def setup_global(python=None, auto=False):
    """Install the skill + auto-refresh hook at the USER level (~/.claude) so .cai
    loads in every project automatically. With auto=True the hook also builds a store
    on the first code edit in a git repo (zero-touch, no `init` needed); otherwise a
    repo is opted in once with `kerneta init`."""
    engine = os.path.dirname(os.path.abspath(__file__))
    python = os.path.abspath(python) if python else sys.executable
    home_claude = os.path.join(os.path.expanduser("~"), ".claude")
    out = []
    skill_dir = os.path.join(home_claude, "skills", "kerneta-cai")
    os.makedirs(skill_dir, exist_ok=True)
    with open(os.path.join(skill_dir, "SKILL.md"), "w", encoding="utf-8") as f:
        f.write(GLOBAL_SKILL)
    out.append("installed global skill: {}".format(os.path.join(skill_dir, "SKILL.md")))
    cmd = '"{}" "{}/cai_hook_resolve.py"{}'.format(
        python.replace("\\", "/"), engine.replace("\\", "/"), " --auto" if auto else "")
    settings = os.path.join(home_claude, "settings.json")
    added = _merge_settings(settings, cmd)
    out.append(("added global PostToolUse hook to {}" if added
                else "global PostToolUse hook already present in {}").format(settings))
    out.append("\n.cai now loads in every project." + (
        " With --auto, a store builds itself on the first code edit in a git repo (no init needed)."
        if auto else " Index a project once with `kerneta init .`; the hook keeps it fresh after edits."))
    return "\n".join(out)


def _opt(args, name, default=None):
    return args[args.index(name) + 1] if name in args else default


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "skill":
        print(install_skill(sys.argv[2]))
    elif cmd == "hook":
        print(install_hook(sys.argv[2]))
    elif cmd == "init":
        a = sys.argv[2:]
        print(init(a[0] if a and not a[0].startswith("--") else ".",
                   _opt(a, "--corpus"), _opt(a, "--store"), _opt(a, "--python")))
    elif cmd == "setup":
        a = sys.argv[2:]
        if "--global" in a:
            print(setup_global(_opt(a, "--python"), auto=("--auto" in a)))
        else:
            corpus = _opt(a, "--corpus")
            if not corpus:
                print("usage: setup <project_dir> --corpus <dir> [--store <dir>] [--python <path>]")
                print("   or: setup --global [--python <path>]")
                sys.exit(2)
            print(setup(a[0], corpus, _opt(a, "--store"), _opt(a, "--python")))
    else:
        print("unknown command:", cmd)
