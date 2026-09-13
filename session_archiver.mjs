#!/usr/bin/env node
// DaiDocs session archiver: Claude Code SessionEnd hook + catch-up CLI.
// Hook mode: reads the hook JSON from stdin, renders the session text, ALWAYS writes the raw
// to <store>/_raw/ (lossless, keyless), then ingests it if an observer key is available, else
// drops a <store>/_pending/ marker. Catch-up mode (--catch-up) ingests everything pending.
// Idempotent (a session already stored is skipped); sessions under 300 tokens are skipped.
// Env: DAIDOCS_STORE, DAIDOCS_OBSERVER.

import { createRequire } from 'module';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

const require = createRequire(import.meta.url);
const { VERSION, ENGINE_PATH } = require('./lib/version');
const daidocs = require(ENGINE_PATH);
const { getProviders } = require('./lib/providers');
const { countTokens } = require('./lib/tokens');
const { summarize } = require('./lib/redact');
const { projectName, attribute, renderClaudeTranscript, chunkText } = require('./lib/convert');
const S = require('./lib/stores');

// Resolved from the session's own directory, not from one machine-wide value.
let STORE_DIR = S.SHARED_STORE();
let RESOLVED = null;
// The working directory of the session being archived, kept so a pending marker
// can say where it came from.
let SESSION_CWD = null;
function useStore(cwd) {
  SESSION_CWD = cwd || null;
  RESOLVED = S.resolveStore(cwd);
  STORE_DIR = RESOLVED.storeDir;
  // Create the subdirectories for THIS store (not just the one this process started with):
  // a project store's _raw/_index/_pending must exist before the first archive into it.
  for (const d of ['_index', '_raw', '_pending', '_unconverted']) {
    try { fs.mkdirSync(path.join(STORE_DIR, d), { recursive: true }); } catch { /* a read-only store still reads */ }
  }
  return RESOLVED;
}

for (const d of ['_index', '_raw', '_pending', '_unconverted']) fs.mkdirSync(path.join(STORE_DIR, d), { recursive: true });
const { resolveObserver, subscriptionMode } = require('./lib/host');
const { writeUnconverted, clearUnconverted, rawFor } = require('./lib/session_marks');
const { needsKey } = require('./lib/observers');
// Host-aware observer (DAIDOCS_OBSERVER overrides). Chosen once at install so every entry
// point writes a store with the same observer.
const OBSERVER = resolveObserver();
const OBSERVER_SPEC = OBSERVER.spec;
const MIN_TOKENS = 300;

// On a subscription this hook doesn't call a PAID model: it saves the transcript and stops,
// since the next session converts for free. needsKey scopes the refusal to spending money —
// a keyless observer still runs here (which keeps the offline test path meaningful).
const SUBSCRIPTION = subscriptionMode() && needsKey(OBSERVER_SPEC);

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const readJson = fp => { try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; } };
// Distinguishes "no key configured" from "the call itself failed", so the
// status line and errors.log stop blaming a missing key for a network fault.
const observerReady = () => {
  try { const [o] = getProviders([OBSERVER_SPEC]); return typeof o.available !== 'function' || o.available(); }
  catch { return false; }
};
// head+tail cap for huge sessions; raise via env for full indexing
const CAP_TOKENS = parseInt(process.env.DAIDOCS_CAP_TOKENS || '25000', 10);

// One renderer, shared with `daidocs.js convert` via lib/convert.js, so a transcript reads
// identically whichever path converts it. Redaction happens inside it, before any write.
function renderTranscript(fp) {
  const r = renderClaudeTranscript(fp);
  if (Object.keys(r.found).length) console.error(`daidocs session_archiver: redacted ${summarize(r.found)} before storing`);
  // Dates travel with the text, so the caller never invents one ("now" is wrong for anything
  // converted after the fact).
  return { text: r.text, startedOn: r.startedOn, endedOn: r.endedOn, startedAt: r.startedAt, endedAt: r.endedAt };
}

function firstUserLine(text) {
  const m = text.match(/\[USER\]: (.{10,90})/);
  return m ? m[1].replace(/\s+/g, ' ').trim() : 'claude code session';
}

