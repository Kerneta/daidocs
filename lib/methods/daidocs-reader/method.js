// DaiDocs reader core: a page-level reader over a .dai store, built on the assumption that
// finding the file is the easy half and synthesising the answer is the hard half — so it
// hands the model structure to reason over, not prose:
//   1. typed event table (events.jsonl) for counting/ordering reads, deduped — prose
//      counting is unreliable both ways (a capped list drops rows, an uncapped one buries).
//   2. candidate values: competing dated facts are SHOWN with their dates, not resolved.
//   3. visible working: ordering/counting may show dates/items then "ANSWER:", so the
//      arithmetic isn't forced into the model's head.
//   4. scoped abstention: only single-fact reads may abstain, only on near-zero retrieval.

const { countTokens } = require('../../tokens');
const { sentences, topWords, hash8 } = require('../../util');
const { candidateTags } = require('../../taxonomy');
const cleanMd = require('../daidocs-cleanmd/method');

const SEG_TOKENS = 800;

function segment(text) {
  const sents = sentences(text);
  const segs = [];
  let cur = [], curTok = 0;
  for (const s of sents) {
    const t = countTokens(s);
    if (curTok + t > SEG_TOKENS && cur.length) { segs.push(cur.join(' ')); cur = []; curTok = 0; }
    cur.push(s); curTok += t;
  }
  if (cur.length) segs.push(cur.join(' '));
  return segs.length ? segs : [text.slice(0, 4000)];
}

function yamlEscape(s) { return JSON.stringify(String(s).slice(0, 300)); }

const EVENT_CATS = ['appointment', 'purchase', 'trip', 'meal_out', 'workout', 'entertainment', 'social', 'errand', 'incident', 'other'];

