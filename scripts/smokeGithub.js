/** Real-network smoke: GitHub search adapter against the live API + temp-db ingest. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb, closeDb, insertDocument, getStats } from '../lib/db.js';
import { searchRecentRepos } from '../lib/adapters/github.js';

const ghFetcher = {
  getJson: async (url) => {
    const res = await globalThis.fetch(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-intelligence-hub' } });
    if (!res.ok) throw new Error(`github ${res.status}: ${url}`);
    return await res.json();
  },
};

const repos = await searchRecentRepos(ghFetcher, {
  query: 'topic:llm-agent OR topic:ai-agents',
  days: 7,
  perPage: 20,
});
console.log(`[smoke] searchRecentRepos OK: ${repos.length} repos (deduped across OR sub-queries)`);
for (const r of repos.slice(0, 5)) console.log(`[smoke]   ${r.title} -> ${r.url}`);

const dir = mkdtempSync(path.join(tmpdir(), 'intelhub-ghsmoke-'));
const db = openDb(path.join(dir, 'smoke.db'));
for (const r of repos) {
  insertDocument(db, { url: r.url, title: r.title, summary: r.summary, source_type: 'github', lang: 'en', topic: 'ai-agents', published_at: r.publishedAt });
}
const stats = getStats(db);
console.log(`[smoke] temp-db ingest OK: documents=${stats.documents}`);
if (repos.length === 0 || stats.documents !== repos.length) {
  console.error('[smoke] FAILED'); closeDb(db); process.exit(1);
}
console.log('[smoke] PASSED');
closeDb(db);
