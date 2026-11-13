import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb, closeDb, ensureSources, markSourceRun } from '../lib/db.js';
import { runCoverageAudit, lastCoverageSummary, computeCoverageStats, STALE_HOURS, BLIND_STREAK } from '../lib/coverage.js';
import { insertDocument } from '../lib/db.js';

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'intelhub-cov-'));
  const db = openDb(path.join(dir, 't.db'));
  return { db, dir, close: () => closeDb(db) };
}

test('coverage audit: real stats, idempotent per date, markdown + report file', async () => {
  const { db, dir, close } = setup();
  try {
    ensureSources(db);
    const srcId = db.prepare("SELECT id FROM intel_sources WHERE source_type='rss' LIMIT 1").get().id;
    markSourceRun(db, srcId, { ok: true });
    const otherId = db.prepare("SELECT id FROM intel_sources WHERE id != ?").get(srcId).id;
    markSourceRun(db, otherId, { ok: false, error: 'HTTP 403 AUTH_REQUIRED' });
    markSourceRun(db, otherId, { ok: false, error: 'HTTP 403 AUTH_REQUIRED' });
    markSourceRun(db, otherId, { ok: false, error: 'HTTP 403 AUTH_REQUIRED' });
    const d = insertDocument(db, { url: 'https://example.org/x', title: 'Covered doc', summary: 's'.repeat(200), source_type: 'rss', lang: 'zh', topic: 'llm', published_at: new Date(Date.now() - 3 * 3600000).toISOString() }, srcId);
    db.prepare("INSERT INTO intel_scores (document_id, total, decision, created_at, ranking_version) VALUES (?, 82, 'RECOMMEND', ?, 'v1')").run(d.id, new Date().toISOString());

    const reportsDir = path.join(dir, 'reports');
    const dateStr = new Date().toISOString().slice(0, 10);
    const r1 = await runCoverageAudit(db, { dateStr, timeZone: 'Asia/Shanghai', reportsDir, webSearch: null });
    assert.ok(r1.created);
    assert.equal(r1.stats.sources.total, 6, 'real source count');
    assert.equal(r1.stats.sources.failed, 1, 'only the errored source counts as failed');
    assert.equal(r1.stats.coverage.documents_total, 1);
    assert.equal(r1.stats.funnel.recommendations, 1);
    assert.equal(r1.stats.coverage.zh_en_ratio, '1:0');
    assert.ok(Array.isArray(r1.stats.blind_spots));
    assert.ok(r1.stats.blind_spots.some((b) => b.kind === 'sample_skipped'), 'sampling skipped when no webSearch seam');
    assert.ok(r1.markdown.includes('未采集到 ≠ 不存在'), 'declaration present');
    assert.ok(r1.file_path && r1.file_path.includes(path.join('reports', 'coverage')), 'coverage md written');

    const r2 = await runCoverageAudit(db, { dateStr, timeZone: 'Asia/Shanghai', reportsDir, webSearch: null });
    assert.ok(!r2.created, 'same-date audit is idempotent');
    assert.equal(r2.stats.coverage.documents_total, 1);

    const summary = lastCoverageSummary(db);
    assert.equal(summary.date, dateStr);
    assert.equal(summary.sources.total, 6);
    assert.ok(summary.blind_spot_count >= 1);
  } finally { close(); }
});

test('coverage audit: consecutive failures and stale sources land in blind spots', async () => {
  const { db, dir, close } = setup();
  try {
    ensureSources(db);
    const id = db.prepare("SELECT id FROM intel_sources LIMIT 1").get().id;
    for (let i = 0; i < BLIND_STREAK; i++) markSourceRun(db, id, { ok: false, error: 'ECONNREFUSED feed unreachable' });
    const staleId = db.prepare("SELECT id FROM intel_sources WHERE id != ?").get(id).id;
    db.prepare('UPDATE intel_sources SET last_ok_at = ? WHERE id = ?').run(new Date(Date.now() - (STALE_HOURS + 5) * 3600000).toISOString(), staleId);

    const stats = await computeCoverageStats(db, { dateStr: new Date().toISOString().slice(0, 10), webSearch: null });
    const failing = stats.blind_spots.find((b) => b.kind === 'failing_sources');
    assert.ok(failing, 'failing source listed');
    assert.match(failing.sources[0].last_error, /ECONNREFUSED/);
    const stale = stats.blind_spots.find((b) => b.kind === 'stale_sources');
    assert.ok(stale, 'stale source flagged');
    assert.match(stale.sources[0].reason, /48h|从未/);
  } finally { close(); }
});

test('coverage audit: sampling path runs with an injectable webSearch seam and records misses', async () => {
  const { db, close } = setup();
  try {
    const { ensureDefaultProfile } = await import('../lib/profile.js');
    ensureDefaultProfile(db);
    const webSearch = async () => ({
      sources: [
        { url: 'https://covered.example/a', title: 'already in library' },
        { url: 'https://missing.example/b', title: 'not collected' },
      ],
    });
    insertDocument(db, { url: 'https://covered.example/a', title: 'covered', source_type: 'rss', lang: 'en' });
    const stats = await computeCoverageStats(db, { dateStr: new Date().toISOString().slice(0, 10), webSearch });
    const sample = stats.blind_spots.find((b) => b.kind === 'sample_missed');
    assert.ok(sample, 'sample check ran');
    assert.equal(sample.missed.length, 1);
    assert.match(sample.missed[0].url, /missing\.example/);
    assert.ok(sample.note.includes('不代表'));
  } finally { close(); }
});
