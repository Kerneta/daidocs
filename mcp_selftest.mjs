// Self-test for the DaiDocs MCP server: spawns it over stdio exactly as Claude
// would, saves a sample conversation, then verifies recall returns context
// containing the saved facts. Costs ~$0.002 (one gpt-4.1-mini ingest + router).
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

const save = await client.callTool({ name: 'save_memory', arguments: { title: 'Valletta trip planning chat', content: sample, date: '2026-07-20', type: 'chat' } });
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

console.log(`\n${pass} pass, ${fail} fail`);
await client.close();
process.exit(fail ? 1 : 0);
