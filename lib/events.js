/** Event clusterer: rule-only incremental clustering of documents into events. No LLM. */

import { randomUUID } from 'node:crypto';
import { normalizedTitle } from './normalize.js';

export const JACCARD_THRESHOLD = 0.55;

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'for', 'and', 'in', 'on', 'to', 'with', 'is', 'are', 'at', 'by', 'from',
  'new', 'news', 'update', 'updates', 'released', 'release', 'launch', 'announces', 'announced', 'introducing',
  '发布', '推出', '更新', '宣布', '正式',
]);

/** Normalized token list of a title (lowercase, punctuation collapsed, stopwords dropped). */
export function titleTokens(title) {
  const norm = normalizedTitle(title);
  return norm.split(' ').filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** Token Jaccard similarity between two titles. */
export function titleJaccard(a, b) {
  const ta = new Set(titleTokens(a));
  const tb = new Set(titleTokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/**
 * Canonical event key extracted from a document, when one exists:
 * GitHub release (meta.repo + meta.tag), DOI (meta.doi or doi.org url), arXiv id.
 * Documents sharing such a key belong to the same event regardless of title.
 */
export function canonicalEventKey(doc) {
  let meta = doc?.meta || {};
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta); } catch { meta = {}; }
  }
  if (meta.repo && meta.tag) return `gh-release:${meta.repo}@${meta.tag}`;
  const doi = meta.doi || (/doi\.org\/(10\..+)$/i.exec(String(doc?.url || '')) || [])[1];
  if (doi) return `doi:${String(doi).toLowerCase()}`;
  const arxiv = /arxiv\.org\/(?:abs|pdf)\/([a-z0-9.-]+)\.?(pdf)?/i.exec(String(doc?.url || ''));
  if (arxiv) return `arxiv:${arxiv[1].toLowerCase()}`;
  return null;
}

function domainOf(url) {
  try {
    return new URL(String(url || '')).host.toLowerCase();
  } catch {
    return '';
  }
}

/** Source-type authority rank for choosing the event title / primary source. */
export function sourceAuthority(sourceType) {
  const rank = { arxiv: 4, github: 3, official: 3, rss: 2, unknown: 1 };
  return rank[String(sourceType || 'unknown')] || 1;
}

function docTime(doc) {
  return doc.published_at || doc.fetched_at || '';
}

/**
 * Decide the event title among member docs: earliest (published||fetched) wins;
 * ties broken by source authority then smallest document id. "最早（最权威）".
 */
export function pickEventTitle(docs) {
  const sorted = [...docs].sort((a, b) => {
    const ta = docTime(a);
    const tb = docTime(b);
    if (ta !== tb) return ta < tb ? -1 : 1;
    const sa = sourceAuthority(a.source_type);
    const sb = sourceAuthority(b.source_type);
    if (sa !== sb) return sb - sa;
    return (a.id || 0) - (b.id || 0);
  });
  return sorted[0] || null;
}

const newEventId = () => `evt_${randomUUID().slice(0, 12)}`;

function loadEventDocs(db, eventId) {
  return db
    .prepare(
      `SELECT d.* FROM intel_document_events de JOIN intel_documents d ON d.id = de.document_id
       WHERE de.event_id = ? ORDER BY d.id`
    )
    .all(eventId);
}

/**
 * Incrementally assign one document to an event (creates one when no match).
 * Matching rules (no LLM):
 *  1. Same canonical key (GitHub release / DOI / arXiv id) -> same event.
 *  2. Same canonical domain + title Jaccard >= 0.55 against an existing member.
 * The event title is re-derived from all members after each merge.
 * Returns { eventId, created, matchedBy }.
 */
