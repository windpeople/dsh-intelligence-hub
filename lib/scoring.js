/** Scoring pipeline: L0 filter -> L1 relevance -> L2 knowledge delta -> L3 total + Research Gate. */

import { extractJson, streamText } from './analysis.js';
import { localDayBounds, localParts } from './scheduler.js';
import { bigramize, dedupKeyFor } from './normalize.js';
import { getProfile, saveKnowledgeDelta, saveDocScore, saveResearchCandidate } from './db.js';
import { matchProfile, SYNONYMS } from './profile.js';
import { assignDocumentToEvent, electPrimaryDocument, eventsOnDate } from './events.js';
import { recordUsage, withinBudget } from './usage.js';

export const RANKING_VERSION = 'v1';

export const DEFAULT_THRESHOLDS = { archive: 50, digest: 50, recommend: 70, research: 85 };

/** Merge configured thresholds over defaults; invalid values fall back. */
export function resolveThresholds(config) {
  const t = config?.scoreThresholds || {};
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 100 ? Number(v) : d);
  return {
    archive: num(t.archive, DEFAULT_THRESHOLDS.archive),
    digest: num(t.digest, DEFAULT_THRESHOLDS.digest),
    recommend: num(t.recommend, DEFAULT_THRESHOLDS.recommend),
    research: num(t.research, DEFAULT_THRESHOLDS.research),
  };
}

// ---------------- L0: deterministic filters (no LLM) ----------------

const PUBLISHED_STALE_DAYS = 90;

/**
 * L0 checks reusing existing dedup/language/time ideas. Returns
 * { pass, reason, filterStage: 'L0' } — reason='' when passing.
 */
export function l0Filter(db, doc, { now = new Date() } = {}) {
  const title = String(doc.title || '').trim();
  const body = String(doc.raw_content || doc.summary || '').trim();
  if (!title && !body) return { pass: false, reason: 'empty-content', filterStage: 'L0' };
  if (title && !body && !doc.summary) return { pass: false, reason: 'no-content', filterStage: 'L0' };
  if (doc.lang === 'und') return { pass: false, reason: 'unknown-language', filterStage: 'L0' };
  // cross-document exact-content duplicate (same dedup key already stored under another id)
  if (doc.url) {
    const dup = db
      .prepare('SELECT id FROM intel_documents WHERE dedup_key = ? AND id != ? LIMIT 1')
      .get(dedupKeyFor(doc.url), doc.id);
    if (dup) return { pass: false, reason: 'duplicate-url', filterStage: 'L0' };
  }
  if (doc.published_at) {
    const ageDays = (now.getTime() - Date.parse(doc.published_at)) / 86400000;
    if (Number.isFinite(ageDays) && ageDays > PUBLISHED_STALE_DAYS) {
      return { pass: false, reason: `stale-published>${PUBLISHED_STALE_DAYS}d`, filterStage: 'L0' };
    }
  }
  return { pass: true, reason: '', filterStage: 'L0' };
}

/** Persist filter result into the document meta (never overwrites other meta keys). */
export function saveFilterStage(db, doc, { pass, reason, filterStage }) {
  const meta = { ...(typeof doc.meta === 'object' && doc.meta ? doc.meta : {}) };
  meta.filter_stage = filterStage;
  meta.filter_pass = !!pass;
  meta.filter_reason = reason || '';
  db.prepare('UPDATE intel_documents SET meta = ? WHERE id = ?').run(JSON.stringify(meta), doc.id);
}

// ---------------- L1: profile relevance (rules first, LLM only in gray zone) ----------------

/** Hand-written schema check for the L1 LLM verdict. Returns error string or null. */
export function validateRelevanceVerdict(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 'not an object';
  const score = Number(obj.score);
  if (!Number.isFinite(score) || score < 0 || score > 100) return 'score must be a number in [0,100]';
  if (typeof obj.reason !== 'string' || !obj.reason.trim()) return 'reason must be a non-empty string';
  if (obj.matched !== undefined && !Array.isArray(obj.matched)) return 'matched must be an array when present';
  return null;
}

/**
 * LLM fine judgement for gray-zone documents. Mirrors analysis.js stream + extractJson +
 * hand-written validation style. One retry, then falls back to the rule score.
 */
