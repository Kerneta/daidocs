// Deterministic calendar resolution for relative expressions ("last weekend", "two
// weeks ago", "last month", holidays) that a model reading a long context resolves
// unreliably. Pure and unit-testable: no model calls. Weeks are Mon..Sun (ISO); "last
// weekend" from a Monday is the immediately preceding Sat/Sun (2 days back, not nine) —
// getting it wrong back-dates an event by a week.

const DAY = 86400000;
const iso = d => new Date(d).toISOString().slice(0, 10);
const parse = s => new Date(String(s).slice(0, 10) + 'T00:00:00Z');
const addDays = (d, n) => new Date(parse(d).getTime() + n * DAY);
// JS: 0=Sun..6=Sat. ISO weekday: 1=Mon..7=Sun.
const isoDow = d => (parse(d).getUTCDay() + 6) % 7 + 1;

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const DOWS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const NUMWORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, couple: 2, few: 3 };

// Fixed-date holidays only (movable feasts are deliberately excluded: a
// wrong date is worse than none).
const HOLIDAYS = {
  "valentine's day": [2, 14], 'valentines day': [2, 14], 'christmas': [12, 25], 'christmas day': [12, 25],
  'christmas eve': [12, 24], "new year's day": [1, 1], 'new years day': [1, 1], "new year's eve": [12, 31],
  'halloween': [10, 31], "independence day": [7, 4], 'fourth of july': [7, 4], 'july 4th': [7, 4],
  "st patrick's day": [3, 17], 'st patricks day': [3, 17], 'boxing day': [12, 26], 'juneteenth': [6, 19],
};

