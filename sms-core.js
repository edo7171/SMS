// sms-core.js — classification + daily aggregation for Domino's SMS reports.
// No DOM, no Firebase: the same module runs in the dashboard and later in a
// Cloud Function that ingests the daily e-mail report.

export const STREAMS = { survey: 'סקרים', marketing: 'דיוור שיווקי', other: 'אחר' };

export const COL = {
  date: 'תאריך שליחה', phone: 'מספר טלפון', text: 'נוסח ההודעה', status: 'סטטוס השליחה',
  reason: 'סיבה', segments: 'מספר מקטעים', sender: 'זיהוי השולח', campaign: 'שם הקמפיין',
};

export const FAIL_CATS = {
  blocked: 'חסום לשירות (הלקוח חסם)',
  expired: 'פג תוקף (מכשיר כבוי / ללא קליטה)',
  invalid: 'מספר לא קיים / לא פעיל',
  carrier: 'חסימה אצל המפעיל',
  system: 'תקלת מערכת / ממשק',
  general: 'כשל מסירה כללי',
  pending: 'ללא סטטוס סופי',
};
// failures that will repeat on every send to the same number
export const PERMANENT_CATS = ['invalid', 'carrier'];

// ---------- hashing (phones are never stored in clear) ----------
export function cyrb53(str, seed = 0x5d0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
export function normPhone(p) {
  let s = String(p ?? '').replace(/\D/g, '');
  if (s.startsWith('972')) s = s.slice(3);
  return s.replace(/^0+/, '');
}
export const phoneHash = (p) => cyrb53('p:' + normPhone(p)).toString(36);
export const shortCode = (key) => cyrb53('g:' + key).toString(36).slice(0, 6);

// ---------- parsing ----------
export const cleanHeader = (h) => String(h).replace(/^\ufeff/, '').trim().replace(/^"|"$/g, '').trim();

export function parseDate(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/.exec(String(s || '').trim());
  if (!m) return null;
  const [, dd, mm, yyyy, HH, MM] = m;
  const date = `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  const dow = new Date(Date.UTC(+yyyy, +mm - 1, +dd)).getUTCDay(); // 0 = Sunday
  return { date, hour: +HH, minute: +HH * 60 + +MM, dow };
}

function statusOf(s) {
  s = String(s || '');
  if (s === 'התקבלה') return 'd';
  if (s.includes('חסום')) return 'b';
  if (s === 'נשלחה' || !s) return 'p';
  if (s.startsWith('לא התקבלה')) return 'f';
  return 'p';
}

export function cleanReason(r) {
  return String(r || '').replace(/^Operator Response:\s*/, '').trim();
}

export function failCategory(st, reason) {
  if (st === 'd') return null;
  if (st === 'b') return 'blocked';
  if (st === 'p') return 'pending';
  const r = cleanReason(reason);
  if (!r) return 'pending';
  if (r === 'Blocked Number') return 'blocked';
  if (/Expired|validity|Delayed/i.test(r)) return 'expired';
  if (/Illegal Subscriber|Unknown subscriber|RTDB|Unknown Destination|Invalid Destination|No SMS teleservice|Facility not supported|Call barred|subscriber error|absent subscriber/i.test(r)) return 'invalid';
  if (/Target blocked|subscriber blocked/i.test(r)) return 'carrier';
  if (/Api|Authorization|Empty reply|UNKNOWN ERROR|SMSC|provision|HLR|SS7|A2P/i.test(r)) return 'system';
  return 'general';
}

// Streaming CSV parser (quoted fields, "" escapes, multi-line values, CRLF).
// Feed it correctly decoded text chunks (TextDecoder with stream:true), so
// multi-byte Hebrew characters are never split between chunks.
export class CsvStream {
  constructor(onRecord) { this.onRecord = onRecord; this.field = ''; this.rec = []; this.inQ = false; this.pendingQ = false; this.header = null; }
  _emit() {
    this.rec.push(this.field); this.field = '';
    const r = this.rec; this.rec = [];
    if (r.length === 1 && r[0] === '') return;
    if (!this.header) { this.header = r.map(cleanHeader); return; }
    const o = {};
    for (let i = 0; i < this.header.length; i++) o[this.header[i]] = r[i] ?? '';
    this.onRecord(o);
  }
  push(s) {
    let field = this.field;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (this.pendingQ) { // previous char was a quote inside a quoted field
        this.pendingQ = false;
        if (c === '"') { field += '"'; continue; }
        this.inQ = false;
      }
      if (this.inQ) {
        if (c === '"') { this.pendingQ = true; continue; }
        field += c; continue;
      }
      if (c === '"') { this.inQ = true; continue; }
      if (c === ',') { this.rec.push(field); field = ''; continue; }
      if (c === '\n') { this.field = field; this._emit(); field = ''; continue; }
      if (c === '\r') continue;
      field += c;
    }
    this.field = field;
  }
  end() {
    if (this.pendingQ) { this.pendingQ = false; this.inQ = false; }
    if (this.field !== '' || this.rec.length) this._emit();
  }
}

// ---------- classification ----------
const SURVEY_SIG = /hwt\.io\/u\/|מנהל(?:ת)?\s+(?:ה|ב)?סניף/;
const BRANCH_RE = /מנהל(?:ת)?\s+(?:ב|ה)?סניף\s*([^\n]+?)\s*$/;

// Known marketing campaigns (named by their text). Unknown ones get a name
// derived from the headline, so new campaigns in daily reports still group.
const MARKETING_RULES = [
  ['סאנדיי פאנדיי', ['סאנדיי פאנדיי']],
  ['CRAZY NOVEMBER — קוד מתחדש', ['זה לא סוד שאנחנו משוגעים']],
  ['CRAZY NOVEMBER — VIP', ['שווה להיות VIP', 'הקליקה הסודית']],
  ['CRAZY NOVEMBER — 30% הנחה', ['חודש ששווה לשמור']],
  ['CRAZY NOVEMBER — תזכורות', ['רק מזכירים על  CRAZY', 'רק מזכירים שיש קרייזי', 'CRAZY']],
  ['משלימים פערים', ['משלימים פערים']],
  ['כרמיאל חוגג 4 שנים', ['כרמיאל חוגג']],
  ['ברכת ראש השנה', ['שנה של אור', 'שנה חדשה היא הזדמנות']],
  ['תזכורת פיצה מתנה', ['פיצה מתנה', 'הפיצה מתנה']],
  ['הטבה אחרי הזמנה', ['איזה כיף שהזמנת', 'לא סטוץ', 'השליח ישמח']],
  ['תזכורת למימוש הטבה', ['רק קפצנו להזכיר', 'לא מתפספסת', 'שכחת', 'הארכנו', 'הימים עוברים', 'לא חבל', 'שלא זכרת', 'מזכירים', 'לא ממומשת', 'לא תפספס', 'הארכה', 'לממש אותה']],
];

function headlineName(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return 'ללא נוסח';
  let first = lines[0];
  const c = first.indexOf(',');
  if (c > -1 && c < 30) first = first.slice(c + 1).trim();
  if (first.length < 8 && lines[1]) first += ' ' + lines[1];
  first = first.replace(/https?:\S+/g, '').replace(/[A-Z0-9]{5,}/g, '').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  return 'קמפיין: ' + (first.slice(0, 45) || 'ללא כותרת');
}

export function classify(row) {
  const text = String(row[COL.text] || '').replace(/\u00a0/g, ' ');
  const sender = String(row[COL.sender] || '').trim();
  const campaignField = String(row[COL.campaign] || '').trim();
  const out = { stream: 'other', group: 'אחר', branch: null, variant: null, gift: false };

  if (SURVEY_SIG.test(text)) {
    out.stream = 'survey';
    const isReminder = text.includes('לאחרונה הזמנת');
    out.group = isReminder ? 'תזכורת לסקר' : 'סקר';
    out.gift = text.includes('במתנה');
    if (isReminder) out.variant = 'תזכורת';
    else if (text.includes('איזה כיף שהזמנת')) out.variant = 'נוסח "איזה כיף שהזמנת"';
    else if (text.includes('איך היתה ההזמנה')) out.variant = out.gift ? 'נוסח "איך היתה ההזמנה" + מתנה' : 'נוסח "איך היתה ההזמנה"';
    else out.variant = 'נוסח אחר';
    const m = BRANCH_RE.exec(text);
    out.branch = m ? m[1].trim() : 'לא זוהה';
    return out;
  }
  if (text.includes('פנייתך התקבלה')) { out.group = 'אישור פנייה לשירות לקוחות'; return out; }
  if (text.includes('סה"כ שענו')) { out.group = 'דוח סניפים פנימי'; return out; }
  if (/^dominos$/i.test(sender) || text.includes('הסרה')) {
    out.stream = 'marketing';
    // the survey system puts technical ids here ("11120757629,GYWx5geoGvB"); only real names are used
    if (campaignField && !/^\d{5,},/.test(campaignField)) { out.group = campaignField; return out; }
    for (const [name, keys] of MARKETING_RULES) {
      if (keys.some((k) => text.includes(k))) { out.group = name; return out; }
    }
    out.group = headlineName(text);
    return out;
  }
  return out;
}

// Firestore map keys: avoid characters that are awkward in field paths.
export const safeKey = (k) => String(k).replace(/\./g, '\u2024').replace(/\//g, '\u2215').replace(/`/g, "'").replace(/^__|__$/g, '_') || '_';
const safeMap = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [safeKey(k), v]));

