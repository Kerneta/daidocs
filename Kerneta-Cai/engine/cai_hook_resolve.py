"""Global PostToolUse resolver: refresh the current project's .cai store after an edit.

Installed once by `kerneta setup --global` into ~/.claude/settings.json, it runs after
every Edit/Write in every project. It is deliberately cheap and silent:

  1. read the hook payload on stdin, get the edited file path
  2. walk up from that file for a `.cai-store/.kerneta.json` marker (written by
     `kerneta init`). If none, exit immediately - no heavy imports, no tokens, a
     fast no-op in projects that never opted in.
  3. only when a store is found, import the extractor and run an incremental update
     of just that project's store.

It never blocks or fails a tool call: any error exits 0. It emits no model tokens
(stdout is irrelevant to the agent; we keep it quiet).
"""

import json
import os
import sys

MARKER = ".kerneta.json"       # lives inside the store dir
STORE_DIR = ".cai-store"


def _edited_path(payload):
    """Pull the edited file path out of the PostToolUse payload (several shapes)."""
    for key in ("tool_input", "toolInput", "input", "params"):
        ti = payload.get(key)
        if isinstance(ti, dict):
            for fk in ("file_path", "filePath", "path", "notebook_path"):
                if ti.get(fk):
                    return ti[fk]
    # some payloads put it at top level
    for fk in ("file_path", "filePath", "path"):
        if payload.get(fk):
            return payload[fk]
    return None


def _find_marker(start):
    """Walk up from the edited file's directory for <dir>/.cai-store/.kerneta.json."""
    d = os.path.dirname(os.path.abspath(start))
    prev = None
    while d and d != prev:
        cand = os.path.join(d, STORE_DIR, MARKER)
        if os.path.exists(cand):
            return cand
        prev, d = d, os.path.dirname(d)
    return None


MAX_AUTO_FILES = 4000   # do not auto-index a repo larger than this; init it by hand


def _git_root(start):
    """Nearest ancestor containing .git, within a few levels; else None."""
    d = os.path.dirname(os.path.abspath(start))
    prev = None
    while d and d != prev:
        if os.path.isdir(os.path.join(d, ".git")):
            return d
        prev, d = d, os.path.dirname(d)
    return None


def _auto_init(edited_file):
    """Zero-touch: on the first code edit in a real git repo, build a store + marker so
    the agent can query it with no `kerneta init`. Guardrails keep it from indexing junk:
    code files only, inside a git repo, not a home/drive root, under a size cap."""
    import cai_ts_extract
    if os.path.splitext(edited_file)[1] not in cai_ts_extract.EXT:
        return  # not a source file
    root = _git_root(edited_file)
    if not root:
        return  # loose files outside a repo: do not index
    home = os.path.abspath(os.path.expanduser("~"))
    if os.path.abspath(root) in (home, os.path.dirname(root)) or len(os.path.normpath(root).split(os.sep)) < 3:
        return  # home dir / drive root: skip
    n = 0
    for _ in cai_ts_extract.discover(root):
        n += 1
        if n > MAX_AUTO_FILES:
            return  # too big to auto-index; leave it to a manual `kerneta init`
    if n == 0:
        return  # no indexable code
    store = os.path.join(root, STORE_DIR)
    import cai_update
    cai_update.update(root, store, quiet=True)
    os.makedirs(store, exist_ok=True)
    with open(os.path.join(store, MARKER), "w", encoding="utf-8") as f:
        json.dump({"corpus": root, "store": store, "python": sys.executable, "auto": True}, f, indent=2)


def main():
    try:
        raw = sys.stdin.read() if not sys.stdin.isatty() else ""
        payload = json.loads(raw) if raw.strip() else {}
    except Exception:
        return 0
    fp = _edited_path(payload) or os.environ.get("CLAUDE_FILE_PATH")
    if not fp:
        return 0
    marker = _find_marker(fp)
    if not marker:
        # zero-touch: if the hook was installed with --auto, build a store on the first
        # code edit in a real git repo (guarded). Otherwise a fast no-op.
        if "--auto" in sys.argv:
            sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
            try:
                _auto_init(fp)
            except Exception:
                pass
        return 0
    try:
        cfg = json.load(open(marker, encoding="utf-8"))
        corpus, store = cfg.get("corpus"), cfg.get("store")
        if not corpus or not store:
            return 0
        # only now pull in the heavy extractor
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import cai_update
        cai_update.update(corpus, store, quiet=True)
    except Exception:
        return 0  # never break the edit
    return 0


if __name__ == "__main__":
    sys.exit(main())
