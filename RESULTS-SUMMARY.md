# v4.4n1 run: LongMemEval-S results

The measured artifacts of the release run, kept separate from the code so they
can be inspected, archived and compared without a repository around them.

The actor here is `openai:gpt-4o`. For the same 500 questions answered by four
Claude models over this identical memory layer, with the retrieval side proven
unchanged, see `RESULTS-ACTORS.md`. Top of that table is Fable 5 at 92.00%.

## Headline

| | |
|---|--:|
| **micro accuracy** | **83.00%** (415/500) |
| task-averaged (macro) | 84.02% |
| binomial standard error | 1.68 points |
| mean context read | 10,065 tokens |
| mean full history | 103,601 tokens |
| reduction | 10.3x |
| retrieval hit rate | 94.6% |

Both sides of the token ratio are counted with `gpt-tokenizer@3.4.0` over the
same rendered session text, which is the only way the ratio means anything.

## Conditions

| | |
|---|---|
| dataset | LongMemEval-S, all 500 questions, abstention items included, cleaned variant |
| engine | `daidocs-v44n` 4.4n, ingest signature `daidocs-4.4.1` |
| routing | the shipped regex `classify()`, no external router, no override |
| actor | `openai:gpt-4o`, temperature 0 |
| observer | `openai:gpt-4.1-mini` |
| embedder | `openai:text-embedding-3-small` |
| judge | the benchmark authors' `evaluate_qa.py`, snapshot `gpt-4o-2024-08-06` |
| stores | built fresh for this run, 19,195 sessions, nothing reused |

## By question type

| question type | score | n |
|---|--:|--:|
| Single-session (user) | 92.86% | 65/70 |
| Single-session (assistant) | 92.86% | 52/56 |
| Temporal reasoning | 84.96% | 113/133 |
| Knowledge update | 84.62% | 66/78 |
| Preference | 76.67% | 23/30 |
| **Multi-session** | **72.18%** | 96/133 |

Multi-session is the weakest at 72.18%, preference next at 76.67%. Both fail on
synthesis rather than retrieval: retrieval surfaced the gold session on 94.6% of
questions, so most remaining errors are reading errors, not search errors.

Preference is n=30, so one question is 3.33 points. Do not read small movements
in that row as signal.

## By reading strategy

| strategy | score | n |
|---|--:|--:|
| lookup | 88.03% | 125/142 |
| advice | 83.02% | 44/53 |
| tally | 82.55% | 194/235 |
| timeline | 74.29% | 52/70 |

The distribution (142 lookup, 235 tally, 70 timeline, 53 advice) is exactly what
`classify()` produces on these questions, which confirms the run routed with the
shipped regex classifier and nothing else.

## What is here

| path | what it is |
|---|---|
| `run-artifacts/lme.hypotheses.jsonl` | one answer per question, as submitted to the judge |
| `run-artifacts/lme.rows.jsonl` | per-question diagnostics: strategy, context tokens, files read, retrieval hit, tokenizer |
| `run-artifacts/lme.run.json` | the run manifest: engine, models, tokenizer, dataset, start time |
| `run-artifacts/lme.hypotheses.jsonl.eval-results-gpt-4o` | the judge's verdict per question |
| `run-artifacts/longmemeval-s-per-question.jsonl` | the joined per-question file that ships in the repo |
| `charts/` | the generated charts for this run |

No leaderboard chart is generated. The placement of this number against
published third-party figures, with the reproducibility rule that decides who
is in the table and the caveat each figure carries, is in `docs/RESULTS.md`;
the figures themselves stay as data in the repository's `tools/references.json`.

## Caveats that travel with this number

- **It is a development-set score.** The engine was developed against
  LongMemEval-S, and several variants were evaluated against these same 500
  questions before this one shipped. Nothing currently bounds that selection
  bias: no held-out evaluation has been run on this build.
- **One seed.** The standard error alone is 1.68 points, so differences of a
  couple of points, against any other figure, are inside the noise.
- **The judge shares the actor's model family**, which is a known effect in LLM
  judging and is inherited by any absolute number scored this way.
