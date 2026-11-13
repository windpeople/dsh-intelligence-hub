// Tick-level scheduler tests: covers the four previously broken paths
// (RSS_SYNC enqueue+execute, DAILY_DISCOVERY completion, DAILY_REPORT queue
// trace + same-day idempotency, PIPELINE_RUN slot traces) via a fake clock.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb, closeDb } from '../lib/db.js';
import { createSchedulerTick } from '../index.js';
import { recoverStaleJobs, claimDueJob } from '../lib/scheduler.js';

function tempDb() {
  const dir = mkdtempSync(path.join(tmpdir(), 'intelhub-tick-'));
  return openDb(path.join(dir, 'test.db'));
}

const TZ = 'Asia/Shanghai';

function makeHarness(db, { configOverrides = {}, handlers } = {}) {
  const calls = [];
  const mockHandlers = {
    DAILY_DISCOVERY: async (job) => { calls.push(['DAILY_DISCOVERY', job.run_date]); return { inserted: 5 }; },
    RSS_SYNC: async (job) => { calls.push(['RSS_SYNC', job.run_date]); return { inserted: 3 }; },
    GITHUB_SYNC: async (job) => { calls.push(['GITHUB_SYNC', job.run_date]); return { inserted: 1 }; },
    PAPER_SYNC: async (job) => { calls.push(['PAPER_SYNC', job.run_date]); return { inserted: 2 }; },
    DAILY_REPORT: async (job) => { calls.push(['DAILY_REPORT', job.run_date]); return { created: true, dateStr: job.run_date }; },
    COVERAGE_AUDIT: async (job) => { calls.push(['COVERAGE_AUDIT', job.run_date]); return { created: true }; },
    PIPELINE_RUN: async (job) => { calls.push(['PIPELINE_RUN', job.run_date]); return { phase: job.payload?.phase }; },
    ...handlers,
  };
  const config = {
    collectEnabled: true, collectIntervalHours: 6,
    reportEnabled: true, reportTime: '18:00',
    coverageEnabled: true, coverageTime: '20:00',
    pipelineEnabled: true, pipelineSlots: '10:00,12:00',
    reportTimeZone: TZ, retentionDays: 90, maxDiskMb: 512,
    ...configOverrides,
  };
  let now = new Date('2026-11-05T00:00:00Z');
  const tick = createSchedulerTick(db, config, {
    handlers: mockHandlers,
    logger: { info() {}, warn() {} },
    reportsDir: '/tmp/intelhub-tick-reports',
    dbPath: '/tmp/intelhub-tick.db',
    nowFn: () => now,
    runRetentionFn: () => ({ expired: { deleted: 0 }, disk: { deleted: 0 } }),
  });
  return {
    tick,
    calls,
    set now(d) { now = d; },
    get now() { return now; },
  };
}

const rows = (db, kind) => db.prepare('SELECT * FROM intel_job_executions WHERE kind = ? ORDER BY id').all(kind);
const all = (db) => db.prepare('SELECT * FROM intel_job_executions ORDER BY id').all();

test('RSS_SYNC is enqueued and executed to COMPLETED on tick', async () => {
  const db = tempDb();
  const h = makeHarness(db);
  h.now = new Date('2026-11-05T01:00:00Z'); // 09:00 Shanghai
  await h.tick();
  const rss = rows(db, 'RSS_SYNC');
  assert.equal(rss.length, 1);
  assert.equal(rss[0].status, 'COMPLETED', 'RSS_SYNC must execute in the same tick');
  assert.ok(rss[0].started_at && rss[0].finished_at && rss[0].updated_at, 'full execution trace');
  closeDb(db);
});

test('DAILY_DISCOVERY runs to COMPLETED with record', async () => {
  const db = tempDb();
  const h = makeHarness(db);
  h.now = new Date('2026-11-05T01:00:00Z');
  await h.tick();
  const d = rows(db, 'DAILY_DISCOVERY');
  assert.equal(d.length, 1);
  assert.equal(d[0].status, 'COMPLETED');
  assert.equal(d[0].run_date, '2026-11-05');
  closeDb(db);
});

test('DAILY_REPORT: not before reportTime, queued+completed after, same-day idempotent', async () => {
  const db = tempDb();
  const h = makeHarness(db);
  h.now = new Date('2026-11-05T08:59:00Z'); // 16:59 Shanghai
  await h.tick();
  assert.equal(rows(db, 'DAILY_REPORT').length, 0, 'no report job before 18:00');

  h.now = new Date('2026-11-05T10:00:00Z'); // 18:00 Shanghai
  await h.tick();
  let rep = rows(db, 'DAILY_REPORT');
  assert.equal(rep.length, 1);
  assert.equal(rep[0].status, 'COMPLETED');
  assert.equal(rep[0].run_date, '2026-11-05');
  assert.ok(h.calls.some(([k, d]) => k === 'DAILY_REPORT' && d === '2026-11-05'), 'handler received correct run_date');

  h.now = new Date('2026-11-05T11:00:00Z'); // 19:00 same day
  await h.tick();
  rep = rows(db, 'DAILY_REPORT');
  assert.equal(rep.length, 1, 'same-day tick must not duplicate');
  assert.equal(h.calls.filter(([k]) => k === 'DAILY_REPORT').length, 1);
  closeDb(db);
});

