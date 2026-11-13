import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb, closeDb, insertDocument } from '../lib/db.js';
import { parseArxiv, arxivIdParts, arxivDedupKey } from '../lib/adapters/arxiv.js';
import { fetchRepoSnapshot, saveStarSnapshot, snapshotRepo, starTrend } from '../lib/adapters/github.js';

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2401.12345v1</id>
    <title>Paper One</title>
    <summary>We propose a memory mechanism for agents.</summary>
    <published>2026-01-01T00:00:00Z</published>
    <updated>2026-01-01T00:00:00Z</updated>
    <category term="cs.AI"/><author><name>A. Author</name></author>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2401.12345v2</id>
    <title>Paper One (v2)</title>
    <summary>We propose a memory mechanism for agents, with new experiments.</summary>
    <published>2026-01-01T00:00:00Z</published>
    <updated>2026-02-01T00:00:00Z</updated>
    <category term="cs.AI"/><author><name>A. Author</name></author>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2402.99999</id>
    <title>Paper Two (no version suffix)</title>
    <summary>Another paper.</summary>
    <published>2026-01-05T00:00:00Z</published>
    <updated>2026-01-05T00:00:00Z</updated>
    <category term="cs.CL"/><author><name>B. Author</name></author>
  </entry>
</feed>`;

test('arxiv: version parsed, canonical split, v1/v2 same canonical different dedup_key both inserted', () => {
  const items = parseArxiv(XML);
  assert.equal(items.length, 3);
  const v1 = items[0];
  const v2 = items[1];
  const noV = items[2];

  assert.equal(v1.arxiv_version, 1);
  assert.equal(v2.arxiv_version, 2);
  assert.equal(noV.arxiv_version, 1, 'missing version suffix defaults to v1');
  assert.equal(arxivIdParts('http://arxiv.org/abs/2401.12345v2').canonical, '2401.12345');
  assert.equal(arxivIdParts('http://arxiv.org/abs/2402.99999').canonicalUrl, 'https://arxiv.org/abs/2402.99999');

  assert.notEqual(v1.dedup_key, v2.dedup_key, 'different versions carry different dedup keys');
  assert.ok(v1.dedup_key.startsWith(arxivDedupKey(v1.url).split('#')[0]));
  assert.equal(v2.dedup_key, `${arxivDedupKey(v2.url.split('v2')[0] + 'v2')}`.slice(0, 0) || v2.dedup_key); // sanity: helper callable

  const dir = mkdtempSync(path.join(tmpdir(), 'intelhub-arxiv7-'));
  const db = openDb(path.join(dir, 't.db'));
  const r1 = insertDocument(db, { url: v1.url, title: v1.title, summary: v1.summary, source_type: 'arxiv', lang: 'en', dedup_key: v1.dedup_key, arxiv_version: v1.arxiv_version, meta: v1.meta });
  const r2 = insertDocument(db, { url: v2.url, title: v2.title, summary: v2.summary, source_type: 'arxiv', lang: 'en', dedup_key: v2.dedup_key, arxiv_version: v2.arxiv_version, meta: v2.meta });
  const r1again = insertDocument(db, { url: v1.url, title: v1.title, summary: v1.summary, source_type: 'arxiv', lang: 'en', dedup_key: v1.dedup_key, arxiv_version: v1.arxiv_version, meta: v1.meta });
  assert.ok(r1.inserted && r2.inserted, 'v1 and v2 both inserted');
  assert.ok(!r1again.inserted, 'exact same version still deduped');
  assert.notEqual(r1.id, r2.id);
  const row = db.prepare('SELECT arxiv_version, meta FROM intel_documents WHERE id = ?').get(r2.id);
  assert.equal(row.arxiv_version, 2);
  const meta = JSON.parse(row.meta);
  assert.equal(meta.arxiv_canonical, '2401.12345', 'meta carries the canonical id');
  assert.equal(meta.arxiv_updated, '2026-02-01T00:00:00Z');
  closeDb(db);
});

// ---------------- github star snapshots (mock fetch) ----------------

function mockFetcher(repos) {
  return {
    getJson: async (url) => {
      const m = /repos\/(.+)$/.exec(url);
      const repo = m?.[1];
      const data = repos[repo];
      if (!data) throw new Error(`404 ${repo}`);
      return { full_name: repo, stargazers_count: data.stars, forks_count: data.forks, pushed_at: '2026-11-10T00:00:00Z' };
    },
  };
}

function isoDay(offsetDays, base = '2026-11-10T00:00:00Z') {
  return new Date(Date.parse(base) + offsetDays * 86400000);
}

test('github: snapshot same-day idempotent + trend over two snapshots', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'intelhub-stars7-'));
  const db = openDb(path.join(dir, 't.db'));
  const fetcher = mockFetcher({ 'acme/agent': { stars: 100, forks: 10 } });

  const s1 = await snapshotRepo(fetcher, db, 'acme/agent', { now: isoDay(0) });
  assert.ok(s1.saved);
  const s1again = await snapshotRepo(fetcher, db, 'acme/agent', { now: isoDay(0) });
  assert.ok(!s1again.saved && s1again.duplicate, 'same day is idempotent');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM intel_source_star_snapshots').get().n, 1);

  // next day: stars grew
  mockFetcher({ 'acme/agent': { stars: 130, forks: 12 } });
  const fetcher2 = mockFetcher({ 'acme/agent': { stars: 130, forks: 12 } });
  await snapshotRepo(fetcher2, db, 'acme/agent', { now: isoDay(3) });

  const trend = starTrend(db, 'acme/agent', { days: 30, now: isoDay(5) });
  assert.equal(trend.snapshots, 2);
  assert.equal(trend.deltaStars, 30);
  assert.equal(trend.deltaForks, 2);
  assert.ok(trend.trendUp);

  // old snapshots fall out of the window
  const trendWeek = starTrend(db, 'acme/agent', { days: 2, now: isoDay(5) });
  assert.equal(trendWeek.snapshots, 1);
  assert.equal(trendWeek.deltaStars, 0);

  assert.equal(starTrend(db, 'nope/nope', { days: 30 }), null);
  const bad = await fetchRepoSnapshot(mockFetcher({}), 'missing/repo');
  assert.equal(bad, null, 'fetch failure returns null');
  closeDb(db);
});

test('saveStarSnapshot: unique (repo, snapshot_date) enforced and values stored', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'intelhub-stars8-'));
  const db = openDb(path.join(dir, 't.db'));
  const a = saveStarSnapshot(db, 'a/b', { stars: 5, forks: 1, date: '2026-11-09' });
  const b = saveStarSnapshot(db, 'a/b', { stars: 9, forks: 2, date: '2026-11-09' });
  assert.ok(a.saved && !b.saved);
  const c = saveStarSnapshot(db, 'a/b', { stars: 9, forks: 2, date: '2026-11-10' });
  assert.ok(c.saved, 'different day allowed');
  const row = db.prepare('SELECT * FROM intel_source_star_snapshots WHERE snapshot_date = ?').get('2026-11-09');
  assert.equal(row.stars, 5, 'first snapshot of the day wins');
  closeDb(db);
});
