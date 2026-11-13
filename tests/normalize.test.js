import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalUrl, dedupKeyFor, normalizedTitle, detectLang, classifyTopic, bigramize, ftsQueryFor, sha256Hex, stripHtml } from '../lib/normalize.js';

test('canonicalUrl strips params, fragment, trailing slash', () => {
  assert.equal(canonicalUrl('HTTPS://Example.com/A/?utm_source=x&id=1#top'), 'https://example.com/A');
  assert.equal(canonicalUrl('https://example.com/a/'), 'https://example.com/a');
  assert.equal(canonicalUrl('not a url'), 'not a url');
  assert.equal(canonicalUrl(''), '');
});

test('dedupKeyFor is stable across URL variants', () => {
  const a = dedupKeyFor('https://e.com/p?x=1');
  const b = dedupKeyFor('https://e.com/p');
  assert.equal(a, b);
  assert.equal(a, sha256Hex('https://e.com/p'));
});

test('normalizedTitle ignores case and punctuation', () => {
  assert.equal(normalizedTitle('Hello, World!'), normalizedTitle('hello world'));
  assert.equal(normalizedTitle('  A  B  '), 'a b');
});

test('detectLang', () => {
  assert.equal(detectLang('这是一个中文标题，讲的是大模型'), 'zh');
  assert.equal(detectLang('A new LLM agent framework released'), 'en');
  assert.equal(detectLang('123 !!!'), 'und');
  assert.equal(detectLang(''), 'und');
});

test('classifyTopic buckets by keywords', () => {
  assert.equal(classifyTopic('new MCP server for tool calling'), 'mcp');
  assert.equal(classifyTopic('开源大模型发布'), 'llm');
  assert.equal(classifyTopic('autonomous agent framework with memory'), 'ai-agents');
  assert.equal(classifyTopic('nothing relevant here'), 'general');
});

test('bigramize splits CJK into bigrams, keeps latin words', () => {
  assert.equal(bigramize('智能体'), '智能 能体');
  assert.equal(bigramize('LLM Agent'), 'llm agent');
  assert.ok(bigramize('a').includes('a'));
});

test('ftsQueryFor builds AND of quoted tokens', () => {
  assert.equal(ftsQueryFor('智能体 framework'), '"智能" AND "能体" AND "framework"');
});

test('stripHtml removes tags and scripts', () => {
  const out = stripHtml('<p>Hello <b>world</b></p><script>evil()</script>');
  assert.equal(out, 'Hello world');
});
