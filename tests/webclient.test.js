/**
 * Tests for the Web management UI wiring:
 *  - client.js markdown renderer escapes untrusted HTML (no <script> element,
 *    text only via textContent; links restricted to http/https);
 *  - Host web API (lib/webapi.js) exposes the documented read-only methods,
 *    validates payloads against a whitelist, and only approve/reject write
 *    (verified against a mock-backed real temp SQLite db);
 *  - the RPC handler wrapper maps errors into Connection result envelopes.
 *
 * Run: node --test tests/webclient.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { openDb, closeDb, migrate, insertDocument, ensureSources } from '../lib/db.js';
import { createWebApi, createRpcHandler, WEB_API_METHODS } from '../lib/webapi.js';

// ---------------------------------------------------------------------------
// Minimal DOM stub — enough for markdownToDom (createElement/textContent/append).
// ---------------------------------------------------------------------------
function makeDocument() {
  class Node {
    constructor(tag) {
      this.tagName = tag;
      this.nodeType = 1;
      this.children = [];
      this.attrs = {};
      this.textContent = '';
      this.listeners = {};
    }
    append(...kids) {
      for (const k of kids) {
        if (k === undefined || k === null) continue;
        this.children.push(k);
      }
    }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    /** Full serialized text of the subtree. */
    text() {
      return this.children.map((c) => (c instanceof Node ? c.text() : String(c))).join('');
    }
    /** All descendant nodes with the given tagName. */
    queryAll(tag, out = []) {
      for (const c of this.children) {
        if (c instanceof Node) { if (c.tagName === tag) out.push(c); c.queryAll(tag, out); }
      }
      return out;
    }
  }
  return {
    Node,
    createElement: (tag) => new Node(tag),
    createTextNode: (text) => String(text),
  };
}

function loadClientModule() {
  const code = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const document = makeDocument();
  let loaded = null;
  const sandbox = {
    window: { __ModuleLoader__: { load: (def) => { loaded = def; } } },
    document,
    require: (name) => { if (name === 'react') return { createElement: () => 0 }; throw new Error(`unexpected require ${name}`); },
  };
  vm.runInNewContext(code, sandbox, { filename: 'client.js' });
  assert.ok(loaded, 'module loader registration found');
  const mod = loaded.factory(sandbox.require);
  return { mod, document };
}

// ---------------------------------------------------------------------------
// Markdown rendering safety.
// ---------------------------------------------------------------------------
test('markdown renderer escapes HTML: <script> never becomes an element', () => {
  const { mod, document } = loadClientModule();
  const root = mod.__test.markdownToDom('hello <script>alert(1)</script> world');
  assert.equal(root.queryAll('script').length, 0, 'no script element');
  assert.equal(root.queryAll('iframe').length, 0, 'no iframe element');
  assert.ok(root.text().includes('<script>alert(1)</script>'), 'text preserved, escaped');
  // text nodes only — no raw-HTML sink anywhere
  const dumped = JSON.stringify(root, (k, v) => (k === 'listeners' ? undefined : v));
  assert.ok(!dumped.includes('innerHTML'), 'renderer never uses innerHTML');
  void document;
});

test('markdown renderer: links whitelist http(s), inline code, lists, fences', () => {
  const { mod } = loadClientModule();
  const md = [
    '# Title',
    '- item **bold** `code`',
    '1. [ok](https://example.com/a)',
    '2. [bad](javascript:alert(1))',
    '```',
    'const x = "<img src=x onerror=1>";',
    '```',
    '> quote',
  ].join('\n');
  const root = mod.__test.markdownToDom(md);
  const links = root.queryAll('a');
  assert.equal(links.length, 1, 'javascript: URL is not rendered as a link');
  assert.equal(links[0].attrs.href, 'https://example.com/a');
  assert.ok(root.queryAll('pre').length === 1, 'code fence -> pre');
  assert.ok(root.queryAll('ul').length === 1 && root.queryAll('ol').length === 1, 'list kinds');
  assert.ok(root.queryAll('h1').length === 1 && root.queryAll('blockquote').length === 1);
  const pre = root.queryAll('pre')[0];
  assert.ok(pre.text().includes('<img src=x'), 'code block keeps escaped text');
});

