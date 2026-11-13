/**
 * Web API surface for the intelligence hub Web management UI (V2.0 phase 3).
 *
 * Exposed to the browser over the Fetch route `/api/intelligence-hub`
 * (see index.js). Every method validates its payload against a strict
 * whitelist before touching the database; no SQL or command is ever built
 * from client-supplied strings. Write paths are kept minimal and each one
 * re-uses an already-reviewed library function:
 *   - approveCandidate / rejectCandidate  -> lib/discovery.js
 *   - markItems                           -> lib/feedback.js batchAct
 *   - refreshTopic                        -> lib/topics.js classify/apply
 *   - rollbackKnowledge                   -> revision-chain rebuild (single tx)
 *   - retryJob / triggerCollect           -> lib/scheduler.js queue / injected collect
 *   - researchTrigger                     -> lib/scoring.js requestResearchCandidate (agent hand-off queue)
 *   - addSource / setSourceEnabled        -> lib/discovery.js checkUrlSafety + direct UPDATE
 */

import { getStats, listSources, searchDocuments, getDocument } from './db.js';
import { queueStatus, enqueueJob, localDateString, localDayBounds, JOB_KINDS } from './scheduler.js';
import { listCandidates, approveCandidate, rejectCandidate, checkUrlSafety } from './discovery.js';
import { sourceHealth } from './report.js';
import { batchAct, FEEDBACK_TYPES } from './feedback.js';
import {
  listTopics, getTopic, topicProgress, KNOWLEDGE_SECTIONS,
  classifyAgainstTopic, applyToTopicKnowledge,
} from './topics.js';
import { requestResearchCandidate } from './scoring.js';

const SOURCE_TYPES = ['rss', 'github', 'arxiv'];
const MAX_STRING = 300;
const REPORT_KINDS = ['daily', 'weekly', 'coverage', 'research', 'learning'];
const JOB_STATUSES = ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'];
const DIGEST_PLUS = ['DIGEST', 'RECOMMEND', 'RESEARCH'];

class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) {
  throw new ApiError(code, message);
}

function str(value, name, { max = MAX_STRING, optional = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return '';
    fail('INVALID', `${name} is required`);
  }
  if (typeof value !== 'string') fail('INVALID', `${name} must be a string`);
  if (value.length > max) fail('INVALID', `${name} too long (max ${max})`);
  return value;
}

function optInt(value, name, { min = 1, max = 100, fallback } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) fail('INVALID', `${name} must be an integer ${min}..${max}`);
  return n;
}

function optEnum(value, name, allowed) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') fail('INVALID', `${name} must be a string`);
  const s = value;
  if (!allowed.includes(s)) fail('INVALID', `${name} must be one of: ${allowed.join(', ')}`);
  return s;
}

function optBool(value, name, { fallback, optional = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return fallback;
    fail('INVALID', `${name} is required (boolean)`);
  }
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1 || value === '1') return true;
  if (value === 'false' || value === 0 || value === '0') return false;
  fail('INVALID', `${name} must be a boolean`);
}

function optDate(value, name) {
  if (value === undefined || value === null || value === '') return '';
  const s = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) fail('INVALID', `${name} must be YYYY-MM-DD`);
  return s;
}

/** Strip raw body from a search hit; keep only fields the UI renders. */
function docView(row) {
  const view = {
    id: row.id,
    source_type: row.source_type,
    url: row.url,
    title: row.title,
    summary: String(row.summary || '').slice(0, 1200),
    topic: row.topic,
    lang: row.lang,
    published_at: row.published_at || null,
    fetched_at: row.fetched_at,
    bookmark: row.bookmark ? 1 : 0,
  };
  if (row.score !== undefined) view.score = row.score;
  if (row.decision !== undefined) view.decision = row.decision;
  if (row.source_count !== undefined) view.source_count = row.source_count;
  return view;
}

/**
 * "Today" bounds in the report time zone (Bug fix: previously used the host's
 * `setHours(0,0,0,0)` — on a UTC server that was the UTC day boundary, so
 * documents collected just after local midnight were missing from
 * todayAdded/eventsToday/topicUpdates/topPicks).
 */
function todayBoundsIso(now = new Date(), timeZone = 'Asia/Shanghai') {
  const day = localDateString(now, timeZone);
  return localDayBounds(day, timeZone);
}

function parseEvidenceIds(raw) {
  try {
    const ids = JSON.parse(String(raw || '[]'));
    return Array.isArray(ids) ? ids.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0) : [];
  } catch {
    return [];
  }
}

