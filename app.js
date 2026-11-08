// app.js — Domino's SMS dashboard. Receives a data adapter (Firebase or mock).
import {
  STREAMS, FAIL_CATS, PERMANENT_CATS, CsvStream, DayAggregator, sumDays,
  parseShardsInto, frequencyStats, phoneHash, safeKey,
} from './sms-core.js';

// ============ small utilities ============
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const NF = new Intl.NumberFormat('he-IL');
const fN = (x) => (x == null || !isFinite(x) ? '—' : NF.format(Math.round(x)));
const fD = (x, d = 1) => (x == null || !isFinite(x) ? '—' : x.toLocaleString('he-IL', { minimumFractionDigits: d, maximumFractionDigits: d }));
const fP = (x, d = 1) => (x == null || !isFinite(x) ? '—' : (x * 100).toLocaleString('he-IL', { minimumFractionDigits: d, maximumFractionDigits: d }) + '%');
const fM = (x) => (x == null || !isFinite(x) ? '—' : '₪' + x.toLocaleString('he-IL', { maximumFractionDigits: x < 100 ? 2 : 0 }));
const div = (a, b) => (b ? a / b : null);
const sum = (arr) => arr.reduce((a, b) => a + b, 0);

const dUTC = (iso) => new Date(iso + 'T00:00:00Z');
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = dUTC(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const addYears = (s, n) => { const d = dUTC(s); d.setUTCFullYear(d.getUTCFullYear() + n); return iso(d); };
const daysBetween = (a, b) => Math.round((dUTC(b) - dUTC(a)) / 864e5);
const fmtDate = (s) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : '—');
const DOW = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const dowOf = (s) => dUTC(s).getUTCDay();
const unsafe = (k) => String(k).replace(/\u2024/g, '.').replace(/\u2215/g, '/');

function pearson(xs, ys) {
  const pts = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => isFinite(x) && isFinite(y) && x != null && y != null);
  if (pts.length < 5) return null;
  const n = pts.length, mx = sum(pts.map((p) => p[0])) / n, my = sum(pts.map((p) => p[1])) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pts) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

// ============ state ============
const S = {
  db: null, user: null, view: 'conclusions', stream: 'survey',
  days: { survey: [], marketing: [] }, settings: {}, responses: [], insights: [], dailyInsights: [],
  A: null, B: null, cmp: 'yoy', preset: '92', freqCache: new Map(), charts: [],
};

const defaultSettings = { price: 0.005, billing: 'segment', testNumbers: [] };

// ============ data access ============
const daysOf = (stream) => S.days[stream] || [];
const range = (stream, from, to) => daysOf(stream).filter((d) => d.date >= from && d.date <= to);
const lastDate = (stream) => daysOf(stream).at(-1)?.date || null;
const firstDate = (stream) => daysOf(stream)[0]?.date || null;
const totals = (stream, p) => (p ? sumDays(range(stream, p.from, p.to)) : null);
const testSet = () => new Set((S.settings.testNumbers || []).map((t) => t.hash));

function cost(T) {
  const price = +S.settings.price || 0;
  if (!T) return null;
  return S.settings.billing === 'message' ? (T.n - T.b) * price : T.seg * price;
}

function metrics(T, stream, p) {
  if (!T || !T.n) return null;
  const nb = T.n - T.b;
  const calDays = p ? daysBetween(p.from, p.to) + 1 : T.days;
  const m = {
    n: T.n, d: T.d, b: T.b, f: T.f, p: T.p, seg: T.seg,
    dRate: div(T.d, T.n), bRate: div(T.b, T.n), fRate: div(T.f, T.n), pRate: div(T.p, T.n),
    segPerMsg: div(T.seg, T.n), seg2Share: div(T.seg2, nb), seg3Share: div(T.seg3 || 0, nb), cost: cost(T),
    perDay: div(T.n, calDays), daysActive: T.days, calDays,
    expired10k: div((T.failCat.expired || 0) * 1e4, T.n),
    permanent: sum(PERMANENT_CATS.map((c) => T.failCat[c] || 0)),
    multi: T.multi, gaps1h: T.gaps1h, custDaily: T.cust, groupsCount: Object.keys(T.groups).length,
  };
  if (stream === 'survey') {
    const sv = T.groups['סקר'] || { n: 0, d: 0, b: 0 };
    const rm = T.groups['תזכורת לסקר'] || { n: 0, d: 0, b: 0 };
    m.surveys = sv.n; m.reminders = rm.n; m.rem100 = div(rm.n * 100, sv.n);
    m.surveyD = div(sv.d, sv.n); m.surveyB = div(sv.b, sv.n);
    const gift = sum(Object.entries(T.variants).filter(([k]) => k.includes('מתנה')).map(([, v]) => v.n));
    m.giftShare = div(gift, sv.n);
  }
  return m;
}

const METRICS = [
  { k: 'n', label: 'הודעות שנשלחו', f: 'n' },
  { k: 'surveys', label: 'סקרים', f: 'n', only: 'survey' },
  { k: 'reminders', label: 'תזכורות לסקר', f: 'n', only: 'survey' },
  { k: 'rem100', label: 'תזכורות לכל 100 סקרים', f: '1', only: 'survey' },
  { k: 'groupsCount', label: 'קמפיינים', f: 'n', only: 'marketing' },
  { k: 'perDay', label: 'ממוצע הודעות ליום', f: 'n' },
  { k: 'd', label: 'התקבלו', f: 'n' },
  { k: 'surveyD', label: 'שיעור מסירה בסקרים', f: 'p', good: 1, only: 'survey' },
  { k: 'dRate', label: 'שיעור מסירה (כל ההודעות)', f: 'p', good: 1 },
  { k: 'surveyB', label: 'שיעור חסימה בסקרים', f: 'p', good: -1, only: 'survey' },
  { k: 'bRate', label: 'שיעור חסימה (כל ההודעות)', f: 'p', good: -1 },
  { k: 'fRate', label: 'שיעור כשל טכני', f: 'p2', good: -1 },
  { k: 'expired10k', label: 'פג תוקף לכל 10,000 הודעות', f: '1', good: -1 },
  { k: 'permanent', label: 'כשלים קבועים (מספר לא קיים / חסום אצל המפעיל)', f: 'n', good: -1 },
  { k: 'pRate', label: 'ללא סטטוס מסירה סופי', f: 'p2', good: -1 },
  { k: 'seg', label: 'מקטעים לחיוב', f: 'n', good: -1 },
  { k: 'segPerMsg', label: 'מקטעים להודעה', f: '2', good: -1 },
  { k: 'seg2Share', label: 'הודעות של 2 מקטעים ומעלה', f: 'p', good: -1, only: 'survey' },
  { k: 'seg3Share', label: 'הודעות של 3 מקטעים ומעלה', f: 'p', good: -1, only: 'marketing' },
  { k: 'giftShare', label: 'סקרים עם שורת מתנה', f: 'p', only: 'survey' },
  { k: 'cost', label: 'עלות משוערת', f: 'm', good: -1 },
  { k: 'multi', label: 'מקרים שבהם לקוח קיבל 2+ הודעות ביום', f: 'n', good: -1 },
  { k: 'gaps1h', label: 'הודעות בהפרש של פחות משעה לאותו לקוח', f: 'n', good: -1 },
];
const isRate = (f) => f === 'p' || f === 'p2';
function fmtVal(v, f) {
  if (f === 'p') return fP(v); if (f === 'p2') return fP(v, 2); if (f === 'm') return fM(v);
  if (f === '1') return fD(v, 1); if (f === '2') return fD(v, 2); return fN(v);
}
function deltaCell(a, b, f, good) {
  if (a == null || b == null || !isFinite(a) || !isFinite(b)) return '<td class="num muted">—</td>';
  let txt, diff;
  if (isRate(f)) { diff = (a - b) * 100; txt = (diff > 0 ? '+' : '') + fD(diff, f === 'p2' ? 2 : 1) + ' נק׳'; }
  else { if (!b) return `<td class="num muted">${a ? 'חדש' : '—'}</td>`; diff = a / b - 1; txt = (diff > 0 ? '+' : '') + fD(diff * 100, 1) + '%'; }
  const thr = isRate(f) ? 0.3 : 0.03;
  let cls = 'muted';
  if (good && Math.abs(diff) >= thr) cls = Math.sign(diff) === good ? 'good' : 'bad';
  return `<td class="num ${cls}">${txt}</td>`;
}

// ============ periods ============
function initPeriod() {
  const last = lastDate(S.stream);
  if (!last) { S.A = null; S.B = null; return; }
  applyPreset(S.preset, last);
}
function applyPreset(preset, last = lastDate(S.stream)) {
  if (!last) return;
  S.preset = preset;
  const first = firstDate(S.stream);
  const len = { '1': 1, '7': 7, '30': 30, '92': 92 }[preset];
  if (len) S.A = { from: addDays(last, -(len - 1)), to: last };
  else if (preset === 'all') S.A = { from: first, to: last };
  computeB();
}
function computeB() {
  if (!S.A) return;
  const len = daysBetween(S.A.from, S.A.to) + 1;
  if (S.cmp === 'prev') S.B = { from: addDays(S.A.from, -len), to: addDays(S.A.from, -1) };
  else if (S.cmp === 'yoy') S.B = { from: addYears(S.A.from, -1), to: addYears(S.A.to, -1) };
  else if (S.cmp === 'none') S.B = null;
  else if (!S.B) S.B = { from: addDays(S.A.from, -len), to: addDays(S.A.from, -1) };
}
const pLabel = (p) => (p ? (p.from === p.to ? fmtDate(p.from) : `${fmtDate(p.from)}–${fmtDate(p.to)}`) : '');

// ============ charts ============
function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
function chart(canvas, cfg) {
  if (!window.Chart || !canvas) return null;
  const c = new window.Chart(canvas, cfg); S.charts.push(c); return c;
}
function destroyCharts() { S.charts.forEach((c) => c.destroy && c.destroy()); S.charts = []; }
function baseOpts(extra = {}) {
  return {
    responsive: true, maintainAspectRatio: false, animation: false,
    locale: 'he-IL',
    plugins: { legend: { rtl: true, labels: { color: css('--ink'), boxWidth: 12, font: { family: 'Assistant' } } },
      tooltip: { rtl: true, textDirection: 'rtl', bodyFont: { family: 'Assistant' }, titleFont: { family: 'Assistant' } } },
    scales: {
      x: { ticks: { color: css('--muted'), font: { family: 'Assistant' } }, grid: { color: css('--grid') } },
      y: { ticks: { color: css('--muted'), font: { family: 'Assistant' } }, grid: { color: css('--grid') }, beginAtZero: true },
    },
    ...extra,
  };
}
const colA = () => css('--blue'), colB = () => css('--b-series');

