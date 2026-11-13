/** arXiv adapter: export.arxiv.org Atom API for recent AI/Agent/Memory papers.
 *  V2.0: the version suffix (vN) of the entry id is parsed and stored — the same
 *  canonical paper in a new version gets its own dedup_key (`<canonical>#vN`) and
 *  therefore its own document row; v1/v2 never dedup against each other.
 */

const API = 'https://export.arxiv.org/api/query';

import { stripHtml, dedupKeyFor } from '../normalize.js';

/** Split an arXiv id/URL into { canonical, version, canonicalUrl }. */
export function arxivIdParts(idRaw) {
  const s = String(idRaw || '').trim();
  const m = /^(.*?)(v(\d+))?$/.exec(new URL(s, 'https://arxiv.org').pathname.replace(/^\/(abs|pdf)\//, '').split('?')[0]);
  const base = m?.[1] || s;
  const version = m?.[3] ? Number(m[3]) : null;
  return {
    canonical: base,
    version,
    canonicalUrl: `https://arxiv.org/abs/${base}`,
  };
}

/**
 * dedup_key for one arXiv entry: sha256(canonical URL) + '#vN' (v1 when the feed
 * omits a version). Non-arXiv documents never use this helper.
 */
export function arxivDedupKey(idRaw) {
  const { canonicalUrl, version } = arxivIdParts(idRaw);
  return `${dedupKeyFor(canonicalUrl)}#v${version || 1}`;
}

/** Parse an arXiv Atom response into items. */
export function parseArxiv(xml) {
  const s = String(xml || '');
  const out = [];
  for (const m of s.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)) {
    const block = m[0];
    const get = (tag) => {
      const r = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
      return r ? r[1].trim() : '';
    };
    const idRaw = get('id') || '';
    const title = stripHtml(get('title'));
    const summary = stripHtml(get('summary')).slice(0, 2000);
    const published = get('published') || null;
    const updated = get('updated') || null;
    const cats = [...block.matchAll(/<category[^>]*\bterm=["']([^"']+)["']/gi)].map((c) => c[1]);
    const authors = [...block.matchAll(/<name>([\s\S]*?)<\/name>/gi)].map((a) => a[1].trim()).slice(0, 5);
    if (!idRaw) continue;
    const parts = arxivIdParts(idRaw);
    out.push({
      title,
      url: idRaw,
      summary,
      publishedAt: published,
      dedup_key: arxivDedupKey(idRaw),
      arxiv_version: parts.version || 1,
      meta: {
        categories: cats,
        authors,
        arxiv_canonical: parts.canonical,
        arxiv_canonical_url: parts.canonicalUrl,
        arxiv_updated: updated || null,
      },
    });
  }
  return out;
}

/**
 * Query recent submissions for AI/Agent/Memory topics.
 * opts: { query, maxResults, sortBy }
 */
export async function fetchArxiv(fetcher, { query = 'cat:cs.AI OR cat:cs.CL OR all:agent OR all:memory', maxResults = 20, sortBy = 'submittedDate' } = {}) {
  const url =
    `${API}?search_query=${encodeURIComponent(query)}` +
    `&start=0&max_results=${Math.min(maxResults, 100)}&sortBy=${sortBy}&sortOrder=descending`;
  const xml = await fetcher.getText(url, { headers: { accept: 'application/atom+xml' } });
  return parseArxiv(xml);
}
