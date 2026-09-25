"""Kerneta .cai router: classify a mixed corpus and route each file.

Mirrors Graphify's offline/LLM split:
  - code            -> .cai (tree-sitter, deterministic, offline)
  - structured data -> .cai data (SQL/Terraform/config/manifest, offline)
  - prose docs      -> .dai (DaiDocs), the plain-text prose memory
  - images          -> vision model (LLM required, same as Graphify)
  - audio / video   -> transcription model (local whisper)

`plan` prints the routing plan. `build` dispatches the deterministic routes
(code + data) into <store>/code and <store>/data and lists the model-routed files.

Usage:
  python cai_route.py plan  <dir>
  python cai_route.py build <dir> <store>
"""

import json
import os
import sys

import cai_ts_extract
import cai_data_extract

CODE_EXT = set(cai_ts_extract.EXT.keys())
DATA_EXT = {".sql", ".tf", ".hcl"}
DATA_NAMES = {"package.json", "tsconfig.json", "pyproject.toml", "cargo.toml", "go.mod"}
PROSE_EXT = {".md", ".mdx", ".txt", ".rst", ".pdf", ".docx", ".doc"}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}
AV_EXT = {".mp4", ".mov", ".webm", ".mp3", ".wav", ".m4a"}


def classify(name):
    low = name.lower()
    ext = os.path.splitext(low)[1]
    if low in DATA_NAMES or ext in DATA_EXT:
        return "data", ".cai-data (offline)"
    if ext in CODE_EXT:
        return "code", ".cai (offline)"
    if ext in PROSE_EXT:
        return "prose", ".dai / DaiDocs (offline extract)"
    if ext in IMAGE_EXT:
        return "image", "vision model (LLM)"
    if ext in AV_EXT:
        return "audiovideo", "transcription model (local whisper)"
    return "other", "skipped"


def plan(src):
    rows = []
    for name in sorted(os.listdir(src)):
        if os.path.isfile(os.path.join(src, name)):
            cat, target = classify(name)
            rows.append((name, cat, target))
    print("routing plan for {}".format(src))
    for name, cat, target in rows:
        print("  {:<22} {:<12} -> {}".format(name, cat, target))
    counts = {}
    for _, cat, _ in rows:
        counts[cat] = counts.get(cat, 0) + 1
    print("summary:", ", ".join("{} {}".format(v, k) for k, v in sorted(counts.items())))
    return rows


def build(src, store):
    rows = plan(src)
    os.makedirs(store, exist_ok=True)
    code_dir = os.path.join(src)   # extractors filter by extension themselves
    routed = {"code": [], "data": [], "prose": [], "image": [], "audiovideo": [], "other": []}
    for name, cat, _ in rows:
        routed[cat].append(name)

    if routed["code"]:
        cai_ts_extract.build(src, os.path.join(store, "code"))
    if routed["data"]:
        cai_data_extract.build(src, os.path.join(store, "data"))
    # prose + model routes are recorded, not processed here (deterministic layer only)
    manifest = {
        "deterministic": {"code": routed["code"], "data": routed["data"]},
        "needs_daidocs": routed["prose"],
        "needs_model": {"images": routed["image"], "audiovideo": routed["audiovideo"]},
        "skipped": routed["other"],
    }
    with open(os.path.join(store, "routing.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    print("\ndispatched: {} code + {} data files into {}".format(
        len(routed["code"]), len(routed["data"]), store))
    print("recorded for DaiDocs (.dai): {}".format(routed["prose"] or "none"))
    print("recorded for a model: {} images, {} audio/video".format(
        len(routed["image"]), len(routed["audiovideo"])))
    return manifest


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "plan":
        plan(sys.argv[2])
    elif cmd == "build":
        build(sys.argv[2], sys.argv[3])
    else:
        print("unknown command:", cmd)
