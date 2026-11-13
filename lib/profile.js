/** Interest profile: default profile, rule/synonym matching, confirm-gated updates. No LLM required for matching. */

import { getProfile, saveProfile } from './db.js';

export const PROFILE_ID = 'default';

export const DEFAULT_LONG_TERM_INTERESTS = [
  'AI Agent', 'Multi-Agent', 'Agent Memory', 'RAG', 'MCP', 'A2A', 'Agent Runtime', 'AI Backend Engineering',
];

export const DEFAULT_PROFILE = {
  profile_id: PROFILE_ID,
  long_term_interests: [...DEFAULT_LONG_TERM_INTERESTS],
  current_projects: [],
  learning_goals: [],
  content_preferences: {
    prefer: [],
    deprioritize: ['product announcement', '产品发布宣传', '入门教程', 'beginner tutorial', '重复入门内容'],
  },
  updated_at: null,
};

/**
 * Keyword -> synonym table used by rule matching (all lowercase).
 * 扩容原则：每个默认兴趣 8-15 个中英文同义词/相关词，覆盖真实 arXiv/Release 标题
 * （如 "CompressionBench: benchmarking context memory..." 命中 agent memory）。
 * 匹配为子串包含；避免过短的高误命中词（如裸 "agent"、"memory" 单词不收）。
 */
export const SYNONYMS = {
  'ai agent': [
    'ai agent', 'agent framework', 'agent runtime', '智能体', 'agentic', 'autonomous agent',
    'agent orchestration', 'llm agent', 'agent workflow', 'agentic ai', 'coding agent',
    'terminal agent', 'agent eval', 'agent benchmark', 'computer use', 'agent scaffolding',
  ],
  'multi-agent': [
    'multi-agent', 'multi agent', 'agent swarm', 'a2a', 'agent communication', '多智能体',
    'agent collaboration', 'agent-to-agent', 'multi-agent system', 'agent society',
    'multi-agent debate', 'agent teamwork', 'multi-robot', '群体智能', 'agent team',
  ],
  'agent memory': [
    'agent memory', 'memory system', '长期记忆', '记忆机制', 'memory management',
    'context memory', 'context compression', 'compression', 'long-term memory', 'episodic',
    'knowledge graph memory', '记忆检索', 'memory retrieval', 'memory benchmark',
    'memory agent', 'memorybank', 'experience reuse', '记忆压缩',
  ],
  rag: [
    'rag', 'retrieval augmented', 'retrieval-augmented', '检索增强', 'vector search',
    '向量检索', 'embedding', 'retriever', 'vector database', '向量数据库', 'semantic search',
    'semantic retrieval', 'hybrid search', 'rerank', '重排', 'knowledge base retrieval', 'chunking',
  ],
  mcp: [
    'mcp', 'model context protocol', 'tool use', 'function calling', '工具调用', '工具协议',
    'mcp server', 'mcp client', 'tool calling', 'tool integration', '工具生态',
    'protocol server', 'tool schema', 'tool registry', 'jsonrpc', '工具安全',
  ],
  a2a: [
    'a2a', 'agent-to-agent', 'agent protocol', 'agent interoperability', 'agent-to-agent protocol',
    'agent messaging', 'agent discovery', '协议互通', '智能体协议', 'agent handshake',
    'cross-agent', 'inter-agent', 'agent federation',
  ],
  'agent runtime': [
    'agent runtime', 'agent sandbox', 'runtime for agents', '运行时', 'agent container',
    'agent isolation', 'execution environment', '执行环境', 'agent vm', 'firecracker',
    'microvm', 'agent host', 'sandboxing', 'agent infrastructure', '运行环境',
  ],
  'ai backend engineering': [
    'backend', 'inference serving', 'vllm', 'serving', '后端', '推理服务', 'api design',
    'inference engine', '推理引擎', 'gpu scheduling', 'kv cache', '批处理', 'batching',
    'model deployment', '推理优化', 'quantization', '量化', 'throughput', 'latency optimization',
    'sglang', 'tensor parallel', '模型部署',
  ],
  llm: [
    'llm', 'large language model', '大模型', '语言模型', 'deepseek', 'claude', 'gpt', 'gemini',
    'qwen', 'glm', 'foundation model', '基座模型', 'instruction tuning', 'pretraining',
    '预训练', 'fine-tuning', '微调', 'tokenizer', 'scaling law', 'reasoning model', '思维链',
  ],
};

