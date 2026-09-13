// On-demand embeddings (OpenAI text-embedding-3-small, held constant across actors)
// with a disk cache, used to shortlist manifest files for the reader. If unavailable
// it THROWS rather than substituting pseudo-vectors: ranking by meaningless vectors is
// worse than not ranking. DAIDOCS_ALLOW_MOCK_EMBED=1 opts into deterministic hash
// vectors for offline tests; DAIDOCS_EMBED_CACHE overrides the cache location.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Cache beside the store, not the install: a locked release is read-only, and an
// unwritable cache silently costs a re-rank on every read.
const CACHE_DIR = process.env.DAIDOCS_EMBED_CACHE
  || path.join(process.env.DAIDOCS_STORE || path.join(require('os').homedir(), 'DaiDocs'), '.embed-cache');
const ALLOW_MOCK = process.env.DAIDOCS_ALLOW_MOCK_EMBED === '1';
// Loaded lazily: lib/host requires lib/versioning, and pulling that in at module
// load would make the embedder's cost depend on install state being readable.
function usingSubscription() {
  try { return require('./host').subscriptionMode(); } catch { return false; }
}
const EMBEDDER_ID = (process.env.OPENAI_API_KEY && !usingSubscription()) ? 'openai:text-embedding-3-small' : 'mock:hashvec-64';

function sha(s) { return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16); }

// deterministic offline pseudo-vector
function hashVec(text, dim = 64) {
  const v = new Array(dim).fill(0);
  const words = String(text).toLowerCase().match(/[a-z0-9']+/g) || [];
  for (const w of words) {
    const h = crypto.createHash('md5').update(w).digest();
    for (let i = 0; i < dim; i++) v[i] += (h[i % 16] - 128) / 128;
  }
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map(x => x / n);
}

function cacheGet(text) {
  const fp = path.join(CACHE_DIR, sha(EMBEDDER_ID + '|' + text) + '.json');
  if (fs.existsSync(fp)) { try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (_) { } }
  return null;
}
function cacheSet(text, vec) {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(path.join(CACHE_DIR, sha(EMBEDDER_ID + '|' + text) + '.json'), JSON.stringify(vec)); } catch (_) { }
}

// Live counters. STATS.hash > 0 means pseudo-vectors were used (only under
// DAIDOCS_ALLOW_MOCK_EMBED=1), so results are not comparable to an API-backed run.
const STATS = { cached: 0, api: 0, hash: 0 };

let warned = false;
function warnOnce(msg) {
  if (warned) return;
  warned = true;
  try { process.emitWarning(`[daidocs] ${msg}`); } catch (_) { }
}

function mockOrThrow(out, idx, texts, why) {
  if (!ALLOW_MOCK) {
    const e = new Error(`daidocs: embeddings unavailable (${why}). The reader will show the full manifest scan instead of a shortlist. Set DAIDOCS_ALLOW_MOCK_EMBED=1 only for offline pipeline tests.`);
    e.code = 'EMBEDDINGS_UNAVAILABLE';
    throw e;
  }
  warnOnce(`using MOCK embeddings (${why}). Retrieval quality is degraded and results are not comparable to an API-backed run.`);
  for (const i of idx) { out[i] = hashVec(texts[i]); STATS.hash++; }
}

async function embedBatch(texts) {
  const out = new Array(texts.length);
  const missing = [];
  texts.forEach((t, i) => { const c = cacheGet(t); if (c) { out[i] = c; STATS.cached++; } else missing.push(i); });
  if (!missing.length) return out;
  // The shortlist is an optimisation, not an answer: without it the reader scans the
  // whole manifest and returns the same material. So on a subscription, don't reach for
  // a key just to bill someone for a speedup they never asked for.
  if (usingSubscription()) {
    mockOrThrow(out, missing, texts, 'skipped on your subscription, so nothing is billed');
    return out;
  }
  if (!process.env.OPENAI_API_KEY) {
    mockOrThrow(out, missing, texts, 'OPENAI_API_KEY is not set');
    return out;
  }
  // OpenAI accepts up to 2048 inputs per call; chunk to stay under token limits
  for (let s = 0; s < missing.length; s += 256) {
    const idx = missing.slice(s, s + 256);
    let res;
    try {
      res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'text-embedding-3-small', input: idx.map(i => String(texts[i]).slice(0, 8000)) })
      });
    } catch (err) {
      mockOrThrow(out, idx, texts, `network error: ${err.message}`);
      continue;
    }
    if (!res.ok) {
      mockOrThrow(out, idx, texts, `embeddings API returned HTTP ${res.status}`);
      continue;
    }
    const j = await res.json();
    idx.forEach((origIdx, k) => { out[origIdx] = j.data[k].embedding; cacheSet(texts[origIdx], out[origIdx]); STATS.api++; });
  }
  return out;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

module.exports = { embedBatch, cosine, EMBEDDER_ID, STATS };
