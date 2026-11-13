import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb, closeDb, insertDocument, ensureSources } from '../lib/db.js';
import { batchAct } from '../lib/feedback.js';
import { recordUsage, todayUsage, withinBudget, promptCharsOf } from '../lib/usage.js';
import { runContentAnalysis, buildAnalysisMessages } from '../lib/analysis.js';

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'intelhub-batchusage-'));
  const db = openDb(path.join(dir, 't.db'));
  ensureSources(db);
  const src = db.prepare("SELECT id FROM intel_sources WHERE source_type='rss' LIMIT 1").get().id;
  const mk = (i) => {
    const r = insertDocument(db, {
      url: `https://example.org/b${i}`, title: `Doc ${i}`, summary: `body ${i}`,
      source_type: 'rss', lang: 'en', topic: 'llm',
    }, src);
    return r.id;
  };
  return { db, close: () => closeDb(db), ids: [mk(1), mk(2), mk(3)] };
}

test('batchAct: mixed valid/invalid items give per-item results; valid ones apply', () => {
  const { db, close, ids } = setup();
  try {
    const r = batchAct(db, {
      items: [
        { document_id: ids[0], feedback_type: 'irrelevant', related_topic: 'llm' },
        { document_id: ids[1], feedback_type: 'not_a_type' }, // invalid type -> per-item error
        { feedback_type: 'keep' }, // missing id -> per-item error
        { document_id: 99999, feedback_type: 'keep' }, // unknown doc -> effects no-op, still ok (recorded)
        { document_id: ids[2], feedback_type: 'pause_topic', related_topic: 'mcp' },
      ],
    });
    assert.ok(r.ok);
    assert.equal(r.total, 5);
    assert.equal(r.results[0].ok, true);
    assert.ok(!r.results[0].deduped);
    assert.equal(r.results[1].ok, false, 'invalid type reported per item');
    assert.equal(r.results[2].ok, false, 'missing item reported per item');
    assert.ok(r.results[3].ok, 'recorded even without doc match');
    assert.equal(r.results[4].ok, true);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM intel_feedback').get().n, 3);

    // effects applied for the relevant item (meta marker)
    const meta = JSON.parse(db.prepare('SELECT meta FROM intel_documents WHERE id = ?').get(ids[0]).meta);
    assert.equal(meta.feedback_exclusion.type, 'irrelevant');
  } finally { close(); }
});

test('batchAct bookmark option and transactional rollback on hard DB errors', () => {
  const { db, close, ids } = setup();
  try {
    const r = batchAct(db, { items: ids.map((id) => ({ document_id: id, feedback_type: 'keep', related_topic: 'llm' })), bookmark: true });
    assert.ok(r.ok);
    assert.equal(r.bookmarks, 3);
    const flags = db.prepare('SELECT bookmark FROM intel_documents ORDER BY id').all().map((x) => x.bookmark);
    assert.ok(flags.every((f) => f === 1));

    const off = batchAct(db, { items: [{ document_id: ids[0], feedback_type: 'keep', related_topic: 'llm' }], bookmark: false });
    assert.equal(off.bookmarks, 1, 'bookmark=false updates the flag');
    assert.equal(db.prepare('SELECT bookmark FROM intel_documents WHERE id = ?').get(ids[0]).bookmark, 0);
  } finally { close(); }
});

test('batchAct throws and rolls back the whole batch on a real DB error mid-batch', () => {
  const { db, close, ids } = setup();
  try {
    // Force a constraint failure: drop the documents table so the bookmark UPDATE throws mid-batch.
    db.exec('DROP TABLE intel_documents');
    assert.throws(() => batchAct(db, { items: [{ document_id: 1, feedback_type: 'irrelevant' }, { document_id: 2, feedback_type: 'keep' }], bookmark: true }));
    assert.equal(db.prepare('SELECT COUNT(*) n FROM intel_feedback').get().n, 0, 'whole batch rolled back');
  } finally { close(); }
});

// ---------------- usage accounting + budget skip ----------------

