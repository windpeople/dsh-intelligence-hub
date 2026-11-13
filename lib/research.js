/** Deep research tasks (kind='research' rows in intel_research_tasks, v5).
 *  Pipeline: CREATED -> COLLECTING (local FTS + web search) -> ANALYZING (fetch full text,
 *  budget-bounded) -> VERIFYING (evidence extraction + conflict detection) -> WRITING
 *  (LLM report with structured validation, rule fallback) -> COMPLETED / FAILED.
 *  Fully async inside the scheduler's serial queue; checkpoint makes retries skip finished phases.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { searchDocuments } from './db.js';
import { localDayBounds, localDateString } from './scheduler.js';
import { createFetcher } from './http.js';
import { extractJson, streamText } from './analysis.js';
import { maybeDiscover } from './discovery.js';
import { arxivIdParts } from './adapters/arxiv.js';

export const RESEARCH_KIND = 'research';
export const DEPTHS = ['quick', 'standard', 'deep'];
const MAX_FETCH_CHARS = 20000;
const FETCH_TIMEOUT_MS = 20000;
const STOP_TOKENS = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', '模型', '研究', '论文', '方法', '系统', '一个', '基于', '我们']);

const nowIso = () => new Date().toISOString();

export function getResearchTask(db, taskId) {
  return db.prepare('SELECT * FROM intel_research_tasks WHERE task_id = ? AND kind = ?').get(String(taskId), RESEARCH_KIND) || null;
}

/** Daily budget: number of research tasks created today (local calendar day). */
export function researchTasksCreatedToday(db, { timeZone = 'Asia/Shanghai', now = new Date() } = {}) {
  const dateStr = localDateString(now, timeZone);
  const { start, end } = localDayBounds(dateStr, timeZone);
  return db
    .prepare('SELECT COUNT(*) AS n FROM intel_research_tasks WHERE kind = ? AND created_at >= ? AND created_at < ?')
    .get(RESEARCH_KIND, start, end).n;
}

/**
 * Create a RESEARCH task. Budget: at most budgetPerDay per local day (default 3);
 * dedup: an active (non-terminal) task with the same topic returns { deduped: true }.
 */
export function createDeepResearchTask(db, { topic, depth = 'standard', maxSources, timeRange } = {}, {
  budgetPerDay = 3, timeZone = 'Asia/Shanghai', now = new Date(),
} = {}) {
  const t = String(topic || '').trim();
  if (!t) return { ok: false, error: { code: 'INVALID_TOPIC', message: 'topic is required' } };
  if (!DEPTHS.includes(depth)) return { ok: false, error: { code: 'INVALID_DEPTH', message: `depth must be one of ${DEPTHS.join('|')}` } };
  const active = db
    .prepare("SELECT task_id, status FROM intel_research_tasks WHERE kind = ? AND repo = ? AND status IN ('CREATED','COLLECTING','ANALYZING','VERIFYING','WRITING') LIMIT 1")
    .get(RESEARCH_KIND, t);
  if (active) return { ok: true, deduped: true, reason: `an active research task already exists for "${t}"`, task_id: active.task_id, status: active.status };
  const createdToday = researchTasksCreatedToday(db, { timeZone, now });
  if (createdToday >= budgetPerDay) {
    return { ok: false, budgeted: true, error: { code: 'BUDGET_EXCEEDED', message: `daily research budget reached (${createdToday}/${budgetPerDay} tasks today); try again tomorrow` } };
  }
  const taskId = `dr-${randomUUID().slice(0, 12)}`;
  const defaults = { quick: 4, standard: 8, deep: 12 };
  db.prepare(
    `INSERT INTO intel_research_tasks (task_id, kind, repo, status, checkpoint_json, retry_count, created_at, updated_at)
     VALUES (?, ?, ?, 'CREATED', '{}', 0, ?, ?)`
  ).run(taskId, RESEARCH_KIND, t, nowIso(), nowIso());
  return {
    ok: true, deduped: false, task_id: taskId, topic: t, depth,
    max_sources: Math.max(1, Math.min(Number(maxSources) || defaults[depth], 20)),
    time_range: Number(timeRange) || null,
    budget: { used: createdToday + 1, perDay: budgetPerDay },
  };
}

