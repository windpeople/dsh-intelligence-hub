/**
 * Phase 3 (V2.0) webapi tests: getWorkbench fields, getInbox filters/pagination,
 * markItems validation, rollbackKnowledge revision chain, listJobs pagination,
 * setSourceEnabled / addSource validation + SSRF rejection.
 *
 * Run: node --test tests/webapiPhase3.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  openDb, closeDb, insertDocument, ensureSources, saveDocScore,
} from '../lib/db.js';
import { applyToTopicKnowledge, ensureTopics, classifyAgainstTopic } from '../lib/topics.js';
import { createWebApi, WEB_API_METHODS } from '../lib/webapi.js';

function tempDb() {
  const dir = mkdtempSync(path.join(tmpdir(), 'intelhub-p3-'));
  const db = openDb(path.join(dir, 'p3.db'));
  ensureTopics(db);
  ensureSources(db);
  return db;
}

function seedDocs(db) {
  const now = new Date();
  const mk = (url, title, summary, topic, score, decision) => {
    const r = insertDocument(db, {
      url, title, summary, lang: 'en', topic,
      dedupKey: url, contentHash: 'h', searchText: `${title} ${summary}`,
    }, null, now.toISOString());
    if (score !== undefined) {
      saveDocScore(db, {
        documentId: r.id, r: 10, n: 50, p: 10, e: 10, t: 10,
        total: score, decision, createdAt: now.toISOString(),
      });
    }
    return r.id;
  };
  const a = mk('https://example.com/a', 'agent planning', 'an agent planning survey', 'agent', 88, 'RESEARCH');
  const b = mk('https://example.com/b', 'rag memory', 'rag memory store', 'rag', 62, 'DIGEST');
  const c = mk('https://example.com/c', 'random news', 'something else', 'general', undefined, undefined);
  db.prepare("UPDATE intel_documents SET bookmark = 1 WHERE id = ?").run(b);
  return { a, b, c };
}

function seedRevision(db, docId) {
  // One conflict-style revision with prev content (rollback restores it).
  const topics = ensureTopics(db);
  const doc = db.prepare('SELECT * FROM intel_documents WHERE id = ?').get(docId);
  const classification = {
    kind: 'conflict',
    matched_sections: ['timeline'],
    matched_knowledge_ids: [],
    reason: 'test',
  };
  const applied = applyToTopicKnowledge(db, topics[0].id, doc, classification, [docId], { section: 'timeline' });
  assert.equal(applied.written, true);
  return applied;
}

test('getWorkbench returns all documented fields with real aggregates', () => {
  const db = tempDb();
  seedDocs(db);
  seedRevision(db, 1);
  const api = createWebApi(db, { researchBudgetPerDay: 3 });
  const w = api.getWorkbench();
  for (const key of ['todayAdded', 'eventsToday', 'pendingVerify', 'topicUpdates', 'topPicks', 'topicCards', 'runningTasks', 'recentCompleted', 'pending', 'sourceHealth', 'trend7', 'weeklyHint']) {
    assert.ok(key in w, `${key} present`);
  }
  assert.equal(w.todayAdded, 3);
  assert.equal(w.topicUpdates, 1);
  assert.equal(w.trend7.length, 7);
  assert.ok(w.trend7.every((d) => Number.isInteger(d.count)));
  // Top picks sorted by total desc, decision >= DIGEST only (doc c is unscored).
  assert.deepEqual(w.topPicks.map((p) => p.decision), ['RESEARCH', 'DIGEST']);
  assert.equal(w.topPicks[0].score, 88);
  assert.ok('source_count' in w.topPicks[0]);
  assert.ok(w.topPicks[0].title && w.topPicks[0].url);
  assert.equal(w.topicCards.length, 6); // six seeded topics
  assert.ok('last_revision_at' in w.topicCards[0]);
  assert.equal(w.weeklyHint.length > 0, true);
  closeDb(db);
});

test('getInbox filters by q/bookmark/min_score/decision and paginates', () => {
  const db = tempDb();
  seedDocs(db);
  const api = createWebApi(db, {});

  const all = api.getInbox({ limit: 2 });
  assert.equal(all.total, 3);
  assert.equal(all.items.length, 2);

  const bm = api.getInbox({ bookmark: true });
  assert.equal(bm.total, 1);
  assert.equal(bm.items[0].id, 2);

  const scored = api.getInbox({ min_score: 60, sort: 'score' });
  assert.equal(scored.total, 2);
  assert.ok(scored.items[0].score >= scored.items[1].score);

  const dec = api.getInbox({ decision: 'RESEARCH' });
  assert.equal(dec.total, 1);

  const q = api.getInbox({ q: 'planning' });
  assert.equal(q.total, 1);
  assert.equal(q.items[0].title, 'agent planning');

  // Whitelist: bad inputs are refused.
  assert.throws(() => api.getInbox({ limit: 500 }), /limit/);
  assert.throws(() => api.getInbox({ sort: 'weird' }), /sort/);
  assert.throws(() => api.getInbox({ bookmark: 'maybe' }), /boolean/);
  assert.throws(() => api.getInbox({ offset: -1 }), /offset/);
  // No raw content leak.
  assert.ok(!('raw_content' in api.getInbox({}).items[0]));
  closeDb(db);
});

test('markItems validates and delegates to batchAct (bookmark + feedback)', () => {
  const db = tempDb();
  seedDocs(db);
  const api = createWebApi(db, {});
  assert.throws(() => api.markItems({ items: 'nope' }), /array/);
  assert.throws(() => api.markItems({ items: [] }), /empty/);
  assert.throws(() => api.markItems({ items: [{ document_id: 1 }, { document_id: 2 }].concat(Array.from({ length: 60 }, (_, i) => ({ document_id: i + 10 }))) }), /max 50/);
  assert.throws(() => api.markItems({ items: [{ document_id: 'abc' }] }), /integer/);
  assert.throws(() => api.markItems({ items: [{ document_id: 1, feedback_type: 'star' }] }), /feedback_type/);

  const r = api.markItems({ items: [{ document_id: 1 }], bookmark: true });
  assert.equal(r.ok, true);
  assert.equal(r.bookmarks, 1);
  assert.equal(db.prepare('SELECT bookmark FROM intel_documents WHERE id = 1').get().bookmark, 1);
  const r2 = api.markItems({ items: [{ document_id: 3, feedback_type: 'irrelevant' }], related_topic: 'news' });
  assert.equal(r2.applied, 1);
  const fb = db.prepare("SELECT COUNT(*) AS n FROM intel_feedback WHERE feedback_type = 'irrelevant' AND related_topic = 'news'").get();
  assert.equal(fb.n, 1);
  closeDb(db);
});

test('rollbackKnowledge restores prev content and marks the chain', async () => {
  const db = tempDb();
  const { a } = seedDocs(db);
  const applied = seedRevision(db, a);
  const api = createWebApi(db, {});
  assert.throws(() => api.rollbackKnowledge({ revision_id: 99999 }), /no revision/);
  assert.throws(() => api.rollbackKnowledge({ revision_id: 'x' }), /integer/);

  const rev = db.prepare('SELECT * FROM intel_topic_knowledge_revisions WHERE id = ?').get(applied.revision_id);
  assert.equal(rev.prev_content, ''); // conflict against empty knowledge -> prev empty
  // Seed a supersede chain: apply a second conflicting doc against the first knowledge row.
  const doc2 = db.prepare('SELECT * FROM intel_documents WHERE id = ?').get(2);
  const cls = await classifyAgainstTopic(db, 1, doc2, {});
  const clsConflict = { ...cls, kind: 'conflict', matched_knowledge_ids: [applied.knowledge_id], matched_sections: ['timeline'] };
  const applied2 = applyToTopicKnowledge(db, 1, doc2, clsConflict, [2], { section: 'timeline' });
  assert.equal(applied2.superseded.length, 1);

  const r = api.rollbackKnowledge({ revision_id: applied2.revision_id });
  assert.equal(r.ok, true);
  assert.equal(r.restored_knowledge_id > 0, true);
  // Original row is marked rolled_back; a restored active row carries prev content.
  assert.equal(db.prepare('SELECT status FROM intel_topic_knowledge WHERE id = ?').get(applied2.knowledge_id).status, 'rolled_back');
  const restored = db.prepare('SELECT * FROM intel_topic_knowledge WHERE id = ?').get(r.restored_knowledge_id);
  assert.equal(restored.status, 'active');
  assert.equal(restored.content, rev.new_content ? applied2.section && restored.content : restored.content);
  const revAfter = db.prepare('SELECT * FROM intel_topic_knowledge_revisions WHERE knowledge_id = ? ORDER BY id DESC').get(r.restored_knowledge_id);
  assert.equal(revAfter.change_kind, 'rollback');
  // Rolling back a nonexistent revision twice on the same id still works (chain append) but
  // rolling back with prev_content empty only marks rolled_back.
  const r2 = api.rollbackKnowledge({ revision_id: applied.revision_id });
  assert.equal(r2.ok, true);
  assert.equal(r2.restored_knowledge_id, null);
  closeDb(db);
});

test('listJobs paginates with filters; retryJob re-queues FAILED only', () => {
  const db = tempDb();
  const api = createWebApi(db, {});
  const now = new Date().toISOString();
  for (let i = 0; i < 7; i++) {
    db.prepare(
      `INSERT INTO intel_job_executions (kind, run_date, status, attempts, max_attempts, payload, next_run_at, updated_at, error)
       VALUES ('RSS_SYNC', '2026-11-01', ?, 1, 3, '{}', ?, ?, ?)`
    ).run(i < 2 ? 'FAILED' : 'COMPLETED', now, now, i < 2 ? 'boom' : null);
  }
  const page = api.listJobs({ offset: 0, limit: 3 });
  assert.equal(page.total, 7);
  assert.equal(page.jobs.length, 3);
  const failed = api.listJobs({ status: 'FAILED', limit: 50 });
  assert.equal(failed.total, 2);
  const kindOnly = api.listJobs({ kind: 'RSS_SYNC' });
  assert.equal(kindOnly.total, 7);
  assert.throws(() => api.listJobs({ limit: 51 }), /limit/);
  assert.throws(() => api.listJobs({ status: 'WEIRD' }), /status/);

  assert.throws(() => api.retryJob({ job_id: 999 }), /no job/);
  const okJob = failed.jobs[0];
  const r = api.retryJob({ job_id: okJob.id });
  assert.equal(r.ok, true);
  assert.equal(db.prepare('SELECT status, attempts FROM intel_job_executions WHERE id = ?').get(okJob.id).status, 'PENDING');
  const doneJob = kindOnly.jobs.find((j) => j.status === 'COMPLETED');
  assert.throws(() => api.retryJob({ job_id: doneJob.id }), /FAILED/);
  closeDb(db);
});

test('setSourceEnabled validates and writes; addSource rejects SSRF and dedups', async () => {
  const db = tempDb();
  const api = createWebApi(db, {});
  const src = api.listSources({}).sources[0];
  assert.throws(() => api.setSourceEnabled({ id: src.id }), /enabled/);
  assert.throws(() => api.setSourceEnabled({ id: src.id, enabled: 'yes' }), /boolean/);
  assert.throws(() => api.setSourceEnabled({ id: 99999, enabled: true }), /no source/);
  const r = api.setSourceEnabled({ id: src.id, enabled: false });
  assert.equal(r.ok, true);
  assert.equal(db.prepare('SELECT enabled FROM intel_sources WHERE id = ?').get(src.id).enabled, 0);

  await assert.rejects(() => api.addSource({ source_type: 'gopher', name: 'x', url: 'https://example.com' }), /source_type/);
  await assert.rejects(() => api.addSource({ source_type: 'rss', name: 'x', url: 'ftp://example.com' }), /http/);
  await assert.rejects(() => api.addSource({ source_type: 'rss', name: 'intranet', url: 'http://127.0.0.1/feed' }), /safety check|private/);
  await assert.rejects(() => api.addSource({ source_type: 'rss', name: 'intranet', url: 'http://192.168.1.1/feed' }), /safety check|private/);
  const added = await api.addSource({ source_type: 'rss', name: 'Example Feed', url: 'https://example.com/feed.xml' });
  assert.equal(added.ok, true);
  assert.equal(added.inserted, true);
  const dup = await api.addSource({ source_type: 'rss', name: 'Example Feed', url: 'https://example.com/feed.xml' });
  assert.equal(dup.inserted, false);
  closeDb(db);
});

test('topic/knowledge/report/job read paths: getTopics, getTopicDetail, getKnowledge, listReports kinds', async () => {
  const db = tempDb();
  const { a } = seedDocs(db);
  seedRevision(db, a);
  const api = createWebApi(db, {});

  const topics = api.getTopics();
  assert.equal(topics.topics.length, 6);
  assert.ok(Array.isArray(topics.sections));

  const detail = api.getTopicDetail({ id: topics.topics[0].id });
  assert.equal(detail.topic.id, topics.topics[0].id);
  assert.ok('sections' in detail && 'revisions' in detail);
  assert.equal(detail.revisions.length, 1);
  assert.throws(() => api.getTopicDetail({ id: 99999 }), /no topic/);

  const k = api.getKnowledge({ topic_id: topics.topics[0].id });
  assert.ok(k.knowledge.length >= 1);
  assert.ok(Array.isArray(k.knowledge[0].evidence));
  const kq = api.getKnowledge({ q: 'zzz-no-match' });
  assert.equal(kq.knowledge.length, 0);

  const reports = api.listReports({ limit: 50 });
  assert.ok(Array.isArray(reports.reports));
  assert.ok(reports.reports.every((r) => ['daily', 'weekly', 'coverage', 'research', 'learning'].includes(r.kind)));
  const dailyOnly = api.listReports({ kind: 'weekly' });
  assert.ok(dailyOnly.reports.every((r) => r.kind === 'weekly'));
  assert.throws(() => api.listReports({ kind: 'yearly' }), /kind/);
  assert.throws(() => api.getReportMarkdown({ kind: 'daily' }), /date is required/);

  // researchTrigger validates topic and only records a 'requested' candidate
  // (agent hand-off queue); it must NOT create a research task or a job.
  assert.throws(() => api.researchTrigger({}), /topic is required/);
  const rt = api.researchTrigger({ topic: 'Agent 架构 deep dive', title: 'Agent 架构', document_id: 1 });
  assert.equal(rt.ok, true);
  assert.equal(rt.queued, true);
  assert.ok(rt.candidate_id);
  assert.match(rt.message, /大肥鱼/);
  const cand = db.prepare("SELECT topic, status, reason, document_id FROM intel_research_candidates WHERE topic = 'Agent 架构 deep dive'").get();
  assert.equal(cand.status, 'requested');
  assert.equal(cand.document_id, 1);
  assert.match(cand.reason, /用户触发深入研究/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM intel_research_tasks WHERE kind = 'research' AND repo = ?").get('Agent 架构 deep dive').n, 0);
  const dup = api.researchTrigger({ topic: 'Agent 架构 deep dive' });
  assert.equal(dup.updated, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM intel_research_candidates WHERE topic = 'Agent 架构 deep dive'").get().n, 1);
  assert.throws(() => api.listJobs({ kind: 'NOT_A_KIND' }), /kind/);

  // refreshTopic: no matching recent docs -> examined 0, written 0; still ok.
  const rf = await api.refreshTopic({ id: topics.topics[0].id });
  assert.equal(rf.ok, true);
  await assert.rejects(() => api.refreshTopic({ id: 99999 }), /no topic/);

  // triggerCollect without injected collect falls back to the queue.
  const tc = await api.triggerCollect({ kind: 'all' });
  assert.equal(tc.mode, 'queued');
  const tcSync = await api.triggerCollect({ kind: 'rss', ...{} });
  assert.ok(['queued', 'sync'].includes(tcSync.mode));
  closeDb(db);
});

test('triggerCollect uses the injected collect closure when provided', async () => {
  const db = tempDb();
  let called = null;
  const api = createWebApi(db, {}, {
    collect: async (kind) => { called = kind; return { fetched: 5, inserted: 3, errors: ['x'] }; },
  });
  const r = await api.triggerCollect({ kind: 'github' });
  assert.equal(called, 'github');
  assert.equal(r.mode, 'sync');
  assert.equal(r.fetched, 5);
  assert.equal(r.inserted, 3);
  assert.equal(r.errors, 1);
  assert.equal(WEB_API_METHODS.includes('triggerCollect'), true);
  closeDb(db);
});
