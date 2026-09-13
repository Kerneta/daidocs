#!/usr/bin/env node
// DaiDocs session context: Claude Code SessionStart hook. The archiver pushes sessions INTO
// the store at the end; nothing read them back at the start, so a fresh session opened with
// no memory in context. This injects zoom 1 (the manifest digest) and nothing more — pure
// file reads, no model call. Deeper zooms stay on demand through the MCP tools.
// Env: DAIDOCS_STORE, DAIDOCS_DISABLE, DAIDOCS_CONTEXT_ENTRIES (30),
// DAIDOCS_CONTEXT_MAX_CHARS (4000), DAIDOCS_UNCONVERTED_MAX_CHARS (6000). Never throws or
// blocks session start: on any failure prints nothing and exits 0.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const { projectName } = createRequire(import.meta.url)('./lib/convert');
const S = createRequire(import.meta.url)('./lib/stores');
const { subscriptionMode } = createRequire(import.meta.url)('./lib/host');
const { unconvertedFor, autoDeclare, folderNotice } = createRequire(import.meta.url)('./lib/session_marks');
let STORE_DIR = S.SHARED_STORE();

const MAX_ENTRIES = parseInt(process.env.DAIDOCS_CONTEXT_ENTRIES || '30', 10);
const MAX_CHARS = parseInt(process.env.DAIDOCS_CONTEXT_MAX_CHARS || '4000', 10);
// The unconverted tail has its own budget, outside the index cap. It is the
// most recent thing said in this folder and the one thing the index cannot
// yet answer about, so it is not something to trade away for a listing entry.
const UNCONV_MAX = parseInt(process.env.DAIDOCS_UNCONVERTED_MAX_CHARS || '6000', 10);

function readStdin() {
  return new Promise(res => {
    let input = '';
    // A SessionStart hook may be invoked with no stdin attached. Resolve on
    // end or error, never hang waiting for a payload that is not coming.
    const done = () => res(input);
    process.stdin.on('data', c => input += c);
    process.stdin.on('end', done);
    process.stdin.on('error', done);
    setTimeout(done, 2000).unref();
  });
}

function manifestEntries() {
  const fp = path.join(STORE_DIR, '_index', 'manifest.jsonl');
  if (!fs.existsSync(fp)) return [];
  const out = [];
  for (const line of fs.readFileSync(fp, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a partial write mid-append */ }
  }
  return out;
}

// The archiver tags every memory with "[<project>] " at the front of the
// title. Scope to the current project when anything matches, and say so when
// nothing does rather than silently dumping every project into the session.
function scope(entries, project) {
  if (!project) return { rows: entries, scoped: false };
  const tag = `[${project}]`;
  const mine = entries.filter(e => typeof e.title === 'string' && e.title.startsWith(tag));
  return mine.length ? { rows: mine, scoped: true } : { rows: entries, scoped: false };
}

function trim(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function backlog() {
  const dir = path.join(STORE_DIR, '_pending');
  if (!fs.existsSync(dir)) return { pending: 0, errors: 0 };
  const files = fs.readdirSync(dir);
  let errors = 0;
  const log = path.join(dir, 'errors.log');
  if (fs.existsSync(log)) errors = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).length;
  return { pending: files.filter(f => f.endsWith('.json')).length, errors };
}

// The backlog line, built on its own so an empty store can still carry it.
function backlogLine() {
  const { pending, errors } = backlog();
  if (!pending) return '';
  const n = `${pending} archived session${pending === 1 ? '' : 's'} ${pending === 1 ? 'is' : 'are'} captured but not yet indexed`;
  const it = pending === 1 ? 'it' : 'them';
  // On a subscription the backlog is not a fault to report, it is work waiting
  // for a session. Naming a failure count here, when those failures were API
  // calls the user never agreed to, reads as something broken.
  if (!subscriptionMode()) {
    return `Note: ${n}${errors ? `, and ${errors} ingest attempt${errors === 1 ? '' : 's'} failed` : ''}. Run "npm run catch-up" in the daidocs install to index them.`;
  }
  // This block is additionalContext: it reaches the ASSISTANT, never the screen, so address
  // the assistant directly rather than phrasing it as something "the user can say".
  return `ACTION FOR YOU: ${n}, so ${it} cannot be searched yet; the text of any from this folder is shown in full further down, and you can answer from it. Mention this in your first reply, briefly, and offer to convert ${it}. Converting costs nothing and uses no API key, because you write the extractions yourself. Say it once, then drop it: do not repeat the offer if the user declines or ignores it.`;
}

