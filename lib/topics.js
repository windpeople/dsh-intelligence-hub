/** V2.0 Phase 2: Topic knowledge base + five-way classification engine.
 *
 *  classifyAgainstTopic compares an incoming document against the topic's stored
 *  knowledge (bigram Jaccard from normalize.js bigramize) plus keyword hits, and
 *  returns one of:
 *    - known         : high overlap, no contradicting/change signals -> nothing written
 *    - supplement    : moderate overlap or keyword affinity -> append a new knowledge row
 *    - new           : no comparable knowledge at all -> append a new knowledge row
 *    - conflict      : high overlap BUT negation / number-difference signals -> supersede old
 *    - major_change  : high overlap AND importance signals -> supersede old
 *
 *  Rule-based only in this phase; an async LLM judge hook (`llmJudge`) can refine
 *  conflict/major_change verdicts later without changing storage semantics.
 */

import { bigramize } from './normalize.js';

export const KNOWLEDGE_SECTIONS = ['timeline', 'architecture', 'papers', 'implementations', 'pros_cons', 'open_questions'];
export const CHANGE_KINDS = ['known', 'supplement', 'new', 'conflict', 'major_change'];

export const SIM_SUPPLEMENT = 0.15; // below this + no keyword hit => brand new
export const SIM_HIGH = 0.6;       // at/above this with signals => conflict / major_change

const nowIso = () => new Date().toISOString();

/** Default six topics seeded idempotently after migration v7. */
export const DEFAULT_TOPICS = [
  { name: 'Agent 架构', description: '智能体整体架构：规划、工具使用、反思、编排框架。', keywords: ['agent', 'agentic', '智能体', 'planning', 'tool use', 'orchestration', 'react', 'reflection'] },
  { name: '长期记忆', description: '智能体长期记忆：RAG、记忆机制、检索增强、知识库。', keywords: ['memory', 'rag', 'retrieval', '长期记忆', '记忆机制', '向量', '知识库', 'embedding'] },
  { name: 'MCP · A2A', description: '模型上下文协议与智能体互操作协议。', keywords: ['mcp', 'model context protocol', 'a2a', 'agent2agent', '协议', '工具调用', 'function calling'] },
  { name: '多智能体协作', description: '多智能体系统：协作、通信、分工与群体行为。', keywords: ['multi-agent', 'multi agent', '多智能体', '协作', 'swarm', '通信', 'debate'] },
  { name: 'LLM 推理', description: '大模型推理能力：思维链、推理时计算、评测。', keywords: ['reasoning', 'inference', 'cot', 'chain-of-thought', '推理', '思维链', 'test-time compute', '数学'] },
  { name: 'Agent 安全治理', description: '智能体安全与治理：越狱、注入、护栏、对齐。', keywords: ['safety', 'security', 'guardrail', '安全', '治理', '越狱', 'prompt injection', '对齐', 'red team'] },
];

// ---------------- topic CRUD ----------------

