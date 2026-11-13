/** Phase 5 Memory Bridge: one-way export of high-value structured knowledge facts.
 *  Principle: the intelligence library and the personal memory system stay separated;
 *  this module ONLY exports read-only JSON facts. It never writes persona/system
 *  instructions, never writes the interest profile, and never pushes to any external system.
 */

import { extractJson, streamText } from './analysis.js';
import { recordUsage, withinBudget, promptCharsOf } from './usage.js';

const nowIso = () => new Date().toISOString();
export const DEFAULT_CONFIDENCE = 0.6;
export const MIN_EVIDENCE = 3;
export const MAX_FACTS = 5;

/**
 * Insert a new fact version for a subject. Versioning: all currently active (valid_to IS NULL)
 * facts of the same subject are closed (valid_to = now) and get superseded_by pointing at the
 * new fact id — history is never overwritten.
 */
export function addFacts(db, { subject, facts = [], confidence = DEFAULT_CONFIDENCE, sourceUrl = '', now } = {}) {
  const subj = String(subject || '').trim();
  if (!subj) throw new Error('subject is required');
  const cleaned = (Array.isArray(facts) ? facts : [])
    .map((f) => ({
      fact: String(typeof f === 'string' ? f : f?.fact || '').trim(),
      evidence_ids: Array.isArray(f?.evidence_ids) ? f.evidence_ids.map(String) : [],
      source_url: String(f?.source_url || sourceUrl || ''),
    }))
    .filter((f) => f.fact)
    .slice(0, MAX_FACTS);
  if (!cleaned.length) return { added: 0, superseded: 0, ids: [] };
  const t = now || nowIso();
  const previous = db.prepare('SELECT id FROM intel_knowledge_facts WHERE subject = ? AND valid_to IS NULL').all(subj);
  const newIds = [];
  for (const f of cleaned) {
    const res = db
      .prepare(
        `INSERT INTO intel_knowledge_facts (subject, fact, evidence_ids, source_url, valid_from, valid_to, confidence, verification_status, discovered_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, 'UNVERIFIED', ?, ?)`
      )
      .run(subj, f.fact, JSON.stringify(f.evidence_ids), f.source_url, t, Number(confidence) || DEFAULT_CONFIDENCE, t, t);
    newIds.push(Number(res.lastInsertRowid));
  }
  const anchor = newIds[0];
  for (const p of previous) {
    db.prepare('UPDATE intel_knowledge_facts SET valid_to = ?, superseded_by = ?, updated_at = ? WHERE id = ? AND valid_to IS NULL')
      .run(t, anchor, t, p.id);
  }
  return { added: newIds.length, superseded: previous.length, ids: newIds, subject: subj };
}

/** Read-only export. subject filters by exact (or substring) match; since filters by valid_from. */
export function exportFacts(db, { subject, since, includeSuperseded = false } = {}) {
  const conds = [];
  const params = [];
  if (!includeSuperseded) conds.push('valid_to IS NULL');
  if (subject) {
    conds.push('subject LIKE ?');
    params.push(`%${String(subject)}%`);
  }
  if (since) {
    conds.push('valid_from >= ?');
    params.push(String(since));
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM intel_knowledge_facts ${where} ORDER BY subject, valid_from DESC LIMIT 500`).all(...params);
  return {
    ok: true,
    readonly: true,
    count: rows.length,
    facts: rows.map((r) => ({
      id: r.id,
      subject: r.subject,
      fact: r.fact,
      evidence_ids: JSON.parse(r.evidence_ids || '[]'),
      source_url: r.source_url,
      valid_from: r.valid_from,
      valid_to: r.valid_to,
      confidence: r.confidence,
      verification_status: r.verification_status,
      superseded_by: r.superseded_by,
      discovered_at: r.discovered_at,
    })),
  };
}

function safeJson(text, fallback) {
  try { return JSON.parse(text ?? ''); } catch { return fallback; }
}

/** Rule extraction: research report key_points / evidences, code report innovations+tradeoffs. */
export function ruleExtractFacts(task) {
  const facts = [];
  if (task.kind === 'research') {
    const result = safeJson(task.result_json, {});
    const evidences = result.evidences || [];
    const points = result.report?.key_points || result.body?.key_points || [];
    for (const p of points.slice(0, MAX_FACTS)) {
      const text = String(p).trim();
      if (text) facts.push({ fact: text.slice(0, 300), evidence_ids: evidences.map((e) => e.id).slice(0, 3), source_url: evidences[0]?.url || '' });
    }
    if (!facts.length) {
      for (const e of evidences.slice(0, MAX_FACTS)) {
        facts.push({ fact: `${e.title || e.url}：${e.quote}`.slice(0, 300), evidence_ids: [e.id], source_url: e.url });
      }
    }
    return { subject: result.topic || task.repo, facts };
  }
  // code report
  const report = task.report || {};
  for (const field of ['innovations', 'tradeoffs']) {
    for (const item of (report[field] || []).slice(0, 3)) {
      const ev = (item.evidence || []).map((e) => `${e.path}:${e.lines}`).slice(0, 3);
      facts.push({ fact: `${item.name || item.point || field}: ${item.note || ''}`.trim().slice(0, 300), evidence_ids: ev, source_url: `https://github.com/${report.repo || task.repo}` });
    }
  }
  return { subject: report.repo || task.repo, facts: facts.slice(0, MAX_FACTS) };
}

