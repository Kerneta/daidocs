#!/usr/bin/env node
// DaiDocs local capture server: the browser extension's landing strip.
//
// The extension cannot write files, so this small HTTP server does it for it,
// on localhost only. It is the browser analog of the Stop hook: the extension
// sends the FULL conversation text every few thousand tokens, and this server
// writes the same four files the hooks write, so the whole existing pipeline
// (convert, catch-up, recall, the memory map) picks browser chats up with no
// changes anywhere else:
//
//   _raw/<id>.txt           the rendered conversation, whole, rewritten each send
//   _raw/<id>.meta.json     hash, lengths, saved mark, origin
//   _unconverted/<id>.txt   the tail not yet converted to memory
//   _pending/<id>.json      marker while anything is unconverted
//
// Full-text-every-time is deliberate. Chunk appending drifts the moment the
// page re-renders, a message is edited, or a retry fires twice. Overwriting
// from the full text makes every send idempotent: same text, same hash, no-op.
// At 25k tokens a send is ~100KB over loopback, which costs nothing.
//
// No model is ever called here. Capture is keyless and lossless (minus secret
// redaction), exactly like the SessionEnd archiver. Conversion happens later,
// where it always does: a Claude Code session converts the backlog for free,
// or `node daidocs.js convert` / `npm run catch-up` with an observer key.
//
// Env: DAIDOCS_STORE          where captures land (default ~/DaiDocs)
//      DAIDOCS_CAPTURE_PORT   default 41100
//      DAIDOCS_CAPTURE_TOKEN  optional bearer token; unset means localhost trust
//
// Run: node capture_server.mjs           (or: npm run capture)

import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));

// Build the memory-map dashboard on demand, cached briefly. Runs the builder
// pointed at the current store so its vault matches, and returns the HTML.
let dashCache = { at: 0, html: '' };
function buildDashboard() {
  const now = Date.now();
  if (dashCache.html && now - dashCache.at < 15000) return dashCache.html;
  const builder = path.join(HERE, 'tools', 'dashboard', 'build_dashboard.mjs');
  const out = path.join(os.tmpdir(), 'daidocs-dashboard.html');
  // Do NOT set DAIDOCS_STORE here: that would make the current store the
  // dashboard's shared default and hide the real memory store. Pass the capture
  // store separately, only for vault defaulting.
  execFileSync(process.execPath, [builder, '--out', out], {
    env: { ...process.env, DAIDOCS_CAPTURE_STORE: STORE_DIR, DAIDOCS_CAPTURE_PORT: String(PORT), DAIDOCS_STORE: '' },
    stdio: 'ignore', timeout: 60000,
  });
  const html = fs.readFileSync(out, 'utf8');
  dashCache = { at: now, html };
  return html;
}
const { countTokens } = require('./lib/tokens');
const { redact, summarize } = require('./lib/redact');
const { writeUnconverted, readJson } = require('./lib/session_marks');
const { VERSION } = require('./lib/version');
const vault = require('./lib/vault_core');

const PORT = parseInt(process.env.DAIDOCS_CAPTURE_PORT || '41100', 10);
const TOKEN = process.env.DAIDOCS_CAPTURE_TOKEN || null;
const MAX_BODY = 2 * 1024 * 1024; // 2MB: ~500k tokens of text, far past any chat

// Store location is resolvable at runtime so the settings dropdown can change
// it: DAIDOCS_STORE env wins (for scripted/dev runs); otherwise a persisted
// config file chosen from the UI; otherwise the default ~/DaiDocs.
const CONFIG_PATH = path.join(os.homedir(), '.daidocs-capture.json');
function readConfig() { try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; } }
function writeConfig(c) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2)); }
function resolveStore() {
  if (process.env.DAIDOCS_STORE) return path.resolve(process.env.DAIDOCS_STORE);
  const c = readConfig();
  return path.resolve(c.store || path.join(os.homedir(), 'DaiDocs'));
}
let STORE_DIR = resolveStore();

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

