/** Code Research Pipeline: GitHub source-level research sessions.
 *
 * Design (degraded mode, see docs in scripts/smoke5.js):
 *  - No external code-analysis tool (GitNexus / DeepWiki MCP / investigate-codebase /
 *    codebase-recon-skill) is available in this environment; analysis_mode = 'agent-read'.
 *  - The plugin is responsible ONLY for: URL whitelist -> clone (git depth-1 pinned ref,
 *    hooks disabled; pure-JS tarball fallback if git is missing) -> isolated read-only
 *    dir -> file-tree index -> snapshots -> durable task state.
 *  - Source UNDERSTANDING is done by the calling Agent through the session tools
 *    intel_code_read / intel_code_search; conclusions must cite path:line evidence.
 */

import { execFile } from 'node:child_process';
import { createGunzip } from 'node:zlib';
import {
  existsSync, mkdirSync, readdirSync, statSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

export const TASK_STATUS = {
  CREATED: 'CREATED',
  PLANNING: 'PLANNING',
  COLLECTING: 'COLLECTING',
  ANALYZING: 'ANALYZING', // waiting for the calling Agent to read code
  WRITING: 'WRITING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
};

const CODE_LANG_BY_EXT = {
  '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.jsx': 'JavaScript',
  '.ts': 'TypeScript', '.tsx': 'TypeScript',
  '.py': 'Python', '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.rb': 'Ruby',
  '.c': 'C', '.h': 'C', '.cc': 'C++', '.cpp': 'C++', '.hpp': 'C++',
  '.cs': 'C#', '.php': 'PHP', '.swift': 'Swift', '.kt': 'Kotlin',
  '.sh': 'Shell', '.md': 'Markdown', '.json': 'JSON', '.yml': 'YAML', '.yaml': 'YAML',
  '.toml': 'TOML', '.html': 'HTML', '.css': 'CSS', '.sql': 'SQL', '.vue': 'Vue',
};
const TEXT_ANALYZE_EXTS = new Set(Object.keys(CODE_LANG_BY_EXT));
const SKIP_DIRS = new Set(['.git', 'node_modules', '.svn', '.hg', 'dist', '.github']);
const MAX_READ_LINES = 400;
const MAX_READ_BYTES = 256 * 1024;

const nowIso = () => new Date().toISOString();

// ---------------- repo input / whitelist ----------------

/** Parse "owner/repo" or https URL into { host, owner, repo, fullName }. Throws on violation. */
export function parseRepoInput(input, { extraHosts = [], testHosts = [] } = {}) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('repo is required');
  const allowed = new Set(['github.com', ...extraHosts.map((h) => String(h).toLowerCase()), ...testHosts]);
  let host = 'github.com';
  let owner = '';
  let repo = '';
  if (/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(raw)) {
    owner = raw.split('/')[0];
    repo = raw.split('/')[1].replace(/\.git$/, '');
  } else {
    let u;
    try { u = new URL(raw); } catch { throw new Error(`invalid repo url: ${raw}`); }
    if (!/^https?:$/.test(u.protocol)) throw new Error(`only https urls allowed: ${raw}`);
    host = u.hostname.toLowerCase();
    if (!allowed.has(host)) throw new Error(`host not whitelisted: ${host}`);
    const parts = u.pathname.replace(/^\//, '').replace(/\.git$/, '').split('/').filter(Boolean);
    if (parts.length < 2) throw new Error(`url must point to owner/repo: ${raw}`);
    owner = parts[0];
    repo = parts[1];
  }
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(owner) || !/^[a-zA-Z0-9._-]{1,100}$/.test(repo) || owner === '.' || owner === '..' || repo === '.' || repo === '..') {
    throw new Error(`invalid owner/repo: ${owner}/${repo}`);
  }
  return { host, owner, repo, fullName: `${owner}/${repo}` };
}

export function isCommitSha(s) {
  return /^[0-9a-f]{7,40}$/.test(String(s || '').toLowerCase());
}

export function sanitizeRef(ref) {
  const r = String(ref || '').trim();
  if (!r || !/^[a-zA-Z0-9._/-]{1,120}$/.test(r) || r.includes('..') || r.startsWith('/') || r.endsWith('.lock')) {
    throw new Error(`invalid git ref: ${ref}`);
  }
  return r;
}

