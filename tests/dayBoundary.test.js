/**
 * Regression: local-day boundary (reportTimeZone) vs UTC day boundary.
 *
 * Scenario from production (2026-11-12, Asia/Shanghai): a document collected at
 * local 00:01 has fetched_at = 2026-11-11T16:01:00Z (UTC *previous* day). The
 * next morning's 10:00 local pipeline / dashboard ("today") must include it.
 *
 * Run: node --test tests/dayBoundary.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb, closeDb, insertDocument } from '../lib/db.js';
import { ensureTopics } from '../lib/topics.js';
import { runPipeline } from '../lib/scoring.js';
import { createWebApi } from '../lib/webapi.js';
import { localParts, localDayBounds } from '../lib/scheduler.js';
import { searchRecentRepos, splitOrQueries } from '../lib/adapters/github.js';

const TZ = 'Asia/Shanghai';
// local 2026-11-12 10:00 == 2026-11-12T02:00:00Z
const NOW = new Date('2026-11-12T02:00:00.000Z');
// local 2026-11-12 00:01 == 2026-11-11T16:01:00Z (UTC previous calendar day)
const FETCHED_AT = '2026-11-11T16:01:00.000Z';

function tempDb() {
  const dir = mkdtempSync(path.join(tmpdir(), 'intelhub-daybounds-'));
  const db = openDb(path.join(dir, 'daybounds.db'));
  ensureTopics(db);
  return db;
}

function doc(db, { url, title, summary }) {
  const r = insertDocument(db, {
    url, title, summary,
    source_type: 'rss',
    lang: 'en',
    topic: 'general',
    published_at: '2026-11-11T20:00:00.000Z',
    fetched_at: FETCHED_AT,
  });
  assert.equal(r.inserted, true);
  return db.prepare('SELECT * FROM intel_documents WHERE id = ?').get(r.id);
}

test('localDayBounds puts local-midnight doc inside local next day, outside UTC day', () => {
  assert.equal(localParts(NOW, TZ).date, '2026-11-12');
  const { start, end } = localDayBounds('2026-11-12', TZ);
  assert.equal(start, '2026-11-11T16:00:00.000Z');
  assert.ok(FETCHED_AT >= start && FETCHED_AT < end, 'fetched_at within local day');
  // UTC calendar day of 11-12 would be [2026-11-12T00:00Z, ...): excludes the doc.
  assert.ok(FETCHED_AT < '2026-11-12T00:00:00.000Z');
});

test('pipeline 10:00 local run selects and scores the local-midnight doc', async () => {
  const db = tempDb();
  doc(db, { url: 'https://example.net/midnight', title: 'agent framework released at midnight', summary: 'an agent framework with planning and memory' });
  const dateStr = localParts(NOW, TZ).date; // what enqueuePipelineRun stores

  const l0 = await runPipeline(db, { phase: 'L0', dateStr, timeZone: TZ, now: NOW });
  assert.equal(l0.l0.passed, 1, 'L0 must pass the doc collected just after local midnight');
  assert.equal(l0.l0.filtered, 0);

  // L0 phase is idempotent: re-running must not double-count.
  const l0again = await runPipeline(db, { phase: 'L0', dateStr, timeZone: TZ, now: NOW });
  assert.equal(l0again.l0.passed, 0);
  assert.equal(l0again.l0.filtered, 0);

  const full = await runPipeline(db, { phase: 'FULL', dateStr, timeZone: TZ, now: NOW });
  assert.equal(full.scored.length, 1, 'scoring phase must score the same day set');
  assert.equal(full.scored[0].decision !== undefined, true);
  closeDb(db);
});

test('webapi getStatus/getWorkbench count the local-midnight doc as today', async () => {
  const db = tempDb();
  doc(db, { url: 'https://example.net/midnight2', title: 'midnight collected rss item', summary: 'an agent framework with planning and memory skills' });
  const api = createWebApi(db, { reportTimeZone: TZ });

  const status = api.getStatus();
  assert.equal(status.todayAdded, 1);

  const wb = api.getWorkbench();
  assert.equal(wb.todayAdded, 1);
  // No clustering ran in this fixture, so eventsToday is legitimately 0; the
  // bounds themselves are verified via the pipeline + trend7 assertions below.
  assert.equal(wb.eventsToday, 0);
  const today = wb.trend7.at(-1);
  assert.equal(today.date, '2026-11-12');
  assert.equal(today.count, 1, 'trend7 last bucket (local today) counts the doc');
  assert.ok(wb.trend7.slice(0, 6).every((d) => d.count === 0));
  closeDb(db);
});

// ---------- Bug 2 helpers (real network smoke lives in scripts/smokeGithub.js) ----------

test('splitOrQueries splits OR queries; single query stays single', () => {
  assert.deepEqual(splitOrQueries('topic:llm-agent OR topic:ai-agents'), ['topic:llm-agent', 'topic:ai-agents']);
  assert.deepEqual(splitOrQueries('topic:llm-agent'), ['topic:llm-agent']);
  assert.deepEqual(splitOrQueries('  a  OR  b OR c '), ['a', 'b', 'c']);
});

test('searchRecentRepos merges OR sub-queries and dedupes by full_name', async () => {
  const seen = [];
  const fetcher = {
    getJson: async (url) => {
      seen.push(url);
      if (/topic%3Allm-agent/.test(url)) {
        return { items: [{ full_name: 'a/one', stargazers_count: 10, html_url: 'https://github.com/a/one', description: 'one', created_at: '2026-11-10T00:00:00Z' }] };
      }
      return { items: [{ full_name: 'a/one', stargazers_count: 99, html_url: 'https://github.com/a/one', description: 'one-newer', created_at: '2026-11-10T00:00:00Z' }, { full_name: 'b/two', stargazers_count: 50, html_url: 'https://github.com/b/two', description: 'two', created_at: '2026-11-11T00:00:00Z' }] };
    },
  };
  const repos = await searchRecentRepos(fetcher, { query: 'topic:llm-agent OR topic:ai-agents', days: 7, perPage: 20 });
  assert.equal(seen.length, 2, 'two sub-requests, one per OR operand');
  assert.deepEqual(repos.map((r) => r.title), ['a/one ★99', 'b/two ★50'], 'dedupe keeps the higher-star record, sorted by stars');
});

test('searchRecentRepos tolerates one failing sub-query, throws only when all fail', async () => {
  let calls = 0;
  const flaky = { getJson: async () => { calls++; if (calls === 1) throw new Error('rate limited'); return { items: [{ full_name: 'c/three', stargazers_count: 5, html_url: 'https://github.com/c/three', description: '', created_at: null }] }; } };
  const repos = await searchRecentRepos(flaky, { query: 'topic:x OR topic:y', days: 7 });
  assert.equal(repos.length, 1);
  const allBad = { getJson: async () => { throw new Error('403'); } };
  await assert.rejects(() => searchRecentRepos(allBad, { query: 'topic:x OR topic:y', days: 7 }), /403/);
});
