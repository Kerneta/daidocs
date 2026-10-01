// Which store a session writes to, and which stores a read is allowed to touch.
//
// The old rule was one store for the whole machine, at ~/DaiDocs, with every
// memory tagged by project and recall narrowing by tag. That does not hold: with
// dozens of projects it becomes one large file of unrelated material, and it
// puts separate clients' work in the same folder, which is a confidentiality
// problem rather than an inconvenience.
//
// So a project may declare its own store, and declare what it may read.
//
//   <project>/.daidocs/config.json
//   {
//     "type": "normal",              // see TYPES below
//     "store": ".daidocs/store",     // relative to the project, or absolute
//     "id": "20260907T143052-myapp",   // permanent: survives moving and renaming
//     "reads": ["self"],             // self | parent | children | <path> | all
//     "connections": [ { "to": "../other", "mode": "both" } ],
//     "label": "Client A"            // shown whenever its material is used
//   }
//
// Resolution walks up from the session's working directory to the first config
// and stops there. No config anywhere means the shared store, so nothing changes
// for anyone who has not opted in.
//
// Three rules keep this honest, and they are why the code below is fussier than
// it looks:
//
//   Nothing widens silently. A read that reaches past the current project says
//   so, and names every store it touched.
//   Both ends must agree. A connection declared on one side alone does nothing.
//   Connections do not chain. A reads B and B reads C gives A nothing from C,
//   because transitive access makes confidentiality meaningless two hops out.

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_DIR = '.daidocs';
const CONFIG_FILE = 'config.json';
const PERMISSIONS = path.join(os.homedir(), '.daidocs', 'permissions.json');
const SHARED_STORE = () => process.env.DAIDOCS_STORE || path.join(os.homedir(), 'DaiDocs');

// type: [writable, readableByOthers, permanent]
const TYPES = {
  normal: { write: true, external: true, permanent: true },
  locked: { write: false, external: true, permanent: true },   // reversible: unlock, change, re-lock
  frozen: { write: false, external: true, permanent: true },   // permanent: change it by copying it
  connected: { write: true, external: true, permanent: true },
  shared: { write: true, external: true, permanent: true },
  confidential: { write: true, external: false, permanent: true }, // asks every session, never in a wider read
  temporary: { write: true, external: false, permanent: false },   // testing; never becomes permanent memory
};

const DEFAULT_CONFIG = { id: null, type: 'normal', store: `${CONFIG_DIR}/store`, reads: ['self'], connections: [], label: null };

const readJson = fp => { try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; } };
const norm = p => path.resolve(p).replace(/\\/g, '/');

// ---------------------------------------------------------------- discovery --

// Walk up from `dir` to the first .daidocs/config.json. Stops at the filesystem
// root. Returns null when nothing declares a store, which means the shared one.
function findProject(dir) {
  let cur = path.resolve(dir || process.cwd());
  for (let i = 0; i < 40; i++) {
    const cfg = path.join(cur, CONFIG_DIR, CONFIG_FILE);
    if (fs.existsSync(cfg)) return { root: cur, configPath: cfg };
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return null;
}

function loadConfig(root, configPath) {
  const raw = readJson(configPath) || {};
  const cfg = { ...DEFAULT_CONFIG, ...raw };
  if (!TYPES[cfg.type]) cfg.type = 'normal';
  if (!Array.isArray(cfg.reads)) cfg.reads = ['self'];
  if (!Array.isArray(cfg.connections)) cfg.connections = [];
  cfg.root = root;
  cfg.configPath = configPath;
  cfg.storeDir = path.isAbsolute(cfg.store) ? cfg.store : path.join(root, cfg.store);
  cfg.rules = TYPES[cfg.type];
  cfg.label = cfg.label || path.basename(root);
  return cfg;
}

// The declared stores directly under a project root: immediate subfolders that
// carry their own .daidocs/config.json. Undeclared subfolders inherit the parent
// and so are not separate stores, which is why only declared ones count.
function childProjects(root) {
  let names = [];
  try { names = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); }
  catch { return []; }
  const out = [];
  for (const name of names) {
    if (name === CONFIG_DIR || name.startsWith('.')) continue;
    const dir = path.join(root, name);
    const cfgPath = path.join(dir, CONFIG_DIR, CONFIG_FILE);
    if (fs.existsSync(cfgPath)) out.push(loadConfig(dir, cfgPath));
  }
  return out;
}

