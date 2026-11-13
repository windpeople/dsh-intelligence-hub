/** Learning materials (v5): structured study material generated FROM existing facts —
 *  a completed deep research report, a daily report, or the day's high-scoring documents.
 *  Every generated claim must cite evidence ids (or path:line for code reports); the LLM path
 *  is structurally validated and falls back to a rule template (marked degraded) otherwise.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { extractJson, streamText } from './analysis.js';

const nowIso = () => new Date().toISOString();

/** Collect source facts for a material. Returns { subject, source_type, source_ref, facts, codeReport }. */
export function collectFacts(db, { topic, reportId, taskId } = {}) {
  if (taskId) {
    const task = db.prepare('SELECT * FROM intel_research_tasks WHERE task_id = ?').get(String(taskId));
    if (!task) throw new Error(`unknown task ${taskId}`);
    if (task.kind === 'research') {
      if (task.status !== 'COMPLETED') throw new Error(`research task ${taskId} not COMPLETED (status=${task.status})`);
      const result = JSON.parse(task.result_json || '{}');
      const facts = (result.evidences || []).map((e) => ({ id: e.id, kind: 'evidence', ref: e.url, text: `${e.title || ''}：${e.quote}` }));
      return { subject: result.topic || topic || task.repo, source_type: 'research_task', source_ref: taskId, facts, codeReport: null, degradedSource: result.degraded || result.insufficient_data };
    }
    // code research task: path:line evidence
    const row = db.prepare('SELECT * FROM intel_code_reports WHERE task_id = ?').get(String(taskId));
    if (!row) throw new Error(`no completed code report for task ${taskId}`);
    const report = JSON.parse(row.report_json);
    const facts = [];
    for (const field of ['key_modules', 'call_chains', 'innovations', 'tradeoffs', 'learning_suggestions']) {
      for (const item of report[field] || []) {
        for (const e of item.evidence || []) {
          facts.push({ id: `${field}:${facts.length}`, kind: 'path', ref: `${e.path}:${e.lines}`, text: `${item.name || item.point || field}: ${e.note}` });
        }
      }
    }
    return { subject: topic || report.repo, source_type: 'code_report', source_ref: String(row.id), facts, codeReport: report, degradedSource: false };
  }
  if (reportId) {
    const row = db.prepare('SELECT * FROM intel_reports WHERE id = ?').get(Number(reportId));
    if (!row) throw new Error(`unknown report ${reportId}`);
    const docIds = JSON.parse(row.document_ids || '[]');
    const facts = docIds.map((id, i) => {
      const d = db.prepare('SELECT id, title, url, summary, raw_content FROM intel_documents WHERE id = ?').get(id);
      return d ? { id: `d${i + 1}`, kind: 'document', ref: d.url, text: `${d.title}：${String(d.summary || d.raw_content || '').replace(/\s+/g, ' ').trim().slice(0, 200)}`, document_id: d.id } : null;
    }).filter(Boolean);
    return { subject: topic || row.title, source_type: 'daily_report', source_ref: String(row.id), facts, codeReport: null, degradedSource: false };
  }
  // topic: top-scored documents mentioning it
  const t = String(topic || '').trim();
  if (!t) throw new Error('one of topic / report_id / task_id is required');
  const like = `%${t.replace(/[%_]/g, '')}%`;
  const rows = db
    .prepare(
      `SELECT d.id, d.title, d.url, d.summary, d.raw_content, s.total FROM intel_documents d
       JOIN intel_scores s ON s.document_id = d.id
       WHERE d.title LIKE ? OR d.summary LIKE ? OR d.raw_content LIKE ?
       ORDER BY s.total DESC LIMIT 8`
    )
    .all(like, like, like);
  const facts = rows.map((d, i) => ({ id: `d${i + 1}`, kind: 'document', ref: d.url, text: `${d.title}：${String(d.summary || d.raw_content || '').replace(/\s+/g, ' ').trim().slice(0, 200)}`, document_id: d.id }));
  return { subject: t, source_type: 'topic_docs', source_ref: '', facts, codeReport: null, degradedSource: false };
}

