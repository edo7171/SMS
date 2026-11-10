// Downloads a large SMS report (CSV) from a URL, aggregates it with sms-core.js
// and writes the daily summaries to Firestore. Run by .github/workflows/import-large-report.yml.
//
// Auth: signs in as a dedicated Firebase Auth user (e-mail + password) and writes through the
// Firestore REST API, so the normal security rules apply. No service-account key is needed.
// Env: REPORT_URL, REPORT_NAME, FIREBASE_IMPORT_EMAIL, FIREBASE_IMPORT_PASSWORD, DRY_RUN=1 to skip writing.
import { CsvStream, DayAggregator } from '../sms-core.js';

const PROJECT_ID = 'infousms-abdc7';
const API_KEY = 'AIzaSyDEvNCbEqngrYY1O_99gTmg0Wwy9sWmsCI'; // public web key, same as in index.html
const AUTH_BASE = process.env.AUTH_BASE || 'https://identitytoolkit.googleapis.com';
const FS_HOST = process.env.FS_HOST || 'https://firestore.googleapis.com';
const DOCS = `projects/${PROJECT_ID}/databases/(default)/documents`;
// The web API key is restricted to the dashboard's site, so sign-in identifies itself with that site.
const REFERER = process.env.FIREBASE_REFERER || 'https://edo7171.github.io/SMS/';

const url = process.env.REPORT_URL;
const name = process.env.REPORT_NAME || 'report.csv';
if (!url) { console.error('REPORT_URL is missing'); process.exit(1); }

async function aggregate() {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const agg = new DayAggregator();
  const csv = new CsvStream((r) => agg.add(r));
  const dec = new TextDecoder('utf-8');
  let read = 0, nextLog = 50e6;
  for await (const chunk of res.body) {
    read += chunk.byteLength;
    csv.push(dec.decode(chunk, { stream: true }));
    if (read >= nextLog) { console.log(`downloaded ${(read / 1e6).toFixed(0)}MB${total ? ' / ' + (total / 1e6).toFixed(0) + 'MB' : ''}, rows ${agg.rows}`); nextLog += 50e6; }
  }
  csv.push(dec.decode()); csv.end();
  console.log(`done: ${(read / 1e6).toFixed(1)}MB, ${agg.rows} rows, ${agg.duplicates ?? 'n/a (old sms-core.js)'} duplicates, ${agg.skipped} without date`);
  return agg;
}

// ---------- Firestore REST ----------
async function signIn() {
  const email = process.env.FIREBASE_IMPORT_EMAIL, password = process.env.FIREBASE_IMPORT_PASSWORD;
  if (!email || !password) throw new Error('FIREBASE_IMPORT_EMAIL / FIREBASE_IMPORT_PASSWORD secrets are missing');
  const res = await fetch(`${AUTH_BASE}/v1/accounts:signInWithPassword?key=${API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Referer: REFERER }, body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const j = await res.json();
  if (!res.ok || !j.idToken) throw new Error(`Firebase sign-in failed: ${j.error?.message || res.status}`);
  return j.idToken;
}
function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toValue(x)])) } };
}
const update = (path, obj) => ({ update: { name: `${DOCS}/${path}`, fields: toValue(obj).mapValue.fields } });
async function call(token, op, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${FS_HOST}/v1/${DOCS}:${op}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    if (res.ok) return res.json();
    const txt = await res.text();
    if (res.status === 403) throw new Error(`Permission denied by Firestore rules. Add the import user's e-mail to allowedEmails(). ${txt.slice(0, 200)}`);
    if (attempt >= 2) throw new Error(`Firestore ${op} failed: HTTP ${res.status} ${txt.slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
}

async function write(results, agg) {
  const token = await signIn();
  const old = {};
  const got = await call(token, 'batchGet', { documents: results.map((r) => `${DOCS}/days/${r.id}`), mask: { fieldPaths: ['shards'] } });
  for (const x of got) if (x.found) old[x.found.name.split('/').pop()] = Number(x.found.fields?.shards?.integerValue || 0);
  const now = new Date().toISOString();
  const writes = [];
  for (const r of results) {
    writes.push(update(`days/${r.id}`, { ...r.doc, importedAt: now, importedBy: 'github-action' }));
    r.shards.forEach((s, i) => writes.push(update(`freq/${r.id}_${i}`, { stream: r.doc.stream, date: r.doc.date, i, d: s })));
    for (let j = r.shards.length; j < (old[r.id] || 0); j++) writes.push({ delete: `${DOCS}/freq/${r.id}_${j}` });
  }
  const byStream = {};
  results.forEach((r) => { const b = byStream[r.doc.stream] || (byStream[r.doc.stream] = { days: 0, n: 0, from: r.doc.date, to: r.doc.date }); b.days++; b.n += r.doc.n; if (r.doc.date < b.from) b.from = r.doc.date; if (r.doc.date > b.to) b.to = r.doc.date; });
  const names = { survey: 'סקרים', marketing: 'דיוור שיווקי' };
  const summary = Object.entries(byStream).map(([s, b]) => `${names[s]}: ${b.n} הודעות, ${b.days} ימים (${b.from}–${b.to})`).join(' | ');
  writes.push(update(`imports/gh-${Date.now()}`, { file: name, rows: agg.rows, duplicates: agg.duplicates, summary, other: Object.entries(agg.otherGroups).map(([k, v]) => `${k}: ${v}`).join(', '), at: now, by: 'ייבוא אוטומטי מהמייל (קובץ גדול)' }));
  let batch = [], bytes = 0;
  const flush = async () => { if (batch.length) await call(token, 'commit', { writes: batch }); batch = []; bytes = 0; };
  for (const w of writes) {
    const size = JSON.stringify(w).length;
    if (batch.length >= 400 || bytes + size > 8e6) await flush();
    batch.push(w); bytes += size;
  }
  await flush();
  console.log(`written: ${summary}`);
}

const agg = await aggregate();
const results = agg.finish().filter((r) => r.doc.stream !== 'other');
for (const r of results) console.log(`${r.id}: ${r.doc.n} messages, ${r.shards.length} shards`);
if (!results.length) { console.error('No survey or marketing messages found in the file'); process.exit(1); }
if (process.env.DRY_RUN === '1') console.log('DRY_RUN: nothing written');
else await write(results, agg);
