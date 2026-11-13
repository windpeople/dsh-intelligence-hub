/** SQLite layer: WAL, ordered migrations via schema_version, idempotent writes. */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { bigramize, dedupKeyFor, canonicalUrl, ftsQueryFor } from './normalize.js';

const MIGRATIONS = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE intel_sources (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_type TEXT NOT NULL,
          name TEXT NOT NULL,
          url TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          last_run_at TEXT,
          last_ok_at TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX idx_sources_url ON intel_sources(source_type, url);

        CREATE TABLE intel_documents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id INTEGER REFERENCES intel_sources(id) ON DELETE SET NULL,
          source_type TEXT NOT NULL DEFAULT '',
          url TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          raw_content TEXT NOT NULL DEFAULT '',
          summary TEXT NOT NULL DEFAULT '',
          lang TEXT NOT NULL DEFAULT 'und',
          topic TEXT NOT NULL DEFAULT 'general',
          dedup_key TEXT NOT NULL,
          content_hash TEXT NOT NULL DEFAULT '',
          search_text TEXT NOT NULL DEFAULT '',
          meta TEXT NOT NULL DEFAULT '{}',
          published_at TEXT,
          fetched_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX idx_documents_dedup ON intel_documents(dedup_key);
        CREATE INDEX idx_documents_source ON intel_documents(source_id);
        CREATE INDEX idx_documents_fetched ON intel_documents(fetched_at);

        CREATE TABLE intel_collection_jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          kind TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'running',
          started_at TEXT NOT NULL,
          finished_at TEXT,
          fetched INTEGER NOT NULL DEFAULT 0,
          inserted INTEGER NOT NULL DEFAULT 0,
          error TEXT
        );

        CREATE TABLE intel_reports (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          topic TEXT NOT NULL DEFAULT 'general',
          title TEXT NOT NULL DEFAULT '',
          body TEXT NOT NULL DEFAULT '',
          model TEXT NOT NULL DEFAULT '',
          document_ids TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL
        );

        CREATE VIRTUAL TABLE intel_documents_fts USING fts5(
          search_text, content='intel_documents', content_rowid='id', tokenize='unicode61'
        );
        CREATE TRIGGER documents_ai AFTER INSERT ON intel_documents BEGIN
          INSERT INTO intel_documents_fts(rowid, search_text) VALUES (new.id, new.search_text);
        END;
        CREATE TRIGGER documents_ad AFTER DELETE ON intel_documents BEGIN
          INSERT INTO intel_documents_fts(intel_documents_fts, rowid, search_text)
          VALUES ('delete', old.id, old.search_text);
        END;
        CREATE TRIGGER documents_au AFTER UPDATE ON intel_documents BEGIN
          INSERT INTO intel_documents_fts(intel_documents_fts, rowid, search_text)
          VALUES ('delete', old.id, old.search_text);
          INSERT INTO intel_documents_fts(rowid, search_text) VALUES (new.id, new.search_text);
        END;
      `);
    },
  },
  {
    version: 2,
    up(db) {
      db.exec(`
        ALTER TABLE intel_documents ADD COLUMN analysis TEXT;
        ALTER TABLE intel_documents ADD COLUMN bookmark INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE intel_reports ADD COLUMN report_date TEXT;
        CREATE UNIQUE INDEX idx_reports_date ON intel_reports(report_date);

        CREATE TABLE intel_job_executions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          kind TEXT NOT NULL,
          run_date TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'PENDING',
          attempts INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 3,
          payload TEXT NOT NULL DEFAULT '{}',
          next_run_at TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT,
          updated_at TEXT NOT NULL,
          error TEXT,
          result TEXT
        );
        CREATE INDEX idx_jobs_due ON intel_job_executions(status, next_run_at);
        CREATE INDEX idx_jobs_day ON intel_job_executions(kind, run_date);
      `);
    },
  },
  {
    version: 3,
    up(db) {
      db.exec(`
        -- Interest profile: single default row.
        CREATE TABLE intel_interest_profiles (
          profile_id TEXT NOT NULL PRIMARY KEY,
          profile_json TEXT NOT NULL DEFAULT '{}',
          updated_at TEXT NOT NULL
        );

        -- Event clustering.
        CREATE TABLE intel_events (
          event_id TEXT NOT NULL PRIMARY KEY,
          event_title TEXT NOT NULL DEFAULT '',
          event_type TEXT NOT NULL DEFAULT 'news',
          first_seen_at TEXT NOT NULL,
          occurred_at TEXT,
          primary_source TEXT NOT NULL DEFAULT '',
          primary_document_id INTEGER,
          verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED',
          meta TEXT NOT NULL DEFAULT '{}'
        );
        CREATE TABLE intel_document_events (
          document_id INTEGER NOT NULL,
          event_id TEXT NOT NULL,
          is_primary INTEGER NOT NULL DEFAULT 0,
          linked_at TEXT NOT NULL,
          PRIMARY KEY (document_id, event_id)
        );
        CREATE INDEX idx_doc_events_event ON intel_document_events(event_id);

        -- L2 knowledge delta per document.
        CREATE TABLE intel_knowledge_deltas (
          document_id INTEGER NOT NULL PRIMARY KEY,
          novelty_score REAL NOT NULL DEFAULT 50,
          novelty_state TEXT NOT NULL DEFAULT 'UNKNOWN',
          scores_json TEXT NOT NULL DEFAULT '{}',
          known_before TEXT NOT NULL DEFAULT '[]',
          new_findings TEXT NOT NULL DEFAULT '[]',
          evidence_ids TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          ranking_version TEXT NOT NULL DEFAULT 'v1'
        );

        -- L3 final scores.
        CREATE TABLE intel_scores (
          document_id INTEGER NOT NULL PRIMARY KEY,
          r REAL NOT NULL DEFAULT 0,
          n REAL NOT NULL DEFAULT 50,
          p REAL NOT NULL DEFAULT 0,
          e REAL NOT NULL DEFAULT 0,
          t REAL NOT NULL DEFAULT 0,
          total REAL NOT NULL DEFAULT 0,
          stage TEXT NOT NULL DEFAULT 'L3',
          decision TEXT NOT NULL DEFAULT '',
          exploratory INTEGER NOT NULL DEFAULT 0,
          filter_stage TEXT NOT NULL DEFAULT '',
          filter_reason TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          ranking_version TEXT NOT NULL DEFAULT 'v1'
        );
        CREATE INDEX idx_scores_total ON intel_scores(total);

        -- Research gate candidates.
        CREATE TABLE intel_research_candidates (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          topic TEXT NOT NULL,
          decision TEXT NOT NULL,
          reason TEXT NOT NULL DEFAULT '',
          evidence_ids TEXT NOT NULL DEFAULT '[]',
          document_id INTEGER,
          status TEXT NOT NULL DEFAULT 'watching',
          created_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX idx_research_topic_doc ON intel_research_candidates(topic, document_id);

        -- Feedback (Phase 5; table created now).
        CREATE TABLE intel_feedback (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          document_id INTEGER,
          feedback_type TEXT NOT NULL DEFAULT '',
          payload TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 4,
    up(db) {
      db.exec(`
        -- Code Research Pipeline (v4): GitHub source-level research sessions.
        CREATE TABLE intel_github_projects (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          repo_full_name TEXT NOT NULL,
          default_branch TEXT NOT NULL DEFAULT '',
          last_analyzed_commit TEXT,
          stars INTEGER,
          watched INTEGER NOT NULL DEFAULT 0,
          reason TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX idx_gh_projects_repo ON intel_github_projects(repo_full_name);

        CREATE TABLE intel_github_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL REFERENCES intel_github_projects(id) ON DELETE CASCADE,
          "commit" TEXT NOT NULL,
          snapshot_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX idx_gh_snapshots ON intel_github_snapshots(project_id, "commit");

        CREATE TABLE intel_research_tasks (
          task_id TEXT NOT NULL PRIMARY KEY,
          execution_id INTEGER,
          repo TEXT NOT NULL,
          "commit" TEXT,
          ref TEXT,
          status TEXT NOT NULL DEFAULT 'CREATED',
          checkpoint_json TEXT NOT NULL DEFAULT '{}',
          retry_count INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          result_json TEXT,
          token_usage_json TEXT NOT NULL DEFAULT '{}',
          source_refs_json TEXT NOT NULL DEFAULT '[]',
          candidate_id INTEGER,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT
        );
        CREATE INDEX idx_research_tasks_repo_commit ON intel_research_tasks(repo, "commit");
        CREATE INDEX idx_research_tasks_status ON intel_research_tasks(status);

        CREATE TABLE intel_code_reports (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT NOT NULL,
          repo TEXT NOT NULL,
          "commit" TEXT NOT NULL,
          report_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX idx_code_reports_task ON intel_code_reports(task_id);
      `);
    },
  },
  {
    version: 5,
    up(db) {
      db.exec(`
        -- Deep research tasks share intel_research_tasks; kind distinguishes code vs research.
        ALTER TABLE intel_research_tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'code';
        CREATE INDEX idx_research_tasks_kind ON intel_research_tasks(kind, status);

        -- Learning materials generated from completed reports / research tasks (v5).
        CREATE TABLE intel_learning_materials (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          subject TEXT NOT NULL,
          source_type TEXT NOT NULL DEFAULT '',
          source_ref TEXT NOT NULL DEFAULT '',
          content_json TEXT NOT NULL DEFAULT '{}',
          degraded INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_learning_subject ON intel_learning_materials(subject);
      `);
    },
  },
  {
    version: 6,
    up(db) {
      db.exec(`
        -- Phase 5 feedback learning (v6): item-keyed feedback with idempotent (item_id, feedback_type).
        ALTER TABLE intel_feedback ADD COLUMN item_id TEXT;
        ALTER TABLE intel_feedback ADD COLUMN related_topic TEXT;
        ALTER TABLE intel_feedback ADD COLUMN ranking_version TEXT NOT NULL DEFAULT 'v1';
        CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_item_type ON intel_feedback(item_id, feedback_type);

        -- Per-source quality adjustment (bad_source -> -10 with floor, keep/deep_research -> +5 recovery)
        -- and consecutive-failure counter for coverage blind-spot detection.
        ALTER TABLE intel_sources ADD COLUMN quality_adjust INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE intel_sources ADD COLUMN fail_streak INTEGER NOT NULL DEFAULT 0;

        -- Coverage Auditor daily reports (date unique).
        CREATE TABLE intel_coverage_reports (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          date TEXT NOT NULL,
          stats_json TEXT NOT NULL DEFAULT '{}',
          markdown TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_coverage_date ON intel_coverage_reports(date);

        -- Source auto-discovery candidates.
        CREATE TABLE intel_source_candidates (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          url TEXT NOT NULL,
          domain TEXT NOT NULL,
          discovered_via TEXT NOT NULL DEFAULT '',
          rss_detected TEXT NOT NULL DEFAULT '',
          relevance_score REAL NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'candidate',
          safety_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_source_candidates_domain ON intel_source_candidates(domain);

        -- Memory bridge: versioned knowledge facts (export-only; never writes persona/profile).
        CREATE TABLE intel_knowledge_facts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          subject TEXT NOT NULL,
          fact TEXT NOT NULL,
          evidence_ids TEXT NOT NULL DEFAULT '[]',
          source_url TEXT NOT NULL DEFAULT '',
          valid_from TEXT NOT NULL,
          valid_to TEXT,
          confidence REAL NOT NULL DEFAULT 0.6,
          verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED',
          discovered_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          superseded_by INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_facts_subject ON intel_knowledge_facts(subject);
      `);
    },
  },
  {
    version: 7,
    up(db) {
      db.exec(`
        -- Phase 2 (V2.0) data layer: topic knowledge base + weekly reports + usage budget.

        -- Topics: curated knowledge domains (seeded idempotently from lib/topics.js).
        CREATE TABLE intel_topics (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          keywords TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_topics_name ON intel_topics(name);

        -- Per-topic knowledge entries (versioned via revisions below).
        CREATE TABLE intel_topic_knowledge (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          topic_id INTEGER NOT NULL REFERENCES intel_topics(id) ON DELETE CASCADE,
          section TEXT NOT NULL,
          content TEXT NOT NULL,
          evidence_ids TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_topic_knowledge_topic_section ON intel_topic_knowledge(topic_id, section);

        -- Append-only revision history (known/supplement/new/conflict/major_change).
        CREATE TABLE intel_topic_knowledge_revisions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          knowledge_id INTEGER NOT NULL REFERENCES intel_topic_knowledge(id) ON DELETE CASCADE,
          prev_content TEXT NOT NULL DEFAULT '',
          new_content TEXT NOT NULL DEFAULT '',
          change_kind TEXT NOT NULL,
          change_reason TEXT NOT NULL DEFAULT '',
          evidence_ids TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_topic_revisions_knowledge ON intel_topic_knowledge_revisions(knowledge_id);

        -- Daily GitHub star/fork snapshots (same-day idempotent per repo).
        CREATE TABLE intel_source_star_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          repo_full_name TEXT NOT NULL,
          stars INTEGER NOT NULL DEFAULT 0,
          forks INTEGER NOT NULL DEFAULT 0,
          snapshot_date TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_star_snapshots_repo_day ON intel_source_star_snapshots(repo_full_name, snapshot_date);

        -- Report items: which documents back which section of a report.
        CREATE TABLE intel_report_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          report_id INTEGER NOT NULL REFERENCES intel_reports(id) ON DELETE CASCADE,
          document_id INTEGER,
          section TEXT NOT NULL DEFAULT '',
          claim TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_report_items_report ON intel_report_items(report_id);

        -- Report kinds: daily (default) + weekly. The old per-date unique index is
        -- rebuilt as (report_date, kind) so a daily and a weekly report may share a date.
        ALTER TABLE intel_reports ADD COLUMN kind TEXT NOT NULL DEFAULT 'daily';
        DROP INDEX IF EXISTS idx_reports_date;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_date_kind ON intel_reports(report_date, kind);

        -- arXiv version tracking: same canonical paper, different versions are separate docs.
        ALTER TABLE intel_documents ADD COLUMN arxiv_version INTEGER;

        -- Source scheduling / policy columns (credentials stay out of the DB: auth_ref points at them).
        ALTER TABLE intel_sources ADD COLUMN fetch_interval_hours INTEGER;
        ALTER TABLE intel_sources ADD COLUMN last_cursor TEXT;
        ALTER TABLE intel_sources ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE intel_sources ADD COLUMN rate_limit_per_hour INTEGER;
        ALTER TABLE intel_sources ADD COLUMN auth_ref TEXT;

        -- LLM token usage accounting (tokenBudgetPerDay=0 means unlimited).
        CREATE TABLE intel_usage (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          call TEXT NOT NULL DEFAULT '',
          prompt_chars INTEGER NOT NULL DEFAULT 0,
          completion_chars INTEGER NOT NULL DEFAULT 0,
          used_at TEXT NOT NULL,
          usage_date TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_usage_date ON intel_usage(usage_date);
      `);
    },
  },
];

