/** Phase 5 Feedback Learner: durable user feedback with conservative, traceable effects.
 *  Effects (ranking_version 'v1', every adjustment traceable via intel_feedback rows):
 *   - irrelevant / already_known -> document meta feedback_exclusion marker; excluded from the
 *     digest candidate pool immediately and from the next pipeline/report pass.
 *   - bad_source -> source-level quality_adjust -10 (cumulative floor: effective E >= 30).
 *   - keep / deep_research -> source quality_adjust +5 recovery (capped at the original base);
 *     temporary +1 topic interest boost (suggest queue only; confirm persists, never direct writes).
 *   - pause_topic -> topic-level 7-day digest pause (collection is never deleted).
 */

import { dedupKeyFor } from './normalize.js';

export const FEEDBACK_TYPES = ['deep_research', 'keep', 'already_known', 'irrelevant', 'bad_source', 'pause_topic'];
export const RANKING_VERSION = 'v1';
export const PAUSE_TOPIC_DAYS = 7;
export const SOURCE_PENALTY_STEP = -10;
export const SOURCE_RECOVERY_STEP = 5;
/** floor for the cumulative adjust so effective E never drops below 30 (base is <= 90). */
export const SOURCE_PENALTY_FLOOR = -70;

const nowIso = () => new Date().toISOString();

export function itemKeyFor({ itemId, documentId } = {}) {
  if (itemId) return String(itemId);
  if (documentId !== undefined && documentId !== null && Number.isFinite(Number(documentId))) {
    return `doc:${Number(documentId)}`;
  }
  return null;
}

/**
 * Record one feedback row. Idempotent per (item_id, feedback_type).
 * Returns { ok, id, deduped, item_id, feedback_type } or { ok:false, error }.
 */
export function recordFeedback(db, { itemId, documentId, feedbackType, relatedTopic, comment, now } = {}) {
  const type = String(feedbackType || '').trim();
  if (!FEEDBACK_TYPES.includes(type)) {
    return { ok: false, error: { code: 'INVALID_TYPE', message: `feedback_type must be one of ${FEEDBACK_TYPES.join('|')}` } };
  }
  const itemIdStr = itemKeyFor({ itemId, documentId });
  if (!itemIdStr) {
    return { ok: false, error: { code: 'MISSING_ITEM', message: 'item_id or document_id is required' } };
  }
  const t = now || nowIso();
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO intel_feedback (document_id, feedback_type, payload, created_at, item_id, related_topic, ranking_version)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      documentId !== undefined && documentId !== null ? Number(documentId) : null,
      type,
      JSON.stringify({ comment: comment || '' }),
      t,
      itemIdStr,
      relatedTopic ? String(relatedTopic) : null,
      RANKING_VERSION
    );
  const inserted = Number(res.changes) > 0;
  return {
    ok: true,
    id: inserted ? Number(res.lastInsertRowid) : null,
    deduped: !inserted,
    item_id: itemIdStr,
    feedback_type: type,
    related_topic: relatedTopic || null,
    ranking_version: RANKING_VERSION,
  };
}

function docIdFromItem(itemIdStr) {
  const m = /^doc:(\d+)$/.exec(String(itemIdStr || ''));
  return m ? Number(m[1]) : null;
}

function sourceIdForDoc(db, docId) {
  if (!docId) return null;
  const row = db.prepare('SELECT source_id FROM intel_documents WHERE id = ?').get(docId);
  return row?.source_id ?? null;
}

/**
 * Apply the conservative effects of one feedback item.
 * Returns { applied: [string], source_id, quality_adjust }.
 */
