# Replication protocol

Everything needed to reproduce the published **83.00%** is in this repository
plus the public dataset. The adapter that produces it is
[`benchmark/run_longmemeval.mjs`](../benchmark/run_longmemeval.mjs): one command,
fresh stores, the benchmark authors' own scorer. There is no other harness.

1. **The dataset.** LongMemEval-S, a public academic benchmark, obtained from its
   authors. We run the cleaned variant of the corpus and say so wherever the
   number appears.
2. **The engine.** `lib/methods/daidocs-v44n` in this repository, Apache 2.0.
   Pin the commit you ran and name it when you quote a score.
3. **The scorer.** The benchmark authors' own `evaluate_qa.py`, not ours.

---

## The exact configuration

Everything below must be held fixed. Changing any one of them produces a
different number that cannot be compared with ours.

| | |
|---|---|
| Dataset | LongMemEval-S, **all 500 questions**, abstention items included, cleaned variant |
| Engine | `daidocs-v44n` (`lib/methods/daidocs-v44n`), at the pinned commit |
| Routing | the shipped regex `classify()`, no external router, no override |
| Read depth | top 5 files per question below 200k source tokens, top 8 above |
| Question text | must carry the `(asked on YYYY-MM-DD)` suffix |
| Actor (answers the question) | `openai:gpt-4o`, temperature 0 |
| Observer (builds the store) | `openai:gpt-4.1-mini` |
| Embedder | `openai:text-embedding-3-small`, ranks what the actor sees |
| Tokenizer (context counting) | `gpt-tokenizer@3.4.0`, pinned exactly |
| Judge | the benchmark's own `evaluate_qa.py`, snapshot `gpt-4o-2024-08-06` |
| Aggregation | micro, correct ÷ 500 |
| Result | **415/500 = 83.00%** micro, 84.02% task-averaged, mean context 10,065 tokens |

Run it:

```bash
node benchmark/run_longmemeval.mjs --data /path/to/longmemeval_s.json --concurrency 50
```

The adapter checkpoints after every question and resumes from what is on disk, so
an interrupted run never loses paid work. It refuses to end cleanly with a
partial subset: if any question in the range has no answer on disk it exits
non-zero and names the missing ids, because the denominator of every published
figure is the full subset. Mock providers write to `*.MOCK.*` filenames so a test
artifact can never be mistaken for a scored run, and every run writes a
`.run.json` manifest recording the engine version, ingest signature, models,
tokenizer and dataset.

**Name the answering model whenever you quote a score.** Accuracy varies
substantially across actors on identical stores; a memory-system number without
its actor is not a result.

---

## Driving the engine directly

The engine exposes two functions. The adapter is a loop around them.

```js
const engine = require('./lib/methods/daidocs-v44n/method');

// 1. Build a store. ingest() is called once per source document and RETURNS
//    the files it produced; it does not write them anywhere. You assemble them.
//
//    Field names matter. The engine reads `raw` (falling back to `text`) for
//    the content and `capturedAt` for the date. A field called `date` is
//    ignored, which silently produces an undated store and wrecks every
//    ordering question.
const store = { files: {} };
for (const session of sessions) {
  const { files } = await engine.ingest({
    id: session.id,
    sourceId: session.id,
    title: `Chat session on ${session.date}`,
    type: 'chat',
    capturedAt: session.date,       // NOT `date`
    raw: session.text,              // NOT `content`
  }, observer);                     // openai:gpt-4.1-mini

  // Index files accumulate across documents; everything else is per document.
  for (const f of files) {
    if (f.path.startsWith('_index/')) store.files[f.path] = (store.files[f.path] || '') + f.content;
    else store.files[f.path] = f.content;
  }
}

// 2. Answer, reading only what retrieval selects.
const r = await engine.answerMulti(
  { text: `${question} (asked on ${questionDate})` },
  store,
  actor,                            // openai:gpt-4o, temperature 0
  {}
);
// r.answer, r.contextTokens, r.kind, r.pickedIds
```

**You do not choose the reading strategy, and you cannot.** The engine decides it
from the question text with `classify()`; there is no option, no second model and
no caller hook. `r.kind` reports what it chose.

Note the `(asked on YYYY-MM-DD)` suffix. The engine parses it to resolve relative
dates, and a real deployment supplies it from the clock. Leaving it off changes
results on every ordering question.

Write one `{"question_id": ..., "hypothesis": ...}` line per question, then hand
that file to the official scorer.

---

## Scoring

```bash
python evaluate_qa.py gpt-4o your_hypotheses.jsonl longmemeval_s.json
```

On Windows, run Python in UTF-8 mode or the official script fails on non-ASCII
answers:

```bash
python -X utf8 evaluate_qa.py gpt-4o your_hypotheses.jsonl longmemeval_s.json
```

**The official script does not enforce the denominator.** It scores whatever rows
you hand it and silently skips the rest, so "scored with the official script" is
not by itself a specification. Report how many rows you scored; the published
figure is always out of 500.

---

## What it costs

From our own runs, cold start with nothing cached, synchronous endpoints:

| stage | what it is | cost |
|---|---|--:|
| ingest | 19,195 distinct sessions, roughly 50M tokens in, `gpt-4.1-mini` | ~$40 |
| answers | 500 questions, `gpt-4o` | ~$15 |
| embeddings | ranking calls, disk-cached | <$0.10 |
| judge | official `evaluate_qa.py` on `gpt-4o` | ~$1.50 |

Ingest dominates and is paid once; the stores are cached by content, so re-running
the answer stage costs only the answers. Batch APIs roughly halve both. At an
ingest concurrency of 150 the ingest takes about 12 minutes and the answers about
40.

---

## What we would want to know

**If you cannot reproduce the number, that is the most valuable issue you can
open**, and we will say so publicly rather than quietly editing anything.

Two caveats, stated before anyone finds them:

- **GPT-4o is not deterministic at temperature 0.** Expect movement on a
  from-scratch run; at n=500 the binomial standard error alone is about 1.7
  points. A handful of flipped questions is noise.
- **The published number is the best of a family.** Engine variants were
  evaluated against the same 500 questions during development and the winner
  shipped. That is selection on the development set and it inflates; see the
  disclosure section of [`RESULTS.md`](RESULTS.md).
