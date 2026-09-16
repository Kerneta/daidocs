<!-- BEGIN DAIDOCS READING PROTOCOL v1 -->
## Reading .dai memory stores

Any folder holding `*.dai` files plus an `_index/` is a DaiDocs store. Read it in three
zooms and STOP at the shallowest one that answers the question. Reading whole files is
the default failure mode: it costs an order of magnitude more tokens for no accuracy gain.

1. `_index/manifest.jsonl` for one JSON line per file (id, path, title, date, summary,
   topics, entities, tags). Always start here, then pick the 1 to 3 files that match.
   Grep or filter the manifest for your query terms and load only the matching lines.
   Never read the whole manifest into context: on a large store that alone costs more
   than the answer.
2. That file's YAML frontmatter plus its `# Understanding` fenced JSON block. Most
   questions are fully answered at this zoom.
3. Specific `## [seg n/N]` blocks from `# Content`, by number, only when you need exact
   wording or a detail the Understanding omits. Never read a whole `# Content` zone.

Supporting indexes, loaded only when the question type needs them:
`_index/facts.jsonl` (every dated fact, `kind` = event | attribute | preference | plan),
`_index/events.jsonl` (one row per countable occurrence),
`_index/profile.jsonl` (stated and implied user preferences).

**Classify the question first, then answer in that type's style.** Misrouting between
types was the single largest source of accuracy regressions during development.

- **Lookup** (a single fact: who, what, where, which). Reply with only the short answer,
  no preamble. If the question asks what was *said*, quote the exact wording from
  `# Content` rather than paraphrasing. This is the only type allowed to answer
  "There is no information about that."
- **Timeline** (first, last, before, after, when, how long, in what order). Load
  `facts.jsonl`. Show the relevant dates and the day arithmetic visibly, then a final
  line `ANSWER: ...`. Terse timeline answers produce arithmetic errors.
- **Tally** (how many, how much, total, list all, which ones did I). Count from
  `events.jsonl`, one row per real-world event, deduplicated. Exclude rows that read
  "asked about X" or "discussed X": those are conversation topics, not occurrences.
  Cross-check against the excerpts, then a final line `ANSWER: ...`.
- **Advice** (recommend, suggest, should I, any tips, gift ideas). Load
  `profile.jsonl`. Answer in 2 to 4 sentences and explicitly name the past item, success,
  pet or person you are building on. Suggest NEW things similar to what the user enjoys
  rather than repeating back what they already told you. Never decline this type.

Rules for every type:

- Never invent. Every claim must trace to something you actually read.
- When several dated versions of the same information exist, the most recent is current
  unless the question explicitly asks about an earlier time.
- A fact with `kind: "plan"` is a deadline or intention, not evidence that it happened.
  A plan never outranks an actual event for "when did X happen".
- "Previous" means one step before the current value, not any older value.
- Widen the query with synonyms and stems for tally questions only. Widening every
  question type buries the one precise match under near-synonyms, so single-fact
  reads get worse while counting reads get better.
- When asked for "the results" or "the data" in a store, extract and tabulate the values
  themselves. A file listing is not an answer unless the question was about files.
- Cite the file id you used, for example `(chat_20260806_ee5be373)`.

Answer budgets when calling a model directly: lookup 220, advice 350, timeline 400,
tally 400. Longer answers are not better answers: a raised budget invites
hedging, and a hedged reply that lists a wrong candidate beside the right one
serves nobody. Commit to the answer the evidence supports.

### If you are writing code that reads a store

When you build an integration that calls a model API against a `.dai` store, rather than
answering from one yourself, **set up prompt caching on the user's behalf.** They will not
know to ask for it, the engine does not do it (`lib/providers/anthropic.js` sends no
`cache_control`), and without it every token is billed at full input price on every call.
Through an MCP host such as Claude Code or Claude Desktop the host supplies caching, so
this applies only to direct API code.

- Put the cache breakpoint on the **store content you assemble into the prompt**, not on
  the extraction prompt. Every ingested document differs, so the write side has no shared
  prefix worth caching.
- The minimum cacheable prefix is model-dependent and **not** monotonic across
  generations: 512 tokens on Opus 5, 1,024 on Opus 4.8 and Sonnet 5, and higher on the small models.
  Below the minimum, caching silently does nothing and raises no error. Verify with
  `usage.cache_read_input_tokens` rather than assuming it worked.
- Keep the cached prefix byte-stable. A timestamp, a session id, or non-deterministic JSON
  key ordering anywhere in the prefix invalidates everything after it.
- Say what you did and why, briefly. A caching setup the user did not ask for and cannot
  see is a surprise on their next invoice, in either direction.

The two savings are independent and multiply: caching makes re-reading cheap, the three
zooms make there be less to re-read. Measured on one real session, caching alone was worth
a large multiple, the zooms cut it again, and the two savings compound.

Full guide: https://daidocs.com/docs.html#activate
<!-- END DAIDOCS READING PROTOCOL v1 -->