export async function llmRelevanceCheck({ llm, provider, model, doc, ruleResult, signal, db = null, timeZone = 'Asia/Shanghai' }) {
  const content = String(doc.raw_content || doc.summary || '').slice(0, 3000);
  const text =
    `判断以下文档与用户兴趣画像的相关度，只输出一个 JSON 对象：\n` +
    `{"score": 0-100 整数, "reason": "不超过80字的判断理由", "matched": ["命中的兴趣/项目/问题"]}\n` +
    `画像长期兴趣：${(ruleResult.matched_goals || []).join('、') || '（未命中）'}\n` +
    `规则初判分数：${ruleResult.relevance_score}（灰区，请精判）\n` +
    `标题：${doc.title}\n正文：\n${content}`;
  const messages = [{ id: 'l1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'dsh-intelligence-hub' } }];
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = await streamText(llm, {
        provider,
        model,
        messages,
        system: '你是情报筛选助手，只输出符合 schema 的 JSON。',
        temperature: 0.2,
        maxTokens: 300,
        signal,
      });
      if (db) recordUsage(db, { call: 'l1_relevance', promptChars: messages[0].content[0].text.length, completionChars: out.length, timeZone });
      const obj = extractJson(out);
      const err = validateRelevanceVerdict(obj);
      if (err) {
        lastError = `invalid verdict: ${err}`;
        continue;
      }
      return {
        score: Math.round(Number(obj.score)),
        reason: String(obj.reason).trim(),
        matched: (obj.matched || []).map(String),
        used_llm: true,
      };
    } catch (err) {
      lastError = String(err.message || err);
    }
  }
  return { score: ruleResult.relevance_score, reason: `LLM 精判失败（${lastError.slice(0, 120)}），回退规则分`, matched: [], used_llm: false, fallback: true };
}

/**
 * Full L1: rule match against the profile; LLM only when rule score is in the
 * 40-75 gray zone and an llm capability is provided.
 */
export async function l1Relevance(db, doc, { llm, provider, model, profile, tokenBudgetPerDay = 0, timeZone = 'Asia/Shanghai' } = {}) {
  const { getMatchableProfile } = await import('./profile.js');
  const p = profile || getProfile(db) || { long_term_interests: [], current_projects: [], learning_goals: [], content_preferences: { deprioritize: [] } };
  const { keywordSets } = getMatchableProfileFrom(p);
  const ruleMatch = matchProfile(keywordSets, p, doc);
  if (!ruleMatch.gray_zone || typeof llm?.stream !== 'function') {
    return { ...ruleMatch, used_llm: false };
  }
  // Daily token budget: over budget -> rule score fallback (existing fallback path).
  if (!withinBudget(db, { tokenBudgetPerDay }, { timeZone }).allowed) {
    return { ...ruleMatch, used_llm: false, llm_fallback: true, reason: `${ruleMatch.reason}；当日 token 预算已用尽，回退规则分` };
  }
  const verdict = await llmRelevanceCheck({ llm, provider, model, doc, ruleResult: ruleMatch, db, timeZone });
  return {
    ...ruleMatch,
    relevance_score: verdict.score,
    reason: `${ruleMatch.reason}；LLM 精判：${verdict.reason}`,
    matched_goals: [...new Set([...ruleMatch.matched_goals, ...verdict.matched])],
    used_llm: verdict.used_llm,
    llm_fallback: !!verdict.fallback,
  };
}

/** Build matchable keyword sets from a profile object (or an empty stub). */
function getMatchableProfileFrom(profile) {
  const p = profile || { long_term_interests: [], current_projects: [], learning_goals: [], content_preferences: { deprioritize: [] } };
  const keywordSets = (p.long_term_interests || []).map((interest) => {
    const key = String(interest).toLowerCase().trim();
    return { interest: String(interest), terms: [key, ...(SYNONYMS[key] || [])] };
  });
  return { profile: p, keywordSets };
}

// ---------------- L2: knowledge delta vs already-collected documents ----------------

function tokenSet(text) {
  return new Set(bigramize(String(text || '')).split(' ').filter(Boolean));
}

function setJaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function analysisOf(doc) {
  if (!doc.analysis) return null;
  try {
    return typeof doc.analysis === 'string' ? JSON.parse(doc.analysis) : doc.analysis;
  } catch {
    return null;
  }
}

