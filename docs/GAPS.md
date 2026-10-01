# Known gaps

The honest list of what this project has not done yet. Ordered by how much each
one would change the picture if it went the wrong way. Each is a real risk we
are choosing to ship with, stated before anyone else finds it.

## 1. Measurement

**One benchmark.** Everything quantitative rests on LongMemEval-S. It is the
best public long-memory benchmark there is, and it is still one dataset, one
question style, one judge. Results on a second corpus that played no part in
development are the single most valuable thing this project could publish next.

**The engine was developed against the test set.** Reading strategies, counting
rules, the calendar resolver, read depth, answer budgets: all shaped by
diagnosing failures on the same 500 questions the headline is measured on.
[`RESULTS.md`](RESULTS.md) discloses this in detail. No held-out evaluation has
been run on the shipped build, so nothing currently bounds the selection bias.

**Variance is a single point, not a band.** The published figure is one seed; at
n=500 the binomial standard error alone is about 1.7 points. The published
figure should eventually be a mean over several seeds with its interval, and is
not yet.

**The judge is the actor's family.** The official scorer judges with
`gpt-4o-2024-08-06` while the default actor is GPT-4o. Family self-preference in
LLM judging is documented, every row scored with the official scorer inherits
it equally, and absolute numbers carry it regardless.

**The full-context baseline is not ours.** The comparison arm everyone will ask
about is the benchmark authors' published run, on their corpus variant with
their prompt; its figure is recorded in tools/references.json. Running our own
full-context arm with this adapter would turn an indicative gap into a
controlled one, and we have not done it.

## 2. Scope

**Long chat history only.** The corpus behind the design is multi-session chat.
Documents work, and are less exercised. We designed for long histories: the
method earns its place above roughly 10k to 20k tokens of history, and below
that we recommend pasting the history instead, which is simpler and usually
more accurate. The docs say so wherever the choice comes up.

**Agent traces are not handled.** Tool calls, stack traces and file dumps have a
different shape from conversation. Converting them today produces poor stores.

**English only.** The extraction prompts, the routing regexes and the taxonomy
are English. Nothing about the format prevents other languages; nothing about
the implementation supports them yet.

**Local observers are not offered.** Small local models can convert, and their
extractions come back malformed more often. Because that has never been measured
here, they are no longer presented as a choice: `OFFERED_PROVIDERS` is OpenAI,
Anthropic and Gemini, and setup refuses anything else by name. A store stays
readable by a local model, which is a property of the format; running one as the
observer is a different claim, and it is not one this project has earned. The
measured comparison is still worth publishing and still does not exist.

## 3. Implementation

**The reference-engine reader has no dedicated unit tests.** The Python reader has
unit coverage, while the surfaces around the reference engine are covered heavily:
`npm run verify` runs more than five hundred offline checks with no API key, plus
the keyless checks and 18 unit tests for the derived surfaces. Those cover the CLI,
the hooks, the MCP server, the store system, the registry, backup, redaction and
the dashboard. The reference-engine reader in `lib/methods/daidocs-reader/method.js`,
which carries most of the remaining behaviour and all of the accuracy, is still
exercised only end to end.

**The embedder is a single external dependency.** Reads degrade to lexical
selection with a visible warning when it is unavailable, which is the designed
behaviour, and there is still no offline embedder. Since V4.4n8 it is also
skipped deliberately on a Claude subscription rather than reaching for an OpenAI
key, so the shortlist is off by default for those users and every read is a full
manifest scan. That costs roughly 130 tokens per stored memory.

**No format versioning logic in code.** The `daidocs:` frontmatter marker is
written and never read. A future format change will need real version handling.

**Concurrent writes are unguarded.** Two simultaneous `save_memory` calls can
interleave appends to the index files. Fine for a single user, not for anything
shared.

**macOS has automated CI coverage but no manual product validation.** The CI matrix
runs on `macos-latest` alongside Ubuntu and Windows for Node 18 and 22. That is
automated coverage, not a hands-on product-validation pass on a Mac; `npm run verify`
in a real macOS environment remains the honest first manual test. Two features are
known absent and say so rather than failing: the `.dai` file icon, which needs an
application bundle rather than a config file, and folder type icons, which need
Finder custom icons rather than `desktop.ini`. Both are cosmetic and both are
written up in `DAIDOCS-AFTER-LAUNCH.md`.

**The dashboard is a snapshot.** `npm run dashboard` reads the stores and embeds
everything in one self-contained page, which is what lets it work offline and be
sent to somebody. It does not update itself. Numbers in it are true as of the
build, and rebuilding is the only refresh.

## 4. Not yet done at all

**The API surface.** `lib/providers/anthropic.js` sends no `cache_control`, so
anything built directly against the API pays full input price on every call.
There is no retry or backoff, no Batch API path for bulk conversion, and
`package.json` declares no exports map, so the library is used by file path
rather than by import name.

**Nothing verifies a store's integrity.** There is no command that checks a
manifest row has its `.dai`, that a `raw:` pointer resolves, or that no id
appears twice. Every one of those has gone wrong at least once during
development and each was caught by hand.
