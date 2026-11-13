import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed, fetchRss } from '../lib/adapters/rss.js';
import { parseArxiv } from '../lib/adapters/arxiv.js';
import { createFetcher, isRetryableStatus } from '../lib/http.js';
import { normalizeItems, withTimeout, createCollectLock } from '../lib/pipeline.js';

const RSS_SAMPLE = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Test Feed</title>
<item><title><![CDATA[First post about LLM agents]]></title>
<link>https://example.com/one?utm=x</link>
<pubDate>Mon, 01 Jan 2026 00:00:00 GMT</pubDate>
<description><![CDATA[<p>An agent toolkit</p>]]></description></item>
<item><title>Second &amp; last</title>
<link>https://example.com/two/</link>
<description>plain text</description></item>
</channel></rss>`;

const ATOM_SAMPLE = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>T</title>
<entry><title>Atom entry one</title>
<link rel="alternate" href="https://example.org/a1"/>
<published>2026-01-02T03:04:05Z</published>
<summary><![CDATA[summary text here]]></summary></entry>
</feed>`;

test('parseFeed handles RSS 2.0 with CDATA and entities', () => {
  const items = parseFeed(RSS_SAMPLE);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'First post about LLM agents');
  assert.equal(items[0].url, 'https://example.com/one?utm=x');
  assert.equal(items[0].summary, 'An agent toolkit');
  assert.equal(items[0].publishedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(items[1].title, 'Second & last');
  assert.equal(items[1].url, 'https://example.com/two/');
});

test('parseFeed handles Atom entries', () => {
  const items = parseFeed(ATOM_SAMPLE);
  assert.equal(items.length, 1);
  assert.equal(items[0].url, 'https://example.org/a1');
  assert.equal(items[0].summary, 'summary text here');
});

test('fetchRss works against a stub fetch (no network)', async () => {
  const fetcher = createFetcher({ fetchImpl: async () => ({ status: 200, text: async () => RSS_SAMPLE }) });
  const items = await fetchRss(fetcher, 'https://example.com/feed');
  assert.equal(items.length, 2);
});

test('fetcher retries on 500 then succeeds', async () => {
  let calls = 0;
  const fetcher = createFetcher({ fetchImpl: async () => { calls++; if (calls < 2) return { status: 500 }; return { status: 200, text: async () => 'ok' }; }, minDelayMs: 0 });
  const text = await fetcher.getText('https://example.com');
  assert.equal(text, 'ok');
  assert.equal(calls, 2);
});

test('fetcher throws on 404 without retry', async () => {
  let calls = 0;
  const fetcher = createFetcher({ fetchImpl: async () => { calls++; return { status: 404 }; } });
  await assert.rejects(() => fetcher.getText('https://example.com/x'), /HTTP 404/);
  assert.equal(calls, 1);
  assert.ok(isRetryableStatus(503));
  assert.ok(!isRetryableStatus(404));
});

const ARXIV_SAMPLE = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<entry><id>http://arxiv.org/abs/2601.01234v1</id>
<title>Memory-Augmented
  Agents</title>
<summary>We study agent memory.</summary>
<published>2026-01-03T00:00:00Z</published>
<category term="cs.AI"/><category term="cs.CL"/>
<author><name>A. Author</name></author><author><name>B. Beta</name></author>
</entry></feed>`;

test('parseArxiv extracts entries, categories, authors', () => {
  const items = parseArxiv(ARXIV_SAMPLE);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Memory-Augmented Agents');
  assert.equal(items[0].url, 'http://arxiv.org/abs/2601.01234v1');
  assert.deepEqual(items[0].meta.categories, ['cs.AI', 'cs.CL']);
  assert.deepEqual(items[0].meta.authors, ['A. Author', 'B. Beta']);
  assert.equal(items[0].publishedAt, '2026-01-03T00:00:00Z');
});

test('normalizeItems fills lang/topic/hash/meta', () => {
  const docs = normalizeItems([
    { title: '智能体框架发布', url: 'https://e.com/z', summary: '全新的中文智能体框架' },
    { title: 'New agent paper', url: 'https://e.com/y', summary: 'agents', meta: { stars: 5 } },
  ], { sourceType: 'rss' });
  assert.equal(docs[0].lang, 'zh');
  assert.equal(docs[1].lang, 'en');
  assert.equal(docs[1].topic, 'ai-agents');
  assert.equal(docs[1].meta.stars, 5);
  assert.ok(docs[0].content_hash);
});

test('withTimeout rejects on timeout', async () => {
  await assert.rejects(() => withTimeout(new Promise(() => {}), 30, 'thing'), /timed out/);
  assert.equal(await withTimeout(Promise.resolve(7), 100), 7);
});

test('collect lock prevents reentry', () => {
  const lock = createCollectLock();
  assert.ok(lock.tryAcquire());
  assert.ok(!lock.tryAcquire());
  lock.release();
  assert.ok(lock.tryAcquire());
});
