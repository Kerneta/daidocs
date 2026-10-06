# Kerneta combined: .cai code memory + .dai document and history memory

One plain-text memory layer that unifies three halves and knows which to use:

- **`.cai`** deterministic code graph (10 languages, tree-sitter): callers, callees,
  imports, defines, transitive deps, analysis.
- **`.dai`-lite** document memory: markdown/text split into segments (the offline slice
  of DaiDocs; real `.dai` adds LLM Understanding on top).
- **`.dai` history** session memory: the live DaiDocs session store (past conversations,
  decisions, facts, events, preferences). Answered through the same router.
- **Cross-links** connect code and docs: every doc segment that names a code symbol or
  module is linked to it both ways (`mentions` and `documented_by`). This is the payoff
  neither half has alone: a single query returns the code *and* the prose that explains it.

The `ask` router decides which tier answers: code graph, documents, or past sessions.

## Install (out of the box)

```
pip install kerneta-cai             # installs the engine + tree-sitter grammars + the `kerneta` command
kerneta doctor                      # verify: interpreter, engine, grammars
kerneta setup <project_dir> --corpus <code_dir>
```

Kerneta-Cai is the code tier of DaiDocs: `npx daidocs setup` gives documents + session
history (Node), and this adds the `.cai` code graph (Python). `npx daidocs setup --ask`
can install both in one flow. Until the PyPI publish, install from the repo subdirectory:
`pip install "git+https://github.com/Kerneta/daidocs#subdirectory=Kerneta-Cai"`.

`pip install` makes all three tiers work from the interpreter it installed into, and that
same interpreter is what `setup` wires into the auto-refresh hook, so nothing hard-codes a
python path. `kerneta setup` then makes `.cai` automatic for the project (see below). The
`.dai` document and history tiers are pure stdlib, so they work with no extra dependency;
session **capture** for the history tier is handled by the DaiDocs product (`npx daidocs
setup`), and `kerneta setup` auto-links its store if it is beside the project.

The `kerneta` command drives every tier: `setup`, `build`, `update`, `watch`, `query`,
`ask`, `history`, `doctor`.

## Pipeline

```
corpus/code  -> cai_ts_extract.py  -> store-code    (code graph)
corpus/docs  -> dai_lite.py        -> store-docs     (doc segments)
store-code + store-docs -> cai_dai_combine.py -> store-combined  (+ cross-links)
```

`cai_dai_combine.py` scans each doc segment for whole-word occurrences of known code
symbol and module names and emits `mentions` / `documented_by` edges. Deterministic, no
LLM (prose semantics remain the model leaf, handled by real DaiDocs).

## Query (engine/combined_query.py)

Code questions delegate to the `.cai` ops; cross-store ops use the links:

| op | answer |
|---|---|
| `callers` / `callees` / `imports` / `defines` / `tdeps` / `path` / `most_imported` | code graph (from `.cai`) |
| `usages <sym>` | every place a symbol is used (rename-impact): calls, references, method, indirect calls |
| `impact <sym>` | transitive callers affected if the symbol changes |
| `signature <sym>` | parameters and return type, from the stored declaration line |
| `raises <sym>` | exception types raised (project + `*Error`; bare stdlib raises need raise-edges, planned) |
| `docs_for <symbol>` | documents/segments that document a code symbol |
| `describes <docmod>` | code symbols a document covers |
| `why <symbol>` | code definition + what it calls + who calls it + the prose that explains it |
| `history "<q>"` / `recall "<q>"` | answer from past sessions (the `.dai` session store) |
| `link-history <path>` | register a `.dai` session store for this combined store |
| `ask "<question>"` | natural-language router across code, docs **and** history |

Example (`why cart_total`) returns, in one slice: `fn cart_total defined in pricing`,
its calls (`item_price`, `loyalty_discount`, `format_money`), its caller (`cart.total`),
and the two spec segments that describe it.

## History tier (engine/dai_history.py)

The third tier reads a live **DaiDocs `.dai` session store** (the Node product's output:
`.dai` files plus an `_index/` of `manifest` / `facts` / `events` / `profile` JSONL) so
the same router can answer questions about past conversations and decisions, not just
code and docs. It is a pure-stdlib reader over the indexes, following the DaiDocs reading
protocol: it classifies the question and answers from the shallowest index that resolves
it. No LLM, no server, no API cost: the semantic Understanding was written at capture
time by DaiDocs; this retrieves and shapes it.

| question type | index used | answer style |
|---|---|---|
| `lookup` (single fact) | manifest (+ facts) | the best-matching memory, cited |
| `timeline` (when / first / last / how long) | facts | relevant facts by date, with day arithmetic |
| `tally` (how many / list all) | events | deduplicated count, topic rows excluded |
| `advice` (recommend / should I / tips) | profile | known preferences + a named past item |

**One install, auto-wired.** The router finds the history store without configuration:
`$KERNETA_HISTORY_STORE`, then a `history.json` pointer written by `link-history`, then a
sibling `.daidocs/store` beside the combined store or its parent. So when kerneta sits in
a project that already runs DaiDocs session capture, history works with zero config; a
custom location is one `link-history <path>` call.

