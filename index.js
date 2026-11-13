/** dsh-intelligence-hub — Host-only plugin: local intelligence collection + durable job queue + daily report + LLM analysis. */

import os from 'node:os';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';
import { openDb, closeDb, getStats } from './lib/db.js';
import { buildTools } from './lib/tools.js';
import { collect, createCollectLock } from './lib/pipeline.js';
import {
  enqueueJob, enqueueScheduledDaily, runDueJobs, recoverStaleJobs, localParts,
  enqueuePipelineRun, parseTimeOfDay, enqueueScheduledWeekly, weekStartOf,
} from './lib/scheduler.js';
import { generateDailyReport, generateWeeklyReport } from './lib/report.js';
import { ensureTopics } from './lib/topics.js';
import { runContentAnalysis } from './lib/analysis.js';
import { runRetention } from './lib/retention.js';
import { createRpcHandler } from './lib/webapi.js';
import { runPipeline, completeResearchCandidates, completeResearchCandidateById } from './lib/scoring.js';
import { runResearchReview } from './lib/researchReview.js';
import { runResearchTask, checkWatchedProjects, createResearchTask, reposRootFor, enforceDiskBudget } from './lib/codeResearch.js';
import { runDeepResearchTask } from './lib/research.js';

const name = 'intelligence-hub';

const inject = ['tools', 'web', 'llm', 'timer', 'connection'];

export const Config = z.object({
  enabled: z.boolean().default(true).description('Enable the intelligence hub plugin.'),
  dbPath: z.string().default('').description('SQLite file path. Empty = ~/.dsh/plugins-data/dsh-intelligence-hub/intel.db'),
  collectEnabled: z.boolean().default(true).description('Enable scheduled collection jobs.'),
  collectIntervalHours: z.number().default(6).description('Minimum hours between DAILY_DISCOVERY collection runs.'),
  maxPerRun: z.number().default(20).description('Max documents inserted per source per run.'),
  analysisEnabled: z.boolean().default(false).description('Enable LLM content analysis (CONTENT_ANALYSIS jobs).'),
  analysisProvider: z.string().default('').description('LLM provider for analysis (paired with model).'),
  analysisModel: z.string().default('').description('LLM model for analysis (paired with provider).'),
  analysisMaxDocs: z.number().default(10).description('Top-N new documents per day to analyze (heuristic-ranked).'),
  reportEnabled: z.boolean().default(true).description('Generate a rule-based daily report each day.'),
  reportTime: z.string().default('18:00').description('Daily report generation time, HH:mm in reportTimeZone.'),
  reportTimeZone: z.string().default('Asia/Shanghai').description('IANA time zone for report scheduling and report dates.'),
  reportsDir: z.string().default('').description('Directory for report .md files. Empty = <db dir>/reports.'),
  retentionDays: z.number().default(90).description('Delete non-bookmarked documents older than this many days.'),
  maxDiskMb: z.number().default(512).description('Disk budget for the SQLite file; oldest non-bookmarked docs are purged beyond it.'),
  pipelineEnabled: z.boolean().default(true).description('Enable the PIPELINE_RUN scoring pipeline (L0 filter + clustering + L1-L3 scoring + research gate).'),
  pipelineSlots: z.string().default('10:00,12:00').description('Comma-separated daily PIPELINE_RUN slots (HH:mm, reportTimeZone). First slot runs L0+clustering, later slots run L1-L3+gate.'),
  scoreThresholds: z.object({
    archive: z.number().default(50).description('Below this total -> ARCHIVE.'),
    digest: z.number().default(50).description('>= digest -> DIGEST candidate.'),
    recommend: z.number().default(70).description('>= recommend -> RECOMMEND.'),
    research: z.number().default(85).description('>= research -> Research Gate evaluation.'),
  }).description('L3 total-score thresholds (0-100 each).'),
  codeResearchEnabled: z.boolean().default(false).description('Enable the Code Research Pipeline (intel_analyze_repository and session tools). Default off to keep search lightweight.'),
  codeResearchMaxRepoMb: z.number().default(200).description('Max size of one cloned repo; larger repos fail the COLLECTING stage.'),
  reposTotalMaxMb: z.number().default(1024).description('Total disk budget for the repos dir; oldest non-watched repos are LRU-evicted beyond it.'),
  codeResearchTimeoutMs: z.number().default(300000).description('Hard timeout for one clone (git or tarball fallback).'),
  extraCloneHosts: z.array(z.string()).default([]).description('Extra git hosts allowed besides github.com.'),
  codeResearchTestHosts: z.array(z.string()).default([]).description('Test-only clone hosts (file:// fixtures). Keep empty in production.'),
  codeResearchReposDir: z.string().default('').description('Repos dir override. Empty = ~/.dsh/plugins-data/dsh-intelligence-hub/repos.'),
  researchBudgetPerDay: z.number().default(3).description('Max deep research tasks (intel_research) created per local day; extra requests are rejected.'),
  researchReviewEnabled: z.boolean().default(true).description('Daily agent-run research review (RESEARCH_REVIEW): LLM autonomously decides which candidates get deep research.'),
  researchReviewTime: z.string().default('15:00').description('Daily RESEARCH_REVIEW time, HH:mm in reportTimeZone.'),
  researchReviewBatch: z.number().default(5).description('Max candidates per review round (requested first, then watching by score).'),
  coverageEnabled: z.boolean().default(true).description('Run the daily COVERAGE_AUDIT (statistics + blind-spot detection).'),
  coverageTime: z.string().default('20:00').description('Daily COVERAGE_AUDIT time, HH:mm in reportTimeZone.'),
  discoveryEnabled: z.boolean().default(true).description('Auto-discover out-of-library source candidates during research/search flows.'),
  maxNewSourcesPerDay: z.number().default(3).description('Max new source candidates recorded per day.'),
  autoApproveSources: z.boolean().default(false).description('Auto-approve discovered sources into scheduled collection (default: wait for explicit user approval).'),
  tokenBudgetPerDay: z.number().default(0).description('Daily LLM token (char) budget. 0 = unlimited. Over-budget LLM calls are skipped and fall back to rule paths.'),
  weeklyReportEnabled: z.boolean().default(true).description('Generate a rule-based weekly report each Monday (kind=weekly, covers the previous week).'),
  weeklyReportTime: z.string().default('09:00').description('Weekly report time, HH:mm in reportTimeZone (fires on Mondays).'),
  starSnapshotsEnabled: z.boolean().default(true).description('Record daily GitHub star/fork snapshots for watched repos during GITHUB_SYNC.'),
});

