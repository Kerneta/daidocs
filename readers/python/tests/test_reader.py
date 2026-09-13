"""Tests for the daidocs reader. Each test builds a tiny store fixture in a temp dir.
Run with `python tests/test_reader.py` or `python -m unittest`."""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

# Make the package importable when run directly from the package root.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from daidocs import Store, __version__, parse_dai  # noqa: E402

SAMPLE_DAI = '''---
daidocs: "4.4"
id: "chat_test_0001"
type: "chat"
title: "Test chat about deploys"
lang: "en"
source: {"app": "claude-code", "native_id": "cc_test_0001"}
span: null
messages: 1
class: {"category": "general", "priority": "normal"}
summary: "A tiny test document about a deploy."
tags: ["technology.coding", "test.fixture"]
raw: "_raw/chat_test_0001"
extracted_by: "test"
---

# Understanding
```json
{
 "entities": {"people": ["Sam"], "orgs": [], "dates": ["2026-01-01"], "amounts": [], "places": []},
 "actions": ["shipped the deploy"],
 "facts": [{"fact": "the deploy shipped on 2026-01-01", "date": "2026-01-01", "kind": "event"}],
 "topics": ["deploy", "testing"],
 "summary": "A tiny test document about a deploy.",
 "sentiment": "neutral"
}
```

# Content

## [seg 1/1]
[USER]: did the deploy ship? [ASSISTANT]: yes, it shipped on 2026-01-01.
'''

MANIFEST_ROW = {
    "id": "chat_test_0001",
    "path": "chat_test_0001.dai",
    "type": "chat",
    "title": "Test chat about deploys",
    "date": "2026-01-01",
    "summary": "A tiny test document about a deploy.",
    "topics": ["deploy", "testing"],
    "entities": ["Sam"],
    "tags": ["technology.coding", "test.fixture"],
}


def _build_store(root):
    root = Path(root)
    (root / "_index").mkdir(parents=True, exist_ok=True)
    (root / "chat_test_0001.dai").write_text(SAMPLE_DAI, encoding="utf-8")
    (root / "_index" / "manifest.jsonl").write_text(
        json.dumps(MANIFEST_ROW) + "\n", encoding="utf-8"
    )
    (root / "_index" / "facts.jsonl").write_text(
        json.dumps(
            {"date": "2026-01-01", "fact": "the deploy shipped on 2026-01-01",
             "kind": "event", "src": "chat_test_0001"}
        )
        + "\n",
        encoding="utf-8",
    )
    return Store(root)


class TestParse(unittest.TestCase):
    def test_three_parts_parse(self):
        parsed = parse_dai(SAMPLE_DAI)
        # 1. frontmatter
        self.assertEqual(parsed["header"]["id"], "chat_test_0001")
        self.assertEqual(parsed["header"]["daidocs"], "4.4")
        self.assertEqual(parsed["header"]["tags"], ["technology.coding", "test.fixture"])
        # inline JSON object in the YAML frontmatter parses to a dict
        self.assertEqual(parsed["header"]["source"]["app"], "claude-code")
        # 2. understanding JSON block
        self.assertIsNotNone(parsed["understanding"])
        self.assertEqual(parsed["understanding"]["topics"], ["deploy", "testing"])
        self.assertEqual(parsed["understanding"]["facts"][0]["kind"], "event")
        # 3. content segments
        self.assertEqual(len(parsed["segments"]), 1)
        self.assertEqual(parsed["segments"][0]["n"], 1)
        self.assertEqual(parsed["segments"][0]["total"], 1)
        self.assertIn("did the deploy ship", parsed["segments"][0]["text"])

    def test_no_frontmatter_is_tolerated(self):
        parsed = parse_dai("just some text, no fences")
        self.assertEqual(parsed["header"], {})
        self.assertIsNone(parsed["understanding"])
        self.assertEqual(parsed["segments"], [])


class TestStore(unittest.TestCase):
    def test_manifest_read_and_indexes(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _build_store(tmp)
            self.assertTrue(store.exists())
            manifest = store.manifest()
            self.assertEqual(len(manifest), 1)
            self.assertEqual(manifest[0]["id"], "chat_test_0001")
            self.assertEqual(store.ids(), ["chat_test_0001"])
            self.assertEqual(len(store.facts()), 1)
            # file absent -> empty
            self.assertEqual(store.events(), [])
            self.assertEqual(store.profile(), [])

    def test_read_by_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _build_store(tmp)
            doc = store.read("chat_test_0001")
            self.assertEqual(doc["id"], "chat_test_0001")
            self.assertEqual(doc["header"]["title"], "Test chat about deploys")
            self.assertEqual(doc["understanding"]["summary"],
                             "A tiny test document about a deploy.")
            self.assertEqual(len(doc["segments"]), 1)
            self.assertTrue(doc["raw"].startswith("---"))

    def test_read_missing_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _build_store(tmp)
            with self.assertRaises(FileNotFoundError):
                store.read("does_not_exist")

    def test_search(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = _build_store(tmp)
            self.assertEqual(len(store.search("deploy")), 1)
            # case-insensitive
            self.assertEqual(len(store.search("DEPLOY")), 1)
            self.assertEqual(len(store.search("nonexistent-term")), 0)


class TestVersion(unittest.TestCase):
    def test_version_string(self):
        self.assertEqual(__version__, "0.1.1")


class TestCli(unittest.TestCase):
    def test_refuses_without_node(self):
        import daidocs.cli as cli
        from unittest import mock

        # No Node on PATH: check_node() is False and main() exits non-zero.
        with mock.patch.object(cli.shutil, "which", return_value=None):
            self.assertFalse(cli.check_node())
            self.assertEqual(cli.main([]), 1)

    def test_refuses_old_node(self):
        import daidocs.cli as cli
        from unittest import mock

        # Node present but too old: still refused.
        with mock.patch.object(cli, "_node_major", return_value=16), \
             mock.patch.object(cli.shutil, "which", return_value="npx"):
            self.assertFalse(cli.check_node())

    def test_forwards_with_pip_surface_tag(self):
        import daidocs.cli as cli
        from unittest import mock

        # Node present: main() forwards to npx and tags the surface as "pip"
        # so the engine's install ping counts it distinctly, not as npm.
        with mock.patch.object(cli, "check_node", return_value=True), \
             mock.patch.object(cli.shutil, "which", return_value="npx"), \
             mock.patch.object(cli.subprocess, "call", return_value=0) as call:
            rc = cli.main(["setup"])
        self.assertEqual(rc, 0)
        _, kwargs = call.call_args
        self.assertEqual(kwargs["env"]["DAIDOCS_SURFACE"], "pip")


if __name__ == "__main__":
    unittest.main(verbosity=2)
