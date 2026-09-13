// Which store a session writes to, and which stores a read may touch. A project can
// declare its own store in <project>/.daidocs/config.json:
//   { type, store, id, reads: ["self"|"parent"|"children"|<path>|"all"], connections, label }
// Resolution walks up from the cwd to the first config, else the shared store at
// ~/DaiDocs. Three rules keep it honest: nothing widens silently (a wider read names every
// store it touched); both ends must declare a connection; connections don't chain.

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
  // reversible: unlock, change, re-lock
  locked: { write: false, external: true, permanent: true },
  // permanent: change it by copying it
  frozen: { write: false, external: true, permanent: true },
  connected: { write: true, external: true, permanent: true },
  shared: { write: true, external: true, permanent: true },
  // asks every session, never in a wider read
  confidential: { write: true, external: false, permanent: true },
  // testing; never becomes permanent memory
  temporary: { write: true, external: false, permanent: false },
};

const DEFAULT_CONFIG = { id: null, type: 'normal', store: `${CONFIG_DIR}/store`, reads: ['self'], connections: [], label: null };

const readJson = fp => { try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; } };
const norm = p => path.resolve(p).replace(/\\/g, '/');

// Walk up from `dir` to the first .daidocs/config.json (else null = the shared store).
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

// Record where this store is and give it an id if it has none. Runs on every resolve, so
// it's cheap and every failure is swallowed — an unwritable home loses enumeration, never
// a read. The id is written into the project's config too, since that copy travels with
// the folder and makes a moved folder identifiable.
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

// Declare a folder as a project: write its config, create its store, keep it out of git,
// register the id. Lives here (not only setup.js) so an assistant can declare on request —
// declaring from a terminal is a step nobody takes, so the feature otherwise goes unused.
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

  // Keep the whole folder out of git from inside, so git never mentions it and we never
  // edit the user's own .gitignore. A memory folder is not a repo's business; sharing stays
  // deliberate (copy it, or git add -f).
  const gi = path.join(cfgDir, '.gitignore');
  const SELF_IGNORE = '# Your memory lives here, and it is nobody else\'s business.\n'
    + '# This folder keeps itself out of git: the store, the config, all of it.\n'
    + '# To share a store anyway, copy it, or commit it with: git add -f\n'
    + '*\n';
  try {
    const cur = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
    const ignoresEverything = cur.split('\n').some(l => l.trim() === '*');
    // Replace only our own older auto-written file; never touch a user-written one.
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

function loadPermissions() { return readJson(PERMISSIONS) || {}; }

function savePermission(storeDir, state) {
  const all = loadPermissions();
  // always | never
  all[norm(storeDir)] = state;
  fs.mkdirSync(path.dirname(PERMISSIONS), { recursive: true });
  fs.writeFileSync(PERMISSIONS, JSON.stringify(all, null, 2));
  return all;
}

// always | never | ask. Nothing is granted by default: a store the user has not
// ruled on is `ask`, which the caller turns into a question.
function permissionFor(storeDir) {
  return loadPermissions()[norm(storeDir)] || 'ask';
}

// Every store this read may touch, with the reason each is included; permissions are the
// caller's job, not decided here. A store is a candidate when `reads` names it or a
// connection is declared at both ends. Confidential/temporary stores are candidates only
// for themselves.
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
    // The walk-up lets a path naming a store folder resolve to its project, but it must
    // never climb out and resolve to an ancestor (or the reader itself): a deleted part
    // would otherwise resolve to the parent, get added twice, and double every fact/event.
    // It can't be an existence check: a declared project with nothing saved has no store yet.
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
    // Every declared store one level down, so a parent reads its parts without listing each
    // and picks up new ones automatically. One level only: deeper reach is reach nobody granted.
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
    // we only READ on receive/both
    if (mode !== 'receive' && mode !== 'both') continue;
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
    // your own store never asks
    if (c.why === 'this project') { allowed.push(c); continue; }
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
