"""Parse a single DaiDocs (.dai) document into its three parts.

A .dai file has three parts, in order:

1. YAML frontmatter between ``---`` fences at the top (id, type, title, lang,
   source, span, messages, class, summary, tags, raw, extracted_by). Some
   values are inline JSON objects or arrays, which YAML parses natively.
2. A fenced JSON block under a ``# Understanding`` heading (the extraction).
3. Text segments under ``# Content``, each headed ``## [seg n/N]``.

This module does the parsing and nothing else: no disk walking, no ranking,
no engine behaviour. See the normative format in spec/DAIDOCS-STANDARD.md.
"""

import json
import re

try:
    import yaml
except ImportError:  # pragma: no cover - guarded so the error is actionable
    yaml = None

_FRONTMATTER_RE = re.compile(r"^---[ \t]*\n(.*?)\n---[ \t]*\n?", re.DOTALL)
_JSON_FENCE_RE = re.compile(r"```json[ \t]*\n(.*?)\n```", re.DOTALL)
_SEG_RE = re.compile(r"^##[ \t]*\[seg[ \t]+(\d+)[ \t]*/[ \t]*(\d+)\][ \t]*$", re.MULTILINE)


def _require_yaml():
    if yaml is None:
        raise RuntimeError(
            "pyyaml is required to parse .dai frontmatter. Install it with "
            "`pip install pyyaml`."
        )


def parse_frontmatter(text):
    """Return (header_dict, body_text).

    If the text has no ``---`` frontmatter, returns ({}, text) unchanged.
    """
    match = _FRONTMATTER_RE.match(text)
    if not match:
        return {}, text
    _require_yaml()
    header = yaml.safe_load(match.group(1)) or {}
    if not isinstance(header, dict):
        header = {}
    return header, text[match.end():]


def parse_understanding(body):
    """Return the parsed JSON of the ``# Understanding`` block, or None."""
    idx = body.find("# Understanding")
    area = body[idx:] if idx != -1 else body
    match = _JSON_FENCE_RE.search(area)
    if not match:
        return None
    try:
        return json.loads(match.group(1))
    except json.JSONDecodeError:
        return None


def parse_segments(body):
    """Return the ``## [seg n/N]`` blocks under ``# Content`` as a list of dicts.

    Each dict has ``n`` (int), ``total`` (int) and ``text`` (str).
    """
    idx = body.find("# Content")
    area = body[idx:] if idx != -1 else body
    matches = list(_SEG_RE.finditer(area))
    segments = []
    for i, match in enumerate(matches):
        start = match.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(area)
        segments.append(
            {
                "n": int(match.group(1)),
                "total": int(match.group(2)),
                "text": area[start:end].strip(),
            }
        )
    return segments


def parse_dai(text):
    """Parse a full .dai document string into its three parts.

    Returns a dict with keys ``header``, ``understanding`` and ``segments``.
    """
    header, body = parse_frontmatter(text)
    return {
        "header": header,
        "understanding": parse_understanding(body),
        "segments": parse_segments(body),
    }
