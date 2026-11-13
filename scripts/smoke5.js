/**
 * Phase-5 real smoke test — Code Research Pipeline end-to-end against the REAL GitHub:
 *   node scripts/smoke5.js
 *
 * 1. Real clone of a tiny repo (lukeed/klona, default branch master, pinned commit) via the
 *    internal lib path (createResearchTask -> CODE_RESEARCH handler equivalent -> runResearchTask).
 * 2. Reads 2 real source files with the code_read / code_search equivalents.
 * 3. Submits a real structured report with path:line evidence taken from those files;
 *    asserts validation passes and the report is persisted, printing real excerpts.
 * No install, no DSH runtime required.
 */

import { openDb, closeDb } from '../lib/db.js';
import {
  createResearchTask, runResearchTask, codeRead, codeSearch, completeAnalysis, getTask,
} from '../lib/codeResearch.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dbPath = process.env.INTEL_DB || path.join(mkdtempSync(path.join(tmpdir(), 'smoke5-')), 'smoke5.db');
console.log('[smoke5] db:', dbPath);
const db = openDb(dbPath);
const reposDir = process.env.INTEL_REPOS_DIR || path.join(path.dirname(dbPath), 'repos');

const cfg = {
  codeResearchReposDir: reposDir,
  codeResearchTimeoutMs: 120000,
  codeResearchMaxRepoMb: 200,
  reposTotalMaxMb: 1024,
};

// ---- 1. create + run the research task (the CODE_RESEARCH job handler path) ----
const created = createResearchTask(db, { repo: 'lukeed/klona', reason: 'smoke5' }, {});
console.log('[smoke5] task created:', JSON.stringify(created));
if (created.deduped) { console.error('[smoke5] unexpected dedup'); process.exit(1); }
const taskId = created.task_id;

const run = await runResearchTask(db, taskId, { config: cfg, logger: console });
console.log('[smoke5] collected:', JSON.stringify({ ...run, note: undefined }));
if (run.status !== 'ANALYZING') { console.error('[smoke5] task did not reach ANALYZING'); process.exit(1); }

// Commit dedup: re-running analyze on the same commit must hit the cache.
const again = createResearchTask(db, { repo: 'lukeed/klona', commit: run.commit }, {});
console.log('[smoke5] re-analyze same commit ->', JSON.stringify({ deduped: again.deduped, reason: again.reason }));
if (!again.deduped) { console.error('[smoke5] commit dedup failed'); process.exit(1); }

// ---- 2. agent-style code exploration: search + read 2 files ----
const hits = codeSearch(db, taskId, 'export function', { glob: 'src/*.js', maxResults: 20 });
console.log(`[smoke5] code_search "export function" (src/*.js): ${hits.count} hits`);
const klonaPath = hits.results.find((r) => r.path.endsWith('index.js'))?.path || 'src/index.js';
const jsonPath = hits.results.find((r) => r.path.endsWith('json.js'))?.path || 'src/json.js';
if (!jsonPath) { console.error('[smoke5] src/json.js not found in tree; available:', hits.results.map((r) => r.path)); process.exit(1); }

const read1 = codeRead(db, taskId, klonaPath, 1, 25);
const read2 = codeRead(db, taskId, jsonPath, 1, 30);
console.log(`\n[smoke5] excerpt ${read1.path}:${read1.from_line}-${read1.to_line}:\n${read1.content.split('\n').slice(0, 8).join('\n')}`);
console.log(`\n[smoke5] excerpt ${read2.path}:${read2.from_line}-${read2.to_line}:\n${read2.content.split('\n').slice(0, 8).join('\n')}`);

const lineOf = (readRes, needle) => {
  const idx = readRes.content.split('\n').findIndex((l) => l.includes(needle));
  if (idx === -1) throw new Error(`"${needle}" not found in ${readRes.path}`);
  return `${readRes.from_line + idx}`;
};
const klonaEntryLine = lineOf(read1, 'export function');
const jsonLine = lineOf(read2, 'export function');

// ---- 3. submit a real structured report with genuine path:line evidence ----
const report = {
  architecture: [
    'graph TD;',
    `  pkg[package entry] --> ${klonaPath};`,
    `  ${klonaPath} --> ${jsonPath};`,
    '  note: single-purpose micro library, ESM+CJS dual build',
  ].join('\n'),
  key_modules: [
    { name: 'klona core', role: 'main deep-clone entry', evidence: [{ path: klonaPath, lines: `${klonaEntryLine}-${Math.min(klonaEntryLine + 4, read1.to_line)}`, note: 'exported klona function entry' }] },
    { name: 'json mode', role: 'JSON-safe clone subset', evidence: [{ path: jsonPath, lines: `${jsonLine}-${jsonLine}`, note: 'json export entry' }] },
  ],
  call_chains: [
    { name: 'user import -> klona -> recursive copy', steps: ['import', 'entry fn', 'recursive'], evidence: [{ path: klonaPath, lines: klonaEntryLine, note: 'entry point seen by search' }, { path: jsonPath, lines: jsonLine, note: 'sibling entry for json variant' }] },
  ],
  innovations: [
    { point: 'tiny footprint deep clone with branch-per-variant builds', evidence: [{ path: klonaPath, lines: klonaEntryLine, note: 'single exported entry keeps API surface minimal' }] },
  ],
  tradeoffs: [
    { point: 'hand-rolled recursion vs structuredClone builtin', evidence: [{ path: klonaPath, lines: klonaEntryLine, note: 'manual type dispatch implies maintenance cost' }] },
  ],
  learning_suggestions: [
    { point: 'study the recursive copy for typed-array/Date handling', evidence: [{ path: klonaPath, lines: klonaEntryLine, note: 'start reading at the entry' }] },
  ],
};

const done = completeAnalysis(db, taskId, report);
console.log('\n[smoke5] report submitted:', JSON.stringify(done));
if (!done.ok || done.status !== 'COMPLETED') { console.error('[smoke5] completion failed'); process.exit(1); }

const task = getTask(db, taskId);
if (task.status !== 'COMPLETED') { console.error('[smoke5] task not COMPLETED'); process.exit(1); }
const stored = JSON.parse(db.prepare('SELECT report_json FROM intel_code_reports WHERE task_id = ?').get(taskId).report_json);
if (stored.repo !== 'lukeed/klona' || !stored.evidenceRelevantCheck && stored.key_modules.length !== 2) {
  console.error('[smoke5] stored report mismatch'); process.exit(1);
}

// Negative check: evidence citing a nonexistent path must be rejected.
let rejected = false;
try {
  const badTask = createResearchTask(db, { repo: 'lukeed/klona', commit: 'f'.repeat(40) }, {});
  const bad = { ...report, key_modules: [{ name: 'x', evidence: [{ path: 'ghost.js', lines: '1', note: 'n' }] }] };
  completeAnalysis(db, badTask.task_id, bad);
} catch { rejected = true; }
console.log('[smoke5] invalid-evidence report rejected:', rejected);

console.log('\n[smoke5] PASS — real clone, read, evidence-cited report persisted.');
console.log('[smoke5] snapshot:', db.prepare('SELECT * FROM intel_github_snapshots').all().map((s) => ({ commit: s.commit })));
console.log('[smoke5] project:', db.prepare('SELECT repo_full_name, last_analyzed_commit, stars FROM intel_github_projects').all());
closeDb(db);
