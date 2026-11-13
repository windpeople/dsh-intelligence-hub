import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, closeDb } from '../lib/db.js';
import {
  enqueueJob, claimDueJob, completeJob, failJob, recoverStaleJobs, queueStatus,
  runDueJobs, enqueueScheduledDaily, localParts, localDayBounds, parseTimeOfDay,
} from '../lib/scheduler.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function tempDb() {
  const dir = mkdtempSync(path.join(tmpdir(), 'intelhub-sched-'));
  return openDb(path.join(dir, 'test.db'));
}

test('enqueue dedups same kind+runDate; FAILED allows re-enqueue', () => {
  const db = tempDb();
  const a = enqueueJob(db, { kind: 'DAILY_REPORT', runDate: '2026-11-05' });
  assert.ok(a.enqueued);
  const b = enqueueJob(db, { kind: 'DAILY_REPORT', runDate: '2026-11-05' });
  assert.ok(!b.enqueued, 'same-day same-kind must dedup');
  completeJob(db, a.id, {});
  const c = enqueueJob(db, { kind: 'DAILY_REPORT', runDate: '2026-11-05' });
  assert.ok(!c.enqueued, 'COMPLETED also blocks');
  const other = enqueueJob(db, { kind: 'DAILY_REPORT', runDate: '2026-11-06' });
  assert.ok(other.enqueued, 'different day enqueues');
  // force FAILED then re-enqueue
  db.prepare("UPDATE intel_job_executions SET status='FAILED' WHERE id=?").run(a.id);
  const d = enqueueJob(db, { kind: 'DAILY_REPORT', runDate: '2026-11-05' });
  assert.ok(d.enqueued, 'FAILED allows re-enqueue');
  closeDb(db);
});

test('claim flips to PROCESSING; failJob retries with exponential backoff then FAILED', async () => {
  const db = tempDb();
  const { id } = enqueueJob(db, { kind: 'RSS_SYNC', runDate: '2026-11-05' });
  const job = claimDueJob(db, {});
  assert.equal(job.status, 'PROCESSING');
  const f1 = failJob(db, id, 'boom', { backoffBaseMs: 100 });
  assert.ok(f1.requeued);
  assert.equal(f1.attempts, 1);
  assert.equal(f1.backoffMs, 100);
  const row1 = db.prepare('SELECT * FROM intel_job_executions WHERE id=?').get(id);
  assert.equal(row1.status, 'PENDING');
  // not due yet
  assert.equal(claimDueJob(db, {}), null);
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(claimDueJob(db, {}), 'due again after backoff');
  // exhaust attempts
  failJob(db, id, 'boom2', { backoffBaseMs: 1 });
  const f3 = failJob(db, id, 'boom3', { backoffBaseMs: 1 });
  assert.ok(!f3.requeued);
  const row = db.prepare('SELECT * FROM intel_job_executions WHERE id=?').get(id);
  assert.equal(row.status, 'FAILED');
  assert.equal(row.attempts, 3);
  closeDb(db);
});

test('runDueJobs executes handlers, heartbeats, and retries failing jobs', async () => {
  const db = tempDb();
  enqueueJob(db, { kind: 'RSS_SYNC', runDate: '2026-11-05', payload: { n: 1 } });
  let calls = 0;
  const handlers = {
    RSS_SYNC: async () => {
      calls++;
      if (calls === 1) throw new Error('transient');
      return { ok: true, calls };
    },
  };
  const r1 = await runDueJobs(db, handlers, { backoffBaseMs: 10, execTimeoutMs: 5000 });
  assert.ok(!r1[0].ok && r1[0].requeued);
  await new Promise((r) => setTimeout(r, 30));
  const r2 = await runDueJobs(db, handlers, { backoffBaseMs: 10, execTimeoutMs: 5000 });
  assert.ok(r2[0].ok);
  assert.equal(r2[0].result.calls, 2);
  const row = db.prepare('SELECT * FROM intel_job_executions').get();
  assert.equal(row.status, 'COMPLETED');
  closeDb(db);
});

