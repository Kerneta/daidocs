#!/usr/bin/env node
// Turns sweep.partial.jsonl into the recall@k tables: pick, content and evidence recall at
// every k, per category, excluding any row that hit the blocked network, plus the shipped
// control column. Read content_recall as the headline — pick understates tally/timeline
// reads (they answer from the index, not opened docs) and evidence overstates (a gold id
// counts even as a bare manifest line).
//   node experiments/recall-sweep/report.mjs [--rows path] [--json path]

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const ROWS = arg('rows', path.join(HERE, 'results', 'sweep.partial.jsonl'));
const JSONOUT = arg('json', path.join(HERE, 'results', 'recall-at-k.json'));

// Mean full history, from docs/RESULTS.md, counted with the same tokenizer over
// the same rendered text the engine counts context with. Both sides of the
// reduction ratio have to come from the same count or the ratio is decoration.
const MEAN_FULL_HISTORY = 103601;

const KS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15];
const LABEL = {
  'single-session-assistant': 'SS - Assistant',
  'single-session-user': 'SS - User',
  'knowledge-update': 'Knowledge Update',
  'multi-session': 'Multi-session',
  'temporal-reasoning': 'Temporal Reasoning',
  'single-session-preference': 'SS - Preference',
};
const ORDER = ['single-session-assistant', 'single-session-user', 'knowledge-update', 'multi-session', 'temporal-reasoning', 'single-session-preference'];

const all = fs.readFileSync(ROWS, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const tainted = all.filter(r => r.net_attempts > 0);
const rows = all.filter(r => !r.net_attempts);
if (tainted.length) console.log(`EXCLUDED ${tainted.length} rows that hit the blocked network (full-manifest fallback, not comparable)\n`);
console.log(`${rows.length} questions\n`);

const pct = (a, b) => b ? (100 * a / b) : 0;
const fmt = x => x.toFixed(0) + '%';

function column(key, metric) {
  const per = {};
  for (const t of ORDER) {
    const s = rows.filter(r => r.type === t);
    const hit = s.filter(r => r.at[key] && r.at[key][metric]).length;
    per[t] = { n: s.length, hit, pct: pct(hit, s.length) };
  }
  const hit = rows.filter(r => r.at[key] && r.at[key][metric]).length;
  const tok = rows.map(r => r.at[key] && r.at[key].context_tokens).filter(Number.isFinite);
  const files = rows.map(r => r.at[key] && r.at[key].files_read).filter(Number.isFinite);
  const cov = rows.map(r => r.at[key] && r.at[key].gold_coverage).filter(Number.isFinite);
  const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
  return {
    per, overall: pct(hit, rows.length),
    mean_tokens: Math.round(mean(tok)),
    mean_files: +mean(files).toFixed(1),
    gold_coverage: +mean(cov).toFixed(3),
    reduction_x: +(MEAN_FULL_HISTORY / mean(tok)).toFixed(1),
    reduction_pct: +((1 - mean(tok) / MEAN_FULL_HISTORY) * 100).toFixed(1),
  };
}

const out = { questions: rows.length, excluded: tainted.length, mean_full_history: MEAN_FULL_HISTORY, pick: {}, content: {}, evidence: {} };
for (const k of [...KS, 'default']) {
  out.pick[k] = column(k, 'pick_hit');
  out.content[k] = column(k, 'content_hit');
  out.evidence[k] = column(k, 'evidence_hit');
}

for (const [metric, table] of [
  ['CONTENT RECALL@k (headline: gold session opened, or cited as the source of a fact or event row)', out.content],
  ['PICK RECALL@k (gold session among the documents the reader opened; understates tally and timeline)', out.pick],
  ['EVIDENCE RECALL@k (gold id anywhere in the prompt, including a bare manifest index line; upper bound)', out.evidence]]) {
  console.log(`\n## ${metric}\n`);
  const head = ['category', 'n', ...KS.map(k => '@' + k), 'shipped'];
  console.log('| ' + head.join(' | ') + ' |');
  console.log('|---|--:|' + KS.map(() => '--:').join('|') + '|--:|');
  for (const t of ORDER) {
    const cells = KS.map(k => fmt(table[k].per[t].pct));
    console.log(`| ${LABEL[t]} | ${table[KS[0]].per[t].n} | ${cells.join(' | ')} | ${fmt(table.default.per[t].pct)} |`);
  }
  console.log(`| **Overall** | ${rows.length} | ${KS.map(k => fmt(table[k].overall)).join(' | ')} | ${fmt(table.default.overall)} |`);
  console.log(`| mean tokens | | ${KS.map(k => table[k].mean_tokens.toLocaleString()).join(' | ')} | ${table.default.mean_tokens.toLocaleString()} |`);
  console.log(`| reduction | | ${KS.map(k => table[k].reduction_pct + '%').join(' | ')} | ${table.default.reduction_pct}% |`);
  console.log(`| mean files | | ${KS.map(k => table[k].mean_files).join(' | ')} | ${table.default.mean_files} |`);
}

// The needle path shortlists 10 candidates before slicing to k, so k above 10
// cannot move it. Stated as a measurement, not as a reading of the source.
console.log('\n## By reading strategy, content recall (which strategies respond to k at all)\n');
const kinds = [...new Set(rows.map(r => r.at.default && r.at.default.kind).filter(Boolean))];
console.log('| strategy | n | ' + KS.map(k => '@' + k).join(' | ') + ' | shipped |');
console.log('|---|--:|' + KS.map(() => '--:').join('|') + '|--:|');
for (const kind of kinds) {
  const s = rows.filter(r => r.at.default && r.at.default.kind === kind);
  const c = KS.map(k => fmt(pct(s.filter(r => r.at[k] && r.at[k].content_hit).length, s.length)));
  console.log(`| ${kind} | ${s.length} | ${c.join(' | ')} | ${fmt(pct(s.filter(r => r.at.default.content_hit).length, s.length))} |`);
}

// Gold coverage: the fraction of a question's gold sessions present, not just
// whether one of them is. Multi-session questions have several, and answering
// from one of three is a different failure from answering from three of three.
console.log('\n## Gold coverage at k (mean fraction of a question\'s gold sessions whose content arrived)\n');
console.log('| category | n | ' + KS.map(k => '@' + k).join(' | ') + ' | shipped |');
console.log('|---|--:|' + KS.map(() => '--:').join('|') + '|--:|');
const meanOf = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
for (const t of ORDER) {
  const s = rows.filter(r => r.type === t);
  const c = [...KS, 'default'].map(k => fmt(100 * meanOf(s.map(r => (r.at[k] && r.at[k].content_coverage) || 0))));
  console.log(`| ${LABEL[t]} | ${s.length} | ${c.join(' | ')} |`);
}
{
  const c = [...KS, 'default'].map(k => fmt(100 * meanOf(rows.map(r => (r.at[k] && r.at[k].content_coverage) || 0))));
  console.log(`| **Overall** | ${rows.length} | ${c.join(' | ')} |`);
}

fs.mkdirSync(path.dirname(JSONOUT), { recursive: true });
fs.writeFileSync(JSONOUT, JSON.stringify(out, null, 2));
console.log(`\nwritten to ${path.relative(ROOT, JSONOUT)}`);
