import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attrs, auditPage, cleanKeywords, cleanSite, keywordReport, readPage, robotsAllows, scoreOf, sitemapsIn } from './seo-model.mjs';

const GOOD = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Lyrtrip · Cheap flights and hotels in Bangladesh</title>
<meta name="description" content="Book cheap flights, hotels and holiday packages from Dhaka with Lyrtrip. Compare fares, pay with bKash and travel today.">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="canonical" href="https://lyrtrip.com/">
<link rel="icon" href="/favicon.ico">
<meta property="og:title" content="Lyrtrip"><meta property="og:description" content="Cheap flights"><meta property="og:image" content="https://lyrtrip.com/og.png">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"TravelAgency","name":"Lyrtrip"}</script>
</head><body><h1>Cheap flights from Dhaka</h1><h2>Hotels</h2>
<p>${'Cheap flights and hotels for every trip. '.repeat(60)}</p>
<a href="/hotels">Hotels</a><a href="https://example.com" rel="nofollow">Partner</a>
<img src="a.jpg" alt="Beach"><img src="b.jpg"><script>var x = "<h1>not a heading</h1>";</script></body></html>`;

const FETCH = { url: 'https://lyrtrip.com/', finalUrl: 'https://lyrtrip.com/', status: 200, ms: 400, ttfb: 300, bytes: 9000, headers: { 'content-encoding': 'br' }, redirects: [], robotsTxt: 'User-agent: *\nAllow: /', robotsBlocked: false, sitemap: 'https://lyrtrip.com/sitemap.xml' };

test('reads a page like a crawler', () => {
  const p = readPage(GOOD, 'https://lyrtrip.com/');
  assert.equal(p.title, 'Lyrtrip · Cheap flights and hotels in Bangladesh');
  assert.equal(p.headings.h1.length, 1, 'headings inside scripts are ignored');
  assert.equal(p.lang, 'en');
  assert.deepEqual(p.structured, ['TravelAgency']);
  assert.deepEqual(p.links, { internal: 1, external: 1, nofollow: 1 });
  assert.deepEqual([p.images.total, p.images.noAlt], [2, 1]);
  assert.ok(p.words > 300);
  assert.deepEqual(attrs(`<meta name=x content='a &amp; b' async>`), { name: 'x', content: 'a & b', async: '' });
});

test('a good page scores high, a bare one low, with a fix for each problem', () => {
  const good = auditPage(readPage(GOOD, FETCH.finalUrl), FETCH);
  assert.ok(scoreOf(good) >= 85, `good page scored ${scoreOf(good)}`);
  assert.equal(good.find((c) => c.id === 'alt').level, 'fail', 'half the images lack alt text');
  const bare = auditPage(readPage('<html><body><p>Hi</p></body></html>', 'http://x.com/'), { ...FETCH, finalUrl: 'http://x.com/', robotsTxt: null, sitemap: null, ttfb: 2500 });
  assert.ok(scoreOf(bare) < 40, `bare page scored ${scoreOf(bare)}`);
  for (const c of bare.filter((c) => c.level !== 'pass')) assert.ok(c.fix, `${c.id} has a fix`);
  const blocked = auditPage(readPage(GOOD.replace('<meta charset="utf-8">', '<meta charset="utf-8"><meta name="robots" content="noindex">'), FETCH.finalUrl), FETCH);
  assert.equal(blocked.find((c) => c.id === 'noindex').level, 'fail');
});

test('keywords: where they appear and how often', () => {
  const r = keywordReport(readPage(GOOD, FETCH.finalUrl), 'https://lyrtrip.com/cheap-flights', 'Cheap flights');
  assert.deepEqual([r.title, r.description, r.h1, r.url, r.intro], [true, true, true, true, true]);
  assert.equal(r.stuffing, true, 'repeated 60 times is stuffing');
  assert.equal(keywordReport(readPage(GOOD, FETCH.finalUrl), FETCH.finalUrl, 'visa').count, 0);
  assert.deepEqual(cleanKeywords('Flights, flights\nHotels'), ['flights', 'hotels']);
});

test('robots.txt and sites', () => {
  const robots = 'User-agent: *\nDisallow: /admin\nAllow: /admin/help\n\nUser-agent: BadBot\nDisallow: /\nSitemap: https://x.com/s.xml';
  assert.equal(robotsAllows(robots, '/admin/users'), false);
  assert.equal(robotsAllows(robots, '/admin/help/a'), true);
  assert.equal(robotsAllows(robots, '/'), true);
  assert.equal(robotsAllows('User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nAllow: /', '/x'), false);
  assert.deepEqual(sitemapsIn(robots), ['https://x.com/s.xml']);
  assert.equal(cleanSite({ url: 'lyrtrip.com' }).name, 'lyrtrip.com');
  assert.throws(() => cleanSite({ url: 'http://192.168.0.1' }));
});