function setCheckpoint(db, taskId, { status, checkpoint, error } = {}) {
  db.prepare(
    'UPDATE intel_research_tasks SET status = ?, checkpoint_json = ?, error = ?, updated_at = ? WHERE task_id = ?'
  ).run(status, JSON.stringify(checkpoint || {}), error ?? null, nowIso(), taskId);
}

function loadCheckpoint(task) {
  try { return JSON.parse(task.checkpoint_json || '{}'); } catch { return {}; }
}

/** Significant tokens of a text (len>3 / CJK bigrams simplified: keep CJK words len>=2). */
export function significantTokens(text) {
  const words = String(text || '').toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter((w) => w.length > 3 && !STOP_TOKENS.has(w));
  const cjk = String(text || '').match(/[\u4e00-\u9fff]{2,6}/g) || [];
  return [...new Set([...words, ...cjk.filter((w) => !STOP_TOKENS.has(w))])];
}

function tokenSet(text) {
  return new Set(significantTokens(text));
}

function setJaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function hostOf(url) {
  try { return new URL(url).host.toLowerCase(); } catch { return ''; }
}

/** Best evidence quote: sentences containing topic/source keywords, else head of content. */
export function extractQuote(content, keywords, maxLen = 240) {
  const text = String(content || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const sentences = text.split(/(?<=[。.!?！？])\s*/).filter((s) => s.length > 15);
  const kw = keywords.map((k) => k.toLowerCase());
  const hit = sentences.find((s) => kw.some((k) => s.toLowerCase().includes(k)));
  return String(hit || sentences[0] || text).slice(0, maxLen);
}

/**
 * Conflict detection: two evidences from different hosts covering the same subtopic
 * (≥1 shared significant token) whose quotes barely overlap (Jaccard < 0.2) are flagged
 * as conflicting sources. Rule-based annotation only — never presented as verified fact.
 */
export function detectConflicts(evidences) {
  const conflicts = [];
  for (let i = 0; i < evidences.length; i++) {
    for (let j = i + 1; j < evidences.length; j++) {
      const a = evidences[i];
      const b = evidences[j];
      if (!a.quote || !b.quote || hostOf(a.url) === hostOf(b.url)) continue;
      const ta = tokenSet(a.quote);
      const tb = tokenSet(b.quote);
      const shared = [...ta].filter((t) => tb.has(t));
      if (shared.length === 0) continue;
      const ov = setJaccard(ta, tb);
      if (ov < 0.2) {
        conflicts.push({
          subtopic: shared[0],
          sources: [a.url, b.url],
          evidence_ids: [a.id, b.id],
          note: `来源 ${hostOf(a.url)} 与 ${hostOf(b.url)} 就子话题 "${shared[0]}" 表述差异明显（内容重合度 ${(ov * 100).toFixed(0)}%），需人工核实。`,
        });
      }
    }
  }
  return conflicts.slice(0, 5);
}

/** Structured validation for the LLM research report body. */
export function validateResearchReport(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 'not an object';
  if (typeof obj.summary !== 'string' || obj.summary.trim().length < 20) return 'summary must be a non-trivial string';
  if (!Array.isArray(obj.key_points) || obj.key_points.length === 0) return 'key_points must be a non-empty array';
  if (obj.key_points.some((p) => typeof p !== 'string' || !p.trim())) return 'key_points entries must be strings';
  if (obj.citations === undefined) return 'citations required';
  if (!Array.isArray(obj.citations)) return 'citations must be an array of evidence ids';
  return null;
}

export function buildResearchMessages(topic, evidences, conflicts) {
  const facts = evidences.map((e) => ({ id: e.id, url: e.url, title: e.title, quote: e.quote }));
  const text =
    `围绕主题「${topic}」写一份研究简报，只输出一个 JSON 对象。\n` +
    `字段：summary（不超过150字的中文综述，只依据给出的证据，证据不足就直说）、` +
    `key_points（3-5 条要点，每条标注引用证据 id，如 "[e1] ..."）、` +
    `citations（引用的证据 id 数组）、conflicts_note（一段话说明已标注的来源冲突，无冲突写"无"）。\n` +
    `证据：${JSON.stringify(facts)}\n已标注冲突：${JSON.stringify(conflicts.map((c) => c.note))}`;
  return [{ id: `rr-${topic}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'dsh-intelligence-hub' } }];
}

/**
 * 「给你的摘要」: one plain-language paragraph (100-200 chars) answering four things:
 * what this is (jargon explained inline), why it matters to the user, how it relates
 * to what they already follow, and where to start. LLM-generated; rule fallback.
 */
export function buildPlainSummaryMessages(topic, evidences, sourcesCount) {
  const evidenceLines = evidences.slice(0, 5).map((e) => `- ${e.title || e.url}：${e.quote.slice(0, 160)}`).join('\n');
  const text =
    `研究主题：「${topic}」（共 ${sourcesCount} 个来源，${evidences.length} 条证据）\n` +
    `证据摘录：\n${evidenceLines || '（无）'}\n\n` +
    `请面向不懂技术的普通读者，用通俗中文写一段 100-200 字的「给你的摘要」，必须回答四件事：\n` +
    `1) 这是什么（绝对不用术语；不得不用时当场用括号一句话解释）；\n` +
    `2) 为什么值得用户关注；\n` +
    `3) 和用户已关注的 AI 智能体/大模型应用有什么关系；\n` +
    `4) 想深入的话从哪里开始。\n` +
    `若主题本身含术语，先用一句话把它翻译成大白话。只输出摘要正文，不要标题和列表。`;
  return [{ id: `rs-${topic}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'dsh-intelligence-hub' } }];
}