// ============ insights ============
function ins(level, text) { return { level, text }; }
function periodInsights(stream, A, B, mA, mB) {
  const out = [];
  if (!mA) return [ins('info', 'אין נתונים לתקופה שנבחרה. אפשר לבחור תקופה אחרת או לייבא קבצים בלשונית "ייבוא והגדרות".')];
  const TA = totals(stream, A);
  const lbB = B ? `לעומת ${pLabel(B)}` : '';
  if (mB) {
    const ch = mA.n / mB.n - 1;
    if (Math.abs(ch) >= 0.1) out.push(ins('info', `נשלחו ${fN(mA.n)} הודעות, ${fD(Math.abs(ch) * 100, 1)}% ${ch > 0 ? 'יותר' : 'פחות'} ${lbB}.`));
    if (stream === 'survey' && mB.surveys) {
      const cs = mA.surveys / mB.surveys - 1;
      if (Math.abs(cs) >= 0.1) out.push(ins(cs < 0 ? 'warn' : 'info', `מספר הסקרים ${cs < 0 ? 'ירד' : 'עלה'} ב־${fD(Math.abs(cs) * 100, 1)}%. ${cs < 0 ? 'כדאי לבדוק מול נתוני ההזמנות שכל ההזמנות הזכאיות מקבלות סקר.' : ''}`));
    }
    const [dk, bk, what] = stream === 'survey' && mB.surveys ? ['surveyD', 'surveyB', ' של הסקרים'] : ['dRate', 'bRate', ''];
    const dd = (mA[dk] - mB[dk]) * 100;
    if (Math.abs(dd) >= 1) out.push(ins(dd > 0 ? 'good' : 'bad', `שיעור המסירה${what} ${dd > 0 ? 'עלה' : 'ירד'} מ־${fP(mB[dk])} ל־${fP(mA[dk])}.`));
    const db = (mA[bk] - mB[bk]) * 100;
    if (Math.abs(db) >= 1) out.push(ins(db < 0 ? 'good' : 'bad', `שיעור החסימה${what} ${db < 0 ? 'ירד' : 'עלה'} מ־${fP(mB[bk])} ל־${fP(mA[bk])}.`));
    if (mA.expired10k > 5 && mA.expired10k > mB.expired10k * 1.5) out.push(ins('bad', `הודעות שפג תוקפן עלו מ־${fD(mB.expired10k)} ל־${fD(mA.expired10k)} לכל 10,000 הודעות.`));
    const sp = mA.segPerMsg / mB.segPerMsg - 1;
    if (Math.abs(sp) >= 0.05) out.push(ins(sp > 0 ? 'bad' : 'good', `ההודעות ${sp > 0 ? 'התארכו' : 'התקצרו'}: מ־${fD(mB.segPerMsg, 2)} ל־${fD(mA.segPerMsg, 2)} מקטעים להודעה. העלות ${sp > 0 ? 'עלתה' : 'ירדה'} בהתאם${S.settings.price ? ` (${fM(mA.cost)} לעומת ${fM(mB.cost)})` : ''}.`));
    if (stream === 'survey' && mA.rem100 != null && mB.rem100 != null && Math.abs(mA.rem100 - mB.rem100) >= 5)
      out.push(ins('info', `תזכורות: ${fD(mA.rem100)} לכל 100 סקרים, ובתקופת ההשוואה ${fD(mB.rem100)}.`));
  }
  if (stream === 'survey' && mA.seg2Share > 0.2) out.push(ins('warn', `${fP(mA.seg2Share)} מהסקרים והתזכורות (ללא חסומים) הם 2 מקטעים ומעלה. קיצור הנוסח למקטע אחד יוזיל משמעותית.`));
  if (stream === 'marketing' && mA.seg3Share > 0.1) out.push(ins('warn', `${fP(mA.seg3Share)} מההודעות הן 3 מקטעים ומעלה (ממוצע ${fD(mA.segPerMsg, 2)} מקטעים להודעה). קיצור פסקאות התנאים יוזיל משמעותית.`));
  if (mA.fRate > 0.01) out.push(ins('bad', `שיעור הכשל הטכני ${fP(mA.fRate, 2)} — גבוה. הסיבה המובילה: ${esc(FAIL_CATS[topKey(TA.failCat, ['blocked', 'pending'])] || '—')}.`));
  if (mA.permanent > 50) out.push(ins('warn', `${fN(mA.permanent)} הודעות נכשלו בגלל מספר לא קיים או חסום אצל המפעיל. את המספרים האלה כדאי להסיר מהרשימה.`));
  if (mA.pRate > 0.01) out.push(ins('info', `${fP(mA.pRate)} מההודעות עדיין ללא סטטוס מסירה סופי — כנראה שהדוח הופק לפני שהתקבלו כל האישורים.`));
  if (mA.multi > 0 && mA.custDaily && mA.multi / mA.custDaily > 0.02) out.push(ins('warn', `ב־${fN(mA.multi)} מקרים לקוח קיבל יותר מהודעה אחת באותו יום (${fP(mA.multi / mA.custDaily)} מימי־הלקוח).`));
  if (mA.gaps1h > 100) out.push(ins('warn', `${fN(mA.gaps1h)} הודעות הגיעו לאותו לקוח פחות משעה אחרי הודעה קודמת.`));
  if (stream === 'marketing') {
    const g = Object.entries(TA.groups).sort((a, b) => b[1].seg - a[1].seg)[0];
    if (g) out.push(ins('info', `הקמפיין היקר ביותר: ${esc(unsafe(g[0]))} — ${fP(g[1].seg / TA.seg)} מהמקטעים, ${fD(g[1].seg / g[1].n, 2)} מקטעים להודעה.`));
  }
  const missing = missingDays(stream, A);
  if (stream === 'survey' && missing.length && missing.length <= 10) out.push(ins('info', `ימים ללא שליחת סקרים: ${missing.map(fmtDate).join(', ')}.`));
  if (!out.length) out.push(ins('good', 'אין חריגות בולטות בתקופה שנבחרה.'));
  return out;
}
function topKey(obj, exclude = []) {
  return Object.entries(obj || {}).filter(([k]) => !exclude.includes(k)).sort((a, b) => b[1] - a[1])[0]?.[0];
}
function missingDays(stream, p) {
  if (!p) return [];
  const have = new Set(range(stream, p.from, p.to).map((d) => d.date));
  const out = []; const first = firstDate(stream);
  for (let d = p.from; d <= p.to; d = addDays(d, 1)) if (d >= first && !have.has(d)) out.push(d);
  return out;
}

function dayDoc(stream, date) { return daysOf(stream).find((d) => d.date === date) || null; }
function dailyInsights(stream, date) {
  const D = dayDoc(stream, date); if (!D) return [];
  const out = [];
  const T = sumDays([D]); const m = metrics(T, stream, { from: date, to: date });
  const prev7 = []; for (let i = 1; i <= 7; i++) { const x = dayDoc(stream, addDays(date, -i)); if (x) prev7.push(x); }
  const wk = dayDoc(stream, addDays(date, -7));
  const avgN = prev7.length ? sum(prev7.map((x) => x.n)) / 7 : null;
  const T7 = prev7.length ? sumDays(prev7) : null; const m7 = metrics(T7, stream);
  if (avgN) {
    const ch = m.n / avgN - 1;
    if (Math.abs(ch) >= 0.25) out.push(ins(stream === 'survey' && ch < 0 ? 'warn' : 'info', `נשלחו ${fN(m.n)} הודעות — ${fD(Math.abs(ch) * 100, 0)}% ${ch > 0 ? 'מעל ממוצע' : 'מתחת לממוצע'} 7 הימים הקודמים (${fN(avgN)}).`));
  }
  if (wk) {
    const mw = metrics(sumDays([wk]), stream);
    const ch = m.n / mw.n - 1;
    if (Math.abs(ch) >= 0.25) out.push(ins('info', `לעומת יום ${DOW[dowOf(date)]} שעבר (${fmtDate(wk.date)}): ${ch > 0 ? '+' : ''}${fD(ch * 100, 0)}% בכמות.`));
  }
  if (m7) {
    const dd = (m.dRate - m7.dRate) * 100;
    if (Math.abs(dd) >= 2) out.push(ins(dd > 0 ? 'good' : 'bad', `שיעור המסירה ${fP(m.dRate)}, לעומת ${fP(m7.dRate)} בשבוע הקודם.`));
    const db = (m.bRate - m7.bRate) * 100;
    if (Math.abs(db) >= 2) out.push(ins(db > 0 ? 'bad' : 'good', `שיעור החסימה ${fP(m.bRate)}, לעומת ${fP(m7.bRate)} בשבוע הקודם.`));
    if ((T.failCat.expired || 0) >= 20 && m.expired10k > 10 && m.expired10k > 2 * (m7.expired10k || 0)) out.push(ins('bad', `קפיצה בהודעות שפג תוקפן: ${fN(T.failCat.expired)} (${fD(m.expired10k)} לכל 10,000).`));
  }
  if (m.fRate > 0.01) out.push(ins('bad', `שיעור כשל טכני ${fP(m.fRate, 2)}.`));
  if (m.pRate > 0.01) out.push(ins('info', `${fN(T.p)} הודעות עדיין ללא סטטוס סופי. כדאי לייבא שוב את היום הזה מדוח מאוחר יותר.`));
  // new groups
  const seen = new Set(); for (let i = 1; i <= 30; i++) { const x = dayDoc(stream, addDays(date, -i)); if (x) Object.keys(x.groups || {}).forEach((g) => seen.add(g)); }
  const fresh = Object.keys(D.groups || {}).filter((g) => !seen.has(g));
  if (fresh.length && prev7.length) out.push(ins('info', `${stream === 'marketing' ? 'קמפיינים' : 'סוגי הודעות'} חדשים היום: ${fresh.map((g) => esc(unsafe(g))).join(', ')}.`));
  if (stream === 'marketing') {
    if (D.multi > 0 && D.cust && D.multi / D.cust > 0.02) out.push(ins('warn', `${fN(D.multi)} לקוחות קיבלו יותר מהודעה אחת היום.`));
    const big = Object.entries(D.groups || {}).filter(([, g]) => g.n > 1000 && g.seg / g.n >= 3);
    big.forEach(([k, g]) => out.push(ins('warn', `${esc(unsafe(k))}: ${fD(g.seg / g.n, 1)} מקטעים להודעה (${fN(g.seg)} מקטעים).`)));
    const peak = D.hours.map((s, i) => [i, +String(s).split(',')[0]]).sort((a, b) => b[1] - a[1])[0];
    if (peak && peak[1] > 0.5 * D.n && (T.failCat.expired || 0) > 0.01 * D.n) out.push(ins('warn', `רוב השליחה רוכזה סביב ${String(peak[0]).padStart(2, '0')}:00, ו־${fP((T.failCat.expired || 0) / D.n)} מההודעות פגו. כדאי לפזר שליחות גדולות.`));
  }
  if (stream === 'survey' && prev7.length) {
    const base = sumDays(prev7).branches;
    const anomalies = Object.entries(D.branches || {}).filter(([b, x]) => x.n >= 40 && base[b] && base[b].n >= 100)
      .map(([b, x]) => [b, x.b / x.n - base[b].b / base[b].n]).filter(([, dlt]) => Math.abs(dlt) >= 0.1);
    anomalies.slice(0, 5).forEach(([b, dlt]) => out.push(ins(dlt > 0 ? 'bad' : 'good', `סניף ${esc(unsafe(b))}: שיעור החסימה ${dlt > 0 ? 'גבוה' : 'נמוך'} ב־${fD(Math.abs(dlt) * 100, 0)} נק׳ מהשבוע הקודם.`)));
    const sv = D.groups['סקר']; const rm = D.groups['תזכורת לסקר'];
    if (sv && sv.n && (!rm || !rm.n) && prev7.some((x) => x.groups['תזכורת לסקר']?.n)) out.push(ins('warn', 'היום לא נשלחו תזכורות לסקר, למרות שבשבוע הקודם נשלחו.'));
  }
  if (!out.length) out.push(ins('good', 'יום תקין — אין חריגות לעומת השבוע הקודם.'));
  return out;
}

// ============ rendering helpers ============
const insightList = (items) => `<ul class="insights">${items.map((i) => `<li class="lv-${i.level}"><span class="dot" aria-hidden="true"></span><span>${i.text}</span></li>`).join('')}</ul>`;
function compareTable(stream, mA, mB, keys = null, labels = ['תקופה א', 'תקופה ב']) {
  const rows = METRICS.filter((x) => (!x.only || x.only === stream) && (!keys || keys.includes(x.k)) && (mA?.[x.k] != null || mB?.[x.k] != null));
  return `<div class="tablewrap"><table class="t"><thead><tr><th>מדד</th><th class="num">${labels[0]}</th>${mB !== undefined ? `<th class="num">${labels[1]}</th><th class="num">שינוי</th>` : ''}</tr></thead><tbody>
    ${rows.map((r) => `<tr><td>${r.label}</td><td class="num">${fmtVal(mA?.[r.k], r.f)}</td>${mB !== undefined ? `<td class="num">${fmtVal(mB?.[r.k], r.f)}</td>${deltaCell(mA?.[r.k], mB?.[r.k], r.f, r.good)}` : ''}</tr>`).join('')}
  </tbody></table></div>`;
}
function kpiStrip(stream, mA, mB) {
  const keys = stream === 'survey' ? ['surveys', 'surveyD', 'surveyB', 'seg', 'cost'] : ['n', 'dRate', 'fRate', 'seg', 'cost'];
  return `<div class="kpis">${keys.map((k) => {
    const def = METRICS.find((x) => x.k === k);
    const a = mA?.[k], b = mB?.[k];
    let d = '';
    if (a != null && b != null && isFinite(b) && b !== 0) {
      const diff = isRate(def.f) ? (a - b) * 100 : (a / b - 1) * 100;
      const cls = def.good ? (Math.abs(diff) < (isRate(def.f) ? 0.3 : 3) ? 'muted' : Math.sign(diff) === def.good ? 'good' : 'bad') : 'muted';
      d = `<span class="kd ${cls}">${diff > 0 ? '+' : ''}${fD(diff, 1)}${isRate(def.f) ? ' נק׳' : '%'}</span>`;
    }
    return `<div class="kpi"><span class="kl">${def.label}</span><span class="kv">${fmtVal(a, def.f)}</span>${d}</div>`;
  }).join('')}</div>`;
}
function section(title, body, note = '') {
  return `<section class="panel"><h2>${title}</h2>${body}${note ? `<p class="note">${note}</p>` : ''}</section>`;
}
const empty = (msg) => `<div class="empty"><p>${msg}</p><button class="btn" data-go="import">לייבוא נתונים</button></div>`;

