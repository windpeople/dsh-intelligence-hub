/**
 * RESEARCH_REVIEW tests: the agent-run review loop (mock LLM).
 * Run: node --test tests/researchReview.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb, closeDb, insertDocument, ensureSources } from '../lib/db.js';
import { requestResearchCandidate, saveGateCandidate } from '../lib/scoring.js';
import { runResearchReview, selectReviewCandidates, validateReviewDecision, buildReviewMessages } from '../lib/researchReview.js';
import { createDeepResearchTask } from '../lib/research.js';
import { enqueueScheduledDaily, JOB_KINDS } from '../lib/scheduler.js';

function tempDb() {
  const dir = mkdtempSync(path.join(tmpdir(), 'intelhub-review-'));
  const db = openDb(path.join(dir, 'review.db'));
  ensureSources(db);
  return db;
}

/** Mock llm: yields the queued texts in order (last one repeats). */
function mockLlm(...texts) {
  let i = 0;
  return {
    async *stream() {
      const text = texts[Math.min(i++, texts.length - 1)];
      yield { type: 'text-delta', text };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
}

const cfg = (over = {}) => ({
  reportTimeZone: 'Asia/Shanghai',
  analysisProvider: 'p',
  analysisModel: 'm',
  analysisEnabled: true,
  researchBudgetPerDay: 3,
  researchReviewBatch: 5,
  tokenBudgetPerDay: 0,
  ...over,
});

const RESEARCH_JSON = '{"decision":"research","reason":"主题聚焦且与兴趣强相关","refined_topic":"Agent memory 架构对比"}';
const DISMISS_JSON = '{"decision":"dismiss","reason":"主题过时，重复度高"}';

function seed(db, { topic = 'Agent memory', status = 'requested', docTitle = null } = {}) {
  let docId = null;
  if (docTitle) {
    docId = insertDocument(db, {
      url: `https://example.com/${encodeURIComponent(topic)}`, title: docTitle,
      summary: 'sum', lang: 'en', topic: 'agent', dedupKey: `k-${topic}`, contentHash: `h-${topic}`, searchText: topic,
    }, null, new Date().toISOString()).id;
  }
  if (status === 'requested') {
    return requestResearchCandidate(db, { topic, documentId: docId, reason: '用户触发' }).id;
  }
  saveGateCandidate(db, { doc: { id: docId, title: topic, url: 'u' }, gate: { decision: 'WATCHLIST', status: 'watching', reason: 'gate 建议测试' } });
  return db.prepare('SELECT id FROM intel_research_candidates WHERE topic = ?').get(topic).id;
}

test('review: research branch enqueues RESEARCH_TASK with refined_topic; dismiss branch archives with reason', async () => {
  const db = tempDb();
  const idR = seed(db, { topic: 'Agent memory', status: 'requested', docTitle: 'Agent Memory Paper' });
  seed(db, { topic: '过时的框架 X', status: 'watching', docTitle: 'Framework X' });
  const r = await runResearchReview(db, {
    llm: mockLlm(RESEARCH_JSON, DISMISS_JSON),
    config: cfg(),
  });
  assert.equal(r.skipped, false);
  assert.equal(r.enqueued, 1);
  assert.equal(r.dismissed, 1);
  const mem = db.prepare('SELECT status, reason FROM intel_research_candidates WHERE id = ?').get(idR);
  assert.equal(mem.status, 'researching');
  assert.match(mem.reason, /已入队/);
  const task = db.prepare("SELECT repo FROM intel_research_tasks WHERE repo = 'Agent memory 架构对比'").get();
  assert.ok(task, 'refined topic task created');
  const job = db.prepare("SELECT payload FROM intel_job_executions WHERE kind = 'RESEARCH_TASK' ORDER BY id DESC LIMIT 1").get();
  const payload = JSON.parse(job.payload);
  assert.equal(payload.candidate_id, idR);
  assert.equal(payload.topic, 'Agent memory 架构对比');
  assert.equal(db.prepare("SELECT status FROM intel_research_candidates WHERE topic = '过时的框架 X'").get().status, 'dismissed');
  // token usage recorded
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM intel_usage WHERE call = 'research_review'").get().n >= 2);
  closeDb(db);
});

test('review: research-budget exhausted -> candidate deferred, kept for next round', async () => {
  const db = tempDb();
  seed(db, { topic: 'Budget case', status: 'requested' });
  // Spend the daily budget (1) beforehand.
  const pre = createDeepResearchTask(db, { topic: 'pre-existing task' }, { budgetPerDay: 1 });
  assert.equal(pre.ok, true);
  const r = await runResearchReview(db, { llm: mockLlm(RESEARCH_JSON), config: cfg({ researchBudgetPerDay: 1 }) });
  assert.equal(r.deferred, 1);
  assert.equal(r.enqueued, 0);
  const cand = db.prepare("SELECT status FROM intel_research_candidates WHERE topic = 'Budget case'").get();
  assert.equal(cand.status, 'deferred');
  // Next round (budget raised) picks the deferred candidate up again.
  const pool = selectReviewCandidates(db, { limit: 5 });
  assert.equal(pool.length, 1);
  assert.equal(pool[0].status, 'deferred');
  closeDb(db);
});

test('review: token budget exhausted -> remaining pool untouched', async () => {
  const db = tempDb();
  seed(db, { topic: 'Token budget A', status: 'requested' });
  seed(db, { topic: 'Token budget B', status: 'watching' });
  // Tiny budget: the first candidate spends it, the second is kept.
  const r = await runResearchReview(db, { llm: mockLlm(RESEARCH_JSON), config: cfg({ tokenBudgetPerDay: 5 }) });
  assert.equal(r.skipped, false);
  const actions = Object.fromEntries(r.reviewed.map((x) => [x.topic, x.action]));
  assert.notEqual(actions['Token budget A'], 'kept');
  assert.equal(actions['Token budget B'], 'kept');
  assert.equal(db.prepare("SELECT status FROM intel_research_candidates WHERE topic = 'Token budget B'").get().status, 'watching');
  closeDb(db);
});

test('review: no candidates -> empty run; missing llm -> skipped', async () => {
  const db = tempDb();
  const empty = await runResearchReview(db, { llm: mockLlm(RESEARCH_JSON), config: cfg() });
  assert.equal(empty.skipped, false);
  assert.equal(empty.reviewed.length, 0);
  seed(db, { topic: 'Nobody reviews me', status: 'requested' });
  const skipped = await runResearchReview(db, { llm: null, config: cfg() });
  assert.equal(skipped.skipped, true);
  assert.match(skipped.reason, /llm unavailable/);
  const skipped2 = await runResearchReview(db, { llm: mockLlm(RESEARCH_JSON), config: cfg({ analysisProvider: '' }) });
  assert.equal(skipped2.skipped, true);
  assert.equal(db.prepare("SELECT status FROM intel_research_candidates WHERE topic = 'Nobody reviews me'").get().status, 'requested');
  closeDb(db);
});

test('review: invalid JSON twice -> candidate keeps its status (retry then fallback skip)', async () => {
  const db = tempDb();
  seed(db, { topic: 'Bad output case', status: 'requested' });
  const r = await runResearchReview(db, { llm: mockLlm('not json at all'), config: cfg() });
  assert.equal(r.skipped, false);
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0].error, /review failed after retry/);
  assert.equal(db.prepare("SELECT status FROM intel_research_candidates WHERE topic = 'Bad output case'").get().status, 'requested');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM intel_research_tasks WHERE kind = 'research'").get().n, 0);
  closeDb(db);
});

