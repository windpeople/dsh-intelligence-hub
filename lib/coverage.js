/** Phase 5 Coverage Auditor (COVERAGE_AUDIT job kind): daily honest statistics + blind-spot detection.
 *  Key principle declared in every report: 未采集到 ≠ 不存在 (not collected ≠ does not exist).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { localDayBounds, localDateString } from './scheduler.js';
import { dedupKeyFor } from './normalize.js';
import { loadProfile } from './profile.js';

export const STALE_HOURS = 48;
export const BLIND_STREAK = 3;

const nowIso = () => new Date().toISOString();

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round(((s[mid - 1] + s[mid]) / 2) * 10) / 10;
}

/**
 * Compute the coverage statistics for one local day. Pure read + optional web sampling.
 * Returns the stats object (also persisted into intel_coverage_reports).
 */
export async function computeCoverageStats(db, {
  dateStr,
  timeZone = 'Asia/Shanghai',
  webSearch = null,
  now = new Date(),
  sampleTopInterest = true,
} = {}) {
  const date = dateStr || localDateString(now, timeZone);
  const { start, end } = localDayBounds(date, timeZone);

  // ---- sources ----
  const sources = db.prepare('SELECT * FROM intel_sources ORDER BY id').all();
  const enabled = sources.filter((s) => !!s.enabled);
  const failed = enabled.filter((s) => s.last_error);
  const authRequired = enabled.filter((s) => /AUTH|401|403|unauthor|forbidden/i.test(String(s.last_error || '')));
  const staleCutoff = new Date(now.getTime() - STALE_HOURS * 3600000).toISOString();
  const stale = enabled.filter((s) => !s.last_ok_at || s.last_ok_at < staleCutoff);
  const consecutiveFailures = enabled
    .filter((s) => (s.fail_streak || 0) >= BLIND_STREAK)
    .map((s) => ({ id: s.id, name: s.name, url: s.url, fail_streak: s.fail_streak || 0, last_error: s.last_error || '' }));

  // ---- collection funnel of the day ----
  const jobRow = db
    .prepare('SELECT COALESCE(SUM(fetched),0) AS f, COALESCE(SUM(inserted),0) AS i, COUNT(*) AS total, COALESCE(SUM(status = \'done\'),0) AS ok FROM intel_collection_jobs WHERE started_at >= ? AND started_at < ?')
    .get(start, end);
  const docs = db
    .prepare('SELECT id, title, topic, lang, published_at, fetched_at, url FROM intel_documents WHERE fetched_at >= ? AND fetched_at < ?')
    .all(start, end);
  const scored = db
    .prepare(`SELECT s.document_id, s.total, s.decision FROM intel_scores s JOIN intel_documents d ON d.id = s.document_id
              WHERE d.fetched_at >= ? AND d.fetched_at < ?`)
    .all(start, end);
  const recommendations = scored.filter((r) => ['RECOMMEND', 'RESEARCH'].includes(r.decision)).length;
  const digestThresholdRow = scored.length ? Math.max(...scored.map((r) => r.total)) : 0;
  const highScore = scored.filter((r) => r.total >= 70).length;
  const eventCount = db
    .prepare('SELECT COUNT(*) AS n FROM intel_events WHERE first_seen_at >= ? AND first_seen_at < ?')
    .get(start, end).n;
  const topicDist = {};
  const langDist = {};
  for (const d of docs) {
    topicDist[d.topic || 'general'] = (topicDist[d.topic || 'general'] || 0) + 1;
    langDist[d.lang || 'und'] = (langDist[d.lang || 'und'] || 0) + 1;
  }
  const freshness = median(
    docs
      .map((d) => {
        const t = Date.parse(d.published_at || d.fetched_at);
        return Number.isFinite(t) ? Math.round(((now.getTime() - t) / 3600000) * 10) / 10 : null;
      })
      .filter((v) => v !== null)
  );
  const successRate = jobRow.total ? Math.round((jobRow.ok / jobRow.total) * 1000) / 10 : null;

  const stats = {
    date,
    generated_at: nowIso(),
    sources: {
      total: sources.length,
      enabled: enabled.length,
      available: enabled.filter((s) => !s.last_error).length,
      failed: failed.length,
      auth_required: authRequired.map((s) => ({ id: s.id, name: s.name, last_error: String(s.last_error).slice(0, 160) })),
      stale: stale.map((s) => ({
        id: s.id, name: s.name, url: s.url,
        last_ok_at: s.last_ok_at, reason: !s.last_ok_at ? '从未成功采集' : `超过 ${STALE_HOURS}h 无新文档`,
      })),
      consecutive_failures: consecutiveFailures,
    },
    funnel: {
      raw_candidates: jobRow.f,
      deduped: Math.max(0, jobRow.f - jobRow.i),
      inserted: jobRow.i,
      event_clusters: eventCount,
      scored: scored.length,
      recommendations,
      high_score_candidates: highScore,
      top_score_today: digestThresholdRow,
      collection_success_rate_pct: successRate,
    },
    coverage: {
      topic_distribution: topicDist,
      lang_distribution: langDist,
      zh_en_ratio: `${langDist.zh || 0}:${langDist.en || 0}`,
      freshness_median_hours: freshness,
      documents_total: docs.length,
    },
    blind_spots: [],
  };

  // ---- sampling check (webSearch seam; injectable; skipped + recorded when unavailable) ----
  if (sampleTopInterest && typeof webSearch === 'function') {
    const profile = loadProfile(db);
    const interest = (profile?.long_term_interests || [])[0];
    if (interest) {
      try {
        const res = await webSearch({ query: String(interest), maxResults: 5 }, undefined);
        const found = new Set(
          db.prepare('SELECT dedup_key FROM intel_documents').all().map((r) => r.dedup_key)
        );
        const missed = [];
        for (const s of res?.sources || []) {
          const key = dedupKeyFor(s.url);
          if (!found.has(key)) missed.push({ url: s.url, title: s.title || s.url });
        }
        stats.blind_spots.push({
          kind: 'sample_missed',
          interest,
          checked: (res?.sources || []).length,
          missed: missed.slice(0, 10),
          note: '抽样检查：web 搜索返回但本地库未收录的 URL（不代表这些内容必须收录）',
        });
      } catch (e) {
        stats.blind_spots.push({ kind: 'sample_error', error: String(e.message || e).slice(0, 200) });
      }
    } else {
      stats.blind_spots.push({ kind: 'sample_skipped', reason: '画像无长期兴趣词，跳过抽样' });
    }
  } else {
    stats.blind_spots.push({ kind: 'sample_skipped', reason: 'webSearch seam 不可用，跳过抽样漏检检查' });
  }

  if (consecutiveFailures.length) {
    stats.blind_spots.push({
      kind: 'failing_sources',
      sources: consecutiveFailures,
      note: `连续 ${BLIND_STREAK} 次失败来源（原因取自 last_error），已列入盲区观察`,
    });
  }
  if (stale.length) {
    stats.blind_spots.push({
      kind: 'stale_sources',
      sources: stats.sources.stale,
      note: `启用但超过 ${STALE_HOURS}h 无新文档的来源`,
    });
  }
  return stats;
}

