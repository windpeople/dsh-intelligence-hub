import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb, closeDb, ensureSources } from '../lib/db.js';
import { addFacts, exportFacts, ruleExtractFacts, extractAndStoreFacts, validateLlmFacts, MIN_EVIDENCE } from '../lib/memoryBridge.js';

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'intelhub-mb-'));
  const db = openDb(path.join(dir, 't.db'));
  ensureSources(db);
  return { db, dir, close: () => closeDb(db) };
}

const researchResult = {
  topic: 'Agent Memory',
  evidences: [
    { id: 'e1', url: 'https://a.example/1', title: 'A', quote: 'Memory A result.' },
    { id: 'e2', url: 'https://b.example/2', title: 'B', quote: 'Memory B result.' },
    { id: 'e3', url: 'https://c.example/3', title: 'C', quote: 'Memory C result.' },
  ],
  report: 'markdown...',
};

function seedResearchTask(db, taskId = 'dr-test1', evidences = 3) {
  const result = { ...researchResult, evidences: researchResult.evidences.slice(0, evidences) };
  db.prepare(
    `INSERT INTO intel_research_tasks (task_id, kind, repo, status, result_json, created_at, updated_at)
     VALUES (?, 'research', 'Agent Memory', 'COMPLETED', ?, ?, ?)`
  ).run(taskId, JSON.stringify(result), new Date().toISOString(), new Date().toISOString());
}

test('fact versioning: new evidence supersedes old facts via valid_to + superseded_by, never overwrites', () => {
  const { db, close } = setup();
  try {
    const v1 = addFacts(db, { subject: 'Agent Memory', facts: [{ fact: 'v1 claim', evidence_ids: ['e1'], source_url: 'https://a.example/1' }] });
    assert.equal(v1.added, 1);
    const v2 = addFacts(db, { subject: 'Agent Memory', facts: [{ fact: 'v2 claim', evidence_ids: ['e2', 'e3'] }, { fact: 'v2 claim 2', evidence_ids: ['e2'] }] });
    assert.equal(v2.superseded, 1, 'old version closed');
    const rows = db.prepare('SELECT * FROM intel_knowledge_facts ORDER BY id').all();
    assert.equal(rows.length, 3, 'history preserved');
    const old = rows[0];
    assert.ok(old.valid_to, 'old fact closed (valid_to set)');
    assert.equal(old.superseded_by, v2.ids[0], 'superseded_by points at the new fact');
    assert.equal(old.fact, 'v1 claim', 'old fact text not overwritten');
    const active = exportFacts(db).facts;
    assert.equal(active.length, 2, 'only current version exported by default');
    const all = exportFacts(db, { includeSuperseded: true }).facts;
    assert.equal(all.length, 3);
    // supersede chain continues
    const v3 = addFacts(db, { subject: 'Agent Memory', facts: [{ fact: 'v3 claim', evidence_ids: ['e3'] }] });
    const chain = exportFacts(db, { includeSuperseded: true }).facts;
    assert.equal(chain.filter((f) => f.superseded_by).length, 3, 'chain: v1->v2, v2a->v3, v2b->v3');
    assert.equal(v3.superseded, 2);
  } finally { close(); }
});

test('rule extraction from a COMPLETED research report needs >= 3 evidence', async () => {
  const { db, close } = setup();
  try {
    seedResearchTask(db, 'dr-ok', 3);
    const r = await extractAndStoreFacts(db, 'dr-ok', {});
    assert.ok(r.ok && r.added >= 1 && r.added <= 5, '3-5 facts extracted');
    assert.ok(!r.used_llm);
    seedResearchTask(db, 'dr-thin', 2);
    const thin = await extractAndStoreFacts(db, 'dr-thin', {});
    assert.ok(!thin.ok && /evidence 2 < 3/.test(thin.reason), 'below evidence bar -> no facts');
  } finally { close(); }
});

test('code report facts extracted from innovations/tradeoffs', async () => {
  const { db, close } = setup();
  try {
    const report = {
      repo: 'lukeed/klona',
      innovations: [{ name: 'zero-dep deep clone', note: 'single-pass clone', evidence: [{ path: 'src/index.js', lines: '10-20', note: 'loop' }] }],
      tradeoffs: [{ name: 'no Map support', note: 'plain objects only', evidence: [{ path: 'README.md', lines: '3', note: 'docs' }] }],
    };
    db.prepare(
      `INSERT INTO intel_research_tasks (task_id, kind, repo, status, created_at, updated_at) VALUES ('cr-1','code','lukeed/klona','COMPLETED',?,?)`
    ).run(new Date().toISOString(), new Date().toISOString());
    db.prepare('INSERT INTO intel_code_reports (task_id, repo, "commit", report_json, created_at) VALUES (?,?,?,?,?)')
      .run('cr-1', 'lukeed/klona', 'abc', JSON.stringify(report), new Date().toISOString());
    const r = await extractAndStoreFacts(db, 'cr-1', {});
    assert.ok(r.ok && r.added === 2);
    const exported = exportFacts(db, { subject: 'lukeed/klona' });
    assert.ok(exported.facts.some((f) => f.evidence_ids.some((e) => e.startsWith('src/index.js:'))));
  } finally { close(); }
});

