'use strict';

// A tiny cross-process advisory lock for the shared append-only indexes (SK1). Four separate
// processes (the Stop hook, the SessionStart hook, the archiver and save_memory) can write one
// store at once, and a multi-kilobyte append is not atomic, so two writers could interleave a
// half-line into a .jsonl and break every later JSON.parse. These serialize index appends.
//
// The lock is a file created exclusively: a second writer spins briefly, breaks a stale lock
// (a crashed holder), and, rather than ever lose a write, gives up waiting after a timeout and
// proceeds. Losing the serialization in a rare pathological case is better than dropping a memory.

const fs = require('fs');
const path = require('path');

function sleep(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { const end = Date.now() + ms; while (Date.now() < end) { /* spin */ } }
}

function withLock(lockPath, fn, opts = {}) {
  const timeoutMs = opts.timeoutMs || 3000;
  const staleMs = opts.staleMs || 10000;
  try { fs.mkdirSync(path.dirname(lockPath), { recursive: true }); } catch { /* ignore */ }
  const deadline = Date.now() + timeoutMs;
  let fd = null;
  for (;;) {
    try { fd = fs.openSync(lockPath, 'wx'); break; }
    catch (e) {
      if (e.code !== 'EEXIST') { fd = null; break; } // an unlockable filesystem: proceed, never fail a write
      let broke = false;
      try { const st = fs.statSync(lockPath); if (Date.now() - st.mtimeMs > staleMs) { fs.unlinkSync(lockPath); broke = true; } }
      catch { broke = true; } // the lock vanished under us; retry immediately
      if (broke) continue;
      if (Date.now() > deadline) break; // held too long: proceed unlocked rather than drop the write
      sleep(20);
    }
  }
  try { return fn(); }
  finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } try { fs.unlinkSync(lockPath); } catch { /* ignore */ } } }
}

// Append a complete, newline-terminated record to an append-only index, under the file's lock, so
// the whole line lands atomically relative to other writers and a crash leaves only whole lines.
function appendIndex(filePath, content) {
  if (content == null || content === '') return;
  const text = /\n$/.test(content) ? content : content + '\n';
  withLock(filePath + '.lock', () => fs.appendFileSync(filePath, text));
}

module.exports = { withLock, appendIndex };
