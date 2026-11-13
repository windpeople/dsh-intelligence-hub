import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, closeDb, insertDocument, ensureSources, markSourceRun } from '../lib/db.js';
import { MIGRATIONS, migrate } from '../lib/db.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  submitFeedback, recordFeedback, feedbackExcludedDocIds, isTopicPaused,
  pendingTopicBoosts, feedbackTrace, FEEDBACK_TYPES,
} from '../lib/feedback.js';
import { effectiveEvidenceQuality, evidenceQuality } from '../lib/scoring.js';

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'intelhub-fb-'));
  const db = openDb(path.join(dir, 't.db'));
  ensureSources(db);
  const src = db.prepare("SELECT id FROM intel_sources WHERE source_type='rss' LIMIT 1").get().id;
  const doc = insertDocument(db, {
    url: 'https://example.org/a', title: 'Test doc', summary: 'body text', source_type: 'rss', lang: 'en', topic: 'llm',
  }, src);
  return { db, close: () => closeDb(db), sourceId: src, docId: doc.id };
}

test('feedback idempotency: same item+type recorded once, different type allowed', async () => {
  const { db, close, docId } = setup();
  try {
    const a = submitFeedback(db, { documentId: docId, feedbackType: 'irrelevant', relatedTopic: 'llm' });
    assert.ok(a.ok && !a.deduped);
    const b = submitFeedback(db, { documentId: docId, feedbackType: 'irrelevant', relatedTopic: 'llm' });
    assert.ok(b.ok && b.deduped, 'same item+type is deduped');
    const c = submitFeedback(db, { documentId: docId, feedbackType: 'already_known' });
    assert.ok(c.ok && !c.deduped, 'different type is a new row');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM intel_feedback').get().n, 2);
    const bad = submitFeedback(db, { documentId: docId, feedbackType: 'not_a_type' });
    assert.equal(bad.ok, false);
    assert.equal(recordFeedback(db, { feedbackType: 'keep' }).ok, false, 'missing item rejected');
    assert.deepEqual(FEEDBACK_TYPES.sort(), ['already_known', 'bad_source', 'deep_research', 'irrelevant', 'keep', 'pause_topic']);
  } finally { close(); }
});

test('irrelevant/already_known excludes the doc from the digest candidate pool', async () => {
  const { db, close, docId } = setup();
  try {
    submitFeedback(db, { documentId: docId, feedbackType: 'irrelevant' });
    assert.ok(feedbackExcludedDocIds(db).has(docId));
    const meta = JSON.parse(db.prepare('SELECT meta FROM intel_documents WHERE id=?').get(docId).meta);
    assert.equal(meta.feedback_exclusion.type, 'irrelevant');
    submitFeedback(db, { documentId: docId, feedbackType: 'already_known' });
    assert.ok(feedbackExcludedDocIds(db).has(docId), 'exclusion persists to next pass');
  } finally { close(); }
});

test('bad_source lowers source quality -10 with cumulative floor; keep recovers +5 capped at original', async () => {
  const { db, close, sourceId, docId } = setup();
  try {
    for (let i = 0; i < 9; i++) {
      // idempotent per item+type, so vary the doc to allow repeated penalties
      const d = insertDocument(db, { url: `https://example.org/p${i}`, title: `p${i}`, source_type: 'rss', lang: 'en' }, sourceId);
      submitFeedback(db, { documentId: d.id, feedbackType: 'bad_source' });
    }
    const adj = db.prepare('SELECT quality_adjust FROM intel_sources WHERE id=?').get(sourceId).quality_adjust;
    assert.equal(adj, -70, 'cumulative penalty floored at -70 (effective E >= 30 from base 40)');
    const base = evidenceQuality({ source_id: sourceId, source_type: 'rss', url: 'https://example.org/x' });
    const eff = effectiveEvidenceQuality(db, { source_id: sourceId, source_type: 'rss', url: 'https://example.org/x' });
    assert.equal(base, 50, "rss base E is 50");
    assert.equal(eff, 30, 'effective E floored at 30');
    submitFeedback(db, { documentId: docId, feedbackType: 'keep', relatedTopic: 'llm' });
    assert.equal(db.prepare('SELECT quality_adjust FROM intel_sources WHERE id=?').get(sourceId).quality_adjust, -65, '+5 recovery');
    for (let i = 0; i < 20; i++) {
      const d = insertDocument(db, { url: `https://example.org/k${i}`, title: `k${i}`, source_type: 'rss', lang: 'en' }, sourceId);
      submitFeedback(db, { documentId: d.id, feedbackType: 'deep_research', relatedTopic: 'llm' });
    }
    assert.equal(db.prepare('SELECT quality_adjust FROM intel_sources WHERE id=?').get(sourceId).quality_adjust, 0, 'recovery capped at original value (0)');
  } finally { close(); }
});