function holidayDate(text, year) {
  const t = String(text).toLowerCase();
  for (const [name, [m, d]] of Object.entries(HOLIDAYS)) {
    if (t.includes(name)) return `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return null;
}

// Resolve ONE relative expression against an anchor date.
// Returns {label, start, end, kind}: an inclusive [start,end] window.
function resolveExpression(text, anchorISO) {
  if (!anchorISO) return null;
  const t = String(text).toLowerCase();
  const A = iso(parse(anchorISO));
  // 1=Mon..7=Sun
  const dow = isoDow(A);

  // "yesterday" / "today"
  if (/\byesterday\b/.test(t)) { const d = iso(addDays(A, -1)); return { label: 'yesterday', start: d, end: d, kind: 'day' }; }
  if (/\btoday\b/.test(t)) return { label: 'today', start: A, end: A, kind: 'day' };

  // "last weekend" = the Sat/Sun before this week's Monday; if the anchor is itself
  // Sat/Sun, the previous weekend is 7 days earlier.
  if (/\blast weekend\b|\bthis past weekend\b|\bover the weekend\b/.test(t)) {
    const mondayOfThisWeek = addDays(A, -(dow - 1));
    let sat = addDays(iso(mondayOfThisWeek), -2), sun = addDays(iso(mondayOfThisWeek), -1);
    // anchor is Sat/Sun
    if (dow >= 6) { sat = addDays(A, -(dow - 6) - 7); sun = addDays(iso(sat), 1); }
    return { label: 'last weekend', start: iso(sat), end: iso(sun), kind: 'window' };
  }

  // "last <weekday>" / "on <weekday>"
  const dowHit = DOWS.findIndex(d => new RegExp(`\\b(last |this past |on )?${d}\\b`).test(t));
  if (dowHit >= 0 && /\blast |this past /.test(t)) {
    const target = dowHit + 1;
    let back = dow - target; if (back <= 0) back += 7;
    const d = iso(addDays(A, -back));
    return { label: `last ${DOWS[dowHit]}`, start: d, end: d, kind: 'day' };
  }

  // "N days/weeks/months ago" (numeric or word), plus "a week ago"
  const agoM = t.match(/\b(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|couple|few)\s+(day|week|month|year)s?\s+ago\b/);
  if (agoM) {
    const n = /^\d+$/.test(agoM[1]) ? parseInt(agoM[1], 10) : (NUMWORDS[agoM[1]] || 1);
    const unit = agoM[2];
    const mult = unit === 'day' ? 1 : unit === 'week' ? 7 : unit === 'month' ? 30 : 365;
    const center = iso(addDays(A, -n * mult));
    // tolerance: exact for days, ±3d for weeks, ±10d for months/years
    const tol = unit === 'day' ? 0 : unit === 'week' ? 3 : 10;
    return { label: `${agoM[1]} ${unit}${n === 1 ? '' : 's'} ago`, start: iso(addDays(center, -tol)), end: iso(addDays(center, tol)), kind: 'window' };
  }

  // "last month/week/year": the previous calendar unit
  if (/\blast month\b/.test(t)) {
    // getUTCMonth is 0-based
    const d = parse(A); const y = d.getUTCFullYear(), m = d.getUTCMonth();
    const pm = m === 0 ? 11 : m - 1, py = m === 0 ? y - 1 : y;
    const start = `${py}-${String(pm + 1).padStart(2, '0')}-01`;
    const end = iso(new Date(Date.UTC(py, pm + 1, 0)));
    return { label: 'last month', start, end, kind: 'window' };
  }
  if (/\blast week\b/.test(t)) {
    const mondayOfThisWeek = addDays(A, -(dow - 1));
    const start = iso(addDays(iso(mondayOfThisWeek), -7));
    return { label: 'last week', start, end: iso(addDays(start, 6)), kind: 'window' };
  }
  if (/\blast year\b/.test(t)) {
    const y = parse(A).getUTCFullYear() - 1;
    return { label: 'last year', start: `${y}-01-01`, end: `${y}-12-31`, kind: 'window' };
  }

  // "in <month>" (the anchor's year, or the previous year if that month is
  // still ahead of the anchor)
  const monHit = MONTHS.findIndex(m => new RegExp(`\\b(in |last |during )${m}\\b`).test(t));
  if (monHit >= 0) {
    const d = parse(A); let y = d.getUTCFullYear();
    if (monHit > d.getUTCMonth()) y -= 1;
    const start = `${y}-${String(monHit + 1).padStart(2, '0')}-01`;
    const end = iso(new Date(Date.UTC(y, monHit + 1, 0)));
    return { label: MONTHS[monHit], start, end, kind: 'window' };
  }

  // holidays: anchored to the anchor's year, or the previous year if the
  // holiday has not happened yet relative to the anchor
  const y0 = parse(A).getUTCFullYear();
  let hd = holidayDate(t, y0);
  if (hd) {
    if (hd > A) hd = holidayDate(t, y0 - 1);
    return { label: (t.match(new RegExp(Object.keys(HOLIDAYS).join('|'))) || ['holiday'])[0], start: hd, end: hd, kind: 'day' };
  }
  return null;
}

// Does an event row's date fall inside the resolved window? Rows dated by
// month precision ("2023-04") count if the month overlaps the window.
function inWindow(rowDate, win) {
  if (!rowDate || !win) return false;
  const d = String(rowDate).slice(0, 10);
  if (d.length === 7) return d >= win.start.slice(0, 7) && d <= win.end.slice(0, 7);
  return d >= win.start && d <= win.end;
}

// The prompt block: what the expression resolves to, and which stored rows
// land inside it. `rows` = [{date, what, src, kind}] from the union surface.
function renderResolution(win, rows, anchorISO) {
  if (!win) return '';
  const hits = rows.filter(r => inWindow(r.date, win));
  const head = `# RESOLVED TIME WINDOW (computed, not inferred)\n"${win.label}" relative to the asked-on date ${anchorISO} = ${win.start}${win.end !== win.start ? ` .. ${win.end}` : ''}`;
  if (!hits.length) return `${head}\n(no stored event falls inside this window: if the answer requires one, say the information is not recorded.)`;
  return `${head}\nStored events inside this window:\n` +
    hits.slice(0, 12).map(r => `- ${r.date} · ${r.what}${r.src ? ` [${r.src}]` : ''}`).join('\n');
}

module.exports = { resolveExpression, holidayDate, inWindow, renderResolution, isoDow };
