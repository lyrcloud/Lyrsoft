// Lyrsoft SEO routes (#/w/<ws>/seo in the app), mounted on the work API (index.mjs) after Performance &
// maintenance. A workspace lists its sites (any page address) with the keywords it wants to be found
// for. An audit fetches the page from Lyrsoft's servers like a crawler, with robots.txt and the XML
// sitemap, and scores it (seo-model.mjs): content, indexing, links and images, social cards and
// structured data, speed. Every audit is kept (the last AUDITS_KEPT per site) so the score's trend shows.
//
// Who: workspace owners and admins, plus the people named in its settings. Owners and admins add sites.
//
//   GET    /workspaces/{ws}/seo                       sites with their latest score, settings
//   PATCH  /workspaces/{ws}/seo/settings              { viewers }
//   POST   /workspaces/{ws}/seo/check                 { url, keyword? } one-off audit, not saved
//   POST   /workspaces/{ws}/seo/sites                 { name, url, keywords } add (audited straight away)
//   GET    /workspaces/{ws}/seo/sites/{id}            site, latest audit in full, score history
//   PATCH  /workspaces/{ws}/seo/sites/{id}            { name?, url?, keywords? }
//   DELETE /workspaces/{ws}/seo/sites/{id}
//   POST   /workspaces/{ws}/seo/sites/{id}/audit      audit now
//
// Keys in the work table:
//   SEO#<ws>  SETTINGS              viewers
//   SEO#<ws>  SITE#<id>             site + latest summary (score, area scores, counts)
//   SEO#<ws>  AUDIT#<id>#<at>       one audit: checks, page facts, keyword reports
import { lookup } from 'node:dns/promises';
import { isPrivateAddress, cleanUrl } from './ops-model.mjs';
import { ValidationError } from './model.mjs';
import { areaScores, auditPage, AREAS, AUDITS_KEPT, cleanSeoSettings, cleanSite, keywordReport, MAX_SITES, readPage, robotsAllows, scoreOf, sitemapsIn } from './seo-model.mjs';

const UA = 'LyrsoftSEO/1.0 (+https://lyrsoft.com/app/)';
const MAX_HTML = 4 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const AUDITS_PER_HOUR = 60;

