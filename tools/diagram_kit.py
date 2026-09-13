#!/usr/bin/env python3
"""A small drawing vocabulary for the explainer diagrams, built on chart_theme.py so the
diagrams and benchmark charts share one look (same panel, hairlines, accent). Laid out in a
fixed 100 x 100 space, so positions read as percentages."""

import numpy as np
from matplotlib.patches import PathPatch, FancyArrowPatch
from matplotlib.colors import to_rgb

import chart_theme as T

# Type colours, matching the folder icons and the dashboard's --t-* tokens
# exactly. A locked folder is amber in Explorer, amber in the dashboard and
# amber here, or the colour is teaching the reader nothing.
TYPE = {
    "normal":       "#4fd0e8",
    "locked":       "#d3a24a",
    "frozen":       "#8fb6d9",
    "connected":    "#4ade87",
    "shared":       "#7fd1b9",
    "confidential": "#e0765a",
    "temporary":    "#9a8fd9",
}


def canvas(fig_w, fig_h, title, sub=None, foot=None):
    """A panel with a 100 x 100 axes on it. Returns (fig, ax)."""
    import matplotlib.pyplot as plt
    fig = plt.figure(figsize=(fig_w, fig_h))
    T.panel(fig)
    T.titles(fig, title, sub)
    if foot:
        T.footnote(fig, foot)
    h = fig.get_figheight()
    top = 1.0 - (T.HEAD_SUB_IN if sub else T.HEAD_IN) / h
    bot = (T.FOOT_IN if foot else T.FOOT_BARE_IN) / h
    ax = fig.add_axes([0.022, bot, 0.956, top - bot], zorder=2)
    ax.set_xlim(0, 100)
    ax.set_ylim(0, 100)
    ax.set_facecolor("none")
    ax.set_xticks([])
    ax.set_yticks([])
    for s in ax.spines.values():
        s.set_visible(False)
    fig.canvas.draw()
    return fig, ax


def _rr(ax, x, y, w, h, radius_px, **kw):
    px, py = T.px_per_data(ax)
    return PathPatch(T.rounded_path(x, y, w, h, radius_px / px, radius_px / py),
                     transform=ax.transData, **kw)


def card(ax, x, y, w, h, title, lines=(), accent=None, glow=False,
         title_size=10.5, body_size=8.6, dim=False, mono_body=True):
    """One box: a rounded panel, a coloured left rule, a title and body lines.

    The left rule rather than a coloured fill: a filled card at this size
    swamps its own text, and the rule still identifies the card at a glance.
    """
    col = accent or T.ACCENT
    face = "#10161d" if not dim else "#0b1015"
    if glow:
        for grow, alpha in ((3.0, 0.10), (1.8, 0.14), (0.9, 0.18)):
            pad = 2.4 * grow
            px, py = T.px_per_data(ax)
            ax.add_patch(_rr(ax, x - pad / px, y - pad / py,
                             w + 2 * pad / px, h + 2 * pad / py, 9 + pad,
                             facecolor=col, edgecolor="none", alpha=alpha, zorder=2))
    ax.add_patch(_rr(ax, x, y, w, h, 9, facecolor=face,
                     edgecolor=col if glow else T.HAIRLINE,
                     linewidth=1.1, zorder=3))
    # the left rule
    ax.add_patch(_rr(ax, x + w * 0.018, y + h * 0.14, w * 0.012, h * 0.72, 3,
                     facecolor=col, edgecolor="none", zorder=4))

    tx = x + w * 0.075
    ax.text(tx, y + h - h * 0.24, title, ha="left", va="center",
            fontsize=title_size, fontweight=600,
            color=T.TEXT_HI if not dim else T.TEXT_2, zorder=5)
    for i, ln in enumerate(lines):
        ax.text(tx, y + h - h * 0.24 - (i + 1) * (h * 0.185), ln,
                ha="left", va="center", fontsize=body_size, color=T.MUTED,
                family=T.MONO if mono_body else None, zorder=5)


def chip(ax, x, y, text, colour=None, size=8.2, pad=0.34):
    """A small labelled pill, for a value or a state."""
    col = colour or T.ACCENT
    return ax.text(x, y, text, ha="center", va="center", fontsize=size,
                   fontweight=600, color=col, family=T.MONO, zorder=6,
                   bbox=dict(boxstyle=f"round,pad={pad}", facecolor=T.BG,
                             edgecolor=col, linewidth=0.9, alpha=0.95))


def arrow(ax, xy_from, xy_to, colour=None, label=None, curve=0.0,
          style="-|>", width=1.6, label_dy=3.0, dashed=False):
    """A connector. Curved when two boxes are not on the same line."""
    col = colour or T.HAIRLINE_ARROW
    ax.add_patch(FancyArrowPatch(
        xy_from, xy_to, transform=ax.transData,
        arrowstyle=style, mutation_scale=11,
        connectionstyle=f"arc3,rad={curve}",
        linewidth=width, color=col, zorder=4,
        linestyle=(0, (4, 3)) if dashed else "solid",
        shrinkA=2, shrinkB=3,
    ))
    if label:
        mx = (xy_from[0] + xy_to[0]) / 2
        my = (xy_from[1] + xy_to[1]) / 2 + label_dy
        ax.text(mx, my, label, ha="center", va="center", fontsize=8,
                color=T.MUTED, family=T.MONO, zorder=6,
                bbox=dict(boxstyle="round,pad=0.26", facecolor=T.PANEL,
                          edgecolor="none", alpha=0.92))


def band(ax, x, y, w, h, series, label=None, value=None):
    """A proportional band, for showing how a file or a budget divides up."""
    T.gradient_bar(ax, x + w, y + h / 2, h, series, base=x)
    if label:
        ax.text(x + w / 2, y + h / 2, label, ha="center", va="center",
                fontsize=8.6, fontweight=700, color="#04160c", zorder=7)
    if value:
        ax.text(x + w / 2, y - 3.4, value, ha="center", va="top",
                fontsize=8.2, color=T.MUTED, family=T.MONO, zorder=6)


def note(ax, x, y, text, colour=None, size=8.6, ha="left"):
    """A muted aside, for the sentence a box cannot hold."""
    ax.text(x, y, text, ha=ha, va="center", fontsize=size,
            color=colour or T.MUTED, zorder=6)


def rule(ax, x0, x1, y, colour=None):
    ax.plot([x0, x1], [y, y], color=colour or T.HAIRLINE, linewidth=1.0, zorder=2)


# A slightly lighter hairline for arrows: the panel hairline disappears against
# the card edges it has to travel between.
T.HAIRLINE_ARROW = "#3c4652"