// The vault reader page, served at /viewer. It asks for the vault password,
// posts it to /vault/read, and shows the decrypted originals. Plaintext is
// only ever held in this page's memory, never written to disk. Locking clears
// it. No em dashes in this string, per project rule.
const VIEWER_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DaiDocs Vault Reader</title><style>
:root{color-scheme:dark}
body{margin:0;background:#0b0b10;color:#e8e8ee;font:14px/1.5 system-ui,sans-serif}
header{padding:14px 18px;border-bottom:1px solid #23232c;display:flex;align-items:center;gap:12px}
header b{font-size:15px}
#lock{margin-left:auto}
button{font:inherit;padding:7px 13px;border-radius:8px;border:1px solid #3a3a46;background:#2a2a36;color:#e8e8ee;cursor:pointer}
button.primary{background:#16a34a;border-color:#16a34a;color:#06240f;font-weight:700}
.gate{max-width:420px;margin:12vh auto;padding:24px;background:#15151d;border-radius:14px;box-shadow:0 10px 40px rgba(0,0,0,.5)}
.gate h1{font-size:18px;margin:0 0 6px}
.gate p{color:#9a9aa8;margin:0 0 14px}
input[type=password]{width:100%;box-sizing:border-box;padding:10px 12px;font:inherit;border-radius:8px;border:1px solid #3a3a46;background:#0d0d13;color:#eee;margin-bottom:10px}
.err{color:#ff9d80;margin:8px 0 0}
main{display:none;height:calc(100vh - 52px)}
main.on{display:flex}
#list{width:320px;border-right:1px solid #23232c;overflow:auto;flex:0 0 auto}
.item{padding:9px 14px;border-bottom:1px solid #191921;cursor:pointer}
.item:hover{background:#1b1b24}
.item.sel{background:#16233f}
.item .f{color:#8aa0c8;font-size:12px}
.item .t{color:#ff9d80;font-size:11px}
#body{flex:1;overflow:auto;padding:16px 20px;white-space:pre-wrap;word-break:break-word}
.muted{color:#9a9aa8}
</style></head><body>
<header><b>DaiDocs Vault Reader</b><span class="muted" id="count"></span>
<button id="lock" style="display:none">Lock</button></header>
<div class="gate" id="gate">
  <h1>Vault is locked</h1>
  <p>Pick the folder whose vault you want, then enter that vault's password. Each folder has its own vault and password. Nothing is written to disk; locking clears everything.</p>
  <div style="margin:0 0 10px">
    <div class="muted" style="font-size:12px;margin-bottom:4px">Vault folder: <span id="target"></span></div>
    <div id="fs" style="max-height:150px;overflow:auto;border:1px solid #23232c;border-radius:8px;margin-bottom:8px"></div>
  </div>
  <input type="password" id="pw" placeholder="password for this folder's vault" autofocus>
  <button class="primary" id="open">Unlock and view</button>
  <div class="err" id="err"></div>
</div>
<main id="main"><div id="list"></div><div id="body" class="muted">Select a file on the left.</div></main>
<script>
let files=[]; let target=null;
const $=id=>document.getElementById(id);
async function loadFolders(pth){
  const cfg=await fetch('/config').then(x=>x.json()).catch(()=>null);
  if(!target) target=(cfg&&cfg.store)||null;
  const q = pth?('?path='+encodeURIComponent(pth)):(target?('?path='+encodeURIComponent(target)):'');
  const l=await fetch('/fs/list'+q).then(x=>x.json()).catch(()=>null);
  const fs=$('fs'); fs.innerHTML='';
  if(!l||!l.ok){ fs.innerHTML='<div class="item muted">cannot read folder</div>'; return; }
  target=l.path; $('target').textContent=l.path;
  const mk=(label,go)=>{ const d=document.createElement('div'); d.className='item'; d.textContent=label; d.onclick=go; fs.append(d); };
  if(l.parent) mk('.. (up one level)',()=>loadFolders(l.parent));
  l.dirs.forEach(n=>mk('\\uD83D\\uDCC1 '+n,()=>loadFolders((l.path.endsWith('\\\\')||l.path.endsWith('/'))?l.path+n:l.path+'\\\\'+n)));
  if(!l.dirs.length&&!l.parent) mk('(no subfolders)',()=>{});
}
async function unlock(){
  $('err').textContent='';
  const pw=$('pw').value; if(!pw){return;}
  $('open').disabled=true;$('open').textContent='Opening...';
  let r; try{ r=await fetch('/vault/read',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw,store:target})}).then(x=>x.json()); }
  catch(e){ r={ok:false,error:'server not reachable'}; }
  $('open').disabled=false;$('open').textContent='Unlock and view';
  if(!r||!r.ok){ $('err').textContent = r&&r.error==='wrong password' ? 'Wrong password.' : ('Could not open: '+((r&&r.error)||'error')); return; }
  files=r.files||[]; $('pw').value='';
  $('gate').style.display='none'; $('main').classList.add('on'); $('lock').style.display='';
  $('count').textContent = files.length+' file'+(files.length===1?'':'s')+' · '+(r.store||target||'');
  renderList();
}
function renderList(){
  const list=$('list'); list.innerHTML='';
  files.forEach((f,i)=>{
    const d=document.createElement('div'); d.className='item';
    d.innerHTML='<div class="f">'+esc(f.folder)+'</div><div>'+esc(f.name)+'</div>'+(f.tampered?'<div class="t">TAMPERED: cannot decrypt</div>':'');
    d.onclick=()=>{[...list.children].forEach(c=>c.classList.remove('sel'));d.classList.add('sel');show(i);};
    list.append(d);
  });
}
function show(i){
  const f=files[i]; const b=$('body');
  if(f.tampered){ b.className=''; b.style.color='#ff9d80'; b.textContent='This file could not be decrypted. It was changed or corrupted since it was written.'; return; }
  b.className=''; b.style.color=''; b.textContent=pretty(f.text);
}
function pretty(t){ try{ return (t||'').split('\\n').map(l=>{ if(!l.trim())return l; try{const o=JSON.parse(l);return JSON.stringify(o,null,2);}catch(_){return l;} }).join('\\n'); }catch(_){ return t||''; } }
function esc(s){ return (s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
function lock(){ files=[]; $('main').classList.remove('on'); $('lock').style.display='none'; $('gate').style.display=''; $('body').textContent='Select a file on the left.'; $('count').textContent=''; loadFolders(target); $('pw').focus(); }
$('open').onclick=unlock; $('pw').addEventListener('keydown',e=>{if(e.key==='Enter')unlock();}); $('lock').onclick=lock;
loadFolders();
</script></body></html>`;

// Site names arrive from the extension; anything unknown still captures, it
// just gets a generic code. Three letters keep the id inside cleanId's cap.
const SITE_CODES = { chatgpt: 'gpt', claude: 'cla', gemini: 'gem' };

// The id deliberately carries the cc_ prefix even though these are browser
// sessions, because lib/session_marks cleanId() prefixes cc_ onto anything
// else. With the prefix already there, save_memory's session marking, the
// pending marker, and the raw file all agree on one name. The bx marks it as
// a browser capture; _pending titles carry the human-readable site name.
function convId(site, conversationId) {
  const code = SITE_CODES[site] || 'web';
  return `cc_bx_${code}_${sha256(site + '|' + conversationId).slice(0, 8)}`;
}

const firstUserLine = text => {
  const m = /\[USER\]:\s*(.+)/.exec(text);
  return (m ? m[1] : text).replace(/\s+/g, ' ').trim().slice(0, 80);
};

function saveCapture(p) {
  const site = String(p.site || 'web').toLowerCase().replace(/[^a-z]/g, '').slice(0, 20) || 'web';
  const conversationId = String(p.conversationId || 'unknown').slice(0, 200);
  const clean = redact(String(p.text || ''));
  const text = clean.text;
  if (!text.trim()) return { ok: false, error: 'empty text' };

  const id = convId(site, conversationId);

  // Each chat site gets its own folder in the store: chat_chatgpt, chat_claude,
  // chat_perplexity, ... Its _raw/_unconverted/_pending live inside that folder,
  // so ChatGPT chats never mix with Claude or Perplexity chats.
  const base = path.join(STORE_DIR, 'chat_' + site);

  // Opt-in vault mode for chat captures: the whole conversation is stored
  // encrypted and nothing plaintext is written. Encrypted chats go to the
  // per-site vault folder too.
  if (p.vault === true) {
    if (!vault.isInitialized(STORE_DIR)) return { ok: false, error: 'vault not initialized: run node vault.mjs init' };
    vault.writeEncrypted(STORE_DIR, 'chat_' + site, id, text);
    return { ok: true, id, vaulted: true, folder: 'chat_' + site, tokens: countTokens(text) };
  }
  for (const d of ['_raw', '_pending', '_unconverted']) fs.mkdirSync(path.join(base, d), { recursive: true });

  const rawPath = path.join(base, '_raw', id + '.txt');
  const metaPath = path.join(base, '_raw', id + '.meta.json');
  const pendingPath = path.join(base, '_pending', id + '.json');

  const hash = sha256(text);
  const meta = readJson(metaPath) || {};
  if (meta.hash === hash) {
    // Same text as last time: a retry, or a send with nothing new. Idempotent.
    return { ok: true, id, unchanged: true, unsavedTokens: meta.tokens - Math.ceil((meta.savedLen || 0) / 4) };
  }
  // A conversation only ever grows. Shrinkage means a different page state
  // (collapsed branches, a cleared thread) and overwriting would lose captured
  // text, so the longer version is kept and the send is acknowledged as stale.
  if (meta.len && text.length < meta.len * 0.8) {
    return { ok: true, id, stale: true, keptLen: meta.len };
  }

  fs.writeFileSync(rawPath, text);
  const at = new Date().toISOString();
  const date = at.slice(0, 10);
  const savedLen = Number(meta.savedLen || 0);
  const fresh = savedLen > 0 ? (text.length > savedLen ? text.slice(savedLen) : '') : text;
  const newTokens = countTokens(fresh);
  writeUnconverted(base, id, fresh);

  fs.writeFileSync(metaPath, JSON.stringify({
    hash, len: text.length, tokens: countTokens(text), seq: meta.seq || 1,
    savedLen, savedHash: meta.savedHash || null, savedAt: meta.savedAt || null,
    cwd: null, project: 'browser-' + site, at, live: true,
    source: 'browser-extension', site, conversationId,
    title: String(p.title || '').slice(0, 200) || null,
    url: String(p.url || '').slice(0, 500) || null,
  }));

  if (newTokens > 0) {
    fs.writeFileSync(pendingPath, JSON.stringify({
      id, segId: id,
      title: `[${site}] ` + (String(p.title || '').trim().slice(0, 80) || firstUserLine(text)),
      date, at, hash, seq: meta.seq || 1, project: 'browser-' + site, cwd: null,
      tokens: newTokens, reason: 'browser',
    }));
  } else if (fs.existsSync(pendingPath)) {
    fs.unlinkSync(pendingPath);
  }

  const red = summarize(clean.found);
  if (red) console.error(`[capture] ${id}: redacted ${red}`);
  return { ok: true, id, folder: 'chat_' + site, tokens: countTokens(text), unsavedTokens: newTokens };
}

// ------------------------------------------------------- browse capture ----
// Browse history (X tweets, opted-in web pages) is a separate folder TYPE:
// _vault/browse_x/ and _vault/browse_web/, always encrypted, never mixed
// with chat history in _raw/. Entries arrive as batches and are stored as
// one encrypted JSONL file per batch.

// Server-side sensitive-host block, independent of the extension, so a client
// bug cannot leak a sensitive page into the store. Keep in step with
// extension/content/exclusions.js.
const SENSITIVE_KEYWORDS = ['bank', 'paypal', 'stripe', 'venmo', 'wise', 'revolut', 'coinbase', 'binance',
  'wellsfargo', 'chase', 'citi', 'hsbc', 'barclays', 'santander', 'amex', 'americanexpress', 'capitalone',
  'schwab', 'fidelity', 'vanguard', 'health', 'mychart', 'patient', 'medical', 'clinic', 'insurance', 'nhs',
  'webmail', 'login', 'signin', 'account', 'wallet', 'crypto'];
const SENSITIVE_EXACT = new Set(['mail.google.com', 'outlook.office.com', 'outlook.live.com', 'mail.yahoo.com',
  'mail.proton.me', 'proton.me', 'icloud.com', 'mail.aol.com', 'accounts.google.com',
  'login.microsoftonline.com', 'appleid.apple.com', '1password.com', 'my.1password.com', 'bitwarden.com',
  'vault.bitwarden.com', 'lastpass.com', 'dashlane.com', 'keepersecurity.com', 'gov.uk', 'irs.gov', 'ssa.gov',
  'login.gov', 'id.me']);
function hostIsSensitive(host) {
  const h = String(host || '').replace(/^www\./, '').toLowerCase();
  if (!h) return false;
  if (SENSITIVE_EXACT.has(h)) return true;
  return SENSITIVE_KEYWORDS.some(k => h.includes(k));
}

// Personal-number scrub, mirroring extension/content/browse.js, so the server
// stays an independent backstop: dashed SSNs, and Luhn-valid card numbers.
function luhnOk(digits) {
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d; alt = !alt;
  }
  return sum % 10 === 0;
}
function scrubPersonal(text) {
  if (!text) return text;
  text = text.replace(/\b(?:\d[ -]?){13,19}\b/g, m => {
    const digits = m.replace(/[ -]/g, '');
    return (digits.length >= 13 && digits.length <= 19 && luhnOk(digits)) ? '[CARD REDACTED]' : m;
  });
  return text.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[SSN REDACTED]');
}

function saveBrowse(p) {
  if (hostIsSensitive(p.host)) return { ok: false, error: 'host is on the sensitive-site exclusion list; not captured' };
  // A per-site store folder overrides the global store for this write. Ignored
  // when DAIDOCS_STORE pins the store via env.
  const store = (!process.env.DAIDOCS_STORE && p.store) ? path.resolve(String(p.store)) : STORE_DIR;
  const encrypt = p.vault === true;
  if (encrypt && !vault.isInitialized(store)) {
    return { ok: false, error: 'encryption is on but the vault is not initialized: set a vault password first' };
  }
  // Each platform stores in its own folder (browse_x, browse_youtube, ...).
  const kind = String(p.kind || 'web').toLowerCase().replace(/[^a-z]/g, '').slice(0, 20) || 'web';
  const entries = Array.isArray(p.entries) ? p.entries.slice(0, 500) : [];
  if (!entries.length) return { ok: false, error: 'no entries' };

  const lines = [];
  for (const e of entries) {
    const text = scrubPersonal(redact(String(e.text || '')).text);
    if (!text.trim()) continue;
    lines.push(JSON.stringify({
      id: String(e.id || '').slice(0, 300),
      url: String(e.url || '').slice(0, 500),
      title: String(e.title || '').slice(0, 200) || undefined,
      handle: String(e.handle || '').slice(0, 60) || undefined,
      name: String(e.name || '').slice(0, 80) || undefined,
      at: String(e.at || '').slice(0, 40) || undefined,
      seenAt: String(e.seenAt || '').slice(0, 40),
      host: String(p.host || '').slice(0, 100),
      text,
    }));
  }
  if (!lines.length) return { ok: false, error: 'no usable entries' };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const base = `${stamp}_${sha256(lines.join('\n')).slice(0, 8)}`;
  const payload = lines.join('\n');
  if (encrypt) {
    // Encrypted: goes in the vault, in its own browse folder.
    vault.writeEncrypted(store, 'browse_' + kind, base, payload);
    return { ok: true, stored: lines.length, folder: '_vault/browse_' + kind, encrypted: true, store };
  }
  // Plaintext: a plain browse folder under the store, separate from chats.
  const dir = path.join(store, 'browse_' + kind);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, base + '.jsonl'), payload);
  return { ok: true, stored: lines.length, folder: 'browse_' + kind, encrypted: false, store };
}

// ------------------------------------------------------------------ HTTP ----

// No cross-origin sharing. The extension talks to this server ONLY from its
// background service worker, which has a 127.0.0.1 host permission and so
// bypasses CORS entirely: it never reads these headers. The /viewer and
// /dashboard pages are served from this same origin, so their own fetches are
// same-origin too. Advertising Access-Control-Allow-Origin: * would let any web
// page you visit read responses from the local server, which is exactly what we
// do not want, so we advertise nothing. The cross-site guard below is the real
// enforcement; this just stops responses being shared.
const CORS = {};
const SELF_ORIGINS = [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`];
const send = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json', ...CORS });
  res.end(JSON.stringify(obj));
};

// Directory listing for the settings folder picker. Localhost only, same trust
// as the user. Returns subdirectories only, never file contents.
function listDir(target) {
  const dir = target ? path.resolve(target) : STORE_DIR;
  const parent = path.dirname(dir);
  const entries = [];
  // A brand-new store folder may not exist yet: create it so the picker never
  // errors on first use, then list it (empty).
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    try { if (fs.statSync(path.join(dir, name)).isDirectory()) entries.push(name); } catch {}
  }
  entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  return { ok: true, path: dir, parent: parent === dir ? null : parent, dirs: entries };
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

  // Cross-site guard. The extension's background worker sends either no Origin
  // (GETs) or its chrome-extension:// origin (POSTs), and the server's own
  // pages send this origin; command-line tools send no Origin. A normal web
  // page's fetch always carries its own http(s) Origin. So refuse any request
  // that arrives with an http(s) Origin that is not this server itself: that
  // stops a site you happen to be visiting from reaching the local server to
  // list your folders, change the store, or inject captures while it runs.
  const origin = String(req.headers.origin || '');
  if (origin && /^https?:\/\//i.test(origin) && !SELF_ORIGINS.includes(origin)) {
    return send(res, 403, { ok: false, error: 'cross-site request refused' });
  }
  // Host guard, against DNS rebinding: a page on attacker.com whose DNS is
  // rebound to 127.0.0.1 would reach us with Host: attacker.com. Legitimate
  // callers (the extension, the viewer/dashboard tabs, local tools) always use
  // 127.0.0.1 or localhost on this port. Anything else is refused.
  const host = String(req.headers.host || '').toLowerCase();
  const HOST_OK = new Set(['127.0.0.1:' + PORT, 'localhost:' + PORT, '127.0.0.1', 'localhost']);
  if (host && !HOST_OK.has(host)) {
    return send(res, 403, { ok: false, error: 'bad host' });
  }

  if (TOKEN) {
    const auth = String(req.headers.authorization || '');
    if (auth !== 'Bearer ' + TOKEN) return send(res, 401, { ok: false, error: 'bad token' });
  }

  STORE_DIR = resolveStore();   // pick up any store change from the settings UI
  const u = new URL(req.url, 'http://127.0.0.1');

  if (req.method === 'GET' && u.pathname === '/health') {
    // Report our own program folder and launcher path so the extension can
    // remember where DaiDocs lives and show the exact folder to launch from,
    // even later when the server is down.
    return send(res, 200, {
      ok: true, name: 'daidocs-capture', version: VERSION, store: STORE_DIR,
      dir: HERE, launcher: path.join(HERE, 'launcher', 'start-daidocs.bat'),
    });
  }

  if (req.method === 'GET' && u.pathname === '/config') {
    return send(res, 200, { ok: true, store: STORE_DIR, envLocked: !!process.env.DAIDOCS_STORE });
  }

  if (req.method === 'GET' && u.pathname === '/viewer') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...CORS });
    return res.end(VIEWER_HTML);
  }

  // The memory-map dashboard, built on demand and cached briefly. Vault access
  // lives here (lock badges + inline unlock), so the extension opens this.
  if (req.method === 'GET' && u.pathname === '/dashboard') {
    try {
      const html = buildDashboard();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...CORS });
      return res.end(html);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8', ...CORS });
      return res.end('<h1>Dashboard build failed</h1><pre>' + String(e && e.message || e).replace(/[<>&]/g, '') + '</pre>');
    }
  }

  if (req.method === 'GET' && u.pathname === '/fs/list') {
    try { return send(res, 200, listDir(u.searchParams.get('path'))); }
    catch (e) { return send(res, 400, { ok: false, error: e.message }); }
  }

  if (req.method === 'GET' && req.url === '/vault/status') {
    try { return send(res, 200, { ok: true, ...vault.status(STORE_DIR) }); }
    catch (e) { return send(res, 500, { ok: false, error: e.message }); }
  }

  if (req.method === 'POST') {
    let body = '';
    let over = false;
    req.on('data', c => {
      body += c;
      if (body.length > MAX_BODY && !over) { over = true; send(res, 413, { ok: false, error: 'too large' }); req.destroy(); }
    });
    req.on('end', () => {
      if (over) return;
      let p;
      try { p = body ? JSON.parse(body) : {}; } catch { return send(res, 400, { ok: false, error: 'bad json' }); }
      try {
        switch (u.pathname) {
          case '/capture': return send(res, 200, saveCapture(p));
          case '/browse':  return send(res, 200, saveBrowse(p));
          case '/config/store': {
            if (process.env.DAIDOCS_STORE) return send(res, 409, { ok: false, error: 'store is fixed by DAIDOCS_STORE env; unset it to change from here' });
            const dir = path.resolve(String(p.path || ''));
            if (!dir) return send(res, 400, { ok: false, error: 'no path' });
            fs.mkdirSync(dir, { recursive: true });
            fs.accessSync(dir, fs.constants.W_OK);
            const c = readConfig(); c.store = dir; writeConfig(c);
            STORE_DIR = resolveStore();
            return send(res, 200, { ok: true, store: STORE_DIR });
          }
          case '/fs/mkdir': {
            const base = path.resolve(String(p.path || STORE_DIR));
            const name = String(p.name || '').replace(/[\\/:*?"<>|]/g, '').trim();
            if (!name) return send(res, 400, { ok: false, error: 'invalid folder name' });
            const made = path.join(base, name);
            fs.mkdirSync(made, { recursive: true });
            return send(res, 200, { ok: true, path: made });
          }
          case '/vault/init': {
            try { vault.init(STORE_DIR, String(p.password || '')); return send(res, 200, { ok: true }); }
            catch (e) { return send(res, 400, { ok: false, error: e.message }); }
          }
          case '/vault/verify': {
            return send(res, 200, { ok: true, valid: vault.verify(STORE_DIR, String(p.password || '')) });
          }
          case '/vault/read': {
            // Optional per-folder vault: read a vault in any folder, not just
            // the current store, so the reader can browse between vaults.
            const rstore = p.store ? path.resolve(String(p.store)) : STORE_DIR;
            if (!vault.isInitialized(rstore)) return send(res, 400, { ok: false, error: 'no vault in this folder' });
            try { return send(res, 200, { ...vault.readAll(rstore, String(p.password || '')), store: rstore }); }
            catch (e) { return send(res, 401, { ok: false, error: e.message === 'wrong password' ? 'wrong password' : e.message }); }
          }
          default: return send(res, 404, { ok: false, error: 'not found' });
        }
      } catch (e) {
        console.error(`[${u.pathname}] error: ${e.message}`);
        return send(res, 500, { ok: false, error: e.message });
      }
    });
    return;
  }

  send(res, 404, { ok: false, error: 'not found' });
});

// Localhost only. Nothing here is meant to be reachable from another machine;
// the connector path (public HTTPS, auth, store selection) is a separate build.
server.listen(PORT, '127.0.0.1', () => {
  console.error(`daidocs-capture ${VERSION} on http://127.0.0.1:${PORT}`);
  console.error(`  store: ${STORE_DIR}`);
  console.error(`  auth:  ${TOKEN ? 'bearer token required' : 'none (localhost only)'}`);
});
