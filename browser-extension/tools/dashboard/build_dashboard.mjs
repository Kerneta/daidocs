#!/usr/bin/env node
// Build the DaiDocs memory dashboard: one self-contained HTML file.
//
//   node build_dashboard.mjs [--out <file>] [--install <daidocs install>] [--no-open]
//   node build_dashboard.mjs --watch      rebuild whenever a store changes
//
// It opens the page in your default browser when a person is watching. --no-open,
// DAIDOCS_NO_OPEN or a non-interactive terminal stops that.
//
// Everything it shows is read from disk at build time and embedded, so the page
// works offline, opens with a double click, and can be mailed to somebody. There
// is no server and no fetch: a dashboard that needs a running process to show
// you your own files would be a worse thing than the files.
//
// Two views over the same tree:
//
//   MEMORY   every declared store and the shared one, the memories inside them,
//            and the links between memories that share topics or entities.
//   PROJECT  the folders those stores belong to, with real file counts and
//            sizes, so you can see what a project is as well as what it remembers.
//
// Design follows daidocs.com: its own theme tokens, its fx-2040 layer, and the
// icon palette. Consistency here is not decoration. The folder types have colours
// that mean something in Explorer, and they have to mean the same thing here.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { spawnSync } from 'child_process';
const OPEN = createRequire(import.meta.url)('../../lib/open_page');
const REG = createRequire(import.meta.url)('../../lib/registry');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };

// Default to the install this file lives in, so the tool works wherever the
// release is unpacked rather than only on the machine it was written on.
// fileURLToPath, not hand-rolled URL surgery: a path with a space arrives
// percent-encoded in import.meta.url, so stripping the leading slash alone
// looks for a folder called 'R&D%20Dev' and finds nothing.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const INSTALL = opt('install', path.resolve(HERE, '..', '..'));
const OUT = path.resolve(opt('out', path.join(process.cwd(), 'daidocs-dashboard.html')));

const readJson = fp => { try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; } };
const readLines = fp => { try { return fs.readFileSync(fp, 'utf8').split('\n').filter(l => l.trim()); } catch { return []; } };
const parseLines = fp => readLines(fp).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const sizeOf = fp => { try { return fs.statSync(fp).size; } catch { return 0; } };

// ---------------------------------------------------------------- stores ----

// Every store this machine knows about: the registry's declared ones plus the
// shared default, which is never declared and is where everything lands until
// somebody declares something.
function findStores() {
  const out = [];
  // Through lib/registry, which is the one place that decides where the
  // registry lives. This read the home directory directly and so ignored
  // DAIDOCS_REGISTRY, which every other part of DaiDocs honours: the map
  // showed a different set of stores from the tool that made them.
  const reg = readJson(REG.FILE());
  if (reg && reg.stores) {
    for (const s of Object.values(reg.stores)) {
      const cfg = readJson(path.join(s.root || '', '.daidocs', 'config.json')) || {};
      out.push({
        id: s.id, label: s.label || path.basename(s.root || ''), type: s.type || 'normal',
        root: s.root, storeDir: s.storeDir, declared: true,
        reads: cfg.reads || ['self'], connections: cfg.connections || [],
        firstSeen: s.firstSeen || null, lastSeen: s.lastSeen || null,
      });
    }
  }
  const shared = process.env.DAIDOCS_STORE || path.join(os.homedir(), 'DaiDocs');
  if (fs.existsSync(shared) && !out.some(s => path.resolve(s.storeDir || '') === path.resolve(shared))) {
    out.push({
      id: 'shared', label: 'Shared store', type: 'shared', root: shared, storeDir: shared,
      declared: false, reads: ['self'], connections: [], firstSeen: null, lastSeen: null,
    });
  }
  // The folder the capture server is currently saving to. It may not be the
  // shared store or a registered project, but it holds the live vault, so it
  // must appear in the map. Added only if not already present.
  const cap = process.env.DAIDOCS_CAPTURE_STORE;
  if (cap && fs.existsSync(cap) && !out.some(s => path.resolve(s.storeDir || '') === path.resolve(cap))) {
    out.push({
      id: 'capture', label: path.basename(cap) + ' (capturing)', type: 'shared', root: cap, storeDir: cap,
      declared: false, reads: ['self'], connections: [], firstSeen: null, lastSeen: null,
    });
  }
  // De-duplicate a folder that is both a registered project and the shared or
  // capture store. Such a project's storeDir is an empty <root>/.daidocs/store,
  // so it renders as "no memories" beside the real store for the same folder,
  // which is confusing. Drop the declared duplicate; the shared/capture tile
  // (which reads the memories from the root) is the real one.
  const dupRoots = new Set([path.resolve(shared)]);
  if (cap) dupRoots.add(path.resolve(cap));
  return out
    .filter(s => s.storeDir && fs.existsSync(s.storeDir))
    .filter(s => !(s.declared && dupRoots.has(path.resolve(s.root || ''))));
}

