/** Daily report v2: event-first briefing consuming intel_scores / intel_events / intel_knowledge_deltas / exploratory flag.
 *  Structure (≈5 min read): Top-3 picks (why / new findings / project match / action)
 *  -> further reading (5-8) -> WATCHLIST topics -> exploratory (≤2) -> sources & information gaps.
 *  Rule-based by default; LLM only enhances the "why watch" paragraph of the top picks (validated, falls back on failure).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getReport, saveReport, getProfile, saveReportItems } from './db.js';
import { localDayBounds, localParts, weekStartOf } from './scheduler.js';
import { DEFAULT_LONG_TERM_INTERESTS, getMatchableProfile, matchProfile } from './profile.js';
import { extractJson, streamText } from './analysis.js';
import { recordUsage, withinBudget, promptCharsOf } from './usage.js';
import { feedbackExcludedDocIds, isTopicPaused } from './feedback.js';
import { listTopics } from './topics.js';

const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/;

/**
 * Heuristic quality score (0-10 scale-ish). Deterministic, no LLM:
 * content length, published metadata, language, topic weight, title substance.
 * Kept for backward compatibility (used as tie-breaker for 延伸阅读 ordering).
 */
export function scoreDocument(doc) {
  const raw = String(doc.raw_content || doc.summary || '');
  const title = String(doc.title || '');
  let score = 0;
  score += Math.min(4, raw.length / 400); // substance: up to 4
  if (title.length >= 20) score += 0.5;
  if (CJK_RE.test(title + raw)) score += 0.5;
  if (doc.published_at) score += 1;
  const topicWeight = { 'ai-agents': 1.5, llm: 1.5, mcp: 1, memory: 1, devtools: 0.5, frontend: 0.3, general: 0.5 };
  score += topicWeight[doc.topic] ?? 0.5;
  if (/release|发布|launch|introduc|announc|open.?sourc/i.test(title)) score += 0.5;
  return Math.round(Math.min(10, score) * 10) / 10;
}

/** Documents first fetched on local date `dateStr` (tz-aware bounds). */
export function documentsOnDate(db, dateStr, timeZone = 'Asia/Shanghai') {
  const { start, end } = localDayBounds(dateStr, timeZone);
  return db
    .prepare('SELECT * FROM intel_documents WHERE fetched_at >= ? AND fetched_at < ? ORDER BY fetched_at DESC')
    .all(start, end);
}

/** Day rows joined with L3 scores, knowledge deltas and event clusters.
 *  Feedback effects (Phase 5): docs excluded by irrelevant/already_known feedback and docs whose
 *  topic is paused are dropped from the digest candidate pool (collection itself is untouched). */
export function scoredRowsOnDate(db, dateStr, timeZone = 'Asia/Shanghai') {
  const { start, end } = localDayBounds(dateStr, timeZone);
  const excludedIds = feedbackExcludedDocIds(db);
  const pausedCache = new Map();
  return db
    .prepare(
      `SELECT d.id, d.url, d.title, d.summary, d.raw_content, d.source_type, d.topic, d.published_at, d.fetched_at,
              s.r, s.n, s.p, s.e, s.t, s.total, s.decision, s.exploratory, s.filter_reason,
              kd.novelty_score, kd.novelty_state, kd.new_findings, kd.known_before,
              de.event_id, e.event_title
       FROM intel_documents d
       JOIN intel_scores s ON s.document_id = d.id
       LEFT JOIN intel_knowledge_deltas kd ON kd.document_id = d.id
       LEFT JOIN intel_document_events de ON de.document_id = d.id
       LEFT JOIN intel_events e ON e.event_id = de.event_id
       WHERE d.fetched_at >= ? AND d.fetched_at < ?
       ORDER BY s.total DESC, d.id ASC`
    )
    .all(start, end)
    .map((row) => ({
      ...row,
      exploratory: !!row.exploratory,
      new_findings: safeJson(row.new_findings, []),
      known_before: safeJson(row.known_before, []),
      _score: scoreDocument(row),
    }))
    .filter((row) => {
      if (excludedIds.has(row.id)) return false; // feedback: irrelevant / already_known
      if (!pausedCache.has(row.topic)) pausedCache.set(row.topic, isTopicPaused(db, row.topic));
      return !pausedCache.get(row.topic); // feedback: pause_topic (7-day digest pause)
    });
}

