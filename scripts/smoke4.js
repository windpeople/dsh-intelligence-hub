/**
 * Phase-4 real smoke test — run directly against the REAL intelligence hub db:
 *   node scripts/smoke4.js
 *
 * Runs one full PIPELINE_RUN (L0 -> L3 + Research Gate) over today's real
 * documents, prints per-document scores and gate decisions, event clusters,
 * and at least one recommendation with its matching reason. No install, no
 * DSH runtime required (LLM optional; gray-zone docs fall back to rule scores
 * without a provider).
 */

import { openDb, closeDb, getStats } from '../lib/db.js';
import { localDateString, localDayBounds, enqueueJob, runDueJobs } from '../lib/scheduler.js';
import { runPipeline } from '../lib/scoring.js';
import { defaultDbPath } from '../index.js';
import { existsSync } from 'node:fs';

const dbPath = process.env.INTEL_DB || defaultDbPath();
if (!existsSync(dbPath)) {
  console.error(`[smoke4] real db not found at ${dbPath} (set INTEL_DB to override)`);
  process.exit(1);
}
console.log('[smoke4] using real db:', dbPath);
const db = openDb(dbPath);
const stats = getStats(db);
console.log('[smoke4] library stats:', JSON.stringify({ documents: stats.documents, sources: stats.sources, byType: stats.byType }));

const timeZone = 'Asia/Shanghai';
const dateStr = localDateString(new Date(), timeZone);
const { start, end } = localDayBounds(dateStr, timeZone);
console.log(`[smoke4] day ${dateStr} bounds ${start} .. ${end}`);

// ---- Phase A: L0 + clustering through the durable queue (idempotent kind+slot) ----
const enqueueA = enqueueJob(db, { kind: 'PIPELINE_RUN', runDate: `${dateStr}#1000`, payload: { phase: 'L0', dateStr } });
console.log('[smoke4] enqueue L0 slot ->', JSON.stringify(enqueueA));
const enqueueAgain = enqueueJob(db, { kind: 'PIPELINE_RUN', runDate: `${dateStr}#1000`, payload: { phase: 'L0', dateStr } });
console.log('[smoke4] re-enqueue same slot (idempotency) ->', JSON.stringify(enqueueAgain));

const handlers = {
  PIPELINE_RUN: async (job) => runPipeline(db, {
    phase: job.payload?.phase || 'FULL',
    dateStr: job.run_date.split('#')[0],
    timeZone,
    config: { analysisEnabled: false, scoreThresholds: { archive: 50, digest: 50, recommend: 70, research: 85 } },
  }),
};
const runA = await runDueJobs(db, handlers, { execTimeoutMs: 120000 });
console.log('[smoke4] L0 job:', JSON.stringify(runA.map((r) => ({ ok: r.ok, result: r.result, error: r.error }))));

// ---- Phase B: L1-L3 + Gate ----
const enqueueB = enqueueJob(db, { kind: 'PIPELINE_RUN', runDate: `${dateStr}#1200`, payload: { phase: 'FULL', dateStr } });
console.log('[smoke4] enqueue FULL slot ->', JSON.stringify(enqueueB));
const runB = await runDueJobs(db, handlers, { execTimeoutMs: 120000 });
const summary = runB[0]?.result || {};
console.log('[smoke4] FULL job:', JSON.stringify({ ok: runB[0]?.ok, scored: summary.scored?.length, candidates: summary.candidates?.length, events: summary.events?.length, error: runB[0]?.error }));

// ---- Per-document L0 -> L3 ----
const rows = db
  .prepare(
    `SELECT d.id, d.title, d.source_type, s.r, s.n, s.p, s.e, s.t, s.total, s.decision, s.exploratory,
            json_extract(d.meta, '$.filter_stage') AS filter_stage,
            json_extract(d.meta, '$.filter_reason') AS filter_reason
     FROM intel_documents d LEFT JOIN intel_scores s ON s.document_id = d.id
     WHERE d.fetched_at >= ? AND d.fetched_at < ? ORDER BY s.total DESC`
  )
  .all(start, end);
console.log(`\n[smoke4] per-document pipeline results (${rows.length} docs):`);
for (const r of rows.slice(0, 25)) {
  const line = r.total === null
    ? `  #${r.id} [${r.source_type}] "${String(r.title).slice(0, 60)}" — L0:${r.filter_stage || '-'}${r.filter_reason ? `(${r.filter_reason})` : ''} 未打分`
    : `  #${r.id} [${r.source_type}] "${String(r.title).slice(0, 60)}" R=${r.r} N=${r.n} P=${r.p} E=${r.e} T=${r.t} → V=${r.total} ${r.decision}${r.exploratory ? ' (exploratory)' : ''}`;
  console.log(line);
}

// ---- Gate candidates ----
const cands = db.prepare('SELECT topic, decision, reason FROM intel_research_candidates ORDER BY id DESC LIMIT 5').all();
console.log('\n[smoke4] research gate candidates:');
for (const c of cands) console.log(`  [${c.decision}] ${String(c.topic).slice(0, 60)} — ${String(c.reason).slice(0, 110)}`);

// ---- Event clusters ----
const events = db
  .prepare(
    `SELECT e.event_id, e.event_title, e.primary_source, COUNT(de.document_id) AS docs,
            SUM(de.is_primary) AS primaries
     FROM intel_events e JOIN intel_document_events de ON de.event_id = e.event_id
     GROUP BY e.event_id ORDER BY e.first_seen_at DESC LIMIT 10`
  )
  .all();
console.log(`\n[smoke4] event clusters (${events.length} shown):`);
for (const ev of events) console.log(`  ${ev.event_id} [${ev.primary_source}] docs=${ev.docs} primary=${ev.primaries} "${String(ev.event_title).slice(0, 70)}"`);

// ---- At least one recommendation with reason ----
const scoredRows = db
  .prepare(
    `SELECT s.total, s.decision, s.n, d.title, d.url FROM intel_scores s JOIN intel_documents d ON d.id = s.document_id
     WHERE s.total >= 50 ORDER BY s.total DESC LIMIT 1`
  )
  .get();
const delta = scoredRows
  ? db.prepare('SELECT scores_json, new_findings FROM intel_knowledge_deltas WHERE document_id = (SELECT document_id FROM intel_scores WHERE total = ? LIMIT 1)').get(scoredRows.total)
  : null;
console.log('\n[smoke4] recommendation example:');
if (scoredRows) {
  console.log(`  推荐 [${scoredRows.decision} V=${scoredRows.total}] ${String(scoredRows.title).slice(0, 80)}`);
  console.log(`  URL: ${scoredRows.url}`);
  if (delta) {
    const sc = JSON.parse(delta.scores_json || '{}');
    console.log(`  依据: 相关度 R=${sc.r}, 新颖度 N=${scoredRows.n}, 实践 P=${sc.p}, 证据 E=${sc.e}, 时效 T=${sc.t}`);
    const findings = JSON.parse(delta.new_findings || '[]');
    if (findings.length) console.log(`  新发现: ${findings[0]}`);
  }
} else {
  console.log('  当日无 V>=50 的推荐（均为低分或被 L0 过滤）');
}

const ok = runA.every((r) => r.ok) && runB.every((r) => r.ok);
closeDb(db);
console.log(ok ? '[smoke4] OK' : '[smoke4] FAILED');
process.exit(ok ? 0 : 1);
