// Shared on-disk state four processes use to agree about one session (none can see the
// others run): the Stop hook writes the transcript + meta + unconverted tail, save_memory
// advances the saved mark and clears the tail, the archiver clears it on index, and
// start/recall read the tail so a short session is usable before conversion.
//   _raw/<id>.txt           whole transcript, rewritten at every stop
//   _raw/<id>.meta.json     { hash, len, tokens, cwd, project, at, savedLen, savedHash, savedAt, seq }
//   _unconverted/<id>.txt   text after savedLen; absent when nothing waits
//   _pending/<id>.json      present while anything after savedLen is unconverted
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

// Which folder a session belongs to, recorded by the SessionStart hook (which always receives the
// real cwd) and read back by the MCP server (which does not: the desktop app launches stdio MCP
// servers with cwd=$HOME, so resolving the store from process.cwd() lands in the shared store while
// the hooks wrote the capture into the project store). The server correlates by
// CLAUDE_CODE_SESSION_ID, so recall and save use the SAME store the hooks did, on desktop and CLI.
const SESSION_STORES = path.join(os.homedir(), '.daidocs', 'session-stores.json');

function recordSessionCwd(sessionId, cwd) {
  try {
    const id = cleanId(sessionId);
    if (!id || id === 'cc_' || !cwd) return;
    let m = readJson(SESSION_STORES) || {};
    m[id] = { cwd: String(cwd), at: new Date().toISOString() };
    // Keep the most recent 200 so the file never grows without bound.
    const kept = Object.entries(m)
      .sort((a, b) => String((b[1] || {}).at).localeCompare(String((a[1] || {}).at)))
      .slice(0, 200);
    fs.mkdirSync(path.dirname(SESSION_STORES), { recursive: true });
    fs.writeFileSync(SESSION_STORES, JSON.stringify(Object.fromEntries(kept)));
  } catch (_) { /* a convenience map; never break a hook over it */ }
}

function sessionCwd(sessionId) {
  try {
    const id = cleanId(sessionId);
    const e = (readJson(SESSION_STORES) || {})[id];
    return e && e.cwd ? e.cwd : null;
  } catch { return null; }
}

// The project folder the MCP server should resolve its store from, most reliable first:
// CLAUDE_PROJECT_DIR (set by newer Claude Code), then the cwd the SessionStart hook recorded for
// this CLAUDE_CODE_SESSION_ID, then process.cwd() as a last resort.
function resolveProjectDir() {
  const isDir = p => { try { return !!p && fs.statSync(p).isDirectory(); } catch { return false; } };
  const proj = String(process.env.CLAUDE_PROJECT_DIR || '').trim();
  if (isDir(proj)) return proj;
  const sid = String(process.env.CLAUDE_CODE_SESSION_ID || '').trim();
  if (sid) { const c = sessionCwd(sid); if (isDir(c)) return c; }
  return process.cwd();
}

const UNCONVERTED = '_unconverted';

const readJson = fp => { try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; } };
const norm = p => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const safe = id => String(id || '').replace(/[^\w.-]/g, '');

// The project a capture belongs to: the nearest ancestor holding a .daidocs store or a .git
// repo, else the folder itself. Routing and scoping by this instead of the live shell cwd means
// a mid-session cd inside one project does not split its capture across two folders (B3).
function projectRoot(dir) {
  if (!dir) return null;
  // Only walk a directory that actually exists. A foreign or absent path (a Windows cwd read on
  // another OS, a since-deleted folder) is compared as its literal self and never resolved
  // against the process cwd, so two unrelated folders can never collapse onto one root. A real
  // folder with no .daidocs/.git ancestor is its own root, not the filesystem root.
  let exists = false;
  try { exists = fs.statSync(dir).isDirectory(); } catch { exists = false; }
  if (!exists) return norm(dir);
  const base = path.resolve(dir);
  let cur = base;
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(path.join(cur, '.daidocs')) || fs.existsSync(path.join(cur, '.git'))) return cur;
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return base;
}
// Two folders belong to the same capture when they resolve to the same project root.
const sameProject = (a, b) => !!a && !!b && norm(projectRoot(a)) === norm(projectRoot(b));