// One store's contents. Sizes come from the filesystem rather than the index,
// because the question "how much room is this taking" is about disk.
function loadStore(s) {
  const dir = s.storeDir;
  const rows = parseLines(path.join(dir, '_index', 'manifest.jsonl'));
  const facts = readLines(path.join(dir, '_index', 'facts.jsonl')).length;
  const events = readLines(path.join(dir, '_index', 'events.jsonl')).length;
  const profile = readLines(path.join(dir, '_index', 'profile.jsonl')).length;

  const memories = rows.map(r => {
    const dai = path.join(dir, r.id + '.dai');
    const bytes = sizeOf(dai);
    // Entities arrive in two shapes across engine versions: a keyed object, or
    // an array. Flatten either into a plain list of names.
    let ents = [];
    const e = r.entities;
    if (Array.isArray(e)) ents = e.map(String);
    else if (e && typeof e === 'object') {
      for (const v of Object.values(e)) {
        if (Array.isArray(v)) ents.push(...v.map(String));
        else if (typeof v === 'string') ents.push(v);
      }
    }
    // The file itself, split into the three zones the format defines, so the
    // reader can show them separately instead of dumping one long blob.
    //
    // The three-zoom discipline exists to stop a MODEL reading whole files for
    // no accuracy gain. A person reading their own memory is the opposite case:
    // the full text is exactly what they came for. It is still presented in
    // zones, because that is what the file is.
    const text = (() => { try { return fs.readFileSync(dai, 'utf8'); } catch { return ''; } })();
    const NL = String.fromCharCode(10);
    const front = (text.match(new RegExp('^---' + NL + '([\\s\\S]*?)' + NL + '---')) || [])[1] || '';
    const understanding = (text.match(new RegExp('#\\s*Understanding\\s*' + NL + '+```(?:json)?' + NL + '([\\s\\S]*?)```')) || [])[1] || '';
    const contentZone = text.split(/^#\s*Content\s*$/m)[1] || '';
    const segments = contentZone.split(/^##\s*\[seg\s*/m).slice(1)
      .map(bit => {
        const head = (bit.match(/^([^\]]*)\]/) || [])[1] || '';
        return { n: head.trim(), text: bit.replace(/^[^\]]*\]\s*/, '').trim() };
      });

    // The verbatim original, before the engine touched it.
    //
    // The .dai's `raw:` pointer names _raw/<engine id>, with no extension. It is
    // the losslessness guarantee made inspectable: if the extraction ever looks
    // wrong, this is what it was made from. Capped, because one runaway session
    // should not make the whole page unopenable, and the cap is stated rather
    // than hidden so nobody reads a truncated file thinking it is complete.
    const RAW_CAP = 140 * 1024;
    const rawPath = [path.join(dir, '_raw', r.id), path.join(dir, '_raw', r.id + '.txt')]
      .find(fp => { try { return fs.statSync(fp).isFile(); } catch { return false; } }) || null;
    const rawBytes = rawPath ? sizeOf(rawPath) : 0;
    let raw = '';
    if (rawPath) { try { raw = fs.readFileSync(rawPath, 'utf8').slice(0, RAW_CAP); } catch { raw = ''; } }

    return {
      id: r.id, title: String(r.title || r.id), date: r.date || null, at: r.at || null,
      summary: String(r.summary || ''), type: r.type || 'chat',
      front, understanding, segments,
      raw, rawBytes, rawTruncated: rawBytes > RAW_CAP,
      rawPath: rawPath ? path.basename(rawPath) : null,
      topics: (r.topics || []).map(String).slice(0, 12),
      entities: ents.filter(Boolean).slice(0, 12),
      tags: (r.tags || []).map(String).slice(0, 8),
      bytes,
    };
  });

  // What is captured but not converted, grouped by the project it came from.
  //
  // A single number ("29 unindexed") tells you there is a problem and nothing
  // about how to start on it. Grouped by origin it becomes a list of decisions:
  // this project matters, that one does not, convert the first and leave the
  // rest. Markers written before the cwd field carry only the "[name] " tag the
  // archiver puts on every title, so the name is taken from there when the path
  // is missing.
  const pendingDir = path.join(dir, '_pending');
  const pendingItems = [];
  try {
    for (const f of fs.readdirSync(pendingDir)) {
      if (!f.endsWith('.json')) continue;
      const j = readJson(path.join(pendingDir, f)) || {};
      const pid = j.segId || j.id || f.replace(/\.json$/, '');
      const rawFile = [pid + '.txt', pid, (j.id || '') + '.txt', j.id || '']
        .flatMap(n => [path.join(dir, '_unconverted', n), path.join(dir, '_raw', n)])
        .find(fp2 => { try { return fs.statSync(fp2).isFile(); } catch { return false; } }) || null;
      const tag = (String(j.title || '').match(/^\[([^\]]+)\]/) || [])[1] || null;
      pendingItems.push({
        id: pid,
        title: String(j.title || pid).replace(/^\[[^\]]+\]\s*/, ''),
        date: j.date || null,
        project: j.project || tag || 'unknown',
        cwd: j.cwd || null,
        bytes: rawFile ? sizeOf(rawFile) : 0,
      });
    }
  } catch { }
  const pendingGroups = Object.values(pendingItems.reduce((acc, it) => {
    const g = acc[it.project] = acc[it.project] || { project: it.project, items: [], bytes: 0, cwd: null };
    g.items.push(it); g.bytes += it.bytes; if (!g.cwd && it.cwd) g.cwd = it.cwd;
    return acc;
  }, {})).sort((a, b) => b.items.length - a.items.length);

  let raw = 0, rawFiles = 0;
  const rawDir = path.join(dir, '_raw');
  try { for (const f of fs.readdirSync(rawDir)) { raw += sizeOf(path.join(rawDir, f)); rawFiles++; } } catch { }
  // The unconverted tail counts as raw on disk: it is verbatim text waiting.
  let unconverted = 0, unconvertedBytes = 0;
  try { for (const f of fs.readdirSync(path.join(dir, '_unconverted'))) { const b = sizeOf(path.join(dir, '_unconverted', f)); raw += b; unconvertedBytes += b; unconverted++; } } catch { }
  const pending = (() => { try { return fs.readdirSync(path.join(dir, '_pending')).filter(f => f.endsWith('.json')).length; } catch { return 0; } })();
  let indexBytes = 0;
  for (const f of ['manifest', 'facts', 'events', 'profile']) indexBytes += sizeOf(path.join(dir, '_index', f + '.jsonl'));

  return {
    ...s,
    memories,
    counts: { memories: memories.length, facts, events, profile, pending, rawFiles, unconverted },
    pendingGroups,
    bytes: {
      dai: memories.reduce((a, m) => a + m.bytes, 0),
      index: indexBytes,
      raw,
      unconverted: unconvertedBytes,
      total: memories.reduce((a, m) => a + m.bytes, 0) + indexBytes + raw,
    },
  };
}

