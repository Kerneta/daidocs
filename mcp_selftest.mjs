// Self-test for the DaiDocs MCP server: spawns it over stdio exactly as Claude
// would, saves a sample conversation, then verifies recall returns context
// containing the saved facts. Runs offline: no API key, no cost, because the
// extraction is supplied inline (see "understanding" below).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const storeDir = process.env.DAIDOCS_STORE || path.join(here, '.selftest-store');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(here, 'mcp_server.mjs')],
  env: { ...process.env, DAIDOCS_STORE: storeDir },
});
const client = new Client({ name: 'selftest', version: '0.0.1' });
await client.connect(transport);

const tools = await client.listTools();
console.log('tools:', tools.tools.map(t => t.name).join(', '));

const sample = `[USER]: I finally booked the summer trip! Flying to Valletta on August 14th, staying at the Casa do Rio guesthouse near the harbour for 6 nights. Cost me €780 total with the early-bird discount.
[ASSISTANT]: That sounds wonderful! Valletta in August is vibrant. Would you like packing suggestions or day-trip ideas?
[USER]: Day trips please. Also remind me later: my passport expires November 3rd this year, I must renew it BEFORE the trip since Portugal needs 3 months validity.
[ASSISTANT]: Noted on the passport. For day trips: Sintra with the Pena Palace is the classic, Cascais for beaches, and Óbidos for the medieval walls.
[USER]: Sintra it is. Booking the 9am train from Rossio on the 16th.`;

// The extraction the observer would produce, written out here so the self-test runs
// with no API key and no cost: save_memory takes "understanding" and skips the observer
// entirely. Without it, a clean clone with no OPENAI_API_KEY gets an isError from
// save_memory, writes nothing, and every recall below fails for a reason that has
// nothing to do with the code under test.
const understanding = {
  entities: { people: [], orgs: ['Casa do Rio'], dates: ['2026-08-14', '2026-11-03', '2026-08-16'], amounts: ['\u20ac780'], places: ['Valletta', 'Sintra', 'Rossio'] },
  actions: ['booked the summer trip', 'booked the 9am train from Rossio'],
  facts: [
    { fact: 'Flying to Valletta on August 14th', date: '2026-08-14', kind: 'plan' },
    { fact: 'Staying at the Casa do Rio guesthouse near the harbour for 6 nights', date: '2026-08-14', kind: 'plan' },
    { fact: 'The trip cost 780 euros in total with the early-bird discount', date: '2026-07-20', kind: 'attribute' },
    { fact: 'The passport expires November 3 and must be renewed before the trip', date: '2026-11-03', kind: 'attribute' },
    { fact: 'Booked the 9am train from Rossio to Sintra on the 16th', date: '2026-08-16', kind: 'plan' },
  ],
  events: [
    { date: '2026-08-14', cat: 'travel', what: 'Flight to Valletta' },
    { date: '2026-08-16', cat: 'travel', what: 'Train to Sintra' },
  ],
  preferences: ['prefers day trips over packing advice'],
  tags: ['travel'],
  decisions: ['Chose Sintra for the day trip'],
  topics: ['summer trip planning'],
  summary: 'Booked a Valletta trip for August 14th, 6 nights at Casa do Rio for 780 euros, passport expires November 3 and needs renewing first, day trip to Sintra by the 9am Rossio train on the 16th.',
  sentiment: 'positive',
  open_questions: ['When exactly will the passport be renewed?'],
};

const save = await client.callTool({ name: 'save_memory', arguments: { title: 'Valletta trip planning chat', content: sample, date: '2026-07-20', type: 'chat', understanding } });
console.log('\nsave_memory ->', save.content[0].text.slice(0, 200));

const list = await client.callTool({ name: 'list_memories', arguments: {} });
console.log('\nlist_memories ->', list.content[0].text.slice(0, 300));

