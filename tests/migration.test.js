import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MIGRATIONS, openDb, closeDb, insertDocument, migrate } from '../lib/db.js';
import { dedupKeyFor } from '../lib/normalize.js';

test('v2 migration upgrades a real v1 database without data loss', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'intelhub-mig-'));
  const dbPath = path.join(dir, 'old.db');

  // Build a genuine old-schema (v1) db by hand-running migration 1 only.
  const raw = new DatabaseSync(dbPath);
  raw.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL PRIMARY KEY, applied_at TEXT NOT NULL)');
  MIGRATIONS[0].up(raw);
  raw.prepare('INSERT INTO schema_version (version, applied_at) VALUES (1, ?)').run('2026-01-01T00:00:00.000Z');
  raw.prepare(
    `INSERT INTO intel_documents (source_type, url, title, raw_content, summary, lang, topic, dedup_key, content_hash, search_text, meta, published_at, fetched_at)
     VALUES ('rss', 'https://old.example/a', 'Old doc', 'old body', 'old summary', 'en', 'llm', ?, '', 'old', '{}', NULL, '2026-01-02T00:00:00.000Z')`
  ).run(dedupKeyFor('https://old.example/a'));
  raw.prepare("INSERT INTO intel_reports (topic, title, body, model, document_ids, created_at) VALUES ('daily', 't', 'b', '', '[]', '2026-01-02T00:00:00.000Z')").run();
  raw.close();

  // openDb runs migrations through v2.
  const db = openDb(dbPath);
  const v = migrate(db);
  assert.ok(v >= 2, `schema version advanced (got ${v})`);

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  for (const t of ['intel_job_executions', 'intel_documents', 'intel_reports']) {
    assert.ok(tables.includes(t), `table ${t} exists`);
  }
  const cols = db.prepare('PRAGMA table_info(intel_documents)').all().map((c) => c.name);
  for (const c of ['analysis', 'bookmark']) assert.ok(cols.includes(c), `column ${c} added`);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM intel_documents').get().n, 1, 'existing documents preserved');
  const old = db.prepare('SELECT * FROM intel_documents').get();
  assert.equal(old.title, 'Old doc');
  assert.equal(old.raw_content, 'old body');
  assert.equal(old.bookmark, 0, 'bookmark defaults to 0');
  assert.equal(old.analysis, null);

  const reportCols = db.prepare('PRAGMA table_info(intel_reports)').all().map((c) => c.name);
  assert.ok(reportCols.includes('report_date'));

  // new unique report_date index works and rejects duplicates
  db.prepare("INSERT INTO intel_reports (topic, title, body, created_at, report_date) VALUES ('daily','t','b','2026-11-05T10:00:00Z','2026-11-05')").run();
  assert.throws(() => {
    db.prepare("INSERT INTO intel_reports (topic, title, body, created_at, report_date) VALUES ('daily','t2','b2','2026-11-05T11:00:00Z','2026-11-05')").run();
  }, /UNIQUE/);

  // job queue table usable
  db.prepare(
    "INSERT INTO intel_job_executions (kind, run_date, status, next_run_at, updated_at) VALUES ('DAILY_REPORT', '2026-11-05', 'PENDING', '2026-11-05T10:00:00Z', '2026-11-05T10:00:00Z')"
  ).run();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM intel_job_executions').get().n, 1);

  // old doc still insertable/dedupable with new columns present
  const r = insertDocument(db, { url: 'https://old.example/a', title: 'dup of old', source_type: 'rss' });
  assert.ok(!r.inserted, 'existing dedup keys still honored after migration');
  closeDb(db);
});

test('v4 -> v5: kind column on intel_research_tasks + intel_learning_materials created, data preserved', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'intelhub-mig5-'));
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(path.join(dir, 'old.db'));
  raw.exec(`CREATE TABLE schema_version (version INTEGER NOT NULL PRIMARY KEY, applied_at TEXT NOT NULL)`);
  for (const m of MIGRATIONS.filter((m) => m.version <= 4)) {
    m.up(raw);
    raw.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(m.version, new Date().toISOString());
  }
  raw.prepare(
    `INSERT INTO intel_research_tasks (task_id, repo, status, created_at, updated_at) VALUES ('cr-old', 'a/b', 'COMPLETED', ?, ?)`
  ).run('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  raw.close();
  const db = openDb(path.join(dir, 'old.db')); // applies v5 only
  const cols = db.prepare('PRAGMA table_info(intel_research_tasks)').all().map((c) => c.name);
  assert.ok(cols.includes('kind'), 'kind column added');
  assert.equal(db.prepare("SELECT kind FROM intel_research_tasks WHERE task_id = 'cr-old'").get().kind, 'code', 'existing rows default to kind=code');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  assert.ok(tables.includes('intel_learning_materials'));
  db.prepare(
    `INSERT INTO intel_learning_materials (subject, source_type, source_ref, content_json, degraded, created_at)
     VALUES ('agent memory', 'research_task', 'dr-x', '{}', 1, ?)`
  ).run('2026-11-05T00:00:00.000Z');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM intel_learning_materials').get().n, 1);
  closeDb(db);
});