// ============ views ============
const VIEWS = {
  conclusions: { label: 'מסקנות', render: viewConclusions },
  overview: { label: 'סקירה', render: viewOverview },
  daily: { label: 'ניתוח יומי', render: viewDaily },
  compare: { label: 'השוואות', render: viewCompare },
  groups: { label: 'קמפיינים וסניפים', render: viewGroups, labelFor: (s) => (s === 'survey' ? 'סוגי הודעות וסניפים' : 'קמפיינים') },
  failures: { label: 'כשלים', render: viewFailures },
  timing: { label: 'שעות וימים', render: viewTiming },
  frequency: { label: 'תדירות ללקוח', render: viewFrequency },
  responses: { label: 'מענה לסקר', render: viewResponses, only: 'survey' },
  import: { label: 'ייבוא והגדרות', render: viewImport },
};

function render() {
  destroyCharts();
  // data may have arrived after boot (first import): pick a default period then
  if ((!S.A || !S.A.from) && lastDate(S.stream)) initPeriod();
  renderNav(); renderBar();
  const v = VIEWS[S.view];
  const el = $('#view');
  if (v.only && v.only !== S.stream) { S.view = 'overview'; return render(); }
  if (S.view !== 'import' && S.view !== 'conclusions' && !daysOf(S.stream).length) { el.innerHTML = empty(`עדיין אין נתוני ${STREAMS[S.stream]} במסד הנתונים.`); bindCommon(el); return; }
  el.innerHTML = '<div class="loading">טוען…</div>';
  Promise.resolve(v.render(el)).then(() => bindCommon(el)).catch((e) => { console.error(e); el.innerHTML = `<div class="error">שגיאה בהצגת המסך: ${esc(e.message)}</div>`; });
}
function bindCommon(el) {
  $$('[data-go]', el).forEach((b) => b.addEventListener('click', () => { S.view = b.dataset.go; render(); }));
}
function renderNav() {
  $('#nav').innerHTML = Object.entries(VIEWS).filter(([, v]) => !v.only || v.only === S.stream)
    .map(([k, v]) => `<button class="navbtn${S.view === k ? ' on' : ''}" data-view="${k}" ${S.view === k ? 'aria-current="page"' : ''}>${v.labelFor ? v.labelFor(S.stream) : v.label}</button>`).join('');
  $$('#nav .navbtn').forEach((b) => b.addEventListener('click', () => { S.view = b.dataset.view; render(); }));
  $$('.tile button').forEach((b) => { b.classList.toggle('on', b.dataset.stream === S.stream); b.setAttribute('aria-pressed', b.dataset.stream === S.stream); });
}
function renderBar() {
  const bar = $('#bar');
  if (!S.A || S.view === 'import') { bar.innerHTML = S.view === 'import' ? '' : '<span class="muted">אין נתונים לתקופה</span>'; return; }
  bar.innerHTML = `
    <label>תקופה <select id="preset">
      ${[['1', 'יום אחרון'], ['7', '7 ימים אחרונים'], ['30', '30 ימים אחרונים'], ['92', '92 ימים אחרונים'], ['all', 'כל הנתונים'], ['custom', 'בחירה חופשית']].map(([v, l]) => `<option value="${v}" ${S.preset === v ? 'selected' : ''}>${l}</option>`).join('')}
    </select></label>
    <span class="dates"><input type="date" id="aFrom" value="${S.A.from}" aria-label="מתאריך"> – <input type="date" id="aTo" value="${S.A.to}" aria-label="עד תאריך"></span>
    <label>השוואה ל<select id="cmp">
      ${[['yoy', 'אותה תקופה אשתקד'], ['prev', 'התקופה הקודמת'], ['custom', 'תקופה לבחירה'], ['none', 'ללא השוואה']].map(([v, l]) => `<option value="${v}" ${S.cmp === v ? 'selected' : ''}>${l}</option>`).join('')}
    </select></label>
    ${S.cmp !== 'none' && S.B ? `<span class="dates bdates"><input type="date" id="bFrom" value="${S.B.from}" ${S.cmp !== 'custom' ? 'disabled' : ''} aria-label="השוואה מתאריך"> – <input type="date" id="bTo" value="${S.B.to}" ${S.cmp !== 'custom' ? 'disabled' : ''} aria-label="השוואה עד תאריך"></span>` : ''}
    <span class="range-note">נתונים: ${fmtDate(firstDate(S.stream))}–${fmtDate(lastDate(S.stream))}</span>`;
  $('#preset').onchange = (e) => { if (e.target.value !== 'custom') applyPreset(e.target.value); else S.preset = 'custom'; render(); };
  const setA = () => { S.preset = 'custom'; S.A = { from: $('#aFrom').value, to: $('#aTo').value }; if (S.A.from > S.A.to) S.A = { from: S.A.to, to: S.A.from }; computeB(); render(); };
  $('#aFrom').onchange = setA; $('#aTo').onchange = setA;
  $('#cmp').onchange = (e) => { S.cmp = e.target.value; if (S.cmp === 'custom') S.B = null; computeB(); render(); };
  if ($('#bFrom')) { const setB = () => { S.B = { from: $('#bFrom').value, to: $('#bTo').value }; render(); }; $('#bFrom').onchange = setB; $('#bTo').onchange = setB; }
}
const AB = () => {
  const TA = totals(S.stream, S.A), TB = S.B ? totals(S.stream, S.B) : null;
  return { TA, TB, mA: metrics(TA, S.stream, S.A), mB: S.B ? metrics(TB, S.stream, S.B) : undefined };
};
const abLabels = () => [pLabel(S.A), S.B ? pLabel(S.B) : ''];

// ---------- conclusions ----------
async function viewConclusions(el) {
  const { mA, mB } = AB();
  const auto = S.A ? periodInsights(S.stream, S.A, S.B, mA, mB) : [];
  const daily = S.dailyInsights.filter((d) => d.stream === S.stream).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 7);
  const mine = S.insights.filter((i) => i.stream === S.stream).sort((a, b) => (a.order || 0) - (b.order || 0));
  const concl = mine.filter((i) => i.kind !== 'recommendation');
  const recs = mine.filter((i) => i.kind === 'recommendation');
  const sections = [...new Set(concl.map((c) => c.section))];
  el.innerHTML = `
    <h1 class="vt">מסקנות — ${STREAMS[S.stream]}</h1>
    ${S.A ? section(`מסקנות אוטומטיות: ${pLabel(S.A)}${S.B ? ` מול ${pLabel(S.B)}` : ''}`, insightList(auto), 'מחושבות מחדש בכל שינוי של התקופה או של תקופת ההשוואה.') : ''}
    ${section('ניתוחים יומיים אחרונים', daily.length ? daily.map((d) => `<div class="dayins"><button class="linkbtn" data-day="${d.date}">${DOW[dowOf(d.date)]} ${fmtDate(d.date)}</button>${insightList(d.items || [])}</div>`).join('') : '<p class="muted">עדיין לא נוצרו ניתוחים יומיים. הם נוצרים אוטומטית בכל ייבוא של קובץ.</p>')}
    ${section('מסקנות הניתוח', concl.length ? sections.map((s) => `<h3>${esc(s)}</h3><ol class="concl">${concl.filter((c) => c.section === s).map((c) => `<li><p>${esc(c.text)}</p><span class="src">${esc(c.period || '')}${c.source ? ` · מקור: ${esc(c.source)}` : ''}</span><button class="x" data-del="${c.id}" aria-label="מחיקת מסקנה">מחיקה</button></li>`).join('')}</ol>`).join('') : '<p class="muted">אין מסקנות שמורות. אפשר לטעון את מסקנות הניתוח הראשוני בלשונית "ייבוא והגדרות".</p>')}
    ${section('המלצות', recs.length ? `<div class="tablewrap"><table class="t"><thead><tr><th>עדיפות</th><th>המלצה</th><th>למה</th><th></th></tr></thead><tbody>${recs.map((r) => `<tr><td><span class="pri pri-${r.priority === 'גבוהה' ? 'h' : r.priority === 'בינונית' ? 'm' : 'l'}">${esc(r.priority || '')}</span></td><td>${esc(r.text)}</td><td class="muted">${esc(r.why || '')}</td><td><button class="x" data-del="${r.id}" aria-label="מחיקת המלצה">מחיקה</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">אין המלצות שמורות.</p>')}
    ${section('הוספת מסקנה או המלצה', `<form id="addIns" class="form">
      <label>סוג <select name="kind"><option value="conclusion">מסקנה</option><option value="recommendation">המלצה</option></select></label>
      <label>נושא <input name="section" value="${esc(sections[0] || 'כללי')}" required></label>
      <label>עדיפות (להמלצה) <select name="priority"><option>גבוהה</option><option selected>בינונית</option><option>נמוכה</option></select></label>
      <label class="wide">טקסט <textarea name="text" rows="2" required></textarea></label>
      <button class="btn">שמירה</button></form>`)}`;
  $$('[data-day]', el).forEach((b) => b.addEventListener('click', () => { S.dailyDate = b.dataset.day; S.view = 'daily'; render(); }));
  $$('[data-del]', el).forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('למחוק את הפריט?')) return;
    await S.db.deleteInsight(b.dataset.del); S.insights = S.insights.filter((i) => i.id !== b.dataset.del); render();
  }));
  $('#addIns', el).addEventListener('submit', async (e) => {
    e.preventDefault(); const f = new FormData(e.target);
    const doc = { stream: S.stream, kind: f.get('kind'), section: f.get('kind') === 'recommendation' ? 'המלצות' : f.get('section'), priority: f.get('priority'), text: f.get('text'), period: S.A ? pLabel(S.A) : '', order: Date.now(), by: S.user?.email || '' };
    doc.id = await S.db.addInsight(doc); S.insights.push(doc); render();
  });
}

// ---------- overview ----------
async function viewOverview(el) {
  const { TA, TB, mA, mB } = AB();
  const [la, lb] = abLabels();
  el.innerHTML = `
    <h1 class="vt">סקירה — ${STREAMS[S.stream]}</h1>
    ${kpiStrip(S.stream, mA, mB)}
    ${section('מה בולט בתקופה', insightList(periodInsights(S.stream, S.A, S.B, mA, mB)))}
    <section class="panel"><h2>הודעות ביום</h2><div class="chart tall"><canvas id="cDaily"></canvas></div><p class="note">${S.B ? 'תקופת ההשוואה מוצגת מיושרת לפי מספר היום בתקופה.' : ''}</p></section>
    <div class="cols">
      ${section('כל המדדים', compareTable(S.stream, mA, mB, null, [la, lb]))}
      <section class="panel"><h2>${S.stream === 'survey' ? 'סקרים ותזכורות' : 'חלוקת המקטעים לפי קמפיין'}</h2><div class="chart"><canvas id="cMix"></canvas></div></section>
    </div>`;
  const len = daysBetween(S.A.from, S.A.to) + 1;
  const labels = [], a = [], b = [], a2 = [];
  for (let i = 0; i < len; i++) {
    const da = addDays(S.A.from, i); labels.push(fmtDate(da).slice(0, 5));
    const x = dayDoc(S.stream, da);
    if (S.stream === 'survey') { a.push(x?.groups?.['סקר']?.n || 0); a2.push(x?.groups?.['תזכורת לסקר']?.n || 0); }
    else a.push(x?.n || 0);
    if (S.B) { const y = dayDoc(S.stream, addDays(S.B.from, i)); b.push(S.stream === 'survey' ? (y?.groups?.['סקר']?.n || 0) : (y?.n || 0)); }
  }
  const ds = [{ label: (S.stream === 'survey' ? 'סקרים ' : 'הודעות ') + la, data: a, borderColor: colA(), backgroundColor: colA(), tension: 0.2, pointRadius: len > 40 ? 0 : 2 }];
  if (S.stream === 'survey') ds.push({ label: 'תזכורות ' + la, data: a2, borderColor: css('--amber'), backgroundColor: css('--amber'), tension: 0.2, pointRadius: 0 });
  if (S.B) ds.push({ label: (S.stream === 'survey' ? 'סקרים ' : 'הודעות ') + lb, data: b, borderColor: colB(), backgroundColor: colB(), borderDash: [5, 4], tension: 0.2, pointRadius: 0 });
  chart($('#cDaily'), { type: 'line', data: { labels, datasets: ds }, options: baseOpts() });
  if (S.stream === 'survey') {
    const vs = Object.entries(TA.variants).sort((x, y) => y[1].n - x[1].n);
    chart($('#cMix'), { type: 'bar', data: { labels: vs.map(([k]) => unsafe(k)), datasets: [{ label: 'הודעות', data: vs.map(([, v]) => v.n), backgroundColor: colA() }, { label: 'מקטעים', data: vs.map(([, v]) => v.seg), backgroundColor: css('--amber') }] }, options: baseOpts({ indexAxis: 'y' }) });
  } else {
    const gs = Object.entries(TA.groups).sort((x, y) => y[1].seg - x[1].seg).slice(0, 10);
    chart($('#cMix'), { type: 'bar', data: { labels: gs.map(([k]) => unsafe(k)), datasets: [{ label: 'מקטעים', data: gs.map(([, v]) => v.seg), backgroundColor: colA() }] }, options: baseOpts({ indexAxis: 'y', plugins: { legend: { display: false } } }) });
  }
}

