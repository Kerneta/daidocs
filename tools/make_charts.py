#!/usr/bin/env python3
# Chart generator. Every value is FILLED FROM tools/publish_run.mjs output after the release
# run; until then the guard refuses to run, so a chart can't disagree with a measurement
# (tools/check_numbers.mjs scans this file and the SVGs for unbacked figures). To fill: run
# the release run, then publish_run.mjs, then replace every FILL and set NUMBERS_SET = True.
# The look is chart_theme.py (the daidocs.com surface), not matplotlib's default.
NUMBERS_SET = True

import sys
if not NUMBERS_SET:
    sys.exit("make_charts: NUMBERS_SET is False. Fill the values from tools/publish_run.mjs output first (see RUNBOOK.md step 4).")

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import chart_theme as T

OUT = Path(__file__).resolve().parent.parent / "assets" / "charts"
OUT.mkdir(parents=True, exist_ok=True)

T.apply_rc()

# Values below are from tools/publish_run.mjs output for the release run.
# micro, 415/500
HEADLINE = 83.00
# Third-party figures are DATA, not chart constants: they load from
# tools/references.json, the single place published external scores live.
import json
REFS = json.load(open(Path(__file__).resolve().parent / "references.json", encoding="utf-8"))
BASELINE = REFS["full_context_baseline"]["score"]
# mean context tokens per question, from the run
TOKENS_READ = 10065
# mean full history, gpt-tokenizer@3.4.0
TOKENS_PASTED = 103601
CATEGORIES = [
    ("Single-session, user", 92.86),
    ("Single-session, assistant", 92.86),
    ("Temporal reasoning", 84.96),
    ("Knowledge update", 84.62),
    ("Preference", 76.67),
    ("Multi-session", 72.18),
]

# Five answering models over the identical memory layer, measured 2026-08-15.
# Values are transcribed from RESULTS-ACTORS.md, whose per-actor judge files
# sit in run-artifacts/. The gpt-4o row is the release run and equals HEADLINE.
ACTORS = [
    ("Claude Fable 5", 92.00),
    ("Claude Opus 5", 91.00),
    ("Claude Sonnet 5", 85.60),
    ("gpt-4o (release run)", HEADLINE),
    ("Claude Haiku 4.5", 78.00),
]

# Retrieval recall at fixed k is not typed here at all: it is read from the
# sweep's own machine-readable output so the chart cannot drift from it.
RECALL_JSON = Path(__file__).resolve().parent.parent / "experiments" / "recall-sweep" / "results" / "recall-at-k.json"

# The ranking, under the results page's stated rule: one setup (LongMemEval-S, gpt-4o, all
# 500, micro-averaged) and only reproducible configurations; systems that match the setup but
# not reproducibility are held out and reported separately (including the one that beats us).
# No figure is typed — ours is HEADLINE, the rest load from references.json. RANK_LABEL only
# shortens two display names (Mastra's full name doesn't fit; the baseline is labelled "no
# memory system", the comparison a reader most wants); figures and systems untouched.
RANK_LABEL = {
    "Mastra Observational Memory": "Mastra OM",
    "GPT-4o full context": "GPT-4o, no memory system",
}
RANKING = sorted(
    [(RANK_LABEL.get(r["system"], r["system"]), r["score"],
      "cool" if r["score"] > HEADLINE else "none") for r in REFS["leaderboard"]]
    + [(".dai v4.4n", HEADLINE, "aidoc")],
    key=lambda row: -row[1])


def barh(rows, path, title, sub=None, unit="%", foot=None, xmax=None,
         row_in=None, bar_frac=0.58, emphasize_top=0, top_frac=None, rest_frac=None):
    """Horizontal bars on the site's surface. `rows` is (label, value[, series-key]); the
    series key names a gradient in chart_theme.SERIES and defaults to "aidoc" (brand accent),
    since the bars are ours unless said otherwise."""
    n = len(rows)
    rh = T.ROW_IN if row_in is None else row_in
    fig_h = ((T.HEAD_SUB_IN if sub else T.HEAD_IN)
             + n * rh
             + (T.FOOT_IN if foot else T.FOOT_BARE_IN))
    fig = plt.figure(figsize=(9.6, fig_h))
    T.panel(fig)
    T.titles(fig, title, sub)

    bot, band = T.axes_band(fig, sub=bool(sub), foot=bool(foot))
    ax = fig.add_axes([0.235, bot, 0.735, band], zorder=2)
    ax.set_facecolor("none")

    labels = [r[0] for r in rows][::-1]
    vals = [r[1] for r in rows][::-1]
    series = [(r[2] if len(r) > 2 else "aidoc") for r in rows][::-1]

    span_hint = xmax if xmax is not None else max(vals) * 1.06
    hi = span_hint * 1.17
    ax.set_xlim(0, hi)
    ax.set_ylim(-0.5, n - 0.5)
    ax.set_yticks(range(n))
    ax.set_yticklabels(labels, fontsize=11.5, color=T.TEXT_2)
    ax.set_xticks([])
    for s in ax.spines.values():
        s.set_visible(False)
    ax.tick_params(length=0)

    # Draw once so get_window_extent is real: the rounded corners are computed
    # from the rendered pixel size of the axes, not from the data range.
    fig.canvas.draw()

    if emphasize_top and top_frac is not None and rest_frac is not None:
        heights = [(top_frac if i >= n - emphasize_top else rest_frac)
                   for i in range(n)]
    else:
        heights = [bar_frac] * n
    span = xmax if xmax is not None else max(vals) * 1.06
    gap = hi * 0.016

    # The chip sits inside the groove; its width depends on rendered font, so measure it (read
    # the boxes back in data units) and cut each groove to the widest chip plus the gap.
    chips = []
    for i, v in enumerate(vals):
        txt = f"{v:,.2f}%" if unit == "%" else f"{v:,.0f}"
        chips.append(T.value_chip(ax, v + gap, i, txt))
    fig.canvas.draw()
    inv = ax.transData.inverted()
    widest = max(inv.transform((c.get_bbox_patch().get_window_extent().x1, 0))[0]
                 for c in chips)
    end = max(span, widest + gap)
    # never let the groove touch the edge
    if end + gap > hi:
        hi = end + gap
        ax.set_xlim(0, hi)
        fig.canvas.draw()

    for i, (v, sk) in enumerate(zip(vals, series)):
        T.track(ax, 0, span, i, heights[i], end=end)
        T.gradient_bar(ax, v, i, heights[i], sk)

    if foot:
        T.footnote(fig, foot)
    for ext in ("svg", "png"):
        fig.savefig(OUT / f"{path}.{ext}")
    T.write_lf(OUT / f"{path}.svg")
    plt.close(fig)
    print(f"  wrote {path}.svg + .png")