// ---------- aggregation ----------
const blankCounts = () => ({ n: 0, d: 0, b: 0, f: 0, p: 0, seg: 0, seg2: 0, seg3: 0 });
function addCounts(c, st, seg) {
  c.n++; c[st]++; c.seg += seg; if (seg >= 2) c.seg2++; if (seg >= 3) c.seg3++;
}

export class DayAggregator {
  constructor() { this.days = new Map(); this.rows = 0; this.skipped = 0; this.otherGroups = {}; }

  key(stream, date) { return stream + '_' + date; }

  add(row) {
    this.rows++;
    const t = parseDate(row[COL.date]);
    if (!t) { this.skipped++; return; }
    const cls = classify(row);
    if (cls.stream === 'other') { this.otherGroups[cls.group] = (this.otherGroups[cls.group] || 0) + 1; }
    const k = this.key(cls.stream, t.date);
    let day = this.days.get(k);
    if (!day) {
      day = {
        stream: cls.stream, date: t.date, dow: t.dow, ...blankCounts(),
        hours: Array.from({ length: 24 }, () => [0, 0, 0]), // [sent, delivered, blocked]
        groups: {}, failCat: {}, reasons: {}, branches: {}, variants: {}, codes: {},
        phones: new Map(),
      };
      this.days.set(k, day);
    }
    const st = statusOf(row[COL.status]);
    const seg = parseInt(row[COL.segments], 10) || 0;
    const reason = cleanReason(row[COL.reason]);
    const cat = failCategory(st, reason);

    addCounts(day, st, seg);
    const h = day.hours[t.hour]; h[0]++; if (st === 'd') h[1]++; if (st === 'b') h[2]++;

    const g = day.groups[cls.group] || (day.groups[cls.group] = { ...blankCounts(), fc: {}, cust: 0 });
    addCounts(g, st, seg);
    if (cat) {
      day.failCat[cat] = (day.failCat[cat] || 0) + 1;
      g.fc[cat] = (g.fc[cat] || 0) + 1;
      if (st === 'f') day.reasons[reason] = (day.reasons[reason] || 0) + 1;
    }
    if (cls.stream === 'survey') {
      const b = day.branches[cls.branch] || (day.branches[cls.branch] = { n: 0, d: 0, b: 0, f: 0, seg: 0, rem: 0, gift: 0 });
      if (cls.group === 'תזכורת לסקר') b.rem++;
      else { b.n++; if (st !== 'p') b[st]++; if (cls.gift) b.gift++; }
      b.seg += seg;
      const v = day.variants[cls.variant] || (day.variants[cls.variant] = { ...blankCounts(), len: 0 });
      addCounts(v, st, seg); v.len += String(row[COL.text] || '').length;
    }
    const code = shortCode(cls.group);
    day.codes[code] = cls.group;
    const ph = phoneHash(row[COL.phone]);
    let entries = day.phones.get(ph);
    if (!entries) { entries = []; day.phones.set(ph, entries); }
    entries.push([code, t.minute, st]);
  }

