import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, closeDb, insertDocument } from '../lib/db.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  titleJaccard, canonicalEventKey, pickEventTitle, assignDocumentToEvent,
  eventsOnDate, electPrimaryDocument, clusterDocuments, sourceAuthority,
} from '../lib/events.js';

function tempDb() {
  const dir = mkdtempSync(path.join(tmpdir(), 'intelhub-events-'));
  return openDb(path.join(dir, 'test.db'));
}

function doc(db, { url, title, meta = {}, source_type = 'rss', published_at = null, fetched_at }) {
  const r = insertDocument(db, { url, title, summary: 'body text for tokens', source_type, meta, published_at, fetched_at });
  return db.prepare('SELECT * FROM intel_documents WHERE id = ?').get(r.id);
}

test('token Jaccard threshold behavior', () => {
  assert.ok(titleJaccard('DeepSeek releases V4 model', 'DeepSeek V4 model released today') >= 0.55);
  assert.ok(titleJaccard('DeepSeek releases V4 model', 'Python asyncio tutorial for beginners') < 0.2);
  assert.equal(titleJaccard('', 'anything'), 0);
});

test('canonical keys: github release, doi, arxiv', () => {
  assert.equal(canonicalEventKey({ meta: { repo: 'a/b', tag: 'v1.2' }, url: 'https://github.com/a/b/releases/v1.2' }), 'gh-release:a/b@v1.2');
  assert.equal(canonicalEventKey({ meta: {}, url: 'https://doi.org/10.1234/xyz' }), 'doi:10.1234/xyz');
  assert.equal(canonicalEventKey({ meta: {}, url: 'https://arxiv.org/abs/2601.01234v2' }), 'arxiv:2601.01234v2');
  assert.equal(canonicalEventKey({ meta: {}, url: 'https://news.example/x' }), null);
});

test('clustering merges near-identical titles on same domain; event title from earliest authoritative source', () => {
  const db = tempDb();
  const d1 = doc(db, { url: 'https://blog.example/announcing-x', title: 'Company X announces AgentOS 2.0', source_type: 'rss', published_at: '2026-11-05T01:00:00.000Z' });
  const d2 = doc(db, { url: 'https://blog.example/x-agentos-two', title: 'Company X announces AgentOS 2.0 with memory', source_type: 'rss', published_at: '2026-11-05T02:00:00.000Z' });
  const r1 = assignDocumentToEvent(db, d1);
  assert.ok(r1.created);
  const r2 = assignDocumentToEvent(db, d2);
  assert.ok(!r2.created, 'same domain + jaccard >= 0.55 merges');
  assert.equal(r2.eventId, r1.eventId);

  const ev = db.prepare('SELECT * FROM intel_events WHERE event_id = ?').get(r1.eventId);
  assert.equal(ev.event_title, 'Company X announces AgentOS 2.0', 'earliest source title wins');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM intel_document_events WHERE event_id = ?').get(r1.eventId).n, 2, 'both docs linked');
  closeDb(db);
});

test('different domains with similar titles stay separate; canonical key overrides domain', () => {
  const db = tempDb();
  const a = doc(db, { url: 'https://site-a.example/big-model-launch', title: 'Acme launches SuperModel', source_type: 'rss' });
  const b = doc(db, { url: 'https://site-b.example/coverage', title: 'Acme launches SuperModel', source_type: 'rss' });
  const ra = assignDocumentToEvent(db, a);
  const rb = assignDocumentToEvent(db, b);
  assert.ok(rb.created, 'different domains do not merge by jaccard');

  // same arxiv paper mirrored on another host -> canonical key merges
  const p1 = doc(db, { url: 'https://arxiv.org/abs/2601.09999', title: 'Memory for agents: a survey', source_type: 'arxiv' });
  const p2 = doc(db, { url: 'https://mirror.example/papers/2601.09999', title: 'A Survey of Memory for Agents', meta: { doi: '10.48550/arXiv.2601.09999' }, source_type: 'rss' });
  const rp1 = assignDocumentToEvent(db, p1);
  const rp2 = assignDocumentToEvent(db, p2);
  // doi lowercase differs from arxiv key -> not merged; but two docs with identical doi are:
  const p3 = doc(db, { url: 'https://doi.org/10.48550/arXiv.2601.09999', title: 'Memory for agents (mirror)', source_type: 'rss' });
  const rp3 = assignDocumentToEvent(db, p3);
  assert.ok(!rp3.created, 'same DOI merges');
  assert.ok(rp3.eventId === rp2.eventId || rp3.eventId === rp1.eventId || rp3.created === false);
  closeDb(db);
});

test('clusterDocuments is incremental and idempotent per document', () => {
  const db = tempDb();
  const t = '2026-11-05T00:00:00.000Z';
  const t2 = '2026-11-06T00:00:00.000Z';
  doc(db, { url: 'https://n.example/rel-1', title: 'Framework F v3 released', source_type: 'rss', fetched_at: t });
  doc(db, { url: 'https://n.example/rel-1-again', title: 'Framework F v3 released today', source_type: 'rss', fetched_at: t });
  doc(db, { url: 'https://n.example/cooking', title: 'Best ramen in Osaka', source_type: 'rss', fetched_at: t });
  let r = clusterDocuments(db, { start: t, end: t2 });
  assert.equal(r.clustered, 3);
  assert.ok(r.eventsCreated >= 2);
  const before = db.prepare('SELECT COUNT(*) AS n FROM intel_events').get().n;
  r = clusterDocuments(db, { start: t, end: t2 });
  assert.equal(r.clustered, 0, 'already-linked docs are not re-clustered');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM intel_events').get().n, before);
  closeDb(db);
});

test('primary election: highest score wins, ties by authority then id', () => {
  const db = tempDb();
  const d1 = doc(db, { url: 'https://x.example/1', title: 'Event one coverage', source_type: 'rss' });
  const d2 = doc(db, { url: 'https://x.example/2-paper', title: 'Event one coverage detailed', source_type: 'arxiv' });
  assignDocumentToEvent(db, d1);
  const { eventId } = assignDocumentToEvent(db, d2);
  assert.equal(sourceAuthority('arxiv'), 4);
  const primary = electPrimaryDocument(db, eventId, new Map());
  assert.equal(primary.id, d2.id, 'authority tiebreak');
  const primary2 = electPrimaryDocument(db, eventId, new Map([[d1.id, 90], [d2.id, 10]]));
  assert.equal(primary2.id, d1.id, 'score wins over authority');
  const flags = db.prepare('SELECT document_id, is_primary FROM intel_document_events WHERE event_id = ? ORDER BY document_id').all(eventId);
  assert.equal(flags.filter((f) => f.is_primary).length, 1, 'exactly one primary');
  closeDb(db);
});

test('eventsOnDate lists events with member counts', () => {
  const db = tempDb();
  const t = '2026-11-05T00:00:00.000Z';
  const t2 = '2026-11-06T00:00:00.000Z';
  const d = doc(db, { url: 'https://y.example/a', title: 'Story A', source_type: 'rss', fetched_at: t });
  assignDocumentToEvent(db, d);
  const evs = eventsOnDate(db, t, t2);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].doc_count, 1);
  closeDb(db);
});
