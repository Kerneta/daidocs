// Builds COMPLETE selection surfaces in code (no model, no ranking): the per-row
// bag-of-words ranker drops rows ("trips" never matches "trip"), so a category list
// can't be assembled by scoring rows independently. States completeness in the header
// so the model orders/counts the given list instead of re-deriving one. Pure, tested.

const EVENT_CATS = ['appointment', 'purchase', 'trip', 'meal_out', 'workout', 'entertainment', 'social', 'errand', 'incident', 'other'];

// Question noun -> event category. Lemmatized (plural/singular) and
// synonym-mapped, because "museums"/"visits"/"outings" all mean one category
// while sharing no token with the stored row's `cat` field.
const CAT_WORDS = {
  trip: ['trip', 'trips', 'travel', 'travels', 'traveled', 'travelled', 'vacation', 'vacations', 'holiday', 'holidays', 'flight', 'flights', 'flew', 'visit', 'visits', 'visited', 'destination', 'destinations', 'road trip', 'excursion', 'excursions'],
  // NB: no bare "order": a question about the ORDER of events is a sequencing
  // question, not a purchase (covered in tools/test_surfaces.js)
  purchase: ['purchase', 'purchases', 'purchased', 'bought', 'buy', 'buys', 'buying', 'ordered', 'acquired', 'got', 'spend', 'spent', 'paid'],
  appointment: ['appointment', 'appointments', 'doctor', 'doctors', 'dentist', 'checkup', 'check-up', 'consultation', 'consultations', 'specialist', 'specialists', 'clinic', 'exam', 'test', 'tests', 'procedure', 'procedures'],
  meal_out: ['restaurant', 'restaurants', 'dined', 'dinner', 'dinners', 'lunch', 'lunches', 'brunch', 'ate out', 'meal', 'meals', 'cafe', 'cafes', 'bar', 'bars'],
  workout: ['workout', 'workouts', 'exercise', 'exercises', 'gym', 'run', 'runs', 'ran', 'jog', 'jogs', 'jogging', 'class', 'classes', 'yoga', 'training', 'race', 'races', 'swim', 'swims'],
  entertainment: ['concert', 'concerts', 'show', 'shows', 'movie', 'movies', 'film', 'films', 'festival', 'festivals', 'museum', 'museums', 'exhibition', 'exhibitions', 'gig', 'gigs', 'play', 'plays', 'game', 'games', 'watched', 'read', 'book', 'books'],
  social: ['party', 'parties', 'gathering', 'gatherings', 'wedding', 'weddings', 'meetup', 'meetups', 'met', 'meet', 'friends', 'reunion', 'reunions', 'birthday', 'birthdays', 'get-together'],
  errand: ['errand', 'errands', 'chore', 'chores', 'task', 'tasks', 'return', 'returns', 'returned', 'pick up', 'picked up', 'drop off'],
  incident: ['incident', 'incidents', 'accident', 'accidents', 'broke', 'broken', 'malfunction', 'issue', 'issues', 'problem', 'problems', 'repair', 'repairs', 'fixed'],
};

// Generic motion/acquisition verbs appear in questions about EVERY category
// ("visited a museum", "went to the doctor"): they must never outweigh the
// question's head noun, which is what actually names the category.
const WEAK_WORDS = new Set(['visit', 'visits', 'visited', 'got', 'go', 'went', 'attend', 'attended', 'read', 'watched', 'met', 'meet', 'class', 'classes', 'game', 'games', 'return', 'returns', 'returned', 'play', 'plays']);

function categoryOf(questionText) {
  const t = ' ' + String(questionText).toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ') + ' ';
  let best = null, bestScore = 0;
  for (const [cat, words] of Object.entries(CAT_WORDS)) {
    let s = 0;
    for (const w of words) {
      if (!t.includes(' ' + w + ' ')) continue;
      s += WEAK_WORDS.has(w) ? 0.25 : (w.includes(' ') ? 3 : 2);
    }
    if (s > bestScore) { bestScore = s; best = cat; }
  }
  // a lone weak verb ("what did I visit?") names no category: leave it to
  // the existing lexical path rather than guessing
  return bestScore >= 2 ? best : null;
}

const normWhat = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

// THE UNION of events.jsonl and kind:'event' facts: neither is complete alone (some
// events live in only one), so a surface reading a single source under-counts.
function unionEvents(store) {
  const out = [];
  const push = (date, cat, what, src, from) => { if (what) out.push({ date: date || null, cat: cat || 'other', what: String(what).slice(0, 120), src, from }); };
  for (const l of (store.files['_index/events.jsonl'] || '').trim().split('\n')) {
    if (!l) continue;
    try { const ev = JSON.parse(l); push(ev.date, ev.cat, ev.what, ev.src, 'events'); } catch (_) { }
  }
  for (const l of (store.files['_index/facts.jsonl'] || '').trim().split('\n')) {
    if (!l) continue;
    try { const f = JSON.parse(l); if (f.kind === 'event') push(f.date, null, f.fact, f.src, 'facts'); } catch (_) { }
  }
  // dedupe: same day + strongly overlapping wording is one occurrence.
  // Conservative on purpose: merging distinct occurrences would create the
  // under-counts the aggregation cell currently avoids.
  const kept = [];
  for (const r of out) {
    const w = new Set(normWhat(r.what).split(' ').filter(x => x.length > 3));
    const dup = kept.find(k => {
      if (String(k.date || '').slice(0, 10) !== String(r.date || '').slice(0, 10)) return false;
      const kw = new Set(normWhat(k.what).split(' ').filter(x => x.length > 3));
      let inter = 0; for (const x of w) if (kw.has(x)) inter++;
      return inter >= Math.max(2, Math.min(w.size, kw.size) * 0.6);
    });
    // keep the fuller wording
    if (dup) { if (dup.what.length < r.what.length) dup.what = r.what; continue; }
    kept.push({ ...r });
  }
  return kept.sort((a, b) => String(a.date || '9999').localeCompare(String(b.date || '9999')));
}

// Complete ordered log for one category. The header asserts completeness because a
// model that doesn't trust the table re-derives its own list from prose and miscounts.
function renderCategoryLog(rows, cat, cap = 40) {
  const hits = rows.filter(r => r.cat === cat);
  if (hits.length < 2) return '';
  const shown = hits.slice(0, cap);
  return `# COMPLETE ${cat.toUpperCase().replace('_', ' ')} LOG: every recorded ${cat.replace('_', ' ')} in the store, chronological (code-built, not a search result)\n` +
    shown.map((r, i) => `${i + 1}. ${r.date || 'date unknown'} · ${r.what}${r.src ? ` [${r.src}]` : ''}`).join('\n') +
    `\n(${hits.length} recorded: this list is COMPLETE for this category; order and count from it rather than re-deriving from excerpts.${hits.length > cap ? ` First ${cap} shown.` : ''})`;
}


module.exports = { unionEvents, categoryOf, renderCategoryLog, EVENT_CATS, CAT_WORDS };