async function extractUnderstanding(text, provider, sourceDate, tagCandidates, extraFields = '', promptAddendum = '') {
  const window = text.length > 60000 ? text.slice(0, 45000) + '\n[...]\n' + text.slice(-10000) : text;
  const prompt = `Read the source below and output ONLY a JSON object with keys: ` +
    `"entities" {"people":[],"orgs":[],"dates":[],"amounts":[],"places":[]}, "actions" [], ` +
    `"facts" (4-10 objects {"fact": short string, "date": "YYYY-MM-DD" or null, "kind": "event"|"attribute"|"preference"|"plan"${extraFields ? extraFields : ''}}: ` +
    `resolve relative dates against the SOURCE DATE; ALWAYS include durable personal attributes as kind "attribute"), ` +
    `"events" (one row per COUNTABLE occurrence the user experienced, every appointment, purchase, trip, meal out, workout, show, gathering: ` +
    `{"date":"YYYY-MM-DD" or null, "cat": one of ${JSON.stringify(EVENT_CATS)}, "what": 3-8 words}; do not merge or skip occurrences; [] if none), ` +
    `"preferences" (explicitly stated user preferences/constraints, [] if none), ` +
    `"tags" (pick 2-5, ONLY from: ${tagCandidates.join(', ') || 'x.general'}), ` +
    `"decisions" [], "topics" (4-8 lowercase strings), "summary" (one sentence, max 40 words), "sentiment" (one word), "open_questions" []. ` +
    `Everything must be supported by the source; do not invent. Output minified JSON with NO code fences.` +
    // dense long documents can blow any output budget: cap list appetite there
    (text.length > 8000 ? ` This is a long source: keep every list to at most 15 items, prioritizing the most important.` : '') +
    promptAddendum +
    `\n\nSOURCE DATE: ${sourceDate || 'unknown'}\n\nSOURCE:\n${window}`;
  // Budget scales with source size (a truncated JSON parses as nothing). format:'json' is
  // honored by ollama (constrained decoding) and ignored by API providers.
  let raw = await provider.complete({ prompt, maxTokens: Math.min(4000, 1800 + Math.round(text.length / 6)), format: 'json' });
  let understanding;
  // models often wrap JSON in ``` fences: strip them before locating the object
  const tryParse = r => { const c = r.replace(/```(?:json)?/gi, ''); return JSON.parse(c.slice(c.indexOf('{'), c.lastIndexOf('}') + 1)); };
  try { understanding = tryParse(raw); }
  catch (_) {
    // One strict retry. A truncated or invalid extraction that gets cached
    // poisons every later read of that file, so it is worth paying for.
    try {
      raw = await provider.complete({ prompt: prompt + `\n\nIMPORTANT: your previous attempt produced invalid or truncated JSON. Output COMPLETE minified JSON only; keep every list to at most 10 items; never emit null placeholders in arrays.`, maxTokens: 2500, format: 'json' });
      understanding = tryParse(raw);
    } catch (_2) { understanding = { entities: {}, facts: sentences(raw).slice(0, 5), topics: topWords(raw, 6), parse_error: true }; }
  }
  understanding.tags = (understanding.tags || []).filter(t => tagCandidates.includes(t) || String(t).startsWith('x.')).slice(0, 5);
  return { understanding, tokensIn: countTokens(prompt), tokensOut: countTokens(raw) };
}

function frontmatter(item, summary, segCount, tags) {
  const today = (item.capturedAt || '2026-01-01').slice(0, 10).replace(/-/g, '');
  const id = `${item.type || 'doc'}_${today}_${hash8(item.sourceId || item.id)}`;
  return { id, text: `---
daidocs: "4.4"
id: "${id}"
type: "${item.type || 'doc'}"
title: ${yamlEscape(item.title)}
lang: "en"
source: {"app": ${yamlEscape(item.app || 'daidocs')}, "native_id": ${yamlEscape(item.sourceId || item.id)}}
span: null
messages: ${segCount}
class: {"category": ${yamlEscape(item.category || 'general')}, "priority": "normal", "actionable": false, "sensitivity": "public", "confidence": 0.9}
summary: ${yamlEscape(summary)}
tags: ${JSON.stringify(tags)}
raw: "_raw/${id}"
extracted_by: "daidocs-v44n"
---` };
}

function flatEntities(u, cap = 12) {
  const e = (u && u.entities) || {};
  return Object.values(e).flat().filter(x => typeof x === 'string').slice(0, cap);
}

function normFacts(u, fallbackDate) {
  return ((u && u.facts) || []).map(f => typeof f === 'string'
    ? { fact: f, date: fallbackDate || null, kind: 'event', dated: false }
    : {
      fact: String(f.fact || ''), date: /^\d{4}-\d{2}-\d{2}/.test(f.date || '') ? f.date.slice(0, 10) : (fallbackDate || null), kind: f.kind || 'event', dated: /^\d{4}-\d{2}-\d{2}/.test(f.date || ''),
      // optional alternate terms (synonyms/category words) ride along when present
      ...(Array.isArray(f.terms) && f.terms.length ? { terms: f.terms.filter(t => typeof t === 'string').slice(0, 6) } : {})
    }
  ).filter(f => f.fact);
}

// Semantic top-k over candidate lines via the shared embedder (throws if unavailable).
async function semanticTopK(queryText, candidates, k, floor, margin) {
  if (!candidates.length) return [];
  const { embedBatch, cosine } = require('../../embeddings');
  const [qv, ...cv] = await embedBatch([queryText, ...candidates.map(c => c.text)]);
  let scored = candidates.map((c, i) => ({ c, s: cosine(qv, cv[i]) }))
    .filter(x => x.s > (floor ?? 0.25)).sort((a, b) => b.s - a.s).slice(0, k);
  // relative-margin mode (anchor precision): one strong match must not be
  // padded with weak topical neighbors: drop anything far below the top hit
  if (margin && scored.length) scored = scored.filter(x => x.s >= scored[0].s * margin);
  return scored.map(x => x.c);
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function classify(qtext, prefWide) {
  const q = qtext.toLowerCase();
  // advice can be phrased as an opinion question ("any tips", "is it worth"); without this
  // it reads as a terse, abstainable lookup, both wrong for advice.
  if (prefWide && /any tips|do you think|what do you think|good idea|could there be|is it worth|worth (buying|getting|attending)|ideas? (on|to|about)/.test(q)) return 'advice';
  if (/recommend|suggest|prefer|should (i|you)|advi[cs]e|ideas? for|gift|what would (i|you)|help me (choose|pick|plan)/.test(q)) return 'advice';
  if (/how (many|much|often)|total|all (the|of|my)|list |count|which .* did i (go|attend|visit|buy)|what .*have i/.test(q)) return 'tally';
  if (/\bfirst\b|\blast\b|latest|earliest|most recent|right (before|after)|\bbefore\b|\bafter\b|\bsince\b|between .* and|when did|how long (ago|after|before)|in what order|sequence/.test(q)) return 'timeline';
  return 'lookup';
}

function questionMonths(qtext) {
  const q = qtext.toLowerCase();
  const out = [];
  MONTHS.forEach((m, i) => { if (q.includes(m)) out.push(i + 1); });
  return out;
}

function scoreEntry(e, qWords, months, qTags) {
  const hit = (text, n) => topWords(text, n).filter(w => qWords.has(w)).length;
  let s = hit(`${e.title} ${e.summary}`, 40)
    + 2 * hit((e.topics || []).join(' '), 20)
    + 3 * hit([...(e.entities || []), ...(e.attrs || [])].join(' '), 40)
    + 2 * Math.min((e.tags || []).filter(t => qTags.has(t)).length, 2);
  if (months.length && e.date) {
    const m = parseInt(e.date.slice(5, 7), 10);
    s += months.includes(m) ? 6 : -2;
  }
  return s;
}

function fileZones(dai) {
  const fmEnd = dai.indexOf('---', 4);
  const fm = dai.slice(0, fmEnd + 3);
  const uMatch = dai.match(/# Understanding\s*```json\s*([\s\S]*?)```/);
  const segs = [...dai.matchAll(/## \[seg \d+\/\d+\]\n([\s\S]*?)(?=\n## \[seg |\n*$)/g)].map(m => m[1]);
  return { fm, understanding: uMatch ? uMatch[1] : '', segs };
}

// Page-level retrieval: shortlist segments by question overlap, keep the two
// best (in document order; prefer the top pick's neighbor on near-ties so a span
// crossing a segment boundary stays whole).
function pickSegments(segs, qWords, n = 2) {
  if (!segs.length) return [];
  const scored = segs.map((sg, i) => ({ sg, i, sc: topWords(sg, 60).filter(w => qWords.has(w)).length }))
    .sort((a, b) => b.sc - a.sc);
  const picks = [scored[0]];
  if (n > 1 && scored.length > 1) {
    const rest = scored.slice(1).map(x => ({ ...x, adj: Math.abs(x.i - scored[0].i) === 1 ? 0.5 : 0 }))
      .sort((a, b) => (b.sc + b.adj) - (a.sc + a.adj));
    picks.push(rest[0]);
  }
  return picks.filter(Boolean).sort((a, b) => a.i - b.i).map(x => x.sg);
}

function buildProfile(store) {
  const lines = (store.files['_index/profile.jsonl'] || '').trim();
  if (!lines) return '';
  const prefs = [];
  for (const l of lines.split('\n')) {
    try {
      const p = JSON.parse(l);
      for (const x of p.preferences || []) prefs.push(`- [${p.date}] ${x}`);
      for (const x of p.inferred || []) prefs.push(`- [${p.date}] ~${x} (implied)`);
    } catch (_) { }
  }
  return prefs.length ? `# profile.dai: user preferences and persona (stated, ~implied; newest last)\n${prefs.slice(-50).join('\n')}` : '';
}

function markSuperseded(facts) {
  const chains = new Map();
  for (const f of facts) {
    if (f.kind !== 'attribute' && f.kind !== 'plan') continue;
    const key = f.kind + '|' + topWords(f.fact, 3).sort().join(',');
    (chains.get(key) || chains.set(key, []).get(key)).push(f);
  }
  for (const chain of chains.values()) {
    if (chain.length < 2) continue;
    chain.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    for (let i = 0; i < chain.length - 1; i++) chain[i].superseded = chain[chain.length - 1].date;
  }
  return facts;
}

function ledgerFacts(store, qWords, months, cap = 40, rankByRelevance = false) {
  const lines = (store.files['_index/facts.jsonl'] || '').trim();
  if (!lines) return [];
  const seen = new Set(), out = [];
  const parsed = lines.split('\n').map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  for (const f of parsed) {
    // Stored alternate terms join the matchable surface when the extraction
    // produced them, and are simply absent when it did not.
    const words = topWords(`${f.fact} ${(f.entities || []).join(' ')} ${(f.terms || []).join(' ')}`, 36);
    const rel = words.filter(w => qWords.has(w)).length;
    const monthOk = months.length ? (f.date && months.includes(parseInt(f.date.slice(5, 7), 10))) : false;
    if (rel === 0 && !monthOk) continue;
    const key = `${f.date}|${words.slice(0, 6).sort().join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // event rows edge attribute rows at equal relevance
    out.push({ ...f, _rel: rel + (f.kind === 'event' ? 1 : 0) });
    if (!rankByRelevance && out.length >= cap) break;
  }
  // Rank by relevance before capping: a chronological cap cuts the tail, so loosely dated
  // attribute rows could displace the events the question asks about. Restore chronological
  // order after.
  const kept = rankByRelevance
    ? out.sort((a, b) => b._rel - a._rel).slice(0, cap).sort((a, b) => String(a.date).localeCompare(String(b.date)))
    : out;
  kept.forEach(f => delete f._rel);
  return markSuperseded(kept);
}

function renderTimeline(facts, askedOn) {
  const ref = askedOn ? new Date(askedOn) : null;
  const dayDiff = (a, b) => Math.round((b - a) / 86400000);
  let prev = null;
  return facts.map(f => {
    const d = f.date ? new Date(f.date) : null;
    const gap = prev && d ? ` (+${dayDiff(prev, d)}d)` : '';
    const rel = ref && d ? ` [${dayDiff(d, ref)}d before question]` : '';
    if (d) prev = d;
    const sup = f.superseded ? ` [SUPERSEDED by ${f.superseded} update]` : '';
    return `- ${f.date || '????-??-??'}${f.dated === false ? '~' : ''}${gap}${rel} [${f.kind}] ${f.fact}${sup} (src ${f.src})`;
  }).join('\n');
}

// The typed event table. Loaded ONLY for counting and ordering reads;
// deduplicated by (category, date, core-words): the mechanical dedup that prose
// facts couldn't support.
function eventTable(store, qWords, months, cap = 60, tableOpts = {}) {
  const lines = (store.files['_index/events.jsonl'] || '').trim();
  if (!lines) return [];
  // an undated row regains its source session's date (marked inferred with ~) so it
  // doesn't silently drop out of chronologies and counts
  let srcDate = null;
  if (tableOpts.inferDates) {
    srcDate = new Map();
    for (const l of (store.files['_index/manifest.jsonl'] || '').trim().split('\n')) {
      try { const e = JSON.parse(l); srcDate.set(e.id, e.date); } catch (_) { }
    }
  }
  const seen = new Set(), out = [];
  const parsed = lines.split('\n').map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean)
    .map(ev => (tableOpts.inferDates && !ev.date && srcDate.get(ev.src)) ? { ...ev, date: srcDate.get(ev.src), inferred: true } : ev)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  for (const ev of parsed) {
    // "asked about X" is a topic, not something the user did; drop it so a milestone
    // sweep doesn't bury real actions
    if (tableOpts.dropTopicRows && /^(asked|asking|inquired|discussed|talked|learned|read|chatted) about\b/i.test(String(ev.what))) continue;
    const words = topWords(`${ev.what} ${ev.cat}`, 12);
    const rel = words.filter(w => qWords.has(w)).length;
    const monthOk = months.length ? (ev.date && months.includes(parseInt(ev.date.slice(5, 7), 10))) : false;
    if (rel === 0 && !monthOk) continue;
    const key = `${ev.cat}|${ev.date}|${words.slice(0, 4).sort().join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ev);
    if (out.length >= cap) break;
  }
  return out;
}

function renderEventTable(events) {
  return `| # | date | category | event | src |\n|---|---|---|---|---|\n` +
    events.map((ev, i) => `| ${i + 1} | ${ev.inferred ? '~' : ''}${ev.date || '?'} | ${ev.cat} | ${ev.what} | ${ev.src} |`).join('\n');
}

// Candidate values: several dated facts competing for the same asked slot are
// SHOWN, not silently resolved: the model chooses with all information visible.
function candidateValues(facts, qWords, markPlans = false) {
  const relevant = facts.filter(f => (f.kind === 'attribute' || f.kind === 'plan' || f.kind === 'event') &&
    topWords(f.fact, 20).filter(w => qWords.has(w)).length >= 2 && f.date);
  if (relevant.length < 2) return '';
  // markPlans: annotate [plan] rows so recency never treats a deadline as an occurrence
  const lines = relevant.slice(-6).map(f => `- ${f.date}: ${f.fact}${markPlans && f.kind === 'plan' ? ' [PLAN: a deadline or intention, not necessarily when it happened]' : ''}`).join('\n');
  return `# CANDIDATE VALUES: multiple dated versions of possibly the same information\n${lines}\n` +
    `(If these are updates of one thing, the question most likely asks about the CURRENT one, the latest date, unless it explicitly asks about an earlier time.${markPlans ? ' A [PLAN] row never wins over an actual event row for questions about when something HAPPENED.' : ''})`;
}


// Category-aware pull: a purchase recorded by brand name shares no words with "money spent
// on cycling", so for money questions match by event CATEGORY instead of words — pull every
// purchase row and priced fact regardless of overlap. Code-only.
function categoryEvents(store, cat) {
  const lines = (store.files['_index/events.jsonl'] || '').trim();
  if (!lines) return [];
  const seen = new Set(); const out = [];
  for (const l of lines.split('\n')) {
    try {
      const ev = JSON.parse(l);
      if (ev.cat !== cat) continue;
      const k = `${ev.date}|${ev.what}`;
      if (seen.has(k)) continue; seen.add(k); out.push(ev);
    } catch (_) { }
  }
  return out;
}
function pricedFacts(store) {
  const lines = (store.files['_index/facts.jsonl'] || '').trim();
  if (!lines) return [];
  const seen = new Set(); const out = [];
  for (const l of lines.split('\n')) {
    try {
      const f = JSON.parse(l);
      if (!/[$€£]\s?\d|\b\d+(\.\d+)?\s?(dollars|bucks|euros|pounds)\b/i.test(f.fact)) continue;
      if (seen.has(f.fact)) continue; seen.add(f.fact); out.push(f);
    } catch (_) { }
  }
  return out;
}


const COMMON_RULES = `Rules: When several dated versions of the same information exist, the most recent is current unless the question asks about an earlier time. Never invent.`;
const ABSTAIN_RULE = ` If, after checking the excerpts, the asked information is genuinely absent from the context, reply exactly: "There is no information about that."`;

function stylize(kind, qtext, raised, noEcho) {
  // Ordering/counting answers may show working; preference never abstains. Answer caps
  // (220 lookup, 350 advice, 400 timeline/tally) favour a committed short answer over a
  // hedged paragraph; the numbers were calibrated on LongMemEval (see docs/RESULTS.md).
  if (kind === 'advice') {
    return { style: `Respond as a helpful assistant giving the user a concise, personalized answer (2-4 sentences) that EXPLICITLY reflects the user's relevant stated and implied preferences from the profile and the retrieved sessions. There is always enough to attempt an answer: do not decline.${noEcho ? ` Recommend NEW items similar to what they already enjoy: never recommend back the exact items, shows, or places they told you about (those define their taste, they are not suggestions). EXPLICITLY NAME the specific past item, success, possession, pet, or person of theirs you are building on: open by referring to the thing of theirs it follows from, such as a dish they said went well or their pet by name.` : ''}`, maxTokens: raised ? 800 : 350, abstain: false };
  }
  if (kind === 'timeline') {
    return { style: `First briefly show your working, the relevant dates (and day arithmetic if asked "how long/many days"), or the ordered events. Then give the final line as: ANSWER: <short answer or full chronological sequence>.`, maxTokens: raised ? 1500 : 400, abstain: false };
  }
  if (kind === 'tally') {
    return { style: `Count from the event table: list the qualifying rows briefly (each real-world event once), cross-check against the verbatim excerpts, then final line: ANSWER: <number or list>.`, maxTokens: raised ? 1500 : 400, abstain: false };
  }
  const verbatim = /assistant|you (said|told|recommended|suggested|mentioned|shared|gave)|exact/i.test(qtext);
  return {
    style: verbatim
      ? `The question asks what was said in the conversation: quote the exact wording from the verbatim content, not a paraphrase. Reply with only the answer.`
      : `Reply with ONLY the short answer: a few words, no explanation, no preamble.`, maxTokens: raised ? 400 : 220, abstain: true
  };
}


// Adaptive top-K by source size (fixed rungs so the run is self-describing):
//   <= 200k source tokens -> 5, otherwise 8.
function sourceTokensOf(store) {
  let chars = 0, sawRaw = false;
  for (const [p, body] of Object.entries(store.files || {})) {
    if (p.startsWith('_raw/')) { chars += String(body).length; sawRaw = true; }
  }
  if (!sawRaw) {
    for (const [p, body] of Object.entries(store.files || {})) {
      if (p.endsWith('.dai')) chars += String(body).length;
    }
  }
  return Math.round(chars / 4);
}
function resolveTopK(opts, store, wide) {
  // an explicit --topk still wins
  if (Number.isFinite(opts.topk)) return opts.topk;
  return sourceTokensOf(store) <= 200000 ? 5 : 8;
}

async function answerMulti(question, store, provider, opts = {}) {
  const manifest = (store.files['_index/manifest.jsonl'] || '').trim();
  const entries = manifest.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  const qWords = new Set([...topWords(question.text, 20),
  ...(question.text.match(/[A-Z][a-z]{2,}/g) || []).map(w => w.toLowerCase())]);
  const wide = entries.length > (opts.wideGate ?? 5);

  // A caller-declared kind uses the spec's cheap zooms directly, with no guessing.
  const declared = question.kind;
  if (!wide && (declared === 'summary' || declared === 'facts' || declared === 'topics')) {
    const e = entries[0];
    const dai = e && store.files[e.path];
    const { fm, understanding } = dai ? fileZones(dai) : { fm: '', understanding: '' };
    const ctx = declared === 'summary' ? `${manifest}\n${fm}` : `${manifest}\n${fm}\n# Understanding\n\`\`\`json\n${understanding}\n\`\`\``;
    const prompt = `Answer from the DaiDocs context below.\n\nCONTEXT:\n${ctx}\n\nQUESTION: ${question.text}\nAnswer directly and completely; no preamble.`;
    const answer = await provider.complete({ prompt, maxTokens: 400 });
    return { answer, contextTokens: countTokens(prompt), pickedIds: e ? [e.id] : [], kind: declared };
  }

  // Reading strategy from classify() alone, on the question text — no caller override,
  // no second model.
  const kind = classify(question.text, !!opts.prefClassify);
  const months = questionMonths(question.text);
  const qTags = new Set(candidateTags(question.text, 6));
  const askedOn = (question.text.match(/asked on (\d{4}-\d{2}-\d{2})/) || [])[1];

  const scored = entries.map(e => ({ e, s: scoreEntry(e, qWords, months, qTags) })).sort((a, b) => b.s - a.s || String(a.e.date).localeCompare(String(b.e.date)));
  // Show each file's entities in the scan: a "how many instructors" question may share no
  // word with any fact while the names sit in the manifest. Counting reads get the full
  // summary, not a 110-char slice, so a truncated summary can't cut off the counted item.
  const sumCap = (opts.wideScan && kind === 'tally') ? 300 : 110;
  // Question-aware scan filtering: the manifest scan dominates context cost at scale, yet
  // most entries are irrelevant per question. Keep the semantic top-K plus every
  // lexically-scoring entry, so scoring never finds what the actor can't see (retrieval
  // still considers ALL entries). The one place a read touches the network.
  let scanList = entries;
  if (opts.leanScan && entries.length > 12) {
    try {
      const { embedBatch, cosine } = require('../../embeddings');
      const texts = entries.map(e => `${e.title || ''} ${(e.tags || []).join(' ')} ${(e.entities || []).slice(0, 4).join(' ')} ${e.summary || ''}`.slice(0, 500));
      const vecs = await embedBatch([question.text, ...texts]);
      const qv = vecs[0];
      const k = kind === 'tally'
        ? Math.min(entries.length, Math.max(30, Math.ceil(entries.length * 0.5)))
        : Math.min(entries.length, Math.max(12, Math.ceil(entries.length * 0.25)));
      const ranked = entries.map((e, i) => ({ e, sim: cosine(qv, vecs[i + 1]) }));
      const keep = new Set(ranked.slice().sort((a, b) => b.sim - a.sim).slice(0, k).map(x => x.e.id));
      for (const s of scored) if (s.s >= 2) keep.add(s.e.id);
      scanList = entries.filter(e => keep.has(e.id));
    } catch (err) {
      // embeddings unavailable: show the full manifest scan (costs tokens, hides nothing)
      scanList = entries;
      try { process.emitWarning(`[daidocs] manifest shortlist disabled: ${err.message}`); } catch (_) { }
    }
  }
  const showEntities = opts.scanEntities && (!opts.scopedScan || kind === 'tally');
  const manifestScan = scanList.map(e => JSON.stringify({
    id: e.id, date: e.date, title: e.title, tags: e.tags,
    ...(showEntities && e.entities && e.entities.length ? { entities: e.entities.slice(0, 6) } : {}),
    summary: (e.summary || '').slice(0, sumCap)
  })).join('\n');
  // narrow stores keep the lean read
  const profile = wide ? buildProfile(store) : '';

  let picks, parts = [];
  if (kind === 'lookup' || kind === 'advice') {
    const shortlist = scored.slice(0, 10);
    for (const x of shortlist) {
      const dai = store.files[x.e.path];
      if (dai) x.s += 2 * topWords(fileZones(dai).understanding, 80).filter(w => qWords.has(w)).length;
    }
    shortlist.sort((a, b) => b.s - a.s);
    picks = shortlist.slice(0, resolveTopK(opts, store, wide)).map(x => x.e);
    for (let i = 0; i < picks.length; i++) {
      const dai = store.files[picks[i].path]; if (!dai) continue;
      const { fm, understanding, segs } = fileZones(dai);
      // two best segments for the top pick, so a single-document answer isn't lost to one wrong segment
      const segsOut = pickSegments(segs, qWords, i === 0 ? 2 : 1);
      parts.push(`${fm}\n# Understanding\n\`\`\`json\n${understanding}\n\`\`\`\n# Verbatim excerpts\n${segsOut.join('\n[...]\n')}`);
    }
    // Preference reads paste the best verbatim spans across DIFFERENT files (diversity
    // cap), scored per segment from the stored Content zones — verbatim keeps the user's
    // specifics that summarization flattens.
    if (opts.prefSpans && kind === 'advice') {
      const spanRows = [];
      for (const x of scored.slice(0, 8)) {
        const dai = store.files[x.e.path]; if (!dai) continue;
        const segs = fileZones(dai).segs;
        segs.forEach((sg, i) => {
          const s = topWords(sg, 40).filter(w => qWords.has(w)).length;
          if (s > 0) spanRows.push({ src: x.e.id, date: x.e.date, seg: i + 1, n: segs.length, text: sg, s });
        });
      }
      spanRows.sort((a, b) => b.s - a.s);
      const perFile = new Map(); const chosen = [];
      for (const r of spanRows) {
        if (chosen.length >= 5) break;
        const c = perFile.get(r.src) || 0; if (c >= 2) continue;
        perFile.set(r.src, c + 1); chosen.push(r);
      }
      if (chosen.length) parts.push(`# THE USER'S OWN WORDS (verbatim, addressed: cite their specifics by name)\n` +
        chosen.map(r => `[${r.src} · seg${r.seg}/${r.n} · ${r.date}]\n${r.text.slice(0, 700)}`).join('\n[...]\n'));
    }
    // Anchor-pull: "my wrists ache after long rides" shares no word with a fact naming the
    // bike, so meaning-match profile lines + attribute/preference facts to find anchors.
    if (opts.semantic && kind === 'advice') {
      const cands = [];
      const prof = (store.files['_index/profile.jsonl'] || '').trim();
      if (prof) for (const l of prof.split('\n')) { try { const p = JSON.parse(l); for (const x of (p.preferences || [])) cands.push({ text: String(x), date: p.date }); } catch (_) { } }
      const flines = (store.files['_index/facts.jsonl'] || '').trim();
      // widen the pool for recommendations: what someone did or plans says as much about taste
      if (flines) for (const l of flines.split('\n')) { try { const f = JSON.parse(l); if (f.kind === 'attribute' || f.kind === 'preference' || (opts.anchorWide && (f.kind === 'event' || f.kind === 'plan'))) cands.push({ text: f.fact, date: f.date }); } catch (_) { } }
      const uniq = [...new Map(cands.map(c => [c.text, c])).values()];
      // a wrong anchor + a "cite it" rule yields an obediently wrong answer, so keep
      // selection tight (floor 0.35, top 4, >=75% of the top hit) and advisory. Keyless,
      // the embedder throws and the read runs without anchors.
      let anchors = [];
      try {
        anchors = opts.anchorPrecision
          ? await semanticTopK(question.text, uniq, 4, 0.35, 0.75)
          : await semanticTopK(question.text, uniq, 8, 0.2);
      } catch (err) {
        try { process.emitWarning(`[daidocs] anchor pull skipped: ${err.message}`); } catch (_) { }
      }
      if (anchors.length) parts.push((opts.anchorPrecision
        ? `# Possibly relevant personal context (advisory: cite only what is DIRECTLY relevant to this question; ignore the rest)\n`
        : `# PERSONAL ANCHORS (meaning-matched to this question: explicitly name the relevant ones)\n`) +
        anchors.map(a => `- [${a.date || '?'}] ${a.text}`).join('\n'));
    }
    // Full-text fallback: when the derived layer has no signal, search the Content zones
    // directly. Rare tokens (numbers, #ids) are exact-matched and the hit quoted. Code-only.
    if (opts.textFallback) {
      // discriminative probes: drop date tokens and gate out probes hitting >4 files (IDF gate)
      const rawProbes = [...new Set((question.text.match(/[\w#]*\d[\w#]*|#\w+/g) || []).map(t => t.toLowerCase())
        .filter(t => !/^\d{4}(-\d{2}){0,2}$/.test(t))
        .concat(topWords(question.text, 6)).filter(t => t.length >= 3))];
      const lows = entries.map(e => ({ e, low: (store.files[e.path] || '').toLowerCase() }));
      const probes = rawProbes.filter(t => {
        let c = 0;
        for (const { low } of lows) if (low.includes(t) && ++c > 4) return false;
        return c >= 1;
      });
      const hits = [];
      for (const { e, low } of lows) {
        if (!low) continue;
        let s = 0; for (const t of probes) if (low.includes(t)) s += /\d|#/.test(t) ? 5 : 1;
        if (s >= 5) hits.push({ e, s, low });
      }
      hits.sort((a, b) => b.s - a.s);
      for (const h of hits.slice(0, 2)) {
        if (picks.some(p => p.id === h.e.id)) continue;
        const rare = probes.find(t => /\d|#/.test(t) && h.low.includes(t)) || probes.find(t => h.low.includes(t));
        const idx = h.low.indexOf(rare);
        const dai = store.files[h.e.path];
        parts.push(`--- full-text match · ${h.e.id} · ${h.e.date} · ${h.e.title}\n[...]${dai.slice(Math.max(0, idx - 500), idx + 800)}[...]`);
        picks.push(h.e);
      }
    }
    const uncertain = (shortlist[0] && shortlist[0].s < 6);
    if (wide && kind === 'lookup' && (uncertain || /\b(first|last|before|after|when|how many|all|order|time)\b/i.test(question.text))) {
      const facts = ledgerFacts(store, qWords, months, 15, !!opts.rankTimeline);
      if (facts.length) {
        // the "[Nd before question]" offset helps temporal reads but gets echoed as the
        // answer on a terse lookup, so needle reads drop it
        parts.push(`# Compact facts timeline\n${renderTimeline(facts, opts.needleNoOffset ? null : askedOn)}`);
        const cand = candidateValues(facts, qWords, !!opts.markPlans);
        // multiple dated versions: show, don't guess
        if (cand) parts.push(cand);
      }
    }
  } else {
    // aggregation | temporal
    const facts = wide ? ledgerFacts(store, qWords, months, 40) : ledgerFacts(store, qWords, months, 15);
    const srcIds = [...new Set(facts.map(f => f.src))];
    // The typed event table is the counting surface, loaded only here
    const events = eventTable(store, qWords, months, 60, { inferDates: !!opts.inferDates, dropTopicRows: !!opts.dropTopicRows });
    if (events.length) parts.push(`# Event table: typed, deduplicated, chronological (${events.length} rows)\n${renderEventTable(events)}`);
    if (facts.length) {
      parts.push(`# Facts timeline: dated, deduped, chronological (${facts.length} facts from ${srcIds.length} files)\n` +
        renderTimeline(facts, askedOn) +
        `\n(~ = date inferred from the session date, not stated with the fact.)`);
      const cand = candidateValues(facts, qWords, !!opts.markPlans);
      if (cand) parts.push(cand);
    }
    // Category-aware pull for money questions: see categoryEvents()
    if (opts.categoryPull && kind === 'tally' && /\b(spen[dt]|cost|costs|paid|pay|price|money|bought|buy|purchase[sd]?)\b|\$/i.test(question.text)) {
      const purchases = categoryEvents(store, 'purchase');
      if (purchases.length) parts.push(`# ALL recorded purchases (category-matched: words may not overlap the question)\n` +
        purchases.map(ev => `- ${ev.date || '?'} · ${ev.what} [${ev.src}]`).join('\n'));
      const priced = pricedFacts(store);
      if (priced.length) parts.push(`# ALL facts with amounts (category-matched)\n` +
        priced.slice(0, 25).map(f => `- ${f.date || '?'}${f.dated ? '' : '~'} · ${f.fact} [${f.src}]`).join('\n'));
    }
    // Semantic union for counting: a fact can describe the asked category in words sharing
    // nothing with the question ("sourdough starter workshop" vs "baking classes"). Meaning-
    // match facts not already selected lexically. Counting reads only — widening everywhere
    // costs more in distractor noise than it gains.
    if (opts.semantic && kind === 'tally') {
      const flines = (store.files['_index/facts.jsonl'] || '').trim();
      if (flines) {
        const all = flines.split('\n').map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
        const have = new Set(facts.map(f => f.fact));
        const cands = [...new Map(all.filter(f => f.fact && !have.has(f.fact)).map(f => [f.fact, f])).values()].map(f => ({ text: f.fact, f }));
        // keyless: the sweep is skipped, not faked; the read falls back to lexical selection
        let extra = [];
        try { extra = await semanticTopK(question.text, cands, 15, 0.3); }
        catch (err) { try { process.emitWarning(`[daidocs] semantic sweep skipped: ${err.message}`); } catch (_) { } }
        if (extra.length) parts.push(`# Semantically related facts (meaning-matched: wording may differ from the question)\n` +
          extra.map(x => `- ${x.f.date || '?'}${x.f.dated ? '' : '~'} · ${x.f.fact} [${x.f.src}]`).join('\n'));
      }
    }
    // how many source files get a verbatim excerpt
    const VERIFY_FILES = 4;
    const verifySrc = srcIds.slice(0, wide ? VERIFY_FILES : 1).map(id => entries.find(e => e.id === id)).filter(Boolean);
    const verify = [...new Map([...verifySrc, ...scored.filter(x => x.s > 0).slice(0, 2).map(x => x.e)].map(e => [e.id, e])).values()].slice(0, wide ? VERIFY_FILES : 1);
    picks = [...new Map([...srcIds.map(id => entries.find(e => e.id === id)).filter(Boolean), ...verify].map(e => [e.id, e])).values()];
    for (const p of verify) {
      const dai = store.files[p.path]; if (!dai) continue;
      const { segs } = fileZones(dai);
      const segsOut = pickSegments(segs, qWords, wide ? 1 : 2);
      parts.push(`--- verbatim excerpt · ${p.id} · ${p.date} · ${p.title}\n${segsOut.join('\n[...]\n')}`);
    }
  }

  // The COMPLETE ordered log for the question's category, built in code from the union of
  // events.jsonl and event-kind facts (word-overlap surfaces can't assemble a complete
  // list). The header asserts completeness. Scoped to ordering and single-fact reads.
  if (opts.scopedCategoryLog && ['timeline', 'lookup'].includes(kind)) {
    try {
      const surf = require('../../derive/surfaces');
      const cat = surf.categoryOf(question.text);
      if (cat) {
        const log = surf.renderCategoryLog(surf.unionEvents(store), cat);
        if (log) parts.push(log);
      }
    } catch (_) { /* never break a run on a surface error */ }
  }
  // Code resolves the question's relative date expression and shows which stored events
  // fall in the window — arithmetic ("last weekend" on a Monday) belongs in code.
  if (opts.calendarResolve && askedOn) {
    try {
      const cal = require('../../derive/calendar');
      const win = cal.resolveExpression(question.text, askedOn);
      if (win) {
        // union surface: typed events + event-kind facts (either may hold the row)
        const rows = [];
        for (const l of (store.files['_index/events.jsonl'] || '').trim().split('\n')) {
          try { const ev = JSON.parse(l); if (ev && ev.what) rows.push({ date: ev.date, what: ev.what, src: ev.src }); } catch (_) { }
        }
        for (const l of (store.files['_index/facts.jsonl'] || '').trim().split('\n')) {
          try { const f = JSON.parse(l); if (f && f.fact && f.kind === 'event') rows.push({ date: f.date, what: f.fact, src: f.src }); } catch (_) { }
        }
        const seen = new Set();
        const uniq = rows.filter(r => { const k = `${r.date}|${String(r.what).toLowerCase().slice(0, 40)}`; if (seen.has(k)) return false; seen.add(k); return true; })
          .sort((a, b) => String(a.date).localeCompare(String(b.date)));
        const block = cal.renderResolution(win, uniq, askedOn);
        // first in context: the anchor the rest is read against
        if (block) parts.unshift(block);
      }
    } catch (_) { /* never break a run on a resolver error */ }
  }
  const { style, maxTokens, abstain } = stylize(kind, question.text, false, !!opts.prefNoEcho);
  // Small-store read-all: when the whole store's content fits fullContentBudget (~25k
  // tokens), read all of it instead of a keyword slice — selected segments miss answers
  // whose wording doesn't match. Above the budget this never fires, so benchmarks are unaffected.
  if (opts.fullContent) {
    const contentParts = []; let tot = 0;
    for (const e of entries) {
      const dai = store.files[e.path]; if (!dai) continue;
      const ci = dai.indexOf('# Content');
      const content = ci >= 0 ? dai.slice(ci + '# Content'.length).trim() : '';
      if (!content) continue;
      contentParts.push(`--- original content · ${e.id} · ${e.date} · ${e.title}
${content}`);
      tot += countTokens(content);
    }
    if (contentParts.length && tot <= (opts.fullContentBudget ?? 25000)) {
      parts = parts.filter(p => /^# (Event table|Facts timeline|Compact facts)/.test(p))
        .concat(`# Complete original content (store fits the budget, full verbatim read)
${contentParts.join('\n\n')}`);
    }
  }
  const ctx = [`# Manifest scan (${entries.length} stored files${scanList.length < entries.length ? `; showing the ${scanList.length} most relevant to this question` : ''})`, manifestScan, profile, ...parts].filter(Boolean).join('\n\n');
  // Counting/answering rules, stated in the prompt because counting a personal history has
  // recurring failure modes (double-counting, rows vs items, wrong category, date-boundary
  // drops, giving up when the answer must be composed). Scoped by read kind.

  // Dedup by entity must not merge two distinct pending actions on one item:
  // returning the old boots and picking up the new pair are two errands.
  const countActionsRule = (opts.countActions && kind === 'tally')
    ? ` When counting tasks, errands, or occurrences, distinct pending actions on the same item count separately (e.g., returning an old item AND picking up its replacement are two).` : '';
  const aggRules = (opts.aggRules && kind === 'tally')
    ? ` The same item or event restated in several sessions counts ONCE (one map cabinet mentioned twice is one purchase). Evidence is usually SPREAD across sessions: combine partial clues (a stated time + a stated duration, an age + an average) and compute the derived value before concluding anything is missing: give a specific number, not a range. If NO qualifying items exist in the evidence at all, say the information is not recorded rather than computing from unrelated data.${opts.legRule ? ' Distinct occurrences on the SAME day with different descriptions (two flight legs, two separate errands) are separate: dedupe restatements of one occurrence, never genuinely different ones. But several rows from ONE source session narrating one continuous role or activity (a promotion, then leading, then presenting in the same job) are ONE occurrence.' : ''}` : '';
  const rollupRule = (opts.rollupCount && kind === 'tally')
    ? ` Before counting, ROLL UP rows to distinct real-world items: bought/started/finished/repaired rows about the SAME item are one item; a role-only mention and a named mention anchoring the same recorded event are the SAME person (a reference to "the specialist" and a later reference naming that specialist are one person). Count items, never rows.` : '';
  const categoryRule = (opts.categoryGate && kind === 'tally')
    ? ` Each counted candidate must itself BE an instance of the asked category: an accessory bought FOR a thing is not that thing, and an intention or booking is not an occurrence.` : '';
  const windowRule = (opts.calendarWindow && kind === 'tally')
    ? ` Time windows are calendar-inclusive: "last month" means the previous calendar month, and a month-precision date at a window boundary counts rather than being dropped.` : '';
  const composeRule = (opts.composeCount && kind === 'tally')
    ? ` If the answer needs a derived value, first list the partial clues (a duration here, a quantity there), then COMPUTE the result; if exactly one component is genuinely absent, name the missing piece instead of guessing.` : '';
  // Answer completeness: when the source states distinguishing qualifiers,
  // include them ("The Linden Street Bakery on Morrow Road", not just
  // "the bakery").
  const fullAnswersRule = (opts.fullAnswers && (kind === 'lookup'))
    ? ` When the source states distinguishing qualifiers for the answer (a full name, the location, the venue), include them rather than a shortened form.` : '';
  const prompt = `Below is DaiDocs context: a manifest of stored files${profile ? ', the user profile' : ''}, and the most relevant material (${kind} read). A question follows at the end.\n\nCONTEXT:\n${ctx}\n\nQUESTION: ${question.text}\n${askedOn ? `Resolve relative dates against the asked-on date ${askedOn}. ` : ''}${COMMON_RULES}${opts.noOutside ? ' Answer ONLY from the provided context; do not use any outside knowledge or prior training knowledge about this subject.' : ''}${countActionsRule}${aggRules}${rollupRule}${categoryRule}${windowRule}${composeRule}${fullAnswersRule}${abstain ? ABSTAIN_RULE : ''}\n${style}`;
  const answer = await provider.complete({ prompt, maxTokens });
  return { answer, contextTokens: countTokens(prompt), pickedIds: picks.map(p => p.id), kind };
}

// Ingest factory. extraFields extends the extraction schema: this build asks
// for a per-fact "terms" list, and passing '' omits it.
function makeIngest(extraFields = '', promptAddendum = '', ingestOpts = {}) {
  return async function ingest(item, provider) {
    const text = cleanMd.clean(item.raw ?? item.text);
    const date = (item.capturedAt || '').slice(0, 10);
    const tagCand = candidateTags(text, 10);
    const u = await extractUnderstanding(text, provider, date, tagCand, extraFields, promptAddendum);
    const s = { summary: String(u.understanding.summary || sentences(text).slice(0, 2).join(' ')).replace(/\s+/g, ' ').slice(0, 300) };
    const segs = segment(text);
    const tags = u.understanding.tags && u.understanding.tags.length ? u.understanding.tags : tagCand.slice(0, 3);
    const fm = frontmatter(item, s.summary, segs.length, tags);
    const body = segs.map((sg, i) => `## [seg ${i + 1}/${segs.length}]\n${sg}`).join('\n\n');
    const file = `${fm.text}\n\n# Understanding\n\`\`\`json\n${JSON.stringify(u.understanding, null, 1)}\n\`\`\`\n\n# Content\n\n${body}\n`;
    const facts = normFacts(u.understanding, date);
    const attrs = facts.filter(f => f.kind === 'attribute').map(f => f.fact).slice(0, 4);
    const manifestLine = JSON.stringify({
      id: fm.id, path: `${fm.id}.dai`, type: item.type || 'doc', title: item.title, date,
      summary: s.summary, topics: (u.understanding.topics || []).slice(0, 8), entities: flatEntities(u.understanding), attrs, tags
    });
    const files = [
      { path: `${fm.id}.dai`, content: file },
      { path: `_index/manifest.jsonl`, content: manifestLine + '\n' }
    ];
    if (facts.length) {
      files.push({
        path: `_index/facts.jsonl`,
        // the terms field rides along only when the extraction produced it
        content: facts.map(f => JSON.stringify({ date: f.date, dated: f.dated, fact: f.fact.slice(0, 200), kind: f.kind, entities: flatEntities(u.understanding, 6), ...(f.terms ? { terms: f.terms } : {}), src: fm.id })).join('\n') + '\n'
      });
    }
    // Typed countable events, one row each. With nullDateStays an undated event stays
    // undated: re-stamping the session date would mis-date a past event being recounted.
    const events = (u.understanding.events || []).filter(ev => ev && ev.what)
      .map(ev => ({ date: /^\d{4}-\d{2}-\d{2}/.test(ev.date || '') ? ev.date.slice(0, 10) : (ingestOpts.nullDateStays ? null : (date || null)), cat: EVENT_CATS.includes(ev.cat) ? ev.cat : 'other', what: String(ev.what).slice(0, 80), src: fm.id }));
    if (events.length) files.push({ path: `_index/events.jsonl`, content: events.map(ev => JSON.stringify(ev)).join('\n') + '\n' });
    const prefs = (u.understanding.preferences || []).filter(x => typeof x === 'string').slice(0, 6);
    if (prefs.length) files.push({ path: `_index/profile.jsonl`, content: JSON.stringify({ date, preferences: prefs }) + '\n' });
    return { files, tokensIn: u.tokensIn, tokensOut: u.tokensOut, calls: 1 };
  };
}

module.exports = {
  id: 'daidocs-reader',
  version: '4.4',
  description: 'DaiDocs reader core: typed event table for counting (loaded on demand), candidate values shown rather than guessed, visible working for date arithmetic, scoped abstention.',
  ingestSignature: 'daidocs-4.4',
  answerMulti,
  ingest: makeIngest(''),
  makeIngest,

  async answer(question, store, provider) {
    const r = await answerMulti(question, store, provider, {});
    return { answer: r.answer, contextTokens: r.contextTokens, calls: 1 };
  }
};