export function defaultDbPath() {
  return path.join(os.homedir(), '.dsh', 'plugins-data', 'dsh-intelligence-hub', 'intel.db');
}

/** Create a research task with this config's host whitelist (shared by tool + GITHUB_SYNC path). */
export function createResearchTaskSafe(db, { repo, commit, ref, reason, candidateId }, config) {
  return createResearchTask(db, { repo, commit, ref, reason, candidateId }, {
    extraHosts: config.extraCloneHosts || [],
    testHosts: config.codeResearchTestHosts || [],
  });
}

/**
 * Build one scheduler tick: enqueue every due scheduled job into the durable
 * intel_job_executions queue, then execute due jobs to completion. All state
 * that must survive across ticks lives here; `nowFn`/`runJobs`/`runRetentionFn`
 * are injectable for tests (fake clock, mock handlers).
 */
export function createSchedulerTick(db, config, {
  handlers,
  logger = console,
  reportsDir,
  dbPath,
  nowFn = () => new Date(),
  runJobs = runDueJobs,
  runRetentionFn = runRetention,
} = {}) {
  const timeZone = config.reportTimeZone || 'Asia/Shanghai';
  let lastCleanupDay = '';
  let lastDiscoveryDay = '';
  return async function tick() {
    const now = nowFn();
    // Each scheduling block is isolated: one failure must never prevent the
    // other blocks (or the queue execution below) from running.
    try {
      const { date } = localParts(now, timeZone);

      // One DAILY_DISCOVERY per collectIntervalHours-day (simple: per calendar day when interval <= 24h, else skip days).
      if (config.collectEnabled) {
        const hours = Math.max(0.1, Number(config.collectIntervalHours) || 6);
        const slotDays = Math.max(1, Math.round(hours / 24));
        const dayNumber = Math.floor(Date.parse(`${date}T00:00:00Z`) / 86400000);
        if (dayNumber % slotDays === 0 && lastDiscoveryDay !== date) {
          const r = enqueueJob(db, { kind: 'DAILY_DISCOVERY', runDate: date, nextRunAt: now.toISOString() });
          if (r.enqueued) lastDiscoveryDay = date;
        }
        for (const kind of ['RSS_SYNC', 'GITHUB_SYNC', 'PAPER_SYNC']) {
          enqueueJob(db, { kind, runDate: date, nextRunAt: now.toISOString() });
        }
      }

      // Daily report at reportTime (same-day idempotent through queue dedup + unique report_date).
      if (config.reportEnabled) {
        enqueueScheduledDaily(db, [{ kind: 'DAILY_REPORT', at: config.reportTime }], { timeZone, now, nextRunAt: now.toISOString() });
      }

      // Weekly report: Monday at weeklyReportTime, covering the previous week (week-start keyed idempotent).
      if (config.weeklyReportEnabled !== false) {
        enqueueScheduledWeekly(db, { at: config.weeklyReportTime || '09:00', weekday: 1, now, timeZone, nextRunAt: now.toISOString() });
      }

      // Agent-run research review (RESEARCH_REVIEW): same-day idempotent via queue dedup.
      if (config.researchReviewEnabled) {
        enqueueScheduledDaily(db, [{ kind: 'RESEARCH_REVIEW', at: config.researchReviewTime || '15:00' }], { timeZone, now, nextRunAt: now.toISOString() });
      }

      // Coverage audit at coverageTime local (same-day idempotent through queue dedup + unique report date).
      if (config.coverageEnabled) {
        enqueueScheduledDaily(db, [{ kind: 'COVERAGE_AUDIT', at: config.coverageTime || '20:00' }], { timeZone, now, nextRunAt: now.toISOString() });
      }

      // Scoring pipeline slots (first slot -> L0+clustering, later slots -> L1-L3+gate), slot-scoped dedup.
      if (config.pipelineEnabled) {
        enqueuePipelineRun(db, {
          slots: String(config.pipelineSlots || '10:00,12:00').split(',').map((s) => s.trim()).filter((s) => parseTimeOfDay(s) !== null),
          now,
          timeZone,
          nextRunAt: now.toISOString(),
        });
      }

      // Retention: once per local day.
      if (lastCleanupDay !== date) {
        const rr = runRetentionFn(db, { retentionDays: config.retentionDays, maxDiskMb: config.maxDiskMb, dbPath });
        lastCleanupDay = date;
        if (rr.expired.deleted || rr.disk.deleted) {
          logger.info(`intelligence-hub: retention purged expired=${rr.expired.deleted} disk=${rr.disk.deleted}`);
        }
      }
    } catch (err) {
      logger.warn(`intelligence-hub: scheduler enqueue failed: ${err.message}`);
    }

    try {
      const results = await runJobs(db, handlers, {
        maxJobs: 10,
        execTimeoutMs: 10 * 60000,
        heartbeatMs: 15000,
        backoffBaseMs: 60000,
        now,
      });
      for (const r of results) {
        if (r.ok) logger.info(`intelligence-hub: job ${r.kind}#${r.id} completed`);
        else logger.warn(`intelligence-hub: job ${r.kind}#${r.id} failed: ${r.error}`);
      }
    } catch (err) {
      logger.warn(`intelligence-hub: scheduler tick failed: ${err.message}`);
    }
  };
}

