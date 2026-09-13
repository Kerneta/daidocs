# Using DaiDocs with Claude Code

How the pieces fit together, and how to drive each one. Everything here describes
the current release as it behaves; the version string lives in `lib/version.js`.

## Install

The one-line install fetches the tool from npm and configures every surface it finds:

```bash
npx daidocs setup
```

Or clone the repo and run setup from there, which also gives you the source and the
benchmark artifacts:

```bash
git clone https://github.com/Kerneta/daidocs daidocs-app
cd daidocs-app
node setup.js
```

`setup.js` installs the dependencies itself on the first run, so nothing has to be
installed before it. `npm run setup` is equivalent where npm can run at all: on
Windows PowerShell refuses to load npm's script until the execution policy is
changed, which is why the documented command is node. `--no-install` skips the
dependency step. Each line stands alone, because Windows PowerShell 5.1 has no `&&`.

It asks nothing and configures every surface it finds. Every file it touches is backed up
as `*.daidocs-bak`, `node setup.js --status` lists what is on with the command that changes
each one, and `node setup.js --restore` puts them all back. `--ask` restores the old
question-per-surface flow.

### One command per MCP client

```bash
node setup.js --client list                 the names, and where each keeps its config
node setup.js --client codex                one of them
node setup.js --client all                  every one detected on this machine
node setup.js --client generic --config <f> anything else, at a path you name
```

Known: `cursor`, `windsurf`, `codex`, `cline`, `continue`, `zed`. Each is written in the
shape that client reads: `mcpServers` for most, a `[mcp_servers.daidocs-mcp]` table for
Codex's TOML, `context_servers` for Zed. A client that is not installed is reported, not
written to. Running one twice changes nothing the second time.

Flags, for a scripted install:

| Flag | What it configures |
|---|---|
| `--desktop` | Claude Desktop's `claude_desktop_config.json` |
| `--code` | `.mcp.json` in a project folder, for Claude Code |
| `--hook` | SessionEnd: every session captures itself |
| `--context` | SessionStart: your memory index loads into each new session |
| `--autosave` | Stop: sessions save themselves as you work, with no API key |
| `--instructions` | the reading protocol, into `~/.claude/CLAUDE.md` |
| `--observer <spec>` | the model that reads documents into memory |
| `--key <key>` | stored in the OS user environment, never in a file |
| `--project <dir>` | which folder `--code` and `--instructions` apply to |
| `--restore` | undo everything setup ever wrote |

Passing any flag disables the questions, so `node setup.js --hook --context` does
exactly those two and nothing else.

**Hooks are global, so the tools are registered globally with them.** The hooks
live in `~/.claude/settings.json` and fire in every folder, so installing any of
them also registers `daidocs-mcp` in the top-level `mcpServers` of
`~/.claude.json`. Without that, a hook fires in a project where the tools do not
exist and asks for a `save_memory` that is not there. `--code` still writes a
per-project `.mcp.json`, which is useful when one project needs its own store.

**Changing the server means restarting the client.** An MCP client starts the
server once and caches its tool schema for the session, so edits to
`mcp_server.mjs`, or a reinstall pointing somewhere new, only take effect after a
restart.

## Which model reads your documents

The observer runs **once per document, at ingest**, and never when you read. Its
quality is baked permanently into the store while its cost is paid once.

Resolution order, first match wins:

1. the model you chose at install. `node setup.js --observer <spec>` changes it,
   and that one choice applies to conversion, the hooks, the MCP server and the CLI
2. `DAIDOCS_OBSERVER`, but only when it names a keyless backend (`mock:`,
   `manual:`) or when no model was chosen. A stale override that disagrees with
   your chosen model is ignored, and the run says so, because a store written by
   two different observers is a store with two levels of detail in it
3. the host's default when nothing was chosen: Opus under Claude, GPT-4.1 mini
   under ChatGPT, Gemini Pro under Gemini
4. `openai:gpt-4.1-mini` when no host is detected

