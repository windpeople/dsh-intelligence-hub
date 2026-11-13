import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb, closeDb, insertDocument } from '../lib/db.js';
import {
  ensureTopics, ensureTopic, listTopics, topicProgress, classifyAgainstTopic,
  applyToTopicKnowledge, DEFAULT_TOPICS, CHANGE_KINDS, KNOWLEDGE_SECTIONS,
} from '../lib/topics.js';

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'intelhub-topics-'));
  const db = openDb(path.join(dir, 't.db'));
  const topics = ensureTopics(db);
  return { db, close: () => closeDb(db), topics };
}

function mkDoc(db, { title, summary, sourceType = 'rss' }) {
  const r = insertDocument(db, {
    url: `https://example.org/${Math.random().toString(36).slice(2)}`,
    title, summary, source_type: sourceType, lang: 'en', topic: 'general',
  });
  return db.prepare('SELECT * FROM intel_documents WHERE id = ?').get(r.id);
}

test('topic seeds are idempotent and listing/progress works', () => {
  const { db, close, topics } = setup();
  try {
    assert.equal(topics.length, 6);
    assert.ok(topics.every((t) => t.id > 0));
    const again = ensureTopics(db);
    assert.ok(again.every((t) => !t.created), 'second seed run creates nothing');
    assert.equal(listTopics(db).length, 6);
    const names = listTopics(db).map((t) => t.name);
    for (const n of ['Agent 架构', '长期记忆', 'MCP · A2A', '多智能体协作', 'LLM 推理', 'Agent 安全治理']) {
      assert.ok(names.includes(n), `seeded topic ${n}`);
    }
    const progress = topicProgress(db);
    assert.equal(progress.length, 6);
    assert.ok(progress.every((p) => p.completed_research === 0));
    const single = ensureTopic(db, { name: '临时专题', keywords: ['x'] });
    assert.ok(single.created);
    const dup = ensureTopic(db, { name: '临时专题' });
    assert.equal(dup.id, single.id);
    assert.ok(!dup.created);
    // topicProgress counts COMPLETED research tasks whose repo carries the topic name
    const t = '2026-11-01T00:00:00.000Z';
    db.prepare("INSERT INTO intel_research_tasks (task_id, repo, kind, status, created_at, updated_at) VALUES ('tr1','Agent 架构','research','COMPLETED',?,?)").run(t, t);
    db.prepare("INSERT INTO intel_research_tasks (task_id, repo, kind, status, created_at, updated_at) VALUES ('tr2','Agent 架构','research','RUNNING',?,?)").run(t, t);
    const pAgent = topicProgress(db).find((x) => x.name === 'Agent 架构');
    assert.equal(pAgent.completed_research, 1, 'only COMPLETED research tasks counted');
    assert.ok(Object.keys(pAgent.sections).length === KNOWLEDGE_SECTIONS.length);
  } finally { close(); }
});

test('five-way classification: new / supplement / known / conflict / major_change', async () => {
  const { db, close, topics } = setup();
  try {
    const mem = topics.find((t) => t.name === '长期记忆');
    const agent = topics.find((t) => t.name === 'Agent 架构');

    // 1) new: empty knowledge base, no keyword hit -> kind=new
    const unrelated = mkDoc(db, { title: 'Urban gardening basics', summary: 'How to grow tomatoes on a balcony with compost soil all year.' });
    const c1 = await classifyAgainstTopic(db, agent.id, unrelated);
    assert.equal(c1.kind, 'new');

    // 2) new with keyword hit but empty knowledge -> new (storage-wise identical)
    const kwDoc = mkDoc(db, { title: 'Agent planning with reflection', summary: 'An agent framework that plans and reflects over tool use traces.' });
    const c2 = await classifyAgainstTopic(db, agent.id, kwDoc);
    assert.equal(c2.kind, 'new');
    assert.ok(c2.keyword_hits.length > 0, 'keyword hits recorded');

    // 3) seed knowledge: supplement -> new active row + revision(change_kind)
    const seedDoc = mkDoc(db, { title: 'Memory retrieval for agents', summary: 'We study RAG based memory retrieval with vector embeddings for long-term agent memory across sessions.' });
    const a3 = applyToTopicKnowledge(db, mem.id, seedDoc, { kind: 'new', matched_sections: [], reason: 'seed' }, seedDoc.id);
    assert.ok(a3.written && a3.kind === 'new');
    assert.equal(a3.section, 'timeline', 'rss docs default to timeline section');
    const rev = db.prepare('SELECT * FROM intel_topic_knowledge_revisions WHERE knowledge_id = ?').get(a3.knowledge_id);
    assert.equal(rev.change_kind, 'new');

    // supplement: keyword-affine but moderate overlap
    const suppDoc = mkDoc(db, { title: 'Episodic memory compression', summary: 'We compress episodic agent memory traces with embedding clustering to reduce retrieval latency.' });
    const c3 = await classifyAgainstTopic(db, mem.id, suppDoc);
    assert.equal(c3.kind, 'supplement', `got ${c3.kind} (${c3.reason})`);
    const a4 = applyToTopicKnowledge(db, mem.id, suppDoc, c3, suppDoc.id);
    assert.ok(a4.written && a4.kind === 'supplement');
    assert.equal(db.prepare('SELECT change_kind FROM intel_topic_knowledge_revisions WHERE knowledge_id = ?').get(a4.knowledge_id).change_kind, 'supplement');

    // known: near-identical content, no signals -> nothing written
    const knownDoc = mkDoc(db, { title: 'Memory retrieval for agents (rehash)', summary: 'We study RAG based memory retrieval with vector embeddings for long-term agent memory across sessions.' });
    const c4 = await classifyAgainstTopic(db, mem.id, knownDoc);
    assert.equal(c4.kind, 'known', `got ${c4.kind} (${c4.reason})`);
    const a5 = applyToTopicKnowledge(db, mem.id, knownDoc, c4, knownDoc.id);
    assert.ok(!a5.written, 'known writes nothing');
    const before = db.prepare('SELECT COUNT(*) n FROM intel_topic_knowledge WHERE topic_id = ?').get(mem.id).n;

    // conflict: high similarity + negation signal
    const conflictDoc = mkDoc(db, { title: 'Memory retrieval for agents revisited', summary: 'We study RAG based memory retrieval with vector embeddings for long-term agent memory across sessions. The approach fails without reranking.' });
    const c5 = await classifyAgainstTopic(db, mem.id, conflictDoc);
    assert.equal(c5.kind, 'conflict', `got ${c5.kind} (${c5.reason})`);
    const a6 = applyToTopicKnowledge(db, mem.id, conflictDoc, c5, conflictDoc.id);
    assert.ok(a6.written && a6.superseded.length === 1, 'conflict supersedes the matched row');
    assert.equal(db.prepare('SELECT status FROM intel_topic_knowledge WHERE id = ?').get(a6.superseded[0]).status, 'superseded');
    const cRev = db.prepare('SELECT * FROM intel_topic_knowledge_revisions WHERE knowledge_id = ?').get(a6.knowledge_id);
    assert.equal(cRev.change_kind, 'conflict');
    assert.ok(cRev.prev_content.length > 0, 'revision records prev content');
    assert.ok(db.prepare('SELECT COUNT(*) n FROM intel_topic_knowledge WHERE topic_id = ? AND status = ?').get(mem.id, 'active').n === before, 'active count preserved after supersede');

    // major_change: high similarity + importance signal, no new contradiction
    const majorDoc = mkDoc(db, { title: 'Memory retrieval for agents breakthrough', summary: 'We study RAG based memory retrieval with vector embeddings for long-term agent memory across sessions. The approach fails without reranking but a record breakthrough lifts it on all benchmarks.' });
    const c6 = await classifyAgainstTopic(db, mem.id, majorDoc);
    assert.equal(c6.kind, 'major_change', `got ${c6.kind} (${c6.reason})`);
    assert.ok(CHANGE_KINDS.includes(c6.kind));
  } finally { close(); }
});