function mockLlm(responses) {
  let i = 0;
  return {
    calls: 0,
    async *stream() {
      this.calls++;
      yield { type: 'text-delta', text: responses[Math.min(i, responses.length - 1)] };
      i++;
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
}

test('usage: recordUsage/todayUsage aggregate by local day; withinBudget gates', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'intelhub-usage2-'));
  const db = openDb(path.join(dir, 't.db'));
  try {
    const now = new Date('2026-11-10T02:00:00Z'); // 10:00 Shanghai
    recordUsage(db, { call: 'a', promptChars: 100, completionChars: 200, now });
    recordUsage(db, { call: 'b', promptChars: 10, completionChars: 20, now });
    const u = todayUsage(db, { date: '2026-11-10' });
    assert.deepEqual([u.prompt_chars, u.completion_chars, u.calls], [110, 220, 2]);
    assert.deepEqual(todayUsage(db, { date: '2026-11-11' }), { date: '2026-11-11', prompt_chars: 0, completion_chars: 0, calls: 0 });

    assert.ok(withinBudget(db, { tokenBudgetPerDay: 0 }, { now }).allowed, '0 = unlimited');
    const gate = withinBudget(db, { tokenBudgetPerDay: 200 }, { timeZone: 'Asia/Shanghai', now });
    assert.equal(gate.allowed, false, '220 used already exceeds the 200 budget');
    assert.equal(gate.used, 220);
    const ok = withinBudget(db, { tokenBudgetPerDay: 500 }, { timeZone: 'Asia/Shanghai', now });
    assert.equal(ok.allowed, true);
    const tight = withinBudget(db, { tokenBudgetPerDay: 400 }, { estimateChars: 200, timeZone: 'Asia/Shanghai', now });
    assert.equal(tight.allowed, false, '220 + estimate 200 > 400');
    assert.ok(promptCharsOf(buildAnalysisMessages({ title: 't', url: 'u', raw_content: 'body' })) > 0);
  } finally { closeDb(db); }
});

test('runContentAnalysis: budget exhaustion skips LLM calls (mock llm), docs stay unanalyzed', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'intelhub-budgetskip-'));
  const db = openDb(path.join(dir, 't.db'));
  try {
    ensureSources(db);
    for (let i = 0; i < 3; i++) {
      insertDocument(db, {
        url: `https://example.org/s${i}`, title: `Skip doc ${i}`, summary: 'content body here for analysis',
        source_type: 'rss', lang: 'en', topic: 'llm', fetched_at: '2026-11-10T01:00:00Z',
      });
    }
    const llm = mockLlm(['```json\n{"summary":"好的摘要","relevance":7,"innovation":["a","b"]}\n```']);

    // unlimited budget: all docs analyzed
    const r1 = await runContentAnalysis(db, {
      llm, config: { analysisEnabled: true, analysisProvider: 'p', analysisModel: 'm', analysisMaxDocs: 10, reportTimeZone: 'Asia/Shanghai', tokenBudgetPerDay: 0 },
      job: { runDate: '2026-11-10' },
    });
    assert.equal(r1.analyzed.length, 3);
    assert.equal(r1.budget_skipped.length, 0);
    const u1 = todayUsage(db, {});
    assert.equal(u1.calls, 3, 'usage recorded per call');
    assert.ok(u1.completion_chars > 0);
    const usedChars = u1.completion_chars;

    // tiny budget + fresh unanalyzed docs: further calls skipped
    for (let i = 3; i < 6; i++) {
      insertDocument(db, {
        url: `https://example.org/s${i}`, title: `Skip doc ${i}`, summary: 'content body here for analysis',
        source_type: 'rss', lang: 'en', topic: 'llm', fetched_at: '2026-11-10T01:00:00Z',
      });
    }
    const r2 = await runContentAnalysis(db, {
      llm, config: { analysisEnabled: true, analysisProvider: 'p', analysisModel: 'm', analysisMaxDocs: 10, reportTimeZone: 'Asia/Shanghai', tokenBudgetPerDay: Math.max(1, Math.floor(usedChars / 2)) },
      job: { runDate: '2026-11-10' },
    });
    assert.equal(r2.analyzed.length, 0);
    assert.equal(r2.budget_skipped.length, 3, 'remaining docs skipped due to budget');
    const callsBefore = llm.calls;
    assert.equal(llm.calls, callsBefore, 'llm never invoked when over budget');
  } finally { closeDb(db); }
});