**On a Claude subscription no path pays.** When a Claude host is detected, every
background path, the Stop hook, SessionEnd, `convert` and `catch-up` included,
asks the assistant to write the extraction rather than calling an API. Where an
extraction is needed you are asked for it, not billed for it. This used to be
implicit and it produced the worst possible outcome: the install menu called
Opus free, then a hook with no share in the subscription called the API with
whatever key it could find and reported the failure as a key problem. Set
`DAIDOCS_USE_API=1` to opt out deliberately and use a key from a hook.

Under Claude the install menu leads with Opus 5. Elsewhere it leads with GPT-4.1
mini, the observer behind every published number. Only hosted providers are
offered.

## The three hooks

Together they form a loop: memory is read in at the start, written as you work,
and swept up at the end.

### SessionStart, `session_context.mjs`

Loads the manifest digest into every new session: ids, dates, titles and one-line
summaries, scoped to the current project. Pure file reads, no model call, around
180 tokens for a small store. It also reports how many sessions are captured but
not yet indexed, so a stalled observer is visible rather than silent.

```
DAIDOCS_CONTEXT_ENTRIES     max memories listed (default 30)
DAIDOCS_CONTEXT_MAX_CHARS   hard cap on injected text (default 4000)
```

### Stop, `session_autosave.mjs`

Fires when the assistant finishes a reply. At every stop it writes the rendered
transcript to `_raw/<session>.txt` in the folder's store, the not-yet-converted
tail to `_unconverted/<session>.txt`, a meta beside them and a marker in
`_pending/`, so the raw is on disk after each reply and a killed terminal loses
at most the last exchange. The tail is what the next session's start hook and
`recall_memory` read, so a short session is usable before it is converted, and it
leaves the folder the moment it is. It stays quiet until enough unconverted
material exists, counting anything still waiting from earlier sessions in the same
folder, then asks the assistant to save using its own extraction and to convert the
waiting sessions with it. That costs nothing and needs no key.

The instruction passes the session id, and `save_memory` records how much of the
transcript is saved once it has written the file. Only what comes after that mark
counts next time, which is what stops the hook asking for the same conversation
again after every reply.

```
DAIDOCS_AUTOSAVE_TOKENS     new tokens required before prompting (default 4000)
```

It cannot loop: a Stop hook that asks the assistant to continue sees
`stop_hook_active` on the next Stop and stands down. On any error it prints nothing
and exits 0, so it can never block you.

Every memory is tagged with its project. Inside a git worktree that resolves back to
the repository the worktree belongs to, not the worktree folder, so branches do not
each become their own project.

### SessionEnd, `session_archiver.mjs`

The safety net. Writes the rendered transcript to `_raw/` losslessly with no key
required, then indexes it if an observer is available, or leaves the unconverted
part in `_unconverted/` with a marker in `_pending/` for later.

Idempotency is on **content**, not on the session id. SessionEnd fires on `/clear`
as well as on exit and the session carries on afterwards, so identical text is
skipped, a grown transcript indexes only the new turns, and a rewritten one goes in
as a fresh continuation.

```bash
npm run catch-up      # index everything sitting in _pending
```

Set `DAIDOCS_DISABLE` to any value to switch every hook off.

## Converting existing history

```bash
node daidocs.js convert
```

Three sources, treated identically:

1. **Claude Code sessions** on this machine, from `~/.claude/projects`
2. **Captured but not yet indexed**: the `_pending` markers, with the text in
   `_unconverted/`. Readable by the next session and by recall before conversion
3. **A folder of exports**: `.txt`, `.md` or `.jsonl` from anywhere else

It lists what it found with dates, projects and sizes, asks which ones (`all`, or
`1,3,5-8`), asks where the store goes, then quotes the worst-case token count and
cost **before** any paid call. Each item is written the moment it finishes, so a
crash loses at most one document, and re-running skips whatever is already
converted. If the observer has no key it stops cleanly and keeps what it did.

Every question has a flag, so it scripts:

```bash
node daidocs.js convert --source claude --project Browser --pick 1-5 --to ~/DaiDocs --yes
```

