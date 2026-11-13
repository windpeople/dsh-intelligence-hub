/**
 * Research hand-off tests: the "是否深入研究" decision moved from the rule
 * pipeline to the agent (大肥鱼). The gate only produces suggestion candidates;
 * user/panel requests land in intel_research_candidates with status='requested';
 * the agent discovers them via intel_pending_research and its intel_research
 * run (RESEARCH_TASK COMPLETED) flips them to 'done'.
 *
 * Run: node --test tests/researchHandoff.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb, closeDb, insertDocument, ensureSources, saveDocScore } from '../lib/db.js';
import { researchGate, saveGateCandidate, requestResearchCandidate, listRequestedResearch, completeResearchCandidates } from '../lib/scoring.js';
import { buildTools } from '../lib/tools.js';
import { createWebApi } from '../lib/webapi.js';

function tempDb() {
  const dir = mkdtempSync(path.join(tmpdir(), 'intelhub-handoff-'));
  const db = openDb(path.join(dir, 'handoff.db'));
  ensureSources(db);
  return db;
}

const th = { archive: 50, digest: 50, recommend: 70, research: 85 };

test('gate only records suggestion candidates; no research task or job is created', () => {
  const db = tempDb();
  const doc = { id: 1, source_type: 'arxiv', title: 'Agent memory paper', url: 'https://arxiv.org/a' };
  const gate = researchGate(db, doc, 90, { thresholds: th, eventDocCount: 1 });
  assert.equal(gate.decision, 'DEEP_RESEARCH');
  saveGateCandidate(db, { doc, gate, eventId: null });
  const cand = db.prepare('SELECT topic, status FROM intel_research_candidates').get();
  assert.equal(cand.status, 'queued'); // gate suggestion status, not a user request
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM intel_research_tasks WHERE kind = 'research'").get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM intel_job_executions').get().n, 0);
  closeDb(db);
});

test('researchTrigger records a requested candidate only (no task/job); dedup by topic', () => {
  const db = tempDb();
  const api = createWebApi(db, { researchBudgetPerDay: 3, reportTimeZone: 'Asia/Shanghai' }, {});
  const r = api.researchTrigger({ topic: 'Agent memory', title: 'Agent Memory 深度解析', document_id: 7 });
  assert.equal(r.ok, true);
  assert.equal(r.queued, true);
  assert.match(r.message, /大肥鱼/);
  const cand = db.prepare("SELECT status, reason, document_id, decision FROM intel_research_candidates WHERE topic = 'Agent memory'").get();
  assert.equal(cand.status, 'requested');
  assert.equal(cand.document_id, 7);
  assert.match(cand.reason, /用户触发深入研究/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM intel_research_tasks WHERE kind = 'research'").get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM intel_job_executions').get().n, 0);
  // Second click on the same topic updates the row instead of duplicating.
  const dup = api.researchTrigger({ topic: 'Agent memory' });
  assert.equal(dup.updated, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM intel_research_candidates WHERE topic = 'Agent memory'").get().n, 1);
  assert.throws(() => api.researchTrigger({}), /topic is required/);
  closeDb(db);
});

test('intel_pending_research lists requested candidates with evidence doc; completion flips to done', async () => {
  const db = tempDb();
  const now = new Date().toISOString();
  const docId = insertDocument(db, {
    url: 'https://arxiv.org/abs/1234', title: 'Agent Memory Paper',
    summary: 's', lang: 'en', topic: 'agent', dedupKey: 'k1', contentHash: 'h1', searchText: 'agent memory',
  }, null, now).id;
  requestResearchCandidate(db, { topic: 'Agent memory', documentId: docId, reason: 'Agent Memory Paper（用户触发深入研究）' });
  // A gate 'watching' candidate must NOT appear in the pending list.
  saveGateCandidate(db, { doc: { id: null, title: 'watch only', url: 'u2' }, gate: { decision: 'WATCHLIST', status: 'watching', reason: 'r' } });

  const tools = {};
  for (const t of buildTools({ db, config: { reportTimeZone: 'Asia/Shanghai', dbPath: ':memory:' }, webFetch: null, webSearch: null })) tools[t.name] = t;
  const pending = await tools.intel_pending_research.execute({ limit: 10 });
  assert.equal(pending.ok, true);
  assert.equal(pending.count, 1);
  assert.equal(pending.items[0].topic, 'Agent memory');
  assert.equal(pending.items[0].document_title, 'Agent Memory Paper');
  assert.equal(pending.items[0].document_url, 'https://arxiv.org/abs/1234');

  // RESEARCH_TASK COMPLETED handler closure: requested -> done.
  const marked = completeResearchCandidates(db, 'Agent memory');
  assert.equal(marked.updated, 1);
  assert.equal(listRequestedResearch(db).length, 0);
  assert.equal(db.prepare("SELECT status FROM intel_research_candidates WHERE topic = 'Agent memory'").get().status, 'done');
  // Idempotent: nothing left to mark.
  assert.equal(completeResearchCandidates(db, 'Agent memory').updated, 0);
  closeDb(db);
});