print("generating charts from the published run")

barh([("Reading .dai", HEADLINE, "aidoc")],
     "headline", "LongMemEval-S accuracy, GPT-4o answering, official judge",
     sub="500 questions, micro-averaged, scored by the benchmark's own evaluate_qa.py",
     foot="one seed; binomial standard error at n=500 is about 1.7 points",
     xmax=100)

barh([("Reading .dai", TOKENS_READ, "aidoc"),
      ("Pasting the history", TOKENS_PASTED, "full")],
     "tokens", "Mean input tokens per question",
     sub="What the answering model is asked to read, per question",
     unit="", foot="gpt-tokenizer@3.4.0")

# No row gets the accent: highlighting the best would undercut "worst included", so all sit in steel.
if CATEGORIES:
    barh([(lbl, v, "cool") for lbl, v in CATEGORIES],
         "categories", "Accuracy by question type",
         sub="Every row from the release run, worst included",
         xmax=100, foot="the spread is the point: nothing here is omitted")

# The release-run row carries the accent; the other four sit in the cooler member of the same
# family (all five are the SAME memory layer, so a warm colour would misread as a rival).
barh(RANKING, "ranking", "Strict same-setup ranking on LongMemEval-S",
     sub="gpt-4o answering, all 500 questions, micro-averaged, reproducible configurations only",
     xmax=100, row_in=0.26, bar_frac=0.42,
     foot="caveats travel with the figures in docs/RESULTS.md; the systems this rule holds out are at daidocs.com/results.html")

barh([(lbl, v, "aidoc" if "release run" in lbl else "cool") for lbl, v in ACTORS],
     "actors", "Same stores, same prompts, same judge",
     sub="Five answering models over one identical memory layer (n=500)",
     xmax=100, row_in=0.30, bar_frac=0.48, foot="accent row = the release run")

# Recall@k line chart, straight from the sweep output.
if RECALL_JSON.exists():
    rk = json.load(open(RECALL_JSON, encoding="utf-8"))
    ks = sorted(int(k) for k in rk["content"].keys() if k.isdigit())

    def series(metric):
        return [rk[metric][str(k)]["overall"] for k in ks]

    fig = plt.figure(figsize=(9.6, 4.4))
    T.panel(fig)
    T.titles(fig, "Recall@k on LongMemEval-S",
             "500 questions, retrieval only: does the gold session get opened at all")
    ax = fig.add_axes([0.085, 0.165, 0.885, 0.655], zorder=2)
    ax.set_facecolor("none")

    for metric, colour, glow, marker, label in (
        ("content", T.MARK, "#2fe0a8", "o", "content recall"),
        ("pick", T.WARN, "#d3a24a", "s", "pick recall"),
    ):
        ys = series(metric)
        # The glow is drawn as three progressively wider, fainter copies of
        # the same line: the same device as the bars' halo, and the reason a
        # line on a dark panel reads as lit rather than as a hairline scratch.
        for width, alpha in ((9.0, 0.06), (5.5, 0.09), (3.0, 0.14)):
            ax.plot(ks, ys, color=glow, linewidth=width, alpha=alpha,
                    solid_capstyle="round", zorder=2)
        ax.plot(ks, ys, color=colour, linewidth=2.0, marker=marker,
                markersize=6.5, markerfacecolor=T.PANEL,
                markeredgecolor=colour, markeredgewidth=1.8,
                label=label, zorder=3)

    ax.set_ylim(80, 101)
    ax.set_xticks(ks)
    ax.set_xlabel("k (files opened per lookup read)", fontsize=10.5, color=T.MUTED)
    ax.set_ylabel("recall of gold session, %", fontsize=10.5, color=T.MUTED)
    ax.tick_params(labelsize=10, length=0, colors=T.MUTED)
    ax.grid(axis="y", color=T.GRIDLINE, linewidth=1.0, zorder=0)
    ax.set_axisbelow(True)
    for side, on in (("top", False), ("right", False), ("left", True), ("bottom", True)):
        ax.spines[side].set_visible(on)
        if on:
            ax.spines[side].set_color(T.HAIRLINE)
    leg = ax.legend(frameon=False, loc="lower right", fontsize=10.5)
    for t in leg.get_texts():
        t.set_color(T.TEXT_2)
    T.footnote(fig, "from experiments/recall-sweep/results/recall-at-k.json")
    for ext in ("svg", "png"):
        fig.savefig(OUT / f"recall.{ext}")
    T.write_lf(OUT / "recall.svg")
    plt.close(fig)
    print("  wrote recall.svg + .png")
print("done")
