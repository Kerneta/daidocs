#!/usr/bin/env node
// DaiDocs autosave: Claude Code Stop hook. The SessionEnd archiver runs detached and can
// only convert via a paid API; this closes the gap while the session is live by asking the
// assistant to save what was said, using itself as the extractor (no key, no cost, no
// backlog). At EVERY stop it writes the rendered transcript, so a killed terminal loses at
// most the last exchange; it only speaks up once the unconverted material is worth a memory.
// Env: DAIDOCS_STORE, DAIDOCS_DISABLE, DAIDOCS_AUTOSAVE_TOKENS (default 4000). Never blocks
// or loops: on any error prints nothing and exits 0.

import { createRequire } from 'module';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const { countTokens } = require('./lib/tokens');
const { projectName, renderClaudeTranscript } = require('./lib/convert');
const { pendingFor, readJson, writeUnconverted, autoDeclare } = require('./lib/session_marks');
const S = require('./lib/stores');

const THRESHOLD = parseInt(process.env.DAIDOCS_AUTOSAVE_TOKENS || '4000', 10);
// Cost reminder cadence: per-question cost scales with total context size, so
// once the conversation crosses each of these bands (default 50k tokens) we nudge
// the user once to start a fresh window and let recall_memory rehydrate. Set
// DAIDOCS_COST_REMINDER_DISABLE to turn it off, or the token count to retune it.
const COST_REMIND_EVERY = parseInt(process.env.DAIDOCS_COST_REMINDER_TOKENS || '50000', 10);
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

function readStdin() {
  return new Promise(res => {
    let input = '';
    const done = () => res(input);
    process.stdin.on('data', c => input += c);
    process.stdin.on('end', done);
    process.stdin.on('error', done);
    setTimeout(done, 2000).unref();
  });
}

const firstUserLine = text => {
  const m = /\[USER\]:\s*(.+)/.exec(text);
  return (m ? m[1] : text).replace(/\s+/g, ' ').trim().slice(0, 80);
};

// A lower-bound estimate of the live context size, for the cost reminder. Sums
// the tokens of every message's text, tool inputs and tool results (images
// skipped). renderClaudeTranscript strips tool blocks, so its token count badly
// undercounts a tool-heavy session; the cost the reminder cares about is driven
// by exactly those tool results, so they are counted here. Never throws.
function contextTokens(tp) {
  const collect = c => {
    if (typeof c === 'string') return c;
    if (!Array.isArray(c)) return '';
    let s = '';
    for (const b of c) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && b.text) s += b.text + '\n';
      else if (b.type === 'thinking' && b.thinking) s += b.thinking + '\n';
      else if (b.type === 'tool_use' && b.input) s += JSON.stringify(b.input) + '\n';
      else if (b.type === 'tool_result') s += collect(b.content) + '\n';
    }
    return s;
  };
  try {
    let buf = '';
    for (const line of fs.readFileSync(tp, 'utf8').split('\n')) {
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const c = o.message && o.message.content;
      if (c) buf += collect(c) + '\n';
    }
    return countTokens(buf);
  } catch { return 0; }
}