  // Finalise: returns [{dayDoc, shards:[string]}] ready to be written.
  finish(maxShardBytes = 700_000) {
    const out = [];
    for (const day of this.days.values()) {
      const hist = { 1: 0, 2: 0, 3: 0, 4: 0, '5+': 0 };
      let multi = 0, gaps1h = 0;
      const groupCust = {};
      const parts = [];
      for (const [ph, entries] of day.phones) {
        const n = entries.length;
        hist[n >= 5 ? '5+' : n]++;
        if (n >= 2) multi++;
        entries.sort((a, b) => a[1] - b[1]);
        for (let i = 1; i < n; i++) if (entries[i][1] - entries[i - 1][1] < 60) gaps1h++;
        const seen = new Set();
        for (const e of entries) if (!seen.has(e[0])) { seen.add(e[0]); groupCust[e[0]] = (groupCust[e[0]] || 0) + 1; }
        parts.push(ph + '=' + entries.map((e) => e[0] + '@' + e[1] + e[2]).join(','));
      }
      for (const [code, name] of Object.entries(day.codes)) if (day.groups[name]) day.groups[name].cust = groupCust[code] || 0;
      const shards = [];
      let cur = '';
      for (const p of parts) {
        if (cur.length + p.length + 1 > maxShardBytes) { shards.push(cur); cur = ''; }
        cur += (cur ? ';' : '') + p;
      }
      if (cur) shards.push(cur);
      const { phones, ...doc } = day;
      doc.groups = safeMap(doc.groups); doc.reasons = safeMap(doc.reasons);
      doc.branches = safeMap(doc.branches); doc.variants = safeMap(doc.variants);
      doc.codes = Object.fromEntries(Object.entries(doc.codes).map(([c, n]) => [c, safeKey(n)]));
      doc.cust = day.phones.size;
      doc.hist = hist; doc.multi = multi; doc.gaps1h = gaps1h;
      doc.hours = day.hours.map((a) => a.join(',')); // Firestore has no nested arrays
      doc.shards = shards.length;
      out.push({ id: day.stream + '_' + day.date, doc, shards });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }
}

// ---------- reading back shards ----------
// entry string: "<hash>=<code>@<minute><status>,..." ; returns Map hash -> [{date,code,min,st}]
export function parseShardsInto(map, date, str) {
  if (!str) return;
  const base = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) / 60000;
  for (const part of str.split(';')) {
    const eq = part.indexOf('=');
    const ph = part.slice(0, eq);
    let arr = map.get(ph);
    if (!arr) { arr = []; map.set(ph, arr); }
    for (const e of part.slice(eq + 1).split(',')) {
      const at = e.indexOf('@');
      arr.push({ date, code: e.slice(0, at), t: base + parseInt(e.slice(at + 1), 10), st: e.slice(-1) });
    }
  }
}