```
$PY engine/combined_query.py store-combined ask "what did we decide about the orders database"
$PY engine/dai_history.py    /path/to/.daidocs/store "how many times did we add a redis cache"
```

The save side stays with the DaiDocs product (its autosave hook writes `.dai` with LLM
Understanding); kerneta is the unified reader/router over code, docs, and that history.

## Semantic and lookup search (v4, engine/cai_search.py)

Beyond the deterministic graph ops, v4 adds token-cheap "find the code that does X" and
"where is X defined" retrieval:

```
$PY engine/cai_search.py store-code corpus/code "code that gives a discount for buying in bulk"
```

It ranks individual symbols over a body-enriched surface (name, docstring, signature,
comments, string literals, and body identifiers) with a module-fallback for exact name
matches, and returns compact per-symbol slices rather than whole files. On real code
(psf/requests, pallets/click) it matches embedding search on recall at roughly one third
to one sixth the tokens, and wins the structural queries outright. The `.cai` file format
is unchanged at v3: v4 is the reader and retrieval layer.

## Automatic in Claude Code (recommended)

One command makes `.cai` automatic for a project: Claude queries the store instead of
reading source files (far fewer tokens), and the store refreshes itself after every edit.

```
kerneta setup <project_dir> --corpus <code_dir> [--store <dir>] [--python <path>]
```

`setup` does four things: builds the store once (indexing the corpus **recursively**,
skipping deps/build/VCS/cache dirs), installs a `kerneta-cai` skill under
`<project_dir>/.claude/skills/` (so Claude queries the store by default), adds a Claude
Code **PostToolUse** hook to `<project_dir>/.claude/settings.json` that runs the
incremental `cai update` after every `Edit` / `Write` / `MultiEdit`, and auto-links a
DaiDocs `.dai` history store if one is beside the project (so `ask` covers history too).
The update is SHA-gated, so it rebuilds only the file that changed (milliseconds). The
settings merge preserves any existing keys and is idempotent.

The result: edit a file -> hook refreshes the store -> Claude's next answer is a `.cai`
slice reflecting the latest code, with no manual rebuild. This supersedes the older
git `hook` command (which only refreshed at commit time); the git hook remains available
for non-Claude-Code workflows.

## Build and test

```
PY=../_archive-cai-pre-v5/kerneta-cai/.venv/Scripts/python.exe   # tree-sitter env (10 grammars)
$PY engine/cai_ts_extract.py corpus/code store-code
$PY engine/dai_lite.py        corpus/docs store-docs
$PY engine/cai_dai_combine.py store-code store-docs store-combined
$PY engine/combined_query.py  store-combined why cart_total
$PY bench/test_combined.py    # 14 assertions (code + docs), all passing
$PY bench/test_history.py     # 17 assertions (history + router), all passing
$PY bench/test_setup.py       # 11 assertions (auto-setup skill + hook + history link)
$PY bench/test_recursive.py   # 7 assertions (recursive indexing + cross-dir calls)
```

The history tier needs no tree-sitter, so `bench/test_history.py` also runs under a plain
`python` (stdlib only).

## Status

- Built and tested: routing, doc segmentation, code<->doc cross-links, unified query,
  NL routing. `bench/test_combined.py` passes 14/14.
- History tier (`engine/dai_history.py`): `.dai` session-store retrieval with question
  classification, wired into the `ask` router as a third destination beside code and docs.
  `bench/test_history.py` passes 17/17 (classification, the four answer types on a fixture
  with known ground truth, router routing of history vs code vs doc, and a smoke test on
  the live local `.daidocs` store).
- Auto-setup (`kerneta setup`): one command installs the skill and a Claude Code
  PostToolUse hook so `.cai` is used and kept fresh automatically, no manual rebuild, and
  auto-links a history store. `bench/test_setup.py` passes 11/11.
- Packaged for `pip install kerneta` (grammars as deps, a `kerneta` console command over
  every tier); recursive corpus indexing with cross-package call resolution
  (`bench/test_recursive.py` 7/7). All four suites: 49 assertions passing.
- Retriever v4 adds semantic and lookup search (`engine/cai_search.py`), verified on
  psf/requests and pallets/click; `.cai` file format stays v3.
- v5 adds four ops: `usages` (rename-impact), `impact` (transitive callers), `signature`
  (params + return, from a new `sig` field the extractor now stores) and `raises`.
  Benchmarked on encode/httpx: signature 92%, exceptions 100%, transitive-impact 99%,
  each at a fraction of the tokens of passage retrieval. Two follow-ups: emit `raises`
  edges so bare stdlib raises are captured, and index code + tests together so
  test-to-code linking resolves (test-only stores cannot link a test to external code).
- The code half carries the full `.cai` engine (analysis, exporters, incremental,
  cross-repo, serve) from `engine/`.
- `.dai`-lite is the offline document slice; wiring real DaiDocs LLM Understanding in
  place of it is the one remaining upgrade for full document-semantic parity.