export function buildCoverageMarkdown(stats) {
  const f = stats.funnel;
  const s = stats.sources;
  const lines = [];
  lines.push(`# 覆盖审计 · ${stats.date}`);
  lines.push('');
  lines.push(`- 生成时间：${stats.generated_at}`);
  lines.push('');
  lines.push('## 来源状态');
  lines.push('');
  lines.push(`- 总数 ${s.total} ｜ 启用 ${s.enabled} ｜ 可用 ${s.available} ｜ 失败 ${s.failed} ｜ AUTH_REQUIRED ${s.auth_required.length}`);
  lines.push('');
  lines.push('## 采集漏斗（当日）');
  lines.push('');
  lines.push(`- 原始候选 ${f.raw_candidates} → 去重 ${f.deduped} → 入库 ${f.inserted}；事件簇 ${f.event_clusters}；评分 ${f.scored}；推荐 ${f.recommendations}；高分候选(≥70) ${f.high_score_candidates}；当日最高分 ${f.top_score_today}`);
  lines.push(`- 采集成功率：${f.collection_success_rate_pct === null ? '无采集记录' : `${f.collection_success_rate_pct}%`}`);
  lines.push(`- 内容新鲜度中位数：${stats.coverage.freshness_median_hours === null ? '无数据' : `${stats.coverage.freshness_median_hours} 小时`}`);
  lines.push(`- 主题覆盖分布：${JSON.stringify(stats.coverage.topic_distribution)}`);
  lines.push(`- 中英文占比（zh:en）：${stats.coverage.zh_en_ratio}`);
  lines.push('');
  lines.push('## 盲区');
  lines.push('');
  if (stats.blind_spots.length === 0) lines.push('未检出盲区。');
  for (const b of stats.blind_spots) {
    if (b.kind === 'sample_missed') {
      lines.push(`- 抽样漏检（兴趣词「${b.interest}」，检查 ${b.checked} 条）：${b.missed.length} 条未被库收录`);
      for (const m of b.missed) lines.push(`  - [${m.title}](${m.url})`);
    } else if (b.kind === 'failing_sources') {
      for (const src of b.sources) lines.push(`- 连续失败来源 ${src.name}（连续 ${src.fail_streak} 次）：${String(src.last_error).slice(0, 120) || '未知原因'}`);
    } else if (b.kind === 'stale_sources') {
      for (const src of b.sources) lines.push(`- stale 来源 ${src.name}：${src.reason}（last_ok_at=${src.last_ok_at || 'null'}）`);
    } else if (b.kind === 'sample_skipped') {
      lines.push(`- 抽样检查已跳过：${b.reason}`);
    } else if (b.kind === 'sample_error') {
      lines.push(`- 抽样检查失败（不致命）：${b.error}`);
    }
  }
  lines.push('');
  lines.push('> 声明：**未采集到 ≠ 不存在**。本报告仅描述本库采集管道的覆盖情况，不对外部世界的存在性做任何判断。');
  lines.push('');
  return lines.join('\n');
}

