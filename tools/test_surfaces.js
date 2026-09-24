// Unit tests for the code-built selection surfaces (lib/derive/surfaces.js)
// and the calendar resolver (lib/derive/calendar.js). Pure functions, no
// network, no model calls. Run: node tools/test_surfaces.js
const assert = require('assert');
const s = require('../lib/derive/surfaces');
const cal = require('../lib/derive/calendar');
const reader = require('../lib/methods/daidocs-reader/method');

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log('  PASS  ' + name); };

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
  // 2023-05-22 is a Monday; the preceding weekend is May 20-21.
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

// markSuperseded: an update is almost never worded like the fact it replaces, so the
// chain rule has to survive rewording without merging two unrelated subjects.
const deployFacts = () => [
  { date: '2026-06-10', fact: 'The Northwind API is deployed on Heroku', kind: 'attribute', entities: ['Northwind'] },
  { date: '2026-09-15', fact: 'The Northwind API moved off Heroku and now runs on Fly.io', kind: 'attribute', entities: ['Northwind'] },
];

ok('a reworded update supersedes the fact it replaces', () => {
  const out = reader.markSuperseded(deployFacts());
  assert.strictEqual(out[0].superseded, '2026-09-15');
});
ok('the newest fact in a chain is never marked superseded', () => {
  const out = reader.markSuperseded(deployFacts());
  assert.strictEqual(out[1].superseded, undefined);
});
ok('shared vocabulary alone does not chain two different subjects', () => {
  const out = reader.markSuperseded([
    ...deployFacts(),
    { date: '2026-07-01', fact: 'The office coffee machine is covered in Heroku stickers', kind: 'attribute', entities: ['Office'] },
  ]);
  assert.strictEqual(out[2].superseded, undefined);
});
ok('a lone fact is left alone', () => {
  const out = reader.markSuperseded([deployFacts()[0]]);
  assert.strictEqual(out[0].superseded, undefined);
});
ok('event-kind facts never form a supersede chain', () => {
  const out = reader.markSuperseded([
    { date: '2026-06-10', fact: 'Deployed the Northwind API to Heroku', kind: 'event', entities: ['Northwind'] },
    { date: '2026-09-15', fact: 'Moved the Northwind API from Heroku to Fly.io', kind: 'event', entities: ['Northwind'] },
  ]);
  assert.ok(out.every(f => f.superseded === undefined));
});

console.log(`\n${n} pass, 0 fail`);
