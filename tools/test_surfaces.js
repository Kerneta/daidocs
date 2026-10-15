// Unit and integration tests for:
//   1. Code-built selection surfaces (lib/derive/surfaces.js) & calendar resolver (lib/derive/calendar.js)
//   2. Reference-engine reader & ingest pipeline (lib/methods/daidocs-reader/method.js)
//   3. Anthropic provider prompt caching (cache_control), retry/backoff & token telemetry (lib/providers/anthropic.js)
//   4. Token budget chunking, context window pruning & cache economics (lib/tokens.js, lib/recall_cap.js)
// Pure functions and deterministic mock/stubbed calls: no network, no API keys.
// Run: node tools/test_surfaces.js
const assert = require('assert');
const s = require('../lib/derive/surfaces');
const cal = require('../lib/derive/calendar');
const reader = require('../lib/methods/daidocs-reader/method');
const mockProvider = require('../lib/providers/mock');
const anthropic = require('../lib/providers/anthropic');
const tokens = require('../lib/tokens');
const { capRecallContext } = require('../lib/recall_cap');

let n = 0;
let failed = 0;
const queue = [];
const ok = (name, fn) => queue.push({ name, fn });

// --- 1. Derived selection surfaces & calendar resolver ---
const store = {
  files: {
    '_index/events.jsonl':
      JSON.stringify({ date: '2023-05-01', cat: 'trip', what: 'weekend trip to the coast', src: 'a' }) + '\n' +
      JSON.stringify({ date: '2023-06-02', cat: 'purchase', what: 'bought a standing desk', src: 'b' }) + '\n',
    '_index/facts.jsonl':
      JSON.stringify({ date: '2023-05-01', fact: 'took a weekend trip to the coast', kind: 'event', src: 'a' }) + '\n' +
      JSON.stringify({ date: '2023-07-09', fact: 'attended a pottery workshop downtown', kind: 'event', src: 'c' }) + '\n' +
      JSON.stringify({ date: null, fact: 'has a nut allergy', kind: 'attribute', src: 'c' }) + '\n',
  },
};

ok('unionEvents merges events.jsonl with event-kind facts', () => {
  const u = s.unionEvents(store);
  assert.strictEqual(u.length, 3);
});
ok('unionEvents dedupes the same occurrence recorded in both sources', () => {
  const u = s.unionEvents(store);
  assert.strictEqual(u.filter(r => String(r.what).includes('trip to the coast')).length, 1);
});
ok('unionEvents never admits attribute facts as events', () => {
  const u = s.unionEvents(store);
  assert.ok(!u.some(r => String(r.what).includes('nut allergy')));
});
ok('unionEvents rows carry date, cat, what, src', () => {
  for (const r of s.unionEvents(store)) {
    assert.ok('date' in r && 'cat' in r && 'what' in r && 'src' in r);
  }
});

ok('trips route to the trip category', () =>
  assert.strictEqual(s.categoryOf('how many trips did I take last year'), 'trip'));
ok('spending questions route to purchase', () =>
  assert.strictEqual(s.categoryOf('how much did I spend on furniture'), 'purchase'));
ok('buying questions route to purchase', () =>
  assert.strictEqual(s.categoryOf('what did I buy'), 'purchase'));
ok('workouts route to workout', () =>
  assert.strictEqual(s.categoryOf('how many workouts this month'), 'workout'));
ok('concerts route to entertainment', () =>
  assert.strictEqual(s.categoryOf('list all the concerts I went to'), 'entertainment'));
ok('the word "order" in a sequencing question is NOT a purchase', () =>
  assert.strictEqual(s.categoryOf('what is the order of the six events I attended'), null));
ok('a question with no category words matches nothing', () =>
  assert.strictEqual(s.categoryOf('what is my middle name'), null));

