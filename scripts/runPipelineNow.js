/** Manual one-off: run the scoring pipeline against the live DB now (same handler as index.js PIPELINE_RUN). */
import os from 'node:os';
import path from 'node:path';
import { openDb, closeDb } from '../lib/db.js';
import { enqueueJob, runDueJobs, localDateString } from '../lib/scheduler.js';
import { runPipeline } from '../lib/scoring.js';

const dbPath = process.argv[2] || path.join(os.homedir(), '.dsh', 'plugins-data', 'dsh-intelligence-hub', 'intel.db');
const db = openDb(dbPath);
const timeZone = 'Asia/Shanghai';
// Local (reportTimeZone) date — was UTC `.toISOString().slice(0,10)`, which made
// manual runs select a shifted window (documents collected after local midnight
// fell into "yesterday", so "today's" L0 passed=0 while backlog got scored).
const date = localDateString(new Date(), timeZone);
const config = { pipelineEnabled: true, scoreThresholds: undefined, analysisEnabled: false, analysisProvider: '', analysisModel: '' };
const effConfig = { ...config, dbPath, reportTimeZone: timeZone };
const eff = { ...effConfig, scoreThresholds: effConfig.scoreThresholds ?? { archive: 50, digest: 50, recommend: 70, research: 85 } };

const enq = enqueueJob(db, { kind: 'PIPELINE_RUN', runDate: `${date}#manual`, payload: { phase: 'FULL' } });
console.log('enqueue:', JSON.stringify(enq));

const handlers = {
  PIPELINE_RUN: async (job) => {
    const r = await runPipeline(db, {
      phase: 'FULL',
      dateStr: job.run_date?.split('#')[0],
      timeZone,
      config: eff,
      llm: null,
    });
    return r;
  },
};

const results = await runDueJobs(db, handlers, { maxJobs: 5, execTimeoutMs: 10 * 60000, heartbeatMs: 15000, backoffBaseMs: 60000 });
for (const r of results) console.log(r.ok ? `job ${r.kind} OK` : `job ${r.kind} FAILED: ${r.error}`);

const r = results[0]?.result;
if (r) {
  console.log('l0:', JSON.stringify(r.l0));
  console.log('clustered:', r.clustered, 'scored:', r.scored.length, 'candidates:', r.candidates.length, 'events:', r.events.length);
  const top = r.scored.filter((s) => s.total >= 50).sort((a, b) => b.total - a.total).slice(0, 5);
  for (const s of top) console.log(`[V=${s.total}] R=${s.r} N=${s.n} P=${s.p} E=${s.e} T=${s.t} #doc${s.document_id} ${s.stage}`);
  for (const c of r.candidates.slice(0, 5)) console.log('gate:', JSON.stringify(c));
}
closeDb(db);
