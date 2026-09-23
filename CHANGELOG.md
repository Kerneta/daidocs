# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The version is
defined once in `lib/version.js`; every surface imports it.

Scores below are LongMemEval-S, 500 questions, GPT-4o answering, scored by the benchmark
authors' own `evaluate_qa.py` with judge snapshot `gpt-4o-2024-08-06`. Numbers measured on
other scales are marked as such and are not comparable.

## [Unreleased]

### Fixed

- **Setup no longer leaves its project files for `git add .` to take.** A
  silent install writes `AGENTS.md`, `GEMINI.md`, `.cursorrules` and
  `.mcp.json` into the working directory. The store keeps itself out of git
  with a nested `.daidocs/.gitignore`; these four sit at the project root and
  cannot. When the target directory is a git repository, setup now appends
  those names to `.gitignore` (creating the file if the repo has none, skipping
  names that are already there, and never touching the install folder itself).
  A folder that is not a repository is left alone.

- **The dashboard check in the verify suite is hermetic.** The standalone-dashboard
  build in `verify_surfaces.mjs` inherited the environment without `DAIDOCS_STORE`,
  so it embedded the real machine's `~/DaiDocs` store, and the "nothing is loaded
  over the network" regex ran over the whole page including that embedded data. On
  any machine whose store merely mentioned `fetch(` or `<link href=` the check
  failed. The build now reads a store made inside the suite's temp dir (with its
  own home and registry, as the watcher and empty-map builds already did), and the
  regex reads only the page around the first embedded data script block. The test
  store deliberately mentions `fetch(` and `<link href=` so the distinction stays
  pinned down.

- **A conversion now lands beside its capture.** The hooks resolve the store from
  the session's own working directory, so a project folder keeps its raw captures
  in its local `.daidocs/store`. `save_memory` resolved from the MCP server's own
  `process.cwd()` instead, which is wherever the client was launched, so converting
  a captured session wrote the `.dai` and index rows into the wrong store, usually
  the general one, and the project's `_pending`/`_unconverted` markers never came
  down. When a session id is given, `save_memory` now finds the store that already
  holds that session's capture (current store, then every store the registry knows,
  then the general store) and writes the conversion there. A session from a folder
  with no project store still converts into the general store, exactly as before.
  `DAIDOCS_STORE` remains an explicit override for both halves.

### Added

- **Python reader package (`daidocs` on PyPI, 0.1.0).** A pure-Python reader for
  `.dai` stores at `readers/python/`: `from daidocs import Store` reads the
  manifest, documents and index files with no Node. It also installs a `daidocs`
  command that drives the Node engine (Node 18+ required; if Node is missing it
  says so and offers to install it via the OS package manager).

## [V4.4n32] - 2026-09-12

**The launch release.** No engine change: `lib/methods/daidocs-v44n` is byte-identical
to the build the release run measured, and every file under `run-artifacts/`,
`benchmark/` and `experiments/recall-sweep/results/` hashes to the same values. Every
number below the fold is the same number. What changed is the product around it.

### Added

- **Memory that lives with the work.** A folder can be declared a project and keep
  its own store at `<project>/.daidocs/store`, travelling with the code. Seven folder
  types decide what happens to that memory: `normal`, `locked`, `frozen`,
  `connected`, `shared`, `confidential`, `temporary`. A parent project reads its
  parts; a confidential part is never included. Every store has a permanent id in
  `~/.daidocs/stores.json`, and `daidocs.js stores --scan` finds one that has moved.
- **Sessions that save themselves.** The Stop hook converts every 4,000 new tokens,
  written by the assistant already in the conversation. Below the threshold the
  session is held verbatim in `_raw/` with a marker in `_pending/` and continues the
  next time the folder is opened. The not-yet-converted tail lives in
  `_unconverted/`, small by construction; the next session reads it in at the
  start and `recall_memory` appends it, so a short session is usable before it is
  converted, and it leaves the folder the moment it is. `daidocs.js pending
  --route` converts a backlog a project at a time, into the folder each session
  came from.
- **Subscription mode.** On a Claude host no background path calls a paid model:
  where an extraction is needed the assistant is asked for it, not billed for it.
  `DAIDOCS_USE_API=1` opts out. The model is chosen once at install and applies to
  conversion, the hooks, the MCP server and the CLI.
- **Two tools:** `declare_project` and `brief_parent`, making six. `declare_project`
  takes `reads`, so "make this folder a project that reads its parts" needs no
  config.json edit, and `recall_memory` takes `allow` and `refuse`, so the answer to
  "may this store be read from here?" is recorded once and never asked again.