/**
 * Adapt the dsh-web seam to the plugin's Response-like `fetch(url, init)` contract.
 * dsh-web (0.2.2-rc.1) exposes `fetch({ url }, signal?) -> WebFetchResult` where the
 * body is a decoded `{ kind: 'html' | 'text', content }` union (text-only, no custom
 * request headers, no binary). This wrapper maps that onto the `.status/.ok/.headers.get/
 * .text()/.arrayBuffer()` shape the rest of the plugin expects. Text-only by design:
 * binary downloads must go through globalThis.fetch.
 */
function responseLikeWebFetch(rawFetch) {
  if (typeof rawFetch !== 'function') return null;
  return async (url, init = {}) => {
    const r = await rawFetch({ url }, init?.signal);
    const kind = r?.body?.kind;
    const content = typeof r?.body?.content === 'string' ? r.body.content : '';
    const contentType = kind === 'html' ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8';
    return {
      ok: Number(r?.statusCode) >= 200 && Number(r?.statusCode) < 300,
      status: r?.statusCode,
      url: r?.url || url,
      truncated: !!r?.truncated,
      headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? contentType : null) },
      text: async () => content,
      arrayBuffer: async () => new TextEncoder().encode(content).buffer,
    };
  };
}

export function apply(ctx, config) {
  if (!config.enabled) return;

  const dbPath = config.dbPath || defaultDbPath();
  const db = openDb(dbPath);
  const logger = ctx.logger || console;
  const timeZone = config.reportTimeZone || 'Asia/Shanghai';
  const reportsDir = config.reportsDir || path.join(path.dirname(dbPath), 'reports');
  const effConfig = { ...config, dbPath, reportsDir, reportTimeZone: timeZone };

  // Startup recovery: stale PROCESSING rows from a previous process -> FAILED + re-queued.
  const recovered = recoverStaleJobs(db, { staleMs: 10 * 60000 });
  if (recovered.length) logger.warn(`intelligence-hub: recovered ${recovered.length} stale job(s) from previous run`);

  // Idempotent topic seeds (V2.0 phase 2): the six default knowledge topics.
  try {
    const seeded = ensureTopics(db);
    if (seeded.some((s) => s.created)) logger.info('intelligence-hub: default topics seeded');
  } catch (e) {
    logger.warn(`intelligence-hub: topic seeding failed: ${e.message}`);
  }

  const disposeTool = [];
  for (const tool of buildTools({
    db,
    config: effConfig,
    webFetch: responseLikeWebFetch(ctx.web?.fetch),
    webSearch: ctx.web && typeof ctx.web.search === 'function' ? (request, signal) => ctx.web.search(request, signal) : null,
    llm: ctx.llm || null,
  })) {
    disposeTool.push(ctx.tools.register(tool));
  }
  logger.info('intelligence-hub: tools registered');

  const runLock = createCollectLock();

  const doCollect = async (kinds) => {
    if (!runLock.tryAcquire()) throw new Error('another collection run is in progress');
    try {
      return await collect({
        db,
        kinds,
        maxPerRun: config.maxPerRun,
        ctxWebFetch: responseLikeWebFetch(ctx.web?.fetch),
      });
    } finally {
      runLock.release();
    }
  };

  const handlers = {
    DAILY_DISCOVERY: async (job) => {
      const r = await doCollect('all');
      return { fetched: r.fetched, inserted: r.inserted, errors: r.errors.length };
    },
    RSS_SYNC: async () => {
      const r = await doCollect('rss');
      return { fetched: r.fetched, inserted: r.inserted, errors: r.errors.length };
    },
    GITHUB_SYNC: async () => {
      const r = await doCollect('github');
      let candidates = [];
      // Star snapshots for watched repos (same-day idempotent via intel_source_star_snapshots).
      let snapshots = 0;
      if (config.starSnapshotsEnabled !== false && ctx.web?.fetch) {
        try {
          const ghFetcher = {
            getJson: async (url) => {
              const res = await globalThis.fetch(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-intelligence-hub' } });
              if (!res.ok) throw new Error(`github ${res.status}`);
              return await res.json();
            },
          };
          const watched = db.prepare('SELECT repo_full_name FROM intel_github_projects WHERE watched = 1').all();
          const { snapshotRepo } = await import('./lib/adapters/github.js');
          for (const w of watched) {
            const s = await snapshotRepo(ghFetcher, db, w.repo_full_name, { now: new Date(), timeZone });
            if (s.saved) snapshots++;
          }
        } catch (e) {
          logger.warn(`intelligence-hub: star snapshot failed: ${e.message}`);
        }
      }
      if (config.codeResearchEnabled && ctx.web?.fetch) {
        try {
          candidates = await checkWatchedProjects(db, {
            fetchImpl: globalThis.fetch, // GitHub API JSON + binary tarball: needs headers/UA and binary bodies, which the ctx.web text seam cannot carry.
            enqueueCodeResearch: ({ repo, commit, reason }) => {
              const created = createResearchTaskSafe(db, { repo, commit, reason }, effConfig);
              if (created.deduped) return created;
              return enqueueJob(db, {
                kind: 'CODE_RESEARCH',
                runDate: `${created.repo}@${String(commit).toLowerCase().slice(0, 40)}`,
                payload: { task_id: created.task_id, repo: created.repo, commit: created.commit, ref: created.ref, reason: reason || '' },
                maxAttempts: 3,
              });
            },
          });
        } catch (e) {
          logger.warn(`intelligence-hub: watched repo check failed: ${e.message}`);
        }
      }
      return { fetched: r.fetched, inserted: r.inserted, errors: r.errors.length, researchCandidates: candidates.length, starSnapshots: snapshots };
    },
    PAPER_SYNC: async () => {
      const r = await doCollect('arxiv');
      return { fetched: r.fetched, inserted: r.inserted, errors: r.errors.length };
    },
    CONTENT_ANALYSIS: async (job) => {
      if (config.analysisEnabled && ctx.llm) {
        return runContentAnalysis(db, { llm: ctx.llm, config: effConfig, job });
      }
      return { skipped: true, reason: 'analysis disabled, unconfigured, or llm capability missing' };
    },
    PIPELINE_RUN: async (job) => {
      const phase = job.payload?.phase || 'FULL';
      const r = await runPipeline(db, {
        phase,
        dateStr: job.run_date?.split('#')[0] || job.payload?.dateStr,
        timeZone,
        config: effConfig,
        llm: ctx.llm || null,
        provider: config.analysisProvider,
        model: config.analysisModel,
      });
      return {
        phase,
        date: r.date,
        l0Passed: r.l0?.passed ?? null,
        l0Filtered: r.l0?.filtered ?? null,
        newlyClustered: r.clustered,
        scored: r.scored.length,
        candidates: r.candidates.length,
        events: r.events.length,
      };
    },
    CODE_RESEARCH: async (job) => {
      if (!config.codeResearchEnabled) return { skipped: true, reason: 'codeResearchEnabled=false' };
      const taskId = job.payload?.task_id;
      if (!taskId) throw new Error('CODE_RESEARCH payload missing task_id');
      const r = await runResearchTask(db, taskId, {
        config: effConfig,
        fetchImpl: globalThis.fetch, // code research downloads tarballs (binary) — not representable via the ctx.web text seam.
        logger,
      });
      try { enforceDiskBudget(db, reposRootFor(effConfig), { reposTotalMaxMb: config.reposTotalMaxMb }); } catch {}
      // Memory bridge: extract facts from a completed code report (innovations/tradeoffs, rule-based).
      if (r.status === 'COMPLETED') {
        try {
          const { extractAndStoreFacts } = await import('./lib/memoryBridge.js');
          const facts = await extractAndStoreFacts(db, taskId, {
            llm: ctx.llm || null, provider: config.analysisProvider, model: config.analysisModel,
            analysisEnabled: !!config.analysisEnabled,
            tokenBudgetPerDay: Number(config.tokenBudgetPerDay) || 0,
          });
          if (facts.ok) logger.info(`intelligence-hub: memory bridge extracted ${facts.added} fact(s) from ${taskId}`);
        } catch (e) {
          logger.warn(`intelligence-hub: memory fact extraction failed (non-fatal): ${e.message}`);
        }
      }
      return { status: r.status, repo: r.repo, commit: r.commit, files: r.files, backend: r.backend };
    },
    RESEARCH_TASK: async (job) => {
      const taskId = job.payload?.task_id;
      if (!taskId) throw new Error('RESEARCH_TASK payload missing task_id');
      const r = await runDeepResearchTask(db, taskId, {
        config: effConfig,
        webSearch: ctx.web?.search ? (request, signal) => ctx.web.search(request, signal) : null,
        webFetch: responseLikeWebFetch(ctx.web?.fetch),
        llm: ctx.llm || null,
        provider: config.analysisProvider,
        model: config.analysisModel,
        reportsDir,
        logger,
      });
      // Hand-off closure: once a deep-research run on this topic COMPLETED,
      // flip its user-requested candidates (status='requested') to 'done'.
      if (r.status === 'COMPLETED') {
        try {
          let topic = job.payload?.topic || '';
          if (!topic) {
            const row = db.prepare('SELECT repo FROM intel_research_tasks WHERE task_id = ?').get(taskId);
            topic = row?.repo || '';
          }
          const marked = completeResearchCandidates(db, topic);
          // Review-enqueued tasks may use a refined topic: mark by candidate id too.
          const byId = completeResearchCandidateById(db, job.payload?.candidate_id);
          if (marked.updated || byId.updated) logger.info(`intelligence-hub: ${marked.updated + byId.updated} pending research candidate(s) marked done for "${topic}"`);
          if (marked.updated) logger.info(`intelligence-hub: ${marked.updated} requested research candidate(s) marked done for "${topic}"`);
        } catch (e) {
          logger.warn(`intelligence-hub: candidate completion marking failed (non-fatal): ${e.message}`);
        }
      }
      // Memory bridge: auto-extract structured facts from a completed deep research report.
      if (r.status === 'COMPLETED' && (r.evidence_count ?? 0) >= 3) {
        try {
          const { extractAndStoreFacts } = await import('./lib/memoryBridge.js');
          const facts = await extractAndStoreFacts(db, taskId, {
            llm: ctx.llm || null, provider: config.analysisProvider, model: config.analysisModel,
            analysisEnabled: !!config.analysisEnabled,
            tokenBudgetPerDay: Number(config.tokenBudgetPerDay) || 0,
          });
          if (facts.ok) logger.info(`intelligence-hub: memory bridge extracted ${facts.added} fact(s) from ${taskId}`);
        } catch (e) {
          logger.warn(`intelligence-hub: memory fact extraction failed (non-fatal): ${e.message}`);
        }
      }
      return { status: r.status, task_id: r.task_id, evidence_count: r.evidence_count ?? null, conflicts: r.conflicts ?? null, insufficient_data: r.insufficient_data ?? null };
    },
    RESEARCH_REVIEW: async (job) => {
      // Agent-run review: LLM decides per candidate research/dismiss; the pool
      // stays untouched when the LLM is unavailable or the token budget is spent.
      return runResearchReview(db, {
        llm: ctx.llm || null,
        config: effConfig,
      });
    },
    COVERAGE_AUDIT: async (job) => {
      const { runCoverageAudit } = await import('./lib/coverage.js');
      const r = await runCoverageAudit(db, {
        dateStr: job.run_date,
        timeZone,
        reportsDir,
        webSearch: ctx.web?.search ? (request, signal) => ctx.web.search(request, signal) : null,
        now: new Date(),
      });
      return { created: r.created, date: r.date, blind_spots: r.stats?.blind_spots?.length ?? 0, file: r.file_path || null };
    },
    DAILY_REPORT: async (job) => {
      const r = await generateDailyReport(db, {
        dateStr: job.run_date,
        timeZone,
        reportsDir,
        now: new Date(),
        llm: ctx.llm || null,
        provider: config.analysisProvider,
        model: config.analysisModel,
        analysisEnabled: !!config.analysisEnabled,
        tokenBudgetPerDay: Number(config.tokenBudgetPerDay) || 0,
      });
      return { created: r.created, id: r.id, totalDocs: r.totalDocs ?? null, file: r.filePath || null };
    },
    WEEKLY_REPORT: async (job) => {
      // Reports on the week given by payload.week_start (last Monday), else the
      // week before the current one. Idempotent via (report_date, kind='weekly').
      const weekStart = job.payload?.week_start
        || weekStartOf(new Date(Date.parse(`${job.run_date}T00:00:00Z`) - 7 * 86400000).toISOString().slice(0, 10), { timeZone });
      const r = await generateWeeklyReport(db, {
        weekStart,
        timeZone,
        reportsDir,
        now: new Date(),
      });
      return { created: r.created, id: r.id, week_start: r.week_start, file: r.filePath || null };
    },
  };

  const tick = createSchedulerTick(db, effConfig, {
    handlers,
    logger,
    reportsDir,
    dbPath,
  });

  if (config.collectEnabled || config.reportEnabled || config.pipelineEnabled || config.coverageEnabled || config.researchReviewEnabled) {
    ctx.interval(() => void tick(), 60000);
    void tick(); // run once at startup
    logger.info(`intelligence-hub: scheduler tick every 60s (report at ${config.reportTime} ${timeZone})`);
  }

  // Web management UI data path: authenticated Fetch route `/api/intelligence-hub`
  // for the browser half (same pattern as dsh-experimental-inspector's bootstrap
  // route; rc.1's connection.rpc.handle requires webServer on the connection
  // service's own context and never materializes, so plugins use fetch routes).
  // Protocol: POST JSON {method, payload} -> {ok:true,value}|{ok:false,error}.
  // Injected capabilities for the phase-3 write paths: the audited collect
  // closure (lock-guarded) for triggerCollect, and an optional LLM judge
  // (config-gated) that refreshTopic may use to refine conflict verdicts.
  const topicJudge = config.analysisEnabled && ctx.llm
    ? async (judgeCtx) => {
        const text =
          '你是知识库变更复核器。根据旧知识与新内容判断变更类型，只输出一个 JSON 对象：' +
          '{"kind":"known|supplement|new|conflict|major_change"}。\n' +
          `专题：${judgeCtx.topic}\n当前判定：${judgeCtx.kind}\n` +
          `相似度：${judgeCtx.similarity}\n旧知识：${String(judgeCtx.old_content || '').slice(0, 1500)}\n` +
          `新内容：${String(judgeCtx.new_content || '').slice(0, 1500)}`;
        let out = '';
        for await (const chunk of ctx.llm.stream({
          provider: config.analysisProvider,
          model: config.analysisModel,
          messages: [{ id: `judge-${Date.now()}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'dsh-intelligence-hub' } }],
          temperature: 0,
          maxTokens: 60,
        })) {
          if (chunk.type === 'text-delta') out += chunk.text;
          if (chunk.type === 'finish' && chunk.reason?.kind === 'error') throw new Error('judge stream error');
        }
        const m = /"(kind)"\s*:\s*"([a-z_]+)"/.exec(out);
        return m ? m[2] : null;
      }
    : null;
  const rpcHandler = createRpcHandler(db, effConfig, { collect: doCollect, topicJudge });
  const disposeRpc = ctx.connection.fetch.register({
    path: '/api/intelligence-hub',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify({ ok: false, error: { code: 'BAD_REQUEST', message: 'invalid JSON body', details: {} } }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
      const result = await rpcHandler(String(body && body.method || ''), body && body.payload);
      return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  logger.info('intelligence-hub: web fetch route /api/intelligence-hub registered');
  ctx.effect(() => () => {
    Promise.resolve(disposeRpc && disposeRpc()).catch((e) => logger.warn(`intelligence-hub: rpc route dispose failed: ${e?.message || e}`));
  });

  ctx.effect(() => () => {
    try {
      closeDb(db);
    } catch {}
    logger.info('intelligence-hub: db closed');
  });
}

export { name, inject };
