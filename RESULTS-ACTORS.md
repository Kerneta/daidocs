# v4.4n1 run: five actors over one identical memory layer

`RESULTS-SUMMARY.md` records the release run with a single actor, `openai:gpt-4o`
at 83.00%. This file records what happens when the actor is swapped and
everything else is held fixed: same engine build, same stores, same routing, same
rendered prompts, same judge, same 500 questions.

Measured 2026-08-15.

## Headline

| actor | accuracy | correct | +/- 1 s.e. | macro |
|---|--:|--:|--:|--:|
| Claude Fable 5 | **92.00%** | 460/500 | 1.21 | 91.94% |
| Claude Opus 5 | **91.00%** | 455/500 | 1.28 | 90.94% |
| Claude Sonnet 5 | **85.60%** | 428/500 | 1.57 | 86.75% |
| `openai:gpt-4o` (release run) | **83.00%** | 415/500 | 1.68 | 84.02% |
| Claude Haiku 4.5 | **78.00%** | 390/500 | 1.85 | 77.66% |
| `openai:gpt-4o`, no memory system | 60.60% | 303/500 | 2.19 | not published |

The last row is the same model with **no memory layer at all**: the benchmark
authors' own full-context baseline, where the entire history is pasted into the
context window and the model answers from that. It is their measurement on
their harness, not a run of ours. Its count and standard error are arithmetic
on that published percentage at n = 500, by the same formula that gives every
other row its s.e.; the task-averaged column is left open because it needs the
six per-type accuracies and they published one overall figure. Read against our
`gpt-4o` row it is the cleanest comparison available, because the actor is
identical and the only variable is the memory: **83.00% against 60.60%, a gap
of 22.40 points**, and it is the row that costs the most to run, since pasting
the history is what a 100,000-token prompt per question means.

Every cell is n = 500 for the rows measured here. The standard error is one binomial s.e. on the overall
accuracy. Macro is the unweighted mean of the six question-type accuracies.

## What was held fixed, and the evidence for it

| | |
|---|---|
| dataset | LongMemEval-S, all 500 questions, abstention items included, cleaned variant |
| engine | `daidocs-v44n` 4.4n, ingest signature `daidocs-4.4.1` |
| stores | the same 19,195 ingested sessions, reused by all five actors, never re-ingested |
| routing | the shipped regex `classify()`, no external router, no override |
| observer | `openai:gpt-4.1-mini` |
| embedder | `openai:text-embedding-3-small` |
| prompts | one rendered set of 500 prompts, shared by all five actors |
| judge | the benchmark authors' `evaluate_qa.py`, snapshot `gpt-4o-2024-08-06` |
| tokenizer | `gpt-tokenizer@3.4.0`, pinned exactly |

The prompt cache key is `hash8(system + '\n' + prompt)` and carries no actor name,
which is what makes one rendered prompt set serve every actor.

The strongest evidence that the retrieval side really was identical is that
`run-artifacts/lme.rows.jsonl` is **byte-identical across all five runs**, sha256
`95bcf659c42ff063...`. That file carries the per-question diagnostics: reading
strategy, context tokens, files read, retrieval hit. One copy is stored here
because five copies would be the same bytes five times.

So every actor was handed the same retrieved context, selected the same way, at
the same token cost, with the same retrieval hit rate of 94.6%. The only variable
in the table above is which model read it.

## By question type

Correct count in brackets.

| question type | Fable 5 | Opus 5 | Sonnet 5 | gpt-4o | Haiku 4.5 | n |
|---|--:|--:|--:|--:|--:|--:|
| single-session-user | 98.57% (69) | 97.14% (68) | 91.43% (64) | 92.86% (65) | 81.43% (57) | 70 |
| single-session-assistant | 96.43% (54) | 94.64% (53) | 94.64% (53) | 92.86% (52) | 82.14% (46) | 56 |
| knowledge-update | 93.59% (73) | 92.31% (72) | 87.18% (68) | 84.62% (66) | 84.62% (66) | 78 |
| temporal-reasoning | 90.98% (121) | 90.23% (120) | 87.22% (116) | 84.96% (113) | 81.20% (108) | 133 |
| multi-session | 88.72% (118) | 87.97% (117) | 76.69% (102) | 72.18% (96) | 69.92% (93) | 133 |
| single-session-preference | 83.33% (25) | 83.33% (25) | 83.33% (25) | 76.67% (23) | 66.67% (20) | 30 |

