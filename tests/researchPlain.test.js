/**
 * Report readability fixes: hard gate on zero evidence, local-library evidence
 * fallback, arXiv abstract fetch, and the plain-language「给你的摘要」section.
 * Run: node --test tests/researchPlain.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb, closeDb, insertDocument } from '../lib/db.js';
import { createDeepResearchTask, runDeepResearchTask, buildPlainSummaryMessages, plainSummaryRule } from '../lib/research.js';

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'intelhub-plain-'));
  const db = openDb(path.join(dir, 'test.db'));
  const reportsDir = path.join(dir, 'reports');
  return { db, dir, reportsDir };
}

const textResponse = (status, text) => ({ status, text: async () => text });

/** Mock llm: yields queued texts in order. */
function mockLlm(...texts) {
  let i = 0;
  return {
    stream: async function* () {
      yield { type: 'text-delta', text: texts[Math.min(i++, texts.length - 1)] };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
}

const PLAIN = '这是一种让AI助手记住之前聊过内容的新方法。它值得你关注，因为记忆能力正是你关注的智能体方向的核心短板。和你关注的RAG（检索增强，先查资料再回答）思路相通。想深入可以先把下面第一条链接读一遍，再对照第二条看不同结论。'.repeat(1);

const SUMMARY_LLM = JSON.stringify({
  summary: '两条来源对压缩收益结论不一致，需人工核实。',
  key_points: ['[e1] 基准显示检索质量提升'],
  citations: ['e1'],
  conflicts_note: '无',
});

async function runTask(db, taskId, opts) {
  return runDeepResearchTask(db, taskId, {
    config: {}, reportsDir: opts.reportsDir ?? null, logger: { info() {}, warn() {} },
    ...opts,
  });
}

test('zero evidence -> COMPLETED with empty result, no report file', async () => {
  const { db, reportsDir } = setup();
  const created = createDeepResearchTask(db, { topic: 'totally unknown topic xyz' }, { budgetPerDay: 3 });
  const r = await runTask(db, created.task_id, {
    webSearch: async () => ({ sources: [{ url: 'https://x.example/a', title: 'A', snippet: 's' }] }),
    webFetch: async () => textResponse(404, 'nope'),
    llm: mockLlm(SUMMARY_LLM, PLAIN),
  });
  assert.equal(r.status, 'COMPLETED');
  assert.equal(r.empty, true);
  assert.equal(r.evidence_count, 0);
  const task = db.prepare('SELECT result_json FROM intel_research_tasks WHERE task_id = ?').get(created.task_id);
  const result = JSON.parse(task.result_json);
  assert.equal(result.empty, true);
  assert.equal(result.report, '');
  assert.ok(!existsSync(path.join(reportsDir, 'research', `${created.task_id}.md`)), 'no report file for empty evidence');
  closeDb(db);
});

test('fetch failures -> local-library content used as evidence; summary section present', async () => {
  const { db, reportsDir } = setup();
  insertDocument(db, {
    url: 'https://local.example/mem', title: 'Memory paper',
    summary: '', raw_content: 'Agent memory (智能体记忆) research shows retrieval quality improved twenty percent in benchmark traces across workloads.',
    source_type: 'arxiv', lang: 'en',
    published_at: '2026-11-12T01:00:00Z', fetched_at: '2026-11-12T02:00:00Z',
  });
  const created = createDeepResearchTask(db, { topic: 'agent memory retrieval quality' }, { budgetPerDay: 3 });
  const r = await runTask(db, created.task_id, {
    reportsDir,
    webSearch: async () => { throw new Error('no usable provider'); },
    webFetch: async () => textResponse(500, 'down'),
    llm: mockLlm(PLAIN),
  });
  assert.equal(r.status, 'COMPLETED');
  assert.equal(r.empty, undefined);
  assert.ok(r.evidence_count >= 1, 'local-library fallback produced evidence');
  const file = path.join(reportsDir, 'research', `${created.task_id}.md`);
  assert.ok(existsSync(file));
  const md = readFileSync(file, 'utf8');
  const section = /## 给你的摘要\n\n([\s\S]*?)\n\n/.exec(md);
  assert.ok(section, '给你的摘要 section exists at top');
  assert.ok(md.indexOf('## 给你的摘要') < md.indexOf('## 结论摘要'), 'summary section comes first');
  assert.ok(section[1].length >= 50 && section[1].length <= 400, 'summary in plain-summary length range');
  assert.ok(!section[1].includes('阈值'), 'plain summary has no internal jargon');
  closeDb(db);
});

test('no llm -> rule plain summary (degraded marker present)', async () => {
  const { db, reportsDir } = setup();
  insertDocument(db, {
    url: 'https://local.example/mem2', title: 'Memory paper 2',
    summary: '', raw_content: 'Agent memory research shows retrieval quality improved twenty percent in benchmark traces across many workloads and settings.',
    source_type: 'arxiv', lang: 'en',
    published_at: '2026-11-12T01:00:00Z', fetched_at: '2026-11-12T02:00:00Z',
  });
  const created = createDeepResearchTask(db, { topic: 'agent memory retrieval' }, { budgetPerDay: 3 });
  const r = await runTask(db, created.task_id, { reportsDir, webSearch: null, webFetch: null, llm: null });
  const md = readFileSync(path.join(reportsDir, 'research', `${created.task_id}.md`), 'utf8');
  assert.ok(md.includes('规则拼接'), 'degraded marker for rule summary');
  assert.match(md, /这次帮你查了/, 'rule summary uses humanized wording');
  assert.equal(r.status, 'COMPLETED');
  closeDb(db);
});

test('plain summary helpers: prompt asks the four questions; rule text humanized', () => {
  const msgs = buildPlainSummaryMessages('agent memory', [{ id: 'e1', url: 'u', title: 'T', quote: 'q' }], 3);
  const text = msgs[0].content[0].text;
  for (const kw of ['这是什么', '为什么值得', '什么关系', '从哪', '括号']) assert.ok(text.includes(kw), `prompt covers: ${kw}`);
  const rule = plainSummaryRule('agent memory', [{ id: 'e1', title: 'T', quote: 'q' }], 3);
  assert.ok(rule.length > 40 && !/阈值|评分/.test(rule));
  const empty = plainSummaryRule('x', [], 2);
  assert.match(empty, /没能抓到足够/);
});