- **One folder per part.** A project with several parts is several projects: the
  top folder reads its parts, each part loads only its own memory, and "look in the
  main project's memory too" widens on request, asking once.
- **Three commands:** `backup` (to a folder or a zip, optionally memory only),
  `scrub` (finds credentials already in a store and rewrites them out), `stores`.
- **The memory map.** `npm run dashboard` builds one offline page: every store and
  what it costs on disk, the conversion backlog by project, each memory as its own
  page, the file in its three zones beside the verbatim original, search, and the
  folder settings. Ships as a builder; a built page holds your memories and never ships.
- **`docs/GUIDE.md`**, the complete reference, and five explainer diagrams.
- **Provenance that stays true.** `lock.js` regenerates `MANIFEST.sha256` on every
  lock. `npm run verify` runs in CI on Linux, macOS and Windows.
- **The ranking**, placed in `docs/RESULTS.md`: second among memory systems whose
  configuration can be reproduced, 1.80 points behind first on the same actor, inside
  single-run noise, with the rule and every caveat stated.

### Changed

- The Anthropic default observer is Claude Opus 5. With an API key the
  recommendation is `openai:gpt-4.1-mini`, the observer behind every published number.
- README, QUICKSTART and INTEGRATION rewritten for the product as it is: the
  subscription path first, the 4,000-token save, one model chosen at install.
- Charts restyled onto the daidocs.com surface, inside `tools/make_charts.py`.
- Badges are local SVG files. Contributing is aimed at integrations.
- The security contact is security@kerneta.com.

### Fixed after launch: the suite CI was actually running

CI went red on the launch commit, the one that added `npm run verify` to
it, and stayed red on every commit after. The suite passed on any machine
that had DaiDocs on it and failed on a clean runner, because eight tests
quietly read the machine underneath them rather than building what they
were testing: whether Claude was installed, what stores happened to exist,
and whether the process was running inside a Claude session. Each now
makes its own world, so the suite asserts things about the code instead of
about the laptop.

Chasing it turned up a real defect behind them: the memory map read
`~/.daidocs/stores.json` directly and so ignored `DAIDOCS_REGISTRY`, which
every other part of DaiDocs honours. Anyone pointing that variable
elsewhere got a map of a different set of stores from the tool that made
them. It goes through `lib/registry` now, like everything else.

### Changed after launch

- **Every folder you work in keeps its own memory, without being asked.** The
  first session in a folder with no store gives it one, and the assistant
  says so in a line. There was a question here and it did not work: an
  assistant loses to the user's own first message, and on a first install
  the tool the question named does not exist until the client restarts. A
  hook has neither problem. The home folder and a drive root are never
  claimed, nor is a folder sent to the general store; a folder inside a
  project keeps using that project's memory rather than splitting it.
  "Keep this folder's memory in the general store" still works and now
  takes effect on a folder that has already been claimed, leaving whatever
  was saved there on disk.
- **The memory map can keep itself current.** `npm run dashboard-live`
  rebuilds the page whenever a store changes, and the page reloads itself
  to match. It lands back on the store, memory, search and scroll position
  you were on, waits twelve seconds after you stop touching it, and never
  reloads mid-read or on a hidden tab. A page built without `--watch` never
  reloads itself. The page also asks the browser not to cache it, which is
  what made a rebuild sometimes appear to do nothing.
- **A back button in the map.** Inside a store the only way up was Escape,
  which nothing said, so the hand reached for the browser's Back and left
  the page. There is a button now, and the browser's own Back goes up one
  level instead of leaving.
- **The memory folder keeps itself out of git, all of it.** It ignored the
  store but left `config.json` tracked, so every repository someone worked in
  showed `?? .daidocs/`, one `git add -A` from committing a description of
  their own memory to a public remote. The folder now ignores everything
  inside itself, which adds nothing to the user's own `.gitignore` and leaves
  a hand-written one alone. Sharing a store is a deliberate act: copy it, or
  `git add -f`. Folders declared by an earlier version are upgraded the next
  time DaiDocs runs in them.
- **A map with nothing in it says so.** A fresh install builds an empty page,
  and "0 memories" over a blank grid is what something broken looks like. The
  build and the page now both say nothing is saved yet, that nothing is
  broken, and the two ways to change it: keep working, or convert the history
  you already have.
- **The memory map opens itself.** `npm run dashboard` built a page and printed
  its path, leaving the reader to go and find a file. It now hands the page to
  whichever browser you use by default. Only when someone is there to see it:
  piped output, `CI`, `--no-open` and `DAIDOCS_NO_OPEN` each stop it, so a build
  inside a script never puts a window on a machine nobody is at, and
  `DAIDOCS_OPEN_CMD` names a specific program instead of the platform default.
