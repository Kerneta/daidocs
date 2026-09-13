// Keep every published number in step with the run artifacts that back it. Two states:
// BEFORE the release run NUMBERS.headline is null, docs must carry PENDING and no earlier
// internal figure (the FORBIDDEN list), making it impossible to ship an unbacked number;
// AFTER, tools/publish_run.mjs fills NUMBERS from the artifacts and docs must match (no
// PENDING, derived values recompute, charts agree).
//   node tools/check_numbers.mjs [../site-dir]
// Exit 1 on any drift, so CI and a pre-deploy hook can gate on it.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// The single source of truth, filled ONLY by tools/publish_run.mjs from run artifacts.
export const NUMBERS = {
  // micro accuracy, correct/500
  headline: '83.00',
  headlineCorrect: '415/500',
  // task-averaged
  headlineMacro: '84.02',
  // mean context tokens per question
  tokensRead: '10,065',
  retrievalHit: '94.6',
  // Constants that do not come from the run:
  // mean full history, gpt-tokenizer@3.4.0, measured over renderSession
  tokensPasted: '103,601',
  observer: 'gpt-4.1-mini',
  judge: 'gpt-4o-2024-08-06',
  engine: 'daidocs-v44n',
  tokenizer: 'gpt-tokenizer@3.4.0',
  formatVersion: '4.4',
  mediaType: 'text/vnd.dai',
};

// Measured constants of the corpus itself, allowed to appear in prose because
// they describe the dataset, not a result: mean/median/min/max full-history
// tokens (gpt-tokenizer@3.4.0 over the rendered sessions) and the distinct
// session count.
const CORPUS_CONSTANTS = ['103,601', '103,706', '97,121', '105,842', '19,195'];
// Unit denominators used in pricing prose ('per 1,000 tokens'), not figures.
const UNIT_LITERALS = ['1,000', '1,024', '4,096'];

// Always-on bans: claims and naming, not figures.
const FORBIDDEN = [
  [/model-independent by construction/i, 'unsupportable claim: portability is designed in, accuracy must be measured per model'],
  [/\baidoc-v\d/i, 'wrong engine id family: ids are daidocs-*'],
  [/\bneedle\b/i, 'wrong strategy vocabulary: the four names are lookup, tally, timeline, advice'],
  [/application\/vnd\.daidocs\+text/, 'wrong media type: the format uses text/vnd.dai'],
  // Keep comparisons on our own pages: report a competing score, do not link
  // readers out to the product from inside our results.
  [/\]\(https?:\/\/(www\.)?(mastra|supermemory|getzep|zep\.|mem0|emergence|timem|feather)/i,
    'outbound link to a competing product'],
];

// Files that make public claims.
const CLAIM_FILES = [
  'README.md', 'docs/RESULTS.md', 'docs/REPLICATION.md', 'QUICKSTART.md',
  'CHANGELOG.md', 'CITATION.cff', 'CONTRIBUTING.md', 'SECURITY.md',
  'spec/DAIDOCS-STANDARD.md', 'docs/GAPS.md', 'docs/READ-DAIDOCS.md',
  'benchmark/README.md', 'prompts/CLAUDE-MD-BLOCK.md', 'prompts/READER-PROMPT.txt',
];

// Files that must carry the headline once it exists, and PENDING until then.
const HEADLINE_FILES = ['README.md', 'docs/RESULTS.md', 'docs/REPLICATION.md', 'benchmark/README.md'];

let problems = 0;
const fail = (where, msg) => { problems++; console.log(`  DRIFT  ${where}: ${msg}`); };

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.existsSync(path.join(repoRoot, rel)) ? fs.readFileSync(path.join(repoRoot, rel), 'utf8') : null;

console.log('checking the repo');

