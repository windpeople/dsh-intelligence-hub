/**
 * Real-network smoke test, run directly (no DSH runtime):
 *   node scripts/smoke.js
 * Collects one real RSS source (hnrss.org/frontpage) and one real arXiv query,
 * inserts into a temp SQLite DB, then queries it back.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb, closeDb, searchDocuments, getStats } from '../lib/db.js';
import { collect } from '../lib/pipeline.js';

const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'intelhub-smoke-')), 'smoke.db');
console.log('[smoke] db:', dbPath);
const db = openDb(dbPath);

// Only RSS + arXiv for the smoke run.
const started = Date.now();
const r = await collect({ db, kinds: 'rss', maxPerRun: 10, timeoutMs: 60000 });
console.log('[smoke] rss run:', JSON.stringify(r.perSource), 'errors:', r.errors);

const r2 = await collect({ db, kinds: 'arxiv', maxPerRun: 5, timeoutMs: 60000 });
console.log('[smoke] arxiv run: fetched=%d inserted=%d errors=%s', r2.fetched, r2.inserted, r2.errors);

const stats = getStats(db);
console.log('[smoke] stats:', JSON.stringify({ documents: stats.documents, sources: stats.sources, byType: stats.byType }));

const rows = searchDocuments(db, { query: 'agent OR AI', limit: 5 });
console.log('[smoke] search "agent OR AI" -> %d rows', rows.length);
for (const d of rows.slice(0, 3)) console.log(`  #${d.id} [${d.source_type}/${d.topic}/${d.lang}] ${d.title} — ${d.url}`);

const zh = searchDocuments(db, { limit: 5 });
console.log('[smoke] latest docs: %d', zh.length);
for (const d of zh.slice(0, 3)) console.log(`  #${d.id} [${d.source_type}] ${String(d.title).slice(0, 60)}`);

console.log('[smoke] elapsed %dms', Date.now() - started);
closeDb(db);
if (stats.documents === 0) {
  console.error('[smoke] FAILED: no documents collected');
  process.exit(1);
}
console.log('[smoke] OK');