// ------------------------------------------------------------ connections ---

// Two memories are linked when they share topics or entities. The weight is the
// number of shared terms, and weak single-term links are dropped: a graph where
// everything touches everything says nothing at all.
function linksWithin(memories) {
  const key = m => new Set([...m.topics, ...m.entities].map(t => t.toLowerCase().trim()).filter(t => t.length > 2));
  const keys = memories.map(key);
  const links = [];
  for (let i = 0; i < memories.length; i++) {
    for (let j = i + 1; j < memories.length; j++) {
      let shared = [];
      for (const t of keys[i]) if (keys[j].has(t)) shared.push(t);
      if (shared.length >= 2) links.push({ a: memories[i].id, b: memories[j].id, w: shared.length, on: shared.slice(0, 5) });
    }
  }
  return links.sort((x, y) => y.w - x.w).slice(0, 400);
}

// ---------------------------------------------------------- project view ----

// The folder a store belongs to, as a folder: what is actually in it, how big,
// and which parts of it are declared stores of their own.
const SKIP = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', '.cache']);

// A project as it actually is: every folder and file, with sizes, and a count
// per file type at each level.
//
// The point is to answer "what is in here" before you open anything: a folder
// that says "5 pdf, 3 png, 12 js, 2.4 MB" has told you what it is. Sizes and
// counts roll up, so a parent reports everything beneath it.
//
// Depth is generous rather than shallow, because a project's shape lives three
// or four levels down, but it stops somewhere: a scan that walks an entire disk
// to build a page nobody asked to wait for is a worse tool.
let scanBudget = 0;                         // entries left to visit this scan
const SCAN_MAX = 20000;                      // hard cap so a huge tree cannot hang the build
function scanProject(root, storeDirs, depth = 0) {
  if (depth === 0) scanBudget = SCAN_MAX;    // fresh budget per top-level store
  const node = {
    name: path.basename(root) || root, path: root, dirs: [], fileList: [],
    files: 0, bytes: 0, kinds: {}, isStore: storeDirs.has(path.resolve(root)),
  };
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return node; }

  for (const e of entries) {
    if (scanBudget-- <= 0) { node.truncated = true; break; }   // budget spent: stop walking
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      if (SKIP.has(e.name)) continue;
      if (depth >= 5) { node.dirs.push({ name: e.name, path: p, dirs: [], fileList: [], files: 0, bytes: 0, kinds: {}, deep: true }); continue; }
      const child = scanProject(p, storeDirs, depth + 1);
      node.dirs.push(child);
      node.files += child.files;
      node.bytes += child.bytes;
      for (const [k, v] of Object.entries(child.kinds)) node.kinds[k] = (node.kinds[k] || 0) + v;
    } else {
      const size = sizeOf(p);
      node.files++; node.bytes += size;
      const ext = (path.extname(e.name).replace('.', '') || 'no extension').toLowerCase();
      node.kinds[ext] = (node.kinds[ext] || 0) + 1;
      // Only the files directly in this folder are listed. Rolling every file
      // up to the root would embed the entire tree twice over.
      if (node.fileList.length < 400) node.fileList.push({ name: e.name, bytes: size, ext });
    }
  }
  node.fileList.sort((a, b) => b.bytes - a.bytes);
  node.dirs.sort((a, b) => b.bytes - a.bytes);
  return node;
}

