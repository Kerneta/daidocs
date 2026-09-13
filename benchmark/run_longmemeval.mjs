#!/usr/bin/env node
// The LongMemEval-S adapter, published so the run's fairness is checkable. What to verify by
// reading it:
//   1. the engine gets the question TEXT and nothing else (question_type appears only in one
//      diagnostics-row line, after the answer is final);
//   2. gold fields are read in that one diagnostics row only (answer_session_ids for the
//      retrieval-hit check); q.answer is never read;
//   3. no router here — the engine chooses its own strategy and the adapter can't override it;
//   4. no per-question branching: all 500 go through the same path with the same options {}.
//
// Usage: node benchmark/run_longmemeval.mjs --data <longmemeval_s.json> [--actor …]
//   [--observer …] [--limit 500] [--concurrency 8] [--out results/lme]
// Outputs (<out>.hypotheses.jsonl for the authors' evaluate_qa.py, .rows.jsonl diagnostics,
// .stores/ ingest cache) are appended per question and resumed from, so an interrupted run
// never loses paid work.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const engine = require('../lib/methods/daidocs-v44n/method');
const { getProviders } = require('../lib/providers');
const { TOKENIZER_ID } = require('../lib/tokens');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

const DATA = arg('data', null);
const LIMIT = parseInt(arg('limit', '500'), 10);
// Ingest calls in flight. 8 is polite; raise it if your rate limit allows, since
// a 500-question run is roughly 19,000 ingests and this sets the wall clock.
const POOL = parseInt(arg('concurrency', '8'), 10);
const OUT = arg('out', path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'results', 'lme'));

if (!DATA || !fs.existsSync(DATA)) {
  console.error('pass --data /path/to/longmemeval_s.json (obtain it from the benchmark authors)');
  process.exitCode = 2;
} else {

const [actor] = getProviders([arg('actor', 'openai:gpt-4o')]);
const [observer] = getProviders([arg('observer', 'openai:gpt-4.1-mini')]);
for (const [who, p] of [['actor', actor], ['observer', observer]]) {
  if (typeof p.available === 'function' && !p.available()) {
    console.error(`${who} ${p.id}:${p.model} is not available: set the matching API key.`);
    process.exit(2);
  }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const STORES = `${OUT}.stores`;
fs.mkdirSync(STORES, { recursive: true });
// A provider with live === false is a mock. Its output must never be
// mistakable for a scored run, so it goes to differently named files.
const MOCK = (actor.live === false) || (observer.live === false);
if (MOCK) console.log('MOCK PROVIDER IN USE: writing to *.MOCK.* files; these cannot be scored as results.');
const HYP = `${OUT}${MOCK ? '.MOCK' : ''}.hypotheses.jsonl`;
const ROWS = `${OUT}${MOCK ? '.MOCK' : ''}.rows.jsonl`;

// Resume: anything already answered is skipped, so paid work is never repeated.
const done = new Set();
if (fs.existsSync(HYP)) {
  for (const l of fs.readFileSync(HYP, 'utf8').split('\n').filter(Boolean)) {
    try { done.add(JSON.parse(l).question_id); } catch { /* skip a torn line */ }
  }
  if (done.size) console.log(`resuming: ${done.size} questions already answered`);
}

// Run `worker` over `items` with at most `size` in flight, preserving order — one at a time
// would be the difference between two hours and eleven on a 500-question run.
async function pooledMap(items, worker, size = 8) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await worker(items[i], i); }
  }));
  return out;
}

// Transient failures (rate limits, 5xx, dropped sockets) are expected on a run
// this long and must not lose the work done so far.
async function withRetry(fn, tries = 6) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); }
    catch (err) {
      const msg = String(err && err.message);
      // Any 5xx is transient, including the Cloudflare codes (520 to 527) that
      // sit in front of the API and appear in nobody's documented error list,
      // which is exactly why enumerating individual status codes is a trap.
      const transient = /\b5\d\d\b|429|overloaded|rate limit|timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|UND_ERR/i.test(msg);
      if (!transient || isFatal(err) || attempt >= tries - 1) throw err;
      await new Promise(r => setTimeout(r, 2000 * 2 ** attempt));
    }
  }
}