const DEPRIORITIZE_PATTERNS = [
  /限时优惠|早鸟价|just\s?\$|discount|coupon/i,
  /^how to get started|新手入门|零基础|beginner'?s guide|getting started tutorial/i,
];

export function deepMergeProfile(base, patch) {
  const out = { ...structuredClone(base) };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === undefined) continue;
    if (k === 'content_preferences' && v && typeof v === 'object' && !Array.isArray(v)) {
      out.content_preferences = { ...out.content_preferences, ...v };
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Create the default profile row if missing. Idempotent. */
export function ensureDefaultProfile(db, now = new Date().toISOString()) {
  const existing = getProfile(db, PROFILE_ID);
  if (existing) return { created: false, profile: existing };
  const profile = { ...structuredClone(DEFAULT_PROFILE), updated_at: now };
  saveProfile(db, profile, { profileId: PROFILE_ID, updatedAt: now });
  return { created: true, profile };
}

export function loadProfile(db) {
  ensureDefaultProfile(db);
  return getProfile(db, PROFILE_ID);
}

/**
 * Read the current profile and expand long-term interests into matchable keyword sets.
 * Pure-ish: db only for load. Returns { profile, keywordSets: [{ interest, terms }] }.
 */
export function getMatchableProfile(db) {
  const profile = loadProfile(db);
  const keywordSets = (profile.long_term_interests || []).map((interest) => {
    const key = String(interest).toLowerCase().trim();
    const terms = new Set([key, ...(SYNONYMS[key] || [String(interest).toLowerCase()])]);
    return { interest: String(interest), terms: [...terms] };
  });
  return { profile, keywordSets };
}

function textOf(doc) {
  return String(`${doc?.title || ''} ${doc?.summary || ''} ${doc?.topic || ''} ${doc?.url || ''}`).toLowerCase();
}

/** 标题 vs 正文权重：标题命中说明主题即为此兴趣，权重更高（修 R 偏低）。 */
export const TITLE_HIT_WEIGHTS = { first: 40, more: 20 };
export const BODY_HIT_WEIGHTS = { first: 30, more: 12 };

/**
 * L1 rule matching: keywords/synonyms, project repo names, project problem words,
 * learning-goal tech terms, deprioritize patterns.
 * Returns { relevance_score (0-100), matched_goals, matched_projects, matched_problems, reason, gray_zone }.
 */
export function matchProfile(keywordSets, profile, doc) {
  const titleText = String(doc?.title || '').toLowerCase();
  const bodyText = String(`${doc?.summary || ''} ${doc?.topic || ''} ${doc?.url || ''}`).toLowerCase();
  const text = `${titleText} ${bodyText}`;
  const matchedGoals = [];
  const matchedProjects = [];
  const matchedProblems = [];
  let score = 0;
  const hits = [];

  for (const { interest, terms } of keywordSets || []) {
    const hit = terms.find((t) => (titleText && titleText.includes(t)) || (bodyText && bodyText.includes(t)));
    if (hit) {
      const inTitle = !!titleText && titleText.includes(hit);
      const w = inTitle ? TITLE_HIT_WEIGHTS : BODY_HIT_WEIGHTS;
      matchedGoals.push(interest);
      score += matchedGoals.length === 1 ? w.first : w.more; // first goal enters gray zone; more evidence adds
      hits.push(`interest:${interest}~"${hit}"${inTitle ? '(title)' : '(body)'}`);
    }
  }
  score = Math.min(score, 60); // long-term interests cap

  for (const proj of profile.current_projects || []) {
    const projText = String(`${proj.name || ''} ${proj.direction || ''} ${(proj.repos || []).join(' ')} ${(proj.problems || []).join(' ')}`).toLowerCase();
    if (!projText.trim()) continue;
    const repoHit = (proj.repos || []).some((r) => text.includes(String(r).toLowerCase()));
    const problemHit = (proj.problems || []).some((p) => text.includes(String(p).toLowerCase()));
    const nameHit = proj.name && text.includes(String(proj.name).toLowerCase());
    if (repoHit || problemHit || nameHit) {
      matchedProjects.push(proj.name || 'unnamed-project');
      score += repoHit ? 20 : 10;
      hits.push(`project:${proj.name}${repoHit ? '(repo)' : problemHit ? '(problem)' : '(name)'}`);
      for (const p of proj.problems || []) if (text.includes(String(p).toLowerCase())) matchedProblems.push(p);
    }
  }

  for (const goal of profile.learning_goals || []) {
    const terms = [goal.tech, ...(goal.unmastered || []), goal.target_capability].filter(Boolean).map((s) => String(s).toLowerCase());
    const hit = terms.find((t) => text.includes(t));
    if (hit) {
      matchedGoals.push(goal.tech || String(hit));
      score += score === 0 ? 40 : 20;
      hits.push(`learning:${goal.tech}~"${hit}"`);
    }
  }

  const deprioritizeHits = (profile.content_preferences?.deprioritize || [])
    .filter((p) => text.includes(String(p).toLowerCase()));
  if (deprioritizeHits.length) {
    score -= 15 * deprioritizeHits.length;
    hits.push(`deprioritize:${deprioritizeHits.join(',')}`);
  }
  if (DEPRIORITIZE_PATTERNS.some((re) => re.test(String(doc?.title || '')))) {
    score -= 10;
    hits.push('deprioritize:promo/beginner-pattern');
  }

  const relevanceScore = Math.max(0, Math.min(100, Math.round(score)));
  // Gray zone = ambiguous single weak signal (rule score 40-75 from at most one goal, no project hit).
  // Multiple distinct interests or any project match counts as confident (no LLM needed).
  const grayZone = relevanceScore >= 40 && relevanceScore <= 75 && matchedGoals.length <= 1 && matchedProjects.length === 0;
  const reason = hits.length
    ? `规则命中：${hits.slice(0, 6).join('; ')}`
    : '规则未命中任何画像关键词/项目/学习目标';
  return {
    relevance_score: relevanceScore,
    matched_goals: [...new Set(matchedGoals)],
    matched_projects: [...new Set(matchedProjects)],
    matched_problems: [...new Set(matchedProblems)],
    reason,
    gray_zone: grayZone,
  };
}

/**
 * Profile update API. Only explicit confirm=true persists long-term fields
 * (long_term_interests, learning_goals, current_projects, content_preferences).
 * confirm=false returns the merged preview without touching the db (临时输入不落盘).
 */
export function updateProfile(db, patch, { confirm = false } = {}) {
  const current = loadProfile(db);
  const merged = deepMergeProfile(current, patch);
  if (!confirm) {
    return { persisted: false, profile: merged, note: 'preview only; pass confirm=true to persist' };
  }
  merged.updated_at = new Date().toISOString();
  saveProfile(db, merged, { profileId: PROFILE_ID, updatedAt: merged.updated_at });
  return { persisted: true, profile: merged };
}

/**
 * Suggest profile updates from recent documents (rule-derived, no LLM).
 * Returns a suggestion patch; does NOT write the db.
 */
export function suggestProfileUpdate(db, docs = []) {
  const { profile } = getMatchableProfile(db);
  const knownInterests = new Set((profile.long_term_interests || []).map((s) => s.toLowerCase()));
  const freq = new Map();
  for (const d of docs) {
    for (const key of Object.keys(SYNONYMS)) {
      if (knownInterests.has(key)) continue;
      if (textOf(d).includes(SYNONYMS[key][0])) freq.set(key, (freq.get(key) || 0) + 1);
    }
  }
  const candidates = [...freq.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  return {
    persisted: false,
    suggestion: candidates.length
      ? { long_term_interests: [...(profile.long_term_interests || []), ...candidates.map((k) => k.toUpperCase())] }
      : null,
    note: 'rule-derived suggestion; confirm=true required to persist',
  };
}