// ---------------- paths ----------------

export function defaultReposRoot() {
  return path.join(os.homedir(), '.dsh', 'plugins-data', 'dsh-intelligence-hub', 'repos');
}

export function reposRootFor(config) {
  return config.codeResearchReposDir || defaultReposRoot();
}

export function taskRepoDir(root, fullName, commit) {
  const [owner, repo] = String(fullName).split('/');
  return path.join(root, `${owner}__${repo}`, String(commit).toLowerCase());
}

/** Resolve a path strictly inside baseDir; throws on traversal. */
export function safeJoin(baseDir, relPath) {
  const base = path.resolve(baseDir);
  const target = path.resolve(base, String(relPath || ''));
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error(`path escapes repo dir: ${relPath}`);
  }
  return target;
}

// ---------------- clone backends ----------------

function hasGitBinary() {
  return new Promise((resolve) => {
    execFile('git', ['--version'], { timeout: 5000 }, (err, stdout) => resolve(!err && /git version/.test(String(stdout))));
  });
}

function sh(execFileFn, file, args, opts) {
  return new Promise((resolve, reject) => {
    execFileFn(file, args, opts, (err, stdout, stderr) => {
      if (err) reject(new Error(`${file} ${args.join(' ')} failed: ${String(stderr || err.message).slice(0, 300)}`));
      else resolve(String(stdout || ''));
    });
  });
}

/** git clone --depth 1 into destDir with all hooks/protocols neutered. Never runs repo scripts. */
async function cloneWithGit({ owner, repo, ref, commit, destDir, timeoutMs }) {
  const url = `https://github.com/${owner}/${repo}.git`;
  const common = ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=always', '-c', 'advice.detachedHead=false'];
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' };
  const opts = { timeout: timeoutMs, env, maxBuffer: 4 * 1024 * 1024 };
  const args = [...common, 'clone', '--depth', '1', '--no-single-branch', '--no-checkout'];
  if (ref && !isCommitSha(ref)) args.push('--branch', ref);
  args.push(url, destDir);
  mkdirSync(path.dirname(destDir), { recursive: true });
  await sh(execFile, 'git', args, opts);
  if (commit) {
    await sh(execFile, 'git', [...common, '-C', destDir, 'fetch', '--depth', '1', 'origin', commit], opts);
    await sh(execFile, 'git', [...common, '-C', destDir, 'checkout', '--detach', 'FETCH_HEAD'], opts);
  } else if (ref) {
    await sh(execFile, 'git', [...common, '-C', destDir, 'checkout', '--detach', `origin/${ref}`], opts);
  }
  // Read-only analysis: drop the git metadata, we only need the worktree.
  rmSync(path.join(destDir, '.git'), { recursive: true, force: true });
}