export function registerSeoRoutes(route, { db, HttpError, openWorkspace, now, newId, countUse }) {
  const { get, put, del, queryAll } = db;
  const pk = (ws) => `SEO#${ws}`;
  const strip = ({ PK, SK, ...rest }) => rest;
  const prefix = (PK, sk) => queryAll({ KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)', ExpressionAttributeValues: { ':pk': PK, ':sk': sk } });
  const clean = (fn) => {
    try {
      return fn();
    } catch (error) {
      if (error instanceof ValidationError || error instanceof Error) throw new HttpError(400, error.message);
      throw error;
    }
  };

  async function access(me, ws) {
    const { workspace, role } = await openWorkspace(me, ws, 'view');
    const settings = cleanSeoSettings({}, (await get(pk(ws), 'SETTINGS')) || {});
    const admin = ['owner', 'admin'].includes(role);
    if (!admin && !settings.viewers.includes(me.email)) throw new HttpError(403, 'SEO is open to workspace owners and admins, and to people they add in its settings.');
    return { workspace, admin, settings };
  }

  // ---------------------------------------------------------------- fetching like a crawler

  async function assertPublicHost(host) {
    const bare = host.replace(/^\[|\]$/g, '');
    const addresses = /^[\d.]+$/.test(bare) || bare.includes(':') ? [{ address: bare }] : await lookup(bare, { all: true });
    if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) throw new Error('That address points to a private network.');
  }

  // GET with redirects followed by hand, so every hop is checked to be on the public internet.
  async function fetchPublic(startUrl, { maxBytes = MAX_HTML, timeoutMs = 15000, accept = 'text/html,application/xhtml+xml,*/*;q=0.8' } = {}) {
    const started = Date.now();
    const redirects = [];
    let url = startUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Redirected to an address that isn’t http or https.');
      await assertPublicHost(parsed.hostname);
      const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': UA, accept, 'accept-encoding': 'gzip, deflate, br' } });
      const ttfb = Date.now() - started;
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        await res.body?.cancel();
        redirects.push(`${res.status} ${url}`);
        url = cleanUrl(new URL(res.headers.get('location'), url).href);
        continue;
      }
      const headers = Object.fromEntries([...res.headers].map(([k, v]) => [k.toLowerCase(), v]));
      let bytes = 0;
      const chunks = [];
      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (bytes <= maxBytes) chunks.push(value);
          else {
            await reader.cancel();
            break;
          }
        }
      }
      return { url: startUrl, finalUrl: url, status: res.status, headers, body: Buffer.concat(chunks).toString('utf8'), bytes, ttfb, ms: Date.now() - started, redirects };
    }
    throw new Error(`More than ${MAX_REDIRECTS} redirects.`);
  }

  const reason = (error) => {
    const code = error?.cause?.code || error?.code || '';
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'Timed out after 15 seconds';
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'Domain not found (DNS)';
    if (code === 'ECONNREFUSED') return 'Connection refused';
    if (/CERT|SSL|TLS/i.test(code)) return `SSL problem (${code})`;
    return String(error?.message || 'Request failed').slice(0, 160);
  };

  // Fetches the page, robots.txt and the sitemap, and scores it.
  async function audit(url, keywords = []) {
    let page;
    let res;
    try {
      res = await fetchPublic(url);
    } catch (error) {
      res = { url, finalUrl: url, status: 0, headers: {}, body: '', bytes: 0, ttfb: 0, ms: 0, redirects: [], error: reason(error) };
    }
    const type = String(res.headers['content-type'] || '');
    if (res.status && type && !/html|xml/i.test(type)) res.error = `Not a web page (${type.split(';')[0]})`;
    page = readPage(res.body, res.finalUrl);
    const origin = new URL(res.finalUrl).origin;
    let robotsTxt = null;
    try {
      const r = await fetchPublic(`${origin}/robots.txt`, { maxBytes: 500_000, timeoutMs: 8000, accept: 'text/plain,*/*' });
      if (r.status === 200 && !/html/i.test(r.headers['content-type'] || '')) robotsTxt = r.body;
    } catch {}
    let sitemap = null;
    for (const candidate of [...sitemapsIn(robotsTxt), `${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`]) {
      try {
        const s = await fetchPublic(cleanUrl(candidate), { maxBytes: 200_000, timeoutMs: 8000, accept: 'application/xml,text/xml,*/*' });
        if (s.status === 200 && /<(urlset|sitemapindex)\b/i.test(s.body)) {
          sitemap = s.finalUrl;
          break;
        }
      } catch {}
    }
    const path = (() => {
      const u = new URL(res.finalUrl);
      return `${u.pathname}${u.search}`;
    })();
    const facts = { ...res, body: undefined, robotsTxt, robotsBlocked: !robotsAllows(robotsTxt, path), sitemap };
    const checks = auditPage(page, facts);
    const { text, ...pageFacts } = page;
    return {
      at: now(),
      url,
      finalUrl: res.finalUrl,
      status: res.status,
      error: res.error || '',
      ms: res.ms,
      ttfb: res.ttfb,
      bytes: res.bytes,
      redirects: res.redirects,
      sitemap,
      robotsTxt: robotsTxt !== null,
      score: scoreOf(checks),
      areas: areaScores(checks),
      counts: { fail: checks.filter((c) => c.level === 'fail').length, warn: checks.filter((c) => c.level === 'warn').length, pass: checks.filter((c) => c.level === 'pass').length },
      checks,
      page: pageFacts,
      keywords: keywords.map((k) => keywordReport(page, res.finalUrl, k)),
    };
  }

  async function limit(me) {
    if (countUse && (await countUse(`seo#${me.userId}`, 'hour')) > AUDITS_PER_HOUR) throw new HttpError(429, 'That’s a lot of audits this hour. Try again in a little while.');
  }

  const summary = (a) => ({ at: a.at, score: a.score, areas: a.areas, counts: a.counts, status: a.status, error: a.error, ms: a.ms });

  async function auditSite(ws, site) {
    const result = await audit(site.url, site.keywords);
    await put({ PK: pk(ws), SK: `AUDIT#${site.id}#${result.at}`, siteId: site.id, ...result });
    const history = [...(site.history || []), { at: result.at, score: result.score }].slice(-AUDITS_KEPT);
    const next = { ...site, last: summary(result), history };
    await put({ PK: pk(ws), SK: `SITE#${site.id}`, ...next });
    const audits = await prefix(pk(ws), `AUDIT#${site.id}#`);
    for (const old of audits.slice(0, Math.max(0, audits.length - AUDITS_KEPT))) await del(old.PK, old.SK);
    return { site: next, audit: result };
  }

  async function openSite(ws, id) {
    const row = /^[\w-]{4,40}$/.test(String(id)) ? await get(pk(ws), `SITE#${id}`) : null;
    if (!row) throw new HttpError(404, 'Site not found.');
    return strip(row);
  }

  // ---------------------------------------------------------------- routes

  route('GET', '/workspaces/{ws}/seo', async (me, { ws }) => {
    const { admin, settings } = await access(me, ws);
    const sites = (await prefix(pk(ws), 'SITE#')).map(strip).sort((a, b) => a.name.localeCompare(b.name));
    return { admin, settings: admin ? settings : { viewers: [] }, sites, areas: AREAS, maxSites: MAX_SITES };
  });

  route('PATCH', '/workspaces/{ws}/seo/settings', async (me, { ws }, body) => {
    const { admin, settings } = await access(me, ws);
    if (!admin) throw new HttpError(403, 'Only workspace owners and admins change who can see SEO.');
    const next = cleanSeoSettings(body, settings);
    await put({ PK: pk(ws), SK: 'SETTINGS', ...next });
    return { settings: next };
  });

  route('POST', '/workspaces/{ws}/seo/check', async (me, { ws }, body) => {
    await access(me, ws);
    await limit(me);
    const url = clean(() => cleanUrl(body.url));
    const keyword = String(body.keyword || '').trim().slice(0, 80);
    return { audit: await audit(url, keyword ? [keyword] : []) };
  });

  route('POST', '/workspaces/{ws}/seo/sites', async (me, { ws }, body) => {
    const { admin } = await access(me, ws);
    if (!admin) throw new HttpError(403, 'Only workspace owners and admins add sites.');
    const existing = await prefix(pk(ws), 'SITE#');
    if (existing.length >= MAX_SITES) throw new HttpError(400, `Up to ${MAX_SITES} sites per workspace.`);
    const site = { ...clean(() => cleanSite(body)), id: newId(), createdAt: now(), createdBy: me.email, history: [] };
    if (existing.some((s) => s.url === site.url)) throw new HttpError(409, 'That address is already in the list.');
    await put({ PK: pk(ws), SK: `SITE#${site.id}`, ...site });
    await limit(me);
    return [201, await auditSite(ws, site)];
  });

  route('GET', '/workspaces/{ws}/seo/sites/{id}', async (me, { ws, id }) => {
    await access(me, ws);
    const site = await openSite(ws, id);
    const audits = await prefix(pk(ws), `AUDIT#${site.id}#`);
    const latest = audits.at(-1);
    return { site, audit: latest ? strip(latest) : null };
  });

  route('PATCH', '/workspaces/{ws}/seo/sites/{id}', async (me, { ws, id }, body) => {
    const { admin } = await access(me, ws);
    const site = await openSite(ws, id);
    // Viewers may tune keywords; only owners and admins change the name or address.
    const changes = admin ? body : { keywords: body.keywords };
    const next = { ...clean(() => cleanSite(changes, site)), updatedAt: now() };
    await put({ PK: pk(ws), SK: `SITE#${site.id}`, ...next });
    return { site: next };
  });

  route('DELETE', '/workspaces/{ws}/seo/sites/{id}', async (me, { ws, id }) => {
    const { admin } = await access(me, ws);
    if (!admin) throw new HttpError(403, 'Only workspace owners and admins remove sites.');
    const site = await openSite(ws, id);
    for (const a of await prefix(pk(ws), `AUDIT#${site.id}#`)) await del(a.PK, a.SK);
    await del(pk(ws), `SITE#${site.id}`);
    return { deleted: true };
  });

  route('POST', '/workspaces/{ws}/seo/sites/{id}/audit', async (me, { ws, id }) => {
    await access(me, ws);
    await limit(me);
    return auditSite(ws, await openSite(ws, id));
  });
}