export function ensureTopic(db, { name, keywords = [], description = '', status = 'active', now } = {}) {
  const n = String(name || '').trim();
  if (!n) throw new Error('topic name is required');
  const t = now || nowIso();
  const existing = db.prepare('SELECT id FROM intel_topics WHERE name = ?').get(n);
  if (existing) return { id: existing.id, created: false, name: n };
  const res = db
    .prepare('INSERT INTO intel_topics (name, description, keywords, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(n, String(description || ''), JSON.stringify(keywords || []), String(status || 'active'), t, t);
  return { id: Number(res.lastInsertRowid), created: true, name: n };
}

/** Idempotent seed. Returns [{ id, name, created }]. */
export function ensureTopics(db, seeds = DEFAULT_TOPICS, now) {
  const out = [];
  for (const s of seeds) {
    out.push(ensureTopic(db, { ...s, now }));
  }
  return out;
}

export function listTopics(db, { status } = {}) {
  const where = status ? 'WHERE status = ?' : '';
  const rows = db.prepare(`SELECT * FROM intel_topics ${where} ORDER BY id`).all(...(status ? [status] : []));
  return rows.map((r) => {
    let keywords = [];
    try { keywords = JSON.parse(r.keywords || '[]'); } catch {}
    return { ...r, keywords };
  });
}

export function getTopic(db, topicId) {
  const row = db.prepare('SELECT * FROM intel_topics WHERE id = ?').get(Number(topicId));
  if (!row) return null;
  let keywords = [];
  try { keywords = JSON.parse(row.keywords || '[]'); } catch {}
  return { ...row, keywords };
}

/**
 * Per-topic progress: knowledge counts per section + COMPLETED deep-research tasks.
 * For kind='research' tasks the topic is carried in the repo column (see lib/research.js).
 */
export function topicProgress(db) {
  return listTopics(db, { status: 'active' }).map((t) => {
    const knowledge = db
      .prepare("SELECT section, COUNT(*) AS n FROM intel_topic_knowledge WHERE topic_id = ? AND status = 'active' GROUP BY section")
      .all(t.id);
    const sections = Object.fromEntries(KNOWLEDGE_SECTIONS.map((s) => [s, 0]));
    let knowledgeCount = 0;
    for (const k of knowledge) {
      if (sections[k.section] === undefined) sections[k.section] = 0;
      sections[k.section] = k.n;
      knowledgeCount += k.n;
    }
    let completedResearch = 0;
    try {
      completedResearch = db
        .prepare(
          `SELECT COUNT(*) AS n FROM intel_research_tasks
           WHERE kind = 'research' AND status = 'COMPLETED' AND repo = ?`
        )
        .get(t.name).n;
    } catch { /* research table missing: ignore */ }
    return { id: t.id, name: t.name, description: t.description, knowledge_count: knowledgeCount, sections, completed_research: completedResearch };
  });
}

// ---------------- similarity helpers ----------------

function tokenSet(text) {
  return new Set(bigramize(String(text || '')).split(' ').filter(Boolean));
}

export function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function docTextOf(doc) {
  return `${doc?.title || ''} ${doc?.summary || ''} ${doc?.raw_content || ''}`;
}

/** Best-effort section routing when a classification carries no matched section. */
export function sectionForDoc(doc) {
  const type = String(doc?.source_type || '');
  const url = String(doc?.url || '');
  if (type === 'arxiv' || /arxiv\.org/.test(url)) return 'papers';
  if (type === 'github' || /github\.com/.test(url)) return 'implementations';
  return 'timeline';
}

// ---------------- signal detection (rules only; LLM hook optional) ----------------

const NEGATION_RE = /\bnot\b|\bno\b|\bnever\b|\bfails?\b|\bfailures?\b|\bcannot\b|\bwithout\b|无法|不能|并非|不是|不适|不会|没有|失败|无效/;

const MAJOR_RE = /breakthrough|sota|state-of-the-art|record|milestone|outperform|first\b|重大|突破|首个|首次|显著|数量级/;

function numbersIn(text) {
  return String(text || '').match(/\d+(?:\.\d+)?/g) || [];
}

/** Do old and new content disagree on numbers (a number present in one and absent in the other)? */
function numberDifference(oldText, newText) {
  const a = new Set(numbersIn(oldText));
  const b = new Set(numbersIn(newText));
  if (a.size === 0 && b.size === 0) return false;
  let shared = 0;
  for (const x of b) if (a.has(x)) shared++;
  const sim = a.size + b.size === 0 ? 1 : (2 * shared) / (a.size + b.size);
  return sim < 0.5; // less than half the numbers agree -> likely different figures
}

/**
 * Rule-based signal check for a high-similarity pair. Returns { conflict, major_change, signals[] }.
 */
export function changeSignals(oldContent, newContent) {
  const signals = [];
  const oldNeg = NEGATION_RE.test(String(oldContent || ''));
  const newNeg = NEGATION_RE.test(String(newContent || ''));
  const negationMismatch = oldNeg !== newNeg;
  if (negationMismatch) signals.push('negation-mismatch');
  const numDiff = numberDifference(oldContent, newContent);
  if (numDiff) signals.push('number-difference');
  const major = MAJOR_RE.test(String(newContent || ''));
  if (major) signals.push('major-signal');
  return {
    conflict: negationMismatch || numDiff,
    major_change: !negationMismatch && !numDiff && major,
    signals,
  };
}

/**
 * Classify `doc` against the active knowledge of topic `topicId`.
 * Options: { llmJudge?: async (ctx) => kind|null, simSupplement?, simHigh? }
 * Returns { kind, matched_sections, best_similarity, matched_knowledge_ids, keyword_hits, reason, signals }.
 */
export async function classifyAgainstTopic(db, topicId, doc, { llmJudge = null, simSupplement = SIM_SUPPLEMENT, simHigh = SIM_HIGH } = {}) {
  const topic = getTopic(db, topicId);
  if (!topic) throw new Error(`topic ${topicId} not found`);
  const text = String(doc?.title || '') + ' ' + String(doc?.summary || '') + ' ' + String(doc?.raw_content || '');
  const lower = text.toLowerCase();
  const keywordHits = (topic.keywords || []).filter((k) => lower.includes(String(k).toLowerCase()));

  const rows = db
    .prepare("SELECT * FROM intel_topic_knowledge WHERE topic_id = ? AND status = 'active'")
    .all(Number(topicId));
  // Similarity is computed on body text only (summary + raw_content vs stored content);
  // titles differ too much across sources and would dilute the bigram overlap.
  const docTokens = tokenSet(`${doc?.summary || ''} ${doc?.raw_content || ''}`);

  const bestBySection = new Map(); // section -> { sim, row }
  for (const row of rows) {
    const sim = jaccard(docTokens, tokenSet(row.content));
    const cur = bestBySection.get(row.section);
    if (!cur || sim > cur.sim) bestBySection.set(row.section, { sim, row });
  }
  const matched = [...bestBySection.entries()]
    .filter(([, v]) => v.sim >= simSupplement)
    .sort((a, b) => b[1].sim - a[1].sim);
  const best = matched[0]?.[1] || null;
  const bestSim = best ? best.sim : 0;

  let kind;
  const reasonParts = [];
  if (!rows.length || (!best && keywordHits.length === 0)) {
    kind = 'new';
    reasonParts.push(rows.length ? '与专题既有知识重叠低且未命中关键词' : '专题知识库为空');
  } else if (!best) {
    kind = 'supplement';
    reasonParts.push(`未达相似度阈值但命中专题关键词 ${keywordHits.slice(0, 3).join('、')}`);
  } else if (bestSim < simHigh) {
    kind = 'supplement';
    reasonParts.push(`与既有知识相似度 ${Math.round(bestSim * 100)}%（中等，可补充）`);
  } else {
    const sig = changeSignals(best.row.content, text);
    if (sig.conflict) {
      kind = 'conflict';
      reasonParts.push(`高相似（${Math.round(bestSim * 100)}%）但存在矛盾信号：${sig.signals.join('、')}`);
    } else if (sig.major_change) {
      kind = 'major_change';
      reasonParts.push(`高相似（${Math.round(bestSim * 100)}%）且含重大变化信号词`);
    } else {
      kind = 'known';
      reasonParts.push(`与既有知识高相似（${Math.round(bestSim * 100)}%）且无矛盾/变化信号`);
    }
  }

  // LLM enhancement hook: may refine conflict/major_change/known verdicts.
  // Returns a valid kind or null to keep the rule verdict. Failures keep the rule result.
  if (llmJudge && typeof llmJudge === 'function' && (kind === 'conflict' || kind === 'major_change' || kind === 'known')) {
    try {
      const refined = await llmJudge({
        topic: topic.name, kind, similarity: bestSim,
        old_content: best ? best.row.content : '', new_content: text,
      });
      if (CHANGE_KINDS.includes(refined)) {
        kind = refined;
        reasonParts.push(`LLM 复核改为 ${refined}`);
      }
    } catch { /* hook failures never break the rule path */ }
  }

  return {
    kind,
    matched_sections: matched.map(([s]) => s),
    best_similarity: Math.round(bestSim * 100) / 100,
    matched_knowledge_ids: best ? [best.row.id] : [],
    keyword_hits: keywordHits,
    reason: reasonParts.join('；'),
    signals: best ? changeSignals(best.row.content, text).signals : [],
  };
}

// ---------------- apply ----------------

function normalizeEvidence(db, evidence) {
  let ids = [];
  if (Array.isArray(evidence)) ids = evidence;
  else if (typeof evidence === 'number' || typeof evidence === 'string') ids = [evidence];
  else if (evidence && Array.isArray(evidence.documentIds)) ids = evidence.documentIds;
  else if (evidence && evidence.documentId !== undefined && evidence.documentId !== null) ids = [evidence.documentId];
  ids = [...new Set(ids.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0))];
  if (!ids.length) throw new Error('evidence required: at least one document id');
  for (const id of ids) {
    if (!db.prepare('SELECT id FROM intel_documents WHERE id = ?').get(id)) {
      throw new Error(`evidence document ${id} not found in intel_documents`);
    }
  }
  return ids;
}