// gitignore-lite matcher used by .daiignore. `rel` is the session path relative to the project
// root. A plain name matches that folder/file as a path prefix, a trailing segment, or any
// segment; * matches within a segment and ** across segments.
function matchIgnore(rel, pattern) {
  const p = String(pattern || '').trim().replace(/\/+$/, '');
  if (!p) return false;
  if (/[*?]/.test(p)) {
    const re = new RegExp('^' + p.split('/').map(seg => seg
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')
      .replace(/\?/g, '[^/]')).join('/') + '(?:/|$)');
    return re.test(rel);
  }
  if (!rel) return false;
  const segs = rel.split('/');
  return rel === p || rel.startsWith(p + '/') || rel.endsWith('/' + p) || segs.includes(p);
}

// Whether a session's working directory is excluded from capture by a .daiignore at its project
// root (H2). Patterns match the cwd relative to that root. A missing or empty file ignores nothing.
// Lets a user keep a sensitive subfolder's sessions out of memory entirely, beyond the credential
// redaction that already runs on every capture.
function captureIgnored(cwd) {
  if (!cwd) return false;
  const root = projectRoot(cwd);
  if (!root) return false;
  let patterns;
  try {
    patterns = fs.readFileSync(path.join(root, '.daiignore'), 'utf8')
      .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  } catch { return false; }
  if (!patterns.length) return false;
  const rel = path.relative(root, path.resolve(cwd)).replace(/\\/g, '/');
  return patterns.some(p => matchIgnore(rel, p));
}

// Session ids arrive as Claude Code's own id, or already prefixed. Same rule
// as the hook and the archiver, so all of them name the same files.
function cleanId(session) {
  const s = String(session || '').replace(/[^\w-]/g, '');
  return (s.startsWith('cc_') ? s : 'cc_' + s).slice(0, 27);
}

const unconvertedPath = (storeDir, id) => path.join(storeDir, UNCONVERTED, safe(id) + '.txt');

// The tail goes in when there is one and comes out when there is not, so the
// folder always shows exactly what is waiting and nothing else.
function writeUnconverted(storeDir, id, tail) {
  const p = unconvertedPath(storeDir, id);
  if (tail && tail.trim()) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, tail);
    return p;
  }
  if (fs.existsSync(p)) fs.unlinkSync(p);
  return null;
}

function clearUnconverted(storeDir, id) {
  const p = unconvertedPath(storeDir, id);
  if (fs.existsSync(p)) { fs.unlinkSync(p); return true; }
  return false;
}

// save_memory calls this once it has written the file: the part of the transcript
// that is now in the index gets marked, the marker comes down if nothing is left,
// and any still-unsaved tail stays waiting.
//
// coveredLen is how far into the transcript this save actually reached. It is passed
// explicitly because the length the hook captured (meta.len) is not the same as how
// much a given save indexed: a save that covers only part of the capture must not mark
// the rest as saved, or that rest is dropped from _unconverted and lost to recall. A
// caller that omits coveredLen is taken to have saved the whole capture (legacy
// behaviour). The mark never moves past the capture, and never backwards.
function markSaved(storeDir, session, coveredLen) {
  const id = cleanId(session);
  const mp = path.join(storeDir, '_raw', id + '.meta.json');
  const m = readJson(mp) || {};
  const total = Number(m.len || 0);
  const saved = coveredLen == null
    ? total
    : Math.min(total, Math.max(Number(m.savedLen || 0), Number(coveredLen) || 0));
  fs.mkdirSync(path.dirname(mp), { recursive: true });
  fs.writeFileSync(mp, JSON.stringify({
    ...m, savedLen: saved,
    savedHash: saved >= total ? (m.hash || null) : (m.savedHash || null),
    savedAt: new Date().toISOString(),
  }));
  if (saved >= total) {
    const pp = path.join(storeDir, '_pending', id + '.json');
    if (fs.existsSync(pp)) fs.unlinkSync(pp);
    clearUnconverted(storeDir, id);
  } else {
    // A tail is still unsaved: keep exactly that remainder waiting, so a partial save
    // can never be mistaken for a complete one.
    try {
      const full = fs.readFileSync(path.join(storeDir, '_raw', id + '.txt'), 'utf8');
      writeUnconverted(storeDir, id, full.slice(saved));
    } catch { /* no raw on disk: leave the existing tail untouched */ }
  }
  return id;
}

