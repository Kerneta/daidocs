# daidocs (Python)

A pure-Python reader for DaiDocs `.dai` memory stores, plus a small `daidocs`
command that forwards to the Node engine.

DaiDocs is an open plain-text format for AI memory. A store is a folder of
`.dai` files plus an `_index/`. This package gives Python code a way to read
that store. It does not reimplement the engine that writes stores: writing,
extraction, embeddings and ranking stay in the Node project.

## Requirements

- Python 3.8+
- **Node 18 or newer (required).** DaiDocs is a Node project; this package
  drives that engine. If Node is missing when you first run `daidocs`, the
  command tells you it is required and offers to install it for you (via your OS
  package manager, such as `winget` on Windows, after you confirm). You can also
  install Node (LTS) yourself from https://nodejs.org/ . The full setup needs a
  system Node, because Claude Code and Claude Desktop launch it themselves.

Verify Node with:

```
node --version
```

## Install

```
pip install daidocs
```

This pulls in `pyyaml`. Node is a separate prerequisite (see Requirements): the
`daidocs` command drives the published npm engine via `npx`, so Node must be
present for setup, convert, capture and the MCP server.

## Reader (pure Python)

```python
from daidocs import Store

store = Store("~/DaiDocs")        # a store folder, or a project folder

store.manifest()                  # list of manifest entries (dicts)
store.read("chat_20260807_d1dd87da")
                                  # dict: id, path, header, understanding,
                                  #       segments, raw
store.facts()                     # parsed _index/facts.jsonl rows
store.events()                    # parsed _index/events.jsonl rows
store.profile()                   # parsed _index/profile.jsonl rows
store.search("deploy")            # substring filter over the manifest
```

`read()` returns the document's three parts:

- `header`: the YAML frontmatter (id, type, title, lang, summary, tags, ...).
- `understanding`: the JSON extraction block under `# Understanding`.
- `segments`: the `## [seg n/N]` blocks under `# Content`, each as
  `{"n", "total", "text"}`.
- `raw`: the full original file text, preserved losslessly.

You can also parse a `.dai` string directly without a store:

```python
from daidocs import parse_dai
parsed = parse_dai(open("chat_20260807_d1dd87da.dai", encoding="utf-8").read())
```

## CLI (drives the Node engine, Node required)

```
daidocs setup
daidocs convert
```

These run `npx -y daidocs@latest <args>` underneath, so they behave exactly
like the Node engine. Node 18+ is required: if Node is missing or older, the
command says so and offers to install it for you (after you confirm), rather
than silently falling back. Once Node is present, run `daidocs setup` to get the
full setup: Claude Code hooks, the Claude Desktop MCP server, and conversion.

Note: if you also have the npm package installed globally, both provide a
`daidocs` command and can shadow each other. The pip `daidocs` command is a
convenience wrapper around the Node engine.

## Keys and subscriptions

The reader needs no API key and no subscription. `from daidocs import Store`
only parses `.dai` files that already exist on disk. It never calls a model and
never sends anything to a third party.

Writing new memories (the engine behind the `daidocs` command) uses each
person's own setup, two ways:

- Keyless by default. Through an MCP host such as Claude Code or Claude
  Desktop, your own assistant does the extraction. This rides on the
  subscription you already have, and no API key is involved.
- Bring your own key, optionally. `daidocs setup` offers a provider menu
  (Anthropic, OpenAI, Gemini, Ollama) if you would rather run extraction
  against your own account. The key is stored in your user environment only,
  never written to a file, and you can point at a custom endpoint with
  `OPENAI_BASE_URL`.

Either way the key is per person and local to that person. There is no shared
or central key.

## License

Apache-2.0.