/** Hand-written schema check for LLM learning material. evidence_ids must reference real facts. */
export function validateLearningMaterial(obj, factIds) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 'not an object';
  const idSet = new Set(factIds);
  const arr = (v, name, min = 1) => {
    if (!Array.isArray(v) || v.length < min) return `${name} must be an array with >=${min} items`;
    return null;
  };
  for (const [name, v, min] of [
    ['learning_objectives', obj.learning_objectives, 1],
    ['prerequisites', obj.prerequisites, 1],
    ['practice_tasks', obj.practice_tasks, 3],
    ['common_mistakes', obj.common_mistakes, 1],
    ['interview_questions', obj.interview_questions, 1],
    ['next_directions', obj.next_directions, 1],
  ]) {
    const err = arr(v, name, min);
    if (err) return err;
    if ((name === 'practice_tasks' && v.length > 5) || v.some((x) => typeof x !== 'string' || !x.trim())) return `${name} entries must be strings (practice_tasks 3-5)`;
  }
  const citeOk = (item, name) => {
    const ids = item?.evidence_ids;
    if (!Array.isArray(ids) || ids.length === 0) return `${name} entries must cite evidence_ids`;
    if (ids.some((id) => !idSet.has(id))) return `${name} cites unknown evidence id`;
    return null;
  };
  for (const [name, v] of [['concepts', obj.concepts], ['technical_flow', obj.technical_flow], ['cases', obj.cases]]) {
    if (!Array.isArray(v) || v.length === 0) return `${name} must be a non-empty array`;
    for (const item of v) {
      if (typeof item === 'string') return `${name} entries must be objects with evidence_ids`;
      const err = citeOk(item, name);
      if (err) return err;
    }
  }
  if (obj.source_entries !== undefined) {
    if (!Array.isArray(obj.source_entries)) return 'source_entries must be an array';
    for (const s of obj.source_entries) {
      if (!s || typeof s.path !== 'string' || !s.path) return 'source_entries need path';
    }
  }
  return null;
}

/** Rule template built strictly from the collected facts (no invented conclusions). */
export function ruleLearningMaterial({ subject, facts, codeReport }) {
  const ids = () => facts.slice(0, 3).map((f) => f.id);
  const concepts = facts.slice(0, 5).map((f, i) => ({
    term: String(f.text).split('：')[0].slice(0, 60) || `来源要点 ${i + 1}`,
    explanation: String(f.text).split('：').slice(1).join('：').slice(0, 180) || String(f.text).slice(0, 180),
    evidence_ids: [f.id],
  }));
  const material = {
    learning_objectives: [`理解「${subject}」的核心概念与来源证据`, `能复述来源中的关键事实并指出证据出处`, `完成练习并对照证据自查`],
    prerequisites: facts.length ? ['情报检索/评分流程的基本认识', ...ids().map((id) => `粗读证据 ${id}`)] : ['本主题暂无本地证据，请先补充资料'],
    concepts: concepts.length ? concepts : [{ term: subject, explanation: '信息不足：本地库无可用证据，不编造内容。', evidence_ids: [] }],
    technical_flow: (codeReport?.call_chains || []).map((c, i) => ({
      step: c.name || `步骤 ${i + 1}`,
      detail: (c.steps || []).join(' -> ') || (c.evidence || []).map((e) => e.note).join('; '),
      evidence_ids: (c.evidence || []).map((e) => `${e.path}:${e.lines}`),
    })).slice(0, 5).concat(facts.slice(0, 2).map((f) => ({ step: '阅读证据', detail: String(f.text).slice(0, 150), evidence_ids: [f.id] }))) ,
    cases: facts.slice(0, 3).map((f) => ({ name: String(f.text).split('：')[0].slice(0, 60), description: String(f.text).slice(0, 180), evidence_ids: [f.id] })),
    source_entries: (codeReport ? [].concat(...['key_modules', 'call_chains', 'innovations', 'tradeoffs'].map((f) => codeReport[f] || [])).flatMap((it) => (it.evidence || []).map((e) => ({ path: e.path, line: e.lines, note: e.note }))) : []).slice(0, 8),
    practice_tasks: [
      `精读证据 ${ids()[0] || '(无证据)'}，用 3 句话概括其核心结论并标注证据 id`,
      `对比两条证据（如 ${ids().slice(0, 2).join(' 与 ')}）的表述差异，写一段冲突/一致性分析`,
      `把「${subject}」的要点整理成一页笔记，至少引用 2 个证据 id`,
      `为该主题补充 1 个本地库中缺失的角度并说明检索词`,
      `用自己的一句话向同事解释「${subject}」，并接受"证据在哪"的追问`,
    ].slice(0, facts.length >= 2 ? 5 : 3),
    common_mistakes: ['把单一来源表述当作已验证事实（注意 conflicting 标注）', '引用结论时未标注证据 id，导致无法回溯', '把日报摘要当成原文全文，忽略上下文'],
    interview_questions: [`如何评估「${subject}」相关工作的 novelty？`, `如果两条来源对同一子话题表述冲突，你的核实流程是什么？`, `说明本地证据 -> 结论的引用链路如何保证可审计`],
    next_directions: [`对该主题发起 intel_research 深度研究补充证据`, `将结论回写画像（intel_track_topic confirm）以提升后续匹配`, `为相关仓库发起代码级研究（intel_analyze_repository）获取 path:line 证据`],
    degraded: true,
  };
  return material;
}

