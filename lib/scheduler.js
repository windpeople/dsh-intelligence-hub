/** Durable job queue over intel_job_executions: dedup, timeout, heartbeat, backoff retry, restart recovery. */

import { randomUUID } from 'node:crypto';
import { withTimeout } from './pipeline.js';

export const JOB_KINDS = ['DAILY_DISCOVERY', 'RSS_SYNC', 'GITHUB_SYNC', 'PAPER_SYNC', 'CONTENT_ANALYSIS', 'DAILY_REPORT', 'WEEKLY_REPORT', 'PIPELINE_RUN', 'CODE_RESEARCH', 'RESEARCH_TASK', 'RESEARCH_REVIEW', 'COVERAGE_AUDIT'];
export const JOB_STATUS = { PENDING: 'PENDING', PROCESSING: 'PROCESSING', COMPLETED: 'COMPLETED', FAILED: 'FAILED' };

const nowIso = () => new Date().toISOString();

/**
 * Enqueue one job for (kind, runDate). Dedup rule: an existing PENDING,
 * PROCESSING or COMPLETED row for the same kind+runDate blocks re-enqueue;
 * FAILED rows allow a fresh attempt. Returns { enqueued, id, reason }.
 */
export function enqueueJob(db, { kind, runDate, payload = {}, maxAttempts = 3, nextRunAt } = {}) {
  if (!JOB_KINDS.includes(kind)) return { enqueued: false, reason: `unknown kind ${kind}` };
  const day = String(runDate || localDateString());
  const existing = db
    .prepare(
      "SELECT id, status FROM intel_job_executions WHERE kind = ? AND run_date = ? AND status IN ('PENDING','PROCESSING','COMPLETED') LIMIT 1"
    )
    .get(kind, day);
  if (existing) return { enqueued: false, id: existing.id, reason: `dedup: ${kind}/${day} already ${existing.status}` };
  const t = nowIso();
  const res = db
    .prepare(
      `INSERT INTO intel_job_executions (kind, run_date, status, attempts, max_attempts, payload, next_run_at, updated_at)
       VALUES (?, ?, 'PENDING', 0, ?, ?, ?, ?)`
    )
    .run(kind, day, maxAttempts, JSON.stringify(payload || {}), nextRunAt || t, t);
  return { enqueued: true, id: Number(res.lastInsertRowid), runDate: day };
}

/** Claim the oldest due PENDING job (atomic status flip to PROCESSING). */
export function claimDueJob(db, { now = new Date() } = {}) {
  const t = now.toISOString();
  const row = db
    .prepare(
      "SELECT * FROM intel_job_executions WHERE status = 'PENDING' AND next_run_at <= ? ORDER BY next_run_at, id LIMIT 1"
    )
    .get(t);
  if (!row) return null;
  db.prepare(
    "UPDATE intel_job_executions SET status = 'PROCESSING', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ? AND status = 'PENDING'"
  ).run(t, t, row.id);
  return { ...row, status: 'PROCESSING' };
}

export function touchJob(db, id) {
  db.prepare("UPDATE intel_job_executions SET updated_at = ? WHERE id = ? AND status = 'PROCESSING'").run(nowIso(), id);
}

export function completeJob(db, id, result) {
  db.prepare(
    "UPDATE intel_job_executions SET status = 'COMPLETED', finished_at = ?, updated_at = ?, result = ?, error = NULL WHERE id = ?"
  ).run(nowIso(), nowIso(), result === undefined ? null : JSON.stringify(result), id);
}

/** Fail one attempt: exponential backoff re-queue until maxAttempts, then FAILED. */
export function failJob(db, id, error, { backoffBaseMs = 60000, now = new Date() } = {}) {
  const row = db.prepare('SELECT attempts, max_attempts, run_date, kind, payload, started_at FROM intel_job_executions WHERE id = ?').get(id);
  if (!row) return { requeued: false };
  const attempts = (row.attempts || 0) + 1;
  const t = nowIso();
  const msg = String(error?.message || error || 'unknown error').slice(0, 800);
  if (attempts < (row.max_attempts || 3)) {
    const delay = backoffBaseMs * Math.pow(2, attempts - 1);
    const next = new Date((now instanceof Date ? now : new Date(now)).getTime() + delay).toISOString();
    db.prepare(
      "UPDATE intel_job_executions SET status = 'PENDING', attempts = ?, next_run_at = ?, updated_at = ?, error = ? WHERE id = ?"
    ).run(attempts, next, t, msg, id);
    return { requeued: true, attempts, nextRunAt: next, backoffMs: delay };
  }
  db.prepare(
    "UPDATE intel_job_executions SET status = 'FAILED', attempts = ?, finished_at = ?, updated_at = ?, error = ? WHERE id = ?"
  ).run(attempts, t, t, msg, id);
  return { requeued: false, attempts, status: 'FAILED' };
}