async function ingestOne(id, title, date, text, at) {
  // park it; the next session converts it free
  if (SUBSCRIPTION) return false;
  const [observer] = getProviders([OBSERVER_SPEC]);
  if (typeof observer.available === 'function' && !observer.available()) return false;
  let body = text;
  // keep head + tail of very long coding sessions
  if (countTokens(body) > CAP_TOKENS) {
    const parts = chunkText(body);
    const keep = []; let tok = 0;
    for (const p of [...parts.slice(0, 4), ...parts.slice(-4)]) { if (tok > CAP_TOKENS) break; keep.push(p); tok += countTokens(p); }
    body = keep.join('\n[... middle of session omitted from index; full text in _raw ...]\n');
  }
  const parts = countTokens(body) > 6000 ? chunkText(body) : [body];
  for (let i = 0; i < parts.length; i++) {
    const pid = parts.length > 1 ? `${id}_p${i + 1}` : id;
    const res = await daidocs.ingest({
      id: pid, sourceId: pid, title: parts.length > 1 ? `${title} (part ${i + 1}/${parts.length})` : title,
      type: 'chat', app: 'claude-code', capturedAt: date, raw: parts[i],
    }, observer);
    for (const f of res.files) {
      const p = path.join(STORE_DIR, f.path);
      if (f.path.startsWith('_index/')) fs.appendFileSync(p, attribute(f.path, f.content, pid, at));
      else fs.writeFileSync(p, f.content);
    }
    // The .dai raw: pointer names _raw/<engine id>, known only after ingest; write the
    // addressable copy now (the whole-session verbatim capture above survives a failed call).
    const daiOut = res.files.find(f => f.path.endsWith('.dai'));
    if (daiOut) {
      fs.writeFileSync(path.join(STORE_DIR, '_raw', path.basename(daiOut.path, '.dai')), parts[i]);
    }
  }
  return true;
}

async function archive(sessionId, transcriptPath, project) {
  const id = 'cc_' + String(sessionId).replace(/[^\w-]/g, '').slice(0, 24);
  if (!fs.existsSync(transcriptPath)) return 'no-transcript';
  const dates = renderTranscript(transcriptPath);
  const text = dates.text;
  if (countTokens(text) < MIN_TOKENS) return 'too-small';

  // Idempotency is on CONTENT, not the session id alone: SessionEnd fires on /clear too and
  // the session continues, so compare rendered vs last-indexed — identical = done, a strict
  // extension = index only the new turns, anything else = a fresh continuation.
  const rawPath = path.join(STORE_DIR, '_raw', id + '.txt');
  const metaPath = path.join(STORE_DIR, '_raw', id + '.meta.json');
  const pendingPath = path.join(STORE_DIR, '_pending', id + '.json');
  const hash = sha256(text);
  let meta = readJson(metaPath);
  const resuming = fs.existsSync(pendingPath);

  let body = text, seq = meta ? (meta.seq || 1) : 1, suffix = '';
  // The Stop hook writes the raw at every stop and save_memory advances a
  // saved mark inside the meta. Anything before that mark is already in the
  // index; only what came after it is this archiver's business.
  const savedLen = meta && Number(meta.savedLen || 0);
  if (savedLen > 0) {
    if (text.length <= savedLen) { if (fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath); clearUnconverted(STORE_DIR, id); return 'unchanged (already saved in session)'; }
    body = text.slice(savedLen);
    if (countTokens(body) < MIN_TOKENS) {
      fs.writeFileSync(rawPath, text);
      fs.writeFileSync(metaPath, JSON.stringify({ ...meta, hash, len: text.length, seq }));
      return 'unchanged (below the minimum)';
    }
    seq += 1; suffix = `_c${seq}`;
  } else if (meta && !resuming) {
    if (meta.hash === hash) return 'unchanged';
    const prev = fs.existsSync(rawPath) ? fs.readFileSync(rawPath, 'utf8') : '';
    if (prev && text.startsWith(prev)) {
      body = text.slice(prev.length);
      // grew, but not enough to be worth a call
      if (countTokens(body) < MIN_TOKENS) {
        fs.writeFileSync(rawPath, text);
        fs.writeFileSync(metaPath, JSON.stringify({ hash, len: text.length, seq }));
        return 'unchanged (below the minimum)';
      }
    }
    seq += 1;
    suffix = `_c${seq}`;
  }

  // lossless whole-session capture, keyless
  fs.writeFileSync(rawPath, text);
  const segId = id + suffix;
  // Date/time of the CONVERSATION, not the conversion: a first capture is dated when it
  // started, a continuation when its new turns were said. The full timestamp orders same-day
  // conversations (a drained backlog otherwise lands in processing order).
  const at = (suffix ? (dates.endedAt || dates.startedAt) : (dates.startedAt || dates.endedAt)) || new Date().toISOString();
  const date = (suffix ? (dates.endedOn || dates.startedOn) : (dates.startedOn || dates.endedOn))
    || new Date().toISOString().slice(0, 10);
  const title = (project ? `[${project}] ` : '') + 'Claude Code session: ' + firstUserLine(body)
    + (suffix ? ` (continued ${seq})` : '');

  const ok = await ingestOne(segId, title, date, body, at).catch(e => {
    // Only a real failure belongs in errors.log; parking on a subscription is intended.
    if (!SUBSCRIPTION) fs.appendFileSync(path.join(STORE_DIR, '_pending', 'errors.log'),
      `${new Date().toISOString()} ${segId}: ${e.message}\n`);
    return false;
  });
  if (!ok) {
    // Record WHERE the session happened (cwd), not just its name, so the backlog can be routed
    // back to its folder without searching the disk for a matching name.
    fs.writeFileSync(pendingPath, JSON.stringify({
      id, segId, title, date, at, hash, seq,
      project: project || null,
      cwd: SESSION_CWD || null,
      reason: SUBSCRIPTION ? 'subscription' : 'observer',
    }));
    // The part still to convert goes where the next session will read it. The
    // whole transcript is already in _raw/<id>.txt above.
    writeUnconverted(STORE_DIR, segId, body);
    if (SUBSCRIPTION) return 'saved; your next Claude session reads it, and converts it free with nothing billed';
    return observerReady()
      ? 'pending (observer call failed; raw saved, run --catch-up later)'
      : `pending (observer "${OBSERVER_SPEC}" unavailable; raw saved, run --catch-up later)`;
  }
  fs.writeFileSync(metaPath, JSON.stringify({ ...(meta || {}), hash, len: text.length, seq, savedLen: text.length, savedHash: hash }));
  if (resuming && fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath);
  clearUnconverted(STORE_DIR, segId); clearUnconverted(STORE_DIR, id);
  return suffix ? `indexed (continuation ${seq})` : 'indexed';
}