/**
 * Write the classified document into the topic knowledge base inside one transaction.
 *  known -> nothing written; supplement/new -> new active row + revision;
 *  conflict/major_change -> new active row, best-matched old rows superseded + revision(prev,new).
 * `evidence` is a document id, an array of ids, or { documentIds }. Evidence ids are
 * validated against intel_documents BEFORE any write; a missing id throws and the
 * transaction rolls back (zero partial state).
 */
export function applyToTopicKnowledge(db, topicId, doc, classification, evidence, { section, now } = {}) {
  const evidenceIds = normalizeEvidence(db, evidence); // throws before BEGIN when missing
  const kind = classification?.kind;
  if (!CHANGE_KINDS.includes(kind)) throw new Error(`invalid classification kind: ${kind}`);
  const t = now || nowIso();
  const sec = String(section || (classification.matched_sections?.[0]) || sectionForDoc(doc));
  const content = String(doc?.summary || doc?.raw_content || doc?.title || '').trim() || String(doc?.title || '');
  if (!content) throw new Error('document has no content to store');

  const supersededIds = [];
  db.exec('BEGIN');
  try {
    if (kind === 'conflict' || kind === 'major_change') {
      // Supersede the rows the classification matched against.
      for (const kid of classification.matched_knowledge_ids || []) {
        const r = db
          .prepare("UPDATE intel_topic_knowledge SET status = 'superseded' WHERE id = ? AND topic_id = ? AND status = 'active'")
          .run(Number(kid), Number(topicId));
        if (Number(r.changes) > 0) supersededIds.push(Number(kid));
      }
    }
    if (kind === 'known') {
      db.exec('ROLLBACK');
      return { written: false, kind, knowledge_id: null, revision_id: null, superseded: [] };
    }
    const res = db
      .prepare(
        "INSERT INTO intel_topic_knowledge (topic_id, section, content, evidence_ids, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)"
      )
      .run(Number(topicId), sec, content, JSON.stringify(evidenceIds), t);
    const knowledgeId = Number(res.lastInsertRowid);
    let prevContent = '';
    if (supersededIds.length) {
      prevContent = db
        .prepare('SELECT content FROM intel_topic_knowledge WHERE id = ?')
        .get(supersededIds[0])?.content || '';
    }
    const rev = db
      .prepare(
        'INSERT INTO intel_topic_knowledge_revisions (knowledge_id, prev_content, new_content, change_kind, change_reason, evidence_ids, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(knowledgeId, prevContent, content, kind, String(classification?.reason || ''), JSON.stringify(evidenceIds), t);
    db.exec('COMMIT');
    return {
      written: true,
      kind,
      knowledge_id: knowledgeId,
      revision_id: Number(rev.lastInsertRowid),
      section: sec,
      superseded: supersededIds,
    };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* not in a transaction */ }
    throw err;
  }
}
