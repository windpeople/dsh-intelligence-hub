import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, closeDb, insertDocument, saveAnalysis } from '../lib/db.js';
import {
  extractJson, validateAnalysis, buildAnalysisMessages, analyzeDocument, selectDocsForAnalysis, PROMPT_VERSION,
} from '../lib/analysis.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function makeDb() {
  const dir = mkdtempSync(path.join(tmpdir(), 'intelhub-an-'));
  return openDb(path.join(dir, 'test.db'));
}

/** Fake ctx.llm.stream: canned responses queue; records call options. */
function fakeLlm(responses, record = []) {
  return {
    async *stream(options) {
      record.push(options);
      const text = responses.shift();
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
}

const GOOD_JSON = '{"summary":"这是一个不超过一百二十字的中文摘要，描述了某个智能体框架的发布要点与记忆能力。","relevance":8,"innovation":["记忆增强","工具调用编排"]}';
const WRAPPED = `好的，以下是分析结果：\n\`\`\`json\n${GOOD_JSON}\n\`\`\`\n以上。`;

test('extractJson handles plain, fenced, and prose-wrapped output', () => {
  assert.deepEqual(extractJson(GOOD_JSON), JSON.parse(GOOD_JSON));
  assert.deepEqual(extractJson(WRAPPED), JSON.parse(GOOD_JSON));
  assert.equal(extractJson('no json here'), null);
  assert.equal(extractJson('{"broken": '), null);
});

test('validateAnalysis enforces the schema', () => {
  const ok = JSON.parse(GOOD_JSON);
  assert.equal(validateAnalysis(ok), null);
  assert.match(validateAnalysis(null), /not an object/);
  assert.match(validateAnalysis({ ...ok, summary: '' }), /summary/);
  assert.match(validateAnalysis({ ...ok, relevance: 11 }), /relevance/);
  assert.match(validateAnalysis({ ...ok, relevance: 'high' }), /relevance/);
  assert.match(validateAnalysis({ ...ok, innovation: [] }), /innovation/);
  assert.match(validateAnalysis({ ...ok, innovation: ['ok', 3] }), /innovation/);
});

test('analyzeDocument succeeds on valid output; message carries title/url/content', async () => {
  const calls = [];
  const llm = fakeLlm([WRAPPED], calls);
  const doc = { id: 1, title: 'Agent framework', url: 'https://e.com/1', raw_content: 'body text' };
  const a = await analyzeDocument({ llm, provider: 'p', model: 'm', doc });
  assert.equal(a.summary, JSON.parse(GOOD_JSON).summary);
  assert.equal(a.relevance, 8);
  assert.equal(a.innovation.length, 2);
  assert.equal(a._attempts, 1);
  assert.equal(calls[0].provider, 'p');
  assert.equal(calls[0].model, 'm');
  const text = calls[0].messages[0].content[0].text;
  assert.match(text, /Agent framework/);
  assert.match(text, /https:\/\/e\.com\/1/);
  assert.match(text, /body text/);
  assert.ok(typeof calls[0].maxTokens === 'number');
});

test('analyzeDocument retries once on invalid output then throws', async () => {
  const calls = [];
  const llm = fakeLlm(['not json at all', '{"summary":"s","relevance":5,"innovation":["x"]}'], calls);
  const a = await analyzeDocument({ llm, provider: 'p', model: 'm', doc: { title: 't', url: 'u', raw_content: 'c' } });
  assert.equal(calls.length, 2, 'one retry after invalid output');
  assert.equal(a._attempts, 2);
  const llm2 = fakeLlm(['bad', 'still bad']);
  await assert.rejects(() => analyzeDocument({ llm: llm2, provider: 'p', model: 'm', doc: { title: 't', url: 'u', raw_content: 'c' } }), /after retry/);
});

test('saveAnalysis preserves raw_content and stores metadata', () => {
  const db = makeDb();
  const r = insertDocument(db, { url: 'https://e.com/9', title: 'T', summary: 'S', raw_content: 'RAW-BODY', source_type: 'rss' });
  saveAnalysis(db, r.id, { summary: 's', relevance: 7, innovation: ['i'] }, { model: 'glm', promptVersion: PROMPT_VERSION });
  const row = db.prepare('SELECT * FROM intel_documents WHERE id=?').get(r.id);
  assert.equal(row.raw_content, 'RAW-BODY');
  const a = JSON.parse(row.analysis);
  assert.equal(a.model, 'glm');
  assert.equal(a.promptVersion, PROMPT_VERSION);
  assert.ok(a.analyzedAt);
  closeDb(db);
});

test('selectDocsForAnalysis ranks by heuristic score and skips analyzed docs', () => {
  const db = makeDb();
  insertDocument(db, { url: 'https://e.com/1', title: 'big agent release with memory framework', summary: 'long '.repeat(200), source_type: 'rss', topic: 'ai-agents', fetched_at: '2026-11-05T03:00:00.000Z' });
  insertDocument(db, { url: 'https://e.com/2', title: 'tiny', summary: 'x', source_type: 'rss', fetched_at: '2026-11-05T04:00:00.000Z' });
  insertDocument(db, { url: 'https://e.com/3', title: 'analyzed one', summary: 'long '.repeat(100), source_type: 'rss', fetched_at: '2026-11-05T05:00:00.000Z' });
  const second = db.prepare("SELECT id FROM intel_documents WHERE url LIKE '%/3'").get();
  saveAnalysis(db, second.id, { summary: 's', relevance: 5, innovation: ['i'] }, {});
  const picked = selectDocsForAnalysis(db, { dateStr: '2026-11-05', limit: 10 });
  assert.equal(picked.length, 2, 'analyzed doc excluded');
  assert.equal(picked[0].url, 'https://e.com/1', 'higher score first');
  closeDb(db);
});