/** Pure-JS fallback: fetch codeload tar.gz for a ref and extract safely (no shell, no git). */
async function fetchTarball({ owner, repo, ref, destDir, timeoutMs, maxRepoBytes, fetchImpl, testHosts = [] }) {
  const host = testHosts.length ? testHosts[0] : 'codeload.github.com';
  const url = `https://${host}/${owner}/${repo}/tar.gz/${encodeURIComponent(ref || 'HEAD')}`;
  const res = await fetchImpl(url, {
    headers: { 'user-agent': 'dsh-intelligence-hub code research', accept: 'application/gzip' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`tarball fetch HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  extractTarGz(buf, destDir, { maxBytes: maxRepoBytes });
}

/** Minimal ustar/pax tar reader with hard path + size limits. Typeflags: 0 file, 5 dir, x/L skipped. */
export function extractTarGz(buf, destDir, { maxBytes = 200 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const gunzip = createGunzip();
    gunzip.on('data', (c) => chunks.push(c));
    gunzip.on('error', reject);
    gunzip.on('end', () => {
      try {
        const data = Buffer.concat(chunks);
        mkdirSync(destDir, { recursive: true });
        let off = 0;
        let total = 0;
        let prefixRoot = null;
        let longName = null;
        let paxPath = null;
        while (off + 512 <= data.length) {
          const header = data.subarray(off, off + 512);
          if (header.every((b) => b === 0)) break;
          let name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
          const sizeField = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
          const size = parseInt(sizeField, 8) || 0;
          const typeflag = String.fromCharCode(header[156] || 48);
          const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
          if (prefix) name = `${prefix}/${name}`;
          off += 512;
          const body = data.subarray(off, off + size);
          off += size + (512 - (size % 512)) % 512;
          if (typeflag === 'L') { longName = body.toString('utf8').replace(/\0.*$/, ''); continue; }
          if (typeflag === 'x' || typeflag === 'g') {
            if (typeflag === 'x') {
              const m = /(\d+) path=([^\n]+)/.exec(body.toString('utf8'));
              if (m) paxPath = m[2];
            }
            continue;
          }
          let rel = longName ?? paxPath ?? name;
          longName = null;
          paxPath = null;
          if (typeflag !== '5' && prefixRoot === null) {
            prefixRoot = rel.split('/')[0] ? rel.split('/')[0] + '/' : '';
          }
          if (prefixRoot && rel.startsWith(prefixRoot)) rel = rel.slice(prefixRoot.length);
          if (!rel) continue;
          if (rel.includes('..') || path.isAbsolute(rel) || rel.includes('\0')) continue;
          const target = safeJoin(destDir, rel);
          if (typeflag === '5') {
            mkdirSync(target, { recursive: true });
          } else if (typeflag === '0' || typeflag === '\0' || typeflag === '') {
            total += size;
            if (total > maxBytes) { reject(new Error(`repo exceeds size budget (${maxBytes} bytes)`)); return; }
            mkdirSync(path.dirname(target), { recursive: true });
            writeFileSync(target, body, { mode: 0o444 });
          }
          // symlinks/hardlinks/devices/chmod specials: skipped entirely (read-only analysis).
        }
        resolve({ bytes: total });
      } catch (err) { reject(err); }
    });
    gunzip.end(buf);
  });
}

// ---------------- file tree / snapshot ----------------

const MAX_FILES = 20000;

/** Walk the extracted repo dir; returns [{path, size, lines}] sorted by path. */
export function buildFileTree(reposDir) {
  const files = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(full);
      } else if (e.isFile()) {
        if (files.length >= MAX_FILES) return;
        let size = 0;
        try { size = statSync(full).size; } catch { continue; }
        let lines = 0;
        if (TEXT_ANALYZE_EXTS.has(path.extname(e.name).toLowerCase()) && size <= 512 * 1024) {
          try {
            const buf = readFileSync(full);
            if (!buf.subarray(0, 8192).includes(0)) lines = buf.length === 0 ? 0 : buf.toString('utf8').split('\n').length;
          } catch { /* unreadable */ }
        }
        files.push({ path: path.relative(reposDir, full).split(path.sep).join('/'), size, lines });
      }
    }
  };
  walk(reposDir);
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  return files;
}

export function computeSnapshot(tree) {
  const langs = {};
  let loc = 0;
  for (const f of tree) {
    const lang = CODE_LANG_BY_EXT[path.extname(f.path).toLowerCase()];
    if (lang && f.lines) { langs[lang] = (langs[lang] || 0) + f.lines; loc += f.lines; }
  }
  const treeStr = tree.map((f) => `${f.path}:${f.size}:${f.lines}`).join('\n');
  return { fileCount: tree.length, loc, languages: langs, treeHash: treeStr.length };
}

// ---------------- disk budget / LRU ----------------

function dirSizeBytes(dir) {
  let total = 0;
  const walk = (d) => {
    let entries = [];
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else { try { total += statSync(full).size; } catch {} }
    }
  };
  walk(dir);
  return total;
}

/** Enforce per-repo and global disk budgets; LRU-evicts oldest non-watched repos beyond reposTotalMaxMb. */
export function enforceDiskBudget(db, root, { reposTotalMaxMb = 1024, isProtected } = {}) {
  const evicted = [];
  if (!existsSync(root)) return { evicted, totalBytes: 0 };
  // per-repo projects: <root>/<owner__repo>/<commit> — evict whole repo dirs (LRU by mtime).
  const repos = [];
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const full = path.join(root, d.name);
    repos.push({ full, mtime: statSync(full).mtimeMs, name: d.name });
  }
  repos.sort((a, b) => a.mtime - b.mtime); // oldest first
  let total = repos.reduce((s, r) => s + dirSizeBytes(r.full), 0);
  const budget = reposTotalMaxMb * 1024 * 1024;
  const watched = new Set(
    (db ? db.prepare('SELECT repo_full_name FROM intel_github_projects WHERE watched = 1').all() : [])
      .map((r) => String(r.repo_full_name).replace('/', '__'))
  );
  for (const r of repos) {
    if (total <= budget) break;
    if (isProtected?.(r.name) || watched.has(r.name)) continue;
    const size = dirSizeBytes(r.full);
    rmSync(r.full, { recursive: true, force: true });
    total -= size;
    evicted.push(r.name);
  }
  return { evicted, totalBytes: total };
}

// ---------------- db helpers ----------------

export function upsertProject(db, { fullName, defaultBranch, stars, watched, reason }) {
  const now = nowIso();
  const existing = db.prepare('SELECT * FROM intel_github_projects WHERE repo_full_name = ?').get(fullName);
  if (!existing) {
    db.prepare(
      `INSERT INTO intel_github_projects (repo_full_name, default_branch, last_analyzed_commit, stars, watched, reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(fullName, defaultBranch || '', null, stars ?? null, watched ? 1 : 0, reason || '', now, now);
  } else {
    db.prepare(
      `UPDATE intel_github_projects SET default_branch = COALESCE(NULLIF(?, ''), default_branch),
         stars = COALESCE(?, stars), watched = CASE WHEN ? IS NULL THEN watched ELSE ? END,
         reason = CASE WHEN ? != '' THEN ? ELSE reason END, updated_at = ? WHERE repo_full_name = ?`
    ).run(defaultBranch || '', stars ?? null, watched === undefined ? null : (watched ? 1 : 0),
      watched === undefined ? null : (watched ? 1 : 0), reason || '', reason || '', now, fullName);
  }
  return db.prepare('SELECT * FROM intel_github_projects WHERE repo_full_name = ?').get(fullName);
}

export function snapshotExists(db, fullName, commit) {
  return db.prepare(
    `SELECT s.*, p.repo_full_name FROM intel_github_snapshots s JOIN intel_github_projects p ON p.id = s.project_id
     WHERE p.repo_full_name = ? AND s."commit" = ?`
  ).get(fullName, String(commit).toLowerCase()) || null;
}

export function getTask(db, taskId) {
  return db.prepare('SELECT * FROM intel_research_tasks WHERE task_id = ?').get(String(taskId)) || null;
}

function setTask(db, taskId, fields) {
  const keys = Object.keys(fields);
  db.prepare(
    `UPDATE intel_research_tasks SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE task_id = ?`
  ).run(...keys.map((k) => fields[k]), nowIso(), taskId);
}

function j(v) { return v === undefined || v === null ? null : JSON.stringify(v); }

// ---------------- task lifecycle ----------------

export const codeResearchLock = { held: false, tryAcquire() { if (this.held) return false; this.held = true; return true; }, release() { this.held = false; } };

/**
 * Create a research task (CREATED). Dedup: same repo+commit with a snapshot or a
 * live/completed task returns { deduped: true, existing... } instead of a new clone.
 */
export function createResearchTask(db, { repo, commit, ref, reason, candidateId }, { extraHosts = [], testHosts = [] } = {}) {
  const parsed = parseRepoInput(repo, { extraHosts, testHosts });
  if (commit && !isCommitSha(commit)) throw new Error(`commit must be a hex sha: ${commit}`);
  if (ref) sanitizeRef(ref);
  const fullName = parsed.fullName;

  // Commit dedup: an existing snapshot for this commit -> cached, no clone.
  const project = db.prepare('SELECT * FROM intel_github_projects WHERE repo_full_name = ?').get(fullName);
  const cachedCommit = commit && project ? snapshotExists(db, fullName, commit) : null;
  if (cachedCommit) {
    const done = db.prepare(
      "SELECT task_id, result_json FROM intel_research_tasks WHERE repo = ? AND [commit] = ? AND status = 'COMPLETED' ORDER BY updated_at DESC LIMIT 1"
    ).get(fullName, String(commit).toLowerCase());
    return {
      deduped: true, reason: `commit ${commit} already analyzed`, cached: true,
      task_id: done?.task_id || null, report_id: done ? JSON.parse(done.result_json || '{}').report_id ?? null : null,
      snapshot: cachedCommit,
    };
  }
  const live = db.prepare(
    "SELECT task_id, status FROM intel_research_tasks WHERE repo = ? AND [commit] IS ? AND status IN ('CREATED','PLANNING','COLLECTING','ANALYZING','WRITING') ORDER BY created_at DESC LIMIT 1"
  ).get(fullName, commit ? String(commit).toLowerCase() : null);
  if (live) return { deduped: true, reason: `an active task already exists for ${fullName}@${commit || 'HEAD'}`, task_id: live.task_id, status: live.status };

  const taskId = `cr-${randomUUID().slice(0, 12)}`;
  db.prepare(
    `INSERT INTO intel_research_tasks (task_id, repo, "commit", ref, status, checkpoint_json, retry_count, source_refs_json, candidate_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'CREATED', '{}', 0, ?, ?, ?, ?)`
  ).run(taskId, fullName, commit ? String(commit).toLowerCase() : null, ref || null, candidateId ? JSON.stringify({ candidateId }) : '[]', candidateId ?? null, nowIso(), nowIso());
  upsertProject(db, { fullName });
  return { deduped: false, task_id: taskId, status: TASK_STATUS.CREATED, repo: fullName, commit: commit || null, ref: ref || null };
}

/**
 * Run PLANNING + COLLECTING for one task (clone, tree, snapshot, checkpoint).
 * On success the task enters ANALYZING (agent reads code via intel_code_read/search).
 * Checkpoint makes retries skip the clone: { reposDir, fileTree, commit, backend }.
 */
export async function runResearchTask(db, taskId, {
  config = {}, fetchImpl = globalThis.fetch, testHosts = [], logger = console,
} = {}) {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`unknown task ${taskId}`);
  if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(task.status)) {
    return { status: task.status, note: 'terminal, nothing to do' };
  }
  const cfg = {
    codeResearchTimeoutMs: 300000, codeResearchMaxRepoMb: 200, reposTotalMaxMb: 1024,
    ...config,
  };
  let checkpoint = {};
  try { checkpoint = JSON.parse(task.checkpoint_json || '{}'); } catch {}
  const [owner, repo] = String(task.repo).split('/');
  const maxRepoBytes = cfg.codeResearchMaxRepoMb * 1024 * 1024;
  const root = reposRootFor(cfg);

  try {
    // ---- PLANNING: resolve commit if missing ----
    if (!task.commit && !checkpoint.commit) {
      setTask(db, taskId, { status: 'PLANNING' });
      let sha = null;
      let defaultBranch = null;
      let stars = null;
      try {
        const meta = JSON.parse(await (await fetchImpl(
          `https://api.github.com/repos/${owner}/${repo}`,
          { headers: { 'user-agent': 'dsh-intelligence-hub', accept: 'application/json' }, signal: AbortSignal.timeout(15000) }
        )).text());
        defaultBranch = meta.default_branch || 'main';
        stars = meta.stargazers_count ?? null;
      } catch { defaultBranch = 'main'; }
      const ref = task.ref || defaultBranch;
      if (!isCommitSha(ref)) {
        try {
          const c = JSON.parse(await (await fetchImpl(
            `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`,
            { headers: { 'user-agent': 'dsh-intelligence-hub', accept: 'application/json' }, signal: AbortSignal.timeout(15000) }
          )).text());
          sha = String(c.sha || '').toLowerCase();
        } catch { /* pinned by ref name instead */ }
      } else {
        sha = ref.toLowerCase();
      }
      checkpoint = { ...checkpoint, commit: sha, ref, defaultBranch, stars };
      db.prepare('UPDATE intel_research_tasks SET checkpoint_json = ?, updated_at = ? WHERE task_id = ?').run(JSON.stringify(checkpoint), nowIso(), taskId);
    }
    const commit = (checkpoint.commit || task.commit || '').toLowerCase();
    const ref = checkpoint.ref || task.ref || checkpoint.defaultBranch || null;
    const destDir = taskRepoDir(root, task.repo, commit || ref || 'HEAD');

    // ---- COLLECTING: clone (skip when checkpoint says done) ----
    if (checkpoint.phase !== 'collected') {
      setTask(db, taskId, { status: 'COLLECTING' });
      if (!codeResearchLock.tryAcquire()) throw new Error('another code research clone is in progress (concurrency 1)');
      try {
        mkdirSync(destDir, { recursive: true });
        let backend = 'git';
        try {
          if (!(await hasGitBinary())) throw new Error('git not on PATH');
          await cloneWithGit({ owner, repo, ref, commit: commit || null, destDir, timeoutMs: cfg.codeResearchTimeoutMs });
        } catch (gitErr) {
          backend = 'tarball';
          rmSync(destDir, { recursive: true, force: true });
          mkdirSync(destDir, { recursive: true });
          try {
            await fetchTarball({ owner, repo, ref: commit || ref, destDir, timeoutMs: cfg.codeResearchTimeoutMs, maxRepoBytes, fetchImpl, testHosts });
          } catch (tarErr) {
            throw new Error(`clone failed (git: ${gitErr.message}; tarball: ${tarErr.message})`);
          }
        }
        const size = dirSizeBytes(destDir);
        if (size > maxRepoBytes) throw new Error(`repo exceeds codeResearchMaxRepoMb=${cfg.codeResearchMaxRepoMb}`);
        const tree = buildFileTree(destDir);
        if (tree.length === 0) throw new Error('extracted repo is empty');
        checkpoint = { ...checkpoint, phase: 'collected', reposDir: destDir, backend, bytes: size, fileTree: tree, commit: commit || null };
        db.prepare('UPDATE intel_research_tasks SET checkpoint_json = ?, "commit" = COALESCE(?, "commit"), updated_at = ? WHERE task_id = ?')
          .run(JSON.stringify(checkpoint), commit || null, nowIso(), taskId);
        logger.info?.(`intelligence-hub: cloned ${task.repo} via ${backend} (${tree.length} files, ${Math.round(size / 1024)}KB)`);
      } finally {
        codeResearchLock.release();
      }
    }

    // ---- snapshot + project update (idempotent) ----
    const finalCommit = checkpoint.commit || task.commit || 'head';
    const proj = upsertProject(db, {
      fullName: task.repo, defaultBranch: checkpoint.defaultBranch, stars: checkpoint.stars,
    });
    const tree = checkpoint.fileTree || buildFileTree(checkpoint.reposDir);
    const snap = computeSnapshot(tree);
    db.prepare(
      `INSERT OR IGNORE INTO intel_github_snapshots (project_id, "commit", snapshot_json, created_at) VALUES (?, ?, ?, ?)`
    ).run(proj.id, String(finalCommit).toLowerCase(), JSON.stringify({ ...snap, backend: checkpoint.backend, reposDir: checkpoint.reposDir }), nowIso());
    db.prepare('UPDATE intel_github_projects SET last_analyzed_commit = ?, updated_at = ? WHERE id = ?')
      .run(String(finalCommit).toLowerCase(), nowIso(), proj.id);

    setTask(db, taskId, { status: 'ANALYZING' });
    return {
      status: TASK_STATUS.ANALYZING, repo: task.repo, commit: finalCommit,
      reposDir: checkpoint.reposDir, files: tree.length, backend: checkpoint.backend,
      note: 'clone ready; agent reads code with intel_code_read / intel_code_search, then submits via intel_complete_repository_analysis',
    };
  } catch (err) {
    setTask(db, taskId, { status: 'FAILED', error: String(err.message || err).slice(0, 500) });
    throw err;
  }
}

// ---------------- agent session tools ----------------

function requireCollected(db, taskId) {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`unknown task ${taskId}`);
  if (task.status === 'FAILED') throw new Error(`task failed: ${task.error}`);
  const cp = JSON.parse(task.checkpoint_json || '{}');
  if (!cp.reposDir || !existsSync(cp.reposDir)) throw new Error(`task ${taskId} has no collected repo (status=${task.status}); run the CODE_RESEARCH job first`);
  return { task, cp };
}