const manyTrips = [
  { date: '2023-03-01', cat: 'trip', what: 'city break', src: 'a' },
  { date: '2023-05-01', cat: 'trip', what: 'coast weekend', src: 'b' },
  { date: '2023-08-15', cat: 'trip', what: 'mountain hike trip', src: 'c' },
];
ok('renderCategoryLog needs at least two rows in the category', () => {
  assert.strictEqual(s.renderCategoryLog(manyTrips.slice(0, 1), 'trip'), '');
});
ok('renderCategoryLog asserts completeness in its header', () => {
  const log = s.renderCategoryLog(manyTrips, 'trip');
  assert.ok(log.includes('COMPLETE'));
  assert.ok(log.includes('3 recorded'));
});
ok('renderCategoryLog is chronological and numbered', () => {
  const log = s.renderCategoryLog(manyTrips, 'trip');
  assert.ok(log.indexOf('1. 2023-03-01') < log.indexOf('2. 2023-05-01'));
  assert.ok(log.indexOf('2. 2023-05-01') < log.indexOf('3. 2023-08-15'));
});
ok('renderCategoryLog only shows the asked category', () => {
  const rows = [...manyTrips, { date: '2023-04-01', cat: 'purchase', what: 'new kettle', src: 'd' }];
  assert.ok(!s.renderCategoryLog(rows, 'trip').includes('kettle'));
});

ok('"last weekend" from a Monday is the immediately preceding Sat/Sun', () => {
  const w = cal.resolveExpression('what did I do last weekend', '2023-05-22');
  assert.ok(w && w.start === '2023-05-20' && w.end === '2023-05-21', JSON.stringify(w));
});
ok('"last month" is the previous calendar month', () => {
  const w = cal.resolveExpression('how many workouts last month', '2023-05-22');
  assert.ok(w && w.start.startsWith('2023-04-') && w.end.startsWith('2023-04-'), JSON.stringify(w));
});
ok('a question with no relative expression resolves to nothing', () => {
  assert.strictEqual(cal.resolveExpression('what is my dog called', '2023-05-22'), null);
});

// --- 2. Reference-engine reader & ingest unit tests (lib/methods/daidocs-reader/method.js) ---
function buildTestStore(items) {
  const files = {};
  for (const f of items) {
    if (f.path.startsWith('_index/')) {
      files[f.path] = (files[f.path] || '') + f.content;
    } else {
      files[f.path] = f.content;
    }
  }
  return { files };
}

