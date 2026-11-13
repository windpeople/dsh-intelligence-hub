import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, closeDb, insertDocument, ensureSources, getStats } from '../lib/db.js';
import { buildTools } from '../lib/tools.js';
import { enqueueJob, completeJob, failJob, claimDueJob } from '../lib/scheduler.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'intelhub-tools-'));
  const dbPath = path.join(dir, 'test.db');
  const db = openDb(dbPath);
  const config = { maxPerRun: 5, reportTimeZone: 'Asia/Shanghai', dbPath, reportsDir: path.join(dir, 'reports') };
  const tools = {};
  for (const t of buildTools({ db, config, webSearch: null })) tools[t.name] = t;
  return { db, dbPath, config, tools };
}

test('intel_get_status includes queue, per-source errors, today counts and dedup', async () => {
  const { db, tools } = setup();
  ensureSources(db);
  const date = new Date().toISOString().slice(0, 10); // rough; status uses Shanghai day
  insertDocument(db, { url: 'https://a.com/1', title: 't', summary: 's', source_type: 'rss' });
  enqueueJob(db, { kind: 'RSS_SYNC', runDate: '2026-11-05' });
  const j = enqueueJob(db, { kind: 'GITHUB_SYNC', runDate: '2026-11-05' });
  claimDueJob(db, {});
  failJob(db, j.id, 'source exploded', { backoffBaseMs: 1 });

  const res = await tools.intel_get_status.execute({});
  assert.ok(res.stats.documents >= 1);
  assert.ok(res.queue, 'queue status present');
  assert.ok(res.queue.byStatus.PENDING >= 1);
  assert.ok(res.sources.length > 0);
  assert.ok('last_error' in res.sources[0]);
  assert.ok(typeof res.today.newDocs === 'number');
  assert.ok(typeof res.today.dedupSkipped === 'number');
  closeDb(db);
});

test('intel_web_search aggregates, dedups and reports provider unavailability', async () => {
  const { db, dbPath } = setup();
  // no webSearch capability
  const noCap = await buildTools({ db, config: { reportTimeZone: 'Asia/Shanghai', dbPath }, webSearch: null }).find((t) => t.name === 'intel_web_search').execute({ query: 'q' });
  assert.ok(!noCap.ok);
  assert.equal(noCap.error.code, 'WEB_PROVIDER_UNAVAILABLE');

  // throwing provider (simulating WEB_PROVIDER_UNAVAILABLE from the seam)
  const throwing = buildTools({ db, config: { reportTimeZone: 'Asia/Shanghai', dbPath }, webSearch: async () => { const e = new Error('no usable provider'); e.code = 'WEB_PROVIDER_UNAVAILABLE'; throw e; } }).find((t) => t.name === 'intel_web_search');
  const fail = await throwing.execute({ query: 'q' });
  assert.ok(!fail.ok);
  assert.match(fail.error.message, /no usable web search provider/);

  // happy path with duplicates + saveToDb
  const sources = [
    { url: 'https://x.com/a?utm=1', title: 'A', snippet: 'first' },
    { url: 'https://x.com/a', title: 'A dup', snippet: 'dupe' },
    { url: 'https://y.com/b', title: 'B', snippet: 'second' },
  ];
  const tool = buildTools({ db, config: { reportTimeZone: 'Asia/Shanghai', dbPath }, webSearch: async (req) => ({ sources, truncated: false }) }).find((t) => t.name === 'intel_web_search');
  const ok = await tool.execute({ query: 'agents', save_to_db: true });
  assert.ok(ok.ok);
  assert.equal(ok.count, 2, 'canonical-URL dedup');
  assert.equal(ok.saved.inserted, 2, 'saved into library');
  assert.deepEqual(ok.results.map((r) => r.title), ['A', 'B']);
  closeDb(db);
});

test('intel_get_daily_report returns markdown; generates on demand', async () => {
  const { db, tools } = setup();
  const r = insertDocument(db, { url: 'https://a.com/today', title: 'today doc from agent world', summary: 'content '.repeat(30), source_type: 'rss' });
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  // score the doc so it enters the report pipeline (top pick / further reading)
  const { saveDocScore } = await import('../lib/db.js');
  saveDocScore(db, { documentId: r.id, r: 60, n: 55, p: 40, e: 50, t: 70, total: 75, stage: 'L3', decision: 'RECOMMEND', createdAt: new Date().toISOString() });
  const res = await tools.intel_get_daily_report.execute({});
  assert.equal(res.date, today);
  assert.ok(res.found);
  assert.match(res.markdown, /# 情报日报 · /);
  assert.match(res.markdown, /today doc from agent world/);
  const again = await tools.intel_get_daily_report.execute({ date: today });
  assert.equal(again.created, false, 'second call returns stored report');
  closeDb(db);
});

test('intel_track_topic: get/suggest/confirm semantics and intel_submit_feedback stub', async () => {
  const { db, tools } = setup();
  const before = await tools.intel_track_topic.execute({ action: 'get' });
  assert.ok(before.ok && Array.isArray(before.profile.long_term_interests));

  // suggest is read-only
  const sug = await tools.intel_track_topic.execute({ action: 'suggest' });
  assert.ok(!sug.persisted);

  // confirm persists only with confirm action
  const upd = await tools.intel_track_topic.execute({
    action: 'confirm',
    patch: JSON.stringify({ long_term_interests: ['Agent Memory'], current_projects: [{ name: 'hub', goal: 'g', problems: ['p'], repos: ['me/hub'], direction: 'd' }] }),
  });
  assert.ok(upd.persisted);
  assert.deepEqual(upd.profile.long_term_interests, ['Agent Memory']);

  // invalid patch -> structured error, no write
  const bad = await tools.intel_track_topic.execute({ action: 'confirm', patch: 'not-json' });
  assert.equal(bad.error.code, 'INVALID_PATCH');

  // feedback (Phase 5): invalid type now rejected at the schema layer; real behavior covered in phase5tools.test.js
  await assert.rejects(
    tools.intel_submit_feedback.execute({ document_id: 1, feedback_type: 'like' }),
    /must be one of/,
  );
  closeDb(db);
});
