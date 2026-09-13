#!/usr/bin/env node
// Build the DaiDocs memory dashboard: one self-contained HTML file.
//   node build_dashboard.mjs [--out <file>] [--install <dir>] [--no-open] [--watch]
// Everything is read from disk at build time and embedded, so the page works offline with no
// server or fetch and opens with a double click. Two views over the same tree: MEMORY (stores,
// their memories, and topic/entity links) and PROJECT (the folders those stores belong to,
// with real file counts and sizes). Opens in the browser when someone is watching (open_page.js).

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

// Default to the install this file lives in. fileURLToPath, not hand-rolled URL surgery:
// a path with a space arrives percent-encoded in import.meta.url.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const INSTALL = opt('install', path.resolve(HERE, '..', '..'));
const OUT = path.resolve(opt('out', path.join(process.cwd(), 'daidocs-dashboard.html')));

const readJson = fp => { try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; } };
const readLines = fp => { try { return fs.readFileSync(fp, 'utf8').split('\n').filter(l => l.trim()); } catch { return []; } };
const parseLines = fp => readLines(fp).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const sizeOf = fp => { try { return fs.statSync(fp).size; } catch { return 0; } };

// Every store this machine knows about: the registry's declared ones plus the shared default,
// which is never declared and is where everything lands until something is declared.
function findStores() {
  const out = [];
  // Via lib/registry (the one place that decides where the registry lives), so
  // DAIDOCS_REGISTRY is honoured like everywhere else.
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
  return out.filter(s => s.storeDir && fs.existsSync(s.storeDir));
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
    // Split into the format's three zones for display. The three-zoom discipline is for
    // MODELS; a person reading their own memory wants the full text, still shown in zones.
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

    // The verbatim original (the .dai's raw: pointer, _raw/<engine id>), losslessness made
    // inspectable. Capped so one runaway session can't make the page unopenable; the cap is
    // stated so a truncated file isn't mistaken for complete.
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

  // Captured-but-not-converted, grouped by origin project so a single "29 unindexed" number
  // becomes a list of decisions. Older markers carry only the "[name] " title tag, used when
  // the path is missing.
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

// Two memories are linked when they share topics or entities; weight is the shared-term
// count, and weak single-term links are dropped (a graph where everything touches everything
// says nothing).
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

const SKIP = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', '.cache']);

// A project as it is: every folder and file with sizes, and a per-type count at each level,
// rolled up, so you can see what a folder holds before opening it. Depth is bounded so the
// scan doesn't walk an entire disk.
function scanProject(root, storeDirs, depth = 0) {
  const node = {
    name: path.basename(root) || root, path: root, dirs: [], fileList: [],
    files: 0, bytes: 0, kinds: {}, isStore: storeDirs.has(path.resolve(root)),
  };
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return node; }

  for (const e of entries) {
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

const stores = findStores().map(loadStore);
const storeDirSet = new Set(stores.map(s => path.resolve(s.storeDir)));

const data = {
  generated: new Date().toISOString(),
  install: INSTALL,
  // kept current by a watcher, so the page may reload itself
  live: argv.includes('--watch'),
  // The page suggests commands, which must be plausible on the machine it's read on: a
  // hardcoded D:/backups is meaningless on a Mac.
  platform: process.platform,
  backupHint: process.platform === 'win32' ? 'D:/backups' : path.join(os.homedir(), 'Backups'),
  version: (() => { try { return JSON.parse(fs.readFileSync(path.join(INSTALL, 'package.json'), 'utf8')).version; } catch { return 'unknown'; } })(),
  stores: stores.map(s => ({
    id: s.id, label: s.label, type: s.type, root: s.root, storeDir: s.storeDir,
    declared: s.declared, reads: s.reads, connections: s.connections,
    counts: s.counts, bytes: s.bytes,
    pendingGroups: s.pendingGroups,
    memories: s.memories,
    links: linksWithin(s.memories),
    project: s.root && fs.existsSync(s.root) ? scanProject(s.root, storeDirSet) : null,
  })),
};

const html = fs.readFileSync(path.join(HERE, 'dashboard.template.html'), 'utf8')
  // Escape </ so a transcript containing "</script>" can't end the embedded <script> early.
  // "<\/" is identical to JSON and JS but invisible to the HTML parser, so data is unchanged.
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

// Hand the built page to the browser rather than just printing its path (the WHETHER lives
// in lib/open_page.js). A watcher rebuild opens nothing.
if (!argv.includes('--watch-child') && OPEN.shouldOpen(process.env, argv)) console.log(OPEN.openPage(OUT));

// --watch: rebuild on any store change. A rebuild is this script run again (not a function),
// so a fresh process can't carry stale state.
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