test('scheduler: RESEARCH_REVIEW daily enqueue is same-day idempotent; kind whitelisted', () => {
  assert.ok(JOB_KINDS.includes('RESEARCH_REVIEW'));
  const db = tempDb();
  // 08:00Z = 16:00 Asia/Shanghai, past the 15:00 slot.
  const now = new Date('2026-11-12T08:00:00Z');
  const a = enqueueScheduledDaily(db, [{ kind: 'RESEARCH_REVIEW', at: '15:00' }], { timeZone: 'Asia/Shanghai', now, nextRunAt: now.toISOString() });
  const b = enqueueScheduledDaily(db, [{ kind: 'RESEARCH_REVIEW', at: '15:00' }], { timeZone: 'Asia/Shanghai', now, nextRunAt: now.toISOString() });
  assert.equal(a.length, 1);
  assert.equal(b.length, 0, 'same-day re-enqueue deduped');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM intel_job_executions WHERE kind = 'RESEARCH_REVIEW'").get().n, 1);
  closeDb(db);
});

test('review: internal jargon in reason (阈值/评分) is rejected and retried; fallback keeps candidate', async () => {
  const db = tempDb();
  seed(db, { topic: 'Jargon case', status: 'requested' });
  const r = await runResearchReview(db, {
    llm: mockLlm('{"decision":"dismiss","reason":"评分71未达85阈值，转WATCHLIST"}'),
    config: cfg(),
  });
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0].error, /review failed after retry/);
  assert.equal(db.prepare("SELECT status FROM intel_research_candidates WHERE topic = 'Jargon case'").get().status, 'requested');
  // Plain reason passes.
  const ok = validateReviewDecision({ decision: 'dismiss', reason: '这个方向和你关注的记忆能力关系不大，先放着。' });
  assert.equal(ok, null);
  closeDb(db);
});

test('validateReviewDecision: schema checks', () => {
  assert.equal(validateReviewDecision({ decision: 'research', reason: 'r' }), null);
  assert.equal(validateReviewDecision({ decision: 'research', reason: 'r', refined_topic: 't' }), null);
  assert.match(validateReviewDecision({ decision: 'maybe', reason: 'r' }), /decision/);
  assert.match(validateReviewDecision({ decision: 'research', reason: '' }), /reason/);
  assert.match(validateReviewDecision({ decision: 'research', reason: 'r', refined_topic: '  ' }), /refined_topic/);
  assert.match(validateReviewDecision('x'), /not an object/);
  // Prompt messages carry the profile + candidate context.
  const msgs = buildReviewMessages({ topic: 'T', candidate_reason: 'why', status: 'watching', document_title: 'D' }, '长期兴趣: agent');
  assert.match(msgs[0].content[0].text, /长期兴趣: agent/);
  assert.match(msgs[0].content[0].text, /证据文档：D/);
});
