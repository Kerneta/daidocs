# VSCode / Cursor sidebar for browsing and editing memories

Status: design, not yet implemented (FR1). This is a major feature with its own
build toolchain and its own distribution channel, so it is written up here for
review before the code is written, the same way the team-store work was. The
actual extension is a separate, larger change and is deliberately not started in
this pass.

## The goal

A sidebar inside VSCode and Cursor (both are VSCode under the hood, so one
extension serves both) that lets a developer:

1. Browse the `.dai` memory store as a tree, grouped and searchable, without
   opening files by hand or reading a whole `.dai`.
2. Open and read a single memory with its Understanding shown in a readable form,
   not as raw JSON.
3. Edit a memory and have the index stay in sync.
4. Run recall and remember from the editor, against the store that belongs to the
   folder currently open.

## Architecture: wrap the CLI, do not re-implement the engine

The extension must not duplicate the reader, the store resolver, or the store
type rules. All of that already exists and is the source of truth. Two ways to
reach it:

- Option A, chosen: shell out to the `daidocs` CLI. It already exposes `recall`,
  `read`, `list`, `convert`, `stats` and `doctor`, it resolves the right store
  from the working directory, it applies the three-zoom reading protocol, and it
  honours store types. The extension spawns `daidocs <cmd>` with the workspace
  folder as the working directory and renders the result. Thin, and it inherits
  every fix to the engine for free.
- Option B, rejected for v1: spawn the stdio MCP server and speak MCP from the
  extension. This is heavier (the extension becomes an MCP client), and it
  duplicates what the CLI already wraps. Worth revisiting only if a feature needs
  something the CLI does not expose.

The one thing the extension reads directly is `_index/manifest.jsonl` for the
tree, because that is zoom 1 by design: one cheap JSON line per memory (id, path,
title, date, summary, topics, tags). Reading the manifest is exactly the right
amount of work to paint a tree, and it is what the reading protocol says to do
first anyway. It never reads a whole `.dai` to build the tree.

## What the user sees

### A tree view in the activity bar

A DaiDocs icon in the activity bar opens a tree:

- Top level: the store (or stores) in play. Normally one, resolved from the open
  folder's `.daidocs/config.json` or the shared `~/DaiDocs`. The store type is
  shown as a badge, and a confidential store is clearly marked.
- Second level: memories grouped by month (from the manifest `date`), newest
  first. Each node shows the title and a one-line summary on hover.
- A filter box filters the tree by title, topic, tag or entity, all of which are
  already in the manifest line, so filtering needs no file reads.

Clicking a memory opens it (see below). Right-click gives Open, Reveal the `.dai`
file, Copy id, and Delete (which removes the `.dai` and reconciles the index).

### Reading a memory

Two panes, selectable:

- Plain `.dai` in the normal text editor. A `.dai` is plain text, so this is free
  and lets power users see exactly what is stored. A TextMate grammar can colour
  the YAML frontmatter, the `# Understanding` JSON and the `# Content` segments.
- A rendered Understanding webview: the frontmatter and the Understanding JSON
  laid out as readable sections (summary, facts by kind, events, decisions, open
  questions), with the `# Content` segments collapsed and expandable by segment
  number. This is the three-zoom idea as a UI: open at zoom 2, expand a segment to
  reach zoom 3, never force the whole file on the reader.

### Recall and remember from the editor

Command palette and context menu:

- DaiDocs: Recall. An input box takes a question, runs `daidocs recall`, and shows
  the assembled answer in a webview with the cited file ids as clickable links
  that open those memories in the tree.
- DaiDocs: Remember selection. Takes the current editor selection (or a prompt),
  runs `daidocs save` as a note, and refreshes the tree. This is the editor-native
  twin of the `/remember` slash command.
- DaiDocs: Stats. Runs `daidocs stats` and shows the per-project savings view
  (better once FR3 lands; see dependencies).

## Editing, and why it needs the reindex command

Editing a `.dai` in the text editor is easy. Keeping the index correct after an
edit is the real work, because the manifest, facts, events and profile indexes
are derived from the `.dai` files. On save of a `.dai`, the extension must
reconcile the index so the tree and recall do not drift from the file.

This is the same reconcile step the team-store design calls for. The clean
dependency is: implement `daidocs reindex` first (see docs/TEAM-STORES.md), then
the extension simply runs it after a save. Until that exists, v1 should treat the
store as read-plus-append (browse, read, recall, remember-new) and leave in-place
editing of existing memories to a later version, rather than ship an editor that
can silently desync the index.

## Store types and privacy

The extension inherits the store type rules by going through the CLI, and must
not undo them in its own UI:

- A confidential store is shown and browsable locally but is never sent anywhere
  outside the machine and is never surfaced through any "share" or "export"
  action the extension might add later.
- The active store and its type are always visible in the view title, so a user
  is never unsure which store a remember will write to.
- Keys stay in the environment. The extension never reads, stores or displays a
  provider key; recall and remember that need no key (the keyless paths) work with
  no key configured, which is the common case for subscription users.

## Packaging and distribution

- A separate `vscode-extension/` folder in this repo, with its own `package.json`,
  TypeScript sources, an `esbuild` bundle step, and `@vscode/test-electron` for
  tests. It publishes to the VS Code Marketplace and OpenVSX (so Cursor and other
  OpenVSX clients can install it), which is a different channel from the npm
  `daidocs` package.
- It is excluded from the npm package's `files` list: a Node CLI user should not
  download the extension sources, and an extension user should not need the
  benchmark material. The two share the engine through the `daidocs` CLI, which
  the extension lists as a prerequisite (and can offer to install globally if it
  is missing).

## Testing story (why this is a morning / separate-build item)

The extension cannot be exercised by this repo's existing harness
(`verify_surfaces.mjs`, `bench_local.mjs`, `test_surfaces.js`): those are Node
scripts and the extension needs VS Code's own test host. It needs
`@vscode/test-electron` integration tests plus manual checks in a real VSCode and
a real Cursor. That gap is exactly why FR1 is scoped as a reviewed, separate build
rather than something to land unverified in an overnight pass.

## Dependencies on other roadmap items

- `daidocs reindex` (from the team-store design) is a hard prerequisite for safe
  in-place editing. Browse / read / recall / remember-new do not need it.
- FR3 (the `daidocs stats` per-project savings dashboard) makes the Stats view
  worth having; without it, Stats shows only what the current CLI prints.

## Proposed phases

- v0.1, read-only browser: activity-bar tree from the manifest, open `.dai` as
  text, the rendered Understanding webview, and DaiDocs: Recall. No writes, so
  nothing can desync. Shippable and useful on its own, and testable with
  `@vscode/test-electron`.
- v0.2, write paths: DaiDocs: Remember selection and DaiDocs: Stats.
- v0.3, editing: in-place edit of an existing memory with reindex-on-save (after
  `daidocs reindex` exists), and a structured Understanding editor.

## Open questions for review

1. One extension for both VSCode and Cursor via OpenVSX, or a Cursor-specific
   build? One is proposed; Cursor installs OpenVSX extensions, so one should do.
2. Should v0.1 render the Understanding in a webview, or start with just the
   TextMate-coloured `.dai` and add the webview in v0.2? Webview is nicer but is
   more surface to build and test first.
3. Repo-in-tree (`vscode-extension/`) versus a separate `daidocs-vscode` repo.
   In-tree keeps the engine and the extension versioned together; a separate repo
   keeps the Marketplace release cadence independent of the npm one.