export const NOVELTY_UNKNOWN = 50;

/**
 * Compare one document against already-collected prior documents:
 * same-event document count, title/body bigram overlap, innovation-keyword overlap.
 * Returns { novelty_score, novelty_state: 'KNOWN'|'PARTIAL'|'UNKNOWN', known_before, new_findings, is_new, verification_status }.
 * 当无法确认（库中无可比文档且内容过短）时 novelty 用中位数 50 并标 UNKNOWN；
 * 绝不把推断当已验证事实 —— verification_status 恒为 'UNVERIFIED'。
 */
export function l2Novelty(db, doc) {
  const docTokens = tokenSet(`${doc.title} ${doc.summary} ${doc.raw_content}`);
  const short = docTokens.size < 10;

  // same-event existing documents (excluding this one)
  const eventMates = db
    .prepare(
      `SELECT d.id, d.title, d.source_type FROM intel_document_events de JOIN intel_documents d ON d.id = de.document_id
       WHERE de.document_id = ? AND d.id != ?`
    )
    .all(doc.id, doc.id);

  const prior = db
    .prepare('SELECT id, title, analysis, search_text FROM intel_documents WHERE id != ? ORDER BY fetched_at DESC LIMIT 200')
    .all(doc.id);

  let maxOverlap = 0;
  const knownBefore = [];
  const docInnov = analysisOf(doc);
  const docInnovTerms = new Set(tokenSet((docInnov?.innovation || []).join(' ')));
  let innovOverlap = 0;
  for (const p of prior) {
    const pTokens = new Set(String(p.search_text || '').split(' ').filter(Boolean));
    const ov = setJaccard(docTokens, pTokens);
    if (ov > 0.3) {
      knownBefore.push({ id: p.id, title: p.title, overlap: Math.round(ov * 100) / 100 });
    }
    if (ov > maxOverlap) maxOverlap = ov;
    const pInnov = analysisOf(p);
    if (docInnovTerms.size && pInnov?.innovation?.length) {
      const pTerms = tokenSet(pInnov.innovation.join(' '));
      const io = setJaccard(docInnovTerms, pTerms);
      if (io > innovOverlap) innovOverlap = io;
    }
  }

  // Too little content to judge against the corpus -> median 50 + UNKNOWN (推断不当已验证).
  if (short) {
    return {
      novelty_score: NOVELTY_UNKNOWN,
      novelty_state: 'UNKNOWN',
      known_before: [],
      new_findings: extractNewFindings(doc),
      is_new: false,
      verification_status: 'UNVERIFIED',
      evidence_ids: [],
      unknown_reason: '无可比对的已收录文档且内容过短，无法确认 novelty（取中位数 50）',
    };
  }

  let novelty = 100;
  novelty -= Math.min(40, Math.max(0, eventMates.length) * 12);
  novelty -= Math.round(maxOverlap * 45);
  novelty -= Math.round(innovOverlap * 15);
  novelty = Math.max(0, Math.min(100, novelty));

  const state = novelty >= 70 ? 'KNOWN-NOVEL' : novelty >= 40 ? 'PARTIAL' : 'KNOWN';
  return {
    novelty_score: novelty,
    novelty_state: state,
    known_before: knownBefore.slice(0, 5).map((k) => ({ id: k.id, title: k.title })),
    new_findings: extractNewFindings(doc),
    is_new: novelty >= 60 && knownBefore.length === 0,
    verification_status: 'UNVERIFIED',
    evidence_ids: knownBefore.slice(0, 5).map((k) => k.id),
  };
}

/** Extract new findings from content + stored LLM analysis (evidence, not verified facts). */
export function extractNewFindings(doc) {
  const out = [];
  const a = analysisOf(doc);
  if (a?.innovation?.length) out.push(...a.innovation.slice(0, 3).map((s) => `[analysis] ${String(s).slice(0, 120)}`));
  const summary = String(doc.summary || doc.raw_content || '').replace(/\s+/g, ' ').trim();
  if (summary) {
    for (const s of summary.split(/(?<=[。.!?！？])\s*/).filter((x) => x.length > 20).slice(0, 2)) {
      out.push(`[content] ${s.slice(0, 120)}`);
    }
  }
  return out.slice(0, 4);
}

