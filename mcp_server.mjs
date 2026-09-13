#!/usr/bin/env node
// DaiDocs MCP server: plain-text AI memory over stdio (Claude Desktop / Claude Code).
//  - recall_memory runs the daidocs-v44n retrieval via a capture provider and returns the
//    assembled context to the CALLING model (no nested LLM call, no double cost).
//  - save_memory converts one conversation/document into one .dai file plus append-only
//    index rows; originals kept verbatim in _raw/.
// Env: OPENAI_API_KEY (observer + embeddings; recall degrades to lexical without it),
// DAIDOCS_STORE (default ~/DaiDocs), DAIDOCS_OBSERVER (default openai:gpt-4.1-mini).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
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
const { redact, summarize } = require('./lib/redact');
const { attribute } = require('./lib/convert');
const { resolveObserver, subscriptionMode } = require('./lib/host');
const { needsKey } = require('./lib/observers');
const S = require('./lib/stores');
const { markSaved, unconvertedFor } = require('./lib/session_marks');
const Reg = require('./lib/registry');

// Resolved per call, not once at startup: one server serves every project, and
// each project may declare its own store. See lib/stores.js.
function currentStore() {
  const r = S.resolveStore(process.cwd());
  for (const d of ['_index', '_raw']) fs.mkdirSync(path.join(r.storeDir, d), { recursive: true });
  return r;
}

// store I/O: plain files, loaded fresh per call
function loadStore(dir) {
  const store = { files: {} };
  if (!fs.existsSync(dir)) return store;
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.dai')) store.files[f] = fs.readFileSync(path.join(dir, f), 'utf8');
  }
  const idx = path.join(dir, '_index');
  if (fs.existsSync(idx)) for (const f of fs.readdirSync(idx)) store.files['_index/' + f] = fs.readFileSync(path.join(idx, f), 'utf8');
  return store;
}

// Several stores read as one, with each file's origin remembered so the answer
// can say where its material came from.
function mergeStores(list) {
  const merged = { files: {} }, origin = {};
  for (const st of list) {
    const one = loadStore(st.storeDir);
    for (const [k, v] of Object.entries(one.files)) {
      if (k.startsWith('_index/')) merged.files[k] = (merged.files[k] || '') + v;
      else { merged.files[k] = v; origin[k] = st.label; }
    }
  }
  return { store: merged, origin };
}
const manifestEntries = store => (store.files['_index/manifest.jsonl'] || '').trim().split('\n').filter(Boolean)
  .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

// Sessions captured but not yet indexed. _raw is lossless storage, not memory: nothing that
// answers a question reads it, so an unconverted session is safe but unfindable — hence
// every read reports the backlog rather than answering as if it weren't there.
function pendingCount(storeDir) {
  try { return fs.readdirSync(path.join(storeDir, '_pending')).filter(f => f.endsWith('.json')).length; }
  catch { return 0; }
}

// What's captured but not converted, appended to whatever a read would say. With `full`, the
// text itself up to a budget, so a question about a just-ended session is answerable.
function unconvertedBlock(stores, full) {
  const MAX = parseInt(process.env.DAIDOCS_UNCONVERTED_MAX_CHARS || '8000', 10);
  const items = [];
  for (const s of stores) for (const u of unconvertedFor(s.storeDir, null)) items.push(u);
  if (!items.length) return '';
  items.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const n = items.length;
  const lines = ['', '', `## Not yet converted (${n} session${n === 1 ? '' : 's'}, verbatim, small)`,
    `Captured but not indexed, so the retrieval above could not use ${n === 1 ? 'it' : 'them'}. `
    + `Convert with save_memory, passing session: "<id>", to make ${n === 1 ? 'it' : 'them'} searchable; it costs nothing.`];
  let left = MAX;
  for (const u of items) {
    if (!full || left <= 200) { lines.push(`- ${u.id} · ${u.date || 'undated'} · ${u.tokens} tokens · ${u.path}`); continue; }
    let text = '';
    try { text = fs.readFileSync(u.path, 'utf8'); } catch { continue; }
    const cut = text.length > left;
    lines.push('', `--- ${u.id} · ${u.date || 'undated'} · ${u.tokens} tokens ---`, cut ? text.slice(0, left) + `\n[... ${text.length - left} more chars in ${u.path}]` : text);
    left -= Math.min(text.length, left);
  }
  return lines.join('\n');
}

