/** Learning material tests: facts collection, evidence-citation validation, degraded fallback, persistence + file. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, closeDb, insertDocument, saveDocScore, saveReport } from '../lib/db.js';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectFacts, validateLearningMaterial, ruleLearningMaterial, buildLearningMarkdown, generateLearningMaterial } from '../lib/learning.js';
import { createDeepResearchTask, runDeepResearchTask, getResearchTask } from '../lib/research.js';

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'intelhub-learning-'));
  const dbPath = path.join(dir, 'test.db');
  const db = openDb(dbPath);
  return { db, dir, reportsDir: path.join(dir, 'reports') };
}

const DAY = '2026-11-05';

function seedDocs(db, topic = 'agent memory') {
  const ids = [];
  for (const [i, u] of ['a', 'b', 'c'].entries()) {
    const r = insertDocument(db, {
      url: `https://ex.com/${u}`,
      title: `${topic} study ${i + 1}`,
      summary: `Study ${i + 1}: ${topic} improves recall; benchmarks included.`,
      source_type: 'rss', lang: 'en', fetched_at: `${DAY}T0${i + 1}:00:00.000Z`,
    });
    saveDocScore(db, { documentId: r.id, r: 60, n: 55, p: 50, e: 60, t: 70, total: 80 - i, stage: 'L3', decision: 'RECOMMEND', createdAt: `${DAY}T09:00:00.000Z` });
    ids.push(r.id);
  }
  return ids;
}

test('collectFacts: topic docs, report, and completed research task sources', async () => {
  const { db, reportsDir } = setup();
  seedDocs(db);
  const byTopic = collectFacts(db, { topic: 'agent memory' });
  assert.equal(byTopic.source_type, 'topic_docs');
  assert.equal(byTopic.facts.length, 3);
  assert.match(byTopic.facts[0].text, /agent memory/);
  assert.throws(() => collectFacts(db, {}), /one of topic/);
  assert.equal(collectFacts(db, { topic: 'ghost-topic-xyz' }).facts.length, 0, 'unknown topic yields empty facts');
  // report source
  const saved = saveReport(db, { reportDate: DAY, title: '日报', body: 'body', documentIds: [1, 2], createdAt: new Date().toISOString() });
  const byReport = collectFacts(db, { reportId: saved.id });
  assert.equal(byReport.source_type, 'daily_report');
  assert.equal(byReport.facts.length, 2);
  closeDb(db);
});

test('validateLearningMaterial: citations must reference real evidence ids; practice_tasks 3-5', () => {
  const ok = {
    learning_objectives: ['o'], prerequisites: ['p'],
    concepts: [{ term: 't', explanation: 'e', evidence_ids: ['d1'] }],
    technical_flow: [{ step: 's', detail: 'd', evidence_ids: ['d1'] }],
    cases: [{ name: 'c', description: 'd', evidence_ids: ['d2'] }],
    practice_tasks: ['1', '2', '3'],
    common_mistakes: ['m'], interview_questions: ['q'], next_directions: ['n'],
  };
  assert.equal(validateLearningMaterial(ok, ['d1', 'd2']), null);
  assert.match(String(validateLearningMaterial({ ...ok, practice_tasks: ['1', '2'] }, ['d1'])), /practice_tasks/);
  assert.match(String(validateLearningMaterial({ ...ok, practice_tasks: ['1', '2', '3', '4', '5', '6'] }, ['d1'])), /practice_tasks/);
  assert.match(String(validateLearningMaterial({ ...ok, concepts: [{ term: 't', explanation: 'e', evidence_ids: ['ghost'] }] }, ['d1'])), /unknown evidence/);
  assert.match(String(validateLearningMaterial({ ...ok, cases: ['just a string'] }, ['d1'])), /must be objects/);
});

test('generateLearningMaterial without LLM: degraded rule template citing real facts, persisted + file', async () => {
  const { db, reportsDir } = setup();
  seedDocs(db);
  const r = await generateLearningMaterial(db, { topic: 'agent memory', reportsDir });
  assert.ok(r.ok);
  assert.equal(r.degraded, true);
  assert.ok(r.facts.length >= 1);
  assert.ok(r.practice_tasks >= 3 && r.practice_tasks <= 5);
  const row = db.prepare('SELECT * FROM intel_learning_materials WHERE id = ?').get(r.id);
  assert.ok(row, 'stored in intel_learning_materials');
  assert.equal(row.degraded, 1);
  assert.equal(row.subject, 'agent memory');
  const content = JSON.parse(row.content_json);
  assert.ok(Array.isArray(content.facts));
  const md = readFileSync(r.file_path, 'utf8');
  assert.match(md, /# 学习材料 · agent memory/);
  assert.match(md, /degraded/);
  assert.match(md, /## 练习任务/);
  assert.match(md, /证据：\[d1\]/, 'citations link to evidence refs');
  assert.ok(!existsSync(path.join(reportsDir, 'learning', 'nonexistent')));
});

test('LLM path: validated material stored non-degraded; invalid citations fall back to rule template', async () => {
  const { db, reportsDir } = setup();
  seedDocs(db);
  const goodLlm = {
    stream: async function* () {
      yield {
        type: 'text-delta',
        text: '```json\n' + JSON.stringify({
          learning_objectives: ['理解 agent memory 证据'], prerequisites: ['检索基础'],
          concepts: [{ term: 'recall improvement', explanation: '证据中提到 recall 提升', evidence_ids: ['d1', 'd2'] }],
          technical_flow: [{ step: '读证据', detail: '按分数顺序', evidence_ids: ['d1'] }],
          cases: [{ name: 'study', description: 'benchmark included', evidence_ids: ['d2'] }],
          practice_tasks: ['概括 d1', '对比 d1/d2', '写一页笔记'],
          common_mistakes: ['忽略出处'], interview_questions: ['如何评估 novelty'], next_directions: ['发起研究'],
        }) + '\n```',
      };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const good = await generateLearningMaterial(db, { topic: 'agent memory', reportsDir, llm: goodLlm, provider: 'p', model: 'm' });
  assert.equal(good.degraded, false);
  assert.equal(db.prepare('SELECT degraded FROM intel_learning_materials WHERE id = ?').get(good.id).degraded, 0);

  const badLlm = {
    stream: async function* () {
      yield { type: 'text-delta', text: JSON.stringify({ ...{}, learning_objectives: ['x'], prerequisites: ['p'], concepts: [{ term: 't', explanation: 'e', evidence_ids: ['ghost-id'] }], technical_flow: [{ step: 's', detail: 'd', evidence_ids: ['d1'] }], cases: [{ name: 'c', description: 'd', evidence_ids: ['d1'] }], practice_tasks: ['1', '2', '3'], common_mistakes: ['m'], interview_questions: ['q'], next_directions: ['n'] }) };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const fallback = await generateLearningMaterial(db, { topic: 'agent memory', reportsDir, llm: badLlm, provider: 'p', model: 'm' });
  assert.equal(fallback.degraded, true, 'invalid citations -> rule fallback');
  closeDb(db);
});

test('learning material from a completed research task cites its evidence ids', async () => {
  const { db, reportsDir } = setup();
  insertDocument(db, {
    url: 'https://ex.com/paper', title: 'agent memory paper', summary: 'The method improves memory retrieval quality substantially in benchmarks.',
    raw_content: 'The method improves memory retrieval quality substantially in benchmarks. Prior studies reported mixed results on memory compression.',
    source_type: 'arxiv', lang: 'en', fetched_at: `${DAY}T01:00:00.000Z`,
  });
  const created = createDeepResearchTask(db, { topic: 'agent memory', depth: 'quick', maxSources: 4 }, { budgetPerDay: 9 });
  await runDeepResearchTask(db, created.task_id, { webSearch: null, webFetch: null, llm: null, reportsDir, logger: console });
  assert.equal(getResearchTask(db, created.task_id).status, 'COMPLETED');

  const mat = await generateLearningMaterial(db, { taskId: created.task_id, reportsDir });
  assert.equal(mat.source_type, 'research_task');
  assert.ok(mat.facts.length >= 1);
  assert.match(mat.markdown, /证据：\[e1\]/, 'material cites research evidence ids');
  const row = db.prepare('SELECT * FROM intel_learning_materials WHERE id = ?').get(mat.id);
  assert.equal(row.source_ref, created.task_id);
  await assert.rejects(() => generateLearningMaterial(db, { taskId: 'nope' }), /unknown task/);
  closeDb(db);
});
