import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MIGRATIONS, openDb, closeDb, migrate, insertDocument, saveReport, getReport } from '../lib/db.js';
import { dedupKeyFor } from '../lib/normalize.js';

/** Build a genuine v6 database (all migrations <= 6) with legacy rows. */
function buildV6(dir) {
  const dbPath = path.join(dir, 'old.db');
  const raw = new DatabaseSync(dbPath);
  raw.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const m of MIGRATIONS.filter((m) => m.version <= 6)) {
    m.up(raw);
    raw.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(m.version, '2026-01-01T00:00:00.000Z');
  }
  raw.prepare(
    `INSERT INTO intel_documents (source_type, url, title, raw_content, summary, lang, topic, dedup_key, content_hash, search_text, meta, published_at, fetched_at)
     VALUES ('rss', 'https://old.example/a', 'Old doc', 'old body', 'old summary', 'en', 'llm', ?, '', 'old', '{}', NULL, '2026-01-02T00:00:00.000Z')`
  ).run(dedupKeyFor('https://old.example/a'));
  raw.prepare("INSERT INTO intel_reports (topic, title, body, model, document_ids, created_at, report_date) VALUES ('daily', 'legacy', 'b', '', '[]', '2026-01-02T00:00:00.000Z', '2026-01-02')").run();
  raw.close();
  return dbPath;
}

test('v6 -> v7: legacy data preserved, new tables and columns exist', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'intelhub-mig7-'));
  const dbPath = buildV6(dir);
  const db = openDb(dbPath);
  assert.equal(migrate(db), 7, 'schema advanced to v7');

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  for (const t of ['intel_topics', 'intel_topic_knowledge', 'intel_topic_knowledge_revisions', 'intel_source_star_snapshots', 'intel_report_items', 'intel_usage']) {
    assert.ok(tables.includes(t), `table ${t} exists`);
  }

  // Legacy rows untouched.
  const doc = db.prepare('SELECT * FROM intel_documents').get();
  assert.equal(doc.title, 'Old doc');
  assert.equal(doc.arxiv_version, null, 'arxiv_version defaults to NULL for legacy rows');
  const rep = db.prepare('SELECT * FROM intel_reports').get();
  assert.equal(rep.kind, 'daily', 'existing report rows get kind=daily');
  assert.equal(rep.title, 'legacy');

  // Source policy columns.
  const srcCols = db.prepare('PRAGMA table_info(intel_sources)').all().map((c) => c.name);
  for (const c of ['fetch_interval_hours', 'last_cursor', 'failure_count', 'rate_limit_per_hour', 'auth_ref']) {
    assert.ok(srcCols.includes(c), `intel_sources column ${c} added`);
  }

  // Legacy daily report still deduped (index rebuilt on (report_date, kind)).
  const dup = saveReport(db, { reportDate: '2026-01-02', title: 'again', body: '', createdAt: '2026-01-03T00:00:00Z' });
  assert.ok(!dup.created, 'daily idempotency still holds after index rebuild');
  // Same date, different kind is allowed.
  const weekly = saveReport(db, { reportDate: '2026-01-02', title: 'week', body: '', createdAt: '2026-01-09T00:00:00Z', kind: 'weekly' });
  assert.ok(weekly.created, 'weekly report may share report_date with a daily');
  assert.equal(getReport(db, '2026-01-02').id, rep.id);
  assert.equal(getReport(db, '2026-01-02', 'weekly').id, weekly.id);
  const weeklyAgain = saveReport(db, { reportDate: '2026-01-02', title: 'week2', body: '', createdAt: '2026-01-10T00:00:00Z', kind: 'weekly' });
  assert.ok(!weeklyAgain.created, 'weekly idempotent per week start');

  // arxiv_version is writable through insertDocument.
  const r = insertDocument(db, { url: 'https://arxiv.org/abs/2401.1v2', title: 'p', summary: 's', source_type: 'arxiv', lang: 'en', arxiv_version: 2, dedup_key: 'k-v2' });
  assert.ok(r.inserted);
  assert.equal(db.prepare('SELECT arxiv_version FROM intel_documents WHERE id = ?').get(r.id).arxiv_version, 2);
  closeDb(db);
});

test('v7 usage table records and aggregates per local day', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'intelhub-usage7-'));
  const db = openDb(path.join(dir, 't.db'));
  db.prepare("INSERT INTO intel_usage (call, prompt_chars, completion_chars, used_at, usage_date) VALUES ('t', 10, 20, '2026-11-10T01:00:00Z', '2026-11-10')").run();
  const row = db.prepare('SELECT * FROM intel_usage').get();
  assert.equal(row.usage_date, '2026-11-10');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM intel_usage').get().n, 1);
  closeDb(db);
});
