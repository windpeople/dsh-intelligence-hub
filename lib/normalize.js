/** Pure helpers: URL canonicalization, hashing, language and topic sniffing. */

import { createHash } from 'node:crypto';

/** Lowercase host, drop fragment and query string, drop trailing slash. */
export function canonicalUrl(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let s = raw.trim();
  try {
    const u = new URL(s);
    u.hash = '';
    u.search = '';
    u.username = '';
    u.password = '';
    let out = `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
    if (out.endsWith('/')) out = out.slice(0, -1);
    return out;
  } catch {
    return s;
  }
}

export function sha256Hex(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/** Dedup key: sha256 of the canonical URL. */
export function dedupKeyFor(url) {
  return sha256Hex(canonicalUrl(url) || String(url || ''));
}

/** Collapse whitespace/punctuation so near-identical titles compare equal. */
export function normalizedTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, ' ')
    .trim();
}

export function contentHash(text) {
  return sha256Hex(normalizedTitle(text) ? String(text).replace(/\s+/g, ' ').trim() : '');
}

const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/g;

/** Crude language detection: CJK char ratio > 10% => 'zh', else 'en'. */
export function detectLang(text) {
  const s = String(text || '');
  if (!s) return 'und';
  const cjk = (s.match(CJK_RE) || []).length;
  const letters = (s.match(/[A-Za-z]/g) || []).length;
  const denom = cjk + letters;
  if (denom === 0) return 'und';
  return cjk / denom > 0.1 ? 'zh' : 'en';
}

const TOPIC_RULES = [
  ['ai-agents', ['agent', 'agentic', ' autonomous agent', '智能体', '代理框架']],
  ['llm', ['llm', 'large language model', 'gpt', '大模型', '语言模型', 'deepseek', 'claude', 'gemini']],
  ['memory', ['memory', 'rag', 'retrieval', '记忆', '检索增强', '向量']],
  ['mcp', ['mcp', 'model context protocol', 'tool use', 'function calling', '工具调用']],
  ['devtools', ['github', 'open source', '开源', '开发', 'release', 'cli', 'sdk', 'api']],
  ['frontend', ['css', 'web app', '前端', 'react', 'vue']],
];

/** Keyword-bucket topic classification; returns the first hit or 'general'. */
export function classifyTopic(text) {
  const s = String(text || '').toLowerCase();
  for (const [topic, words] of TOPIC_RULES) {
    for (const w of words) if (s.includes(w)) return topic;
  }
  return 'general';
}

/**
 * Split text into space-separated tokens for FTS5's default tokenizer.
 * CJK runs become overlapping bigrams; latin words stay intact.
 */
export function bigramize(text) {
  const s = String(text || '');
  const out = [];
  for (const m of s.matchAll(/[A-Za-z0-9_]+|[\u4e00-\u9fff\u3400-\u4dbf]+/g)) {
    const tok = m[0];
    if (/^[A-Za-z0-9_]+$/.test(tok)) out.push(tok.toLowerCase());
    else if (tok.length === 1) out.push(tok);
    else for (let i = 0; i < tok.length - 1; i++) out.push(tok.slice(i, i + 2));
  }
  return out.join(' ');
}

/** Build the FTS5 MATCH query for user input; `OR` (case-insensitive) is honored. */
export function ftsQueryFor(input) {
  const terms = bigramize(input).split(' ').filter(Boolean).map((t) => `"${t}"`);
  const out = [];
  for (const term of terms) {
    if (/^"?or"?$/i.test(term) && out.length > 0) {
      out.push('OR');
    } else {
      if (out.length > 0 && out[out.length - 1] !== 'OR') out.push('AND');
      out.push(term);
    }
  }
  return out.join(' ');
}

export function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
