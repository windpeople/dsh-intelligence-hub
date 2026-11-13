import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, closeDb, insertDocument, searchDocuments, migrate, ensureSources, getStats, getDocument } from '../lib/db.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function tempDb() {
  const dir = mkdtempSync(path.join(tmpdir(), 'intelhub-test-'));
  return openDb(path.join(dir, 'test.db'));
}

test('migrations run and are idempotent', () => {
  const db = tempDb();
  const v1 = migrate(db);
  const v2 = migrate(db);
  assert.equal(v1, v2);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  for (const t of ['intel_sources', 'intel_documents', 'intel_collection_jobs', 'intel_reports', 'intel_documents_fts', 'schema_version']) {
    assert.ok(tables.includes(t), `table ${t} exists`);
  }
  closeDb(db);
});

test('document insert is idempotent on dedup_key', () => {
  const db = tempDb();
  const doc = { url: 'https://example.com/a?utm=1', title: 'Hello', summary: 'world', source_type: 'rss', lang: 'en', topic: 'general' };
  const r1 = insertDocument(db, doc);
  const r2 = insertDocument(db, { ...doc, title: 'Hello (dup)' });
  assert.ok(r1.inserted);
  assert.ok(!r2.inserted, 'same canonical URL must be ignored');
  const rows = db.prepare('SELECT * FROM intel_documents').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Hello');
  assert.ok(rows[0].dedup_key, 'dedup_key set');
  assert.ok(JSON.parse(rows[0].meta));
  closeDb(db);
});

test('dedup ignores query params and trailing slash', () => {
  const db = tempDb();
  const r1 = insertDocument(db, { url: 'https://example.com/x/', title: 'a', source_type: 'rss' });
  const r2 = insertDocument(db, { url: 'https://example.com/x/?utm_source=n', title: 'b', source_type: 'rss' });
  const r3 = insertDocument(db, { url: 'https://other.com/x', title: 'c', source_type: 'rss' });
  assert.ok(r1.inserted && !r2.inserted && r3.inserted);
  closeDb(db);
});

test('search finds by keyword via FTS and via LIKE fallback', () => {
  const db = tempDb();
  insertDocument(db, { url: 'https://a.com/1', title: 'LLM Agent Framework released', summary: 'an open source agent toolkit', source_type: 'github' });
  insertDocument(db, { url: 'https://a.com/2', title: '大模型智能体框架发布', summary: '全新的开源智能体框架，支持记忆与工具调用', source_type: 'rss' });
  insertDocument(db, { url: 'https://a.com/3', title: 'unrelated cooking recipe', summary: 'how to boil pasta', source_type: 'rss' });

  const en = searchDocuments(db, { query: 'agent' });
  assert.ok(en.some((d) => d.url === 'https://a.com/1'));

  const zh = searchDocuments(db, { query: '智能体' });
  assert.ok(zh.some((d) => d.url === 'https://a.com/2'), 'CJK bigram FTS search works');

  const like = searchDocuments(db, { query: 'boil pasta' });
  assert.ok(like.some((d) => d.url === 'https://a.com/3'));

  const filtered = searchDocuments(db, { sourceType: 'github' });
  assert.equal(filtered.length, 1);
  closeDb(db);
});

test('sources seeding, stats and getDocument', () => {
  const db = tempDb();
  assert.equal(ensureSources(db), 6);
  assert.equal(ensureSources(db), 6, "seeding idempotent");
  const r = insertDocument(db, { url: 'https://a.com/9', title: 't', summary: 's', source_type: 'arxiv' });
  const st = getStats(db);
  assert.equal(st.documents, 1);
  assert.equal(st.sources, 6);
  const doc = getDocument(db, r.id);
  assert.equal(doc.url, 'https://a.com/9');
  assert.equal(getDocument(db, 999), null);
  closeDb(db);
});
