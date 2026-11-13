/** Deep research tests: creation/budget/dedup, full pipeline with mocked web+LLM, conflict annotation, state machine. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, closeDb, insertDocument, saveDocScore } from '../lib/db.js';
import { enqueueJob, runDueJobs } from '../lib/scheduler.js';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDeepResearchTask, runDeepResearchTask, detectConflicts, validateResearchReport, extractQuote, getResearchTask, RESEARCH_KIND } from '../lib/research.js';

function setup({ budgetPerDay = 3 } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'intelhub-research-'));
  const dbPath = path.join(dir, 'test.db');
  const db = openDb(dbPath);
  const reportsDir = path.join(dir, 'reports');
  return { db, dir, reportsDir, budgetPerDay };
}

const DAY = '2026-11-05';

function seedLocalDoc(db, topic) {
  const r = insertDocument(db, {
    url: 'https://local.example/memory-bench',
    title: `${topic} benchmark paper`,
    summary: `Benchmark paper on ${topic}: retrieval quality improved twenty percent, contradicting earlier negative reports about compression.`,
    raw_content: `Benchmark paper on ${topic}: retrieval quality improved twenty percent, contradicting earlier negative reports about compression.`,
    source_type: 'arxiv', lang: 'en',
    published_at: `${DAY}T01:00:00.000Z`, fetched_at: `${DAY}T02:00:00.000Z`,
  });
  saveDocScore(db, { documentId: r.id, r: 70, n: 60, p: 40, e: 90, t: 80, total: 70, stage: 'L3', decision: 'RECOMMEND', createdAt: `${DAY}T02:00:00.000Z` });
  return r.id;
}

const okWebSearch = async (req) => ({
  sources: [
    { url: 'https://blog.example.org/memory-compression', title: 'Blog: memory compression deep dive', snippet: 'we disagree: compression gains are marginal' },
    { url: 'https://wiki.example.net/memory-compression', title: 'Wiki: overview', snippet: 'compression saves context' },
  ],
});

const okWebFetch = async (url) => {
  if (url.includes('blog.example.org')) {
    return { ok: true, status: 200, text: async () => 'x'.repeat(1) , arrayBuffer: async () => new ArrayBuffer(0) };
  }
  return { ok: true, status: 200, text: async () => 'placeholder' };
};

// createFetcher.getText needs res.status + res.text; craft a minimal Response-like
function textResponse(status, text) {
  return { status, text: async () => text };
}

const fetchResponses = {
  'https://local.example/memory-bench': textResponse(200, 'Benchmark paper: retrieval quality improved twenty percent, contradicting earlier negative reports about compression.'),
  'https://blog.example.org/memory-compression': textResponse(200, 'We disagree with the benchmark: memory compression gains are marginal in production traces.'.repeat(4)),
  'https://wiki.example.net/memory-compression': textResponse(200, 'Memory compression stores a condensed context. Early studies reported large savings across workloads.'.repeat(4)),
};

const okFetch = async (url) => fetchResponses[url] || textResponse(404, 'nope');

const okLlm = {
  stream: async function* (opts) {
    const text = JSON.stringify({
      summary: `依据给定证据：两条来源对压缩收益结论不一致，需人工核实。`,
      key_points: ['[e1] 基准显示检索质量提升', '[e2] 生产追踪显示收益有限'],
      citations: ['e1', 'e2'],
      conflicts_note: '来源间存在明显分歧',
    });
    yield { type: 'text-delta', text };
    yield { type: 'finish', reason: { kind: 'stop' } };
  },
};

test('createDeepResearchTask: validation, dedup, daily budget rejection', () => {
  const { db, budgetPerDay } = setup({ budgetPerDay: 2 });
  assert.match(createDeepResearchTask(db, { topic: '' }).error.code, /INVALID_TOPIC/);
  assert.match(createDeepResearchTask(db, { topic: 'x', depth: 'nope' }).error.code, /INVALID_DEPTH/);
  const a = createDeepResearchTask(db, { topic: 'agent memory', depth: 'quick' }, { budgetPerDay });
  assert.equal(a.ok, true);
  assert.equal(a.depth, 'quick');
  assert.equal(a.max_sources, 4, 'quick default max_sources');
  const dedup = createDeepResearchTask(db, { topic: 'agent memory' }, { budgetPerDay });
  assert.equal(dedup.deduped, true);
  const b = createDeepResearchTask(db, { topic: 'rag rerank' }, { budgetPerDay });
  assert.equal(b.ok, true);
  const c = createDeepResearchTask(db, { topic: 'mcp' }, { budgetPerDay });
  assert.equal(c.ok, false);
  assert.equal(c.error.code, 'BUDGET_EXCEEDED');
  assert.match(c.error.message, /budget reached \(2\/2/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM intel_research_tasks WHERE kind = ?').get(RESEARCH_KIND).n, 2);
  closeDb(db);
});

test('full pipeline: CREATED->COMPLETED with local+web evidence, conflict annotation, report file, token usage', async () => {
  const { db, reportsDir } = setup();
  seedLocalDoc(db, 'memory compression');
  const created = createDeepResearchTask(db, { topic: 'memory compression', depth: 'standard', maxSources: 3 }, { budgetPerDay: 5 });
  const taskId = created.task_id;
  const job = enqueueJob(db, { kind: 'RESEARCH_TASK', runDate: `2026-11-05#${taskId}`, payload: { task_id: taskId } });
  assert.ok(job.enqueued);

  const handlers = {
    RESEARCH_TASK: async (j) => runDeepResearchTask(db, j.payload.task_id, {
      webSearch: okWebSearch, webFetch: okFetch, llm: okLlm, provider: 'test', model: 'test',
      reportsDir, logger: console,
    }),
  };
  const results = await runDueJobs(db, handlers, { execTimeoutMs: 30000 });
  assert.ok(results[0].ok, `job failed: ${results[0].error}`);
  assert.equal(results[0].result.status, 'COMPLETED');

  const task = getResearchTask(db, taskId);
  assert.equal(task.status, 'COMPLETED');
  const result = JSON.parse(task.result_json);
  assert.equal(result.evidence_count, 3, 'local doc + 2 web docs');
  assert.ok(result.evidences.length === 3);
  assert.ok(result.evidences[0].document_id, 'local evidence links document_id');
  // conflict: blog ("gains marginal") vs wiki ("large savings") on subtopic "compression"
  assert.ok(result.conflicts.length >= 1, 'conflicting sources annotated');
  assert.ok(result.conflicts[0].sources.length === 2);
  assert.ok(!result.insufficient_data);
  assert.ok(result.token_usage.estimate_tokens > 0, 'token usage estimated');
  assert.ok(!result.report.includes('信息不足：未获得可用证据'), 'sufficient evidence -> no insufficiency notice');
  assert.ok(/\[e1\]|\[e2\]/.test(result.report), 'report cites evidence ids');
  const file = path.join(reportsDir, 'research', `${taskId}.md`);
  assert.ok(existsSync(file), 'report markdown written');
  const md = readFileSync(file, 'utf8');
  assert.match(md, /## 全部来源/);
  assert.match(md, /https:\/\/blog\.example\.org\/memory-compression/);
  assert.match(md, /## 来源冲突/);
  // tool view
  const status = JSON.stringify(task.status);
  assert.equal(status, '"COMPLETED"');
  closeDb(db);
});

test('web search failure is non-fatal: quick depth completes with local evidence only', async () => {
  const { db, reportsDir } = setup();
  seedLocalDoc(db, 'agent memory');
  const created = createDeepResearchTask(db, { topic: 'agent memory', depth: 'quick', maxSources: 4 }, { budgetPerDay: 5 });
  const r = await runDeepResearchTask(db, created.task_id, {
    webSearch: async () => { throw new Error('WEB_PROVIDER_UNAVAILABLE'); },
    webFetch: null, llm: null, reportsDir, logger: console,
  });
  assert.equal(r.status, 'COMPLETED');
  const task = getResearchTask(db, created.task_id);
  const result = JSON.parse(task.result_json);
  assert.equal(result.evidence_count, 1);
  assert.match(result.web_error, /WEB_PROVIDER_UNAVAILABLE/);
  assert.match(result.report, /信息不足/, 'single-evidence report states insufficiency honestly');
  closeDb(db);
});

test('rerun after completion is a no-op; LLM failure falls back to rule body (degraded)', async () => {
  const { db, reportsDir } = setup();
  seedLocalDoc(db, 'mcp');
  seedLocalDoc(db, 'mcp servers'); // second doc so llm path would trigger
  const created = createDeepResearchTask(db, { topic: 'mcp', depth: 'deep' }, { budgetPerDay: 5 });
  const brokenLlm = { stream: async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { message: 'boom' } } }; } };
  const r = await runDeepResearchTask(db, created.task_id, {
    webSearch: okWebSearch, webFetch: okFetch, llm: brokenLlm, provider: 'p', model: 'm', reportsDir, logger: console,
  });
  assert.equal(r.status, 'COMPLETED');
  const task = getResearchTask(db, created.task_id);
  const result = JSON.parse(task.result_json);
  assert.ok(result.evidence_count >= 2, 'llm path attempted (>=2 evidences)');
  assert.match(result.report, /规则编排/, 'LLM failure fell back to the rule body');
  const again = await runDeepResearchTask(db, created.task_id, { logger: console });
  assert.equal(again.status, 'COMPLETED');
  assert.match(again.note, /terminal/);
  closeDb(db);
});

test('validateResearchReport + extractQuote rules', () => {
  assert.equal(validateResearchReport({ summary: 'x'.repeat(30), key_points: ['a'], citations: [] }), null);
  assert.ok(validateResearchReport({ summary: 'short', key_points: ['a'], citations: [] }));
  assert.ok(validateResearchReport({ summary: 'x'.repeat(30), key_points: [], citations: [] }));
  assert.match(extractQuote('Short. A sentence that definitely contains the keyword compression and is long enough to keep.', ['compression']), /compression/);
});

test('detectConflicts: cross-host disagreement flagged, same-host skipped', () => {
  const evs = [
    { id: 'e1', url: 'https://a.com/x', quote: 'Compression benchmarks show large memory savings across workloads and setups.' },
    { id: 'e2', url: 'https://b.com/y', quote: 'Compression delivers negligible improvement according to our production traces.' },
    { id: 'e3', url: 'https://a.com/z', quote: 'Compression benchmarks show large memory savings across workloads and setups again.' },
  ];
  const c = detectConflicts(evs);
  assert.ok(c.length >= 1);
  assert.ok(c.every((x) => new Set(x.sources).size === 2));
  assert.ok(!c.some((x) => x.sources[0] === x.sources[1] && x.sources[0].includes('a.com') && x.sources[1].includes('a.com')), 'same-host pairs skipped');
});