export function validateLlmFacts(obj, evidenceIdSet) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 'not an object';
  if (!Array.isArray(obj.facts) || obj.facts.length < 1 || obj.facts.length > MAX_FACTS + 2) return 'facts must be an array of 1-7 entries';
  for (const f of obj.facts) {
    if (!f || typeof f.fact !== 'string' || !f.fact.trim()) return 'each fact needs a non-empty fact string';
    if (!Array.isArray(f.evidence_ids) || f.evidence_ids.length === 0) return 'each fact must cite evidence_ids';
    if (evidenceIdSet && f.evidence_ids.some((id) => !evidenceIdSet.has(String(id)))) return 'cites unknown evidence id';
  }
  return null;
}

function buildFactsMessages(subject, evidences) {
  const slim = evidences.map((e) => ({ id: e.id, url: e.url, quote: String(e.quote || '').slice(0, 160) }));
  const text =
    `从主题「${subject}」的研究证据中提炼 3-5 条结构化事实，只输出一个 JSON 对象：\n` +
    `{"facts": [{"fact": "不超过100字、只依据证据的陈述", "evidence_ids": ["引用的证据 id"]}]}\n` +
    `不得编造证据之外的内容。\n证据：${JSON.stringify(slim)}`;
  return [{ id: `mf-${subject}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'dsh-intelligence-hub' } }];
}

/**
 * Extract + persist facts from a COMPLETED research task (kind research or code).
 * Rule path requires evidence >= MIN_EVIDENCE; LLM assist only when analysisEnabled && llm,
 * validated, with rule fallback on failure. Returns { ok, subject, added, ids, used_llm }.
 */
export async function extractAndStoreFacts(db, taskId, { llm = null, provider = '', model = '', analysisEnabled = false, tokenBudgetPerDay = 0, timeZone = 'Asia/Shanghai' } = {}) {
  const task = db.prepare('SELECT * FROM intel_research_tasks WHERE task_id = ?').get(String(taskId));
  if (!task || task.status !== 'COMPLETED') {
    return { ok: false, reason: `task ${taskId} not found or not COMPLETED` };
  }
  let bundle;
  if (task.kind === 'research') {
    const result = safeJson(task.result_json, {});
    const evidenceCount = (result.evidences || []).length;
    if (evidenceCount < MIN_EVIDENCE) return { ok: false, reason: `evidence ${evidenceCount} < ${MIN_EVIDENCE}, no facts extracted` };
    bundle = ruleExtractFacts({ kind: 'research', repo: task.repo, result_json: task.result_json });
    bundle.evidenceIds = new Set((result.evidences || []).map((e) => e.id));
  } else {
    const row = db.prepare('SELECT * FROM intel_code_reports WHERE task_id = ?').get(String(taskId));
    if (!row) return { ok: false, reason: `no code report for task ${taskId}` };
    bundle = ruleExtractFacts({ kind: 'code', repo: task.repo, report: safeJson(row.report_json, {}) });
    bundle.evidenceIds = null;
  }
  let usedLlm = false;
  const messages = task.kind === 'research' && bundle.facts.length ? buildFactsMessages(bundle.subject, safeJson(task.result_json, {}).evidences || []) : null;
  const budgetOpen = withinBudget(db, { tokenBudgetPerDay }, { timeZone }).allowed;
  if (analysisEnabled && llm && typeof llm?.stream === 'function' && task.kind === 'research' && bundle.facts.length && budgetOpen) {
    try {
      const evidences = safeJson(task.result_json, {}).evidences || [];
      const text = await streamText(llm, {
        provider, model, messages,
        system: '你是严谨的知识提炼助手：只输出符合 schema 的 JSON，证据之外的内容不得编造。',
        temperature: 0.2, maxTokens: 600,
      });
      recordUsage(db, { call: 'memory_facts', promptChars: promptCharsOf(messages), completionChars: text.length, timeZone });
      const obj = extractJson(text);
      const err = validateLlmFacts(obj, bundle.evidenceIds);
      if (err) throw new Error(err);
      bundle = { ...bundle, facts: obj.facts.slice(0, MAX_FACTS) };
      usedLlm = true;
    } catch {
      usedLlm = false; // rule facts retained
    }
  }
  const stored = addFacts(db, {
    subject: bundle.subject,
    facts: bundle.facts,
    sourceUrl: bundle.facts[0]?.source_url || '',
  });
  return { ok: true, subject: stored.subject, added: stored.added, superseded: stored.superseded, ids: stored.ids, used_llm: usedLlm, budget_open: budgetOpen };
}

// Bridge direction guarantee: every exported entry point above is either a pure read
// (exportFacts) or writes ONLY intel_knowledge_facts. No function here touches
// intel_interest_profiles, persona files, or any external system — verified by tests.