| Flag | Meaning |
|---|---|
| `--source claude\|raw\|<folder>` | where the history comes from |
| `--pick all\|1,3,5-8` | which items |
| `--to <store>` | destination store |
| `--project <name>` | only sessions from that project |
| `--min-kb <n>` | ignore sessions smaller than this (default 20) |
| `--observer <spec>` | override the observer for this run |
| `--yes` | no prompts |

## Saving without an API key

`save_memory` takes an optional `understanding` object. When you supply it, no
observer runs at all: the engine only ever asks a provider for a JSON string and
does not care where it came from, so an assistant that has already read the
conversation can hand over its own extraction.

```
save_memory({
  title:   "[project] what this session was about",
  content: "[USER]: ...\n[ASSISTANT]: ...",
  understanding: { entities, actions, facts[], events[], preferences[],
                   tags[], decisions[], topics[], summary, sentiment,
                   open_questions[] }
})
```

This is the only conversion route that works with no credentials and no cost. It
is what the Stop hook asks for. Content is not split into parts when an
understanding is supplied, because one extraction describes one document.

## Where memories are kept

By default everything goes to one shared store at `~/DaiDocs`. A project can
declare its own instead, which is what keeps separate clients' material apart:

```json
<project>/.daidocs/config.json
{
  "type": "normal",
  "store": ".daidocs/store",
  "reads": ["self"],
  "connections": [{ "to": "../team-b", "mode": "both" }],
  "label": "Client A"
}
```

```bash
node setup.js --project "C:\work\client-a" --project-type confidential
```

Resolution walks up from the session's directory to the first config and stops.
No config anywhere means the shared store, so nothing changes until you opt in.

The opt-in is offered once. At the first session in an undeclared folder the
start hook has the assistant ask whether memory stays here or goes to the general
store; `declare_project` with `store: "general"` records the second answer in
`~/.daidocs/stores.json` so it is not asked again for that folder. Declared
folders, the home folder and a store set by `DAIDOCS_STORE` are never asked.
The start hook puts the question first and holds the backlog offer back; if the
assistant still answers the user's message without asking, the Stop hook blocks
once with the same question, the way autosave does. The reliable route is to say
it: type "make this folder a project" in a session there.

### Folder types

| Type | Read | Write |
|---|---|---|
| `normal` | yes | yes |
| `locked` | yes | no while locked: unlock, change, re-lock |
| `frozen` | yes | no, permanently: change it by copying it |
| `connected` | per link | per link |
| `shared` | yes | yes |
| `confidential` | permission every session, never in a wider read | yes |
| `temporary` | not from outside | yes, never permanent |

### What a read is allowed to touch

`reads` accepts `self`, `parent`, `children`, `all`, or a path. A sub-project with
`["self", "parent"]` writes its own memories and reads the parent's, which is the
shape for a version or an experiment. `["self"]` is an isolated variant.
`["self", "children"]` is the main folder of a project kept one-folder-per-part:
it reads every declared part one level down, and a part added later is picked
up without editing anything. `declare_project` takes `reads`, and calling it
again on a declared folder updates only what you pass.

Three rules make the separation real rather than a convention:

- **Nothing widens silently.** A project with no memories of its own says so, names
  the other stores reachable from here, and asks. It never quietly returns another
  project's material. Every answer names the stores it read.
- **Both ends must agree.** A connection declared on one side alone does nothing.
- **Connections do not chain.** A reads B and B reads C gives A nothing from C.

Confidential and temporary stores are never candidates for anyone else, whatever
another project declares about them.

### Permissions

The first time a read wants to reach another store you are asked, and the answer is
remembered in `~/.daidocs/permissions.json` as `always` or `never`: the assistant
records it by calling `recall_memory` again with `allow: [label]` or
`refuse: [label]`. Nothing is
granted by default. Your own project's store never asks.

## Reading a store

Four MCP tools, over stdio:

| Tool | What it does |
|---|---|
| `recall_memory` | assembles context for a question and returns it to the calling model |
| `save_memory` | converts one conversation or document into the store |
| `list_memories` | ids, dates, titles, summaries |
| `read_memory` | one `.dai` file in full, by id |