export { MIGRATIONS };

export function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get();
  let current = row && row.v ? row.v : 0;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.exec('BEGIN');
    try {
      m.up(db);
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(m.version, new Date().toISOString());
      db.exec('COMMIT');
      current = m.version;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return current;
}

export function closeDb(db) {
  try {
    db.close();
  } catch {}
}

export function openDb(dbPath) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

const INSERT_DOC = `
  INSERT OR IGNORE INTO intel_documents
    (source_id, source_type, url, title, raw_content, summary, lang, topic,
     dedup_key, content_hash, search_text, meta, published_at, fetched_at, arxiv_version)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

/**
 * Idempotent document insert. Returns { inserted, id }.
 * Duplicate dedup_key is silently ignored. arXiv documents carry a version-suffixed
 * dedup_key (see lib/adapters/arxiv.js) so a new version of the same canonical paper
 * is inserted as its own row; other sources keep the plain canonical-URL key.
 */
export function insertDocument(db, doc, sourceId = null, now = new Date().toISOString()) {
  const url = String(doc.url || '');
  if (!url) return { inserted: false, reason: 'no-url' };
  const dedupKey = doc.dedup_key || dedupKeyFor(url);
  const meta = typeof doc.meta === 'string' ? doc.meta : JSON.stringify(doc.meta || {});
  const arxivVersion = doc.arxiv_version === undefined || doc.arxiv_version === null ? null : Number(doc.arxiv_version) || null;
  const res = db.prepare(INSERT_DOC).run(
    sourceId,
    String(doc.source_type || ''),
    canonicalUrl(url),
    String(doc.title || ''),
    String(doc.raw_content || ''),
    String(doc.summary || ''),
    String(doc.lang || 'und'),
    String(doc.topic || 'general'),
    String(dedupKey),
    String(doc.content_hash || ''),
    bigramize(`${doc.title || ''} ${doc.summary || ''} ${doc.raw_content || ''}`),
    meta,
    doc.published_at || null,
    doc.fetched_at || now,
    arxivVersion
  );
  return { inserted: Number(res.changes) > 0, id: Number(res.lastInsertRowid || 0) };
}

const DEFAULT_SOURCES = [
  ['rss', 'Hacker News (front page)', 'https://hnrss.org/frontpage'],
  ['rss', '机器之心', 'https://www.jiqizhixin.com/rss'],
  ['rss', '量子位', 'https://www.qbitai.com/feed'],
  ['rss', '少数派', 'https://sspai.com/feed'],
  ['github', 'GitHub new repos (llm-agent topics)', 'https://api.github.com/search/repositories'],
  ['arxiv', 'arXiv AI / Agent / Memory', 'https://export.arxiv.org/api/query'],
];

export function ensureSources(db, extra = []) {
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO intel_sources (source_type, name, url, created_at) VALUES (?, ?, ?, ?)'
  );
  const now = new Date().toISOString();
  for (const [type, name, url] of [...DEFAULT_SOURCES, ...extra]) {
    stmt.run(type, name, url, now);
  }
  return db.prepare('SELECT COUNT(*) AS n FROM intel_sources').get().n;
}

export function listSources(db, { sourceType } = {}) {
  const sql = 'SELECT * FROM intel_sources' + (sourceType ? ' WHERE source_type = ?' : '') + ' ORDER BY id';
  return sourceType ? db.prepare(sql).all(sourceType) : db.prepare(sql).all();
}

export function markSourceRun(db, id, { ok, error } = {}) {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE intel_sources SET last_run_at = ?,
       last_ok_at = CASE WHEN ? THEN ? ELSE last_ok_at END,
       last_error = CASE WHEN ? THEN NULL ELSE ? END,
       fail_streak = CASE WHEN ? THEN 0 ELSE fail_streak + 1 END
     WHERE id = ?`
  ).run(now, ok ? 1 : 0, ok ? now : null, ok ? 1 : 0, error || null, ok ? 1 : 0, id);
}

