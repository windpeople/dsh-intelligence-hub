/**
 * Real smoke for the agent-run research review (RESEARCH_REVIEW):
 *   node scripts/smokeReview.js
 *
 * Runs one review round against the REAL library db
 * (~/.dsh/plugins-data/dsh-intelligence-hub/intel.db) with the real
 * ctx.llm (provider zai-coding-cn / model glm-5.3-flash, standalone cordis
 * context built the same way as smoke3). Prints each candidate's real
 * decision + reason. Constrained by the real research budget
 * (researchBudgetPerDay, default 3) and token budget (tokenBudgetPerDay).
 */
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import { apply as piAiApply, Config as PiConfig } from '@deepseek-ai/dsh-llm-pi-ai';
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local';

import path from 'node:path';
import os from 'node:os';
import { openDb, closeDb } from '../lib/db.js';
import { runResearchReview, selectReviewCandidates } from '../lib/researchReview.js';
import { defaultDbPath } from '../index.js';

const PROVIDER = 'zai-coding-cn';
const MODEL = 'glm-5.3-flash';

const dbPath = process.env.INTELHUB_DB || defaultDbPath();
console.log('[smokeReview] db:', dbPath);
const db = openDb(dbPath);

const pool = selectReviewCandidates(db, { limit: 5 });
console.log('[smokeReview] candidate pool (%d):', pool.length);
for (const c of pool) {
  console.log('  - #%s [%s] %s (score=%s, doc=%s)', c.id, c.status, c.topic, c.score_total ?? '-', c.document_title || '-');
}
if (!pool.length) {
  console.log('[smokeReview] no candidates in pool — nothing to review');
  closeDb(db);
  process.exit(0);
}

console.log('[smokeReview] mounting standalone llm context (%s/%s)...', PROVIDER, MODEL);
const ctx = new Context();
ctx.plugin(LocalCredentialProvider);
ctx.plugin(LlmRuntime);
ctx.plugin({ name: 'pi-ai-smoke', inject: ['llm'], apply: piAiApply, Config: PiConfig }, {
  providers: { [PROVIDER]: { apiKeyEnv: 'ZAI_CODING_CN_API_KEY' } },
});
await new Promise((r) => setTimeout(r, 500));

const config = {
  reportTimeZone: 'Asia/Shanghai',
  analysisEnabled: true,
  analysisProvider: PROVIDER,
  analysisModel: MODEL,
  researchBudgetPerDay: 3,
  researchReviewBatch: 5,
  tokenBudgetPerDay: 0,
};
const r = await runResearchReview(db, { llm: ctx.llm, config });
console.log('[smokeReview] result:', JSON.stringify({
  skipped: r.skipped,
  reason: r.reason,
  enqueued: r.enqueued,
  dismissed: r.dismissed,
  deferred: r.deferred,
  failed: r.failed,
}, null, 1));
for (const x of r.reviewed || []) {
  console.log('  decision: #%s "%s" -> %s%s\n    reason: %s', x.id, x.topic, x.decision || x.action, x.refined_topic ? ` (refined: ${x.refined_topic})` : '', String(x.reason).slice(0, 200));
}
const statuses = db.prepare('SELECT topic, status, reason FROM intel_research_candidates ORDER BY id DESC LIMIT 10').all();
console.log('[smokeReview] candidate statuses after review:');
for (const s of statuses) console.log('  - [%s] %s | %s', s.status, s.topic, String(s.reason).slice(0, 120));
const usage = db.prepare("SELECT COUNT(*) AS n, SUM(prompt_chars) AS p, SUM(completion_chars) AS c FROM intel_usage WHERE call = 'research_review'").get();
console.log('[smokeReview] usage rows for research_review:', JSON.stringify(usage));

closeDb(db);
if (r.skipped) {
  console.error('[smokeReview] SKIPPED: %s', r.reason);
  process.exit(1);
}
console.log('[smokeReview] OK');
