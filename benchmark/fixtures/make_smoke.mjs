#!/usr/bin/env node
// Deterministic generator for the local smoke fixture (benchmark/fixtures/smoke.json),
// in LongMemEval-S INPUT shape so benchmark/run_longmemeval.mjs reads it unchanged.
//
// This is NOT the real benchmark. It is a tiny synthetic corpus whose only job is to
// exercise the reader's retrieval and surfaces deterministically, with the mock actor
// and observer, so a change that silently moves recall@K or context size shows up for
// free on every run. Real accuracy still needs the paid LongMemEval-S run.
//
// Each question has exactly one gold session carrying a unique "needle"; the haystack is
// that gold session plus a fixed set of distractor sessions drawn from the other needles,
// so retrieval has to actually pick the right file out of several. Knowledge-update
// questions add a later session that supersedes the earlier value; the gold is the newer.
//
// Run: node benchmark/fixtures/make_smoke.mjs > benchmark/fixtures/smoke.json

// A small, deterministic PRNG so distractor selection is stable across machines.
let seed = 1234567;
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = (arr, n) => {
  const a = arr.slice(); const out = [];
  while (out.length < n && a.length) out.push(a.splice(Math.floor(rand() * a.length), 1)[0]);
  return out;
};

const turn = (role, content) => ({ role, content });

// 30 needles across the taxonomy areas. Each becomes one dated session with a
// distinctive fact a question can target. Keep content plain and specific.
const needles = [
  { k: 'job', date: '2026-01-06', text: 'I started as a backend engineer at Northwind Labs this week.', q: 'Where do I work?', a: 'Northwind Labs' },
  { k: 'pet', date: '2026-01-09', text: 'We adopted a border collie puppy named Pixel yesterday.', q: 'What is my dog called?', a: 'Pixel' },
  { k: 'car', date: '2026-01-13', text: 'I bought a used blue Mazda hatchback for the commute.', q: 'What car did I buy?', a: 'blue Mazda hatchback' },
  { k: 'passport', date: '2026-01-20', text: 'My passport expires on the 3rd of November and I must renew it before the trip.', q: 'When does my passport expire?', a: 'November 3' },
  { k: 'allergy', date: '2026-01-24', text: 'The doctor confirmed I am allergic to penicillin.', q: 'What am I allergic to?', a: 'penicillin' },
  { k: 'coffee', date: '2026-01-28', text: 'I really prefer a flat white over any filter coffee.', q: 'What coffee do I prefer?', a: 'flat white' },
  { k: 'gym', date: '2026-02-02', text: 'I joined the climbing gym on Fifth Street and go on Tuesdays.', q: 'Which day do I go climbing?', a: 'Tuesday' },
  { k: 'book', date: '2026-02-07', text: 'I finished reading Piranesi and loved it.', q: 'What book did I finish?', a: 'Piranesi' },
  { k: 'flight', date: '2026-02-11', text: 'My flight to Lisbon leaves at 7am on the 14th of March.', q: 'What time does my flight to Lisbon leave?', a: '7am' },
  { k: 'hotel', date: '2026-02-15', text: 'In Lisbon I am staying at the Casa do Rio guesthouse for five nights.', q: 'Where am I staying in Lisbon?', a: 'Casa do Rio' },
  { k: 'budget', date: '2026-02-19', text: 'I set a monthly grocery budget of 400 pounds.', q: 'What is my grocery budget?', a: '400 pounds' },
  { k: 'laptop', date: '2026-02-23', text: 'I ordered a 14 inch ThinkPad for work.', q: 'What laptop did I order?', a: '14 inch ThinkPad' },
  { k: 'language', date: '2026-02-27', text: 'I am learning Portuguese before the Lisbon trip.', q: 'What language am I learning?', a: 'Portuguese' },
  { k: 'dentist', date: '2026-03-03', text: 'My dentist appointment is booked for the 9th of April at 2pm.', q: 'When is my dentist appointment?', a: 'April 9 at 2pm' },
  { k: 'sister', date: '2026-03-07', text: 'My sister Dana is visiting from Berlin next month.', q: 'Who is visiting from Berlin?', a: 'my sister Dana' },
  { k: 'plant', date: '2026-03-11', text: 'I repotted the monstera into a bigger ceramic pot.', q: 'Which plant did I repot?', a: 'the monstera' },
  { k: 'guitar', date: '2026-03-15', text: 'I started weekly guitar lessons on Thursday evenings.', q: 'What instrument am I learning?', a: 'guitar' },
  { k: 'insurance', date: '2026-03-19', text: 'My home insurance renews on the 1st of June with Aviva.', q: 'Who is my home insurance with?', a: 'Aviva' },
  { k: 'bike', date: '2026-03-23', text: 'I bought an e-bike to ride along the canal path.', q: 'What did I buy to ride along the canal?', a: 'an e-bike' },
  { k: 'movie', date: '2026-03-27', text: 'We watched Arrival again and it held up.', q: 'What movie did we rewatch?', a: 'Arrival' },
  { k: 'course', date: '2026-04-02', text: 'I enrolled in a weekend pottery course at the arts centre.', q: 'What course did I enrol in?', a: 'pottery' },
  { k: 'phone', date: '2026-04-06', text: 'I switched my phone number to end in 4471.', q: 'What does my phone number end in?', a: '4471' },
  { k: 'restaurant', date: '2026-04-10', text: 'The best meal this year was at a small ramen place called Kuro.', q: 'What is the ramen place called?', a: 'Kuro' },
  { k: 'project', date: '2026-04-14', text: 'At work I am leading the billing migration project.', q: 'Which project am I leading?', a: 'the billing migration' },
  { k: 'marathon', date: '2026-04-18', text: 'I registered for the October half marathon.', q: 'What race did I register for?', a: 'the October half marathon' },
  { k: 'wine', date: '2026-04-22', text: 'I do not drink red wine, only white.', q: 'What wine do I drink?', a: 'white' },
  { k: 'house', date: '2026-04-26', text: 'We are moving to a flat in the Southville area in May.', q: 'Which area are we moving to?', a: 'Southville' },
  { k: 'camera', date: '2026-04-30', text: 'I picked up a secondhand Fujifilm X100 camera.', q: 'What camera did I pick up?', a: 'Fujifilm X100' },
  { k: 'charity', date: '2026-05-04', text: 'I volunteer monthly at the riverside food bank.', q: 'Where do I volunteer?', a: 'the riverside food bank' },
  { k: 'degree', date: '2026-05-08', text: 'I graduated with a degree in geology back in 2014.', q: 'What is my degree in?', a: 'geology' },
];

