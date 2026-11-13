/** Code Research Pipeline tests: whitelist, traversal, dedup, state machine, disk budget, report validation, migration v4. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, closeDb, MIGRATIONS } from '../lib/db.js';
import { buildTools } from '../lib/tools.js';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, cpSync as cpSyncR } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TEST_HOSTS = ['testhost.invalid'];
const cpSync = (a, b) => cpSyncR(a, b, { recursive: true });

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'intelhub-cr-'));
  const dbPath = path.join(dir, 'test.db');
  const db = openDb(dbPath);
  const reposDir = path.join(dir, 'repos');
  const config = {
    reportTimeZone: 'Asia/Shanghai', dbPath, reportsDir: path.join(dir, 'reports'),
    codeResearchEnabled: true, codeResearchTestHosts: TEST_HOSTS,
    codeResearchReposDir: reposDir, codeResearchMaxRepoMb: 1, reposTotalMaxMb: 2,
  };
  const tools = {};
  for (const t of buildTools({ db, config, webFetch: null, webSearch: null })) tools[t.name] = t;
  return { db, dir, reposDir, config, tools };
}

/** Build a tiny fixture "repository" (plain dir) — the injected test clone fn copies it. */
function fixtureRepo(dir) {
  const root = path.join(dir, 'fixture-src');
  mkdirSync(path.join(root, 'lib'), { recursive: true });
  writeFileSync(path.join(root, 'index.js'), 'export function main() {\n  return helper();\n}\n');
  writeFileSync(path.join(root, 'lib', 'util.js'), 'export function helper() {\n  return 42;\n}\n');
  return root;
}

/** Fake clone backend helper: runResearchTask cannot be given a custom git fn, so tests
 *  seed the checkpoint to the 'collected' phase — exactly the resume path a retry takes. */

test('parseRepoInput whitelist: github ok, other hosts rejected, testHosts accepted', () => {
  const { parseRepoInput } = globalThis.__cr || {};
  return import('../lib/codeResearch.js').then((cr) => {
    const ok = cr.parseRepoInput('facebook/react');
    assert.equal(ok.fullName, 'facebook/react');
    assert.equal(cr.parseRepoInput('https://github.com/o/r.git').fullName, 'o/r');
    assert.throws(() => cr.parseRepoInput('https://evil.com/o/r'), /not whitelisted/);
    assert.throws(() => cr.parseRepoInput('file:///etc/passwd'), /only https/);
    const t = cr.parseRepoInput('https://testhost.invalid/o/r', { testHosts: TEST_HOSTS });
    assert.equal(t.fullName, 'o/r');
    const e = cr.parseRepoInput('https://gitlab.com/o/r', { extraHosts: ['gitlab.com'] });
    assert.equal(e.fullName, 'o/r');
    assert.throws(() => cr.parseRepoInput('../escape'), /invalid owner\/repo|invalid repo url/);
  });
});

test('safeJoin rejects directory traversal', async () => {
  const cr = await import('../lib/codeResearch.js');
  const base = mkdtempSync(path.join(tmpdir(), 'intelhub-sj-'));
  assert.throws(() => cr.safeJoin(base, '../../etc/passwd'), /escapes repo dir/);
  assert.throws(() => cr.safeJoin(base, '/etc/passwd'), /escapes repo dir/);
  assert.equal(cr.safeJoin(base, 'lib/util.js'), path.resolve(base, 'lib/util.js'));
});

