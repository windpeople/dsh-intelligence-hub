/** Disk/retention: delete expired document versions conservatively (never bookmarked docs). */

import { statSync } from 'node:fs';

/**
 * Delete documents whose fetched_at is older than retentionDays, unless bookmark=1.
 * Returns { deleted, candidates }.
 */
export function purgeExpiredDocuments(db, { retentionDays = 90, now = new Date() } = {}) {
  if (!(Number(retentionDays) > 0)) return { deleted: 0, candidates: 0, skipped: 'retention disabled' };
  const cutoff = new Date(now.getTime() - Number(retentionDays) * 86400 * 1000).toISOString();
  const candidates = db
    .prepare('SELECT COUNT(*) AS n FROM intel_documents WHERE fetched_at < ? AND bookmark = 0')
    .get(cutoff).n;
  const res = db
    .prepare('DELETE FROM intel_documents WHERE fetched_at < ? AND bookmark = 0')
    .run(cutoff);
  return { deleted: Number(res.changes), candidates, cutoff };
}

/**
 * Enforce maxDiskMb over the SQLite file: delete oldest non-bookmark documents
 * until the file is under the budget (checked in chunks of 50 rows).
 */
export function enforceDiskBudget(db, { dbPath, maxDiskMb = 512 } = {}) {
  const budget = Number(maxDiskMb) > 0 ? Number(maxDiskMb) * 1024 * 1024 : 0;
  if (!budget || !dbPath) return { deleted: 0, sizeBytes: null, skipped: 'no budget or path' };
  let size = 0;
  try {
    size = statSync(dbPath).size;
  } catch {
    return { deleted: 0, sizeBytes: null, skipped: 'stat failed' };
  }
  let deleted = 0;
  let guard = 0;
  while (size > budget && guard++ < 200) {
    const ids = db
      .prepare('SELECT id FROM intel_documents WHERE bookmark = 0 ORDER BY fetched_at ASC LIMIT 50')
      .all()
      .map((r) => r.id);
    if (ids.length === 0) break;
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM intel_documents WHERE id IN (${placeholders})`).run(...ids);
    deleted += ids.length;
    try {
      size = statSync(dbPath).size;
    } catch {
      break;
    }
  }
  return { deleted, sizeBytes: size };
}

export function runRetention(db, { retentionDays, maxDiskMb, dbPath, now = new Date() } = {}) {
  const expired = purgeExpiredDocuments(db, { retentionDays, now });
  const disk = enforceDiskBudget(db, { dbPath, maxDiskMb });
  return { expired, disk };
}
