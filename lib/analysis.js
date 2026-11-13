/** LLM content analysis (CONTENT_ANALYSIS): structured JSON via ctx.llm.stream + hand-written validation. */

import { randomUUID } from 'node:crypto';
import { countDocsBetween, saveAnalysis } from './db.js';
import { localDayBounds, localParts } from './scheduler.js';
import { scoreDocument } from './report.js';
import { recordUsage, withinBudget, promptCharsOf } from './usage.js';

export const PROMPT_VERSION = 'analysis-v1';

/** Extract the outermost JSON object from model text (tolerates fences/prose). */
export function extractJson(text) {
  const s = String(text || '');
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
  const candidate = fence ? fence[1] : s;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Hand-written schema check for one analysis result. Returns error string or null. */
export function validateAnalysis(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 'not an object';
  const { summary, relevance, innovation } = obj;
  if (typeof summary !== 'string' || !summary.trim()) return 'summary must be a non-empty string';
  if ([...summary].length > 200) return 'summary too long (>200 chars)';
  const rel = Number(relevance);
  if (!Number.isFinite(rel) || rel < 0 || rel > 10) return 'relevance must be a number in [0,10]';
  if (!Array.isArray(innovation) || innovation.length === 0) return 'innovation must be a non-empty array';
  if (innovation.some((p) => typeof p !== 'string' || !p.trim())) return 'innovation points must be strings';
  return null;
}

/** Collect the stream into plain text (text-delta chunks only). */
export async function streamText(llm, options) {
  let text = '';
  for await (const chunk of llm.stream(options)) {
    if (chunk.type === 'text-delta') text += chunk.text;
    if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
      throw new Error(chunk.reason.failure?.message || 'llm stream finished with error');
    }
  }
  return text;
}

export function buildAnalysisMessages(doc) {
  const content = String(doc.raw_content || doc.summary || '').slice(0, 4000);
  const title = String(doc.title || '');
  const text =
    `请分析以下情报文档，只输出一个 JSON 对象，不要输出其它内容。\n` +
    `JSON 字段要求：summary（不超过120字的中文摘要）、relevance（0-10 的整数，与 AI 智能体/大模型主题的相关度）、innovation（字符串数组，2-3 条创新要点）。\n` +
    `标题：${title}\nURL：${doc.url}\n正文：\n${content}`;
  // Same shape as @deepseek-ai/dsh-llm's createUserMessage (id + role + content blocks + source),
  // built inline so lib/ keeps zero runtime dependency on the dsh-llm package in tests.
  return [
    {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'dsh-intelligence-hub' },
    },
  ];
}

/**
 * Analyze one document via ctx.llm.stream. One retry on invalid/failed output.
 * Returns the validated { summary, relevance, innovation } or throws.
 */
export async function analyzeDocument({ llm, provider, model, doc, signal, temperature = 0.2, maxTokens = 500, promptVersion = PROMPT_VERSION } = {}) {
  const messages = buildAnalysisMessages(doc);
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = await streamText(llm, {
        provider,
        model,
        messages,
        system: '你是严谨的情报分析助手，只输出符合 schema 的 JSON，不要包裹代码块以外的解释文字。',
        temperature,
        maxTokens,
        signal,
      });
      const obj = extractJson(text);
      const err = validateAnalysis(obj);
      if (err) {
        lastError = `invalid analysis output: ${err}`;
        continue;
      }
      return {
        summary: obj.summary.trim(),
        relevance: Number(obj.relevance),
        innovation: obj.innovation.map((p) => p.trim()),
        _raw: text,
        _attempts: attempt + 1,
      };
    } catch (err) {
      lastError = String(err.message || err);
    }
  }
  throw new Error(`analysis failed after retry: ${lastError}`);
}

/** Today's new docs ranked by heuristic score, unanalyzed only. */
export function selectDocsForAnalysis(db, { dateStr, timeZone = 'Asia/Shanghai', limit = 10, docIds } = {}) {
  if (Array.isArray(docIds)) {
    return docIds.map((id) => db.prepare('SELECT * FROM intel_documents WHERE id = ?').get(id)).filter(Boolean);
  }
  const { start, end } = localDayBounds(dateStr, timeZone);
  const rows = db
    .prepare('SELECT * FROM intel_documents WHERE fetched_at >= ? AND fetched_at < ? AND analysis IS NULL')
    .all(start, end);
  return rows
    .map((d) => ({ ...d, _score: scoreDocument(d) }))
    .sort((a, b) => b._score - a._score)
    .slice(0, Math.max(1, limit));
}

/**
 * Execute the CONTENT_ANALYSIS job for a day. Skips silently (no throw) when
 * provider/model are unconfigured or analysisEnabled=false.
 */
export async function runContentAnalysis(db, { llm, config, job, signal } = {}) {
  const provider = config?.analysisProvider;
  const model = config?.analysisModel;
  if (!config?.analysisEnabled || !provider || !model) {
    return { skipped: true, reason: 'analysis disabled or provider/model unconfigured' };
  }
  const dateStr = job?.runDate || localParts().date;
  const limit = Number(config.analysisMaxDocs) || 10;
  const docs = selectDocsForAnalysis(db, { dateStr, timeZone: config.reportTimeZone, limit });
  const analyzed = [];
  const failed = [];
  const budgetSkipped = [];
  for (const doc of docs) {
    // Daily token budget: skip the LLM (doc stays unanalyzed) once the budget is spent.
    if (!withinBudget(db, config, { timeZone: config.reportTimeZone }).allowed) {
      budgetSkipped.push({ id: doc.id, title: doc.title, reason: 'token budget exhausted' });
      continue;
    }
    try {
      const promptChars = promptCharsOf(buildAnalysisMessages(doc));
      const a = await analyzeDocument({ llm, provider, model, doc, signal });
      recordUsage(db, {
        call: 'content_analysis',
        promptChars,
        completionChars: String(a._raw || '').length,
        timeZone: config.reportTimeZone,
      });
      const analyzedAt = new Date().toISOString();
      saveAnalysis(db, doc.id, a, { model, promptVersion: PROMPT_VERSION, analyzedAt });
      analyzed.push({ id: doc.id, title: doc.title, relevance: a.relevance, attempts: a._attempts });
    } catch (err) {
      failed.push({ id: doc.id, error: String(err.message || err).slice(0, 300) });
    }
  }
  return { skipped: false, analyzed, failed, budget_skipped: budgetSkipped, selected: docs.length };
}
