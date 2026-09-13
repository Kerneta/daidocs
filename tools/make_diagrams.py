#!/usr/bin/env python3
"""The explainer diagrams, on the same surface as the benchmark charts: lifecycle (what
happens to a session), zones (inside one .dai), zooms (the three reading depths), folder-types
(the seven types), where-memory (which folder a memory lands in). No release-run guard — these
describe how the system works, not how well it scored. Run with `npm run diagrams`."""

import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

sys.path.insert(0, str(Path(__file__).resolve().parent))
import chart_theme as T
import diagram_kit as K

OUT = Path(__file__).resolve().parent.parent / "assets" / "diagrams"
OUT.mkdir(parents=True, exist_ok=True)
T.apply_rc()


def save(fig, name):
    for ext in ("svg", "png"):
        fig.savefig(OUT / f"{name}.{ext}")
    T.write_lf(OUT / f"{name}.svg")
    plt.close(fig)
    print(f"  wrote {name}.svg + .png")


# 1. the lifecycle. The common worry: "if I close the terminal, is that session lost?" It is
# not, and this is the picture that says so.

fig, ax = K.canvas(
    11.4, 5.0,
    "What happens to a session",
    "Nothing is ever discarded. A session too small to convert waits in _unconverted, is read in next time, and converts when it is worth a memory.",
    foot="the threshold is 4,000 NEW tokens since the last save, not the size of the whole session",
)

K.card(ax, 2, 62, 21, 26, "You work", [
    "a normal session,", "in any folder"], accent=T.ACCENT2)

K.card(ax, 29, 62, 22, 26, "Every stop", [
    "the Stop hook asks:", "enough new to save?"], accent=T.ACCENT2)

K.chip(ax, 62.5, 82, "4,000 new tokens?", T.WARN, size=9.2, pad=0.5)

K.card(ax, 74, 66, 24, 22, "Converted now", [
    "one .dai + index rows", "free, no API key"], accent=T.ACCENT, glow=True)

K.card(ax, 74, 22, 24, 26, "Held, not lost", [
    "_unconverted/  the tail", "_pending/  a marker"], accent=T.WARN)

K.card(ax, 29, 18, 22, 26, "Next session", [
    "reads the tail in", "and carries on"], accent=T.ACCENT2)

K.card(ax, 2, 18, 21, 26, "Or later", [
    "npm run catch-up,", "or the dashboard"], accent=T.ACCENT2)

K.arrow(ax, (23, 75), (29, 75))
K.arrow(ax, (51, 75), (56.5, 79))
K.arrow(ax, (69, 84), (74, 79), label="yes", label_dy=4.2, colour="#3f7d5c")
K.arrow(ax, (66, 76), (76, 49), label="no", curve=-0.18, label_dy=2.6, colour="#7a6234")
K.arrow(ax, (74, 33), (51, 31), label="reopened", dashed=True)
K.arrow(ax, (12.5, 44), (30, 66), curve=-0.30, colour="#3f7d5c")
K.note(ax, 26, 52, "converted when you choose, into the same store", size=8.4)

K.note(ax, 2, 8,
       "Closing the terminal changes nothing: the marker is on disk. "
       "Reopen the folder and the session continues from where it stopped.",
       colour=T.TEXT_2, size=9)
save(fig, "lifecycle")


# 2. inside a .dai file
fig, ax = K.canvas(
    11.4, 4.6,
    "What is inside one .dai file",
    "Three zones, in one plain-text file you can open in any editor, plus a pointer to the untouched original.",
    foot="the three zones are defined in spec/DAIDOCS-STANDARD.md",
)

K.card(ax, 2, 58, 30, 32, "--- frontmatter ---", [
    "id, title, date, type", "raw: _raw/<id>", "daidocs: format marker"], accent=T.ACCENT2)

K.card(ax, 35, 58, 30, 32, "# Understanding", [
    "one JSON block:", "facts, events, topics,", "entities, decisions"], accent=T.ACCENT, glow=True)

K.card(ax, 68, 58, 30, 32, "# Content", [
    "## [seg 1/N] ...", "the conversation,", "verbatim, in segments"], accent=T.ACCENT2)

K.note(ax, 2, 47, "Alongside it, written once per store:", colour=T.TEXT_2, size=9)

for i, (name, what) in enumerate([
    ("_index/manifest.jsonl", "one line per file"),
    ("_index/facts.jsonl", "every dated fact"),
    ("_index/events.jsonl", "one row per occurrence"),
    ("_index/profile.jsonl", "stated preferences"),
]):
    x = 2 + i * 24.3
    K.card(ax, x, 20, 22.5, 22, name, [what], accent="#2b8ba6",
           title_size=8.8, body_size=8.2, dim=True)

K.note(ax, 2, 9,
       "_raw/ keeps the original text exactly as it arrived, before any model saw it. "
       "If an extraction ever looks wrong, that is what it was made from.",
       colour=T.TEXT_2, size=9)
save(fig, "zones")


# 3. the three zooms
fig, ax = K.canvas(
    11.4, 4.6,
    "The three zooms",
    "Stop at the shallowest depth that answers the question. Reading whole files is the default failure mode.",
    foot="measured on a 50-session store: a recall costs about 5.3K tokens, the whole store is 188K",
)

