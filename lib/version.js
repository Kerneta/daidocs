// The single source of truth for the version. Every surface imports VERSION from here;
// `npm run verify` fails if any disagree. FORMAT, ENGINE and PROVENANCE below are
// deliberately NOT the release version (a .dai format marker, the retrieval-engine module
// id, and the benchmark provenance tag) and must not be unified with it. To release: bump
// VERSION and package.json together, add a CHANGELOG entry, run `npm run verify`.

const path = require('path');

// The release version, on semver so npm publish accepts it. It used to be the provenance
// tag "V4.4n32", which npm rejects as a non-semver string; that tag now lives on its own
// in PROVENANCE below, so every benchmark number and document that cites it stays valid.
const VERSION = '4.4.36';

// The benchmark provenance tag the published scores were recorded under. Not a release
// number: it names the engine revision a result came from, so papers, CHANGELOG prose and
// docs/RESULTS.md keep citing "V4.4n32" even as the release version moves on semver.
const PROVENANCE = 'V4.4n32';

// The .dai file format this build reads and writes. A compatibility contract
// with every store already on disk, not a release number.
const FORMAT = '4.4';

// The retrieval engine module this build loads (provenance, not a release number).
// Engine behind the published 83.00% (415/500) on LongMemEval-S, GPT-4o answering.
const ENGINE = 'daidocs-v44n';
// Absolute so it resolves from any caller, not just the root entry points.
const ENGINE_PATH = path.join(__dirname, 'methods', ENGINE, 'method');

// Returns a list of version-drift problems (empty if consistent). Run by the test
// harness so a second version number can't be introduced without a failure.
function checkConsistency(rootDir) {
  const fs = require('fs');
  const problems = [];
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')); } catch (e) { problems.push(`package.json unreadable: ${e.message}`); }
  if (pkg.version !== VERSION) problems.push(`package.json version is "${pkg.version}", expected "${VERSION}"`);

  const cff = path.join(rootDir, 'CITATION.cff');
  if (fs.existsSync(cff)) {
    const m = fs.readFileSync(cff, 'utf8').match(/^version:\s*(\S+)$/m);
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

module.exports = { VERSION, PROVENANCE, FORMAT, ENGINE, ENGINE_PATH, checkConsistency };