test('supersede chain and revision history are append-only and traceable', async () => {
  const { db, close, topics } = setup();
  try {
    const t = topics.find((x) => x.name === 'Agent 架构');
    const d1 = mkDoc(db, { title: 'Planner v1', summary: 'A hierarchical planner decomposes goals into subtasks with tool calls, scoring 60 on the benchmark.' });
    const c1 = await classifyAgainstTopic(db, t.id, d1);
    const a1 = applyToTopicKnowledge(db, t.id, d1, { ...c1, kind: 'new', matched_knowledge_ids: [] }, d1.id);
    const d2 = mkDoc(db, { title: 'Planner v2 conflict', summary: 'A hierarchical planner decomposes goals into subtasks with tool calls. It fails on 60 of the benchmark cases and cannot recover.' });
    const c2 = await classifyAgainstTopic(db, t.id, d2);
    assert.equal(c2.kind, 'conflict');
    const a2 = applyToTopicKnowledge(db, t.id, d2, c2, [d2.id]);
    assert.deepEqual(a2.superseded, [a1.knowledge_id]);

    // chain: 2 revisions, exactly 1 active row
    const revs = db.prepare('SELECT * FROM intel_topic_knowledge_revisions ORDER BY id').all();
    assert.equal(revs.length, 2);
    assert.equal(revs[1].prev_content.length > 0, true);
    const active = db.prepare("SELECT * FROM intel_topic_knowledge WHERE topic_id = ? AND status = 'active'").all(t.id);
    assert.equal(active.length, 1);
    assert.equal(active[0].id, a2.knowledge_id);
    const superseded = db.prepare("SELECT * FROM intel_topic_knowledge WHERE status = 'superseded'").all();
    assert.equal(superseded.length, 1);
  } finally { close(); }
});

test('transaction rollback: missing / unknown evidence rejects with zero writes', async () => {
  const { db, close, topics } = setup();
  try {
    const t = topics.find((x) => x.name === 'Agent 架构');
    assert.throws(() => applyToTopicKnowledge(db, t.id, { summary: 'no evidence at all' }, { kind: 'new', reason: '' }, []), /evidence required/);
    assert.throws(() => applyToTopicKnowledge(db, t.id, { summary: 'x' }, { kind: 'new', reason: '' }, 99999), /not found in intel_documents/);
    assert.throws(() => applyToTopicKnowledge(db, t.id, { summary: 'x' }, { kind: 'bogus', reason: '' }, []), /invalid classification kind|evidence/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM intel_topic_knowledge').get().n, 0, 'zero partial writes');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM intel_topic_knowledge_revisions').get().n, 0);
    // db still usable after rollback
    const doc = mkDoc(db, { title: 'ok', summary: 'fine' });
    const r = applyToTopicKnowledge(db, t.id, doc, { kind: 'new', matched_sections: [], reason: '' }, doc.id);
    assert.ok(r.written);
    assert.ok(KNOWLEDGE_SECTIONS.includes(r.section));
  } finally { close(); }
});