# The failure mode is on the chart because the three zooms mean nothing
# without it: they are only impressive next to what they replace.
rows = [
    (None, "Reading every file whole", "the default failure mode, and what the zooms exist to avoid", "full", 100),
    (1, "manifest.jsonl", "id, title, date, summary and topics for every file", "aidoc", 11),
    (2, "frontmatter + # Understanding", "the extraction, for the 1 to 3 files that matched", "cool", 3),
    (3, "## [seg n/N], by number", "exact wording, only when the Understanding omits it", "cool", 0.8),
]
for i, (n, name, what, series, w) in enumerate(rows):
    y = 72 - i * 21
    if n:
        K.chip(ax, 4.5, y + 6, f"zoom {n}", T.ACCENT if n == 1 else "#3b9fc4", size=9)
    else:
        K.chip(ax, 4.5, y + 6, "avoid", T.WARN, size=9)
    ax.text(10, y + 10.5, name, ha="left", va="center", fontsize=10.5,
            fontweight=600, color=T.TEXT_HI if n else T.WARN, zorder=6)
    ax.text(10, y + 3, what, ha="left", va="center", fontsize=8.6,
            color=T.MUTED, zorder=6)
    T.track(ax, 60, 97, y + 6, 8)
    T.gradient_bar(ax, 60 + 37 * max(w, 0.8) / 100, y + 6, 8, series, base=60)

K.note(ax, 60, 90, "relative size of one read", colour=T.MUTED, size=8.4)
K.note(ax, 2, 4,
       "Every question is classified first: lookup, timeline, tally or advice. "
       "Misrouting between those was the single largest source of accuracy loss during development.",
       colour=T.TEXT_2, size=9)
save(fig, "zooms")


# 4. the folder types
fig, ax = K.canvas(
    11.4, 5.4,
    "The seven folder types",
    "What a folder is decides what happens to its memory. Set it once; the dashboard or one sentence in a session changes it.",
    foot="node daidocs.js setup --project-type <type>   ·   or ask in a session, which is the shortest route",
)

types = [
    ("normal", "the default", ["writable, readable,", "nothing special"]),
    ("locked", "read-only", ["existing memory stays,", "no new writes"]),
    ("frozen", "read-only for good", ["a finished project", "kept for reference"]),
    ("connected", "reads a sibling", ["can pull context from", "another declared folder"]),
    ("shared", "readable by others", ["for a folder more than", "one person works in"]),
    ("confidential", "never leaves", ["excluded from every", "wider or parent read"]),
    ("temporary", "expected to go", ["a spike; deleting the", "folder deletes its memory"]),
]
for i, (name, tag, lines) in enumerate(types):
    col = K.TYPE[name]
    x = 2 + (i % 4) * 24.4
    y = 60 - (i // 4) * 31
    K.card(ax, x, y, 22.6, 27, name, [tag] + lines, accent=col,
           title_size=10.5, body_size=8.2)

K.note(ax, 51, 12,
       "A type is not a permission system: it is what YOUR machine and YOUR\n"
       "assistant do with the folder. Locking uses the operating system's own\n"
       "read-only flags, so an accidental save fails loudly rather than quietly.",
       colour=T.TEXT_2, size=8.8)
save(fig, "folder-types")


# 5. where memory lands
fig, ax = K.canvas(
    11.4, 4.8,
    "Where a memory lands",
    "In the folder the session was in. Declare a folder and its memory lives inside it, travelling with the code.",
    foot="node daidocs.js stores   lists every declared store, and finds one that has moved",
)

K.card(ax, 2, 60, 30, 30, "atlas-api/", [
    ".daidocs/store/", "13 memories"], accent=K.TYPE["normal"], glow=True)
K.card(ax, 36, 62, 27, 26, "services/auth-service/", [
    ".daidocs/store/", "locked"], accent=K.TYPE["locked"], title_size=9.4)
K.card(ax, 67, 62, 31, 26, "services/billing/", [
    ".daidocs/store/", "confidential"], accent=K.TYPE["confidential"], title_size=9.4)

K.arrow(ax, (32, 70), (36, 70), label="part of", label_dy=-5.5)
K.arrow(ax, (63, 70), (67, 70), label="part of", label_dy=-5.5)

K.note(ax, 30, 51, "The parent can read its parts. A confidential part is the exception: it is never included.",
       colour=T.TEXT_2, size=9)

K.card(ax, 2, 16, 44, 26, "~/DaiDocs/  (the shared store)", [
    "where every session lands until a folder is declared", "nothing is lost by not declaring: it is just shared"],
    accent="#7fd1b9", title_size=10, body_size=8.4, mono_body=False)

K.card(ax, 52, 16, 46, 26, "~/.daidocs/stores.json  (the registry)", [
    "one permanent id per store: 20260907T110856-atlas-api", "moved a folder? the id finds it again"],
    accent="#2b8ba6", title_size=10, body_size=8.4, mono_body=False)

K.arrow(ax, (14, 60), (14, 43), dashed=True, label="until\ndeclared", label_dy=0, curve=0.0)
save(fig, "where-memory")

print("done")
