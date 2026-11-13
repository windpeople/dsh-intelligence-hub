/** RESEARCH_REVIEW: the agent (大肥鱼) autonomously reviews research candidates on a schedule.
 *
 *  Pool: intel_research_candidates with status 'requested' (user/panel hand-offs) and
 *  'watching' (gate suggestions, top-N by recent score), plus 'deferred' (previous
 *  review rounds that hit the daily research budget). For each candidate ctx.llm
 *  makes a structured decision { decision: 'research'|'dismiss', reason,
 *  refined_topic? }; 'research' enqueues a RESEARCH_TASK via createDeepResearchTask
 *  (researchBudgetPerDay enforced; over-budget candidates are marked 'deferred'),
 *  'dismiss' marks the candidate 'dismissed' with the reason kept for audit.
 *  LLM unavailable / unconfigured / token budget exhausted -> nothing changes and
 *  the run returns { skipped: true, reason }.
 */

import { randomUUID } from 'node:crypto';
import { createDeepResearchTask } from './research.js';
import { enqueueJob, localDateString, localParts } from './scheduler.js';
import { extractJson, streamText } from './analysis.js';
import { recordUsage, withinBudget, promptCharsOf } from './usage.js';
import { loadProfile } from './profile.js';

export const RESEARCH_REVIEW_KIND = 'RESEARCH_REVIEW';
export const REVIEW_PROMPT_VERSION = 'research-review-v1';

/** Candidate pool: requested first, then deferred, then watching by recent score. */
export function selectReviewCandidates(db, { limit = 5 } = {}) {
  return db.prepare(
    `SELECT c.id, c.topic, c.decision, c.reason AS candidate_reason, c.document_id, c.status, c.created_at,
            d.title AS document_title, d.summary AS document_summary, d.url AS document_url,
            (SELECT MAX(total) FROM intel_scores WHERE document_id = c.document_id) AS score_total
     FROM intel_research_candidates c
     LEFT JOIN intel_documents d ON d.id = c.document_id
     WHERE c.status IN ('requested', 'watching', 'deferred')
     ORDER BY CASE c.status WHEN 'requested' THEN 0 WHEN 'deferred' THEN 1 ELSE 2 END,
              score_total DESC, c.id DESC
     LIMIT ?`
  ).all(Math.max(1, Math.min(20, Number(limit) || 5)));
}

/** One-line interest-profile summary for the prompt (rule-built, no LLM). */
export function profileSummary(db) {
  try {
    const p = loadProfile(db);
    const parts = [];
    if (Array.isArray(p.long_term_interests) && p.long_term_interests.length) parts.push(`长期兴趣: ${p.long_term_interests.join('、')}`);
    if (Array.isArray(p.current_projects)) {
      for (const pr of p.current_projects) {
        parts.push(`进行中项目: ${pr.name}${pr.goal ? `（${String(pr.goal).slice(0, 80)}）` : ''}`);
      }
    }
    if (Array.isArray(p.learning_goals) && p.learning_goals.length) parts.push(`学习目标: ${p.learning_goals.join('、')}`);
    return parts.join('；') || '（空，使用默认兴趣：AI 智能体/大模型工程）';
  } catch {
    return '（空，使用默认兴趣：AI 智能体/大模型工程）';
  }
}

export function buildReviewMessages(candidate, profileText) {
  const evidence = candidate.document_title
    ? `证据文档：${candidate.document_title}（${candidate.document_url || ''}，评分 ${candidate.score_total ?? '无'}）\n摘要：${String(candidate.document_summary || '').slice(0, 600)}`
    : `证据文档：无（仅候选理由）`;
  const text =
    `你是研究规划助手（大肥鱼）。判断以下研究候选是否值得立即深入调研（deep research），只输出一个 JSON 对象。\n` +
    `JSON 字段：decision（"research"=值得深入研究，"dismiss"=不值得）、reason（用给非研究者看的通俗中文说明为什么研究/不研究，直接说内容和价值本身；禁止出现"阈值""评分""分数""WATCHLIST"等系统内部词，100 字以内）、refined_topic（可选，仅 decision=research 时给出比原主题更精确的研究主题字符串）。\n` +
    `候选主题：${candidate.topic}\n候选理由：${candidate.candidate_reason || ''}\n候选状态：${candidate.status}\n${evidence}\n` +
    `用户兴趣画像：${profileText}\n` +
    `标准：与用户兴趣强相关、证据充足或主题足够聚焦才选 research；重复、过时、太宽泛的选 dismiss。`;
  return [
    {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'dsh-intelligence-hub' },
    },
  ];
}

/** Hand-written schema check for one review decision. Returns error string or null. */
export function validateReviewDecision(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 'not an object';
  const { decision, reason } = obj;
  if (decision !== 'research' && decision !== 'dismiss') return 'decision must be "research" or "dismiss"';
  if (typeof reason !== 'string' || !reason.trim()) return 'reason must be a non-empty string';
  if ([...reason].length > 300) return 'reason too long (>300 chars)';
  // User-facing wording: internal system vocabulary must not leak into the reason.
  if (/阈值|评分|分数|总分|WATCHLIST|total\s*=/i.test(reason)) return 'reason must be plain user-facing language (no internal words like 阈值/评分)';
  if (obj.refined_topic !== undefined && obj.refined_topic !== null && (typeof obj.refined_topic !== 'string' || !obj.refined_topic.trim())) {
    return 'refined_topic must be a non-empty string when present';
  }
  return null;
}

/**
 * One LLM decision for a candidate, analysis.js style (one retry, JSON extract +
 * hand-written validation). Returns the validated object or throws.
 */
