import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, closeDb } from '../lib/db.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_PROFILE, ensureDefaultProfile, loadProfile, getMatchableProfile, matchProfile,
  updateProfile, suggestProfileUpdate, SYNONYMS,
} from '../lib/profile.js';

function tempDb() {
  const dir = mkdtempSync(path.join(tmpdir(), 'intelhub-profile-'));
  return openDb(path.join(dir, 'test.db'));
}

test('default profile is created once and idempotent', () => {
  const db = tempDb();
  const a = ensureDefaultProfile(db);
  assert.ok(a.created);
  assert.deepEqual(a.profile.long_term_interests, DEFAULT_PROFILE.long_term_interests);
  assert.deepEqual(a.profile.content_preferences.deprioritize.length > 0, true);
  const b = ensureDefaultProfile(db);
  assert.ok(!b.created);
  const p = loadProfile(db);
  assert.equal(p.profile_id, 'default');
  closeDb(db);
});

test('rule matching: interests, synonyms, repos, problems, learning goals, deprioritize', () => {
  const db = tempDb();
  const { profile, keywordSets } = getMatchableProfile(db);
  assert.ok(keywordSets.length >= 8);

  // strong hit: MCP synonym + AI Agent -> two interest hits
  const p1 = matchProfile(keywordSets, profile, {
    title: 'Model Context Protocol servers release for AI agents',
    summary: 'new function calling servers',
    url: 'https://github.com/modelcontextprotocol/servers',
  });
  assert.ok(p1.relevance_score >= 40, `expected >=40, got ${p1.relevance_score}`);
  assert.ok(p1.matched_goals.includes('MCP'));
  assert.ok(!p1.gray_zone, 'strong hits should exceed gray zone');

  // synonym hit: 智能体 counts as AI Agent
  const p2 = matchProfile(keywordSets, profile, { title: '一个开源智能体框架', summary: '', url: 'https://a.example/x' });
  assert.ok(p2.matched_goals.includes('AI Agent'));

  // project repo + problems
  const withProj = {
    ...profile,
    current_projects: [{ name: 'hub', goal: '筛选', problems: ['event clustering', '重复聚类'], repos: ['me/intel-hub'], direction: '' }],
  };
  const p3 = matchProfile(keywordSets, withProj, { title: 'improving event clustering quality', summary: '', url: '' });
  assert.ok(p3.matched_projects.includes('hub'));
  assert.ok(p3.matched_problems.some((x) => /clustering/.test(x)));

  // learning goal
  const withGoal = {
    ...profile,
    learning_goals: [{ tech: 'vllm', mastered: [], unmastered: ['paged attention'], target_capability: 'serving', depth: 'deep' }],
  };
  const p4 = matchProfile(keywordSets, withGoal, { title: 'paged attention deep dive in vllm', summary: '', url: '' });
  assert.ok(p4.matched_goals.some((g) => /vllm/i.test(g)));

  // deprioritize subtracts
  const promo = matchProfile(keywordSets, profile, { title: '限时优惠 agent course 介绍', summary: '入门教程 getting started', url: '' });
  assert.ok(promo.relevance_score < 40, `promo should be deprioritized, got ${promo.relevance_score}`);

  // no hit
  const none = matchProfile(keywordSets, profile, { title: '烤鸭的做法', summary: '', url: '' });
  assert.equal(none.relevance_score, 0);
  assert.ok(!none.gray_zone);
  assert.ok(none.reason.includes('未命中'));
  closeDb(db);
});

test('updateProfile: only confirm=true persists long-term fields; preview does not write', () => {
  const db = tempDb();
  const before = loadProfile(db);
  const r = updateProfile(db, { long_term_interests: ['Cool New Topic'] }, { confirm: false });
  assert.ok(!r.persisted);
  assert.deepEqual(loadProfile(db).long_term_interests, before.long_term_interests, 'preview must not persist');
  const r2 = updateProfile(db, { long_term_interests: ['Cool New Topic'], current_projects: [{ name: 'p1' }] }, { confirm: true });
  assert.ok(r2.persisted);
  const after = loadProfile(db);
  assert.deepEqual(after.long_term_interests, ['Cool New Topic']);
  assert.equal(after.current_projects.length, 1);
  assert.ok(after.updated_at);
  closeDb(db);
});

test('suggestProfileUpdate derives candidates from recent docs without persisting', () => {
  const db = tempDb();
  const before = loadProfile(db);
  const docs = [
    { title: 'llm serving guide', summary: 'llm serving', url: '' },
    { title: 'another llm serving post', summary: 'llm serving again', url: '' },
  ];
  const s = suggestProfileUpdate(db, docs);
  assert.ok(!s.persisted);
  assert.deepEqual(loadProfile(db), before, 'suggestion must not write');
  closeDb(db);
});

test('SYNONYMS cover every default long-term interest', () => {
  for (const interest of DEFAULT_PROFILE.long_term_interests) {
    assert.ok(Array.isArray(SYNONYMS[String(interest).toLowerCase()]), `synonyms for ${interest}`);
    assert.ok(SYNONYMS[String(interest).toLowerCase()].length >= 8, `${interest} has >=8 synonyms`);
  }
});

test('synonym expansion raises real-title hit rate (arXiv-style titles)', () => {
  const db = tempDb();
  const { profile, keywordSets } = getMatchableProfile(db);
  const samples = [
    { title: 'CompressionBench: benchmarking context memory compression for long-running agents', interest: 'Agent Memory' },
    { title: 'Episodic memory retrieval with knowledge graph memory for LLM agents', interest: 'Agent Memory' },
    { title: 'SGLang vs vLLM: KV cache batching for inference serving throughput', interest: 'AI Backend Engineering' },
    { title: 'A2A inter-agent handshake protocol for agent interoperability', interest: 'A2A' },
    { title: 'Chunking and rerank strategies for hybrid semantic retrieval', interest: 'RAG' },
    { title: 'Firecracker microvm sandboxing for agent isolation', interest: 'Agent Runtime' },
    { title: 'Multi-agent debate improves agent collaboration quality', interest: 'Multi-Agent' },
    { title: 'MCP tool registry with tool schema validation', interest: 'MCP' },
  ];
  let hits = 0;
  for (const s of samples) {
    const m = matchProfile(keywordSets, profile, { title: s.title, summary: '', url: '' });
    if (m.matched_goals.includes(s.interest)) hits++;
  }
  assert.ok(hits >= 7, `expected >=7/8 real-title hits, got ${hits}`);
  closeDb(db);
});

test('title hits weigh more than body hits (R improvement)', () => {
  const db = tempDb();
  const { profile, keywordSets } = getMatchableProfile(db);
  const titleHit = matchProfile(keywordSets, profile, { title: 'memory compression for agents', summary: '', url: '' });
  const bodyHit = matchProfile(keywordSets, profile, { title: 'untitled release notes', summary: 'mentions memory compression briefly', url: '' });
  assert.ok(titleHit.relevance_score > bodyHit.relevance_score, `title ${titleHit.relevance_score} should beat body ${bodyHit.relevance_score}`);
  assert.match(titleHit.reason, /\(title\)/);
  assert.match(bodyHit.reason, /\(body\)/);
  closeDb(db);
});
