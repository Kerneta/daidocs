// DaiDocs engine v4.4n.
//
// This is the configuration the release benchmark run measures. It is a
// thin wrapper: it selects the ingest, fixes the reader's feature set, and
// delegates. All of the behaviour lives in daidocs-reader and daidocs-ingest.
//
// The reader surfaces this configuration turns on, in one line each:
//   unionEvents()       events.jsonl combined with event-kind facts, deduped
//                       conservatively. Neither source is complete on its own.
//   categoryOf()        maps the question's head noun onto a stored event
//                       category, lemmatised and synonym-mapped, weighting head
//                       nouns above motion verbs ("visited", "went").
//   renderCategoryLog() the complete chronological log for that category, with
//                       a header asserting completeness, so the model orders and
//                       counts the list it is given rather than re-deriving one.
//
// Routing is the four-line regex classifier in daidocs-reader (classify()).
// No external router, and no model call other than the embedder used to
// shortlist the manifest scan and the answering model itself.

const reader = require('../daidocs-reader/method');
const ingest = require('../daidocs-ingest/method');

const FLAGS = { textFallback: true, categoryPull: true, countActions: true, scanEntities: true, scopedScan: true, wideScan: true, prefSpans: true, prefClassify: true, prefNoEcho: true, aggRules: true, semantic: true, anchorPrecision: true, leanScan: true, fullAnswers: true, anchorWide: true, markPlans: true, dropTopicRows: true, inferDates: true, legRule: true, rankTimeline: true, needleNoOffset: true, rollupCount: true, categoryGate: true, calendarWindow: true, composeCount: true, calendarResolve: true, scopedCategoryLog: true,
  // Small-store behaviour: always read thoroughly (no file-count gate) and read
  // all original content when the store fits roughly 25k tokens. Inert on large
  // multi-session stores, where the selective read is unchanged.
  wideGate: 0, fullContent: true, fullContentBudget: 25000 };

module.exports = {
  id: 'daidocs-v44n',
  version: '4.4n',
  description: 'DaiDocs v4.4n: calendar resolver, event canonicalization, and a category log scoped to ordering and single-fact reads. The configuration the release benchmark run measures.',
  ingestSignature: 'daidocs-4.4.1',
  ingest: ingest.ingest,

  async answerMulti(question, store, provider, opts = {}) {
    return reader.answerMulti(question, store, provider, { ...opts, ...FLAGS });
  },
  async answer(question, store, provider) {
    const r = await module.exports.answerMulti(question, store, provider, {});
    return { answer: r.answer, contextTokens: r.contextTokens, calls: r.calls || 1 };
  },
};