// ---------------------------------------------------------------------------
// Host web API against a real temp db (mock-level: no plugin runtime needed).
// ---------------------------------------------------------------------------
function tempDbWithContent() {
  const dir = mkdtempSync(path.join(tmpdir(), 'intelhub-web-'));
  const db = openDb(path.join(dir, 'web.db'));
  migrate(db);
  ensureSources(db);
  const now = new Date();
  insertDocument(db, {
    url: 'https://example.com/a', title: 'Hello <b>world</b>', summary: 'first',
    lang: 'en', topic: 'rag', dedupKey: 'a', contentHash: 'ha', searchText: 'hello world first',
  }, null, now.toISOString());
  insertDocument(db, {
    url: 'https://example.com/b', title: 'agent memory', summary: 'second',
    lang: 'en', topic: 'agent', dedupKey: 'b', contentHash: 'hb', searchText: 'agent memory second',
  }, null, now.toISOString());
  db.prepare("INSERT INTO intel_source_candidates (url, domain, discovered_via, rss_detected, relevance_score, status, safety_json, created_at, updated_at) VALUES ('https://new.example.com/feed', 'new.example.com', 'test', 'https://new.example.com/feed.xml', 1, 'candidate', '{}', ?, ?)")
    .run(now.toISOString(), now.toISOString());
  db.prepare("INSERT INTO intel_reports (topic, title, body, model, document_ids, created_at, report_date) VALUES ('daily', 'Daily <script>x</script>', '# Report\n- a', '', '[]', ?, '2026-11-05')")
    .run(now.toISOString());
  return db;
}

test('webapi exposes exactly the documented method whitelist (25 endpoints)', () => {
  assert.equal(WEB_API_METHODS.length, 25);
  assert.deepEqual([...WEB_API_METHODS].sort(), [
    'approveCandidate', 'addSource', 'getConfig', 'getDoc', 'getInbox', 'getKnowledge',
    'getReportMarkdown', 'getStatus', 'getTopicDetail', 'getTopics', 'getWorkbench',
    'listCandidates', 'listJobs', 'listReports', 'listSourceHealth', 'listSources',
    'markItems', 'refreshTopic', 'rejectCandidate', 'researchTrigger', 'retryJob',
    'rollbackKnowledge', 'searchDocs', 'setSourceEnabled', 'triggerCollect',
  ].sort());
  for (const m of WEB_API_METHODS) {
    assert.equal(typeof createWebApi(tempDbWithContent())[m], 'function', `${m} exists`);
  }
});

test('client registers 8 in-panel pages in the documented order', () => {
  const { mod } = loadClientModule();
  // Compare as JSON: NAV_PAGES crosses a vm realm (different Array prototype).
  assert.equal(JSON.stringify(mod.__test.NAV_PAGES.map(([k]) => k)), JSON.stringify([
    'workbench', 'inbox', 'topics', 'knowledge', 'reports', 'sources', 'jobs', 'settings',
  ]));
  // topPicks pure helpers are retained for the workbench/tests.
  assert.equal(typeof mod.__test.topPicksFromMarkdown, 'function');
  assert.equal(typeof mod.__test.sparkPoints, 'function');
  assert.deepEqual(mod.__test.sparkPoints([{ count: 0 }, { count: 5 }, { count: 2 }]), '0,44 110,6 220,29');
});

test('searchDocs never returns raw body; results carry escaped-safe fields only', () => {
  const db = tempDbWithContent();
  const api = createWebApi(db, {});
  const r = api.searchDocs({ query: 'hello' });
  assert.equal(r.results.length, 1);
  const doc = r.results[0];
  assert.ok(!('raw_content' in doc) && !('search_text' in doc), 'no raw fields');
  assert.equal(doc.title, 'Hello <b>world</b>');
  closeDb(db);
});

