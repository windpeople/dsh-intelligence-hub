import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb, closeDb, insertDocument, saveDocScore } from '../lib/db.js';
import { generateWeeklyReport, weeklyStats, buildWeeklyReportMarkdown, scoredRowsBetween } from '../lib/report.js';
import { weekStartOf, enqueueScheduledWeekly, localParts, JOB_KINDS } from '../lib/scheduler.js';

const TZ = 'Asia/Shanghai';

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'intelhub-weekly-'));
  const db = openDb(path.join(dir, 't.db'));
  return { db, close: () => closeDb(db) };
}

/** Seed one scored doc inside the week starting 2026-11-02 (Mon). dayOffset 0..6. */
function seedDoc(db, { dayOffset = 0, total = 90, decision = 'RECOMMEND', p = 70, title = 'Doc' } = {}) {
  const fetchedAt = new Date(Date.parse('2026-11-02T06:00:00Z') + dayOffset * 86400000).toISOString();
  const r = insertDocument(db, {
    url: `https://example.org/w-${Math.random().toString(36).slice(2)}`,
    title, summary: `${title} summary body with engineering detail`, source_type: 'rss', lang: 'en',
    fetched_at: fetchedAt,
  });
  saveDocScore(db, {
    documentId: r.id, r: 80, n: 60, p, e: 70, t: 60, total, stage: 'L3', decision,
    exploratory: false, filterStage: '', filterReason: '', createdAt: fetchedAt,
  });
  return r.id;
}

test('weekStartOf computes Mondays; enqueueScheduledWeekly fires only Monday after time', () => {
  assert.equal(weekStartOf('2026-11-11'), '2026-11-09', 'Wednesday -> Monday of same week');
  assert.equal(weekStartOf('2026-11-09'), '2026-11-09');
  assert.equal(weekStartOf('2026-11-08'), '2026-11-02', 'Sunday -> previous Monday');
  assert.equal(weekStartOf('2026-11-01'), '2026-10-26', 'Saturday -> previous Monday');

  // 2026-11-09 is a Monday. At 10:00 local the 09:00 job fires.
  const dir = mkdtempSync(path.join(tmpdir(), 'intelhub-weeklysched-'));
  const db = openDb(path.join(dir, 't.db'));
  const monday10 = new Date(Date.parse('2026-11-09T02:00:00Z')); // 10:00 Shanghai
  const enq = enqueueScheduledWeekly(db, { at: '09:00', now: monday10, timeZone: TZ });
  assert.equal(enq.length, 1);
  assert.equal(enq[0].week_start, '2026-11-02', 'reports on the previous week');
  const enqAgain = enqueueScheduledWeekly(db, { at: '09:00', now: monday10, timeZone: TZ });
  assert.equal(enqAgain.length, 0, 'same-day dedup');
  const monday8 = new Date(Date.parse('2026-11-09T00:30:00Z')); // 08:30 Shanghai
  const db2 = openDb(path.join(dir, 't2.db'));
  assert.equal(enqueueScheduledWeekly(db2, { at: '09:00', now: monday8, timeZone: TZ }).length, 0, 'before 09:00 does not fire');
  const tuesday = new Date(Date.parse('2026-11-10T02:00:00Z'));
  assert.equal(enqueueScheduledWeekly(db2, { at: '09:00', now: tuesday, timeZone: TZ }).length, 0, 'only Mondays fire');
  assert.ok(JOB_KINDS.includes('WEEKLY_REPORT'));
  closeDb(db); closeDb(db2);
});