function safeJson(text, fallback) {
  if (text === null || text === undefined) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

const TOP_DECISIONS = new Set(['RECOMMEND', 'RESEARCH', 'DIGEST']);

/** Rule-based action suggestion for a pick. */
export function suggestAction(row) {
  if (row.source_type === 'github' || /github\.com/.test(String(row.url || ''))) {
    return '开源项目：clone 下来跑一次 README 快速上手，评估能否接入当前项目。';
  }
  if (row.source_type === 'arxiv' || /arxiv\.org/.test(String(row.url || ''))) {
    return '论文：先读摘要与实验表，若方法可复用再精读 §方法 并记录可借鉴点。';
  }
  if (Number(row.p) >= 50) {
    return '实践价值高：按文中步骤动手验证一次，把结果沉淀为内部笔记。';
  }
  return '延伸阅读：安排 10 分钟精读，提取与当前项目相关的一到两个做法。';
}

/** Rule-based "why watch" fallback text. */
function ruleWhyWatch(row, match) {
  const parts = [];
  if (row.event_title && row.event_title !== row.title) parts.push(`同事件有多来源报道（${row.event_title}）`);
  if (Number(row.n) >= 60) parts.push(`新颖度 ${Math.round(row.n)}：与库内已有知识重叠低`);
  if (match.matched_goals.length) parts.push(`命中长期兴趣 ${match.matched_goals.join('、')}`);
  if (match.matched_projects.length) parts.push(`关联进行中项目 ${match.matched_projects.join('、')}`);
  if (Number(row.t) >= 70) parts.push('时效性强（发布时间新）');
  if (!parts.length) parts.push(`综合评分 V=${row.total} 高于当日多数文档`);
  return parts.join('；') + '。';
}

/** LLM enhancement prompt for one pick. Returns chat messages (analysis.js shape). */
export function buildWhyWatchMessages(row, match) {
  const content = String(row.summary || row.raw_content || '').slice(0, 1500);
  const text =
    `为日报"今日最值得关注"条目写一段"为什么值得关注"（不超过100字，中文，直接给结论，不要列举格式）。\n` +
    `可参考信息：评分 R=${Math.round(row.r)} N=${Math.round(row.n)} P=${Math.round(row.p)} E=${Math.round(row.e)} T=${Math.round(row.t)}；` +
    `命中兴趣：${match.matched_goals.join('、') || '无'}；命中项目：${match.matched_projects.join('、') || '无'}；` +
    `新发现：${(row.new_findings || []).slice(0, 2).join(' / ') || '无'}。\n` +
    `标题：${row.title}\n摘要：${content}\n` +
    `只输出一个 JSON 对象：{"why_watch": "..."}`;
  return [{ id: `why-${row.id}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'dsh-intelligence-hub' } }];
}

/** Hand-written schema check for the why_watch enhancement. */
export function validateWhyWatch(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 'not an object';
  if (typeof obj.why_watch !== 'string' || obj.why_watch.trim().length < 8) return 'why_watch must be a non-trivial string';
  if ([...obj.why_watch].length > 300) return 'why_watch too long (>300 chars)';
  return null;
}

async function enhancePick({ db, timeZone, llm, provider, model, row, match, signal }) {
  const promptChars = promptCharsOf(buildWhyWatchMessages(row, match));
  try {
    const text = await streamText(llm, {
      provider, model,
      messages: buildWhyWatchMessages(row, match),
      system: '你是情报日报编辑，只输出符合 schema 的 JSON。',
      temperature: 0.3,
      maxTokens: 200,
      signal,
    });
    recordUsage(db, { call: 'report_why_watch', promptChars, completionChars: text.length, timeZone });
    const obj = extractJson(text);
    const err = validateWhyWatch(obj);
    if (err) throw new Error(err);
    return { why_watch: obj.why_watch.trim(), enhanced_by: 'llm' };
  } catch {
    return { why_watch: ruleWhyWatch(row, match), enhanced_by: 'rule' };
  }
}

/** Watchlist candidates (WATCHLIST gate) created within the day. */
export function watchlistOnDate(db, dateStr, timeZone = 'Asia/Shanghai') {
  const { start, end } = localDayBounds(dateStr, timeZone);
  return db
    .prepare(
      `SELECT topic, decision, reason, status, created_at FROM intel_research_candidates
       WHERE created_at >= ? AND created_at < ? AND decision IN ('WATCHLIST', 'DEEP_RESEARCH')
       ORDER BY created_at DESC LIMIT 8`
    )
    .all(start, end);
}

/** Per-source health for the gaps section. */
export function sourceHealth(db) {
  return db.prepare('SELECT name, source_type, last_ok_at, last_error FROM intel_sources ORDER BY id').all();
}

/** Interests with no coverage among the day's documents. */
export function coverageGaps(dayRows, db) {
  const matched = new Set();
  let keywordSets = [];
  try { keywordSets = getMatchableProfile(db).keywordSets; } catch { /* no profile table content */ }
  for (const row of dayRows) {
    for (const g of matchProfile(keywordSets, getProfile(db) || {}, row).matched_goals) matched.add(g);
  }
  return DEFAULT_LONG_TERM_INTERESTS.filter((i) => !matched.has(i));
}

/** Pure Markdown builder — fully testable without a database. */
export function buildDailyReportMarkdown({
  dateStr, picks, furtherReading, watchlist, exploratory, failedSources, gaps,
  generatedAt, timeZone = 'Asia/Shanghai', totalDocs, scoredCount,
}) {
  const lines = [];
  lines.push(`# 情报日报 · ${dateStr}`);
  lines.push('');
  lines.push(`- 生成时间：${generatedAt}（${timeZone}）`);
  lines.push(`- 当日新增文档：${totalDocs}`);
  lines.push(`- 进入评分管道：${scoredCount}`);
  lines.push('');
  lines.push('## 今日最值得关注');
  lines.push('');
  if (picks.length === 0) {
    lines.push('今日无达到推荐线（DIGEST 及以上）的事件：所有新文档评分偏低或被 L0 过滤，暂不凑数。');
  } else {
    if (picks.length < 3) {
      lines.push(`> 说明：今日高分事件仅 ${picks.length} 条（目标 3 条，缺 ${3 - picks.length} 条）——其余文档未达 DIGEST 线或为同事件重复来源，不凑数。`);
      lines.push('');
    }
    for (const [i, p] of picks.entries()) {
      lines.push(`### ${i + 1}. ${clean(p.title)}`);
      lines.push('');
      lines.push(`- 链接：[${clean(p.title)}](${p.url})`);
      lines.push(`- ${p.published_at ? `发布 ${p.published_at}` : '发布时间未知'} ｜ 发现 ${p.fetched_at} ｜ 来源 ${p.source_type || 'unknown'} ｜ V=${p.total}（R=${Math.round(p.r)} N=${Math.round(p.n)} P=${Math.round(p.p)} E=${Math.round(p.e)} T=${Math.round(p.t)}）`);
      if (p.event_id) lines.push(`- 事件簇：${clean(p.event_title || p.title)}（event ${p.event_id}）`);
      lines.push(`- **为什么值得关注**：${p.why_watch}`);
      if ((p.new_findings || []).length) {
        lines.push(`- **相比已有知识新增**：${p.new_findings.slice(0, 3).join('；')}`);
      } else {
        lines.push('- **相比已有知识新增**：暂无可提取的新发现（知识增量未生成或内容过短）。');
      }
      lines.push(`- **与当前项目关系**：${p.matched_projects.length ? p.matched_projects.join('、') : '无直接关联'}${p.matched_problems.length ? `；命中问题：${p.matched_problems.join('、')}` : ''}${p.matched_goals.length ? `；兴趣：${p.matched_goals.join('、')}` : ''}`);
      lines.push(`- **可操作建议**：${p.action}`);
      lines.push('');
    }
  }
  lines.push('## 延伸阅读');
  lines.push('');
  if (furtherReading.length === 0) lines.push('今日无更多达标文档。');
  for (const d of furtherReading) {
    const published = d.published_at ? `发布 ${d.published_at}` : '发布时间未知';
    lines.push(`- [${clean(d.title)}](${d.url})  `);
    lines.push(`  ${published} ｜ 发现 ${d.fetched_at} ｜ V=${d.total}（${d.decision || '-'}）${d.event_id ? ` ｜ 事件 ${d.event_id}` : ''}`);
    const snippet = String(d.summary || d.raw_content || '').replace(/\s+/g, ' ').trim().slice(0, 140);
    if (snippet) lines.push(`  > ${snippet}`);
  }
  lines.push('');
  lines.push('## 值得追踪主题（WATCHLIST）');
  lines.push('');
  if (watchlist.length === 0) lines.push('今日无新的 WATCHLIST 候选。');
  for (const w of watchlist) {
    lines.push(`- ${clean(w.topic)}（${w.decision}${w.status ? ` · ${w.status}` : ''}）— ${w.reason}`);
  }
  lines.push('');
  lines.push('## 探索性内容');
  lines.push('');
  if (exploratory.length === 0) lines.push('今日无探索性采样文档。');
  for (const e of exploratory) {
    lines.push(`- [${clean(e.title)}](${e.url}) ｜ 发现 ${e.fetched_at} ｜ V=${e.total} ｜ 探索性采样（低分池 5% 随机保留）`);
  }
  lines.push('');
  lines.push('## 来源与信息缺口');
  lines.push('');
  if (failedSources.length === 0) lines.push('- 今日全部来源抓取正常。');
  for (const s of failedSources) {
    lines.push(`- 来源失败：${s.name}（${s.source_type}）— ${String(s.last_error || '').slice(0, 120)}`);
  }
  lines.push(`- 无覆盖主题：${gaps.length ? gaps.join('、') : '无（当日主题覆盖完整）'}`);
  lines.push('');
  lines.push('---');
  lines.push('*规则化生成（评分/事件/知识增量驱动，每事件一个主推荐位）；"为什么值得关注"在 LLM 可用时增强生成，失败回退规则文案。*');
  return lines.join('\n');
}

function clean(s) {
  return String(s || '').replace(/[\[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

/**
 * Generate the daily report for `dateStr`. Idempotent: unique report_date index
 * on intel_reports; if a report already exists it is returned unchanged.
 * Also writes `reports/<date>.md` (reportsDir override supported).
 * Async: LLM enhancement awaits ctx.llm when analysisEnabled + provider/model set.
 */
export async function generateDailyReport(db, {
  dateStr, timeZone = 'Asia/Shanghai', reportsDir, now = new Date(),
  llm = null, provider = '', model = '', analysisEnabled = false, maxFurther = 8,
  tokenBudgetPerDay = 0,
} = {}) {
  const existing = getReport(db, dateStr);
  if (existing) return { created: false, id: existing.id, markdown: existing.body, date: dateStr };

  const dayRows = scoredRowsOnDate(db, dateStr, timeZone);
  const totalDocs = documentsOnDate(db, dateStr, timeZone).length;

  // Top picks: best non-exploratory doc per event, DIGEST+ only, up to 3.
  const seenEvents = new Set();
  const picksRaw = [];
  const rest = [];
  for (const row of dayRows) {
    if (!TOP_DECISIONS.has(row.decision)) continue;
    const evKey = row.event_id || `doc-${row.id}`;
    if (picksRaw.length < 3 && !seenEvents.has(evKey)) {
      seenEvents.add(evKey);
      picksRaw.push(row);
    } else if (seenEvents.has(evKey) && !picksRaw.some((p) => (p.event_id || `doc-${p.id}`) === evKey)) {
      // same event later doc: stays in further reading
    }
    rest.push(row);
  }

  const profile = getProfile(db) || { long_term_interests: [], current_projects: [], learning_goals: [], content_preferences: { deprioritize: [] } };
  const { keywordSets } = getMatchableProfile(db);

  const picks = [];
  for (const row of picksRaw) {
    const match = matchProfile(keywordSets, profile, row);
    let why = { why_watch: ruleWhyWatch(row, match), enhanced_by: 'rule' };
    const budgetOpen = withinBudget(db, { tokenBudgetPerDay }, { timeZone }).allowed;
    if (analysisEnabled && llm && provider && model && budgetOpen) {
      why = await enhancePick({ db, timeZone, llm, provider, model, row, match });
    }
    picks.push({ ...row, ...match, match, ...why, action: suggestAction(row) });
  }

  const furtherReading = rest
    .filter((r) => !picks.some((p) => p.id === r.id))
    .sort((a, b) => (b.total - a.total) || (b._score - a._score))
    .slice(0, maxFurther);

  const watchlist = watchlistOnDate(db, dateStr, timeZone);
  const exploratory = dayRows.filter((r) => r.exploratory).slice(0, 2);
  const failedSources = sourceHealth(db).filter((s) => s.last_error);
  const gaps = coverageGaps(dayRows, db);

  const generatedAt = now.toISOString();
  const markdown = buildDailyReportMarkdown({
    dateStr, picks, furtherReading, watchlist, exploratory, failedSources, gaps,
    generatedAt, timeZone, totalDocs, scoredCount: dayRows.length,
  });
  const title = `情报日报 ${dateStr}`;
  const saved = saveReport(db, {
    reportDate: dateStr,
    title,
    body: markdown,
    model: picks.some((p) => p.enhanced_by === 'llm') ? `${provider}/${model}` : '',
    documentIds: [...picks.map((p) => p.id), ...furtherReading.map((d) => d.id)],
    createdAt: generatedAt,
    kind: 'daily',
  });
  if (saved.created && saved.id) {
    try {
      saveReportItems(db, saved.id, [
        ...picks.map((p) => ({ document_id: p.id, section: 'top_picks', claim: `推荐：${p.title}` })),
        ...furtherReading.map((d) => ({ document_id: d.id, section: 'further_reading', claim: d.title })),
      ], generatedAt);
    } catch { /* report items are audit-only; never fail the report */ }
  }

  let filePath = null;
  if (reportsDir) {
    mkdirSync(reportsDir, { recursive: true });
    filePath = path.join(reportsDir, `${dateStr}.md`);
    writeFileSync(filePath, markdown, 'utf8');
  }
  return {
    created: saved.created, id: saved.id, markdown, date: dateStr, filePath,
    totalDocs, scoredCount: dayRows.length,
    picks: picks.map((p) => ({ id: p.id, title: p.title, total: p.total, enhanced_by: p.enhanced_by })),
  };
}

// ---------------- Weekly report (V2.0 Phase 2) ----------------

/** Days [startIso, endIso) scored rows for a whole local-date window. */
export function scoredRowsBetween(db, { start, end }, timeZone = 'Asia/Shanghai') {
  const excludedIds = feedbackExcludedDocIds(db);
  const pausedCache = new Map();
  return db
    .prepare(
      `SELECT d.id, d.url, d.title, d.summary, d.raw_content, d.source_type, d.topic, d.published_at, d.fetched_at,
              s.r, s.n, s.p, s.e, s.t, s.total, s.decision, s.exploratory,
              kd.novelty_score, kd.novelty_state, kd.new_findings,
              de.event_id, e.event_title
       FROM intel_documents d
       JOIN intel_scores s ON s.document_id = d.id
       LEFT JOIN intel_knowledge_deltas kd ON kd.document_id = d.id
       LEFT JOIN intel_document_events de ON de.document_id = d.id
       LEFT JOIN intel_events e ON e.event_id = de.event_id
       WHERE d.fetched_at >= ? AND d.fetched_at < ?
       ORDER BY s.total DESC, d.id ASC`
    )
    .all(start, end)
    .map((row) => ({
      ...row,
      exploratory: !!row.exploratory,
      new_findings: safeJson(row.new_findings, []),
      _score: scoreDocument(row),
    }))
    .filter((row) => {
      if (excludedIds.has(row.id)) return false;
      if (!pausedCache.has(row.topic)) pausedCache.set(row.topic, isTopicPaused(db, row.topic));
      return !pausedCache.get(row.topic);
    });
}

/** Per-day aggregate over the 7 days starting `weekStart` (rule-based weekly stats). */
export function weeklyStats(db, weekStart, timeZone = 'Asia/Shanghai') {
  const days = [];
  let total = 0;
  let scoredTotal = 0;
  let picksTotal = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.parse(`${weekStart}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10);
    const { start, end } = localDayBounds(d, timeZone);
    const docs = db.prepare('SELECT COUNT(*) AS n FROM intel_documents WHERE fetched_at >= ? AND fetched_at < ?').get(start, end).n;
    const rows = scoredRowsBetween(db, { start, end }, timeZone);
    const avgTotal = rows.length ? Math.round((rows.reduce((a, r) => a + Number(r.total || 0), 0) / rows.length) * 10) / 10 : 0;
    const picks = rows.filter((r) => TOP_DECISIONS.has(r.decision)).length;
    days.push({ date: d, docs, scored: rows.length, picks, avg_total: avgTotal });
    total += docs;
    scoredTotal += rows.length;
    picksTotal += picks;
  }
  return { week_start: weekStart, days, total_docs: total, total_scored: scoredTotal, total_picks: picksTotal };
}

/** Topic affinity: how many week documents hit each active topic's keywords. */
export function weeklyTopicAffinity(db, weekStart, timeZone = 'Asia/Shanghai') {
  const { start, end } = localDayBounds(weekStart, timeZone);
  const weekEnd = new Date(Date.parse(end) + 7 * 86400000).toISOString();
  const rows = db.prepare('SELECT title, summary, raw_content FROM intel_documents WHERE fetched_at >= ? AND fetched_at < ?').all(start, weekEnd);
  const out = [];
  for (const t of listTopics(db, { status: 'active' })) {
    let hits = 0;
    for (const r of rows) {
      const text = `${r.title} ${r.summary} ${r.raw_content}`.toLowerCase();
      if ((t.keywords || []).some((k) => text.includes(String(k).toLowerCase()))) hits++;
    }
    const progress = db
      .prepare(
        "SELECT COUNT(*) AS n FROM intel_research_tasks WHERE kind = 'research' AND status = 'COMPLETED' AND repo = ?"
      )
      .get(t.name)?.n || 0;
    out.push({ topic: t.name, doc_hits: hits, completed_research: progress });
  }
  return out;
}

/** Pure weekly Markdown builder — no database access, fully testable. */
export function buildWeeklyReportMarkdown({
  weekStart, weekEnd, stats, picks, trends, topicAffinity, engineering, researchSuggestions,
  generatedAt, timeZone = 'Asia/Shanghai', llmSection = '',
}) {
  const lines = [];
  lines.push(`# 情报周报 · ${weekStart} ~ ${weekEnd}`);
  lines.push('');
  lines.push(`- 生成时间：${generatedAt}（${timeZone}）`);
  lines.push(`- 本周新增文档：${stats.total_docs} ｜ 进入评分：${stats.total_scored} ｜ 达标条目：${stats.total_picks}`);
  lines.push('');
  lines.push('## 本周趋势');
  lines.push('');
  lines.push('| 日期 | 新增 | 评分 | 达标 | 平均分 |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const d of stats.days) {
    lines.push(`| ${d.date} | ${d.docs} | ${d.scored} | ${d.picks} | ${d.avg_total} |`);
  }
  lines.push('');
  lines.push('## 重要进展（本周 Top）');
  lines.push('');
  if (picks.length === 0) lines.push('本周无达到 DIGEST 及以上的条目。');
  for (const [i, p] of picks.entries()) {
    lines.push(`${i + 1}. [${clean(p.title)}](${p.url}) ｜ ${p.fetched_at} ｜ V=${p.total}（${p.decision || '-'}）`);
    const snippet = String(p.summary || p.raw_content || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    if (snippet) lines.push(`   > ${snippet}`);
  }
  lines.push('');
  lines.push('## 热点变化');
  lines.push('');
  if (trends.length === 0) lines.push('本周无可对比的事件/评分趋势。');
  for (const t of trends) lines.push(`- ${t}`);
  lines.push('');
  lines.push('## 与专题的关系');
  lines.push('');
  for (const t of topicAffinity) {
    lines.push(`- ${t.topic}：本周命中 ${t.doc_hits} 篇；专题累计完成研究 ${t.completed_research} 项`);
  }
  lines.push('');
  lines.push('## 工程实践');
  lines.push('');
  if (engineering.length === 0) lines.push('本周无高实践价值（P≥60）条目。');
  for (const e of engineering) {
    lines.push(`- [${clean(e.title)}](${e.url}) ｜ P=${Math.round(e.p)} ｜ ${suggestAction(e)}`);
  }
  lines.push('');
  lines.push('## 研究建议');
  lines.push('');
  if (researchSuggestions.length === 0) lines.push('本周无新的研究候选建议。');
  for (const s of researchSuggestions) {
    lines.push(`- ${clean(s.topic)}（${s.decision}${s.status ? ` · ${s.status}` : ''}）— ${s.reason}`);
  }
  lines.push('');
  if (llmSection) {
    lines.push('## 编辑综述');
    lines.push('');
    lines.push(llmSection);
    lines.push('');
  }
  lines.push('---');
  lines.push('*规则化生成（7 天窗口聚合：趋势/进展/热点/专题/工程/建议）；"编辑综述"为 LLM 增强位，本期默认跳过（留空钩子）。*');
  return lines.join('\n');
}

/**
 * Generate the weekly report for the week starting `weekStart` (a Monday, tz-aware
 * via localDayBounds). Idempotent: unique (report_date=weekStart, kind='weekly').
 * Writes reports/<weekStart>.md when reportsDir is set. The LLM 综述 hook is left
 * empty by default (rule-only); pass llmOverview to inject one.
 */
export async function generateWeeklyReport(db, {
  weekStart, timeZone = 'Asia/Shanghai', reportsDir, now = new Date(),
  maxPicks = 10, maxEngineering = 5, llmOverview = '',
} = {}) {
  const start = String(weekStart || weekStartOf(now.toISOString().slice(0, 10), { timeZone }));
  const existing = getReport(db, start, 'weekly');
  if (existing) return { created: false, id: existing.id, markdown: existing.body, week_start: start };

  const stats = weeklyStats(db, start, timeZone);
  const weekEndDate = new Date(Date.parse(`${start}T00:00:00Z`) + 6 * 86400000).toISOString().slice(0, 10);
  const { start: windowStart, end: windowEndRaw } = localDayBounds(start, timeZone);
  const windowEnd = new Date(Date.parse(windowEndRaw) + 6 * 86400000).toISOString();
  const rows = scoredRowsBetween(db, { start: windowStart, end: windowEnd }, timeZone);

  const picks = rows.filter((r) => TOP_DECISIONS.has(r.decision)).slice(0, maxPicks);
  const engineering = [...rows].sort((a, b) => (Number(b.p) || 0) - (Number(a.p) || 0)).filter((r) => Number(r.p) >= 60).slice(0, maxEngineering);

  const trends = [];
  const half = Math.floor(stats.days.length / 2);
  const firstHalf = stats.days.slice(0, half);
  const secondHalf = stats.days.slice(half);
  const avg = (xs) => (xs.length ? xs.reduce((a, x) => a + x.avg_total, 0) / xs.length : 0);
  const delta = Math.round((avg(secondHalf) - avg(firstHalf)) * 10) / 10;
  if (delta > 0) trends.push(`周后半平均分较前半上升 ${delta}：内容质量走强`);
  else if (delta < 0) trends.push(`周后半平均分较前半下降 ${Math.abs(delta)}：高分来源减少`);
  else trends.push('周内平均分基本持平');
  const byEvent = new Map();
  for (const r of rows) {
    const key = r.event_id || `doc-${r.id}`;
    byEvent.set(key, (byEvent.get(key) || 0) + 1);
  }
  const multi = [...byEvent.values()].filter((n) => n > 1).length;
  if (multi > 0) trends.push(`${multi} 个事件有多来源跟进（热点事件簇）`);
  const newDocs = rows.filter((r) => Number(r.n) >= 60).length;
  if (newDocs > 0) trends.push(`${newDocs} 篇高新颖度（N≥60）文档入库`);

  const topicAffinity = weeklyTopicAffinity(db, start, timeZone);
  const researchSuggestions = db
    .prepare(
      `SELECT topic, decision, reason, status, created_at FROM intel_research_candidates
       WHERE created_at >= ? AND created_at < ? AND decision IN ('WATCHLIST', 'DEEP_RESEARCH')
       ORDER BY created_at DESC LIMIT 8`
    )
    .all(windowStart, windowEnd);

  const markdown = buildWeeklyReportMarkdown({
    weekStart: start,
    weekEnd: weekEndDate,
    stats,
    picks,
    trends,
    topicAffinity,
    engineering,
    researchSuggestions,
    generatedAt: now.toISOString(),
    timeZone,
    llmSection: llmOverview,
  });

  const saved = saveReport(db, {
    reportDate: start,
    title: `情报周报 ${start} ~ ${weekEndDate}`,
    body: markdown,
    model: llmOverview ? 'llm' : '',
    documentIds: [...picks.map((p) => p.id), ...engineering.map((e) => e.id)],
    createdAt: now.toISOString(),
    kind: 'weekly',
  });
  if (saved.created && saved.id) {
    try {
      saveReportItems(db, saved.id, [
        ...picks.map((p) => ({ document_id: p.id, section: 'weekly_picks', claim: `重要进展：${p.title}` })),
        ...engineering.map((e) => ({ document_id: e.id, section: 'engineering', claim: e.title })),
      ], now.toISOString());
    } catch { /* audit-only */ }
  }

  let filePath = null;
  if (reportsDir) {
    mkdirSync(reportsDir, { recursive: true });
    filePath = path.join(reportsDir, `weekly-${start}.md`);
    writeFileSync(filePath, markdown, 'utf8');
  }
  return {
    created: saved.created, id: saved.id, markdown, week_start: start, week_end: weekEndDate, filePath,
    total_docs: stats.total_docs, total_scored: stats.total_scored, picks: picks.length,
  };
}
