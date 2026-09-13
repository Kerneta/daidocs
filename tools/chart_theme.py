#!/usr/bin/env python3
"""The daidocs.com chart surface, ported to matplotlib so the README/RESULTS charts match
the site (palette from theme.css, bar treatment from fx-2040.css). Adds what plain matplotlib
lacks: a dark panel that reads on both GitHub themes, gradient fills, a lit top edge and outer
glow, value chips, and a measured track. Two things the browser does for free and this fakes:
corner radii (matplotlib rounds in data units, so rounded_path uses separate x/y radii for a
circular corner at any axis scale) and blur (glow = three fainter wider copies; lit edge = a
clipped alpha ramp). Fonts can't be matched (the brand woff2s aren't readable), so the stacks
fall through to DejaVu silently."""

import logging

import numpy as np
import matplotlib as mpl
from matplotlib.path import Path
from matplotlib.patches import PathPatch, FancyBboxPatch
from matplotlib.colors import to_rgb

# The font stack below is a deliberate fallback chain, not a mistake, so the
# per-glyph "font family not found" chatter is noise on every build.
logging.getLogger("matplotlib.font_manager").setLevel(logging.ERROR)

# transcribed from daidocs-site/assets/theme.css :root
BG        = "#05070a"   # --bg
PANEL     = "#0d1117"   # --surface-solid
TRACK     = "#161a20"   # --track (rgba(255,255,255,.05)) flattened onto PANEL
TEXT      = "#d5e0d8"   # --text
TEXT_HI   = "#f2f7f3"   # --text-hi
TEXT_2    = "#b4c2b8"   # --text-2
MUTED     = "#7f9188"   # --muted
HAIRLINE  = "#22272e"   # --hairline  (rgba(255,255,255,.09)) flattened
GRIDLINE  = "#171b21"   # --grid-line (rgba(255,255,255,.035)) flattened
QUARTER   = "#2c333c"   # .bar-track::before, the quarter measure lines
ACCENT    = "#4ade87"   # --accent
ACCENT2   = "#38bdf8"   # --accent2
WARN      = "#d3a24a"   # --warn
MARK      = "#2fe0a8"   # brand mark mint, from the icon set

# Series gradients, transcribed stop for stop from fx-2040.css. `glow` is the
# outer box-shadow colour on that rule.
SERIES = {
    # .s-aidoc: ours. Brand accent, and the glow that reads as "this is the
    # good one" before the label is read.
    "aidoc": {"stops": [(0.00, "#2fe0a8"), (0.38, "#4ade87"), (1.00, "#38bdf8")],
              "glow": "#4ade87", "glow_alpha": 0.38},
    # .s-full: the comparison arm. Warm, so length reads as cost.
    "full":  {"stops": [(0.00, "#f7a13c"), (0.45, "#ef7a2b"), (1.00, "#d9432c")],
              "glow": "#e9762e", "glow_alpha": 0.26},
    "live":  {"stops": [(0.00, "#34d399"), (1.00, "#14b8a6")],
              "glow": "#2dd4bf", "glow_alpha": 0.26},
    "rival": {"stops": [(0.00, "#b79cff"), (1.00, "#7c5cf0")],
              "glow": "#947aff", "glow_alpha": 0.26},
    "none":  {"stops": [(0.00, "#7b8494"), (1.00, "#4b5563")],
              "glow": None, "glow_alpha": 0.0},
    # A cooler member of the same family, for rows that are ours but are not
    # the row being pointed at. Same hue family as .s-aidoc so it never reads
    # as a different arm of the comparison.
    "cool":  {"stops": [(0.00, "#1c6f8c"), (1.00, "#3b9fc4")],
              "glow": "#38bdf8", "glow_alpha": 0.14},
}

SANS = ["Plus Jakarta Sans", "Plus Jakarta Sans Variable", "Segoe UI",
        "Helvetica Neue", "Arial", "DejaVu Sans"]
MONO = ["Commit Mono", "Cascadia Code", "Consolas", "SF Mono",
        "DejaVu Sans Mono"]


def apply_rc():
    """Set the global rcParams. Call once, before any figure is made."""
    mpl.rcParams.update({
        "figure.facecolor": BG,
        "savefig.facecolor": BG,
        "axes.facecolor": "none",
        "font.family": "sans-serif",
        "font.sans-serif": SANS,
        "text.color": TEXT,
        "axes.labelcolor": TEXT_2,
        "xtick.color": MUTED,
        "ytick.color": TEXT_2,
        "axes.edgecolor": HAIRLINE,
        "figure.dpi": 160,
        "savefig.dpi": 160,
        # keep text as text, so the SVG stays greppable
        "svg.fonttype": "none",
    })


# circle-to-bezier constant
K = 0.5523


