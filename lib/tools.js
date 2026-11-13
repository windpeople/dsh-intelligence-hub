/** Tool definitions registered via ctx.tools.register(defineTool(...)). */

import path from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { searchDocuments, getDocument, listSources, getStats, getReport, countDocsBetween } from './db.js';
import { collect, createCollectLock } from './pipeline.js';
import { generateDailyReport } from './report.js';
import { queueStatus, localDateString, localDayBounds, enqueueJob } from './scheduler.js';
import { canonicalUrl } from './normalize.js';
import * as codeResearch from './codeResearch.js';
import * as research from './research.js';
import { listRequestedResearch } from './scoring.js';
import { runResearchReview } from './researchReview.js';
import * as learning from './learning.js';

const JSON_OUT = { type: 'object', additionalProperties: true };

function summarizeDoc(d, truncate = 300) {
  return {
    id: d.id,
    title: d.title,
    url: d.url,
    source_type: d.source_type,
    lang: d.lang,
    topic: d.topic,
    published_at: d.published_at,
    fetched_at: d.fetched_at,
    snippet: String(d.summary || d.raw_content || '').slice(0, truncate),
  };
}

/** Build all tool definitions bound to one db handle + config. */
export function buildTools({ db, config, webFetch, webSearch, llm = null }) {
  const lock = createCollectLock();
  const timeZone = config.reportTimeZone || 'Asia/Shanghai';
  const reportsDir = config.reportsDir || (config.dbPath ? path.join(path.dirname(config.dbPath), 'reports') : '');

  const intelSearch = defineTool({
    name: 'intel_search',
    description:
      'Search the local intelligence library (collected RSS / GitHub / arXiv documents). ' +
      'Returns matching documents with title, url, topic, language and a snippet.',
    parameters: {
      query: { type: 'string', description: 'Search keywords (Chinese supported).' },
      limit: { type: 'integer', description: 'Max results, 1-100.', default: 10 },
      source_type: { type: 'string', description: 'Filter by source type.', enum: ['rss', 'github', 'arxiv'] },
      time_range: { type: 'integer', description: 'Only documents fetched within the last N minutes.' },
    },
    output: {
      schema: JSON_OUT,
      render: (_args, value) => [
        { type: 'text', text: value.query ? `intel_search: ${value.count} result(s) for "${value.query}"` : `intel_search: ${value.count} document(s)` },
      ],
    },
    async execute(args) {
      const rows = searchDocuments(db, {
        query: args.query,
        limit: args.limit,
        sourceType: args.source_type,
        timeRange: args.time_range,
      });
      return {
        query: args.query || '',
        count: rows.length,
        results: rows.map((d) => summarizeDoc(d)),
      };
    },
  });

  const intelGetDocument = defineTool({
    name: 'intel_get_document',
    description: 'Fetch one stored document by id, including its raw collected content.',
    parameters: {
      id: { type: 'integer', description: 'Document id (from intel_search).', required: true },
      truncate: { type: 'integer', description: 'Truncate raw content to this many characters. 0 = full.', default: 2000 },
    },
    output: {
      schema: JSON_OUT,
      render: (_args, value) => [
        { type: 'text', text: value.found ? `Document #${value.document.id}: ${value.document.title}` : 'Document not found.' },
      ],
    },
    async execute(args) {
      const doc = getDocument(db, args.id);
      if (!doc) return { found: false };
      const trunc = Number(args.truncate) || 0;
      const raw = trunc > 0 ? String(doc.raw_content || '').slice(0, trunc) : doc.raw_content;
      return { found: true, document: { ...summarizeDoc(doc, 2000), raw_content: raw } };
    },
  });

  const intelListSources = defineTool({
    name: 'intel_list_sources',
    description:
      'List configured intelligence sources (RSS feeds, GitHub queries, arXiv) with their status. ' +
      'candidates=true lists auto-discovered source candidates instead; action=approve|reject with candidate_id ' +
      'promotes a candidate into a real scheduled source (approve) or rejects it.',
    parameters: {
      source_type: { type: 'string', description: 'Optional filter.', enum: ['rss', 'github', 'arxiv'] },
      candidates: { type: 'boolean', description: 'List discovered source candidates instead of configured sources.', default: false },
      status: { type: 'string', description: 'Candidate status filter (with candidates=true).', enum: ['candidate', 'approved', 'rejected'] },
      action: { type: 'string', description: 'Manage a candidate (requires candidate_id).', enum: ['approve', 'reject'] },
      candidate_id: { type: 'integer', description: 'Candidate id for action=approve|reject.' },
    },
    output: {
      schema: JSON_OUT,
      render: (_args, value) => [
        { type: 'text', text: value.action
          ? `intel_list_sources(${value.action}): ${value.ok ? `candidate #${value.candidate_id} -> ${value.status || 'approved'}` : value.error?.message || 'error'}`
          : `intel_list_sources: ${value.count} ${value.candidates ? 'candidate(s)' : 'source(s)'}` },
      ],
    },
    async execute(args) {
      if (args.action) {
        const discovery = await import('./discovery.js');
        if (!args.candidate_id) return { ok: false, action: args.action, error: { code: 'MISSING_CANDIDATE', message: 'candidate_id is required for approve/reject' } };
        const r = args.action === 'approve'
          ? discovery.approveCandidate(db, args.candidate_id)
          : discovery.rejectCandidate(db, args.candidate_id);
        return { ...r, action: args.action, candidate_id: args.candidate_id, status: r.ok && args.action === 'reject' ? 'rejected' : r.status };
      }
      if (args.candidates) {
        const discovery = await import('./discovery.js');
        const rows = discovery.listCandidates(db, { status: args.status });
        return {
          candidates: true,
          count: rows.length,
          sources: rows.map((c) => ({
            id: c.id, url: c.url, domain: c.domain, discovered_via: c.discovered_via,
            rss_detected: c.rss_detected, relevance_score: c.relevance_score, status: c.status,
            safety_ok: c.safety?.ok ?? null, safety_reason: c.safety?.reason || '', created_at: c.created_at,
          })),
        };
      }
      const rows = listSources(db, { sourceType: args.source_type });
      return {
        count: rows.length,
        sources: rows.map((s) => ({
          id: s.id,
          type: s.source_type,
          name: s.name,
          url: s.url,
          enabled: !!s.enabled,
          last_ok_at: s.last_ok_at,
          last_error: s.last_error,
          quality_adjust: s.quality_adjust || 0,
          fail_streak: s.fail_streak || 0,
        })),
      };
    },
  });

  const intelCollectNow = defineTool({
    name: 'intel_collect_now',
    description:
      'Trigger a synchronous collection run against the configured sources. ' +
      'kinds: rss (news feeds), github (recent repos + releases), arxiv (papers), all.',
    parameters: {
      kind: { type: 'string', description: 'Which adapters to run.', enum: ['rss', 'github', 'arxiv', 'all'], default: 'all' },
      timeout_ms: { type: 'integer', description: 'Hard budget for the whole run (default 120000).', default: 120000 },
    },
    timeoutMs: 180000,
    isConcurrencySafe: () => false,
    output: {
      schema: JSON_OUT,
      render: (_args, value) => [
        { type: 'text', text: `intel_collect_now(${value.kind}): fetched ${value.fetched}, inserted ${value.inserted}, ${value.errors.length} error(s)` },
      ],
    },
    async execute(args) {
      if (!lock.tryAcquire()) {
        return { kind: args.kind || 'all', fetched: 0, inserted: 0, perSource: [], errors: ['another collection run is in progress'], elapsedMs: 0 };
      }
      try {
        const r = await collect({
          db,
          kinds: args.kind || 'all',
          maxPerRun: config.maxPerRun,
          timeoutMs: Number(args.timeout_ms) || 120000,
          ctxWebFetch: webFetch,
        });
        return { kind: r.jobId ? (args.kind || 'all') : 'all', fetched: r.fetched, inserted: r.inserted, perSource: r.perSource, errors: r.errors, elapsedMs: r.elapsedMs };
      } finally {
        lock.release();
      }
    },
  });

  const intelGetStatus = defineTool({
    name: 'intel_get_status',
    description:
      'Show intelligence hub statistics: document/source/job counts, per-type breakdown, task queue state, ' +
      'per-source last_error, documents added today and dedup count.',
    parameters: {},
    output: {
      schema: JSON_OUT,
      render: (_args, value) => [
        { type: 'text', text: `intel_get_status: ${value.stats.documents} documents, today +${value.today.newDocs}, queue ${value.queue.byStatus.PENDING || 0} pending` },
      ],
    },
    async execute() {
      const stats = getStats(db);
      const date = localDateString(new Date(), timeZone);
      const { start, end } = localDayBounds(date, timeZone);
      const todayNew = countDocsBetween(db, start, end);
      const jobsToday = db
        .prepare('SELECT COALESCE(SUM(fetched),0) AS f, COALESCE(SUM(inserted),0) AS i FROM intel_collection_jobs WHERE started_at >= ?')
        .get(start);
      const sources = db
        .prepare('SELECT name, source_type, last_ok_at, last_error FROM intel_sources')
        .all()
        .map((s) => ({ name: s.name, type: s.source_type, last_ok_at: s.last_ok_at, last_error: s.last_error }));
      const { lastCoverageSummary } = await import('./coverage.js');
      return {
        stats,
        queue: queueStatus(db),
        today: { date, newDocs: todayNew, fetched: jobsToday.f, inserted: jobsToday.i, dedupSkipped: Math.max(0, jobsToday.f - jobsToday.i) },
        sources,
        last_coverage: lastCoverageSummary(db),
      };
    },
  });

  const intelGetDailyReport = defineTool({
    name: 'intel_get_daily_report',
    description:
      'Get the intelligence daily report Markdown for a date (default: today, Asia/Shanghai). ' +
      'Groups the day\'s high-scoring documents by topic with source links, publish time and discovery time. ' +
      'If no report exists yet, one is generated on demand (rule-based, no LLM).',
    parameters: {
      date: { type: 'string', description: 'Report date as YYYY-MM-DD (local calendar day). Optional, default today.' },
    },
    output: {
      schema: JSON_OUT,
      render: (_args, value) => [
        { type: 'text', text: `intel_get_daily_report(${value.date}): ${value.found ? `${value.markdown.length} chars` : 'no documents that day'}` },
      ],
    },
    async execute(args) {
      const dateStr = args.date || localDateString(new Date(), timeZone);
      const existing = getReport(db, dateStr);
      if (existing) return { date: dateStr, found: true, created: false, markdown: existing.body };
      const r = await generateDailyReport(db, {
        dateStr,
        timeZone,
        reportsDir,
        llm,
        provider: config.analysisProvider || '',
        model: config.analysisModel || '',
        analysisEnabled: !!config.analysisEnabled,
      });
      return { date: dateStr, found: r.totalDocs > 0, created: r.created, markdown: r.markdown, filePath: r.filePath || null };
    },
  });

  const intelWebSearch = defineTool({
    name: 'intel_web_search',
    description:
      'Real-time web search through the configured DSH web search provider. Returns deduplicated ' +
      'title/url/snippet results. Optionally save results into the local library (saveToDb).',
    parameters: {
      query: { type: 'string', description: 'Search query (one query string; multiple keywords allowed).', required: true },
      max_results: { type: 'integer', description: 'Max results to return (1-20, default 8).', default: 8 },
      save_to_db: { type: 'boolean', description: 'Store results as rss-type documents in the local library.', default: false },
    },
    timeoutMs: 60000,
    output: {
      schema: JSON_OUT,
      render: (_args, value) => [
        { type: 'text', text: value.ok ? `intel_web_search: ${value.count} result(s) for "${value.query}"` : `intel_web_search failed: ${value.error?.code || ''} ${value.error?.message || ''}` },
      ],
    },
    async execute(args) {
      if (typeof webSearch !== 'function') {
        return { ok: false, query: args.query, error: { code: 'WEB_PROVIDER_UNAVAILABLE', message: 'web search capability is not available in this context (no ctx.web.search provider).' } };
      }
      const maxResults = Math.max(1, Math.min(Number(args.max_results) || 8, 20));
      let res;
      try {
        res = await webSearch({ query: String(args.query), maxResults }, undefined);
      } catch (err) {
        const code = err?.code || err?.name || 'WEB_SEARCH_FAILED';
        return {
          ok: false,
          query: args.query,
          error: {
            code,
            message:
              code === 'WEB_PROVIDER_UNAVAILABLE'
                ? 'no usable web search provider is configured; configure one (e.g. dsh-web-search-deepseek) or set DEEPSEEK_API_KEY.'
                : String(err.message || err).slice(0, 500),
          },
        };
      }
      const seen = new Set();
      const results = [];
      for (const s of res?.sources || []) {
        const key = canonicalUrl(s.url) || s.url;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({ title: s.title || s.url, url: s.url, snippet: s.snippet || '', published_at: s.publishedAt || null });
      }
      let saved = null;
      if (args.save_to_db) {
        const { insertDocument } = await import('./db.js');
        const { detectLang } = await import('./normalize.js');
        const { maybeDiscover } = await import('./discovery.js');
        let inserted = 0;
        for (const r of results) {
          const out = insertDocument(db, {
            url: r.url,
            title: r.title,
            summary: r.snippet,
            raw_content: r.snippet,
            source_type: 'rss',
            lang: detectLang(`${r.title} ${r.snippet}`),
            topic: 'general',
          });
          if (out.inserted) {
            inserted++;
            maybeDiscover(db, { url: r.url, title: r.title, description: r.snippet, via: 'intel_web_search' }, { config, fetchText: webFetch });
          }
        }
        saved = { inserted, candidates: results.length };
      }
      return { ok: true, query: args.query, count: results.length, truncated: !!res?.truncated, results, saved };
    },
  });

  const intelTrackTopic = defineTool({
    name: 'intel_track_topic',
    description:
      'View or update the interest profile used for scoring (long-term interests, current projects, learning goals, content preferences). ' +
      'action=get returns the current profile; action=suggest returns a rule-derived suggestion without persisting; ' +
      'action=confirm persists an update patch (ONLY explicit confirm=true writes long-term fields; temporary input is never stored).',
    parameters: {
      action: { type: 'string', description: 'What to do.', enum: ['get', 'suggest', 'confirm'], default: 'get' },
      patch: { type: 'string', description: 'For confirm: JSON object patch, e.g. {"long_term_interests":["RAG"],"current_projects":[{"name":"hub","goal":"...","problems":["..."],"repos":["x/y"],"direction":"..."}]}' },
    },
    output: {
      schema: JSON_OUT,
      render: (_args, value) => [
        { type: 'text', text: `intel_track_topic(${value.action}): ${value.persisted ? 'profile updated' : value.note || 'read-only'}` },
      ],
    },
    async execute(args) {
      const { loadProfile, updateProfile, suggestProfileUpdate, ensureDefaultProfile } = await import('./profile.js');
      ensureDefaultProfile(db);
      if (args.action === 'confirm') {
        let patch = {};
        try {
          patch = typeof args.patch === 'string' ? JSON.parse(args.patch) : args.patch || {};
        } catch {
          return { ok: false, action: 'confirm', persisted: false, error: { code: 'INVALID_PATCH', message: 'patch must be valid JSON' } };
        }
        const r = updateProfile(db, patch, { confirm: true });
        return { ok: true, action: 'confirm', persisted: r.persisted, profile: r.profile };
      }
      if (args.action === 'suggest') {
        const { documentsOnDate } = await import('./report.js');
        const docs = documentsOnDate(db, localDateString(new Date(), timeZone), timeZone).slice(0, 50);
        const r = suggestProfileUpdate(db, docs);
        return { ok: true, action: 'suggest', persisted: false, suggestion: r.suggestion, note: r.note };
      }
      return { ok: true, action: 'get', persisted: false, profile: loadProfile(db), note: 'read-only; use action=confirm with a JSON patch to persist' };
    },
  });

  const intelSubmitFeedback = defineTool({
    name: 'intel_submit_feedback',
    description:
      'Submit user feedback on a document or recommendation. Types and conservative effects: ' +
      'irrelevant/already_known (doc excluded from digest pool), bad_source (source quality -10, floor 30), ' +
      'pause_topic (topic digest-paused 7 days, collection untouched), keep/deep_research (source +5 recovery ' +
      'capped at original, temporary topic interest boost in the suggest queue until confirm). ' +
      'Idempotent per item+type; every adjustment traceable via intel_feedback (ranking_version v1).',
    parameters: {
      document_id: { type: 'integer', description: 'Document the feedback refers to (from intel_search).' },
      feedback_type: {
        type: 'string',
        description: 'What kind of feedback.',
        enum: ['deep_research', 'keep', 'already_known', 'irrelevant', 'bad_source', 'pause_topic'],
        required: true,
      },
      related_topic: { type: 'string', description: 'Topic this feedback is about (required for pause_topic; used for interest boosts).' },
      comment: { type: 'string', description: 'Optional free-text comment.' },
    },
    output: {
      schema: JSON_OUT,
      render: (_args, value) => [
        { type: 'text', text: value.ok
          ? `intel_submit_feedback: ${value.feedback_type} on ${value.item_id}${value.deduped ? ' (idempotent dedup)' : ''}${value.applied?.length ? ` — ${value.applied.join('; ')}` : ''}`
          : `intel_submit_feedback failed: ${value.error?.code || ''} ${value.error?.message || ''}` },
      ],
    },
    async execute(args) {
      const fb = await import('./feedback.js');
      const r = fb.submitFeedback(db, {
        documentId: args.document_id,
        feedbackType: args.feedback_type,
        relatedTopic: args.related_topic || (args.document_id ? fbItemTopic(db, args.document_id) : null),
        comment: args.comment,
      });
      if (!r.ok) return r;
      return {
        ok: true,
        id: r.id,
        item_id: r.item_id,
        document_id: args.document_id ?? null,
        feedback_type: r.feedback_type,
        related_topic: r.related_topic,
        deduped: r.deduped,
        applied: r.applied,
        source_id: r.source_id,
        quality_adjust: r.quality_adjust,
        ranking_version: r.ranking_version,
        trace: fb.feedbackTrace(db, { itemId: r.item_id, limit: 5 }),
      };
    },
  });

  const intelExportMemoryFacts = defineTool({
    name: 'intel_export_memory_facts',
    description:
      'Read-only export of versioned knowledge facts (intel_knowledge_facts) for the personal memory system ' +
      'to pull on demand. Returns JSON only; never writes the profile, persona, or any external system. ' +
      'subject: substring filter; since: ISO timestamp filter on valid_from.',
    parameters: {
      subject: { type: 'string', description: 'Optional subject substring filter.' },
      since: { type: 'string', description: 'Optional ISO time; only facts with valid_from >= since.' },
      include_superseded: { type: 'boolean', description: 'Include closed (superseded) fact versions.', default: false },
    },
    output: {
      schema: JSON_OUT,
      render: (_args, value) => [
        { type: 'text', text: `intel_export_memory_facts: ${value.count} fact(s) (read-only export)` },
      ],
    },
    async execute(args) {
      const bridge = await import('./memoryBridge.js');
      return bridge.exportFacts(db, { subject: args.subject, since: args.since, includeSuperseded: !!args.include_superseded });
    },
  });

  function fbItemTopic(dbHandle, docId) {
    try {
      return dbHandle.prepare('SELECT topic FROM intel_documents WHERE id = ?').get(Number(docId))?.topic || null;
    } catch {
      return null;
    }
  }

  // ---------------- Code Research Pipeline (config.codeResearchEnabled, default off) ----------------
  const codeTools = [];
  if (config.codeResearchEnabled) {
    const testHosts = Array.isArray(config.codeResearchTestHosts) ? config.codeResearchTestHosts : [];
    const extraHosts = Array.isArray(config.extraCloneHosts) ? config.extraCloneHosts : [];
    const crCfg = {
      codeResearchTimeoutMs: config.codeResearchTimeoutMs,
      codeResearchMaxRepoMb: config.codeResearchMaxRepoMb,
      reposTotalMaxMb: config.reposTotalMaxMb,
      codeResearchReposDir: config.codeResearchReposDir,
    };
    const cr = codeResearch;

    const intelTrackGithub = defineTool({
      name: 'intel_track_github',
      description:
        'Manage the GitHub repo watch list. action=add watches a repo (later GITHUB_SYNC runs detect new commits on the default branch and auto-create CODE_RESEARCH candidates); action=remove un-watches; action=list shows all watched/known repos.',
      parameters: {
        action: { type: 'string', description: 'What to do.', enum: ['add', 'remove', 'list'], default: 'list' },
        repo: { type: 'string', description: 'owner/repo (or full https URL, github.com + configured extra hosts only). Required for add/remove.' },
        reason: { type: 'string', description: 'Why this repo is watched (stored on the project).' },
      },
      output: {
        schema: JSON_OUT,
        render: (_args, value) => [{ type: 'text', text: `intel_track_github(${value.action}): ${value.ok ? 'ok' : value.error?.message || 'error'}` }],
      },
      async execute(args) {
        if (args.action === 'list') {
          const rows = db.prepare('SELECT repo_full_name, default_branch, last_analyzed_commit, stars, watched, reason FROM intel_github_projects ORDER BY updated_at DESC').all();
          return { ok: true, action: 'list', repos: rows.map((r) => ({ repo: r.repo_full_name, default_branch: r.default_branch, last_analyzed_commit: r.last_analyzed_commit, stars: r.stars, watched: !!r.watched, reason: r.reason })) };
        }
        let parsed;
        try { parsed = cr.parseRepoInput(args.repo, { extraHosts, testHosts }); } catch (e) {
          return { ok: false, action: args.action, error: { code: 'INVALID_REPO', message: e.message } };
        }
        if (args.action === 'add') {
          const p = cr.upsertProject(db, { fullName: parsed.fullName, watched: true, reason: args.reason || '' });
          return { ok: true, action: 'add', repo: parsed.fullName, watched: !!p.watched, reason: p.reason };
        }
        const p = cr.upsertProject(db, { fullName: parsed.fullName, watched: false });
        return { ok: true, action: 'remove', repo: parsed.fullName, watched: !!p.watched };
      },
    });

    const intelAnalyzeRepository = defineTool({
      name: 'intel_analyze_repository',
      description:
        'Start an async source-level research task for a GitHub repo: validates the URL whitelist, creates a CODE_RESEARCH job (clone depth-1 pinned ref/commit into an isolated read-only dir + file-tree index), and returns task_id. Commit dedup: an already-analyzed commit returns the cached report instead of re-cloning. After the task reaches ANALYZING, read code with intel_code_read / intel_code_search and submit intel_complete_repository_analysis.',
      parameters: {
        repo: { type: 'string', description: 'owner/repo or full https URL (github.com by default; extra hosts via config).', required: true },
        commit: { type: 'string', description: 'Pin a commit sha (hex, 7-40 chars). Omit = latest commit of ref.' },
        ref: { type: 'string', description: 'Git ref (tag or branch) to pin when commit is omitted.' },
        reason: { type: 'string', description: 'Why this research task is being started (e.g. research candidate id).' },
      },
      output: {
        schema: JSON_OUT,
        render: (_args, value) => [{ type: 'text', text: `intel_analyze_repository: ${value.deduped ? `deduped (${value.reason})` : `task ${value.task_id} created`} ` }],
      },
      async execute(args) {
        let created;
        try {
          created = cr.createResearchTask(db, {
            repo: args.repo, commit: args.commit, ref: args.ref, reason: args.reason,
            candidateId: args.reason ? Number(args.reason) || null : null,
          }, { extraHosts, testHosts });
        } catch (e) {
          return { ok: false, error: { code: 'INVALID_REQUEST', message: e.message } };
        }
        if (created.deduped) return { ok: true, ...created };
        const commit = created.commit || args.ref || 'HEAD';
        const job = enqueueJob(db, {
          kind: 'CODE_RESEARCH',
          runDate: `${created.repo}@${String(commit).toLowerCase().slice(0, 40)}`,
          payload: { task_id: created.task_id, repo: created.repo, commit: created.commit, ref: created.ref, reason: args.reason || '' },
          maxAttempts: 3,
        });
        db.prepare('UPDATE intel_research_tasks SET execution_id = ? WHERE task_id = ?').run(job.id ?? null, created.task_id);
        return { ok: true, ...created, job_id: job.id ?? null, enqueued: job.enqueued };
      },
    });

    const intelCodeRead = defineTool({
      name: 'intel_code_read',
      description:
        'Read source lines of one file inside an isolated code research task dir (read-only). Max 400 lines per call; path must stay inside the task reposDir (traversal rejected). Returns numbered lines for path:line evidence citations.',
      parameters: {
        task_id: { type: 'string', description: 'Research task id.', required: true },
        path: { type: 'string', description: 'File path relative to the repo root.', required: true },
        from_line: { type: 'integer', description: 'First line (1-based, default 1).' },
        to_line: { type: 'integer', description: 'Last line (inclusive). Clamped to a 400-line window.' },
      },
      output: {
        schema: JSON_OUT,
        render: (_args, value) => [{ type: 'text', text: `intel_code_read ${value.path} ${value.from_line}-${value.to_line} (${value.total_lines} lines total)` }],
      },
      async execute(args) {
        try {
          return { ok: true, ...cr.codeRead(db, args.task_id, args.path, args.from_line, args.to_line) };
        } catch (e) {
          return { ok: false, error: { code: 'READ_FAILED', message: e.message } };
        }
      },
    });

    const intelCodeSearch = defineTool({
      name: 'intel_code_search',
      description:
        'Search source inside an isolated code research task dir (self-implemented substring or regex scan; no shell). Returns path:line snippets; use them to plan intel_code_read calls and to build evidence citations.',
      parameters: {
        task_id: { type: 'string', description: 'Research task id.', required: true },
        query: { type: 'string', description: 'Substring (default) or regex pattern.', required: true },
        glob: { type: 'string', description: 'Optional file glob, e.g. "lib/*.js" or "**/*.ts".' },
        regex: { type: 'boolean', description: 'Treat query as a regular expression.', default: false },
        max_results: { type: 'integer', description: 'Max path:line hits (default 50).', default: 50 },
      },
      output: {
        schema: JSON_OUT,
        render: (_args, value) => [{ type: 'text', text: `intel_code_search "${value.query}": ${value.count} hit(s)` }],
      },
      async execute(args) {
        try {
          return { ok: true, ...cr.codeSearch(db, args.task_id, args.query, { glob: args.glob, regex: args.regex, maxResults: args.max_results }) };
        } catch (e) {
          return { ok: false, error: { code: 'SEARCH_FAILED', message: e.message } };
        }
      },
    });

    const intelCompleteAnalysis = defineTool({
      name: 'intel_complete_repository_analysis',
      description:
        'Submit the structured code research report for a task and mark it COMPLETED. Required structure: architecture (string), key_modules, call_chains, innovations, tradeoffs, learning_suggestions (non-empty arrays) — every entry must carry evidence:[{path, lines "N"|"N-M", note}] citing files that exist in the collected tree. Reports with missing/empty evidence or nonexistent paths are rejected.',
      parameters: {
        task_id: { type: 'string', description: 'Research task id.', required: true },
        report: { type: 'string', description: 'Report JSON string with the required structure and evidence arrays.', required: true },
      },
      output: {
        schema: JSON_OUT,
        render: (_args, value) => [{ type: 'text', text: `intel_complete_repository_analysis: ${value.ok ? `report #${value.report_id} stored, task COMPLETED` : value.error?.message || 'error'}` }],
      },
      async execute(args) {
        let report;
        try { report = typeof args.report === 'string' ? JSON.parse(args.report) : args.report; } catch (e) {
          return { ok: false, error: { code: 'INVALID_REPORT', message: `report must be valid JSON: ${e.message}` } };
        }
        try {
          return cr.completeAnalysis(db, args.task_id, report);
        } catch (e) {
          return { ok: false, error: { code: 'REPORT_REJECTED', message: e.message } };
        }
      },
    });

    codeTools.push(intelTrackGithub, intelAnalyzeRepository, intelCodeRead, intelCodeSearch, intelCompleteAnalysis);
  }

  // ---------------- Deep research (kind='research', v5) ----------------

  const intelResearch = defineTool({
    name: 'intel_research',
    description:
      'Start an async deep research task on a topic: local library search (FTS) + web search + budget-bounded ' +
      'full-text fetch -> evidence extraction -> conflict annotation -> (standard/deep, LLM available) written report. ' +
      'Returns task_id; poll intel_get_research_report. Daily budget: config researchBudgetPerDay (default 3); ' +
      'an active task on the same topic dedups.',
    parameters: {
      topic: { type: 'string', description: 'Research topic/keywords.', required: true },
      depth: { type: 'string', description: 'quick = evidence only; standard/deep add an LLM-written report.', enum: ['quick', 'standard', 'deep'], default: 'standard' },
      max_sources: { type: 'integer', description: 'Max documents to fetch full text for (default by depth: quick 4 / standard 8 / deep 12).' },
      time_range: { type: 'integer', description: 'Local-library search window in minutes.' },
    },
    output: {
      schema: JSON_OUT,
      render: (_args, value) => [
        { type: 'text', text: value.ok ? (value.deduped ? `intel_research: deduped -> ${value.task_id} (${value.reason || value.status})` : `intel_research: task ${value.task_id} created (budget ${value.budget ? `${value.budget.used}/${value.budget.perDay}` : ''})`) : `intel_research failed: ${value.error?.code || ''} ${value.error?.message || ''}` },
      ],
    },
    async execute(args) {
      const created = research.createDeepResearchTask(db, args, {
        budgetPerDay: Number(config.researchBudgetPerDay) || 3,
        timeZone,
      });
      if (!created.ok) return created;
      if (created.deduped) return { ok: true, ...created };
      const date = localDateString(new Date(), timeZone);
      const job = enqueueJob(db, {
        kind: 'RESEARCH_TASK',
        runDate: `${date}#${created.task_id}`,
        payload: { task_id: created.task_id, topic: created.topic, depth: created.depth },
        maxAttempts: 3,
      });
      db.prepare('UPDATE intel_research_tasks SET execution_id = ? WHERE task_id = ?').run(job.id ?? null, created.task_id);
      return { ok: true, ...created, job_id: job.id ?? null, enqueued: job.enqueued };
    },
  });

  // ---------------- Agent research hand-off (candidates status='requested') ----------------

  const intelPendingResearch = defineTool({    name: 'intel_pending_research',
    description:
      'List deep-research requests explicitly handed over by the user / web panel ' +
      '(intel_research_candidates with status=\'requested\'), each with title, reason and the ' +
      'evidence document (if any). For each item, decide yourself whether to run ' +
      'intel_research(topic) on it; when the RESEARCH_TASK completes, the candidate is ' +
      'automatically marked status=\'done\'. An empty list means no pending hand-offs.',
    parameters: {
      limit: { type: 'integer', description: 'Max items to return (default 20, max 100).', default: 20 },
    },
    output: {
      schema: JSON_OUT,
      render: (_args, value) => [
        { type: 'text', text: `intel_pending_research: ${value.count} pending request(s)` },
      ],
    },
    async execute(args) {
      const items = listRequestedResearch(db, { limit: args.limit });
      return { ok: true, count: items.length, items };
    },
  });

  const intelRunResearchReview = defineTool({
    name: 'intel_run_research_review',
    description:
      'Run one agent research review round right now (same as the scheduled RESEARCH_REVIEW job): ' +
      'for each pool candidate (requested/deferred first, then watching by score, cap = batch or config ' +
      'researchReviewBatch) an LLM structured decision research|dismiss is made; research creates a deep ' +
      'research task via refined_topic and enqueues RESEARCH_TASK (researchBudgetPerDay enforced; ' +
      'over-budget candidates are marked deferred), dismiss marks the candidate dismissed with the reason. ' +
      'No LLM configured or token budget exhausted -> the whole run is skipped and the pool is untouched.',
    parameters: {
      batch: { type: 'integer', description: 'Max candidates for this round (default: config researchReviewBatch).' },
    },
    output: {
      schema: JSON_OUT,
      render: (_args, value) => [
        { type: 'text', text: value.skipped ? `intel_run_research_review: skipped (${value.reason})` : `intel_run_research_review: ${value.reviewed?.length || 0} candidate(s) reviewed, ${value.enqueued || 0} enqueued, ${value.dismissed || 0} dismissed, ${value.deferred || 0} deferred` },
      ],
    },
    async execute(args) {
      return runResearchReview(db, {
        llm: llm || null,
        config: { ...config, researchReviewBatch: args.batch ?? config.researchReviewBatch },
      });
    },
  });

  const intelGetResearchReport = defineTool({
    name: 'intel_get_research_report',
    description:
      'Get the status/result of a research task (kind research: deep-research report + evidence + conflicts; ' +
      'kind code: structured code report with path:line evidence once COMPLETED). Accepts task_id; ' +
      'report_id alone refers to an intel_code_reports row.',
    parameters: {
      task_id: { type: 'string', description: 'task id returned by intel_research or intel_analyze_repository.' },
      report_id: { type: 'integer', description: 'Alternative: intel_code_reports row id.' },
    },
    output: {
      schema: JSON_OUT,
      render: (_args, value) => [{ type: 'text', text: `intel_get_research_report: ${value.status || (value.report ? 'report' : 'not found')}` }],
    },
    async execute(args) {
      if (args.task_id) {
        const t = db.prepare('SELECT * FROM intel_research_tasks WHERE task_id = ?').get(String(args.task_id));
        if (t && t.kind === 'research') {
          const base = { ok: true, task_id: t.task_id, kind: 'research', topic: t.repo, status: t.status, error: t.error, updated_at: t.updated_at, completed_at: t.completed_at };
          if (t.status === 'COMPLETED') {
            const result = JSON.parse(t.result_json || '{}');
            if (result.empty) {
              return { ...base, empty: true, message: '证据不足，已转入观察', reason: result.reason || '证据不足', evidence_count: 0 };
            }
            return { ...base, report: result.report, evidence_count: result.evidence_count, conflicts: result.conflicts, insufficient_data: result.insufficient_data, plain_summary: result.plain_summary, sources: result.sources, token_usage: result.token_usage };
          }
          let cp = {};
          try { cp = JSON.parse(t.checkpoint_json || '{}'); } catch {}
          return { ...base, phase: cp.phase || 'created', collected: { local: (cp.local || []).length, web: (cp.web || []).length }, documents: (cp.documents || []).length };
        }
      }
      if (args.report_id && !args.task_id) {
        const row = db.prepare('SELECT * FROM intel_code_reports WHERE id = ?').get(Number(args.report_id));
        if (!row) return { ok: false, error: { code: 'NOT_FOUND', message: `no report ${args.report_id}` } };
        return { ok: true, report: JSON.parse(row.report_json) };
      }
      const task = args.task_id ? codeResearch.getTask(db, args.task_id) : null;
      if (!task) return { ok: false, error: { code: 'NOT_FOUND', message: `no task ${args.task_id}` } };
      const base = {
        ok: true, task_id: task.task_id, kind: 'code', repo: task.repo, commit: task.commit, status: task.status,
        error: task.error, retry_count: task.retry_count,
        updated_at: task.updated_at, completed_at: task.completed_at,
      };
      if (task.status === 'COMPLETED') {
        const row = db.prepare('SELECT id, report_json FROM intel_code_reports WHERE task_id = ?').get(task.task_id);
        return { ...base, report_id: row?.id ?? null, report: row ? JSON.parse(row.report_json) : null };
      }
      let checkpoint = {};
      try { checkpoint = JSON.parse(task.checkpoint_json || '{}'); } catch {}
      return {
        ...base,
        backend: checkpoint.backend || null,
        files: Array.isArray(checkpoint.fileTree) ? checkpoint.fileTree.length : null,
        file_tree_sample: Array.isArray(checkpoint.fileTree) ? checkpoint.fileTree.slice(0, 30).map((f) => f.path) : [],
      };
    },
  });

  const intelGenerateLearningMaterial = defineTool({
    name: 'intel_generate_learning_material',
    description:
      'Generate structured learning material (objectives, prerequisites, concepts, flow, cases, source entries, ' +
      '3-5 practice tasks, common mistakes, interview questions, next steps) FROM an existing source: a completed ' +
      'deep research task, a code research report, a daily report, or the top-scored local documents for a topic. ' +
      'Every claim cites evidence ids (or path:line); LLM unavailable -> rule template marked degraded. No invented conclusions.',
    parameters: {
      topic: { type: 'string', description: 'Topic: picks top-scored matching documents as facts.' },
      report_id: { type: 'integer', description: 'Daily report id (intel_reports).' },
      task_id: { type: 'string', description: 'Completed research task id (deep research or code research).' },
    },
    output: {
      schema: JSON_OUT,
      render: (_args, value) => [
        { type: 'text', text: value.ok ? `intel_generate_learning_material: #${value.id} "${value.subject}" (${value.degraded ? 'degraded' : 'llm'}, ${value.facts.length} facts)` : `failed: ${value.error?.message || value.error}` },
      ],
    },
    async execute(args) {
      try {
        return await learning.generateLearningMaterial(db, {
          topic: args.topic, reportId: args.report_id, taskId: args.task_id,
          llm: config.analysisEnabled ? llm : null,
          provider: config.analysisProvider || '',
          model: config.analysisModel || '',
          reportsDir,
        });
      } catch (e) {
        return { ok: false, error: { code: 'LEARNING_FAILED', message: e.message } };
      }
    },
  });

  return [intelSearch, intelGetDocument, intelListSources, intelCollectNow, intelGetStatus, intelGetDailyReport, intelWebSearch, intelTrackTopic, intelSubmitFeedback, intelExportMemoryFacts, intelResearch, intelPendingResearch, intelRunResearchReview, intelGetResearchReport, intelGenerateLearningMaterial, ...codeTools];
}