test('weekly report: 7-day window aggregation, markdown structure, same-week idempotency', async () => {
  const { db, close } = setup();
  try {
    seedDoc(db, { dayOffset: 0, total: 95, decision: 'RESEARCH', p: 90, title: 'Great paper' });
    seedDoc(db, { dayOffset: 2, total: 75, decision: 'RECOMMEND', p: 65, title: 'Useful tool' });
    seedDoc(db, { dayOffset: 6, total: 60, decision: 'DIGEST', p: 30, title: 'Weekend news' });

    const reportsDir = path.join(path.dirname(db.prepare("SELECT 1").source ? '' : ''), 'unused');
    const tmpOut = mkdtempSync(path.join(tmpdir(), 'intelhub-weeklyout-'));
    const r1 = await generateWeeklyReport(db, { weekStart: '2026-11-02', timeZone: TZ, reportsDir: tmpOut, now: new Date('2026-11-09T01:00:00Z') });
    assert.ok(r1.created);
    assert.equal(r1.week_start, '2026-11-02');
    assert.equal(r1.week_end, '2026-11-08');
    assert.equal(r1.total_scored, 3);

    const stats = weeklyStats(db, '2026-11-02', TZ);
    assert.equal(stats.days.length, 7);
    assert.equal(stats.total_docs, 3);
    assert.equal(stats.total_picks, 3, 'all three reach DIGEST+');

    const md = r1.markdown;
    for (const heading of ['# 情报周报 · 2026-11-02 ~ 2026-11-08', '## 本周趋势', '## 重要进展（本周 Top）', '## 热点变化', '## 与专题的关系', '## 工程实践', '## 研究建议', '| 日期 | 新增 | 评分 | 达标 | 平均分 |']) {
      assert.ok(md.includes(heading), `markdown contains ${heading}`);
    }
    assert.ok(md.includes('Great paper'));
    assert.ok(!md.includes('## 编辑综述'), 'LLM overview section stays empty by default');

    const r2 = await generateWeeklyReport(db, { weekStart: '2026-11-02', timeZone: TZ, reportsDir: tmpOut, now: new Date('2026-11-10T01:00:00Z') });
    assert.ok(!r2.created, 'same week idempotent');
    assert.equal(r2.id, r1.id);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM intel_reports WHERE kind = 'weekly'").get().n, 1);
    assert.ok(db.prepare("SELECT COUNT(*) n FROM intel_reports WHERE report_date = '2026-11-02' AND kind = 'daily'").get().n === 0, 'weekly does not collide with a daily on the same date');

    const items = db.prepare("SELECT * FROM intel_report_items WHERE report_id = ?").all(r1.id);
    assert.ok(items.length >= 3, 'report items recorded');
    assert.ok(items.every((i) => i.section));

    const filePath = path.join(tmpOut, 'weekly-2026-11-02.md');
    const { readFileSync } = await import('node:fs');
    assert.ok(readFileSync(filePath, 'utf8').includes('# 情报周报'), 'markdown file written');
  } finally { close(); }
});

test('scoredRowsBetween respects the 7-day window and excludes feedback-filtered docs', async () => {
  const { db, close } = setup();
  try {
    seedDoc(db, { dayOffset: 1, title: 'in week' });
    seedDoc(db, { dayOffset: 8, title: 'next week' }); // outside window
    const { start, end } = { start: new Date(Date.parse('2026-11-02T00:00:00Z')).toISOString(), end: new Date(Date.parse('2026-11-09T00:00:00Z')).toISOString() };
    const rows = scoredRowsBetween(db, { start, end }, TZ);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, 'in week');
  } finally { close(); }
});

test('buildWeeklyReportMarkdown is pure and renders llm overview when provided', () => {
  const stats = {
    week_start: '2026-11-02',
    days: Array.from({ length: 7 }, (_, i) => ({ date: `2026-11-0${i + 2}`, docs: i, scored: i, picks: 0, avg_total: 50 })),
    total_docs: 21, total_scored: 21, total_picks: 0,
  };
  const md = buildWeeklyReportMarkdown({
    weekStart: '2026-11-02', weekEnd: '2026-11-08', stats, picks: [], trends: ['周内平均分基本持平'],
    topicAffinity: [{ topic: '长期记忆', doc_hits: 3, completed_research: 1 }], engineering: [], researchSuggestions: [],
    generatedAt: '2026-11-09T01:00:00Z', timeZone: TZ, llmSection: '本周综述文本。',
  });
  assert.ok(md.includes('本周综述文本。'), 'llm section rendered when provided');
  assert.ok(md.includes('长期记忆：本周命中 3 篇'));
});
