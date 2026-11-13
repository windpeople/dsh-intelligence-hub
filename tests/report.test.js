import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, closeDb, insertDocument, saveDocScore, saveKnowledgeDelta } from '../lib/db.js';
import { generateDailyReport, buildDailyReportMarkdown, scoreDocument, suggestAction, validateWhyWatch } from '../lib/report.js';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function tempDb() {
  const dir = mkdtempSync(path.join(tmpdir(), 'intelhub-report-'));
  const dbPath = path.join(dir, 'test.db');
  return { db: openDb(dbPath), dbPath };
}

const DAY = '2026-11-05';

function seedScored(db, { pickCount = 3, exploratory = false } = {}) {
  const specs = [
    { url: `https://example.com/agent-cn`, title: '全新开源智能体框架发布，支持记忆与工具调用', summary: '一个面向 AI agents 的开源框架，集成记忆与 MCP 工具调用。'.repeat(3), source_type: 'rss', total: 82, decision: 'RESEARCH', findings: ['[content] 支持长程记忆检索与压缩'] },
    { url: 'https://example.org/llm-en', title: 'CompressionBench: benchmarking context memory for agents', summary: 'A benchmark for context memory compression in long-running agents.', source_type: 'arxiv', total: 76, decision: 'RECOMMEND', findings: ['[analysis] first public benchmark for memory compression'] },
    { url: 'https://example.net/mcp', title: 'MCP tool registry goes GA with function calling', summary: 'The model context protocol registry ships GA.', source_type: 'github', total: 71, decision: 'RECOMMEND', findings: ['[content] registry GA'] },
    { url: 'https://example.io/rag', title: 'Hybrid search reranker for RAG pipelines', summary: 'A reranker mixing vector and keyword retrieval.', source_type: 'rss', total: 64, decision: 'DIGEST', findings: [] },
    { url: 'https://example.dev/low', title: 'minor bugfix release', summary: 'patch notes only', source_type: 'rss', total: 30, decision: 'ARCHIVE', findings: [] },
  ];
  const ids = [];
  for (const s of specs.slice(0, pickCount === 'all' ? 5 : pickCount + 1)) {
    const r = insertDocument(db, {
      url: s.url, title: s.title, summary: s.summary, source_type: s.source_type, lang: 'en', topic: 'ai-agents',
      published_at: `${DAY}T02:00:00.000Z`, fetched_at: `${DAY}T03:10:00.000Z`,
    });
    const id = r.id;
    ids.push(id);
    saveDocScore(db, {
      documentId: id, r: 60, n: 60, p: 50, e: 70, t: 80, total: s.total, stage: 'L3',
      decision: s.decision, exploratory: s.decision === 'ARCHIVE' ? exploratory : false,
      createdAt: `${DAY}T04:00:00.000Z`,
    });
    saveKnowledgeDelta(db, {
      documentId: id, noveltyScore: 60, noveltyState: 'PARTIAL',
      newFindings: s.findings, evidenceIds: [], createdAt: `${DAY}T04:00:00.000Z`,
    });
  }
  return ids;
}

test('scoreDocument ranks substance over noise', () => {
  const good = scoreDocument({ raw_content: 'a'.repeat(2000), title: 'Agent framework release with memory', topic: 'ai-agents', published_at: '2026-11-05T00:00:00Z' });
  const bad = scoreDocument({ raw_content: 'x', title: 'hi', topic: 'general', published_at: null });
  assert.ok(good > bad);
  assert.ok(good <= 10);
});

