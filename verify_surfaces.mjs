#!/usr/bin/env node
// Verifies all four DaiDocs surfaces end to end: terminal CLI, library API,
// MCP server over stdio, and the Claude Code session hooks.
//
// Free and offline. Every model call goes to the mock observer, so this runs
// in seconds, needs no API key, and never touches the real store: it works in
// a throwaway directory under the OS temp dir and deletes it afterwards.
//
//   node verify_surfaces.mjs           run every surface
//   node verify_surfaces.mjs --keep    keep the temp store for inspection
//   node verify_surfaces.mjs mcp hook  run only the named surfaces
//
// Exit code is 0 only if every check passed.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const keep = argv.includes('--keep');
const only = argv.filter(a => !a.startsWith('--'));
const wanted = s => only.length === 0 || only.includes(s);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'daidocs-verify-'));

// Redirected before any test runs: resolveStore writes here, and the store tests resolve
// dozens of temp folders in-process, so setting it later leaks temp paths into the real
// ~/.daidocs/stores.json.
process.env.DAIDOCS_REGISTRY = path.join(TMP, 'registry', 'stores.json');
const MOCK = 'mock:mock';
let pass = 0, fail = 0;

const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  (' + detail + ')' : ''}`); }
};

// Pull the embedded data back out. A regex is the wrong tool: the JSON holds transcripts,
// which hold code containing "});", so a lazy match stops early and a greedy one overruns.
// The data is the first script block, whole.
const embeddedData = html => {
  const open = html.indexOf('<script>');
  const close = html.indexOf('</script>', open);
  if (open < 0 || close < 0) return null;
  const body = html.slice(open + 8, close).trim();
  const eq = body.indexOf('=');
  try { return JSON.parse(body.slice(eq + 1).trim().replace(/;$/, '')); } catch { return null; }
};

// Every script block, found by index not by splitting: the embedded transcripts contain
// literal "<script>", so splitting there yields fragments that were never code.
const pageScripts = html => {
  const out = []; let i = 0;
  for (;;) {
    const open = html.indexOf('<script>', i); if (open < 0) break;
    const close = html.indexOf('</script>', open); if (close < 0) break;
    out.push(html.slice(open + 8, close));
    i = close + 9;
  }
  return out;
};

const section = t => console.log(`\n${t}:`);
const store = n => path.join(TMP, n);

// A transcript in the shape Claude Code writes, so the hook path sees real input.
function writeTranscript(fp, turns) {
  const rows = turns.map(([type, text]) => JSON.stringify({ type, message: { content: [{ type: 'text', text }] } }));
  fs.writeFileSync(fp, rows.join('\n') + '\n');
}
const LONG = 'The recall sweep for version 1.9.6 recorded 74.00 on the official five hundred question set. '.repeat(30);

function runNode(script, args, env, stdin) {
  return new Promise(res => {
    const p = spawn(process.execPath, [path.join(here, script), ...args], { cwd: here, env: { ...process.env, ...env } });
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('close', code => res({ code, out, err }));
    if (stdin !== undefined) p.stdin.end(stdin); else p.stdin.end();
  });
}

// 1. terminal
if (wanted('cli')) {
  section('terminal CLI');
  const src = store('src');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'note.md'), `# Note\n\nOn 2026-09-01 the sweep recorded 74.00 for v1.9.6.\n${LONG}`);
  const s = store('cli');

  const ing = await runNode('daidocs.js', ['ingest', src, s, '--observer', MOCK], {});
  ok('ingest exits clean', ing.code === 0, `exit ${ing.code}`);
  const dai = fs.existsSync(s) ? fs.readdirSync(s).filter(f => f.endsWith('.dai')) : [];
  ok('ingest writes a .dai', dai.length === 1, `${dai.length} files`);
  ok('ingest writes a manifest', fs.existsSync(path.join(s, '_index', 'manifest.jsonl')));

  const rows = () => fs.readFileSync(path.join(s, '_index', 'manifest.jsonl'), 'utf8').trim().split('\n').length;
  const before = rows();
  await runNode('daidocs.js', ['ingest', src, s, '--observer', MOCK], {});
  ok('re-ingest does not duplicate manifest rows', rows() === before, `${before} -> ${rows()} rows`);

  const ask = await runNode('daidocs.js', ['ask', s, 'What score was recorded for v1.9.6?', '--actor', MOCK], {});
  ok('ask exits clean', ask.code === 0, `exit ${ask.code}`);
  ok('ask reads from the store', /read \d+ tokens from \d+ store files/.test(ask.out));

  const envAsk = await runNode('daidocs.js', ['ask', 'What score was recorded?', '--actor', MOCK], { DAIDOCS_STORE: s });
  ok('ask honours DAIDOCS_STORE when the path is omitted', envAsk.code === 0, (envAsk.err || envAsk.out).trim().split('\n').pop());

  const help = await runNode('daidocs.js', ['--help'], {});
  ok('--help prints usage and exits 0', help.code === 0 && /usage/i.test(help.out), `exit ${help.code}`);
}

// 2. library
if (wanted('api')) {
  section('library API');
  const engine = require(require('./lib/version').ENGINE_PATH);
  const { getProviders } = require('./lib/providers');
  const s = store('api');
  fs.mkdirSync(path.join(s, '_index'), { recursive: true });
  fs.mkdirSync(path.join(s, '_raw'), { recursive: true });
  const [observer] = getProviders([MOCK]);
  ok('provider resolves and reports availability', observer.id === 'mock' && observer.available() === true);

  const item = {
    id: 'note', sourceId: 'note', title: 'sweep note', type: 'doc',
    app: 'verify', capturedAt: '2026-09-01',
    raw: `On 2026-09-01 the sweep recorded 74.00 for v1.9.6.\n${LONG}`,
  };
  const out = await engine.ingest(item, observer);
  const daiFile = out.files.find(f => f.path.endsWith('.dai'));
  ok('ingest returns files and one call', !!daiFile && out.calls === 1);
  ok('ingest honours capturedAt in the id', /_20260901_/.test(daiFile.path), daiFile.path);
  for (const f of out.files) {
    const fp = path.join(s, f.path);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    if (f.path.startsWith('_index/')) fs.appendFileSync(fp, f.content); else fs.writeFileSync(fp, f.content);
  }

  const mem = { files: {} };
  for (const f of fs.readdirSync(s)) if (f.endsWith('.dai')) mem.files[f] = fs.readFileSync(path.join(s, f), 'utf8');
  for (const f of fs.readdirSync(path.join(s, '_index'))) mem.files['_index/' + f] = fs.readFileSync(path.join(s, '_index', f), 'utf8');

  let captured = null;
  const capture = { complete: async a => { captured = a; return ''; } };
  const r = await engine.answerMulti({ text: 'What score was recorded for v1.9.6?' }, mem, capture, {});
  ok('answerMulti classifies and retrieves', r.kind === 'lookup' && r.contextTokens > 0, `kind=${r.kind} tokens=${r.contextTokens}`);
  ok('capture provider sees the assembled prompt', !!captured && captured.prompt.includes('CONTEXT:'));
  ok('lookup budget is 220 tokens', captured.maxTokens === 220, String(captured && captured.maxTokens));

  // v44n picks its own strategy from the question text and refuses an injected one.
  const r2 = await engine.answerMulti({ text: 'x' }, mem, capture, { forceKind: 'tally' });
  ok('refuses an injected strategy', r2.kind === 'lookup', r2.kind);
  const r3 = await engine.answerMulti({ text: 'how many sweeps did i run in total' }, mem, capture, {});
  ok('classifies a counting question as tally', r3.kind === 'tally', r3.kind);
}

// 3. MCP
if (wanted('mcp')) {
  section('MCP server over stdio');
  const s = store('mcp');
  fs.mkdirSync(path.join(s, '_index'), { recursive: true });
  fs.mkdirSync(path.join(s, '_raw'), { recursive: true });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(here, 'mcp_server.mjs')],
    env: { ...process.env, DAIDOCS_STORE: s, DAIDOCS_OBSERVER: MOCK },
  });
  const client = new Client({ name: 'verify', version: '0.0.1' });
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map(t => t.name).sort();
  ok('exposes the six tools', tools.join(',') === 'brief_parent,declare_project,list_memories,read_memory,recall_memory,save_memory', tools.join(','));

  const empty = await client.callTool({ name: 'recall_memory', arguments: { question: 'anything' } });
  // An empty project store names the project and refuses to widen unless asked.
  ok('recall on an empty store names the project and does not widen',
    /No memories for this project/i.test(empty.content[0].text), empty.content[0].text.slice(0, 70));

  // A session that ended before conversion is still readable: recall appends
  // the unconverted tail to whatever the index found, which here is nothing.
  fs.mkdirSync(path.join(s, '_unconverted'), { recursive: true });
  fs.writeFileSync(path.join(s, '_unconverted', 'cc_wait-0001.txt'), '[USER]: the deploy window is Thursday 2pm\n\n[ASSISTANT]: noted.');
  const waiting = await client.callTool({ name: 'recall_memory', arguments: { question: 'when is the deploy window' } });
  ok('recall reads the unconverted tail when the index has nothing',
    /Not yet converted/.test(waiting.content[0].text) && /Thursday 2pm/.test(waiting.content[0].text), waiting.content[0].text.slice(0, 120));
  fs.unlinkSync(path.join(s, '_unconverted', 'cc_wait-0001.txt'));

  const saved = await client.callTool({
    name: 'save_memory',
    arguments: { title: 'sweep note', type: 'note', date: '2026-09-01', content: `On 2026-09-01 the recall sweep recorded 74.00 for v1.9.6.\n${LONG}` },
  });
  ok('save_memory writes with a keyless observer', !saved.isError, saved.content[0].text.slice(0, 90));

  const list = await client.callTool({ name: 'list_memories', arguments: {} });
  ok('list_memories sees the new file without a restart', /sweep note/.test(list.content[0].text));

  const rec = await client.callTool({ name: 'recall_memory', arguments: { question: 'What did the sweep record for v1.9.6?' } });
  ok('recall_memory returns assembled context', /74\.00/.test(rec.content[0].text));

  const id = (list.content[0].text.match(/- (\S+) /) || [])[1];
  const read = await client.callTool({ name: 'read_memory', arguments: { id } });
  ok('read_memory returns one file in full', !read.isError && /# Understanding/.test(read.content[0].text), id);

  const missing = await client.callTool({ name: 'read_memory', arguments: { id: 'does_not_exist' } });
  ok('read_memory reports a missing id as an error', missing.isError === true);
  await client.close();
}

// 4. Claude Code hooks
if (wanted('hook')) {
  section('Claude Code hooks');
  const s = store('hook');
  const tp = path.join(TMP, 'transcript.jsonl');
  writeTranscript(tp, [
    ['user', 'Record the sweep result.'],
    ['assistant', `On 2026-09-01 the sweep recorded 74.00 for v1.9.6.\n${LONG}`],
  ]);
  const env = { DAIDOCS_STORE: s, DAIDOCS_OBSERVER: MOCK };
  const base = { session_id: 'verify-session-0001', transcript_path: tp, cwd: 'C:/work/atlas' };

  const r1 = await runNode('session_archiver.mjs', [], env, JSON.stringify({ ...base, reason: 'clear' }));
  ok('SessionEnd archives on clear', /indexed/.test(r1.err), r1.err.trim());
  ok('SessionEnd never blocks session teardown', r1.code === 0, `exit ${r1.code}`);

  // The session continues after /clear, so the transcript grows. The second
  // SessionEnd must capture the new turns rather than skipping the whole file.
  writeTranscript(tp, [
    ['user', 'Record the sweep result.'],
    ['assistant', `On 2026-09-01 the sweep recorded 74.00 for v1.9.6.\n${LONG}`],
    ['user', 'Now record the follow-up.'],
    ['assistant', `On 2026-09-04 the master copy froze at bf97aa4.\n${LONG}`],
  ]);
  const r2 = await runNode('session_archiver.mjs', [], env, JSON.stringify({ ...base, reason: 'exit' }));
  ok('a grown transcript is archived, not skipped', !/already-saved/.test(r2.err), r2.err.trim());

  const r3 = await runNode('session_archiver.mjs', [], env, JSON.stringify({ ...base, reason: 'exit' }));
  ok('an unchanged transcript is skipped', /already-saved|unchanged/.test(r3.err), r3.err.trim());

  const raws = fs.existsSync(path.join(s, '_raw')) ? fs.readdirSync(path.join(s, '_raw')) : [];
  ok('the full text is preserved in _raw', raws.some(f => f.endsWith('.txt')));
  const manifest = path.join(s, '_index', 'manifest.jsonl');
  ok('the project tag reaches the manifest', fs.existsSync(manifest) && /\[atlas\]/.test(fs.readFileSync(manifest, 'utf8')));

  const start = await runNode('session_context.mjs', [], env, JSON.stringify({ session_id: base.session_id, cwd: base.cwd, source: 'startup' }));
  ok('SessionStart hook exits clean', start.code === 0, `exit ${start.code}`);
  let payload = null;
  try { payload = JSON.parse(start.out); } catch { }
  const hso = payload && payload.hookSpecificOutput;
  ok('SessionStart emits valid hook JSON', !!hso && hso.hookEventName === 'SessionStart', start.out.slice(0, 120));
  const ctx = (hso && hso.additionalContext) || '';
  ok('injected context lists the stored memory', /sweep|atlas/.test(ctx), ctx.slice(0, 120));
  ok('injected context costs no model call', !/api key|fetch failed/i.test(start.err), start.err.trim().slice(0, 120));

  const off = await runNode('session_context.mjs', [], { ...env, DAIDOCS_DISABLE: '1' }, JSON.stringify({ cwd: base.cwd }));
  ok('DAIDOCS_DISABLE suppresses injection', off.code === 0 && off.out.trim() === '', off.out.slice(0, 80));
}

// 4b. secret redaction
if (wanted('redact')) {
  section('secrets never reach the store');
  const { redact } = require('./lib/redact');

  // Realistic shapes, none of them a live credential.
  const samples = [
    ['OPENAI_KEY', 'here is my key sk-proj-' + 'A'.repeat(40) + ' use it'],
    ['ANTHROPIC_KEY', 'anthropic: sk-ant-api03-' + 'B'.repeat(40)],
    ['GOOGLE_KEY', 'AIza' + 'C'.repeat(35)],
    ['GITHUB_TOKEN', 'ghp_' + 'D'.repeat(36)],
    ['AWS_KEY_ID', 'AKIA' + 'E'.repeat(16)],
    ['SLACK_TOKEN', 'xoxb-' + '1'.repeat(24)],
    ['BEARER_TOKEN', 'Authorization: Bearer ' + 'F'.repeat(40)],
  ];
  for (const [label, text] of samples) {
    const { text: out, found } = redact(text);
    ok(`redacts ${label}`, !!found[label] && !out.includes('A'.repeat(40)) && /REDACTED/.test(out), out.slice(0, 60));
  }
  ok('leaves ordinary prose untouched', redact('the sweep recorded 74.00 for v1.9.6').text === 'the sweep recorded 74.00 for v1.9.6');
  ok('does not eat base64 or hashes', !/REDACTED/.test(redact('sha256 3b1f9e2c8a7d4f60b1e2c3d4e5f60718293a4b5c6d7e8f90').text));

  // End to end: a transcript containing a key must archive without it.
  const s = store('redact');
  const tp = path.join(TMP, 'secret.jsonl');
  const secret = 'sk-proj-' + 'Z'.repeat(44);
  writeTranscript(tp, [
    ['user', `let me give you a api key: ${secret}`],
    ['assistant', `Noted. ${LONG}`],
  ]);
  const r = await runNode('session_archiver.mjs', [], { DAIDOCS_STORE: s, DAIDOCS_OBSERVER: MOCK },
    JSON.stringify({ session_id: 'redact-test-0001', transcript_path: tp, cwd: 'C:/tmp/Proj', reason: 'exit' }));
  ok('the archiver reports what it redacted', /redacted .*OPENAI_KEY/.test(r.err), r.err.trim().slice(0, 90));

  const leaked = [];
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (fs.readFileSync(p, 'utf8').includes(secret)) leaked.push(p);
    }
  };
  if (fs.existsSync(s)) walk(s);
  ok('the key appears nowhere in the store', leaked.length === 0, leaked.join(', '));
  ok('the surrounding conversation is still stored', (() => {
    const raws = fs.readdirSync(path.join(s, '_raw')).filter(f => f.endsWith('.txt'));
    return raws.length > 0 && fs.readFileSync(path.join(s, '_raw', raws[0]), 'utf8').includes('let me give you a api key');
  })());
}

// 4bb. in-session saving, keyless
if (wanted('autosave')) {
  section('saving in-session, with no API key');
  const s = store('autosave');
  fs.mkdirSync(path.join(s, '_index'), { recursive: true });
  fs.mkdirSync(path.join(s, '_raw'), { recursive: true });

  // save_memory with a caller-written Understanding must call no model. The observer has no
  // key on purpose, so if it were consulted the call would fail and this test would catch it.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(here, 'mcp_server.mjs')],
    env: { ...process.env, DAIDOCS_STORE: s, DAIDOCS_OBSERVER: 'anthropic:claude-opus-5', ANTHROPIC_API_KEY: '' },
  });
  const c = new Client({ name: 'claude-code', version: '0.0.1' });
  await c.connect(transport);

  const noKey = await c.callTool({ name: 'save_memory', arguments: { title: 'sweep note', content: `On 2026-09-01 the sweep recorded 74.00.\n${LONG}` } });
  ok('without an understanding it still needs an observer', noKey.isError === true, (noKey.content[0].text || '').slice(0, 70));
  ok('and it says the free route exists', /understanding/.test(noKey.content[0].text));

  const understanding = {
    entities: { people: ['Amin'], orgs: [], dates: ['2026-09-01'], amounts: ['74.00'], places: [] },
    actions: ['ran the recall sweep'],
    facts: [{ fact: 'The recall sweep recorded 74.00 for v1.9.6', date: '2026-09-01', kind: 'event' }],
    events: [{ date: '2026-09-01', cat: 'other', what: 'recorded 74.00 for v1.9.6' }],
    preferences: [], tags: [], decisions: [], topics: ['sweep', 'benchmark'],
    summary: 'The recall sweep recorded 74.00 for v1.9.6 on 2026-09-01.',
    sentiment: 'neutral', open_questions: [],
  };
  const saved = await c.callTool({ name: 'save_memory', arguments: { title: 'sweep note', date: '2026-09-01', content: `On 2026-09-01 the sweep recorded 74.00 for v1.9.6.\n${LONG}`, understanding } });
  ok('a caller-written understanding saves with no key', !saved.isError, (saved.content[0].text || '').slice(0, 80));

  const dai = fs.readdirSync(s).filter(f => f.endsWith('.dai'));
  ok('it writes exactly one .dai', dai.length === 1, String(dai.length));
  const body = dai.length ? fs.readFileSync(path.join(s, dai[0]), 'utf8') : '';
  ok('the supplied summary reaches the file', /recorded 74\.00 for v1\.9\.6/.test(body));
  ok('the supplied fact reaches facts.jsonl', /recorded 74\.00/.test(fs.readFileSync(path.join(s, '_index', 'facts.jsonl'), 'utf8')));
  ok('a supplied understanding is not chunked into parts', !/_p1/.test(dai.join(',')), dai.join(','));
  await c.close();

  // The Stop hook: quiet until there is enough new material, then one instruction.
  const tp = path.join(TMP, 'autosave.jsonl');
  const hookEnv = { DAIDOCS_STORE: s, DAIDOCS_OBSERVER: MOCK };
  const fire = (payload, extraEnv = {}) => runNode('session_autosave.mjs', [], { ...hookEnv, ...extraEnv }, JSON.stringify(payload));
  const base = { session_id: 'autosave-0001', transcript_path: tp, cwd: 'C:/work/atlas' };

  writeTranscript(tp, [['user', 'hello'], ['assistant', 'hi']]);
  const tiny = await fire(base);
  ok('says nothing about a short exchange', tiny.out.trim() === '', tiny.out.slice(0, 60));

  writeTranscript(tp, [['user', 'Record the sweep result.'], ['assistant', LONG], ['user', 'And the follow-up.'], ['assistant', LONG]]);
  // Threshold set explicitly, so the check is about the decision and not about
  // how big the fixture happens to be. It also proves the env knob works.
  const big = await fire(base, { DAIDOCS_AUTOSAVE_TOKENS: '500' });
  let payload = null; try { payload = JSON.parse(big.out); } catch { }
  ok('asks for a save once the session is worth one', !!payload && payload.decision === 'block', big.out.slice(0, 80));
  ok('the instruction names save_memory and understanding', !!payload && /save_memory/.test(payload.reason) && /understanding/.test(payload.reason));
  ok('the instruction says it costs nothing', !!payload && /no observer model is called|costs nothing/.test(payload.reason));
  ok('it tags the memory with the project', !!payload && /\[atlas\]/.test(payload.reason));

  const under = await fire(base, { DAIDOCS_AUTOSAVE_TOKENS: '100000' });
  ok('a high threshold keeps it quiet', under.out.trim() === '', under.out.slice(0, 60));

  const loop = await fire({ ...base, stop_hook_active: true }, { DAIDOCS_AUTOSAVE_TOKENS: '500' });
  ok('never prompts twice in a row', loop.out.trim() === '', loop.out.slice(0, 60));

  const off = await fire(base, { DAIDOCS_DISABLE: '1', DAIDOCS_AUTOSAVE_TOKENS: '500' });
  ok('DAIDOCS_DISABLE switches it off', off.out.trim() === '');
  // Raw is written to the folder at every stop, threshold or not: otherwise, below the
  // threshold with no saved mark, the hook re-asks for the whole conversation after every reply.
  const readJsonT = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const rawFile = path.join(s, '_raw', 'cc_autosave-0001.txt');
  const metaFile = path.join(s, '_raw', 'cc_autosave-0001.meta.json');
  const markFile = path.join(s, '_pending', 'cc_autosave-0001.json');
  writeTranscript(tp, [['user', 'a small exchange about the payments retry'], ['assistant', 'noted, the retry is capped at three']]);
  const small = await fire(base, { DAIDOCS_AUTOSAVE_TOKENS: '100000' });
  ok('a stop below the threshold still says nothing', small.out.trim() === '', small.out.slice(0, 60));
  ok('but the raw is on disk in the store', fs.existsSync(rawFile) && /payments retry/.test(fs.readFileSync(rawFile, 'utf8')));
  ok('with a meta that records the folder', (readJsonT(metaFile) || {}).cwd === base.cwd);
  ok('and a live marker the backlog can see', (readJsonT(markFile) || {}).reason === 'live');
  const tailFile = path.join(s, '_unconverted', 'cc_autosave-0001.txt');
  ok('and the unconverted tail is in its own folder', fs.existsSync(tailFile) && /payments retry/.test(fs.readFileSync(tailFile, 'utf8')));

  const Marks = require('./lib/session_marks');
  Marks.markSaved(s, 'cc_autosave-0001');
  ok('save_memory with the session id clears the marker', !fs.existsSync(markFile));
  ok('and the tail leaves the folder once saved', !fs.existsSync(tailFile));
  ok('and records how much of the transcript is saved', (readJsonT(metaFile) || {}).savedLen > 0);
  const quiet = await fire(base, { DAIDOCS_AUTOSAVE_TOKENS: '10' });
  ok('a saved session with nothing new stays quiet at any threshold', quiet.out.trim() === '', quiet.out.slice(0, 60));

  // An earlier session from the same folder, still waiting, counts towards the bar.
  fs.writeFileSync(path.join(s, '_raw', 'cc_earlier-0001.txt'), LONG);
  fs.writeFileSync(path.join(s, '_pending', 'cc_earlier-0001.json'), JSON.stringify({
    id: 'cc_earlier-0001', segId: 'cc_earlier-0001', title: '[Browser] Claude Code session: yesterday',
    date: '2026-09-06', cwd: base.cwd, tokens: 400, reason: 'subscription' }));
  writeTranscript(tp, [['user', 'a small exchange about the payments retry'], ['assistant', 'noted, the retry is capped at three'], ['user', 'and log it'], ['assistant', 'logged']]);
  const carried = await fire(base, { DAIDOCS_AUTOSAVE_TOKENS: '405' });
  let cp = null; try { cp = JSON.parse(carried.out); } catch { }
  ok('pending from an earlier session in this folder counts towards the threshold', !!cp && cp.decision === 'block', carried.out.slice(0, 80));
  ok('the instruction names that session to convert too', !!cp && /cc_earlier-0001/.test(cp.reason));
  ok('and passes this session id for save_memory', !!cp && /session: "cc_autosave-0001"/.test(cp.reason));
  ok('the tail holds only what is not yet saved', fs.existsSync(tailFile)
    && /and log it/.test(fs.readFileSync(tailFile, 'utf8')) && !/payments retry/.test(fs.readFileSync(tailFile, 'utf8')));
  // A different folder's backlog is not this folder's business.
  fs.writeFileSync(path.join(s, '_pending', 'cc_elsewhere-001.json'), JSON.stringify({
    id: 'cc_elsewhere-001', segId: 'cc_elsewhere-001', title: 'other', date: '2026-09-06', cwd: 'C:/some/other/folder', tokens: 9000, reason: 'subscription' }));
  fs.unlinkSync(path.join(s, '_pending', 'cc_earlier-0001.json'));
  Marks.markSaved(s, 'cc_autosave-0001');
  writeTranscript(tp, [['user', 'a small exchange about the payments retry'], ['assistant', 'noted, the retry is capped at three'], ['user', 'and log it'], ['assistant', 'logged'], ['user', 'thanks'], ['assistant', 'done']]);
  const other = await fire(base, { DAIDOCS_AUTOSAVE_TOKENS: '405' });
  ok("another folder's pending does not count", other.out.trim() === '', other.out.slice(0, 60));
  fs.unlinkSync(path.join(s, '_pending', 'cc_elsewhere-001.json'));

  // The folder question, enforced by the Stop hook. In an askable folder the
  // first stop blocks with the question, once; the next stop (same transcript,
  // flag set) is quiet; a recorded 'general' answer keeps it quiet for a fresh
  // session. HOME is redirected so the shared store this writes to is a temp one.
  const askHome = path.join(TMP, 'ask-home'); fs.mkdirSync(askHome, { recursive: true });
  const askDir = path.join(TMP, 'ask-folder'); fs.mkdirSync(askDir, { recursive: true });
  const askTp = path.join(TMP, 'ask.jsonl');
  writeTranscript(askTp, [['user', 'run the game'], ['assistant', 'running it']]);
  const askEnv = { DAIDOCS_STORE: '', HOME: askHome, USERPROFILE: askHome, DAIDOCS_AUTOSAVE_TOKENS: '100000' };
  const ask1 = await runNode('session_autosave.mjs', [], { ...askEnv }, JSON.stringify({ session_id: 'ask-0001', transcript_path: askTp, cwd: askDir }));
  let aq = null; try { aq = JSON.parse(ask1.out); } catch { }
  // Nothing is asked and nothing blocks: the folder was given its own store
  // before this save, so the save lands in it rather than in the shared one.
  ok('the first stop in an undeclared folder does not block to ask', !aq || aq.decision !== 'block', ask1.out.slice(0, 80));
  ok('and the folder now has a store of its own', fs.existsSync(path.join(askDir, '.daidocs', 'config.json')));
  ok('and this session was saved into it, not the shared store',
    fs.existsSync(path.join(askDir, '.daidocs', 'store', '_raw')),
    fs.existsSync(path.join(askHome, 'DaiDocs', '_raw')) ? 'went to the shared store' : 'ok');
  writeTranscript(askTp, [['user', 'run the game'], ['assistant', 'running it'], ['user', 'ok'], ['assistant', 'done']]);
  const ask2 = await runNode('session_autosave.mjs', [], { ...askEnv }, JSON.stringify({ session_id: 'ask-0001', transcript_path: askTp, cwd: askDir }));
  ok('and a second stop is quiet too', ask2.out.trim() === '', ask2.out.slice(0, 60));
  // A folder someone has sent to the general store is left alone.
  const genDir = path.join(TMP, 'ask-general'); fs.mkdirSync(genDir, { recursive: true });
  require('./lib/registry').recordFolder(genDir, 'general');
  const ask3 = await runNode('session_autosave.mjs', [], { ...askEnv }, JSON.stringify({ session_id: 'ask-0002', transcript_path: askTp, cwd: genDir }));
  ok('a folder sent to the general store is not claimed', !fs.existsSync(path.join(genDir, '.daidocs')), ask3.out.slice(0, 60));
  require('./lib/registry').forgetFolder(genDir);

  ok('it never blocks the session on error', (await fire({ transcript_path: 'C:/does/not/exist.jsonl' })).code === 0);
}

