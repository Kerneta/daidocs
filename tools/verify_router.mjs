// Check what the question router does, to answer "did you tailor the system to the test?"
//   node tools/verify_router.mjs [/path/longmemeval_s.json]
// LongMemEval publishes question_type (how a question was constructed), not a routing label,
// so there is no "correct" routing to measure against. goldRoute() below is OUR six-to-four
// mapping, invented for this check — every percentage here is agreement with that mapping,
// NOT with a benchmark label. Near-100% agreement would mean the router is reading the answer
// key; it cannot show whether the four strategies were themselves shaped by the benchmark.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const enginePath = path.join(here, '..', 'lib', 'methods', 'daidocs-reader', 'method.js');

// Pull classify() out of the engine source by brace-matching (aware of strings, comments and
// regex literals) so nested braces and CRLF can't truncate the span.
function extractFunction(text, header) {
  const start = text.indexOf(header);
  if (start < 0) return null;
  let depth = 0, str = null, line = false, block = false, re = false;
  for (let i = text.indexOf('{', start); i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (line) { if (c === '\n') line = false; continue; }
    if (block) { if (c === '*' && n === '/') { block = false; i++; } continue; }
    if (str) { if (c === '\\') i++; else if (c === str) str = null; continue; }
    if (re) {
      if (c === '\\') { i++; continue; }
      if (c === '[') { while (i < text.length && text[i] !== ']') { if (text[i] === '\\') i++; i++; } continue; }
      if (c === '/') re = false;
      continue;
    }
    if (c === '/' && n === '/') { line = true; i++; continue; }
    if (c === '/' && n === '*') { block = true; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { str = c; continue; }
    if (c === '/' && /[=(,:[!&|?{};+\-*%~^]\s*$/.test(text.slice(Math.max(0, i - 12), i))) { re = true; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

const src = fs.readFileSync(enginePath, 'utf8');
const fnSrc = extractFunction(src, 'function classify(qtext, prefWide)');
if (!fnSrc) {
  console.error('could not locate classify() in the engine; has it been renamed?');
  process.exitCode = 2;
} else {

const classify = eval('(' + fnSrc.replace('function classify', 'function') + ')');

console.log('The router, read out of the shipped engine at');
console.log(`  ${path.relative(process.cwd(), enginePath)}\n`);
console.log(fnSrc.split(/\r?\n/).map(l => '    ' + l).join('\n'));
console.log('\nIt takes two arguments, as the signature above shows: the question text,');
console.log('and a boolean that widens the advice branch. Neither can carry a question type,');
console.log('nothing here can reach the dataset, and the engine has no other way to');
console.log('choose a strategy: no caller override, and no second model.\n');

const dataPath = process.argv[2];
if (!dataPath) {
  console.log('To measure agreement against our own mapping, pass the dataset:');
  console.log('  node tools/verify_router.mjs /path/to/longmemeval_s.json');
} else if (!fs.existsSync(dataPath)) {
  console.error('dataset not found:', dataPath);
  process.exitCode = 2;
} else {

// OUR mapping of LongMemEval's six construction types onto our four reading
// strategies. Not a benchmark label. Generous to the criticism: it credits a
// match wherever a reasonable person would call the two surfaces equivalent.
const goldRoute = t => {
  if (/preference/.test(t)) return 'advice';
  if (/temporal/.test(t)) return 'timeline';
  if (/multi-session/.test(t)) return 'tally';
  return 'lookup';
};

const ds = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
let agree = 0;
const confusion = new Map();
for (const q of ds) {
  const got = classify(q.question, true);
  const want = goldRoute(q.question_type || '');
  if (got === want) agree++;
  const k = `${want} -> ${got}`;
  confusion.set(k, (confusion.get(k) || 0) + 1);
}

const n = ds.length;
const pct = (agree / n * 100).toFixed(1);
console.log(`questions                          : ${n}`);
console.log(`agreement with OUR mapping         : ${pct}%  (${agree}/${n})`);
console.log(`routed differently                 : ${(100 - pct).toFixed(1)}%\n`);

console.log('where the router and our mapping disagree:');
[...confusion.entries()]
  .filter(([k]) => k.split(' -> ')[0] !== k.split(' -> ')[1])
  .sort((a, b) => b[1] - a[1])
  .forEach(([k, v]) => console.log(`  ${k.padEnd(30)} ${v}`));

console.log();
if (agree / n > 0.95) {
  console.log('AGREEMENT IS SUSPICIOUSLY HIGH. If the router were reading the answer');
  console.log('key, this is what it would look like. Investigate before publishing.');
  process.exitCode = 1;
} else {
  console.log(`The router disagrees with our own mapping on ${(100 - pct).toFixed(1)}% of questions`);
  console.log('and that is fine: it is classifying English, not reading a label.');
}

}
}
