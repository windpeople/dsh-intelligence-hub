import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, closeDb, insertDocument, ensureSources } from "../lib/db.js";
import { buildTools } from '../lib/tools.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function setup(config = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'intelhub-p5tools-'));
  const dbPath = path.join(dir, 'test.db');
  const db = openDb(dbPath);
  const cfg = { maxPerRun: 5, reportTimeZone: 'Asia/Shanghai', dbPath, reportsDir: path.join(dir, 'reports'), ...config };
  const tools = {};
  for (const t of buildTools({ db, config: cfg, webSearch: null, webFetch: null })) tools[t.name] = t;
  return { db, tools, close: () => closeDb(db) };
}

test('intel_submit_feedback: real implementation with confirmation payload', async () => {
  const { db, tools, close } = setup();
  try {
    ensureSources(db);
    const srcId = db.prepare("SELECT id FROM intel_sources WHERE source_type='rss' LIMIT 1").get().id;
    const doc = insertDocument(db, { url: 'https://fb.example/1', title: 'fb', source_type: 'rss', lang: 'en', topic: 'llm' }, srcId);
    const r = await tools.intel_submit_feedback.execute({ document_id: doc.id, feedback_type: 'irrelevant', comment: 'noise' });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.feedback_type, 'irrelevant');
    assert.equal(r.item_id, `doc:${doc.id}`);
    assert.equal(r.ranking_version, 'v1');
    assert.ok(Array.isArray(r.applied) && r.applied.length > 0, 'confirmation explains applied effects');
    assert.ok(Array.isArray(r.trace) && r.trace.length === 1, 'trace returned');
    const dedup = await tools.intel_submit_feedback.execute({ document_id: doc.id, feedback_type: 'irrelevant' });
    assert.ok(dedup.ok && dedup.deduped);
    const bad = tools.intel_submit_feedback.execute({ feedback_type: 'like' });
    await assert.rejects(bad, /must be one of/, 'invalid type rejected at the schema layer');
  } finally { close(); }
});

test('intel_submit_feedback bad_source confirmation shows source quality adjustment', async () => {
  const { db, tools, close } = setup();
  try {
    ensureSources(db);
    const srcId = db.prepare("SELECT id FROM intel_sources LIMIT 1").get().id;
    const doc = insertDocument(db, { url: 'https://bs.example/1', title: 'bs', source_type: 'rss', lang: 'en' }, srcId);
    const r = await tools.intel_submit_feedback.execute({ document_id: doc.id, feedback_type: 'bad_source' });
    assert.equal(r.source_id, srcId);
    assert.equal(r.quality_adjust, -10);
    const r2 = await tools.intel_submit_feedback.execute({ document_id: doc.id, feedback_type: 'keep' });
    assert.equal(r2.quality_adjust, -5, '+5 recovery visible in confirmation');
  } finally { close(); }
});

test('intel_list_sources: candidates filter + approve/reject actions', async () => {
  const { db, tools, close } = setup({ discoveryEnabled: true });
    ensureSources(db);
  try {
    const list = await tools.intel_list_sources.execute({});
    assert.ok(list.count >= 1);
    assert.ok('quality_adjust' in list.sources[0], 'quality adjustment surfaced');
    const empty = await tools.intel_list_sources.execute({ candidates: true });
    assert.equal(empty.count, 0);
    // seed a candidate directly through the discovery path
    const discovery = await import('../lib/discovery.js');
    const r = await discovery.recordDiscoveredSource(db, { url: 'https://tooltest.example/feed', via: 'test' }, {
      fetchText: async (url) => (new URL(url).pathname === '/feed' ? '<?xml?><rss><channel></channel></rss>' : '<html>x</html>'),
      resolver: async () => [{ address: '93.184.216.34', family: 4 }],
    });
    assert.ok(r.discovered);
    const cands = await tools.intel_list_sources.execute({ candidates: true, status: 'candidate' });
    assert.equal(cands.count, 1);
    assert.equal(cands.sources[0].status, 'candidate');
    const missing = await tools.intel_list_sources.execute({ action: 'approve' });
    assert.equal(missing.ok, false, 'approve without candidate_id rejected');
    const approved = await tools.intel_list_sources.execute({ action: 'approve', candidate_id: r.candidate_id });
    assert.ok(approved.ok && approved.source_id > 0, 'approve promotes into intel_sources');
    const after = await tools.intel_list_sources.execute({ candidates: true, status: 'approved' });
    assert.equal(after.count, 1);
    const rej = await tools.intel_list_sources.execute({ action: 'reject', candidate_id: r.candidate_id });
    assert.ok(!rej.ok || rej.status === 'approved', 'already-approved candidate keeps approved status on reject attempt');
  } finally { close(); }
});

test('intel_get_status includes the latest coverage summary', async () => {
  const { db, tools, close } = setup();
  try {
    ensureSources(db);
    const none = await tools.intel_get_status.execute({});
    assert.equal(none.last_coverage, null, 'null before any audit');
    const { runCoverageAudit } = await import('../lib/coverage.js');
    const dateStr = new Date().toISOString().slice(0, 10);
    await runCoverageAudit(db, { dateStr, timeZone: 'Asia/Shanghai', webSearch: null });
    const res = await tools.intel_get_status.execute({});
    assert.equal(res.last_coverage.date, dateStr);
    assert.ok(res.last_coverage.sources.total >= 1);
    assert.equal(typeof res.last_coverage.blind_spot_count, 'number');
  } finally { close(); }
});

test('intel_export_memory_facts: read-only JSON export tool', async () => {
  const { db, tools, close } = setup();
  try {
    const bridge = await import('../lib/memoryBridge.js');
    bridge.addFacts(db, { subject: 'MCP', facts: [{ fact: 'mcp fact', evidence_ids: ['e1'], source_url: 'https://mcp.example' }] });
    const all = await tools.intel_export_memory_facts.execute({});
    assert.ok(all.ok && all.readonly && all.count === 1);
    assert.equal(all.facts[0].subject, 'MCP');
    const filtered = await tools.intel_export_memory_facts.execute({ subject: 'MCP', since: '2100-01-01T00:00:00Z' });
    assert.equal(filtered.count, 0, 'since filter applied');
  } finally { close(); }
});

test('COVERAGE_AUDIT is a valid scheduled job kind and runs via the queue', async () => {
  const { db, close } = setup();
  try {
    ensureSources(db);
    const { enqueueJob, claimDueJob, completeJob, JOB_KINDS } = await import('../lib/scheduler.js');
    assert.ok(JOB_KINDS.includes('COVERAGE_AUDIT'));
    const j = enqueueJob(db, { kind: 'COVERAGE_AUDIT', runDate: new Date().toISOString().slice(0, 10) });
    assert.ok(j.enqueued);
    const job = claimDueJob(db, {});
    assert.equal(job.kind, 'COVERAGE_AUDIT');
    const { runCoverageAudit } = await import('../lib/coverage.js');
    const result = await runCoverageAudit(db, { dateStr: job.run_date, timeZone: 'Asia/Shanghai', webSearch: null });
    assert.ok(result.created);
    completeJob(db, job.id, { created: result.created, date: result.date });
    const r2 = await runCoverageAudit(db, { dateStr: job.run_date, timeZone: 'Asia/Shanghai', webSearch: null });
    assert.ok(!r2.created, 'second run same day is idempotent');
  } finally { close(); }
});
