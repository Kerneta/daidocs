#!/usr/bin/env node
// DaiDocs one-command setup: automates every automatable step (MCP registration for Claude
// Desktop/Code and other clients, the SessionEnd/SessionStart/Stop hooks, the reading
// protocol, project declaration, the observer model and its key). Idempotent; backs up every
// file it touches as *.daidocs-bak. Keys are stored ONLY in the OS user environment, never
// in files. Installing over an existing install removes the old one first so two copies
// can't own the same hook; every install/upgrade/rollback/removal is appended to
// ~/.daidocs-installs.jsonl (which --restore does not delete). Run --status to see every
// switch and the command that changes it.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const readline = require('readline');

const V = require('./lib/versioning');
const OBS = require('./lib/observers');
const S = require('./lib/stores');

const HERE = __dirname;
const VERSION = V.packageVersion(HERE);
const argv = process.argv.slice(2);
const has = f => argv.includes('--' + f);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const ALL = has('all');
// A bare run configures everything; --ask brings back per-surface questions. Nothing is
// one-way: --status lists every switch, and --restore puts the machine back.
const ASK = has('ask');
const log = (s) => console.log('  ' + s);
const readJson = fp => { try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return {}; } };

// Undo. Setup edits files the user didn't create (Claude Desktop config, ~/.claude
// settings, CLAUDE.md), so every touched path is recorded here with whether it EXISTED
// beforehand — a .bak can't express that: a file we created from nothing is undone by
// deleting it, not restoring a backup.
const STATE_FILE = V.STATE_FILE;

function recordTouched(fp, existedBefore) {
  const state = readJson(STATE_FILE);
  state.touched = state.touched || {};
  // first record wins: it describes the pre-DaiDocs world, and a second run
  // must not overwrite that with the post-first-run state
  if (!(fp in state.touched)) state.touched[fp] = { existedBefore, at: new Date().toISOString() };
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (_) { }
}

const backup = fp => {
  const existed = fs.existsSync(fp);
  // only the FIRST backup is kept, so restore always returns the original file
  // rather than whatever the previous run left behind
  if (existed && !fs.existsSync(fp + '.daidocs-bak')) fs.copyFileSync(fp, fp + '.daidocs-bak');
  recordTouched(fp, existed);
};

function restoreAll() {
  const state = readJson(STATE_FILE);
  const touched = state.touched || {};
  const paths = Object.keys(touched);
  if (!paths.length) { log('Nothing to restore: no record of this machine being configured.'); return false; }
  let restored = 0, removed = 0;
  for (const fp of paths) {
    const bak = fp + '.daidocs-bak';
    if (fs.existsSync(bak)) {
      fs.copyFileSync(bak, fp);
      fs.unlinkSync(bak);
      log(`restored ${fp}`);
      restored++;
    } else if (!touched[fp].existedBefore && fs.existsSync(fp)) {
      // we created this file; putting things back means removing it
      fs.unlinkSync(fp);
      log(`removed ${fp} (did not exist before setup)`);
      removed++;
    } else {
      log(`left ${fp} alone (no backup found and it predates setup)`);
    }
  }
  try { fs.unlinkSync(STATE_FILE); } catch (_) { }
  log(`Restore complete: ${restored} file(s) put back, ${removed} removed.`);
  log('Your .dai store was NOT touched. Your memory is still in the store folder.');
  return true;
}

const NODE = process.execPath;
const SERVER = path.join(HERE, 'mcp_server.mjs');
const ARCHIVER = path.join(HERE, 'session_archiver.mjs');
const CONTEXT = path.join(HERE, 'session_context.mjs');
const AUTOSAVE = path.join(HERE, 'session_autosave.mjs');

function desktopConfigPath() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  return path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json');
}

function setupDesktop() {
  const fp = desktopConfigPath();
  if (!fs.existsSync(path.dirname(fp))) { log('Claude Desktop not detected (no config dir), skipped'); return false; }
  backup(fp);
  const cfg = readJson(fp);
  cfg.mcpServers = cfg.mcpServers || {};
  cfg.mcpServers['daidocs-mcp'] = { command: NODE, args: [SERVER] };
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(cfg, null, 2));
  log(`Claude Desktop: daidocs-mcp registered (${fp}). Restart Desktop to load`);
  return true;
}

// Register the MCP server for EVERY project (user-scope config). The hooks are global and
// fire in every folder, so the tool they call must be global too, not per-project.
function setupUserScopeMcp() {
  const fp = path.join(os.homedir(), '.claude.json');
  backup(fp);
  const cfg = readJson(fp);
  cfg.mcpServers = cfg.mcpServers || {};
  const before = JSON.stringify(cfg.mcpServers['daidocs-mcp'] || null);
  // Forward slashes survive every layer of quoting between here and the config.
  cfg.mcpServers['daidocs-mcp'] = { command: NODE, args: [SERVER.replace(/\\/g, '/')] };
  fs.writeFileSync(fp, JSON.stringify(cfg, null, 2));
  const changed = before !== JSON.stringify(cfg.mcpServers['daidocs-mcp']);
  log(`daidocs-mcp registered for every project (${fp})${changed ? '' : ', already current'}`);
  return true;
}

// Declare a project: its store, its type, and what it may read. Writes
// <project>/.daidocs/config.json and gives the folder its type icon.
function setupProject(projectDir, type, storePath) {
  const dir = projectDir || process.cwd();
  if (path.resolve(dir) === path.resolve(HERE)) {
    log('Refusing to make the install folder a project. Pass --project <your work folder>.');
    return false;
  }
  const cfgDir = path.join(dir, S.CONFIG_DIR);
  const fp = path.join(cfgDir, S.CONFIG_FILE);
  fs.mkdirSync(cfgDir, { recursive: true });
  backup(fp);
  const existing = readJson(fp);
  const cfg = { ...S.DEFAULT_CONFIG, ...existing, type: type || (existing && existing.type) || 'normal' };
  if (storePath) cfg.store = storePath;
  cfg.label = cfg.label || path.basename(dir);
  // A permanent id, assigned once, so a moved/renamed folder can be found again (the
  // registry records where it was last seen; a scan matches folder id to registry).
  const REG = require('./lib/registry');
  if (!cfg.id) cfg.id = REG.newId(dir);
  fs.writeFileSync(fp, JSON.stringify(cfg, null, 2) + '\n');
  REG.record({ id: cfg.id, label: cfg.label, type: cfg.type, root: dir,
    storeDir: path.isAbsolute(cfg.store) ? cfg.store : path.join(dir, cfg.store) });
  ignoreStoreInGit(cfgDir);
  warnAboutExposure(dir, cfgDir);
  fs.mkdirSync(path.isAbsolute(cfg.store) ? cfg.store : path.join(dir, cfg.store), { recursive: true });
  log(`Project declared in ${fp}: type ${cfg.type}, store ${cfg.store}`);
  setFolderIcon(dir, cfg.type);
  return true;
}

