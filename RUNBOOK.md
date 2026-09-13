# Release runbook

The repository ships with every result slot marked `PENDING` and a checker that
fails while any unmeasured number is claimed. This file is the exact sequence
that turns a fresh clone plus an API key into a publishable set of numbers.
It stays in the repo on purpose: the process is part of the claim.

## 0. Before spending anything

```bash
npm install
npm run check          # engine, providers, store integrity: all offline
node tools/test_surfaces.js
node tools/check_numbers.mjs   # must print: pre-run state clean
```

Set `OPENAI_API_KEY` in the environment (never in a file), then probe it with a
one-token call before committing to the run. Worst-case cost for the full
sequence, cold, synchronous: **about $60** (roughly $40 ingest, $15 answers,
$1.50 judge, plus retries). The adapter checkpoints every question, so an
interruption never loses paid work and rerunning the same command resumes.

## 1. The run

```bash
node benchmark/run_longmemeval.mjs \
  --data /path/to/longmemeval_s_cleaned.json \
  --concurrency 150 \
  --out results/lme
```

Two phases: ingest every distinct session once (about 12 minutes at 150), then
one answer per question (about 40 minutes). It exits non-zero if any question in
the subset has no answer on disk; do not proceed past a non-zero exit.

## 2. The judge (the benchmark authors' scorer, not ours)

```bash
python -X utf8 evaluate_qa.py gpt-4o results/lme.hypotheses.jsonl /path/to/ref.jsonl
```

`-X utf8` matters on Windows. The scorer does not enforce a denominator; step 3
does.

## 3. Publish the numbers

```bash
node tools/publish_run.mjs \
  --rows results/lme.rows.jsonl \
  --eval results/lme.hypotheses.jsonl.eval-results-gpt-4o \
  --run  results/lme.run.json \
  --write
```

This refuses partial or mock runs, regenerates
`benchmark/longmemeval-s-per-question.jsonl`, fills `NUMBERS` in
`tools/check_numbers.mjs`, and prints every figure next to the doc slot it
fills. Replace each `PENDING` marker in the docs with the printed value, then
restore the comparison material (the leaderboard and the full-context baseline)
from tools/references.json, quoting each figure with its source.

## 4. Charts, then the gate

```bash
python tools/make_charts.py    # refuses to run until its values are updated
node tools/check_numbers.mjs   # must print: no drift
```

The checker now enforces the post-run state: headline present in all four claim
files, no `PENDING` anywhere, derived values recomputing, no forbidden figure,
and no chart carrying a number the artifacts do not.

## 5. Only then

Commit, tag the release, and quote the number, always with its actor and judge:
"LongMemEval-S, GPT-4o answering, official scorer, judge `gpt-4o-2024-08-06`".