// ---------- entry ----------
if (process.argv.includes('--catch-up')) {
  const pend = fs.readdirSync(path.join(STORE_DIR, '_pending')).filter(f => f.endsWith('.json'));
  console.log(`${pend.length} pending sessions`);
  if (pend.length && SUBSCRIPTION) {
    // Draining via the API would bill for work the subscription covers, so say how to get it
    // free instead.
    console.log('');
    console.log('These convert for free inside a Claude session, on your subscription.');
    console.log('Open Claude Code here and say:');
    console.log('');
    console.log('    convert my pending daidocs sessions');
    console.log('');
    console.log('Nothing is billed and no API key is used. To convert them here through');
    console.log('the paid API instead, run this again with DAIDOCS_USE_API=1 set.');
  } else if (pend.length && !observerReady()) {
    console.log(`observer "${OBSERVER_SPEC}" is unavailable; set the API key it needs, or choose another model with DAIDOCS_OBSERVER`);
    process.exitCode = 1;
  } else {
    let done = 0, failed = 0;
    for (const f of pend) {
      const rec = JSON.parse(fs.readFileSync(path.join(STORE_DIR, '_pending', f), 'utf8'));
      const { id, title, date } = rec;
      const segId = rec.segId || id;
      // Older markers were written before continuations existed and point at
      // the whole-session capture; newer ones name the part still unindexed.
      const raw = rawFor(STORE_DIR, segId, id);
      if (!raw) { fs.unlinkSync(path.join(STORE_DIR, '_pending', f)); continue; }
      const body = fs.readFileSync(raw, 'utf8');
      const ok = await ingestOne(segId, title, date, body, at).catch(e => {
        fs.appendFileSync(path.join(STORE_DIR, '_pending', 'errors.log'), `${new Date().toISOString()} ${segId}: ${e.message}\n`);
        console.error(segId, e.message);
        return false;
      });
      if (ok) {
        fs.unlinkSync(path.join(STORE_DIR, '_pending', f));
        clearUnconverted(STORE_DIR, segId); if (id !== segId) clearUnconverted(STORE_DIR, id);
        const metaPath = path.join(STORE_DIR, '_raw', id + '.meta.json');
        const whole = path.join(STORE_DIR, '_raw', id + '.txt');
        if (fs.existsSync(whole)) fs.writeFileSync(metaPath, JSON.stringify({ hash: rec.hash || sha256(fs.readFileSync(whole, 'utf8')), len: body.length, seq: rec.seq || 1 }));
        done++; console.log('indexed', segId);
      } else if (!observerReady()) {
        console.log('still pending', segId, '(observer became unavailable; stopping)');
        break;
      } else {
        // One bad document should not strand the rest of the queue.
        failed++; console.log('still pending', segId, '(this one failed; continuing)');
      }
    }
    console.log(`${done} indexed, ${failed} failed, ${pend.length - done - failed} untouched`);
  }
} else if (process.env.DAIDOCS_DISABLE) {
  console.error('daidocs session_archiver: skipped (DAIDOCS_DISABLE is set)');
} else {
  // hook mode: JSON on stdin
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let j = {}; try { j = JSON.parse(input); } catch { }
  const transcriptPath = j.transcript_path || process.argv[2];
  const sessionId = j.session_id || (transcriptPath ? path.basename(transcriptPath, '.jsonl') : null);
  if (!transcriptPath || !sessionId) { console.error('session_archiver: no transcript_path'); process.exit(0); }
  // tag the memory with its project so recall can scope to one project
  const project = projectName(j.cwd);
  // A locked or frozen project accepts nothing, and says so rather than failing
  // silently halfway through an append.
  const resolved = useStore(j.cwd);
  const w = S.canWrite(resolved);
  if (!w.ok) { console.error(`daidocs session_archiver: skipped, ${w.reason}`); process.exitCode = 0; }
  const result = await archive(sessionId, transcriptPath, project);
  console.error(`daidocs session_archiver: ${result} (${sessionId})`);
  // Set the code, not process.exit(): exiting while a failed request's socket is still
  // closing trips a libuv assertion on Windows.
  // never block session end
  process.exitCode = 0;
}
