# Team stores: sharing a .dai memory store through git

Status: design, not yet implemented (FR4). This document is the agreed
"design before code" step. It describes how a team can keep one shared DaiDocs
memory store in a git repository, why the `.dai` format is already most of the
way to merge-safe, and the small amount of machinery still needed to make
concurrent edits conflict-free. Nothing here changes behaviour on its own.

## The goal

Today a store is a private per-machine folder (the shared store at `~/DaiDocs`,
or a project's own store under `<project>/.daidocs/`). A team wants one store
that several people, and their assistants, read and write, kept in version
control so history, review and rollback come for free. The natural carrier is
git: it already versions plain text, and a `.dai` store is plain text by design.

The requirement is narrow and worth stating precisely: two teammates who each
add memory on their own machine and then sync through git must end up with both
sets of memory and no merge conflict they have to resolve by hand.

## What is already in our favour

1. One session is one file. Sessions are stored as individual
   `chat_<date>_<id8>.dai` files. Two people adding different sessions add
   different files, so git merges them as independent additions. The bodies of
   the `.dai` files are never a conflict surface.
2. Stable, content-derived ids. A file's id is derived from its date and a hash
   of its source, so the same session converted on two machines lands on the
   same filename rather than two rival ones.
3. Plain UTF-8, LF line endings. `.gitattributes` already pins `* text=auto
   eol=lf`, so a `.dai` file is byte-identical across Windows, macOS and Linux
   and never shows up as an all-lines-changed diff.
4. Keys never live in the store. API keys are environment-only, so committing a
   store never leaks a secret. This is a hard rule elsewhere in the project and
   it is what makes a store safe to push at all.

## The one real conflict surface: the append-only indexes

`_index/manifest.jsonl`, `_index/facts.jsonl`, `_index/events.jsonl` and
`_index/profile.jsonl` are append-only, one JSON object per line. Every new
session appends lines to all four. When two teammates both append and then
merge, git sees two sets of lines added at the same end-of-file position and
reports a conflict, even though the correct result is simply "keep both sets".

This is the whole problem. The `.dai` bodies take care of themselves; the
indexes do not, because they are shared files that everyone appends to.

Within a single machine this is already handled: writes to the append-only
indexes are serialized (SK1). That lock does not reach across machines or across
a git merge, so the cross-machine case needs its own answer.

### Option A, chosen: union-merge the indexes, then reconcile

Treat the indexes as conflict-free-mergeable and give git a union merge driver
for them, via a `.gitattributes` committed inside the store:

```
# .gitattributes at the store root
_index/*.jsonl merge=union
_index/*.jsonl text eol=lf
```

With `merge=union`, git concatenates both sides' added lines instead of raising
a conflict. The merge always succeeds. The cost is that `merge=union` can leave
two problems the format must tolerate and a reconcile pass must clean up:

- Duplicate lines, when both sides added a line for the same id (for example the
  same source converted on two machines). Resolved by de-duplicating on `id`,
  keeping the most recent.
- Non-deterministic order, because union append order depends on merge
  direction. Resolved by sorting each index to a canonical order (by `date` then
  `id`) so the file content is a function of the set of entries, not of who
  merged whom. Deterministic order also keeps future diffs small.

Both are handled by a single idempotent reconcile step:

```
daidocs reindex            # proposed command, see "Code steps still needed"
```

which rebuilds each `_index/*.jsonl` from the `.dai` files actually present,
de-duplicated and canonically sorted. Because it reads the `.dai` files (the
source of truth) rather than trusting the merged index, it also repairs an index
that drifted from the files for any other reason.

### Option B, rejected as the default: do not commit the indexes

The indexes are a derived cache: everything in them can be regenerated from the
`.dai` files. So one option is to `.gitignore` `_index/` entirely and have every
clone run `daidocs reindex` after pulling. This removes the conflict surface
completely.

It is rejected as the default because the index is what the SessionStart hook
and the reader load first, and a freshly cloned store with no index would give
an assistant nothing to read until someone remembered to rebuild it. The index
is cheap to carry and valuable to have present. Committing it with a union
driver keeps the "clone and it just works" property while still being
conflict-free. Teams that would rather keep the repo minimal can opt into Option
B; it should be supported, not forced.

## Which stores are shareable, and which must never be shared

Store type already encodes this and should gate sharing:

- shared and connected and normal: intended to be read by more than the one
  machine, so these are the types a team store uses. `shared` is the clearest
  signal of intent and should be the recommended type for a team store.
- confidential: never included in any wider read, whoever asks. A confidential
  store must never be committed to a shared repo. Sharing tooling must refuse a
  confidential store, not quietly include it.
- temporary: never becomes permanent memory, so it is pointless to share and
  should be excluded.
- locked and frozen: read-only stores. Shareable, but only the person who
  unlocks writes, which fits a curated team knowledge base.

The store's `.daidocs/config.json` (`{ type, store, id, reads, connections,
label }`) is committed so every teammate resolves the same store with the same
type and the same read rules. Store resolution already walks up from the working
directory to the first `.daidocs/config.json`, so a committed config means a
teammate who clones the repo and works inside it gets the team store with no
per-machine setup.

## What about `_raw/` and `_unconverted/`

`_raw/` holds the verbatim capture behind each `.dai`, and `_unconverted/` holds
captured-but-not-yet-converted sessions. Both are plain text and merge like the
`.dai` files (one file per capture, stable names), so they are not a new conflict
surface. The real question is a privacy one, not a merge one: a team may want the
distilled `.dai` understanding in the repo but not every raw transcript.

Recommendation: make raw inclusion a per-store choice in `config.json`
(`shareRaw: true|false`, default false for a shared store). When false, the
sharing tooling adds `_raw/` and `_unconverted/` to the store's `.gitignore`.
The `.dai` understanding is still fully usable without the raw behind it.

Caches are never shared: `**/.ingest-cache/`, `**/.cache/` and any provider
response cache stay in `.gitignore`. They are per-machine and, on this project,
are treated as money, so they are neither committed nor deleted casually.

## Concurrency within the reconcile step

`daidocs reindex` must be safe to run while a SessionEnd or autosave hook could
also be writing. It should reuse the existing index write lock (SK1) so a
rebuild and a live append cannot interleave, and it should write each rebuilt
index to a temporary file and rename it into place, so a crash mid-rebuild never
leaves a half-written index.

## Code steps still needed (not in this change)

This document is the design. Implementing it is a later, separate change and
breaks down as:

1. `daidocs reindex`: rebuild `_index/*.jsonl` from the `.dai` files present,
   de-duplicated on `id`, sorted by `date` then `id`, written atomically under
   the SK1 lock. Idempotent. This is the keystone; everything else is optional
   without it but much nicer with it.
2. Canonical index ordering at write time: have the normal append path keep each
   index sorted (or sort on read), so a store stays reconciled between full
   rebuilds and union merges produce less churn.
3. `daidocs share <dir>`: initialise a store for team use. Writes the store
   `.gitattributes` (union driver + eol), writes or updates `.gitignore`
   (caches always; `_raw/`/`_unconverted/` when `shareRaw` is false), refuses a
   confidential or temporary store, and prints the one-time
   `git config merge.union.driver true`-style note if any is needed. (`union` is
   a built-in merge strategy, so no custom driver binary is required; the
   `.gitattributes` line is enough. This step mostly writes files and checks the
   store type.)
4. A post-merge hint: after a pull that touched `_index/`, suggest running
   `daidocs reindex` (a git `post-merge` hook is optional and opt-in; many teams
   dislike repo-installed hooks, so a printed reminder is the safe default).
5. Docs: a short "Share a store with your team" section in the README pointing
   here, plus a note in `QUICKSTART.md`.

## Open questions for review

1. Default for `shareRaw`: off (distilled understanding only) is proposed. Agree?
2. Should `reindex` run automatically from the SessionStart hook when it detects
   an index that is out of order or has duplicate ids, or stay a manual command
   only? Automatic is friendlier; manual is more predictable.
3. For very large team stores, is a single `manifest.jsonl` still the right shape,
   or should the index shard by month so merges and appends touch smaller files?
   Sharding would cut the conflict surface further but complicates the reader.
