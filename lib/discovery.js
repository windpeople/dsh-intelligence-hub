/** Phase 5 Source Auto-Discovery: high-quality out-of-library domains found during research/search
 *  become intel_source_candidates. Safety first: SSRF checks (private/loopback/metadata IPs, non-http(s),
 *  DNS-resolved private addresses); RSS probe over common paths + HTML <link rel="alternate">;
 *  profile-relevance scoring; daily quota; approval gate (autoApproveSources default false).
 */

import { promises as dns } from 'node:dns';
import { withTimeout } from './pipeline.js';
import { loadProfile, SYNONYMS } from './profile.js';


export const DEFAULTS = { maxNewSourcesPerDay: 3, discoveryEnabled: true, autoApproveSources: false };

/** Domains already handled by built-in adapters / obvious noise — never become candidates. */
export const KNOWN_NOISE_DOMAINS = new Set([
  'github.com', 'api.github.com', 'raw.githubusercontent.com', 'objects.githubusercontent.com', 'gist.github.com',
  'arxiv.org', 'export.arxiv.org', 'doi.org',
  'hnrss.org', 'news.ycombinator.com',
  'jiqizhixin.com', 'qbitai.com', 'sspai.com',
  'google.com', 'www.google.com', 'baidu.com', 'bing.com', 'x.com', 'twitter.com', 'facebook.com',
  'youtube.com', 'www.youtube.com', 'wikipedia.org', 'en.wikipedia.org', 'zh.wikipedia.org',
  'npmjs.com', 'www.npmjs.com', 'pypi.org', 'docker.com',
]);

const nowIso = () => new Date().toISOString();

/** Extract lowercase hostname (no port) from a URL; '' when unparseable. */
export function extractDomain(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function isPrivateIp(host) {
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '0.0.0.0') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local incl. cloud metadata 169.254.169.254
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast/reserved
    return false;
  }
  if (host === '::1' || host === '::') return true;
  if (/^(f[cd]|fe80)/i.test(host)) return true; // IPv6 ULA / link-local
  return false;
}

/**
 * SSRF safety check for a candidate URL. Rejections are final for that candidate.
 * Checks: protocol, literal host, DNS resolution (all records must be public).
 * `resolver` is injectable for tests. Returns { ok, reason, checks }.
 */
export async function checkUrlSafety(url, { resolver } = {}) {
  const checks = {};
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return { ok: false, reason: 'unparseable-url', checks };
  }
  checks.protocol = u.protocol;
  if (!/^https?:$/.test(u.protocol)) return { ok: false, reason: `non-http(s) protocol ${u.protocol}`, checks };
  const host = u.hostname.toLowerCase();
  checks.host = host;
  if (isPrivateIp(host)) return { ok: false, reason: `private/reserved host ${host}`, checks };
  const lookup = resolver || ((h) => dns.lookup(h, { all: true }));
  try {
    const addrs = await withTimeout(lookup(host), 5000, 'dns-lookup');
    checks.addresses = (addrs || []).map((a) => a.address);
    if (!checks.addresses.length) return { ok: false, reason: 'dns-unresolved', checks };
    if (checks.addresses.some((a) => isPrivateIp(a))) return { ok: false, reason: 'dns resolves to private/reserved address', checks };
  } catch (e) {
    return { ok: false, reason: `dns lookup failed: ${String(e.message || e).slice(0, 120)}`, checks };
  }
  return { ok: true, reason: '', checks };
}

const RSS_PATHS = ['/feed', '/rss', '/atom', '/feed.xml', '/index.xml', '/rss.xml', '/feeds'];

function looksLikeFeed(text, contentType = '') {
  const head = String(text || '').slice(0, 800).toLowerCase();
  return /<rss|<feed|<\?xml[^>]*rss|application\/(rss|atom)\+xml/.test(head) || /application\/(rss|atom)\+xml/.test(String(contentType).toLowerCase());
}

