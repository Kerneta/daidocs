# Recall@k on LongMemEval-S, v4.4n1

A fixed-k retrieval sweep over the published release run, so the engine's
retrieval can be compared with systems that publish recall@k curves. Re-runs
retrieval at k = 1 to 15 against the stores the release run already built.

Status: complete, 500/500 questions. Cost: nothing. No actor call, no observer
call, no embedding call.

What ships here: the sweep script, the report script, the machine-readable
result (`results/recall-at-k.json`) and the per-question rows
(`results/sweep.partial.jsonl`, one line per question, all 500). What does not
ship: the 19,195 ingested stores (`results/lme.stores`) and the embedding cache
(`results/.embed-cache`) the sweep reads, which are working-copy data excluded
by `.gitignore`. Re-running the sweep therefore needs a release run's stores
first (see `docs/REPLICATION.md`); re-running the report needs nothing.

---

## 1. Headline

**The curve is flat.** Content recall is 96% at k=1 and 98% from k=3 onward, and
nothing above k=5 moves it. Reading deeper buys 33% more context tokens for zero
additional recall.

| | @1 | @5 | @10 | @15 | shipped |
|---|--:|--:|--:|--:|--:|
| content recall | 96% | **98%** | 98% | 98% | 98% |
| pick recall | 90% | **95%** | 95% | 95% | 95% |
| gold coverage | 90% | **95%** | 96% | 96% | 95% |
| mean context tokens | 7,398 | **10,065** | 13,377 | 13,377 | 10,065 |
| reduction vs 103,601-token history | 92.9% | **90.3%** | 87.1% | 87.1% | 90.3% |

A three-position @5 / @10 / @15 toggle is degenerate on this engine. The
comparable single number is **98% content recall at 10,065 tokens**.

Two reasons the curve is flat, both structural rather than incidental:

1. **305 of 500 questions never read by depth at all.** Tally and timeline reads
   answer out of the global facts and events indexes, not out of opened
   documents, so k does not enter. Both sit at 100% content recall at every k.
2. **The lookup path shortlists 10 candidates before it slices to k**
   (`lib/methods/daidocs-reader/method.js:496`), so k above 10 cannot move it. Measured, not read off
   the source: every column from @10 to @15 is identical.

The only category that responds to k is preference, and only on pick recall:
37% at k=1 to 80% at k=8. Its content recall barely moves (77% to 80%), because
what changes is which document gets opened, not whether the gold one is reachable.

## 2. Three metrics, and why one number is not enough

Same distinction the window-scaling calibration tool in the development working copy draws.

| metric | asks | use it for |
|---|---|---|
| **pick recall** | is a gold session among the documents the reader opened? | lookup reads. Understates tally and timeline, which cite only a few sources while answering correctly from index rows |
| **content recall** | did the gold session's substance reach the actor: opened as a document, or cited as the source of a fact or event row? | **the headline.** The closest like-for-like with a system publishing recall over injected chunks |
| **evidence recall** | does the gold id appear anywhere in the prompt, including as a bare manifest index line? | an upper bound only. It is 100% everywhere, at every k, in every category, which is exactly why it must not be quoted as the score |

`content_hit` is computed by excluding manifest-scan lines, which are exactly the
prompt lines beginning `{"id":` (`lib/methods/daidocs-reader/method.js:487`). What remains is opened
documents, fact rows rendering `(src <id>)`, and event-table rows with a `src`
column (`lib/methods/daidocs-reader/method.js:267`, `:310`).

Gold coverage is reported separately: the mean fraction of a question's gold
sessions whose content arrived, not just whether one of them did. A multi-session
question answered from one of three gold sessions is a different situation from
one answered from three of three, and a binary hit hides that.

## 3. Full tables

Regenerate with `node experiments/recall-sweep/report.mjs`. Machine-readable in
`results/recall-at-k.json`.

### Content recall, per category

| category | n | @1 | @2 | @3 | @4 | @5 | @6 | @7 | @8 | @10 | @15 | shipped |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| SS - Assistant | 56 | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% |
| Knowledge Update | 78 | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% |
| Temporal Reasoning | 133 | 98% | 98% | 98% | 99% | 100% | 100% | 100% | 100% | 100% | 100% | 100% |
| Multi-session | 133 | 98% | 98% | 99% | 99% | 99% | 99% | 99% | 99% | 99% | 99% | 99% |
| SS - User | 70 | 90% | 94% | 97% | 97% | 97% | 97% | 97% | 97% | 97% | 97% | 97% |
| SS - Preference | 30 | 77% | 77% | 77% | 77% | 77% | 77% | 80% | 80% | 80% | 80% | 77% |
| **Overall** | 500 | 96% | 97% | 98% | 98% | 98% | 98% | 98% | 98% | 98% | 98% | 98% |