// Frequency statistics for one period from the phone map.
export function frequencyStats(map, { exclude = new Set(), codeNames = {}, primaryCodes = null } = {}) {
  const hist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, '6-9': 0, '10+': 0 };
  let phones = 0, msgs = 0, multi2 = 0, max = 0, maxPrimary = 0, sameDay = 0, groups3 = 0;
  const gaps = [];
  const combos = new Map();
  const heavy = [];
  let primaryMsgs = 0, primaryPhones = 0;
  for (const [ph, arr] of map) {
    if (exclude.has(ph)) continue;
    phones++;
    const n = arr.length; msgs += n;
    const b = n >= 10 ? '10+' : n >= 6 ? '6-9' : n;
    hist[b]++;
    if (n >= 2) multi2++;
    if (n > max) max = n;
    if (n >= 15) heavy.push([ph, n]);
    arr.sort((a, c) => a.t - c.t);
    const perDay = {};
    for (let i = 0; i < n; i++) {
      perDay[arr[i].date] = (perDay[arr[i].date] || 0) + 1;
      if (i) gaps.push(arr[i].t - arr[i - 1].t);
    }
    for (const v of Object.values(perDay)) if (v >= 2) sameDay++;
    const set = [...new Set(arr.map((e) => e.code))];
    if (set.length >= 3) groups3++;
    const key = set.map((c) => codeNames[c] || c).sort().join(' + ');
    combos.set(key, (combos.get(key) || 0) + 1);
    if (primaryCodes) {
      const k = arr.filter((e) => primaryCodes.has(e.code)).length;
      if (k) { primaryPhones++; primaryMsgs += k; if (k > maxPrimary) maxPrimary = k; }
    }
  }
  gaps.sort((a, b) => a - b);
  const q = (p) => (gaps.length ? gaps[Math.floor((gaps.length - 1) * p)] : null);
  return {
    phones, msgs, avg: phones ? msgs / phones : 0, multi2, max, hist, sameDay, groups3,
    gapMedianH: gaps.length ? q(0.5) / 60 : null, gapP25H: gaps.length ? q(0.25) / 60 : null,
    gapsUnder1h: gaps.filter((g) => g < 60).length, gapsUnder24h: gaps.filter((g) => g < 1440).length,
    gapsUnder7d: gaps.filter((g) => g < 10080).length, gapsTotal: gaps.length,
    combos: [...combos.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15),
    heavy: heavy.sort((a, b) => b[1] - a[1]).slice(0, 20),
    primaryPhones, primaryMsgs, maxPrimary,
  };
}