/** Evidence metadata (title/url) for knowledge rows, capped to keep payloads small. */
function evidenceInfo(db, ids) {
  const out = [];
  for (const id of ids.slice(0, 6)) {
    const d = db.prepare('SELECT id, title, url FROM intel_documents WHERE id = ?').get(id);
    if (d) out.push(d);
  }
  return out;
}

function knowledgeView(db, row) {
  const evidenceIds = parseEvidenceIds(row.evidence_ids);
  return {
    id: row.id,
    topic_id: row.topic_id,
    section: row.section,
    content: String(row.content || '').slice(0, 1200),
    status: row.status,
    created_at: row.created_at,
    evidence_ids: evidenceIds,
    evidence: evidenceInfo(db, evidenceIds),
  };
}

function revisionView(row) {
  return {
    id: row.id,
    knowledge_id: row.knowledge_id,
    change_kind: row.change_kind,
    change_reason: String(row.change_reason || '').slice(0, 300),
    prev_content: String(row.prev_content || '').slice(0, 300),
    new_content: String(row.new_content || '').slice(0, 300),
    created_at: row.created_at,
  };
}

/**
 * Build the endpoint handlers. `db` is the hub's better-sqlite3 handle,
 * `effConfig` the plugin's resolved config (values only). Optional injected
 * capabilities (all optional, tests may omit them):
 *   - collect(kind): the already-audited collect() closure (with its lock) from index.js
 *   - topicJudge(ctx): async LLM refinement hook for refreshTopic (null = rule-only)
 */