/** Rule fallback for the plain summary (humanized wording, no jargon). */
export function plainSummaryRule(topic, evidences, sourcesCount) {
  const n = evidences.length;
  if (!n) return `关于「${topic}」，这次没能抓到足够的内容，暂时说不清它讲了什么；先记录下来，等有新资料再回头看。`;
  const first = String(evidences[0].title || topic).slice(0, 60);
  return `这次帮你查了「${topic}」：一共找到 ${sourcesCount} 个来源，其中 ${n} 条内容可用（比如《${first}》）。` +
    `它讲的事和你一直关注的 AI 智能体新进展是同一个方向，值得扫一眼下面的要点；` +
    `想深入的话，先从"证据清单"里的第一条链接读起就够了。`;
}

/** LLM plain summary with one retry; falls back to the rule text. Never throws. */
export async function generatePlainSummary({ llm, provider, model, topic, evidences, sourcesCount, signal }) {
  if (!llm) return { text: plainSummaryRule(topic, evidences, sourcesCount), degraded: true };
  const messages = buildPlainSummaryMessages(topic, evidences, sourcesCount);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = (await streamText(llm, {
        provider, model, messages,
        system: '你是把技术情报翻译成人话的助手：写大白话，短句，不堆术语，术语必须当场括号解释。',
        temperature: 0.4, maxTokens: 400, signal,
      })).trim();
      const cjk = (out.match(/[\u4e00-\u9fff]/g) || []).length;
      if (out.length < 50 || out.length > 400 || cjk < 40) throw new Error(`summary out of range (len=${out.length}, cjk=${cjk})`);
      return { text: out, degraded: false, _attempts: attempt + 1 };
    } catch { /* retry, then rule */ }
  }
  return { text: plainSummaryRule(topic, evidences, sourcesCount), degraded: true };
}

