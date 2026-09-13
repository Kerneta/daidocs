# The benchmark adapter, and the per-question file it produces

Two things live here.

**[`run_longmemeval.mjs`](run_longmemeval.mjs)** is the adapter the published
LongMemEval-S number comes from: the release number is produced by this file in
this repository, not by any private harness. Its fairness properties are stated at the top of the file as things
you can grep for: the gold `question_type` is read in exactly one executable
line, writing a diagnostics row after the answer is already final; the gold
answer string is never read at all; and all questions take the same code path
with an empty options object. There is no router in the adapter, because the
engine exposes no way to inject one.

**`longmemeval-s-per-question.jsonl`** is one line per question from the release
run, written by `tools/publish_run.mjs` from the run artifacts. It exists so
that if your reproduction lands on a different score you can find **which
questions** differ, rather than staring at two totals. It is absent until the
release run has been published.

## The run it records

Filled by `tools/publish_run.mjs`; the same values appear in
[`docs/RESULTS.md`](../docs/RESULTS.md) and are cross-checked by
`tools/check_numbers.mjs`.

| | |
|---|---|
| Engine | `daidocs-v44n`, at the pinned commit |
| Routing | the shipped regex `classify()`; no external router, no override |
| Dataset | LongMemEval-S, all 500 questions, abstention items included, cleaned variant |
| Actor | `openai:gpt-4o`, temperature 0 |
| Observer | `openai:gpt-4.1-mini` |
| Embedder | `openai:text-embedding-3-small` |
| Tokenizer | `gpt-tokenizer@3.4.0` |
| Judge | the benchmark authors' `evaluate_qa.py`, snapshot `gpt-4o-2024-08-06` |
| Result | **415/500 = 83.00%** micro, 84.02% task-averaged |

## Fields

| field | meaning |
|---|---|
| `question_id` | the benchmark's own id, so you can join against your run |
| `type` | the benchmark's question type |
| `sessions` | how many sessions were in this question's haystack |
| `strategy` | the reading strategy the engine chose: `lookup`, `tally`, `timeline` or `advice` |
| `context_tokens` | tokens the reader actually loaded to answer |
| `files_read` | how many `.dai` files contributed |
| `tokenizer` | the exact tokenizer that counted `context_tokens` |
| `retrieval_hit` | whether retrieval surfaced the gold session at all |
| `correct` | the official judge's verdict |

## What is deliberately not here

**No answer text.** The file carries verdicts and diagnostics, not hypotheses.
You reproduce the score by running the engine; this file is for locating
disagreements after you have.

**No dataset content and no store files.** LongMemEval-S is a public academic
benchmark and you obtain it from its authors. Nothing here redistributes it.

## Using it

Join your run to this file on `question_id` and look at the disagreements.

- **Your `retrieval_hit` is false where ours is true.** Retrieval, not reading.
  Check that ingest produced a manifest for every session and that the observer
  completed.
- **`retrieval_hit` matches but `correct` differs.** The reading stage. Check the
  reading protocol is actually installed; a reader loading whole files instead of
  the three zooms is the usual cause.
- **Your `strategy` differs on many questions.** That should not happen: the
  classifier is deterministic regex over the question text. Check you are passing
  the question with its `(asked on YYYY-MM-DD)` suffix, and run
  `node tools/verify_router.mjs` to print the shipped classifier.
- **Your `context_tokens` are far larger.** The reader is not being selective, or
  your tokenizer differs: compare the `tokenizer` field first.

Expect some disagreement even when everything is correct: GPT-4o is not
deterministic at temperature 0, and at n=500 the standard error alone is about
1.7 points. A handful of flipped questions is noise. Fifty is a configuration
difference.

If you cannot reproduce the number, that is the most valuable issue you can
open, and it will be said publicly rather than quietly corrected.
