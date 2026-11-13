/**
 * smoke8 — Read-only "library index" over the REAL intelligence knowledge base.
 *   node scripts/smoke8.js
 *
 * Per direction change (2026-11-09): intelligence knowledge is NOT written into
 * Aurabot memory (library vs person separation). This script only walks
 * intel_knowledge_facts in the real intel.db, groups facts by subject, resolves
 * supersede chains, and prints a reader-friendly index (subject → facts →
 * evidence ids / source urls). It never calls any Aurabot write interface and
 * never modifies the database (single read-only connection).
 * No install, no DSH runtime required.
 */

import { openDb, closeDb } from '../lib/db.js';
import os from 'node:os';
import path from 'node:path';

const dbPath = process.env.INTEL_DB || path.join(os.homedir(), '.dsh', 'plugins-data', 'dsh-intelligence-hub', 'intel.db');
console.log('[smoke8] real db (read-only):', dbPath);
const db = openDb(dbPath, { readonly: true });

const rows = db.prepare('SELECT * FROM intel_knowledge_facts ORDER BY subject, valid_from').all();
console.log('[smoke8] total facts:', rows.length);

// Group by subject, resolve supersede chains (a fact whose superseded_by is set
// is historical; the pointer target is the current version).
const byId = new Map(rows.map((r) => [r.id, r]));
const subjects = new Map();
for (const r of rows) {
  if (!subjects.has(r.subject)) subjects.set(r.subject, []);
  subjects.get(r.subject).push(r);
}

let current = 0, historical = 0;
for (const [subject, facts] of subjects) {
  console.log(`\n== subject: ${subject} (${facts.length} facts) ==`);
  for (const f of facts) {
    const isCurrent = !f.superseded_by && !f.valid_to;
    if (isCurrent) current++; else historical++;
    let evidence = [];
    try { evidence = JSON.parse(f.evidence_ids || '[]'); } catch {}
    const tag = isCurrent ? 'current' : `historical -> superseded_by #${f.superseded_by || '?'}`;
    const resolved = f.superseded_by && byId.get(f.superseded_by)
      ? ` (current fact #${f.superseded_by}: ${String(byId.get(f.superseded_by).fact).slice(0, 60)}...)` : '';
    console.log(`  [${tag}] fact #${f.id} (confidence=${f.confidence}, ${f.verification_status})${resolved}`);
    console.log(`    fact  : ${f.fact}`);
    console.log(`    source: ${f.source_url || '(none)'}`);
    console.log(`    evidence: ${evidence.join(', ') || '(none)'}`);
    console.log(`    valid_from: ${f.valid_from}${f.valid_to ? `  valid_to: ${f.valid_to}` : ''}`);
  }
}

console.log(`\n[smoke8] summary: ${rows.length} facts, ${current} current, ${historical} historical (superseded kept, never deleted).`);
console.log('[smoke8] read-only index complete; no Aurabot memory interface invoked, no writes performed.');
closeDb(db);