test('createResearchTask dedups same commit (cached) and active tasks', async () => {
  const { db, dir } = setup();
  const cr = await import('../lib/codeResearch.js');
  const root = fixtureRepo(dir);

  // First task created, then driven to collected via checkpoint seeding (retry path).
  const t1 = cr.createResearchTask(db, { repo: 'acme/tiny', commit: 'a'.repeat(40) }, { testHosts: TEST_HOSTS });
  assert.equal(t1.deduped, false);
  const dest = cr.taskRepoDir(path.join(dir, 'repos'), 'acme/tiny', 'a'.repeat(40));
  cpSync(root, dest);
  const tree = cr.buildFileTree(dest);
  const { db: db2 } = { db }; // keep single handle
  // Seed checkpoint = "collected" and complete lifecycle pieces via runResearchTask shortcut:
  const dbx = db;
  dbx.prepare('UPDATE intel_research_tasks SET checkpoint_json = ?, status = ? WHERE task_id = ?')
    .run(JSON.stringify({ phase: 'collected', reposDir: dest, fileTree: tree, commit: 'a'.repeat(40), backend: 'git', bytes: 100 }), 'ANALYZING', t1.task_id);
  cr.upsertProject(dbx, { fullName: 'acme/tiny' });
  dbx.prepare(
    'INSERT OR IGNORE INTO intel_github_snapshots (project_id, "commit", snapshot_json, created_at) VALUES (?, ?, ?, ?)'
  ).run(dbx.prepare('SELECT id FROM intel_github_projects WHERE repo_full_name = ?').get('acme/tiny').id, 'a'.repeat(40), '{}', new Date().toISOString());

  // Same repo+commit now dedups to the cached snapshot, no new clone.
  const t2 = cr.createResearchTask(db, { repo: 'acme/tiny', commit: 'a'.repeat(40) }, { testHosts: TEST_HOSTS });
  assert.equal(t2.deduped, true);
  assert.equal(t2.cached, true);
  // A different commit for the same repo while an ANALYZING task for THAT commit exists -> dedup on active task.
  const t3 = cr.createResearchTask(db, { repo: 'acme/tiny', commit: 'b'.repeat(40) }, { testHosts: TEST_HOSTS });
  assert.equal(t3.deduped, false, 'different commit -> new task');
  db.prepare("UPDATE intel_research_tasks SET status = 'ANALYZING' WHERE task_id = ?").run(t3.task_id);
  const t4 = cr.createResearchTask(db, { repo: 'acme/tiny', commit: 'b'.repeat(40) }, { testHosts: TEST_HOSTS });
  assert.equal(t4.deduped, true);
  assert.match(t4.reason, /active task/);
  closeDb(db);
});

test('codeRead: window limit, traversal rejection, unknown task', async () => {
  const { db, dir } = setup();
  const cr = await import('../lib/codeResearch.js');
  const dest = path.join(dir, 'r2');
  cpSync(fixtureRepo(dir), dest);
  const t = cr.createResearchTask(db, { repo: 'acme/tiny2', commit: 'c'.repeat(40) }, { testHosts: TEST_HOSTS });
  db.prepare('UPDATE intel_research_tasks SET checkpoint_json = ?, status = ? WHERE task_id = ?')
    .run(JSON.stringify({ phase: 'collected', reposDir: dest, fileTree: cr.buildFileTree(dest), commit: 'c'.repeat(40) }), 'ANALYZING', t.task_id);

  const r = cr.codeRead(db, t.task_id, 'lib/util.js', 1, 1);
  assert.equal(r.total_lines, 4); // 3 content lines + trailing newline
  assert.match(r.content, /^1: export function helper/);
  assert.throws(() => cr.codeRead(db, t.task_id, '../../etc/passwd'), /escapes|not found/);
  assert.throws(() => cr.codeRead(db, 'nope', 'x'), /unknown task/);

  // search
  const s = cr.codeSearch(db, t.task_id, 'helper');
  assert.equal(s.count, 2); // definition + call site
  assert.deepEqual(s.results.map((x) => `${x.path}:${x.line}`).sort(), ['index.js:2', 'lib/util.js:1']);
  const sre = cr.codeSearch(db, t.task_id, 'return 4\\d', { regex: true });
  assert.equal(sre.count, 1);
  const sglob = cr.codeSearch(db, t.task_id, 'helper', { glob: 'lib/*.js' });
  assert.equal(sglob.count, 1);
  closeDb(db);
});

test('validateCodeReport: rejects missing evidence, bad path:line, accepts real refs', async () => {
  const cr = await import('../lib/codeResearch.js');
  const tree = [{ path: 'index.js', size: 10, lines: 2 }, { path: 'lib/util.js', size: 10, lines: 3 }];
  assert.match(String(cr.validateCodeReport({}, tree)), /architecture/);
  const noEv = { architecture: 'x'.repeat(20), key_modules: [{ name: 'a' }], call_chains: [1], innovations: [1], tradeoffs: [1], learning_suggestions: [1] };
  assert.match(String(cr.validateCodeReport(noEv, tree)), /no evidence|must be objects/);
  const badPath = mkReport();
  badPath.key_modules[0].evidence[0].path = 'nope.js';
  assert.match(String(cr.validateCodeReport(badPath, tree)), /not in repo file tree/);
  const badLines = mkReport();
  badLines.call_chains[0].evidence[0].lines = 'x';
  assert.match(String(cr.validateCodeReport(badLines, tree)), /lines/);
  assert.equal(cr.validateCodeReport(mkReport(), tree), null);

  function mkReport() {
    const ev = (path, lines) => [{ path, lines, note: 'n' }];
    return {
      architecture: 'graph TD; A-->B; (module graph)',
      key_modules: [{ name: 'main', role: 'entry', evidence: ev('index.js', '1-2') }],
      call_chains: [{ name: 'main->helper', steps: [], evidence: ev('lib/util.js', '1-3') }],
      innovations: [{ point: 'tiny', evidence: ev('index.js', '1') }],
      tradeoffs: [{ point: 'none', evidence: ev('lib/util.js', '2') }],
      learning_suggestions: [{ point: 'read util', evidence: ev('index.js', '2-3') }],
    };
  }
});