// -------------------------------------------------------------- assemble ----

const stores = findStores().map(loadStore);
const storeDirSet = new Set(stores.map(s => path.resolve(s.storeDir)));

const data = {
  generated: new Date().toISOString(),
  install: INSTALL,
  live: argv.includes('--watch'),   // kept current by a watcher, so the page may reload itself
  // The page suggests commands, and a command has to be plausible on the machine
  // it is read on. A hardcoded D:/backups is meaningless on a Mac, and a
  // file:/// prefix is wrong for a path that already starts with a slash.
  platform: process.platform,
  backupHint: process.platform === 'win32' ? 'D:/backups' : path.join(os.homedir(), 'Backups'),
  version: (() => { try { return JSON.parse(fs.readFileSync(path.join(INSTALL, 'package.json'), 'utf8')).version; } catch { return 'unknown'; } })(),
  // The local capture server that can decrypt vaults, and the folder it is
  // currently saving to, so the dashboard can offer inline vault unlock and
  // default to the active store.
  capturePort: parseInt(process.env.DAIDOCS_CAPTURE_PORT || '41100', 10),
  captureStore: (() => {
    try { if (process.env.DAIDOCS_CAPTURE_STORE) return path.resolve(process.env.DAIDOCS_CAPTURE_STORE); } catch {}
    try { if (process.env.DAIDOCS_STORE) return path.resolve(process.env.DAIDOCS_STORE); } catch {}
    try { return path.resolve(JSON.parse(fs.readFileSync(path.join(os.homedir(), '.daidocs-capture.json'), 'utf8')).store); } catch {}
    return path.join(os.homedir(), 'DaiDocs');
  })(),
  stores: stores.map(s => ({
    id: s.id, label: s.label, type: s.type, root: s.root, storeDir: s.storeDir,
    declared: s.declared, reads: s.reads, connections: s.connections,
    counts: s.counts, bytes: s.bytes,
    pendingGroups: s.pendingGroups,
    memories: s.memories,
    links: linksWithin(s.memories),
    project: s.root && fs.existsSync(s.root) ? scanProject(s.root, storeDirSet) : null,
    // Encrypted vault present in this store? (a lock badge + inline unlock)
    vault: (() => { try { return fs.existsSync(path.join(s.storeDir, '_vault', 'vault.json')); } catch { return false; } })(),
  })),
};