### Pick recall, per category

| category | n | @1 | @2 | @3 | @4 | @5 | @6 | @7 | @8 | @10 | @15 | shipped |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| SS - Assistant | 56 | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% |
| Knowledge Update | 78 | 97% | 97% | 99% | 99% | 99% | 99% | 99% | 99% | 99% | 99% | 99% |
| Multi-session | 133 | 95% | 95% | 96% | 96% | 96% | 96% | 96% | 96% | 96% | 96% | 96% |
| Temporal Reasoning | 133 | 92% | 92% | 92% | 94% | 95% | 95% | 95% | 95% | 95% | 95% | 95% |
| SS - User | 70 | 83% | 89% | 91% | 91% | 93% | 93% | 93% | 93% | 93% | 93% | 93% |
| SS - Preference | 30 | 37% | 43% | 57% | 63% | 70% | 73% | 77% | 80% | 80% | 80% | 70% |
| **Overall** | 500 | 90% | 91% | 93% | 94% | 95% | 95% | 95% | 95% | 95% | 95% | 95% |

### Content recall by reading strategy

| strategy | n | @1 | @5 | @10 | @15 | responds to k |
|---|--:|--:|--:|--:|--:|:--|
| tally | 235 | 100% | 100% | 100% | 100% | no: answers from the global index |
| timeline | 70 | 100% | 100% | 100% | 100% | no: answers from the global index |
| lookup | 142 | 92% | 98% | 98% | 98% | yes, to k=5 |
| advice | 53 | 87% | 87% | 89% | 89% | barely |

## 4. How it is measured, and why it costs nothing

Every input the sweep needs already exists on disk from the release run:

- **stores**: `results/lme.stores`, 19,195 cached ingests, assembled per question
  with the byte-identical render and hash the adapter uses
  (`benchmark/run_longmemeval.mjs:131`, `:135`). A drift there would miss every
  cache and silently measure a different engine.
- **vectors**: `results/.embed-cache`, 233,370 of them. The run consumed 164,219
  and fetched **0**.
- **actor**: replaced with a stub that records the finished prompt and returns a
  fixed string, so recall is read off the real prompt with no model call.

`fetch` is replaced at the top of the sweep with a counter that throws, so a
cache miss cannot quietly become a paid call. Any question that attempted one
records `net_attempts > 0` in its own row and is excluded from every average
rather than averaged in. **Total network attempts over the 500-question run: 0.**

The embed cache is keyed on `EMBEDDER_ID`, which is `openai:...` only when
`OPENAI_API_KEY` is set (`lib/embeddings.js:27`). Running without the key set
changes every key, misses everything, and drops the reader into its
full-manifest fallback. The sweep therefore refuses to start without the key
present, though it never spends it.

Each question is read 12 times, once per k, and every read embeds the identical
batch, since the batch is built from the question text and the manifest entries
and neither depends on k. An in-process memo returns what the disk cache would.
That is a wall-clock change and nothing else.

## 5. Validity: the control reproduces the published run

Alongside k = 1 to 15, every question is also read with the shipped
configuration and an empty options object, exactly as the adapter does. That
control column matches `benchmark/longmemeval-s-per-question.jsonl` on **500 of
500 questions**, on all four recorded fields at once: reading strategy, files
read, context tokens **to the token**, and retrieval hit.

That is the load-bearing check. If the stores, the vectors, the tokenizer or the
engine build had drifted, the control would diverge and every number above would
be measuring something other than the released engine.

Two things it does not establish. The sweep measures **retrieval only**: it
never calls an actor, so it says nothing about whether a retrieved session was
read correctly. And `retrieval_hit` in the published rows is pick recall, so the
94.6% quoted in `docs/RESULTS.md` is the pick-recall column here (95% rounded at
the shipped operating point), not the content-recall headline.

## 6. What this does not answer

- **Answer accuracy is unchanged and unmeasured here.** The release run scores
  83.00% judged. Recall is the ceiling accuracy is drawn from, not a substitute:
  multi-session sits at 99% content recall and 72.18% accuracy, so its failures
  are synthesis failures, not search failures.
- **One dataset, one embedder, one build.** LongMemEval-S histories average
  103,601 tokens. Nothing here speaks to larger histories; that is a separate experiment.
- **k above 15 was not run.** The lookup path cannot exceed its 10-candidate
  shortlist, and @10 and @15 are already identical, so there is nothing above 15
  to find without changing the engine.

## 7. Reproduce

```bash
node --max-old-space-size=8192 experiments/recall-sweep/sweep.mjs \
  --data /path/to/longmemeval_s_cleaned.json
node experiments/recall-sweep/report.mjs
```

Rows are appended one per question as they complete and a rerun skips what is
already on disk, so an interrupted sweep never repeats work.