test('LLM assist is validated; invalid output falls back to rule facts', async () => {
  const { db, close } = setup();
  try {
    seedResearchTask(db, 'dr-llm', 3);
    const llmText = (text) => ({ stream: async function* () { yield { type: 'text-delta', text }; } });
    const badLlm = llmText('not json at all');
    const r1 = await extractAndStoreFacts(db, 'dr-llm', { llm: badLlm, analysisEnabled: true, provider: 'p', model: 'm' });
    assert.ok(r1.ok && !r1.used_llm, 'fallback to rules');
    assert.ok(r1.added >= 1);
    const goodLlm = llmText(JSON.stringify({ facts: [{ fact: 'LLM fact citing e1', evidence_ids: ['e1'] }, { fact: 'LLM fact citing e2', evidence_ids: ['e2'] }, { fact: 'LLM fact citing e3', evidence_ids: ['e3'] }] }));
    const r2 = await extractAndStoreFacts(db, 'dr-llm', { llm: goodLlm, analysisEnabled: true, provider: 'p', model: 'm' });
    assert.ok(r2.ok && r2.used_llm, 'valid LLM output used');
    assert.ok(exportFacts(db).facts.some((f) => f.fact.startsWith('LLM fact')));
  } finally { close(); }
});

test('validateLlmFacts rejects unknown evidence citations', () => {
  const ids = new Set(['e1', 'e2']);
  assert.ok(validateLlmFacts({ facts: [{ fact: 'x', evidence_ids: ['e1'] }] }, ids) === null);
  assert.match(validateLlmFacts({ facts: [{ fact: 'x', evidence_ids: ['e9'] }] }, ids), /unknown evidence/);
  assert.match(validateLlmFacts({ facts: [{ fact: 'x', evidence_ids: [] }] }, ids), /evidence_ids/);
  assert.match(validateLlmFacts({ facts: 'nope' }, ids), /array/);
});

test('export is read-only: nothing in the db changes, and no path writes the profile/persona', async () => {
  const { db, close } = setup();
  try {
    const { ensureDefaultProfile, loadProfile } = await import('../lib/profile.js');
    ensureDefaultProfile(db);
    addFacts(db, { subject: 'RAG', facts: [{ fact: 'rag fact', evidence_ids: ['e1'] }] });
    const before = {
      tables: db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name),
      docs: db.prepare('SELECT COUNT(*) n FROM intel_documents').get().n,
      profile: JSON.stringify(loadProfile(db)),
      facts: db.prepare('SELECT COUNT(*) n FROM intel_knowledge_facts').get().n,
      sources: db.prepare('SELECT COUNT(*) n FROM intel_sources').get().n,
    };
    const out1 = exportFacts(db, { subject: 'RAG' });
    const out2 = exportFacts(db, {});
    const after = {
      tables: db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name),
      docs: db.prepare('SELECT COUNT(*) n FROM intel_documents').get().n,
      profile: JSON.stringify(loadProfile(db)),
      facts: db.prepare('SELECT COUNT(*) n FROM intel_knowledge_facts').get().n,
      sources: db.prepare('SELECT COUNT(*) n FROM intel_sources').get().n,
    };
    assert.deepEqual(before, after, 'exportFacts performs zero writes');
    assert.equal(out1.count, 1);
    assert.equal(out2.readonly, true, 'export result self-declares read-only');
    // bridge module exposes no profile/persona write path
    const bridge = await import('../lib/memoryBridge.js');
    const exported = Object.keys(bridge);
    for (const fn of exported) {
      const src = String(bridge[fn]);
      assert.ok(!src.includes('intel_interest_profiles'), `${fn} never touches the interest profile`);
    }
    assert.ok(before.tables.includes('intel_knowledge_facts'));
  } finally { close(); }
});

test('addFacts guards: empty subject / empty facts rejected cleanly', () => {
  const { db, close } = setup();
  try {
    assert.throws(() => addFacts(db, { subject: '', facts: [{ fact: 'x' }] }));
    assert.equal(addFacts(db, { subject: 'X', facts: [] }).added, 0);
    assert.equal(addFacts(db, { subject: 'X', facts: [{ fact: '   ' }] }).added, 0);
    const big = addFacts(db, { subject: 'X', facts: Array.from({ length: 10 }, (_, i) => ({ fact: `f${i}`, evidence_ids: ['e'] })) });
    assert.equal(big.added, 5, 'capped at 5 facts per batch');
  } finally { close(); }
});