// Where a waiting session's text is. The new folder first; the two older
// locations after it, so a backlog written before this folder existed still
// resolves.
function rawFor(storeDir, segId, id) {
  return [unconvertedPath(storeDir, segId), id && id !== segId ? unconvertedPath(storeDir, id) : null,
    path.join(storeDir, '_raw', safe(segId) + '.txt'), id ? path.join(storeDir, '_raw', safe(id) + '.txt') : null]
    .filter(Boolean).find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

// Every session waiting in this store that came from the same folder, apart
// from the one asking. Tokens come from the marker when it recorded them, or
// are estimated from the text so an older marker still counts for something.
function pendingFor(storeDir, cwd, excludeId) {
  const dir = path.join(storeDir, '_pending');
  const out = [];
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return out; }
  for (const f of files) {
    if (!f.endsWith('.json') || f === excludeId + '.json') continue;
    const m = readJson(path.join(dir, f));
    if (!m) continue;
    if (cwd && !sameProject(m.cwd, cwd)) continue;
    const segId = m.segId || m.id || f.replace(/\.json$/, '');
    const raw = rawFor(storeDir, segId, m.id);
    let tokens = Number(m.tokens || 0);
    if (!tokens && raw) { try { tokens = Math.ceil(fs.statSync(raw).size / 4); } catch { } }
    out.push({ id: m.id || segId, segId, title: m.title || '', date: m.date || null, tokens, raw });
  }
  return out;
}

// Every unconverted tail in a store, newest first, with where it came from.
// Scoped to a folder when one is given: a project store is that folder's
// already, but the shared store holds every undeclared folder's sessions and
// a session in one of them should not be handed another's text.
function unconvertedFor(storeDir, cwd) {
  const dir = path.join(storeDir, UNCONVERTED);
  const out = [];
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return out; }
  for (const f of files) {
    if (!f.endsWith('.txt')) continue;
    const id = f.replace(/\.txt$/, '');
    const p = path.join(dir, f);
    const marker = readJson(path.join(storeDir, '_pending', id + '.json'));
    const meta = readJson(path.join(storeDir, '_raw', id + '.meta.json'));
    const origin = (marker && marker.cwd) || (meta && meta.cwd) || null;
    if (cwd && !sameProject(origin, cwd)) continue;
    let st = null; try { st = fs.statSync(p); } catch { continue; }
    out.push({
      id, path: p, bytes: st.size,
      tokens: Number((marker && marker.tokens) || 0) || Math.ceil(st.size / 4),
      at: (marker && marker.at) || (meta && meta.at) || st.mtime.toISOString(),
      date: (marker && marker.date) || ((meta && meta.at) || '').slice(0, 10) || null,
      title: (marker && marker.title) || '',
      cwd: origin,
    });
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

// Whether a folder should be asked "here, or general?". One rule, used by the
// start hook (which puts the question first) and the Stop hook (which makes
// sure it is asked). Never a declared folder, never a store named by
// DAIDOCS_STORE, never the home folder or a drive root, never a folder whose
// answer is already recorded.
function askableFolder(cwd, resolved) {
  if (!cwd || !resolved) return false;
  if (resolved.config || resolved.source === 'DAIDOCS_STORE') return false;
  const here = String(cwd).replace(/\\/g, '/').replace(/\/+$/, '');
  const home = require('os').homedir().replace(/\\/g, '/').replace(/\/+$/, '');
  if (here.toLowerCase() === home.toLowerCase() || /^[A-Za-z]:$/.test(here) || here === '/') return false;
  const d = require('./registry').folderDecision(cwd);
  return !(d && d.choice === 'general');
}

// Give a folder its own store without asking: a hook does this reliably, unlike an
// assistant prompt (the user's first message wins, and the declaring tool isn't loaded
// until after the MCP server is). Never throws: an unwritable folder falls back to the
// general store.
function autoDeclare(cwd, resolved) {
  if (!askableFolder(cwd, resolved)) return null;
  try {
    const r = require('./stores').declareProject(cwd, 'normal', null, null);
    return r && r.ok ? r : null;
  } catch (_) { return null; }
}

// One-line notice shown after the fact, with both ways to change it.
const folderNotice = (storeDir) => 'This folder now keeps its own memory, in '
  + String(storeDir).replace(/\\/g, '/') + '. That is the default for any folder you work in: '
  + 'nothing was asked and nothing needs answering. Mention it in one line. If the user would rather it went '
  + 'to the general store with everything else, they can say so and you call declare_project with store: "general"; '
  + 'to put it somewhere else, declare_project with a store path. Whatever is already saved here stays where it is.';

module.exports = { UNCONVERTED, markSaved, pendingFor, unconvertedFor, writeUnconverted, clearUnconverted, rawFor, cleanId, readJson, askableFolder, autoDeclare, folderNotice, projectRoot, sameProject, matchIgnore, captureIgnored, recordSessionCwd, sessionCwd, resolveProjectDir, SESSION_STORES };