ok('reader.ingest produces valid .dai frontmatter, Understanding JSON, Content segments, and index rows', async () => {
  const prov = mockProvider.create();
  const res = await reader.ingest({
    id: 'sess_1',
    sourceId: 'sess_1',
    title: 'Valletta booking and cycling gear',
    type: 'chat',
    app: 'daidocs',
    capturedAt: '2025-07-12T10:00:00Z',
    text: 'I booked a trip to Valletta on 2025-07-12 staying at Casa do Rio guesthouse. I prefer quiet boutique hotels and I bought a road helmet for $120.',
  }, prov);
  assert.strictEqual(res.calls, 1);
  assert.ok(res.tokensIn > 0 && res.tokensOut > 0);
  const daiFile = res.files.find(f => f.path.endsWith('.dai'));
  const manifestFile = res.files.find(f => f.path === '_index/manifest.jsonl');
  assert.ok(daiFile, 'missing .dai file');
  assert.ok(manifestFile, 'missing manifest.jsonl');
  assert.ok(/^daidocs: "4\.4"/m.test(daiFile.content));
  assert.ok(/# Understanding\n```json\n[\s\S]+?\n```/.test(daiFile.content));
  assert.ok(/## \[seg 1\/1\]/.test(daiFile.content));
  const mRow = JSON.parse(manifestFile.content.trim());
  assert.strictEqual(mRow.date, '2025-07-12');
  assert.strictEqual(mRow.path, daiFile.path);
});

ok('reader.makeIngest respects nullDateStays for undated events', async () => {
  const stubProv = {
    async complete() {
      return JSON.stringify({
        entities: { people: ['Alice'], orgs: [], dates: [], amounts: ['$45'], places: ['Rome'] },
        facts: [{ fact: 'Visited Rome museum', date: null, kind: 'event' }],
        events: [{ date: null, cat: 'trip', what: 'Visited Rome museum' }],
        preferences: ['prefers morning flights'],
        tags: ['x.general'],
        topics: ['rome', 'museum'],
        summary: 'User recounted an undated trip to Rome.',
        sentiment: 'positive',
      });
    },
  };
  const ingestStay = reader.makeIngest('', '', { nullDateStays: true });
  const rStay = await ingestStay({ id: 'u1', title: 'Rome note', capturedAt: '2025-08-01', text: 'Visited Rome museum.' }, stubProv);
  const evStay = JSON.parse(rStay.files.find(f => f.path === '_index/events.jsonl').content.trim());
  assert.strictEqual(evStay.date, null);

  const ingestStamp = reader.makeIngest('', '', { nullDateStays: false });
  const rStamp = await ingestStamp({ id: 'u1', title: 'Rome note', capturedAt: '2025-08-01', text: 'Visited Rome museum.' }, stubProv);
  const evStamp = JSON.parse(rStamp.files.find(f => f.path === '_index/events.jsonl').content.trim());
  assert.strictEqual(evStamp.date, '2025-08-01');
});

ok('reader.answerMulti fast-paths caller-declared summary, facts, and topics on narrow stores', async () => {
  const prov = mockProvider.create();
  const ing = await reader.ingest({
    id: 'doc1', title: 'Project Atlas kickoff', capturedAt: '2025-06-10',
    text: 'Alice and Bob launched Project Atlas in Berlin on 2025-06-10 with a budget of 5000 euros.',
  }, prov);
  const st = buildTestStore(ing.files);
  for (const kind of ['summary', 'facts', 'topics']) {
    const r = await reader.answerMulti({ text: `Give the ${kind}`, kind }, st, prov);
    assert.strictEqual(r.kind, kind);
    assert.strictEqual(r.pickedIds.length, 1);
    assert.ok(r.contextTokens > 0);
  }
});

ok('reader.answerMulti classifies lookup, tally, timeline, and advice questions accurately', async () => {
  const prompts = [];
  const spyProv = {
    async complete({ prompt, maxTokens }) {
      prompts.push({ prompt, maxTokens });
      return 'stub-answer';
    },
  };
  const prov = mockProvider.create();
  const ing = await reader.ingest({
    id: 's1', title: 'Fitness & travel', capturedAt: '2025-05-01',
    text: 'I went for a morning run on 2025-05-01 and bought running shoes for $140. I love trail running.',
  }, prov);
  const st = buildTestStore(ing.files);

  const rLookup = await reader.answerMulti({ text: 'Where did I store my passport?' }, st, spyProv);
  assert.strictEqual(rLookup.kind, 'lookup');
  assert.strictEqual(prompts.at(-1).maxTokens, 220);

  const rTally = await reader.answerMulti({ text: 'How many workouts did I do in May?' }, st, spyProv);
  assert.strictEqual(rTally.kind, 'tally');
  assert.strictEqual(prompts.at(-1).maxTokens, 400);

  const rTimeline = await reader.answerMulti({ text: 'When did I first buy running shoes?' }, st, spyProv);
  assert.strictEqual(rTimeline.kind, 'timeline');
  assert.strictEqual(prompts.at(-1).maxTokens, 400);

  const rAdvice = await reader.answerMulti({ text: 'What trail shoes would you recommend for me?' }, st, spyProv);
  assert.strictEqual(rAdvice.kind, 'advice');
  assert.strictEqual(prompts.at(-1).maxTokens, 350);

  const rWideAdvice = await reader.answerMulti(
    { text: 'Do you think it is worth buying a hydration vest?' },
    st,
    spyProv,
    { prefClassify: true }
  );
  assert.strictEqual(rWideAdvice.kind, 'advice');
});

ok('reader.answerMulti assembles event table, category purchases, priced facts, and superseded timeline', async () => {
  let lastPrompt = '';
  const spyProv = {
    async complete({ prompt }) {
      lastPrompt = prompt;
      return 'ANSWER: $210';
    },
  };
  const richStore = {
    files: {
      '_index/manifest.jsonl': [
        { id: 'doc_a', path: 'doc_a.dai', title: 'Gear shopping', date: '2025-03-10', summary: 'Bought cycling jersey', topics: ['cycling'], entities: ['Rapha'], attrs: [], tags: ['x.general'] },
        { id: 'doc_b', path: 'doc_b.dai', title: 'Bike upgrade', date: '2025-04-15', summary: 'Bought pedals', topics: ['cycling'], entities: ['Shimano'], attrs: [], tags: ['x.general'] },
      ].map(x => JSON.stringify(x)).join('\n') + '\n',
      '_index/events.jsonl': [
        { date: '2025-03-10', cat: 'purchase', what: 'bought Rapha jersey', src: 'doc_a' },
        { date: '2025-04-15', cat: 'purchase', what: 'bought Shimano pedals', src: 'doc_b' },
      ].map(x => JSON.stringify(x)).join('\n') + '\n',
      '_index/facts.jsonl': [
        { date: '2025-03-10', dated: true, fact: 'current home residence is Austin apartment', kind: 'attribute', entities: ['Austin'], src: 'doc_a' },
        { date: '2025-04-15', dated: true, fact: 'current home residence is Denver house', kind: 'attribute', entities: ['Denver'], src: 'doc_b' },
        { date: '2025-03-10', dated: true, fact: 'paid $90 for cycling jersey', kind: 'event', entities: [], src: 'doc_a' },
        { date: '2025-04-15', dated: true, fact: 'paid $120 for clipless pedals', kind: 'event', entities: [], src: 'doc_b' },
      ].map(x => JSON.stringify(x)).join('\n') + '\n',
      'doc_a.dai': `---\ndaidocs: "4.4"\nid: "doc_a"\n---\n\n# Understanding\n\`\`\`json\n{"summary":"Bought jersey"}\n\`\`\`\n\n# Content\n\n## [seg 1/1]\nPaid $90 for a cycling jersey while living in Austin.\n`,
      'doc_b.dai': `---\ndaidocs: "4.4"\nid: "doc_b"\n---\n\n# Understanding\n\`\`\`json\n{"summary":"Bought pedals"}\n\`\`\`\n\n# Content\n\n## [seg 1/1]\nPaid $120 for pedals after moving to Denver.\n`,
    },
  };

  await reader.answerMulti(
    { text: 'How much money did I spend on cycling purchases in total?' },
    richStore,
    spyProv,
    { categoryPull: true, coverageFloor: true }
  );
  assert.ok(lastPrompt.includes('# ALL recorded purchases'), 'missing category-matched purchases');
  assert.ok(lastPrompt.includes('# ALL facts with amounts'), 'missing priced facts section');
  assert.ok(lastPrompt.includes('# Every session, compact extracted facts'), 'missing small-store coverage floor');

  await reader.answerMulti(
    { text: 'When did my current home residence change and where did I live before versus after? (asked on 2025-05-01)' },
    richStore,
    spyProv,
    { calendarResolve: true, markPlans: true }
  );
  assert.ok(lastPrompt.includes('[SUPERSEDED by 2025-04-15 update]'), 'missing superseded marker on older attribute');
  assert.ok(lastPrompt.includes('# CANDIDATE VALUES'), 'missing candidate values block');
});

// --- 3. Anthropic Prompt Caching (cache_control), Retry/Backoff & Token Telemetry ---
ok('anthropic.buildCachedPayload skips cache_control on short prompts below minCacheChars', () => {
  const p = anthropic.buildCachedPayload({
    system: 'Short system.',
    prompt: 'Short user prompt.',
    minCacheChars: 1000,
  });
  assert.strictEqual(p.cacheBreakpoints, 0);
  assert.strictEqual(typeof p.system, 'string');
  assert.strictEqual(typeof p.messages[0].content, 'string');
});

ok('anthropic.buildCachedPayload places cache_control breakpoints on system, store prefix, and retrieved context', () => {
  const sys = 'S'.repeat(1200);
  const storeHeader = '# Manifest scan (20 stored files)\n' + '{"id":"doc_1","summary":"test"}\n'.repeat(45);
  const retrieved = '\n\n---\ndaidocs: "4.4"\n# Understanding\n' + 'U'.repeat(900);
  const question = '\n\nQUESTION: What happened in session 1?\nReply briefly.';
  const prompt = storeHeader + retrieved + question;

  const p = anthropic.buildCachedPayload({
    system: sys,
    prompt,
    minCacheChars: 1000,
  });
  assert.strictEqual(p.cacheBreakpoints, 3);
  assert.ok(Array.isArray(p.system));
  assert.deepStrictEqual(p.system[0].cache_control, { type: 'ephemeral' });
  const blocks = p.messages[0].content;
  assert.strictEqual(blocks.length, 3);
  assert.deepStrictEqual(blocks[0].cache_control, { type: 'ephemeral' });
  assert.deepStrictEqual(blocks[1].cache_control, { type: 'ephemeral' });
  assert.strictEqual(blocks[2].cache_control, undefined);
  assert.strictEqual(blocks.map(b => b.text).join(''), prompt);
});

ok('anthropic.buildCachedPayload respects cacheControl: false opt-out', () => {
  const longPrompt = 'A'.repeat(5000) + '\n\nQUESTION: test?';
  const p = anthropic.buildCachedPayload({ system: 'B'.repeat(5000), prompt: longPrompt, cacheControl: false });
  assert.strictEqual(p.cacheBreakpoints, 0);
  assert.strictEqual(typeof p.messages[0].content, 'string');
});

ok('anthropic provider records cache_creation_input_tokens & cache_read_input_tokens telemetry and retries 429/529', async () => {
  const calls = [];
  let callNum = 0;
  const mockFetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    callNum++;
    if (callNum === 1) {
      return {
        ok: false,
        status: 429,
        headers: { get: () => '0' },
        text: async () => 'rate limited',
      };
    }
    if (callNum === 2) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: 'text', text: 'First cached response' }],
          usage: { input_tokens: 150, output_tokens: 40, cache_creation_input_tokens: 2400, cache_read_input_tokens: 0 },
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ type: 'text', text: 'Second cache-hit response' }],
        usage: { input_tokens: 160, output_tokens: 35, cache_creation_input_tokens: 0, cache_read_input_tokens: 2400 },
      }),
    };
  };

  const prov = anthropic.create('claude-opus-5', {
    apiKey: 'test-key-not-real',
    fetchImpl: mockFetch,
    baseDelayMs: 1,
    minCacheChars: 500,
  });
  assert.strictEqual(prov.available(), true);

  const bigPrompt = 'Context prefix '.repeat(60) + '\n\nQUESTION: What is the status?';
  const out1 = await prov.complete({ prompt: bigPrompt, maxTokens: 300 });
  assert.strictEqual(out1, 'First cached response');
  const out2 = await prov.complete({ prompt: bigPrompt, maxTokens: 300 });
  assert.strictEqual(out2, 'Second cache-hit response');

  // Verify request payload carried ephemeral cache_control on the context block
  const sentBlocks = calls[0].body.messages[0].content;
  assert.ok(Array.isArray(sentBlocks));
  assert.deepStrictEqual(sentBlocks[0].cache_control, { type: 'ephemeral' });

  const stats = prov.getTelemetry();
  assert.strictEqual(stats.calls, 2);
  assert.strictEqual(stats.retries, 1);
  assert.strictEqual(stats.inputTokens, 310);
  assert.strictEqual(stats.outputTokens, 75);
  assert.strictEqual(stats.cacheCreationInputTokens, 2400);
  assert.strictEqual(stats.cacheReadInputTokens, 2400);
  assert.ok(stats.tokensSaved > 1500, `expected >1500 tokens saved, got ${stats.tokensSaved}`);
  assert.ok(stats.cacheHitRate > 0.4);

  prov.resetTelemetry();
  assert.strictEqual(prov.getTelemetry().calls, 0);
});