def rounded_path(x0, y0, w, h, rx, ry):
    """A rounded rectangle with independent x and y corner radii.

    Independent rx/ry (set from each axis's pixels-per-unit) keep the corner a
    true circle on the rendered image even when the two axes are on very
    different scales.
    """
    rx = min(rx, w / 2.0)
    ry = min(ry, h / 2.0)
    x1, y1 = x0 + w, y0 + h
    verts = [
        (x0 + rx, y0),                                        # bottom edge
        (x1 - rx, y0),
        (x1 - rx + rx * K, y0), (x1, y0 + ry - ry * K), (x1, y0 + ry),
        (x1, y1 - ry),                                        # right edge
        (x1, y1 - ry + ry * K), (x1 - rx + rx * K, y1), (x1 - rx, y1),
        (x0 + rx, y1),                                        # top edge
        (x0 + rx - rx * K, y1), (x0, y1 - ry + ry * K), (x0, y1 - ry),
        (x0, y0 + ry),                                        # left edge
        (x0, y0 + ry - ry * K), (x0 + rx - rx * K, y0), (x0 + rx, y0),
        (x0 + rx, y0),
    ]
    codes = [Path.MOVETO, Path.LINETO,
             Path.CURVE4, Path.CURVE4, Path.CURVE4, Path.LINETO,
             Path.CURVE4, Path.CURVE4, Path.CURVE4, Path.LINETO,
             Path.CURVE4, Path.CURVE4, Path.CURVE4, Path.LINETO,
             Path.CURVE4, Path.CURVE4, Path.CURVE4, Path.CLOSEPOLY]
    return Path(verts, codes)


def px_per_data(ax):
    """(x, y) pixels per data unit on the rendered axes."""
    bb = ax.get_window_extent()
    xr = ax.get_xlim()[1] - ax.get_xlim()[0]
    yr = ax.get_ylim()[1] - ax.get_ylim()[0]
    return (bb.width / xr if xr else 1.0), (bb.height / yr if yr else 1.0)


def _rr(ax, x0, y0, w, h, radius_px, **kw):
    """A PathPatch rounded by `radius_px` PIXELS, in data coordinates."""
    px, py = px_per_data(ax)
    return PathPatch(rounded_path(x0, y0, w, h, radius_px / px, radius_px / py),
                     transform=ax.transData, **kw)


def panel(fig):
    """The card the chart sits on: --surface-solid with a hairline edge."""
    p = FancyBboxPatch(
        (0.006, 0.012), 0.988, 0.976,
        boxstyle="round,pad=0,rounding_size=0.013",
        transform=fig.transFigure,
        mutation_aspect=fig.get_figwidth() / fig.get_figheight(),
        facecolor=PANEL, edgecolor=HAIRLINE, linewidth=1.0, zorder=0,
    )
    fig.patches.append(p)
    # The accent seam along the top of the card: the same device as .honesty
    # on the site, a 1px rule fading out to the right.
    seam = np.zeros((1, 256, 4))
    seam[0, :, :3] = to_rgb(ACCENT)
    seam[0, :, 3] = np.clip(np.linspace(0.9, 0.0, 256) ** 1.5, 0, 1)
    ax = fig.add_axes([0.006, 0.9835, 0.988, 0.005], zorder=1)
    ax.imshow(seam, aspect="auto", interpolation="bilinear")
    ax.set_axis_off()


# Header/footer heights in INCHES, not figure fractions: a fraction would put the subtitle on
# the title in a short chart and leave a hole in a tall one. Vertical offsets below are inches
# divided by the figure height at use.
HEAD_IN      = 0.62   # title only
HEAD_SUB_IN  = 0.94   # title + subtitle
FOOT_IN      = 0.48   # with a footnote
FOOT_BARE_IN = 0.26   # without
ROW_IN       = 0.64   # one bar row


def figure_height(n_rows, sub=False, foot=False):
    """Total height in inches for a bar chart of n_rows."""
    return ((HEAD_SUB_IN if sub else HEAD_IN)
            + n_rows * ROW_IN
            + (FOOT_IN if foot else FOOT_BARE_IN))


def axes_band(fig, sub=False, foot=False):
    """(bottom, height) in figure fractions for the plotting area."""
    h = fig.get_figheight()
    top = 1.0 - (HEAD_SUB_IN if sub else HEAD_IN) / h
    bot = (FOOT_IN if foot else FOOT_BARE_IN) / h
    return bot, top - bot


def titles(fig, title, sub=None):
    """Title and subtitle in the site's .viz-title / .viz-sub sizes."""
    h = fig.get_figheight()
    fig.text(0.028, 1.0 - 0.26 / h, title, ha="left", va="top",
             fontsize=14, fontweight=600, color=TEXT_HI)
    if sub:
        fig.text(0.028, 1.0 - 0.56 / h, sub, ha="left", va="top",
                 fontsize=10.5, color=MUTED)


