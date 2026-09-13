// Detects which assistant is running us and defaults the observer model to match
// (Claude->Opus, ChatGPT->GPT-4.1 mini, Gemini->Gemini Pro), since a user usually has a
// key for their own provider. Detection chooses a MODEL, not ACCESS: a hook/MCP server
// is a separate process with no share in the host's subscription, so an Anthropic
// default still needs ANTHROPIC_API_KEY. Resolution: DAIDOCS_OBSERVER, host default,
// then FALLBACK.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULTS = {
  anthropic: 'anthropic:claude-opus-5',
  openai: 'openai:gpt-4.1-mini',
  // gemini id not verified against a live model list; change here if Gemini rejects it
  google: 'gemini:gemini-3.1-pro',
};

// The cheapest capable option, and what install recommends regardless of host.
const RECOMMENDED = 'openai:gpt-4.1-mini';

// Used when nothing identifies a host: a bare terminal, cron, CI.
const FALLBACK = 'openai:gpt-4.1-mini';

// Env markers set inside a host process, checked in order.
const ENV_MARKERS = [
  ['anthropic', ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_AGENT_SDK_VERSION']],
  ['openai', ['CODEX_SANDBOX', 'CODEX_SESSION_ID', 'OPENAI_AGENT']],
  ['google', ['GEMINI_CLI', 'GEMINI_SESSION_ID']],
];

// An MCP client's name from the initialize handshake — the most reliable signal.
const CLIENT_PATTERNS = [
  ['anthropic', /claude/i],
  ['openai', /chatgpt|openai|codex/i],
  ['google', /gemini|google/i],
];

// On-disk evidence of which assistant is installed, checked when the environment says
// nothing — setup is usually run from a plain terminal, where the env markers are absent.
const INSTALLED_EVIDENCE = [
  ['anthropic', () => [
    path.join(os.homedir(), '.claude'),
    path.join(os.homedir(), '.claude', 'settings.json'),
    path.join(os.homedir(), '.claude.json'),
    process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
        : path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json'),
  ]],
  ['openai', () => [path.join(os.homedir(), '.codex')]],
  ['google', () => [path.join(os.homedir(), '.gemini')]],
];

function installedHost() {
  for (const [host, paths] of INSTALLED_EVIDENCE) {
    try { if (paths().some(p => fs.existsSync(p))) return host; } catch { /* unreadable home */ }
  }
  // A key on its own is the weakest signal, so it comes last.
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  return null;
}

// Confidence order: client handshake, then process env, then installed tools.
function detectHost(clientName) {
  if (clientName) {
    for (const [host, re] of CLIENT_PATTERNS) if (re.test(clientName)) return host;
  }
  for (const [host, vars] of ENV_MARKERS) {
    // Presence, not truthiness: Claude Code sets some of these to an empty
    // string, and an empty string is a marker just as much as "1" is.
    if (vars.some(v => v in process.env)) return host;
  }
  return installedHost();
}

// The model the user chose at install, read from the install record not the environment:
// a stale DAIDOCS_OBSERVER in an old shell would otherwise send conversions to the wrong,
// possibly paid, provider.
function chosenObserver() {
  try {
    const cur = require('./versioning').currentInstall();
    return cur && cur.observer ? cur.observer : null;
  } catch { return null; }
}

// Keyless observers cost nothing, so an env asking for one is always honoured.
const KEYLESS = spec => /^(mock|manual|capture):/.test(String(spec || ''));

// The recorded choice outranks a CONTRADICTING paid env value, but not agreement and not
// a keyless spec: choosing a model is a decision, inheriting a variable is an accident,
// and only the accident can cost money unexpectedly.
function resolveObserver(clientName) {
  const env = process.env.DAIDOCS_OBSERVER;
  const chosen = chosenObserver();
  if (env && (KEYLESS(env) || !chosen || env === chosen)) {
    return { spec: env, source: 'DAIDOCS_OBSERVER', host: detectHost(clientName) };
  }
  if (chosen) {
    return {
      spec: chosen,
      source: env ? 'your chosen model (a stale DAIDOCS_OBSERVER was ignored)' : 'your chosen model',
      host: detectHost(clientName),
      overrode: env || null,
    };
  }
  const host = detectHost(clientName);
  if (host && DEFAULTS[host]) return { spec: DEFAULTS[host], source: `${host} host default`, host };
  return { spec: FALLBACK, source: 'fallback (no host detected)', host: null };
}

// On a subscription host, background paths don't call an API: they save the transcript
// (keyless) and let the next session convert for free, so a stray key in the env is
// ignored. DAIDOCS_USE_API=1 opts back in.
function subscriptionMode(clientName) {
  if (process.env.DAIDOCS_USE_API === '1') return false;
  return detectHost(clientName) === 'anthropic';
}

module.exports = { DEFAULTS, RECOMMENDED, FALLBACK, detectHost, resolveObserver, subscriptionMode };
