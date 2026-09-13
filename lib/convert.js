// Converting chat history into the store. Sources: `claude` (Claude Code transcripts),
// `raw` (sessions the hook captured but never converted), `folder` (a directory of
// .txt/.md/.jsonl exports). Each becomes an item, the person picks, cost is quoted BEFORE
// any paid call, and each is written the moment it finishes so a crash loses at most one
// document; re-running skips what's already converted.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { countTokens } = require('./tokens');
const { redact, summarize } = require('./redact');
const { getProviders } = require('./providers');
const { ENGINE_PATH } = require('./version');

// Stamp the source id onto index rows lacking one. profile.jsonl is the only row the
// engine writes without a src and the most personal, so an unattributed preference must
// not reach disk.
function attribute(indexPath, content, srcId, at) {
  const isProfile = /profile\.jsonl$/.test(indexPath);
  // The manifest has a date but no time, so same-day conversations can't be ordered.
  // Stamp `at` HERE, not in the engine, whose output must stay byte-identical to the
  // measured master copy (same reason `src` is added here).
  const isManifest = /manifest\.jsonl$/.test(indexPath);
  if (!isProfile && !(isManifest && at)) return content;
  const rows = content.split('\n').filter(Boolean).map(line => {
    try {
      const j = JSON.parse(line);
      if (isProfile && !j.src) j.src = srcId;
      if (isManifest && at && !j.at) j.at = at;
      return JSON.stringify(j);
    }
    catch { return line; }
  });
  return rows.length ? rows.join('\n') + '\n' : content;
}

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const readJson = fp => { try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; } };

// List prices per million tokens (input/output). OpenAI is approximate and Gemini
// unknown; the quote says so rather than pretending.
const PRICES = {
  'anthropic:claude-fable-5-1': { input: 10, output: 50, note: 'list price' },
  'anthropic:claude-opus-5': { input: 5, output: 25, note: 'list price' },
  'anthropic:claude-sonnet-5': { input: 2, output: 10, note: 'list price' },
  'openai:gpt-4.1-mini': { input: 0.4, output: 1.6, note: 'approximate' },
};
// observed mean Understanding size
const OUTPUT_PER_DOC = 650;

