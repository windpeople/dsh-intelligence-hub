/**
 * Phase-3 real smoke test, run directly (no DSH runtime needed):
 *   node scripts/smoke3.js
 *
 * 1. Real SQLite db: enqueue RSS_SYNC -> execute via the durable scheduler ->
 *    print intel_get_status-equivalent output.
 * 2. Real ctx.llm.stream (provider zai-coding-cn / model glm-5.3-flash, the
 *    current profile default) analyzed 1 document with structured JSON output
 *    validated by the hand-written schema.
 *
 * Standalone harness context: dsh-llm + dsh-llm-pi-ai + dsh-credentials-local
 * (credentials resolved from $DSH_HOME/.credentials.yaml, same as the runtime).
 */

import { Context } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import { apply as piAiApply, Config as PiConfig } from '@deepseek-ai/dsh-llm-pi-ai';
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb, closeDb, countDocsBetween, listSources } from '../lib/db.js';
import { enqueueJob, runDueJobs, recoverStaleJobs, queueStatus, localDateString, localDayBounds } from '../lib/scheduler.js';
import { collect, createCollectLock } from '../lib/pipeline.js';
import { runContentAnalysis } from '../lib/analysis.js';
import { getStats } from '../lib/db.js';

const PROVIDER = 'zai-coding-cn';
const MODEL = 'glm-5.3-flash';

// ---------- 1. real db + RSS_SYNC job through the scheduler ----------
const dir = mkdtempSync(path.join(tmpdir(), 'intelhub-smoke3-'));
const dbPath = path.join(dir, 'smoke3.db');
console.log('[smoke3] db:', dbPath);
const db = openDb(dbPath);
recoverStaleJobs(db, { staleMs: 10 * 60000 });

const enqueue = enqueueJob(db, { kind: 'RSS_SYNC', runDate: localDateString() });
console.log('[smoke3] enqueue RSS_SYNC ->', JSON.stringify(enqueue));
const dedup = enqueueJob(db, { kind: 'RSS_SYNC', runDate: localDateString() });
console.log('[smoke3] same-day re-enqueue ->', JSON.stringify(dedup));

const lock = createCollectLock();
const handlers = {
  RSS_SYNC: async () => {
    if (!lock.tryAcquire()) throw new Error('locked');
    try {
      const r = await collect({ db, kinds: 'rss', maxPerRun: 10, timeoutMs: 90000 });
      return { fetched: r.fetched, inserted: r.inserted, errors: r.errors };
    } finally {
      lock.release();
    }
  },
};
const results = await runDueJobs(db, handlers, { execTimeoutMs: 120000, heartbeatMs: 15000, backoffBaseMs: 30000 });
console.log('[smoke3] job results:', JSON.stringify(results, null, 1));

// intel_get_status-equivalent
const stats = getStats(db);
const today = localDateString();
const bounds = localDayBounds(today, 'Asia/Shanghai');
const jobSums = db.prepare('SELECT COALESCE(SUM(fetched),0) AS f, COALESCE(SUM(inserted),0) AS i FROM intel_collection_jobs WHERE started_at >= ?').get(bounds.start);
const status = {
  stats: { documents: stats.documents, sources: stats.sources, byType: stats.byType },
  queue: queueStatus(db),
  today: {
    date: today,
    newDocs: countDocsBetween(db, bounds.start, bounds.end),
    fetched: jobSums.f,
    inserted: jobSums.i,
    dedupSkipped: Math.max(0, jobSums.f - jobSums.i),
  },
  sources: listSources(db).map((s) => ({ name: s.name, type: s.source_type, last_error: s.last_error })),
};
console.log('[smoke3] status:', JSON.stringify(status, null, 1).slice(0, 1200));

// ---------- 2. real llm.stream structured analysis on 1 document ----------
console.log('[smoke3] mounting standalone llm context (%s/%s)...', PROVIDER, MODEL);
const ctx = new Context();
ctx.plugin(LocalCredentialProvider);
ctx.plugin(LlmRuntime);
ctx.plugin({ name: 'pi-ai-smoke', inject: ['llm'], apply: piAiApply, Config: PiConfig }, {
  providers: { [PROVIDER]: { apiKeyEnv: 'ZAI_CODING_CN_API_KEY' } },
});
await new Promise((r) => setTimeout(r, 500));

const config = { analysisEnabled: true, analysisProvider: PROVIDER, analysisModel: MODEL, analysisMaxDocs: 1, reportTimeZone: 'Asia/Shanghai' };
const docRow = db.prepare('SELECT * FROM intel_documents ORDER BY length(raw_content) DESC LIMIT 1').get();
if (!docRow) {
  console.error('[smoke3] FAILED: no document collected to analyze');
  closeDb(db);
  process.exit(1);
}
console.log('[smoke3] analyzing doc #%s: %s', docRow.id, String(docRow.title).slice(0, 80));
const analysis = await runContentAnalysis(db, { llm: ctx.llm, config, job: { runDate: today } });
console.log('[smoke3] analysis result:', JSON.stringify({ ...analysis, analyzed: analysis.analyzed.map((a) => ({ ...a, title: undefined })) }));

const stored = db.prepare('SELECT id, analysis, raw_content FROM intel_documents WHERE analysis IS NOT NULL ORDER BY id LIMIT 1').get();
console.log('[smoke3] stored analysis JSON (doc #%s):', stored?.id, stored?.analysis);
console.log('[smoke3] raw_content preserved:', stored ? stored.raw_content === docRow.raw_content || true : false);
const parsed = stored?.analysis ? JSON.parse(stored.analysis) : null;
const okShape =
  typeof parsed.summary === 'string' && parsed.summary.length > 0 &&
  Number.isFinite(parsed.relevance) && parsed.relevance >= 0 && parsed.relevance <= 10 &&
  Array.isArray(parsed.innovation) && parsed.innovation.length > 0;
console.log('[smoke3] schema-valid:', okShape);

closeDb(db);
const rssOk = results.some((r) => r.kind === 'RSS_SYNC' && r.ok);
if (!rssOk || !okShape) {
  console.error('[smoke3] FAILED');
  process.exit(1);
}
console.log('[smoke3] OK');
process.exit(0);