- **The session-start question says what to do when the tools are missing.** It
  asks the assistant to call `declare_project`, which does not exist until the
  client has loaded the MCP server, so the first session after an install could
  be asked for something it could not do. It now says the answer is noted and
  needs a restart of the client to be recorded.

- **Install stopped asking.** It put ten questions in a row and every sensible
  answer was yes, which made answering them the slowest part of an install that
  otherwise takes seconds. A bare `node setup.js` now configures every surface
  it finds. `--ask` brings the questions back, `--status` lists every switch
  with the command that changes it, and `--restore` puts the machine back. The
  one thing it will not start on its own is converting existing history: that
  runs for a while and, with an API key, spends money.
- **One command per MCP client.** Setup used to print a block of JSON and ask
  the user to paste it into a config themselves, which was the only manual step
  in the whole install. `node setup.js --client codex` and the same for
  `cursor`, `windsurf`, `cline`, `continue` and `zed`, each written in the shape
  that client reads, with `--client generic --config <file>` for anything else
  and `--client list` to see the names. Backed up, idempotent, and a client
  that is not installed is reported rather than written to.
- **Setup survives a stdin that is not a terminal.** It made a readline
  interface per question, so on a pipe every line arriving while nothing was
  waiting was dropped: the third question never came and setup exited 0
  half-installed. It reads through one interface now and keeps what it is
  given.

### Fixed

Found by two people installing the release on their own machines, on the day it
went public, and fixed the same day.

- **The clone could land on your memory.** `git clone .../daidocs` run from a
  home directory makes `~/daidocs`, and the default store is `~/DaiDocs`: on
  Windows and on a default macOS volume those are the same directory. A store
  already there made git refuse, which is what saved it; with no store yet the
  clone succeeded and the source tree and every memory shared one folder, so
  deleting the checkout would have deleted the memories. The documented clone
  is `daidocs-app` now, and setup refuses to run from inside the store,
  changing nothing and printing the way out.
- **Install on Windows, again.** PowerShell's default execution policy refuses
  to load npm's own script, so `npm run setup` failed on a clean machine
  before anything of ours ran. It blocks every npm command, not just this
  one. The documented command is `node setup.js` now, which the policy does
  not govern, and setup installs its own dependencies on the first run. It
  reaches npm through npm's JS entry point rather than `npm.cmd`, which node
  has refused to spawn directly since the 2024 argument-injection fix.
  `npm run setup` still works wherever npm can run at all.
- **Install on Windows.** The install line joined its commands with `&&`, which
  Windows PowerShell 5.1, the default shell on Windows, rejects as a parse
  error. `npm run setup` now installs the dependencies and then connects, with
  no shell operator anywhere: `presetup` is an npm hook, so the shell never sees
  a join. From the folder above the clone, `npm --prefix daidocs run setup` is
  the whole install in one command. Every document and both website pages carry
  the same three lines.
- **A folder path with a space in it.** `import.meta.url` percent-encodes a
  space, and six scripts turned that URL into a path by hand, so an install
  under `D:\R&D Dev` looked for `D:\R&D%20Dev` and the memory map would not
  build. They use `fileURLToPath` now. The page's own folder links had the
  mirror of the same defect and are encoded. Nothing in daily use was affected:
  the MCP server, the hooks and the self-tests already did this correctly.
- **`setx` and the very next command.** The Windows key instructions did not say
  that `setx` writes the variable for future terminals only, so the key was
  invisible to the step that followed it.
- **Two advisories `npm install` reported**, both inside the MCP SDK's own
  dependencies rather than anything named here: `fast-uri` (high) under `ajv`,
  and `qs` (moderate) under `express`. The lockfile pins the patched versions,
  3.1.7 and 6.16.0. Nothing this repository depends on directly changed. Of the
  two, only `fast-uri` is reachable: the suite still passes with `qs` made to
  throw on load, because the server speaks over stdio and never touches the
  SDK's HTTP transport.

Each of the three carries a test that fails if it returns, including one that
copies the map builder into a folder called `R&D Dev` and runs it from there.

### Removed

- Claude Haiku as a default anywhere. It remains in the benchmark results as measured.
- Every suggestion of a local model as the observer. The backend for one stays in
  the tree; nothing offers it.
- The static CI badge, and any freeze-date story about the tree.

## [V4.4n4] - 2026-09-06

The Kerneta Engine V4.4n, published with its measured results included. No engine
change: `lib/methods/daidocs-v44n` is byte-identical to 1.0.0 and to the build the release
run measured.

### Added