function extractAlternateLink(html) {
  const m = /<link[^>]+rel=["']alternate["'][^>]*>/gi.exec(String(html || ''));
  if (!m) return null;
  const tag = m[0];
  const typeM = /type=["']([^"']+)["']/i.exec(tag);
  const hrefM = /href=["']([^"']+)["']/i.exec(tag);
  if (!hrefM) return null;
  if (typeM && !/rss|atom/i.test(typeM[1])) return null;
  return hrefM[1];
}

/**
 * Probe RSS existence for a site. Tries the homepage HTML <link rel="alternate"> first,
 * then common paths. `fetchText(url)` injectable (tests use mocks). Returns { found, url, tried }.
 */
export async function probeRss(base, { fetchText } = {}) {
  if (typeof fetchText !== 'function') return { found: false, url: '', tried: [], reason: 'no fetch capability' };
  const tried = [];
  const getText = async (url) => {
    let out = await fetchText(url);
    if (out && typeof out.text === 'function') out = await out.text();
    return out;
  };
  let altHref = null;
  try {
    const html = await withTimeout(getText(base), 8000, 'homepage-probe');
    altHref = extractAlternateLink(html);
  } catch {
    // homepage may 404/timeout; still try the common paths
  }
  const candidates = [];
  if (altHref) {
    try {
      candidates.push(new URL(altHref, base).toString());
    } catch {}
  }
  for (const p of RSS_PATHS) {
    try {
      candidates.push(new URL(p, base.endsWith('/') ? base : `${base}/`).toString());
    } catch {}
  }
  for (const url of [...new Set(candidates)]) {
    tried.push(url);
    let text = '';
    try {
      text = await withTimeout(getText(url), 8000, 'rss-probe');
    } catch {
      continue;
    }
    if (looksLikeFeed(text)) return { found: true, url, tried };
  }
  return { found: false, url: '', tried };
}

/** Relevance score (0-100): title/description hits against profile long-term interest synonyms. */
export function relevanceToProfile(db, { title = '', description = '' } = {}) {
  const text = `${String(title)} ${String(description)}`.toLowerCase();
  if (!text.trim()) return 0;
  const profile = loadProfile(db);
  let hits = 0;
  const matched = [];
  for (const interest of profile.long_term_interests || []) {
    const key = String(interest).toLowerCase().trim();
    const terms = [key, ...(SYNONYMS[key] || [])];
    const hit = terms.find((t) => t && text.includes(t));
    if (hit) {
      hits++;
      matched.push(interest);
    }
  }
  return Math.min(100, hits * 35);
}

async function fetchTextVia(fetchImpl, url) {
  const res = await fetchImpl(url, { headers: { accept: 'text/html,application/xml,application/rss+xml,*/*' }, signal: AbortSignal.timeout(8000) });
  if (typeof res === 'string') return res; // plain-text fetcher
  const ct = res.headers?.get ? res.headers.get('content-type') || '' : '';
  const text = await res.text();
  if (!res.ok && !looksLikeFeed(text, ct)) throw new Error(`HTTP ${res.status} for ${url}`);
  return String(text).slice(0, 4000);
}

function candidatesToday(db, timeZoneDate) {
  return db.prepare('SELECT COUNT(*) AS n FROM intel_source_candidates WHERE created_at >= ?').get(timeZoneDate).n;
}

function sourceExistsForDomain(db, domain) {
  return db.prepare('SELECT id FROM intel_sources WHERE url LIKE ? LIMIT 1').get(`%${domain}%`);
}

/**
 * Record a discovered source. Async (DNS + RSS probe) but designed to be fired-and-forgotten
 * with .catch(); caller must not block the main flow on it.
 */
export async function recordDiscoveredSource(db, { url, title = '', description = '', via = '' } = {}, {
  config = {}, fetchText = null, resolver = null, now = new Date(), todayStartIso = null,
} = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const skip = (reason, extra = {}) => ({ discovered: false, skipped: true, reason, ...extra });
  if (!cfg.discoveryEnabled) return skip('discoveryEnabled=false');
  const rawUrl = String(url || '');
  const domain = extractDomain(rawUrl);
  if (!domain) return skip('unparseable-url');
  if (KNOWN_NOISE_DOMAINS.has(domain)) return skip(`known-noise domain ${domain} (handled by built-in adapters)`);
  if (sourceExistsForDomain(db, domain)) return skip(`domain ${domain} already a configured source`);
  const existing = db.prepare('SELECT id, status FROM intel_source_candidates WHERE domain = ?').get(domain);
  if (existing) return skip(`domain ${domain} already a candidate (status=${existing.status})`, { candidate_id: existing.id });

  if (candidatesToday(db, todayStartIso || new Date(now.getTime() - 86400000).toISOString()) >= cfg.maxNewSourcesPerDay) {
    return skip(`daily quota reached (maxNewSourcesPerDay=${cfg.maxNewSourcesPerDay})`);
  }

  const safety = await checkUrlSafety(rawUrl, { resolver });
  const relevance = relevanceToProfile(db, { title, description });
  const t = nowIso();
  let rss = { found: false, url: '' };
  if (safety.ok && typeof fetchText === 'function') {
    try {
      rss = await probeRss(new URL(rawUrl).origin, { fetchText: (u) => fetchTextVia(fetchImplOf(fetchText), u) });
    } catch {
      rss = { found: false, url: '' };
    }
  }

  const autoApprove = safety.ok && cfg.autoApproveSources && rss.found && relevance >= 35;
  const rowStatus = safety.ok ? (autoApprove ? 'candidate' : 'candidate') : 'rejected'; // approval flips via approveCandidate
  const res = db
    .prepare(
      `INSERT INTO intel_source_candidates (url, domain, discovered_via, rss_detected, relevance_score, status, safety_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(domain) DO NOTHING`
    )
    .run(rawUrl, domain, String(via || ''), rss.found ? rss.url : '', relevance, rowStatus, JSON.stringify(safety), t, t);
  if (Number(res.changes) === 0) return skip(`domain ${domain} raced into candidates`);
  const id = Number(res.lastInsertRowid);
  const finalStatus = autoApprove ? (approveCandidate(db, id, { now: now.toISOString() }).status || 'approved') : rowStatus;
  return {
    discovered: true,
    skipped: false,
    candidate_id: id,
    domain,
    status: finalStatus,
    rss_detected: rss.found ? rss.url : '',
    relevance_score: relevance,
    safety,
  };
}

function fetchImplOf(fetchText) {
  // fetchText is a (url, init) => Promise<Response> fetch-like; probeRss expects text fetchers.
  return fetchText;
}

/**
 * Fire-and-forget wrapper for hooks in research/web-search flows: never blocks, never throws,
 * hard time budget so a slow site cannot stall the pipeline.
 */
export function maybeDiscover(db, info, opts = {}) {
  if (!opts?.config?.discoveryEnabled) return;
  const guard = new Promise((resolve) => {
    const t = setTimeout(() => resolve({ discovered: false, skipped: true, reason: 'timeout-guard' }), 15000);
    if (typeof t?.unref === 'function') t.unref();
  });
  void Promise.race([recordDiscoveredSource(db, info, opts), guard]).catch(() => {});
}

function isoOf(v) {
  if (v instanceof Date) return v.toISOString();
  return v || nowIso();
}

/** Approve a candidate: status -> approved and a real intel_sources row is created (normal scheduling). */
export function approveCandidate(db, id, { now } = {}) {
  const c = db.prepare('SELECT * FROM intel_source_candidates WHERE id = ?').get(Number(id));
  if (!c) return { ok: false, error: { code: 'NOT_FOUND', message: `no candidate ${id}` } };
  if (c.status === 'approved') return { ok: true, candidate_id: c.id, already: true, source_id: sourceIdFor(db, c) };
  if (c.status === 'rejected') return { ok: false, error: { code: 'REJECTED_CANDIDATE', message: 'candidate was rejected; cannot approve' } };
  const t = isoOf(now);
  const feedUrl = c.rss_detected || c.url;
  const res = db
    .prepare('INSERT OR IGNORE INTO intel_sources (source_type, name, url, created_at) VALUES (?, ?, ?, ?)')
    .run('rss', c.domain, feedUrl, t);
  const sourceId = Number(res.lastInsertRowid) || sourceIdFor(db, c);
  db.prepare("UPDATE intel_source_candidates SET status = 'approved', updated_at = ? WHERE id = ?").run(t, c.id);
  return { ok: true, candidate_id: c.id, source_id: sourceId, feed_url: feedUrl, inserted_source: Number(res.changes) > 0 };
}

function sourceIdFor(db, candidate) {
  return db.prepare('SELECT id FROM intel_sources WHERE url = ?').get(candidate.rss_detected || candidate.url)?.id ?? null;
}

/** Reject a candidate. An approved candidate is refused (it is already a live source). */
export function rejectCandidate(db, id, { now } = {}) {
  const c = db.prepare('SELECT * FROM intel_source_candidates WHERE id = ?').get(Number(id));
  if (!c) return { ok: false, error: { code: 'NOT_FOUND', message: `no candidate ${id}` } };
  if (c.status === 'approved') return { ok: false, error: { code: 'ALREADY_APPROVED', message: 'candidate already approved and scheduled; disable the source instead' } };
  db.prepare("UPDATE intel_source_candidates SET status = 'rejected', updated_at = ? WHERE id = ?").run(isoOf(now), c.id);
  return { ok: true, candidate_id: c.id, status: 'rejected' };
}

export function listCandidates(db, { status } = {}) {
  const rows = status
    ? db.prepare('SELECT * FROM intel_source_candidates WHERE status = ? ORDER BY id DESC').all(String(status))
    : db.prepare('SELECT * FROM intel_source_candidates ORDER BY id DESC').all();
  return rows.map((r) => {
    let safety = {};
    try { safety = JSON.parse(r.safety_json || '{}'); } catch {}
    return { ...r, safety, rss_detected: r.rss_detected || null, approved: r.status === 'approved' };
  });
}