test('pause_topic pauses the topic for 7 days only (collection untouched)', async () => {
  const { db, close, docId } = setup();
  try {
    const now = new Date();
    submitFeedback(db, { documentId: docId, feedbackType: 'pause_topic', relatedTopic: 'llm' });
    assert.ok(isTopicPaused(db, 'llm'));
    assert.ok(!isTopicPaused(db, 'mcp'), 'other topics unaffected');
    const docCount = db.prepare('SELECT COUNT(*) n FROM intel_documents').get().n;
    assert.equal(docCount, 1, 'pause never deletes collected documents');
    // expire the window
    const old = new Date(now.getTime() - 8 * 86400000).toISOString();
    db.prepare('UPDATE intel_feedback SET created_at = ?').run(old);
    assert.ok(!isTopicPaused(db, 'llm', { now }), 'pause expires after 7 days');
  } finally { close(); }
});

test('keep/deep_research feed the suggest queue, never the persisted profile', async () => {
  const { db, close, docId } = setup();
  try {
    submitFeedback(db, { documentId: docId, feedbackType: 'deep_research', relatedTopic: 'Prompt Engineering' });
    submitFeedback(db, { documentId: docId, feedbackType: 'keep', relatedTopic: 'Prompt Engineering' });
    const boosts = pendingTopicBoosts(db);
    assert.equal(boosts[0].topic, 'Prompt Engineering');
    assert.equal(boosts[0].boost, 2);
    const { loadProfile } = await import('../lib/profile.js');
    const profileBefore = JSON.stringify(loadProfile(db));
    assert.ok(!profileBefore.includes('Prompt Engineering'), 'long-term profile untouched (confirm-gated)');
  } finally { close(); }
});

test('every adjustment is traceable via intel_feedback (ranking_version v1)', async () => {
  const { db, close, docId } = setup();
  try {
    submitFeedback(db, { documentId: docId, feedbackType: 'bad_source' });
    const trace = feedbackTrace(db, { documentId: docId });
    assert.equal(trace.length, 1);
    assert.equal(trace[0].ranking_version, 'v1');
    assert.equal(trace[0].feedback_type, 'bad_source');
  } finally { close(); }
});

test('markSourceRun maintains fail_streak for coverage blind-spot detection', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'intelhub-streak-'));
  const db = openDb(path.join(dir, 't.db'));
  try {
    ensureSources(db);
    const id = db.prepare("SELECT id FROM intel_sources LIMIT 1").get().id;
    markSourceRun(db, id, { ok: false, error: 'HTTP 403' });
    markSourceRun(db, id, { ok: false, error: 'HTTP 403' });
    markSourceRun(db, id, { ok: false, error: 'AUTH_REQUIRED' });
    assert.equal(db.prepare('SELECT fail_streak FROM intel_sources WHERE id=?').get(id).fail_streak, 3);
    markSourceRun(db, id, { ok: true });
    assert.equal(db.prepare('SELECT fail_streak, last_error FROM intel_sources WHERE id=?').get(id).fail_streak, 0);
    assert.equal(db.prepare('SELECT last_error FROM intel_sources WHERE id=?').get(id).last_error, null);
  } finally { closeDb(db); }
});

test('migration v5 -> v6 adds Phase 5 tables and columns without data loss', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'intelhub-mig6-'));
  const dbPath = path.join(dir, 'old.db');
  const raw = new DatabaseSync(dbPath);
  raw.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const m of MIGRATIONS.filter((m) => m.version <= 5)) m.up(raw);
  raw.prepare('INSERT INTO schema_version (version, applied_at) VALUES (5, ?)').run('2026-01-01T00:00:00.000Z');
  raw.prepare("INSERT INTO intel_documents (source_type, url, title, lang, topic, dedup_key, fetched_at) VALUES ('rss','https://old.example/a','Old','en','llm','k1','2026-01-02T00:00:00.000Z')").run();
  raw.close();

  const db = openDb(dbPath);
  try {
    assert.ok(migrate(db) >= 6);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    for (const t of ['intel_feedback', 'intel_coverage_reports', 'intel_source_candidates', 'intel_knowledge_facts']) {
      assert.ok(tables.includes(t), `table ${t} exists`);
    }
    const srcCols = db.prepare('PRAGMA table_info(intel_sources)').all().map((c) => c.name);
    for (const c of ['quality_adjust', 'fail_streak']) assert.ok(srcCols.includes(c));
    const fbCols = db.prepare('PRAGMA table_info(intel_feedback)').all().map((c) => c.name);
    for (const c of ['item_id', 'related_topic', 'ranking_version']) assert.ok(fbCols.includes(c));
    assert.equal(db.prepare('SELECT COUNT(*) n FROM intel_documents').get().n, 1, 'existing docs preserved');
    // unique (item_id, feedback_type) enforced
    db.prepare("INSERT INTO intel_feedback (feedback_type, created_at, item_id, ranking_version) VALUES ('keep','2026-11-05T00:00:00Z','doc:1','v1')").run();
    assert.throws(() => {
      db.prepare("INSERT INTO intel_feedback (feedback_type, created_at, item_id, ranking_version) VALUES ('keep','2026-11-05T01:00:00Z','doc:1','v1')").run();
    }, /UNIQUE/);
  } finally { closeDb(db); }
});