// ---------- daily ----------
async function viewDaily(el) {
  const dates = daysOf(S.stream).map((d) => d.date);
  const date = S.dailyDate && dates.includes(S.dailyDate) ? S.dailyDate : dates.at(-1);
  S.dailyDate = date;
  const D = dayDoc(S.stream, date);
  const T = sumDays([D]); const m = metrics(T, S.stream, { from: date, to: date });
  const wkD = dayDoc(S.stream, addDays(date, -7));
  const prev7 = []; for (let i = 1; i <= 7; i++) { const x = dayDoc(S.stream, addDays(date, -i)); if (x) prev7.push(x); }
  const m7 = prev7.length ? metrics(sumDays(prev7), S.stream, { from: addDays(date, -7), to: addDays(date, -1) }) : null;
  if (m7) for (const k of ['n', 'd', 'surveys', 'reminders', 'seg', 'cost', 'permanent', 'multi', 'gaps1h', 'groupsCount']) if (m7[k] != null) m7[k] /= 7;
  const lyD = dayDoc(S.stream, addDays(date, -364));
  const mW = wkD ? metrics(sumDays([wkD]), S.stream) : null;
  const mY = lyD ? metrics(sumDays([lyD]), S.stream) : null;
  const items = dailyInsights(S.stream, date);
  const keys = ['n', 'surveys', 'reminders', 'groupsCount', 'd', 'surveyD', 'dRate', 'surveyB', 'bRate', 'fRate', 'expired10k', 'permanent', 'pRate', 'seg', 'segPerMsg', 'seg2Share', 'seg3Share', 'cost', 'multi', 'gaps1h'];
  const rows = METRICS.filter((x) => keys.includes(x.k) && (!x.only || x.only === S.stream));
  const groups = Object.entries(D.groups).sort((a, b) => b[1].n - a[1].n);
  el.innerHTML = `
    <h1 class="vt">ניתוח יומי — ${STREAMS[S.stream]}</h1>
    <div class="dayhead"><label>יום <select id="dsel">${dates.slice().reverse().map((d) => `<option value="${d}" ${d === date ? 'selected' : ''}>${DOW[dowOf(d)]} ${fmtDate(d)}</option>`).join('')}</select></label>
    <button class="btn ghost" id="saveDaily">שמירת הניתוח למסקנות</button></div>
    ${section(`מה קרה ב־${fmtDate(date)}`, insightList(items))}
    ${section('היום מול ימים אחרים', `<div class="tablewrap"><table class="t"><thead><tr><th>מדד</th><th class="num">היום</th><th class="num">${DOW[dowOf(date)]} שעבר</th><th class="num">שינוי</th><th class="num">ממוצע 7 ימים קודמים</th><th class="num">שינוי</th><th class="num">לפני 52 שבועות</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${r.label}</td><td class="num">${fmtVal(m[r.k], r.f)}</td><td class="num">${fmtVal(mW?.[r.k], r.f)}</td>${deltaCell(m[r.k], mW?.[r.k], r.f, r.good)}<td class="num">${fmtVal(m7?.[r.k], r.f)}</td>${deltaCell(m[r.k], m7?.[r.k], r.f, r.good)}<td class="num">${fmtVal(mY?.[r.k], r.f)}</td></tr>`).join('')}
      </tbody></table></div>`, 'ממוצע 7 הימים כולל ימים ללא שליחה (כאפס). "לפני 52 שבועות" הוא אותו יום בשבוע לפני שנה.')}
    <div class="cols">
      <section class="panel"><h2>שליחה לפי שעה</h2><div class="chart"><canvas id="cHour"></canvas></div></section>
      ${section(S.stream === 'survey' ? 'סוגי הודעות היום' : 'קמפיינים היום', groupTable(groups, T))}
    </div>
    ${section('כשלים היום', failTable(T, null))}
    ${S.stream === 'survey' ? section('סניפים היום', branchTable(T, prev7.length ? sumDays(prev7) : null, ['היום', '7 ימים קודמים'])) : ''}`;
  $('#dsel').onchange = (e) => { S.dailyDate = e.target.value; render(); };
  $('#saveDaily').onclick = async () => { await saveDailyInsight(S.stream, date, items); toast('הניתוח היומי נשמר'); };
  const hrs = (doc) => (doc?.hours || []).map((s) => +String(s).split(',')[0]);
  const ds = [{ label: fmtDate(date), data: hrs(D), backgroundColor: colA() }];
  if (wkD) ds.push({ label: fmtDate(wkD.date), data: hrs(wkD), backgroundColor: colB() });
  chart($('#cHour'), { type: 'bar', data: { labels: [...Array(24).keys()].map((h) => String(h).padStart(2, '0')), datasets: ds }, options: baseOpts() });
}
async function saveDailyInsight(stream, date, items) {
  const doc = { stream, date, items, at: new Date().toISOString() };
  await S.db.saveDailyInsight(doc);
  S.dailyInsights = S.dailyInsights.filter((d) => !(d.stream === stream && d.date === date)).concat(doc);
}
function groupTable(groups, T) {
  return `<div class="tablewrap"><table class="t"><thead><tr><th>${S.stream === 'survey' ? 'סוג' : 'קמפיין'}</th><th class="num">נשלחו</th><th class="num">% מסירה</th><th class="num">% חסום</th><th class="num">% כשל</th><th class="num">מקטעים להודעה</th><th class="num">לקוחות</th><th class="num">עלות</th></tr></thead><tbody>
  ${groups.map(([k, g]) => `<tr><td>${esc(unsafe(k))}</td><td class="num">${fN(g.n)}</td><td class="num">${fP(div(g.d, g.n))}</td><td class="num">${fP(div(g.b, g.n))}</td><td class="num">${fP(div(g.f, g.n), 2)}</td><td class="num">${fD(div(g.seg, g.n), 2)}</td><td class="num">${fN(g.cust)}</td><td class="num">${fM(cost(g))}</td></tr>`).join('')}
  </tbody></table></div>`;
}
function failTable(TA, TB, labels = ['', '']) {
  const cats = Object.keys(FAIL_CATS).filter((c) => (TA.failCat[c] || 0) + (TB?.failCat?.[c] || 0) > 0);
  return `<div class="tablewrap"><table class="t"><thead><tr><th>קטגוריה</th><th class="num">${TB ? labels[0] : 'הודעות'}</th><th class="num">לכל 10,000</th>${TB ? `<th class="num">${labels[1]}</th><th class="num">לכל 10,000</th><th class="num">שינוי</th>` : ''}</tr></thead><tbody>
    ${cats.map((c) => { const a = div((TA.failCat[c] || 0) * 1e4, TA.n), b = TB ? div((TB.failCat[c] || 0) * 1e4, TB.n) : null;
      return `<tr><td>${FAIL_CATS[c]}${PERMANENT_CATS.includes(c) ? ' <span class="tag">קבוע</span>' : ''}</td><td class="num">${fN(TA.failCat[c] || 0)}</td><td class="num">${fD(a)}</td>${TB ? `<td class="num">${fN(TB.failCat[c] || 0)}</td><td class="num">${fD(b)}</td>${deltaCell(a, b, '1', -1)}` : ''}</tr>`; }).join('')}
  </tbody></table></div>`;
}
function branchTable(TA, TB, labels) {
  const all = [...new Set([...Object.keys(TA.branches), ...Object.keys(TB?.branches || {})])].filter((b) => b !== 'לא זוהה');
  const rows = all.map((b) => { const a = TA.branches[b] || { n: 0, b: 0, rem: 0, gift: 0 }; const x = TB?.branches?.[b];
    return { b, n: a.n, bl: div(a.b, a.n), rem: div(a.rem * 100, a.n), gift: div(a.gift, a.n), nB: x?.n, blB: x ? div(x.b, x.n) : null }; })
    .sort((p, q) => q.n - p.n);
  return `<div class="tablewrap scroll"><table class="t sortable"><thead><tr><th>סניף</th><th class="num">סקרים ${labels[0]}</th>${TB ? `<th class="num">סקרים ${labels[1]}</th><th class="num">שינוי</th>` : ''}<th class="num">% חסום ${labels[0]}</th>${TB ? `<th class="num">% חסום ${labels[1]}</th><th class="num">הפרש</th>` : ''}<th class="num">תזכורות ל־100</th><th class="num">% עם מתנה</th></tr></thead><tbody>
  ${rows.map((r) => `<tr><td>${esc(unsafe(r.b))}</td><td class="num">${fN(r.n)}</td>${TB ? `<td class="num">${fN(r.nB)}</td>${deltaCell(r.n, r.nB, 'n')}` : ''}<td class="num heat" style="--h:${Math.min(1, (r.bl || 0) / 0.4)}">${fP(r.bl)}</td>${TB ? `<td class="num">${fP(r.blB)}</td>${deltaCell(r.bl, r.blB, 'p', -1)}` : ''}<td class="num">${fD(r.rem)}</td><td class="num">${fP(r.gift)}</td></tr>`).join('')}
  </tbody></table></div>`;
}

// ---------- compare ----------
async function viewCompare(el) {
  S.cmpMode = S.cmpMode || 'period';
  const { TA, mA, mB } = AB();
  const groupsAll = Object.keys(sumDays(daysOf(S.stream)).groups).sort();
  const gl = S.stream === 'survey' ? 'סוג הודעה' : 'קמפיין';
  el.innerHTML = `
    <h1 class="vt">השוואות — ${STREAMS[S.stream]}</h1>
    <div class="seg" role="tablist"><button class="${S.cmpMode === 'period' ? 'on' : ''}" data-m="period">תקופה מול תקופה</button><button class="${S.cmpMode === 'group' ? 'on' : ''}" data-m="group">${gl} מול ${gl}</button>${S.stream === 'survey' ? `<button class="${S.cmpMode === 'variant' ? 'on' : ''}" data-m="variant">נוסח מול נוסח</button>` : ''}</div>
    <div id="cmpBody"></div>`;
  $$('.seg button', el).forEach((b) => b.addEventListener('click', () => { S.cmpMode = b.dataset.m; render(); }));
  const body = $('#cmpBody', el);
  if (S.cmpMode === 'period') {
    if (!S.B) { body.innerHTML = '<p class="muted">בחרו תקופת השוואה בסרגל העליון.</p>'; return; }
    const [la, lb] = abLabels();
    body.innerHTML = section(`${la} מול ${lb}`, compareTable(S.stream, mA, mB, null, [la, lb])) + section('מסקנות ההשוואה', insightList(periodInsights(S.stream, S.A, S.B, mA, mB)));
    return;
  }
  const isVar = S.cmpMode === 'variant';
  const opts = isVar ? Object.keys(sumDays(daysOf(S.stream)).variants).sort() : groupsAll;
  S.g1 = opts.includes(S.g1) ? S.g1 : opts[0]; S.g2 = opts.includes(S.g2) && S.g2 !== S.g1 ? S.g2 : opts.find((o) => o !== S.g1);
  S.gScope = S.gScope || 'all';
  const scopeDays = S.gScope === 'all' ? daysOf(S.stream) : range(S.stream, S.A.from, S.A.to);
  const pick = (name) => { const T = sumDays(scopeDays); return isVar ? T.variants[name] : T.groups[name]; };
  const g1 = pick(S.g1), g2 = pick(S.g2);
  const gm = (g) => g ? { n: g.n, d: g.d, dRate: div(g.d, g.n), bRate: div(g.b, g.n), fRate: div(g.f, g.n), pRate: div(g.p, g.n), seg: g.seg, segPerMsg: div(g.seg, g.n), seg2Share: div(g.seg2, g.n - g.b), seg3Share: div(g.seg3 || 0, g.n - g.b), cost: cost(g), expired10k: div((g.fc?.expired || 0) * 1e4, g.n), permanent: sum(PERMANENT_CATS.map((c) => g.fc?.[c] || 0)) } : null;
  body.innerHTML = `
    <div class="pickers"><label>${isVar ? 'נוסח' : gl} א <select id="g1">${opts.map((o) => `<option ${o === S.g1 ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>
      <label>${isVar ? 'נוסח' : gl} ב <select id="g2">${opts.map((o) => `<option ${o === S.g2 ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>
      <label>טווח <select id="gScope"><option value="all" ${S.gScope === 'all' ? 'selected' : ''}>כל הנתונים</option><option value="A" ${S.gScope === 'A' ? 'selected' : ''}>התקופה שנבחרה (${pLabel(S.A)})</option></select></label></div>
    ${section(`${esc(unsafe(S.g1 || ''))} מול ${esc(unsafe(S.g2 || ''))}`, compareTable(S.stream, gm(g1), gm(g2), isVar ? ['n', 'd', 'dRate', 'bRate', 'fRate', 'pRate', 'seg', 'segPerMsg', 'seg2Share', 'cost'] : ['n', 'd', 'dRate', 'bRate', 'fRate', 'expired10k', 'permanent', 'pRate', 'seg', 'segPerMsg', 'seg2Share', 'seg3Share', 'cost'], [unsafe(S.g1 || ''), unsafe(S.g2 || '')])
      + (!isVar && g1 && g2 ? `<p class="note">${esc(unsafe(S.g1))}: ${fmtDate(g1.first)}–${fmtDate(g1.last)}, ${fN(g1.days)} ימים, ${fN(g1.cust)} לקוחות (סכום יומי). ${esc(unsafe(S.g2))}: ${fmtDate(g2.first)}–${fmtDate(g2.last)}, ${fN(g2.days)} ימים, ${fN(g2.cust)} לקוחות.</p>` : ''))}
    ${!isVar ? '<section class="panel"><h2>שליחה לפי שעה</h2><div class="chart"><canvas id="cG"></canvas></div><p class="note">החלוקה לשעות מחושבת מהימים שבהם כל קמפיין נשלח, ולכן היא משוערת כשנשלחו כמה קמפיינים באותו יום.</p></section>' : ''}`;
  $('#g1').onchange = (e) => { S.g1 = e.target.value; render(); };
  $('#g2').onchange = (e) => { S.g2 = e.target.value; render(); };
  $('#gScope').onchange = (e) => { S.gScope = e.target.value; render(); };
  if (!isVar && $('#cG')) {
    const prof = (name) => { const h = Array(24).fill(0); scopeDays.forEach((d) => { const g = d.groups[name]; if (!g) return; const tot = d.n; d.hours.forEach((s, i) => { h[i] += +String(s).split(',')[0] * g.n / tot; }); }); const t = sum(h); return h.map((x) => (t ? x / t * 100 : 0)); };
    chart($('#cG'), { type: 'bar', data: { labels: [...Array(24).keys()].map((h) => String(h).padStart(2, '0')), datasets: [{ label: unsafe(S.g1), data: prof(S.g1), backgroundColor: colA() }, { label: unsafe(S.g2), data: prof(S.g2), backgroundColor: colB() }] }, options: baseOpts() });
  }
}

// ---------- groups ----------
async function viewGroups(el) {
  const { TA, TB } = AB();
  const [la, lb] = abLabels();
  const names = [...new Set([...Object.keys(TA?.groups || {}), ...Object.keys(TB?.groups || {})])].sort((a, b) => (TA?.groups[b]?.n || 0) - (TA?.groups[a]?.n || 0));
  const rows = names.map((k) => { const a = TA?.groups[k], b = TB?.groups[k];
    return `<tr><td>${esc(unsafe(k))}</td><td class="num">${fN(a?.n)}</td>${S.B ? `<td class="num">${fN(b?.n)}</td>${deltaCell(a?.n, b?.n, 'n')}` : ''}<td class="num">${fP(a ? div(a.d, a.n) : null)}</td><td class="num">${fP(a ? div(a.b, a.n) : null)}</td><td class="num">${fP(a ? div(a.f, a.n) : null, 2)}</td><td class="num">${fD(a ? div(a.seg, a.n) : null, 2)}</td><td class="num">${fN(a?.seg)}</td><td class="num">${fM(a ? cost(a) : null)}</td><td class="num">${a ? `${fmtDate(a.first).slice(0, 5)}–${fmtDate(a.last).slice(0, 5)}` : '—'}</td></tr>`; }).join('');
  let html = `<h1 class="vt">${S.stream === 'survey' ? 'סוגי הודעות וסניפים' : 'קמפיינים'} — ${STREAMS[S.stream]}</h1>
    ${section(S.stream === 'survey' ? 'סוגי הודעות' : 'קמפיינים', `<div class="tablewrap"><table class="t"><thead><tr><th>${S.stream === 'survey' ? 'סוג' : 'קמפיין'}</th><th class="num">נשלחו ${la}</th>${S.B ? `<th class="num">נשלחו ${lb}</th><th class="num">שינוי</th>` : ''}<th class="num">% מסירה</th><th class="num">% חסום</th><th class="num">% כשל</th><th class="num">מקטעים להודעה</th><th class="num">מקטעים</th><th class="num">עלות</th><th class="num">תאריכים</th></tr></thead><tbody>${rows}</tbody></table></div>`, 'השיעורים והעלות מחושבים לתקופה הנבחרת.')}`;
  if (S.stream === 'survey') {
    const vn = [...new Set([...Object.keys(TA.variants), ...Object.keys(TB?.variants || {})])];
    const vr = (T, k) => { const v = T?.variants?.[k]; return v ? { n: v.n, bl: div(v.b, v.n), s2: div(v.seg2, v.n - v.b), spd: div(v.seg, v.d), len: div(v.len, v.n) } : null; };
    html += section('נוסחי ההודעה', `<div class="tablewrap"><table class="t"><thead><tr><th>נוסח</th><th class="num">נשלחו ${la}</th>${S.B ? `<th class="num">נשלחו ${lb}</th>` : ''}<th class="num">% חסום</th><th class="num">% בשני מקטעים</th><th class="num">מקטעים להודעה שנמסרה</th>${S.B ? `<th class="num">מקטעים להודעה שנמסרה ${lb}</th>` : ''}<th class="num">אורך ממוצע</th></tr></thead><tbody>
      ${vn.map((k) => { const a = vr(TA, k), b = vr(TB, k); return `<tr><td>${esc(unsafe(k))}</td><td class="num">${fN(a?.n)}</td>${S.B ? `<td class="num">${fN(b?.n)}</td>` : ''}<td class="num">${fP(a?.bl)}</td><td class="num">${fP(a?.s2)}</td><td class="num">${fD(a?.spd, 2)}</td>${S.B ? `<td class="num">${fD(b?.spd, 2)}</td>` : ''}<td class="num">${fN(a?.len)}</td></tr>`; }).join('')}</tbody></table></div>`,
      'אורך ממוצע כולל את שם הלקוח ואת חתימת הסניף. בעברית עם אימוג׳י, הודעה של יותר מכ־200 תווים מחויבת בשני מקטעים.');
    html += section('סניפים', branchTable(TA, TB, [la, lb]), 'צביעת עמודת החסימה: כהה יותר = שיעור חסימה גבוה יותר.');
  }
  el.innerHTML = html;
}

// ---------- failures ----------
async function viewFailures(el) {
  const { TA, TB } = AB();
  const [la, lb] = abLabels();
  const reasons = [...new Set([...Object.keys(TA.reasons), ...Object.keys(TB?.reasons || {})])].sort((a, b) => (TA.reasons[b] || 0) - (TA.reasons[a] || 0)).slice(0, 20);
  const gs = Object.entries(TA.groups).filter(([, g]) => g.n - g.d > 0).sort((a, b) => b[1].n - a[1].n);
  const cats = Object.keys(FAIL_CATS).filter((c) => c !== 'blocked' && gs.some(([, g]) => g.fc[c]));
  el.innerHTML = `<h1 class="vt">כשלים — ${STREAMS[S.stream]}</h1>
    ${section('סיבות לאי־מסירה', failTable(TA, TB, [la, lb]), '"קבוע" = כשל שיחזור בכל שליחה לאותו מספר. ההשוואה מנורמלת לכל 10,000 הודעות.')}
    <div class="cols">
      ${section('סיבות המפעיל המקוריות (כשל טכני)', `<div class="tablewrap scroll"><table class="t"><thead><tr><th>סיבה</th><th class="num">${la}</th>${S.B ? `<th class="num">${lb}</th>` : ''}</tr></thead><tbody>${reasons.map((r) => `<tr><td dir="ltr" class="ltr">${esc(unsafe(r))}</td><td class="num">${fN(TA.reasons[r] || 0)}</td>${S.B ? `<td class="num">${fN(TB?.reasons?.[r] || 0)}</td>` : ''}</tr>`).join('')}</tbody></table></div>`)}
      <section class="panel"><h2>קטגוריות כשל</h2><div class="chart"><canvas id="cFail"></canvas></div></section>
    </div>
    ${section(`כשלים לפי ${S.stream === 'survey' ? 'סוג הודעה' : 'קמפיין'} (${la})`, `<div class="tablewrap"><table class="t"><thead><tr><th>${S.stream === 'survey' ? 'סוג' : 'קמפיין'}</th><th class="num">נשלחו</th>${cats.map((c) => `<th class="num">${FAIL_CATS[c]}</th>`).join('')}<th class="num">% כשל טכני</th></tr></thead><tbody>
      ${gs.map(([k, g]) => `<tr><td>${esc(unsafe(k))}</td><td class="num">${fN(g.n)}</td>${cats.map((c) => `<td class="num">${fN(g.fc[c] || 0)}</td>`).join('')}<td class="num">${fP(div(g.f, g.n), 2)}</td></tr>`).join('')}</tbody></table></div>`)}`;
  const fc = Object.keys(FAIL_CATS).filter((c) => c !== 'blocked');
  const ds = [{ label: la, data: fc.map((c) => div((TA.failCat[c] || 0) * 1e4, TA.n)), backgroundColor: colA() }];
  if (TB) ds.push({ label: lb, data: fc.map((c) => div((TB.failCat[c] || 0) * 1e4, TB.n)), backgroundColor: colB() });
  chart($('#cFail'), { type: 'bar', data: { labels: fc.map((c) => FAIL_CATS[c]), datasets: ds }, options: baseOpts({ indexAxis: 'y' }) });
}

// ---------- timing ----------
async function viewTiming(el) {
  const { TA, TB } = AB();
  const [la, lb] = abLabels();
  const share = (T) => { const t = sum(T.hours.map((h) => h[0])); return T.hours.map((h) => (t ? h[0] / t * 100 : 0)); };
  const blk = (T) => T.hours.map((h) => (h[0] ? h[2] / h[0] : null));
  const sa = share(TA), sb = TB ? share(TB) : null;
  const top = (s) => s.map((v, i) => [i, v]).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([i]) => String(i).padStart(2, '0') + ':00').join(', ');
  const dw = (T) => { const t = sum(T.dow); return T.dow.map((v) => (t ? v / t * 100 : 0)); };
  el.innerHTML = `<h1 class="vt">שעות וימים — ${STREAMS[S.stream]}</h1>
    <section class="panel"><h2>חלק ההודעות לפי שעה</h2><div class="chart tall"><canvas id="cH"></canvas></div><p class="note">השעות העמוסות: ${top(sa)}${sb ? ` (בתקופת ההשוואה: ${top(sb)})` : ''}.</p></section>
    <div class="cols">
      <section class="panel"><h2>חלק ההודעות לפי יום בשבוע</h2><div class="chart"><canvas id="cW"></canvas></div></section>
      ${section('שעות: כמויות ושיעור חסימה', `<div class="tablewrap scroll"><table class="t"><thead><tr><th>שעה</th><th class="num">${la}</th>${TB ? `<th class="num">${lb}</th><th class="num">הפרש בחלק</th>` : ''}<th class="num">% חסום</th></tr></thead><tbody>
        ${TA.hours.map((h, i) => `<tr><td>${String(i).padStart(2, '0')}:00</td><td class="num">${fN(h[0])}</td>${TB ? `<td class="num">${fN(TB.hours[i][0])}</td>${deltaCell(sa[i] / 100, sb[i] / 100, 'p')}` : ''}<td class="num">${fP(blk(TA)[i])}</td></tr>`).join('')}</tbody></table></div>`)}
    </div>`;
  const ds = [{ label: la, data: sa, backgroundColor: colA() }]; if (sb) ds.push({ label: lb, data: sb, backgroundColor: colB() });
  chart($('#cH'), { type: 'bar', data: { labels: [...Array(24).keys()].map((h) => String(h).padStart(2, '0')), datasets: ds }, options: baseOpts() });
  const dws = [{ label: la, data: dw(TA), backgroundColor: colA() }]; if (TB) dws.push({ label: lb, data: dw(TB), backgroundColor: colB() });
  chart($('#cW'), { type: 'bar', data: { labels: DOW, datasets: dws }, options: baseOpts() });
}

// ---------- frequency ----------
async function loadFreq(stream, p, onProgress) {
  const key = `${stream}|${p.from}|${p.to}|${[...testSet()].join(',')}`;
  if (S.freqCache.has(key)) return S.freqCache.get(key);
  const docs = await S.db.loadFreq(stream, p.from, p.to, onProgress);
  const map = new Map();
  docs.forEach((d) => parseShardsInto(map, d.date, d.d));
  const T = sumDays(range(stream, p.from, p.to));
  const codeNames = Object.fromEntries(Object.entries(T.codes).map(([c, n]) => [c, unsafe(n)]));
  const primaryCodes = stream === 'survey' ? new Set(Object.entries(T.codes).filter(([, n]) => n === 'סקר').map(([c]) => c)) : null;
  const st = frequencyStats(map, { exclude: testSet(), codeNames, primaryCodes });
  st.weeks = (daysBetween(p.from, p.to) + 1) / 7;
  S.freqCache.set(key, st);
  return st;
}
async function viewFrequency(el) {
  const [la, lb] = abLabels();
  const cached = (p) => p && S.freqCache.get(`${S.stream}|${p.from}|${p.to}|${[...testSet()].join(',')}`);
  let fa = cached(S.A), fb = cached(S.B);
  const draw = () => {
    if (!fa) {
      el.innerHTML = `<h1 class="vt">תדירות משלוח ללקוח — ${STREAMS[S.stream]}</h1>
        ${section('חישוב תדירות', `<p>התדירות מחושבת מהרשימה המוצפנת של מספרי הטלפון בכל יום (המספרים עצמם לא נשמרים). לתקופות ארוכות של דיוור שיווקי החישוב יכול לקחת כמה שניות.</p><button class="btn" id="calc">חישוב לתקופה ${pLabel(S.A)}${S.B ? ` ולתקופת ההשוואה` : ''}</button><p id="fprog" class="muted"></p>`)}`;
      $('#calc').onclick = async () => {
        $('#calc').disabled = true;
        const prog = (t) => { $('#fprog').textContent = t; };
        try {
          fa = await loadFreq(S.stream, S.A, (n) => prog(`נטענו ${n} קבצי נתונים…`));
          if (S.B) fb = await loadFreq(S.stream, S.B, (n) => prog(`תקופת השוואה: נטענו ${n}…`));
          draw();
        } catch (e) { prog('שגיאה: ' + e.message); }
      };
      return;
    }
    const surveyRows = S.stream === 'survey';
    const row = (label, a, b, f, good) => `<tr><td>${label}</td><td class="num">${fmtVal(a, f)}</td>${fb !== undefined && S.B ? `<td class="num">${fmtVal(b, f)}</td>${deltaCell(a, b, f, good)}` : ''}</tr>`;
    const v = (x, k) => x?.[k];
    const rate = (x, k, d) => (x ? div(x[k], x[d]) : null);
    el.innerHTML = `<h1 class="vt">תדירות משלוח ללקוח — ${STREAMS[S.stream]}</h1>
      ${section('מדדי תדירות', `<div class="tablewrap"><table class="t"><thead><tr><th>מדד</th><th class="num">${la}</th>${S.B ? `<th class="num">${lb}</th><th class="num">שינוי</th>` : ''}</tr></thead><tbody>
        ${row('לקוחות ייחודיים', v(fa, 'phones'), v(fb, 'phones'), 'n')}
        ${row('הודעות', v(fa, 'msgs'), v(fb, 'msgs'), 'n')}
        ${row('ממוצע הודעות ללקוח', v(fa, 'avg'), v(fb, 'avg'), '2', -1)}
        ${row('ממוצע הודעות ללקוח בשבוע', fa ? fa.avg / fa.weeks : null, fb ? fb.avg / fb.weeks : null, '2', -1)}
        ${surveyRows ? row('ממוצע סקרים (ללא תזכורות) ללקוח', rate(fa, 'primaryMsgs', 'primaryPhones'), rate(fb, 'primaryMsgs', 'primaryPhones'), '2', -1) : ''}
        ${row('לקוחות שקיבלו 2 הודעות ומעלה', rate(fa, 'multi2', 'phones'), rate(fb, 'multi2', 'phones'), 'p', -1)}
        ${row('מקסימום הודעות ללקוח אחד', v(fa, 'max'), v(fb, 'max'), 'n', -1)}
        ${surveyRows ? row('מקסימום סקרים ללקוח אחד', v(fa, 'maxPrimary'), v(fb, 'maxPrimary'), 'n', -1) : ''}
        ${row('מרווח חציוני בין הודעות לאותו לקוח (שעות)', v(fa, 'gapMedianH'), v(fb, 'gapMedianH'), '1', 1)}
        ${row('מרווחים קצרים משעה', rate(fa, 'gapsUnder1h', 'gapsTotal'), rate(fb, 'gapsUnder1h', 'gapsTotal'), 'p2', -1)}
        ${row('מרווחים קצרים מיממה', rate(fa, 'gapsUnder24h', 'gapsTotal'), rate(fb, 'gapsUnder24h', 'gapsTotal'), 'p', -1)}
        ${row('מרווחים קצרים משבוע', rate(fa, 'gapsUnder7d', 'gapsTotal'), rate(fb, 'gapsUnder7d', 'gapsTotal'), 'p', -1)}
        ${row('ימי־לקוח עם 2+ הודעות', v(fa, 'sameDay'), v(fb, 'sameDay'), 'n', -1)}
        ${!surveyRows ? row('לקוחות שקיבלו 3 קמפיינים ומעלה', v(fa, 'groups3'), v(fb, 'groups3'), 'n', -1) : ''}
      </tbody></table></div>`, `"בשבוע" = ממוצע ללקוח חלקי מספר השבועות בתקופה. מספרי בדיקה מוחרגים (${(S.settings.testNumbers || []).length} מוגדרים).`)}
      <div class="cols">
        <section class="panel"><h2>לקוחות לפי מספר הודעות</h2><div class="chart"><canvas id="cF"></canvas></div></section>
        ${section(surveyRows ? 'שילובי הודעות' : 'מסלולי קמפיינים נפוצים', `<div class="tablewrap scroll"><table class="t"><thead><tr><th>שילוב</th><th class="num">לקוחות</th><th class="num">%</th></tr></thead><tbody>${fa.combos.map(([k, n]) => `<tr><td>${esc(k)}</td><td class="num">${fN(n)}</td><td class="num">${fP(n / fa.phones)}</td></tr>`).join('')}</tbody></table></div>`)}
      </div>
      ${section('מספרים שקיבלו הכי הרבה הודעות', fa.heavy.length ? `<p>מספרים שקיבלו 15 הודעות ומעלה בתקופה. אם אלה מספרי בדיקה פנימיים, סמנו אותם כדי להחריג אותם מהחישובים.</p><div class="tablewrap"><table class="t"><thead><tr><th>מזהה מוצפן</th><th class="num">הודעות</th><th></th></tr></thead><tbody>${fa.heavy.map(([h, n]) => `<tr><td class="ltr" dir="ltr">${esc(h)}</td><td class="num">${fN(n)}</td><td><button class="btn ghost sm" data-test="${esc(h)}">סימון כמספר בדיקה</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">אין לקוחות עם 15 הודעות ומעלה.</p>')}`;
    const keys = Object.keys(fa.hist);
    const ds = [{ label: la, data: keys.map((k) => fa.hist[k] / fa.phones * 100), backgroundColor: colA() }];
    if (fb) ds.push({ label: lb, data: keys.map((k) => fb.hist[k] / fb.phones * 100), backgroundColor: colB() });
    chart($('#cF'), { type: 'bar', data: { labels: keys, datasets: ds }, options: baseOpts() });
    $$('[data-test]', el).forEach((b) => b.addEventListener('click', async () => {
      const label = prompt('שם או תיאור למספר הבדיקה:', 'מספר בדיקה');
      if (label == null) return;
      S.settings.testNumbers = [...(S.settings.testNumbers || []), { hash: b.dataset.test, label }];
      await S.db.saveSettings(S.settings); S.freqCache.clear(); toast('המספר סומן כמספר בדיקה. יש לחשב שוב.'); render();
    }));
  };
  draw();
}

// ---------- responses ----------
async function viewResponses(el) {
  const R = S.responses.slice().sort((a, b) => b.to.localeCompare(a.to));
  if (!R.length) { el.innerHTML = `<h1 class="vt">מענה לסקר</h1>${empty('עדיין לא יובאו נתוני מענה. אפשר לייבא את קובץ האקסל ממערכת הסקרים.')}`; return; }
  S.rA = R.find((r) => r.id === S.rA)?.id || R[0].id;
  S.rB = R.find((r) => r.id === S.rB && r.id !== S.rA)?.id || R.find((r) => r.id !== S.rA)?.id || '';
  const ra = R.find((r) => r.id === S.rA), rb = R.find((r) => r.id === S.rB);
  const latest = R[0];
  const areaOf = Object.fromEntries(latest.rows.map((r) => [r.branch, r.g1 || 'ללא אזור']));
  const ownOf = (b) => (areaOf[b] ? (areaOf[b] === 'אזור זכיינים' ? 'זכיינים' : 'אלגד') : 'לא ידוע');
  const tot = (r) => r ? r.rows.reduce((t, x) => ({ c: t.c + x.customers, r: t.r + x.reached, k: t.k + x.clicked, a: t.a + x.answered }), { c: 0, r: 0, k: 0, a: 0 }) : null;
  const ta = tot(ra), tb = tot(rb);
  const segIn = (r) => r ? sumDays(range('survey', r.from, r.to)) : null;
  const sa = segIn(ra), sb = segIn(rb);
  const mm = (t, sms) => t ? { c: t.c, r: t.r, k: t.k, a: t.a, ctr: div(t.k, t.r), rr: div(t.a, t.r), comp: div(t.a, t.k), spa: sms?.n ? div(sms.seg, t.a) : null, cpa: sms?.n ? div(cost(sms), t.a) : null } : null;
  const A = mm(ta, sa), B = mm(tb, sb);
  const fr = [['לקוחות', 'c', 'n'], ['תוקשרו', 'r', 'n'], ['לחצו על הקישור', 'k', 'n'], ['ענו על הסקר', 'a', 'n'], ['שיעור לחיצה (מתוך תוקשרו)', 'ctr', 'p', 1], ['שיעור מענה (מתוך תוקשרו)', 'rr', 'p', 1], ['השלימו את הסקר אחרי לחיצה', 'comp', 'p', 1], ['מקטעים לחיוב לכל מענה', 'spa', '2', -1], ['עלות SMS לכל מענה', 'cpa', 'm', -1]];
  const groupBy = (r, fn) => { const g = {}; (r?.rows || []).forEach((x) => { const k = fn(x.branch); const o = g[k] || (g[k] = { r: 0, k: 0, a: 0, n: 0 }); o.r += x.reached; o.k += x.clicked; o.a += x.answered; o.n++; }); return g; };
  const own = (r) => groupBy(r, ownOf), area = (r) => groupBy(r, (b) => areaOf[b] || 'ללא אזור');
  const gTable = (ga, gb, label) => { const keys = Object.keys(ga).sort((x, y) => div(ga[y].a, ga[y].r) - div(ga[x].a, ga[x].r));
    return `<div class="tablewrap"><table class="t"><thead><tr><th>${label}</th><th class="num">סניפים</th><th class="num">מענה ${esc(ra.label)}</th>${rb ? `<th class="num">מענה ${esc(rb.label)}</th><th class="num">הפרש</th>` : ''}<th class="num">לחיצה ${esc(ra.label)}</th>${rb ? `<th class="num">לחיצה ${esc(rb.label)}</th><th class="num">הפרש</th>` : ''}</tr></thead><tbody>
      ${keys.map((k) => { const a = ga[k], b = gb?.[k]; const x1 = div(a.a, a.r), y1 = b ? div(b.a, b.r) : null, x2 = div(a.k, a.r), y2 = b ? div(b.k, b.r) : null;
        return `<tr><td>${esc(k)}</td><td class="num">${a.n}</td><td class="num">${fP(x1)}</td>${rb ? `<td class="num">${fP(y1)}</td>${deltaCell(x1, y1, 'p', 1)}` : ''}<td class="num">${fP(x2)}</td>${rb ? `<td class="num">${fP(y2)}</td>${deltaCell(x2, y2, 'p', 1)}` : ''}</tr>`; }).join('')}</tbody></table></div>`; };
  // branch level
  const bm = (r) => Object.fromEntries((r?.rows || []).map((x) => [x.branch, x]));
  const BA = bm(ra), BB = bm(rb);
  const smsB = sa?.branches || {};
  const brs = Object.keys(BA).sort((x, y) => BA[y].customers - BA[x].customers);
  const brRows = brs.map((b) => { const a = BA[b], x = BB[b]; const s = smsB[safeKey(b)] || smsB[b];
    return { b, rr: div(a.answered, a.reached), rrB: x ? div(x.answered, x.reached) : null, ctr: div(a.clicked, a.reached), rem: s ? div(s.rem * 100, s.n) : null, gift: s ? div(s.gift, s.n) : null, bl: s ? div(s.b, s.n) : null, sent: s?.n, cust: a.customers }; });
  brRows.forEach((r) => { r.d = r.rrB != null ? (r.rr - r.rrB) * 100 : null; });
  const corr = (k) => pearson(brRows.map((r) => r.d), brRows.map((r) => r[k]));
  const corrLevel = (k) => pearson(brRows.map((r) => r.rr), brRows.map((r) => r[k]));
  const answeredChange = A && B ? A.a / B.a - 1 : null;
  const insights = [];
  if (A && B) {
    const d = (A.rr - B.rr) * 100;
    insights.push(ins(d >= 0 ? 'good' : 'bad', `שיעור המענה ${d >= 0 ? 'עלה' : 'ירד'} מ־${fP(B.rr)} ל־${fP(A.rr)} (${d >= 0 ? '+' : ''}${fD(d)} נק׳).`));
    insights.push(ins(answeredChange >= 0 ? 'good' : 'warn', `מספר המענים ${answeredChange >= 0 ? 'עלה' : 'ירד'} ב־${fD(Math.abs(answeredChange) * 100)}%, מ־${fN(B.a)} ל־${fN(A.a)}.`));
    const vol = (A.r - B.r) * B.rr, rate = (A.rr - B.rr) * A.r;
    insights.push(ins('info', `פירוק השינוי במענים: שינוי בכמות הלקוחות שתוקשרו ${vol >= 0 ? 'הוסיף' : 'הוריד'} כ־${fN(Math.abs(vol))} מענים, והשינוי בשיעור המענה ${rate >= 0 ? 'הוסיף' : 'הוריד'} כ־${fN(Math.abs(rate))}.`));
    if (A.spa && B.spa) insights.push(ins(A.spa > B.spa ? 'bad' : 'good', `מקטעים לחיוב לכל מענה: מ־${fD(B.spa)} ל־${fD(A.spa)} (${A.spa > B.spa ? '+' : ''}${fD((A.spa / B.spa - 1) * 100, 0)}%).`));
    const cr = corr('rem'), cg = corr('gift');
    if (cr != null) insights.push(ins('info', `מתאם בין תזכורות לכל 100 סקרים לבין השינוי בשיעור המענה בסניף: ${fD(cr, 2)}. ${cr > 0.3 ? 'סניפים עם יותר תזכורות השתפרו יותר.' : ''}`));
    if (cg != null) insights.push(ins('info', `מתאם בין שיעור ההודעות עם שורת מתנה לבין השינוי בשיעור המענה: ${fD(cg, 2)}. ${Math.abs(cg) < 0.2 ? 'אין קשר נראה.' : ''}`));
  }
  if (A) insights.push(ins('info', `${fP(A.comp)} ממי שלוחץ על הקישור משלים את הסקר — צוואר הבקבוק הוא הלחיצה (${fP(A.ctr)}).`));
  el.innerHTML = `<h1 class="vt">מענה לסקר</h1>
    <div class="pickers"><label>תקופה א <select id="rA">${R.map((r) => `<option value="${r.id}" ${r.id === S.rA ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}</select></label>
      <label>תקופה ב <select id="rB"><option value="">ללא השוואה</option>${R.filter((r) => r.id !== S.rA).map((r) => `<option value="${r.id}" ${r.id === S.rB ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}</select></label></div>
    ${section('מה בולט', insightList(insights), 'נתוני המענה מגיעים ממערכת הסקרים ברמת סניף לכל תקופה. נתוני ה־SMS (מקטעים, תזכורות, מתנה) נלקחים מאותו טווח תאריכים.')}
    <div class="cols">
      ${section('משפך המענה', `<div class="tablewrap"><table class="t"><thead><tr><th>שלב</th><th class="num">${esc(ra.label)}</th>${rb ? `<th class="num">${esc(rb.label)}</th><th class="num">שינוי</th>` : ''}</tr></thead><tbody>${fr.map(([l, k, f, g]) => `<tr><td>${l}</td><td class="num">${fmtVal(A?.[k], f)}</td>${rb ? `<td class="num">${fmtVal(B?.[k], f)}</td>${deltaCell(A?.[k], B?.[k], f, g)}` : ''}</tr>`).join('')}</tbody></table></div>`)}
      <section class="panel"><h2>משפך</h2><div class="chart"><canvas id="cFun"></canvas></div></section>
    </div>
    ${section('אלגד מול זכיינים', gTable(own(ra), rb ? own(rb) : null, 'סוג סניף'), `סוג הסניף והאזור לפי מבנה הקבוצות ב־${esc(latest.label)}, עבור כל התקופות.`)}
    ${section('לפי אזור', gTable(area(ra), rb ? area(rb) : null, 'אזור'))}
    ${section('לפי סניף', `<div class="tablewrap scroll"><table class="t"><thead><tr><th>סניף</th><th class="num">מענה ${esc(ra.label)}</th>${rb ? `<th class="num">מענה ${esc(rb.label)}</th><th class="num">הפרש</th>` : ''}<th class="num">לחיצה</th><th class="num">% חסום (SMS)</th><th class="num">תזכורות ל־100</th><th class="num">% עם מתנה</th></tr></thead><tbody>
      ${brRows.map((r) => `<tr><td>${esc(r.b)}</td><td class="num heat good-h" style="--h:${Math.min(1, Math.max(0, ((r.rr || 0) - 0.1) / 0.15))}">${fP(r.rr)}</td>${rb ? `<td class="num">${fP(r.rrB)}</td>${deltaCell(r.rr, r.rrB, 'p', 1)}` : ''}<td class="num">${fP(r.ctr)}</td><td class="num">${fP(r.bl)}</td><td class="num">${fD(r.rem)}</td><td class="num">${fP(r.gift)}</td></tr>`).join('')}</tbody></table></div>`,
      `מתאם עם שיעור המענה: חסימה ${fD(corrLevel('bl'), 2)}, תזכורות ${fD(corrLevel('rem'), 2)}, מתנה ${fD(corrLevel('gift'), 2)}. מתאם בין סניפים אינו מוכיח סיבתיות.`)}`;
  $('#rA').onchange = (e) => { S.rA = e.target.value; render(); };
  $('#rB').onchange = (e) => { S.rB = e.target.value; render(); };
  const st = ['תוקשרו', 'לחצו', 'ענו'];
  const ds = [{ label: ra.label, data: [ta.r, ta.k, ta.a], backgroundColor: colA() }];
  if (tb) ds.push({ label: rb.label, data: [tb.r, tb.k, tb.a], backgroundColor: colB() });
  chart($('#cFun'), { type: 'bar', data: { labels: st, datasets: ds }, options: baseOpts() });
}

// ---------- import & settings ----------
async function viewImport(el) {
  const s = S.settings;
  const counts = (st) => { const d = daysOf(st); return d.length ? `${fN(d.length)} ימים, ${fmtDate(d[0].date)}–${fmtDate(d.at(-1).date)}` : 'אין נתונים'; };
  const imports = await S.db.loadImports();
  el.innerHTML = `<h1 class="vt">ייבוא והגדרות</h1>
    ${section('מה יש במסד הנתונים', `<dl class="facts"><dt>סקרים</dt><dd>${counts('survey')}</dd><dt>דיוור שיווקי</dt><dd>${counts('marketing')}</dd><dt>תקופות מענה</dt><dd>${S.responses.length ? S.responses.map((r) => esc(r.label)).join(', ') : 'אין'}</dd><dt>מסקנות שמורות</dt><dd>${fN(S.insights.length)}</dd></dl>`)}
    ${section('ייבוא דוח SMS', `<p>קובץ CSV כפי שהוא יוצא ממערכת ה־SMS (סקרים, דיוור שיווקי או שניהם). אפשר לבחור כמה קבצים יחד. ימים שכבר קיימים במסד יוחלפו בנתונים מהקובץ החדש.</p>
      <label class="drop"><input type="file" id="csvIn" accept=".csv,text/csv" multiple><span>בחירת קבצי CSV</span></label>
      <div id="csvProg" class="prog" hidden><div class="bar"><i></i></div><p></p></div><div id="csvOut"></div>`,
      'מספרי טלפון נשמרים כמזהה מוצפן בלבד. נוסח ההודעות ושמות הלקוחות לא נשמרים במסד.')}
    ${section('ייבוא נתוני מענה לסקר', `<p>קובץ האקסל ממערכת הסקרים (טבלת הסניפים, למשל Table-ChildEntities-…xlsx).</p>
      <label class="drop"><input type="file" id="respIn" accept=".xlsx,.xls,.csv"><span>בחירת קובץ מענה</span></label><div id="respOut"></div>`)}
    ${section('מסקנות הניתוח הראשוני', `<p>טעינת ${fN(SEED().length)} המסקנות וההמלצות מהניתוח שנעשה על קבצי האקסל (סקרים 2025 מול 2026 ודיוור נובמבר 2026). פריטים קיימים עם אותו טקסט לא ישוכפלו.</p><button class="btn" id="seed">טעינת המסקנות</button>`)}
    ${section('עלות', `<form id="setForm" class="form"><label>מחיר (₪) <input name="price" type="number" step="0.0001" min="0" value="${esc(s.price ?? 0.005)}" required></label>
      <label>חיוב לפי <select name="billing"><option value="segment" ${s.billing !== 'message' ? 'selected' : ''}>מקטע</option><option value="message" ${s.billing === 'message' ? 'selected' : ''}>הודעה</option></select></label><button class="btn">שמירה</button></form>`, '0.005 ₪ = חצי אגורה (50,000 ₪ ל־10 מיליון).')}
    ${section('מספרי בדיקה', `<p>מספרים פנימיים שמקבלים כל קמפיין. הם מוחרגים מחישובי התדירות.</p>
      <form id="testForm" class="form"><label>מספר טלפון <input name="phone" inputmode="tel" placeholder="0541234567" required></label><label>תיאור <input name="label" placeholder="למשל: צוות שיווק"></label><button class="btn">הוספה</button></form>
      <ul class="plain">${(s.testNumbers || []).map((t, i) => `<li><span class="ltr" dir="ltr">${esc(t.hash)}</span> ${esc(t.label || '')} <button class="x" data-rm="${i}">הסרה</button></li>`).join('') || '<li class="muted">אין מספרי בדיקה מוגדרים.</li>'}</ul>`)}
    ${section('ייבואים אחרונים', imports.length ? `<div class="tablewrap"><table class="t"><thead><tr><th>מתי</th><th>קובץ</th><th class="num">שורות</th><th>תוכן</th><th>מי</th></tr></thead><tbody>${imports.map((i) => `<tr><td>${esc(new Date(i.at).toLocaleString('he-IL'))}</td><td>${esc(i.file)}</td><td class="num">${fN(i.rows)}</td><td>${esc(i.summary || '')}</td><td>${esc(i.by || '')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">עדיין לא בוצע ייבוא.</p>')}`;

  $('#csvIn').onchange = (e) => importCsv([...e.target.files]);
  $('#respIn').onchange = (e) => importResponses(e.target.files[0]);
  $('#seed').onclick = seedInsights;
  $('#setForm').onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.target); S.settings.price = +f.get('price'); S.settings.billing = f.get('billing'); await S.db.saveSettings(S.settings); toast('ההגדרות נשמרו'); };
  $('#testForm').onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.target); const hash = phoneHash(f.get('phone'));
    S.settings.testNumbers = [...(S.settings.testNumbers || []).filter((t) => t.hash !== hash), { hash, label: f.get('label') || '' }];
    await S.db.saveSettings(S.settings); S.freqCache.clear(); render(); };
  $$('[data-rm]', el).forEach((b) => b.onclick = async () => { S.settings.testNumbers.splice(+b.dataset.rm, 1); await S.db.saveSettings(S.settings); S.freqCache.clear(); render(); });
}

async function readCsvFile(file, agg, onProgress) {
  const csv = new CsvStream((r) => agg.add(r));
  const reader = file.stream().getReader();
  const dec = new TextDecoder('utf-8');
  let read = 0, lastTick = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    read += value.byteLength;
    csv.push(dec.decode(value, { stream: true }));
    const now = performance.now();
    if (now - lastTick > 120) { lastTick = now; onProgress(read / file.size); await new Promise((r) => setTimeout(r, 0)); }
  }
  csv.push(dec.decode()); csv.end();
}

async function importCsv(files) {
  if (!files.length) return;
  const prog = $('#csvProg'), out = $('#csvOut');
  prog.hidden = false;
  const setP = (frac, txt) => { $('i', prog).style.width = (frac * 100).toFixed(1) + '%'; $('p', prog).textContent = txt; };
  const summaries = [];
  try {
    for (const file of files) {
      const agg = new DayAggregator();
      await readCsvFile(file, agg, (f) => setP(f * 0.5, `קורא את ${file.name}… ${fD(f * 100, 0)}%`));
      const res = agg.finish().filter((r) => r.doc.stream !== 'other');
      if (!res.length) { summaries.push(`<p class="bad">${esc(file.name)}: לא נמצאו הודעות סקר או דיוור. ודאו שזה דוח ה־SMS המקורי.</p>`); continue; }
      const existing = new Map([...S.days.survey, ...S.days.marketing].map((d) => [d.stream + '_' + d.date, d.shards || 0]));
      await S.db.writeDays(res, existing, (done, total) => setP(0.5 + 0.5 * done / total, `שומר ב־Firebase… ${done}/${total}`));
      const byStream = {};
      res.forEach((r) => { const s = r.doc.stream; const b = byStream[s] || (byStream[s] = { days: 0, n: 0, from: r.doc.date, to: r.doc.date }); b.days++; b.n += r.doc.n; if (r.doc.date < b.from) b.from = r.doc.date; if (r.doc.date > b.to) b.to = r.doc.date; });
      const other = Object.entries(agg.otherGroups).map(([k, v]) => `${k}: ${fN(v)}`).join(', ');
      const summary = Object.entries(byStream).map(([s, b]) => `${STREAMS[s]}: ${fN(b.n)} הודעות, ${b.days} ימים (${fmtDate(b.from)}–${fmtDate(b.to)})`).join(' | ');
      await S.db.logImport({ file: file.name, rows: agg.rows, summary, other, at: new Date().toISOString(), by: S.user?.email || '' });
      summaries.push(`<p class="good">${esc(file.name)}: ${esc(summary)}.${other ? ` הודעות אחרות שלא נכללו: ${esc(other)}.` : ''}${agg.skipped ? ` ${fN(agg.skipped)} שורות ללא תאריך דולגו.` : ''}${agg.duplicates ? ` ${fN(agg.duplicates)} הודעות כפולות דולגו.` : ''}</p>`);
      await reloadDays();
      if (!S.A || !lastDate(S.stream)) { if (!lastDate(S.stream)) S.stream = Object.keys(byStream)[0]; initPeriod(); }
      for (const [s, b] of Object.entries(byStream)) await saveDailyInsight(s, b.to, dailyInsights(s, b.to));
      S.lastImported = byStream;
    }
    setP(1, 'הייבוא הסתיים.');
    out.innerHTML = summaries.join('') + (S.lastImported ? `<button class="btn" id="toDaily">לניתוח היומי של היום האחרון בקובץ</button>` : '');
    if ($('#toDaily')) $('#toDaily').onclick = () => { const [s, b] = Object.entries(S.lastImported)[0]; S.stream = s; S.dailyDate = b.to; S.view = 'daily'; initPeriod(); render(); };
  } catch (e) {
    console.error(e); setP(0, ''); out.innerHTML = `<p class="bad">הייבוא נכשל: ${esc(e.message)}</p>`;
  }
}

async function importResponses(file) {
  const out = $('#respOut');
  if (!file || !window.XLSX) { out.innerHTML = '<p class="bad">לא ניתן לקרוא את הקובץ.</p>'; return; }
  const wb = window.XLSX.read(await file.arrayBuffer(), { type: 'array' });
  let best = null; let period = null;
  for (const name of wb.SheetNames) {
    const rows = window.XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });
    for (const r of rows) { const t = r.join(' '); const m = /(\d{4}-\d{2}-\d{2})\s*-\s*(\d{4}-\d{2}-\d{2})/.exec(t); if (m) period = { from: m[1], to: m[2] }; }
    const hi = rows.findIndex((r) => r.includes('ענו') && r.includes('תוקשרו'));
    if (hi < 0) continue;
    const head = rows[hi].map((x) => String(x).trim());
    const bi = head.findIndex((h) => h === 'סניפים/קבוצות' || h === 'סניף');
    const score = rows.length - hi + (head.includes('קבוצה 3') ? 1000 : 0);
    if (bi >= 0 && (!best || score > best.score)) best = { name, rows: rows.slice(hi + 1), head, bi, score };
  }
  if (!best) { out.innerHTML = '<p class="bad">לא נמצאה טבלה עם העמודות "סניף", "תוקשרו" ו"ענו".</p>'; return; }
  const col = (n) => best.head.indexOf(n);
  const rows = best.rows.filter((r) => String(r[best.bi]).trim() && String(r[best.bi]).trim() !== 'כללי').map((r) => ({
    branch: String(r[best.bi]).replace(/\u00a0/g, ' ').trim(),
    g1: col('קבוצה 1') >= 0 ? String(r[col('קבוצה 1')]).trim() : '', g2: col('קבוצה 2') >= 0 ? String(r[col('קבוצה 2')]).trim() : '', g3: col('קבוצה 3') >= 0 ? String(r[col('קבוצה 3')]).trim() : '',
    customers: +r[col('לקוחות')] || 0, reached: +r[col('תוקשרו')] || 0, clicked: +r[col('לחצו')] || 0, answered: +r[col('ענו')] || 0,
  })).filter((r) => r.reached > 0);
  if (!period) { const m = /(\d{8})-(\d{8})/.exec(file.name); if (m) period = { from: `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6)}`, to: `${m[2].slice(0, 4)}-${m[2].slice(4, 6)}-${m[2].slice(6)}` }; }
  const t = rows.reduce((a, r) => ({ r: a.r + r.reached, a: a.a + r.answered }), { r: 0, a: 0 });
  out.innerHTML = `<form id="respForm" class="form"><p>נמצאו ${rows.length} סניפים בגיליון "${esc(best.name)}": ${fN(t.r)} תוקשרו, ${fN(t.a)} ענו (${fP(t.a / t.r)}).</p>
    <label>מתאריך <input type="date" name="from" value="${period?.from || ''}" required></label><label>עד תאריך <input type="date" name="to" value="${period?.to || ''}" required></label>
    <label>שם התקופה <input name="label" value="${period ? `${fmtDate(period.from)}–${fmtDate(period.to)}` : ''}" required></label><button class="btn">שמירת נתוני המענה</button></form>`;
  $('#respForm').onsubmit = async (e) => {
    e.preventDefault(); const f = new FormData(e.target);
    const doc = { id: `${f.get('from')}_${f.get('to')}`, from: f.get('from'), to: f.get('to'), label: f.get('label'), rows, file: file.name, at: new Date().toISOString() };
    await S.db.saveResponse(doc);
    S.responses = S.responses.filter((r) => r.id !== doc.id).concat(doc);
    out.innerHTML = `<p class="good">נתוני המענה לתקופה ${esc(doc.label)} נשמרו.</p>`;
  };
}