const html = fs.readFileSync(path.join(HERE, 'dashboard.template.html'), 'utf8')
  // Escape the sequence that ends a script block.
  //
  // The embedded data now carries verbatim transcripts, and these transcripts
  // are about building web pages, so they contain the literal characters that
  // close a <script> tag. The browser's HTML parser does not care that they sit
  // inside a JSON string: it ends the script there, and everything after it is
  // parsed as markup. The page dies with a syntax error and renders a starfield.
  //
  // "<\/" is the same string to JSON and to JavaScript, and invisible to the
  // HTML parser, so this changes nothing about the data.
  .replace('/*__DATA__*/', () => 'window.DAIDOCS = ' + JSON.stringify(data).split('</').join('<\\/') + ';');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html);

const totalMem = stores.reduce((a, s) => a + s.counts.memories, 0);
const totalBytes = stores.reduce((a, s) => a + s.bytes.total, 0);
console.log(`  ${stores.length} store${stores.length === 1 ? '' : 's'}, ${totalMem} memories, ${(totalBytes / 1048576).toFixed(1)} MB`);
console.log(`  written: ${OUT}`);

// A fresh install builds an empty page, and "0 memories" on its own reads as
// something being broken. It is not: nothing has been saved yet. The two ways
// to change that are worth more here than the number is.
if (totalMem === 0) {
  const waiting = stores.reduce((a, s) => a + (s.counts.pending || 0), 0);
  console.log('');
  console.log('  Nothing saved yet, so the page is empty. Two ways to fill it:');
  console.log('');
  console.log('    1. Just work. In Claude Code, every session saves itself as you go,');
  console.log('       every 4,000 tokens and again at the end. Come back and rebuild.');
  console.log(`    2. Bring in what you already have:  node ${path.join(INSTALL, 'daidocs.js')} convert`);
  console.log('       It reads your existing Claude Code sessions and quotes the cost');
  console.log('       before anything is spent. On a Claude subscription that is nothing.');
  if (waiting) {
    console.log('');
    console.log(`  ${waiting} session${waiting === 1 ? ' is' : 's are'} captured and waiting to be converted.`);
  }
  console.log('');
}

// Building a page and then printing its path asks the reader to go and find it.
// It is one file with no server behind it, so the browser they already have is
// simply handed it. Whether that should happen at all lives in lib/open_page.js,
// where it can be tested without launching anything.
// A rebuild triggered by the watcher opens nothing and watches nothing: it is
// only there to write the file again.
if (!argv.includes('--watch-child') && OPEN.shouldOpen(process.env, argv)) console.log(OPEN.openPage(OUT));

// --watch: rebuild whenever a store changes, so the page is never the reason
// something looks missing. A rebuild is this same script run again rather than
// a refactor into a function: the build reads everything from disk anyway, and
// a fresh process cannot carry stale state from the last one.
if (argv.includes('--watch') && !argv.includes('--watch-child')) {
  const dirs = new Set();
  for (const s of stores) {
    dirs.add(s.storeDir);
    for (const d of ['_index', '_raw', '_pending', '_unconverted']) dirs.add(path.join(s.storeDir, d));
  }
  let timer = null, building = false;
  const rebuild = () => {
    if (building) return;
    building = true;
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--out', OUT, '--install', INSTALL, '--watch-child'],
      { encoding: 'utf8' });
    building = false;
    const line = String(child.stdout || '').split('\n').find(l => /memories/.test(l)) || '';
    console.log(`  ${new Date().toLocaleTimeString()}  rebuilt${line ? ':' + line : ''}`);
  };
  for (const d of dirs) {
    // A store folder that does not exist yet is not an error: it appears the
    // first time something is saved, and the parent watch catches that.
    try {
      fs.watch(d, { persistent: true }, () => { clearTimeout(timer); timer = setTimeout(rebuild, 700); });
    } catch (_) { }
  }
  console.log(`  watching ${dirs.size} folder${dirs.size === 1 ? '' : 's'}. The page reloads itself when you are not using it. Ctrl+C to stop.`);
}
