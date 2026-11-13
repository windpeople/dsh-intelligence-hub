/** Collection pipeline: run adapters, normalize, idempotently insert into SQLite. */

import { insertDocument, ensureSources, beginJob, finishJob, markSourceRun, listSources } from './db.js';
import { createFetcher } from './http.js';
import { fetchRss } from './adapters/rss.js';
import { searchRecentRepos, fetchReleases } from './adapters/github.js';
import { fetchArxiv } from './adapters/arxiv.js';
import { detectLang, classifyTopic, contentHash } from './normalize.js';

const GITHUB_QUERY = 'topic:llm-agent OR topic:ai-agents';
const GITHUB_RELEASE_REPOS = ['langchain-ai/langchain', 'modelcontextprotocol/servers'];
const ARXIV_QUERY = 'cat:cs.AI OR cat:cs.CL OR all:"LLM agent" OR all:memory';

/** Wrap an async fn with a hard timeout (timer cleared on settle). */
export function withTimeout(promise, ms, label = 'operation') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    Promise.resolve(promise).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

/** Process-wide collection lock so timer + tool never run concurrently. */

export function createCollectLock() {
  let busy = false;
  return {
    tryAcquire() {
      if (busy) return false;
      busy = true;
      return true;
    },
    release() {
      busy = false;
    },
  };
}

/**
 * Build documents from raw adapter items with normalization.
 */
export function normalizeItems(items, { sourceType, fetchedAt = new Date().toISOString() } = {}) {
  return items.map((it) => ({
    source_type: sourceType,
    url: it.url,
    title: it.title || it.url,
    summary: it.summary || '',
    raw_content: it.summary || '',
    lang: detectLang(`${it.title || ''} ${it.summary || ''}`),
    topic: classifyTopic(`${it.title || ''} ${it.summary || ''}`),
    content_hash: contentHash(`${it.title || ''}\n${it.summary || ''}`),
    published_at: it.publishedAt || null,
    fetched_at: fetchedAt,
    meta: it.meta || {},
  }));
}

/**
 * Run one collection pass. kinds: 'rss' | 'github' | 'arxiv' | 'all'.
 * ctxWebFetch (optional): preferred fetch impl from ctx.web.fetch.
 * Returns { fetched, inserted, perSource: [...], errors: [...] }.
 */
export async function collect({ db, kinds = 'all', maxPerRun = 20, timeoutMs = 120000, ctxWebFetch } = {}) {
  const started = Date.now();
  const jobKind = String(kinds);
  const jobId = beginJob(db, jobKind);
  let fetched = 0;
  let inserted = 0;
  const errors = [];
  const perSource = [];

  ensureSources(db);
  const sources = listSources(db).filter((s) => kinds === 'all' || s.source_type === kinds);
  const fetcher = createFetcher({
    fetchImpl: async (url, init) => {
      if (ctxWebFetch) {
        try {
          const res = await ctxWebFetch(url, init);
          if (res && typeof res.text === 'function') return res;
        } catch { /* fall through to global fetch */ }
      }
      return globalThis.fetch(url, init);
    },
  });

  try {
    for (const src of sources) {
      if (Date.now() - started > timeoutMs) {
        errors.push(`collection budget ${timeoutMs}ms exceeded; stopped early`);
        break;
      }
      if (!src.enabled) continue;
      try {
        let items = [];
        if (src.source_type === 'rss') {
          items = await withTimeout(fetchRss(fetcher, src.url), 30000, `rss ${src.name}`);
        } else if (src.source_type === 'github') {
          const repos = await withTimeout(
            searchRecentRepos(fetcher, { query: GITHUB_QUERY, perPage: maxPerRun }),
            30000,
            'github search'
          );
          const releases = await withTimeout(fetchReleases(fetcher, GITHUB_RELEASE_REPOS), 30000, 'github releases');
          items = [...repos, ...releases.filter((r) => !r.meta?.error)];
        } else if (src.source_type === 'arxiv') {
          items = await withTimeout(fetchArxiv(fetcher, { query: ARXIV_QUERY, maxResults: maxPerRun }), 30000, 'arxiv');
        }
        const docs = normalizeItems(items, { sourceType: src.source_type });
        let srcInserted = 0;
        for (const doc of docs.slice(0, maxPerRun)) {
          const r = insertDocument(db, doc, src.id);
          if (r.inserted) srcInserted++;
        }
        fetched += items.length;
        inserted += srcInserted;
        markSourceRun(db, src.id, { ok: true });
        perSource.push({ source: src.name, type: src.source_type, fetched: items.length, inserted: srcInserted });
      } catch (err) {
        markSourceRun(db, src.id, { ok: false, error: String(err.message || err).slice(0, 500) });
        errors.push(`${src.name}: ${err.message || err}`);
        perSource.push({ source: src.name, type: src.source_type, error: String(err.message || err) });
      }
    }
    finishJob(db, jobId, { status: 'done', fetched, inserted });
    return { jobId, fetched, inserted, perSource, errors, elapsedMs: Date.now() - started };
  } catch (err) {
    finishJob(db, jobId, { status: 'failed', fetched, inserted, error: String(err.message || err) });
    throw err;
  }
}