/**
 * Startup recovery: PROCESSING rows whose heartbeat (updated_at) is older than
 * staleMs are marked FAILED and re-enqueued as fresh PENDING rows (attempts reset).
 */
export function recoverStaleJobs(db, { staleMs = 10 * 60000, now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - staleMs).toISOString();
  const stale = db
    .prepare("SELECT * FROM intel_job_executions WHERE status = 'PROCESSING' AND updated_at < ?")
    .all(cutoff);
  const recovered = [];
  for (const row of stale) {
    const t = nowIso();
    db.prepare(
      "UPDATE intel_job_executions SET status = 'FAILED', finished_at = ?, updated_at = ?, error = ? WHERE id = ?"
    ).run(t, t, `stale PROCESSING heartbeat older than ${staleMs}ms (restart recovery)`, row.id);
    const res = db
      .prepare(
        `INSERT INTO intel_job_executions (kind, run_date, status, attempts, max_attempts, payload, next_run_at, updated_at)
         VALUES (?, ?, 'PENDING', 0, ?, ?, ?, ?)`
      )
      .run(row.kind, row.run_date, row.max_attempts, row.payload, t, t);
    recovered.push({ staleId: row.id, kind: row.kind, runDate: row.run_date, newId: Number(res.lastInsertRowid) });
  }
  return recovered;
}

export function queueStatus(db) {
  const byStatus = db
    .prepare('SELECT status, COUNT(*) AS n FROM intel_job_executions GROUP BY status')
    .all()
    .reduce((acc, r) => ({ ...acc, [r.status]: r.n }), {});
  const pending = db
    .prepare("SELECT id, kind, run_date, attempts, next_run_at FROM intel_job_executions WHERE status = 'PENDING' ORDER BY next_run_at LIMIT 20")
    .all();
  const lastFailed = db
    .prepare("SELECT id, kind, run_date, attempts, error, finished_at FROM intel_job_executions WHERE status = 'FAILED' ORDER BY id DESC LIMIT 5")
    .all();
  const lastCompleted = db
    .prepare("SELECT id, kind, run_date, finished_at FROM intel_job_executions WHERE status = 'COMPLETED' ORDER BY id DESC LIMIT 5")
    .all();
  return { byStatus, pending, lastFailed, lastCompleted };
}

/** Local (tz) calendar helpers: 'YYYY-MM-DD' and minutes-since-midnight. */
export function localParts(date = new Date(), timeZone = 'Asia/Shanghai') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value || '';
  const dateStr = `${get('year')}-${get('month')}-${get('day')}`;
  const hour = Number(get('hour')) % 24;
  const minutes = hour * 60 + Number(get('minute'));
  return { date: dateStr, minutes };
}

export function localDateString(date = new Date(), timeZone = 'Asia/Shanghai') {
  return localParts(date, timeZone).date;
}

/** Offset (ms) of `tz` at instant `date`: asUTC(wall clock formatted in tz) - realUTC. */
function tzOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value || 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asUtc - date.getTime();
}

/** UTC [start, end) ISO bounds of a local calendar day in the given tz. */
export function localDayBounds(dateStr, timeZone = 'Asia/Shanghai') {
  const startUtcMs = Date.parse(`${dateStr}T00:00:00Z`) - tzOffsetMs(new Date(`${dateStr}T00:00:00Z`), timeZone);
  return { start: new Date(startUtcMs).toISOString(), end: new Date(startUtcMs + 24 * 3600 * 1000).toISOString() };
}

