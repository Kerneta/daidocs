// DaiDocs Option B: offer the Kerneta-Cai code tier during `node setup.js`.
//
// Drop this file into the daidocs repo at lib/code_tier.js. It adds the .cai code
// memory to a DaiDocs install when Python is available, so one setup flow can wire
// code + docs + history. It never blocks or breaks setup: any failure is swallowed
// and setup continues (same discipline as lib/install_ping.js).
//
// It does NOT reimplement the code tier; it shells out to the Kerneta-Cai Python
// package that ships in this same repo under Kerneta-Cai/ (pip installs it, then
// `kerneta setup` builds the store + installs the skill + the PostToolUse hook).
//
// Integration (one require + one call near the end of setup.js, before the final
// "Done." block): see integration/daidocs/setup.patch.md.

const { execSync, spawnSync } = require('child_process');
const path = require('path');

// Find a Python 3 interpreter that also has pip. Returns the launcher argv prefix
// (e.g. ["py","-3"] or ["python3"]) or null.
function findPython() {
  const candidates = process.platform === 'win32'
    ? [['py', '-3'], ['python'], ['python3']]
    : [['python3'], ['python']];
  for (const argv of candidates) {
    try {
      const v = execSync([...argv, '--version'].join(' '), { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString().trim();
      if (!/Python 3\.(1[0-9]|[2-9][0-9])/.test(v)) continue; // need 3.10+
      execSync([...argv, '-m', 'pip', '--version'].join(' '), { stdio: 'ignore' });
      return { argv, version: v };
    } catch (_) { /* try next */ }
  }
  return null;
}

function hasGrammars(pyArgv) {
  try {
    execSync([...pyArgv, '-c', '"import tree_sitter_python"'].join(' '), { stdio: 'ignore' });
    return true;
  } catch (_) { return false; }
}

// here = the daidocs repo root (pass __dirname's parent from setup.js, i.e. HERE).
// cwd  = the project the user is setting up (defaults to process.cwd()).
// ask/log/ASK come from setup.js so we match its prompt + logging style.
async function offerCodeTier({ here, cwd, ask, log, ASK }) {
  cwd = cwd || process.cwd();
  const pkgDir = path.join(here, 'Kerneta-Cai');
  const py = findPython();

  if (!py) {
    log('Code memory (.cai) is available too, but needs Python 3.10+. Install Python, then:');
    log('  pip install "' + pkgDir + '"  &&  kerneta setup . --corpus .');
    return;
  }

  // In silent mode we never install Python packages on the user's behalf; we tell
  // them the one command. In --ask mode we offer to do it now.
  if (!ASK) {
    log('Code memory (.cai) available. To add it for this project:');
    log('  ' + py.argv.join(' ') + ' -m pip install "' + pkgDir + '" && kerneta setup . --corpus .');
    return;
  }

  const yes = (await ask('\nAlso set up code memory (.cai) for this folder? Indexes your code so the agent reads token-cheap slices instead of whole files. [y/N] '))
    .toLowerCase().startsWith('y');
  if (!yes) {
    log('Skipped. Add it anytime: ' + py.argv.join(' ') + ' -m pip install "' + pkgDir + '" && kerneta setup . --corpus .');
    return;
  }

  log('Installing the Kerneta-Cai code tier (' + py.version + ') ...');
  let r = spawnSync(py.argv[0], [...py.argv.slice(1), '-m', 'pip', 'install', pkgDir],
    { stdio: 'inherit' });
  if (r.status !== 0) { log('pip install failed; skipping the code tier (docs + history are set up).'); return; }
  if (!hasGrammars(py.argv)) { log('tree-sitter grammars did not import; skipping the code tier.'); return; }

  // wire the project: build the store + install the skill + the PostToolUse hook,
  // and auto-link this project's .dai history store if present.
  r = spawnSync(py.argv[0], [...py.argv.slice(1), '-m', 'kerneta_cli', 'setup', cwd, '--corpus', cwd],
    { stdio: 'inherit' });
  if (r.status !== 0) { log('kerneta setup did not complete; run it manually: kerneta setup . --corpus .'); return; }
  log('Code memory wired: the agent will query .cai and it refreshes after every edit.');
}

module.exports = { offerCodeTier, findPython };