function SEED() { try { return JSON.parse(document.getElementById('seed-insights').textContent); } catch { return []; } }
async function seedInsights() {
  const have = new Set(S.insights.map((i) => i.stream + '|' + i.text));
  const todo = SEED().filter((i) => !have.has(i.stream + '|' + i.text));
  for (const i of todo) { i.id = await S.db.addInsight(i); S.insights.push(i); }
  toast(todo.length ? `נטענו ${todo.length} מסקנות והמלצות` : 'כל המסקנות כבר קיימות');
}

async function reloadDays() {
  const all = await S.db.loadDays();
  S.days = { survey: [], marketing: [] };
  all.forEach((d) => { if (S.days[d.stream]) S.days[d.stream].push(d); });
  Object.values(S.days).forEach((a) => a.sort((x, y) => x.date.localeCompare(y.date)));
  S.freqCache.clear();
}

// Days imported by the e-mail job have no saved daily analysis yet: create it on first open.
async function refreshDailyInsights() {
  for (const stream of ['survey', 'marketing']) {
    for (const d of daysOf(stream).slice(-3)) {
      const saved = S.dailyInsights.find((x) => x.stream === stream && x.date === d.date);
      if (saved && (!d.importedAt || saved.at >= d.importedAt)) continue;
      try { await saveDailyInsight(stream, d.date, dailyInsights(stream, d.date)); } catch (e) { console.warn('daily insight', e); }
    }
  }
}

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 3500);
}

