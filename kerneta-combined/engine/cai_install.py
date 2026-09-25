"""Kerneta .cai installers: agent skill + git pre-commit hook.

  skill <out_dir>   write a SKILL.md describing the .cai commands (install-as-skill)
  hook  <repo_dir>  write a git pre-commit hook that runs `cai update`

Deterministic, no LLM.
"""

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


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "skill":
        print(install_skill(sys.argv[2]))
    elif cmd == "hook":
        print(install_hook(sys.argv[2]))
    else:
        print("unknown command:", cmd)