def footnote(fig, text):
    """The .viz-foot line: a muted note under a hairline."""
    h = fig.get_figheight()
    fig.text(0.028, 0.17 / h, text, ha="left", va="bottom",
             fontsize=8.5, color=MUTED, family=MONO)


def _ramp(stops, n=512):
    """An n-wide RGB strip from CSS-style (position, colour) stops."""
    pos = np.array([s[0] for s in stops], dtype=float)
    cols = np.array([to_rgb(s[1]) for s in stops], dtype=float)
    x = np.linspace(0.0, 1.0, n)
    out = np.empty((1, n, 3))
    for c in range(3):
        out[0, :, c] = np.interp(x, pos, cols[:, c])
    return out


def track(ax, x0, x1, y, height, quarters=True, zorder=1, end=None):
    """.bar-track: the recessed groove a bar sits in, with measure lines.

    `x1` is where the SCALE ends: the quarter lines are measured against it.
    `end` is where the groove itself stops, which is further right whenever the
    value chip sits past the scale. A chip half on the groove and half on the
    panel behind it reads as an accident, so the groove is cut to hold it while
    the measure lines keep meaning 25, 50 and 75 per cent.
    """
    px, py = px_per_data(ax)
    r_px = height * py * 0.34
    y0 = y - height / 2.0
    x_end = x1 if end is None else end
    groove = _rr(ax, x0, y0, x_end - x0, height, r_px,
                 facecolor=TRACK, edgecolor=HAIRLINE, linewidth=0.9,
                 zorder=zorder)
    ax.add_patch(groove)
    if quarters:
        # Inset by a hair top and bottom so a line never lands on the groove's
        # own rounded edge, which is what clipping to the groove would cost.
        inset = height * 0.12
        for q in (0.25, 0.50, 0.75):
            xq = x0 + (x1 - x0) * q
            ax.plot([xq, xq], [y0 + inset, y0 + height - inset],
                    color=QUARTER, linewidth=0.9, zorder=zorder + 0.4,
                    solid_capstyle="butt")


def gradient_bar(ax, value, y, height, series, base=0.0, zorder=3):
    """One bar with the site's fill: gradient, lit top edge, outer glow."""
    spec = SERIES[series]
    px, py = px_per_data(ax)
    y0 = y - height / 2.0
    w = value - base
    if w <= 0:
        return
    # fx-2040: 8px radius on a 26px fill
    r_px = height * py * 0.30

    # Outer glow. No blur on this backend, so three progressively wider and
    # fainter copies stand in for one soft halo.
    if spec["glow"]:
        for grow, alpha in ((3.2, 0.09), (2.0, 0.13), (1.0, 0.18)):
            pad_px = 2.6 * grow
            ax.add_patch(_rr(
                ax, base - pad_px / px, y0 - pad_px / py,
                w + 2 * pad_px / px, height + 2 * pad_px / py, r_px + pad_px,
                facecolor=spec["glow"], edgecolor="none",
                alpha=alpha * (spec["glow_alpha"] / 0.38), zorder=zorder - 1,
            ))

    clip = _rr(ax, base, y0, w, height, r_px,
               facecolor="none", edgecolor="none", zorder=zorder)
    ax.add_patch(clip)

    im = ax.imshow(_ramp(spec["stops"]), extent=[base, value, y0, y0 + height],
                   aspect="auto", interpolation="bilinear", zorder=zorder)
    im.set_clip_path(clip)

    # .bar-fill::before, the lit top edge: white at the top falling to nothing
    # over the upper 45% of the bar. imshow puts row 0 at the top, so the ramp
    # runs bright to clear in that order.
    lit = np.ones((64, 1, 4))
    lit[:, 0, 3] = np.linspace(0.24, 0.0, 64)
    im2 = ax.imshow(lit, extent=[base, value, y0 + height * 0.55, y0 + height],
                    aspect="auto", interpolation="bilinear", zorder=zorder + 1)
    im2.set_clip_path(clip)


def write_lf(path):
    """Rewrite a just-saved SVG with LF line endings: matplotlib writes CRLF on Windows, but
    .gitattributes says LF, so an untouched chart would otherwise fail `npm run verify`
    against MANIFEST.sha256."""
    with open(path, "rb") as f:
        raw = f.read()
    with open(path, "wb") as f:
        f.write(raw.replace(b"\r\n", b"\n"))


def value_chip(ax, x, y, text, inside=False):
    """.bar-val: the number as a chip, not as loose text."""
    if inside:
        return ax.text(x, y, text, va="center", ha="right", fontsize=10.5,
                       fontweight=600, color="#ffffff", family=MONO, zorder=6)
    return ax.text(
        x, y, text, va="center", ha="left", fontsize=10.5, fontweight=600,
        color=TEXT_HI, family=MONO, zorder=6,
        bbox=dict(boxstyle="round,pad=0.36", facecolor=BG, edgecolor=HAIRLINE,
                  linewidth=0.9, alpha=0.94),
    )
