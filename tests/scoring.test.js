import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, closeDb, insertDocument } from '../lib/db.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  l0Filter, saveFilterStage, llmRelevanceCheck, l1Relevance, l2Novelty,
  practicalValue, evidenceQuality, timeliness, totalScore, decideStage,
  researchGate, resolveThresholds, runPipeline, validateRelevanceVerdict,
} from '../lib/scoring.js';
import { extractJson } from '../lib/analysis.js';
import { updateProfile } from '../lib/profile.js';

function tempDb() {
  const dir = mkdtempSync(path.join(tmpdir(), 'intelhub-score-'));
  return openDb(path.join(dir, 'test.db'));
}

const T0 = new Date('2026-11-05T12:00:00.000Z');
const fresh = '2026-11-05T08:00:00.000Z';

function doc(db, { url, title, summary = 'some body', raw_content, source_type = 'rss', published_at = fresh, fetched_at = fresh, lang = 'en' }) {
  const r = insertDocument(db, { url, title, summary, raw_content: raw_content ?? summary, source_type, published_at, fetched_at, lang });
  return db.prepare('SELECT * FROM intel_documents WHERE id = ?').get(r.id);
}

// ---------- L0 ----------
test('L0: filters empty/und/stale/duplicate docs with reasons; passes good docs', () => {
  const db = tempDb();
  const empty = doc(db, { url: 'https://a.example/1', title: '', summary: '' });
  db.prepare("UPDATE intel_documents SET title='', raw_content='', summary='', lang='und' WHERE id=?").run(empty.id);
  const f1 = l0Filter(db, db.prepare('SELECT * FROM intel_documents WHERE id=?').get(empty.id), { now: T0 });
  assert.ok(!f1.pass);
  const stale = doc(db, { url: 'https://a.example/2', title: 'old', published_at: '2026-05-01T00:00:00.000Z' });
  const f2 = l0Filter(db, stale, { now: T0 });
  assert.ok(!f2.pass && /stale/.test(f2.reason));
  const good = doc(db, { url: 'https://a.example/3', title: 'good doc' });
  const f3 = l0Filter(db, good, { now: T0 });
  assert.ok(f3.pass && f3.reason === '');
  saveFilterStage(db, good, f3);
  const meta = JSON.parse(db.prepare('SELECT meta FROM intel_documents WHERE id=?').get(good.id).meta);
  assert.equal(meta.filter_stage, 'L0');
  assert.equal(meta.filter_pass, true);
  closeDb(db);
});

// ---------- L1 ----------
test('validateRelevanceVerdict + extractJson on LLM output', () => {
  assert.equal(validateRelevanceVerdict({ score: 55, reason: 'ok', matched: ['RAG'] }), null);
  assert.ok(validateRelevanceVerdict({ score: 120, reason: 'x' }));
  assert.ok(validateRelevanceVerdict({ score: 50 }));
  const obj = extractJson('前置说明```json\n{"score": 60, "reason": "r", "matched": []}\n```');
  assert.equal(obj.score, 60);
});

function mockLlm(textOrFactory) {
  const factory = typeof textOrFactory === 'function' ? textOrFactory : () => textOrFactory;
  let calls = 0;
  return {
    calls: () => calls,
    // llm.stream is a plain function returning an async iterable (matches dsh-llm semantics).
    stream: (options) => {
      calls++;
      const text = factory(options);
      if (text instanceof Error) throw text;
      return (async function* () {
        yield { type: 'text-delta', text };
        yield { type: 'finish', reason: { kind: 'success' } };
      })();
    },
  };
}

test('L1 gray zone triggers LLM fine judgement (mock stream); outside gray zone it does not', async () => {
  const db = tempDb();
  updateProfile(db, { long_term_interests: ['RAG', 'MCP', 'Multi-Agent', 'Agent Memory'], current_projects: [], learning_goals: [], content_preferences: { deprioritize: [] } }, { confirm: true });
  const llm = mockLlm('{"score": 82, "reason": "实质性检索增强新方法", "matched": ["RAG"]}');

  // craft a doc whose rule score lands in 40-75: one interest hit (25) + project-less
  const d = doc(db, { url: 'https://r.example/rag-post', title: 'A new rag retrieval approach', summary: 'rag retrieval augmented ideas' });
  const r1 = await l1Relevance(db, d, { llm, provider: 'p', model: 'm' });
  assert.equal(r1.used_llm, true, 'gray-zone doc should use LLM');
  assert.equal(r1.relevance_score, 82);
  assert.ok(llm.calls() >= 1);

  // strong hit outside gray zone: multiple interest hits -> no LLM call added
  const callsBefore = llm.calls();
  const d2 = doc(db, { url: 'https://r.example/strong', title: 'rag retrieval augmented mcp multi-agent agent memory', summary: '' });
  const r2 = await l1Relevance(db, d2, { llm, provider: 'p', model: 'm' });
  assert.ok(r2.relevance_score >= 50 && r2.matched_goals.length >= 3, `strong doc multi-goal hit (score ${r2.relevance_score}, goals ${r2.matched_goals.length})`);
  assert.equal(r2.used_llm, false);
  assert.equal(llm.calls(), callsBefore);

  // zero-hit doc also skips LLM
  const d3 = doc(db, { url: 'https://r.example/cooking', title: 'ramen recipes', summary: '' });
  const r3 = await l1Relevance(db, d3, { llm, provider: 'p', model: 'm' });
  assert.equal(r3.used_llm, false);
  assert.equal(r3.relevance_score, 0);
  closeDb(db);
});

