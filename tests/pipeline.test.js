import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MIGRATIONS, openDb, closeDb, migrate } from '../lib/db.js';
import { dedupKeyFor } from '../lib/normalize.js';
import { enqueuePipelineRun, enqueueJob, runDueJobs, claimDueJob, completeJob } from '../lib/scheduler.js';

/** Build a genuine v2 database (migrations 1+2) with legacy data rows. */
function makeV2Db(dbPath) {
  const raw = new DatabaseSync(dbPath);
  raw.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL PRIMARY KEY, applied_at TEXT NOT NULL)');
  MIGRATIONS[0].up(raw);
  MIGRATIONS[1].up(raw);
  raw.prepare('INSERT INTO schema_version (version, applied_at) VALUES (2, ?)').run('2026-06-01T00:00:00.000Z');
  raw.prepare(
    `INSERT INTO intel_documents (source_type, url, title, raw_content, summary, lang, topic, dedup_key, content_hash, search_text, meta, published_at, fetched_at, analysis, bookmark)
     VALUES ('rss', 'https://legacy.example/a', 'Legacy doc', 'legacy body', 'legacy summary', 'en', 'llm', ?, '', 'legacy tokens', '{}', '2026-06-01T01:00:00.000Z', '2026-06-01T01:00:00.000Z', '{"summary":"s","relevance":5,"innovation":["i"]}', 1)`
  ).run(dedupKeyFor('https://legacy.example/a'));
  raw.prepare("INSERT INTO intel_job_executions (kind, run_date, status, next_run_at, updated_at) VALUES ('DAILY_REPORT', '2026-06-01', 'COMPLETED', '2026-06-01T10:00:00Z', '2026-06-01T10:00:00Z')").run();
  raw.close();
}

test('v2 -> v3 migration preserves legacy data and creates v3 tables + unique indexes', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'intelhub-mig3-'));
  const dbPath = path.join(dir, 'v2.db');
  makeV2Db(dbPath);

  const db = openDb(dbPath);
  const v = migrate(db);
  assert.ok(v >= 3, `schema version reached (got ${v})`);

  // legacy rows preserved
  const old = db.prepare('SELECT * FROM intel_documents').get();
  assert.equal(old.title, 'Legacy doc');
  assert.equal(old.bookmark, 1);
  assert.ok(old.analysis && JSON.parse(old.analysis).relevance === 5);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM intel_job_executions').get().n, 1);

  // new tables exist
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  for (const t of ['intel_interest_profiles', 'intel_events', 'intel_document_events', 'intel_knowledge_deltas', 'intel_scores', 'intel_research_candidates', 'intel_feedback']) {
    assert.ok(tables.includes(t), `table ${t} exists`);
  }
  // unique indexes exist
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name);
  for (const i of ['idx_research_topic_doc']) assert.ok(idx.includes(i), `index ${i} exists`);
  assert.throws(() => {
    db.prepare('INSERT INTO intel_scores (document_id, created_at) VALUES (1, ?)').run('2026-11-05T00:00:00Z');
    db.prepare('INSERT INTO intel_scores (document_id, created_at) VALUES (1, ?)').run('2026-11-05T01:00:00Z');
  }, /UNIQUE/, 'intel_scores.document_id is unique');
  closeDb(db);
});

test('PIPELINE_RUN: two slots per day enqueue independently and are idempotent per slot', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'intelhub-pipe-'));
  const db = openDb(path.join(dir, 't.db'));
  // 2026-11-05 12:30 Shanghai
  const at = new Date('2026-11-05T04:30:00Z');
  const a = enqueuePipelineRun(db, { slots: ['10:00', '12:00'], now: at, timeZone: 'Asia/Shanghai' });
  assert.equal(a.length, 2, 'both slots fired after 12:00');
  assert.equal(a[0].phase, 'L0');
  assert.equal(a[1].phase, 'FULL');
  const b = enqueuePipelineRun(db, { slots: ['10:00', '12:00'], now: at, timeZone: 'Asia/Shanghai' });
  assert.equal(b.length, 0, 'same-day slot re-enqueue deduped');
  const early = new Date('2026-11-05T01:00:00Z'); // 09:00 Shanghai
  const c = enqueuePipelineRun(db, { slots: ['10:00', '12:00'], now: early, timeZone: 'Asia/Shanghai' });
  assert.equal(c.length, 0, 'no slot before 10:00');
  const rows = db.prepare("SELECT run_date, payload FROM intel_job_executions WHERE kind='PIPELINE_RUN' ORDER BY run_date").all();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.run_date), ['2026-11-05#1000', '2026-11-05#1200']);
  assert.equal(JSON.parse(rows[0].payload).phase, 'L0');
  closeDb(db);
});

test('PIPELINE_RUN handler executes through the scheduler and re-running scores nothing twice', async () => {
  const { insertDocument } = await import('../lib/db.js');
  const { runPipeline } = await import('../lib/scoring.js');
  const dir = mkdtempSync(path.join(tmpdir(), 'intelhub-pipe2-'));
  const db = openDb(path.join(dir, 't.db'));
  insertDocument(db, {
    url: 'https://x.example/agent', title: 'an agent memory framework release',
    summary: 'agent memory release with tool use', source_type: 'rss', lang: 'en',
    fetched_at: '2026-11-05T03:00:00.000Z',
  });
  const handlers = {
    PIPELINE_RUN: async (job) => runPipeline(db, {
      phase: job.payload.phase,
      dateStr: job.run_date.split('#')[0],
      timeZone: 'UTC',
      config: { analysisEnabled: false, scoreThresholds: { archive: 50, digest: 50, recommend: 70, research: 85 } },
      now: new Date('2026-11-05T12:00:00.000Z'),
      rng: () => 0.99,
    }),
  };
  enqueueJob(db, { kind: 'PIPELINE_RUN', runDate: '2026-11-05#1000', payload: { phase: 'L0' } });
  enqueueJob(db, { kind: 'PIPELINE_RUN', runDate: '2026-11-05#1200', payload: { phase: 'FULL' } });
  const r1 = await runDueJobs(db, handlers, { execTimeoutMs: 10000 });
  assert.ok(r1.every((r) => r.ok), JSON.stringify(r1.filter((x) => !x.ok)));
  const r2 = await runDueJobs(db, handlers, { execTimeoutMs: 10000 });
  assert.equal(r2.length, 0, 'no jobs left (kind+slot dedup held)');
  const scores = db.prepare('SELECT * FROM intel_scores').all();
  assert.equal(scores.length, 1, 'doc scored exactly once');
  const linked = db.prepare('SELECT COUNT(*) AS n FROM intel_document_events').get().n;
  assert.equal(linked, 1);
  assert.ok(scores[0].stage === 'L3' && scores[0].ranking_version === 'v1');
  closeDb(db);
});

test('feedback table exists; pipeline tool stub path exercised via scoring module import', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'intelhub-fb-'));
  const db = openDb(path.join(dir, 't.db'));
  db.prepare('INSERT INTO intel_feedback (document_id, feedback_type, payload, created_at) VALUES (1, ?, ?, ?)').run('like', '{}', '2026-11-05T00:00:00Z');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM intel_feedback').get().n, 1);
  const { researchGate } = await import('../lib/scoring.js');
  assert.equal(researchGate(null, { source_type: 'rss' }, 10).decision, 'ARCHIVE');
  void claimDueJob; void completeJob;
  closeDb(db);
});
