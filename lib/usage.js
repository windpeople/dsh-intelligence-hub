/** V2.0 Phase 2: LLM token usage accounting skeleton.
 *
 *  Every LLM call site records prompt/completion char volumes into intel_usage.
 *  `tokenBudgetPerDay` (config, default 0 = unlimited) caps the daily completion
 *  volume; when the budget is exceeded the call site skips the LLM and falls back
 *  to the existing rule path (each call site already has one).
 */

import { localParts } from './scheduler.js';

const nowIso = () => new Date().toISOString();

/** Record one LLM call. usage_date is the local calendar day (reportTimeZone). */
export function recordUsage(db, { call, promptChars = 0, completionChars = 0, now = new Date(), timeZone = 'Asia/Shanghai' } = {}) {
  const t = now instanceof Date ? now : new Date(now);
  const usageDate = localParts(t, timeZone).date;
  const res = db
    .prepare('INSERT INTO intel_usage (call, prompt_chars, completion_chars, used_at, usage_date) VALUES (?, ?, ?, ?, ?)')
    .run(String(call || ''), Math.max(0, Math.round(Number(promptChars) || 0)), Math.max(0, Math.round(Number(completionChars) || 0)), t.toISOString(), usageDate);
  return { id: Number(res.lastInsertRowid), usage_date: usageDate };
}

/** Aggregate usage for one local day (default: today). */
export function todayUsage(db, { date, timeZone = 'Asia/Shanghai', now } = {}) {
  const day = date || localParts(now === undefined ? new Date() : (now instanceof Date ? now : new Date(now)), timeZone).date;
  const row = db
    .prepare('SELECT COALESCE(SUM(prompt_chars),0) AS prompt_chars, COALESCE(SUM(completion_chars),0) AS completion_chars, COUNT(*) AS calls FROM intel_usage WHERE usage_date = ?')
    .get(day);
  return { date: day, prompt_chars: row.prompt_chars, completion_chars: row.completion_chars, calls: row.calls };
}

/** Is the daily budget (config.tokenBudgetPerDay, 0 = unlimited) still open for an estimated extra cost? */
export function withinBudget(db, config, { estimateChars = 0, timeZone = 'Asia/Shanghai', now } = {}) {
  const budget = Number(config?.tokenBudgetPerDay) || 0;
  if (budget <= 0) return { allowed: true, budget: 0, ...todayUsage(db, { timeZone, now }) };
  const used = todayUsage(db, { timeZone, now }).completion_chars;
  return { allowed: used + Math.max(0, estimateChars) <= budget, budget, used, estimate_chars: Math.max(0, estimateChars) };
}

/**
 * Approximate prompt volume for a messages array (analysis.js message shape).
 * Pure char counting — the skeleton treats chars as the budget unit.
 */
export function promptCharsOf(messages = []) {
  let n = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') n += m.content.length;
    else if (Array.isArray(m.content)) for (const c of m.content) n += String(c?.text || '').length;
  }
  return n;
}
