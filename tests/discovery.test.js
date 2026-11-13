import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb, closeDb, ensureSources } from '../lib/db.js';
import {
  extractDomain, checkUrlSafety, probeRss, recordDiscoveredSource, maybeDiscover,
  approveCandidate, rejectCandidate, listCandidates, KNOWN_NOISE_DOMAINS,
} from '../lib/discovery.js';

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'intelhub-disc-'));
  const db = openDb(path.join(dir, 't.db'));
  ensureSources(db);
  return { db, dir, close: () => closeDb(db) };
}

const publicResolver = async () => [{ address: '93.184.216.34', family: 4 }];

function feedFetch(paths) {
  // mock fetch: serves an RSS doc at the given path set, 404 elsewhere
  return async (url) => {
    const u = new URL(url);
    if (paths.includes(u.pathname)) {
      return { ok: true, status: 200, headers: { get: () => 'application/rss+xml' }, text: async () => '<?xml version="1.0"?><rss version="2.0"><channel><title>t</title></channel></rss>' };
    }
    if (u.pathname === '/' || u.pathname === '') {
      return { ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => '<html><head><link rel="alternate" type="application/rss+xml" href="/all.xml"></head><body>hi</body></html>' };
    }
    return { ok: false, status: 404, headers: { get: () => '' }, text: async () => 'not found' };
  };
}

test('domain extraction and known-noise skip', async () => {
  const { db, close } = setup();
  try {
    assert.equal(extractDomain('https://blog.example.com/post/1?x=2'), 'blog.example.com');
    assert.equal(extractDomain('https://www.GitHub.com/a/b'), 'github.com');
    const r = await recordDiscoveredSource(db, { url: 'https://github.com/foo/bar', via: 'test' }, { config: {}, resolver: publicResolver });
    assert.ok(r.skipped && /known-noise/.test(r.reason), 'github.com handled by built-in adapters, not a candidate');
    assert.equal(listCandidates(db).length, 0);
    assert.ok(KNOWN_NOISE_DOMAINS.has('arxiv.org'));
  } finally { close(); }
});

test('RSS probe: <link rel=alternate> hint and common fallback paths', async () => {
  const viaLink = await probeRss("https://blog.example.com/", { fetchText: feedFetch(["/all.xml"]) });
  assert.ok(viaLink.found && viaLink.url.endsWith('/all.xml'), 'alternate link detected');
  const viaPaths = await probeRss('https://blog.example.com/', {
    fetchText: async (url) => {
      const u = new URL(url);
      if (u.pathname === '/feed') return { ok: true, status: 200, headers: { get: () => '' }, text: async () => '<?xml version="1.0"?><rss><channel></channel></rss>' };
      return { ok: false, status: 404, headers: { get: () => '' }, text: async () => '' };
    },
  });
  assert.ok(viaPaths.found && viaPaths.url.endsWith('/feed'), 'common path fallback works');
  const none = await probeRss('https://blog.example.com/', { fetchText: async () => { throw new Error('down'); } });
  assert.ok(!none.found);
  assert.ok(!probeRss('https://x/', { fetchText: null }).found, 'no fetch capability -> skipped, not crash');
});