const idOf = (k, s) => `s_${k}_${s}`;
const sessionFor = (nd, suffix = 'a') => ({
  id: idOf(nd.k, suffix), date: nd.date,
  turns: [turn('user', nd.text), turn('assistant', 'Noted, I will remember that.')],
});

// Build the item list.
const items = [];
const allSessions = needles.map(nd => sessionFor(nd));
const sessionById = new Map(allSessions.map(s => [s.id, s]));

function haystackFor(goldSessions, nDistract = 6) {
  const goldIds = new Set(goldSessions.map(s => s.id));
  const distract = pick(allSessions.filter(s => !goldIds.has(s.id)), nDistract);
  const all = [...goldSessions, ...distract].sort((x, y) => x.date.localeCompare(y.date));
  return all;
}

function emit(qid, type, question, answer, goldSessions, askDate) {
  const hay = haystackFor(goldSessions);
  items.push({
    question_id: qid,
    question_type: type,
    question,
    question_date: askDate || '2026-05-20',
    answer,
    answer_session_ids: goldSessions.map(s => s.id),
    haystack_session_ids: hay.map(s => s.id),
    haystack_dates: hay.map(s => s.date),
    haystack_sessions: hay.map(s => s.turns),
  });
}

// 1. single-session-user: one per needle (30).
needles.forEach((nd, i) => emit(`ssu_${i}`, 'single-session-user', nd.q, nd.a, [sessionById.get(idOf(nd.k, 'a'))]));

// 2. single-session-assistant: ask what the assistant acknowledged (reuses the same gold) (15).
needles.slice(0, 15).forEach((nd, i) => emit(`ssa_${i}`, 'single-session-assistant',
  `What did you say when I mentioned ${nd.k}?`, 'I will remember that', [sessionById.get(idOf(nd.k, 'a'))]));

// 3. preference: the preference-flavoured needles (coffee, wine, book) plus generic (12).
const prefNeedles = needles.filter(n => ['coffee', 'wine', 'book', 'movie', 'restaurant', 'language'].includes(n.k));
prefNeedles.forEach((nd, i) => emit(`pref_${i}`, 'single-session-preference', nd.q, nd.a, [sessionById.get(idOf(nd.k, 'a'))]));

// 4. temporal-reasoning: dated questions over a needle (15).
needles.slice(0, 15).forEach((nd, i) => emit(`temp_${i}`, 'temporal-reasoning',
  `What is the date associated with my ${nd.k}?`, nd.date, [sessionById.get(idOf(nd.k, 'a'))]));

// 5. multi-session: combine two needles into one question (gold = both) (12).
for (let i = 0; i + 1 < 24; i += 2) {
  const a = needles[i], b = needles[i + 1];
  emit(`multi_${i}`, 'multi-session',
    `Tell me about both my ${a.k} and my ${b.k}.`, `${a.a} and ${b.a}`,
    [sessionById.get(idOf(a.k, 'a')), sessionById.get(idOf(b.k, 'a'))]);
}

// 6. knowledge-update: a value stated, then changed later; gold is the newer session (12).
const updates = [
  { k: 'job', old: 'Northwind Labs', neu: 'I changed jobs and now work at Fly.io.', date: '2026-05-10', q: 'Where do I work now?', a: 'Fly.io' },
  { k: 'coffee', old: 'flat white', neu: 'I switched my coffee order to an oat cortado.', date: '2026-05-11', q: 'What coffee do I order now?', a: 'oat cortado' },
  { k: 'car', old: 'Mazda', neu: 'I sold the Mazda and bought a grey Kia Niro.', date: '2026-05-12', q: 'What car do I drive now?', a: 'grey Kia Niro' },
  { k: 'phone', old: '4471', neu: 'I changed my phone number again, it now ends in 8820.', date: '2026-05-13', q: 'What does my phone number end in now?', a: '8820' },
  { k: 'hotel', old: 'Casa do Rio', neu: 'I rebooked Lisbon: now staying at the Alfama Loft instead.', date: '2026-05-14', q: 'Where am I staying in Lisbon now?', a: 'Alfama Loft' },
  { k: 'gym', old: 'Tuesdays', neu: 'I moved my climbing session to Fridays.', date: '2026-05-15', q: 'Which day do I go climbing now?', a: 'Friday' },
];
updates.forEach((up, i) => {
  const base = sessionById.get(idOf(up.k, 'a'));
  const newer = { id: idOf(up.k, 'u'), date: up.date, turns: [turn('user', up.neu), turn('assistant', 'Updated, got it.')] };
  allSessions.push(newer); sessionById.set(newer.id, newer);
  emit(`ku_${i}`, 'knowledge-update', up.q, up.a, [newer], up.date);
});

process.stdout.write(JSON.stringify(items, null, 0));
process.stderr.write(`generated ${items.length} questions over ${allSessions.length} sessions\n`);