export function beginJob(db, kind) {
  const res = db.prepare('INSERT INTO intel_collection_jobs (kind, started_at) VALUES (?, ?)').run(kind, new Date().toISOString());
  return Number(res.lastInsertRowid);
}

export function finishJob(db, id, { status, fetched, inserted, error } = {}) {
  db.prepare(
    'UPDATE intel_collection_jobs SET status = ?, finished_at = ?, fetched = ?, inserted = ?, error = ? WHERE id = ?'
  ).run(status || 'done', new Date().toISOString(), fetched || 0, inserted || 0, error || null, id);
}

export function getStats(db) {
  const docs = db.prepare('SELECT COUNT(*) AS n FROM intel_documents').get().n;
  const sources = db.prepare('SELECT COUNT(*) AS n FROM intel_sources').get().n;
  const jobs = db.prepare("SELECT COUNT(*) AS n FROM intel_collection_jobs WHERE status = 'running'").get().n;
  const byType = db
    .prepare("SELECT source_type, COUNT(*) AS n FROM intel_documents GROUP BY source_type ORDER BY n DESC")
    .all();
  const lastJob = db.prepare('SELECT * FROM intel_collection_jobs ORDER BY id DESC LIMIT 1').get();
  return { documents: docs, sources, runningJobs: jobs, byType, lastJob: lastJob || null };
}