test('completeAnalysis persists intel_code_reports and marks COMPLETED; rejects invalid report', async () => {
  const { db, dir } = setup();
  const cr = await import('../lib/codeResearch.js');
  const dest = path.join(dir, 'r3');
  cpSync(fixtureRepo(dir), dest);
  const t = cr.createResearchTask(db, { repo: 'acme/tiny3', commit: 'd'.repeat(40) }, { testHosts: TEST_HOSTS });
  db.prepare('UPDATE intel_research_tasks SET checkpoint_json = ?, status = ? WHERE task_id = ?')
    .run(JSON.stringify({ phase: 'collected', reposDir: dest, fileTree: cr.buildFileTree(dest), commit: 'd'.repeat(40) }), 'ANALYZING', t.task_id);
  assert.throws(() => cr.completeAnalysis(db, t.task_id, { architecture: '' }), /rejected/);
  const out = cr.completeAnalysis(db, t.task_id, {
    architecture: 'graph TD; index.js -> lib/util.js',
    key_modules: [{ name: 'main', evidence: [{ path: 'index.js', lines: '1-3', note: 'entry' }] }],
    call_chains: [{ name: 'chain', evidence: [{ path: 'lib/util.js', lines: '2', note: 'helper body' }] }],
    innovations: [{ point: 'p', evidence: [{ path: 'index.js', lines: '2', note: 'n' }] }],
    tradeoffs: [{ point: 't', evidence: [{ path: 'lib/util.js', lines: '1-3', note: 'n' }] }],
    learning_suggestions: [{ point: 'l', evidence: [{ path: 'index.js', lines: '1', note: 'n' }] }],
  });
  assert.equal(out.status, 'COMPLETED');
  const row = db.prepare('SELECT * FROM intel_code_reports WHERE task_id = ?').get(t.task_id);
  const report = JSON.parse(row.report_json);
  assert.equal(report.repo, 'acme/tiny3');
  assert.equal(report.commit, 'd'.repeat(40));
  assert.equal(report.analysis_mode, 'agent-read');
  assert.ok(report.analyzed_at);
  assert.throws(() => cr.completeAnalysis(db, t.task_id, validReport()), /already submitted/);
  function validReport() {
    return {
      architecture: 'graph TD; a->b',
      key_modules: [{ evidence: [{ path: 'index.js', lines: '1', note: 'n' }] }],
      call_chains: [{ evidence: [{ path: 'index.js', lines: '1', note: 'n' }] }],
      innovations: [{ evidence: [{ path: 'index.js', lines: '1', note: 'n' }] }],
      tradeoffs: [{ evidence: [{ path: 'index.js', lines: '1', note: 'n' }] }],
      learning_suggestions: [{ evidence: [{ path: 'index.js', lines: '1', note: 'n' }] }],
    };
  }
  closeDb(db);
});

test('tools gate on codeResearchEnabled and expose the session toolset when on', async () => {
  const { dir } = setup();
  const dbPath = path.join(dir, 'off.db');
  const db = openDb(dbPath);
  const off = buildTools({ db, config: { dbPath }, webFetch: null });
  // code-specific session tools stay gated; intel_get_research_report is top-level (serves deep research too)
  assert.equal(off.filter((t) => t.name.startsWith('intel_code') || t.name.startsWith('intel_analyze') || t.name === 'intel_track_github' || t.name.startsWith('intel_complete')).length, 0);
  assert.equal(off.filter((t) => ['intel_research', 'intel_get_research_report', 'intel_generate_learning_material'].includes(t.name)).length, 3, 'deep-research tools are top-level');
  const { tools } = setup();
  for (const name of ['intel_track_github', 'intel_analyze_repository', 'intel_get_research_report', 'intel_code_read', 'intel_code_search', 'intel_complete_repository_analysis']) {
    assert.ok(tools[name], `missing ${name}`);
  }
  closeDb(db);
});