export function applyFeedbackEffects(db, { itemId, documentId, feedbackType, relatedTopic, now } = {}) {
  const type = String(feedbackType || '');
  const itemIdStr = itemKeyFor({ itemId, documentId });
  const docId = documentId ?? docIdFromItem(itemIdStr);
  const applied = [];
  let sourceId = null;
  let qualityAdjust = null;

  if (type === 'irrelevant' || type === 'already_known') {
    if (docId) {
      const row = db.prepare('SELECT meta FROM intel_documents WHERE id = ?').get(docId);
      if (row) {
        let meta = {};
        try { meta = JSON.parse(row.meta || '{}'); } catch {}
        meta.feedback_exclusion = { type, at: now || nowIso(), ranking_version: RANKING_VERSION };
        db.prepare('UPDATE intel_documents SET meta = ? WHERE id = ?').run(JSON.stringify(meta), docId);
        applied.push(`doc:${docId} marked feedback_exclusion (${type}); excluded from digest candidate pool`);
      }
    }
  } else if (type === 'bad_source') {
    sourceId = sourceIdForDoc(db, docId);
    if (sourceId) {
      db.prepare('UPDATE intel_sources SET quality_adjust = MAX(?, quality_adjust + ?) WHERE id = ?')
        .run(SOURCE_PENALTY_FLOOR, SOURCE_PENALTY_STEP, sourceId);
      qualityAdjust = db.prepare('SELECT quality_adjust FROM intel_sources WHERE id = ?').get(sourceId)?.quality_adjust ?? 0;
      applied.push(`source #${sourceId} quality_adjust ${SOURCE_PENALTY_STEP} (now ${qualityAdjust}, effective E floor 30)`);
    }
  } else if (type === 'keep' || type === 'deep_research') {
    sourceId = sourceIdForDoc(db, docId);
    if (sourceId) {
      db.prepare('UPDATE intel_sources SET quality_adjust = MIN(0, quality_adjust + ?) WHERE id = ?')
        .run(SOURCE_RECOVERY_STEP, sourceId);
      qualityAdjust = db.prepare('SELECT quality_adjust FROM intel_sources WHERE id = ?').get(sourceId)?.quality_adjust ?? 0;
      applied.push(`source #${sourceId} quality_adjust +${SOURCE_RECOVERY_STEP} recovery (now ${qualityAdjust})`);
    }
    applied.push(`topic "${relatedTopic || 'unknown'}" temporary interest boost +1 (suggest queue; confirm required to persist)`);
  } else if (type === 'pause_topic') {
    applied.push(`topic "${relatedTopic || 'unknown'}" paused for ${PAUSE_TOPIC_DAYS} days (digest skip; collection untouched)`);
  }

  return { applied, source_id: sourceId, quality_adjust: qualityAdjust };
}

/** Convenience: record + apply in one call. */
export function submitFeedback(db, args = {}) {
  const rec = recordFeedback(db, args);
  if (!rec.ok) return rec;
  const effects = rec.deduped
    ? { applied: ['deduped: no re-application'], source_id: null, quality_adjust: null }
    : applyFeedbackEffects(db, args);
  return { ...rec, ...effects };
}

/**
 * V2.0 Phase 2: batch feedback + bookmark in ONE transaction.
 * items: [{ document_id, feedback_type, related_topic?, comment? }].
 * bookmark: when provided (true/false), every valid item with a document_id also
 * gets `UPDATE intel_documents SET bookmark = ?` applied.
 *
 * Semantics: the whole batch runs inside BEGIN/COMMIT. Per-item validation errors
 * (invalid type, missing id, unknown document) are captured as per-item results
 * without aborting the batch; a real DB error thrown by a valid item rolls back
 * the entire batch and re-throws. Returns { ok, results: [...], applied, bookmarks }.
 */
