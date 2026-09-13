// Open a built file in the user's default browser. Kept out of the builder so the
// decision of WHETHER to open (the part that fails quietly) is testable without
// launching anything.

const { spawn } = require('child_process');

// Open a file with the OS default app. On Windows `start`'s first argument is a window
// title; omitting it makes a quoted path the title and opens nothing, so pass "".
function openCommand(platform, file) {
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '', file] };
  if (platform === 'darwin') return { cmd: 'open', args: [file] };
  return { cmd: 'xdg-open', args: [file] };
}

// Only open when someone is watching: a browser popping up in CI or cron is a bug.
// An attached TTY (or DAIDOCS_OPEN_CMD/DAIDOCS_OPEN) is the signal someone is there.
function shouldOpen(env = process.env, argv = [], isTTY = process.stdout.isTTY) {
  if (argv.includes('--no-open')) return false;
  if (env.DAIDOCS_NO_OPEN) return false;
  if (env.CI) return false;
  return !!isTTY || !!env.DAIDOCS_OPEN_CMD || !!env.DAIDOCS_OPEN;
}

// Returns a line to print. Never throws: a correctly built page must not be reported
// as failed just because no browser (or xdg-open) is available.
function openPage(file, env = process.env, platform = process.platform) {
  const custom = env.DAIDOCS_OPEN_CMD;
  const { cmd, args } = custom ? { cmd: custom, args: [file] } : openCommand(platform, file);
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => { });
    child.unref();
    return '  opening it in your browser. Use --no-open to skip that.';
  } catch {
    return '  (could not open a browser here; the file above opens with a double click)';
  }
}

module.exports = { openCommand, shouldOpen, openPage };