test('intel_track_github add/remove/list', async () => {
  const { tools, db } = setup();
  const add = await tools.intel_track_github.execute({ action: 'add', repo: 'acme/watched', reason: 'research' });
  assert.equal(add.watched, true);
  const bad = await tools.intel_track_github.execute({ action: 'add', repo: 'https://evil.com/a/b' });
  assert.equal(bad.ok, false);
  const list = await tools.intel_track_github.execute({ action: 'list' });
  assert.equal(list.repos.length, 1);
  assert.equal(list.repos[0].watched, true);
  const rm = await tools.intel_track_github.execute({ action: 'remove', repo: 'acme/watched' });
  assert.equal(rm.watched, false);
  closeDb(db);
});

test('enforceDiskBudget LRU-evicts oldest non-watched repos beyond reposTotalMaxMb', async () => {
  const { db, reposDir } = setup();
  const cr = await import('../lib/codeResearch.js');
  cr.upsertProject(db, { fullName: 'keep/watched', watched: true });
  const mb = (n) => n * 1024 * 1024;
  const mk = (name, sizeBytes) => {
    const d = path.join(reposDir, name, 'c'.repeat(40));
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, 'blob.bin'), Buffer.alloc(sizeBytes, 1));
  };
  mk('old__a', mb(1));
  mk('mid__b', mb(1));
  mk('keep__watched', mb(1));
  const r = cr.enforceDiskBudget(db, reposDir, { reposTotalMaxMb: 2 });
  assert.ok(!existsSync(path.join(reposDir, 'old__a')), 'oldest evicted first');
  assert.ok(existsSync(path.join(reposDir, 'keep__watched')), 'watched repo protected');
  closeDb(db);
});

test('tar extractor: safe extraction, root strip, size cap', async () => {
  const cr = await import('../lib/codeResearch.js');
  const { execFileSync } = await import('node:child_process');
  const fsMod = await import('node:fs');
  const src = mkdtempSync(path.join(tmpdir(), 'intelhub-tar-src-'));
  mkdirSync(path.join(src, 'pkg-root', 'lib'), { recursive: true });
  writeFileSync(path.join(src, 'pkg-root', 'lib', 'a.js'), 'export const a = 1;\n');
  writeFileSync(path.join(src, 'pkg-root', 'README.md'), '# hello\n');
  const tgz = path.join(src, 'r.tgz');
  execFileSync('tar', ['czf', tgz, '-C', src, 'pkg-root']);
  const out = mkdtempSync(path.join(tmpdir(), 'intelhub-tar-out-'));
  const r = await cr.extractTarGz(fsMod.readFileSync(tgz), path.join(out, 'x'), {});
  assert.ok(existsSync(path.join(out, 'x', 'lib', 'a.js')));
  assert.equal(readFileSync(path.join(out, 'x', 'lib', 'a.js'), 'utf8'), 'export const a = 1;\n');
  assert.ok(existsSync(path.join(out, 'x', 'README.md')));
  assert.ok(r.bytes > 0);
});

test('migration v3 -> v4 preserves data and creates unique-indexed code research tables', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'intelhub-mig4-'));
  // Build a v3 db by hand.
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(path.join(dir, 'old.db'));
  raw.exec(`CREATE TABLE schema_version (version INTEGER NOT NULL PRIMARY KEY, applied_at TEXT NOT NULL)`);
  for (const m of MIGRATIONS.filter((m) => m.version <= 3)) {
    m.up(raw);
    raw.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(m.version, new Date().toISOString());
  }
  raw.prepare('INSERT INTO intel_documents (url, dedup_key, fetched_at) VALUES (?, ?, ?)').run('https://a.com', 'a', new Date().toISOString());
  raw.close();
  const db = openDb(path.join(dir, 'old.db')); // applies v4 only
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'intel_research_tasks'").get());
  assert.equal(db.prepare('SELECT COUNT(*) n FROM intel_documents').get().n, 1, 'old data preserved');
  const idx = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_gh_snapshots'").get().sql;
  assert.match(idx, /UNIQUE/);
  const idx2 = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_code_reports_task'").get().sql;
  assert.match(idx2, /UNIQUE/);
  closeDb(db);
});