test('L1 LLM failure falls back to rule score with fallback flag', async () => {
  const db = tempDb();
  updateProfile(db, { long_term_interests: ['RAG'], current_projects: [], learning_goals: [], content_preferences: { deprioritize: [] } }, { confirm: true });
  const llm = mockLlm(() => new Error('provider down'));
  const d = doc(db, { url: 'https://r.example/gray', title: 'rag retrieval notes', summary: '' });
  const r = await l1Relevance(db, d, { llm, provider: 'p', model: 'm' });
  assert.equal(r.used_llm, false);
  assert.ok(r.llm_fallback);
  assert.equal(r.relevance_score, 40); // single interest hit = gray-zone entry
  closeDb(db);
});

// ---------- L2 ----------
test('L2: same-event duplicates lower novelty; unknown case returns 50/UNKNOWN; findings extracted', () => {
  const db = tempDb();
  const a = doc(db, { url: 'https://n.example/evt', title: 'Framework G 2.0 released with memory layer', summary: 'Framework G 2.0 released with memory layer and tool use support', raw_content: 'Framework G 2.0 released with memory layer and tool use support for agents' });
  const b = doc(db, { url: 'https://n.example/evt-2', title: 'Framework G 2.0 released today', summary: 'Framework G 2.0 released today bringing memory and tools', raw_content: 'Framework G 2.0 released today bringing memory layer and tool use' });
  const noveltyA = l2Novelty(db, a);
  const noveltyB = l2Novelty(db, b);
  assert.ok(noveltyB.novelty_score < 85, `high overlap must depress novelty (got ${noveltyB.novelty_score})`);
  assert.ok(noveltyB.known_before.length >= 1, 'overlap flagged as known_before');
  assert.equal(noveltyA.verification_status, 'UNVERIFIED');

  // UNKNOWN branch: isolated, very short doc
  const c = doc(db, { url: 'https://x.example/1', title: 'hi', summary: '', raw_content: '' });
  const nc = l2Novelty(db, c);
  assert.equal(nc.novelty_score, 50);
  assert.equal(nc.novelty_state, 'UNKNOWN');
  assert.equal(nc.verification_status, 'UNVERIFIED');

  // findings from stored analysis
  db.prepare('UPDATE intel_documents SET analysis = ? WHERE id = ?').run(JSON.stringify({ innovation: ['novel memory indexing'] }), b.id);
  const nb = l2Novelty(db, db.prepare('SELECT * FROM intel_documents WHERE id=?').get(b.id));
  assert.ok(nb.new_findings.some((f) => /memory indexing/.test(f)));
  closeDb(db);
});

// ---------- L3 ----------
test('L3 weights and threshold boundaries', () => {
  assert.equal(totalScore({ r: 100, n: 100, p: 100, e: 100, t: 100 }), 100);
  assert.equal(totalScore({ r: 0, n: 0, p: 0, e: 0, t: 0 }), 0);
  // weight check: r=100 others 0 -> 30
  assert.equal(totalScore({ r: 100, n: 0, p: 0, e: 0, t: 0 }), 30);
  const th = { archive: 50, digest: 50, recommend: 70, research: 85 };
  assert.equal(decideStage(49.9, th), 'ARCHIVE');
  assert.equal(decideStage(50, th), 'DIGEST');
  assert.equal(decideStage(69.9, th), 'DIGEST');
  assert.equal(decideStage(70, th), 'RECOMMEND');
  assert.equal(decideStage(85, th), 'RESEARCH');
  assert.deepEqual(resolveThresholds({ scoreThresholds: { recommend: 90 } }), { archive: 50, digest: 50, recommend: 90, research: 85 });
});

test('P/E/T heuristics', () => {
  const codey = { title: 'new agent sdk', raw_content: '```py\nprint(1)\n```', url: 'https://github.com/x/y', source_type: 'github' };
  assert.ok(practicalValue(codey) > 60);
  assert.ok(evidenceQuality({ source_type: 'arxiv', url: 'https://arxiv.org/abs/x' }) > evidenceQuality({ source_type: 'rss', url: 'https://news.ycom/b' }));
  assert.ok(timeliness({ published_at: fresh }, { now: T0 }) > timeliness({ published_at: '2026-01-01T00:00:00.000Z' }, { now: T0 }));
});

