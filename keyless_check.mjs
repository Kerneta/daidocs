// Keyless verification: what can be proven without an API key (selftest is the paid
// end-to-end test and can't run in CI). Covers the regressions using the mock observer.
//   npm run check
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const here = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ' -> ' + detail}`);
  ok ? pass++ : fail++;
};

// 1. Everything parses.
console.log('\nsyntax:');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => {
  if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.')) return [];
  const p = path.join(d, e.name);
  return e.isDirectory() ? walk(p) : (/\.(js|mjs)$/.test(e.name) ? [p] : []);
});
const sources = walk(here);
let bad = [];
for (const f of sources) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
  catch { bad.push(path.relative(here, f)); }
}
check(`${sources.length} JS/MJS files parse`, bad.length === 0, bad.join(', '));

// 2. Provider contract: save_memory and the archiver call observer.available(); three
//    providers once didn't implement it, so keyless saves crashed.
console.log('\nprovider contract:');
const { getProviders } = require_('./lib/providers');
for (const spec of ['mock:mock', 'manual:manual', 'openai:gpt-4.1-mini', 'anthropic:claude-opus-5', 'gemini:gemini-2.5-flash']) {
  let ok = false, why = '';
  try { ok = typeof getProviders([spec])[0].available === 'function'; }
  catch (e) { why = e.message; }
  check(`${spec.split(':')[0]} implements available()`, ok, why);
}

// 3. A real CLI conversion with the mock observer, then assert the store is well formed
//    (the raw: pointer once named a missing file on both writer paths).
console.log('\nstore integrity (CLI + mock observer, no key):');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daidocs-check-'));
const src = path.join(tmp, 'src');
const store = path.join(tmp, 'store');
fs.mkdirSync(src, { recursive: true });
fs.writeFileSync(path.join(src, 'note.txt'),
  'I booked Valletta for 12 July, staying at Casa do Rio guesthouse. The trip cost 840 euros.\n');

try {
  execFileSync(process.execPath, [path.join(here, 'daidocs.js'), 'ingest', src, store, '--observer', 'mock:mock'],
    { stdio: 'pipe', timeout: 60000 });
} catch (e) {
  check('CLI ingest completes', false, (e.stderr || e.message || '').toString().slice(0, 160));
}

const dai = fs.existsSync(store) ? fs.readdirSync(store).filter(f => f.endsWith('.dai')) : [];
check('a .dai file was written', dai.length > 0, `found ${dai.length}`);

for (const f of dai) {
  const body = fs.readFileSync(path.join(store, f), 'utf8');

  const raw = (body.match(/^raw: "([^"]+)"/m) || [])[1];
  check(`${f}: raw: pointer resolves`, !!raw && fs.existsSync(path.join(store, raw)),
    raw ? `${raw} is missing from disk` : 'no raw: field');

  // The segment regex is exact; a header mismatch silently yields zero excerpts.
  const declared = Number((body.match(/^messages: (\d+)/m) || [])[1]);
  const parsed = [...body.matchAll(/## \[seg \d+\/\d+\]\n/g)].length;
  check(`${f}: segments parse back`, parsed > 0 && (!declared || parsed === declared),
    `frontmatter says ${declared}, regex parses ${parsed}`);

  check(`${f}: format marker present`, /^daidocs: "[\d.]+"/m.test(body), 'no daidocs: marker');
  check(`${f}: app marker is daidocs`, /"app": "daidocs/.test(body));
}

check('manifest written', fs.existsSync(path.join(store, '_index', 'manifest.jsonl')));

// 4. Every writer must agree with the engine on where the original lives (the raw: pointer
//    was broken in all three writers, each differently), so check them structurally.
console.log('\nwriter contract:');
for (const [file, label] of [['daidocs.js', 'CLI'], ['mcp_server.mjs', 'MCP server'], ['session_archiver.mjs', 'session archiver']]) {
  const src = fs.readFileSync(path.join(here, file), 'utf8');
  const writesRaw = /_raw'/.test(src) || /"_raw"/.test(src);
  // Each writer must derive the _raw filename from the .dai the engine returned,
  // rather than from a name it made up before the call.
  const derivesFromEngine = /basename\((?:daiOut|f)\.path, ?['"]\.dai['"]\)/.test(src) || /rawName/.test(src);
  check(`${label} derives _raw name from the engine's id`, !writesRaw || derivesFromEngine,
    'writes _raw using a name the engine did not assign');
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