/**
 * Run one COVERAGE_AUDIT. Idempotent per local date (unique intel_coverage_reports.date):
 * an existing row is returned with created:false.
 */
export async function runCoverageAudit(db, {
  dateStr,
  timeZone = 'Asia/Shanghai',
  reportsDir = null,
  webSearch = null,
  now = new Date(),
} = {}) {
  const existing = db.prepare('SELECT * FROM intel_coverage_reports WHERE date = ?').get(String(dateStr));
  if (existing) {
    return { created: false, date: dateStr, stats: JSON.parse(existing.stats_json || '{}'), markdown: existing.markdown, file_path: null };
  }
  const stats = await computeCoverageStats(db, { dateStr, timeZone, webSearch, now });
  const markdown = buildCoverageMarkdown(stats);
  db.prepare('INSERT INTO intel_coverage_reports (date, stats_json, markdown, created_at) VALUES (?, ?, ?, ?)')
    .run(String(dateStr), JSON.stringify(stats), markdown, nowIso());
  let filePath = null;
  if (reportsDir) {
    const dir = path.join(reportsDir, 'coverage');
    mkdirSync(dir, { recursive: true });
    filePath = path.join(dir, `${dateStr}.md`);
    writeFileSync(filePath, markdown, 'utf8');
  }
  return { created: true, date: dateStr, stats, markdown, file_path: filePath };
}

/** Latest coverage summary for intel_get_status. */
export function lastCoverageSummary(db) {
  const row = db.prepare('SELECT date, stats_json, created_at FROM intel_coverage_reports ORDER BY date DESC, id DESC LIMIT 1').get();
  if (!row) return null;
  let stats = {};
  try { stats = JSON.parse(row.stats_json || '{}'); } catch {}
  return {
    date: row.date,
    created_at: row.created_at,
    sources: stats.sources ? { total: stats.sources.total, enabled: stats.sources.enabled, failed: stats.sources.failed, stale: stats.sources.stale?.length || 0, auth_required: stats.sources.auth_required?.length || 0 } : null,
    funnel: stats.funnel || null,
    blind_spot_count: (stats.blind_spots || []).length,
  };
}