const hash8 = s => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8);
const isoDate = d => {
  const m = String(d || '').match(/(\d{4})[/-](\d{2})[/-](\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '2023-01-01';
};

// One session becomes one .dai document. Cached on disk by content, so the
// observer is paid for exactly once per distinct session across all runs.
const renderSession = (turns, date) =>
  `[Chat session ${date}]\n` + turns.map(t => `${String(t.role).toUpperCase()}: ${t.content}`).join('\n');

const cachePath = (sessionId, raw) =>
  path.join(STORES, `${hash8(`${engine.ingestSignature}:${observer.id}:${observer.model}:${sessionId}:${raw.length}`)}.json`);

function cachedStore(sessionId, raw) {
  const key = cachePath(sessionId, raw);
  if (!fs.existsSync(key)) return null;
  try { return JSON.parse(fs.readFileSync(key, 'utf8')); } catch { return null; }
}

async function ingestSession(sessionId, turns, date) {
  const raw = renderSession(turns, date);
  const hit = cachedStore(sessionId, raw);
  if (hit) return hit;
  const res = await withRetry(() => engine.ingest({
    id: sessionId, sourceId: sessionId, type: 'chat',
    title: `Chat session on ${date}`, capturedAt: date, raw,
  }, observer));
  fs.writeFileSync(cachePath(sessionId, raw), JSON.stringify(res));
  return res;
}

// A dead key or quota wall should stop the run immediately (not grind through logging the
// same failure); everything answered is on disk, and rerunning resumes from there.
const isFatal = err => /insufficient_quota|billing|credit balance|exceeded your current quota|Incorrect API key|invalid_api_key|account is not active/i.test(String(err && err.message));
function stopFatal(err, at) {
  console.error(`\nSTOPPED at question ${at}: ${String(err.message).replace(/\s+/g, ' ').slice(0, 200)}`);
  console.error(`\n${done.size} of ${LIMIT} questions are answered and saved:`);
  console.error(`  ${HYP}`);
  console.error(`  ${ROWS}`);
  console.error(`Ingested stores are cached in ${STORES} and will not be paid for again.`);
  console.error(`Top the account up, then rerun the SAME command: it resumes from what is on disk.`);
  process.exit(3);
}

const ds = JSON.parse(fs.readFileSync(DATA, 'utf8')).slice(0, LIMIT);
fs.writeFileSync(`${OUT}.run.json`, JSON.stringify({
  engine: engine.id, engine_version: engine.version, ingest_signature: engine.ingestSignature,
  actor: `${actor.id}:${actor.model}`, observer: `${observer.id}:${observer.model}`,
  tokenizer: TOKENIZER_ID, dataset: path.basename(DATA), questions: ds.length,
  mock: MOCK, started: new Date().toISOString(),
}, null, 2));
console.log(`${ds.length} questions | actor ${actor.id}:${actor.model} | observer ${observer.id}:${observer.model} | ingest concurrency ${POOL}`);

// PHASE 1: ingest every distinct session once, in one global pool. Sessions are shared across
// questions; pooling per-question would cap concurrency at one haystack (~50), so pool across
// the whole corpus to keep it full.
const pending = new Map();
for (const q of ds) {
  if (done.has(q.question_id)) continue;
  for (let i = 0; i < q.haystack_sessions.length; i++) {
    const sid = q.haystack_session_ids[i];
    if (pending.has(sid)) continue;
    const date = isoDate(q.haystack_dates[i]);
    const raw = renderSession(q.haystack_sessions[i], date);
    if (cachedStore(sid, raw)) continue;
    pending.set(sid, { turns: q.haystack_sessions[i], date });
  }
}

if (pending.size) {
  console.log(`phase 1: ingesting ${pending.size.toLocaleString()} sessions not yet cached, ${POOL} at a time`);
  const items = [...pending.entries()];
  const t0 = Date.now();
  let built = 0, failed = 0, fatal = null;
  const firstErrors = [];

  // One session failing must not abandon the other eighteen thousand. Errors
  // are caught per item; only a fatal one (dead key, no credit) stops the pool,
  // and it does so by flagging rather than throwing, so in-flight work lands.
  await pooledMap(items, async ([sid, v]) => {
    if (fatal) return;
    try {
      await ingestSession(sid, v.turns, v.date);
      built++;
      if (built % 500 === 0) {
        const per = (Date.now() - t0) / built;
        console.log(`  ${built.toLocaleString()}/${items.length.toLocaleString()} sessions, about ${Math.round((items.length - built) * per / 60000)} min left`);
      }
    } catch (err) {
      if (isFatal(err)) { fatal = err; return; }
      failed++;
      if (firstErrors.length < 5) firstErrors.push(`${sid}: ${String(err.message).replace(/\s+/g, ' ').slice(0, 110)}`);
    }
  }, POOL);

  if (fatal) stopFatal(fatal, `ingest, ${built} of ${items.length} sessions built`);
  console.log(`phase 1 done: ${built.toLocaleString()} sessions in ${Math.round((Date.now() - t0) / 60000)} min${failed ? `, ${failed} failed` : ''}`);
  if (failed) {
    console.log('  first failures:');
    firstErrors.forEach(e => console.log(`    ${e}`));
    console.log('  Sessions that failed here are retried on demand in phase 2.');
  }
} else {
  console.log('phase 1: every session already cached, nothing to ingest');
}

// PHASE 2: answer. Stores are assembled from the cache, so this makes one actor call per
// question plus one embedding call to rank the scan (a second on tally/advice reads).
console.log(`phase 2: answering ${ds.length - done.size} remaining questions`);
const started = Date.now();
let n = 0, answered = 0;
for (const q of ds) {
  n++;
  if (done.has(q.question_id)) continue;

  // Build this question's store. sessionOf maps the engine's document id
  // (<type>_<date>_<hash>) back to the benchmark's session id, so the diagnostics row can
  // report retrieval hit (comparing the two ids directly would make it false for every question).
  const store = { files: {} };
  const sessionOf = new Map();
  let ingested;
  try {
    ingested = await pooledMap(
      q.haystack_sessions.map((_, i) => i),
      async (i) => ({
        sid: q.haystack_session_ids[i],
        res: await ingestSession(q.haystack_session_ids[i], q.haystack_sessions[i], isoDate(q.haystack_dates[i])),
      }),
      POOL
    );
  } catch (err) {
    if (isFatal(err)) stopFatal(err, n);
    console.error(`  ${q.question_id}: ingest failed, skipping. ${String(err.message).slice(0, 120)}`);
    continue;
  }
  // Assembled in input order, not completion order, so the store is identical
  // whatever order the network happens to return things in.
  for (const { sid, res } of ingested) {
    for (const f of res.files) {
      if (f.path.startsWith('_index/')) {
        store.files[f.path] = (store.files[f.path] || '') + f.content;
        if (f.path === '_index/manifest.jsonl') {
          try { sessionOf.set(JSON.parse(f.content).id, sid); } catch { /* skip */ }
        }
      } else store.files[f.path] = f.content;
    }
  }

  // THE ONLY THING THE ENGINE RECEIVES. Question text plus the asked-on date,
  // which a real user's clock supplies and which every ordering question needs.
  // No question_type, no answer, no gold session ids, no strategy hint.
  const question = { text: `${q.question} (asked on ${isoDate(q.question_date)})` };

  let r;
  try {
    r = await withRetry(() => engine.answerMulti(question, store, actor, {}));
  } catch (err) {
    if (isFatal(err)) stopFatal(err, n);
    console.error(`  ${q.question_id}: ${String(err.message).slice(0, 140)}`);
    continue;
  }

  // Checkpoint immediately: one paid answer, one line on disk, before anything
  // else can go wrong.
  fs.appendFileSync(HYP, JSON.stringify({ question_id: q.question_id, hypothesis: r.answer }) + '\n');

  // Diagnostics only. This is the first and only point at which the gold
  // question_type is read, and the answer above is already final.
  fs.appendFileSync(ROWS, JSON.stringify({
    question_id: q.question_id,
    type: q.question_type,
    sessions: q.haystack_sessions.length,
    strategy: r.kind,
    context_tokens: r.contextTokens,
    files_read: (r.pickedIds || []).length,
    tokenizer: TOKENIZER_ID,
    retrieval_hit: (() => {
      const picked = new Set((r.pickedIds || []).map(id => sessionOf.get(id)).filter(Boolean));
      return (q.answer_session_ids || []).some(id => picked.has(id));
    })(),
  }) + '\n');

  answered++;
  done.add(q.question_id);
  if (answered % 5 === 0 || n === ds.length) {
    const per = (Date.now() - started) / answered;
    const left = Math.round((ds.length - n) * per / 60000);
    console.log(`  ${n}/${ds.length} answered, ${(per / 1000).toFixed(1)}s each, about ${left} min left`);
  }
}

const unanswered = ds.filter(q => !done.has(q.question_id));
if (unanswered.length) {
  console.error(`\nINCOMPLETE: ${unanswered.length} of ${ds.length} questions have no answer on disk.`);
  console.error(`  first missing: ${unanswered.slice(0, 5).map(q => q.question_id).join(', ')}`);
  console.error(`  Rerun the same command to fill them. Do not score a partial file: the`);
  console.error(`  denominator of every published figure is the full subset.`);
  process.exitCode = 4;
}
console.log(`\ndone. ${answered} answered this run; ${done.size} of ${ds.length} on disk.`);
console.log(`hypotheses: ${HYP}`);
console.log(`\nScore it with the benchmark authors' own evaluator, not ours:`);
console.log(`  python evaluate_qa.py gpt-4o ${HYP} <path-to>/longmemeval_s.json`);

}
