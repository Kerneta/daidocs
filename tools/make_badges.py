#!/usr/bin/env python3
"""The README badges, as local SVG files rather than img.shields.io URLs, so they render
offline, in mirrors and in Markdown previews, don't break when shields is slow, and don't
tell a third party who is reading the page. The one badge that must stay live is CI status
(its point is to change): a URL when the repo is public, absent otherwise. Geometry is
shields' "flat" style: 20px tall, 3px radius, grey left half, coloured right, 11px text."""

from pathlib import Path
from xml.sax.saxutils import escape

OUT = Path(__file__).resolve().parent.parent / "assets" / "badges"
OUT.mkdir(parents=True, exist_ok=True)

LEFT_BG = "#555555"

# Verdana at 11px, the face shields measures against. Full metrics would need
# the font; these cover what the badges actually contain and are within a pixel
# or two, which is all the layout needs.
WIDE = "ABCDEFGHKLMNOPQRSTUVWXYZmw%"
NARROW = "iljtfrI.,:;'!|"


def text_width(s):
    w = 0.0
    for ch in s:
        if ch in NARROW:
            w += 3.6
        elif ch in WIDE or ch.isupper():
            w += 7.9
        elif ch == " ":
            w += 3.9
        elif ch.isdigit():
            w += 7.0
        else:
            w += 6.4
    return w


def badge(label, message, colour, name):
    lw = text_width(label) + 20
    rw = text_width(message) + 20
    total = lw + rw
    lt, rt = escape(label), escape(message)
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="{total:.0f}" height="20" role="img" aria-label="{lt}: {rt}">
  <title>{lt}: {rt}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="{total:.0f}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="{lw:.0f}" height="20" fill="{LEFT_BG}"/>
    <rect x="{lw:.0f}" width="{rw:.0f}" height="20" fill="{colour}"/>
    <rect width="{total:.0f}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110">
    <text aria-hidden="true" x="{lw * 5:.0f}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="{(lw - 20) * 10:.0f}">{lt}</text>
    <text x="{lw * 5:.0f}" y="140" transform="scale(.1)" textLength="{(lw - 20) * 10:.0f}">{lt}</text>
    <text aria-hidden="true" x="{(lw + rw / 2) * 10:.0f}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="{(rw - 20) * 10:.0f}">{rt}</text>
    <text x="{(lw + rw / 2) * 10:.0f}" y="140" transform="scale(.1)" textLength="{(rw - 20) * 10:.0f}">{rt}</text>
  </g>
</svg>
'''
    # newline is pinned so a badge written on Windows still matches
    # .gitattributes and the hash MANIFEST.sha256 records; see
    # chart_theme.write_lf for the same reason on the charts.
    (OUT / f"{name}.svg").write_text(svg, encoding="utf-8", newline=chr(10))
    print(f"  {name}.svg  {total:.0f}x20  {label} | {message}")


# The colours are the brand's own, not shields' defaults: --accent for anything
# that is a fact about the project, --accent2 for a requirement, the MCP purple
# already used across the docs.
ACCENT = "#4ade87"
ACCENT2 = "#38bdf8"
MCP = "#8b5cf6"

badge("licence", "Apache-2.0", ACCENT, "licence")
badge("node", "18+", ACCENT2, "node")
badge("MCP", "server included", MCP, "mcp")
badge("LongMemEval-S", "83.00% gpt-4o", ACCENT, "lme-gpt4o")
badge("LongMemEval-S", "92.00% Claude Fable 5", ACCENT, "lme-fable")
badge("checks", "offline, no API key", ACCENT2, "checks")
print("done")
