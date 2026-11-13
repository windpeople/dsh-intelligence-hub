/**
 * Real smoke for the readable-report fixes (full intel_research):
 *   node scripts/smokeResearchPlain.js [topic]
 *
 * Real library db + real web (fetch provider dsh-web-fetch-http, search provider
 * dsh-web-search-deepseek via DEEPSEEK_API_KEY) + real ctx.llm
 * (zai-coding-cn / glm-5.3-flash, standalone cordis context as smoke3).
 * Prints the new「给你的摘要」section from the generated report.
 */
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import { apply as piAiApply, Config as PiConfig } from '@deepseek-ai/dsh-llm-pi-ai';
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local';
import WebRuntime from '@deepseek-ai/dsh-web';
import * as FetchHttp from '@deepseek-ai/dsh-web-fetch-http';
import * as SearchDeepseek from '@deepseek-ai/dsh-web-search-deepseek';

import { openDb, closeDb } from '../lib/db.js';
import { createDeepResearchTask, runDeepResearchTask } from '../lib/research.js';
import { defaultDbPath } from '../index.js';

const PROVIDER = 'zai-coding-cn';
const MODEL = 'glm-5.3-flash';

const dbPath = process.env.INTELHUB_DB || defaultDbPath();
console.log('[smokePlain] db:', dbPath);
const db = openDb(dbPath);

// Pick a watching candidate the reviewer dismissed/kept (nothing personal — just a topic).
const topic = process.argv[2]
  || db.prepare("SELECT topic FROM intel_research_candidates WHERE status = 'watching' ORDER BY id DESC LIMIT 1").get()?.topic
  || 'agent memory';
console.log('[smokePlain] topic:', topic);

console.log('[smokePlain] mounting standalone context (web + llm)...');
const ctx = new Context();
ctx.plugin(LocalCredentialProvider);
ctx.plugin(WebRuntime, {});
ctx.plugin(FetchHttp, {});
ctx.plugin(SearchDeepseek, { apiKeyEnv: 'DEEPSEEK_API_KEY' });
ctx.plugin(LlmRuntime);
ctx.plugin({ name: 'pi-ai-smoke', inject: ['llm'], apply: piAiApply, Config: PiConfig }, {
  providers: { [PROVIDER]: { apiKeyEnv: 'ZAI_CODING_CN_API_KEY' } },
});
await new Promise((r) => setTimeout(r, 800));

// Adapt the dsh-web seam to the plugin's Response-like fetch contract (same as index.js).
function responseLikeWebFetch(rawFetch) {
  if (typeof rawFetch !== 'function') return null;
  return async (url, init = {}) => {
    const r = await rawFetch({ url }, init?.signal);
    const kind = r?.body?.kind;
    const content = typeof r?.body?.content === 'string' ? r.body.content : '';
    return {
      ok: Number(r?.statusCode) >= 200 && Number(r?.statusCode) < 300,
      status: r?.statusCode,
      url: r?.url || url,
      truncated: !!r?.truncated,
      headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? 'text/html' : null) },
      text: async () => content,
      arrayBuffer: async () => new TextEncoder().encode(content).buffer,
    };
  };
}

// Budget override for smoke runs only (SMOKE_RESEARCH_BUDGET): the real config
// researchBudgetPerDay stays untouched; today's real budget may already be spent.
const smokeBudget = Number(process.env.SMOKE_RESEARCH_BUDGET) || 3;
const created = createDeepResearchTask(db, { topic, depth: 'standard' }, { budgetPerDay: smokeBudget });
if (!created.ok) {
  console.error('[smokePlain] task rejected:', JSON.stringify(created.error));
  closeDb(db);
  process.exit(1);
}
console.log('[smokePlain] task:', created.task_id, 'budget:', JSON.stringify(created.budget));

const r = await runDeepResearchTask(db, created.task_id, {
  config: {},
  webSearch: ctx.web?.search ? (request, signal) => ctx.web.search(request, signal) : null,
  webFetch: responseLikeWebFetch(ctx.web?.fetch),
  llm: ctx.llm,
  provider: PROVIDER,
  model: MODEL,
  reportsDir: null,
  logger: console,
});
console.log('[smokePlain] result:', JSON.stringify({ status: r.status, evidence_count: r.evidence_count, conflicts: r.conflicts, insufficient_data: r.insufficient_data, empty: r.empty }));

const result = JSON.parse(db.prepare('SELECT result_json FROM intel_research_tasks WHERE task_id = ?').get(created.task_id).result_json);
if (result.empty) {
  console.log('[smokePlain] EMPTY result as designed:', result.reason, '— 已转入观察，无报告文件');
} else {
  const md = result.report || '';
  const sec = /## 给你的摘要\n\n([\s\S]*?)\n\n/.exec(md);
  console.log('[smokePlain] 给你的摘要 (degraded=%s):', result.plain_summary_degraded);
  console.log('---');
  console.log(sec ? sec[1].trim() : result.plain_summary || '(missing)');
  console.log('---');
  console.log('[smokePlain] report head:\n', md.split('\n').slice(0, 18).join('\n'));
}

closeDb(db);
if (r.status !== 'COMPLETED') {
  console.error('[smokePlain] FAILED');
  process.exit(1);
}
console.log('[smokePlain] OK');
process.exit(0);