/** Rule-based report body (no LLM / fallback). */
function ruleReportBody(topic, evidences, conflicts) {  const points = evidences.slice(0, 5).map((e) => `[${e.id}] ${e.title}：${e.quote.slice(0, 140)}${e.conflicting ? '（⚠ 与其他来源存在表述冲突）' : ''}`);
  return {
    summary: evidences.length
      ? `围绕「${topic}」收集到 ${evidences.length} 条来源证据。以下要点均直接摘自来源，未做超出证据的推断。`
      : `围绕「${topic}」信息不足：未获得可用证据，本报告仅记录检索过程，不编造结论。`,
    key_points: points,
    citations: evidences.map((e) => e.id),
    conflicts_note: conflicts.length ? conflicts.map((c) => c.note).join(' ') : '无',
    degraded: true,
  };
}

function buildMarkdown({ task, topic, depth, body, evidences, conflicts, sources, checkpoint, plainSummary }) {
  const lines = [];
  const shortVersion = evidences.length > 0 && evidences.length <= 2;
  lines.push(`# 深度研究 · ${topic}`);
  lines.push('');
  lines.push(`- 任务：${task.task_id} ｜ 深度：${depth} ｜ 状态：COMPLETED`);
  lines.push(`- 证据数：${evidences.length} ｜ 来源数：${sources.length} ｜ 冲突标注：${conflicts.length}`);
  if (checkpoint.web_error) lines.push(`- 联网检索失败（不致命，仅本地库证据）：${String(checkpoint.web_error).slice(0, 120)}`);
  if (body.degraded) lines.push('- ⚠ 本报告为规则编排（LLM 不可用或输出未通过校验），仅汇总来源原文，未做综合推断。');
  lines.push('');
  // 「给你的摘要」always first: plain-language, for non-experts.
  lines.push('## 给你的摘要');
  lines.push('');
  lines.push(String(plainSummary?.text || '').trim() || plainSummaryRule(topic, evidences, sources.length));
  if (plainSummary?.degraded) lines.push('');
  if (plainSummary?.degraded) lines.push('（本段为规则拼接，未能生成更通俗的版本）');
  lines.push('');
  if (shortVersion) {
    lines.push(`> **⚠ 简版报告：本次只拿到 ${evidences.length} 条可用证据（目标 ≥3）。以下内容只是少数来源的说法，不构成完整结论，请谨慎采信。**`);
    lines.push('');
  }
  lines.push('## 结论摘要');
  lines.push('');
  lines.push(body.summary);
  lines.push('');
  lines.push('## 关键要点');
  lines.push('');
  for (const p of body.key_points) lines.push(`- ${p}`);
  lines.push('');
  lines.push('## 证据清单');
  lines.push('');
  if (evidences.length === 0) lines.push('信息不足：未获得可用证据（检索与抓取均无结果），以上结论不可作为事实引用。');
  for (const e of evidences) {
    lines.push(`- **${e.id}** [${e.title || e.url}](${e.url})${e.document_id ? `（本地文档 #${e.document_id}）` : ''}`);
    lines.push(`  > ${e.quote}`);
    if (e.conflicting) lines.push(`  ⚠ conflicting_sources：${e.conflicting.join(', ')}`);
  }
  lines.push('');
  lines.push('## 来源冲突');
  lines.push('');
  if (conflicts.length === 0) lines.push('未发现需要标注的来源冲突。');
  for (const c of conflicts) lines.push(`- ${c.note}（证据 ${c.evidence_ids.join(' vs ')}）`);
  lines.push('');
  lines.push('## 全部来源');
  lines.push('');
  for (const s of sources) lines.push(`- [${s.title || s.url}](${s.url})${s.fetched ? '（已抓取正文）' : '（仅检索结果，未抓取）'}`);
  lines.push('');
  lines.push('---');
  lines.push('*证据不足处已如实标注"信息不足"；冲突为规则标注，非已验证事实。*');
  return lines.join('\n');
}

/**
 * Execute one research task through its state machine. Retries resume from checkpoint.phase.
 * web search/fetch failures are non-fatal (local-library evidence only); LLM failure falls back
 * to the rule body. Final report -> result_json + reports/research/<task_id>.md.
 */
export async function runDeepResearchTask(db, taskId, {
  config = {}, webSearch = null, webFetch = null, llm = null, provider = '', model = '',
  reportsDir = null, logger = console, signal,
} = {}) {
  const task = getResearchTask(db, taskId);
  if (!task) throw new Error(`unknown research task ${taskId}`);
  if (['COMPLETED', 'FAILED'].includes(task.status)) return { status: task.status, note: 'terminal, nothing to do' };
  const topic = task.repo; // repo column carries the topic for kind='research'
  const cp0 = loadCheckpoint(task);
  const depth = cp0.depth || 'standard';
  const maxSources = cp0.max_sources || 8;
  let cp = { ...cp0 };
  let tokenUsage = { ...(task.token_usage_json ? JSON.parse(task.token_usage_json) : {}), input_chars: 0, output_chars: 0, estimate_tokens: 0 };

  try {
    // ---- COLLECTING: local FTS + web search ----
    if (!cp.phase || cp.phase === 'created') {
      setCheckpoint(db, taskId, { status: 'COLLECTING', checkpoint: { ...cp, phase: 'collecting', depth, max_sources: maxSources } });
      const localDocs = searchDocuments(db, { query: topic, limit: 20 });
      cp = { ...cp, phase: 'collecting', local: localDocs.map((d) => ({ document_id: d.id, url: d.url, title: d.title, summary: d.summary, raw_content: d.raw_content, source_type: d.source_type })) };
      if (typeof webSearch === 'function') {
        try {
          const res = await webSearch({ query: topic, maxResults: 10 }, signal);
          cp.web = (res?.sources || []).map((s) => ({ url: s.url, title: s.title || s.url, snippet: s.snippet || '' }));
        } catch (e) {
          cp.web = [];
          cp.web_error = String(e.message || e).slice(0, 300); // non-fatal
        }
      } else {
        cp.web = [];
        cp.web_error = 'web search capability unavailable';
      }
      setCheckpoint(db, taskId, { status: 'COLLECTING', checkpoint: cp });
      logger.info?.(`intelligence-hub: research ${taskId} collected local=${cp.local.length} web=${cp.web.length}`);
    }

    // ---- ANALYZING: fetch full text within budget (≤ max_sources docs total) ----
    if (cp.phase === 'collecting') {
      setCheckpoint(db, taskId, { status: 'ANALYZING', checkpoint: cp });
      const fetcher = webFetch ? createFetcher({ fetchImpl: webFetch, timeoutMs: FETCH_TIMEOUT_MS, retries: 1, minDelayMs: 100 }) : null;
      const selected = [];
      const seen = new Set();
      const candidates = [
        ...cp.local.map((d) => ({ ...d, local: true })),
        ...cp.web.map((w) => ({ document_id: null, url: w.url, title: w.title, summary: w.snippet, raw_content: '', source_type: 'web', local: false })),
      ];
      for (const c of candidates) {
        if (selected.length >= maxSources) break;
        if (seen.has(c.url)) continue;
        seen.add(c.url);
        const doc = { ...c, fetched: false, content: c.raw_content || c.summary || '' };
        if (fetcher && doc.content.length < 400) {
          try {
            doc.content = (await fetcher.getText(doc.url)).slice(0, MAX_FETCH_CHARS);
            doc.fetched = true;
          } catch (e) {
            doc.fetch_error = String(e.message || e).slice(0, 200); // non-fatal
          }
        }
        if (doc.fetched) {
          // Source auto-discovery hook: async, non-blocking, time-guarded; never fails the task.
          maybeDiscover(db, { url: doc.url, title: doc.title, description: String(doc.content).slice(0, 300), via: `research:${taskId}` }, { config, fetchText: webFetch });
        }
        if (doc.content && doc.content.length > 30) selected.push(doc);
      }
      // arXiv sources must have their official abstract page fetched: abstracts are the
      // primary evidence and the search snippet alone is never enough for a paper source.
      const isArxivUrl = (u) => { try { return /(^|\.)arxiv\.org$/.test(new URL(u).host.toLowerCase()); } catch { return false; } };
      if (fetcher) {
        for (const doc of selected) {
          if (doc.fetched || !isArxivUrl(doc.url)) continue;
          try {
            doc.content = (await fetcher.getText(`https://export.arxiv.org/abs/${arxivIdParts(doc.url).canonical}`)).slice(0, MAX_FETCH_CHARS);
            doc.fetched = true;
            doc.arxiv_abs = true;
          } catch { /* non-fatal */ }
        }
      }
      // Fallback: when every fetch failed but the local library has FTS hits for the
      // topic, use their stored content as evidence (document_id-referenced).
      if (selected.length === 0 && cp.local.length > 0) {
        for (const l of cp.local.slice(0, maxSources)) {
          const content = String(l.raw_content || l.summary || '');
          if (content.length > 30) {
            selected.push({ ...l, local: true, fetched: false, content, local_fallback: true });
          }
        }
        if (selected.length) logger.info?.(`intelligence-hub: research ${taskId} fetch failed, using ${selected.length} local-library doc(s) as evidence`);
      }
      cp = { ...cp, phase: 'analyzing', documents: selected };
      setCheckpoint(db, taskId, { status: 'ANALYZING', checkpoint: cp });
      logger.info?.(`intelligence-hub: research ${taskId} selected ${selected.length} doc(s)`);
    }

    // ---- VERIFYING: evidence extraction + conflict annotation ----
    if (cp.phase === 'analyzing') {
      setCheckpoint(db, taskId, { status: 'VERIFYING', checkpoint: cp });
      const keywords = significantTokens(topic);
      const evidences = cp.documents.map((d, i) => ({
        id: `e${i + 1}`,
        document_id: d.document_id,
        url: d.url,
        title: d.title,
        quote: extractQuote(d.content, keywords),
        findings: [extractQuote(d.content, keywords, 160)],
      }));
      const conflicts = detectConflicts(evidences);
      const conflictIds = new Set(conflicts.flatMap((c) => c.evidence_ids));
      for (const e of evidences) if (conflictIds.has(e.id)) e.conflicting = conflicts.filter((c) => c.evidence_ids.includes(e.id)).map((c) => c.sources[1]);
      cp = { ...cp, phase: 'verifying', evidences, conflicts };
      setCheckpoint(db, taskId, { status: 'VERIFYING', checkpoint: cp });
    }

    // ---- Hard gate: zero evidence -> no report at all ----
    if (cp.phase === 'verifying' && (cp.evidences || []).length === 0) {
      const result = {
        topic, depth, empty: true, reason: '证据不足',
        report: '', evidence_count: 0, conflicts: [], evidences: [],
        insufficient_data: true, web_error: cp.web_error || null,
        sources: (cp.documents || []).map((d) => ({ url: d.url, title: d.title, fetched: !!d.fetched })),
        token_usage: tokenUsage, completed_at: nowIso(),
      };
      db.prepare(
        'UPDATE intel_research_tasks SET status = ?, result_json = ?, token_usage_json = ?, completed_at = ?, error = NULL, updated_at = ? WHERE task_id = ?'
      ).run('COMPLETED', JSON.stringify(result), JSON.stringify(tokenUsage), nowIso(), nowIso(), taskId);
      logger.info?.(`intelligence-hub: research ${taskId} completed EMPTY (0 evidence) — no report written`);
      return { status: 'COMPLETED', task_id: taskId, evidence_count: 0, conflicts: 0, insufficient_data: true, empty: true };
    }

    // ---- WRITING: LLM report with validation, rule fallback ----
    if (cp.phase === 'verifying') {
      setCheckpoint(db, taskId, { status: 'WRITING', checkpoint: cp });
      const { evidences = [], conflicts = [], documents = [], local = [], web = [] } = cp;
      let body;
      let promptChars = 0;
      if (llm && depth !== 'quick' && evidences.length >= 2) {
        try {
          const messages = buildResearchMessages(topic, evidences, conflicts);
          promptChars = JSON.stringify(messages[0].content[0].text).length;
          const text = await streamText(llm, {
            provider, model, messages,
            system: '你是严谨的研究助手：只依据给定证据输出 JSON，证据不足必须直说，不得编造。',
            temperature: 0.3, maxTokens: 800, signal,
          });
          const obj = extractJson(text);
          const err = validateResearchReport(obj);
          if (err) throw new Error(err);
          body = { ...obj, degraded: false };
        } catch (e) {
          logger.warn?.(`intelligence-hub: research ${taskId} LLM report failed, rule fallback: ${e.message}`);
          body = ruleReportBody(topic, evidences, conflicts);
        }
      } else {
        body = ruleReportBody(topic, evidences, conflicts);
      }
      const sources = [
        ...documents.map((d) => ({ url: d.url, title: d.title, fetched: !!d.fetched })),
        ...local.filter((l) => !documents.some((d) => d.url === l.url)).map((l) => ({ url: l.url, title: l.title, fetched: false })).slice(0, 5),
        ...web.filter((w) => !documents.some((d) => d.url === w.url)).map((w) => ({ url: w.url, title: w.title, fetched: false })).slice(0, 5),
      ];
      // 「给你的摘要」: plain-language opener (LLM, rule fallback). Small budget, non-fatal.
      const plainSummary = await generatePlainSummary({ llm, provider, model, topic, evidences, sourcesCount: sources.length, signal });
      const reportMd = buildMarkdown({ task, topic, depth, body, evidences, conflicts, sources, checkpoint: cp, plainSummary });
      tokenUsage.output_chars = reportMd.length;
      tokenUsage.input_chars = promptChars + cp.documents.reduce((n, d) => n + String(d.content || '').length, 0) + String(plainSummary.text).length;
      tokenUsage.estimate_tokens = Math.ceil(tokenUsage.input_chars / 4) + Math.ceil(tokenUsage.output_chars / 4);
      cp = { ...cp, phase: 'writing', report: reportMd, body, plain_summary: plainSummary.text, plain_summary_degraded: plainSummary.degraded };
      setCheckpoint(db, taskId, { status: 'WRITING', checkpoint: cp });
    }

    // ---- COMPLETED: persist result + file ----
    const { report, evidences = [], conflicts = [], documents = [], web_error } = cp;
    const result = {
      topic,
      depth,
      report: report || '',
      evidence_count: evidences.length,
      conflicts,
      evidences,
      insufficient_data: evidences.length < 2,
      plain_summary: cp.plain_summary || '',
      plain_summary_degraded: !!cp.plain_summary_degraded,
      web_error: web_error || null,
      sources: (documents || []).map((d) => ({ url: d.url, title: d.title, fetched: !!d.fetched })),
      token_usage: tokenUsage,
      completed_at: nowIso(),
    };
    db.prepare(
      'UPDATE intel_research_tasks SET status = ?, result_json = ?, token_usage_json = ?, completed_at = ?, error = NULL, updated_at = ? WHERE task_id = ?'
    ).run('COMPLETED', JSON.stringify(result), JSON.stringify(tokenUsage), nowIso(), nowIso(), taskId);
    if (reportsDir) {
      const dir = path.join(reportsDir, 'research');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, `${taskId}.md`), report || '', 'utf8');
    }
    return { status: 'COMPLETED', task_id: taskId, evidence_count: evidences.length, conflicts: conflicts.length, insufficient_data: result.insufficient_data };
  } catch (err) {
    setCheckpoint(db, taskId, { status: 'FAILED', checkpoint: cp, error: String(err.message || err).slice(0, 500) });
    throw err;
  }
}