// Keep the store out of git without touching the project's own .gitignore. The store holds
// _raw verbatim transcripts, so a `git add -A` in a repo would push them; ignore the WHOLE
// .daidocs folder from inside so git never lists it. Sharing is deliberate (copy, or git add -f).
function ignoreStoreInGit(cfgDir) {
  const fp = path.join(cfgDir, '.gitignore');
  const body = '# Your memory lives here, and it is nobody else\'s business.\n'
    + '# This folder keeps itself out of git: the store, the config, all of it.\n'
    + '# To share a store anyway, copy it, or commit it with: git add -f\n'
    + '*\n';
  try {
    const cur = fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8') : '';
    if (cur.split('\n').some(l => l.trim() === '*')) return;
    // Replace the file an older version wrote; leave anything the user wrote.
    const oursAndStale = /^# The memory store holds verbatim transcripts/.test(cur)
      && cur.split('\n').filter(l => l.trim() && !l.trim().startsWith('#')).join() === 'store/';
    if (cur && !oursAndStale) return;
    fs.writeFileSync(fp, body);
    log('Wrote .daidocs/.gitignore so the memory folder is never committed.');
  } catch (e) { log(`Could not write .daidocs/.gitignore (${e.message}). Add "*" to it by hand.`); }
}

// The two things .gitignore can't do, checked at declaration: it doesn't untrack an
// already-committed store (silently useless), and it says nothing to OneDrive/Dropbox/backup
// agents. Neither is fixable here, so both are reported.
function warnAboutExposure(dir, cfgDir) {
  // Already tracked by git?
  try {
    const inRepo = execSync('git rev-parse --is-inside-work-tree', { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim() === 'true';
    if (inRepo) {
      const tracked = execSync('git ls-files -- .daidocs', { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString().split('\n').map(s => s.trim()).filter(Boolean)
        .filter(p => p.includes('/store/') || p.endsWith('/store'));
      if (tracked.length) {
        log('');
        log(`WARNING: ${tracked.length} store file${tracked.length === 1 ? ' is' : 's are'} ALREADY tracked by git.`);
        log('The new .gitignore does not untrack them: it only stops new ones being added.');
        log('These files hold verbatim transcripts. To stop tracking them:');
        log('    git rm -r --cached .daidocs/store');
        log('Anything already committed also lives in history, which needs a rewrite to remove.');
        log('');
      }
    }
  } catch { /* no git, or no repo here: nothing to warn about */ }

  // Somewhere that syncs to a cloud?
  const p = path.resolve(dir).replace(/\\/g, '/');
  const synced = [['OneDrive', /\/OneDrive/i], ['Dropbox', /\/Dropbox/i],
    ['Google Drive', /\/Google ?Drive/i], ['iCloud', /\/(Mobile Documents|iCloud)/i]]
    .find(([, re]) => re.test(p));
  if (synced) {
    log('');
    log(`Note: this folder looks like it is inside ${synced[0]}.`);
    log('A .gitignore says nothing to a sync client, so the store will be uploaded');
    log('like any other file. If that is not what you want, point the store somewhere');
    log('outside it:  --store "%USERPROFILE%\\DaiDocs\\<project>"');
    log('');
  }
}

// Windows marks a folder's icon with desktop.ini plus the system attribute.
// macOS and Linux use different mechanisms; rather than guess, they are skipped
// with a line saying so.
function setFolderIcon(dir, type) {
  const ico = path.join(HERE, 'assets', 'brand', 'folder-types', `dai-folder-${type}.ico`);
  if (process.platform !== 'win32') return log('Folder icons are Windows-only for now; skipped.');
  if (!fs.existsSync(ico)) return log(`No .ico yet for type "${type}" (SVGs are in assets/brand/folder-types); folder icon skipped.`);
  try {
    const ini = path.join(dir, 'desktop.ini');
    backup(ini);
    fs.writeFileSync(ini, `[.ShellClassInfo]
IconResource=${ico},0
`);
    execSync(`attrib +S "${dir}"`, { stdio: 'ignore' });
    execSync(`attrib +H +S "${ini}"`, { stdio: 'ignore' });
    log(`Folder icon set for type "${type}".`);
  } catch (e) { log(`Folder icon not set: ${e.message}`); }
}

function setupCode(projectDir) {
  const dir = projectDir || process.cwd();
  if (path.resolve(dir) === path.resolve(HERE)) {
    log('Refusing to write .mcp.json into the install folder. Pass --project <your work folder>.');
    return false;
  }
  const fp = path.join(dir, '.mcp.json');
  backup(fp);
  const cfg = readJson(fp);
  cfg.mcpServers = cfg.mcpServers || {};
  cfg.mcpServers['daidocs-mcp'] = { command: NODE, args: [SERVER] };
  fs.writeFileSync(fp, JSON.stringify(cfg, null, 2));
  log(`Claude Code: .mcp.json written in ${dir}. Approve "daidocs-mcp" on next session`);
  return true;
}

// MCP registration for non-Claude clients. Only write a config if the client's directory
// ALREADY EXISTS (a present dir means it's installed and the path is current); otherwise
// skip rather than leave dead config, and print a paste-ready snippet instead.
//
// `dir` says the client is installed, `fp` is the file to edit, `format` its shape.
// Anything else: --client generic --config <file> writes the mcpServers shape.
function otherMcpClients() {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const vscodeUser = process.platform === 'win32' ? path.join(appData, 'Code', 'User')
    : process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Code', 'User')
      : path.join(home, '.config', 'Code', 'User');
  const clineDir = path.join(vscodeUser, 'globalStorage', 'saoudrizwan.claude-dev', 'settings');
  return [
    { key: 'cursor', name: 'Cursor', dir: path.join(home, '.cursor'), fp: path.join(home, '.cursor', 'mcp.json'), format: 'mcpServers' },
    { key: 'windsurf', name: 'Windsurf', dir: path.join(home, '.codeium', 'windsurf'), fp: path.join(home, '.codeium', 'windsurf', 'mcp_config.json'), format: 'mcpServers' },
    { key: 'codex', name: 'Codex CLI', dir: path.join(home, '.codex'), fp: path.join(home, '.codex', 'config.toml'), format: 'toml' },
    { key: 'cline', name: 'Cline', dir: clineDir, fp: path.join(clineDir, 'cline_mcp_settings.json'), format: 'mcpServers' },
    { key: 'continue', name: 'Continue', dir: path.join(home, '.continue'), fp: path.join(home, '.continue', 'config.json'), format: 'mcpServers' },
    { key: 'zed', name: 'Zed', dir: path.join(home, '.config', 'zed'), fp: path.join(home, '.config', 'zed', 'settings.json'), format: 'context_servers' },
  ];
}

// One client, one file. Returns a line saying what happened, and never throws
// on a client that is simply not installed.
function writeClient(c) {
  backup(c.fp);
  fs.mkdirSync(path.dirname(c.fp), { recursive: true });
  if (c.format === 'toml') {
    // Codex keeps its config in TOML. Only our own table is rewritten: the
    // rest of the file is left exactly as the user wrote it, because a config
    // parsed and re-emitted loses comments and ordering that are theirs.
    const block = ['[mcp_servers.daidocs-mcp]',
      `command = ${JSON.stringify(NODE)}`,
      `args = [${JSON.stringify(SERVER)}]`].join('\n');
    let text = '';
    try { text = fs.readFileSync(c.fp, 'utf8'); } catch { }
    const existing = /^\[mcp_servers\.daidocs-mcp\][^\[]*/m;
    text = existing.test(text) ? text.replace(existing, block + '\n')
      : (text.replace(/\s*$/, '') + (text.trim() ? '\n\n' : '') + block + '\n');
    fs.writeFileSync(c.fp, text);
  } else if (c.format === 'context_servers') {
    const cfg = readJson(c.fp);
    cfg.context_servers = cfg.context_servers || {};
    cfg.context_servers['daidocs-mcp'] = { source: 'custom', command: NODE, args: [SERVER] };
    fs.writeFileSync(c.fp, JSON.stringify(cfg, null, 2));
  } else {
    const cfg = readJson(c.fp);
    cfg.mcpServers = cfg.mcpServers || {};
    cfg.mcpServers['daidocs-mcp'] = { command: NODE, args: [SERVER] };
    fs.writeFileSync(c.fp, JSON.stringify(cfg, null, 2));
  }
  return c.fp;
}

// `--client <name>` for one client, `--client all` for every one detected,
// `--client list` to see the names. `--config <file>` writes to a path you
// name instead of a detected one, which is how a client nobody has taught
// this about still gets configured without anyone editing JSON by hand.
function setupOneClient(which, configPath) {
  const known = otherMcpClients();
  const name = String(which || '').trim().toLowerCase();
  if (name === 'list' || !name) {
    console.log('  Clients this can configure for you:\n');
    for (const c of known) {
      console.log(`    ${c.key.padEnd(9)} ${c.name.padEnd(12)} ${fs.existsSync(c.dir) ? 'detected' : 'not detected here'}`);
      console.log(`    ${' '.repeat(9)} ${c.fp}`);
    }
    console.log('\n  node setup.js --client <name>            configure that one');
    console.log('  node setup.js --client all              every one detected');
    console.log('  node setup.js --client generic --config <file>');
    console.log('                                          any other client, at a path you name\n');
    return true;
  }
  if (name === 'all') return setupOtherClients();
  if (name === 'generic' || configPath) {
    if (!configPath) { log('--client generic needs --config <file>: the path of that client\'s MCP config.'); return false; }
    const fp = path.resolve(configPath);
    const format = /\.toml$/i.test(fp) ? 'toml' : 'mcpServers';
    writeClient({ name: 'that client', fp, format });
    log(`daidocs-mcp registered (${fp}). Restart the client to load it.`);
    return true;
  }
  const c = known.find(k => k.key === name);
  if (!c) {
    log(`"${which}" is not a client this knows. Try: ${known.map(k => k.key).join(', ')}, or --client generic --config <file>.`);
    return false;
  }
  if (!configPath && !fs.existsSync(c.dir)) {
    log(`${c.name} is not installed here (${c.dir} does not exist).`);
    log(`If it lives somewhere else: node setup.js --client generic --config <that client's config file>`);
    return false;
  }
  writeClient(configPath ? { ...c, fp: path.resolve(configPath) } : c);
  log(`${c.name}: daidocs-mcp registered (${configPath ? path.resolve(configPath) : c.fp}). Restart ${c.name} to load it.`);
  return true;
}

function setupOtherClients() {
  let done = 0, absent = [];
  for (const c of otherMcpClients()) {
    if (!fs.existsSync(c.dir)) { absent.push(c.key); continue; }
    writeClient(c);
    log(`${c.name}: daidocs-mcp registered (${c.fp}). Restart ${c.name} to load`);
    done++;
  }
  // clients not installed here get a per-client command rather than paste-it-yourself JSON
  if (absent.length) log(`Not installed here: ${absent.join(', ')}. If you add one later: node setup.js --client <name>`);
  log('Any other MCP client: node setup.js --client generic --config <that client\'s config file>');
  return done > 0;
}

// Register one Claude Code hook, replacing a stale entry from an older or moved install.
// Match on THIS install's PATH, not just the script name: a name match would report a moved
// install's hook as "already present" and never repoint it. Unrelated hooks are untouched.
function registerHook(event, scriptPath, scriptName, description) {
  const fp = path.join(os.homedir(), '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  backup(fp);
  const cfg = readJson(fp);
  cfg.hooks = cfg.hooks || {};
  const cmd = `"${NODE}" "${scriptPath}"`;
  const list = cfg.hooks[event] = cfg.hooks[event] || [];

  const refersToOurs = e => new RegExp(scriptName).test(JSON.stringify(e));
  const isThisInstall = e => JSON.stringify(e).includes(JSON.stringify(scriptPath).slice(1, -1));

  const correct = list.some(e => refersToOurs(e) && isThisInstall(e));
  const stale = list.filter(e => refersToOurs(e) && !isThisInstall(e));

  let action;
  if (correct) {
    action = 'already present';
  } else {
    for (const e of stale) list.splice(list.indexOf(e), 1);
    list.push({ hooks: [{ type: 'command', command: cmd }] });
    action = stale.length ? `repointed from ${stale.length} stale entr${stale.length === 1 ? 'y' : 'ies'}` : 'registered';
  }

  fs.writeFileSync(fp, JSON.stringify(cfg, null, 2));
  log(`${event} hook ${action} (${fp}): ${description}`);
  return true;
}

function setupHook() {
  return registerHook('SessionEnd', ARCHIVER, 'session_archiver', 'every Claude Code session saves itself');
}

// The other half of the loop. Without this, memory is written but never read
// back at the start of a session, so the assistant begins every conversation
// unaware that a store exists.
function setupContextHook() {
  return registerHook('SessionStart', CONTEXT, 'session_context', 'your memory index loads at the start of every session');
}

// Converting while the session is still live, using the assistant you are
// already talking to. The SessionEnd archiver cannot do that: it is a detached
// process, so its only route is a paid API call.
function setupAutosaveHook() {
  return registerHook('Stop', AUTOSAVE, 'session_autosave', 'sessions save themselves as you work, with no API key');
}

// The reading protocol: how to READ a store well once reachable. Registering the MCP server
// says the store EXISTS but not how to read it — whole-file reads cost ~15x the tokens of
// the three zooms, and an unrouted question type was the biggest source of wrong answers.
// Installed into ~/.claude/CLAUDE.md, marker-delimited so a re-run replaces the block and
// --unregister can lift it out.
const BLOCK_START = '<!-- BEGIN DAIDOCS READING PROTOCOL v1 -->';
const BLOCK_END = '<!-- END DAIDOCS READING PROTOCOL v1 -->';

function readingProtocol() {
  const fp = path.join(HERE, 'prompts', 'CLAUDE-MD-BLOCK.md');
  if (!fs.existsSync(fp)) return null;
  return fs.readFileSync(fp, 'utf8').trim();
}

// Where each assistant reads standing instructions: CLAUDE.md (Claude Code), AGENTS.md
// (Codex and others), GEMINI.md (Gemini CLI), .cursorrules (Cursor). All plain markdown, so
// a tool that reads none loses nothing.
function instructionTargets(projectDir) {
  const dir = projectDir || process.cwd();
  return [
    { fp: path.join(os.homedir(), '.claude', 'CLAUDE.md'), who: 'Claude Code (all projects)', global: true },
    { fp: path.join(dir, 'AGENTS.md'), who: 'Codex and other AGENTS.md readers' },
    { fp: path.join(dir, 'GEMINI.md'), who: 'Gemini CLI' },
    { fp: path.join(dir, '.cursorrules'), who: 'Cursor' },
  ];
}

function installAllInstructions(projectDir, undo) {
  if (projectDir && path.resolve(projectDir) === path.resolve(HERE)) {
    log('Refusing to write assistant instructions into the install folder. Pass --project <your work folder>.');
    return false;
  }
  let n = 0;
  for (const t of instructionTargets(projectDir)) {
    // Only create a project-level file if the user opted into this folder at all.
    // The global Claude one is always written; the rest land beside their project.
    if (installInstructions(t.fp, undo)) n++;
  }
  log(`Reading protocol ${undo ? 'removed from' : 'installed for'} ${n} target(s): Claude Code, Codex/AGENTS.md, Gemini CLI, Cursor.`);
  return n > 0;
}

function installInstructions(target, undo) {
  const block = readingProtocol();
  if (!block && !undo) { log('prompts/CLAUDE-MD-BLOCK.md not found, reading protocol skipped'); return false; }
  const fp = target || path.join(os.homedir(), '.claude', 'CLAUDE.md');
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  backup(fp);
  const existing = fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8') : '';
  const s = existing.indexOf(BLOCK_START);
  const e = existing.indexOf(BLOCK_END);
  // an older block (any version marker) is replaced wholesale, never appended to
  const stripped = (s >= 0 && e > s) ? existing.slice(0, s) + existing.slice(e + BLOCK_END.length) : existing;
  if (undo) {
    fs.writeFileSync(fp, stripped.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n');
    log(`Reading protocol removed from ${fp}`);
    return true;
  }
  const body = stripped.trimEnd();
  fs.writeFileSync(fp, (body ? body + '\n\n' : '') + block + '\n');
  log(`Reading protocol ${s >= 0 ? 'updated' : 'installed'} in ${fp}. Every Claude Code session now reads stores the efficient way`);
  return true;
}

// Keys, for whichever provider the user has. The observer is provider-neutral (anthropic,
// openai, gemini, ollama); the provider is inferred from the key's prefix (unambiguous
// across the three vendors), and --provider overrides it.
const PROVIDERS = {
  anthropic: { env: 'ANTHROPIC_API_KEY', observer: 'anthropic:claude-opus-5', test: k => k.startsWith('sk-ant-') },
  openai: { env: 'OPENAI_API_KEY', observer: 'openai:gpt-4.1-mini', test: k => /^sk-(proj-)?[A-Za-z0-9]/.test(k) },
  gemini: { env: 'GEMINI_API_KEY', observer: 'gemini:gemini-2.5-flash', test: k => k.startsWith('AIza') || k.startsWith('AQ.') },
};

function detectProvider(key, explicit) {
  if (explicit && PROVIDERS[explicit]) return explicit;
  // order matters: sk-ant- must be tested before the looser sk- rule
  for (const name of ['anthropic', 'gemini', 'openai']) if (PROVIDERS[name].test(key)) return name;
  return null;
}

// True when the user environment already holds a key for the provider this key
// belongs to. Reads the persisted value rather than process.env, because the
// point is to detect a saved key that the current shell may be shadowing.
function alreadyPersisted(key) {
  const name = detectProvider(key, null);
  if (!name) return false;
  const varName = PROVIDERS[name].env;
  try {
    if (process.platform === 'win32') {
      const out = execSync(`reg query HKCU\\Environment /v ${varName}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      return new RegExp(varName + '\\s+REG_\\w+\\s+\\S').test(out);
    }
    const prof = path.join(os.homedir(), process.env.SHELL && process.env.SHELL.includes('zsh') ? '.zshrc' : '.bashrc');
    return fs.existsSync(prof) && fs.readFileSync(prof, 'utf8').includes(`export ${varName}=`);
  } catch (_) { return false; }
}

// Persist env vars to the OS user environment so every terminal and hook sees them, not
// just the shell that ran setup — otherwise DAIDOCS_OBSERVER lives in one process and the
// archiver silently uses its default everywhere else.
function persistVars(vars) {
  const entries = Object.entries(vars).filter(([, v]) => v);
  if (!entries.length) return false;
  // Escape hatch for the test harness. setx and the shell profile are the one
  // part of setup that reaches outside the files we back up, so a test run must
  // be able to exercise this path without writing to a real user environment.
  if (process.env.DAIDOCS_NO_PERSIST) {
    log(`Would save: ${entries.map(([k]) => k).join(', ')} (DAIDOCS_NO_PERSIST is set, nothing written)`);
    return false;
  }
  if (process.platform === 'win32') {
    for (const [k, v] of entries) execSync(`setx ${k} "${v}"`, { stdio: 'ignore' });
    log(`Saved to your Windows user environment: ${entries.map(([k]) => k).join(', ')}. Open a new terminal, and restart your assistant, to pick them up.`);
  } else {
    const prof = path.join(os.homedir(), process.env.SHELL && process.env.SHELL.includes('zsh') ? '.zshrc' : '.bashrc');
    backup(prof);
    const existing = fs.existsSync(prof) ? fs.readFileSync(prof, 'utf8') : '';
    const fresh = entries.filter(([k]) => !existing.includes(`export ${k}=`));
    if (fresh.length) fs.appendFileSync(prof, `\n# DaiDocs memory\n` + fresh.map(([k, v]) => `export ${k}="${v}"`).join('\n') + '\n');
    log(`Exported in ${prof}: ${entries.map(([k]) => k).join(', ')}. Open a new shell.`);
  }
  return true;
}

function setupKey(key, observer, explicitProvider, extraVars = {}) {
  const name = detectProvider(key, explicitProvider);
  if (!name) {
    log('Could not tell which provider that key belongs to. Re-run with --provider openai|anthropic|gemini.');
    return false;
  }
  const p = PROVIDERS[name];
  observer = observer || p.observer;
  // A key for one provider paired with an observer from another is a 401 that
  // only shows up later, at ingest, as a session that quietly stays pending.
  const want = OBS.providerOf(observer);
  if (want && want !== name && OBS.needsKey(observer)) {
    log(`That looks like a ${name} key, but the observer is ${observer}. Set ${OBS.keyVarFor(observer)} as well, or pick a ${name} model.`);
  }
  persistVars({ [p.env]: key, DAIDOCS_OBSERVER: observer, ...extraVars });
  log(`${name} key stored as ${p.env}, observer ${observer}.`);
  return true;
}

// One shared readline interface for all questions. A per-question interface breaks on a
// pipe: closing one ends the stream, and readline emits lines faster than they're asked for,
// so a line arriving with no question pending was dropped and setup exited mid-install. Here
// every line is kept until asked for, and at end-of-input pending questions get "".
let rlShared = null;
// lines read but not yet asked for
const answered = [];
// questions asked but not yet answered
const waiting = [];
function initAsk() {
  if (rlShared) return;
  rlShared = readline.createInterface({ input: process.stdin, output: process.stdout });
  rlShared.on('line', l => { const w = waiting.shift(); if (w) w(l); else answered.push(l); });
  rlShared.on('close', () => { while (waiting.length) waiting.shift()(''); });
}
async function ask(q) {
  initAsk();
  process.stdout.write(q);
  if (answered.length) return String(answered.shift()).trim();
  return new Promise(r => waiting.push(v => r(String(v).trim())));
}
// An open interface holds the event loop, so a run cannot end without this.
function closeAsk() { if (rlShared) { rlShared.close(); rlShared = null; } }

// File-type registration: give .dai files our icon in the file manager. No cross-platform
// mechanism, so each OS branch is separate (all user-scope, idempotent, undone by
// --unregister); macOS is skipped (needs a real .app bundle). Affects THIS machine only.
const MIME = 'text/vnd.dai';

function assetPath(name) {
  return path.join(__dirname, 'assets', 'brand', name);
}

function registerFileType(undo) {
  // The file association lives in HKCU, which HOME/USERPROFILE don't redirect, so a test run
  // (which redirects those) could delete the real user's .dai association. DAIDOCS_NO_PERSIST
  // ("don't touch state outside this run") now covers the registry too.
  if (process.env.DAIDOCS_NO_PERSIST) {
    log(`Would ${undo ? 'remove' : 'register'} the .dai file association (DAIDOCS_NO_PERSIST is set, registry untouched).`);
    return;
  }
  try {
    if (process.platform === 'win32') return registerWindows(undo);
    if (process.platform === 'linux') return registerLinux(undo);
    log('Skipping .dai icon registration: macOS needs an app bundle, not yet shipped.');
  } catch (e) {
    // Never fail the install over a cosmetic step.
    log(`Could not register the .dai icon (${e.message}). Everything else still works.`);
  }
}

// Is the .dai association in place? Checked BEFORE an upgrade removes the old install (which
// takes the association with it), so a flag-driven upgrade can re-register it rather than
// silently strip the icon.
function fileTypeRegistered() {
  if (process.platform !== 'win32') return false;
  try { execSync('reg query "HKCU\\Software\\Classes\\.dai" /ve', { stdio: 'ignore' }); return true; }
  catch { return false; }
}

function registerWindows(undo) {
  const ico = assetPath('dai-file.ico');
  if (!undo && !fs.existsSync(ico)) return log('Skipping icon: dai-file.ico not found.');
  const reg = (args) => execSync(`reg ${args}`, { stdio: 'ignore' });
  if (undo) {
    try { reg('delete "HKCU\\Software\\Classes\\.dai" /f'); } catch (_) {}
    try { reg('delete "HKCU\\Software\\Classes\\DaiDocs.Document" /f'); } catch (_) {}
    log('Removed the .dai file association.');
  } else {
    reg(`add "HKCU\\Software\\Classes\\.dai" /ve /t REG_SZ /d "DaiDocs.Document" /f`);
    reg(`add "HKCU\\Software\\Classes\\.dai" /v "Content Type" /t REG_SZ /d "${MIME}" /f`);
    reg(`add "HKCU\\Software\\Classes\\.dai" /v "PerceivedType" /t REG_SZ /d "text" /f`);
    reg(`add "HKCU\\Software\\Classes\\DaiDocs.Document" /ve /t REG_SZ /d "DaiDocs memory document" /f`);
    reg(`add "HKCU\\Software\\Classes\\DaiDocs.Document\\DefaultIcon" /ve /t REG_SZ /d "${ico},0" /f`);
    // refresh the icon cache
    try { execSync('ie4uinit.exe -show', { stdio: 'ignore' }); } catch (_) {}
    log('Registered .dai with the DaiDocs icon (Explorer may need a restart).');
  }
}

function registerLinux(undo) {
  const home = os.homedir();
  const mimeDir = path.join(home, '.local', 'share', 'mime', 'packages');
  const iconDir = path.join(home, '.local', 'share', 'icons', 'hicolor', 'scalable', 'mimetypes');
  const mimeFile = path.join(mimeDir, 'daidocs.xml');
  const iconFile = path.join(iconDir, `${MIME.replace('/', '-')}.svg`);
  if (undo) {
    for (const f of [mimeFile, iconFile]) if (fs.existsSync(f)) fs.unlinkSync(f);
  } else {
    const svg = assetPath('dai-file.svg');
    if (!fs.existsSync(svg)) return log('Skipping icon: dai-file.svg not found.');
    fs.mkdirSync(mimeDir, { recursive: true });
    fs.mkdirSync(iconDir, { recursive: true });
    fs.writeFileSync(mimeFile, `<?xml version="1.0" encoding="UTF-8"?>
<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">
  <mime-type type="${MIME}">
    <comment>DaiDocs memory document</comment>
    <sub-class-of type="text/plain"/>
    <glob pattern="*.dai"/>
  </mime-type>
</mime-info>
`);
    fs.copyFileSync(svg, iconFile);
  }
  try { execSync(`update-mime-database "${path.join(home, '.local', 'share', 'mime')}"`, { stdio: 'ignore' }); } catch (_) {}
  try { execSync(`gtk-update-icon-cache -f -t "${path.join(home, '.local', 'share', 'icons', 'hicolor')}"`, { stdio: 'ignore' }); } catch (_) {}
  log(undo ? 'Removed the .dai file association.' : 'Registered .dai with the DaiDocs icon.');
}

// What's on now, and the command that changes each — the settings page, since install asks
// nothing.
function printStatus() {
  const home = os.homedir();
  const state = readJson(STATE_FILE);
  const claudeSettings = readJson(path.join(home, '.claude', 'settings.json'));
  const hookOn = ev => JSON.stringify((claudeSettings.hooks || {})[ev] || []).includes('daidocs');
  const desktopCfg = readJson(desktopConfigPath());
  const rows = [
    ['Claude Desktop', !!(desktopCfg.mcpServers || {})['daidocs-mcp'], 'node setup.js --desktop'],
    ['Session start: load the index', hookOn('SessionStart'), 'node setup.js --context'],
    ['Save as you work, every 4,000 tokens', hookOn('Stop'), 'node setup.js --autosave'],
    ['Save again when a session ends', hookOn('SessionEnd'), 'node setup.js --hook'],
    ['Reading protocol in CLAUDE.md', fs.existsSync(path.join(home, '.claude', 'CLAUDE.md'))
      && /DaiDocs|\.dai/.test(safeRead(path.join(home, '.claude', 'CLAUDE.md'))), 'node setup.js --instructions'],
    ['.dai file icon', fileTypeRegistered(), 'node setup.js --icon'],
  ];
  console.log('  What is on:\n');
  for (const [label, on, cmd] of rows) {
    console.log(`    ${(on ? 'on ' : 'off')}  ${label.padEnd(38)} ${cmd}`);
  }
  console.log('');
  for (const c of otherMcpClients()) {
    const cfgText = safeRead(c.fp);
    const on = cfgText.includes('daidocs-mcp');
    const detected = fs.existsSync(c.dir);
    console.log(`    ${(on ? 'on ' : 'off')}  ${(c.name + (detected ? '' : ' (not installed here)')).padEnd(38)} node setup.js --client ${c.key}`);
  }
  const H = require('./lib/host');
  const obs = H.resolveObserver(null);
  console.log('');
  console.log(`    Model that reads conversations in:    ${obs.spec}  (${obs.source})`);
  console.log('      change it:                          node setup.js --observer <provider:model>');
  console.log(`    Memory lives in:                      ${process.env.DAIDOCS_STORE || path.join(home, 'DaiDocs')}`);
  if (state.version) console.log(`    Installed:                            ${state.version} at ${state.installPath}`);
  console.log('');
  console.log('    Everything at once again:             node setup.js');
  console.log('    Choose each one yourself:             node setup.js --ask');
  console.log('    Undo the lot:                         node setup.js --restore');
  console.log('    Map of what you have stored:          npm run dashboard');
  console.log('');
}

const safeRead = fp => { try { return fs.readFileSync(fp, 'utf8'); } catch { return ''; } };

// Install dependencies ourselves. `npm run setup` fails on Windows because npm.ps1 is
// blocked by PowerShell's default execution policy; `node setup.js` isn't, and spawning npm
// from here runs npm.cmd, which the policy doesn't govern.
function ensureDependencies() {
  if (has('no-install')) return;
  // The one that matters: the MCP server cannot start without it.
  if (fs.existsSync(path.join(HERE, 'node_modules', '@modelcontextprotocol', 'sdk'))) return;
  log('Installing dependencies (first run only)...');
  const { spawnSync } = require('child_process');
  // npm's own JS entry point, run by this node — not `npm` (reaches npm.ps1) or `npm.cmd`
  // (node refuses to spawn .cmd since the 2024 arg-injection fix, EINVAL). Same npm either way.
  const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const args = ['install', '--no-audit', '--no-fund'];
  const r = fs.existsSync(cli)
    ? spawnSync(process.execPath, [cli, ...args], { cwd: HERE, stdio: 'inherit' })
    : spawnSync('npm', args, { cwd: HERE, stdio: 'inherit', shell: true });
  if (r.error || r.status !== 0) {
    log(`Could not install them automatically${r.error ? ` (${r.error.code})` : ''}. Run this once, then setup again:`);
    log('  npm install');
    log('Everything below still gets configured; the memory tools need those packages to run.');
  } else {
    log('Dependencies installed.');
  }
  console.log('');
}

(async () => {
  console.log(`\nDaiDocs setup ${VERSION}: plain-text AI memory you own.\n`);
  // Every surface flag belongs here: a flag missing from this list makes setup fall into
  // interactive mode and block on the first question, so the flag alone would do nothing.
  const anyFlag = ['desktop', 'code', 'hook', 'context', 'autosave', 'clients', 'instructions', 'icon',
    'observer', 'key', 'all', 'project', 'project-type', 'store'].some(has);
  // A bare run configures everything (EVERY); --ask restores the per-question flow.
  const EVERY = ALL || (!anyFlag && !ASK);

  // Declaring a folder type is not an install: falling through to the main flow would hit the
  // "remove previous install" branch and tear down the user's hooks/configs. So a
  // project-only run does exactly that one thing and stops.
  const projectOnly = (has('project') || has('project-type') || has('store'))
    && !['desktop', 'code', 'hook', 'context', 'autosave', 'clients', 'instructions', 'icon', 'observer', 'key', 'all'].some(has);
  if (projectOnly) {
    const ok = setupProject(opt('project', null), opt('project-type', null), opt('store', null));
    if (ok) {
      log('Nothing else was changed: your hooks, clients and observer are untouched.');
      log('New memories from this folder go to its own store from the next session.');
    }
    return;
  }

  if (has('version')) {
    const cur = V.currentInstall();
    console.log(`  this copy:  ${VERSION}  (${HERE})`);
    if (cur) console.log(`  installed:  ${cur.version}  (${cur.installPath})${cur.installedAt ? `, on ${cur.installedAt.slice(0, 10)}` : ''}`);
    else console.log('  installed:  nothing configured on this machine yet');
    return;
  }
  if (has('versions') || has('history')) {
    console.log('  Install history\n');
    console.log(V.formatHistory(V.readLedger()));
    console.log(`\n  Ledger: ${V.LEDGER_FILE}`);
    console.log('  To go back to an older version, get that copy of the source and run its');
    console.log('  setup.js. This install will be removed automatically first.');
    return;
  }

  if (has('restore')) {
    console.log('  Putting every file setup.js touched back the way it was.\n');
    const cur = V.currentInstall();
    registerFileType(true);
    const did = restoreAll();
    if (did && cur) V.recordEvent('uninstall', { version: cur.version, from: null, installPath: cur.installPath, observer: cur.observer });
    return;
  }
  if (has('unregister')) { registerFileType(true); installInstructions(null, true); return; }
  if (has('status') || has('settings')) { printStatus(); return; }
  if (has('client')) { setupOneClient(opt('client', 'list'), opt('config', null)); return; }

  // An older or relocated install is removed before the new one is written.
  // Two installs configuring the same Claude Desktop config and the same
  // ~/.claude/settings.json is how you end up with a hook pointing at a folder
  // that no longer exists, archiving nothing and reporting nothing.
  const previous = V.currentInstall();
  const action = previous && previous.legacy ? 'install' : V.classify(previous && previous.version, VERSION);
  let hadFileType = false;
  if (previous && previous.legacy) {
    // Installed before versioning existed, so we do not know where from.
    // Uninstalling on a guess could revert configuration belonging to this very
    // copy. Adopt it instead: overwrite the surfaces we are asked to configure,
    // and start the recorded history here.
    log(`Adopting an existing install that predates version tracking. History starts at ${VERSION}.`);
    console.log('');
  } else if (previous && (previous.version !== VERSION || previous.installPath !== HERE)) {
    console.log(`  Found ${previous.version} installed at ${previous.installPath}.`);
    console.log(`  Removing it before installing ${VERSION}${action === 'rollback' ? ' (this is a rollback to an older version)' : ''}.\n`);
    // Note it before it is taken away, so the new copy can put it back. The
    // association points at an .ico inside the OLD install folder, so it has to
    // be re-pointed rather than left alone.
    hadFileType = fileTypeRegistered();
    registerFileType(true);
    restoreAll();
    V.recordEvent('uninstall', { version: previous.version, from: null, installPath: previous.installPath, observer: previous.observer, reason: `replaced by ${VERSION}` });
    console.log('');
  }

  // The install folder must not BE the memory store. `git clone .../daidocs` from home makes
  // ~/daidocs, and the default store is ~/DaiDocs — one directory on Windows/macOS. Then the
  // source tree and every memory share a folder, and deleting the checkout deletes the memory.
  // Compared by inode where available, since case isn't the only way two paths collide.
  const sharedStore = S.SHARED_STORE();
  const samePlace = (a, b2) => {
    try {
      const x = fs.statSync(a), y = fs.statSync(b2);
      if (x.ino && x.ino === y.ino && x.dev === y.dev) return true;
    } catch (_) { }
    return path.resolve(a).toLowerCase() === path.resolve(b2).toLowerCase();
  };
  if (fs.existsSync(sharedStore) && samePlace(HERE, sharedStore)) {
    console.log('  This copy of DaiDocs is installed INSIDE its own memory store:');
    console.log(`    ${HERE}`);
    console.log('');
    console.log('  That happens when the clone is made from your home folder: git clone');
    console.log('  creates "daidocs" and the default store is "DaiDocs", which on Windows and');
    console.log('  macOS are the same folder. Left alone, your memories and this source tree');
    console.log('  share one directory, and deleting the checkout would delete the memories.');
    console.log('');
    console.log('  Nothing has been changed. Move the checkout somewhere of its own:');
    console.log('    cd ..');
    console.log('    git clone https://github.com/Kerneta/daidocs daidocs-app');
    console.log('    cd daidocs-app');
    console.log('    node setup.js');
    console.log('');
    console.log('  Your memory is safe and stays where it is. Only this checkout moves.');
    console.log('');
    process.exitCode = 1;
    return;
  }

  ensureDependencies();

  const surfaces = [];
  const did = (name, fn) => { try { fn(); surfaces.push(name); } catch (e) { log(`${name} failed: ${e.message}`); } };

  if (EVERY || has('desktop') || (ASK && (await ask('Configure Claude Desktop? [Y/n] ')).toLowerCase() !== 'n')) did('desktop', setupDesktop);
  if (EVERY || has('code') || (ASK && (await ask('Configure Claude Code in current folder? [Y/n] ')).toLowerCase() !== 'n')) did('code', () => setupCode(opt('project', null)));
  if (EVERY || has('hook') || (ASK && (await ask('Auto-archive every Claude Code session? [Y/n] ')).toLowerCase() !== 'n')) did('hook', setupHook);
  // Any hook implies the tools must exist everywhere the hook fires.
  if (EVERY || has('hook') || has('context') || has('autosave') || surfaces.includes('hook')) did('mcp-user', setupUserScopeMcp);
  if (EVERY || has('context') || (ASK && (await ask('Load your memory index at the start of every session? [Y/n] ')).toLowerCase() !== 'n')) did('context', setupContextHook);
  if (EVERY || has('autosave') || (ASK && (await ask('Save each session to memory as you work, using this assistant and no API key? [Y/n] ')).toLowerCase() !== 'n')) did('autosave', setupAutosaveHook);
  if (EVERY || has('clients') || (ASK && (await ask('Configure other MCP clients (Cursor, Windsurf)? [Y/n] ')).toLowerCase() !== 'n')) did('clients', setupOtherClients);
  // default yes: without it an assistant can reach the store but reads it the expensive way
  if (EVERY || has('instructions') || (ASK && (await ask('Teach your assistants how to read your store efficiently? [Y/n] ')).toLowerCase() !== 'n')) did('instructions', () => installAllInstructions(opt('project', null), false));
  // Interactive setup offers per-project store declaration; otherwise the whole feature is
  // reachable only by reading the source, so every install writes to the one shared store.
  let ptype = opt('project-type', null);
  let pstore = opt('store', null);
  if (!ptype && !pstore && ASK) {
    const target = opt('project', null) || process.cwd();
    if (path.resolve(target) !== path.resolve(HERE)) {
      console.log('');
      console.log(`  A project can keep its memories in its own folder instead of the shared store,`);
      console.log(`  which is what keeps separate clients' work apart. This would declare:`);
      console.log(`    ${target}`);
      console.log('');
      console.log('    1. normal        writable, and readable by projects you connect to it');
      console.log('    2. confidential  never included in any wider search, whoever asks');
      console.log('    3. shared        the multi-project default');
      console.log('    4. temporary     for testing; never becomes permanent memory');
      console.log('    5. locked        read-only until you unlock it');
      console.log('    6. frozen        read-only for good; change it by copying it');
      console.log('    7. connected     linked to another project, agreed at both ends');
      console.log('');
      const pick = (await ask('  Declare this folder as a project? [1-7, or Enter to skip] ')).trim();
      ptype = { 1: 'normal', 2: 'confidential', 3: 'shared', 4: 'temporary', 5: 'locked', 6: 'frozen', 7: 'connected' }[pick] || null;
      if (ptype) log(`This folder will be declared ${ptype}.`);
    }
  }
  if (ptype || pstore) did('project', () => setupProject(opt('project', null), ptype, pstore));
  // hadFileType makes an upgrade keep the icon it already had (the removal above unregisters
  // the type; this is what puts it back).
  if (EVERY || has('icon') || hadFileType || (ASK && (await ask('Show .dai files with the DaiDocs icon in your file manager? [Y/n] ')).toLowerCase() !== 'n')) did('icon', () => registerFileType(false));

  // Model before key: which key you need depends on the model. Key-first would infer the
  // provider from the prefix and trap an OpenAI-key user out of choosing Claude.
  let observer = opt('observer', null);
  let keyVar = observer ? OBS.keyVarFor(observer) : null;
  let baseUrl = null;
  if (!observer && ASK) {
    const picked = await OBS.pickObserver(ask, log, require('./lib/host').detectHost());
    if (picked) ({ spec: observer, keyVar, baseUrl } = picked);
  }
  if (!observer) {
    // Nobody was asked, so this has to be the answer they would have given.
    // On a Claude host the assistant writes the extraction itself: free, no
    // key, nothing billed. Anywhere else, the cheapest capable observer.
    const H = require('./lib/host');
    observer = H.DEFAULTS[H.detectHost()] || OBS.CATALOGUE[0].spec;
    keyVar = OBS.keyVarFor(observer);
  }
  log(`Observer: ${observer}${ASK ? '' : '  (change it with: node setup.js --observer <provider:model>)'}`);

  // Distinguish a key the user just gave from one merely exported in this shell: persisting
  // the latter would overwrite a good saved key with a stale one and cause later 401s.
  let key = opt('key', null);
  let keyIsExplicit = !!key;
  if (!key && keyVar) key = process.env[keyVar];
  if (!key && keyVar && ASK) {
    key = await ask(`  ${keyVar} for ${observer} (Enter to skip and set it later): `);
    keyIsExplicit = !!key;
  }

  const extraVars = {};
  if (baseUrl) extraVars.OPENAI_BASE_URL = baseUrl;
  if (!keyVar) {
    persistVars({ DAIDOCS_OBSERVER: observer, ...extraVars });
    log(`${observer} needs no API key. Nothing is sent to a third party at ingest.`);
  } else if (key && !keyIsExplicit && alreadyPersisted(key)) {
    persistVars({ DAIDOCS_OBSERVER: observer, ...extraVars });
    log('A key is already saved in your user environment; leaving it alone. Pass --key to replace it.');
  } else if (key) {
    setupKey(key, observer, opt('provider', null), extraVars);
  } else {
    persistVars({ DAIDOCS_OBSERVER: observer, ...extraVars });
    log(`No ${keyVar} set. Sessions still archive losslessly; set the key and run "npm run catch-up" to index them.`);
  }

  V.writeState({ version: VERSION, installPath: HERE, installedAt: new Date().toISOString(), surfaces, observer });

  // Existing history. Most people installing this already have months of
  // sessions on disk; asking now is the difference between a store that is
  // useful today and one that fills up slowly from here on.
  const convertNow = ASK && (await ask('\nConvert existing chat history into memory now? [Y/n] ')).toLowerCase() !== 'n';
  // the child inherits stdio; let go of it first
  closeAsk();
  if (convertNow) {
    const { spawnSync } = require('child_process');
    spawnSync(NODE, [path.join(HERE, 'daidocs.js'), 'convert', '--observer', observer], { stdio: 'inherit' });
  } else {
    // The one thing a silent install must not do on its own: it can run for a
    // long time, and with an API key it spends money.
    log('Your existing chat history is not converted yet. When you want it: node daidocs.js convert');
  }
  V.recordEvent(action, { version: VERSION, from: previous ? previous.version : null, installPath: HERE, surfaces, observer });

  closeAsk();
  const store = process.env.DAIDOCS_STORE || path.join(os.homedir(), 'DaiDocs');
  console.log(`\nDone. DaiDocs ${VERSION} installed. Your memory lives in plain files at: ${store}`);
  console.log('Sessions now save themselves as you work, with no API key.');
  console.log('Try it: keep working, then open a NEW chat and ask about this one.');
  console.log('Change any of it, or see what is on: node setup.js --status');
  console.log('See what has been installed over time with: node setup.js --versions');

  // One-time, opt-in install ping. Off by default; never blocks or breaks setup.
  try {
    const { maybeInstallPing } = require('./lib/install_ping.js');
    await maybeInstallPing({ version: VERSION });
  } catch (e) { /* telemetry must never break the install */ }
})();
