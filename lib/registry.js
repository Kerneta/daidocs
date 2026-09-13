// The directory of every memory store on this machine. A store lives in its project
// folder (so memory travels with the project), which means moving the folder stales every
// path to it. So each store gets a permanent id, written into its own config, and this
// file records where that id was last seen — pointers, never content (a cached summary
// would drift). Id format: YYYYMMDDTHHMMSS-<folder-name>, date first so ids sort.

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_DIR = '.daidocs';
const CONFIG_FILE = 'config.json';

// DAIDOCS_REGISTRY points tests at a throwaway registry so they never write the real one.
const FILE = () => process.env.DAIDOCS_REGISTRY
  || path.join(os.homedir(), CONFIG_DIR, 'stores.json');

const norm = p => path.resolve(p).replace(/\\/g, '/');
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'store';

// YYYYMMDDTHHMMSS-name. Sub-second collisions in one folder aren't worth defending against.
function newId(dir, when) {
  const d = when ? new Date(when) : new Date();
  const p = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${stamp}-${slug(path.basename(path.resolve(dir)))}`;
}

const EMPTY = { version: 1, stores: {}, folders: {} };

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    if (!j || typeof j !== 'object' || !j.stores) return { ...EMPTY, folders: {} };
    return { version: j.version || 1, stores: j.stores, folders: j.folders || {} };
  } catch { return { ...EMPTY, folders: {} }; }
}

// Where an UNDECLARED folder's memory goes: the recorded answer to the start-hook's one
// question ('general' = the shared store, don't ask again). Keyed case-insensitively on
// Windows (Claude Code varies desktop\\x vs Desktop\\x) and on the realpath (macOS
// /var -> /private/var gives one folder two names), with a fallback to the literal name so
// an answer recorded by an older version is still found. Record/forget clear both keys.
const real = p => { try { return fs.realpathSync(p); } catch { return p; } };
const cased = p => process.platform === 'win32' ? p.toLowerCase() : p;
const rawkey = p => cased(norm(p));
const fkey = p => cased(norm(real(p)));
function folderDecision(dir) {
  const reg = load();
  const f = reg.folders || {};
  return f[fkey(dir)] || f[rawkey(dir)] || null;
}
function recordFolder(dir, choice) {
  const reg = load();
  reg.folders = reg.folders || {};
  const k = fkey(dir), raw = rawkey(dir);
  if (raw !== k) delete reg.folders[raw];
  reg.folders[k] = { choice, at: new Date().toISOString() };
  return save(reg);
}
function forgetFolder(dir) {
  const reg = load();
  const f = reg.folders || {};
  const k = fkey(dir), raw = rawkey(dir);
  if (!f[k] && !f[raw]) return false;
  delete f[k];
  delete f[raw];
  return save(reg);
}

function save(reg) {
  if (process.env.DAIDOCS_NO_PERSIST) return false;
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    fs.writeFileSync(FILE(), JSON.stringify(reg, null, 2) + '\n');
    return true;
  } catch { return false; }
}

// Record where an id is now; returns what changed so a caller can say "this moved".
// Never throws or blocks a read — the registry is a convenience.
function record(entry) {
  if (!entry || !entry.id) return { ok: false };
  const reg = load();
  const now = new Date().toISOString();
  const prev = reg.stores[entry.id];
  const next = {
    id: entry.id,
    label: entry.label || path.basename(entry.root || ''),
    type: entry.type || 'normal',
    root: entry.root ? norm(entry.root) : (prev && prev.root) || null,
    storeDir: entry.storeDir ? norm(entry.storeDir) : (prev && prev.storeDir) || null,
    firstSeen: (prev && prev.firstSeen) || now,
    lastSeen: now,
  };
  const moved = prev && prev.root && next.root && prev.root !== next.root
    ? { from: prev.root, to: next.root } : null;
  // Only a real change earns a write; a read shouldn't need a writable home.
  const unchanged = prev && prev.root === next.root && prev.storeDir === next.storeDir
    && prev.label === next.label && prev.type === next.type
    && prev.lastSeen && (Date.now() - Date.parse(prev.lastSeen)) < 6 * 3600 * 1000;
  if (unchanged) return { ok: true, moved: null, written: false };
  reg.stores[entry.id] = next;
  return { ok: true, moved, written: save(reg) };
}

// Everything known, each marked with whether it is still where it was left.
function list() {
  const reg = load();
  return Object.values(reg.stores).map(s => ({
    ...s,
    present: !!(s.root && fs.existsSync(path.join(s.root, CONFIG_DIR, CONFIG_FILE))),
    memories: countMemories(s.storeDir),
  })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

// A line count, not a parse: the registry never holds content.
function countMemories(storeDir) {
  try {
    const fp = path.join(storeDir, '_index', 'manifest.jsonl');
    return fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean).length;
  } catch { return 0; }
}

const missing = () => list().filter(s => !s.present);

// Walk a tree for declared stores. Depth-limited and skipping the folders that
// make a naive scan take all day.
const SKIP = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'AppData',
  'Windows', 'Program Files', 'Program Files (x86)', '$Recycle.Bin', 'System Volume Information',
  'dist', 'build', '.next', '.cache']);

function scan(root, opts = {}) {
  const maxDepth = opts.maxDepth === undefined ? 8 : opts.maxDepth;
  const found = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const cfg = path.join(dir, CONFIG_DIR, CONFIG_FILE);
    if (fs.existsSync(cfg)) {
      try {
        const j = JSON.parse(fs.readFileSync(cfg, 'utf8'));
        found.push({ id: j.id || null, label: j.label || path.basename(dir), type: j.type || 'normal', root: norm(dir), configPath: cfg });
      } catch { /* an unreadable config is not a store we can identify */ }
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(path.resolve(root), 0);
  return found;
}

// Scan, then match what was found against what is lost, BY ID. This is the
// whole point of the identifier: the folder can be renamed and moved to another
// drive, and it still says who it is.
function reconcile(roots, opts = {}) {
  const lost = missing();
  if (!lost.length) return { lost: [], relocated: [], stillLost: [], scanned: 0 };
  const byId = new Map();
  let scanned = 0;
  for (const r of [].concat(roots)) {
    for (const f of scan(r, opts)) { scanned++; if (f.id) byId.set(f.id, f); }
  }
  const relocated = [], stillLost = [];
  for (const s of lost) {
    const hit = byId.get(s.id);
    if (!hit) { stillLost.push(s); continue; }
    const storeDir = readStoreDir(hit.configPath, hit.root);
    record({ id: s.id, label: hit.label, type: hit.type, root: hit.root, storeDir });
    relocated.push({ id: s.id, label: hit.label, from: s.root, to: hit.root });
  }
  return { lost, relocated, stillLost, scanned };
}

function readStoreDir(configPath, root) {
  try {
    const j = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const rel = j.store || `${CONFIG_DIR}/store`;
    return path.isAbsolute(rel) ? rel : path.join(root, rel);
  } catch { return path.join(root, CONFIG_DIR, 'store'); }
}

// Drop an id from the registry. For a store the user has genuinely deleted and
// does not want to be reminded about.
function forget(id) {
  const reg = load();
  if (!reg.stores[id]) return false;
  delete reg.stores[id];
  return save(reg);
}

module.exports = { FILE, newId, load, save, record, list, missing, scan, reconcile, forget, countMemories, folderDecision, recordFolder, forgetFolder };
