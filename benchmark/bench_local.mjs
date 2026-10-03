#!/usr/bin/env node
// Free, deterministic local regression check. Runs the published LongMemEval adapter
// (benchmark/run_longmemeval.mjs) over a tiny bundled fixture with the MOCK actor and
// observer, so it needs no API key, no network and no cost, and gives the same numbers
// every run. It scores the two model-INDEPENDENT signals a reader change moves:
//   - recall@K: did retrieval put a gold session in the files it read
//   - context tokens: how much the reader fed the model
// It does NOT measure answer accuracy; mock answers are heuristic noise. A drift here is
// the signal to do the real paid LongMemEval-S run, not a verdict on its own.
//
//   node benchmark/bench_local.mjs            compare to benchmark/bench-baseline.json (report only)
//   node benchmark/bench_local.mjs --update   write that baseline from this run
//
// Report-only by design: it prints drift and ALWAYS exits 0, so an intended change is
// never treated as a failure. When a change is deliberate, re-run with --update.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const FIXTURE = path.join(HERE, 'fixtures', 'smoke.json');
const BASELINE = path.join(HERE, 'bench-baseline.json');
const UPDATE = process.argv.includes('--update');
const TOL = 0.001; // recall rates compared to 3 dp; ctx to the token.

const outDir = path.join(os.tmpdir(), 'daidocs-bench-local');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const outPrefix = path.join(outDir, 'run');

// 1. Run the real adapter with the mock actor/observer over the bundled fixture.
const res = spawnSync(process.execPath, [
  path.join(ROOT, 'benchmark', 'run_longmemeval.mjs'),
  '--data', FIXTURE, '--actor', 'mock', '--observer', 'mock',
  '--limit', '500', '--concurrency', '8', '--out', outPrefix,
], { cwd: ROOT, encoding: 'utf8', env: { ...process.env } });
if (res.status !== 0) {
  console.error('bench-local: the run did not complete.\n' + (res.stderr || '').split('\n').slice(-8).join('\n'));
  process.exit(0); // report-only: never fail the caller
}

// 2. Read the diagnostics rows (the adapter infixes the actor id into the filename).
const rowsFile = fs.readdirSync(outDir).find(f => f.endsWith('.rows.jsonl'));
if (!rowsFile) { console.error('bench-local: no rows file produced; nothing to score.'); process.exit(0); }
const rows = fs.readFileSync(path.join(outDir, rowsFile), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

// 3. Aggregate the model-independent signals, overall and per question type.
function score(rows) {
  const by = {};
  const bucket = t => (by[t] = by[t] || { n: 0, hits: 0, ctx: 0, files: 0 });
  for (const r of rows) {
    for (const key of ['ALL', r.type]) {
      const b = bucket(key);
      b.n++; b.hits += r.retrieval_hit ? 1 : 0; b.ctx += r.context_tokens || 0; b.files += r.files_read || 0;
    }
  }
  const out = {};
  for (const [t, b] of Object.entries(by)) {
    out[t] = { n: b.n, recall: +(b.hits / b.n).toFixed(3), ctx: Math.round(b.ctx / b.n), files: +(b.files / b.n).toFixed(2) };
  }
  return out;
}
const now = score(rows);

// 4. Update or compare.
if (UPDATE) {
  fs.writeFileSync(BASELINE, JSON.stringify({ generatedBy: 'bench_local.mjs', tokenizer: rows[0] && rows[0].tokenizer, scores: now }, null, 2) + '\n');
  console.log(`bench-local: baseline written (${now.ALL.n} questions, recall@K ${now.ALL.recall}, ctx ${now.ALL.ctx}).`);
  process.exit(0);
}

const printScore = s => {
  console.log(`  ${'type'.padEnd(28)} n   recall  ctx    files`);
  for (const t of Object.keys(s).sort()) {
    const r = s[t];
    console.log(`  ${t.padEnd(28)} ${String(r.n).padStart(2)}  ${r.recall.toFixed(3)}  ${String(r.ctx).padStart(5)}  ${r.files}`);
  }
};

console.log(`\nbench-local (mock, ${now.ALL.n} questions): deterministic recall@K + context tokens\n`);
printScore(now);

if (!fs.existsSync(BASELINE)) {
  console.log('\nNo baseline yet. Run with --update to record one.');
  process.exit(0);
}
const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8')).scores;
const drifts = [];
for (const t of Object.keys(now)) {
  const b = base[t]; const n = now[t];
  if (!b) { drifts.push(`  NEW type ${t}`); continue; }
  if (Math.abs(n.recall - b.recall) > TOL) drifts.push(`  ${t}: recall ${b.recall} -> ${n.recall}`);
  if (Math.abs(n.ctx - b.ctx) > 0) drifts.push(`  ${t}: ctx ${b.ctx} -> ${n.ctx}`);
}
for (const t of Object.keys(base)) if (!now[t]) drifts.push(`  MISSING type ${t} (was in baseline)`);

if (!drifts.length) {
  console.log('\nNo change vs baseline. (recall@K and context tokens identical.)');
} else {
  console.log('\nDRIFT vs baseline (report only, not a failure):');
  for (const d of drifts) console.log(d);
  console.log('\nIf this change is intended, re-run with --update. If not, this is the cue for a real paid LongMemEval-S run.');
}
process.exit(0);
