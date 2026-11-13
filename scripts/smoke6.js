/**
 * Phase-6 real smoke test — reworked daily report + deep research against the REAL library:
 *   node scripts/smoke6.js
 *
 * 1. Copies the real intel.db to a temp dir (no mutation of the live db), runs the
 *    restructured generateDailyReport on today's real scores/events, prints real excerpts
 *    (top picks / further reading / watchlist / gaps).
 * 2. Creates a real intel_research task (depth=quick, local FTS evidence first; web search
 *    unavailable in this context -> non-fatal web_error, acceptable) through the durable
 *    queue, asserts terminal state COMPLETED and the report file on disk, prints real excerpts.
 * No install, no DSH runtime required.
 */

import { openDb, closeDb, getStats } from '../lib/db.js';
import { localDateString, enqueueJob, runDueJobs } from '../lib/scheduler.js';
import { generateDailyReport } from '../lib/report.js';
import { runPipeline } from '../lib/scoring.js';
import { createDeepResearchTask, runDeepResearchTask, getResearchTask } from '../lib/research.js';
import { defaultDbPath } from '../index.js';
import { mkdtempSync, cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const realDbPath = process.env.INTEL_DB || defaultDbPath();
if (!existsSync(realDbPath)) {
  console.error(`[smoke6] real db not found at ${realDbPath} (set INTEL_DB to override)`);
  process.exit(1);
}

// Work on a copy so the live db is never mutated (also lets us regenerate today's report in the new format).
const dir = mkdtempSync(path.join(tmpdir(), 'smoke6-'));
const dbPath = path.join(dir, 'copy.db');
cpSync(realDbPath, dbPath);
for (const ext of ['-wal', '-shm']) {
  if (existsSync(realDbPath + ext)) cpSync(realDbPath + ext, dbPath + ext);
}
console.log('[smoke6] real db:', realDbPath, '-> working copy:', dbPath);
const db = openDb(dbPath);
const reportsDir = path.join(dir, 'reports');
const timeZone = 'Asia/Shanghai';
const dateStr = localDateString(new Date(), timeZone);
const stats = getStats(db);
console.log('[smoke6] library stats:', JSON.stringify({ documents: stats.documents, sources: stats.sources, byType: stats.byType.map((t) => `${t.source_type}:${t.n}`).join(',') }));

// ---- Part 0: run the real scoring pipeline (L0 -> L3 + gate) over today's real documents
// (on the copy, rule scores, no LLM) so the report consumes genuine scores/events/deltas. ----
for (const phase of ['L0', 'FULL']) {
  const summary = await runPipeline(db, {
    phase,
    dateStr,
    timeZone,
    config: { analysisEnabled: false, scoreThresholds: { archive: 50, digest: 50, recommend: 70, research: 85 } },
  });
  console.log(`[smoke6] real pipeline ${phase}: clustered=${summary.clustered} scored=${summary.scored.length} candidates=${summary.candidates.length} events=${summary.events.length}`);
}

// ---- Part 1: restructured daily report on real scores/events ----
// If today's report already exists (old format from a previous plugin version), drop the copy's row
// so the reworked generator actually runs; the live db keeps its original report untouched.
const existing = db.prepare('SELECT id, report_date, LENGTH(body) AS len FROM intel_reports WHERE report_date = ?').get(dateStr);
if (existing) {
  console.log(`[smoke6] today's report exists in the copy (id=${existing.id}, ${existing.len} chars) — regenerating in the new format on the copy`);
  db.prepare('DELETE FROM intel_reports WHERE id = ?').run(existing.id);
}
const report = await generateDailyReport(db, { dateStr, timeZone, reportsDir, now: new Date() });
console.log(`[smoke6] report generated: created=${report.created} totalDocs=${report.totalDocs} scored=${report.scoredCount} picks=${report.picks.length} file=${report.filePath}`);
console.log('[smoke6] report head excerpt:');
console.log(report.markdown.split('\n').slice(0, 30).map((l) => '  | ' + l).join('\n'));
const okStructure = ['## 今日最值得关注', '## 延伸阅读', '## 值得追踪主题（WATCHLIST）', '## 探索性内容', '## 来源与信息缺口']
  .every((s) => report.markdown.includes(s));
console.log(`[smoke6] new structure sections present: ${okStructure}`);
if (!okStructure || !report.created || !existsSync(report.filePath)) {
  console.error('[smoke6] daily report check FAILED');
  process.exit(1);
}

// ---- Part 2: real deep research task (depth=quick, local-first) ----
// Pick a topic from a real document title (prefer a scored one) so local FTS has something to find.
const seed = db
  .prepare(
    `SELECT d.title, s.total FROM intel_documents d LEFT JOIN intel_scores s ON s.document_id = d.id
     WHERE d.title != '' ORDER BY (s.total IS NULL), s.total DESC, d.id DESC LIMIT 1`
  )
  .get();
const topicWords = String(seed?.title || 'agent memory')
  .split(/[^A-Za-z\u4e00-\u9fff]+/)
  .filter((w) => w.length >= 4 && !['your', 'this', 'that', 'with', 'from', 'what', 'when', 'how', 'can', '设计', '系统'].includes(w.toLowerCase()))
  .slice(0, 2)
  .join(' ');
const topic = topicWords || 'agent memory';
console.log(`[smoke6] research topic from real top-score doc "${String(seed?.title || '').slice(0, 70)}" -> "${topic}"`);

const created = createDeepResearchTask(db, { topic, depth: 'quick', maxSources: 4 }, { budgetPerDay: 3, timeZone });
console.log('[smoke6] task created:', JSON.stringify({ ok: created.ok, task_id: created.task_id, budget: created.budget, deduped: created.deduped, error: created.error || null }));
if (!created.ok) { console.error('[smoke6] task creation failed (budget?)'); process.exit(1); }
const taskId = created.task_id;
const job = enqueueJob(db, { kind: 'RESEARCH_TASK', runDate: `${dateStr}#${taskId}`, payload: { task_id: taskId }, maxAttempts: 3 });
console.log('[smoke6] job enqueued:', JSON.stringify(job));

// DAILY_REPORT + RESEARCH_TASK handlers (web capability unavailable in smoke -> local evidence only; non-fatal by design)
const handlers = {
  DAILY_REPORT: async () => ({ skipped: true, reason: 'report already generated directly in Part 1' }),
  RESEARCH_TASK: async (j) => runDeepResearchTask(db, j.payload.task_id, {
    webSearch: null, webFetch: null, llm: null, reportsDir, logger: console,
  }),
};
const results = await runDueJobs(db, handlers, { execTimeoutMs: 120000 });
console.log('[smoke6] queue run:', JSON.stringify(results.map((r) => ({ ok: r.ok, error: r.error || null, result: r.result }))));

const task = getResearchTask(db, taskId);
console.log(`[smoke6] task terminal state: ${task.status}`);
const result = JSON.parse(task.result_json || '{}');
console.log('[smoke6] token usage:', JSON.stringify(result.token_usage));
console.log(`[smoke6] web_error (expected, non-fatal): ${result.web_error}`);
const reportFile = path.join(reportsDir, 'research', `${taskId}.md`);
const fileOk = existsSync(reportFile);
console.log(`[smoke6] research report file on disk: ${reportFile} -> ${fileOk}`);
if (fileOk) {
  const md = readFileSync(reportFile, 'utf8');
  console.log('[smoke6] research report excerpt:');
  console.log(md.split('\n').slice(0, 20).map((l) => '  | ' + l).join('\n'));
}
const dailyFileOk = existsSync(path.join(reportsDir, `${dateStr}.md`));
console.log(`[smoke6] daily report file on disk: ${dailyFileOk}`);

const ok = task.status === 'COMPLETED' && fileOk && dailyFileOk && okStructure;
closeDb(db);
if (!ok) {
  console.error('[smoke6] FAILED');
  process.exit(1);
}
console.log('[smoke6] PASS — reworked daily report + real research task completed with report on disk.');
try { rmSync(dir, { recursive: true, force: true }); } catch {}