/** Read at most 400 lines of one file inside the task's isolated reposDir. */
export function codeRead(db, taskId, relPath, fromLine = 1, toLine) {
  const { cp } = requireCollected(db, taskId);
  const tree = cp.fileTree || [];
  const file = tree.find((f) => f.path === String(relPath).split(path.sep).join('/'));
  const abs = safeJoin(cp.reposDir, relPath);
  if (!existsSync(abs)) throw new Error(`file not found in repo: ${relPath}`);
  const st = statSync(abs);
  if (!st.isFile()) throw new Error(`not a file: ${relPath}`);
  if (st.size > 1024 * 1024) throw new Error(`file too large to read (${st.size} bytes)`);
  const from = Math.max(1, Number(fromLine) || 1);
  const to = Math.min(from + MAX_READ_LINES - 1, Number(toLine) || from + MAX_READ_LINES - 1);
  const all = readFileSync(abs, 'utf8').split('\n');
  const slice = all.slice(from - 1, to);
  return {
    task_id: taskId, path: file?.path || String(relPath), total_lines: all.length,
    from_line: from, to_line: Math.min(to, all.length), truncated_by_limit: to < Math.min(Number(toLine) || Infinity, all.length),
    content: slice.map((line, i) => `${from + i}: ${line}`).join('\n'),
  };
}