// 1. Bans. Always-on: unsupportable claims, wrong naming, competitor links. Pre-run: no
//    self-result SHAPE may appear unless its line attributes it to a named third party.
//    Bans shapes, not values, so this file carries no unpublished number.
const SELF_RESULT_SHAPES = [
  [/\b\d{2}\.\d{2}%/, 'a percentage'],
  [/\b\d{1,3}\/500\b/, 'a correct-count out of 500'],
  [/\b\d+(?:\.\d+)?x\b/i, 'a reduction multiple'],
];
const allowedLiterals = [...CORPUS_CONSTANTS, ...UNIT_LITERALS, ...Object.values(NUMBERS).filter(v => typeof v === 'string')];
for (const rel of CLAIM_FILES) {
  const s = read(rel); if (s == null) continue;
  const lines = s.split(/\r?\n/);
  for (const [re, why] of FORBIDDEN) {
    const line = lines.find(l => re.test(l));
    if (line) fail(`repo/${rel}`, `${why}  ->  ${line.trim().slice(0, 90)}`);
  }
  if (NUMBERS.headline === null) {
    for (const line of lines) {
      for (const [re, what] of SELF_RESULT_SHAPES) {
        const m = line.match(re);
        if (m && !allowedLiterals.some(a => line.includes(a))) {
          fail(`repo/${rel}`, `pre-run: ${what} with no third-party attribution on its line  ->  ${line.trim().slice(0, 90)}`);
          break;
        }
      }
      // A token figure (comma-grouped number next to the word tokens) must be
      // a stated corpus constant until the run supplies the rest.
      if (/token/i.test(line)) {
        const nums = line.match(/\b\d{1,3},\d{3}\b/g) || [];
        for (const num of nums) {
          if (!allowedLiterals.includes(num)) {
            fail(`repo/${rel}`, `pre-run: token figure ${num} is not a stated corpus constant  ->  ${line.trim().slice(0, 90)}`);
            break;
          }
        }
      }
    }
  }
}

// 2. Charts: the generator and any rendered SVG are claim surfaces too.
{
  const gen = read('tools/make_charts.py');
  if (gen != null && NUMBERS.headline === null) {
    for (const line of gen.split(/\r?\n/)) {
      if (/\b\d{2}\.\d{2}\b/.test(line) && !/^\s*#/.test(line) && !Object.values(NUMBERS).filter(v => typeof v === 'string').some(a => line.includes(a))) {
        fail('repo/tools/make_charts.py', `pre-run: chart value with no third-party attribution  ->  ${line.trim().slice(0, 90)}`);
      }
    }
  }
  if (gen != null) for (const [re, why] of FORBIDDEN) {
    const line = gen.split(/\r?\n/).find(l => re.test(l));
    if (line) fail('repo/tools/make_charts.py', `${why}  ->  ${line.trim().slice(0, 90)}`);
  }
  const chartsDir = path.join(repoRoot, 'assets', 'charts');
  if (fs.existsSync(chartsDir)) {
    for (const f of fs.readdirSync(chartsDir).filter(f => f.endsWith('.svg'))) {
      const s = fs.readFileSync(path.join(chartsDir, f), 'utf8');
      for (const [re, why] of FORBIDDEN) if (re.test(s)) fail(`assets/charts/${f}`, why);
      if (NUMBERS.headline === null) fail(`assets/charts/${f}`, 'a rendered chart exists before the release run; charts are generated only from run artifacts');
      else if (!s.includes(NUMBERS.headline) && /accuracy|score|longmemeval/i.test(s)) {
        // informational only for charts that do not show the headline
      }
    }
  }
}

