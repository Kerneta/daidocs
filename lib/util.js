const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function hash8(s) { return sha256(String(s)).slice(0, 8); }

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); return p; }

function writeFileEnsuring(fp, content) {
  ensureDir(path.dirname(fp));
  fs.writeFileSync(fp, content, 'utf8');
}

function readJSON(fp, fallback) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (_) { return fallback; }
}

function isoWeek(d = new Date()) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// Sentence splitter tolerant of abbreviations enough for benchmarking purposes.
function sentences(text) {
  return String(text).replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z"'(])/)
    .map(s => s.trim()).filter(s => s.length > 20);
}

const STOP = new Set(('the a an and or but if then of to in on for with as by at from is are was were be been being it its ' +
  'this that these those he she they we you i his her their our your not no yes do does did done have has had can could ' +
  'will would shall should may might must about into over under after before between out up down off so than too very').split(' '));

function topWords(text, n = 10) {
  const freq = new Map();
  for (const m of String(text).toLowerCase().matchAll(/[a-z][a-z'-]{3,}/g)) {
    const w = m[0];
    if (STOP.has(w)) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(e => e[0]);
}

function properNouns(text, n = 12) {
  const freq = new Map();
  for (const m of String(text).matchAll(/(?<![.!?]\s)(?<!^)\b([A-Z][a-z]{2,}(?:\s[A-Z][a-z]{2,}){0,2})\b/gm)) {
    const w = m[1];
    if (STOP.has(w.toLowerCase())) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  return [...freq.entries()].filter(e => e[1] > 1).sort((a, b) => b[1] - a[1]).slice(0, n).map(e => e[0]);
}

// Token-level F1 between a candidate answer and a gold answer: the standard extractive-QA
// agreement metric; model-independent and judge-free.
function tokenF1(candidate, gold) {
  const tok = s => (String(s).toLowerCase().match(/[a-z0-9']+/g) || []).filter(w => !STOP.has(w));
  const c = tok(candidate), g = tok(gold);
  if (!c.length || !g.length) return 0;
  const gset = new Map();
  for (const w of g) gset.set(w, (gset.get(w) || 0) + 1);
  let overlap = 0;
  for (const w of c) { const k = gset.get(w) || 0; if (k > 0) { overlap++; gset.set(w, k - 1); } }
  if (!overlap) return 0;
  const p = overlap / c.length, r = overlap / g.length;
  return 2 * p * r / (p + r);
}

function dirStats(dir) {
  let bytes = 0, files = 0;
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) walk(fp);
      else { bytes += fs.statSync(fp).size; files++; }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return { bytes, files };
}

module.exports = { sha256, hash8, ensureDir, writeFileEnsuring, readJSON, isoWeek, sentences, topWords, properNouns, tokenF1, dirStats, STOP };