/** Substring (default) or regex search inside the isolated reposDir. No shell. */
export function codeSearch(db, taskId, query, { glob, regex = false, maxResults = 50 } = {}) {
  const { cp } = requireCollected(db, taskId);
  if (!query || !String(query).trim()) throw new Error('query is required');
  const tree = cp.fileTree || buildFileTree(cp.reposDir);
  const globRe = glob ? new RegExp('^' + String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\0/g, '.*').replace(/\?/g, '.') + '$') : null;
  let matcher;
  if (regex) {
    try { const re = new RegExp(String(query)); matcher = (line) => re.test(line); } catch (e) { throw new Error(`invalid regex: ${e.message}`); }
  } else {
    const q = String(query);
    matcher = (line) => line.includes(q);
  }
  const results = [];
  for (const f of tree) {
    if (results.length >= Math.min(200, Math.max(1, maxResults))) break;
    if (globRe && !globRe.test(f.path)) continue;
    if (f.size > 512 * 1024) continue;
    let abs;
    try { abs = safeJoin(cp.reposDir, f.path); } catch { continue; }
    let text;
    try { text = readFileSync(abs, 'utf8'); } catch { continue; }
    if (text.includes('\0')) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (matcher(lines[i])) {
        results.push({ path: f.path, line: i + 1, snippet: lines[i].trim().slice(0, 200) });
        if (results.length >= maxResults) break;
      }
    }
  }
  return { task_id: taskId, query: String(query), regex: !!regex, count: results.length, results };
}