export function buildLearningMessages({ subject, facts, codeReport }) {
  const factsSlim = facts.map((f) => ({ id: f.id, ref: f.ref, text: f.text.slice(0, 200) }));
  const text =
    `为主题「${subject}」生成学习材料，只输出一个 JSON 对象。所有结论必须只依据给出的证据（facts），` +
    `证据不足的部分如实写"信息不足"，不得编造。\n` +
    `字段：learning_objectives(数组)、prerequisites(数组)、concepts([{term, explanation, evidence_ids}])、` +
    `technical_flow([{step, detail, evidence_ids}])、cases([{name, description, evidence_ids}])、` +
    `practice_tasks(3-5 个字符串)、common_mistakes(数组)、interview_questions(数组)、next_directions(数组)、` +
    `source_entries([{path, line, note}]，仅在给定源码证据时输出)。\n` +
    `evidence_ids 只能引用下面 facts 的 id${codeReport ? ' 或 path:line 引用' : ''}。\n` +
    `facts：${JSON.stringify(factsSlim)}${codeReport ? `\n源码报告摘要：${JSON.stringify({ architecture: codeReport.architecture, repo: codeReport.repo })}` : ''}`;
  return [{ id: `lm-${randomUUID().slice(0, 8)}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'dsh-intelligence-hub' } }];
}

function evidenceIndex(facts) {
  const m = new Map();
  for (const f of facts) m.set(f.id, f);
  return m;
}

export function buildLearningMarkdown({ subject, material, facts, meta }) {
  const ev = evidenceIndex(facts);
  const cite = (ids) => (ids || []).map((id) => (ev.get(id) ? `[${id}](${ev.get(id).ref})` : `\`${id}\``)).join('、');
  const lines = [];
  lines.push(`# 学习材料 · ${subject}`);
  lines.push('');
  lines.push(`- 生成时间：${meta.generatedAt} ｜ 来源：${meta.source_type}${meta.source_ref ? ` #${meta.source_ref}` : ''}${material.degraded ? ' ｜ ⚠ degraded（规则编排，LLM 不可用或未通过校验）' : ''}`);
  lines.push('');
  lines.push('## 学习目标');
  for (const o of material.learning_objectives) lines.push(`- ${o}`);
  lines.push('');
  lines.push('## 前置知识');
  for (const p of material.prerequisites) lines.push(`- ${p}`);
  lines.push('');
  lines.push('## 概念解释');
  for (const c of material.concepts) lines.push(`- **${c.term}**：${c.explanation}${c.evidence_ids?.length ? `（证据：${cite(c.evidence_ids)}）` : '（信息不足，无证据）'}`);
  lines.push('');
  lines.push('## 技术流程');
  for (const s of material.technical_flow) lines.push(`- ${s.step}：${s.detail}${s.evidence_ids?.length ? `（证据：${cite(s.evidence_ids)}）` : ''}`);
  lines.push('');
  lines.push('## 实际案例');
  for (const c of material.cases) lines.push(`- ${c.name}：${c.description}（证据：${cite(c.evidence_ids)}）`);
  lines.push('');
  if (material.source_entries?.length) {
    lines.push('## 源码入口');
    for (const s of material.source_entries) lines.push(`- \`${s.path}:${s.line ?? ''}\` — ${s.note}`);
    lines.push('');
  }
  lines.push('## 练习任务');
  (material.practice_tasks || []).forEach((p, i) => lines.push(`${i + 1}. ${p}`));
  lines.push('');
  lines.push('## 常见错误');
  for (const m of material.common_mistakes) lines.push(`- ${m}`);
  lines.push('');
  lines.push('## 架构/面试问题');
  for (const q of material.interview_questions) lines.push(`- ${q}`);
  lines.push('');
  lines.push('## 后续方向');
  for (const n of material.next_directions) lines.push(`- ${n}`);
  lines.push('');
  lines.push('---');
  lines.push('*全部内容均引用原报告/证据，未引入来源之外的新结论。*');
  return lines.join('\n');
}

/**
 * Generate + persist a learning material. LLM optional; degraded template otherwise.
 * Returns { ok, id, subject, degraded, markdown, file_path }.
 */
export async function generateLearningMaterial(db, { topic, reportId, taskId, llm = null, provider = '', model = '', reportsDir = null } = {}) {
  const { subject, source_type, source_ref, facts, codeReport, degradedSource } = collectFacts(db, { topic, reportId, taskId });
  const factIds = facts.map((f) => f.id);
  let material = null;
  let promptChars = 0;
  if (llm && provider && model && facts.length >= 2) {
    try {
      const messages = buildLearningMessages({ subject, facts, codeReport });
      promptChars = messages[0].content[0].text.length;
      const text = await streamText(llm, {
        provider, model, messages,
        system: '你是技术导师：只依据给定证据生成学习材料 JSON，证据不足必须直说，不得编造。',
        temperature: 0.3, maxTokens: 1200,
      });
      const obj = extractJson(text);
      const err = validateLearningMaterial(obj, factIds);
      if (err) throw new Error(err);
      material = { ...obj, degraded: false };
    } catch {
      material = null;
    }
  }
  if (!material) material = ruleLearningMaterial({ subject, facts, codeReport });
  const generatedAt = nowIso();
  const markdown = buildLearningMarkdown({ subject, material, facts, meta: { generatedAt, source_type, source_ref } });
  const res = db.prepare(
    `INSERT INTO intel_learning_materials (subject, source_type, source_ref, content_json, degraded, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(subject, source_type, source_ref, JSON.stringify({ ...material, facts: factIds, markdown }), material.degraded ? 1 : 0, generatedAt);
  const id = Number(res.lastInsertRowid);
  let filePath = null;
  if (reportsDir) {
    const dir = path.join(reportsDir, 'learning');
    mkdirSync(dir, { recursive: true });
    const slug = String(subject).replace(/[^\w\u4e00-\u9fff-]+/g, '-').slice(0, 60) || `material-${id}`;
    filePath = path.join(dir, `${id}-${slug}.md`);
    writeFileSync(filePath, markdown, 'utf8');
  }
  return {
    ok: true, id, subject, source_type, source_ref, degraded: !!material.degraded,
    degraded_source: !!degradedSource,
    facts: factIds, practice_tasks: material.practice_tasks.length,
    markdown, file_path: filePath,
    token_usage: { input_chars: promptChars, output_chars: markdown.length, estimate_tokens: Math.ceil(promptChars / 4) + Math.ceil(markdown.length / 4) },
  };
}