// ---------- Gate ----------
test('Research Gate: DEEP_RESEARCH with evidence, WATCHLIST when insufficient, ARCHIVE below digest', () => {
  const th = { archive: 50, digest: 50, recommend: 70, research: 85 };
  const paper = { source_type: 'arxiv', title: 't' };
  const deep = researchGate(null, paper, 90, { thresholds: th, eventDocCount: 1 });
  assert.equal(deep.decision, 'DEEP_RESEARCH');
  const watch = researchGate(null, { source_type: 'rss', title: 't' }, 90, { thresholds: th, eventDocCount: 1 });
  assert.equal(watch.decision, 'WATCHLIST');
  assert.ok(watch.status === 'watching');
  const deepMulti = researchGate(null, { source_type: 'rss', title: 't' }, 88, { thresholds: th, eventDocCount: 4 });
  assert.equal(deepMulti.decision, 'DEEP_RESEARCH');
  const watchLow = researchGate(null, { source_type: 'rss', title: 't' }, 60, { thresholds: th, eventDocCount: 2 });
  assert.equal(watchLow.decision, 'WATCHLIST');
  const archived = researchGate(null, { source_type: 'rss', title: 't' }, 40, { thresholds: th, eventDocCount: 1 });
  assert.equal(archived.decision, 'ARCHIVE');
});

// ---------- Full pipeline run ----------
test('runPipeline FULL scores the day, elects primaries, respects thresholds and is idempotent', async () => {
  const db = tempDb();
  updateProfile(db, { long_term_interests: ['Agent Memory', 'RAG', 'MCP'], current_projects: [], learning_goals: [], content_preferences: { deprioritize: [] } }, { confirm: true });
  doc(db, { url: 'https://a.example/mem-1', title: 'Agent memory survey with new benchmark', summary: 'agent memory benchmark for retrieval augmented systems', source_type: 'arxiv' });
  doc(db, { url: 'https://a.example/mem-2', title: 'Agent memory survey follow-up', summary: 'agent memory benchmark results for retrieval', source_type: 'arxiv' });
  doc(db, { url: 'https://c.example/x', title: '', summary: '', raw_content: '', lang: 'und' }); // L0 fail
  doc(db, { url: 'https://c.example/y', title: 'ramen guide', summary: 'how to cook ramen', source_type: 'rss' }); // low

  const cfg = { analysisEnabled: false, scoreThresholds: { archive: 50, digest: 50, recommend: 70, research: 85 } };
  const r1 = await runPipeline(db, { phase: 'FULL', dateStr: '2026-11-05', timeZone: 'UTC', config: cfg, now: T0, rng: () => 0.9 });
  assert.equal(r1.scored.filter((s) => !s.filtered_at).length, 3, 'three docs scored');
  assert.equal(r1.scored.filter((s) => s.filtered_at).length, 1, 'one doc L0-filtered');
  const filtered = r1.scored.find((s) => s.filtered_at);
  assert.ok(filtered && filtered.filtered_at.length > 0, `L0 reason recorded: ${filtered && filtered.filtered_at}`);
  assert.ok(r1.candidates.length >= 1, 'arxiv docs reach the gate');
  assert.ok(r1.events.length >= 1);
  // exactly one primary per event
  for (const ev of r1.events) {
    const n = db.prepare('SELECT COUNT(*) AS n FROM intel_document_events WHERE event_id = ? AND is_primary = 1').get(ev.event_id).n;
    assert.ok(n <= 1);
  }
  // idempotent: second run scores nothing new
  const r2 = await runPipeline(db, { phase: 'FULL', dateStr: '2026-11-05', timeZone: 'UTC', config: cfg, now: T0, rng: () => 0.9 });
  assert.equal(r2.scored.filter((s) => !s.exploratory).length, 0, 'second run scores nothing new');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM intel_scores').get().n, 4, 'all four docs have score rows (incl. L0-filtered)');

  // threshold boundary honored via config
  const high = db.prepare('SELECT MAX(total) AS t FROM intel_scores').get().t;
  const top = db.prepare('SELECT decision FROM intel_scores WHERE total = ?').get(high);
  assert.ok(top.decision === 'RESEARCH' || top.decision === 'RECOMMEND' || top.decision === 'DIGEST');
  closeDb(db);
});

test('runPipeline exploratory sampling marks ~5% of archived docs', async () => {
  const db = tempDb();
  updateProfile(db, { long_term_interests: [], current_projects: [], learning_goals: [], content_preferences: { deprioritize: [] } }, { confirm: true });
  for (let i = 0; i < 40; i++) {
    doc(db, { url: `https://e.example/${i}`, title: `filler ${i}`, summary: 'filler content without any profile hits', source_type: 'rss' });
  }
  const cfg = { analysisEnabled: false, scoreThresholds: { archive: 50, digest: 50, recommend: 70, research: 85 } };
  await runPipeline(db, { phase: 'FULL', dateStr: '2026-11-05', timeZone: 'UTC', config: cfg, now: T0, rng: () => 0.01 }); // rng always < 0.05
  const marked = db.prepare('SELECT COUNT(*) AS n FROM intel_scores WHERE exploratory = 1').get().n;
  assert.equal(marked, 40, 'deterministic rng=0.01 marks every archived doc');
  closeDb(db);
});
