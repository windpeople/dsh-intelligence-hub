/** GitHub adapter: unauthenticated REST search of recent repos + releases. */

const API = 'https://api.github.com';

function ghHeaders(token) {
  const h = { accept: 'application/vnd.github+json' };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

/**
 * Split a query on ` OR ` into separate GitHub-legal queries.
 * Verified against the live API (2026-11-12): `topic:a OR topic:b created:>d`
 * returns HTTP 422 — "The search contains only logical operators (AND / OR /
 * NOT) without any search terms"; parenthesized `(topic:a OR topic:b)` returns
 * 200 but always total_count=0 (OR does not combine qualifiers). Each operand
 * requested as its own query works, so we do that and merge results.
 */
export function splitOrQueries(query) {
  return String(query || '')
    .split(/\s+OR\s+/i)
    .map((q) => q.trim())
    .filter(Boolean);
}

/** Search repos created in the last `days` days matching a query/topic. */
export async function searchRecentRepos(fetcher, { query = 'topic:llm-agent', days = 7, perPage = 20, token = process.env.GITHUB_TOKEN || '' } = {}) {
  const created = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const queries = splitOrQueries(query);
  const byName = new Map();
  let firstError = null;
  let okQueries = 0;
  for (const q of queries) {
    const url = `${API}/search/repositories?q=${encodeURIComponent(`${q} created:>${created}`)}&sort=stars&order=desc&per_page=${Math.min(perPage, 100)}`;
    try {
      const data = await fetcher.getJson(url, { headers: ghHeaders(token) });
      okQueries++;
      for (const r of Array.isArray(data.items) ? data.items : []) {
        const prev = byName.get(r.full_name);
        if (!prev || (r.stargazers_count || 0) > (prev.stargazers_count || 0)) byName.set(r.full_name, r);
      }
    } catch (err) {
      firstError = firstError || err; // tolerate one sub-query failing (e.g. rate limit)
    }
  }
  if (okQueries === 0 && firstError) throw firstError;
  const items = [...byName.values()]
    .sort((a, b) => (b.stargazers_count || 0) - (a.stargazers_count || 0))
    .slice(0, perPage);
  return items.map((r) => ({
    title: `${r.full_name} ★${r.stargazers_count}`,
    url: r.html_url,
    summary: String(r.description || '').slice(0, 1000),
    publishedAt: r.created_at || null,
    meta: { stars: r.stargazers_count, language: r.language, topics: r.topics || [] },
  }));
}

/** Latest releases for a repo list like ['openai/openai-python']. */
export async function fetchReleases(fetcher, repos, { token = process.env.GITHUB_TOKEN || '' } = {}) {
  const out = [];
  for (const repo of repos) {
    try {
      const data = await fetcher.getJson(`${API}/repos/${repo}/releases/latest`, { headers: ghHeaders(token) });
      if (data && data.html_url) {
        out.push({
          title: `${repo} ${data.tag_name || ''}`.trim(),
          url: data.html_url,
          summary: String(data.body || '').slice(0, 2000),
          publishedAt: data.published_at || null,
          meta: { repo, tag: data.tag_name },
        });
      }
    } catch (err) {
      out.push({ title: `${repo} release fetch failed`, url: `${API}/repos/${repo}/releases/latest`, summary: String(err.message || err), publishedAt: null, meta: { error: true } });
    }
  }
  return out;
}

// ---------------- V2.0 star snapshots ----------------

/** Local date 'YYYY-MM-DD' for a snapshot (tz-aware via the scheduler helper when given). */
function snapshotDate(date = new Date(), timeZone = 'Asia/Shanghai') {
  if (typeof timeZone === 'function') return timeZone(date);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour12: false,
  }).format(date);
}

/**
 * Fetch stars/forks for one repo via the REST repo endpoint.
 * fetcher needs getJson(url, opts). Returns { repo, stars, forks, pushed_at, fetched_at } or null.
 */
export async function fetchRepoSnapshot(fetcher, repo, { token = process.env.GITHUB_TOKEN || '', now = new Date() } = {}) {
  try {
    const data = await fetcher.getJson(`${API}/repos/${repo}`, { headers: ghHeaders(token) });
    if (!data || data.full_name === undefined && data.stargazers_count === undefined) return null;
    return {
      repo: data.full_name || repo,
      stars: Number(data.stargazers_count) || 0,
      forks: Number(data.forks_count) || 0,
      pushed_at: data.pushed_at || null,
      fetched_at: now.toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * Persist one snapshot. Same-day idempotent: UNIQUE(repo_full_name, snapshot_date),
 * INSERT OR IGNORE. Returns { saved, id, duplicate, snapshot_date }.
 */
export function saveStarSnapshot(db, repo, { stars, forks, date, now = new Date(), timeZone = 'Asia/Shanghai' } = {}) {
  const day = date || snapshotDate(now, timeZone);
  const res = db
    .prepare(
      'INSERT OR IGNORE INTO intel_source_star_snapshots (repo_full_name, stars, forks, snapshot_date) VALUES (?, ?, ?, ?)'
    )
    .run(String(repo), Number(stars) || 0, Number(forks) || 0, day);
  const saved = Number(res.changes) > 0;
  const id = saved ? Number(res.lastInsertRowid) : null;
  return { saved, id, duplicate: !saved, snapshot_date: day, repo: String(repo), stars: Number(stars) || 0, forks: Number(forks) || 0 };
}

/** Snapshot a repo and store it in one call. Returns { snapshot: {...}|null, saved } */
export async function snapshotRepo(fetcher, db, repo, opts = {}) {
  const snap = await fetchRepoSnapshot(fetcher, repo, opts);
  if (!snap) return { snapshot: null, saved: false };
  const saved = saveStarSnapshot(db, snap.repo, {
    stars: snap.stars, forks: snap.forks, now: opts.now instanceof Date ? opts.now : new Date(), timeZone: opts.timeZone,
  });
  return { snapshot: snap, saved: saved.saved, duplicate: saved.duplicate, snapshot_date: saved.snapshot_date };
}

/**
 * Star trend across the last `days` days: earliest vs latest snapshot in the window.
 * Returns { repo, snapshots, first, last, deltaStars, deltaForks, trendUp } or null with <2 snapshots.
 */
export function starTrend(db, repo, { days = 7, now = new Date(), timeZone = 'Asia/Shanghai' } = {}) {
  const cutoff = snapshotDate(new Date(now.getTime() - days * 86400000), timeZone);
  const rows = db
    .prepare('SELECT * FROM intel_source_star_snapshots WHERE repo_full_name = ? AND snapshot_date >= ? ORDER BY snapshot_date ASC, id ASC')
    .all(String(repo), cutoff);
  if (rows.length === 0) return null;
  const first = rows[0];
  const last = rows[rows.length - 1];
  const deltaStars = last.stars - first.stars;
  const deltaForks = last.forks - first.forks;
  return {
    repo: String(repo),
    snapshots: rows.length,
    first: { date: first.snapshot_date, stars: first.stars, forks: first.forks },
    last: { date: last.snapshot_date, stars: last.stars, forks: last.forks },
    deltaStars,
    deltaForks,
    trendUp: deltaStars > 0,
  };
}
