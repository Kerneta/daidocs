'use strict';

// One-time, opt-in install ping, off by default (DaiDocs otherwise never phones home).
// Asks once on the first interactive setup, default no; never prompts non-interactively;
// DAIDOCS_NO_PING=1 refuses unasked; the payload is only a random id, version and
// timestamp. Every side effect is injectable so it's testable without a TTY or network.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const DEFAULT_URL = process.env.DAIDOCS_PING_URL || 'https://api.daidocs.com/v1/installs';
const DEFAULT_FLAG = path.join(os.homedir(), '.daidocs', 'install.json');

function readFlag(flagFile) {
  try { return JSON.parse(fs.readFileSync(flagFile, 'utf8')); } catch { return null; }
}

function writeFlag(flagFile, obj) {
  try {
    fs.mkdirSync(path.dirname(flagFile), { recursive: true });
    fs.writeFileSync(flagFile, JSON.stringify(obj, null, 2) + '\n');
    return true;
  } catch { return false; }
}

// Default y/N prompt. Declines on anything that is not an explicit yes, and on
// a non-TTY resolves false without reading, so it can never block a pipe.
function defaultPrompt(questionText) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) { resolve(false); return; }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(questionText, (a) => { rl.close(); resolve(/^y(es)?$/i.test(String(a || '').trim())); });
  });
}

// Default sender: a single POST with a short timeout that fails silently. Uses
// the global fetch built into Node 18+.
async function defaultSend(url, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Which surface this install came from: a git clone has .git at the package root, npm/npx
// has none. DAIDOCS_SURFACE overrides (extensions and other packagings set their own).
function detectSurface() {
  const env = process.env.DAIDOCS_SURFACE;
  if (env) return String(env).replace(/[^0-9A-Za-z._-]/g, '').slice(0, 24) || 'cli';
  try {
    if (fs.existsSync(path.join(__dirname, '..', '.git'))) return 'clone';
  } catch { /* ignore */ }
  return 'npm';
}

async function maybeInstallPing(opts = {}) {
  const version = opts.version || 'unknown';
  const url = opts.url || DEFAULT_URL;
  const flagFile = opts.flagFile || DEFAULT_FLAG;
  const log = opts.log || console.log;
  const isTTY = opts.isTTY !== undefined ? opts.isTTY : Boolean(process.stdin.isTTY);
  const promptFn = opts.promptFn || defaultPrompt;
  const sendFn = opts.sendFn || defaultSend;
  const noPingEnv = opts.noPingEnv !== undefined ? opts.noPingEnv : Boolean(process.env.DAIDOCS_NO_PING);
  const force = Boolean(opts.force);

  // One-time: if we have already asked on this machine, do nothing.
  const flag = readFlag(flagFile);
  if (flag && flag.asked && !force) return { skipped: 'already-asked' };

  // Hard refusal via environment, recorded so it never asks later either.
  if (noPingEnv) {
    writeFlag(flagFile, { asked: true, optedIn: false, via: 'env', ts: new Date().toISOString() });
    return { optedIn: false, via: 'env' };
  }

  // Never prompt on a non-interactive run. Leave it unasked so the next
  // interactive setup can ask once, rather than silently marking it declined.
  if (!isTTY && !force) return { skipped: 'non-interactive' };

  log('');
  log('DaiDocs is installed on this machine.');
  log('One-time question, and the only telemetry there is: may we count this install?');
  log('A yes sends a single anonymous ping: a random id, the version, a timestamp.');
  log('Nothing that identifies you, your files, or your memory. It is off unless you');
  log('say yes, it is asked only this once, and DAIDOCS_NO_PING=1 refuses it outright.');

  const yes = await promptFn('Send one anonymous install ping? [y/N] ');
  if (!yes) {
    writeFlag(flagFile, { asked: true, optedIn: false, ts: new Date().toISOString() });
    log('No problem. Nothing was sent, and you will not be asked again.');
    return { optedIn: false };
  }

  const id = crypto.randomUUID();
  const payload = { id, version, surface: opts.surface || detectSurface(), ts: new Date().toISOString() };
  const sent = await sendFn(url, payload);
  writeFlag(flagFile, { asked: true, optedIn: true, id, sent, ts: payload.ts });
  log(sent ? 'Thanks. One anonymous ping sent.' : 'Thanks. The server could not be reached; nothing else will be tried.');
  return { optedIn: true, sent, id, payload };
}

module.exports = { maybeInstallPing, readFlag, writeFlag, DEFAULT_URL, DEFAULT_FLAG };