// The nearest declared store above a project, or null at the top. Used by a
// brief sent upward: the one deliberate way a confidential part shares.
function parentProject(cfg) {
  if (!cfg || !cfg.root) return null;
  const up = findProject(path.dirname(cfg.root));
  return up ? loadConfig(up.root, up.configPath) : null;
}

// The store this session writes to, plus everything needed to decide reads.
// `DAIDOCS_STORE` still wins, because an explicit instruction outranks discovery.
function resolveStore(cwd) {
  if (process.env.DAIDOCS_STORE) {
    return { storeDir: process.env.DAIDOCS_STORE, type: 'shared', label: 'shared', source: 'DAIDOCS_STORE', config: null, rules: TYPES.shared };
  }
  const found = findProject(cwd);
  if (!found) {
    return { storeDir: SHARED_STORE(), type: 'shared', label: 'shared', source: 'shared default', config: null, rules: TYPES.shared };
  }
  const cfg = loadConfig(found.root, found.configPath);
  noteInRegistry(cfg);
  return { id: cfg.id || null, storeDir: cfg.storeDir, type: cfg.type, label: cfg.label, source: cfg.configPath, config: cfg, rules: cfg.rules };
}

// Tell the directory where this store is, and give it an id if it has none.
//
// Resolution happens on every call, so this has to be cheap and it has to be
// harmless: the registry writes only when something actually changed, and every
// failure here is swallowed. A home directory that cannot be written is a
// reason to lose the convenience of enumeration, never a reason to fail a read.
//
// The id is stamped into the project's own config, not just the registry,
// because the config is the copy that travels with the folder. That is what
// makes a moved folder identifiable: the registry says what was lost, the
// folder itself says who it is.
function noteInRegistry(cfg) {
  try {
    const R = require('./registry');
    if (!cfg.id) {
      const id = R.newId(cfg.root);
      // Write it back only if we can. A frozen or read-only project keeps
      // working without an id; it simply cannot be found again after a move.
      try {
        const raw = readJson(cfg.configPath) || {};
        if (!raw.id) { raw.id = id; fs.writeFileSync(cfg.configPath, JSON.stringify(raw, null, 2) + '\n'); }
        cfg.id = raw.id || id;
      } catch { return; }
    }
    R.record({ id: cfg.id, label: cfg.label, type: cfg.type, root: cfg.root, storeDir: cfg.storeDir });
  } catch { /* the directory is a convenience; never let it break a read */ }
}

// Declare a folder as a project: write its config, create its store, keep the
// store out of git, and register the id.
//
// This lives here rather than only in setup.js because declaring from a terminal
// is a step nobody takes. The folder system worked from the day it shipped and
// not one folder was ever declared, because the only way in was a command you
// had to know existed. An assistant that can do it when asked is the difference
// between a feature and a feature nobody uses.
function declareProject(dir, type, storePath, label, reads) {
  const root = path.resolve(dir);
  if (!fs.existsSync(root)) return { ok: false, reason: `${root} does not exist.` };
  if (!TYPES[type || 'normal']) {
    return { ok: false, reason: `"${type}" is not a folder type. Choose one of: ${Object.keys(TYPES).join(', ')}.` };
  }
  const cfgDir = path.join(root, CONFIG_DIR);
  const fp = path.join(cfgDir, CONFIG_FILE);
  const existing = readJson(fp);
  fs.mkdirSync(cfgDir, { recursive: true });

  const cfg = { ...DEFAULT_CONFIG, ...(existing || {}), type: type || (existing && existing.type) || 'normal' };
  if (storePath) cfg.store = storePath;
  if (label) cfg.label = label;
  // What this folder may read: self, parent, children, all, or a path. Set
  // from the conversation, because a config.json edit is a step nobody takes.
  if (Array.isArray(reads) && reads.length) cfg.reads = reads.map(r => String(r).trim()).filter(Boolean);
  cfg.label = cfg.label || path.basename(root);
  let R = null;
  try { R = require('./registry'); if (!cfg.id) cfg.id = R.newId(root); } catch { /* id is a convenience */ }
  fs.writeFileSync(fp, JSON.stringify(cfg, null, 2) + '\n');

  const storeDir = path.isAbsolute(cfg.store) ? cfg.store : path.join(root, cfg.store);
  fs.mkdirSync(storeDir, { recursive: true });

  // This folder keeps ITSELF out of git, all of it.
  //
  // It used to ignore `store/` alone, leaving config.json tracked on the theory
  // that a folder's type is a team decision. What that actually did was put
  // `?? .daidocs/` in front of someone in every repository they work in, one
  // `git add -A` away from committing a description of their own memory to a
  // public remote. A memory folder is not a repository's business.
  //
  // Ignoring everything from inside means git never mentions the folder, and
  // nothing is written to the user's own .gitignore, which is not ours to edit.
  // Sharing a store stays possible and becomes deliberate: copy it, or commit it
  // with `git add -f`.
  const gi = path.join(cfgDir, '.gitignore');
  const SELF_IGNORE = '# Your memory lives here, and it is nobody else\'s business.\n'
    + '# This folder keeps itself out of git: the store, the config, all of it.\n'
    + '# To share a store anyway, copy it, or commit it with: git add -f\n'
    + '*\n';
  try {
    const cur = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
    const ignoresEverything = cur.split('\n').some(l => l.trim() === '*');
    // The older file, written by a previous version, is replaced. Anything the
    // user has written themselves is left exactly as it is.
    const oursAndStale = /^# The memory store holds verbatim transcripts/.test(cur)
      && cur.split('\n').filter(l => l.trim() && !l.trim().startsWith('#')).join() === 'store/';
    if (!ignoresEverything && (!cur || oursAndStale)) fs.writeFileSync(gi, SELF_IGNORE);
  } catch { /* an unwritable ignore file is not a reason to fail the declaration */ }

  if (R) { try { R.record({ id: cfg.id, label: cfg.label, type: cfg.type, root, storeDir }); } catch { } }
  return { ok: true, root, storeDir, type: cfg.type, label: cfg.label, id: cfg.id || null, existed: !!existing, reads: cfg.reads };
}