// ---------------- report validation ----------------

function validateEvidenceRef(e, treePaths) {
  if (!e || typeof e !== 'object') return 'evidence entry must be an object';
  const p = String(e.path || '');
  if (!p) return 'evidence.path required';
  if (!treePaths.has(p)) return `evidence.path not in repo file tree: ${p}`;
  const lines = String(e.lines ?? '');
  if (!/^\d+(-\d+)?$/.test(lines)) return `evidence.lines must be "N" or "N-M": ${lines}`;
  if (!String(e.note || '').trim()) return 'evidence.note required';
  return null;
}

/**
 * Validate a structured code report. Every conclusion field must carry evidence
 * citing path:line that exists in the collected file tree. Returns error string or null.
 */
export function validateCodeReport(report, tree) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) return 'report must be an object';
  const treePaths = new Set((tree || []).map((f) => f.path));
  if (typeof report.architecture !== 'string' || report.architecture.trim().length < 10) {
    return 'architecture must be a non-trivial string (module graph, mermaid text ok)';
  }
  const arrFields = ['key_modules', 'call_chains', 'innovations', 'tradeoffs', 'learning_suggestions'];
  for (const f of arrFields) {
    if (!Array.isArray(report[f]) || report[f].length === 0) return `${f} must be a non-empty array`;
  }
  const evidenceOf = (item) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) return Array.isArray(item.evidence) ? item.evidence : null;
    return null;
  };
  const checkItem = (f, item) => {
    const ev = evidenceOf(item);
    if (item && typeof item === 'string') return `${f} entries must be objects with evidence[] (got string)`;
    if (!ev || ev.length === 0) return `${f} entry #${item?.name ?? ''} has no evidence`;
    for (const [i, e] of ev.entries()) {
      const err = validateEvidenceRef(e, treePaths);
      if (err) return `${f} entry #${i}: ${err}`;
    }
    return null;
  };
  for (const f of arrFields) {
    for (const [i, item] of report[f].entries()) {
      const err = checkItem(f, item);
      if (err) return `${f}[${i}]: ${err}`;
    }
  }
  return null;
}

