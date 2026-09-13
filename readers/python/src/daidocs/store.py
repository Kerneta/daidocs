"""Read a DaiDocs (.dai) memory store from Python.

A store is a folder of ``*.dai`` files plus an ``_index/`` holding
``manifest.jsonl`` (one JSON object per file) and, where present,
``facts.jsonl``, ``events.jsonl`` and ``profile.jsonl`` (one JSON object per
line each).

This is a plain reader. It does not reimplement the retrieval engine, the
observer, embeddings or scoring. ``search`` is a simple substring filter over
the manifest, nothing more.
"""

import json
import os
from pathlib import Path

from . import parse as _parse


def _read_jsonl(path):
    rows = []
    if not path.exists():
        return rows
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                # A malformed line is skipped rather than failing the whole read.
                continue
    return rows


class Store:
    """A DaiDocs store rooted at a folder.

    >>> s = Store("~/DaiDocs")
    >>> s.manifest()            # list of manifest entries (dicts)
    >>> s.read("chat_2026...")  # dict: header, understanding, segments, raw
    >>> s.facts(); s.events(); s.profile()
    >>> s.search("deploy")      # substring filter over the manifest
    """

    def __init__(self, root):
        self.root = Path(os.path.expanduser(str(root))).resolve()
        self.index_dir = self.root / "_index"

    def __repr__(self):
        return "Store(%r)" % str(self.root)

    def exists(self):
        """True if the store root is a directory that exists."""
        return self.root.is_dir()

    def manifest(self):
        """The manifest as a list of dicts (one per .dai file)."""
        return _read_jsonl(self.index_dir / "manifest.jsonl")

    def facts(self):
        """Parsed rows of _index/facts.jsonl (empty list if absent)."""
        return _read_jsonl(self.index_dir / "facts.jsonl")

    def events(self):
        """Parsed rows of _index/events.jsonl (empty list if absent)."""
        return _read_jsonl(self.index_dir / "events.jsonl")

    def profile(self):
        """Parsed rows of _index/profile.jsonl (empty list if absent)."""
        return _read_jsonl(self.index_dir / "profile.jsonl")

    def ids(self):
        """List of document ids from the manifest."""
        return [entry["id"] for entry in self.manifest() if entry.get("id")]

    def _resolve_path(self, doc_id):
        doc_id = str(doc_id)
        for entry in self.manifest():
            if entry.get("id") == doc_id or entry.get("path") == doc_id:
                rel = entry.get("path") or (doc_id + ".dai")
                return self.root / rel
        name = doc_id if doc_id.endswith(".dai") else doc_id + ".dai"
        return self.root / name

    def read(self, doc_id):
        """Read and parse one .dai file by its id (or path, or filename).

        Returns a dict with ``id``, ``path``, ``header``, ``understanding``,
        ``segments`` and ``raw`` (the full original file text).
        """
        path = self._resolve_path(doc_id)
        if not path.exists():
            raise FileNotFoundError(
                "no .dai file for %r in %s (looked at %s)"
                % (doc_id, self.root, path)
            )
        text = path.read_text(encoding="utf-8")
        parsed = _parse.parse_dai(text)
        parsed["id"] = parsed["header"].get("id", str(doc_id))
        parsed["path"] = str(path)
        parsed["raw"] = text
        return parsed

    def search(self, query, limit=None):
        """Substring filter over manifest id, title, summary, topics,
        entities and tags. Case-insensitive. Returns matching manifest dicts.
        """
        needle = str(query).lower()
        hits = []
        for entry in self.manifest():
            parts = [str(entry.get(key, "")) for key in ("id", "title", "summary")]
            for key in ("topics", "entities", "tags", "attrs"):
                value = entry.get(key) or []
                if isinstance(value, (list, tuple)):
                    parts.extend(str(item) for item in value)
                else:
                    parts.append(str(value))
            if needle in " ".join(parts).lower():
                hits.append(entry)
        if limit is not None:
            hits = hits[:limit]
        return hits
