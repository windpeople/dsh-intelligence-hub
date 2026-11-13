/** RSS 2.0 / Atom adapter with a lightweight regex-based parser (no deps). */

import { stripHtml } from '../normalize.js';

function decodeEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

function pick(block, tags) {
  for (const tag of tags) {
    // attribute form first: <link href="..."/>
    if (tag === 'link') {
      const href = block.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\/?>/i);
      if (href) return decodeEntities(href[1]).trim();
    }
    const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
    if (m) return decodeEntities(m[1]).trim();
  }
  return '';
}

/** Parse RSS 2.0 or Atom text into normalized items. */
export function parseFeed(xml) {
  const s = String(xml || '');
  const items = [];
  const isAtom = /<feed[\s>]/i.test(s) && !/<item[\s>]/i.test(s);
  const blocks = isAtom
    ? [...s.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)]
    : [...s.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)];
  for (const m of blocks) {
    const block = m[0];
    const title = pick(block, ['title']);
    let link = '';
    if (isAtom) {
      link = pick(block, ['link']);
      const alt = block.match(/<link\b[^>]*\brel=["']alternate["'][^>]*\bhref=["']([^"']+)["']/i);
      if (alt) link = decodeEntities(alt[1]).trim();
    } else {
      link = pick(block, ['link']);
    }
    const published = pick(block, ['pubDate', 'published', 'updated', 'dc:date']);
    const summary = pick(block, ['description', 'summary', 'content:encoded', 'content']);
    if (!title && !link) continue;
    items.push({
      title: stripHtml(title),
      url: link,
      summary: stripHtml(summary).slice(0, 2000),
      publishedAt: published ? safeDate(published) : null,
    });
  }
  return items;
}

function safeDate(v) {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Fetch one RSS/Atom source; returns [{title, url, summary, publishedAt}]. */
export async function fetchRss(fetcher, url) {
  const xml = await fetcher.getText(url, { headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' } });
  return parseFeed(xml);
}