/**
 * Local library search. Prefers FTS5 (query is bigramized for CJK);
 * falls back to LIKE when FTS yields nothing. timeRange is minutes back.
 */
export function searchDocuments(db, { query, limit = 10, sourceType, timeRange } = {}) {
  const conds = [];
  const params = [];
  if (sourceType) {
    conds.push('d.source_type = ?');
    params.push(sourceType);
  }
  if (timeRange) {
    conds.push('d.fetched_at >= ?');
    params.push(new Date(Date.now() - timeRange * 60000).toISOString());
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const lim = Math.max(1, Math.min(Number(limit) || 10, 100));

  let rows = [];
  if (query && String(query).trim()) {
    try {
      const match = ftsQueryFor(String(query));
      rows = db
        .prepare(
          `SELECT d.* FROM intel_documents_fts f JOIN intel_documents d ON d.id = f.rowid
           WHERE intel_documents_fts MATCH ? ${where ? 'AND ' + where : ''}
           ORDER BY rank LIMIT ?`
        )
        .all(match, ...params, lim);
    } catch {
      rows = [];
    }
    if (rows.length === 0) {
      const like = `%${String(query).trim()}%`;
      rows = db
        .prepare(
          `SELECT d.* FROM intel_documents d ${where ? where + ' AND ' : 'WHERE '}
           (d.title LIKE ? OR d.summary LIKE ? OR d.raw_content LIKE ?)
           ORDER BY d.fetched_at DESC LIMIT ?`
        )
        .all(...params, like, like, like, lim);
    }
  } else {
    rows = db
      .prepare(`SELECT d.* FROM intel_documents d ${where} ORDER BY d.fetched_at DESC LIMIT ?`)
      .all(...params, lim);
  }
  return rows.map(rowToDoc);
}

export function getDocument(db, id) {
  const row = db.prepare('SELECT * FROM intel_documents WHERE id = ?').get(Number(id));
  return row ? rowToDoc(row) : null;
}

function rowToDoc(row) {
  let meta = {};
  try {
    meta = JSON.parse(row.meta || '{}');
  } catch {}
  return { ...row, meta };
}

/** Persist analysis JSON on a document. Never touches raw_content. */
export function saveAnalysis(db, docId, analysis, { model, promptVersion, analyzedAt } = {}) {
  const payload = {
    summary: analysis.summary,
    relevance: analysis.relevance,
    innovation: analysis.innovation,
    model: model || '',
    promptVersion: promptVersion || '',
    analyzedAt: analyzedAt || new Date().toISOString(),
  };
  db.prepare('UPDATE intel_documents SET analysis = ? WHERE id = ?').run(JSON.stringify(payload), Number(docId));
}

/** Report lookup + idempotent insert keyed by unique (report_date, kind). */
export function getReport(db, reportDate, kind = 'daily') {
  return db
    .prepare('SELECT * FROM intel_reports WHERE report_date = ? AND kind = ?')
    .get(String(reportDate), String(kind)) || null;
}

export function saveReport(db, { reportDate, title, body, model, documentIds, createdAt, kind = 'daily' }) {
  const res = db
    .prepare(
      'INSERT OR IGNORE INTO intel_reports (topic, title, body, model, document_ids, created_at, report_date, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(String(kind || 'daily'), title || '', body || '', model || '', JSON.stringify(documentIds || []), createdAt, reportDate, String(kind || 'daily'));
  return { created: Number(res.changes) > 0, id: Number(res.lastInsertRowid || 0) };
}

/** Store the per-document items backing a report's sections (best effort, non-fatal). */
export function saveReportItems(db, reportId, items = [], createdAt = new Date().toISOString()) {
  const stmt = db.prepare(
    'INSERT INTO intel_report_items (report_id, document_id, section, claim, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  for (const it of items) {
    stmt.run(Number(reportId), it.document_id ?? null, String(it.section || ''), String(it.claim || ''), createdAt);
  }
}

/** Count documents first fetched within [startIso, endIso). */
export function countDocsBetween(db, startIso, endIso) {
  return db
    .prepare('SELECT COUNT(*) AS n FROM intel_documents WHERE fetched_at >= ? AND fetched_at < ?')
    .get(startIso, endIso).n;
}

// ---------- Interest profile (v3) ----------

export function getProfileRow(db, profileId = 'default') {
  return db.prepare('SELECT * FROM intel_interest_profiles WHERE profile_id = ?').get(String(profileId)) || null;
}

export function getProfile(db, profileId = 'default') {
  const row = getProfileRow(db, profileId);
  if (!row) return null;
  try {
    return JSON.parse(row.profile_json || '{}');
  } catch {
    return null;
  }
}

/** Upsert profile JSON. Caller is responsible for confirm-gating long-term fields. */
export function saveProfile(db, profile, { profileId = 'default', updatedAt } = {}) {
  db.prepare(
    `INSERT INTO intel_interest_profiles (profile_id, profile_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(profile_id) DO UPDATE SET profile_json = excluded.profile_json, updated_at = excluded.updated_at`
  ).run(String(profileId), JSON.stringify(profile), updatedAt || new Date().toISOString());
}

// ---------- Knowledge deltas / scores / candidates helpers ----------

export function saveKnowledgeDelta(db, { documentId, noveltyScore, noveltyState, scores, knownBefore, newFindings, evidenceIds, createdAt, rankingVersion = 'v1' }) {
  db.prepare(
    `INSERT INTO intel_knowledge_deltas (document_id, novelty_score, novelty_state, scores_json, known_before, new_findings, evidence_ids, created_at, ranking_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(document_id) DO UPDATE SET
       novelty_score = excluded.novelty_score, novelty_state = excluded.novelty_state,
       scores_json = excluded.scores_json, known_before = excluded.known_before,
       new_findings = excluded.new_findings, evidence_ids = excluded.evidence_ids,
       created_at = excluded.created_at, ranking_version = excluded.ranking_version`
  ).run(
    Number(documentId), Number(noveltyScore) || 50, String(noveltyState || 'UNKNOWN'),
    JSON.stringify(scores || {}), JSON.stringify(knownBefore || []), JSON.stringify(newFindings || []),
    JSON.stringify(evidenceIds || []), createdAt || new Date().toISOString(), rankingVersion
  );
}

export function saveDocScore(db, { documentId, r, n, p, e, t, total, stage, decision, exploratory, filterStage, filterReason, createdAt, rankingVersion = 'v1' }) {
  db.prepare(
    `INSERT INTO intel_scores (document_id, r, n, p, e, t, total, stage, decision, exploratory, filter_stage, filter_reason, created_at, ranking_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(document_id) DO UPDATE SET
       r = excluded.r, n = excluded.n, p = excluded.p, e = excluded.e, t = excluded.t,
       total = excluded.total, stage = excluded.stage, decision = excluded.decision,
       exploratory = excluded.exploratory, filter_stage = excluded.filter_stage,
       filter_reason = excluded.filter_reason, created_at = excluded.created_at,
       ranking_version = excluded.ranking_version`
  ).run(
    Number(documentId), Number(r) || 0, Number(n) || 0, Number(p) || 0, Number(e) || 0, Number(t) || 0,
    Number(total) || 0, String(stage || 'L3'), String(decision || ''), exploratory ? 1 : 0,
    String(filterStage || ''), String(filterReason || ''), createdAt || new Date().toISOString(), rankingVersion
  );
}

export function saveResearchCandidate(db, { topic, decision, reason, evidenceIds, documentId, status = 'watching', createdAt }) {
  db.prepare(
    `INSERT OR IGNORE INTO intel_research_candidates (topic, decision, reason, evidence_ids, document_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(String(topic || ''), String(decision || ''), String(reason || ''), JSON.stringify(evidenceIds || []), documentId ?? null, String(status || 'watching'), createdAt || new Date().toISOString());
}