`recall_memory` makes **no generation call**. It runs the retrieval pipeline with a
capture provider that records the assembled prompt instead of calling a model, and
hands that context back, so the calling model answers and there is no double cost.
The engine chooses its own reading strategy from the question text and accepts no
external override.

Read strategies and their answer budgets:

| Strategy | Question shape | Budget |
|---|---|--:|
| `lookup` | a single stated fact | 220 |
| `timeline` | first, last, before, after, how long, order | 400 |
| `tally` | how many, total, list all | 400 |
| `advice` | recommend, should I, any tips | 350 |

## Secrets

Credentials are stripped from every conversation before it is written or sent, on
both the archiver and `save_memory` paths. The lossless promise covers
conversation, not secrets: an API key pasted into a chat would otherwise sit in
`_raw` in plain text and be handed to the observer as document content.

Recognised: OpenAI, Anthropic, Google, GitHub, AWS, Slack, bearer tokens and
private key blocks. Patterns are anchored on issuer prefixes rather than entropy,
so hashes, base64 and minified code are left alone. Each redaction is reported on
stderr.

## Versions

```bash
node setup.js --version     # this copy, and what is installed on this machine
node setup.js --versions    # every install, upgrade, rollback and removal
```

The version string is defined once, in `lib/version.js`, and every surface imports
it. `npm run verify` fails if any of them disagrees.

Installing over an existing install removes the old one first, so two copies can
never both own the same hook. History is appended to `~/.daidocs-installs.jsonl`,
which `--restore` deliberately does not delete: that is what makes returning to an
earlier version possible.

Two identifiers are deliberately **not** the version. The `.dai` format marker is a
compatibility contract with every store already on disk, and the engine module id
is provenance for benchmark records. Neither changes when a release does.

## Verifying

```bash
npm run check     # engine, providers, store integrity, writer contract
npm run verify    # all surfaces end to end
npm test          # the engine's own derived-surface tests
```

`npm run verify` is free and offline: every model call goes to the mock observer,
it works in a throwaway temp directory, and it never touches your real store. Run
one surface at a time with `node verify_surfaces.mjs cli`, `api`, `mcp`, `hook`,
`redact`, `autosave`, `convert` or `version`.

## Environment

| Variable | Default | Effect |
|---|---|---|
| `DAIDOCS_STORE` | `~/DaiDocs` | where memory lives |
| `DAIDOCS_OBSERVER` | the model chosen at install | overrides it for one run: keyless backends only, or when nothing was chosen |
| `DAIDOCS_USE_API` | unset | `1` makes hooks call the API on a Claude host instead of the free in-session save |
| `DAIDOCS_DISABLE` | unset | switches every hook off |
| `DAIDOCS_CAP_TOKENS` | 25000 | head and tail cap when indexing a long session |
| `DAIDOCS_AUTOSAVE_TOKENS` | 4000 | new tokens before the Stop hook speaks |
| `DAIDOCS_CONTEXT_ENTRIES` | 30 | memories listed at session start |
| `DAIDOCS_CONTEXT_MAX_CHARS` | 4000 | cap on injected context |
| `DAIDOCS_UNCONVERTED_MAX_CHARS` | 6000 at session start, 8000 in recall | cap on the unconverted text read in |
| `DAIDOCS_RECALL_MAX_CHARS` | 20000 | cap on returned recall context |
| `DAIDOCS_EMBED_CACHE` | `<store>/.embed-cache` | where ranked embeddings are cached |
| `OPENAI_API_KEY` | | observer and embeddings |
| `ANTHROPIC_API_KEY` | | observer |
| `GEMINI_API_KEY` | | observer |

Set these persistently, not per shell. A value exported in one terminal is invisible
to a hook launched by your assistant, which is the usual reason an observer appears
configured but never runs. On Windows `setx NAME "value"` applies to new terminals;
elsewhere add it to your shell profile. `node setup.js --key` does this for you.