// --- 4. Token budget chunking, context window pruning & cache economics (lib/tokens.js & lib/recall_cap.js) ---
ok('tokens.chunkByTokenBudget splits multi-paragraph text and oversized single paragraphs within maxTokens', () => {
  const p1 = 'Paragraph one about project architecture and token budgets. '.repeat(30);
  const p2 = 'Paragraph two about retrieval evaluation and latency. '.repeat(30);
  const giantSinglePara = 'Sentence inside a single giant paragraph without double newlines. '.repeat(120);
  const input = `${p1}\n\n${p2}\n\n${giantSinglePara}`;

  const chunks = tokens.chunkByTokenBudget(input, { targetTokens: 300, maxTokens: 450, overlapTokens: 40 });
  assert.ok(chunks.length >= 4, `expected >=4 chunks, got ${chunks.length}`);
  for (const c of chunks) {
    const t = tokens.countTokens(c);
    assert.ok(t <= 500, `chunk exceeded budget: ${t} tokens`);
  }
});

ok('tokens.pruneContextWindow enforces strict token budget while keeping head and tail', () => {
  const lines = [];
  for (let i = 1; i <= 200; i++) {
    lines.push(`Line ${i}: recorded memory event and diagnostic details for session ${i}.`);
  }
  const full = lines.join('\n');
  assert.ok(tokens.countTokens(full) > 1500);

  const pruned = tokens.pruneContextWindow(full, { maxTokens: 400, headRatio: 0.6 });
  assert.ok(tokens.countTokens(pruned) <= 400, `pruned tokens ${tokens.countTokens(pruned)} > 400`);
  assert.ok(pruned.includes('Line 1:'), 'lost head line');
  assert.ok(pruned.includes('Line 200:'), 'lost tail line');
  assert.ok(pruned.includes('context pruned to fit token budget'), 'missing prune marker');
});