- **Five-actor comparison** (`RESULTS-ACTORS.md`, measured 2026-08-15): the same 500
  questions, stores, prompts, routing and judge, with only the answering model swapped.
  Claude Fable 5 92.00%, Claude Opus 5 91.00%, Claude Sonnet 5 85.60%, gpt-4o 83.00%
  (the release run), Claude Haiku 4.5 78.00%. Per-actor answers and judge verdicts under
  `run-artifacts/`; the per-question diagnostics file is byte-identical across all five.
- **Recall@k sweep** (`experiments/recall-sweep/`): retrieval-only, k = 1 to 15, zero
  network calls, control column reproduces the release run on 500/500 questions. Content
  recall 96% at k=1, 98% from k=3 onward.
- **`docs/PROVENANCE.md`**: the chain of custody from run to repository and how to verify
  the tree against `MANIFEST.sha256`.
- **Two charts**, `assets/charts/actors.*` and `assets/charts/recall.*`, generated by
  `tools/make_charts.py`; the recall chart reads the sweep's JSON directly so it cannot
  drift from it.
- **`docs/RESULTS.md`** gains a retrieval-recall section with the definitions spelled out.
- **README** leads with the five-actor chart and states what a format buys over a service.

## [1.0.0] - 2026-08-12

First public release. The format, the reference engine, the MCP server and the setup are
all here, Apache 2.0.

### Added

- **The `.dai` format.** Three zones per file: YAML frontmatter, a `# Understanding` JSON
  block, and a `# Content` body of numbered segments. Plain text, readable in any editor.
- **The reading protocol**, shipped rather than documented. `setup.js --instructions`
  installs it into `~/.claude/CLAUDE.md`, and `prompts/READER-PROMPT.txt` is the same
  rules as a paste-anywhere prompt for claude.ai, ChatGPT, Gemini, local models or your
  own API code. Without it a reader loads whole files instead of the three zooms, which
  costs an order of magnitude more tokens for no accuracy gain.
- **`QUICKSTART.md`**, a five minute path with nothing assumed, including a
  symptom-to-fix troubleshooting table.
- **MCP server** (`mcp_server.mjs`) exposing `save_memory`, `recall_memory`,
  `list_memories` and `read_memory` over stdio, for Claude Desktop, Claude Code, Cursor,
  Windsurf and any other MCP client.
- **Session auto-archiver** (`session_archiver.mjs`), a Claude Code SessionEnd hook. Every
  session saves itself. Capture is lossless even with no API key set, and
  `npm run catch-up` indexes the backlog later.
- **One-command setup** (`setup.js`) covering Claude Desktop, Claude Code, Cursor,
  Windsurf, the hook, the reading protocol, the `.dai` file association and key storage.
  Provider is inferred from the key's own prefix. Idempotent, backs up every file it
  touches, and `--restore` puts everything back, including deleting files it created from
  nothing.
- **Provider backends** for Anthropic, OpenAI and Gemini, plus mock and manual backends
  for testing. Setup offers those three and refuses anything else by name.

### Engine

`lib/methods/daidocs-v44n` is the engine, GPT-4o answering: **83.00%** (415/500) on
LongMemEval-S, 84.02% task-averaged, mean context 10,065 tokens. docs/RESULTS.md holds
the conditions and every disclosure that ships with it; other projects' published
figures live in tools/references.json, uncompared.

What it does, and what each surface is for:

- **Typed event tables.** Counting questions read a deduplicated table, not prose.
- **Semantic retrieval** with anchor precision over candidate lines.
- **Question-aware reads.** Lookup, tally, timeline and advice questions each
  get a different surface rather than one uniform context.
- **Calendar resolver.** Relative dates ("last weekend", "three weeks ago") are resolved
  against the asked-on date in code, so the model reads date arithmetic instead of
  performing it.
- **Category logs and event canonicalization**, scoped to the question types they help.

### Known limits

- **Preference synthesis and cross-session joins are the hardest question types for
  this design.** The per-category table in docs/RESULTS.md is filled by the release
  run, worst rows included.
- **Below roughly 20k tokens of history** the whole thing fits in a context window and
  pasting it is simpler and usually more accurate. We would rather say so here than have
  you find out after converting.
- **Agent traces are not a target.** Tool calls, stack traces and file dumps have a
  different shape to conversation and are not handled well yet.
- **Accuracy does not travel with the format.** The same store answered through different
  models spans substantially across answering models on identical stores. Any memory score quoted without naming the answering
  model, this one included, means very little.
- **Answer budgets are deliberately tight** (lookup 220, advice 350, timeline and
  aggregation 400). Raising them measured worse, not better.
- **The engine does not set `cache_control`.** Through an MCP host like Claude Desktop or
  Claude Code the host provides prompt caching. Calling the engine directly against an API
  pays full input price on every call.