async function main() {
  if (process.env.DAIDOCS_DISABLE) return;
  let j = {};
  try { j = JSON.parse(await readStdin()) || {}; } catch { return; }

  // The guard that makes this safe. When a Stop hook asks the assistant to
  // continue, the next Stop carries stop_hook_active, and prompting again there
  // would loop forever.
  if (j.stop_hook_active) return;

  const tp = j.transcript_path;
  if (!tp || !fs.existsSync(tp)) return;
  const id = 'cc_' + String(j.session_id || path.basename(tp, '.jsonl')).replace(/[^\w-]/g, '').slice(0, 24);

  const r = renderClaudeTranscript(tp);
  const text = r.text;
  if (!text) return;

  // Resolve the folder's store FIRST, so a declared folder finds what it wrote (not the
  // shared store's meta) and doesn't recount the whole transcript at each stop. autoDeclare
  // gives an undeclared folder its own store too, so a save never lands in the shared store.
  autoDeclare(j.cwd, S.resolveStore(j.cwd));
  const here = S.resolveStore(j.cwd);
  // locked or frozen: say nothing, write nothing
  if (!S.canWrite(here).ok) return;
  const STORE_DIR = here.storeDir;
  for (const d of ['_raw', '_pending', '_unconverted']) fs.mkdirSync(path.join(STORE_DIR, d), { recursive: true });
  const project = projectName(j.cwd);

  const rawPath = path.join(STORE_DIR, '_raw', id + '.txt');
  const metaPath = path.join(STORE_DIR, '_raw', id + '.meta.json');
  const pendingPath = path.join(STORE_DIR, '_pending', id + '.json');
  const hash = sha256(text);
  const meta = readJson(metaPath) || {};
  // nothing has changed since the last stop
  if (meta.hash === hash) return;

  // 1. The raw, every stop. Nothing is thrown away and nothing waits for a
  //    threshold: the text is in the folder from the first reply.
  fs.writeFileSync(rawPath, text);
  const at = r.endedAt || r.startedAt || new Date().toISOString();
  const date = r.startedOn || r.endedOn || at.slice(0, 10);

  // 2. What's new is measured from the saved mark (advanced by save_memory when given the
  //    session id), not from the last raw write, so a save isn't re-requested every reply.
  const savedLen = Number(meta.savedLen || 0);
  const fresh = savedLen > 0 ? (text.length > savedLen ? text.slice(savedLen) : '') : text;
  const newTokens = countTokens(fresh);
  // Per-question re-read cost scales with the live context size. Track which
  // band the context is in (costBand), persisted in the meta, so the reminder
  // fires once per band and never repeats within the same band.
  const totalTokens = countTokens(text);
  const ctxTokens = contextTokens(tp);
  const prevBand = Number(meta.costBand || 0);
  const costBand = COST_REMIND_EVERY > 0 ? Math.floor(ctxTokens / COST_REMIND_EVERY) : 0;
  const costReminderDue = !process.env.DAIDOCS_COST_REMINDER_DISABLE && costBand > prevBand && costBand >= 1;
  const folder = j.cwd || '(the current project folder)';
  const costReminderLine = costReminderDue
    ? `This session has grown large (about ${(costBand * COST_REMIND_EVERY).toLocaleString()}+ tokens of context). Per-question cost scales with context size, because the whole history is re-read every turn. Tell the user they can cut cost by starting fresh, and give them these steps:\n`
      + `  1. To save token usage, start a NEW session instead of continuing this one.\n`
      + `  2. Open it on this same folder so memory and recall work. Folder to copy and paste:\n`
      + `       ${folder}\n`
      + `  3. Then just ask to continue where you left off, and recall_memory will rehydrate the prior work from memory.\n`
      + `Relay these three steps to the user, with the folder path shown exactly.`
    : null;
  // The not-yet-converted tail, on its own, where the next session and any
  // recall can read it. Small by construction: it is at most what one save
  // would take. Gone the moment save_memory or the archiver indexes it.
  writeUnconverted(STORE_DIR, id, fresh);
  fs.writeFileSync(metaPath, JSON.stringify({
    hash, len: text.length, tokens: totalTokens, seq: meta.seq || 1,
    savedLen, savedHash: meta.savedHash || null, savedAt: meta.savedAt || null,
    cwd: j.cwd || null, project: project || null, at, live: true, costBand,
  }));

  // 3. The marker, while anything is unconverted, so the backlog line and the
  //    memory map see this session now rather than after it ends.
  if (newTokens > 0) {
    fs.writeFileSync(pendingPath, JSON.stringify({
      id, segId: id, title: (project ? `[${project}] ` : '') + 'Claude Code session: ' + firstUserLine(text),
      date, at, hash, seq: meta.seq || 1, project: project || null, cwd: j.cwd || null,
      tokens: newTokens, reason: 'live',
    }));
  } else if (fs.existsSync(pendingPath)) {
    fs.unlinkSync(pendingPath);
  }

  // 4. Earlier sessions from this folder that are still waiting count towards
  //    the bar. A 2k session yesterday and a 2.5k one today are one memory's
  //    worth, and they convert together rather than each sitting below the line.
  const carried = pendingFor(STORE_DIR, j.cwd, id);
  const carriedTokens = carried.reduce((a, c) => a + (c.tokens || 0), 0);
  if (newTokens + carriedTokens < THRESHOLD) {
    // Nothing needs saving yet, but a cost band was just crossed: nudge once anyway.
    if (costReminderLine) process.stdout.write(JSON.stringify({ decision: 'block',
      reason: `${costReminderLine}\n\nNothing else needs saving right now; relay the steps above to the user, then stop.` }));
    return;
  }

  // A Stop hook returns the assistant to work with this as its instruction.
  const reason = [
    `Before finishing: ${newTokens.toLocaleString()} tokens of this conversation are not yet in DaiDocs memory`
      + (carried.length ? `, and ${carried.length} earlier session${carried.length === 1 ? '' : 's'} from this folder ${carried.length === 1 ? 'is' : 'are'} waiting (${carriedTokens.toLocaleString()} tokens).` : '.'),
    '',
    'Call save_memory once for this conversation, with:',
    `  title:   a short description of what this session was about${project ? `, prefixed "[${project}] "` : ''}`,
    '  content: the conversation so far, as [USER]: / [ASSISTANT]: lines',
    '  understanding: the extraction, written by you',
    `  session: "${id}"`,
    '',
    'The session id is what stops this hook asking again: save_memory records',
    'how much of the transcript is saved, and only what comes after it counts.',
  ];
  if (carried.length) {
    reason.push('', 'Then convert the waiting sessions the same way, one save_memory call each,',
      'reading the text from the file named and passing that session id:');
    for (const c of carried.slice(0, 6)) {
      reason.push(`  ${c.segId}: ${c.raw || '(raw missing)'}${c.title ? '  (' + c.title.slice(0, 60) + ')' : ''}`);
    }
    if (carried.length > 6) reason.push(`  and ${carried.length - 6} more: node daidocs.js pending`);
    reason.push('', 'For a backlog this size, also tell the user it is best done in a NEW session so the reading does not inflate this one: they can start a fresh session in this folder and ask you to convert the backlog there.');
  }
  reason.push('',
    'Writing the understanding yourself means no observer model is called, so this',
    'costs nothing and needs no API key. The schema is in the save_memory tool',
    'description. Resolve any relative dates against today.',
    '',
    'Then tell the user in one line that the session was saved, and stop.');
  if (costReminderLine) reason.push('', costReminderLine);

  process.stdout.write(JSON.stringify({ decision: 'block', reason: reason.join('\n') }));
}

main().catch(e => { console.error(`daidocs session_autosave: ${e.message}`); }).finally(() => { process.exitCode = 0; });
