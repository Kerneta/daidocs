// Pure, testable helpers for the version-reliability surfaces: the SessionStart update
// nudge, the MCP store-consistency self-check, and the running-vs-installed mismatch
// warning. Every function here is a pure string-or-empty decision over values the caller
// supplies, so the network fetch, the filesystem resolution and the stderr write all stay
// in the entry points and the DECISIONS are unit-tested with injected inputs (no network,
// no disk). See verify_surfaces.mjs, the "version reliability" section.
'use strict';

const { compareVersions } = require('./versioning');

// One line when a newer version is published, else ''. Both versions are supplied by the
// caller (the hook fetches `latest` from npm, cached), so the compare is deterministic.
function updateAvailableLine(installed, latest) {
  if (!installed || !latest) return '';
  try {
    if (compareVersions(String(latest), String(installed)) > 0) {
      return `DaiDocs update available: ${installed} -> ${latest}, run: daidocs update`;
    }
  } catch (_) { /* an unparseable version is not a reason to nag */ }
  return '';
}

// One line when the running server's in-memory version differs from the daidocs package
// found on disk, else ''. Catches "npm updated the package but the long-lived MCP server
// still runs the old code", which only a full host restart fixes. When the installed
// version cannot be determined (null/empty) we say nothing, to avoid a false alarm.
function versionMismatchLine(running, installed) {
  if (!running || !installed) return '';
  if (String(running) === String(installed)) return '';
  return `DaiDocs: this MCP server is running ${running} but the installed daidocs package on disk is ${installed}. Fully restart the host app (not just the window) so the server loads the updated code.`;
}

// One line when the server fell back to a shared store although the resolved project
// directory sits under a project that declares its own store, else ''. This is the
// split-store class of bug (save and recall landing in different stores) fixed in PR #51:
// here it is surfaced rather than silently tolerated. `fellBackToShared` is true when the
// resolved store carries no project config (the shared default, or a DAIDOCS_STORE
// override); `projectConfigPath` is the config the project walk found, or null.
function splitStoreLine({ fellBackToShared, projectConfigPath, resolvedStoreDir } = {}) {
  if (fellBackToShared && projectConfigPath) {
    return `daidocs-mcp: a project declares its own store in ${projectConfigPath}, but this server resolved the shared store (${resolvedStoreDir}). Saves and recalls may use a different store than the session hooks (the split-store bug, PR #51). Check CLAUDE_PROJECT_DIR and DAIDOCS_STORE.`;
  }
  return '';
}

module.exports = { updateAvailableLine, versionMismatchLine, splitStoreLine };