test('PIPELINE_RUN: both slots fire once each, slot-suffixed run_date traces', async () => {
  const db = tempDb();
  const h = makeHarness(db);
  h.now = new Date('2026-11-05T02:01:00Z'); // 10:01 Shanghai
  await h.tick();
  let p = rows(db, 'PIPELINE_RUN');
  assert.equal(p.length, 1);
  assert.equal(p[0].run_date, '2026-11-05#1000');
  assert.equal(p[0].status, 'COMPLETED');
  assert.equal(JSON.parse(p[0].payload).phase, 'L0');

  h.now = new Date('2026-11-05T04:01:00Z'); // 12:01 Shanghai
  await h.tick();
  p = rows(db, 'PIPELINE_RUN');
  assert.equal(p.length, 2);
  assert.equal(p[1].run_date, '2026-11-05#1200');
  assert.equal(JSON.parse(p[1].payload).phase, 'FULL');

  h.now = new Date('2026-11-05T06:00:00Z'); // 14:00 same day
  await h.tick();
  assert.equal(rows(db, 'PIPELINE_RUN').length, 2, 'slots dedup within a day');
  closeDb(db);
});

test('cross-day simulation 11-05 08:00 -> 11-06 21:00 (60s discrete ticks)', async () => {
  const db = tempDb();
  const h = makeHarness(db);
  // 2026-11-05 08:00 Shanghai -> 2026-11-06 21:00 Shanghai, step 60s.
  let t = Date.parse('2026-11-05T00:00:00Z');
  const end = Date.parse('2026-11-06T13:00:00Z');
  let ticks = 0;
  while (t <= end) {
    h.now = new Date(t);
    await h.tick();
    t += 60000;
    ticks++;
  }
  assert.ok(ticks > 2000);
  const kinds = (k) => rows(db, k);
  for (const kind of ['RSS_SYNC', 'GITHUB_SYNC', 'PAPER_SYNC', 'DAILY_DISCOVERY', 'DAILY_REPORT', 'COVERAGE_AUDIT']) {
    const r = kinds(kind);
    assert.equal(r.length, 2, `${kind} once per day across two days`);
    assert.ok(r.every((x) => x.status === 'COMPLETED'), `${kind} all COMPLETED`);
  }
  const pipe = kinds('PIPELINE_RUN');
  assert.equal(pipe.length, 4, 'two pipeline slots x two days');
  assert.deepEqual(pipe.map((x) => x.run_date), ['2026-11-05#1000', '2026-11-05#1200', '2026-11-06#1000', '2026-11-06#1200']);
  // Report landed on the 18:00 boundary, not before.
  const rep5 = kinds('DAILY_REPORT')[0];
  assert.ok(Date.parse(rep5.started_at) >= Date.parse('2026-11-05T09:59:00Z'), 'report executed at/after 18:00 Shanghai');
  // No FAILED rows in a healthy run.
  assert.equal(all(db).filter((x) => x.status === 'FAILED').length, 0);
  closeDb(db);
});

test('restart recovery does not touch COMPLETED or fresh PENDING jobs', async () => {
  const db = tempDb();
  const h = makeHarness(db);
  h.now = new Date('2026-11-05T01:00:00Z');
  await h.tick();
  const before = all(db);
  const recovered = recoverStaleJobs(db, { staleMs: 10 * 60000 });
  assert.equal(recovered.length, 0, 'healthy COMPLETED/PENDING rows are untouched');
  assert.deepEqual(all(db), before);

  // A genuinely stale PROCESSING row is recovered; others stay intact.
  const { id } = enqueue(db, 'DAILY_REPORT', '2026-11-04');
  claimDueJob(db, {});
  db.prepare("UPDATE intel_job_executions SET updated_at = ? WHERE id = ?").run(new Date(Date.now() - 30 * 60000).toISOString(), id);
  const rec = recoverStaleJobs(db, { staleMs: 10 * 60000 });
  assert.equal(rec.length, 1);
  assert.equal(rec[0].kind, 'DAILY_REPORT');
  const fresh = db.prepare('SELECT * FROM intel_job_executions WHERE id = ?').get(rec[0].newId);
  assert.equal(fresh.status, 'PENDING');
  const completedStill = rows(db, 'RSS_SYNC');
  assert.ok(completedStill.every((x) => x.status === 'COMPLETED'), 'COMPLETED rows survive recovery');
  closeDb(db);
});

test('handler failure is retried with backoff and recorded, scheduler keeps running', async () => {
  const db = tempDb();
  let n = 0;
  const h = makeHarness(db, { handlers: { RSS_SYNC: async () => { n++; if (n === 1) throw new Error('network down'); return { inserted: 0 }; } } });
  h.now = new Date('2026-11-05T01:00:00Z');
  await h.tick();
  let rss = rows(db, 'RSS_SYNC');
  assert.equal(rss[0].status, 'PENDING', 'failed attempt requeued');
  assert.equal(rss[0].attempts, 1);
  assert.match(rss[0].error || '', /network down/);
  assert.ok(rss[0].updated_at, 'heartbeat/updated_at recorded');

  h.now = new Date(Date.parse('2026-11-05T01:03:00Z')); // past backoff (60s)
  await h.tick();
  rss = rows(db, 'RSS_SYNC');
  assert.equal(rss[0].status, 'COMPLETED', 'retry succeeds');
  closeDb(db);
});

function enqueue(db, kind, runDate) {
  const t = new Date().toISOString();
  const res = db.prepare(
    `INSERT INTO intel_job_executions (kind, run_date, status, attempts, max_attempts, payload, next_run_at, updated_at)
     VALUES (?, ?, 'PENDING', 0, 3, '{}', ?, ?)`
  ).run(kind, runDate, t, t);
  return { id: Number(res.lastInsertRowid) };
}
