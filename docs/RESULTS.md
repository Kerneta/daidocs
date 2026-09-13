# Results

> **Every number on this page was measured by the release run and by nothing
> else.** They are written only by `tools/publish_run.mjs`, which reads the run
> artifacts and refuses partial or mock runs, and `tools/check_numbers.mjs`
> fails the build if any published figure stops agreeing with them. The run
> protocol is [`REPLICATION.md`](REPLICATION.md) and the exact code is
> [`benchmark/run_longmemeval.mjs`](../benchmark/run_longmemeval.mjs).

**Conditions for everything below:** LongMemEval-S, all 500 questions including the
30 abstention items, GPT-4o answering at temperature 0, observer `gpt-4.1-mini`,
embedder `text-embedding-3-small`, scored by the benchmark authors' own
`evaluate_qa.py` with judge snapshot `gpt-4o-2024-08-06`, micro average over 500.

---

## The headline

| | |
|---|--:|
| Reading `.dai` (this engine, this repo) | **83.00%** (415/500) |

Task-averaged across the six question types: **84.02%**. At n=500 the binomial
standard error is **1.68 points**, so treat differences smaller than a couple of
points, including against any other system, as inside the noise.

The placement of this number against published third-party figures is in
[Ranking](#ranking) below, with the rule that decides who is in the table and
the caveat each figure carries. The figures themselves are recorded as data with
their sources in [`tools/references.json`](../tools/references.json).

**What the pipeline is,** so the eventual number is read correctly: an
extraction pass by a small observer model, embedder-ranked retrieval, and a
reading prompt with per-type counting rules. Any gap against a full-context
baseline belongs to that whole pipeline, not to any single ingredient.

---

## The same store, read by other models

The number above names its actor because accuracy does not travel with the
format. Measured 2026-08-15 with everything except the answering model held
fixed (same stores, same rendered prompts, same routing, same judge):

| actor | accuracy | correct | +/- 1 s.e. |
|---|--:|--:|--:|
| Claude Fable 5 | 92.00% | 460/500 | 1.21 |
| Claude Opus 5 | 91.00% | 455/500 | 1.28 |
| Claude Sonnet 5 | 85.60% | 428/500 | 1.57 |
| `openai:gpt-4o` (the release run above) | 83.00% | 415/500 | 1.68 |
| Claude Haiku 4.5 | 78.00% | 390/500 | 1.85 |

The Claude rows were produced through the repository's `manual` provider route
rather than an API call, with no sampling parameters, which is a real difference
from the release run and is set out in full, with the per-type table and the
byte-identical retrieval proof, in [`../RESULTS-ACTORS.md`](../RESULTS-ACTORS.md).
Judge verdicts per actor are in `run-artifacts/`.

---

## Ranking

**Second**, among memory systems whose configuration can be reproduced by
someone who does not work for the vendor.

That rule is the entry criterion and it is applied whatever the number is.
Every figure below is the publisher's own, recorded with its source and caveat
in [`tools/references.json`](../tools/references.json), and filtered to one
setup: LongMemEval-S, all 500 questions, GPT-4o answering, micro-averaged.

| system | score | the caveat that travels with it |
|---|--:|---|
| Mastra Observational Memory | 84.80% | their own published run; they headline 84.23% task-averaged, and 84.80 micro is the like-for-like figure |
| **Reading `.dai`, this run** | **83.00%** | 415/500, from this repository's own artifacts |
| Supermemory | 81.60% | cleaned-dataset variant, own harness |
| Mastra RAG topK 20 | 81.20% | judge not named |
| EmergenceMem Simple Fast | 79.00% | the open-sourced configuration |
| TiMem | 76.88% | the project's own figure |
| Zep | 71.20% | own harness, re-implemented baselines |
| Feather | 69.30% | vendor-published |
| GPT-4o + Chain-of-Note | 64.00% | the benchmark authors' baseline, not a memory system |
| GPT-4o full context | 60.60% | the benchmark authors' baseline, not a memory system |

Held out and reported rather than dropped: EmergenceMem Internal at 86.00%,
which sits above ours, because its own authors call it not publicly
reproducible; and EmergenceMem Simple at 82.40%, because it is not the
open-sourced configuration. A rule that only excluded systems below us would
not be a rule.

**The gap to first is 1.80 points, 9 questions of 500.** At n=500 the binomial
standard error is 1.68 points, so that gap is inside single-run noise, but the
point estimate is theirs and not ours. **The gap to the full-context baseline is
22.40 points**: the same model, reading a `.dai` store instead of the pasted
history.

These figures come from other projects' own write-ups, under conditions we did
not control and in some cases cannot see. That is why each carries its caveat in
the table rather than in a footnote, and why the rule for entry is
reproducibility rather than size.

---

## Where it is weak

From the release run, per question type, worst rows included:

| question type | score | n |
|---|--:|--:|
| Single-session (user) | 92.86% | 65/70 |
| Single-session (assistant) | 92.86% | 52/56 |
| Temporal reasoning | 84.96% | 113/133 |
| Knowledge update | 84.62% | 66/78 |
| Preference | 76.67% | 23/30 |
| **Multi-session** | **72.18%** | 96/133 |

**Multi-session is the weakest category at 72.18%**, with preference next at 76.67%. Both
fail on synthesis rather than retrieval: retrieval surfaced the gold session on
**94.6%** of questions, so most remaining errors are reading errors, not search
errors.

Note the sample sizes. Preference is n=30, so one question is 3.33 points; do not
read small movements in that row as signal.

---

## Retrieval recall, compared

LongMemEval_S, 500 questions, gold sessions as annotated by the benchmark.

| system | metric | unit retrieved | at | recall |
|---|---|---|---|--:|
| **.dai v4.4n1** | Recall | session documents, plus facts and events cited from them | k=5 | **98.0%** |
| MemPalace | Recall | whole sessions stored verbatim, ChromaDB default embeddings, no reranking, no LLM | k=5 | 96.6% |
| Supermemory | Recall | atomic memories, source chunk injected on a hit | k=5 | 86% |
| LongMemEval paper, session-level baseline | Recall | whole sessions, Stella V5 retriever, measured on _M (about 1.5M tokens per history) | k=5 | 70.6% |
| Mastra Observational Memory | none published | no retrieval step, keeps a running compressed log | n/a | n/a |

Recall is not comparable across rows without reading the unit column, and the
paper's row is on the larger _M corpus, so it is a harder task than the rest of
the table. Each third-party figure is recorded with its source and the exact
table cell it came from in [`tools/references.json`](../tools/references.json)
under `retrieval_recall`.

The 98.0% counts a gold session as retrieved when its content reaches the model,
either opened as a document or cited as the source of a fact or event row. On the
stricter document-only definition it is the 94.6% above, which is the
`retrieval_hit` recorded per question in the release run. The full sweep, k = 1 to
15, with both definitions and the per-category tables, is in
[`experiments/recall-sweep/`](../experiments/recall-sweep/), and the curve is in
`assets/charts/recall.png`.

Recall is the ceiling, not the score. Multi-session sits at 99% content recall
and 72.18% accuracy in the release run, so what remains there is synthesis, not
search.

---

## Token economics

The full histories measure a mean of **103,601 tokens** per question (median
103,706, min 97,121, max 105,842), counted with `gpt-tokenizer@3.4.0`, the same
pinned tokenizer the engine counts context with, over the same rendered session
text the adapter ingests. Numerator and ratio come from the run:

| | |
|---|--:|
| Mean tokens read per question | **10,065** |
| Mean full history | 103,601 |
| Reduction | **10.3x** |

Both sides of that ratio are counted with the same tokenizer over the same
rendered text, which is the only way the ratio means anything.

**What a read actually costs.** Retrieval is mostly code over an index, with one
external dependency: `text-embedding-3-small`. A lookup or timeline read makes
one embedding call, to rank which stored files the reading model sees. A tally or
advice read makes a second call, over candidate fact and profile lines, and that
second call selects material that goes straight into the prompt. All of it is
disk-cached, so repeated questions cost nothing, and the spend is on the order of
$0.00002 per 1,000 tokens. Without a key the reader falls back to the full
manifest scan and says so; it never silently ranks by anything meaningless.

Ingest is the metered call that matters, once per document, at about $0.0009 per
1,000 tokens with `gpt-4.1-mini` through an API key. On a Claude subscription the
in-session save is written by the assistant itself and is not metered at all.

---

## "You classify the questions. Isn't that gaming the benchmark?"

The engine routes each question to one of four reading strategies, **lookup**,
**tally**, **timeline** or **advice**, using a regex classifier over the question
text. That invites a fair question, and the answer has a checkable part and an
unavoidable part.

**The checkable part.** The classifier reads the question text and nothing else.
There is no caller override, no second model, and no access to the dataset. Do
not take a pasted code block's word for it; print it from the shipped source and
measure it:

```bash
node tools/verify_router.mjs /path/to/longmemeval_s.json
```

LongMemEval publishes no routing label, so the agreement figure that command
prints is measured against a six-to-four mapping **we wrote ourselves** for the
check. What the figure can rule out is label-reading: a router reading the answer
key would agree near 100%, and the tool exits non-zero above 95% as a deliberate
tripwire.

**The unavoidable part.** Four reading strategies chosen while looking at this
benchmark may be shaped by it, and no agreement percentage can rule that out. The
strategies are general categories, single fact, count, order, recommend, and the
mechanism is plain regex, but the honest statement is that generalisation is
argued, not demonstrated, until results on a second corpus are published.

---

## What is shaped by this benchmark

This engine was developed against LongMemEval-S. Diagnosing failures on a
development set and fixing what you find is ordinary practice; it stays ordinary
only if you say so. **83.00% is a development-set score** and should be read as
one.

**Rules kept because they state a general principle.** Deduplicate restatements
of one event; count distinct real-world items, not rows; a candidate must be an
instance of the asked category; calendar windows are calendar-inclusive; compose
an answer from partial clues before declaring it missing; include distinguishing
qualifiers in an answer. Each was found by studying failures here, and each holds
for any personal history.

**Values calibrated on this benchmark.** The specific numbers were chosen by
measuring accuracy on LongMemEval, we cannot show they are general, and so
they are listed as exactly what they are:

| value | what it is |
|---|---|
| answer budgets 220 / 350 / 400 | chosen by measuring on this benchmark; raising them scored worse |
| read depth: top 5 files per question, top 8 above 200k source tokens | chosen by sweeping accuracy on this benchmark |
| extraction fact cap of 14 | chosen by measurement on this benchmark |
| the widened advice-detection phrasings ("any tips", "do you think") | added after auditing missed advice questions here |

**Selection.** Several engine variants were evaluated against the same 500
questions and the best shipped. That inflates, and nothing currently bounds the
inflation: no held-out evaluation has been run on this build. Until one is
published, treat the headline as carrying selection bias of unknown size.

**Judge.** The official scorer uses `gpt-4o-2024-08-06` as judge, the same model
family as the default actor. Family self-preference is a known effect in LLM
judging; systems scored with the official scorer share this judge, which
contains those comparisons, but not every published figure names its judge,
and absolute numbers inherit the effect either way.

---

## Reproducing this

Everything needed is in this repository and the public dataset:
[`REPLICATION.md`](REPLICATION.md) is the protocol,
[`benchmark/run_longmemeval.mjs`](../benchmark/run_longmemeval.mjs) is the code,
and [`benchmark/README.md`](../benchmark/README.md) documents the per-question
file the run produces, so a diverging reproduction can locate exactly which
questions disagree.