/** Parse 'HH:mm' into minutes; invalid input returns null. */
export function parseTimeOfDay(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Enqueue the recurring daily jobs whose scheduled time has passed today and
 * which have no PENDING/PROCESSING/COMPLETED run for today yet.
 * schedule: [{ kind, atMinutes }] — call once per tick.
 */
export function enqueueScheduledDaily(db, schedule, { now = new Date(), timeZone = 'Asia/Shanghai', nextRunAt } = {}) {
  const { date, minutes } = localParts(now, timeZone);
  const enqueued = [];
  for (const item of schedule) {
    const at = parseTimeOfDay(item.atMinutes ?? item.at);
    if (at === null) continue;
    if (minutes >= at) {
      const r = enqueueJob(db, { kind: item.kind, runDate: date, nextRunAt });
      if (r.enqueued) enqueued.push(r);
    }
  }
  return enqueued;
}

/** Monday 'YYYY-MM-DD' (in tz) of the week containing dateStr (or `date`). */
export function weekStartOf(dateStr, { date = new Date(), timeZone = 'Asia/Shanghai' } = {}) {
  const d = String(dateStr || localDateString(date, timeZone));
  const ms = Date.parse(`${d}T00:00:00Z`);
  if (!Number.isFinite(ms)) return d;
  const dayNumber = Math.floor(ms / 86400000); // 1970-01-01 was a Thursday
  // Days since Monday: (dow + 3) % 7 with dow = (dayNumber + 4) % 7 (0=Sun..6=Sat)
  const dow = ((dayNumber % 7) + 7 + 4) % 7;
  const sinceMonday = (dow + 6) % 7;
  return new Date((dayNumber - sinceMonday) * 86400000).toISOString().slice(0, 10);
}

/**
 * Enqueue WEEKLY_REPORT once per local week: fires when the local time has passed
 * `at` on the configured weekday (default Monday, 09:00) and reports on the
 * previous week (weekStart = Monday one week before the current week start).
 * Queue dedup key: kind + run date, so it enqueues once per occurrence day.
 */
export function enqueueScheduledWeekly(db, {
  kind = 'WEEKLY_REPORT', at = '09:00', weekday = 1, reportWeekOffset = 1,
  now = new Date(), timeZone = 'Asia/Shanghai', nextRunAt,
} = {}) {
  const { date, minutes } = localParts(now, timeZone);
  const atMin = parseTimeOfDay(at);
  if (atMin === null) return [];
  const ms = Date.parse(`${date}T00:00:00Z`);
  const dayNumber = Math.floor(ms / 86400000);
  const dow = ((dayNumber % 7) + 7 + 4) % 7; // 0=Sun..6=Sat
  if (dow !== (Number(weekday) % 7) || minutes < atMin) return [];
  const thisWeekStart = weekStartOf(date, { timeZone });
  const reportWeekStart = new Date(Date.parse(`${thisWeekStart}T00:00:00Z`) - reportWeekOffset * 7 * 86400000)
    .toISOString().slice(0, 10);
  const r = enqueueJob(db, {
    kind, runDate: date,
    payload: { week_start: reportWeekStart },
    nextRunAt,
  });
  return r.enqueued ? [{ ...r, week_start: reportWeekStart }] : [];
}

/**
 * Enqueue PIPELINE_RUN jobs for today's slots that have passed. Each slot gets
 * its own dedup key (runDate = `${date}#${slot}`) so 10:00 (L0) and 12:00 (FULL)
 * run once each per local day, reusing the standard kind+day idempotency.
 */
export function enqueuePipelineRun(db, { slots = ['10:00', '12:00'], phases = {}, now = new Date(), timeZone = 'Asia/Shanghai', nextRunAt } = {}) {
  const { date, minutes } = localParts(now, timeZone);
  const enqueued = [];
  for (const slot of slots) {
    const at = parseTimeOfDay(slot);
    if (at === null || minutes < at) continue;
    const phase = phases[slot] || (slot === slots[0] ? 'L0' : 'FULL');
    const r = enqueueJob(db, {
      kind: 'PIPELINE_RUN',
      runDate: `${date}#${slot.replace(':', '')}`,
      payload: { phase, dateStr: date },
      nextRunAt,
    });
    if (r.enqueued) enqueued.push({ ...r, slot, phase });
  }
  return enqueued;
}

/**
 * Run due jobs to completion (bounded). handlers: { KIND: async (job, ctx) => result }.
 * Each execution: hard timeout, periodic heartbeat (touchJob), backoff on failure.
 */
export async function runDueJobs(db, handlers, {
  maxJobs = 10,
  execTimeoutMs = 10 * 60000,
  heartbeatMs = 15000,
  backoffBaseMs = 60000,
  ctx = {},
  now = new Date(),
} = {}) {
  const results = [];
  for (let i = 0; i < maxJobs; i++) {
    const job = claimDueJob(db, { now });
    if (!job) break;
    const handler = handlers[job.kind];
    if (!handler) {
      failJob(db, job.id, `no handler for kind ${job.kind}`, { backoffBaseMs });
      results.push({ id: job.id, kind: job.kind, ok: false, error: 'no handler' });
      continue;
    }
    let payload = {};
    try { payload = JSON.parse(job.payload || '{}'); } catch {}
    const heartbeat = setInterval(() => touchJob(db, job.id), heartbeatMs);
    try {
      const result = await withTimeout(handler({ ...job, payload }, ctx), execTimeoutMs, `job ${job.kind}#${job.id}`);
      completeJob(db, job.id, result);
      results.push({ id: job.id, kind: job.kind, ok: true, result });
    } catch (err) {
      const f = failJob(db, job.id, err, { backoffBaseMs, now });
      results.push({ id: job.id, kind: job.kind, ok: false, error: String(err.message || err), ...f });
    } finally {
      clearInterval(heartbeat);
    }
  }
  return results;
}

/** Unique run id (used in payloads for traceability). */
export const newRunId = () => randomUUID();
