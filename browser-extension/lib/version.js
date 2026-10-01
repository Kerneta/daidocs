// THE version number. One string, defined once, used everywhere.
//
// Read this before adding any version string anywhere in this repository:
// there is no second number. Not a package version that drifts from the
// release name, not a separate MCP server version, not a hand-typed number in
// a banner or a README. Every surface that states "which version is this"
// imports VERSION from here, and `npm run verify` fails if any of them
// disagrees. That check is the point: consistency that is only a convention
// decays, consistency that is tested does not.
//
// Two identifiers below are deliberately NOT the version, and must not be
// unified with it:
//
//   FORMAT   the marker written into every .dai file's frontmatter. It states
//            which file format the reader must expect, so it changes only when
//            the format itself changes, never when the product is released.
//            Every stored file on every machine carries the old value forever.
//
//   ENGINE   which retrieval method actually ran. This is provenance, a record
//            of what produced a result, and benchmark records depend on it
//            being accurate rather than current.
//
// Bumping the release: change VERSION here, change "version" in package.json to
// the identical string, add a CHANGELOG entry, then run `npm run verify`.

const path = require('path');

// The one number.
const VERSION = 'V4.4n32';

// The .dai file format this build reads and writes. A compatibility contract
// with every store already on disk, not a release number.
const FORMAT = '4.4';

// The retrieval engine module this build loads. Provenance, not a release
// number. Kept here so there is exactly one place that names it. This is the
// engine behind the published 83.00% (415/500) on LongMemEval-S, GPT-4o
// answering, 84.02% task-averaged.
const ENGINE = 'daidocs-v44n';
// Absolute, so it resolves from any caller. A repo-relative './lib/...' only
// worked from the root entry points and broke the moment a module inside
// lib/ tried to require it.
const ENGINE_PATH = path.join(__dirname, 'methods', ENGINE, 'method');

// Verifies that nothing has drifted. Returns a list of problems, empty if the
// repository is consistent. Used by the test harness so a second version number
// cannot be introduced without a test failing.
function checkConsistency(rootDir) {
  const fs = require('fs');
  const problems = [];
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')); } catch (e) { problems.push(`package.json unreadable: ${e.message}`); }
  if (pkg.version !== VERSION) problems.push(`package.json version is "${pkg.version}", expected "${VERSION}"`);

  const cff = path.join(rootDir, 'CITATION.cff');
  if (fs.existsSync(cff)) {
    const m = fs.readFileSync(cff, 'utf8').match(/^version:s*(S+)$/m);
    if (m && m[1] !== VERSION) problems.push(`CITATION.cff version is "${m[1]}", expected "${VERSION}"`);
  }

  const engineMethod = path.join(rootDir, 'lib', 'methods', ENGINE, 'method.js');
  if (!fs.existsSync(engineMethod)) problems.push(`engine module ${ENGINE} not found at ${engineMethod}`);
  else {
    const src = fs.readFileSync(engineMethod, 'utf8');
    const m = src.match(/id:\s*'([^']+)'/);
    if (m && m[1] !== ENGINE) problems.push(`engine module id is "${m[1]}", expected "${ENGINE}"`);
  }
  return problems;
}

module.exports = { VERSION, FORMAT, ENGINE, ENGINE_PATH, checkConsistency };