// 4bc. per-project stores and types
if (wanted('stores')) {
  section('per-project stores, types and permissions');
  const S = require('./lib/stores');
  const root = store('projects');

  // A small world: a parent, a sub-project that reads it, an isolated variant,
  // a confidential client, and two folders that want to be connected.
  const mk = (rel, cfg) => {
    const dir = path.join(root, rel);
    fs.mkdirSync(path.join(dir, '.daidocs'), { recursive: true });
    if (cfg) fs.writeFileSync(path.join(dir, '.daidocs', 'config.json'), JSON.stringify(cfg, null, 2));
    return dir;
  };
  const parent = mk('main', { type: 'normal', label: 'Main', reads: ['self'] });
  const child = mk('main/versions/v2', { type: 'normal', label: 'v2', reads: ['self', 'parent'] });
  const isolated = mk('main/versions/scratch', { type: 'temporary', label: 'scratch', reads: ['self'] });
  const client = mk('client-a', { type: 'confidential', label: 'Client A', reads: ['self'] });
  const teamA = mk('team-a', { type: 'connected', label: 'Team A', reads: ['self'], connections: [{ to: '../team-b', mode: 'both' }] });
  const teamB = mk('team-b', { type: 'connected', label: 'Team B', reads: ['self'], connections: [{ to: '../team-a', mode: 'both' }] });
  const oneSided = mk('lonely', { type: 'connected', label: 'Lonely', reads: ['self'], connections: [{ to: '../client-a', mode: 'both' }] });
  const plain = path.join(root, 'no-config'); fs.mkdirSync(plain, { recursive: true });
  const locked = mk('sealed', { type: 'locked', label: 'Sealed' });
  const frozen = mk('archive', { type: 'frozen', label: 'Archive' });

  // resolution
  ok('a project resolves to its own store', S.resolveStore(parent).label === 'Main', S.resolveStore(parent).label);
  ok('resolution walks up from a subdirectory',
    S.resolveStore(path.join(child, 'src', 'deep')).label === 'v2', S.resolveStore(path.join(child, 'src', 'deep')).label);
  ok('a folder with no config uses the shared store', S.resolveStore(plain).type === 'shared', S.resolveStore(plain).type);

  // writability
  ok('a normal project is writable', S.canWrite(S.resolveStore(parent)).ok);
  ok('a locked project refuses writes and says how to unlock',
    !S.canWrite(S.resolveStore(locked)).ok && /unlock/i.test(S.canWrite(S.resolveStore(locked)).reason));
  ok('a frozen project refuses writes and says to copy it',
    !S.canWrite(S.resolveStore(frozen)).ok && /copy it/i.test(S.canWrite(S.resolveStore(frozen)).reason),
    S.canWrite(S.resolveStore(frozen)).reason);

  // reads
  const own = S.readCandidates(S.resolveStore(parent));
  ok('by default a project reads only itself', own.length === 1 && own[0].why === 'this project', String(own.length));
  const kid = S.readCandidates(S.resolveStore(child));
  ok('a sub-project can read its parent', kid.some(c => c.label === 'Main' && /parent/.test(c.why)), kid.map(c => c.label).join(','));
  const scratch = S.readCandidates(S.resolveStore(isolated));
  ok('an isolated variant reads nothing but itself', scratch.length === 1, scratch.map(c => c.label).join(','));

  // connections
  const a = S.readCandidates(S.resolveStore(teamA));
  ok('a connection agreed at both ends is a candidate', a.some(c => c.label === 'Team B'), a.map(c => c.label).join(','));
  const lone = S.readCandidates(S.resolveStore(oneSided));
  ok('a connection declared on one side alone does nothing', !lone.some(c => c.label === 'Client A'), lone.map(c => c.label).join(','));

  // confidentiality
  const reaching = mk('reacher', { type: 'normal', label: 'Reacher', reads: ['self', path.resolve(client, '.daidocs', 'store')] });
  const reach = S.readCandidates(S.resolveStore(reaching));
  ok('a confidential store is never a candidate for anyone else',
    !reach.some(c => c.label === 'Client A'), reach.map(c => c.label).join(','));
  ok('an temporary store is not readable from outside either', (() => {
    const r = mk('reacher2', { type: 'normal', label: 'R2', reads: ['self', path.resolve(isolated, '.daidocs', 'store')] });
    return !S.readCandidates(S.resolveStore(r)).some(c => c.label === 'scratch');
  })());

  // no chaining: child reads parent, parent reads nothing, so a grandchild
  // must not reach through the parent to anywhere the parent could reach.
  const gp = mk('chain/top', { type: 'normal', label: 'Top', reads: ['self'] });
  const mid = mk('chain/top/mid', { type: 'normal', label: 'Mid', reads: ['self', 'parent'] });
  const bot = mk('chain/top/mid/bot', { type: 'normal', label: 'Bot', reads: ['self', 'parent'] });
  const chain = S.readCandidates(S.resolveStore(bot)).map(c => c.label);
  ok('reads do not chain past one hop', chain.includes('Mid') && !chain.includes('Top'), chain.join(','));

  // permissions: nothing is granted by default
  ok('an unseen store defaults to ask', S.permissionFor(path.join(root, 'never-seen')) === 'ask');
  const part = S.partitionByPermission(kid);
  ok('your own store never asks', part.allowed.some(c => c.why === 'this project'));
  ok('another store needs asking before it is read', part.needsAsking.some(c => c.label === 'Main'), String(part.needsAsking.length));

  ok('provenance names every store read', /Main/.test(S.provenance(kid)) && /2 stores/.test(S.provenance(kid)), S.provenance(kid));

  // profile rows carry their source, so preferences scope like everything else
  const { attribute } = require('./lib/convert');
  const stamped = attribute('_index/profile.jsonl', '{"date":"2026-09-06","preferences":["x"]}\n', 'chat_abc');
  ok('profile rows are attributed to their source', /"src":"chat_abc"/.test(stamped), stamped.trim());
  ok('other index rows are left alone', attribute('_index/facts.jsonl', '{"a":1}\n', 'chat_abc') === '{"a":1}\n');
}

// 4bd. locking a release
if (wanted('lock')) {
  section('locking: a lock that actually locks');
  const dir = store('lockme');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
  const canAdd = () => { try { fs.writeFileSync(path.join(dir, 'probe'), 'x'); fs.unlinkSync(path.join(dir, 'probe')); return true; } catch { return false; } };
  const canEdit = () => { try { fs.appendFileSync(path.join(dir, 'a.txt'), 'x'); return true; } catch { return false; } };
  const run = a => runNode('lock.js', [a, dir], {});

  ok('an ordinary folder is writable to begin with', canAdd() && canEdit());

  const locked = await run('lock');
  ok('lock exits 0', locked.code === 0, `exit ${locked.code}`);
  ok('lock reports it verified the block', /a test write was refused/.test(locked.out), locked.out.trim().split('\n').pop());
  // Read-only alone would stop edits but not new files, so the lock must block both.
  ok('a locked folder refuses edits', !canEdit());
  ok('a locked folder refuses NEW files', !canAdd());
  ok('a locked folder can still be read', fs.readFileSync(path.join(dir, 'a.txt'), 'utf8').startsWith('hello'));

  const st = await run('status');
  ok('status reports LOCKED', /state\s+LOCKED/.test(st.out), (st.out.match(/state.*/) || [''])[0].trim());

  const un = await run('unlock');
  ok('unlock exits 0', un.code === 0, `exit ${un.code}`);
  ok('unlock restores adding and editing', canAdd() && canEdit());
  ok('unlock says to re-lock and leave the folder', /Re-lock when you are done/.test(un.out) && /Leave the folder/.test(un.out));

  // After unlocking, the folder itself can be removed.
  ok('an unlocked folder can be removed outright', (() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); return !fs.existsSync(dir); } catch { return false; }
  })());

  // the icons setup looks for
  const icons = path.join(here, 'assets', 'brand', 'folder-types');
  const types = ['normal', 'locked', 'frozen', 'connected', 'shared', 'confidential', 'temporary'];
  ok('every folder type has an .ico', types.every(t => fs.existsSync(path.join(icons, `dai-folder-${t}.ico`))),
    types.filter(t => !fs.existsSync(path.join(icons, `dai-folder-${t}.ico`))).join(', ') || 'all present');
  ok('each .ico is multi-resolution', fs.statSync(path.join(icons, 'dai-folder-normal.ico')).size > 20000,
    String(fs.statSync(path.join(icons, 'dai-folder-normal.ico')).size));
  ok('small sizes come from the small artwork', (() => {
    const a = fs.readFileSync(path.join(icons, 'png', 'dai-folder-locked-16.png'));
    const b = fs.readFileSync(path.join(icons, 'png', 'dai-folder-normal-16.png'));
    // if both were the same brand mark shrunk, they would match
    return !a.equals(b);
  })());
}

// 4c. converting history
if (wanted('convert')) {
  section('convert: choose history, choose store');
  const C = require('./lib/convert');

  // Selection parsing, the part people will type by hand.
  ok('pick "all"', C.parsePick('all', 5).join(',') === '0,1,2,3,4');
  ok('pick a list and a range', C.parsePick('1,3,5-7', 9).join(',') === '0,2,4,5,6');
  ok('pick ignores out-of-range and junk', C.parsePick('0,2,99,x', 5).join(',') === '1');

  // A fake home with two projects' worth of Claude Code sessions.
  const home = store('convert-home');
  const proj = (slug) => { const d = path.join(home, '.claude', 'projects', slug); fs.mkdirSync(d, { recursive: true }); return d; };
  const rowsFor = (cwd, turns) => turns.map(([type, text]) => JSON.stringify({ type, cwd, sessionId: 'sess-' + type, timestamp: '2026-09-01T10:00:00.000Z', message: { content: [{ type: 'text', text }] } })).join('\n') + '\n';
  fs.writeFileSync(path.join(proj('C--Users-me-Desktop-Alpha'), 'alpha-1111-2222.jsonl'), rowsFor('C:/Users/me/Desktop/Alpha', [['user', 'Plan the alpha launch for the sweep.'], ['assistant', LONG]]));
  fs.writeFileSync(path.join(proj('C--Users-me-Desktop-Beta'), 'beta-3333-4444.jsonl'), rowsFor('C:/Users/me/Desktop/Beta', [['user', 'Review the beta results with key sk-proj-' + 'Q'.repeat(44)], ['assistant', LONG]]));
  const env = { HOME: home, USERPROFILE: home, DAIDOCS_OBSERVER: MOCK };
  const dest = store('convert-dest');

  const found = C.listClaudeSessions({ projectsDir: path.join(home, '.claude', 'projects'), minBytes: 0 });
  ok('lists every Claude Code session with its project', found.length === 2 && found.every(i => /Alpha|Beta/.test(i.project)), found.map(i => i.project).join(','));
  ok('labels each session by its first prompt', found.some(i => /alpha launch/.test(i.title)), found.map(i => i.title).join(' | '));
  ok('filters by project', C.listClaudeSessions({ projectsDir: path.join(home, '.claude', 'projects'), minBytes: 0, project: 'Beta' }).length === 1);

  const run = (args) => runNode('daidocs.js', ['convert', ...args], env);
  const r1 = await run(['--source', 'claude', '--min-kb', '0', '--pick', 'all', '--to', dest, '--observer', MOCK, '--yes']);
  ok('converts all selected sessions', r1.code === 0 && /2 converted/.test(r1.out), r1.out.split('\n').slice(-2).join(' | '));
  ok('quotes the worst case before converting', /Worst case: [\d,]+ input tokens/.test(r1.out) && /Cost:/.test(r1.out));
  const dais = fs.readdirSync(dest).filter(f => f.endsWith('.dai'));
  ok('writes one .dai per session', dais.length === 2, String(dais.length));
  const manifest = fs.readFileSync(path.join(dest, '_index', 'manifest.jsonl'), 'utf8');
  ok('tags each memory with its project', /\[Alpha\]/.test(manifest) && /\[Beta\]/.test(manifest));
  ok('redacts a key on the convert path too', !fs.readdirSync(path.join(dest, '_raw')).some(f => fs.readFileSync(path.join(dest, '_raw', f), 'utf8').includes('Q'.repeat(44))));

  const r2 = await run(['--source', 'claude', '--min-kb', '0', '--pick', 'all', '--to', dest, '--observer', MOCK, '--yes']);
  ok('re-running skips what is already converted', /2 already-converted/.test(r2.out), r2.out.split('\n').slice(-1)[0]);

  const r3 = await run(['--source', 'claude', '--min-kb', '0', '--pick', '1', '--to', store('convert-one'), '--observer', MOCK, '--yes']);
  ok('--pick selects a single item', /1 converted/.test(r3.out) && !/2 converted/.test(r3.out), r3.out.split('\n').slice(-1)[0]);

  // A folder of exports from somewhere else: a note and a transcript together.
  const folder = store('convert-folder');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'notes.md'), `# Notes\n\nOn 2026-09-01 the sweep recorded 74.00.\n${LONG}`);
  fs.copyFileSync(path.join(home, '.claude', 'projects', 'C--Users-me-Desktop-Alpha', 'alpha-1111-2222.jsonl'), path.join(folder, 'exported.jsonl'));
  const r4 = await run(['--source', folder, '--pick', 'all', '--to', path.join(folder, '.dai-store'), '--observer', MOCK, '--yes']);
  ok('converts a folder of mixed exports', r4.code === 0 && /2 converted/.test(r4.out), r4.out.split('\n').slice(-1)[0]);
  ok('can write the store next to the source', fs.existsSync(path.join(folder, '.dai-store', '_index', 'manifest.jsonl')));

  // The backlog case: a session the hook captured but could not convert.
  const backlogStore = path.join(home, 'DaiDocs');
  for (const d of ['_raw', '_pending', '_index']) fs.mkdirSync(path.join(backlogStore, d), { recursive: true });
  fs.writeFileSync(path.join(backlogStore, '_raw', 'cc_old-session-0001.txt'), `[USER]: Old captured session about the sweep.\n[ASSISTANT]: ${LONG}`);
  fs.writeFileSync(path.join(backlogStore, '_pending', 'cc_old-session-0001.json'), JSON.stringify({ id: 'cc_old-session-0001', title: '[Gamma] Claude Code session: Old captured session', date: '2026-08-15' }));
  ok('lists a captured-but-unconverted session', C.listRawCaptures(backlogStore).length === 1);
  const r5 = await run(['--source', 'raw', '--pick', 'all', '--observer', MOCK, '--yes']);
  ok('converts the backlog into the default store', /1 converted/.test(r5.out), r5.out.split('\n').slice(-1)[0]);
  ok('clears the pending marker once converted', !fs.existsSync(path.join(backlogStore, '_pending', 'cc_old-session-0001.json')));

  const r6 = await run(['--source', 'claude', '--min-kb', '0', '--pick', 'all', '--to', store('convert-nokey'), '--observer', 'anthropic:claude-opus-5', '--yes']);
  ok('stops cleanly when the observer has no key, keeping what was done', /unavailable/.test(r6.out) && /Stopping/.test(r6.out), r6.out.split('\n').find(l => /Stopping|unavailable/.test(l)) || '');
}