// What this folder said last, before conversion caught up. The text itself,
// verbatim, newest first, under its own budget, so the session that ended at
// 2k tokens is in front of the assistant when the next one opens here. Not
// searchable until converted, and the section says so once.
function unconvertedSection() {
  const items = unconvertedFor(STORE_DIR, CWD);
  if (!items.length) return '';
  const n = items.length;
  const lines = ['', '', `## Not yet converted, from this folder (${n} session${n === 1 ? '' : 's'})`,
    `The last session${n === 1 ? '' : 's'} here ended before conversion. The text is below, verbatim, so nothing said there is lost to you; it is not searchable until converted. Offer once to convert ${n === 1 ? 'it' : 'them'} with save_memory (session: "<id>"), which costs nothing, then drop it.`];
  let left = UNCONV_MAX;
  for (const u of items) {
    if (left <= 200) { lines.push(`- ${u.id} · ${u.date || 'undated'} · ${u.tokens} tokens · ${u.path}`); continue; }
    let text = '';
    try { text = fs.readFileSync(u.path, 'utf8'); } catch { continue; }
    const cut = text.length > left;
    lines.push('', `--- ${u.id} · ${u.date || 'undated'} · ${u.tokens} tokens ---`, cut ? text.slice(0, left) + `\n[... ${text.length - left} more chars in ${u.path}]` : text);
    left -= Math.min(text.length, left);
  }
  return lines.join('\n');
}

// Whether this folder has its own store, and the one question if not: per-project stores go
// unused unless asked for, so the assistant asks once and either answer is recorded ("here"
// declares the folder, "general" is written to the registry so it's never asked again).
// Never for the home folder, a drive root, or when DAIDOCS_STORE names a store explicitly.
let SHARED = true;
let CWD = null;
let RESOLVED = null;
// set when this session gave the folder its store
let DECLARED = null;
function declareLine() {
  return DECLARED ? 'FOR YOUR FIRST REPLY: ' + folderNotice(DECLARED.storeDir) : '';
}

function build(project) {
  const all = manifestEntries();
  // An empty manifest is the worst moment to go quiet: everything pending and nothing
  // searchable is exactly when the user thinks memory is running. Say so if there's a backlog.
  if (!all.length) {
    const ask = declareLine();
    const parts = [ask, ask ? '' : backlogLine()].filter(Boolean);
    const unconv = unconvertedSection();
    return (parts.length || unconv) ? `# DaiDocs memory index\n\nNo memories are indexed yet.\n\n${parts.join('\n\n')}${unconv}` : '';
  }
  const { rows, scoped } = scope(all, project);
  // Newest conversation first, by full timestamp where one was recorded.
  const whenOf = e => String(e.at || e.date || '');
  rows.sort((a, b) => whenOf(b).localeCompare(whenOf(a)));
  const shown = rows.slice(0, MAX_ENTRIES);

  const head = scoped
    ? `${rows.length} of ${all.length} stored memories are from this project (${project}).`
    : `${all.length} stored memories. None are tagged for this project, so this is everything, newest first.`;

  // The folder question goes FIRST: appended at the end it was read and ignored (the user's
  // first message won). At the top and alone it's the first thing the assistant sees.
  const ask = declareLine();
  const lines = [
    '# DaiDocs memory index',
    '',
    ...(ask ? [ask, ''] : []),
    head,
    'This is zoom 1: ids, dates and summaries only. Do not ask the user about anything listed here as though it were new.',
    'To go deeper, call recall_memory(question) for assembled context, or read_memory(id) for one file in full. Never read a whole .dai yourself.',
    '',
  ];
  for (const e of shown) {
    lines.push(`- ${e.id} · ${e.date || 'undated'} · ${trim(e.title, 70)} :: ${trim(e.summary, 110)}`);
  }
  if (rows.length > shown.length) lines.push(`- (${rows.length - shown.length} older memories not listed; recall_memory searches all of them)`);

  // Action lines are appended AFTER truncation: truncation trims from the end, so otherwise
  // the backlog offer and declare nudge were cut off in exactly the stores long enough to
  // need them. A listing entry is worth dropping to keep an instruction, not the reverse.
  // One ask per session start: while the folder question is pending, the backlog offer waits.
  const tail = [ask ? '' : backlogLine()].filter(Boolean);
  const tailText = tail.length ? '\n\n' + tail.join('\n\n') : '';
  const budget = MAX_CHARS - tailText.length;

  let text = lines.join('\n');
  if (text.length > budget) text = text.slice(0, Math.max(0, budget - 40)).replace(/\n[^\n]*$/, '') + '\n- (index truncated to fit the context budget)';
  // After the tail and outside its budget: the index can be cut, this cannot.
  return text + tailText + unconvertedSection();
}

async function main() {
  if (process.env.DAIDOCS_DISABLE) return;
  let j = {};
  try { j = JSON.parse(await readStdin()) || {}; } catch { j = {}; }
  const project = projectName(j.cwd);
  // Before anything is read: an undeclared folder becomes a project now, so
  // this session already writes into it rather than into the shared store.
  DECLARED = autoDeclare(j.cwd, S.resolveStore(j.cwd));
  const resolved = S.resolveStore(j.cwd);
  STORE_DIR = resolved.storeDir;
  SHARED = !resolved.config;
  RESOLVED = resolved;
  CWD = j.cwd || null;
  const context = build(project);
  // empty store: inject nothing rather than a stub
  if (!context) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
  }));
}

main().catch(e => { console.error(`daidocs session_context: ${e.message}`); }).finally(() => { process.exitCode = 0; });