## Reading of the numbers

- **Fable 5 and Opus 5 are tied, not ranked.** Five questions separate them,
  well inside one standard error of either. Reporting an ordering between those
  two would be reading noise.
- **The spread is multi-session.** That row runs from 88.72% down to 69.92%, a
  range of 18.8 points, against much narrower spreads on every other type. It is
  also where the top actors gain most over the release run: Fable is 16.5 points
  above gpt-4o there. Since retrieval was identical, this is a difference in
  synthesising an answer from many retrieved sessions, not a difference in
  finding them.
- **Preference is flat at 83.33% for the three larger Claude actors**, the same
  25 of 30 questions. n = 30, so one question is 3.33 points. This is the
  noisiest row in the table and small movements in it are not signal.
- **Haiku 4.5 is the one actor below the release run.** It matches gpt-4o
  exactly on knowledge-update and loses most ground on preference (66.67%
  against 76.67%) and single-session-assistant (82.14% against 92.86%).
- **One inversion is noise.** Sonnet 5 beats gpt-4o overall but sits below it on
  single-session-user, 91.43% against 92.86%. That is one question on n = 70.

## How the Claude actors were run, and why it is not identical to the release run

The release run called `openai:gpt-4o` over the API at temperature 0. The four
Claude actors were **not** run over an API. They were run through a Claude
subscription using the repo's `lib/providers/manual.js` route:

1. The adapter writes each rendered prompt to a queue file.
2. A subagent on the target model reads a queue file and writes its answer beside
   it, following the answering instructions carried inside that prompt.
3. The adapter is re-run, picks the answers off disk, and completes the run
   exactly as if the model had been called over an API.

This difference is real and travels with these numbers:

- **No sampling parameters were set.** There is no temperature 0 equivalent on
  this route, so the Claude figures carry whatever sampling the subscription
  applies. The release run's gpt-4o figure does have temperature 0.
- **The prompt arrived as a file read, not as a user message.** The content is
  byte-identical to what the API route would have sent, but its framing in the
  context window is not.
- **The judge is unchanged and was the same for every actor**, which is what
  keeps the five numbers comparable to each other.

Before any figure here was accepted, the scoring tool was run against the release
run's verdict file alone and reproduced 83.00%, 415/500, macro 84.02%, s.e. 1.68,
matching `RESULTS-SUMMARY.md` exactly.

## What is here

| path | what it is |
|---|---|
| `run-artifacts/lme.fable.hypotheses.jsonl` | Fable 5, one answer per question, as submitted to the judge |
| `run-artifacts/lme.opus.hypotheses.jsonl` | Opus 5, same |
| `run-artifacts/lme.sonnet.hypotheses.jsonl` | Sonnet 5, same |
| `run-artifacts/lme.haiku.hypotheses.jsonl` | Haiku 4.5, same |
| `run-artifacts/lme.<actor>.hypotheses.jsonl.eval-results-gpt-4o` | the judge's verdict per question, one file per actor, 500 lines each |
| `run-artifacts/lme.hypotheses.jsonl` | the release run's gpt-4o answers |
| `run-artifacts/lme.rows.jsonl` | per-question retrieval diagnostics, shared by all five runs |
| `run-artifacts/lme.run.json` | the run manifest: engine, models, tokenizer, dataset, start time |

The raw per-question model outputs, 500 text files per Claude actor, were not
copied here: they are bulk evidence rather than results, and they live in the
working copy under `results/replies-<actor>/`.

## Caveats that travel with these numbers

- **It is a development-set score.** The engine was developed against
  LongMemEval-S and several variants were evaluated against these same 500
  questions. No held-out evaluation has been run on this build, so the absolute
  level carries selection bias. The comparison between actors is less exposed to
  this, because the memory layer they share is the part that was tuned.
- **One seed each.** No actor was run twice. With s.e. between 1.2 and 1.9
  points, differences of a couple of points are inside the noise.
- **The judge shares the release actor's model family.** `gpt-4o` judging
  `gpt-4o` answers is a known effect in LLM judging. Here it cuts against the
  Claude actors rather than for them, but it is not quantified.
- **The Claude route is not the API route**, as set out above.