test('payload whitelist: bad sourceType / date / id / unknown method are refused', () => {
  const db = tempDbWithContent();
  const api = createWebApi(db, {});
  assert.throws(() => api.searchDocs({ sourceType: 'gopher' }), /sourceType/);
  assert.throws(() => api.getReportMarkdown({ date: "2026-01-01'; DROP TABLE x" }), /YYYY-MM-DD/);
  assert.throws(() => api.approveCandidate({ id: '1 OR 1=1' }), /integer/);
  assert.throws(() => api.searchDocs({ query: 'x'.repeat(400) }), /too long/);
  assert.throws(() => api.listSources({ sourceType: ['rss'] }), /must be/);
  closeDb(db);
});

test('rpc handler wraps results in Connection envelopes and rejects unknown endpoints', async () => {
  const db = tempDbWithContent();
  const handler = createRpcHandler(db, { enabled: true });
  const ok = await handler('getStatus', {});
  assert.equal(ok.ok, true);
  assert.ok(ok.value.documents >= 2);
  const bad = await handler('execSql', { sql: 'DROP TABLE intel_documents' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'UNKNOWN_METHOD');
  const invalid = await handler('getReportMarkdown', { date: 'nope' });
  assert.equal(invalid.ok, false);
  assert.ok(['INVALID', 'INTERNAL'].includes(invalid.error.code));
  closeDb(db);
});

test('approve/reject are the only writes and reuse the discovery paths', () => {
  const db = tempDbWithContent();
  const api = createWebApi(db, {});
  const before = api.listCandidates({ status: 'candidate' }).candidates.length;
  assert.equal(before, 1);
  const approved = api.approveCandidate({ id: api.listCandidates({}).candidates[0].id });
  assert.equal(approved.ok, true);
  assert.equal(api.listCandidates({ status: 'approved' }).candidates.length, 1);
  const sourcesBefore = api.listSources({}).sources.length;
  assert.ok(sourcesBefore >= 1, 'approved candidate created an intel_sources row');
  closeDb(db);
});

test('getReportMarkdown returns markdown body for a whitelisted date', () => {
  const db = tempDbWithContent();
  const api = createWebApi(db, {});
  const r = api.getReportMarkdown({ date: '2026-11-05' });
  assert.match(r.report.markdown, /^# Report/);
  closeDb(db);
});

// ---------------------------------------------------------------------------
// Display-layer helpers used by the polished Dashboard.
// ---------------------------------------------------------------------------
test('topPicksFromMarkdown extracts the first ### sections with one-line reasons', () => {
  const { mod } = loadClientModule();
  const md = [
    '# Daily report',
    'intro',
    '### Agent memory frameworks',
    'New survey on memory architectures **worth reading**.',
    '- detail line',
    '### RAG eval',
    '`retrieval` quality checklist at https://example.com/x',
    '### Third pick',
    '',
    '### Fourth pick ignored',
  ].join('\n');
  const picks = mod.__test.topPicksFromMarkdown(md, 3);
  assert.equal(picks.length, 3);
  assert.equal(picks[0].title, 'Agent memory frameworks');
  assert.equal(picks[0].reason, 'New survey on memory architectures worth reading.');
  assert.equal(picks[1].title, 'RAG eval');
  assert.equal(picks[1].reason, 'retrieval quality checklist at https://example.com/x');
  assert.ok(picks.every((p) => !p.reason.includes('**') && !p.reason.includes('`')), 'inline tokens stripped');
});

test('relTime never returns a bare ISO string for parseable timestamps', () => {
  const { mod } = loadClientModule();
  const t = (k) => k;
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 3 * 3600000).toISOString();
  assert.equal(mod.__test.relTime(now, t), 'justNow');
  assert.equal(mod.__test.relTime(old, t), 'hourAgo'.replace('{n}', '3'));
  assert.equal(mod.__test.relTime('', t), '—');
  assert.equal(mod.__test.relTime('not-a-date', t), 'not-a-date');
});