test('buildDailyReportMarkdown structure: top picks, further reading, watchlist, exploratory, gaps', () => {
  const mk = (o) => ({ event_id: null, event_title: '', new_findings: [], matched_projects: [], matched_problems: [], matched_goals: [], ...o });
  const md = buildDailyReportMarkdown({
    dateStr: DAY,
    picks: [
      mk({ id: 1, title: 'A[d]', url: 'https://e.com/1', published_at: `${DAY}T02:00:00.000Z`, fetched_at: `${DAY}T03:10:00.000Z`, source_type: 'rss', r: 60, n: 70, p: 50, e: 80, t: 80, total: 72, why_watch: '命中兴趣且新颖度高', action: '精读', enhanced_by: 'rule' }),
    ],
    furtherReading: [{ id: 2, title: 'B', url: 'https://e.com/2', published_at: `${DAY}T01:00:00.000Z`, fetched_at: `${DAY}T03:20:00.000Z`, total: 65, decision: 'DIGEST', event_id: 'evt_x', summary: 'snippet' }],
    watchlist: [{ topic: 'memory compression', decision: 'WATCHLIST', status: 'watching', reason: '证据不足' }],
    exploratory: [{ id: 3, title: 'C', url: 'https://e.com/3', fetched_at: `${DAY}T05:00:00.000Z`, total: 20 }],
    failedSources: [{ name: '量子位', source_type: 'rss', last_error: 'HTTP 503' }],
    gaps: ['A2A'],
    generatedAt: `${DAY}T10:00:00.000Z`,
    totalDocs: 3,
    scoredCount: 3,
  });
  assert.match(md, /# 情报日报 · 2026-11-05/);
  assert.match(md, /## 今日最值得关注/);
  assert.match(md, /\[Ad\]\(https:\/\/e\.com\/1\)/, 'source link present');
  assert.match(md, /发布 2026-11-05T02:00:00\.000Z/, 'publish time shown');
  assert.match(md, /发现 2026-11-05T03:10:00\.000Z/, 'discovery time distinct');
  assert.match(md, /为什么值得关注.*命中兴趣且新颖度高/);
  assert.match(md, /相比已有知识新增/);
  assert.match(md, /与当前项目关系/);
  assert.match(md, /可操作建议.*精读/);
  assert.match(md, /## 延伸阅读/);
  assert.match(md, /\[B\]\(https:\/\/e\.com\/2\)/);
  assert.match(md, /## 值得追踪主题（WATCHLIST）/);
  assert.match(md, /memory compression/);
  assert.match(md, /## 探索性内容/);
  assert.match(md, /## 来源与信息缺口/);
  assert.match(md, /来源失败：量子位.*HTTP 503/);
  assert.match(md, /无覆盖主题：A2A/);
});

test('generateDailyReport: one primary pick per event, idempotent, writes file, backward-compatible fields', async () => {
  const { db, dbPath } = tempDb();
  const reportsDir = path.join(path.dirname(dbPath), 'reports');
  const ids = seedScored(db);
  const now = new Date('2026-11-05T10:30:00Z');
  const r1 = await generateDailyReport(db, { dateStr: DAY, reportsDir, now, timeZone: 'Asia/Shanghai' });
  assert.ok(r1.created);
  assert.equal(r1.totalDocs, 4);
  assert.ok(r1.picks.length <= 3);
  assert.ok(['created', 'id', 'markdown', 'date', 'filePath', 'totalDocs'].every((k) => k in r1), 'legacy fields kept');
  // top picks must be the highest-total non-archive docs (one per event; each doc its own event here)
  assert.deepEqual(r1.picks.map((p) => p.total), [82, 76, 71]);
  const r2 = await generateDailyReport(db, { dateStr: DAY, reportsDir, now, timeZone: 'Asia/Shanghai' });
  assert.ok(!r2.created, 'same-day report must be idempotent');
  assert.equal(r2.markdown, r1.markdown);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM intel_reports').get().n, 1);
  assert.ok(existsSync(path.join(reportsDir, `${DAY}.md`)), 'report .md file written');
  const md = r1.markdown;
  assert.match(md, /## 今日最值得关注/);
  assert.match(md, /CompressionBench/);
  assert.ok(!/### 4\./.test(md), 'at most 3 picks');
  closeDb(db);
});

test('fewer than 3 qualifying events: report states the gap instead of padding', async () => {
  const { db, dbPath } = tempDb();
  seedScored(db, { pickCount: 1 }); // 1 RESEARCH + 1 RECOMMEND -> only 2 qualifying events
  const r = await generateDailyReport(db, { dateStr: DAY, timeZone: 'Asia/Shanghai' });
  assert.ok(r.picks.length < 3);
  assert.match(r.markdown, /今日高分事件仅 2 条（目标 3 条，缺 1 条）/, 'gap explanation present');
  closeDb(db);
});

test('no qualifying docs: explicit empty-state, no fabricated picks', async () => {
  const { db } = tempDb();
  const r = await generateDailyReport(db, { dateStr: DAY, timeZone: 'Asia/Shanghai' });
  assert.equal(r.picks.length, 0);
  assert.match(r.markdown, /今日无达到推荐线/);
  closeDb(db);
});

test('report excludes documents from other days and surfaces exploratory + gaps sections', async () => {
  const { db } = tempDb();
  seedScored(db, { pickCount: 'all', exploratory: true });
  insertDocument(db, { url: 'https://late.com/x', title: 'late doc', summary: 's', source_type: 'rss', fetched_at: '2026-11-06T01:00:00.000Z' });
  const r = await generateDailyReport(db, { dateStr: DAY, timeZone: 'Asia/Shanghai' });
  assert.equal(r.totalDocs, 5);
  assert.ok(!r.markdown.includes('late doc'));
  assert.match(r.markdown, /## 探索性内容/);
  assert.match(r.markdown, /探索性采样/);
  closeDb(db);
});

test('suggestAction + validateWhyWatch rules', () => {
  assert.match(suggestAction({ source_type: 'github', url: 'https://github.com/a/b' }), /clone/);
  assert.match(suggestAction({ source_type: 'arxiv', url: 'https://arxiv.org/abs/1' }), /论文/);
  assert.match(suggestAction({ source_type: 'rss', url: '', p: 60 }), /动手/);
  assert.equal(validateWhyWatch({ why_watch: '这段理由足够长，能作为关注理由使用。' }), null);
  assert.ok(validateWhyWatch({ why_watch: '短' }));
  assert.ok(validateWhyWatch(null));
});