// ---------- combining day docs ----------
export function sumDays(days) {
  const t = { ...blankCounts(), days: 0, cust: 0, multi: 0, gaps1h: 0, hours: Array.from({ length: 24 }, () => [0, 0, 0]), dow: Array(7).fill(0),
    groups: {}, failCat: {}, reasons: {}, branches: {}, variants: {}, codes: {}, dates: [] };
  for (const d of days) {
    t.days++; t.dates.push(d.date);
    for (const k of ['n', 'd', 'b', 'f', 'p', 'seg', 'seg2', 'seg3', 'cust', 'multi', 'gaps1h']) t[k] += d[k] || 0;
    t.dow[d.dow] += d.n;
    (d.hours || []).forEach((s, i) => { const a = typeof s === 'string' ? s.split(',').map(Number) : s; for (let j = 0; j < 3; j++) t.hours[i][j] += a[j] || 0; });
    for (const [g, c] of Object.entries(d.groups || {})) {
      const x = t.groups[g] || (t.groups[g] = { ...blankCounts(), fc: {}, cust: 0, days: 0, first: d.date, last: d.date });
      for (const k of ['n', 'd', 'b', 'f', 'p', 'seg', 'seg2', 'seg3', 'cust']) x[k] += c[k] || 0;
      for (const [k, v] of Object.entries(c.fc || {})) x.fc[k] = (x.fc[k] || 0) + v;
      x.days++; if (d.date < x.first) x.first = d.date; if (d.date > x.last) x.last = d.date;
    }
    for (const [k, v] of Object.entries(d.failCat || {})) t.failCat[k] = (t.failCat[k] || 0) + v;
    for (const [k, v] of Object.entries(d.reasons || {})) t.reasons[k] = (t.reasons[k] || 0) + v;
    for (const [b, c] of Object.entries(d.branches || {})) {
      const x = t.branches[b] || (t.branches[b] = { n: 0, d: 0, b: 0, f: 0, seg: 0, rem: 0, gift: 0 });
      for (const k of Object.keys(x)) x[k] += c[k] || 0;
    }
    for (const [v, c] of Object.entries(d.variants || {})) {
      const x = t.variants[v] || (t.variants[v] = { ...blankCounts(), len: 0 });
      for (const k of Object.keys(x)) x[k] += c[k] || 0;
    }
    Object.assign(t.codes, d.codes || {});
  }
  t.dates.sort();
  return t;
}
