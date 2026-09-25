"""Kerneta .cai incremental update + watch.

`update` detects which source files changed (by SHA1) and rebuilds the store when
anything changed, reporting added / changed / removed modules. `watch` polls a
directory and updates on change. Deterministic, no LLM.

Usage:
  python cai_update.py update <corpus_dir> <store>
  python cai_update.py watch  <corpus_dir> <store> [interval_seconds]
"""

import hashlib
import json
import os
import sys
import time

import cai_ts_extract

SHA_INDEX = ".cai-shas.json"
EXTS = set(cai_ts_extract.EXT.keys())


def _shas(corpus):
    out = {}
    for name in sorted(os.listdir(corpus)):
        if os.path.splitext(name)[1] in EXTS:
            data = open(os.path.join(corpus, name), "rb").read()
            out[name] = hashlib.sha1(data).hexdigest()[:12]
    return out


def _load_index(store):
    p = os.path.join(store, SHA_INDEX)
    if os.path.exists(p):
        return json.load(open(p, encoding="utf-8"))
    return {}


def update(corpus, store, quiet=False):
    old = _load_index(store)
    new = _shas(corpus)
    added = [f for f in new if f not in old]
    removed = [f for f in old if f not in new]
    changed = [f for f in new if f in old and new[f] != old[f]]
    dirty = bool(added or removed or changed)
    if dirty or not os.path.exists(os.path.join(store, "manifest.jsonl")):
        nfiles, nedges = cai_ts_extract.build(corpus, store)
        os.makedirs(store, exist_ok=True)
        json.dump(new, open(os.path.join(store, SHA_INDEX), "w", encoding="utf-8"))
        if not quiet:
            print("rebuilt: +{} added, ~{} changed, -{} removed  ({} files, {} edges)".format(
                len(added), len(changed), len(removed), nfiles, nedges))
            for f in added:
                print("  + {}".format(f))
            for f in changed:
                print("  ~ {}".format(f))
            for f in removed:
                print("  - {}".format(f))
    elif not quiet:
        print("up to date ({} files, no changes)".format(len(new)))
    return dirty


def watch(corpus, store, interval=2.0):
    print("watching {} every {}s (ctrl-c to stop)".format(corpus, interval))
    update(corpus, store)
    try:
        while True:
            time.sleep(interval)
            update(corpus, store)
    except KeyboardInterrupt:
        print("stopped")


if __name__ == "__main__":
    cmd, corpus, store = sys.argv[1], sys.argv[2], sys.argv[3]
    if cmd == "update":
        update(corpus, store)
    elif cmd == "watch":
        watch(corpus, store, float(sys.argv[4]) if len(sys.argv) > 4 else 2.0)
    else:
        print("unknown command:", cmd)