test('recordDiscoveredSource creates a candidate (not auto-approved by default)', async () => {
  const { db, close } = setup();
  try {
    const fetchText = async (url) => {
      const u = new URL(url);
      if (u.pathname === '/feed') return '<?xml version="1.0"?><rss><channel><title>Agent Memory weekly</title></channel></rss>';
      if (u.pathname === '/') return '<html><link rel="alternate" type="application/rss+xml" href="/feed"><body>AI Agent blog about agent memory systems</body></html>';
      throw new Error('404');
    };
    const r = await recordDiscoveredSource(db, {
      url: 'https://blog.agentmemory.dev/feed', title: 'Agent Memory weekly',
      description: 'long-term memory for AI agents, context compression', via: 'research:dr-1',
    }, { config: {}, fetchText, resolver: publicResolver });
    assert.ok(r.discovered, JSON.stringify(r));
    assert.equal(r.status, 'candidate', 'autoApproveSources default false -> waits for user confirmation');
    assert.ok(r.rss_detected.endsWith('/feed'));
    assert.ok(r.relevance_score > 0, 'profile-relevant topic scored');
    assert.equal(r.safety.ok, true);
    const configured = listCandidates(db);
    assert.equal(configured.length, 1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM intel_sources WHERE url LIKE '%agentmemory%'").get().n, 0, 'no source row before approval');
  } finally { close(); }
});

test('dedup: same domain not re-candidated; already-configured domain skipped', async () => {
  const { db, close } = setup();
  try {
    const cfg = { config: { autoApproveSources: true } };
    const fetchText = async (url) => {
      if (new URL(url).pathname === '/feed') return '<?xml?><rss><channel><title>agent memory</title></channel></rss>';
      return '<html>agent memory and RAG blog</html>';
    };
    const a = await recordDiscoveredSource(db, { url: 'https://newsite.example/feed', title: 'Agent Memory weekly', description: 'agent memory systems and RAG', via: 't' }, { ...cfg, fetchText, resolver: publicResolver });
    assert.ok(a.discovered && a.status === 'approved', 'autoApproveSources=true approves rss-bearing candidate');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM intel_sources WHERE url LIKE '%newsite.example%'").get().n, 1, 'approved candidate becomes a scheduled source');
    const b = await recordDiscoveredSource(db, { url: 'https://newsite.example/post', via: 't' }, { fetchText, resolver: publicResolver });
    assert.ok(b.skipped && /already a (candidate|configured source)/.test(b.reason), 'domain dedup');
    const c = await recordDiscoveredSource(db, { url: 'https://hnrss.org/frontpage', via: 't' }, { fetchText, resolver: publicResolver });
    assert.ok(c.skipped, 'configured/noise domain skipped');
  } finally { close(); }
});

test('daily quota maxNewSourcesPerDay limits candidate creation', async () => {
  const { db, close } = setup();
  try {
    const cfg = { config: { maxNewSourcesPerDay: 2 } };
    const fetchText = async () => '<html>x</html>';
    for (const d of ['one.example', 'two.example']) {
      const r = await recordDiscoveredSource(db, { url: `https://${d}/`, via: 't' }, { ...cfg, fetchText, resolver: publicResolver });
      assert.ok(r.discovered, `${d} accepted`);
    }
    const third = await recordDiscoveredSource(db, { url: 'https://three.example/', via: 't' }, { ...cfg, fetchText, resolver: publicResolver });
    assert.ok(third.skipped && /quota/.test(third.reason), 'third candidate blocked by quota');
  } finally { close(); }
});

test('SSRF rejections: localhost, 169.254.169.254, private IPs, non-http(s)', async () => {
  const { db, close } = setup();
  try {
    const cases = [
      ['http://localhost:8080/feed', /private\/reserved host/],
      ['http://127.0.0.1/rss', /private\/reserved host/],
      ['http://169.254.169.254/latest/meta-data', /private\/reserved host/],
      ['http://10.1.2.3/feed', /private\/reserved host/],
      ['http://192.168.1.10/feed', /private\/reserved host/],
      ['http://172.16.0.9/feed', /private\/reserved host/],
      ['ftp://files.example/feed', /non-http/],
    ];
    for (const [url, re] of cases) {
      const r = await recordDiscoveredSource(db, { url, via: 't' }, { config: { maxNewSourcesPerDay: 99 }, fetchText: async () => '<?xml?><rss/>', resolver: publicResolver });
      assert.ok(r.discovered, `${url} recorded`);
      assert.equal(r.status, 'rejected', `${url} rejected by safety`);
      assert.match(r.safety.reason, re, `${url} reason mentions the violation`);
    }
    // file:// has no hostname at all -> never becomes a candidate; checkUrlSafety rejects it
    const fileSkip = await recordDiscoveredSource(db, { url: 'file:///etc/passwd', via: 't' }, { config: { maxNewSourcesPerDay: 99 } });
    assert.ok(fileSkip.skipped, 'file:// url never becomes a candidate');
    const fileSafety = await checkUrlSafety('file:///etc/passwd');
    assert.ok(!fileSafety.ok && /non-http/.test(fileSafety.reason), 'checkUrlSafety rejects non-http(s)');
    // DNS-resolved private address also rejected
    const evilResolver = async () => [{ address: '192.168.0.1', family: 4 }];
    const sneaky = await checkUrlSafety('https://evil-rebind.example/feed', { resolver: evilResolver });
    assert.ok(!sneaky.ok && /private/.test(sneaky.reason), 'DNS rebinding to private IP rejected');
    // rejected candidates never become sources even with autoApprove
    const r2 = await recordDiscoveredSource(db, { url: 'http://127.0.0.10:9999/feed', via: 't2' }, { config: { autoApproveSources: true, maxNewSourcesPerDay: 99 }, fetchText: async () => '<?xml?><rss/>', resolver: publicResolver });
    assert.equal(r2.status, 'rejected');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM intel_sources WHERE url LIKE '%127.0.0.10%'").get().n, 0);
  } finally { close(); }
});

test('approve/reject workflow via candidate ids', async () => {
  const { db, close } = setup();
  try {
    const fetchText = async (url) => (new URL(url).pathname === '/feed' ? '<?xml?><rss><channel></channel></rss>' : '<html>x</html>');
    const r = await recordDiscoveredSource(db, { url: 'https://approve.example/feed', via: 't' }, { fetchText, resolver: publicResolver });
    const ok = approveCandidate(db, r.candidate_id);
    assert.ok(ok.ok && ok.source_id > 0, 'approval creates a real intel_sources row');
    const again = approveCandidate(db, r.candidate_id);
    assert.ok(again.already, 'idempotent approve');
    const r2 = await recordDiscoveredSource(db, { url: 'https://rejectme.example/feed', via: 't' }, { fetchText, resolver: publicResolver });
    const rej = rejectCandidate(db, r2.candidate_id);
    assert.equal(rej.status, 'rejected');
    const blocked = approveCandidate(db, r2.candidate_id);
    assert.equal(blocked.ok, false, 'rejected candidate cannot be approved');
    assert.equal(approveCandidate(db, 99999).ok, false);
    assert.ok(listCandidates(db, { status: 'approved' }).length === 1);
  } finally { close(); }
});

test('maybeDiscover never throws and respects discoveryEnabled=false', async () => {
  const { db, close } = setup();
  try {
    maybeDiscover(db, { url: 'https://off.example/' }, { config: { discoveryEnabled: false } });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(listCandidates(db).length, 0, 'no candidate when discovery disabled');
    maybeDiscover(db, { url: 'https://slow.example/' }, { config: {}, fetchText: () => new Promise(() => {}), resolver: async () => { await new Promise((r) => setTimeout(r, 60000)); return [{ address: '1.2.3.4', family: 4 }]; } });
    assert.ok(true, 'does not block the caller');
  } finally { close(); }
});