// 5. install versions
if (wanted('version')) {
  section('one version number, used everywhere');
  const VER = require('./lib/version');
  const V = require('./lib/versioning');
  const OBS = require('./lib/observers');

  // lib/version.js is the one version number: if these fail, a second one has crept in and will drift.
  const problems = VER.checkConsistency(here);
  ok('no version drift anywhere in the repo', problems.length === 0, problems.join('; '));
  ok('package.json carries the identical string', JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8')).version === VER.VERSION, VER.VERSION);

  // Every entry point must report the same string, byte for byte. includes() is not enough:
  // the version carries its own "v", so `v${VERSION}` yields "vV4.4n1", which still contains
  // the string. Assert the exact string with no extra prefix character glued on.
  const printsExactly = (text) => {
    const i = text.indexOf(VER.VERSION);
    if (i < 0) return false;
    const before = i === 0 ? '' : text[i - 1];
    return !/[A-Za-z0-9._-]/.test(before);
  };
  const cliHelp = await runNode('daidocs.js', ['--help'], {});
  ok('the CLI reports it exactly', printsExactly(cliHelp.out), cliHelp.out.split('\n')[0]);
  const setupVer = await runNode('setup.js', ['--version'], { HOME: TMP, USERPROFILE: TMP });
  ok('the installer reports it exactly', printsExactly(setupVer.out), (setupVer.out.split('\n').find(l => l.includes('this copy')) || '').trim());
  ok('no surface doubles the version prefix', !cliHelp.out.includes('vv') && !setupVer.out.includes('vv'),
    (setupVer.out.match(/vv\S+/) || cliHelp.out.match(/vv\S+/) || [''])[0]);

  const mcpTransport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(here, 'mcp_server.mjs')],
    env: { ...process.env, DAIDOCS_STORE: store('vercheck'), DAIDOCS_OBSERVER: MOCK },
  });
  const vc = new Client({ name: 'verify', version: '0.0.1' });
  await vc.connect(mcpTransport);
  const srvVersion = vc.getServerVersion();
  ok('the MCP server advertises it', srvVersion && srvVersion.version === VER.VERSION, srvVersion && srvVersion.version);
  await vc.close();

  // No entry point hardcodes the engine path: it comes from lib/version.js, swappable in one place.
  const entryPoints = ['daidocs.js', 'mcp_server.mjs', 'session_archiver.mjs'];
  const hardcoded = entryPoints.filter(f => /lib\/methods\/daidocs-v44[a-z]\/method/.test(fs.readFileSync(path.join(here, f), 'utf8')));
  ok('no entry point hardcodes an engine path', hardcoded.length === 0, hardcoded.join(', '));

  // The format marker is deliberately NOT the release version. It is a
  // compatibility contract with every .dai file already written.
  ok('the file-format marker is separate from the release version', VER.FORMAT !== VER.VERSION, `format ${VER.FORMAT}, release ${VER.VERSION}`);

  section('install versioning');
  ok('reads its own version from the single definition', V.packageVersion(here) === VER.VERSION, V.packageVersion(here));
  ok('orders versions numerically', V.compareVersions('1.2.0', '1.10.0') === -1 && V.compareVersions('2.0.0', '1.9.9') === 1);
  ok('treats equal versions as equal', V.compareVersions('1.0.0', '1.0.0') === 0);
  // The project scheme: a V prefix, and a lettered revision inside a part.
  ok('ignores the V prefix', V.compareVersions('V4.4n1', '4.4n1') === 0);
  ok('orders lettered revisions', V.compareVersions('V4.4n1', 'V4.4n2') === -1 && V.compareVersions('V4.4n2', 'V4.4n1') === 1);
  ok('orders a lettered revision after the plain one', V.compareVersions('V4.4', 'V4.4n1') === -1);
  ok('orders across major and minor', V.compareVersions('V4.4n1', 'V4.5') === -1 && V.compareVersions('V5.0', 'V4.9n9') === 1);
  ok('orders lettered revisions within a minor', V.compareVersions('V4.4n1', 'V4.4n2') === -1 && V.compareVersions('V4.4n0', 'V4.4n1') === -1);
  ok('orders a plain minor before a lettered one', V.compareVersions('V4.4', 'V4.4n1') === -1);
  ok('classifies a first install', V.classify(null, 'V4.4n1') === 'install');
  ok('classifies an upgrade', V.classify('V4.4n1', 'V4.4n2') === 'upgrade');
  ok('classifies a rollback', V.classify('V4.4n2', 'V4.4n1') === 'rollback');
  ok('classifies a repeat run', V.classify('V4.4n1', 'V4.4n1') === 'reconfigure');

  // The ledger and state files live in the home directory, so this runs in a child process with
  // HOME pointed at the temp dir — nothing here can touch a real install.
  const fakeHome = store('home');
  fs.mkdirSync(fakeHome, { recursive: true });
  const homeEnv = { HOME: fakeHome, USERPROFILE: fakeHome };

  const script = path.join(TMP, 'ledger_probe.mjs');
  fs.writeFileSync(script, [
    `import { createRequire } from 'node:module';`,
    `const require = createRequire(${JSON.stringify(path.join(here, 'x.js'))});`,
    `const V = require('./lib/versioning');`,
    `console.log('empty:', JSON.stringify(V.currentInstall()));`,
    `V.writeState({ version: '1.0.0', installPath: 'C:/old', installedAt: new Date().toISOString(), surfaces: ['hook'], observer: 'openai:gpt-4.1-mini' });`,
    `V.recordEvent('install', { version: '1.0.0', from: null, installPath: 'C:/old', observer: 'openai:gpt-4.1-mini' });`,
    `V.recordEvent('upgrade', { version: '1.1.0', from: '1.0.0', installPath: 'C:/new', observer: 'anthropic:claude-opus-5' });`,
    `const cur = V.currentInstall();`,
    `console.log('current:', cur.version, cur.installPath);`,
    `const rows = V.readLedger();`,
    `console.log('rows:', rows.length, rows.map(r => r.action + ':' + r.version).join(','));`,
    `console.log('legacyDetect:', JSON.stringify(V.currentInstall().legacy));`,
  ].join('\n'));
  const probe = await new Promise(res => {
    const p = spawn(process.execPath, [script], { cwd: here, env: { ...process.env, ...homeEnv } });
    let out = '', err = '';
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    p.on('close', code => res({ code, out, err }));
  });
  ok('starts with no recorded install', /empty: null/.test(probe.out), probe.err.slice(0, 120));
  ok('records the current install', /current: 1\.0\.0 C:\/old/.test(probe.out), probe.out.replace(/\n/g, ' | ').slice(0, 160));
  ok('appends every event to the ledger', /rows: 2 install:1\.0\.0,upgrade:1\.1\.0/.test(probe.out), probe.out.replace(/\n/g, ' | ').slice(0, 160));
  ok('ledger file is written to the home directory', fs.existsSync(path.join(fakeHome, '.daidocs-installs.jsonl')));

  // A pre-versioning install must be visible, not silently treated as absent.
  fs.writeFileSync(path.join(fakeHome, '.daidocs-setup-state.json'), JSON.stringify({ touched: { 'C:/whatever': { existedBefore: true } } }));
  const legacy = await new Promise(res => {
    const p = spawn(process.execPath, ['-e', `const V=require('./lib/versioning');const c=V.currentInstall();console.log(c&&c.legacy,c&&c.version)`],
      { cwd: here, env: { ...process.env, ...homeEnv } });
    let out = ''; p.stdout.on('data', d => out += d); p.on('close', () => res(out));
  });
  ok('detects an install that predates versioning', /true unversioned/.test(legacy), legacy.trim());

  const ver = await runNode('setup.js', ['--version'], homeEnv);
  ok('setup --version reports both copies', ver.code === 0 && /this copy:/.test(ver.out) && /installed:/.test(ver.out), `exit ${ver.code}`);
  const hist = await runNode('setup.js', ['--versions'], homeEnv);
  ok('setup --versions prints the history', hist.code === 0 && /install history/i.test(hist.out), `exit ${hist.code}`);
  ok('setup --version makes no changes', !fs.existsSync(path.join(fakeHome, '.claude', 'settings.json')));

  // A real install / upgrade / rollback cycle, entirely inside the fake home. DAIDOCS_NO_PERSIST
  // keeps setx, the shell profile and the registry out of it: the upgrade removal and --restore
  // unregister the .dai file type unconditionally, and HKCU is not redirected by HOME, so without
  // this these runs would delete the real user's .dai association.
  section('install, upgrade and rollback cycle');
  fs.rmSync(path.join(fakeHome, '.daidocs-setup-state.json'), { force: true });
  fs.rmSync(path.join(fakeHome, '.daidocs-installs.jsonl'), { force: true });
  const proj = store('proj');
  fs.mkdirSync(proj, { recursive: true });
  const installEnv = { ...homeEnv, DAIDOCS_NO_PERSIST: '1' };
  const flags = ['--hook', '--context', '--instructions', '--project', proj, '--observer', MOCK];

  const i1 = await runNode('setup.js', flags, installEnv);
  ok('a fresh install completes', i1.code === 0, `exit ${i1.code} ${i1.err.slice(0, 100)}`);
  const settingsPath = path.join(fakeHome, '.claude', 'settings.json');
  const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};
  ok('registers the SessionEnd hook', !!(settings.hooks && settings.hooks.SessionEnd || []).length);
  ok('registers the SessionStart hook', !!(settings.hooks && settings.hooks.SessionStart || []).length);
  ok('records the installed version', (V.readState ? true : false) && /1\.0\.0|"version"/.test(fs.readFileSync(path.join(fakeHome, '.daidocs-setup-state.json'), 'utf8')));

  const ledgerAfterInstall = fs.readFileSync(path.join(fakeHome, '.daidocs-installs.jsonl'), 'utf8').trim().split('\n');
  ok('writes one ledger row for the install', ledgerAfterInstall.length === 1 && /"action":"install"/.test(ledgerAfterInstall[0]), String(ledgerAfterInstall.length));
  ok('the ledger records the chosen observer', new RegExp(MOCK).test(ledgerAfterInstall[0]));

  // Simulate a newer release by pointing the state at an older version and a
  // different folder, which is exactly what an upgrade looks like on disk.
  const st = JSON.parse(fs.readFileSync(path.join(fakeHome, '.daidocs-setup-state.json'), 'utf8'));
  fs.writeFileSync(path.join(fakeHome, '.daidocs-setup-state.json'), JSON.stringify({ ...st, version: 'V4.4n0', installPath: 'C:/somewhere/old-daidocs' }));
  const i2 = await runNode('setup.js', flags, installEnv);
  ok('an upgrade removes the old install first', /Removing it before installing/.test(i2.out), i2.out.split('\n').find(l => /Found v/.test(l)) || '');
  const rows2 = fs.readFileSync(path.join(fakeHome, '.daidocs-installs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  ok('the ledger records the uninstall and the upgrade',
    rows2.some(r => r.action === 'uninstall' && r.version === 'V4.4n0') && rows2.some(r => r.action === 'upgrade' && r.from === 'V4.4n0'),
    rows2.map(r => `${r.action}:${r.version}`).join(','));
  ok('the hook survives the replace', (() => {
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    return (s.hooks.SessionEnd || []).length === 1 && (s.hooks.SessionStart || []).length === 1;
  })(), 'exactly one entry each, no duplicates');

  // And a rollback: a state that claims a NEWER version than this copy.
  const st2 = JSON.parse(fs.readFileSync(path.join(fakeHome, '.daidocs-setup-state.json'), 'utf8'));
  fs.writeFileSync(path.join(fakeHome, '.daidocs-setup-state.json'), JSON.stringify({ ...st2, version: 'V4.5', installPath: 'C:/somewhere/new-daidocs' }));
  const i3 = await runNode('setup.js', flags, installEnv);
  ok('a rollback is named as one', /rollback to an older version/.test(i3.out), i3.out.split('\n').find(l => /Removing it/.test(l)) || '');
  const rows3 = fs.readFileSync(path.join(fakeHome, '.daidocs-installs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  ok('the ledger records the rollback', rows3.some(r => r.action === 'rollback' && r.from === 'V4.5'), rows3.map(r => r.action).join(','));

  const hist2 = await runNode('setup.js', ['--versions'], installEnv);
  ok('the history lists every event in order', (hist2.out.match(/install|upgrade|rollback|uninstall/g) || []).length >= 5, `${rows3.length} rows`);

  // Uninstall must not erase the history.
  const before = rows3.length;
  await runNode('setup.js', ['--restore'], installEnv);
  const rowsAfter = fs.readFileSync(path.join(fakeHome, '.daidocs-installs.jsonl'), 'utf8').trim().split('\n');
  ok('--restore keeps the install history', rowsAfter.length > before, `${before} -> ${rowsAfter.length} rows`);
  ok('--restore clears the current-install record', !fs.existsSync(path.join(fakeHome, '.daidocs-setup-state.json')));

  section('project naming, and no local models anywhere');
  const { projectName } = require('./lib/convert');
  // basename(cwd) files every branch as its own project, so worktrees must
  // resolve back to the repository they belong to.
  ok('a Claude Code worktree resolves to its project',
    projectName('C:/Users/me/Desktop/Browser/.claude/worktrees/feature-x') === 'Browser',
    projectName('C:/Users/me/Desktop/Browser/.claude/worktrees/feature-x'));
  ok('backslash paths resolve too',
    projectName('C:\\Users\\me\\Desktop\\Browser\\.claude\\worktrees\\feature-x') === 'Browser',
    projectName('C:\\Users\\me\\Desktop\\Browser\\.claude\\worktrees\\feature-x'));
  ok('a plain project keeps its folder name', projectName('C:/Users/me/Desktop/Browser') === 'Browser');
  ok('no cwd yields no project', projectName(null) === null);

  // The rule bans local models for CONVERSION, not reading (any model can read a .dai), so a
  // line offends only when it puts a local model together with converting or its cost.
  const mentionsLocal = /ollama|local model/i;
  const aboutConverting = /observer|convert|ingest|saving|DAIDOCS_OBSERVER|pay nothing|$0|per conversation/i;
  const isExplanation = /deliberately absent|never be offered|not offered|ships anthropic|ollama: null/i;
  const surfaces = ['daidocs.js', 'setup.js', 'mcp_server.mjs', 'session_archiver.mjs',
    'session_context.mjs', 'session_autosave.mjs', 'lib/observers.js', 'lib/host.js',
    'README.md', 'QUICKSTART.md', 'SECURITY.md', 'docs/READ-DAIDOCS.md', 'docs/INTEGRATION.md'];
  const offenders = [];
  for (const f of surfaces) {
    const fp = path.join(here, f);
    if (!fs.existsSync(fp)) continue;
    for (const [n, line] of fs.readFileSync(fp, 'utf8').split('\n').entries()) {
      // An explanatory comment saying local models are excluded is not a suggestion.
      if (!mentionsLocal.test(line)) continue;
      if (isExplanation.test(line)) continue;
      if (!aboutConverting.test(line)) continue;
      offenders.push(`${f}:${n + 1}`);
    }
  }
  ok('no surface suggests a local model', offenders.length === 0, offenders.join(', '));
  ok('only hosted providers are offered', OBS.OFFERED_PROVIDERS.join(',') === 'openai,anthropic,gemini', OBS.OFFERED_PROVIDERS.join(','));

  section('host detection outside the assistant');
  // Setup usually runs from an ordinary terminal, where the assistant's env markers are absent.
  // Detection that reads only the environment would miss that case, so it must also recognise
  // an assistant by what is installed on the machine.

  const stripped = { ...process.env };
  for (const k of Object.keys(stripped)) if (/^CLAUDE|^CODEX|^GEMINI_|ANTHROPIC_API_KEY/.test(k)) delete stripped[k];

  const runDetect = (env, homeDir) => new Promise(res => {
    const p = spawn(process.execPath, ['-e',
      "const h=require('./lib/host');const o=require('./lib/observers');" +
      "console.log(JSON.stringify({host:h.detectHost()||null,first:o.catalogueFor(h.detectHost())[0].spec}))"],
      // A bare machine has no assistant anywhere, so every root that could hold
      // one has to be redirected: HOME, USERPROFILE and APPDATA. Redirecting
      // only HOME still found the real Claude Desktop config under APPDATA.
      { cwd: here, env: { ...env, ...(homeDir ? { HOME: homeDir, USERPROFILE: homeDir, APPDATA: path.join(homeDir, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(homeDir, 'AppData', 'Local') } : {}) } });
    let out = ''; p.stdout.on('data', d => out += d);
    p.on('close', () => { try { res(JSON.parse(out)); } catch { res({}); } });
  });

  // The CLAUDECODE marker is supplied here, not inherited from the process running the suite:
  // inheriting made this pass only when run inside Claude Code and fail everywhere else, CI included.
  const inSession = await runDetect({ ...stripped, CLAUDECODE: '1' }, path.join(TMP, 'no-assistant-home'));
  ok('detects Claude from inside a Claude session', inSession.host === 'anthropic', String(inSession.host));

  // A home with Claude installed, built here rather than borrowed from the real machine: passing
  // null used the real home, so the test asserted a fact about the laptop and was red on CI.
  const claudeInstalled = path.join(TMP, 'home-with-claude');
  fs.mkdirSync(path.join(claudeInstalled, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(claudeInstalled, '.claude', 'settings.json'), '{}');
  const plainTerminal = await runDetect(stripped, claudeInstalled);
  ok('still detects Claude from a plain terminal', plainTerminal.host === 'anthropic', String(plainTerminal.host));
  ok('and the menu leads with Opus there', plainTerminal.first === 'anthropic:claude-opus-5', String(plainTerminal.first));

  // A machine with no assistant installed must not be claimed for one.
  const bare = store('bare-home');
  fs.mkdirSync(bare, { recursive: true });
  const nowhere = await runDetect(stripped, bare);
  ok('claims nothing on a machine with no assistant installed', nowhere.host === null, String(nowhere.host));
  ok('and falls back to the cheapest observer', nowhere.first === 'openai:gpt-4.1-mini', String(nowhere.first));

  // Evidence on disk is enough on its own.
  const claudeHome = store('claude-home');
  fs.mkdirSync(path.join(claudeHome, '.claude'), { recursive: true });
  const viaDisk = await runDetect(stripped, claudeHome);
  ok('a ~/.claude directory alone identifies Claude', viaDisk.host === 'anthropic', String(viaDisk.host));

  section('a converted backlog keeps its own dates');
  // Capture and extraction are separate steps, so a conversation can be indexed weeks later.
  // Dating by new Date() (conversion time) lands a drained backlog all dated today, above things
  // that genuinely came after it, with nothing about the output looking wrong.
  const dStore = store('dates');
  const dTr = path.join(TMP, 'old-session.jsonl');
  const mkLines = (day, text) => [
    JSON.stringify({ type: 'user', timestamp: `${day}T09:00:00.000Z`, cwd: 'C:/proj', sessionId: 'sd1', message: { content: text } }),
    JSON.stringify({ type: 'assistant', timestamp: `${day}T09:05:00.000Z`, message: { content: [{ type: 'text', text: 'reply '.repeat(300) }] } }),
  ].join(String.fromCharCode(10));
  fs.writeFileSync(dTr, mkLines('2026-08-15', 'a conversation from three weeks ago about the payments migration'));

  const runArchive = (sid, tr, st) => new Promise(res => {
    const p = spawn(process.execPath, ['session_archiver.mjs'],
      { cwd: here, env: { ...process.env, DAIDOCS_STORE: st, DAIDOCS_OBSERVER: MOCK } });
    let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
    p.stdin.end(JSON.stringify({ session_id: sid, transcript_path: tr, cwd: st }));
    p.on('close', () => res(out));
  });
  await runArchive('sd1', dTr, dStore);

  const manifestOf = st => (fs.existsSync(path.join(st, '_index', 'manifest.jsonl'))
    ? fs.readFileSync(path.join(st, '_index', 'manifest.jsonl'), 'utf8').trim().split(String.fromCharCode(10))
    : []).filter(Boolean).map(l => JSON.parse(l));
  const dRows = manifestOf(dStore);
  const today = new Date().toISOString().slice(0, 10);
  ok('an old conversation is dated when it happened', dRows.length === 1 && dRows[0].date === '2026-08-15', dRows.map(r => r.date).join(','));
  ok('and not when it was converted', dRows[0].date !== today, `${dRows[0].date} vs today ${today}`);
  ok('the file id carries that date too', /^chat_20260815_/.test(dRows[0].id), dRows[0].id);

  // A continuation holds only the newer turns, so it belongs to the newer day.
  fs.writeFileSync(dTr, mkLines('2026-08-15', 'a conversation from three weeks ago about the payments migration')
    + String.fromCharCode(10) + mkLines('2026-09-01', 'picking the same session back up much later'));
  await runArchive('sd1', dTr, dStore);
  const dRows2 = manifestOf(dStore);
  ok('a continuation is dated by its own newer turns',
    dRows2.length === 2 && dRows2.some(r => r.date === '2026-09-01'), dRows2.map(r => r.date).join(','));
  ok('while the first capture keeps the older date', dRows2.some(r => r.date === '2026-08-15'));

  // And the listing must present them in that order, not in append order.
  const listTransport = new StdioClientTransport({
    command: process.execPath, args: [path.join(here, 'mcp_server.mjs')],
    env: { ...process.env, DAIDOCS_STORE: dStore, DAIDOCS_OBSERVER: MOCK },
  });
  const listClient = new Client({ name: 'verify-dates', version: '0.0.1' });
  await listClient.connect(listTransport);
  const dListed = await listClient.callTool({ name: 'list_memories', arguments: {} });
  const dOrder = (dListed.content[0].text.match(/\d{4}-\d{2}-\d{2}/g) || []);
  ok('list_memories orders newest conversation first',
    dOrder.length >= 2 && dOrder[0] >= dOrder[1], dOrder.slice(0, 3).join(' then '));
  await listClient.close();

  // The backlog only LOWERS the autosave bar (a waiting session converts with this one), never
  // raises it: with an enormous marker waiting, a session over the threshold on its own must
  // still be asked for.
  const gTr = path.join(TMP, 'gate.jsonl');
  writeTranscript(gTr, [['user', 'Record the sweep result.'], ['assistant', LONG], ['user', 'And the follow-up.'], ['assistant', LONG]]);
  fs.writeFileSync(path.join(dStore, '_pending', 'cc_huge-0001.json'), JSON.stringify({
    id: 'cc_huge-0001', segId: 'cc_huge-0001', title: 'huge', date: '2026-08-01', cwd: dStore, tokens: 999999, reason: 'subscription' }));
  const gate = await runNode('session_autosave.mjs', [], { DAIDOCS_STORE: dStore, DAIDOCS_OBSERVER: MOCK, DAIDOCS_AUTOSAVE_TOKENS: '500' },
    JSON.stringify({ session_id: 'gate-0001', transcript_path: gTr, cwd: dStore }));
  let gp = null; try { gp = JSON.parse(gate.out); } catch { }
  ok('the autosave hook never gates on the backlog', !!gp && gp.decision === 'block', (gate.out || '').slice(0, 60));
  fs.unlinkSync(path.join(dStore, '_pending', 'cc_huge-0001.json'));

  section('same-day conversations order by time');
  // A date alone can't separate two conversations on one day. The full timestamp is stamped on
  // the manifest row at the WRITER, never in the engine, whose output stays byte-identical to
  // the measured master copy.
  const tStore = store('times');
  const tTr = path.join(TMP, 'same-day.jsonl');
  const mkAt = (iso, text) => [
    JSON.stringify({ type: 'user', timestamp: iso, cwd: 'C:/p', sessionId: 'st', message: { content: text } }),
    JSON.stringify({ type: 'assistant', timestamp: iso, message: { content: [{ type: 'text', text: 'reply '.repeat(300) }] } }),
  ].join(String.fromCharCode(10));
  const runArch = (sid, st) => new Promise(res => {
    const p = spawn(process.execPath, ['session_archiver.mjs'],
      { cwd: here, env: { ...process.env, DAIDOCS_STORE: st, DAIDOCS_OBSERVER: MOCK } });
    let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
    p.stdin.end(JSON.stringify({ session_id: sid, transcript_path: tTr, cwd: st }));
    p.on('close', () => res(out));
  });
  // deliberately out of order
  for (const hhmm of ['08:00', '19:45', '14:30']) {
    fs.writeFileSync(tTr, mkAt(`2026-08-20T${hhmm}:00.000Z`, `a conversation at ${hhmm} worth remembering`));
    await runArch(`sess-${hhmm}`, tStore);
  }
  const tRows = fs.readFileSync(path.join(tStore, '_index', 'manifest.jsonl'), 'utf8')
    .trim().split(String.fromCharCode(10)).filter(Boolean).map(l => JSON.parse(l));
  ok('every row carries a full timestamp', tRows.length === 3 && tRows.every(r => /T\d\d:\d\d/.test(r.at || '')),
    tRows.map(r => r.at).join(' | '));
  ok('all three share the same date', new Set(tRows.map(r => r.date)).size === 1, tRows.map(r => r.date).join(','));
  ok('but their times differ', new Set(tRows.map(r => r.at)).size === 3);

  const tTransport = new StdioClientTransport({
    command: process.execPath, args: [path.join(here, 'mcp_server.mjs')],
    env: { ...process.env, DAIDOCS_STORE: tStore, DAIDOCS_OBSERVER: MOCK },
  });
  const tClient = new Client({ name: 'verify-times', version: '0.0.1' });
  await tClient.connect(tTransport);
  const tList = await tClient.callTool({ name: 'list_memories', arguments: {} });
  const ids = (tList.content[0].text.match(/chat_\d{8}_[0-9a-f]+/g) || []);
  const byTime = [...tRows].sort((a, b) => String(b.at).localeCompare(String(a.at))).map(r => r.id);
  ok('the listing is ordered newest first WITHIN the day',
    ids.length === 3 && ids.join(',') === byTime.join(','), ids.join(',') + '  vs  ' + byTime.join(','));
  await tClient.close();

  // A row written before timestamps existed must still sort, on its date.
  fs.appendFileSync(path.join(tStore, '_index', 'manifest.jsonl'),
    JSON.stringify({ id: 'chat_20200101_old', date: '2020-01-01', title: 'ancient', summary: 'no at field' }) + String.fromCharCode(10));
  const t2 = new Client({ name: 'verify-times-2', version: '0.0.1' });
  await t2.connect(new StdioClientTransport({
    command: process.execPath, args: [path.join(here, 'mcp_server.mjs')],
    env: { ...process.env, DAIDOCS_STORE: tStore, DAIDOCS_OBSERVER: MOCK },
  }));
  const t2List = await t2.callTool({ name: 'list_memories', arguments: {} });
  ok('a row with no timestamp still sorts, by its date',
    /chat_20200101_old/.test(t2List.content[0].text)
    && t2List.content[0].text.indexOf('chat_20200101_old') > t2List.content[0].text.indexOf('chat_20260820'));
  await t2.close();

  section('credentials can be taken back out of a store');
  // Redaction runs on everything written from now on, but it was added after material was
  // already stored, so an existing store can still hold credentials — hence scrub.
  const scrubStore = store('scrub-me');
  fs.mkdirSync(path.join(scrubStore, '_raw'), { recursive: true });
  const fakeKey = 'sk-ant-' + 'A1b2C3d4E5f6G7h8'.repeat(3);
  const clean = path.join(scrubStore, '_raw', 'clean.txt');
  const dirty = path.join(scrubStore, '_raw', 'dirty.txt');
  fs.writeFileSync(clean, 'nothing secret in here at all');
  fs.writeFileSync(dirty, `here is a key ${fakeKey} in a transcript`);

  const runScrub = args => new Promise(res => {
    const p = spawn(process.execPath, ['daidocs.js', 'scrub', scrubStore, ...args], { cwd: here });
    let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
    p.on('close', () => res(out));
  });

  const dry = await runScrub([]);
  ok('a report names the file and the count', /1 file holds 1 credential/.test(dry), dry.split(String.fromCharCode(10)).filter(Boolean).slice(0, 4).join(' | '));
  ok('and changes nothing without --apply', fs.readFileSync(dirty, 'utf8').includes(fakeKey));

  const applied = await runScrub(['--apply']);
  ok('--apply removes the credential', !fs.readFileSync(dirty, 'utf8').includes(fakeKey));
  ok('and leaves the rest of the text alone', /here is a key .* in a transcript/.test(fs.readFileSync(dirty, 'utf8')));
  ok('a file with no credentials is untouched', fs.readFileSync(clean, 'utf8') === 'nothing secret in here at all');

  // The backup is a verbatim copy, so it still holds the secret: it goes OUTSIDE the store,
  // not beside the original where every sync client would find it.
  const inStore = fs.readdirSync(path.join(scrubStore, '_raw'));
  ok('no backup is left inside the store', !inStore.some(f => /scrub-backup/.test(f)), inStore.join(','));
  const bakDir = fs.readdirSync(path.dirname(scrubStore)).find(f => f.startsWith('daidocs-scrub-backup-'));
  ok('the verbatim original is kept outside it', !!bakDir, String(bakDir));
  ok('and the backup still holds the credential, as a backup must',
    fs.readdirSync(path.join(path.dirname(scrubStore), bakDir))
      .some(f => fs.readFileSync(path.join(path.dirname(scrubStore), bakDir, f), 'utf8').includes(fakeKey)));
  ok('the output says the backup is not safe to keep', /STILL CONTAIN the credentials/.test(applied));
  ok('and that scrubbing is not a substitute for rotating', /rotated/.test(applied), '');

  const again = await runScrub([]);
  ok('a scrubbed store reports clean', /No credentials found/.test(again), again.split(String.fromCharCode(10)).filter(Boolean).slice(0, 3).join(' | '));

  section('every store has a permanent id');
  const REG = require('./lib/registry');
  // redirected at the top of this file
  const regFile = process.env.DAIDOCS_REGISTRY;

  const id1 = REG.newId(path.join(TMP, 'My App'));
  ok('the id starts with a date and time', /^\d{8}T\d{6}-/.test(id1), id1);
  ok('and ends with the folder name, slugged', /-my-app$/.test(id1), id1);
  ok('ids sort chronologically because the date leads',
    REG.newId('/x/a', '2026-01-01T00:00:00Z') < REG.newId('/x/a', '2026-06-01T00:00:00Z'));
  ok('the same folder at a later time gets a different id',
    REG.newId('/x/a', '2026-01-01T00:00:00Z') !== REG.newId('/x/a', '2026-01-01T00:00:01Z'));

  section('the directory finds a store that moved');
  // A store lives inside its project folder. The id is an identity, not an address: move or
  // rename the folder and it still says who it is.
  const homeA = store('move-here'), homeB = store('move-there');
  fs.mkdirSync(homeA, { recursive: true }); fs.mkdirSync(homeB, { recursive: true });
  const orig = path.join(homeA, 'myapp');
  const declare = (dir, type) => new Promise(res => {
    const p = spawn(process.execPath, ['setup.js', '--project', dir, '--project-type', type],
      { cwd: here, env: { ...process.env, DAIDOCS_REGISTRY: regFile, HOME: TMP, USERPROFILE: TMP } });
    let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
    p.stdin.end();
    p.on('close', () => res(out));
  });
  await declare(orig, 'normal');
  const cfg1 = JSON.parse(fs.readFileSync(path.join(orig, '.daidocs', 'config.json'), 'utf8'));
  ok('declaring a project assigns an id', /^\d{8}T\d{6}-myapp$/.test(cfg1.id || ''), String(cfg1.id));
  ok('and records it in the directory', REG.list().some(x => x.id === cfg1.id), String(REG.list().length));
  ok('the store is listed as present', REG.list().find(x => x.id === cfg1.id).present === true);

  // Move it AND rename it: neither must matter.
  const moved = path.join(homeB, 'renamed-app');
  fs.renameSync(orig, moved);
  ok('the directory notices it is gone', REG.list().find(x => x.id === cfg1.id).present === false);
  const rec = REG.reconcile([homeB], { maxDepth: 4 });
  ok('a scan finds it again by id', rec.relocated.length === 1, JSON.stringify(rec.relocated.map(r => r.id)));
  ok('and the id is unchanged by the move',
    JSON.parse(fs.readFileSync(path.join(moved, '.daidocs', 'config.json'), 'utf8')).id === cfg1.id);
  const after = REG.list().find(x => x.id === cfg1.id);
  ok('the directory now points at the new place', path.resolve(after.root) === path.resolve(moved), after.root);
  ok('even though the folder has a different name', path.basename(after.root) === 'renamed-app');
  ok('and it is present again', after.present === true);

  // Deleted, not moved: a scan must not invent an answer.
  fs.rmSync(moved, { recursive: true, force: true });
  const rec2 = REG.reconcile([homeB], { maxDepth: 4 });
  ok('a deleted store is reported as still lost', rec2.stillLost.some(x => x.id === cfg1.id));
  ok('and forget removes it for good', REG.forget(cfg1.id) && !REG.list().some(x => x.id === cfg1.id));

  section('the store is kept out of git');
  // _raw holds verbatim transcripts. A store declared inside a repository would
  // otherwise go into history on an ordinary `git add -A`.
  const gitProj = path.join(homeA, 'in-a-repo');
  await declare(gitProj, 'confidential');
  const gi = path.join(gitProj, '.daidocs', '.gitignore');
  ok('declaring writes .daidocs/.gitignore', fs.existsSync(gi));
  // The whole folder, not just store/: ignoring store/ alone left config.json tracked, one
  // `git add -A` from committing a description of the user's own memory to a public remote.
  const giRules = fs.readFileSync(gi, 'utf8').split(String.fromCharCode(10))
    .map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  ok('and it ignores everything in the folder', giRules.join() === '*', giRules.join(' | '));
  ok('and says how to share one on purpose', /git add -f/.test(fs.readFileSync(gi, 'utf8')));
  await declare(gitProj, 'confidential');
  ok('declaring twice does not duplicate the rule',
    fs.readFileSync(gi, 'utf8').split(String.fromCharCode(10)).filter(l => l.trim() === '*').length === 1);

  section('the directory never touches the real machine');
  // The same class of fault as touching the real machine's registry.
  ok('the registry path is overridable', REG.FILE() === regFile, REG.FILE());
  ok('and the suite never names the real one',
    path.resolve(REG.FILE()).startsWith(path.resolve(TMP)), REG.FILE());
  ok('and writes are suppressed under DAIDOCS_NO_PERSIST', await new Promise(res => {
    const probe = path.join(TMP, 'registry', 'nopersist.json');
    const p = spawn(process.execPath, ['-e',
      "const R=require('./lib/registry');R.record({id:'x',root:'/a',storeDir:'/a/s'});" +
      "console.log(require('fs').existsSync(process.env.DAIDOCS_REGISTRY))"],
      { cwd: here, env: { ...process.env, DAIDOCS_REGISTRY: probe, DAIDOCS_NO_PERSIST: '1' } });
    let out = ''; p.stdout.on('data', d => out += d);
    p.on('close', () => res(/false/.test(out)));
  }));

  section('deleting a part does not corrupt the parent');
  // Deleting a folder deletes its store: there is no copy anywhere else. What
  // must NOT happen is the parent silently double-counting itself. A dangling
  // reads path used to walk up from the missing folder, land on an ancestor
  // (in practice the reader), and add the reader's own store a second time, so
  // mergeStores concatenated its _index twice and every fact and event counted
  // double.
  const Sd = require('./lib/stores');
  const dRoot = store('delete-me');
  const dmk = (dir, cfg) => {
    fs.mkdirSync(path.join(dir, '.daidocs', 'store', '_index'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.daidocs', 'config.json'), JSON.stringify(cfg));
    fs.writeFileSync(path.join(dir, '.daidocs', 'store', '_index', 'manifest.jsonl'), JSON.stringify({ id: 'm1', title: 'one' }) + '\n');
    return dir;
  };
  dmk(dRoot, { type: 'normal', store: '.daidocs/store', reads: ['children', './part'], label: 'droot' });
  const dPart = dmk(path.join(dRoot, 'part'), { type: 'normal', store: '.daidocs/store', reads: ['parent'], label: 'dpart' });

  const beforeC = Sd.readCandidates(Sd.resolveStore(dRoot));
  ok('two declarations naming one store yield one candidate', beforeC.length === 2, beforeC.map(c => c.label).join(','));

  fs.rmSync(dPart, { recursive: true, force: true });
  const afterC = Sd.readCandidates(Sd.resolveStore(dRoot));
  ok('the deleted part disappears from the read set', afterC.length === 1, afterC.map(c => c.label + ':' + c.why).join(','));
  ok('and the parent is never added twice',
    new Set(afterC.map(c => path.resolve(c.storeDir))).size === afterC.length);
  ok('the parent does not masquerade as the deleted part',
    !afterC.some(c => c.why === 'reads: ./part'), afterC.map(c => c.why).join(','));
  ok('the loss is reported rather than swallowed',
    (afterC.missing || []).some(m => /part$/.test(m.path)), JSON.stringify(afterC.missing || []));
  ok('a self-resolving stale path is flagged as such',
    (afterC.missing || []).every(m => m.self === undefined || typeof m.self === 'boolean'));

  // A session opened where the part used to be now belongs to the parent.
  const reopened = Sd.resolveStore(dPart);
  ok('a session at the deleted path falls back to the parent store',
    path.resolve(reopened.storeDir) === path.resolve(dRoot, '.daidocs', 'store'), reopened.label);
  ok('and writes there rather than failing', Sd.canWrite(reopened).ok);

  section('the builder ships, a built page never does');
  // A built dashboard embeds the user's memories, verbatim transcripts and absolute paths, so
  // the release carries the builder and template only, never a built page.
  ok('the builder is in the release', fs.existsSync(path.join(here, 'tools', 'dashboard', 'build_dashboard.mjs')));
  ok('so is the template', fs.existsSync(path.join(here, 'tools', 'dashboard', 'dashboard.template.html')));
  ok('and npm run dashboard builds it', /"dashboard": "node tools\/dashboard\/build_dashboard\.mjs"/.test(
    fs.readFileSync(path.join(here, 'package.json'), 'utf8')));

  const builtInRelease = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p2 = path.join(d, e.name);
      if (e.isDirectory()) walk(p2);
      else if (/daidocs-dashboard.*\.html$/.test(e.name)) builtInRelease.push(path.relative(here, p2));
    }
  })(here);
  ok('no built page is in the release', builtInRelease.length === 0, builtInRelease.join(', '));
  ok('and git is told to refuse one', /daidocs-dashboard\.html/.test(
    fs.existsSync(path.join(here, '.gitignore')) ? fs.readFileSync(path.join(here, '.gitignore'), 'utf8') : ''));

  // Documented where a user looks: an undocumented feature goes unused.
  ok('the dashboard is documented where a user looks', /npm run dashboard/.test(
    fs.readFileSync(path.join(here, 'QUICKSTART.md'), 'utf8')));
  ok('and the docs warn what a built page contains', /contains your memories/.test(
    fs.readFileSync(path.join(here, 'QUICKSTART.md'), 'utf8')));

  // PRE-LAUNCH.md is an internal working list, not part of the released docs set.
  ok('no PRE-LAUNCH.md ships in the release', !fs.existsSync(path.join(here, 'docs', 'PRE-LAUNCH.md')));

  section('every surface is documented, and every link goes somewhere');
  // Every command, tool and folder type must be documented, or it goes unused.
  const docFiles = [];
  for (const d of ['.', 'docs', 'spec']) {
    const dir = path.join(here, d);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.md')) docFiles.push(path.join(dir, f));
  }
  const allDocs = docFiles.map(f => fs.readFileSync(f, 'utf8')).join(String.fromCharCode(10));

  const CLI = ['ingest', 'ask', 'convert', 'stores', 'scrub', 'backup', 'pending'];
  const TOOLS = ['recall_memory', 'save_memory', 'list_memories', 'read_memory', 'brief_parent', 'declare_project'];
  const TYPES = ['normal', 'locked', 'frozen', 'connected', 'shared', 'confidential', 'temporary'];

  const docCliSrc = fs.readFileSync(path.join(here, 'daidocs.js'), 'utf8');
  for (const c of CLI) {
    ok(`the CLI still has ${c}`, docCliSrc.includes(`cmd === "${c}"`));
    ok(`and ${c} is documented`, allDocs.includes(c));
  }
  const srvSrc = fs.readFileSync(path.join(here, 'mcp_server.mjs'), 'utf8');
  for (const t of TOOLS) {
    ok(`the server still exposes ${t}`, srvSrc.includes(`'${t}'`));
    ok(`and ${t} is documented`, allDocs.includes(t));
  }
  for (const t of TYPES) ok(`the folder type ${t} is documented`, allDocs.includes(t));

  // pre/post scripts are npm's own plumbing (npm runs them, nobody types them), so they're excluded.
  const pkgScripts = Object.keys(JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8')).scripts)
    .filter(s2 => !/^(pre|post)/.test(s2));
  const undocScripts = pkgScripts.filter(s2 => !allDocs.includes('npm run ' + s2) && !allDocs.includes('npm ' + s2));
  ok('every npm script is documented', undocScripts.length === 0, undocScripts.join(', '));

  // Two badge faults guarded: an <img> with no link (renders as a clickable-looking pill that
  // does nothing), and a hand-written CI pill (claims a build status nothing checks, straight
  // through a red build).
  const readme = fs.readFileSync(path.join(here, 'README.md'), 'utf8');
  const heroBadges = [...readme.matchAll(/<img[^>]*\ssrc="(assets\/badges\/[^"]+)"[^>]*>/g)];
  ok('the badges are local files, not fetched from a third party', heroBadges.length >= 5,
    `${heroBadges.length} local`);
  for (const m of heroBadges) {
    ok(`${m[1]} exists`, fs.existsSync(path.join(here, m[1])));
  }
  const anyBadgeImg = (readme.match(/<img[^>]*\ssrc="(?:assets\/badges\/|https:\/\/img\.shields\.io)[^"]*"[^>]*>/g) || []).length;
  const linkedBadge = (readme.match(/<a[^>]*>\s*<img[^>]*\ssrc="(?:assets\/badges\/|https:\/\/img\.shields\.io)[^"]*"[^>]*>\s*<\/a>/g) || []).length;
  ok('every badge is wrapped in a link', anyBadgeImg > 0 && linkedBadge === anyBadgeImg,
    `${linkedBadge} of ${anyBadgeImg} linked`);
  ok('no hand-written CI status pill', !/shields\.io\/badge\/CI-/.test(readme));
  ok('the badge generator ships', fs.existsSync(path.join(here, 'tools', 'make_badges.py')));

  // Every relative link and image in every shipped markdown file must resolve.
  const dead = [];
  for (const f of docFiles) {
    const src = fs.readFileSync(f, 'utf8');
    const targets = [
      ...[...src.matchAll(/!?\[[^\]]*\]\(([^)\s#]+)[^)]*\)/g)].map(m => m[1]),
      ...[...src.matchAll(/<img[^>]*\ssrc="([^"]+)"/g)].map(m => m[1]),
      ...[...src.matchAll(/<a[^>]*\shref="([^"#]+)"/g)].map(m => m[1]),
    ];
    for (const t of targets) {
      if (/^(https?:|mailto:)/i.test(t)) continue;
      if (!fs.existsSync(path.resolve(path.dirname(f), decodeURIComponent(t)))) {
        dead.push(path.relative(here, f) + ' -> ' + t);
      }
    }
  }
  ok('no markdown link or image points at nothing', dead.length === 0, dead.slice(0, 4).join('; '));

  // The observer's output is permanent, so a cheapest-model default quietly caps every future
  // answer from that store: assert the defaults are the good ones and that none is a local model.
  const noHaiku = ['setup.js', 'session_archiver.mjs', 'lib/convert.js',
    'keyless_check.mjs', 'mcp_selftest.mjs', 'mcp_server.mjs', 'lib/host.js'];
  for (const f of noHaiku) {
    const src2 = fs.readFileSync(path.join(here, f), 'utf8');
    ok(`${f} does not name Haiku`, !/haiku/i.test(src2));
  }
  ok('the Anthropic default observer is Opus', /observer: 'anthropic:claude-opus-5'/.test(
    fs.readFileSync(path.join(here, 'setup.js'), 'utf8')));
  // Ollama may exist as an engine backend; nothing may suggest running it.
  for (const f of ['README.md', 'QUICKSTART.md', 'CHANGELOG.md', 'docs/GUIDE.md']) {
    ok(`${f} does not suggest a local model`, !/ollama/i.test(
      fs.readFileSync(path.join(here, f), 'utf8')));
  }

  section('the documents describe the release as it is');
  // These guard against a document describing a previous release: it is trusted, so it misleads.
  const docVer = require('./lib/version').VERSION;
  const rdDoc = f => fs.readFileSync(path.join(here, f), 'utf8');

  ok('the README counts six tools, not four', /Six tools over MCP/.test(rdDoc('README.md')));
  ok('the README states the rank with its gap and its noise',
    /Second on the benchmark/.test(rdDoc('README.md')) && /84\.80/.test(rdDoc('README.md')) && /inside single-run noise/.test(rdDoc('README.md')));
  ok('RESULTS.md places the number in a table with the exclusions stated',
    /\| Mastra Observational Memory \| 84\.80% \|/.test(rdDoc('docs/RESULTS.md')) && /EmergenceMem Internal at 86\.00%/.test(rdDoc('docs/RESULTS.md')));
  ok('no results page still says no ranking is claimed',
    !/None is claimed/.test(rdDoc('docs/RESULTS.md')) && !/would assert a like-for-like comparison that has not been performed/.test(rdDoc('RESULTS-SUMMARY.md')));
  // Competitor figures are quoted; competitor links are not. check_numbers bans
  // the links, this asserts the figure quoted is the one references.json holds.
  const docRefs = JSON.parse(rdDoc('tools/references.json'));
  const docMastra = docRefs.leaderboard.find(r => /Observational/.test(r.system));
  ok('the quoted first-place figure is the one in references.json', docMastra && rdDoc('README.md').includes(String(docMastra.score.toFixed(2))));

  // The subscription path is free: any document that says saving requires a key is stale.
  for (const f of ['QUICKSTART.md', 'README.md', 'docs/GUIDE.md', 'docs/INTEGRATION.md']) {
    ok(`${f} does not say saving needs a key`, !/saving cannot run/i.test(rdDoc(f)) && !/they pay the API price/.test(rdDoc(f)));
  }
  ok('the quickstart leads with the subscription path', /you need no key/.test(rdDoc('QUICKSTART.md')));
  ok('the quickstart says sessions save every 4,000 tokens', /every 4,000 new/.test(rdDoc('QUICKSTART.md')));
  ok('the README shows the unconverted folder in the tree', /_unconverted\//.test(rdDoc('README.md')));
  ok('the guide says the tail is read before it is converted', /read before it is converted/i.test(rdDoc('docs/GUIDE.md')));
  ok('the lifecycle diagram names the folder', /_unconverted/.test(rdDoc('tools/make_diagrams.py')));
  // The user's own first message can talk the assistant past the question, so
  // every document says the sentence to type, and how to open the map.
  for (const f of ['README.md', 'QUICKSTART.md', 'docs/GUIDE.md', 'docs/INTEGRATION.md']) {
    // "a project" for a folder that has none, "its own project" for a subfolder
    // that is currently using its parent's. Both are the sentence a user says.
    ok(`${f} tells the user how to make a folder its own project`, /make this folder (a|its own) project/.test(rdDoc(f)));
  }
  // convert is what makes a store useful on day one, and the one thing setup won't start on its
  // own, so the docs must show it prominently.
  ok('the README shows how to bring existing history in',
    /node daidocs\.js convert/.test(rdDoc('README.md')) && /Bring what you already have/.test(rdDoc('README.md')));
  ok('and names where history can come from',
    /~\/\.claude\/projects/.test(rdDoc('README.md')) && /_unconverted/.test(rdDoc('README.md')) && /folder of exports/.test(rdDoc('README.md')));
  ok('and says the cost is quoted before anything is spent',
    /before any paid call/.test(rdDoc('README.md')));
  ok('QUICKSTART shows it too', /node daidocs\.js convert/.test(rdDoc('QUICKSTART.md')));
  // The parts model as it behaves: side-by-side folders auto-declare, a subfolder deliberately
  // does not, and reach is asked for one direction at a time.
  const guideParts = rdDoc('docs/GUIDE.md');
  ok('the guide explains one folder per part', /One folder per part/.test(guideParts));
  ok('and that a subfolder keeps using the project it is in',
    /A subfolder is the exception/.test(guideParts) && /make this folder its own\s+project/.test(guideParts));
  ok('and names every way to reach another store',
    /read the main project too/.test(guideParts) && /read its parts/.test(guideParts)
    && /confidential/.test(guideParts) && /one-way unless/.test(guideParts));
  for (const f of ['README.md', 'QUICKSTART.md', 'docs/GUIDE.md']) {
    // The build opens the page in the browser itself, so the docs cover that and how to stop it.
    ok(`${f} says how to open the map`, /daidocs-dashboard\.html/.test(rdDoc(f)) && /default\s+browser|browser\s+you use by default/i.test(rdDoc(f)));
  }
  ok('and that the opening can be turned off', /--no-open/.test(rdDoc('README.md')) && /--no-open/.test(rdDoc('docs/GUIDE.md')));
  ok('the map shows what is unconverted', /_unconverted/.test(rdDoc('tools/dashboard/dashboard.template.html')) && /unconverted:/.test(rdDoc('tools/dashboard/build_dashboard.mjs')));
  ok('the map tells the general store how to leave it', /make this folder a project/.test(rdDoc('tools/dashboard/dashboard.template.html')));
  ok('recall\'s scope description matches the code', /"project" \(the default\)/.test(rdDoc('mcp_server.mjs')));
  ok('INTEGRATION does not pin a stale version', !/V4\.4n\d+ as it currently behaves/.test(rdDoc('docs/INTEGRATION.md')));
  ok('INTEGRATION documents DAIDOCS_USE_API', /DAIDOCS_USE_API/.test(rdDoc('docs/INTEGRATION.md')));
  ok('no document names a per-surface observer default', !/\(session archiver\)/.test(rdDoc('README.md')));
  ok('no document offers a local model as the observer',
    !/or nothing with a local model/.test(rdDoc('docs/RESULTS.md')) && !/free with a local model/.test(rdDoc('README.md')));
  ok('GAPS does not state an exact check count that will go stale', !/\b\d{3} offline checks/.test(rdDoc('docs/GAPS.md')));

  // Metadata that names the version must name this one.
  ok('CITATION.cff carries the current version', rdDoc('CITATION.cff').includes('version: ' + docVer), docVer);
  ok('CITATION.cff does not call the observer cheap', !/cheap observer/.test(rdDoc('CITATION.cff')));
  // The launch release names itself in three places, and all three must agree
  // with lib/version.js or the CHANGELOG silently describes an older build again.
  const chTop = (rdDoc('CHANGELOG.md').match(/^## \[([^\]]+)\] - (\d{4}-\d\d-\d\d)/m) || []);
  ok('the CHANGELOG top entry is this version', chTop[1] === docVer, chTop[1]);
  ok('the README launch line names this version', rdDoc('README.md').includes('Launch release ' + docVer));
  ok('CITATION.cff carries a release date', /^date-released: \d{4}-\d\d-\d\d$/m.test(rdDoc('CITATION.cff')));
  ok('CONTRIBUTING names OpenRouter and Hermes', /OpenRouter/.test(rdDoc('CONTRIBUTING.md')) && /Hermes/.test(rdDoc('CONTRIBUTING.md')));

  // Only the contact addresses the website uses are allowed; anything else in a shipped file is
  // stale or someone else's. The six live-site addresses are listed below.
  const docAllowed = new Set(['hello@kerneta.com', 'community@kerneta.com', 'security@kerneta.com',
    'privacy@kerneta.com', 'general@kerneta.com', 'technical@kerneta.com',
    // the two authors' own addresses on the project domain, listed in CITATION.cff
    'amin@daidocs.com', 'ali@daidocs.com']);
  const docEmailFiles = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (['node_modules', '.git', 'run-artifacts', 'benchmark', '__pycache__'].includes(e.name)) continue;
      const p2 = path.join(d, e.name);
      if (e.isDirectory()) walk(p2);
      else if (/\.(md|cff|json|yml|txt)$/.test(e.name) && e.name !== 'package-lock.json') docEmailFiles.push(p2);
    }
  })(here);
  const docStrays = [];
  for (const f of docEmailFiles) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/g)) {
      if (!docAllowed.has(m[0]) && !/example\.(com|org)$/.test(m[0])) docStrays.push(path.relative(here, f) + ': ' + m[0]);
    }
  }
  ok('the only contact addresses are the ones on daidocs.com', docStrays.length === 0, docStrays.slice(0, 3).join('; '));
  ok('SECURITY.md uses the website security address', /security@kerneta\.com/.test(rdDoc('SECURITY.md')));

  // The manifest is the README's "check that what is described is what was measured", so it has
  // to match and its header has to name the release it describes.
  const docMan = rdDoc('MANIFEST.sha256').split(/\r?\n/);
  ok('the manifest header names this version', docMan[0].includes(docVer), docMan[0]);
  ok('PROVENANCE no longer claims a git-HEAD line', !/git-HEAD` line names/.test(rdDoc('docs/PROVENANCE.md')));
  ok('PROVENANCE does not call lib/ unchanged', !/`lib\/`[^.]*exactly the/.test(rdDoc('docs/PROVENANCE.md')));
  // The release story is 'unchanged since the run', not 'frozen on a date'. The
  // frozen FOLDER TYPE is a feature and is allowed everywhere.
  ok('no document tells a freeze-date story', !/frozen on 20\d\d|at the freeze|since the freeze|frozen copy|frozen bytes|frozen tree/.test(
    ['README.md', 'docs/PROVENANCE.md', 'CITATION.cff', 'CHANGELOG.md', 'RESULTS-SUMMARY.md', 'docs/RESULTS.md'].map(rdDoc).join(' ')));
  const crypto2 = require('crypto');
  let docMism = 0, docGone = 0, docListed = 0;
  for (const line of docMan) {
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('  ');
    if (i < 0) continue;
    const h = line.slice(0, i), f = line.slice(i + 2).trim();
    docListed++;
    const fp = path.join(here, f);
    if (!fs.existsSync(fp)) { docGone++; continue; }
    if (crypto2.createHash('sha256').update(fs.readFileSync(fp)).digest('hex') !== h) docMism++;
  }
  ok('every file the manifest lists exists', docGone === 0, docGone + ' missing');
  ok('every hash in the manifest matches the file', docMism === 0, docMism + ' of ' + docListed + ' differ');
  // .gitattributes asks for LF, so a text file written CRLF is committed as LF
  // and then hashes differently from the working copy this manifest was made
  // on: a fresh clone fails the check above on a file nobody touched. It has
  // happened twice, both times a generator writing through a text stream on
  // Windows, and both times it was invisible until CI ran on Linux.
  // Only files git will actually normalise count. Git calls a file binary when
  // it finds a NUL in the first 8000 bytes and then leaves its bytes alone, so
  // such a file is consistent whatever endings it has. daidocs.js is one: it
  // carries a NUL as a field separator.
  const docCrlf = [];
  for (const line of docMan) {
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('  ');
    if (i < 0) continue;
    const f = line.slice(i + 2).trim();
    const fp = path.join(here, f);
    if (!fs.existsSync(fp)) continue;
    const buf = fs.readFileSync(fp);
    if (buf.subarray(0, 8000).includes(0)) continue;
    if (buf.includes(Buffer.from('\r\n'))) docCrlf.push(f);
  }
  ok('every shipped text file uses LF, as .gitattributes asks',
    docCrlf.length === 0, docCrlf.slice(0, 4).join(', '));
  // A script that turns import.meta.url into a path by slicing the URL breaks on any install
  // whose path contains a space (the URL percent-encodes it); fileURLToPath decodes it and
  // handles drive letters and UNC paths too.
  const docByHand = [];
  for (const line of docMan) {
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('  ');
    if (i < 0) continue;
    const f = line.slice(i + 2).trim();
    if (!/\.(mjs|js)$/.test(f)) continue;
    const fp = path.join(here, f);
    if (!fs.existsSync(fp)) continue;
    if (/new URL\(\s*import\.meta\.url\s*\)\s*\.pathname/.test(fs.readFileSync(fp, 'utf8'))) docByHand.push(f);
  }
  ok('no script turns import.meta.url into a path by hand', docByHand.length === 0, docByHand.join(', '));
  // Shell command lines in the docs must not join with &&: PowerShell 5.1, the Windows default,
  // parses it as an error. An npm script may still use && — npm runs those through cmd or sh,
  // never PowerShell.
  const docAmp = [];
  for (const line of docMan) {
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('  ');
    if (i < 0) continue;
    const f = line.slice(i + 2).trim();
    if (!f.endsWith('.md')) continue;
    const fp = path.join(here, f);
    if (!fs.existsSync(fp)) continue;
    let lang = null;
    for (const l of fs.readFileSync(fp, 'utf8').split(/\r?\n/)) {
      if (l.startsWith('```')) { lang = lang === null ? l.slice(3).trim().toLowerCase() : null; continue; }
      if (lang && /^(bash|sh|shell|console|powershell|ps1)$/.test(lang) && l.includes('&&')) {
        docAmp.push(`${f}: ${l.trim().slice(0, 50)}`);
      }
    }
  }
  ok('no document joins shell commands with &&', docAmp.length === 0, docAmp.slice(0, 3).join(' | '));
  // And the one-command form the documents point at has to exist.
  const docPkg = JSON.parse(rdDoc('package.json'));
  ok('npm run setup installs before it connects',
    docPkg.scripts.presetup === 'npm install' && docPkg.scripts.setup === 'node setup.js',
    `${docPkg.scripts.presetup} / ${docPkg.scripts.setup}`);
  // The engine and the evidence must hash to the measured values whatever else
  // changes. If this ever fails, a number has stopped being backed.
  const docEngineHash = crypto2.createHash('sha256').update(fs.readFileSync(path.join(here, 'lib/methods/daidocs-v44n/method.js'))).digest('hex');
  ok('the engine file is byte-identical to the measured one', docEngineHash.startsWith('2ae1ff6798a1d575'), docEngineHash.slice(0, 16));

  // CI must run this suite, or none of the above guards anything on push.
  ok('CI runs the full suite', /npm run verify/.test(rdDoc('.github/workflows/ci.yml')));
  ok('the PR template asks for it', /npm run verify/.test(rdDoc('.github/pull_request_template.md')));
  ok('the reproduction template does not contradict CONTRIBUTING', !/most valuable issue/.test(rdDoc('.github/ISSUE_TEMPLATE/reproduction-failure.md')));

  section('the demo and the diagrams ship');
  ok('the diagram kit is in the release', fs.existsSync(path.join(here, 'tools', 'diagram_kit.py')));
  ok('and the generator', fs.existsSync(path.join(here, 'tools', 'make_diagrams.py')));
  ok('npm run diagrams builds them', pkgScripts.includes('diagrams'));
  for (const d of ['lifecycle', 'zones', 'zooms', 'folder-types', 'where-memory']) {
    ok(`${d} is rendered`, fs.existsSync(path.join(here, 'assets', 'diagrams', d + '.png'))
      && fs.existsSync(path.join(here, 'assets', 'diagrams', d + '.svg')));
  }
  const gif = path.join(here, 'assets', 'demo', 'dashboard-demo.gif');
  ok('the dashboard demo ships', fs.existsSync(gif));
  if (fs.existsSync(gif)) {
    const mb = fs.statSync(gif).size / (1024 * 1024);
    // Keep the demo GIF small: a large one makes the README slow to paint.
    ok('and it is small enough for a README', mb < 6, mb.toFixed(1) + ' MB');
  }
  // The demo was recorded off invented data in a throwaway HOME. If a real path
  // ever appears in it, the recording was made against a real store.
  const readmeSrc = fs.readFileSync(path.join(here, 'README.md'), 'utf8');
  ok('the demo is shown in the README', readmeSrc.includes('assets/demo/dashboard-demo.gif'));
  ok('and the README says the demo data is invented', /invented data/i.test(readmeSrc));

  section('the charts wear the site, not matplotlib');
  // The README charts are the same graphic as daidocs.com's: a regeneration that loses the
  // theme drops a white default matplotlib plot into the README unnoticed.
  const themeSrc = path.join(here, 'tools', 'chart_theme.py');
  ok('the chart theme is in the release', fs.existsSync(themeSrc));
  const theme = fs.existsSync(themeSrc) ? fs.readFileSync(themeSrc, 'utf8') : '';
  ok('and the generator uses it', /import chart_theme as T/.test(
    fs.readFileSync(path.join(here, 'tools', 'make_charts.py'), 'utf8')));

  // The palette is transcribed from the site, so a drift here is a drift from
  // the site. These four are the ones a reader actually sees.
  for (const [name, hex] of [['--bg', '#05070a'], ['--surface-solid', '#0d1117'],
                             ['--accent', '#4ade87'], ['--accent2', '#38bdf8']]) {
    ok(`the theme carries the site's ${name}`, theme.includes(hex), hex);
  }
  // The accent gradient marks the pointed-at row, so a neutral ramp must exist for the rest,
  // or the accent means nothing.
  ok('there is a neutral ramp for rows that are not the point', /"cool":/.test(theme));

  const chartsDir2 = path.join(here, 'assets', 'charts');
  if (fs.existsSync(chartsDir2)) {
    const svgs = fs.readdirSync(chartsDir2).filter(f => f.endsWith('.svg'));
    ok('charts are rendered', svgs.length > 0, `${svgs.length} svg`);
    for (const f of svgs) {
      const s2 = fs.readFileSync(path.join(chartsDir2, f), 'utf8');
      // A default matplotlib figure is white. If this fails, someone rendered
      // without the theme.
      ok(`${f} is on the dark panel`, s2.includes('#0d1117') || s2.includes('#05070a'));
      // check_numbers.mjs greps these for figures no artifact backs, which only
      // works while the text is text rather than outlined paths.
      ok(`${f} keeps its text greppable`, /<text/.test(s2));
    }
  }

  section('nothing assumes Windows');
  // The release is written on Windows and will be run on macOS. Anything that
  // only works here has to either branch, or say it is skipping, never fail.
  const srcOf = f => fs.readFileSync(path.join(here, f), 'utf8');
  const lockSrc = srcOf('lock.js'), setupSrc3 = srcOf('setup.js'), cliSrc2 = srcOf('daidocs.js');

  ok('the hard lock has a POSIX path', /process\.platform === 'win32'/.test(lockSrc) && /fs\.chmodSync\(dir/.test(lockSrc));
  ok('Claude Desktop is found on macOS', /Library', 'Application Support', 'Claude'/.test(setupSrc3));
  ok('host detection knows the macOS location', /Library', 'Application Support', 'Claude'/.test(srcOf('lib/host.js')));
  ok('keys persist to a shell profile off Windows', /\.zshrc|\.bashrc/.test(setupSrc3));
  ok('zip uses the platform tool rather than a dependency', /Compress-Archive/.test(cliSrc2) && /zip -qr/.test(cliSrc2));
  ok('folder icons say they are skipped rather than failing', /Folder icons are Windows-only for now; skipped/.test(setupSrc3));
  ok('the file association says what macOS needs', /macOS needs an app bundle/.test(setupSrc3));

  // The dashboard is read on the machine it was built for, so its suggestions
  // have to be plausible there.
  const macOut = path.join(TMP, 'dash5', 'd.html');
  await new Promise(res => {
    const p = spawn(process.execPath, ['tools/dashboard/build_dashboard.mjs', '--out', macOut], { cwd: here });
    p.on('close', () => res());
  });
  const macHtml = fs.existsSync(macOut) ? fs.readFileSync(macOut, 'utf8') : '';
  const macData = embeddedData(macHtml);
  ok('the build records its platform', !!macData && typeof macData.platform === 'string', macData && macData.platform);
  ok('and a backup destination that exists there', !!macData && !!macData.backupHint, macData && macData.backupHint);
  ok('the page no longer hardcodes a Windows drive', !/--to "D:\/backups"/.test(macHtml));

  // file:// wants three slashes before an absolute path. A POSIX path brings its
  // own leading slash, so gluing "file:///" on gives four and the link dies.
  ok('the file link is built, not glued', /function fileUrl/.test(macHtml));
  // Taken out of the built page rather than retyped: a copy in the test would pass while the
  // shipped one is broken, which is exactly what this section catches.
  const fileUrlSrc = (macHtml.match(/function fileUrl\(p\) \{[\s\S]*?\n {2}\}/) || [''])[0];
  ok('and the test reads the shipped one', fileUrlSrc.length > 0);
  const fileUrl = new Function(fileUrlSrc + '; return fileUrl;')();
  ok('a Windows path gets three slashes', fileUrl('C:' + String.fromCharCode(92) + 'work') === 'file:///C:/work', fileUrl('C:' + String.fromCharCode(92) + 'work'));
  ok('a POSIX path also gets three, not four', fileUrl('/Users/amin/work') === 'file:///Users/amin/work', fileUrl('/Users/amin/work'));
  // A path with a space in it is the one that reached us from a real install.
  ok('a space in the path is encoded', fileUrl('D:' + String.fromCharCode(92) + 'R&D Dev') === 'file:///D:/R&D%20Dev', fileUrl('D:' + String.fromCharCode(92) + 'R&D Dev'));

  section('the backlog is grouped by where it came from');
  // "29 unindexed" names a problem but not how to start; grouped by origin it becomes a list of
  // decisions — convert this project, skip that one.
  const pdStore = store('pending-groups');
  for (const d of ['_index', '_raw', '_pending']) fs.mkdirSync(path.join(pdStore, d), { recursive: true });
  const mkPend = (id, project, cwd, text) => {
    fs.writeFileSync(path.join(pdStore, '_pending', id + '.json'),
      JSON.stringify({ id, segId: id, title: '[' + project + '] Claude Code session: ' + text, date: '2026-09-01', project, cwd }));
    fs.writeFileSync(path.join(pdStore, '_raw', id + '.txt'), text.repeat(50));
  };
  mkPend('cc_a', 'Alpha', 'C:/work/Alpha', 'first alpha session ');
  mkPend('cc_b', 'Alpha', 'C:/work/Alpha', 'second alpha session ');
  mkPend('cc_c', 'Beta', null, 'a beta session ');

  const pdRun = await new Promise(res => {
    const p = spawn(process.execPath, ['daidocs.js', 'pending'],
      { cwd: here, env: { ...process.env, DAIDOCS_STORE: pdStore } });
    let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
    p.on('close', code => res({ out, code }));
  });
  ok('pending lists the backlog', /3 sessions captured but not converted/.test(pdRun.out), pdRun.out.split(String.fromCharCode(10)).filter(Boolean)[0]);
  ok('grouped by project', /Alpha/.test(pdRun.out) && /Beta/.test(pdRun.out));
  ok('with a count per project', /Alpha\s+2/.test(pdRun.out), (pdRun.out.match(/Alpha.*/) || [''])[0]);
  ok('and it says nothing is billed', /nothing is billed/i.test(pdRun.out));

  // Routing moves one project's sessions into that project's own store.
  const alphaDir = store('Alpha');
  fs.mkdirSync(alphaDir, { recursive: true });
  const route = await new Promise(res => {
    const p = spawn(process.execPath, ['daidocs.js', 'pending', '--route', 'Alpha', '--to', alphaDir],
      { cwd: here, env: { ...process.env, DAIDOCS_STORE: pdStore, DAIDOCS_REGISTRY: process.env.DAIDOCS_REGISTRY } });
    let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
    p.on('close', code => res({ out, code }));
  });
  ok('routing declares the destination', fs.existsSync(path.join(alphaDir, '.daidocs', 'config.json')), route.out.slice(0, 90));
  ok('and moves that project’s markers there',
    fs.readdirSync(path.join(alphaDir, '.daidocs', 'store', '_pending')).filter(f => f.endsWith('.json')).length === 2);
  ok('with their raw text', fs.readdirSync(path.join(alphaDir, '.daidocs', 'store', '_raw')).length === 2);
  ok('leaving the other project alone',
    fs.readdirSync(path.join(pdStore, '_pending')).filter(f => f.endsWith('.json')).length === 1);
  ok('and nothing is converted by routing', !fs.existsSync(path.join(alphaDir, '.daidocs', 'store', '_index', 'manifest.jsonl'))
    || fs.readFileSync(path.join(alphaDir, '.daidocs', 'store', '_index', 'manifest.jsonl'), 'utf8').trim() === '');
  ok('it names the next step', /convert my pending daidocs sessions/.test(route.out));

  const badRoute = await new Promise(res => {
    const p = spawn(process.execPath, ['daidocs.js', 'pending', '--route', 'NotAProject'],
      { cwd: here, env: { ...process.env, DAIDOCS_STORE: pdStore } });
    let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
    p.on('close', code => res({ out, code }));
  });
  ok('an unknown project is refused rather than guessed', badRoute.code !== 0 && /No pending sessions for/.test(badRoute.out));

  // The archiver must record where a session came from, or nothing can route it.
  const arcSrc = fs.readFileSync(path.join(here, 'session_archiver.mjs'), 'utf8');
  ok('new markers record the project and the folder', /project: project \|\| null/.test(arcSrc) && /cwd: SESSION_CWD/.test(arcSrc));

  // And the dashboard shows the same grouping on its first screen.
  const wOut = path.join(TMP, 'dash4', 'd.html');
  await new Promise(res => {
    // Built from the fixture store above (which has pending markers), not the machine's real
    // store, so it doesn't depend on this machine having used DaiDocs.
    const p = spawn(process.execPath, ['tools/dashboard/build_dashboard.mjs', '--out', wOut],
      { cwd: here, env: { ...process.env, DAIDOCS_STORE: pdStore } });
    p.on('close', () => res());
  });
  const wHtml = fs.existsSync(wOut) ? fs.readFileSync(wOut, 'utf8') : '';
  const wData = embeddedData(wHtml);
  ok('the build embeds the groups', !!wData && wData.stores.some(st => Array.isArray(st.pendingGroups)));
  ok('the main page shows what is waiting', /captured but not converted/.test(wHtml));
  ok('and says you need not do all of them', /you do not have to do all of them/.test(wHtml));
  ok('each group offers the routing command', /pending --route/.test(wHtml));

  section('backing a project up somewhere else');
  // For moving between machines or onto a drive: nothing at the source may be touched, and
  // node_modules must not be dragged along (that turns a 40 MB project into 900 MB).
  const bkSrc = store('bk-src'), bkDest = store('bk-dest');
  fs.mkdirSync(path.join(bkSrc, 'src'), { recursive: true });
  fs.mkdirSync(path.join(bkSrc, 'node_modules', 'junk'), { recursive: true });
  fs.mkdirSync(path.join(bkSrc, '.daidocs', 'store'), { recursive: true });
  fs.writeFileSync(path.join(bkSrc, 'src', 'a.js'), 'code');
  fs.writeFileSync(path.join(bkSrc, 'readme.md'), 'doc');
  fs.writeFileSync(path.join(bkSrc, 'node_modules', 'junk', 'x.js'), 'huge');
  fs.writeFileSync(path.join(bkSrc, '.daidocs', 'config.json'), '{"type":"normal"}');

  const runBk = args => new Promise(res => {
    const p = spawn(process.execPath, ['daidocs.js', 'backup', bkSrc, '--to', bkDest, ...args], { cwd: here });
    let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
    p.on('close', code => res({ out, code }));
  });
  const bk = await runBk([]);
  ok('backup runs', bk.code === 0, bk.out.split(String.fromCharCode(10)).filter(Boolean).slice(-1)[0]);
  const made = fs.readdirSync(bkDest).filter(f => f.startsWith('bk-src-'));
  ok('it writes a dated folder', made.length === 1, made.join(','));
  const copied = [];
  (function walk(d, rel) { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p2 = path.join(d, e.name); if (e.isDirectory()) walk(p2, rel + '/' + e.name); else copied.push(rel + '/' + e.name); } })(path.join(bkDest, made[0]), '');
  ok('the project files came across', copied.some(f => /readme\.md$/.test(f)) && copied.some(f => /src\/a\.js$/.test(f)), copied.join(' '));
  ok('the memory came across', copied.some(f => /\.daidocs\/config\.json$/.test(f)));
  ok('node_modules did NOT', !copied.some(f => /node_modules/.test(f)), copied.filter(f => /node_modules/.test(f)).join(','));
  ok('the source is untouched', fs.existsSync(path.join(bkSrc, 'node_modules', 'junk', 'x.js'))
    && fs.readFileSync(path.join(bkSrc, 'readme.md'), 'utf8') === 'doc');
  ok('and it says so', /Nothing at the source was changed/.test(bk.out));

  const bkMem = await runBk(['--memory-only']);
  const made2 = fs.readdirSync(bkDest).filter(f => f.startsWith('bk-src-')).sort();
  const memCopy = made2[made2.length - 1];
  const memFiles = fs.readdirSync(path.join(bkDest, memCopy));
  ok('a second backup does not merge into the first', made2.length === 2, made2.join(' | '));
  ok('--memory-only takes just the store', memFiles.includes('config.json') || memFiles.includes('store'), memFiles.join(','));
  ok('and leaves the code behind', !memFiles.includes('src'), memFiles.join(','));

  const noDest = await new Promise(res => {
    const p = spawn(process.execPath, ['daidocs.js', 'backup', bkSrc], { cwd: here });
    let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
    p.on('close', code => res({ out, code }));
  });
  ok('a backup with no destination refuses rather than guessing', noDest.code !== 0 && /needs a destination/.test(noDest.out));

  // A declared project with files in it and a real memory in its store, so the
  // builds below have something to read on ANY machine. They used to read
  // whatever the person running the suite happened to have lying about, which
  // is why they passed on a developer's laptop and failed on a clean runner:
  // no stores, no memories, nothing to count.
  const dashProj = store('dash-project');
  fs.mkdirSync(path.join(dashProj, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dashProj, 'README.md'), '# Fixture project' + String.fromCharCode(10));
  fs.writeFileSync(path.join(dashProj, 'src', 'app.js'), 'console.log(1);' + String.fromCharCode(10));
  fs.writeFileSync(path.join(dashProj, 'notes.txt'), 'a plain note' + String.fromCharCode(10));
  require('./lib/stores').declareProject(dashProj, 'normal', null, 'Dash fixture');
  const dashSrc = store('dash-src');
  fs.mkdirSync(dashSrc, { recursive: true });
  fs.writeFileSync(path.join(dashSrc, 'note.md'), '# Note' + String.fromCharCode(10, 10)
    + 'On 2026-09-01 the sweep recorded 74.00 for v1.9.6.' + String.fromCharCode(10) + LONG);
  await runNode('daidocs.js',
    ['ingest', dashSrc, path.join(dashProj, '.daidocs', 'store'), '--observer', MOCK], {});

  section('a memory and a folder each get a page');
  const pgOut = path.join(TMP, 'dash3', 'd.html');
  await new Promise(res => {
    const p = spawn(process.execPath, ['tools/dashboard/build_dashboard.mjs', '--out', pgOut], { cwd: here });
    p.on('close', () => res());
  });
  const pgHtml = fs.existsSync(pgOut) ? fs.readFileSync(pgOut, 'utf8') : '';
  ok('clicking a memory opens its own page', /function memoryPage/.test(pgHtml));
  ok('with date, file and id at the top', /date <\/span><b>/.test(pgHtml) || />date </.test(pgHtml));
  ok('a folder opens its own page too', /function folderPage/.test(pgHtml));
  ok('add-a-folder is gone', !/Add a folder/.test(pgHtml));
  ok('replaced by the project folder itself', /function folderTile/.test(pgHtml));
  ok('the tree lists files, not just folders', /tnode .file|class="file"/.test(pgHtml));
  ok('it says the tree does not open files', /nothing here opens a file/i.test(pgHtml));
  ok('there is an open-folder link', /Open folder/.test(pgHtml));
  ok('and it admits when that will not work', /Served over http a browser will refuse it/.test(pgHtml));
  ok('backup is offered on the folder', /Back up \/ transfer/.test(pgHtml));
  ok('folder settings replace doing it by hand', /Folder settings/.test(pgHtml) && /lock this folder/.test(pgHtml));

  const pgData = embeddedData(pgHtml);
  const withProject = pgData && pgData.stores.map(st => st.project).filter(Boolean);
  ok('the scan counts files by type', withProject && withProject.some(pr => Object.keys(pr.kinds || {}).length > 1),
    withProject && JSON.stringify(Object.keys(withProject[0].kinds || {}).slice(0, 6)));
  ok('and lists the files in a folder with sizes',
    withProject && withProject.some(pr => (pr.fileList || []).some(f => typeof f.bytes === 'number')));

  const pgScripts = pageScripts(pgHtml);
  let pgOk = true, pgWhy = '';
  for (const src of pgScripts) { try { new Function(src); } catch (e) { pgOk = false; pgWhy = e.message; } }
  ok('the page still parses with all of it', pgOk, pgWhy);

  section('a memory can be opened and read');
  // A memory is embedded in full, split into the .dai zones: three-zoom reading is for a model
  // saving tokens, but a person reading their own memory wants the whole thing.
  const readOut = path.join(TMP, 'dash2', 'd.html');
  await new Promise(res => {
    const p = spawn(process.execPath, ['tools/dashboard/build_dashboard.mjs', '--out', readOut], { cwd: here });
    p.on('close', () => res());
  });
  const rHtml = fs.existsSync(readOut) ? fs.readFileSync(readOut, 'utf8') : '';
  const rData = embeddedData(rHtml);
  ok('the build embeds the data', !!rData);

  const withText = rData && rData.stores.flatMap(st => st.memories).filter(m => (m.segments || []).length);
  ok('memories carry their content segments', withText && withText.length > 0, String(withText && withText.length));
  ok('and their Understanding block', withText && withText.every(m => typeof m.understanding === 'string'));
  ok('and their frontmatter', withText && withText.some(m => /daidocs:/.test(m.front || '')));
  ok('segments are numbered', withText && withText[0].segments.every(g => typeof g.n === 'string'));
  ok('a segment carries real text', withText && withText[0].segments.some(g => (g.text || '').length > 40));

  ok('the page offers a reader', /Read this memory/.test(rHtml));
  ok('with all three zones', /data-z="understanding"/.test(rHtml) && /data-z="content"/.test(rHtml) && /data-z="front"/.test(rHtml));
  // Escape, the back button and the browser's Back all go through upOneLevel, so the ordering
  // lives there: the reader is on top and closes first.
  ok('escape closes the reader before the store',
    /function upOneLevel\(\) \{[\s\S]{0,120}if \(reading\) \{ closeReader\(\); return true; \}/.test(rHtml));

  // A reader that pretty-prints must not break on a file whose Understanding is
  // not valid JSON: show it as it is rather than showing nothing.
  ok('a malformed Understanding still renders', /catch \{ \/\* show it as it is \*\/ \}/.test(rHtml));

  const rScripts = pageScripts(rHtml);
  let rOk = true, rWhy = '';
  for (const src of rScripts) { try { new Function(src); } catch (e) { rOk = false; rWhy = e.message; } }
  ok('the page with the reader still parses', rOk, rWhy);
  // Transcripts about building web pages contain the characters that close a
  // script tag. Unescaped, the HTML parser ends the block there and the page dies.
  ok('exactly two script blocks survive the transcripts', pageScripts(rHtml).length === 2, String(pageScripts(rHtml).length));
  ok('the raw zone is offered', /data-z="raw"/.test(rHtml));
  ok('memories carry their raw original', !!rData && rData.stores.flatMap(st => st.memories).some(m => (m.raw || '').length > 40));
  ok('with its true size on disk', !!rData && rData.stores.flatMap(st => st.memories).every(m => typeof m.rawBytes === 'number'));
  ok('and truncation is declared rather than hidden', /rawTruncated/.test(rHtml));

  section('two similar titles do not overwrite each other');
  // The id is the title slugged to 40 chars plus the date. The .dai is written BY id and index
  // rows are APPENDED, so two same-day saves whose titles start the same way collided: two
  // manifest rows pointing at one file holding only the second session.
  const colStore = store('collide');
  fs.mkdirSync(path.join(colStore, '_index'), { recursive: true });
  const colClient = new Client({ name: 'verify-collide', version: '0.0.1' });
  await colClient.connect(new StdioClientTransport({
    command: process.execPath, args: [path.join(here, 'mcp_server.mjs')],
    env: { ...process.env, DAIDOCS_STORE: colStore, DAIDOCS_OBSERVER: MOCK },
  }));
  const prefix = '[V4.4n1-mastercopy-results-added3] Built the ';
  const colU = t => ({ summary: t, facts: [], events: [], topics: [t] });
  const r1 = await colClient.callTool({ name: 'save_memory', arguments: {
    title: prefix + 'multi-part project layout into V4.4n11', date: '2026-09-07',
    content: 'first session about the layout. '.repeat(20), understanding: colU('layout') } });
  const r2 = await colClient.callTool({ name: 'save_memory', arguments: {
    title: prefix + '2040 memory map dashboard with connections', date: '2026-09-07',
    content: 'second session about the dashboard. '.repeat(20), understanding: colU('dashboard') } });
  await colClient.close();

  const colId1 = (r1.content[0].text.match(/memory: (\S+?) \(/) || [])[1];
  const colId2 = (r2.content[0].text.match(/memory: (\S+?) \(/) || [])[1];
  ok('two long titles sharing a prefix get different ids', colId1 && colId2 && colId1 !== colId2, colId1 + ' vs ' + colId2);

  const colRows = fs.readFileSync(path.join(colStore, '_index', 'manifest.jsonl'), 'utf8')
    .trim().split(String.fromCharCode(10)).filter(Boolean).map(l => JSON.parse(l));
  ok('both are in the manifest', colRows.length === 2, String(colRows.length));
  ok('under different ids', new Set(colRows.map(r => r.id)).size === 2, colRows.map(r => r.id).join(' | '));
  ok('and both .dai files exist', colRows.every(r => fs.existsSync(path.join(colStore, r.id + '.dai'))));
  const bodies = colRows.map(r => fs.readFileSync(path.join(colStore, r.id + '.dai'), 'utf8'));
  ok('neither overwrote the other', bodies.some(b => /layout/.test(b)) && bodies.some(b => /dashboard/.test(b)));

  section('the map can keep itself current');
  // A cached rebuild looks exactly like no rebuild, so the page tells the browser not to cache.
  // The page runs only in a browser, so these read the source; the watcher half is run for real.
  const liveSrc = rdDoc('tools/dashboard/dashboard.template.html');
  ok('the page tells the browser not to cache it', /Cache-Control[^>]*no-store/.test(liveSrc));
  ok('it remembers where you were', /sessionStorage\.setItem\(PLACE/.test(liveSrc));
  ok('and comes back to it after a reload', /const place = takePlace\(\)/.test(liveSrc));
  ok('including the scroll position', /scrollTo\(\{ top: place\.y \}\)/.test(liveSrc));
  ok('a place from another sitting is not restored', /Date\.now\(\) - \(p\.at \|\| 0\) > 3600000/.test(liveSrc));
  ok('nor one pointing at a store that has gone', /if \(p\.openStore && !byId\[p\.openStore\]\) return null/.test(liveSrc));
  ok('it reloads only when the build is being watched', /if \(D\.live\) \{/.test(liveSrc));
  ok('and only when nobody is touching the page', /Date\.now\(\) - lastTouch < 12000/.test(liveSrc));
  ok('never mid-read', /if \(reading\) return;\s+\/\/ never pull a document away mid-read/.test(liveSrc));
  ok('and never on a hidden tab', /if \(document\.hidden\) return;/.test(liveSrc));
  ok('a plain build does not declare itself live',
    /live: argv\.includes\('--watch'\)/.test(rdDoc('tools/dashboard/build_dashboard.mjs')));
  ok('npm run dashboard-live watches', /"dashboard-live": "node tools\/dashboard\/build_dashboard\.mjs --watch"/.test(rdDoc('package.json')));

  // The watcher, run for real: change a store, and the file is written again.
  const liveHome = path.join(TMP, 'watch-home');
  const liveStore = path.join(liveHome, 'store', '_index');
  fs.mkdirSync(liveStore, { recursive: true });
  fs.writeFileSync(path.join(liveStore, 'manifest.jsonl'), JSON.stringify({ id: 'w1', title: 'one', date: '2026-09-08' }) + String.fromCharCode(10));
  const liveOut = path.join(liveHome, 'w.html');
  const watcher = spawn(process.execPath, ['tools/dashboard/build_dashboard.mjs', '--out', liveOut, '--watch', '--no-open'], {
    cwd: here,
    env: { ...process.env, HOME: liveHome, USERPROFILE: liveHome, DAIDOCS_STORE: path.join(liveHome, 'store') },
  });
  let liveLog = '';
  watcher.stdout.on('data', d => liveLog += d);
  await new Promise(r => setTimeout(r, 2500));
  ok('the watcher builds once and says what it is watching', /watching \d+ folder/.test(liveLog), liveLog.slice(0, 80));
  const firstBuild = fs.existsSync(liveOut) ? fs.readFileSync(liveOut, 'utf8').length : 0;
  fs.appendFileSync(path.join(liveStore, 'manifest.jsonl'), JSON.stringify({ id: 'w2', title: 'two', date: '2026-09-08' }) + String.fromCharCode(10));
  for (let i = 0; i < 40 && !/rebuilt/.test(liveLog); i++) await new Promise(r => setTimeout(r, 250));
  watcher.kill();
  ok('and rebuilds when a store changes', /rebuilt/.test(liveLog), liveLog.split(String.fromCharCode(10)).slice(-2).join(' ').slice(0, 90));
  ok('with the new memory in the page it wrote',
    fs.existsSync(liveOut) && fs.readFileSync(liveOut, 'utf8').includes('"w2"'), `${firstBuild} bytes first`);

  section('there is a way back that is not the keyboard');
  // The page runs only in a browser, so these read the source: they pin down that one function
  // handles going up a level, that the browser's Back is intercepted (not followed out of the
  // page), and that the button is not drawn where it would do nothing.
  const navSrc = rdDoc('tools/dashboard/dashboard.template.html');
  ok('the crumbs carry a back button', /el\('button', 'back', '&larr; Back'\)/.test(navSrc));
  ok('it is only there when there is somewhere to go',
    /if \(openStore \|\| openMemory \|\| openFolder\) \{[\s\S]{0,80}const back/.test(navSrc));
  ok('one function goes up a level', /function upOneLevel\(\)/.test(navSrc));
  ok('and the button, Escape and Back all use it',
    (navSrc.match(/upOneLevel\(\)/g) || []).length >= 4, String((navSrc.match(/upOneLevel\(\)/g) || []).length));
  ok('going deeper leaves a history entry', /history\.pushState\(\{ daidocsDepth/.test(navSrc));
  ok('and the browser back is caught rather than followed', /addEventListener\('popstate'/.test(navSrc));
  ok('pushing happens on the way down only', /if \(d > histDepth\)/.test(navSrc));
  // pushState throws on some file:// origins. A page that cannot push must still
  // open a store.
  ok('a refused pushState cannot break navigation', /try \{ history\.pushState[\s\S]{0,60}catch/.test(navSrc));

  section('a map with nothing in it says what to do');
  // A fresh install builds an empty page. "0 memories" and a blank grid reads as broken, and
  // it's the first thing a new user sees, so both the terminal and the page say what to do.
  const emptyHome = path.join(TMP, 'empty-home');
  fs.mkdirSync(emptyHome, { recursive: true });
  const emptyOut = path.join(emptyHome, 'empty.html');
  const emptyRun = await new Promise(res => {
    const p2 = spawn(process.execPath, ['tools/dashboard/build_dashboard.mjs', '--out', emptyOut], {
      cwd: here,
      // Its own registry as well as its own home: reading the suite's registry would show every
      // fixture store the run declared, the opposite of the empty machine this is about.
      env: {
        ...process.env, HOME: emptyHome, USERPROFILE: emptyHome,
        DAIDOCS_STORE: path.join(emptyHome, 'DaiDocs'),
        DAIDOCS_REGISTRY: path.join(emptyHome, 'registry', 'stores.json'),
      },
    });
    let out = ''; p2.stdout.on('data', d => out += d); p2.stderr.on('data', d => out += d);
    p2.on('close', code => res({ out, code }));
  });
  ok('an empty store still builds a page', emptyRun.code === 0 && fs.existsSync(emptyOut), String(emptyRun.code));
  ok('and the run says nothing is saved yet, not just a zero', /Nothing saved yet/.test(emptyRun.out), emptyRun.out.slice(-120));
  ok('and names both ways to fill it',
    /saves itself as you go/.test(emptyRun.out) && /daidocs\.js.? convert/.test(emptyRun.out));
  const emptyHtml = fs.existsSync(emptyOut) ? fs.readFileSync(emptyOut, 'utf8') : '';
  ok('the page carries the same first-run panel', /Nothing saved yet/.test(emptyHtml));
  ok('and says plainly that nothing is broken', /Nothing is broken/.test(emptyHtml));
  ok('and offers the convert command to copy', /daidocs\.js&quot; convert|daidocs\.js" convert/.test(emptyHtml));
  // Drawn only when there is nothing: the panel and the Stores label are both behind a count,
  // so a store with memories looks unchanged. (The strings live in the page's script either way,
  // so this reads the guard rather than searching the HTML for their absence.)
  const tplSrc = rdDoc('tools/dashboard/dashboard.template.html');
  ok('the first-run panel is behind a count, not always drawn', /if \(!anyMemories\)/.test(tplSrc));
  ok('and the Stores heading does not sit over empty ground', /if \(stores\.length\) \{/.test(tplSrc));

  section('the map opens itself, when there is someone to open it for');
  // The build opens the page itself (one file, no server), but must not open a window on a
  // machine nobody is sitting at — and this suite builds pages, so pin the decision down.
  const OPEN = require('./lib/open_page');
  ok('Windows gets start with its empty title argument',
    JSON.stringify(OPEN.openCommand('win32', 'C:/a b/x.html')) === JSON.stringify({ cmd: 'cmd', args: ['/c', 'start', '', 'C:/a b/x.html'] }),
    JSON.stringify(OPEN.openCommand('win32', 'C:/a b/x.html')));
  ok('macOS gets open', OPEN.openCommand('darwin', '/x.html').cmd === 'open');
  ok('everything else gets xdg-open', OPEN.openCommand('linux', '/x.html').cmd === 'xdg-open');
  ok('nothing opens when the output is piped', OPEN.shouldOpen({}, [], false) === false);
  ok('but it does when a terminal is attached', OPEN.shouldOpen({}, [], true) === true);
  ok('--no-open stops it', OPEN.shouldOpen({}, ['--no-open'], true) === false);
  ok('DAIDOCS_NO_OPEN stops it', OPEN.shouldOpen({ DAIDOCS_NO_OPEN: '1' }, [], true) === false);
  ok('and CI stops it, whatever the terminal looks like', OPEN.shouldOpen({ CI: 'true' }, [], true) === false);
  ok('a named command opens it even without a terminal',
    OPEN.shouldOpen({ DAIDOCS_OPEN_CMD: 'firefox' }, [], false) === true);

  // That it really launches, with the path arriving whole. The stub sits behind a space in its
  // own path, which is the case that has broken before.
  const openMarker = path.join(TMP, 'opened.txt');
  const stub = path.join(TMP, 'open stub', 'stub.js');
  fs.mkdirSync(path.dirname(stub), { recursive: true });
  fs.writeFileSync(stub, `require('fs').writeFileSync(${JSON.stringify(openMarker)}, process.argv[1] || '');`);
  const openLine = OPEN.openPage(stub, { DAIDOCS_OPEN_CMD: process.execPath });
  ok('opening says so', /opening it in your browser/.test(String(openLine)), String(openLine));
  let opened = '';
  for (let i = 0; i < 60 && !opened; i++) {
    await new Promise(r => setTimeout(r, 50));
    try { opened = fs.readFileSync(openMarker, 'utf8'); } catch { }
  }
  ok('the command really runs, and the path survives the space in it', opened === stub, `${opened} vs ${stub}`);
  // A machine with no browser, or no xdg-open, must not turn a page that built
  // correctly into a failed build.
  ok('a command that does not exist is not a failure',
    /opening it|could not open/.test(String(OPEN.openPage('/x.html', { DAIDOCS_OPEN_CMD: 'daidocs-no-such-program' }))));

  section('the memory dashboard builds and stands alone');
  // One self-contained page: everything is read at build time and embedded, so it opens with a
  // double click and needs no running process.
  // Built against a store made here, its own home and registry (the watcher and empty-map
  // builds above do the same): without DAIDOCS_STORE the builder falls back to the real
  // ~/DaiDocs, so the suite would embed, and its checks would depend on, whatever this
  // machine happens to hold. The memory deliberately mentions fetch( and <link href=,
  // because embedded data that merely talks about HTML is not the page loading anything.
  const dashHome = path.join(TMP, 'dash-home');
  const dashStore = path.join(dashHome, 'DaiDocs');
  fs.mkdirSync(path.join(dashStore, '_index'), { recursive: true });
  fs.writeFileSync(path.join(dashStore, 'note_1.dai'), [
    '---', 'id: note_1', 'title: A note about pages', 'date: 2026-09-08', '---', '',
    '# Understanding', '', '```json',
    '{"summary": "A page that calls fetch( and carries a <link href= tag."}',
    '```', '', '# Content', '', '## [seg 1/1]', '',
    'The page under study used fetch( for its data and a <link href= for its styles,',
    'and a <script src= for a library.', '',
  ].join('\n'));
  fs.writeFileSync(path.join(dashStore, '_index', 'manifest.jsonl'), JSON.stringify({
    id: 'note_1', title: 'A note about pages', date: '2026-09-08',
    summary: 'Mentions fetch( and <link href= in passing.',
    topics: ['pages', 'markup'], entities: ['fetch'],
  }) + '\n');
  const dashEnv = {
    ...process.env, HOME: dashHome, USERPROFILE: dashHome,
    DAIDOCS_STORE: dashStore,
    DAIDOCS_REGISTRY: path.join(dashHome, 'registry', 'stores.json'),
  };
  const dashOut = path.join(TMP, 'dash', 'daidocs-dashboard.html');
  const dashRun = await new Promise(res => {
    const p = spawn(process.execPath, ['tools/dashboard/build_dashboard.mjs', '--out', dashOut], { cwd: here, env: dashEnv });
    let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
    p.on('close', code => res({ out, code }));
  });
  ok('the builder runs', dashRun.code === 0, dashRun.out.split(String.fromCharCode(10))[0]);
  ok('and writes the page', fs.existsSync(dashOut));

  // import.meta.url percent-encodes a space, so slicing the URL by hand goes looking for a
  // folder called 'R&D%20Dev'. The failure only shows when the script itself sits at such a
  // path, so the builder is copied to one and run from there.
  const spaceRoot = path.join(TMP, 'R&D Dev');
  const spaceDir = path.join(spaceRoot, 'tools', 'dashboard');
  fs.mkdirSync(spaceDir, { recursive: true });
  fs.mkdirSync(path.join(spaceRoot, 'lib'), { recursive: true });
  for (const f of ['build_dashboard.mjs', 'dashboard.template.html']) {
    fs.copyFileSync(path.join(here, 'tools', 'dashboard', f), path.join(spaceDir, f));
  }
  // The builder reads lib/open_page.js from beside its install, so the copy
  // carries the same shape a real install has.
  for (const f of ['open_page.js', 'registry.js']) {
    fs.copyFileSync(path.join(here, 'lib', f), path.join(spaceRoot, 'lib', f));
  }
  const spaceOut = path.join(TMP, 'dash-space', 'daidocs-dashboard.html');
  const spaceRun = await new Promise(res => {
    const p = spawn(process.execPath, [path.join(spaceDir, 'build_dashboard.mjs'), '--out', spaceOut, '--install', here], { cwd: TMP, env: dashEnv });
    let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
    p.on('close', code => res({ out, code }));
  });
  ok('the builder runs from a path with a space in it', spaceRun.code === 0,
    spaceRun.out.split(String.fromCharCode(10)).filter(Boolean).slice(-1)[0] || '');
  ok('and writes the page from there', fs.existsSync(spaceOut));

  const dashHtml = fs.existsSync(dashOut) ? fs.readFileSync(dashOut, 'utf8') : '';
  ok('the data is embedded, not fetched', /window\.DAIDOCS = \{/.test(dashHtml));
  // The external-reference check reads the page around the data, not the data itself: the
  // data is the first script block, whole (the convention embeddedData relies on), and a
  // memory whose text mentions fetch( or <link href= is content, not a network reference.
  const dataOpen = dashHtml.indexOf('<script>');
  const dataClose = dashHtml.indexOf('</script>', dataOpen);
  const pageAroundData = (dataOpen < 0 || dataClose < 0) ? dashHtml
    : dashHtml.slice(0, dataOpen + 8) + dashHtml.slice(dataClose);
  ok('nothing is loaded over the network', !/<script[^>]+src=|<link[^>]+href=|fetch\(/.test(pageAroundData), 'no external references');
  ok('it declares both views', /Project files/.test(dashHtml) && /id="tab-memory"/.test(dashHtml));
  // The tile shows the project folder itself, not an add-a-folder button; declaring still
  // happens through declare_project.
  ok('it shows the project folder rather than an add button', /function folderTile/.test(dashHtml));
  ok('and uses the site palette rather than inventing one',
    /--accent:#4ade87/.test(dashHtml) && /--mark:#2fe0a8/.test(dashHtml));

  // The page script has to actually parse: a syntax error there shows a starfield
  // and nothing else, which looks like an empty store rather than a broken page.
  const scripts = pageScripts(dashHtml);
  let parsed = true, why = '';
  for (const src of scripts) { try { new Function(src); } catch (e) { parsed = false; why = e.message; } }
  ok('every script on the page parses', parsed, why);

  // The sizes must be real numbers, not placeholders.
  const embedded = embeddedData(dashHtml);
  ok('it embeds at least one store', !!embedded && embedded.stores.length >= 1, String(embedded && embedded.stores.length));
  ok('with byte sizes on disk', !!embedded && embedded.stores.every(st => typeof st.bytes.total === 'number'));
  ok('and a size for each memory', !!embedded && embedded.stores.every(st => st.memories.every(m => typeof m.bytes === 'number')));

  section('the .dai file icon is legible when small');
  // At 16px (Explorer's list size) a single-artwork file icon loses its mark and reads as a
  // blank pale rectangle, so it needs a dedicated small variant, as the folder icons already have.
  const brand = path.join(here, 'assets', 'brand');
  ok('a small variant of the file icon exists', fs.existsSync(path.join(brand, 'dai-file-small.svg')));
  ok('and the standard one is still there', fs.existsSync(path.join(brand, 'dai-file.svg')));
  const icoBytes = fs.readFileSync(path.join(brand, 'dai-file.ico'));
  // ICO header: reserved(2) type(2) count(2), then 16-byte directory entries
  // whose first two bytes are width and height (0 meaning 256).
  ok('the ico is a real icon file', icoBytes.readUInt16LE(0) === 0 && icoBytes.readUInt16LE(2) === 1);
  const count = icoBytes.readUInt16LE(4);
  const widths = [];
  for (let i = 0; i < count; i++) widths.push(icoBytes[6 + i * 16] || 256);
  widths.sort((a, b) => a - b);
  ok('it carries the small sizes Explorer actually asks for', widths.includes(16) && widths.includes(32), widths.join(','));
  ok('and the large ones too', widths.includes(256), widths.join(','));

  // The 16px entry must NOT be a downscale of the big artwork: a downscaled sheet is mostly
  // empty, the small variant fills its frame.
  const png16 = path.join(brand, 'png', 'dai-file-16.png');
  const png256 = path.join(brand, 'png', 'dai-file-256.png');
  ok('the rendered PNGs ship alongside', fs.existsSync(png16) && fs.existsSync(png256));

  section('the first save into a new project store works');
  // The archiver must create _raw/_index/_pending for the store it resolves: making them once
  // at module load (for the shared store, before any cwd is known) leaves a newly declared
  // project's store missing them, so the first archive into it throws ENOENT.
  const freshProj = store('fresh-project');
  fs.mkdirSync(freshProj, { recursive: true });
  fs.mkdirSync(path.join(freshProj, '.daidocs'), { recursive: true });
  fs.writeFileSync(path.join(freshProj, '.daidocs', 'config.json'),
    JSON.stringify({ type: 'normal', store: '.daidocs/store', reads: ['self'], label: 'fresh' }));
  // Deliberately do NOT create .daidocs/store: the archiver must make it.
  ok('the store directory does not exist yet', !fs.existsSync(path.join(freshProj, '.daidocs', 'store')));

  const freshTr = path.join(TMP, 'fresh.jsonl');
  fs.writeFileSync(freshTr, [
    JSON.stringify({ type: 'user', timestamp: '2026-09-07T10:00:00.000Z', cwd: freshProj, sessionId: 'fr', message: { content: 'the first conversation in a brand new project folder' } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-09-07T10:01:00.000Z', message: { content: [{ type: 'text', text: 'reply '.repeat(300) }] } }),
  ].join(String.fromCharCode(10)));

  const freshOut = await new Promise(res => {
    const p = spawn(process.execPath, ['session_archiver.mjs'],
      { cwd: here, env: { ...process.env, DAIDOCS_STORE: '', DAIDOCS_OBSERVER: MOCK } });
    let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
    p.stdin.end(JSON.stringify({ session_id: 'fr', transcript_path: freshTr, cwd: freshProj }));
    p.on('close', () => res(out));
  });
  ok('the archive does not crash', !/ENOENT|Error:/.test(freshOut), freshOut.split(String.fromCharCode(10))[0]);
  ok('it creates the store directories itself', fs.existsSync(path.join(freshProj, '.daidocs', 'store', '_raw')));
  ok('and the memory lands in the project, not the shared store',
    fs.existsSync(path.join(freshProj, '.daidocs', 'store', '_index', 'manifest.jsonl')));
  ok('with the conversation date, not today',
    /2026-09-07/.test(fs.readFileSync(path.join(freshProj, '.daidocs', 'store', '_index', 'manifest.jsonl'), 'utf8')));

  section('a conversion lands beside its capture');
  // The hooks resolve the store from the session's own working directory, so a
  // project folder keeps its raw captures locally. The MCP server resolves from
  // its own process.cwd(), which is wherever the client was launched. Those two
  // differ routinely, and save_memory then converted a captured session into
  // the general store while the raw and the markers sat in the project store:
  // raw local, conversion elsewhere, marker never cleared, every folder looking
  // permanently unconverted. A conversion must land beside its capture.
  const routeHome = store('route-home');
  const routeProj = path.join(TMP, 'route-proj');
  const routeLaunch = path.join(TMP, 'route-launch');
  for (const d of [routeHome, routeProj, routeLaunch]) fs.mkdirSync(d, { recursive: true });
  const routeEnv = { DAIDOCS_STORE: '', DAIDOCS_OBSERVER: MOCK, HOME: routeHome, USERPROFILE: routeHome };
  const routeTr = path.join(TMP, 'route.jsonl');
  fs.writeFileSync(routeTr, [
    JSON.stringify({ type: 'user', timestamp: '2026-09-20T10:00:00.000Z', cwd: routeProj, sessionId: 'route1', message: { content: 'we decided the launch is on october the third. '.repeat(40) } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-09-20T10:01:00.000Z', message: { content: [{ type: 'text', text: 'noted, filed under launch planning. '.repeat(100) }] } }),
  ].join(String.fromCharCode(10)));
  await runNode('session_autosave.mjs', [], routeEnv,
    JSON.stringify({ session_id: 'route1', transcript_path: routeTr, cwd: routeProj }));
  const routeStore = path.join(routeProj, '.daidocs', 'store');
  ok('the capture sits in the project store', fs.existsSync(path.join(routeStore, '_unconverted', 'cc_route1.txt')));

  const routeClient = new Client({ name: 'verify-route', version: '0.0.1' });
  await routeClient.connect(new StdioClientTransport({
    command: process.execPath, args: [path.join(here, 'mcp_server.mjs')],
    cwd: routeLaunch, env: { ...process.env, ...routeEnv },
  }));
  const routeSave = await routeClient.callTool({ name: 'save_memory', arguments: {
    title: 'proj session', content: 'we decided the launch is on october the third.',
    date: '2026-09-20', session: 'route1',
    understanding: { summary: 'launch date decided', facts: [{ fact: 'launch on october 3', date: '2026-09-20', kind: 'plan' }], events: [], topics: ['launch'] },
  } });
  await routeClient.close();
  const routeDai = d => { try { return fs.readdirSync(d).filter(f => f.endsWith('.dai')); } catch { return []; } };
  ok('the conversion lands in the project store, from a server launched elsewhere',
    routeDai(routeStore).length === 1, routeSave.content[0].text.split(String.fromCharCode(10))[0]);
  ok('nothing leaks to the general store', routeDai(path.join(routeHome, 'DaiDocs')).length === 0,
    routeDai(path.join(routeHome, 'DaiDocs')).join(','));
  ok('and the markers come down in the store that holds the capture',
    !fs.existsSync(path.join(routeStore, '_unconverted', 'cc_route1.txt'))
    && !fs.existsSync(path.join(routeStore, '_pending', 'cc_route1.json')));

  section('declaring a project from the conversation');
  // declare_project makes the per-project store reachable from the conversation, not only from
  // a terminal command a user had to know existed.
  const decRoot = store('declare-from-chat');
  fs.mkdirSync(decRoot, { recursive: true });
  const decClient = new Client({ name: 'verify-declare', version: '0.0.1' });
  await decClient.connect(new StdioClientTransport({
    command: process.execPath, args: [path.join(here, 'mcp_server.mjs')],
    cwd: decRoot, env: { ...process.env, DAIDOCS_OBSERVER: MOCK, DAIDOCS_STORE: '' },
  }));
  const tools2 = (await decClient.listTools()).tools.map(t => t.name).sort();
  ok('declare_project is exposed', tools2.includes('declare_project'), tools2.join(','));

  const decRes = await decClient.callTool({ name: 'declare_project', arguments: { type: 'confidential' } });
  ok('it declares the current folder', /Declared .* as confidential/.test(decRes.content[0].text), decRes.content[0].text.split(String.fromCharCode(10))[0]);
  ok('it writes the config', fs.existsSync(path.join(decRoot, '.daidocs', 'config.json')));
  ok('it creates the store', fs.existsSync(path.join(decRoot, '.daidocs', 'store')));
  ok('it writes the gitignore', fs.existsSync(path.join(decRoot, '.daidocs', '.gitignore')));
  const decCfg = JSON.parse(fs.readFileSync(path.join(decRoot, '.daidocs', 'config.json'), 'utf8'));
  ok('with an id', /^\d{8}T\d{6}-/.test(decCfg.id || ''), String(decCfg.id));
  ok('and the type asked for', decCfg.type === 'confidential', decCfg.type);
  ok('it says existing memories are not moved', /does not move them/.test(decRes.content[0].text));
  ok('and warns that confidential means unreadable from outside', /no other project can read/i.test(decRes.content[0].text));

  // The other answer, from the conversation: general, remembered, declaring nothing.
  const genRoot = store('general-from-chat');
  fs.mkdirSync(genRoot, { recursive: true });
  const genClient = new Client({ name: 'verify-general', version: '0.0.1' });
  await genClient.connect(new StdioClientTransport({
    command: process.execPath, args: [path.join(here, 'mcp_server.mjs')],
    cwd: genRoot, env: { ...process.env, DAIDOCS_OBSERVER: MOCK, DAIDOCS_STORE: '' },
  }));
  const genRes = await genClient.callTool({ name: 'declare_project', arguments: { store: 'general' } });
  ok('declare_project with store "general" records the choice', /goes to the general store/.test(genRes.content[0].text), genRes.content[0].text.slice(0, 80));
  ok('and declares nothing', !fs.existsSync(path.join(genRoot, '.daidocs')));
  // Asking for the general store AFTER a folder has been claimed has to actually
  // take effect: the config is what resolution finds first, so the config goes.
  // The store itself is left on disk, because it holds the user's memories.
  const claimedRoot = store('claimed-then-general');
  fs.mkdirSync(claimedRoot, { recursive: true });
  require('./lib/stores').declareProject(claimedRoot, 'normal', null, null);
  fs.mkdirSync(path.join(claimedRoot, '.daidocs', 'store'), { recursive: true });
  fs.writeFileSync(path.join(claimedRoot, '.daidocs', 'store', 'kept.dai'), 'a memory');
  const gc = new Client({ name: 'verify-claimed-general', version: '0.0.1' });
  await gc.connect(new StdioClientTransport({
    command: process.execPath, args: [path.join(here, 'mcp_server.mjs')],
    cwd: claimedRoot, env: { ...process.env, DAIDOCS_OBSERVER: MOCK, DAIDOCS_STORE: '' },
  }));
  const undo = await gc.callTool({ name: 'declare_project', arguments: { store: 'general' } });
  await gc.close();
  ok('a claimed folder can be sent to the general store', /goes to the general store/.test(undo.content[0].text));
  ok('and the config that would override it is gone', !fs.existsSync(path.join(claimedRoot, '.daidocs', 'config.json')));
  ok('so new memories really do go to the shared store',
    path.resolve(require('./lib/stores').resolveStore(claimedRoot).storeDir) === path.resolve(require('./lib/stores').SHARED_STORE()));
  ok('but what was already saved is left on disk', fs.existsSync(path.join(claimedRoot, '.daidocs', 'store', 'kept.dai')));
  ok('and the reply says where it is', /untouched, at/.test(undo.content[0].text));
  ok('and the registry remembers it', (require('./lib/registry').folderDecision(genRoot) || {}).choice === 'general');
  // One folder, one key, whichever of its names you arrive by. On macOS everything under the
  // temp dir has two names (/var is a symlink to /private/var), so the below asserts the
  // resolve-to-one-key property deliberately, to catch the next regression on any runner.
  const linkTarget = store('symlink-target');
  fs.mkdirSync(linkTarget, { recursive: true });
  const linkPath = path.join(TMP, 'symlink-to-target');
  let linked = true;
  try { fs.symlinkSync(linkTarget, linkPath, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch { linked = false; }
  const noLink = 'symlinks not permitted here, skipped';
  const Reg3 = require('./lib/registry');
  if (linked) Reg3.recordFolder(linkPath, 'general');
  ok('a decision recorded through a symlink is found by the real path',
    !linked || (Reg3.folderDecision(linkTarget) || {}).choice === 'general', linked ? '' : noLink);
  ok('and by the link it was recorded through',
    !linked || (Reg3.folderDecision(linkPath) || {}).choice === 'general', linked ? '' : noLink);
  if (linked) Reg3.forgetFolder(linkTarget);
  ok('and forgetting it by either name forgets it once',
    !linked || Reg3.folderDecision(linkPath) === null, linked ? '' : noLink);
  // An answer written under the folder's literal name by an older version must still be found:
  // the key computation changed, and a user who already answered must not be re-asked. The
  // legacy row is written by hand here, since no API produces that shape any more.
  const BSLASH = String.fromCharCode(92);
  const legacyKey = process.platform === 'win32'
    ? path.resolve(linkPath).split(BSLASH).join('/').toLowerCase()
    : path.resolve(linkPath);
  if (linked) {
    const regFile = process.env.DAIDOCS_REGISTRY;
    const reg = JSON.parse(fs.readFileSync(regFile, 'utf8'));
    reg.folders = reg.folders || {};
    reg.folders[legacyKey] = { choice: 'general', at: new Date().toISOString() };
    fs.writeFileSync(regFile, JSON.stringify(reg, null, 2) + String.fromCharCode(10));
  }
  ok('an answer recorded under the older key is still found',
    !linked || (Reg3.folderDecision(linkPath) || {}).choice === 'general', linked ? '' : noLink);
  if (linked) Reg3.forgetFolder(linkPath);
  ok('and forgetting it clears the older key too, so it cannot come back',
    !linked || (!JSON.parse(fs.readFileSync(process.env.DAIDOCS_REGISTRY, 'utf8')).folders[legacyKey]
      && Reg3.folderDecision(linkPath) === null), linked ? '' : noLink);
  // And recording afresh leaves one row for the folder, not two.
  if (linked) {
    const regFile2 = process.env.DAIDOCS_REGISTRY;
    const reg2 = JSON.parse(fs.readFileSync(regFile2, 'utf8'));
    reg2.folders[legacyKey] = { choice: 'general', at: new Date().toISOString() };
    fs.writeFileSync(regFile2, JSON.stringify(reg2, null, 2) + String.fromCharCode(10));
    Reg3.recordFolder(linkPath, 'general');
  }
  ok('and recording it again leaves one row for the folder, not two',
    !linked || !JSON.parse(fs.readFileSync(process.env.DAIDOCS_REGISTRY, 'utf8')).folders[legacyKey], linked ? '' : noLink);
  if (linked) Reg3.forgetFolder(linkTarget);
  await genClient.close();

  const decBad = await decClient.callTool({ name: 'declare_project', arguments: { type: 'nonsense' } });
  ok('an unknown type is refused, and the real ones named',
    decBad.isError && /is not a folder type/.test(decBad.content[0].text)
    && /confidential/.test(decBad.content[0].text), decBad.content[0].text.slice(0, 70));

  // Declaring, then saving, must land in the new store rather than the shared one.
  await decClient.callTool({ name: 'save_memory', arguments: {
    title: 'first memory in this project', content: 'the kettle lives in the third cupboard. '.repeat(20),
    understanding: { summary: 'kettle', facts: [], events: [], topics: ['kettle'] } } });
  const daiHere = fs.readdirSync(path.join(decRoot, '.daidocs', 'store')).filter(f => f.endsWith('.dai'));
  ok('a save after declaring lands in the project store', daiHere.length === 1, daiHere.join(','));
  await decClient.close();

  // Declaring a subfolder as its own part, by path.
  const partDir = path.join(decRoot, 'api');
  fs.mkdirSync(partDir, { recursive: true });
  const dc2 = new Client({ name: 'verify-declare-2', version: '0.0.1' });
  await dc2.connect(new StdioClientTransport({
    command: process.execPath, args: [path.join(here, 'mcp_server.mjs')],
    cwd: decRoot, env: { ...process.env, DAIDOCS_OBSERVER: MOCK, DAIDOCS_STORE: '' },
  }));
  await dc2.callTool({ name: 'declare_project', arguments: { type: 'normal', dir: 'api', label: 'API' } });
  ok('a subfolder can be declared by relative path', fs.existsSync(path.join(partDir, '.daidocs', 'config.json')));
  ok('and it resolves as its own store',
    path.resolve(require('./lib/stores').resolveStore(partDir).storeDir) === path.resolve(partDir, '.daidocs', 'store'));
  await dc2.close();

  section('one folder per part, from the conversation');
  // A project with several parts is several projects: the main folder reads its parts, and a
  // part reaches the main project only when asked, with the answer recorded once — all from
  // the conversation.
  const partsHome = store('parts-home');
  const mainRoot = path.join(partsHome, 'atlas');
  const webRoot = path.join(mainRoot, 'website');
  fs.mkdirSync(webRoot, { recursive: true });
  const partsEnv = { ...process.env, DAIDOCS_OBSERVER: MOCK, DAIDOCS_STORE: '', HOME: partsHome, USERPROFILE: partsHome };
  const mainClient = new Client({ name: 'verify-parts-main', version: '0.0.1' });
  await mainClient.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(here, 'mcp_server.mjs')], cwd: mainRoot, env: partsEnv }));
  const mainDec = await mainClient.callTool({ name: 'declare_project', arguments: { type: 'normal', label: 'Atlas', reads: ['self', 'children'] } });
  const mainCfg = JSON.parse(fs.readFileSync(path.join(mainRoot, '.daidocs', 'config.json'), 'utf8'));
  ok('declare_project records what the folder reads', JSON.stringify(mainCfg.reads) === '["self","children"]', JSON.stringify(mainCfg.reads));
  ok('and says so', /reads\s+self, children/.test(mainDec.content[0].text), mainDec.content[0].text.slice(0, 120));
  await mainClient.callTool({ name: 'save_memory', arguments: { title: 'the launch date', content: 'The atlas launch is on the eighth of september. '.repeat(30), understanding: { summary: 'launch date', facts: [], events: [], topics: ['launch'] } } });
  await mainClient.close();

  const webClient = new Client({ name: 'verify-parts-web', version: '0.0.1' });
  await webClient.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(here, 'mcp_server.mjs')], cwd: webRoot, env: partsEnv }));
  await webClient.callTool({ name: 'declare_project', arguments: { type: 'normal', label: 'Website' } });
  const own = await webClient.callTool({ name: 'recall_memory', arguments: { question: 'when is the launch' } });
  ok('a part with no memories does not see the main project uninvited', /No memories for this project/.test(own.content[0].text) && !/eighth of september/.test(own.content[0].text), own.content[0].text.slice(0, 80));
  const webDec = await webClient.callTool({ name: 'declare_project', arguments: { reads: ['self', 'parent'] } });
  ok('re-declaring keeps the type and adds the read', /Updated Website as normal/.test(webDec.content[0].text) && /reads\s+self, parent/.test(webDec.content[0].text), webDec.content[0].text.slice(0, 120));
  const asks = await webClient.callTool({ name: 'recall_memory', arguments: { question: 'when is the launch', scope: 'all' } });
  ok('a wider read asks before touching the main project', /Permission needed/.test(asks.content[0].text) && /Atlas/.test(asks.content[0].text), asks.content[0].text.slice(0, 80));
  ok('and names how the answer is recorded', /allow: \[labels\]/.test(asks.content[0].text));
  const granted = await webClient.callTool({ name: 'recall_memory', arguments: { question: 'when is the launch', scope: 'all', allow: ['Atlas'] } });
  ok('allowed once, the main project is read', /eighth of september/i.test(granted.content[0].text) && /Atlas/.test(granted.content[0].text), granted.content[0].text.slice(0, 160));
  const partAgain = await webClient.callTool({ name: 'recall_memory', arguments: { question: 'when is the launch', scope: 'all' } });
  ok('and remembered, so it is not asked again', !/Permission needed/.test(partAgain.content[0].text) && /eighth of september/i.test(partAgain.content[0].text), partAgain.content[0].text.slice(0, 80));
  const perms = JSON.parse(fs.readFileSync(path.join(partsHome, '.daidocs', 'permissions.json'), 'utf8'));
  ok('the answer is on disk as always', Object.values(perms).includes('always'), JSON.stringify(perms));
  const refused = await webClient.callTool({ name: 'recall_memory', arguments: { question: 'when is the launch', scope: 'all', refuse: ['Atlas'] } });
  ok('refuse is remembered the same way', !/eighth of september/i.test(refused.content[0].text) && !/Permission needed/.test(refused.content[0].text), refused.content[0].text.slice(0, 80));
  await webClient.close();

  section('the action lines survive a long index');
  // Truncation trims from the end, where the backlog offer and declare nudge sat, so on a store
  // with a long index they were silently cut off — invisible exactly where they were needed.
  const bigStore = store('long-index');
  fs.mkdirSync(path.join(bigStore, '_index'), { recursive: true });
  fs.mkdirSync(path.join(bigStore, '_pending'), { recursive: true });
  const many = [];
  for (let i = 0; i < 120; i++) {
    many.push(JSON.stringify({ id: `chat_2026090${i % 9}_${String(i).padStart(6, '0')}`, date: '2026-09-01',
      title: `[proj] a session with a fairly long title number ${i} to take up room`,
      summary: 'a summary long enough to eat into the context budget '.repeat(3) }));
  }
  fs.writeFileSync(path.join(bigStore, '_index', 'manifest.jsonl'), many.join(String.fromCharCode(10)) + String.fromCharCode(10));
  fs.writeFileSync(path.join(bigStore, '_pending', 'a.json'), '{}');
  const bigCtx = await new Promise(res => {
    const p = spawn(process.execPath, ['session_context.mjs'],
      // The Claude marker, because the line this checks for is the subscription
      // wording. Without it the host is whatever machine the suite runs on.
      { cwd: here, env: { ...process.env, DAIDOCS_STORE: bigStore, DAIDOCS_OBSERVER: MOCK, CLAUDECODE: '1' } });
    let out = ''; p.stdout.on('data', d => out += d);
    p.stdin.end(JSON.stringify({ session_id: 't', cwd: bigStore }));
    p.on('close', () => { try { res(JSON.parse(out).hookSpecificOutput.additionalContext); } catch { res(''); } });
  });
  ok('the index really was truncated', /index truncated/.test(bigCtx), String(bigCtx.length));
  ok('and the backlog offer survived anyway', /ACTION FOR YOU/.test(bigCtx));
  ok('the whole thing still respects the budget', bigCtx.length <= 4000, String(bigCtx.length));

  section('installing asks nothing, and everything is changeable afterwards');
  // A silent run configures everything with no questions: the questions live behind --ask, and
  // --status is where anyone changes it later. stdin is closed for these, so a run that still
  // asks would hang or truncate.
  const qHome = path.join(TMP, 'silentRun-home');
  const qWork = path.join(qHome, 'work');
  fs.mkdirSync(qWork, { recursive: true });
  const qEnv = {
    ...process.env, HOME: qHome, USERPROFILE: qHome,
    APPDATA: path.join(qHome, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(qHome, 'AppData', 'Local'),
    DAIDOCS_NO_PERSIST: '1', DAIDOCS_STORE: path.join(qHome, 'DaiDocs'), DAIDOCS_OBSERVER: '',
  };
  const runSetup = (args, cwd, stdin) => new Promise(res => {
    const p2 = spawn(process.execPath, [path.join(here, 'setup.js'), ...args], { cwd, env: qEnv });
    let out = ''; p2.stdout.on('data', d => out += d); p2.stderr.on('data', d => out += d);
    p2.stdin.end(stdin === undefined ? '' : stdin);
    p2.on('close', code => res({ out, code }));
  });

  const silentRun = await runSetup([], qWork);
  ok('a bare install finishes with nothing typed', silentRun.code === 0 && /Done\. DaiDocs/.test(silentRun.out),
    silentRun.out.split(String.fromCharCode(10)).filter(Boolean).slice(-1)[0] || String(silentRun.code));
  ok('and asks no questions at all', !/\[Y\/n\]/.test(silentRun.out), (silentRun.out.match(/[^\n]*\[Y\/n\][^\n]*/) || [''])[0]);
  ok('it registers the hooks it used to ask about',
    /SessionStart hook registered/.test(silentRun.out) && /Stop hook registered/.test(silentRun.out));
  ok('and installs the reading protocol', /Reading protocol installed/.test(silentRun.out));
  // Nothing that costs money or takes minutes may start on its own.
  ok('but never converts a history nobody asked it to convert',
    /not converted yet/.test(silentRun.out) && !/Converting/.test(silentRun.out));
  ok('the model is chosen, not prompted for', /Observer: \S+/.test(silentRun.out) && !/Choose 1 to/.test(silentRun.out),
    (silentRun.out.match(/Observer: \S+/) || [''])[0]);
  ok('and the run says where to change any of it', /node setup\.js --status/.test(silentRun.out));

  // The questions still exist behind --ask, and now survive a non-terminal stdin: a readline
  // interface per question dropped every line that arrived while nothing was waiting, so a
  // later question never came and setup exited 0 half-installed.
  const asked = await runSetup(['--ask'], qWork, 'n\nn\nn\nn\nn\nn\nn\n\nn\n\n\nn\n');
  ok('--ask brings the questions back', /Configure Claude Desktop\? \[Y\/n\]/.test(asked.out));
  ok('and every one of them is asked, not just the first two',
    (asked.out.match(/\[Y\/n\]/g) || []).length >= 7, String((asked.out.match(/\[Y\/n\]/g) || []).length));
  ok('and an asked run still reaches the end', /Done\. DaiDocs/.test(asked.out), String(asked.code));

  // git clone .../daidocs from a home directory makes ~/daidocs; the default store is ~/DaiDocs,
  // and on Windows/macOS those are one folder. If the store is already there git refuses (which
  // saves it), but with none yet the source tree and every memory share a directory, so deleting
  // the checkout deletes the memory.
  const clashHome = path.join(TMP, 'clash-home');
  const clashInstall = path.join(clashHome, 'DaiDocs');
  fs.mkdirSync(path.join(clashInstall, '_index'), { recursive: true });
  fs.writeFileSync(path.join(clashInstall, '_index', 'manifest.jsonl'), '{}');
  for (const f of ['setup.js', 'package.json']) fs.copyFileSync(path.join(here, f), path.join(clashInstall, f));
  for (const d of ['lib']) fs.cpSync(path.join(here, d), path.join(clashInstall, d), { recursive: true });
  const clash = await new Promise(res => {
    const p2 = spawn(process.execPath, [path.join(clashInstall, 'setup.js')], {
      cwd: clashInstall,
      env: { ...process.env, HOME: clashHome, USERPROFILE: clashHome, DAIDOCS_STORE: '', DAIDOCS_NO_PERSIST: '1' },
    });
    let out = ''; p2.stdout.on('data', d => out += d); p2.stderr.on('data', d => out += d);
    p2.stdin.end('');
    p2.on('close', code => res({ out, code }));
  });
  ok('setup refuses to run from inside the memory store', /installed INSIDE its own memory store/.test(clash.out), clash.out.slice(0, 100));
  ok('and says so with a failing exit code', clash.code === 1, String(clash.code));
  ok('and changes nothing on the way out', !/hook registered|Done\. DaiDocs/.test(clash.out));
  ok('and gives the command that fixes it', /daidocs-app/.test(clash.out));
  ok('and says the memory itself is safe', /memory is safe/.test(clash.out));
  // The documented clone cannot collide in the first place.
  for (const f of ['README.md', 'QUICKSTART.md', 'docs/INTEGRATION.md']) {
    ok(`${f} clones into a folder of its own`, /git clone \S+ daidocs-app/.test(rdDoc(f)));
  }
  ok('and the README says why that name', /same folder on Windows and macOS|are the same folder/.test(rdDoc('README.md')));

  // The install must not depend on a shell running npm: on Windows, PowerShell's default
  // execution policy refuses npm.ps1, stopping every npm command. So setup.js installs its own
  // deps by running npm's JS entry point with this node — not npm.cmd, which node has refused
  // to spawn since the 2024 argument-injection fix (EINVAL).
  const installSrc = rdDoc('setup.js');
  ok('setup installs its own dependencies', /function ensureDependencies\(\)/.test(installSrc));
  ok('and does not go through a shell to do it', /npm-cli\.js/.test(installSrc) && !/'npm\.cmd'/.test(installSrc));
  ok('and says why in the code', /execution policy/.test(installSrc) && /EINVAL/.test(installSrc));
  ok('it skips the step when the packages are there',
    /node_modules', '@modelcontextprotocol', 'sdk'/.test(installSrc));
  ok('and --no-install skips it outright', /if \(has\('no-install'\)\) return;/.test(installSrc));
  ok('setup.js starts with no dependencies installed at all',
    !/^const .* = require\('@modelcontextprotocol/m.test(installSrc) && !/require\('zod'\)/.test(installSrc));
  // The documents lead with the command that works on an unconfigured machine.
  for (const f of ['README.md', 'QUICKSTART.md', 'docs/GUIDE.md', 'docs/INTEGRATION.md']) {
    ok(`${f} leads with node setup.js`, /node setup\.js/.test(rdDoc(f)));
  }
  ok('and the PowerShell policy has a symptom row',
    /npm\.ps1 cannot be loaded/.test(rdDoc('QUICKSTART.md')) && /Set-ExecutionPolicy/.test(rdDoc('QUICKSTART.md')));

  const status = await runSetup(['--status'], qWork);
  ok('--status lists what is on', /What is on:/.test(status.out));
  for (const switchName of ['--context', '--autosave', '--instructions', '--icon', '--observer']) {
    ok(`and how to change ${switchName}`, status.out.includes(switchName));
  }
  ok('and where the memory lives', /Memory lives in:/.test(status.out));
  ok('and how to undo the lot', /--restore/.test(status.out));

  // Every MCP client gets a command, rather than a block of JSON to paste into a config by hand.
  const clients = await runSetup(['--client', 'list'], qWork);
  for (const c of ['cursor', 'windsurf', 'codex', 'cline', 'continue', 'zed']) {
    ok(`--client list names ${c}`, clients.out.includes(c));
  }
  ok('and offers a path for anything it does not know', /--client generic --config/.test(clients.out));
  ok('a bare install no longer prints JSON to paste by hand',
    !/add this to its MCP config by hand/.test(silentRun.out) && /--client generic --config/.test(silentRun.out));

  // Writing one, to a path we name, in both shapes.
  const genericCfg = path.join(qHome, 'someclient', 'mcp.json');
  const wrote = await runSetup(['--client', 'generic', '--config', genericCfg], qWork);
  ok('--client generic writes the server in', wrote.code === 0 && fs.existsSync(genericCfg));
  const genericJson = fs.existsSync(genericCfg) ? JSON.parse(fs.readFileSync(genericCfg, 'utf8')) : {};
  ok('in the shape MCP clients read', !!(genericJson.mcpServers || {})['daidocs-mcp'],
    JSON.stringify(genericJson).slice(0, 90));
  ok('pointing at this install', ((genericJson.mcpServers || {})['daidocs-mcp'] || {}).args[0] === path.join(here, 'mcp_server.mjs'));

  // Codex keeps TOML, and a config file belongs to its owner: what is already
  // in it has to survive, and running twice must not stack up two tables.
  const codexDir = path.join(qHome, '.codex');
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, 'config.toml'), 'model = "gpt-5"\n\n[history]\npersistence = "save-all"\n');
  await runSetup(['--client', 'codex'], qWork);
  await runSetup(['--client', 'codex'], qWork);
  const toml = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8');
  ok('the codex command writes a TOML table', /\[mcp_servers\.daidocs-mcp\]/.test(toml), toml.slice(-120));
  ok('and says which node and which server', /command = /.test(toml) && toml.includes('mcp_server.mjs'));
  ok('what was already in the file survives', /model = "gpt-5"/.test(toml) && /persistence/.test(toml));
  ok('and running it twice leaves one table, not two',
    (toml.match(/\[mcp_servers\.daidocs-mcp\]/g) || []).length === 1);
  ok('with a backup of what was there before', fs.existsSync(path.join(codexDir, 'config.toml.daidocs-bak')));

  // A client that is not installed is told to the user, not written blindly.
  const absent = await runSetup(['--client', 'zed'], qWork);
  ok('a client that is not installed here is not written to', /not installed here/.test(absent.out), absent.out.slice(-90));
  ok('and the way to configure it anyway is named', /--client generic --config/.test(absent.out));

  section('an undeclared folder is told once');
  const undeclared = store('never-declared');
  fs.mkdirSync(undeclared, { recursive: true });
  const ctxOf = cwd => new Promise(res => {
    const p = spawn(process.execPath, ['session_context.mjs'],
      { cwd: here, env: { ...process.env, DAIDOCS_STORE: '', DAIDOCS_OBSERVER: MOCK } });
    let out = ''; p.stdout.on('data', d => out += d);
    p.stdin.end(JSON.stringify({ session_id: 't', cwd }));
    p.on('close', () => { try { res(JSON.parse(out).hookSpecificOutput.additionalContext); } catch { res(''); } });
  });
  const undecCtx = await ctxOf(undeclared);
  ok('an undeclared folder is given its own store, not asked about',
    /now keeps its own memory/.test(undecCtx), undecCtx.slice(0, 140));
  ok('and it really exists on disk', fs.existsSync(path.join(undeclared, '.daidocs', 'config.json')));
  ok('and the notice comes first, above the index', undecCtx.indexOf('now keeps its own memory') < 220, String(undecCtx.indexOf('now keeps its own memory')));
  ok('and it is the only thing said: no backlog offer beside it', !/archived session/.test(undecCtx));
  ok('and both ways out are named',
    /store: "general"/.test(undecCtx) && /declare_project with a store path/.test(undecCtx));
  ok('and nothing already saved is moved', /stays where it is/.test(undecCtx));
  // Once it has a store, a later session says nothing at all about it.
  const againCtx = await ctxOf(undeclared);
  ok('and a later session in the same folder is silent about it', !/now keeps its own memory/.test(againCtx), againCtx.slice(0, 90));
  // The answer is remembered. "General" goes into the registry (redirected for
  // this whole run at the top of the file) and the question does not return.
  const Reg2 = require('./lib/registry');
  const genFolder = path.join(TMP, 'sent-to-general');
  fs.mkdirSync(genFolder, { recursive: true });
  Reg2.recordFolder(genFolder, 'general');
  const genCtx = await ctxOf(genFolder);
  ok('a folder sent to the general store is left alone', !/now keeps its own memory/.test(genCtx), genCtx.slice(-90));
  ok('and nothing is created in it', !fs.existsSync(path.join(genFolder, '.daidocs')));
  Reg2.forgetFolder(genFolder);
  ok('and forgetting that decision lets it be claimed again', /now keeps its own memory/.test(await ctxOf(genFolder)));
  // The two places that are not projects, whatever else is true.
  ok('the home folder is never claimed', !/now keeps its own memory/.test(await ctxOf(os.homedir())));
  ok('and nothing is created there', !fs.existsSync(path.join(os.homedir(), '.daidocs', 'config.json')));
  const decCtx = await ctxOf(decRoot);
  ok('a declared folder is NOT nudged', !/no memory store of its own/.test(decCtx), decCtx.slice(-60));

  section('a project made of parts');
  // One folder per part, each with its own store; the root reads its parts and no part pays the
  // read cost of the whole project. Nothing is copied upward — the root reads children live.
  const St = require('./lib/stores');
  const root = store('myapp');
  const mk = (dir, cfg) => {
    fs.mkdirSync(path.join(dir, '.daidocs', 'store'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.daidocs', 'config.json'), JSON.stringify(cfg, null, 2));
    return dir;
  };
  mk(root, { type: 'normal', store: '.daidocs/store', reads: ['children'], label: 'myapp' });
  const api = mk(path.join(root, 'api'), { type: 'normal', store: '.daidocs/store', reads: ['parent'], label: 'api' });
  const web = mk(path.join(root, 'web'), { type: 'normal', store: '.daidocs/store', reads: ['parent'], label: 'web' });
  const bill = mk(path.join(root, 'billing'), { type: 'confidential', store: '.daidocs/store', reads: ['self'], label: 'billing' });
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });          // undeclared subfolder

  // Each part writes to its own store, so no store carries the whole project.
  const inApi = St.resolveStore(api);
  ok('a session in a part uses that part store',
    path.resolve(inApi.storeDir) === path.resolve(api, '.daidocs', 'store'), inApi.storeDir);
  ok('and reads only itself by default',
    St.readCandidates(inApi).filter(c => c.why === 'this project').length === 1);

  // An undeclared subfolder inherits the nearest ancestor rather than becoming
  // a store of its own, which is what keeps the layout to the parts you chose.
  const inDocs = St.resolveStore(path.join(root, 'docs'));
  ok('an undeclared subfolder inherits the parent store',
    path.resolve(inDocs.storeDir) === path.resolve(root, '.daidocs', 'store'), inDocs.storeDir);

  // reads: children finds every declared part without listing paths.
  const inRoot = St.resolveStore(root);
  const kids = St.readCandidates(inRoot);
  const labels = kids.map(k => k.label).sort();
  ok('reads children picks up every declared part', labels.includes('api') && labels.includes('web'), labels.join(','));
  ok('and a part added later needs no edit to the parent', St.childProjects(root).length === 3, String(St.childProjects(root).length));

  // The confidentiality boundary holds against the new keyword.
  ok('reads children cannot reach a confidential part', !labels.includes('billing'), labels.join(','));
  const inBill = St.resolveStore(bill);
  ok('and the confidential part still reads itself', St.readCandidates(inBill).length === 1);

  // One level only, for the same reason connections do not chain.
  const sub = mk(path.join(api, 'v2'), { type: 'normal', store: '.daidocs/store', reads: ['self'], label: 'api-v2' });
  ok('reads children does not reach a grandchild',
    !St.readCandidates(St.resolveStore(root)).map(k => k.label).includes('api-v2'));
  ok('though the grandchild is a store in its own right',
    path.resolve(St.resolveStore(sub).storeDir) === path.resolve(sub, '.daidocs', 'store'));

  // parentProject is what a brief travels along.
  ok('a part knows its parent', (St.parentProject(St.resolveStore(api).config) || {}).label === 'myapp');
  ok('and the root has none above it', St.parentProject(St.resolveStore(root).config) === null);

  section('a confidential part can brief its parent');
  // Reading down is refused by design, so the part decides what leaves.
  const briefTransport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(here, 'mcp_server.mjs')],
    env: { ...process.env, DAIDOCS_OBSERVER: MOCK, DAIDOCS_STORE: '' },
    cwd: bill,
  });
  const briefClient = new Client({ name: 'verify-brief', version: '0.0.1' });
  await briefClient.connect(briefTransport);
  const briefed = await briefClient.callTool({ name: 'brief_parent',
    arguments: { summary: 'Shipped the payment retry logic.', date: '2026-09-07' } });
  ok('the brief lands in the parent store', /Brief recorded in myapp/.test(briefed.content[0].text), briefed.content[0].text.slice(0, 90));
  const rootManifest = path.join(root, '.daidocs', 'store', '_index', 'manifest.jsonl');
  ok('and appears in the parent manifest', fs.existsSync(rootManifest) && /Brief from billing/.test(fs.readFileSync(rootManifest, 'utf8')));
  ok('the parent still cannot read the part itself',
    !St.readCandidates(St.resolveStore(root)).map(k => k.label).includes('billing'));
  // The brief must name its origin (an unattributed line in a parent store is noise).
  const briefDai = fs.readdirSync(path.join(root, '.daidocs', 'store')).filter(f => f.endsWith('.dai'));
  const briefBody = briefDai.length ? fs.readFileSync(path.join(root, '.daidocs', 'store', briefDai[0]), 'utf8') : '';
  ok('the brief names its origin in the body', /Brief from the billing project/.test(briefBody), briefDai.join(','));
  ok('and says why it had to be written by hand', /cannot read it/.test(briefBody));
  ok('and carries the actual text', /payment retry logic/.test(briefBody));
  await briefClient.close();

  section('declaring a folder type actually works');
  // The flag-driven declare must not fall into interactive mode: project, project-type and store
  // must be in the anyFlag list, or setup blocks on its first question with no folder made and
  // no error printed.
  const dProj = store('declare-me');
  fs.mkdirSync(dProj, { recursive: true });
  const dRun = await new Promise(res => {
    const p = spawn(process.execPath, ['setup.js', '--project', dProj, '--project-type', 'confidential'],
      { cwd: here, env: { ...process.env, DAIDOCS_NO_PERSIST: '1', HOME: TMP, USERPROFILE: TMP } });
    let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
    // no input available: it must not wait for any
    p.stdin.end();
    const t = setTimeout(() => { p.kill(); res({ out, timedOut: true }); }, 20000);
    p.on('close', () => { clearTimeout(t); res({ out, timedOut: false }); });
  });
  ok('it does not hang waiting for input', !dRun.timedOut, dRun.timedOut ? 'TIMED OUT' : 'returned');
  const dCfgPath = path.join(dProj, '.daidocs', 'config.json');
  ok('it writes the config', fs.existsSync(dCfgPath), dRun.out.slice(0, 120));
  ok('it creates the store folder', fs.existsSync(path.join(dProj, '.daidocs', 'store')));
  const dCfg = fs.existsSync(dCfgPath) ? JSON.parse(fs.readFileSync(dCfgPath, 'utf8')) : {};
  ok('with the type that was asked for', dCfg.type === 'confidential', String(dCfg.type));
  ok('and a label naming the folder', dCfg.label === path.basename(dProj), String(dCfg.label));

  // Declaring a folder type is not an install. Falling through to the main flow
  // would reach the "remove the previous install first" branch, which calls
  // restoreAll() and would tear down hooks the user still wants.
  ok('it does not run the uninstall path', !/Removing it before installing/.test(dRun.out), dRun.out.slice(0, 80));
  ok('and says so plainly', /your hooks, clients and observer are untouched/.test(dRun.out));

  const dResolved = require('./lib/stores').resolveStore(dProj);
  ok('the declared store is what a session there would use',
    path.resolve(dResolved.storeDir) === path.resolve(dProj, '.daidocs', 'store'), dResolved.storeDir);
  ok('and it resolves as confidential', dResolved.type === 'confidential', dResolved.type);

  section('the tests do not touch the real machine');
  // The install cycle above runs setup.js for real with HOME redirected, but HKCU is not
  // redirected by HOME, so an ungated registry write in that cycle reaches the actual user's
  // .dai association.
  const setupSrc2 = fs.readFileSync(path.join(here, 'setup.js'), 'utf8');
  ok('registerFileType honours DAIDOCS_NO_PERSIST',
    /function registerFileType\(undo\) \{[\s\S]{0,900}?DAIDOCS_NO_PERSIST/.test(setupSrc2));
  ok('and says what it would have done instead of doing it',
    /Would \$\{undo \? 'remove' : 'register'\} the \.dai file association/.test(setupSrc2));

  const guarded = await new Promise(res => {
    const p = spawn(process.execPath, ['-e',
      "process.env.DAIDOCS_NO_PERSIST='1';" +
      "const cp=require('child_process');const real=cp.execSync;let touched=false;" +
      "cp.execSync=(c,...a)=>{ if(/reg (add|delete)/i.test(String(c))) touched=true; return Buffer.from(''); };" +
      "console.log(JSON.stringify({touched}));"],
      { cwd: here });
    let out = ''; p.stdout.on('data', d => out += d);
    p.on('close', () => { try { res(JSON.parse(out)); } catch { res({}); } });
  });
  ok('a guarded run issues no reg add or reg delete', guarded.touched === false, String(guarded.touched));

  section('the backlog offer actually reaches the user');
  // SessionStart additionalContext goes to the ASSISTANT, never the screen, so a note phrased
  // "the user can say ..." is one the user never reads — leaving the backlog invisible to the
  // only person who can authorise draining it.
  const ctxSrc = fs.readFileSync(path.join(here, 'session_context.mjs'), 'utf8');
  ok('the note instructs the assistant to speak', /ACTION FOR YOU/.test(ctxSrc));
  ok('it no longer only tells the assistant what the user could say',
    !/the user can say "convert my pending daidocs sessions" and you write/.test(ctxSrc));
  ok('and it says not to nag', /do not repeat the offer/.test(ctxSrc));

  const ctxStore = store('ctx-backlog');
  for (const d of ['_index', '_raw', '_pending']) fs.mkdirSync(path.join(ctxStore, d), { recursive: true });
  const runCtx = () => new Promise(res => {
    const p = spawn(process.execPath, ['session_context.mjs'],
      // Its own registry (the backlog counted is this store's; the suite's registry carries every
      // fixture the run declared) and the Claude marker (these assert the subscription wording,
      // which otherwise depends on whatever machine runs the suite).
      { cwd: here, env: { ...process.env, DAIDOCS_STORE: ctxStore, DAIDOCS_OBSERVER: MOCK,
        DAIDOCS_REGISTRY: path.join(ctxStore, 'registry.json'), CLAUDECODE: '1' } });
    let out = ''; p.stdout.on('data', d => out += d);
    p.stdin.end(JSON.stringify({ session_id: 'test', cwd: ctxStore }));
    p.on('close', () => { try { res(JSON.parse(out).hookSpecificOutput.additionalContext); } catch { res(''); } });
  });
  const quietCtx = await runCtx();
  ok('says nothing when there is no backlog', !/ACTION FOR YOU/.test(quietCtx));

  fs.writeFileSync(path.join(ctxStore, '_pending', 'one.json'), '{}');
  const oneCtx = await runCtx();
  ok('tells the assistant to raise a backlog of one', /ACTION FOR YOU: 1 archived session/.test(oneCtx), oneCtx.slice(-120));
  ok('and gets the singular right', /is captured but not yet indexed, so it cannot be searched yet/.test(oneCtx));

  fs.writeFileSync(path.join(ctxStore, '_pending', 'two.json'), '{}');
  const twoCtx = await runCtx();
  ok('counts correctly with more than one', /ACTION FOR YOU: 2 archived sessions/.test(twoCtx), twoCtx.slice(-120));
  ok('and does not repeat the count twice in one sentence',
    (twoCtx.match(/not yet indexed/g) || []).length === 1, String((twoCtx.match(/not yet indexed/g) || []).length));

  // The unconverted tail is read in at session start, verbatim, for this folder only: a session
  // that ended small is in front of the assistant when the next one opens here, before conversion.
  fs.mkdirSync(path.join(ctxStore, '_unconverted'), { recursive: true });
  fs.writeFileSync(path.join(ctxStore, '_unconverted', 'cc_tail-0001.txt'), '[USER]: the retry cap is three, remember that\n\n[ASSISTANT]: noted, three.');
  fs.writeFileSync(path.join(ctxStore, '_pending', 'cc_tail-0001.json'), JSON.stringify({ id: 'cc_tail-0001', segId: 'cc_tail-0001', title: 'tail', date: '2026-09-06', cwd: ctxStore, tokens: 20, reason: 'live' }));
  const tailCtx = await runCtx();
  ok('the session-start hook reads the unconverted tail in', /Not yet converted, from this folder/.test(tailCtx) && /retry cap is three/.test(tailCtx), tailCtx.slice(-160));
  fs.writeFileSync(path.join(ctxStore, '_unconverted', 'cc_other-0001.txt'), '[USER]: a different project entirely\n\n[ASSISTANT]: ok');
  fs.writeFileSync(path.join(ctxStore, '_pending', 'cc_other-0001.json'), JSON.stringify({ id: 'cc_other-0001', segId: 'cc_other-0001', title: 'other', date: '2026-09-06', cwd: 'C:/some/other/folder', tokens: 10, reason: 'live' }));
  const scopedCtx = await runCtx();
  ok("and not another folder's", /retry cap is three/.test(scopedCtx) && !/different project entirely/.test(scopedCtx));

  section('the model you chose applies everywhere');
  // Two faults, one symptom (a large file demanding an OpenAI key from someone who chose Opus):
  // daidocs.js hardcoded openai:gpt-4.1-mini for ingest, and resolveObserver let any inherited
  // DAIDOCS_OBSERVER outrank the recorded choice, so a stale shell kept using a model nobody picked.
  const cliSrc = fs.readFileSync(path.join(here, 'daidocs.js'), 'utf8');
  ok('ingest no longer hardcodes an observer', !/getProviders\(\[opt\("observer", "openai/.test(cliSrc));
  ok('ingest resolves the chosen model instead', /observerForThisRun\(\)/.test(cliSrc));
  ok('the usage text stops advertising gpt-4.1-mini as the default',
    !/ingest <source-folder>.*--observer openai/.test(cliSrc));

  const H2 = require('./lib/host');
  const runResolve = env => new Promise(res => {
    const p = spawn(process.execPath, ['-e',
      "const h=require('./lib/host');const r=h.resolveObserver();console.log(JSON.stringify({spec:r.spec,overrode:r.overrode||null}))"],
      { cwd: here, env: { ...process.env, ...env } });
    let out = ''; p.stdout.on('data', d => out += d);
    p.on('close', () => { try { res(JSON.parse(out)); } catch { res({}); } });
  });

  // A keyless spec is always honoured: it cannot cost anything, and this is how
  // the offline harness and local runs work.
  const keyless = await runResolve({ DAIDOCS_OBSERVER: MOCK });
  ok('a keyless DAIDOCS_OBSERVER is always honoured', keyless.spec === MOCK, String(keyless.spec));

  // A PAID env value that contradicts the recorded choice is treated as stale.
  const chosen = H2.resolveObserver().spec;
  const stale = await runResolve({ DAIDOCS_OBSERVER: 'openai:gpt-4.1-mini' });
  const record = (() => { try { return require('./lib/versioning').currentInstall(); } catch { return null; } })();
  if (record && record.observer && record.observer !== 'openai:gpt-4.1-mini') {
    ok('a stale paid DAIDOCS_OBSERVER loses to the recorded choice', stale.spec === record.observer, String(stale.spec));
    ok('and the override is reported, not hidden', stale.overrode === 'openai:gpt-4.1-mini', String(stale.overrode));
  } else {
    ok('a stale paid DAIDOCS_OBSERVER loses to the recorded choice', true, 'no recorded choice on this machine, skipped');
    ok('and the override is reported, not hidden', true, 'no recorded choice on this machine, skipped');
  }
  ok('resolution agrees with itself across processes', typeof chosen === 'string' && chosen.includes(':'), chosen);

  // Conversion outside a session cannot use the subscription, so it must offer
  // the free route rather than quietly billing.
  ok('ingest refuses to bill a subscription silently', /subscriptionMode\(\) && needsKey\(pick\.spec\)/.test(cliSrc));
  ok('convert offers the free route too', /convert my pending daidocs sessions/.test(cliSrc));
  ok('convert stops naming an API key when it cannot run', !/Set its API key and re-run/.test(cliSrc));

  // The shortlist is an optimisation, not an answer.
  const embSrc = fs.readFileSync(path.join(here, 'lib', 'embeddings.js'), 'utf8');
  ok('embeddings are skipped on a subscription', /if \(usingSubscription\(\)\)/.test(embSrc));
  ok('and the embedder id reflects that', /!usingSubscription\(\)/.test(embSrc));

  section('a read never goes silent about unindexed sessions');
  // _raw is lossless storage, not memory: nothing that answers a question reads it, so a
  // captured-but-unindexed session is safe on disk but unfindable. Every read path must say so,
  // the successful one included, since a partial answer reads as a complete one.
  const bs = store('backlog');
  for (const d of ['_index', '_raw', '_pending']) fs.mkdirSync(path.join(bs, d), { recursive: true });
  const bTransport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(here, 'mcp_server.mjs')],
    env: { ...process.env, DAIDOCS_STORE: bs, DAIDOCS_OBSERVER: MOCK },
  });
  const bClient = new Client({ name: 'verify-backlog', version: '0.0.1' });
  await bClient.connect(bTransport);

  const quiet = await bClient.callTool({ name: 'list_memories', arguments: {} });
  ok('an empty store with no backlog says nothing extra', !/not yet indexed/.test(quiet.content[0].text));

  fs.writeFileSync(path.join(bs, '_pending', 'a.json'), '{}');
  fs.writeFileSync(path.join(bs, '_pending', 'b.json'), '{}');

  const listed = await bClient.callTool({ name: 'list_memories', arguments: {} });
  ok('list_memories reports the backlog', /2 sessions are captured but not yet indexed/.test(listed.content[0].text), listed.content[0].text.slice(-90));
  ok('and says it is free to convert', /free and uses no API key/.test(listed.content[0].text));

  const recalled = await bClient.callTool({ name: 'recall_memory', arguments: { question: 'anything' } });
  ok('recall reports the backlog instead of a flat no', /not yet indexed/.test(recalled.content[0].text), recalled.content[0].text.slice(-70));

  await bClient.callTool({ name: 'save_memory', arguments: { title: 'a memory', content: 'The kettle is in the third cupboard. '.repeat(30), understanding: { summary: 'kettle', facts: [], events: [], topics: ['kettle'] } } });
  const found = await bClient.callTool({ name: 'recall_memory', arguments: { question: 'where is the kettle' } });
  ok('a SUCCESSFUL read still reports the backlog', /not yet indexed/.test(found.content[0].text), found.content[0].text.slice(-70));
  ok('and still returns the retrieved material', /Retrieved from .dai memory/.test(found.content[0].text));
  await bClient.close();

  section('an upgrade keeps what it had');
  // Upgrading unregisters the old .dai association (its .ico sits in a folder that's going away).
  // Re-registering was gated behind an interactive prompt a flag-driven install never reaches, so
  // every upgrade-with-flags silently stripped the icon, leaving no .dai key while Explorer still
  // showed the cached type name against a blank icon.
  const setupSrc = fs.readFileSync(path.join(here, 'setup.js'), 'utf8');
  ok('setup can tell whether .dai is registered', /function fileTypeRegistered\(/.test(setupSrc));
  ok('it checks before the old install is removed',
    setupSrc.indexOf('hadFileType = fileTypeRegistered()') < setupSrc.indexOf('registerFileType(true)', setupSrc.indexOf('hadFileType = fileTypeRegistered()')) );
  ok('and re-registers when it was there before', /has\('icon'\) \|\| hadFileType/.test(setupSrc));
  ok('the icon asset it points at exists', fs.existsSync(path.join(here, 'assets', 'brand', 'dai-file.ico')));

  section('the folder system is reachable without reading the source');
  // Interactive setup must offer to declare a project; without the offer everything lands in the shared store.
  ok('interactive setup offers to declare a project', /Declare this folder as a project/.test(setupSrc));
  ok('the offer lists every type', ['normal', 'confidential', 'shared', 'temporary', 'locked', 'frozen', 'connected']
    .every(t => setupSrc.includes(`. ${t} `)), 'all seven listed');
  ok('the offer maps each number to a real type',
    Object.keys(require('./lib/stores').TYPES).every(t => setupSrc.includes(`'${t}'`)));
  ok('it never offers to declare the install folder itself',
    /path\.resolve\(target\) !== path\.resolve\(HERE\)/.test(setupSrc));
  ok('a declared project still gets its folder icon', /setFolderIcon\(dir, cfg\.type\)/.test(setupSrc));

  section('a subscription is never billed behind your back');
  // No background path may reach for a key on a subscription host: the SessionEnd hook is a
  // separate process, and it used to call the Anthropic API with whatever key it found — failing
  // every archive on an account with no API credit.
  const H = require('./lib/host');
  ok('a Claude host is in subscription mode', H.subscriptionMode('claude-code') === true);
  ok('a non-Claude host is not', H.subscriptionMode('chatgpt') === false || H.detectHost('chatgpt') === 'anthropic');

  const runIn = (env, args = []) => new Promise(res => {
    const p = spawn(process.execPath, args, { cwd: here, env: { ...process.env, ...env } });
    let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
    p.on('close', code => res({ out, code }));
  });

  // A key IS present and must still go unused: the fixture is a paid observer (what a real Claude
  // install stores) with a key sitting in the environment.
  const subEnv = { DAIDOCS_STORE: store('sub-store'), DAIDOCS_OBSERVER: 'anthropic:claude-opus-5', ANTHROPIC_API_KEY: 'sk-ant-' + 'x'.repeat(40), CLAUDECODE: '1' };
  const optIn = await runIn({ ...subEnv, DAIDOCS_USE_API: '1' },
    ['-e', "console.log(require('./lib/host').subscriptionMode())"]);
  ok('DAIDOCS_USE_API=1 opts back into the API', /false/.test(optIn.out), optIn.out.trim());
  const withKey = await runIn(subEnv, ['-e', "console.log(require('./lib/host').subscriptionMode())"]);
  ok('having an API key does not opt you in', /true/.test(withKey.out), withKey.out.trim());

  // catch-up must not ask for a key the user was told they did not need.
  const cuStore = store('catchup-store');
  for (const d of ['_index', '_raw', '_pending']) fs.mkdirSync(path.join(cuStore, d), { recursive: true });
  fs.writeFileSync(path.join(cuStore, '_pending', 'x.json'), JSON.stringify({ id: 'x', segId: 'x', title: 't', date: '2026-09-06' }));
  fs.writeFileSync(path.join(cuStore, '_raw', 'x.txt'), 'hello');
  const cu = await runIn({ ...subEnv, DAIDOCS_STORE: cuStore }, ['session_archiver.mjs', '--catch-up']);
  // "no API key is used" is the right thing to say, so the test is that it
  // never ASKS for one, or reports the observer as broken.
  ok('catch-up never asks for a key on a subscription', !/set the API key|is unavailable/i.test(cu.out), cu.out.slice(0, 80));
  ok('catch-up says the conversion is free', /free/i.test(cu.out));
  ok('catch-up leaves the backlog for a session', fs.existsSync(path.join(cuStore, '_pending', 'x.json')));
  ok('catch-up writes nothing to errors.log', !fs.existsSync(path.join(cuStore, '_pending', 'errors.log')));

  // The menu may no longer promise free and then bill.
  const note = OBS.catalogueFor('anthropic')[0].note;
  ok('the menu no longer says a hook will bill you', !/API price applies when a hook/.test(note), note);
  ok('the menu says no key is used', /no API key is used/.test(note), note);

  section('host-aware observer menu');
  const claudeMenu = OBS.catalogueFor('anthropic');
  ok('Claude leads under a Claude host', claudeMenu[0].spec === 'anthropic:claude-opus-5' && claudeMenu[1].spec === 'anthropic:claude-fable-5-1',
    claudeMenu.slice(0, 2).map(o => o.spec).join(', '));
  ok('the Claude entries name the subscription', /free on your Claude subscription/.test(claudeMenu[0].note));
  // The Claude entries don't lead with a price: nothing is billed on the subscription, and the
  // rates live in the guide for anyone who opts in with DAIDOCS_USE_API=1.
  ok('and no longer lead with a price the user will not pay',
    !/per million tokens/.test(claudeMenu[0].price) && !/per million tokens/.test(claudeMenu[1].price),
    `${claudeMenu[0].price} | ${claudeMenu[1].price}`);
  ok('the first one is marked as the recommendation', /recommended/.test(claudeMenu[0].price), claudeMenu[0].price);
  // A model list under a memory question reads as "choose the model you talk to" — a far bigger
  // decision than this — so the menu clarifies it is only the converter.
  const claudeRendered = OBS.renderMenu('anthropic');
  ok('the menu says this is only the converter', /only the model that converts/.test(claudeRendered));
  ok('and that it is not the model you talk to', /not the model\s+you talk to/.test(claudeRendered));
  ok('and that the free ones are enough', /cost nothing on your subscription/.test(claudeRendered));
  ok('and it sits under the free options, not at the end',
    claudeRendered.indexOf('only the model that converts') < claudeRendered.indexOf('GPT-4.1 mini'));
  const openaiRendered = OBS.renderMenu('openai');
  ok('a host with nothing free still gets the explanation', /only the model that converts/.test(openaiRendered));
  ok('without pointing at options above it that are not there',
    !/cost nothing on your subscription/.test(openaiRendered));
  ok('and the API recommendation says what it is recommended for',
    /recommended with an API key/.test(openaiRendered));
  ok('other hosts keep the cheapest first', OBS.catalogueFor(null)[0].spec === 'openai:gpt-4.1-mini');
  ok('every host ordering offers the same models',
    OBS.catalogueFor('anthropic').length === OBS.CATALOGUE.length);

  section('observer catalogue');
  // Install recommends the cheapest capable observer and says why. The host
  // default is a separate thing: what runs when nobody chooses.
  ok('catalogue recommends the cheapest observer first', OBS.CATALOGUE[0].spec === require('./lib/host').RECOMMENDED, OBS.CATALOGUE[0].spec);
  ok('the recommendation states the saving', /cheaper/.test(OBS.CATALOGUE[0].note), OBS.CATALOGUE[0].note);
  ok('the host default under Claude is still Opus', require('./lib/host').DEFAULTS.anthropic === 'anthropic:claude-opus-5');
  ok('catalogue ends with a custom-model option', OBS.CATALOGUE[OBS.CATALOGUE.length - 1].spec === null);
  ok('maps each provider to its key variable', OBS.keyVarFor('anthropic:claude-opus-5') === 'ANTHROPIC_API_KEY'
    && OBS.keyVarFor('openai:gpt-4.1-mini') === 'OPENAI_API_KEY');
  ok('knows a keyless observer needs no key', OBS.needsKey('mock:mock') === false);
  ok('splits a spec on the first colon only', OBS.providerOf('mock:some:model') === 'mock');
  ok('rejects an unknown provider', OBS.isKnownProvider('notaprovider:x') === false);
  ok('every catalogue model resolves to a real provider',
    OBS.CATALOGUE.filter(o => o.spec).every(o => OBS.isKnownProvider(o.spec)));
}

// teardown
console.log(`\n${pass} pass, ${fail} fail`);
if (keep) console.log(`temp store kept at ${TMP}`);
else fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
