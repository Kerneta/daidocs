# How to read a .dai store

Connecting the MCP server tells your assistant the store **exists**. This page is about
teaching it to **read** one well, which is a separate step and a large one.

Everything here is plain text. Pick the section for where you work, copy the block, done.
Nothing to install for options 2 and 3.

The rules are not style preferences. Each one is a fix that moved the score on
LongMemEval-S, the 500 question academic benchmark, across the
development of the engine. The reasoning behind each is in `../lib/methods/daidocs-reader/method.js`.

---

## The 30 second version

A `.dai` file has three zones, and you read them in three zooms, never all at once.

| Zoom | What you read | When |
|---|---|---|
| 1 | `_index/manifest.jsonl`, one line per file, no body | Always first. This is the table of contents. |
| 2 | A file's `---` frontmatter plus its `# Understanding` JSON | For the 1 to 3 files the manifest says are relevant. |
| 3 | Specific `## [seg n/N]` blocks from `# Content` | Only for exact quotes or details the Understanding does not hold. |

Reading every file in full defeats the entire point. The order-of-magnitude token reduction comes
from stopping at the shallowest zoom that answers the question.

Four shared index files sit next to the `.dai` files:

- `_index/manifest.jsonl`, the table of contents (id, path, title, date, summary, topics, entities, tags)
- `_index/facts.jsonl`, every extracted fact, dated, with `kind` = event, attribute, preference or plan
- `_index/events.jsonl`, one row per countable real world occurrence (date, category, what, src)
- `_index/profile.jsonl`, the user's stated and implied preferences over time

---

## 1. Claude Code

```bash
node setup.js --instructions
```

Writes the protocol into `~/.claude/CLAUDE.md`, so every session on this machine reads
stores correctly with nothing to remember. Safe to re-run: the block is delimited by
markers, so a second run replaces it rather than stacking copies. Remove it later with
`node setup.js --unregister`.

To scope it to one repository instead of the whole machine, copy
`prompts/CLAUDE-MD-BLOCK.md` into that project's `CLAUDE.md` by hand.

Pair it with the MCP server (`node setup.js --code`) so Claude queries the store through
`list_memories`, `recall_memory` and `read_memory` rather than reading files raw. The
tools enforce the zoom discipline on their own; the protocol makes the model use them
well.

## 2. Any chat window: claude.ai, ChatGPT, Gemini, a local model

Paste `prompts/READER-PROMPT.txt` at the top of the chat, then paste or attach your
`_index/manifest.jsonl`, then ask your question. Hand over full segments only when the
model asks for them by number. That handover discipline is where the token saving comes
from, so resist pasting whole files to save a round trip.

## 3. Standing setup: Claude Project, Custom GPT, Gem

Same file, but in the persistent instructions instead of pasted each time.

- **claude.ai**: create a Project, paste the block into Project instructions, attach
  `spec/DAIDOCS-STANDARD.md` and your `_index/manifest.jsonl` as project knowledge.
- **ChatGPT**: create a Custom GPT, block goes in Instructions, spec goes in Knowledge.
- **Gemini**: create a Gem, block goes in Instructions.

Refresh the attached manifest when you add files. It is the only thing that goes stale.
The `.dai` files themselves never need re-uploading until you need their content.

## 4. Claude Desktop

Settings, then Profile, then paste:

```
When I reference past work or preferences not in this conversation, call
recall_memory before answering, and read stores in three zooms: manifest first,
then a file's Understanding block, then specific segments only if needed.
```

## 5. Your own API code

Use `prompts/READER-PROMPT.txt` as the `system` prompt. Budgets are in the table at the
bottom of this page.

**Set up prompt caching yourself.** The engine does not do it for you:
`lib/providers/anthropic.js` sends a plain request with no `cache_control`. In Claude Code
and Claude Desktop the host handles caching, which is why most users never think about it.
Calling the API directly you get none, and every token is billed at full input price on
every call.

The two effects are independent and they multiply. Caching cuts the cost of re-reading
by a large multiple, and the three zooms make there be less to re-read in the first
place. The two savings compound; skipping either one leaves most of the saving on the
table.

Cache the store content you assemble into the prompt, not the extraction prompt. Two
reasons: every document you ingest is different, so there is no shared prefix worth
caching on the write side, and the minimum cacheable prefix is model-dependent and not
monotonic (512 tokens on Opus 5, 1,024 on Opus 4.8 and Sonnet 5, and higher on the small models). An
extraction prompt is under 4,096, so a breakpoint there silently caches nothing on a
a small observer rather than raising an error.

## 6. Making the files in the first place

```bash
node daidocs.js ingest <source-folder> <store-folder> --observer openai:gpt-4.1-mini
```

Through an API key, roughly $0.003 per conversation-sized document with
`gpt-4.1-mini`. On a Claude subscription the in-session save is written by the
assistant itself and costs nothing. The same rules as a paste-anywhere prompt,
with no install at all, are in `../prompts/READER-PROMPT.txt`.

---

## What actually moves the score

Ranked by the size of the gain each produced during development.

1. **Three zoom discipline.** The single biggest lever. Pasting whole files is the default
   failure mode and it costs an order of magnitude more tokens for no accuracy gain.
2. **Type routed answering.** One uniform style scored worst. Terse for lookup, visible
   working for timeline, table counting for tally, warm and specific for advice.
   Misrouting between types was the largest single source of regressions during development.
3. **Count from the event table, not from prose.** Counting over narrative facts under or
   over counted every time. A typed table is the structure counting actually needs.
4. **Show competing dated values, do not silently pick one.** When several dated facts
   compete for the same slot, list them all with dates and let the reasoning choose in the
   open. Guessing by word overlap actively lost points.
5. **Scope abstention narrowly.** A blanket "say you do not know if unsure" rule made the
   model decline while holding the evidence. Only lookup questions may abstain.
6. **Do not widen the query globally.** Adding synonyms and stems helps counting reads but
   measurably hurts single-fact and latest-value reads. Widen for counting only.

## Answer budgets

| Question type | max_tokens | Abstain allowed |
|---|--:|---|
| Lookup | 220 | Yes |
| Advice | 350 | No |
| Timeline | 400 | No |
| Tally | 400 | No |

Raising these was tested and measured worse, not better. Longer answers invite hedging,
and a hedged answer that lists a wrong candidate beside the right one serves nobody.
