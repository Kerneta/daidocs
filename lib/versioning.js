// Install versioning and history. Two home-dir files: ~/.daidocs-setup-state.json holds
// the CURRENT install (deleted by --restore) and ~/.daidocs-installs.jsonl is an
// append-only history that is NEVER deleted. JSONL so it stays greppable and survives a
// write cut off mid-line.

const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_FILE = path.join(os.homedir(), '.daidocs-setup-state.json');
const LEDGER_FILE = path.join(os.homedir(), '.daidocs-installs.jsonl');

// Installed version from lib/version.js; falls back to package.json only when inspecting
// a different install directory on disk.
function packageVersion(installDir) {
  try {
    const here = path.resolve(__dirname, '..');
    if (path.resolve(installDir) === here) return require('./version').VERSION;
    const mod = path.join(installDir, 'lib', 'version.js');
    if (fs.existsSync(mod)) return require(mod).VERSION;
  } catch { /* fall through to package.json */ }
  try { return JSON.parse(fs.readFileSync(path.join(installDir, 'package.json'), 'utf8')).version || 'unknown'; }
  catch { return 'unknown'; }
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

function writeState(patch) {
  const state = { ...readState(), ...patch };
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch { }
  return state;
}

function readLedger() {
  if (!fs.existsSync(LEDGER_FILE)) return [];
  const rows = [];
  for (const line of fs.readFileSync(LEDGER_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* torn line, skip it */ }
  }
  return rows;
}

// action: install | upgrade | rollback | uninstall | reconfigure
function recordEvent(action, fields) {
  const row = { at: new Date().toISOString(), action, node: process.version, ...fields };
  try { fs.appendFileSync(LEDGER_FILE, JSON.stringify(row) + '\n'); } catch { }
  return row;
}

// What is configured now, or null. A pre-versioning install (only `touched` entries) is
// reported with legacy:true and unknown path; adopt it rather than uninstall, since a
// restore could revert config belonging to the running copy.
function currentInstall() {
  const s = readState();
  const hasTouched = s.touched && Object.keys(s.touched).length > 0;
  if (!s.version && !s.installPath) {
    if (!hasTouched) return null;
    return { version: 'unversioned', installPath: 'unknown', installedAt: null, surfaces: [], observer: null, legacy: true };
  }
  return { version: s.version || 'unknown', installPath: s.installPath || 'unknown', installedAt: s.installedAt || null, surfaces: s.surfaces || [], observer: s.observer || null, legacy: false };
}

// Compare versions in this project's scheme (not semver): parts like "4n1" split into a
// leading number and a suffix, compared number-then-suffix, with an absent suffix sorting
// first (so 4.4 < 4.4n1 < 4.4n2). Returns -1, 0 or 1.
function splitPart(part) {
  const m = String(part).match(/^(\d*)(.*)$/);
  return { num: m[1] === '' ? 0 : parseInt(m[1], 10), suffix: m[2] || '' };
}

function compareVersions(a, b) {
  const clean = v => String(v).trim().replace(/^[vV]/, '').split('.');
  const pa = clean(a), pb = clean(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = splitPart(pa[i] === undefined ? '0' : pa[i]);
    const y = splitPart(pb[i] === undefined ? '0' : pb[i]);
    if (x.num !== y.num) return x.num > y.num ? 1 : -1;
    if (x.suffix !== y.suffix) return x.suffix > y.suffix ? 1 : -1;
  }
  return 0;
}

// install  first time on this machine
// upgrade  a newer version replacing an older one
// rollback a deliberate move back to an older version
// reconfigure  same version, setup run again
function classify(previous, next) {
  if (!previous) return 'install';
  const c = compareVersions(next, previous);
  if (c > 0) return 'upgrade';
  if (c < 0) return 'rollback';
  return 'reconfigure';
}

function formatHistory(rows) {
  if (!rows.length) return '  No install history recorded yet.';
  const pad = (s, n) => String(s === null || s === undefined ? '' : s).padEnd(n);
  // Columns sized to the widest value so a long version string can't run into the next.
  const w = (header, get) => Math.max(header.length, ...rows.map(r => String(get(r) || '').length)) + 2;
  const wv = w('version', r => r.version), wf = w('from', r => r.from);
  const lines = [
    '  ' + pad('when', 20) + pad('action', 13) + pad('version', wv) + pad('from', wf) + 'observer',
    '  ' + '-'.repeat(20 + 13 + wv + wf + 24),
  ];
  for (const r of rows) {
    lines.push('  ' + pad(String(r.at).replace('T', ' ').slice(0, 19), 20)
      + pad(r.action, 13) + pad(r.version, wv) + pad(r.from || '', wf) + (r.observer || ''));
  }
  return lines.join('\n');
}

module.exports = {
  STATE_FILE, LEDGER_FILE,
  packageVersion, readState, writeState,
  readLedger, recordEvent, currentInstall,
  compareVersions, classify, formatHistory,
};