export function createWebApi(db, effConfig = {}, options = {}) {
  const timeZone = effConfig.reportTimeZone || 'Asia/Shanghai';

  return {
    /** Dashboard aggregates: today added, queue state, source availability, latest report, recent errors. */
    getStatus() {
      const stats = getStats(db);
      const { start, end } = todayBoundsIso(new Date(), timeZone);
      const todayAdded = db
        .prepare('SELECT COUNT(*) AS n FROM intel_documents WHERE fetched_at >= ? AND fetched_at < ?')
        .get(start, end).n;
      const sources = db.prepare('SELECT id, source_type, name, url, enabled, last_run_at, last_ok_at, last_error FROM intel_sources ORDER BY id').all();
      const okCount = sources.filter((s) => s.last_ok_at && (!s.last_run_at || s.last_ok_at >= s.last_run_at)).length;
      const failedSources = sources.filter((s) => s.last_error).slice(0, 5);
      const queue = queueStatus(db);
      const latestReport = db
        .prepare('SELECT id, report_date, title, created_at FROM intel_reports ORDER BY report_date DESC LIMIT 1')
        .get() || null;
      const recentJobs = db
        .prepare("SELECT id, kind, status, run_date, attempts, error, updated_at FROM intel_job_executions WHERE status IN ('FAILED','PROCESSING') ORDER BY updated_at DESC LIMIT 5")
        .all();
      return {
        documents: stats.documents,
        sourcesTotal: sources.length,
        sourcesOk: okCount,
        todayAdded,
        byType: stats.byType,
        queue,
        latestReport,
        failedSources,
        recentJobs,
        serverTime: new Date().toISOString(),
      };
    },

    /** Workbench aggregates for the redesigned dashboard page. */
    getWorkbench() {
      const { start, end } = todayBoundsIso(new Date(), timeZone);
      const todayAdded = db
        .prepare('SELECT COUNT(*) AS n FROM intel_documents WHERE fetched_at >= ? AND fetched_at < ?')
        .get(start, end).n;
      const eventsToday = db
        .prepare('SELECT COUNT(*) AS n FROM intel_events WHERE first_seen_at >= ? AND first_seen_at < ?')
        .get(start, end).n;
      const eventsUnverified = db
        .prepare("SELECT COUNT(*) AS n FROM intel_events WHERE verification_status = 'UNVERIFIED'")
        .get().n;
      let factsUnverified = 0;
      try {
        factsUnverified = db
          .prepare("SELECT COUNT(*) AS n FROM intel_knowledge_facts WHERE verification_status = 'UNVERIFIED'")
          .get().n;
      } catch { /* table optional */ }
      const topicUpdates = db
        .prepare('SELECT COUNT(*) AS n FROM intel_topic_knowledge_revisions WHERE created_at >= ? AND created_at < ?')
        .get(start, end).n;

      // Today's top picks: L3-scored documents with decision >= DIGEST, best total first.
      const pickSql = `
        SELECT d.id AS document_id, d.title, d.summary, d.topic, d.lang, d.source_type, d.url,
               d.published_at, s.total AS score, s.decision,
               (SELECT COUNT(*) FROM intel_document_events x WHERE x.document_id = d.id) AS source_count
        FROM intel_scores s JOIN intel_documents d ON d.id = s.document_id
        WHERE s.decision IN (${DIGEST_PLUS.map(() => '?').join(',')})
      `;
      const pickParams = [...DIGEST_PLUS];
      let topPicks = db
        .prepare(`${pickSql} AND s.created_at >= ? ORDER BY s.total DESC LIMIT 5`)
        .all(...pickParams, start);
      let picksFallback = false;
      if (!topPicks.length) {
        // Pipeline has not run today yet: fall back to the best all-time picks so the
        // workbench is never empty; flagged so the UI can hint at it.
        topPicks = db.prepare(`${pickSql} ORDER BY s.total DESC LIMIT 5`).all(...pickParams);
        picksFallback = topPicks.length > 0;
      }
      const topPicksView = topPicks.map((r) => ({
        ...docView(r),
        summary: String(r.summary || '').slice(0, 100),
        score: r.score,
        decision: r.decision,
        source_count: r.source_count,
      }));

      // Topic cards: progress + most recent revision time per topic.
      const lastRev = new Map();
      for (const r of db
        .prepare(`SELECT k.topic_id AS tid, MAX(r.created_at) AS at
                  FROM intel_topic_knowledge_revisions r
                  JOIN intel_topic_knowledge k ON k.id = r.knowledge_id
                  GROUP BY k.topic_id`)
        .all()) lastRev.set(r.tid, r.at);
      const topicCards = topicProgress(db).map((t) => ({
        ...t,
        last_revision_at: lastRev.get(t.id) || null,
      }));

      const runningTasks = db
        .prepare(`SELECT task_id, kind, repo, status, updated_at FROM intel_research_tasks
                  WHERE status NOT IN ('CREATED','COMPLETED','FAILED') ORDER BY updated_at DESC LIMIT 5`)
        .all();
      const recentCompleted = db
        .prepare(`SELECT task_id, kind, repo, status, completed_at, updated_at FROM intel_research_tasks
                  WHERE status = 'COMPLETED' ORDER BY updated_at DESC LIMIT 5`)
        .all();
      const pending = db
        .prepare(`SELECT id, topic, reason, decision, created_at FROM intel_research_candidates
                  WHERE status = 'watching' ORDER BY id DESC LIMIT 5`)
        .all();
      const health = sourceHealth(db);

      // 7-day collection trend grouped by local calendar day (reportTimeZone;
      // previously used SQLite date(fetched_at) = UTC day, so documents fetched
      // after local midnight landed in the previous bucket).
      const today = localDateString(new Date(), timeZone);
      const todayDayNumber = Math.floor(Date.parse(`${today}T00:00:00Z`) / 86400000);
      const trend7 = [];
      for (let i = 6; i >= 0; i--) {
        const day = new Date((todayDayNumber - i) * 86400000).toISOString().slice(0, 10);
        const { start, end } = localDayBounds(day, timeZone);
        const n = db
          .prepare('SELECT COUNT(*) AS n FROM intel_documents WHERE fetched_at >= ? AND fetched_at < ?')
          .get(start, end).n;
        trend7.push({ date: day, count: n });
      }

      const weekly = db
        .prepare("SELECT report_date, title FROM intel_reports WHERE kind = 'weekly' ORDER BY report_date DESC LIMIT 1")
        .get() || null;
      const weeklyHint = weekly
        ? `最近周报：${weekly.report_date} ${weekly.title || ''}`.trim()
        : '本周尚未生成周报（每周一自动生成）';

      return {
        todayAdded,
        eventsToday,
        pendingVerify: eventsUnverified + factsUnverified,
        topicUpdates,
        topPicks: topPicksView,
        picksFallback,
        topicCards,
        runningTasks,
        recentCompleted,
        pending,
        sourceHealth: health,
        trend7,
        weeklyHint,
        serverTime: new Date().toISOString(),
      };
    },

    /** Inbox: filterable, paginated document list joined with scores + event counts. */
    getInbox(payload) {
      const q = str(payload?.q, 'q', { optional: true, max: 200 });
      const sourceType = optEnum(payload?.source_type, 'source_type', SOURCE_TYPES);
      const topic = str(payload?.topic, 'topic', { optional: true, max: 120 });
      const minScore = optInt(payload?.min_score, 'min_score', { min: 0, max: 100, fallback: undefined });
      const decision = optEnum(payload?.decision, 'decision', DIGEST_PLUS.concat(['ARCHIVE']));
      const bookmarkRaw = payload?.bookmark;
      const bookmark = bookmarkRaw === undefined || bookmarkRaw === null || bookmarkRaw === ''
        ? undefined
        : optBool(bookmarkRaw, 'bookmark', { optional: true });
      const sort = optEnum(payload?.sort, 'sort', ['fetched', 'score']) || 'fetched';
      const timeRange = optInt(payload?.time_range, 'time_range', { min: 1, max: 60 * 24 * 365, fallback: undefined });
      const limit = optInt(payload?.limit, 'limit', { min: 1, max: 50, fallback: 20 });
      const offset = optInt(payload?.offset, 'offset', { min: 0, max: 1000000, fallback: 0 });

      const conds = [];
      const params = [];
      if (sourceType) { conds.push('d.source_type = ?'); params.push(sourceType); }
      if (topic) { conds.push('d.topic = ?'); params.push(topic); }
      if (q) {
        conds.push('(d.title LIKE ? OR d.summary LIKE ? OR d.raw_content LIKE ?)');
        const like = `%${q}%`;
        params.push(like, like, like);
      }
      if (timeRange) { conds.push('d.fetched_at >= ?'); params.push(new Date(Date.now() - timeRange * 60000).toISOString()); }
      if (bookmark !== undefined) { conds.push('d.bookmark = ?'); params.push(bookmark ? 1 : 0); }
      if (minScore !== undefined) { conds.push('s.total >= ?'); params.push(minScore); }
      if (decision) { conds.push('s.decision = ?'); params.push(decision); }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const order = sort === 'score' ? 's.total DESC, d.fetched_at DESC' : 'd.fetched_at DESC';
      const from = 'FROM intel_documents d LEFT JOIN intel_scores s ON s.document_id = d.id';
      const total = db.prepare(`SELECT COUNT(*) AS n ${from} ${where}`).get(...params).n;
      const rows = db
        .prepare(`SELECT d.*, s.total AS score, s.decision AS decision,
                    (SELECT COUNT(*) FROM intel_document_events x WHERE x.document_id = d.id) AS source_count
                  ${from} ${where} ORDER BY ${order} LIMIT ? OFFSET ?`)
        .all(...params, limit, offset);
      return { total, offset, limit, items: rows.map(docView) };
    },

    /**
     * Batch actions (bookmark and/or feedback). The only new inbox write path;
     * delegates to lib/feedback.js batchAct (one transaction, per-item results).
     */
    markItems(payload) {
      const rawItems = payload?.items;
      if (!Array.isArray(rawItems)) fail('INVALID', 'items must be an array');
      if (rawItems.length === 0) fail('INVALID', 'items must not be empty');
      if (rawItems.length > 50) fail('INVALID', 'items too large (max 50)');
      const items = rawItems.map((raw, i) => {
        const item = raw && typeof raw === 'object' ? raw : {};
        const documentId = optInt(item.document_id ?? raw, `items[${i}].document_id`, { min: 1, max: Number.MAX_SAFE_INTEGER });
        const feedbackType = optEnum(item.feedback_type, `items[${i}].feedback_type`, FEEDBACK_TYPES);
        const relatedTopic = str(item.related_topic ?? payload?.related_topic, `items[${i}].related_topic`, { optional: true, max: 120 });
        const comment = str(item.comment, `items[${i}].comment`, { optional: true, max: 300 });
        return { document_id: documentId, feedback_type: feedbackType || undefined, related_topic: relatedTopic || undefined, comment: comment || undefined };
      });
      const bookmark = optBool(payload?.bookmark, 'bookmark', { optional: true });
      const relatedTopic = str(payload?.related_topic, 'related_topic', { optional: true, max: 120 });
      const r = batchAct(db, {
        items,
        bookmark,
        relatedTopic: relatedTopic || undefined,
        now: new Date().toISOString(),
      });
      return { ok: true, total: r.total, applied: r.applied, bookmarks: r.bookmarks, results: r.results };
    },

    /** Topic list with per-topic knowledge progress. */
    getTopics() {
      return { topics: topicProgress(db), sections: KNOWLEDGE_SECTIONS };
    },

    /** One topic: knowledge grouped by section + recent revision timeline. */
    getTopicDetail(payload) {
      const id = optInt(payload?.id, 'id', { min: 1, max: Number.MAX_SAFE_INTEGER });
      const topic = getTopic(db, id);
      if (!topic) fail('NOT_FOUND', `no topic ${id}`);
      const sections = Object.fromEntries(KNOWLEDGE_SECTIONS.map((s) => [s, []]));
      for (const row of db
        .prepare("SELECT * FROM intel_topic_knowledge WHERE topic_id = ? AND status = 'active' ORDER BY id DESC LIMIT 200")
        .all(id)) {
        const v = knowledgeView(db, row);
        (sections[v.section] || (sections[v.section] = [])).push(v);
      }
      const revisions = db
        .prepare(`SELECT r.* FROM intel_topic_knowledge_revisions r
                  JOIN intel_topic_knowledge k ON k.id = r.knowledge_id
                  WHERE k.topic_id = ? ORDER BY r.id DESC LIMIT 10`)
        .all(id).map(revisionView);
      const lastRevisionAt = revisions[0]?.created_at || null;
      return { topic, sections, revisions, last_revision_at: lastRevisionAt };
    },

    /**
     * Refresh one topic against the last 3 days of documents: classify + apply.
     * Write path re-uses classifyAgainstTopic + applyToTopicKnowledge only.
     */
    async refreshTopic(payload) {
      const id = optInt(payload?.id, 'id', { min: 1, max: Number.MAX_SAFE_INTEGER });
      optBool(payload?.llm, 'llm', { optional: true });
      const topic = getTopic(db, id);
      if (!topic) fail('NOT_FOUND', `no topic ${id}`);
      const keywords = (topic.keywords || []).map((k) => String(k).toLowerCase());
      const cutoff = new Date(Date.now() - 3 * 86400000).toISOString();
      const docs = db
        .prepare('SELECT * FROM intel_documents WHERE fetched_at >= ? ORDER BY fetched_at DESC LIMIT 200')
        .all(cutoff);
      const judge = options.topicJudge && (payload?.llm === undefined || payload.llm === null || payload.llm === true || payload.llm === 'true')
        ? options.topicJudge
        : null;
      let examined = 0;
      const byKind = {};
      let written = 0;
      let errors = 0;
      for (const doc of docs) {
        const lower = `${doc.title} ${doc.summary} ${doc.raw_content}`.toLowerCase();
        const hits = keywords.filter((k) => lower.includes(k));
        if (doc.topic !== topic.name && hits.length === 0) continue;
        if (examined >= 50) break;
        examined++;
        try {
          const c = await classifyAgainstTopic(db, id, doc, { llmJudge: judge });
          byKind[c.kind] = (byKind[c.kind] || 0) + 1;
          if (c.kind !== 'known') {
            applyToTopicKnowledge(db, id, doc, c, [doc.id]);
            written++;
          }
        } catch {
          errors++;
        }
      }
      return { ok: true, topic_id: id, topic: topic.name, examined, written, errors, by_kind: byKind };
    },

    /** Knowledge base search (content LIKE) with evidence links. */
    getKnowledge(payload) {
      const q = str(payload?.q, 'q', { optional: true, max: 200 });
      const topicId = optInt(payload?.topic_id, 'topic_id', { min: 1, max: Number.MAX_SAFE_INTEGER, fallback: undefined });
      const conds = [];
      const params = [];
      if (topicId) { conds.push('k.topic_id = ?'); params.push(topicId); }
      if (q) {
        conds.push('k.content LIKE ?');
        params.push(`%${q}%`);
      }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const rows = db
        .prepare(`SELECT k.* FROM intel_topic_knowledge k ${where} ORDER BY k.id DESC LIMIT 50`)
        .all(...params);
      const topics = listTopics(db).map((t) => ({ id: t.id, name: t.name }));
      return { knowledge: rows.map((r) => knowledgeView(db, r)), topics };
    },

    /**
     * Roll back one revision: mark its knowledge row rolled_back and, when the
     * revision replaced earlier content, restore the previous content as a new
     * active row + a rollback revision (single transaction, auditable chain).
     */
    rollbackKnowledge(payload) {
      const revisionId = optInt(payload?.revision_id, 'revision_id', { min: 1, max: Number.MAX_SAFE_INTEGER });
      const rev = db.prepare('SELECT * FROM intel_topic_knowledge_revisions WHERE id = ?').get(revisionId);
      if (!rev) fail('NOT_FOUND', `no revision ${revisionId}`);
      const knowledge = db.prepare('SELECT * FROM intel_topic_knowledge WHERE id = ?').get(rev.knowledge_id);
      if (!knowledge) fail('NOT_FOUND', `knowledge ${rev.knowledge_id} missing`);
      const now = new Date().toISOString();
      const evidenceIds = parseEvidenceIds(rev.evidence_ids);
      db.exec('BEGIN');
      try {
        db.prepare("UPDATE intel_topic_knowledge SET status = 'rolled_back' WHERE id = ?").run(knowledge.id);
        let restoredId = null;
        if (String(rev.prev_content || '').trim()) {
          const res = db
            .prepare("INSERT INTO intel_topic_knowledge (topic_id, section, content, evidence_ids, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)")
            .run(knowledge.topic_id, knowledge.section, rev.prev_content, rev.evidence_ids || '[]', now);
          restoredId = Number(res.lastInsertRowid);
          db.prepare(
            'INSERT INTO intel_topic_knowledge_revisions (knowledge_id, prev_content, new_content, change_kind, change_reason, evidence_ids, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
          ).run(restoredId, rev.new_content || '', rev.prev_content, 'rollback', `manual rollback of revision #${rev.id}`, rev.evidence_ids || '[]', now);
        }
        db.exec('COMMIT');
        return { ok: true, revision_id: rev.id, knowledge_id: knowledge.id, restored_knowledge_id: restoredId };
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch { /* not in transaction */ }
        throw err;
      }
    },

    /** Sources list with status and last_error. */
    listSources(payload) {
      const sourceType = optEnum(payload?.sourceType ?? payload?.source_type, 'sourceType', SOURCE_TYPES);
      return { sources: listSources(db, { sourceType: sourceType || undefined }) };
    },

    /** Enable/disable one source (minimal write path; no credential fields). */
    setSourceEnabled(payload) {
      const id = optInt(payload?.id, 'id', { min: 1, max: Number.MAX_SAFE_INTEGER });
      const enabled = optBool(payload?.enabled, 'enabled');
      const r = db.prepare('UPDATE intel_sources SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
      if (Number(r.changes) === 0) fail('NOT_FOUND', `no source ${id}`);
      return { ok: true, id, enabled };
    },

    /** Add one source. URL must pass the discovery SSRF safety check first. */
    async addSource(payload) {
      const sourceType = optEnum(payload?.source_type, 'source_type', SOURCE_TYPES);
      const name = str(payload?.name, 'name', { max: 120 });
      const url = str(payload?.url, 'url', { max: 500 });
      if (!/^https?:\/\//i.test(url)) fail('INVALID', 'url must be http(s)');
      const safety = await checkUrlSafety(url);
      if (!safety.ok) fail('SSRF_REJECTED', `url rejected by safety check: ${safety.reason}`);
      const res = db
        .prepare('INSERT OR IGNORE INTO intel_sources (source_type, name, url, created_at) VALUES (?, ?, ?, ?)')
        .run(sourceType, name, url, new Date().toISOString());
      const inserted = Number(res.changes) > 0;
      return { ok: true, inserted, id: inserted ? Number(res.lastInsertRowid) : null };
    },

    /** Source candidates; optional status filter. */
    listCandidates(payload) {
      const status = optEnum(payload?.status, 'status', ['candidate', 'approved', 'rejected']);
      return { candidates: listCandidates(db, { status: status || undefined }) };
    },

    /** Approve one candidate (shared with discovery.js). */
    approveCandidate(payload) {
      const id = optInt(payload?.id, 'id', { min: 1, max: Number.MAX_SAFE_INTEGER });
      const r = approveCandidate(db, id, { now: new Date().toISOString() });
      if (!r.ok) fail(r.error?.code || 'FAILED', r.error?.message || 'approve failed');
      return r;
    },

    /** Reject one candidate. */
    rejectCandidate(payload) {
      const id = optInt(payload?.id, 'id', { min: 1, max: Number.MAX_SAFE_INTEGER });
      const r = rejectCandidate(db, id, { now: new Date().toISOString() });
      if (!r.ok) fail(r.error?.code || 'FAILED', r.error?.message || 'reject failed');
      return r;
    },

    /** Full-text search with whitelisted filters. Returns metadata only, never raw body. */
    searchDocs(payload) {
      const query = str(payload?.query, 'query', { optional: true });
      const sourceType = optEnum(payload?.sourceType, 'sourceType', SOURCE_TYPES);
      const timeRange = optInt(payload?.timeRange, 'timeRange', { min: 1, max: 60 * 24 * 365, fallback: undefined });
      const limit = optInt(payload?.limit, 'limit', { min: 1, max: 50, fallback: 20 });
      const rows = searchDocuments(db, {
        query,
        sourceType: sourceType || undefined,
        timeRange,
        limit,
      });
      return { results: rows.map(docView) };
    },

    /** One document's metadata (summary view, no raw content dump). */
    getDoc(payload) {
      const id = optInt(payload?.id, 'id', { min: 1, max: Number.MAX_SAFE_INTEGER });
      const row = getDocument(db, id);
      if (!row) fail('NOT_FOUND', `no document ${id}`);
      return { doc: docView(row) };
    },

    /** Reports across kinds (daily/weekly/coverage/research/learning), newest first. */
    listReports(payload) {
      const limit = optInt(payload?.limit, 'limit', { min: 1, max: 90, fallback: 30 });
      const kind = optEnum(payload?.kind, 'kind', REPORT_KINDS);
      const rows = [];
      if (!kind || kind === 'daily' || kind === 'weekly') {
        const where = kind ? 'WHERE kind = ?' : '';
        const params = kind ? [kind] : [];
        for (const r of db
          .prepare(`SELECT id, report_date, kind, topic, title, model, created_at, LENGTH(body) AS body_length
                    FROM intel_reports ${where} ORDER BY report_date DESC LIMIT ?`)
          .all(...params, limit)) rows.push(r);
      }
      if (!kind || kind === 'coverage') {
        for (const r of db
          .prepare(`SELECT id, date AS report_date, 'coverage' AS kind, ('coverage ' || date) AS title, created_at, LENGTH(markdown) AS body_length
                    FROM intel_coverage_reports ORDER BY date DESC LIMIT ?`)
          .all(limit)) rows.push(r);
      }
      if (!kind || kind === 'research') {
        for (const r of db
          .prepare(`SELECT task_id AS id, substr(updated_at, 1, 10) AS report_date, 'research' AS kind,
                           repo AS title, updated_at AS created_at, status, LENGTH(result_json) AS body_length
                    FROM intel_research_tasks WHERE kind = 'research'
                    ORDER BY updated_at DESC LIMIT ?`)
          .all(limit)) rows.push(r);
      }
      if (!kind || kind === 'learning') {
        for (const r of db
          .prepare(`SELECT id, substr(created_at, 1, 10) AS report_date, 'learning' AS kind,
                           subject AS title, created_at, LENGTH(content_json) AS body_length
                    FROM intel_learning_materials ORDER BY id DESC LIMIT ?`)
          .all(limit)) rows.push(r);
      }
      rows.sort((a, b) => String(b.report_date || '').localeCompare(String(a.report_date || '')));
      return { reports: rows.slice(0, limit) };
    },

    /** Markdown body of one report. kind picks the source table. */
    getReportMarkdown(payload) {
      const kind = optEnum(payload?.kind, 'kind', REPORT_KINDS) || 'daily';
      if (kind === 'research') {
        const taskId = str(payload?.task_id, 'task_id', { max: 100 });
        const row = db.prepare("SELECT task_id, repo, status, result_json, updated_at FROM intel_research_tasks WHERE task_id = ? AND kind = 'research'").get(taskId);
        if (!row) fail('NOT_FOUND', `no research task ${taskId}`);
        let markdown = '';
        try { markdown = String(JSON.parse(row.result_json || '{}').report || ''); } catch { /* keep empty */ }
        return { report: { report_date: String(row.updated_at || '').slice(0, 10), title: `研究：${row.repo}`, markdown, created_at: row.updated_at, status: row.status } };
      }
      if (kind === 'learning') {
        const id = optInt(payload?.id, 'id', { min: 1, max: Number.MAX_SAFE_INTEGER });
        const row = db.prepare('SELECT id, subject, content_json, created_at, degraded FROM intel_learning_materials WHERE id = ?').get(id);
        if (!row) fail('NOT_FOUND', `no learning material ${id}`);
        return { report: { report_date: String(row.created_at || '').slice(0, 10), title: `学习材料：${row.subject}`, markdown: row.content_json || '', created_at: row.created_at, degraded: row.degraded } };
      }
      const date = optDate(payload?.date, 'date');
      if (!date) fail('INVALID', 'date is required');
      if (kind === 'coverage') {
        const row = db.prepare('SELECT date, markdown, created_at FROM intel_coverage_reports WHERE date = ?').get(date);
        if (!row) fail('NOT_FOUND', `no coverage report for ${date}`);
        return { report: { report_date: row.date, title: `覆盖审计 ${row.date}`, markdown: row.markdown, created_at: row.created_at } };
      }
      const row = db.prepare('SELECT report_date, title, body, created_at FROM intel_reports WHERE report_date = ? AND kind = ?').get(date, kind);
      if (!row) fail('NOT_FOUND', `no ${kind} report for ${date}`);
      return { report: { report_date: row.report_date, title: row.title, markdown: row.body, created_at: row.created_at } };
    },

    /** Source availability breakdown (last run ok/error per source). */
    listSourceHealth() {
      return { health: sourceHealth(db) };
    },

    /** Job queue history, paginated, optional kind/status filters. */
    listJobs(payload) {
      const limit = optInt(payload?.limit, 'limit', { min: 1, max: 50, fallback: 20 });
      const offset = optInt(payload?.offset, 'offset', { min: 0, max: 1000000, fallback: 0 });
      const kind = optEnum(payload?.kind, 'kind', JOB_KINDS);
      const status = optEnum(payload?.status, 'status', JOB_STATUSES);
      const conds = [];
      const params = [];
      if (kind) { conds.push('kind = ?'); params.push(kind); }
      if (status) { conds.push('status = ?'); params.push(status); }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const total = db.prepare(`SELECT COUNT(*) AS n FROM intel_job_executions ${where}`).get(...params).n;
      const rows = db
        .prepare(`SELECT id, kind, run_date, status, attempts, max_attempts, started_at, finished_at, updated_at, error
                  FROM intel_job_executions ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
        .all(...params, limit, offset);
      return { total, offset, limit, jobs: rows };
    },

    /** Re-queue one FAILED job (attempts reset; the normal claim path picks it up). */
    retryJob(payload) {
      const id = optInt(payload?.job_id, 'job_id', { min: 1, max: Number.MAX_SAFE_INTEGER });
      const row = db.prepare('SELECT id, status FROM intel_job_executions WHERE id = ?').get(id);
      if (!row) fail('NOT_FOUND', `no job ${id}`);
      if (row.status !== 'FAILED') fail('INVALID', `only FAILED jobs can be retried (job ${id} is ${row.status})`);
      const now = new Date().toISOString();
      db.prepare("UPDATE intel_job_executions SET status = 'PENDING', attempts = 0, next_run_at = ?, updated_at = ?, error = NULL WHERE id = ?")
        .run(now, now, id);
      return { ok: true, id, status: 'PENDING' };
    },

    /** Trigger a collection run: reuse the injected collect closure (lock-guarded). */
    async triggerCollect(payload) {
      const kind = optEnum(payload?.kind, 'kind', ['rss', 'github', 'arxiv', 'all']) || 'all';
      if (typeof options.collect === 'function') {
        const r = await options.collect(kind);
        return { ok: true, mode: 'sync', kind, fetched: r.fetched, inserted: r.inserted, errors: (r.errors || []).length };
      }
      // Fallback: enqueue through the durable queue (no collect capability injected).
      const r = enqueueJob(db, { kind: 'DAILY_DISCOVERY', runDate: localDateString(new Date(), timeZone), payload: { triggered: 'webapi' } });
      return { ok: true, mode: 'queued', kind, enqueued: r.enqueued, job_id: r.id ?? null };
    },

    /**
     * Hand a deep-research request to the agent (大肥鱼): record a
     * status='requested' candidate in intel_research_candidates and return a
     * queue hint. No RESEARCH_TASK is created here — the agent decides when to
     * run intel_research (see lib/tools.js intel_pending_research).
     */
    researchTrigger(payload) {
      const topic = str(payload?.topic, 'topic', { max: 200 });
      const documentId = payload?.document_id != null
        ? optInt(payload.document_id, 'document_id', { min: 1, max: Number.MAX_SAFE_INTEGER })
        : null;
      const title = payload?.title != null ? str(payload.title, 'title', { optional: true, max: 300 }) : '';
      const reason = `${title || topic}（用户触发深入研究）`;
      const r = requestResearchCandidate(db, { topic, documentId, reason });
      return {
        ok: true,
        queued: true,
        candidate_id: r.id,
        updated: r.updated,
        message: '已加入研究请求队列，大肥鱼将在对话中看到（intel_pending_research）并自行执行深入研究',
      };
    },

    /** Read-only snapshot of the effective plugin configuration. */
    getConfig() {
      return { config: effConfig };
    },
  };
}

/** Endpoint whitelist (25 methods): everything else is refused before any dispatch. */
export const WEB_API_METHODS = [
  'getStatus', 'listSources', 'setSourceEnabled', 'addSource', 'listCandidates', 'approveCandidate', 'rejectCandidate',
  'searchDocs', 'getDoc', 'getInbox', 'markItems', 'getWorkbench',
  'getTopics', 'getTopicDetail', 'refreshTopic', 'getKnowledge', 'rollbackKnowledge',
  'listReports', 'getReportMarkdown', 'listJobs', 'retryJob', 'triggerCollect', 'researchTrigger',
  'listSourceHealth', 'getConfig',
];

/**
 * RPC handler. Returns the result envelope
 * `{ ok: true, value }` / `{ ok: false, error: { code, message, details } }`.
 */
export function createRpcHandler(db, effConfig, options = {}) {
  const api = createWebApi(db, effConfig, options);
  return async (endpoint, payload) => {
    if (!WEB_API_METHODS.includes(endpoint)) {
      return { ok: false, error: { code: 'UNKNOWN_METHOD', message: `unknown endpoint ${String(endpoint).slice(0, 64)}`, details: {} } };
    }
    try {
      const value = await api[endpoint](payload && typeof payload === 'object' ? payload : {});
      return { ok: true, value };
    } catch (e) {
      if (e instanceof ApiError) {
        return { ok: false, error: { code: e.code, message: e.message, details: {} } };
      }
      return { ok: false, error: { code: 'INTERNAL', message: String(e?.message || e).slice(0, 300), details: {} } };
    }
  };
}