// One sentence, appended to whatever a read was going to say anyway.
function backlogNote(stores) {
  const n = stores.reduce((sum, s) => sum + pendingCount(s.storeDir), 0);
  if (!n) return '';
  return `\n\n${n} session${n === 1 ? '' : 's'} ${n === 1 ? 'is' : 'are'} captured but not yet indexed, so ${n === 1 ? 'it is' : 'they are'} not searchable yet and the answer above cannot draw on ${n === 1 ? 'it' : 'them'}. Tell the user, and offer to convert ${n === 1 ? 'it' : 'them'}: you write the extractions yourself, so it is free and uses no API key.`;
}

function chunkText(text, target = 3000) {
  const paras = String(text).split(/\n\s*\n/);
  const chunks = []; let cur = [], curTok = 0;
  for (const p of paras) {
    const t = countTokens(p);
    if (curTok + t > target && cur.length) { chunks.push(cur.join('\n\n')); cur = []; curTok = 0; }
    cur.push(p); curTok += t;
  }
  if (cur.length) chunks.push(cur.join('\n\n'));
  return chunks;
}

// text-shape normalization, measured: hard-wrapped sources cost ~16pp of
// recall accuracy (format-grid study); unwrap lines inside paragraphs
const unwrap = t => String(t).replace(/\r\n/g, '\n').split(/\n\n+/)
  .map(p => (/^\s*([-*#>]|\d+\.)/.test(p) ? p : p.replace(/\n(?![-*#>]|\d+\.)/g, ' '))).join('\n\n');

const server = new McpServer({ name: 'daidocs-mcp', version: VERSION });

server.tool(
  'recall_memory',
  'Retrieve relevant material from the user\'s .dai memory store for a question about their past conversations, documents, facts, preferences, or history. Returns assembled context: answer the user\'s question from it. Call this whenever the user references something from the past that is not in the current conversation. By default it reads only the current project store. If that has no memories, it says so and names any other stores reachable from here: ask the user before calling again with scope:"all", which searches those too. A store that needs permission is named; ask the user, then call again with allow or refuse, and the answer is remembered. If the user asks to include the main project (the project in the folder above this one) and it is not reachable yet, call declare_project with reads: ["self", "parent"] first, then recall again with scope:"all". Confidential stores are never included in a wider search.',
  {
    question: z.string().describe('The user\'s question, as specifically as possible'),
    scope: z.string().optional().describe('"project" (the default) = this folder\'s own store; "all" or "wider" = also every store this folder is allowed to read, its parts, a connected folder, the main project, asking once about any that need permission; or a collection/project name, e.g. "personal". When the user says to look in the main project too, use "all".'),
    allow: z.array(z.string()).optional().describe('Stores the user has just agreed may be read from here, by the label the permission question used. Recorded once, then never asked again for this folder.'),
    refuse: z.array(z.string()).optional().describe('Stores the user has just refused, by label. Recorded the same way.'),
  },
  async ({ question, scope, allow, refuse }) => {
    const here = currentStore();
    const candidates = S.readCandidates(here);
    // The user's answer to the permission question, recorded before the
    // partition below so this very call can proceed on it. Matching is by the
    // label the question showed, or the folder name, or the store path.
    const ruled = (names, state) => {
      for (const n of names || []) {
        const want = String(n).trim().toLowerCase();
        if (!want) continue;
        for (const c of candidates) {
          if (c.why === 'this project') continue;
          const keys = [c.label, path.basename(c.storeDir), c.storeDir].map(k => String(k || '').toLowerCase());
          if (keys.includes(want)) S.savePermission(c.storeDir, state);
        }
      }
    };
    ruled(allow, 'always');
    ruled(refuse, 'never');
    const { allowed, needsAsking, denied } = S.partitionByPermission(candidates);
    // A declared store that no longer resolves (a deleted folder takes its memory with it; a
    // path resolving back to this project is the signature of a deleted part). Saying so is
    // the difference between a smaller answer and a wrong one.
    const gone = candidates.missing || [];
    const goneNote = gone.length
      ? `\n\nNote: this project declares ${gone.length} store${gone.length === 1 ? '' : 's'} that no longer resolve${gone.length === 1 ? 's' : ''} to anything separate on disk (${gone.map(m => m.path).join(', ')}). If a folder was deleted, whatever it held went with it: a store lives inside its own folder and is not copied anywhere else. The answer above could not draw on ${gone.length === 1 ? 'it' : 'them'}. Tell the user, and offer to remove the stale entr${gone.length === 1 ? 'y' : 'ies'} from .daidocs/config.json.`
      : '';

    // Nothing widens silently. If this project has no memories of its own, the
    // caller is told what else exists and asked, rather than being handed other
    // projects' material without being told, or an empty answer with no reason.
    const mine = loadStore(here.storeDir);
    const wider = scope === 'all' || scope === 'wider';
    const useable = wider ? allowed : allowed.filter(a => a.why === 'this project');

    if (!manifestEntries(mine).length && !wider) {
      const others = [...needsAsking, ...allowed.filter(a => a.why !== 'this project')];
      const offer = others.length
        ? `

Other stores are reachable from here: ${others.map(o => `${o.label} (${o.why})`).join(', ')}.
Ask the user whether to search those too. If they agree, call recall_memory again with scope:"all". Their answer is remembered for this project.`
        : '';
      return { content: [{ type: 'text', text: `No memories for this project (${here.label}).${offer}${goneNote}${unconvertedBlock([here], true) || backlogNote([here])}` }] };
    }
    if (wider && needsAsking.length) {
      return { content: [{ type: 'text', text: `Permission needed before searching wider.

These stores have not been ruled on: ${needsAsking.map(o => `${o.label} (${o.why})`).join(', ')}.
Ask the user to allow or refuse each, then call recall_memory again with allow: [labels] or refuse: [labels]; the answer is remembered for this folder. Confidential stores are never included in a wider search at all.` }] };
    }

    const { store, origin } = mergeStores(useable);
    if (!manifestEntries(store).length) return { content: [{ type: 'text', text: `No memories in ${S.provenance(useable)}.${goneNote}${unconvertedBlock(useable, true) || backlogNote(useable)}` }] };
    const scoped = !wider;
    // capture provider: records the method's final prompt instead of calling an LLM
    let captured = null;
    const capture = { complete: async a => { captured = a; return ''; } };
    const r = await daidocs.answerMulti({ text: question }, store, capture, { noOutside: false });
    if (!captured) return { content: [{ type: 'text', text: 'Retrieval produced no context.' }] };
    // return the CONTEXT portion (between "CONTEXT:" and "QUESTION:") to the caller
    const m = captured.prompt.match(/CONTEXT:\n([\s\S]*)\n\nQUESTION:/);
    let ctx = m ? m[1] : captured.prompt;
    // MCP clients cap tool-result size, and the index scan grows with the
    // store (~130 tok/file). Keep the TAIL: the retrieved segments, facts
    // timeline, and anchors sit at the end; the front is the raw index scan.
    const MAX = parseInt(process.env.DAIDOCS_RECALL_MAX_CHARS || '20000', 10);
    if (ctx.length > MAX) {
      const head = ctx.slice(0, 1500);
      ctx = head + `\n[... index scan truncated (${ctx.length} chars total; store has grown), most relevant material below ...]\n` + ctx.slice(-(MAX - head.length - 120));
    }
    return {
      content: [{
        type: 'text',
        // The note rides on a successful read too: a partial-store answer reads as
        // complete, so a confident wrong answer is likelier here than on "no memories".
        text: `Retrieved from .dai memory (${r.kind || 'auto'} read, ${S.provenance(useable)}${scoped ? '' : ', widened on request'}, ${countTokens(ctx)} tokens, files: ${(r.pickedIds || []).join(', ') || 'index-level'}):\n\n${ctx}\n\n(Answer the user's question from the material above. Dates marked ~ are inferred from session dates.)${goneNote}${unconvertedBlock(useable, true) || backlogNote(useable)}`
      }]
    };
  }
);

server.tool(
  'save_memory',
  'Convert a conversation, note, or document into the user\'s permanent .dai memory store. Call when the user asks to remember something, or at the end of a conversation worth keeping. Pass the FULL text to preserve; it is stored losslessly (original kept verbatim) and indexed for later recall.',
  {
    title: z.string().describe('Short descriptive title, e.g. "chat about bike trip plans"'),
    content: z.string().describe('The full text to remember (conversation transcript, note, or document)'),
    date: z.string().optional().describe('ISO date YYYY-MM-DD the content is from (default: today)'),
    type: z.string().optional().describe('chat | note | doc (default: chat)'),
    collection: z.string().optional().describe('Optional collection name to file this under (e.g. "personal", "client-a"): recall can then scope to it'),
    session: z.string().optional().describe('The Claude Code session this content came from; the Stop hook supplies it. Records how much of that session is now saved, so the hook stops asking, and clears its backlog marker.'),
    understanding: z.object({}).passthrough().optional().describe('The extraction, if you write it yourself: {entities:{people,orgs,dates,amounts,places}, actions:[], facts:[{fact,date,kind:"event"|"attribute"|"preference"|"plan"}], events:[{date,cat,what}], preferences:[], tags:[], decisions:[], topics:[], summary, sentiment, open_questions:[]}. Resolve relative dates against the content date. Supplying this skips the observer entirely: no API key, no cost.'),
  },
  async ({ title, content, date, type, collection, understanding, session }) => {
    if (collection) title = `[${collection}] ${title}`;
    // The MCP client announces itself at the handshake, which is a better host
    // signal than the environment: it names the app actually calling us.
    const clientName = (server.server.getClientVersion && server.server.getClientVersion() || {}).name;

    // Two ways to get an Understanding. The engine only asks a "provider" for a JSON string,
    // so a caller that already read the conversation can supply its own extraction — free,
    // keyless, and the only route when the API has no credit. Otherwise the observer runs.
    let spec, observer;
    if (understanding) {
      spec = 'caller-supplied';
      observer = { id: 'inline', model: 'caller-supplied', live: false, available: () => true, complete: async () => JSON.stringify(understanding) };
    } else if (subscriptionMode(clientName) && needsKey(resolveObserver(clientName).spec)) {
      // On a subscription, don't spend API credit for a second model to re-read what the
      // caller already read — ask the caller to write the extraction instead.
      return { content: [{ type: 'text', text: 'save_memory: call this again with "understanding" filled in. You have read this conversation, so write the extraction yourself: it is free on the subscription, and no API key is used. The schema is in the description of this tool.' }], isError: true };
    } else {
      spec = resolveObserver(clientName).spec;
      [observer] = getProviders([spec]);
      if (typeof observer.available === 'function' && !observer.available()) return { content: [{ type: 'text', text: `save_memory: observer "${spec}" is not available. Set the matching API key (OPENAI_API_KEY / ANTHROPIC_API_KEY), point DAIDOCS_OBSERVER at a model whose key you have, or pass "understanding" and write the extraction yourself for free.` }], isError: true };
    }
    const when = (date || new Date().toISOString().slice(0, 10)).replace(/\//g, '-');
    // The id must be unique: a 40-char title slug alone collides when two same-day titles
    // share a prefix (the .dai is written by id, so the second save would overwrite the
    // first), so a short hash of the WHOLE title carries the uniqueness the slug can't.
    const slug = title.toLowerCase().replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'memory';
    const stamp = crypto.createHash('sha256').update(title + '|' + when).digest('hex').slice(0, 6);
    const baseId = `${slug}_${when.replace(/-/g, '')}_${stamp}`;
    // losslessness: verbatim original first, before any model call
    // Redact before the lossless copy is written, not after. Same reasoning as
    // the archiver: a credential in the conversation must never reach disk or
    // the observer API, and this is the last point where both are still ahead.
    const here = currentStore();
    const w = S.canWrite(here);
    if (!w.ok) return { content: [{ type: 'text', text: `save_memory: ${w.reason}` }], isError: true };
    const STORE_DIR = here.storeDir;
    const { text: safe, found } = redact(content);
    if (Object.keys(found).length) console.error(`daidocs save_memory: redacted ${summarize(found)} before storing`);
    fs.writeFileSync(path.join(STORE_DIR, '_raw', baseId + '.txt'), safe);
    const norm = unwrap(safe);
    const parts = (!understanding && countTokens(norm) > 6000) ? chunkText(norm) : [norm];
    const written = [];
    for (let i = 0; i < parts.length; i++) {
      const id = parts.length > 1 ? `${baseId}_p${i + 1}` : baseId;
      const res = await daidocs.ingest({
        id, sourceId: id, title: parts.length > 1 ? `${title} (part ${i + 1}/${parts.length})` : title,
        type: type || 'chat', app: 'mcp', capturedAt: when, raw: parts[i],
      }, observer);
      for (const f of res.files) {
        const p = path.join(STORE_DIR, f.path);
        if (f.path.startsWith('_index/')) fs.appendFileSync(p, attribute(f.path, f.content, id));
        else fs.writeFileSync(p, f.content);
      }
      // The .dai raw: pointer names _raw/<engine id>, known only after ingest, so write the
      // addressable copy now (the verbatim pre-write above already survives a failed extraction).
      const daiOut = res.files.find(f => f.path.endsWith('.dai'));
      if (daiOut) {
        fs.writeFileSync(path.join(STORE_DIR, '_raw', path.basename(daiOut.path, '.dai')), parts[i]);
      }
      written.push(id);
    }
    // Everything the Stop hook had captured for this session is now indexed.
    if (session) { try { markSaved(STORE_DIR, session); } catch { } }
    return { content: [{ type: 'text', text: `Saved to .dai memory: ${written.join(', ')} (${countTokens(norm)} tokens → indexed; original preserved in _raw/${baseId}.txt). Store: ${STORE_DIR}` }] };
  }
);

server.tool(
  'list_memories',
  'List what is in the user\'s .dai memory store (id, date, title, one-line summary per stored item).',
  {},
  async () => {
    const here = currentStore();
    const entries = manifestEntries(loadStore(here.storeDir));
    if (!entries.length) return { content: [{ type: 'text', text: 'The memory store is empty.' + (unconvertedBlock([here], false) || backlogNote([here])) }] };
    // Ordered by when the conversation happened, not when it was converted: the append-only
    // manifest's natural order is conversion order, so a drained backlog would look newest.
    // `at` is the full timestamp where present (same-day ordering); older rows fall back to date.
    const when = e => String(e.at || e.date || '');
    entries.sort((a, b) => when(b).localeCompare(when(a)));
    const lines = entries.map(e => `- ${e.id} · ${e.date} · ${e.title} :: ${(e.summary || '').slice(0, 100)}`);
    return { content: [{ type: 'text', text: `${entries.length} memor${entries.length === 1 ? 'y' : 'ies'} in ${here.label} (${here.storeDir}):\n${lines.join('\n')}${unconvertedBlock([here], false) || backlogNote([here])}` }] };
  }
);

server.tool(
  'read_memory',
  'Read one stored memory file in full (verbatim segments included) by its id from list_memories.',
  { id: z.string() },
  async ({ id }) => {
    const here = currentStore();
    const fp = path.join(here.storeDir, id.replace(/[^\w-]/g, '_') + '.dai');
    if (!fs.existsSync(fp)) return { content: [{ type: 'text', text: `No memory file ${id}.dai in the store.` }], isError: true };
    return { content: [{ type: 'text', text: fs.readFileSync(fp, 'utf8').slice(0, 50000) }] };
  }
);

// One deliberate summary sent UP to the parent store. A confidential part is never a read
// candidate for anyone (including its parent), so when reading down is refused by design the
// part decides what leaves, in a person's words. Not a digest — a readable parent gets a
// live one for free.
server.tool(
  'brief_parent',
  'Save a short, deliberate summary from this project up into its PARENT project store. Use this only when the user asks to tell the wider project something, and only for a project whose material the parent cannot read for itself (a confidential part). Everything else should be read live instead. Show the user the exact text and get their agreement before calling this: it copies material across a confidentiality boundary they set up on purpose.',
  {
    summary: z.string().describe('The text to record in the parent store. A few sentences at most, written for someone who cannot see this project. Say what changed and when, not how.'),
    date: z.string().optional().describe('ISO date YYYY-MM-DD (default: today)'),
  },
  async ({ summary, date }) => {
    const here = currentStore();
    if (!here.config) return { content: [{ type: 'text', text: 'brief_parent: this session is not inside a declared project, so there is no parent to brief. Declare the project first with setup.js --project <dir> --project-type <type>.' }], isError: true };
    const up = S.parentProject(here.config);
    if (!up) return { content: [{ type: 'text', text: `brief_parent: ${here.label} has no parent project above it. Nothing to brief.` }], isError: true };
    const w = S.canWrite({ ...up, rules: up.rules, type: up.type, label: up.label });
    if (!w.ok) return { content: [{ type: 'text', text: `brief_parent: ${w.reason}` }], isError: true };

    const when = (date || new Date().toISOString().slice(0, 10)).replace(/\//g, '-');
    const { text: safe, found } = redact(summary);
    if (Object.keys(found).length) console.error(`daidocs brief_parent: redacted ${summarize(found)} before storing`);
    const id = `brief_${here.label.toLowerCase().replace(/[^\w]+/g, '_').slice(0, 24)}_${when.replace(/-/g, '')}_${Date.now().toString(36).slice(-4)}`;
    for (const d of ['_index', '_raw']) fs.mkdirSync(path.join(up.storeDir, d), { recursive: true });
    fs.writeFileSync(path.join(up.storeDir, '_raw', id + '.txt'), safe);

    // Origin goes in both the title and the body (an unattributed brief in a parent store is noise).
    const title = `Brief from ${here.label}`;
    const body = `Brief from the ${here.label} project, ${when}. Written deliberately because ${here.label} is ${here.type} and this store cannot read it.\n\n${safe}`;
    const observer = { id: 'inline', model: 'caller-supplied', live: false, available: () => true,
      complete: async () => JSON.stringify({
        summary: safe.replace(/\s+/g, ' ').trim().slice(0, 400),
        entities: {}, actions: [], events: [], preferences: [], decisions: [], open_questions: [],
        facts: [{ fact: safe.replace(/\s+/g, ' ').trim().slice(0, 400), date: when, kind: 'event' }],
        topics: [here.label, 'brief'], tags: ['brief', here.label], sentiment: 'neutral',
      }) };
    const res = await daidocs.ingest({ id, sourceId: id, title, type: 'note', app: 'mcp', capturedAt: when, raw: body }, observer);
    for (const f of res.files) {
      const p = path.join(up.storeDir, f.path);
      if (f.path.startsWith('_index/')) fs.appendFileSync(p, attribute(f.path, f.content, id));
      else fs.writeFileSync(p, f.content);
    }
    const daiOut = res.files.find(f => f.path.endsWith('.dai'));
    if (daiOut) fs.writeFileSync(path.join(up.storeDir, '_raw', path.basename(daiOut.path, '.dai')), body);
    return { content: [{ type: 'text', text: `Brief recorded in ${up.label} (${up.storeDir}) as ${id}. ${here.label} itself stays unreadable from there.` }] };
  }
);

// Give this folder its own memory, from the conversation — the per-project store system is
// otherwise reachable only by a terminal command nobody runs.
server.tool(
  'declare_project',
  'Give the current folder its own memory store, separate from the shared one, with a folder type. Call this when the user asks to keep this project\'s memories separate, to make a folder confidential, or to set a folder type. Types: normal (writable, readable by projects you connect), confidential (never included in any wider search, not even by its parent), shared (the plain multi-project type), temporary (for testing; never becomes permanent memory), locked (read-only until unlocked), frozen (read-only for good), connected (linked to another project, agreed at both ends). Existing memories are NOT moved: this changes where new ones go, from the next session. Say which type you are using and why before calling.',
  {
    type: z.string().optional().describe('One of: normal, confidential, shared, temporary, locked, frozen, connected. Default normal.'),
    dir: z.string().optional().describe('Folder to declare. Defaults to the current one. Use this to declare a subfolder as its own part.'),
    store: z.string().optional().describe('Where the memories live. Pass "general" to record that this folder keeps its memory in the shared store: nothing is declared, and the session-start question is not asked again for it. Otherwise the default ".daidocs/store" inside the project. An absolute path keeps the project folder clean, at the cost of the memory no longer travelling with it.'),
    label: z.string().optional().describe('Name shown whenever this store\'s material is used. Defaults to the folder name.'),
    reads: z.array(z.string()).optional().describe('What this folder may read besides itself: "self", "parent" (the project in the folder above), "children" (every declared part one level down), "all" (the general store), or a path. Use ["self", "children"] when the user says the project has parts or wants one folder per part; ["self", "parent"] when a part should be able to read the main project. Calling again on a declared folder updates this and keeps everything else.'),
  },
  async ({ type, dir, store: storePath, label, reads }) => {
    const target = dir ? path.resolve(process.cwd(), dir) : process.cwd();
    // The other answer to the session-start question. Nothing is declared;
    // the choice is recorded so the folder is not asked again.
    if (String(storePath || '').trim().toLowerCase() === 'general') {
      Reg.recordFolder(target, 'general');
      // Removing the config (not just recording the preference) is what sends this folder to
      // the general store, since resolution finds a config first. Only the config goes;
      // whatever was saved here stays and comes back if the folder is declared again.
      const cfgPath = path.join(target, '.daidocs', 'config.json');
      let had = null;
      try {
        if (fs.existsSync(cfgPath)) { had = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); fs.unlinkSync(cfgPath); }
      } catch (_) { }
      const kept = had ? path.resolve(target, had.store || '.daidocs/store') : null;
      return { content: [{ type: 'text', text: [
        `Understood: memory from ${target} goes to the general store (${S.SHARED_STORE()}) from now on.`,
        ...(kept ? ['', `What was already saved in this folder is untouched, at ${kept}.`,
          'It is out of the way rather than gone: declare the folder again and it comes back.'] : []),
        '',
        'This folder will not be given its own store again. To change that later,',
        'call declare_project with a type, or run: node daidocs.js setup --project <name> --store here',
      ].join('\n') }] };
    }
    const r = S.declareProject(target, type || 'normal', storePath || null, label || null, reads || null);
    // a declared folder is no longer 'general'
    if (r.ok) Reg.forgetFolder(target);
    if (!r.ok) return { content: [{ type: 'text', text: `declare_project: ${r.reason}` }], isError: true };
    const lines = [
      `${r.existed ? 'Updated' : 'Declared'} ${r.label} as ${r.type}.`,
      `  folder  ${r.root}`,
      `  store   ${r.storeDir}`,
      `  id      ${r.id || '(none)'}`,
      `  reads   ${(r.reads || ['self']).join(', ')}`,
      '',
      'New memories from this folder go here from the next session. Existing ones stay',
      'in the shared store: declaring changes where memories go, it does not move them.',
    ];
    if (r.type === 'confidential') lines.push('', 'Confidential: no other project can read this store, including a parent.');
    if (r.type === 'temporary') lines.push('', 'Temporary: nothing saved here becomes permanent memory.');
    lines.push('', 'The whole .daidocs folder keeps itself out of git. To share a store, copy it, or use git add -f.');
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`daidocs-mcp ${VERSION} ready. Stores resolve per project; no project config means the shared store.`);