export function batchAct(db, { items = [], bookmark, now } = {}) {
  const t = now || nowIso();
  db.exec('BEGIN');
  const results = [];
  let bookmarks = 0;
  try {
    for (const [i, raw] of (Array.isArray(items) ? items : []).entries()) {
      const item = raw || {};
      const hasFeedbackType = item.feedback_type !== undefined && item.feedback_type !== null && item.feedback_type !== '';
      // Validation errors come back as { ok:false } from submitFeedback (no throw);
      // anything thrown here is a real DB error and aborts the whole batch (rollback below).
      // Items without a feedback_type are bookmark-only: no feedback row is recorded.
      const rec = hasFeedbackType
        ? submitFeedback(db, {
            documentId: item.document_id,
            itemId: item.item_id,
            feedbackType: item.feedback_type,
            relatedTopic: item.related_topic,
            comment: item.comment,
            now: t,
          })
        : { ok: true, deduped: false, skipped: true, item_id: itemKeyFor({ itemId: item.item_id, documentId: item.document_id }), feedback_type: null };
      if (rec.ok && bookmark !== undefined && bookmark !== null && Number.isFinite(Number(item.document_id))) {
        const exists = db.prepare('SELECT id FROM intel_documents WHERE id = ?').get(Number(item.document_id));
        if (exists) {
          db.prepare('UPDATE intel_documents SET bookmark = ? WHERE id = ?').run(bookmark ? 1 : 0, Number(item.document_id));
          bookmarks++;
        }
      }
      results.push({ index: i, ...rec });
    }
    db.exec('COMMIT');
    return { ok: true, results, bookmarks, total: results.length, applied: results.filter((r) => r.ok && !r.deduped).length };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* not in transaction */ }
    throw err;
  }
}

// ---------------- Read helpers used by the ranking/report layers ----------------

/** Document ids excluded from the digest candidate pool by feedback. */
export function feedbackExcludedDocIds(db) {
  const rows = db
    .prepare("SELECT item_id FROM intel_feedback WHERE feedback_type IN ('irrelevant','already_known') AND item_id LIKE 'doc:%'")
    .all();
  return new Set(rows.map((r) => docIdFromItem(r.item_id)).filter((v) => v !== null));
}

function docTopic(db, docId) {
  return db.prepare('SELECT topic, title, url FROM intel_documents WHERE id = ?').get(docId);
}

/** Topic paused within the last PAUSE_TOPIC_DAYS days? Collection is never deleted — digest only. */
export function isTopicPaused(db, topic, { now = new Date() } = {}) {
  const t = String(topic || '').trim();
  if (!t) return false;
  const cutoff = new Date(now.getTime() - PAUSE_TOPIC_DAYS * 86400000).toISOString();
  const row = db
    .prepare(
      "SELECT 1 AS x FROM intel_feedback WHERE feedback_type = 'pause_topic' AND related_topic = ? AND created_at >= ? LIMIT 1"
    )
    .get(t, cutoff);
  return !!row;
}

/** Temporary interest boosts (keep/deep_research feedback) for the profile suggest queue. */
export function pendingTopicBoosts(db, { sinceDays = 30, now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - sinceDays * 86400000).toISOString();
  const rows = db
    .prepare(
      `SELECT related_topic, COUNT(*) AS n FROM intel_feedback
       WHERE feedback_type IN ('keep','deep_research') AND related_topic IS NOT NULL AND created_at >= ?
       GROUP BY related_topic ORDER BY n DESC`
    )
    .all(cutoff);
  return rows.map((r) => ({ topic: r.related_topic, boost: r.n }));
}

/** Source-level quality adjust (<= 0). */
export function sourceQualityAdjust(db, sourceId) {
  if (!sourceId) return 0;
  return db.prepare('SELECT quality_adjust FROM intel_sources WHERE id = ?').get(Number(sourceId))?.quality_adjust || 0;
}

/** Which configured source (if any) does this URL belong to? */
export function sourceIdForUrl(db, url) {
  if (!url) return null;
  const row = db.prepare('SELECT id FROM intel_sources WHERE ? LIKE "%" || url || "%" LIMIT 1').get(String(url));
  return row?.id ?? null;
}

/** Feedback trace for auditability. */
export function feedbackTrace(db, { itemId, documentId, limit = 20 } = {}) {
  const itemIdStr = itemKeyFor({ itemId, documentId });
  if (!itemIdStr) return [];
  return db
    .prepare('SELECT id, item_id, document_id, feedback_type, related_topic, ranking_version, created_at, payload FROM intel_feedback WHERE item_id = ? ORDER BY id DESC LIMIT ?')
    .all(itemIdStr, Math.max(1, Math.min(Number(limit) || 20, 100)))
    .map((r) => {
      let payload = {};
      try { payload = JSON.parse(r.payload || '{}'); } catch {}
      return { ...r, payload, comment: payload.comment || '' };
    });
}
