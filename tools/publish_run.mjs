#!/usr/bin/env node
// Publish a benchmark run: turn the adapter's artifacts plus the judge's output into every
// number the repo may claim.
//   node tools/publish_run.mjs --rows results/lme.rows.jsonl \
//        --eval results/lme.hypotheses.jsonl.eval-results-gpt-4o --run results/lme.run.json [--write]
// Refuses partial runs, regenerates the per-question file, prints each figure with the doc
// slot it fills, and with --write patches NUMBERS in tools/check_numbers.mjs (then replace
// the docs' PENDING markers and run check_numbers.mjs).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
};
const WRITE = process.argv.includes('--write');
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');

const rowsPath = arg('rows', null), evalPath = arg('eval', null), runPath = arg('run', null);
if (!rowsPath || !evalPath) {
  console.error('usage: node tools/publish_run.mjs --rows <rows.jsonl> --eval <eval-results> [--run <run.json>] [--write]');
  process.exit(2);
}
if (/\.MOCK\./.test(rowsPath) || /\.MOCK\./.test(evalPath)) {
  console.error('refusing: these are MOCK artifacts and cannot be published as results.');
  process.exit(2);
}

const jl = p => fs.readFileSync(p, 'utf8').trim().split(/\r?\n/).map(l => JSON.parse(l));
const rows = jl(rowsPath);
const verdicts = new Map(jl(evalPath).map(e => [e.question_id, !!(e.autoeval_label && e.autoeval_label.label)]));
const run = runPath && fs.existsSync(runPath) ? JSON.parse(fs.readFileSync(runPath, 'utf8')) : null;

if (run && run.mock) { console.error('refusing: run manifest says mock providers were used.'); process.exit(2); }

// Denominator enforcement, both directions.
const ids = new Set(rows.map(r => r.question_id));
if (rows.length !== 500 || ids.size !== 500) {
  console.error(`refusing: rows file has ${rows.length} rows, ${ids.size} unique ids; the denominator is 500.`);
  process.exit(2);
}
const unjudged = rows.filter(r => !verdicts.has(r.question_id));
if (unjudged.length) {
  console.error(`refusing: ${unjudged.length} rows have no judge verdict (first: ${unjudged[0].question_id}).`);
  process.exit(2);
}

// Join and regenerate the shipped per-question file: ids and metrics only.
const out = rows.map(r => JSON.stringify({
  question_id: r.question_id, type: r.type, sessions: r.sessions,
  strategy: r.strategy, context_tokens: r.context_tokens, files_read: r.files_read,
  tokenizer: r.tokenizer, retrieval_hit: r.retrieval_hit,
  correct: verdicts.get(r.question_id),
})).join('\n') + '\n';
fs.writeFileSync(path.join(repo, 'benchmark', 'longmemeval-s-per-question.jsonl'), out);

// Every figure the docs may claim.
const correct = rows.filter(r => verdicts.get(r.question_id)).length;
const micro = (correct / 500 * 100).toFixed(2);
const byType = {}, byStrat = {};
let ctx = 0, hits = 0;
for (const r of rows) {
  const ok = verdicts.get(r.question_id) ? 1 : 0;
  (byType[r.type] = byType[r.type] || []).push(ok);
  (byStrat[r.strategy] = byStrat[r.strategy] || []).push(ok);
  ctx += r.context_tokens; if (r.retrieval_hit) hits++;
}
const macroVals = Object.values(byType).map(v => v.reduce((a, b) => a + b, 0) / v.length);
const macro = (macroVals.reduce((a, b) => a + b, 0) / macroVals.length * 100).toFixed(2);
const meanCtx = Math.round(ctx / 500);
const hit = (hits / 500 * 100).toFixed(1);
// measured constant, gpt-tokenizer@3.4.0 over renderSession
const pasted = 103601;
const redu = (pasted / meanCtx).toFixed(1) + 'x';
const se = (Math.sqrt((correct / 500) * (1 - correct / 500) / 500) * 100).toFixed(2);

const pct = v => (v.reduce((a, b) => a + b, 0) / v.length * 100).toFixed(2);
console.log('=== figures, and the doc slot each fills ===\n');
console.log(`  headline (micro)      : ${micro}%   (${correct}/500)     -> README, RESULTS, REPLICATION, benchmark/README`);
console.log(`  task-averaged (macro) : ${macro}%                  -> RESULTS`);
console.log(`  binomial SE           : ±${se} points            -> RESULTS noise note`);
console.log(`  mean context          : ${meanCtx.toLocaleString()} tokens          -> RESULTS token economics`);
console.log(`  reduction             : ${redu}  (${pasted.toLocaleString()} / ${meanCtx.toLocaleString()})`);
console.log(`  retrieval hit         : ${hit}%`);
console.log('\n  by question type       -> RESULTS "Where it is weak" table');
for (const [k, v] of Object.entries(byType).sort((a, b) => pct(b[1]) - pct(a[1])))
  console.log(`    ${k.padEnd(28)} ${pct(v)}%  (${v.reduce((a, b) => a + b, 0)}/${v.length})`);
console.log('\n  by reading strategy');
for (const [k, v] of Object.entries(byStrat))
  console.log(`    ${k.padEnd(10)} ${pct(v)}%  (${v.reduce((a, b) => a + b, 0)}/${v.length})`);

if (WRITE) {
  const cn = path.join(here, 'check_numbers.mjs');
  let s = fs.readFileSync(cn, 'utf8');
  const fills = [
    ['headline: null,', `headline: '${micro}',`],
    ['headlineCorrect: null,', `headlineCorrect: '${correct}/500',`],
    ['headlineMacro: null,', `headlineMacro: '${macro}',`],
    ['tokensRead: null,', `tokensRead: '${meanCtx.toLocaleString('en-US')}',`],
    ['retrievalHit: null,', `retrievalHit: '${hit}',`],
  ];
  for (const [a, b] of fills) {
    if (!s.includes(a)) { console.error(`cannot fill: "${a}" not found (already written?)`); process.exit(2); }
    s = s.replace(a, b);
  }
  fs.writeFileSync(cn, s);
  console.log('\nNUMBERS written to tools/check_numbers.mjs.');
  console.log('Now replace the PENDING markers in the docs with the values above, regenerate');
  console.log('the charts, and run: node tools/check_numbers.mjs');
} else {
  console.log('\n(dry run: pass --write to fill NUMBERS in tools/check_numbers.mjs)');
}
console.log('\nbenchmark/longmemeval-s-per-question.jsonl regenerated from this run.');