// ============ boot ============
export async function start(db) {
  S.db = db;
  $$('.tile button').forEach((b) => b.addEventListener('click', () => { S.stream = b.dataset.stream; S.preset = S.stream === 'survey' ? '92' : '7'; S.cmp = S.stream === 'survey' ? 'yoy' : 'prev'; initPeriod(); render(); }));
  $('#signout').onclick = () => db.signOut();
  db.onUser(async (user) => {
    S.user = user;
    $('#login').hidden = !!user; $('#app').hidden = !user;
    if (!user) return;
    $('#who').textContent = user.email || '';
    $('#view').innerHTML = '<div class="loading">טוען נתונים…</div>';
    try {
      const [settings, responses, insights, daily] = await Promise.all([db.loadSettings(), db.loadResponses(), db.loadInsights(), db.loadDailyInsights()]);
      S.settings = { ...defaultSettings, ...(settings || {}) };
      S.responses = responses; S.insights = insights; S.dailyInsights = daily;
      await reloadDays();
      await refreshDailyInsights();
      if (!daysOf('survey').length && daysOf('marketing').length) S.stream = 'marketing';
      if (!daysOf('survey').length && !daysOf('marketing').length) S.view = 'import';
      initPeriod(); render();
    } catch (e) {
      console.error(e);
      $('#view').innerHTML = `<div class="error">לא ניתן לטעון נתונים מ־Firebase: ${esc(e.message)}. בדקו שהמשתמש מורשה בכללי האבטחה (firestore.rules).</div>`;
    }
  });
}

export const _test = { S, importResponses, metrics, periodInsights, dailyInsights, sumDays, render, initPeriod, applyPreset, computeB, VIEWS };