ok('tokens.estimatePromptCacheSavings calculates break-even and 90% cached read discount', () => {
  const below = tokens.estimatePromptCacheSavings({ uncachedTokens: 800, cachedPrefixTokens: 600, calls: 5 });
  assert.strictEqual(below.cacheable, false);
  assert.strictEqual(below.tokensSaved, 0);

  const multi = tokens.estimatePromptCacheSavings({ uncachedTokens: 10000, cachedPrefixTokens: 8000, calls: 10 });
  assert.strictEqual(multi.cacheable, true);
  assert.strictEqual(multi.uncachedTotalTokens, 100000);
  // 1st call: 2000 + 8000*1.25 = 12000; next 9 calls: 9 * (2000 + 800) = 25200 -> total 37200
  assert.strictEqual(multi.effectiveBilledTokens, 37200);
  assert.strictEqual(multi.tokensSaved, 62800);
  assert.strictEqual(multi.breakEvenCalls, 2);
});

ok('capRecallContext preserves structured sections when trimming a verbatim dump', () => {
  const structured = '# Manifest scan\nrow1\n\n# Event table\nev1';
  const dump = '# Complete original content\n' + 'verbatim content line\n'.repeat(400);
  const full = `${structured}\n\n${dump}`;
  const capped = capRecallContext(full, 500);
  assert.ok(capped.includes('# Manifest scan'));
  assert.ok(capped.includes('# Event table'));
  assert.ok(capped.includes('the structured sections above are intact'));
});

(async () => {
  for (const item of queue) {
    try {
      await item.fn();
      n++;
      console.log('  PASS  ' + item.name);
    } catch (err) {
      failed++;
      console.error('  FAIL  ' + item.name + ' -> ' + (err && err.stack ? err.stack : err));
    }
  }
  console.log(`\n${n} pass, ${failed} fail`);
  if (failed > 0) process.exit(1);
})();