/**
 * Submit the agent's structured report: validate -> persist intel_code_reports ->
 * task WRITING -> COMPLETED. Rejects empty/invalid evidence.
 */
export function completeAnalysis(db, taskId, report) {
  const { task, cp } = requireCollected(db, taskId);
  const tree = cp.fileTree || [];
  const err = validateCodeReport(report, tree);
  if (err) throw new Error(`report rejected: ${err}`);
  setTask(db, taskId, { status: 'WRITING' });
  const commit = (cp.commit || task.commit || 'head').toLowerCase();
  const full = {
    repo: task.repo,
    commit,
    analyzed_at: nowIso(),
    analysis_mode: cp.backend === 'tarball' && cp.forceAgentRead ? 'tarball-agent-read' : 'agent-read',
    ...report,
  };
  const res = db.prepare(
    'INSERT OR IGNORE INTO intel_code_reports (task_id, repo, "commit", report_json, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(taskId, task.repo, commit, JSON.stringify(full), nowIso());
  if (Number(res.changes) === 0) throw new Error(`report already submitted for task ${taskId}`);
  const reportId = Number(res.lastInsertRowid);
  setTask(db, taskId, {
    status: 'COMPLETED',
    result_json: JSON.stringify({ report_id: reportId, repo: task.repo, commit, analysis_mode: full.analysis_mode }),
    completed_at: nowIso(), error: null,
  });
  return { ok: true, task_id: taskId, report_id: reportId, status: TASK_STATUS.COMPLETED };
}

// ---------------- watch list -> research candidates ----------------

/**
 * For every watched project: resolve HEAD sha via GitHub API; if it differs from
 * last_analyzed_commit, enqueue a CODE_RESEARCH job (a "research candidate" for
 * the new commit) and stamp the project. Returns created candidates.
 */
export async function checkWatchedProjects(db, { fetchImpl = globalThis.fetch, enqueueCodeResearch } = {}) {
  const watched = db.prepare('SELECT * FROM intel_github_projects WHERE watched = 1').all();
  const created = [];
  for (const p of watched) {
    const [owner, repo] = String(p.repo_full_name).split('/');
    try {
      const meta = JSON.parse(await (await fetchImpl(
        `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(p.default_branch || 'main')}`,
        { headers: { 'user-agent': 'dsh-intelligence-hub', accept: 'application/json' }, signal: AbortSignal.timeout(15000) }
      )).text());
      const sha = String(meta.sha || '').toLowerCase();
      if (!sha || sha === String(p.last_analyzed_commit || '').toLowerCase()) continue;
      const r = enqueueCodeResearch({ repo: p.repo_full_name, commit: sha, reason: `watched repo moved ${p.last_analyzed_commit || '(none)'} -> ${sha}` });
      if (r?.task_id) created.push({ repo: p.repo_full_name, commit: sha, task_id: r.task_id });
    } catch { /* network/API error: skip this round */ }
  }
  return created;
}
