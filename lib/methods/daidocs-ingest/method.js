// DaiDocs ingest rules: what the observer writes, kept countable and correctly dated
// (topic-events banned, attributes/durations protected, tense/hedges preserved, relative
// anchors back-dated, long lists compressed). ingestSignature below is the CACHE IDENTITY
// (this prompt + store shape); ANY change to what ingest writes must bump it or a harness
// silently reuses stale stores. The "4.4" frontmatter format marker is separate.

const v19 = require('../daidocs-reader/method');

const V42_EXTRACTION = `
 CRITICAL v4.2 EXTRACTION RULES:
 (1) SWEEP FOR INCIDENTAL MILESTONES: extract EVERY dated first-person life event as its own event row even when it is a passing aside unrelated to the session's main topic: books/audiobooks/shows STARTED or FINISHED, free trials or subscriptions started/cancelled, purchases, attendance (weddings, festivals, church services, museums, concerts, classes), meetings or meals with NAMED people, and nth-occurrence statements ("my fourth session") each count. One sentence of evidence is enough.
 (2) EVENTS ARE THINGS THE USER DID OR EXPERIENCED: asking about, discussing, reading about, researching or learning about a topic is NEVER an event row. A conversation topic is not an occurrence.
 (3) PROPER NOUNS ARE SACRED: keep exact names of people, venues, events, brands and titles in facts, events and the summary ("The Linden Street Bakery", never "a local bakery"). The summary MUST name the session's most identifying entities.
 (4) DATE = WHEN IT HAPPENED: resolve relative phrases against the SOURCE DATE ("last Saturday" = the Saturday before it; "last month" / "N weeks ago" = the approximate earlier date, e.g. the prior month: NEVER the source date). Keep each time phrase adjacent to the verb it modifies. If the user recounts an OLDER event with only a vague anchor ("a few years ago", "back in college"), use null and keep the anchor words inside the fact text. A re-mention of an already-past event keeps its ORIGINAL date or null, never the session date. Something the user did TODAY ("I just got back from...", "I attended ... this afternoon") is a COMPLETED event dated the source date: never a future plan.
 (5) PLANS ARE NOT EVENTS, AND HEDGES STAY HEDGED: intentions, bookings, deadlines and selections-not-yet-acted-on ("I've chosen X and will order it") are kind "plan" with the target date in the text and the user's hedge words preserved. Never record a plan's deadline as an occurrence date. An INCIDENT (something broke, an accident, an illness) is its own event; a later repair/recovery/completion is a SEPARATE row: never merge them into one and never drop the incident.
 (6) DURABLE FACTS ARE NEVER CROWDED OUT: include up to 14 facts when needed: stated durations ("took two weeks", "for six weeks now"), health conditions, possessions and other durable attributes must survive alongside milestone events; include BOTH, never one at the other's expense.
 (7) ENUMERATED LISTS: when the source is dominated by a long list (many titles, items, options), extract the list's THEME as one fact plus only the items the user actually experienced/completed/rated as events: never one row per listed item. Entity lists contain ONLY meaningful non-null strings: never null placeholders, never one slot per list item. Output must remain valid, complete JSON within budget.`;


module.exports = {
  id: 'daidocs-ingest',
  version: '4.4',
  description: 'DaiDocs ingest: topic-event ban, crowd-protection, tense and hedge rules, relative-anchor resolution and enumerated-list handling. Writes stores with the 4.4 frontmatter marker (ingestSignature daidocs-4.4).',
  ingestSignature: 'daidocs-4.4.1',
  ingest: v19.makeIngest('', V42_EXTRACTION, { nullDateStays: true }),

};