// A project may be read-only. Writers ask before they write rather than failing
// halfway through and leaving an index half-appended.
function canWrite(resolved) {
  if (resolved.rules.write) return { ok: true };
  const how = resolved.type === 'locked'
    ? 'unlock it first (see LOCKED.md), then re-lock when you are done'
    : 'a frozen store is final; copy it and change the copy';
  return { ok: false, reason: `${resolved.label} is ${resolved.type}, so nothing can be written to it: ${how}` };
}

// -------------------------------------------------------------- permissions --

function loadPermissions() { return readJson(PERMISSIONS) || {}; }

function savePermission(storeDir, state) {
  const all = loadPermissions();
  all[norm(storeDir)] = state;               // always | never
  fs.mkdirSync(path.dirname(PERMISSIONS), { recursive: true });
  fs.writeFileSync(PERMISSIONS, JSON.stringify(all, null, 2));
  return all;
}

// always | never | ask. Nothing is granted by default: a store the user has not
// ruled on is `ask`, which the caller turns into a question.
function permissionFor(storeDir) {
  return loadPermissions()[norm(storeDir)] || 'ask';
}

// ------------------------------------------------------------------- reading --

// Every store this read is ALLOWED to touch, in order, with the reason each is
// included. Nothing here consults permissions: that is the caller's job, because
// only the caller can ask a question. This returns candidates and why.
//
// A store is a candidate when the current project names it in `reads`, or when a
// connection exists that BOTH ends declare. Confidential and temporary stores are
// never candidates for anyone but themselves.
function readCandidates(resolved) {
  const out = [{ storeDir: resolved.storeDir, label: resolved.label, type: resolved.type, why: 'this project' }];
  // Declared reads that no longer resolve. Collected rather than ignored, so a
  // deleted part shows up as an absence someone can act on instead of the store
  // quietly getting smaller. readCandidates.missing carries them.
  const missing = [];
  Object.defineProperty(out, 'missing', { value: missing, enumerable: false });
  const cfg = resolved.config;
  if (!cfg) return out;

  const add = (dir, label, why) => {
    const abs = path.isAbsolute(dir) ? dir : path.resolve(cfg.root, dir);
    // The walk-up exists so a path naming a store folder inside a project
    // resolves to that project. It must never climb out of the target and land
    // on an ancestor, and least of all on the reader.
    //
    // That is exactly what a deleted part does. Remove <root>/part and the
    // parent's `reads: ["./part"]` no longer finds a config there, so the walk
    // continues up and hits the parent's own config. The parent's store was
    // then added a SECOND time under the deleted part's name, mergeStores
    // concatenated its _index twice, and every fact and event counted double.
    // Resolving to yourself is never a read of somewhere else.
    //
    // The check cannot be "does the path exist", because a declared project
    // that has not saved anything yet has no store folder on disk and is
    // perfectly valid.
    const direct = findProject(abs);
    const other = direct || findProject(path.dirname(abs));
    let type = 'unknown', otherCfg = null;
    if (other) { otherCfg = loadConfig(other.root, other.configPath); type = otherCfg.type; }
    if (otherCfg && norm(otherCfg.root) === norm(cfg.root)) { missing.push({ path: abs, why, self: true }); return; }
    if (!otherCfg && !fs.existsSync(abs)) { missing.push({ path: abs, why }); return; }
    // A store that declares itself unreadable from outside is never a candidate,
    // whatever anyone else declares about it.
    if (otherCfg && !otherCfg.rules.external) return;
    const storeDir = otherCfg ? otherCfg.storeDir : abs;
    // Dedupe on the RESOLVED store, not the declared path: two different
    // declarations can name the same store.
    if (out.some(o => norm(o.storeDir) === norm(storeDir))) return;
    out.push({ storeDir, label: otherCfg ? otherCfg.label : path.basename(abs), type, why });
  };

  for (const r of cfg.reads) {
    if (r === 'self') continue;
    if (r === 'all') { add(SHARED_STORE(), 'shared', 'reads: all'); continue; }
    if (r === 'parent') {
      const up = findProject(path.dirname(cfg.root));
      if (up) { const p = loadConfig(up.root, up.configPath); if (p.rules.external) add(p.storeDir, p.label, 'reads: parent'); }
      continue;
    }
    // Every declared store one level down. A project laid out as one folder per
    // part reads its parts this way without listing each path, and a part added
    // later is picked up without editing the parent. One level only, by the
    // same reasoning that stops connections chaining: a part's own sub-parts
    // are that part's business, and reach that grows with depth is reach that
    // nobody explicitly granted.
    if (r === 'children') {
      for (const child of childProjects(cfg.root)) {
        if (child.rules.external) add(child.storeDir, child.label, 'reads: children');
      }
      continue;
    }
    add(r, r, `reads: ${r}`);
  }

  // Connections count only when both ends declare them. A link one side invented
  // is not a link.
  for (const c of cfg.connections || []) {
    if (!c || !c.to) continue;
    const mode = c.mode || 'both';
    if (mode !== 'receive' && mode !== 'both') continue;         // we only READ on receive/both
    const otherRoot = path.resolve(cfg.root, c.to);
    const found = findProject(otherRoot);
    if (!found) continue;
    const otherCfg = loadConfig(found.root, found.configPath);
    if (!otherCfg.rules.external) continue;
    const agrees = (otherCfg.connections || []).some(oc => {
      if (!oc || !oc.to) return false;
      const back = path.resolve(otherCfg.root, oc.to);
      const m = oc.mode || 'both';
      return norm(back) === norm(cfg.root) && (m === 'send' || m === 'both');
    });
    if (!agrees) continue;
    add(otherCfg.storeDir, otherCfg.label, `connected (${mode}, agreed at both ends)`);
  }
  return out;
}

// Turn candidates into the stores actually readable now, splitting out the ones
// that need a question. `ask` is never answered here.
function partitionByPermission(candidates) {
  const allowed = [], needsAsking = [], denied = [];
  for (const c of candidates) {
    if (c.why === 'this project') { allowed.push(c); continue; }  // your own store never asks
    const p = permissionFor(c.storeDir);
    if (p === 'always') allowed.push(c);
    else if (p === 'never') denied.push(c);
    else needsAsking.push(c);
  }
  return { allowed, needsAsking, denied };
}

// The line a read prints about where its material came from. Silence about
// provenance is what makes mixing dangerous, so this is not optional.
function provenance(stores) {
  if (!stores.length) return 'no stores were read';
  if (stores.length === 1) return `read from ${stores[0].label}`;
  return `read from ${stores.length} stores: ${stores.map(s => s.label).join(', ')}`;
}

module.exports = {
  TYPES, CONFIG_DIR, CONFIG_FILE, PERMISSIONS, SHARED_STORE, DEFAULT_CONFIG,
  findProject, loadConfig, resolveStore, canWrite, childProjects, parentProject, declareProject,
  loadPermissions, savePermission, permissionFor,
  readCandidates, partitionByPermission, provenance,
};