export async function reviewCandidate({ llm, provider, model, candidate, profileText, signal, temperature = 0.2, maxTokens = 300 } = {}) {
  const messages = buildReviewMessages(candidate, profileText);
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = await streamText(llm, {
        provider, model, messages,
        system: '你是严谨的研究规划助手，只输出符合 schema 的 JSON，不要输出解释文字。',
        temperature, maxTokens, signal,
      });
      const obj = extractJson(text);
      const err = validateReviewDecision(obj);
      if (err) { lastError = `invalid review output: ${err}`; continue; }
      return {
        decision: obj.decision,
        reason: obj.reason.trim(),
        refined_topic: typeof obj.refined_topic === 'string' && obj.refined_topic.trim() ? obj.refined_topic.trim() : null,
        _raw: text,
        _attempts: attempt + 1,
      };
    } catch (err) {
      lastError = String(err.message || err);
    }
  }
  throw new Error(`review failed after retry: ${lastError}`);
}

function setCandidateStatus(db, id, status, reason) {
  db.prepare('UPDATE intel_research_candidates SET status = ?, reason = ? WHERE id = ?').run(status, String(reason || '').slice(0, 500), id);
}

/**
 * Execute one RESEARCH_REVIEW run. Never throws for per-candidate failures; a
 * missing/unconfigured LLM or exhausted token budget skips the whole run with
 * the pool untouched.
 */
export async function runResearchReview(db, {
  llm, config = {}, batch, signal, now = new Date(),
} = {}) {
  const timeZone = config.reportTimeZone || 'Asia/Shanghai';
  const provider = config.analysisProvider;
  const model = config.analysisModel;
  if (!llm || !provider || !model) {
    return { skipped: true, reason: 'llm unavailable or analysisProvider/analysisModel unconfigured' };
  }
  const candidates = selectReviewCandidates(db, { limit: batch ?? (Number(config.researchReviewBatch) || 5) });
  if (!candidates.length) return { skipped: false, reviewed: [], enqueued: 0, dismissed: 0, deferred: 0, failed: [] };

  const profileText = profileSummary(db);
  const reviewed = [];
  const failed = [];
  let enqueued = 0, dismissed = 0, deferred = 0;

  for (const candidate of candidates) {
    // Daily token budget (chars): once spent, leave the remaining pool untouched.
    if (!withinBudget(db, config, { timeZone, now }).allowed) {
      reviewed.push({ id: candidate.id, topic: candidate.topic, action: 'kept', reason: 'token budget exhausted' });
      continue;
    }
    let decision;
    try {
      const promptChars = promptCharsOf(buildReviewMessages(candidate, profileText));
      decision = await reviewCandidate({ llm, provider, model, candidate, profileText, signal });
      recordUsage(db, {
        call: 'research_review',
        promptChars,
        completionChars: String(decision._raw || '').length,
        timeZone,
        now,
      });
    } catch (err) {
      // Invalid/failed LLM output after retry -> candidate keeps its status.
      failed.push({ id: candidate.id, topic: candidate.topic, error: String(err.message || err).slice(0, 300) });
      continue;
    }
    if (decision.decision === 'dismiss') {
      setCandidateStatus(db, candidate.id, 'dismissed', `${candidate.candidate_reason || ''} | 评审dismiss: ${decision.reason}`.slice(0, 500));
      dismissed++;
      reviewed.push({ id: candidate.id, topic: candidate.topic, decision: 'dismiss', reason: decision.reason, action: 'dismissed' });
      continue;
    }
    // decision === 'research': create task + enqueue RESEARCH_TASK (budget enforced).
    const topic = decision.refined_topic || candidate.topic;
    const created = createDeepResearchTask(db, { topic, depth: 'standard' }, { budgetPerDay: Number(config.researchBudgetPerDay) || 3, timeZone, now });
    if (!created.ok) {
      if (created.budgeted) {
        setCandidateStatus(db, candidate.id, 'deferred', `${candidate.candidate_reason || ''} | 评审research但超日预算，留待下次: ${decision.reason}`.slice(0, 500));
        deferred++;
        reviewed.push({ id: candidate.id, topic: candidate.topic, decision: 'research', refined_topic: topic, reason: decision.reason, action: 'deferred' });
      } else {
        failed.push({ id: candidate.id, topic: candidate.topic, error: created.error?.message || 'task rejected' });
      }
      continue;
    }
    if (created.deduped) {
      setCandidateStatus(db, candidate.id, 'researching', `${candidate.candidate_reason || ''} | 评审research（活动任务已存在 ${created.task_id}）: ${decision.reason}`.slice(0, 500));
      reviewed.push({ id: candidate.id, topic: candidate.topic, decision: 'research', refined_topic: topic, reason: decision.reason, action: 'deduped', task_id: created.task_id });
      continue;
    }
    const date = localDateString(now, timeZone);
    const job = enqueueJob(db, {
      kind: 'RESEARCH_TASK',
      runDate: `${date}#${created.task_id}`,
      payload: { task_id: created.task_id, topic: created.topic, depth: created.depth, candidate_id: candidate.id },
      maxAttempts: 3,
    });
    db.prepare('UPDATE intel_research_tasks SET execution_id = ? WHERE task_id = ?').run(job.id ?? null, created.task_id);
    setCandidateStatus(db, candidate.id, 'researching', `${candidate.candidate_reason || ''} | 评审research，已入队 ${created.task_id}: ${decision.reason}`.slice(0, 500));
    enqueued++;
    reviewed.push({ id: candidate.id, topic: candidate.topic, decision: 'research', refined_topic: topic, reason: decision.reason, action: 'enqueued', task_id: created.task_id, job_id: job.id ?? null });
  }
  return { skipped: false, reviewed, enqueued, dismissed, deferred, failed, prompt_version: REVIEW_PROMPT_VERSION };
}
