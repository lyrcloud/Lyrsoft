// Lyrsoft SEO: pure rules behind seo.mjs (tested in seo.test.mjs). Reads a page's HTML the way a search
// engine's first pass does (title, description, headings, links, images, structured data, social
// cards, indexing signals) and turns it into a scored checklist with a fix for every problem, plus an
// on-page report for the keywords a site cares about.
import { ValidationError } from './model.mjs';
import { cleanUrl } from './ops-model.mjs';

export const MAX_SITES = 20;
export const MAX_KEYWORDS = 15;
export const AUDITS_KEPT = 30;
export const AREAS = { content: 'Content', indexing: 'Indexing', links: 'Links & images', social: 'Social & rich results', speed: 'Speed & tech' };

const text = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const EMAIL_RE = /^[^\s@<>(),;:"]{1,64}@[^\s@<>(),;:"]{1,190}\.[^\s@<>(),;:"]{2,63}$/;

// ------------------------------------------------------------------ sites, keywords, settings

export function cleanKeywords(v) {
  const raw = Array.isArray(v) ? v : String(v || '').split(/[\n,;]+/);
  return [...new Set(raw.map((k) => text(k, 80).toLowerCase()).filter(Boolean))].slice(0, MAX_KEYWORDS);
}

export function cleanSite(input = {}, current = null) {
  const s = current ? { ...current } : { name: '', url: '', keywords: [] };
  if (!current || 'name' in input) s.name = text(input.name, 80);
  if (!current || 'url' in input) s.url = cleanUrl(input.url);
  if ('keywords' in input) s.keywords = cleanKeywords(input.keywords);
  if (!s.name) {
    try {
      s.name = new URL(s.url).hostname.replace(/^www\./, '');
    } catch {
      throw new ValidationError('Give the site a name.');
    }
  }
  return s;
}

export function cleanSeoSettings(input = {}, current = {}) {
  const s = { viewers: current.viewers || [] };
  if ('viewers' in input) {
    const raw = Array.isArray(input.viewers) ? input.viewers : String(input.viewers || '').split(/[\s,;]+/);
    s.viewers = [...new Set(raw.map((e) => text(e, 254).toLowerCase()).filter((e) => EMAIL_RE.test(e)))].slice(0, 30);
  }
  return s;
}

// ------------------------------------------------------------------ reading HTML

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
export const decode = (s) =>
  String(s || '').replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });

// Attributes of one tag: <meta name="x" content='y' data-z> -> { name: 'x', content: 'y', 'data-z': '' }
export function attrs(tag) {
  const out = {};
  const body = tag.replace(/^<\s*[\w:-]+/, '').replace(/\/?>$/, '');
  for (const m of body.matchAll(/([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g)) {
    out[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

const tags = (html, name) => [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map((m) => attrs(m[0]));
const inner = (html, name) => [...html.matchAll(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}\\s*>`, 'gi'))].map((m) => m[1]);
const plain = (fragment) => text(decode(String(fragment).replace(/<[^>]+>/g, ' ')), 100_000);

// What a crawler sees on the page.
export function readPage(html, pageUrl) {
  const clean = String(html || '').replace(/<!--[\s\S]*?-->/g, '');
  const head = (clean.match(/<head\b[\s\S]*?<\/head>/i) || [clean])[0];
  const metas = tags(head, 'meta');
  const meta = (key) => metas.find((m) => (m.name || '').toLowerCase() === key || (m.property || '').toLowerCase() === key)?.content?.trim() ?? null;
  const linksIn = tags(head, 'link');
  const rel = (r) => linksIn.filter((l) => (l.rel || '').toLowerCase().split(/\s+/).includes(r));
  const body = (clean.match(/<body\b[\s\S]*<\/body>/i) || [clean])[0].replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  const words = plain(body).split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  const headings = {};
  for (let i = 1; i <= 6; i++) headings[`h${i}`] = inner(body, `h${i}`).map(plain).filter(Boolean).slice(0, 40).map((x) => x.slice(0, 200));
  let base;
  try {
    base = new URL(pageUrl);
  } catch {
    base = null;
  }
  const anchors = tags(body, 'a').filter((a) => a.href && !/^(javascript:|mailto:|tel:|#)/i.test(a.href.trim()));
  let internal = 0;
  let external = 0;
  let nofollow = 0;
  for (const a of anchors) {
    if (/\bnofollow\b/i.test(a.rel || '')) nofollow += 1;
    try {
      const u = new URL(a.href, base || undefined);
      if (base && u.hostname.replace(/^www\./, '') === base.hostname.replace(/^www\./, '')) internal += 1;
      else external += 1;
    } catch {}
  }
  const images = tags(body, 'img');
  const jsonLd = [...clean.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .filter((m) => /application\/ld\+json/i.test(m[1]))
    .flatMap(([, , s]) => {
      try {
        const data = JSON.parse(s.trim());
        const list = Array.isArray(data) ? data : data['@graph'] || [data];
        return list.flatMap((x) => [].concat(x?.['@type'] || [])).map(String);
      } catch {
        return ['(invalid JSON-LD)'];
      }
    });
  const htmlTag = attrs((clean.match(/<html\b[^>]*>/i) || ['<html>'])[0]);
  return {
    title: inner(head, 'title').map(plain)[0] ?? null,
    titleCount: inner(head, 'title').length,
    description: meta('description'),
    robots: (meta('robots') || '').toLowerCase(),
    canonical: rel('canonical')[0]?.href || null,
    viewport: meta('viewport'),
    lang: htmlTag.lang || null,
    charset: Boolean(metas.find((m) => 'charset' in m) || metas.find((m) => /charset/i.test(m.content || '') && /content-type/i.test(m['http-equiv'] || ''))),
    favicon: Boolean(rel('icon')[0] || rel('shortcut')[0] || rel('apple-touch-icon')[0]),
    hreflang: rel('alternate').filter((l) => l.hreflang).length,
    og: { title: meta('og:title'), description: meta('og:description'), image: meta('og:image'), type: meta('og:type') },
    twitter: meta('twitter:card'),
    headings,
    words: words.length,
    text: words.slice(0, 3000).join(' '),
    links: { internal, external, nofollow },
    images: { total: images.length, noAlt: images.filter((i) => !('alt' in i)).length, emptyAlt: images.filter((i) => 'alt' in i && !i.alt.trim()).length, lazy: images.filter((i) => (i.loading || '').toLowerCase() === 'lazy').length },
    structured: [...new Set(jsonLd)].slice(0, 20),
    microdata: /\bitemscope\b/i.test(body),
    scripts: tags(clean, 'script').filter((s) => s.src).length,
    stylesheets: rel('stylesheet').length,
    inlineBytes: inner(clean, 'script').concat(inner(clean, 'style')).reduce((n, s) => n + s.length, 0),
  };
}

// ------------------------------------------------------------------ the checklist

const WEIGHT = { fail: 1, warn: 0.5, pass: 0 };
const IMPORTANCE = { high: 3, medium: 2, low: 1 };

// `fetch`: { url, finalUrl, status, ms, ttfb, bytes, headers: {name: value}, redirects, robotsTxt, robotsBlocked, sitemap }
export function auditPage(page, fetch) {
  const out = [];
  const add = (id, area, importance, level, title, detail = '', fix = '') => out.push({ id, area, importance, level, title, detail, fix });
  const h = fetch.headers || {};
  const len = (s) => [...String(s || '')].length;

  // Content
  if (!page.title) add('title', 'content', 'high', 'fail', 'No page title', 'Search results show the <title> as the blue headline.', 'Add a <title> of 30–60 characters that says what the page is, with your main keyword near the start.');
  else if (len(page.title) < 30 || len(page.title) > 60) add('title', 'content', 'high', 'warn', `Title is ${len(page.title)} characters`, page.title, len(page.title) > 60 ? 'Shorten it to about 60 characters so it isn’t cut off in results.' : 'Make it more descriptive: 30–60 characters works best.');
  else add('title', 'content', 'high', 'pass', 'Title length is good', page.title);
  if (page.titleCount > 1) add('title-dup', 'content', 'medium', 'warn', `${page.titleCount} <title> tags`, '', 'Keep one <title> in the <head>.');
  if (!page.description) add('description', 'content', 'high', 'fail', 'No meta description', 'Search engines often show it under the title.', 'Add <meta name="description"> of 70–160 characters that sells the click.');
  else if (len(page.description) < 70 || len(page.description) > 160) add('description', 'content', 'high', 'warn', `Description is ${len(page.description)} characters`, page.description, len(page.description) > 160 ? 'Trim it to about 160 characters.' : 'Write a fuller summary: 70–160 characters.');
  else add('description', 'content', 'high', 'pass', 'Meta description length is good', page.description);
  const h1 = page.headings.h1;
  if (!h1.length) add('h1', 'content', 'high', 'fail', 'No H1 heading', '', 'Give the page one <h1> that matches what people searched for.');
  else if (h1.length > 1) add('h1', 'content', 'medium', 'warn', `${h1.length} H1 headings`, h1.slice(0, 3).join(' · '), 'Use a single <h1>; make the others <h2>.');
  else add('h1', 'content', 'high', 'pass', 'One H1 heading', h1[0]);
  if (!page.headings.h2.length && page.words > 300) add('h2', 'content', 'low', 'warn', 'No H2 subheadings', '', 'Break longer pages up with <h2> sections; they help readers and search engines.');
  if (page.words < 300) add('words', 'content', 'medium', page.words < 100 ? 'fail' : 'warn', `Only ${page.words} words of text`, '', 'Pages with more useful text rank better: aim for 300+ words that answer the visitor’s question.');
  else add('words', 'content', 'medium', 'pass', `${page.words} words of text`);
  if (!page.lang) add('lang', 'content', 'low', 'warn', 'No language on <html>', '', 'Add lang="en" (or your language) to the <html> tag.');

  // Indexing
  if (fetch.status >= 400 || !fetch.status) add('status', 'indexing', 'high', 'fail', fetch.status ? `The page answers HTTP ${fetch.status}` : 'The page didn’t load', fetch.error || '', 'Search engines drop pages that don’t answer 200 OK.');
  else add('status', 'indexing', 'high', 'pass', `HTTP ${fetch.status}`);
  if (fetch.redirects?.length) add('redirects', 'indexing', 'low', fetch.redirects.length > 1 ? 'warn' : 'pass', `${fetch.redirects.length} redirect${fetch.redirects.length > 1 ? 's' : ''} before the page`, fetch.redirects.join(' → '), fetch.redirects.length > 1 ? 'Link straight to the final address; each hop slows crawling.' : '');
  const noindex = /\bnoindex\b/.test(page.robots) || /\bnoindex\b/i.test(h['x-robots-tag'] || '');
  if (noindex) add('noindex', 'indexing', 'high', 'fail', 'The page asks not to be indexed', page.robots || h['x-robots-tag'], 'Remove “noindex” from the robots meta tag or X-Robots-Tag header if this page should appear in search.');
  else add('noindex', 'indexing', 'high', 'pass', 'Indexing is allowed');
  if (fetch.robotsBlocked) add('robots-txt', 'indexing', 'high', 'fail', 'robots.txt blocks this page', '', 'Remove the Disallow rule that matches this path.');
  else if (fetch.robotsTxt === null) add('robots-txt', 'indexing', 'low', 'warn', 'No robots.txt', '', 'Add /robots.txt with a Sitemap: line so crawlers find your pages.');
  else add('robots-txt', 'indexing', 'low', 'pass', 'robots.txt found and allows this page');
  if (!fetch.sitemap) add('sitemap', 'indexing', 'medium', 'warn', 'No XML sitemap found', 'Looked in robots.txt and at /sitemap.xml.', 'Publish /sitemap.xml listing your pages and submit it in Google Search Console.');
  else add('sitemap', 'indexing', 'medium', 'pass', 'XML sitemap found', fetch.sitemap);
  if (!page.canonical) add('canonical', 'indexing', 'medium', 'warn', 'No canonical link', '', 'Add <link rel="canonical" href="…"> pointing at the page’s preferred address to avoid duplicate-content splits.');
  else {
    let same = false;
    try {
      same = new URL(page.canonical, fetch.finalUrl).href.replace(/\/$/, '') === new URL(fetch.finalUrl).href.replace(/\/$/, '');
    } catch {}
    add('canonical', 'indexing', 'medium', same ? 'pass' : 'warn', same ? 'Canonical points at this page' : 'Canonical points elsewhere', page.canonical, same ? '' : 'Fine for duplicates; otherwise point it at this page’s own address.');
  }
  if (!String(fetch.finalUrl || '').startsWith('https:')) add('https', 'indexing', 'high', 'fail', 'Not served over HTTPS', '', 'Serve the site over HTTPS and redirect http:// to it; Google ranks secure pages higher.');
  else add('https', 'indexing', 'high', 'pass', 'Served over HTTPS');

  // Links & images
  if (page.images.total) {
    const missing = page.images.noAlt;
    add('alt', 'links', 'medium', missing ? (missing / page.images.total > 0.3 ? 'fail' : 'warn') : 'pass', missing ? `${missing} of ${page.images.total} images have no alt text` : `All ${page.images.total} images have alt text`, '', missing ? 'Describe each image in alt="…" (empty alt="" only for decoration). It helps image search and screen readers.' : '');
    if (page.images.total > 8 && !page.images.lazy) add('lazy', 'speed', 'low', 'warn', 'Images aren’t lazy-loaded', '', 'Add loading="lazy" to images below the fold.');
  }
  if (!page.links.internal) add('internal', 'links', 'medium', 'warn', 'No internal links', '', 'Link to your other pages so visitors and crawlers can move around the site.');
  else add('internal', 'links', 'medium', 'pass', `${page.links.internal} internal links`, `${page.links.external} external · ${page.links.nofollow} nofollow`);

  // Social & rich results
  const ogMissing = ['title', 'description', 'image'].filter((k) => !page.og[k]);
  add('og', 'social', 'medium', ogMissing.length === 3 ? 'fail' : ogMissing.length ? 'warn' : 'pass', ogMissing.length ? `Open Graph missing: ${ogMissing.join(', ')}` : 'Open Graph tags complete', '', ogMissing.length ? 'Add og:title, og:description and og:image so links look good on Facebook, WhatsApp, LinkedIn and Messenger.' : '');
  if (!page.twitter) add('twitter', 'social', 'low', 'warn', 'No Twitter / X card', '', 'Add <meta name="twitter:card" content="summary_large_image">.');
  if (page.structured.length || page.microdata) add('schema', 'social', 'medium', page.structured.includes('(invalid JSON-LD)') ? 'warn' : 'pass', page.structured.includes('(invalid JSON-LD)') ? 'Structured data has a JSON error' : `Structured data: ${page.structured.join(', ') || 'microdata'}`, '', page.structured.includes('(invalid JSON-LD)') ? 'Fix the JSON in your application/ld+json script; test it with Google’s Rich Results Test.' : '');
  else add('schema', 'social', 'medium', 'warn', 'No structured data', '', 'Add JSON-LD (Organization, Product, Article, LocalBusiness, FAQ…) to win rich results.');
  if (!page.favicon) add('favicon', 'social', 'low', 'warn', 'No favicon link', '', 'Add <link rel="icon" href="/favicon.ico">; Google shows it next to your result on phones.');

  // Speed & tech
  if (!page.viewport) add('viewport', 'speed', 'high', 'fail', 'Not set up for phones (no viewport)', '', 'Add <meta name="viewport" content="width=device-width, initial-scale=1">. Google indexes the mobile version first.');
  else add('viewport', 'speed', 'high', 'pass', 'Mobile viewport set');
  const ttfb = fetch.ttfb || fetch.ms;
  add('ttfb', 'speed', 'high', ttfb > 1800 ? 'fail' : ttfb > 800 ? 'warn' : 'pass', `Server answered in ${Math.round(ttfb)} ms`, 'Time to first byte from Lyrsoft’s servers (US East).', ttfb > 800 ? 'Use caching or a CDN (e.g. CloudFront, Cloudflare) and lighter server work; aim under 800 ms.' : '');
  const kb = Math.round((fetch.bytes || 0) / 1024);
  add('size', 'speed', 'medium', kb > 3000 ? 'fail' : kb > 1500 ? 'warn' : 'pass', `HTML is ${kb} KB`, '', kb > 1500 ? 'Trim inline scripts, styles and data from the HTML.' : '');
  const encoding = String(h['content-encoding'] || '').toLowerCase();
  if (kb > 10) add('compression', 'speed', 'medium', /gzip|br|zstd|deflate/.test(encoding) ? 'pass' : 'warn', /gzip|br|zstd|deflate/.test(encoding) ? `Compressed (${encoding})` : 'Not compressed', '', /gzip|br|zstd|deflate/.test(encoding) ? '' : 'Turn on gzip or Brotli compression on the server or CDN.');
  if (page.scripts > 25) add('scripts', 'speed', 'low', 'warn', `${page.scripts} script files`, '', 'Bundle or defer scripts; each one delays the page on slow phones.');
  if (!page.charset) add('charset', 'speed', 'low', 'warn', 'No character set declared', '', 'Add <meta charset="utf-8"> at the top of the <head>.');
  return out;
}

// 0–100: each check costs its importance when failed and half of it when only a warning.
export function scoreOf(checks) {
  const total = checks.reduce((n, c) => n + IMPORTANCE[c.importance], 0);
  if (!total) return 0;
  const lost = checks.reduce((n, c) => n + IMPORTANCE[c.importance] * WEIGHT[c.level], 0);
  return Math.round(100 * (1 - lost / total));
}

export function areaScores(checks) {
  return Object.fromEntries(Object.keys(AREAS).map((a) => [a, scoreOf(checks.filter((c) => c.area === a))]));
}

// ------------------------------------------------------------------ keywords

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

// Where a keyword appears on the page, and how often in the text (density in %).
export function keywordReport(page, url, keyword) {
  const k = norm(keyword).trim();
  const has = (s) => Boolean(k) && norm(s).includes(k);
  const slug = (() => {
    try {
      return decodeURIComponent(new URL(url).pathname).replace(/[-_/]+/g, ' ');
    } catch {
      return '';
    }
  })();
  const body = norm(page.text);
  const count = k ? body.split(k).length - 1 : 0;
  const wordsInKey = k.split(/\s+/).filter(Boolean).length || 1;
  const density = page.words ? Math.round(((count * wordsInKey) / page.words) * 1000) / 10 : 0;
  const first100 = has(page.text.split(/\s+/).slice(0, 100).join(' '));
  const places = { title: has(page.title), description: has(page.description), h1: page.headings.h1.some(has), h2: page.headings.h2.some(has), url: has(slug), intro: first100 };
  const found = Object.values(places).filter(Boolean).length;
  return { keyword, count, density, ...places, score: Math.round((found / 6) * 100), stuffing: density > 4 };
}

// ------------------------------------------------------------------ robots.txt

// Does robots.txt let Googlebot (or, failing a Googlebot group, every crawler) fetch `path`? The
// longest matching Allow / Disallow rule wins, as Google reads it; * and $ are supported.
export function robotsAllows(robotsTxt, path) {
  if (!robotsTxt) return true;
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const raw of String(robotsTxt).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'user-agent') {
      if (!lastWasAgent) groups.push((current = { agents: [], rules: [] }));
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (current && (key === 'allow' || key === 'disallow')) current.rules.push({ allow: key === 'allow', path: value });
    }
  }
  const group = groups.find((g) => g.agents.some((a) => a === 'googlebot')) || groups.find((g) => g.agents.includes('*'));
  if (!group) return true;
  const toRe = (p) => new RegExp(`^${p.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$').replace(/\$$/, '$')}`);
  let best = null;
  for (const r of group.rules) {
    if (!r.path) continue;
    if (toRe(r.path).test(path) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
  }
  return best ? best.allow : true;
}

export const sitemapsIn = (robotsTxt) => [...String(robotsTxt || '').matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)].map((m) => m[1]).slice(0, 5);