// Claude Code JSONL -> plain conversation: user/assistant text only (tool calls, results,
// reminders dropped), credentials redacted. THE renderer — the SessionEnd hook imports it
// too, so a transcript renders identically whichever path converts it.
function renderClaudeTranscript(fp) {
  const out = [];
  let cwd = null, first = null, last = null, sessionId = null;
  for (const line of fs.readFileSync(fp, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.cwd && !cwd) cwd = j.cwd;
    if (j.sessionId && !sessionId) sessionId = j.sessionId;
    if (j.timestamp) { if (!first) first = j.timestamp; last = j.timestamp; }
    if (j.type !== 'user' && j.type !== 'assistant') continue;
    const c = j.message && j.message.content;
    let text = '';
    if (typeof c === 'string') text = c;
    else if (Array.isArray(c)) text = c.filter(b => b.type === 'text' && b.text).map(b => b.text).join('\n');
    text = text.trim();
    if (!text || /^<system-reminder>|^\[SYSTEM NOTIFICATION|^<task-notification>|^Caveat:|^<local-command/.test(text)) continue;
    out.push(`[${j.type.toUpperCase()}]: ${text}`);
  }
  const { text, found } = redact(out.join('\n'));
  return {
    text, found,
    project: cwd ? projectName(cwd) : null,
    date: (last || first || '').slice(0, 10) || null,
    // Both ends, so a caller can date a segment by its content: a first capture belongs to
    // the start day, a continuation to the day its newer turns were said. Collapsing to one
    // date makes an old conversation converted today sort as if it happened today.
    startedOn: (first || '').slice(0, 10) || null,
    endedOn: (last || '').slice(0, 10) || null,
    startedAt: first || null,
    endedAt: last || null,
    sessionId: sessionId || path.basename(fp, '.jsonl'),
  };
}

// The project a session belongs to. basename(cwd) is wrong in a git worktree (every
// branch becomes its own project), so resolve back to the real repo: a worktree has a
// .git FILE pointing to <main>/.git/worktrees/<name>, and Claude Code also nests them
// under <project>/.claude/worktrees/<name>, recoverable from the path alone.
function projectName(cwd) {
  if (!cwd) return null;
  const norm = String(cwd).split('\\').join('/');
  const marker = norm.match(/^(.*?)\/\.claude\/worktrees\//);
  if (marker) return path.basename(marker[1]);
  try {
    const dotgit = path.join(cwd, '.git');
    if (fs.existsSync(dotgit) && fs.statSync(dotgit).isFile()) {
      const m = fs.readFileSync(dotgit, 'utf8').match(/gitdir:\s*(.+)/);
      if (m) {
        const g = m[1].trim().split('\\').join('/');
        const main = g.match(/^(.*?)\/\.git\/worktrees\//);
        if (main) return path.basename(main[1]);
      }
    }
  } catch { /* unreadable .git: fall through to the folder name */ }
  return path.basename(cwd);
}

function firstUserLine(text) {
  const m = text.match(/\[USER\]: (.{10,90})/);
  return m ? m[1].replace(/\s+/g, ' ').trim() : 'chat session';
}

function chunkText(text, target = 3000) {
  const paras = String(text).split(/\n(?=\[(?:USER|ASSISTANT)\]:)|\n\s*\n/);
  const chunks = []; let cur = [], curTok = 0;
  for (const p of paras) {
    const t = countTokens(p);
    if (curTok + t > target && cur.length) { chunks.push(cur.join('\n')); cur = []; curTok = 0; }
    cur.push(p); curTok += t;
  }
  if (cur.length) chunks.push(cur.join('\n'));
  return chunks;
}

// Very long sessions keep their head and tail for indexing; the full text is
// always in _raw. Same rule the hook applies.
function capText(text, cap) {
  if (countTokens(text) <= cap) return text;
  const parts = chunkText(text);
  const keep = []; let tok = 0;
  for (const p of [...parts.slice(0, 4), ...parts.slice(-4)]) { if (tok > cap) break; keep.push(p); tok += countTokens(p); }
  return keep.join('\n[... middle of session omitted from index; full text in _raw ...]\n');
}

function listClaudeSessions({ projectsDir = path.join(os.homedir(), '.claude', 'projects'), minBytes = 2000, project = null } = {}) {
  if (!fs.existsSync(projectsDir)) return [];
  const items = [];
  for (const slug of fs.readdirSync(projectsDir)) {
    const dir = path.join(projectsDir, slug);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = path.join(dir, f);
      const st = fs.statSync(fp);
      if (st.size < minBytes) continue;
      // Cheap peek for the label: first user row only, no full render yet.
      let cwd = null, ts = null, prompt = null;
      const fd = fs.openSync(fp, 'r');
      const buf = Buffer.alloc(Math.min(st.size, 65536));
      fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
      for (const line of buf.toString('utf8').split('\n')) {
        try {
          const j = JSON.parse(line);
          if (j.cwd && !cwd) cwd = j.cwd;
          if (j.timestamp && !ts) ts = j.timestamp;
          if (j.type === 'user' && !prompt) {
            const c = j.message && j.message.content;
            const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join(' ') : '';
            if (t && !/^<system-reminder>|^<local-command|^Caveat:/.test(t.trim())) prompt = t.replace(/\s+/g, ' ').trim().slice(0, 80);
          }
          if (cwd && ts && prompt) break;
        } catch { /* partial line at the buffer edge */ }
      }
      const proj = cwd ? path.basename(cwd) : slug;
      if (project && proj.toLowerCase() !== project.toLowerCase()) continue;
      items.push({ kind: 'claude', id: 'cc_' + path.basename(f, '.jsonl').replace(/[^\w-]/g, '').slice(0, 24), path: fp, project: proj, date: (st.mtime.toISOString()).slice(0, 10), started: ts ? ts.slice(0, 10) : null, title: prompt || 'claude code session', bytes: st.size });
    }
  }
  return items.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

// Sessions the hook captured but could not convert. The pending marker is the
// authority; a raw file without one has already been indexed.
function listRawCaptures(storeDir) {
  const pend = path.join(storeDir, '_pending');
  if (!fs.existsSync(pend)) return [];
  const items = [];
  for (const f of fs.readdirSync(pend)) {
    if (!f.endsWith('.json')) continue;
    const rec = readJson(path.join(pend, f)) || {};
    const id = rec.id || path.basename(f, '.json');
    const raw = [path.join(storeDir, '_raw', (rec.segId || id) + '.txt'), path.join(storeDir, '_raw', id + '.txt')].find(p => fs.existsSync(p));
    if (!raw) continue;
    const st = fs.statSync(raw);
    const m = String(rec.title || '').match(/^\[([^\]]+)\]/);
    items.push({ kind: 'raw', id, segId: rec.segId || id, path: raw, project: m ? m[1] : null, date: rec.date || st.mtime.toISOString().slice(0, 10), title: String(rec.title || '').replace(/^\[[^\]]+\] /, '').replace(/^Claude Code session: /, '') || 'captured session', bytes: st.size, pendingFile: path.join(pend, f) });
  }
  return items.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

// A folder of exports. .jsonl is treated as a Claude Code transcript; .txt and
// .md are taken as-is.
function listFolder(dir) {
  if (!fs.existsSync(dir)) return [];
  const items = [];
  for (const f of fs.readdirSync(dir)) {
    const fp = path.join(dir, f);
    if (!fs.statSync(fp).isFile()) continue;
    if (!/\.(txt|md|markdown|jsonl)$/i.test(f)) continue;
    const st = fs.statSync(fp);
    items.push({ kind: /\.jsonl$/i.test(f) ? 'claude' : 'file', id: (/\.jsonl$/i.test(f) ? 'cc_' : 'doc_') + f.replace(/\.[^.]+$/, '').replace(/[^\w-]/g, '_').slice(0, 40), path: fp, project: path.basename(dir), date: st.mtime.toISOString().slice(0, 10), title: f, bytes: st.size });
  }
  return items.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

// "all", "3", "1,4,7", "2-5", or any mix. 1-based, as printed.
function parsePick(spec, count) {
  if (!spec || /^all$/i.test(spec.trim())) return Array.from({ length: count }, (_, i) => i);
  const idx = new Set();
  for (const part of spec.split(',')) {
    const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) continue;
    const a = parseInt(m[1], 10), b = m[2] ? parseInt(m[2], 10) : a;
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (i >= 1 && i <= count) idx.add(i - 1);
  }
  return [...idx].sort((x, y) => x - y);
}

function loadText(item) {
  if (item.kind === 'claude') {
    const r = renderClaudeTranscript(item.path);
    return { text: r.text, found: r.found, project: item.project || r.project, date: r.date || item.date, title: item.title };
  }
  const raw = fs.readFileSync(item.path, 'utf8');
  const { text, found } = redact(raw);
  return { text, found, project: item.project, date: item.date, title: item.title };
}

// Quote before spending. Rule: state the worst case, then ask.
function estimate(items, spec, cap = 25000) {
  let input = 0, docs = 0, skippedTiny = 0;
  for (const it of items) {
    const { text } = loadText(it);
    const tok = countTokens(text);
    if (tok < 300) { skippedTiny++; continue; }
    docs++;
    input += Math.min(tok, cap);
  }
  const output = docs * OUTPUT_PER_DOC;
  const p = PRICES[spec];
  const usd = p ? (input / 1e6) * p.input + (output / 1e6) * p.output : null;
  return { docs, skippedTiny, inputTokens: input, outputTokens: output, usd, priceNote: p ? p.note : 'no price on file for this model' };
}

function alreadyInStore(storeDir, id, hash) {
  const meta = readJson(path.join(storeDir, '_raw', id + '.meta.json'));
  return !!(meta && meta.hash === hash);
}

// One item, written the moment it finishes. Returns a status string.
async function convertOne(item, { storeDir, observerSpec, cap = 25000, engine = null, onLog = () => {} }) {
  for (const d of ['_index', '_raw', '_pending']) fs.mkdirSync(path.join(storeDir, d), { recursive: true });
  const { text, found, project, date, title } = loadText(item);
  if (Object.keys(found).length) onLog(`redacted ${summarize(found)}`);
  if (countTokens(text) < 300) return 'too-small';
  const hash = sha256(text);
  const id = item.kind === 'raw' ? item.segId : item.id;
  if (alreadyInStore(storeDir, id, hash)) return 'already-converted';

  const daidocs = engine || require(ENGINE_PATH);
  const [observer] = getProviders([observerSpec]);
  if (typeof observer.available === 'function' && !observer.available()) return `observer "${observerSpec}" unavailable`;

  // lossless first
  fs.writeFileSync(path.join(storeDir, '_raw', id + '.txt'), text);
  const body = capText(text, cap);
  const parts = countTokens(body) > 6000 ? chunkText(body) : [body];
  const fullTitle = (project ? `[${project}] ` : '') + (item.kind === 'file' ? title : 'Claude Code session: ' + firstUserLine(text));
  for (let i = 0; i < parts.length; i++) {
    const pid = parts.length > 1 ? `${id}_p${i + 1}` : id;
    const res = await daidocs.ingest({
      id: pid, sourceId: pid, title: parts.length > 1 ? `${fullTitle} (part ${i + 1}/${parts.length})` : fullTitle,
      type: item.kind === 'file' ? 'doc' : 'chat', app: item.kind === 'file' ? 'daidocs-convert' : 'claude-code',
      capturedAt: date || new Date().toISOString().slice(0, 10), raw: parts[i],
    }, observer);
    for (const f of res.files) {
      const p = path.join(storeDir, f.path);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      if (f.path.startsWith('_index/')) fs.appendFileSync(p, attribute(f.path, f.content, pid));
      else fs.writeFileSync(p, f.content);
    }
    // The .dai file's raw: pointer names _raw/<engine id>; only the engine knows it.
    const daiOut = res.files.find(f => f.path.endsWith('.dai'));
    if (daiOut) fs.writeFileSync(path.join(storeDir, '_raw', path.basename(daiOut.path, '.dai')), parts[i]);
  }
  fs.writeFileSync(path.join(storeDir, '_raw', id + '.meta.json'), JSON.stringify({ hash, len: text.length, seq: 1 }));
  if (item.pendingFile && fs.existsSync(item.pendingFile)) fs.unlinkSync(item.pendingFile);
  return 'converted';
}

module.exports = {
  PRICES, attribute, projectName, renderClaudeTranscript, firstUserLine, chunkText, capText,
  listClaudeSessions, listRawCaptures, listFolder, parsePick,
  loadText, estimate, convertOne,
};