// ---------------- L3: total score + Research Gate ----------------

/** P — practical value heuristics (0-100). */
export function practicalValue(doc) {
  const body = String(doc.raw_content || doc.summary || '');
  const text = `${doc.title || ''} ${body}`.toLowerCase();
  let score = 10;
  if (/```|\bcode\b|implementation|实现|示例代码/.test(body)) score += 30;
  if (/github\.com/.test(String(doc.url || '')) || /\brepo\b|开源/.test(text)) score += 25;
  if (/tutorial|guide|how.?to|教程|实战|walkthrough/.test(text)) score += 20;
  if (/benchmark|eval|dataset|评测|数据集/.test(text)) score += 15;
  if (/api\b|sdk|集成|integration/.test(text)) score += 10;
  return Math.min(100, score);
}

/** E — evidence quality by source type (0-100). */
export function evidenceQuality(doc) {
  const type = String(doc.source_type || '');
  const url = String(doc.url || '');
  if (type === 'arxiv' || /arxiv\.org|doi\.org/.test(url)) return 90; // paper
  if (type === 'github') return 80; // primary repo/release
  if (/\/docs|\/api|developers\./.test(url)) return 75; // official API/docs
  if (/\.gov|\.edu|openai\.com|anthropic\.com|deepseek\.com|modelcontextprotocol\.io/.test(url)) return 70; // official blog
  if (type === 'rss') return 50; // community
  return 40; // aggregator/unknown
}

/** Feedback-driven source quality adjustment (bad_source penalties / keep recoveries), <= 0 offset. */
export function sourceQualityAdjust(db, sourceId) {
  if (!sourceId) return 0;
  try {
    return db.prepare('SELECT quality_adjust FROM intel_sources WHERE id = ?').get(Number(sourceId))?.quality_adjust || 0;
  } catch {
    return 0;
  }
}

/** Effective E = clamp(base + sourceAdjust, 30, base): penalties floor at 30, recovery cannot exceed the original base. */
export function effectiveEvidenceQuality(db, doc) {
  const base = evidenceQuality(doc);
  const adjusted = base + sourceQualityAdjust(db, doc.source_id);
  return Math.max(30, Math.min(base, adjusted));
}

const IMPORTANCE_RE = /breakthrough|sota|state-of-the-art|benchmark|record|重大|突破|首个|first|milestone|release|发布/i;

/** T — timeliness: publish freshness (0-85) + importance keywords (up to +15). */
export function timeliness(doc, { now = new Date() } = {}) {
  let fresh = 20;
  if (doc.published_at) {
    const ageDays = Math.max(0, (now.getTime() - Date.parse(doc.published_at)) / 86400000);
    fresh = ageDays <= 1 ? 85 : ageDays <= 3 ? 70 : ageDays <= 7 ? 55 : ageDays <= 30 ? 35 : Math.max(5, 25 - ageDays / 10);
  }
  const boost = IMPORTANCE_RE.test(`${doc.title || ''} ${doc.summary || ''}`) ? 15 : 0;
  return Math.min(100, Math.round(fresh + boost));
}

/** Weighted total: V = 0.30R + 0.25N + 0.20P + 0.15E + 0.10T (all inputs 0-100). */
export function totalScore({ r, n, p, e, t }) {
  const v = 0.3 * r + 0.25 * n + 0.2 * p + 0.15 * e + 0.1 * t;
  return Math.round(v * 10) / 10;
}

/** Map total to a digest decision using configured thresholds. */
export function decideStage(total, thresholds = DEFAULT_THRESHOLDS) {
  if (total >= thresholds.research) return 'RESEARCH';
  if (total >= thresholds.recommend) return 'RECOMMEND';
  if (total >= thresholds.digest) return 'DIGEST';
  return 'ARCHIVE';
}

export const GATE_DEEP_RESEARCH = 'DEEP_RESEARCH';
export const GATE_WATCHLIST = 'WATCHLIST';

/**
 * Research Gate (triage only). Produces scored candidates + reasons as
 * *suggestions* for the agent (大肥鱼); it never creates RESEARCH_TASK jobs.
 * Whether a candidate becomes a real deep-research run is decided by the agent
 * (via intel_pending_research -> intel_research) or by an explicit user
 * request (status='requested' through webapi.researchTrigger).
 * DEEP_RESEARCH needs score >= research AND enough evidence (>=3 independent
 * sources in the same event, or the doc itself is source code/paper).
 * Below the evidence bar but still valuable -> WATCHLIST (status watching).
 * Neither -> no candidate ({ decision: 'ARCHIVE' }).
 */
export function researchGate(db, doc, total, { thresholds = DEFAULT_THRESHOLDS, eventDocCount = 0 } = {}) {
  const isPrimaryArtifact = doc.source_type === 'arxiv' || doc.source_type === 'github';
  const enoughEvidence = eventDocCount >= 3 || isPrimaryArtifact;
  if (total >= thresholds.research && enoughEvidence) {
    return { decision: GATE_DEEP_RESEARCH, status: 'queued', reason: `total=${total} ≥ research=${thresholds.research} 且证据充足（事件来源 ${eventDocCount} 个${isPrimaryArtifact ? '；含源码/论文' : ''}）` };
  }
  if (total >= thresholds.research && !enoughEvidence) {
    return { decision: GATE_WATCHLIST, status: 'watching', reason: `total=${total} 达 research 线但证据不足（独立来源 ${eventDocCount} < 3），转 WATCHLIST 等待新证据` };
  }
  if (total >= thresholds.digest) {
    return { decision: GATE_WATCHLIST, status: 'watching', reason: `total=${total} 有价值但未达 research=${thresholds.research}，转 WATCHLIST` };
  }
  return { decision: 'ARCHIVE', status: '', reason: `total=${total} 低于 digest=${thresholds.digest}，不建研究候选` };
}

export function saveGateCandidate(db, { doc, gate, eventId }) {
  const topic = String(doc.title || doc.url || 'untitled').slice(0, 120);
  db.prepare('INSERT OR IGNORE INTO intel_research_candidates (topic, decision, reason, evidence_ids, document_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(topic, gate.decision, gate.reason, JSON.stringify(eventId ? [eventId] : []), doc.id, gate.status || 'watching', new Date().toISOString());
}

/** Candidate status: explicitly requested by the user / panel (handed to the agent). */
export const CANDIDATE_REQUESTED = 'requested';
/** Candidate status: the agent finished a deep-research run on this topic. */
export const CANDIDATE_DONE = 'done';

/**
 * Upsert one 'requested' candidate (user / panel asked for deep research).
 * Matches an existing candidate by topic (any document_id) so repeated clicks
 * do not spawn duplicate rows. Returns { id, updated }.
 */
export function requestResearchCandidate(db, { topic, documentId = null, reason, decision = GATE_DEEP_RESEARCH }) {
  const t = String(topic || '').slice(0, 120);
  const existing = db.prepare('SELECT id FROM intel_research_candidates WHERE topic = ? ORDER BY id LIMIT 1').get(t);
  const now = new Date().toISOString();
  if (existing) {
    db.prepare('UPDATE intel_research_candidates SET status = ?, reason = ?, created_at = ? WHERE id = ?')
      .run(CANDIDATE_REQUESTED, String(reason || ''), now, existing.id);
    return { id: existing.id, updated: true };
  }
  const r = db.prepare('INSERT INTO intel_research_candidates (topic, decision, reason, evidence_ids, document_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(t, String(decision || GATE_DEEP_RESEARCH), String(reason || ''), JSON.stringify([]), documentId ?? null, CANDIDATE_REQUESTED, now);
  return { id: Number(r.lastInsertRowid), updated: false };
}

/** List candidates explicitly requested by the user (status='requested'), newest first. */
export function listRequestedResearch(db, { limit = 20 } = {}) {
  return db.prepare(
    `SELECT c.id, c.topic, c.decision, c.reason, c.document_id, c.created_at,
            d.title AS document_title, d.url AS document_url, d.source_type AS document_source_type
     FROM intel_research_candidates c
     LEFT JOIN intel_documents d ON d.id = c.document_id
     WHERE c.status = 'requested'
     ORDER BY c.created_at DESC, c.id DESC LIMIT ?`
  ).all(Math.max(1, Math.min(100, Number(limit) || 20)));
}

/** After a RESEARCH_TASK on this topic COMPLETED, flip its pending candidates to 'done'. */
export function completeResearchCandidates(db, topic) {
  const t = String(topic || '').slice(0, 120);
  if (!t) return { updated: 0 };
  const r = db.prepare("UPDATE intel_research_candidates SET status = 'done' WHERE topic = ? AND status IN ('requested', 'researching')").run(t);
  return { updated: Number(r.changes) || 0 };
}

/** Flip one candidate to 'done' by id (RESEARCH_TASK COMPLETED for a refined topic). */
export function completeResearchCandidateById(db, id) {
  const r = db.prepare("UPDATE intel_research_candidates SET status = 'done' WHERE id = ? AND status IN ('requested', 'researching', 'deferred')").run(Number(id) || 0);
  return { updated: Number(r.changes) || 0 };
}

// ---------------- Pipeline orchestration ----------------

function docsOnDateUnfiltered(db, { start, end }) {
  return db
    .prepare('SELECT * FROM intel_documents WHERE fetched_at >= ? AND fetched_at < ? ORDER BY id')
    .all(start, end);
}

function hasFilterStage(doc) {
  try {
    return !!JSON.parse(doc.meta || '{}').filter_stage;
  } catch {
    return false;
  }
}

/**
 * PIPELINE_RUN execution.
 * phase 'L0' (morning slot): L0 filters + event clustering for the day's new docs.
 * phase 'FULL' (noon slot): remaining unscored docs of the day through L1 -> L3 + Gate,
 * primary recommendation per event, exploratory 5% sampling.
 * Pass llm/provider/model only when analysisEnabled; without llm the gray zone falls back to rule scores.
 */
export async function runPipeline(db, {
  phase = 'FULL',
  dateStr,
  timeZone = 'Asia/Shanghai',
  config = {},
  llm = null,
  provider = '',
  model = '',
  rng = Math.random,
  now = new Date(),
} = {}) {
  const day = dateStr || localParts(now, timeZone).date;
  const { start, end } = localDayBounds(day, timeZone);
  const thresholds = resolveThresholds(config);
  const summary = { date: day, phase, thresholds, l0: { filtered: 0, passed: 0 }, clustered: 0, scored: [], candidates: [], events: [] };

  if (phase === 'L0') {
    // Only process documents that have not been L0-filtered yet (idempotent
    // re-entry; keeps the L0 selection in sync with the set the scoring phase
    // will later see — previously every slot re-filtered ALL docs of the day,
    // double-counting passed/filtered totals across slots).
    const docs = docsOnDateUnfiltered(db, { start, end }).filter((doc) => !hasFilterStage(doc));
    let clustered = 0;
    for (const doc of docs) {
      const f = l0Filter(db, doc, { now });
      saveFilterStage(db, doc, f);
      f.pass ? summary.l0.passed++ : summary.l0.filtered++;
      if (f.pass) {
        assignDocumentToEvent(db, doc, { now: now.toISOString() });
        clustered++;
      }
    }
    summary.clustered = clustered;
    return summary;
  }

  // FULL: make sure everything is filtered + clustered first (idempotent re-entry).
  for (const doc of docsOnDateUnfiltered(db, { start, end })) {
    let metaObj = {};
    try { metaObj = JSON.parse(doc.meta || '{}'); } catch {}
    if (!metaObj.filter_stage) {
      const f = l0Filter(db, doc, { now });
      saveFilterStage(db, doc, f);
      f.pass ? summary.l0.passed++ : summary.l0.filtered++;
    }
    const linked = db.prepare('SELECT 1 AS x FROM intel_document_events WHERE document_id = ?').get(doc.id);
    if (!linked) {
      assignDocumentToEvent(db, doc, { now: now.toISOString() });
      summary.clustered++;
    }
  }

  // Score docs of the day that have no L3 row yet.
  const pending = db
    .prepare(
      `SELECT d.* FROM intel_documents d
       WHERE d.fetched_at >= ? AND d.fetched_at < ?
         AND NOT EXISTS (SELECT 1 FROM intel_scores s WHERE s.document_id = d.id)
       ORDER BY d.id`
    )
    .all(start, end);

  const profile = getProfile(db);
  for (const doc of pending) {
    const f = l0Filter(db, doc, { now });
    if (!f.pass) {
      saveFilterStage(db, doc, f);
      saveDocScore(db, {
        documentId: doc.id, r: 0, n: 0, p: 0, e: 0, t: 0, total: 0, stage: 'L0', decision: 'ARCHIVE',
        exploratory: false, filterStage: f.filterStage, filterReason: f.reason, createdAt: now.toISOString(), rankingVersion: RANKING_VERSION,
      });
      summary.scored.push({ id: doc.id, title: doc.title, total: 0, decision: 'ARCHIVE', filtered_at: f.reason });
      continue;
    }

    const l1 = await l1Relevance(db, doc, {
      llm: config.analysisEnabled ? llm : null,
      provider, model, profile,
      tokenBudgetPerDay: Number(config.tokenBudgetPerDay) || 0,
      timeZone,
    });
    const l2 = l2Novelty(db, doc);
    const p = practicalValue(doc);
    const e = effectiveEvidenceQuality(db, doc);
    const t = timeliness(doc, { now });
    const total = totalScore({ r: l1.relevance_score, n: l2.novelty_score, p, e, t });
    const decision = decideStage(total, thresholds);

    const mates = db.prepare('SELECT COUNT(*) AS n FROM intel_document_events de WHERE de.event_id = (SELECT event_id FROM intel_document_events WHERE document_id = ?) AND de.document_id != ?').get(doc.id, doc.id);
    const gate = researchGate(db, doc, total, { thresholds, eventDocCount: (mates?.n || 0) + 1 });
    if (gate.decision === GATE_DEEP_RESEARCH || gate.decision === GATE_WATCHLIST) {
      saveGateCandidate(db, { doc, gate, eventId: (db.prepare('SELECT event_id FROM intel_document_events WHERE document_id = ?').get(doc.id) || {}).event_id });
      summary.candidates.push({ id: doc.id, topic: doc.title, decision: gate.decision, reason: gate.reason });
    }

    saveKnowledgeDelta(db, {
      documentId: doc.id,
      noveltyScore: l2.novelty_score,
      noveltyState: l2.novelty_state,
      scores: { r: l1.relevance_score, p, e, t, total },
      knownBefore: l2.known_before,
      newFindings: l2.new_findings,
      evidenceIds: l2.evidence_ids,
      createdAt: now.toISOString(),
      rankingVersion: RANKING_VERSION,
    });
    saveDocScore(db, {
      documentId: doc.id, r: l1.relevance_score, n: l2.novelty_score, p, e, t, total,
      stage: 'L3', decision, exploratory: false, filterStage: '', filterReason: '',
      createdAt: now.toISOString(), rankingVersion: RANKING_VERSION,
    });
    summary.scored.push({
      id: doc.id,
      title: doc.title,
      r: l1.relevance_score,
      n: l2.novelty_score,
      p, e, t,
      total,
      decision,
      gate: gate.decision,
      reason: l1.reason,
      used_llm: l1.used_llm,
      is_new: l2.is_new,
      verification_status: l2.verification_status,
    });
  }

  // One primary recommendation per event (daily report layer), other sources stay linked.
  const events = eventsOnDate(db, start, end);
  const scoresById = new Map(summary.scored.map((s) => [s.id, s.total]));
  for (const ev of events) {
    const primary = electPrimaryDocument(db, ev.event_id, scoresById);
    summary.events.push({ event_id: ev.event_id, title: ev.event_title, docs: ev.doc_count, primary: primary ? { id: primary.id, title: primary.title } : null });
  }

  // Exploratory 5%: low-score docs get a random chance to enter the digest candidate pool.
  const archiveRows = db
    .prepare(
      `SELECT s.document_id, d.title FROM intel_scores s JOIN intel_documents d ON d.id = s.document_id
       WHERE s.decision = 'ARCHIVE' AND s.exploratory = 0 AND s.stage = 'L3'
         AND d.fetched_at >= ? AND d.fetched_at < ?`
    )
    .all(start, end);
  for (const row of archiveRows) {
    if (rng() < 0.05) {
      db.prepare('UPDATE intel_scores SET exploratory = 1 WHERE document_id = ?').run(row.document_id);
      summary.scored.push({ id: row.document_id, title: row.title, decision: 'ARCHIVE', exploratory: true, reason: '探索性采样（5% 低分文档进入 digest 候选池）' });
    }
  }

  return summary;
}