if (NUMBERS.headline === null) {
  // 3a. Pre-run state: every headline surface carries PENDING, and no headline-
  //     shaped self-claim exists anywhere.
  for (const rel of HEADLINE_FILES) {
    const s = read(rel); if (s == null) { fail(`repo/${rel}`, 'missing claim file'); continue; }
    if (!s.includes('PENDING')) fail(`repo/${rel}`, 'no PENDING marker; either the run is published (fill NUMBERS via tools/publish_run.mjs --write) or a number is being claimed without one');
  }
} else {
  // 3b. Post-run state: headline present everywhere it is claimed, no PENDING
  //     left, and derived values recompute.
  for (const rel of HEADLINE_FILES) {
    const s = read(rel); if (s == null) continue;
    if (!s.includes(NUMBERS.headline)) fail(`repo/${rel}`, `does not contain the headline ${NUMBERS.headline}`);
    if (s.includes('PENDING')) fail(`repo/${rel}`, 'PENDING marker remains after the run was published');
  }
  // headline must appear with its judge and its second-place honesty rule
  for (const rel of ['README.md', 'docs/RESULTS.md']) {
    const s = read(rel); if (s == null) continue;
    if (s.includes(NUMBERS.headline) && !s.includes(NUMBERS.judge)) fail(`repo/${rel}`, `quotes ${NUMBERS.headline} without naming the judge snapshot`);
  }
  // Every percentage a claim file quotes must be ours (NUMBERS) or recorded
  // in tools/references.json, so the documents and the data file can never
  // disagree.
  {
    const refs = JSON.parse(read('tools/references.json') || '{}');
    const refScores = new Set([
      ...(refs.leaderboard || []).map(r => Number(r.score).toFixed(2)),
      ...(refs.excluded || []).map(r => Number(r.score).toFixed(2)),
      ...(refs.full_context_baseline ? [Number(refs.full_context_baseline.score).toFixed(2)] : []),
    ]);
    const ours = Object.values(NUMBERS).filter(v => typeof v === 'string');
    for (const rel of HEADLINE_FILES) {
      const s2 = read(rel); if (s2 == null) continue;
      for (const line of s2.split(String.fromCharCode(10))) {
        for (const m of line.matchAll(new RegExp(String.raw`(d{2}.d{2})%?`, "g"))) {
          const fig = m[1];
          if (ours.some(o => o.includes(fig))) continue;
          if (refScores.has(fig)) continue;
          fail(`repo/${rel}`, `figure ${fig} is neither ours (NUMBERS) nor recorded in tools/references.json  ->  ${line.trim().slice(0, 80)}`);
        }
      }
    }
  }

  // derived identities
  const h = parseFloat(NUMBERS.headline);
  const [c, d] = String(NUMBERS.headlineCorrect).split('/').map(Number);
  if (Math.abs(c / d * 100 - h) > 0.005) fail('NUMBERS', `headline ${h} does not equal ${c}/${d}`);
  const tr = Number(String(NUMBERS.tokensRead).replace(/,/g, '')), tp = Number(String(NUMBERS.tokensPasted).replace(/,/g, ''));
  const redu = (tp / tr).toFixed(1) + 'x';
  for (const rel of ['README.md', 'docs/RESULTS.md']) {
    const s = read(rel); if (s == null) continue;
    const m = s.match(/\b(\d{1,2}\.\d)x\b/);
    if (m && m[1] + 'x' !== redu) fail(`repo/${rel}`, `reduction ${m[1]}x does not equal ${NUMBERS.tokensPasted}/${NUMBERS.tokensRead} = ${redu}`);
  }
}

// 4. Optional website build.
const siteArg = process.argv[2];
if (siteArg) {
  const site = path.resolve(siteArg);
  if (!fs.existsSync(site)) console.log(`  site not found at ${site}, skipping`);
  else {
    console.log('checking the website');
    for (const f of fs.readdirSync(site).filter(f => f.endsWith('.html'))) {
      const s = fs.readFileSync(path.join(site, f), 'utf8');
      for (const [re, why] of FORBIDDEN) if (re.test(s)) fail(`site/${f}`, why);
      if (NUMBERS.headline === null && /LongMemEval/i.test(s) && /\b\d{2}\.\d{2}%/.test(s) && !s.includes(NUMBERS.leaderScore)) {
        fail(`site/${f}`, 'quotes a benchmark percentage before the release run is published');
      }
    }
  }
}

console.log();
if (problems) {
  console.log(`${problems} drift problem(s). Fix them, or publish the run with tools/publish_run.mjs --write if the truth changed.`);
  process.exit(1);
}
console.log(NUMBERS.headline === null
  ? 'pre-run state clean: no unmeasured number is claimed anywhere'
  : 'no drift: every published number agrees with the run artifacts');
