// Downloads a large SMS report (CSV) from a URL, aggregates it with sms-core.js
// and writes the daily summaries to Firestore. Run by .github/workflows/import-large-report.yml.
// Env: REPORT_URL, REPORT_NAME, FIREBASE_SERVICE_ACCOUNT (JSON), DRY_RUN=1 to skip writing.
import { CsvStream, DayAggregator } from '../sms-core.js';

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
  console.log(`done: ${(read / 1e6).toFixed(1)}MB, ${agg.rows} rows, ${agg.duplicates} duplicates, ${agg.skipped} without date`);
  return agg;
}

async function write(results, agg) {
  const { initializeApp, cert } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  if (!sa.project_id) throw new Error('FIREBASE_SERVICE_ACCOUNT secret is missing or invalid');
  initializeApp({ credential: cert(sa) });
  const db = getFirestore();
  const refs = results.map((r) => db.collection('days').doc(r.id));
  const existing = refs.length ? await db.getAll(...refs) : [];
  const oldShards = Object.fromEntries(existing.map((s) => [s.id, s.exists ? s.get('shards') || 0 : 0]));
  const now = new Date().toISOString();
  const ops = [];
  for (const r of results) {
    ops.push({ ref: db.collection('days').doc(r.id), data: { ...r.doc, importedAt: now, importedBy: 'github-action' }, size: JSON.stringify(r.doc).length });
    r.shards.forEach((s, i) => ops.push({ ref: db.collection('freq').doc(`${r.id}_${i}`), data: { stream: r.doc.stream, date: r.doc.date, i, d: s }, size: s.length }));
    for (let j = r.shards.length; j < (oldShards[r.id] || 0); j++) ops.push({ ref: db.collection('freq').doc(`${r.id}_${j}`), del: true, size: 100 });
  }
  const byStream = {};
  results.forEach((r) => { const b = byStream[r.doc.stream] || (byStream[r.doc.stream] = { days: 0, n: 0, from: r.doc.date, to: r.doc.date }); b.days++; b.n += r.doc.n; if (r.doc.date < b.from) b.from = r.doc.date; if (r.doc.date > b.to) b.to = r.doc.date; });
  const names = { survey: 'סקרים', marketing: 'דיוור שיווקי' };
  const summary = Object.entries(byStream).map(([s, b]) => `${names[s]}: ${b.n} הודעות, ${b.days} ימים (${b.from}–${b.to})`).join(' | ');
  ops.push({ ref: db.collection('imports').doc(), data: { file: name, rows: agg.rows, duplicates: agg.duplicates, summary, other: Object.entries(agg.otherGroups).map(([k, v]) => `${k}: ${v}`).join(', '), at: now, by: 'ייבוא אוטומטי מהמייל (קובץ גדול)' }, size: 500 });
  let batch = db.batch(), count = 0, bytes = 0;
  for (const op of ops) {
    if (count >= 400 || bytes + op.size > 7e6) { await batch.commit(); batch = db.batch(); count = 0; bytes = 0; }
    if (op.del) batch.delete(op.ref); else batch.set(op.ref, op.data);
    count++; bytes += op.size;
  }
  await batch.commit();
  console.log(`written: ${summary}`);
}

const agg = await aggregate();
const results = agg.finish().filter((r) => r.doc.stream !== 'other');
for (const r of results) console.log(`${r.id}: ${r.doc.n} messages, ${r.shards.length} shards`);
if (!results.length) { console.error('No survey or marketing messages found in the file'); process.exit(1); }
if (process.env.DRY_RUN === '1') console.log('DRY_RUN: nothing written');
else await write(results, agg);