let pass = 0, fail = 0;
for (const [q, expects] of [
  ['When does my passport expire and why does it matter for my trip?', ['november 3', 'passport']],
  ['How much did the Valletta trip cost me?', ['780']],
  ['Which guesthouse am I staying at in Valletta?', ['casa do rio']],
]) {
  const r = await client.callTool({ name: 'recall_memory', arguments: { question: q } });
  const ctx = r.content[0].text.toLowerCase();
  const ok = expects.every(e => ctx.includes(e));
  console.log(`\nrecall: "${q}" -> ${ok ? 'PASS' : 'FAIL'} (${ctx.length} chars)`);
  if (!ok) { console.log(ctx.slice(0, 600)); fail++; } else pass++;
}
// Store integrity: recall passing doesn't prove the store on disk is well formed. Each check
// below asserts something that was silently broken at some point.
console.log('\nstore integrity:');
const daiFiles = fs.readdirSync(storeDir).filter(f => f.endsWith('.dai'));
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ' -> ' + detail}`);
  if (ok) pass++; else fail++;
};

check('a .dai file was written', daiFiles.length > 0, `found ${daiFiles.length}`);

for (const f of daiFiles) {
  const body = fs.readFileSync(path.join(storeDir, f), 'utf8');

  // The raw: pointer is the losslessness guarantee, and it once named a missing file.
  const raw = (body.match(/^raw: "([^"]+)"/m) || [])[1];
  check(`${f}: raw: pointer resolves`, !!raw && fs.existsSync(path.join(storeDir, raw)),
    raw ? `${raw} is missing from disk` : 'no raw: field');

  // Segment headers are parsed by an exact regex; a mismatch yields zero
  // verbatim excerpts with no error raised anywhere.
  const declared = Number((body.match(/^messages: (\d+)/m) || [])[1]);
  const parsed = [...body.matchAll(/## \[seg \d+\/\d+\]\n/g)].length;
  check(`${f}: segments parse back`, parsed > 0 && (!declared || parsed === declared),
    `frontmatter says ${declared}, regex parses ${parsed}`);

  check(`${f}: format marker present`, /^daidocs: "[\d.]+"/m.test(body), 'no daidocs: version marker');
}

// Every provider must expose available() — save_memory and the archiver call it.
const { createRequire } = await import('module');
const require_ = createRequire(import.meta.url);
const { getProviders } = require_('./lib/providers');
for (const spec of ['mock:mock', 'openai:gpt-4.1-mini']) {
  let ok = false, why = '';
  try { ok = typeof getProviders([spec])[0].available === 'function'; }
  catch (e) { why = e.message; }
  check(`provider contract: ${spec.split(':')[0]} implements available()`, ok, why);
}

// A caller-supplied understanding is written into the .dai and the indexes as-is, so it
// must be redacted like the content is. A fake key in the title, a fact and the summary
// must appear nowhere in the store afterwards.
console.log('\nredaction of caller-supplied fields:');
const secret = 'sk-proj-' + 'Q'.repeat(44);
const leakyU = {
  ...understanding,
  facts: [{ fact: `The deploy key is ${secret}`, date: '2026-07-21', kind: 'attribute' }],
  summary: `Set up the deploy with key ${secret}.`,
};
await client.callTool({ name: 'save_memory', arguments: { title: `Deploy notes ${secret}`, content: 'Set up the deploy today.', date: '2026-07-21', type: 'note', understanding: leakyU } });
const leaked = [];
const walk = d => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (fs.readFileSync(p, 'utf8').includes(secret)) leaked.push(path.relative(storeDir, p));
  }
};
walk(storeDir);
check('a key in the title or understanding appears nowhere in the store', leaked.length === 0, leaked.join(', '));
check('the redacted fact is still stored', fs.readFileSync(path.join(storeDir, '_index', 'facts.jsonl'), 'utf8').includes('The deploy key is [OPENAI_KEY REDACTED'));

// Two different saves under the same title on the same day are two memories: the second
// once reused the first one's id and overwrote its original and its .dai.
console.log('\nsame title, same day, different content:');
const twinIds = [];
for (const marker of ['FIRST_ONLY_819', 'SECOND_ONLY_824']) {
  const r = await client.callTool({ name: 'save_memory', arguments: { title: 'Deployment decision', content: `Synthetic decision, marker ${marker}.`, date: '2026-07-22', type: 'note', understanding: { ...understanding, facts: [], events: [], summary: `Decision ${marker}` } } });
  twinIds.push((r.content[0].text.match(/memory: (\S+?) \(/) || [])[1]);
}
check('the two saves get different ids', twinIds[0] && twinIds[1] && twinIds[0] !== twinIds[1], twinIds.join(' vs '));
for (const [id, marker] of [[twinIds[0], 'FIRST_ONLY_819'], [twinIds[1], 'SECOND_ONLY_824']]) {
  const rawFile = path.join(storeDir, '_raw', `${id}.txt`);
  check(`the original holding ${marker} survives`, !!id && fs.existsSync(rawFile) && fs.readFileSync(rawFile, 'utf8').includes(marker));
}

console.log(`\n${pass} pass, ${fail} fail`);
await client.close();
process.exit(fail ? 1 : 0);
