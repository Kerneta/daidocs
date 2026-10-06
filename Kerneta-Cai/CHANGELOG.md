# Kerneta changelog (.dai + .cai)

## Versioning scheme

Starting at **V5**, the unified `.dai` + `.cai` system is versioned as `V5.MINOR.PATCH`:

- **V5** is the baseline: the combined plain-text memory layer (code graph `.cai` plus
  document memory `.dai-lite`, joined by cross-links).
- **Minor / notable change** bumps the second number: V5.1, V5.2, and so on (a new
  feature, a new query op, a new language, a new exporter).
- **Major change within the line** also steps the second number forward (for example
  V5.2 as a large reworking), as agreed.
- **Small change / fix** bumps the third number: V5.1.1, V5.0.1.
- A future ground-up rework would open the V6 line.

The authoritative version lives in the `VERSION` file at the root of this folder.

## V5.1.1 (2026-10-05)

Makes `.cai` automatic in Claude Code, so it is used and kept fresh with no manual step.

- `engine/cai_install.py setup <project_dir> --corpus <dir> [--store <dir>] [--python <path>]`:
  builds the store once, installs a `kerneta-cai` skill under the project's
  `.claude/skills/` (so Claude queries the store instead of reading source, saving tokens),
  and adds a Claude Code **PostToolUse** hook to `.claude/settings.json` that runs the
  incremental `cai update` after every `Edit` / `Write` / `MultiEdit`. The settings merge
  preserves existing keys and is idempotent.
- `engine/cai_update.py`: the `update` CLI now accepts `--quiet` (used by the hook).
- `bench/test_setup.py`: 10 assertions (store build, skill install, hook entry + matcher +
  quiet flag, settings-merge preservation, skill points at the store, idempotency).
- This supersedes the git-only `hook` command for Claude Code use: the git pre-commit hook
  refreshed only at commit time, leaving the store stale during active editing; the
  PostToolUse hook keeps it current edit-by-edit. The git hook stays for non-Claude-Code
  workflows. Verified end to end: edit a file -> hook rebuilds the store (+1) -> the new
  symbol is queryable without reading the file -> delete -> hook rebuilds (-1).

**Install, out of the box (`pip install kerneta`):**
- `pyproject.toml` packages the engine with the tree-sitter grammars as dependencies and a
  `kerneta` console command. One `pip install` makes all three tiers (.cai code, .dai-lite
  docs, .dai history) work from the interpreter pip used; that same interpreter is what
  `setup` wires into the hook, so nothing hard-codes a python path (the first go-live
  caveat). `kerneta doctor` verifies the install (interpreter, engine, grammars).
- `kerneta_cli.py` drives every tier: `setup`, `build`, `update`, `watch`, `query`, `ask`,
  `history`, `doctor`. It runs each engine tool with the engine dir on `sys.path`, so the
  flat intra-module imports keep working whether installed or run from a checkout.
- `setup` now also auto-links a DaiDocs `.dai` session store if one sits beside the project
  (`<proj>/.daidocs/store`, or a parent), so `ask` covers history out of the box; session
  capture itself stays the DaiDocs product's job.
- Recursive corpus indexing (the second go-live caveat): `cai_ts_extract.discover` walks
  subdirectories, skipping dependency/build/VCS/store/cache dirs, and gives nested files
  path-qualified module ids (`api/handlers`). The incremental updater keys off the same
  walk. Dotted imports (`core.service`) now reconcile with slash module ids (`core/service`)
  so cross-package calls resolve. `bench/test_recursive.py` passes 7/7; the flat-corpus
  suites are unchanged.
- Test totals: `test_combined` 14, `test_history` 17, `test_setup` 11, `test_recursive` 7
  (49 assertions, all passing).

**Go-live prep (to fold into the DaiDocs repo):**
- Distribution renamed to `kerneta-cai` (import package `kerneta_engine`, command
  `kerneta`); it is the code tier of DaiDocs, to live in the `Kerneta/daidocs` repo under
  `Kerneta-Cai/` so one repo carries code + docs + history (it stays off the npm `files`
  whitelist, so `npm install daidocs` is unchanged).
- Option B wrapper (`integration/daidocs/lib/code_tier.js`): `node setup.js` detects
  Python and, in `--ask`, installs the code tier and runs `kerneta setup` in one flow;
  silent mode prints the one-liner. Never blocks or breaks the Node install. Verified.
- `integration/`: the setup.js patch, website copy for daidocs.com, and a supervised
  `GO-LIVE.md` runbook (unlock, fold in, test, run the verify suite, commit, push, deploy).
  The two-install model is intentional: npm (Node) for docs+history, pip for the Python
  code tier; one repo and one router, two package managers.
- **Global, every-project use** (`kerneta setup --global` + `kerneta init`): installs the
  skill and a project-aware auto-refresh hook into `~/.claude` so `.cai` loads in every
  Claude Code session automatically, no per-project skill to remember. `kerneta init .`
  opts a repo in (builds its store once and drops a `.cai-store/.kerneta.json` marker);
  `engine/cai_hook_resolve.py` is the PostToolUse resolver that, after any edit, finds the
  edited file's project store from the marker and refreshes only that one (a fast no-op in
  repos that never opted in, and it never blocks or fails an edit). Always-on cost is just
  the skill's one-line description; queries save tokens vs reading files.
  `bench/test_global.py` passes 13/13 (init, marker, resolver refresh + no-op, zero-touch
  auto-build in a git repo + the no-repo guardrail, and that the global settings merge
  preserves existing hooks).