export function assignDocumentToEvent(db, doc, { now = new Date().toISOString() } = {}) {
  const ckey = canonicalEventKey(doc);
  const domain = domainOf(doc.url);
  const candidates = db
    .prepare('SELECT e.* FROM intel_events e ORDER BY e.first_seen_at DESC LIMIT 200')
    .all();

  let matched = null;
  let matchedBy = '';
  for (const ev of candidates) {
    const evMeta = (() => { try { return JSON.parse(ev.meta || '{}'); } catch { return {}; } })();
    if (ckey && evMeta.canonical_key === ckey) {
      matched = ev;
      matchedBy = 'canonical-key';
      break;
    }
    const members = loadEventDocs(db, ev.event_id);
    const sameDomain = members.some((m) => domain && domainOf(m.url) === domain);
    if (!sameDomain) continue;
    if (members.some((m) => titleJaccard(m.title, doc.title) >= JACCARD_THRESHOLD)) {
      matched = ev;
      matchedBy = 'jaccard';
      break;
    }
  }

  const linkedAt = now;
  if (!matched) {
    const eventId = newEventId();
    db.prepare(
      `INSERT INTO intel_events (event_id, event_title, event_type, first_seen_at, occurred_at, primary_source, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(eventId, String(doc.title || ''), String(doc.source_type === 'arxiv' ? 'paper' : doc.source_type === 'github' ? 'release' : 'news'),
      now, doc.published_at || null, String(doc.source_type || ''), JSON.stringify({ canonical_key: ckey }));
    db.prepare(
      'INSERT OR IGNORE INTO intel_document_events (document_id, event_id, is_primary, linked_at) VALUES (?, ?, 0, ?)'
    ).run(doc.id, eventId, linkedAt);
    rederiveEvent(db, eventId);
    return { eventId, created: true, matchedBy: 'new' };
  }

  db.prepare(
    'INSERT OR IGNORE INTO intel_document_events (document_id, event_id, is_primary, linked_at) VALUES (?, ?, 0, ?)'
  ).run(doc.id, matched.event_id, linkedAt);
  // Backfill canonical key on the event if this doc carries one the event lacked.
  if (ckey) {
    const evMeta = (() => { try { return JSON.parse(matched.meta || '{}'); } catch { return {}; } })();
    if (!evMeta.canonical_key) {
      evMeta.canonical_key = ckey;
      db.prepare('UPDATE intel_events SET meta = ? WHERE event_id = ?').run(JSON.stringify(evMeta), matched.event_id);
    }
  }
  rederiveEvent(db, matched.event_id);
  return { eventId: matched.event_id, created: false, matchedBy };
}

/** Recompute event_title / occurred_at / primary_source from all member docs. */
export function rederiveEvent(db, eventId) {
  const members = loadEventDocs(db, eventId);
  if (members.length === 0) return;
  const head = pickEventTitle(members);
  db.prepare(
    'UPDATE intel_events SET event_title = ?, occurred_at = ?, primary_source = ? WHERE event_id = ?'
  ).run(String(head.title || ''), head.published_at || null, String(head.source_type || ''), eventId);
}

/** All events linked to at least one document fetched within [start, end). */
export function eventsOnDate(db, start, end) {
  return db
    .prepare(
      `SELECT e.*, COUNT(de.document_id) AS doc_count FROM intel_events e
       JOIN intel_document_events de ON de.event_id = e.event_id
       JOIN intel_documents d ON d.id = de.document_id
       WHERE d.fetched_at >= ? AND d.fetched_at < ?
       GROUP BY e.event_id ORDER BY e.occurred_at DESC`
    )
    .all(start, end);
}

/** Set is_primary for exactly one doc per event (highest total score, tie: authority, tie: id). */
export function electPrimaryDocument(db, eventId, scoresById = new Map()) {
  const members = loadEventDocs(db, eventId);
  if (members.length === 0) return null;
  const sorted = [...members].sort((a, b) => {
    const sa = scoresById.get(a.id) ?? -1;
    const sb = scoresById.get(b.id) ?? -1;
    if (sa !== sb) return sb - sa;
    const ua = sourceAuthority(a.source_type);
    const ub = sourceAuthority(b.source_type);
    if (ua !== ub) return ub - ua;
    return a.id - b.id;
  });
  const primary = sorted[0];
  db.prepare('UPDATE intel_document_events SET is_primary = 0 WHERE event_id = ?').run(eventId);
  db.prepare('UPDATE intel_document_events SET is_primary = 1 WHERE event_id = ? AND document_id = ?').run(eventId, primary.id);
  db.prepare('UPDATE intel_events SET primary_document_id = ? WHERE event_id = ?').run(primary.id, eventId);
  return primary;
}

/**
 * Cluster every document in [start, end) that has no event link yet.
 * Returns { clustered, eventsCreated }.
 */
export function clusterDocuments(db, { start, end } = {}) {
  const docs = db
    .prepare(
      `SELECT d.* FROM intel_documents d
       WHERE d.fetched_at >= ? AND d.fetched_at < ?
         AND NOT EXISTS (SELECT 1 FROM intel_document_events de WHERE de.document_id = d.id)
       ORDER BY d.id`
    )
    .all(start, end);
  let created = 0;
  for (const doc of docs) {
    const r = assignDocumentToEvent(db, doc);
    if (r.created) created++;
  }
  return { clustered: docs.length, eventsCreated: created };
}
