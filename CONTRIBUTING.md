# Contributing

Contributions are welcome, including the kind that prove us wrong.

## What helps most

The format is the point, so the contributions that matter most are the ones that
put it in more places.

**Integrations.** A store that only one assistant can read is not a format. The
MCP server covers Claude Desktop, Claude Code, Cursor and Windsurf; an extension
for another editor, a plugin for another agent framework, a loader for another
runtime, or an adapter for an assistant that does not speak MCP are all open. If
the format fights you while you wire one up, that is a bug in the format and
worth an issue. Two we want by name: an **OpenRouter** provider backend, one key and hundreds of models, which turns bring-your-own-model into a line of config and slots into `lib/providers/` beside `anthropic`, `openai` and `gemini` with the same small contract; and a **Hermes agent** integration, so someone running that stack can point it at a store and have memory work.

**A second implementation.** A reader or a writer that is not this code. The
format is small enough to write in an afternoon, and two independent
implementations is the difference between a file layout and a format.

**Improvements to the memory itself.** Better extraction, better retrieval, and
the shapes that do not work yet, with agent traces the obvious one: tool calls
and stack traces convert badly today.

**A failed reproduction** is still welcome. If you run [`docs/REPLICATION.md`](docs/REPLICATION.md)
and get a materially different score, open an issue with the exact command, your
actor, observer and judge model ids, the scorer output rather than a summary,
and how many questions completed. It will be investigated in public.

## Sign-off, not a CLA

We take contributions under [Developer Certificate of Origin](https://developercertificate.org/)
sign-off. There is no CLA, which means we do not acquire the right to relicense your work.
That is deliberate: a format nobody can be locked out of should not depend on one company
holding the copyright.

Add `-s` to your commit:

```bash
git commit -s -m "Fix segment boundary handling in the reader"
```

That appends a `Signed-off-by:` line, which certifies you wrote the patch or have the
right to submit it under Apache 2.0.

## Before you open a pull request

```bash
npm install
npm run check           # free, no API key: engine checks plus the surface unit tests, all green
npm run selftest        # ~$0.002, needs a key (or DAIDOCS_OBSERVER=mock for free): all green
```

`npm run check` is what CI runs on every push and pull request, on Linux, macOS
and Windows. It needs no key and no secrets, so it works on a fork. It verifies
that everything parses, that every provider implements the `available()` method
the server calls, and that a store built through the CLI with the mock observer
is well formed: the `raw:` pointer resolves to a real file, the segment headers
parse back to the count the frontmatter declares, and the app marker is written
into the output.

Each of those assertions exists because that exact thing was silently broken at
some point and no test noticed. If you are adding a surface, add its regression
here rather than relying on the paid selftest, which most contributors will
never run.

If your change touches the reader or the ingest prompt, say so in the description and
include a before-and-after score on some fixed question set. Reader changes routinely look
correct and measure worse: every reader change that was ultimately reverted looked
reasonable in review first.

## Things that need care

**The reading protocol is measured, not stylistic.** [`prompts/CLAUDE-MD-BLOCK.md`](prompts/CLAUDE-MD-BLOCK.md)
and [`prompts/READER-PROMPT.txt`](prompts/READER-PROMPT.txt) are shipped to users and are
the same rules the engine applies. Each line traces to a scored change. Please do not
tidy them for tone without a measurement.

**The answer budgets are counterintuitive.** Lookup 220, advice 350, timeline 400,
tally 400. Raising them was measured worse, not better: a bigger budget invites hedging,
and a hedged answer that lists a wrong candidate beside the right one serves nobody. If you want to
change them, bring numbers.

**Never commit a store.** `.dai` files are somebody's memory. `.gitignore` covers the
usual locations, but check `git status` before committing anyway.

**Never commit a key.** Keys belong in the OS environment. `setup.js` is written so that
no config file it touches ever contains one.

## Format changes

Changes to `spec/DAIDOCS-STANDARD.md` are a bigger deal than changes to the engine,
because files written today have to stay readable. Open an issue describing the problem
before writing the patch, and expect discussion about whether the format needs to change
or a reader needs to be more tolerant.

## Scope

Good fits: integrations with other assistants and agents, reader and retrieval
accuracy, new source adapters, hosted provider backends, validation and tooling,
documentation, reproductions.

Poor fits: features that require a hosted service, anything that makes a `.dai` file
unreadable in a text editor, and anything that makes the free path worse in order to
differentiate a paid one.