test('execution timeout marks the job failed and retriable', async () => {
  const db = tempDb();
  enqueueJob(db, { kind: 'PAPER_SYNC', runDate: '2026-11-05' });
  const handlers = {
    PAPER_SYNC: async () => new Promise(() => {}), // never settles
  };
  const r = await runDueJobs(db, handlers, { execTimeoutMs: 50, backoffBaseMs: 10 });
  assert.ok(!r[0].ok);
  assert.match(r[0].error, /timed out/);
  const row = db.prepare('SELECT * FROM intel_job_executions').get();
  assert.equal(row.status, 'PENDING', 'requeued for retry');
  closeDb(db);
});

test('recoverStaleJobs fails stale PROCESSING and re-enqueues', () => {
  const db = tempDb();
  const { id } = enqueueJob(db, { kind: 'GITHUB_SYNC', runDate: '2026-11-05' });
  claimDueJob(db, {});
  // age the heartbeat
  db.prepare("UPDATE intel_job_executions SET updated_at = ? WHERE id=?")
    .run(new Date(Date.now() - 20 * 60000).toISOString(), id);
  const recovered = recoverStaleJobs(db, { staleMs: 10 * 60000 });
  assert.equal(recovered.length, 1);
  const stale = db.prepare('SELECT * FROM intel_job_executions WHERE id=?').get(id);
  assert.equal(stale.status, 'FAILED');
  const fresh = db.prepare('SELECT * FROM intel_job_executions WHERE id=?').get(recovered[0].newId);
  assert.equal(fresh.status, 'PENDING');
  assert.equal(fresh.attempts, 0);
  assert.equal(fresh.kind, 'GITHUB_SYNC');
  closeDb(db);
});

test('enqueueScheduledDaily fires DAILY_REPORT only once per day after reportTime', () => {
  const db = tempDb();
  // 2026-11-05 18:30 Shanghai == 10:30 UTC
  const at = new Date('2026-11-05T10:30:00Z');
  const a = enqueueScheduledDaily(db, [{ kind: 'DAILY_REPORT', at: '18:00' }], { now: at, timeZone: 'Asia/Shanghai' });
  assert.equal(a.length, 1, 'fires after 18:00 local');
  const b = enqueueScheduledDaily(db, [{ kind: 'DAILY_REPORT', at: '18:00' }], { now: at, timeZone: 'Asia/Shanghai' });
  assert.equal(b.length, 0, 'deduped within same day');
  const before = new Date('2026-11-06T09:00:00Z'); // 17:00 Shanghai — not yet 18:00
  const c = enqueueScheduledDaily(db, [{ kind: 'DAILY_REPORT', at: '18:00' }], { now: before, timeZone: 'Asia/Shanghai' });
  assert.equal(c.length, 0, 'does not fire before reportTime (new day)');
  closeDb(db);
});

test('local helpers: Shanghai parts, day bounds, time parsing', () => {
  const { date, minutes } = localParts(new Date('2026-11-05T10:30:00Z'), 'Asia/Shanghai');
  assert.equal(date, '2026-11-05');
  assert.equal(minutes, 18 * 60 + 30);
  const bounds = localDayBounds('2026-11-05', 'Asia/Shanghai');
  assert.equal(bounds.start, '2026-11-04T16:00:00.000Z');
  assert.equal(bounds.end, '2026-11-05T16:00:00.000Z');
  assert.equal(parseTimeOfDay('18:00'), 1080);
  assert.equal(parseTimeOfDay('25:00'), null);
  assert.equal(parseTimeOfDay('junk'), null);
});

test('queueStatus reports counts', () => {
  const db = tempDb();
  enqueueJob(db, { kind: 'RSS_SYNC', runDate: '2026-11-05' });
  enqueueJob(db, { kind: 'GITHUB_SYNC', runDate: '2026-11-05' });
  const st = queueStatus(db);
  assert.equal(st.byStatus.PENDING, 2);
  closeDb(db);
});