- **Zero-touch** (`kerneta setup --global --auto`): the hook builds a store on the first
  code edit in a git repo, so no `kerneta init` is needed at all. Guardrails: git repos
  only, never a home/drive root, skipped above 4000 files (index those by hand).

## V5.1.0 (2026-10-05)

Notable change: the history tier. The unified router now covers **code, docs, and
session history** in one `ask`, closing the last gap (V5.0 unified code and docs only;
session history lived in the separate DaiDocs install).

**What is new:**
- `engine/dai_history.py`: a pure-stdlib reader over a live DaiDocs `.dai` session store
  (its `_index/` of `manifest` / `facts` / `events` / `profile` JSONL). It follows the
  DaiDocs reading protocol: classify the question (`lookup` / `timeline` / `tally` /
  `advice`) and answer from the shallowest index that resolves it. No LLM, no API cost;
  the semantic Understanding was written at capture time by DaiDocs.
- `combined_query.py`: new ops `history` / `recall` (answer from past sessions) and
  `link-history <path>` (register a `.dai` store). The `ask` router detects explicit
  history cues and routes to the history tier, while code and doc questions route
  unchanged. History-store resolution is zero-config: `$KERNETA_HISTORY_STORE`, then a
  `history.json` pointer, then a sibling `.daidocs/store`, so "one install" now covers
  history too.
- `corpus/history/`: a committed fixture `.dai` store with known ground truth.
- `bench/test_history.py`: 17 assertions (classification, the four answer types on the
  fixture, router routing of history vs code vs doc, and a live-store smoke test). The
  code+docs gate `bench/test_combined.py` stays green at 14/14 (no regression).

**Division of labour (by design):** the save side stays with the DaiDocs product (its
autosave hook writes `.dai` with LLM Understanding); kerneta is the unified reader/router
over code, docs, and that history. Retrieval within the history tier is lexical (BM25
over the indexes): excellent for lookup and for surfacing the right memory, approximate
for fuzzy timeline/tally, where the DaiDocs product's own LLM recall remains the deep path.

## V5.0.0 (2026-10-05)

First versioned baseline. This folder, `C:\Users\LENOVO\Desktop\Browser\kerneta`
(renamed from `kerneta-combined-clean`), is now the single canonical location for the
combined system. The four superseded copies (`cai+python`, `kerneta-cai`,
`kerneta-combined`, and the `cbench` sub-copies) were moved to
`C:\Users\LENOVO\Desktop\Browser\_archive-cai-pre-v5`.

**What V5 is:**
- `.cai` deterministic code graph: 10 languages (tree-sitter), node kinds
  (fn/method/class/struct/interface/enum/trait/namespace/module/enum_member/rationale),
  edge relations (contains, method, calls, imports, imports_from, extends, implements,
  embeds, mixes_in, case_of, references, rationale_for, dynamic_import, re_exports,
  indirect_call, dispatches_to), EXTRACTED/INFERRED/AMBIGUOUS confidence, fact-based
  resolution with import scope and aliases.
- `.dai-lite` document memory: markdown/text split into segments (the offline slice of
  DaiDocs; real `.dai` adds LLM Understanding on top).
- Cross-links: `cai_dai_combine.py` links every doc segment that names a code symbol or
  module to it both ways (`mentions` / `documented_by`), so one query returns code and
  the prose that explains it.
- Query (`combined_query.py`): callers, callees, imports, defines, tdeps, path,
  most_imported, usages, impact, signature, raises, docs_for, describes, why, and a
  natural-language `ask` router across code and docs.
- Analysis (`cai_analyze.py`): god-nodes, cycles, communities, MinHash + LSH +
  Jaro-Winkler dedup, graph-diff, diagnose, suggest-questions, surprising-connections.
- Exporters (`cai_export.py`): mermaid, dot, graphml, obsidian, html, callflow, tree,
  svg, cypher.
- Structured-data conversions (`cai_data_extract.py`): SQL, Terraform, JSON config,
  manifests, SCIP, MCP config, Cargo workspace, Postgres.
- Incremental update and watch (`cai_update.py`); retriever (`mem_search.py`,
  `mem_search_plus.py`, BM25 + symbol match); routing (`cai_route.py`); install skill and
  git hook (`cai_install.py`).

**Consolidation done for this baseline:**
- Chosen as latest over four older copies (`cai+python`, `kerneta-cai`,
  `kerneta-combined`, plus `corpora/cbench` sub-copies). `kerneta-combined` had no unique
  files; the engine here (2026-09-28) supersedes the 2026-09-17 engine in the others.
- Folded in the only newer assets found elsewhere: `FUTURE-TASKS.md` (Rust/XERJ retrieval
  roadmap) and the 2026-09-29 real-repo benchmark results from `cai+python/benchmark-real3`
  (`bench/real-repo-results/`), including the blind cai vs graphify vs xerj comparison.
- Pulled in a stray newer `cai_symbol.py` (from `cai+python/py-mem`, a few hours newer
  than this folder's copy): it adds the tier-2 concept-expansion layer (`CONCEPT` map,
  `expand_concepts`, `is_hard`, `retrieve_escalate`) that escalates hard paraphrase
  queries. Also folded the py-retriever test/bench scripts into `bench/py-retriever-tests/`.
  After this, V5 is a verified superset of every archived copy's engine.
- Confirmed the confidential `added7-intenall` folder contains no `.cai` work, so nothing
  was pulled from it.

**Model leaf (unchanged, by design):** prose semantics and image vision route to a model
(the host agent's own model when run inside Claude Code, or real DaiDocs), same boundary
as Graphify.
