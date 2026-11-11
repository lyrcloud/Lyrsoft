// Lyrsoft SEO (#/w/<ws>/seo[/<tab>] and #/w/<ws>/seo/site/<id>), plugged into app.js after Performance &
// maintenance. A workspace's sites with their keywords; each audit reads the page like a search engine
// (api/work/seo.mjs) and returns a 0–100 score, five area scores and a checklist with a fix for every
// problem. Quick check audits any address once without saving it.
import { lineChart, mountCharts } from './charts.js';

const TABS = [
  ['overview', '🔎 Sites'],
  ['check', '⚡ Quick check'],
  ['settings', '⚙ Access'],
];
// Never colour alone: each level has a symbol and a word.
const LEVEL = { fail: { icon: '✕', label: 'Fix', cls: 'seo-fail' }, warn: { icon: '▲', label: 'Improve', cls: 'seo-warn' }, pass: { icon: '✓', label: 'Good', cls: 'seo-pass' } };
const grade = (n) => (n == null ? '' : n >= 90 ? 'seo-pass' : n >= 70 ? 'seo-warn' : 'seo-fail');
const gradeWord = (n) => (n == null ? 'Not audited' : n >= 90 ? 'Great' : n >= 70 ? 'Needs work' : 'Poor');

export function createSeo({ api, esc, toast, render, go }) {
  const s = { ws: null, data: null, detail: null, quick: null, busy: new Set(), checking: false };
  let route = null;

  const base = () => `#/w/${encodeURIComponent(s.ws)}/seo`;
  const path = (p = '') => `/workspaces/${encodeURIComponent(s.ws)}/seo${p}`;
  const tab = () => (route?.tab === 'site' && route.id ? 'site' : TABS.some(([id]) => id === route?.tab) ? route.tab : 'overview');
  const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
  const host = (url) => {
    try {
      const u = new URL(url);
      return `${u.host}${u.pathname === '/' ? '' : u.pathname}`;
    } catch {
      return url;
    }
  };

  async function load(next) {
    route = next;
    if (next.view !== 'seo') return;
    if (s.ws !== next.ws) Object.assign(s, { ws: next.ws, data: null, detail: null, quick: null });
    const wantSite = next.tab === 'site' && next.id;
    const [data, detail] = await Promise.all([api('GET', path()), wantSite ? api('GET', path(`/sites/${encodeURIComponent(next.id)}`)) : null]);
    s.data = data;
    s.detail = detail;
  }
  const ready = (r) => r.view !== 'seo' || Boolean(s.data && s.ws === r.ws && (!(r.tab === 'site' && r.id) || s.detail?.site.id === r.id));
  const refresh = async () => {
    await load(route);
    render();
  };

  // A score as a ring with its number and word.
  const ring = (n, size = '') => `<span class="seo-ring ${grade(n)} ${size}" style="--p:${n ?? 0}" role="img" aria-label="SEO score ${n ?? 'not audited'} of 100"><b>${n ?? '—'}</b></span>`;

  function view() {
    const t = tab();
    setTimeout(() => mountCharts(document.querySelector('.seo')));
    return `<div class="seo">
      <div class="page-head"><div><h1>SEO</h1><p>How search engines see your sites: a score, what to fix first, and how your keywords show up on each page.</p></div>
        ${s.data.admin ? '<div class="row"><button class="btn primary" data-click="seo-site">+ Add site or page</button></div>' : ''}</div>
      <nav class="segmented hr-tabs" aria-label="SEO">${TABS.map(([id, label]) => `<a href="${base()}/${id}"${t === id || (t === 'site' && id === 'overview') ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>
      <div class="hr-body">${{ overview: overviewView, site: siteView, check: checkView, settings: settingsView }[t]()}</div></div>`;
  }

  // ---------------------------------------------------------------- sites

  function overviewView() {
    const sites = s.data.sites;
    if (!sites.length) {
      return `<section class="panel hr-welcome"><h2>Get found on Google</h2><ol>
        <li><b>Add your website</b> (or any page) and the <b>keywords</b> people search to find you.</li>
        <li>Lyrsoft reads it like a search engine: title, description, headings, links, images, robots.txt, sitemap, social cards, structured data and speed.</li>
        <li>You get a <b>score out of 100</b> and a checklist with <b>what to fix first</b>, and each keyword’s placement on the page.</li>
        <li>Fix, then press <b>Audit again</b> to see the score move. Every audit is kept so you can follow the trend.</li></ol>
        ${s.data.admin ? '<button class="btn primary" data-click="seo-site">+ Add site or page</button>' : '<p class="muted">Ask a workspace owner or admin to add the first site.</p>'}
        <p class="muted small">Want to try first? Use <a href="${base()}/check">Quick check</a> on any address.</p></section>`;
    }
    const audited = sites.filter((x) => x.last);
    const avg = audited.length ? Math.round(audited.reduce((n, x) => n + x.last.score, 0) / audited.length) : null;
    const fails = audited.reduce((n, x) => n + (x.last.counts?.fail || 0), 0);
    return `
      <div class="stat-row">
        <div class="panel stat hr-tile"><span>Average score</span><b class="${grade(avg)}">${avg ?? '—'}</b><small class="muted">${gradeWord(avg)}</small></div>
        <div class="panel stat hr-tile"><span>Sites and pages</span><b>${sites.length}<small class="muted"> / ${s.data.maxSites}</small></b><small class="muted">${audited.length} audited</small></div>
        <div class="panel stat hr-tile"><span>Problems to fix</span><b class="${fails ? 'seo-fail' : ''}">${fails}</b><small class="muted">across all sites</small></div>
      </div>
      <div class="seo-cards">${sites.map(card).join('')}</div>`;
  }

  function card(x) {
    const busy = s.busy.has(x.id);
    const a = x.last;
    return `<article class="panel seo-card">
      <a class="seo-card-head" href="${base()}/site/${esc(x.id)}">${ring(a?.score)}<span><b>${esc(x.name)}</b><small>${esc(host(x.url))}</small></span></a>
      ${a ? `<ul class="seo-areas">${Object.entries(s.data.areas).map(([k, label]) => `<li><span>${esc(label)}</span><i class="seo-bar ${grade(a.areas?.[k])}" style="--w:${a.areas?.[k] ?? 0}%" aria-hidden="true"></i><b>${a.areas?.[k] ?? '—'}</b></li>`).join('')}</ul>
        <p class="small">${a.error ? `<span class="seo-fail">✕ ${esc(a.error)}</span>` : `<span class="seo-fail">✕ ${a.counts.fail} to fix</span> · <span class="seo-warn">▲ ${a.counts.warn} to improve</span> · <span class="seo-pass">✓ ${a.counts.pass} good</span>`}</p>` : '<p class="muted">Not audited yet.</p>'}
      ${x.keywords?.length ? `<p class="seo-kw-list">${x.keywords.map((k) => `<span class="pill">${esc(k)}</span>`).join(' ')}</p>` : ''}
      <footer><span class="muted small">${a ? `Audited ${esc(when(a.at))}` : ''}</span><button class="btn small" data-click="seo-audit" data-id="${esc(x.id)}"${busy ? ' disabled' : ''}>${busy ? 'Auditing…' : '↻ Audit again'}</button></footer>
    </article>`;
  }

  // ---------------------------------------------------------------- one site

  function siteView() {
    const { site, audit } = s.detail;
    const busy = s.busy.has(site.id);
    const history = site.history || [];
    return `
      <p><a href="${base()}">← All sites</a></p>
      <section class="panel seo-hero">
        ${ring(audit?.score, 'big')}
        <div><h2>${esc(site.name)}</h2><p><a href="${esc(site.url)}" target="_blank" rel="noopener">${esc(site.url)}</a></p>
          <p class="muted small">${audit ? `Audited ${esc(when(audit.at))} · ${gradeWord(audit.score)}` : 'Not audited yet'}</p></div>
        <div class="row">
          <button class="btn primary" data-click="seo-audit" data-id="${esc(site.id)}"${busy ? ' disabled' : ''}>${busy ? 'Auditing…' : '↻ Audit again'}</button>
          <button class="btn" data-click="seo-site" data-id="${esc(site.id)}">✎ ${s.data.admin ? 'Edit' : 'Keywords'}</button>
        </div>
      </section>
      ${audit ? auditBody(audit, history) : ''}`;
  }

  // The audit itself: area scores, keywords, the checklist (worst first), page facts, trend, tools.
  function auditBody(audit, history = []) {
    const order = { fail: 0, warn: 1, pass: 2 };
    const imp = { high: 0, medium: 1, low: 2 };
    const checks = [...audit.checks].sort((a, b) => order[a.level] - order[b.level] || imp[a.importance] - imp[b.importance]);
    const p = audit.page;
    const enc = encodeURIComponent(audit.finalUrl);
    return `
      ${audit.error ? `<section class="panel seo-alert"><h2>✕ ${esc(audit.error)}</h2><p class="muted">The checks below are for what could be read. Fix this first.</p></section>` : ''}
      <div class="stat-row seo-area-row">${Object.entries(s.data.areas).map(([k, label]) => `<div class="panel stat hr-tile"><span>${esc(label)}</span><b class="${grade(audit.areas[k])}">${audit.areas[k]}</b></div>`).join('')}</div>
      ${audit.keywords?.length ? keywordsTable(audit.keywords) : ''}
      <section class="panel">
        <div class="panel-head"><h2>What to fix</h2><span class="muted small"><span class="seo-fail">✕ ${audit.counts.fail}</span> · <span class="seo-warn">▲ ${audit.counts.warn}</span> · <span class="seo-pass">✓ ${audit.counts.pass}</span></span></div>
        <ul class="seo-checks">${checks.map((c) => `
          <li class="${LEVEL[c.level].cls}">
            <span class="seo-level"><i aria-hidden="true">${LEVEL[c.level].icon}</i>${LEVEL[c.level].label}</span>
            <div><b>${esc(c.title)}</b> <small class="muted">${esc(s.data.areas[c.area] || '')}${c.level !== 'pass' ? ` · ${esc(c.importance)} impact` : ''}</small>
              ${c.detail ? `<p class="seo-detail">${esc(c.detail)}</p>` : ''}
              ${c.fix && c.level !== 'pass' ? `<p class="seo-fix">💡 ${esc(c.fix)}</p>` : ''}</div>
          </li>`).join('')}</ul>
      </section>
      ${history.length > 1 ? lineChart({ title: 'Score over time', sub: `Last ${history.length} audits`, labels: history.map((h) => new Date(h.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })), series: [{ name: 'Score', color: 'var(--viz-1)', values: history.map((h) => h.score) }], height: 200 }) : ''}
      <section class="panel">
        <h2>What a search engine sees</h2>
        <div class="seo-serp" aria-label="Search result preview">
          <small>${esc(host(audit.finalUrl))}</small>
          <b>${esc(p.title || '(no title)')}</b>
          <p>${esc(p.description || 'No description: Google will pick some text from the page.')}</p>
        </div>
        <dl class="seo-facts">
          <div><dt>Address read</dt><dd>${esc(audit.finalUrl)}${audit.redirects?.length ? ` <small class="muted">(after ${audit.redirects.length} redirect${audit.redirects.length > 1 ? 's' : ''})</small>` : ''}</dd></div>
          <div><dt>Status</dt><dd>${audit.status || '—'} · first byte ${Math.round(audit.ttfb)} ms · ${Math.round(audit.bytes / 1024)} KB</dd></div>
          <div><dt>Headings</dt><dd>H1 ${p.headings.h1.length} · H2 ${p.headings.h2.length} · H3 ${p.headings.h3.length}</dd></div>
          <div><dt>Text</dt><dd>${p.words} words · ${esc(p.lang || 'no language set')}</dd></div>
          <div><dt>Links</dt><dd>${p.links.internal} internal · ${p.links.external} external · ${p.links.nofollow} nofollow</dd></div>
          <div><dt>Images</dt><dd>${p.images.total} · ${p.images.noAlt} without alt</dd></div>
          <div><dt>Canonical</dt><dd>${esc(p.canonical || '—')}</dd></div>
          <div><dt>Robots</dt><dd>${esc(p.robots || 'index, follow (default)')} · robots.txt ${audit.robotsTxt ? 'found' : 'missing'}</dd></div>
          <div><dt>Sitemap</dt><dd>${audit.sitemap ? `<a href="${esc(audit.sitemap)}" target="_blank" rel="noopener">${esc(audit.sitemap)}</a>` : 'Not found'}</dd></div>
          <div><dt>Structured data</dt><dd>${esc(p.structured.join(', ') || (p.microdata ? 'microdata' : 'none'))}</dd></div>
        </dl>
        ${p.headings.h1.length || p.headings.h2.length ? `<details><summary>Headings on the page</summary><ul class="seo-outline">${p.headings.h1.map((h) => `<li><b>H1</b> ${esc(h)}</li>`).join('')}${p.headings.h2.map((h) => `<li class="h2"><b>H2</b> ${esc(h)}</li>`).join('')}</ul></details>` : ''}
      </section>
      <section class="panel">
        <h2>Go deeper</h2>
        <p class="muted small">Free tools from Google for what only Google knows: real rankings, clicks, Core Web Vitals and rich results.</p>
        <div class="row wrap">
          <a class="btn small" href="https://pagespeed.web.dev/analysis?url=${enc}" target="_blank" rel="noopener">⚡ PageSpeed Insights</a>
          <a class="btn small" href="https://search.google.com/test/rich-results?url=${enc}" target="_blank" rel="noopener">⭐ Rich Results Test</a>
          <a class="btn small" href="https://search.google.com/search-console" target="_blank" rel="noopener">📈 Search Console</a>
          <a class="btn small" href="https://www.google.com/search?q=${encodeURIComponent(`site:${new URL(audit.finalUrl).hostname}`)}" target="_blank" rel="noopener">🔎 Pages Google has indexed</a>
        </div>
      </section>`;
  }

  function keywordsTable(rows) {
    const yes = (v) => (v ? '<span class="seo-pass">✓</span>' : '<span class="seo-fail">✕</span>');
    return `<section class="panel">
      <div class="panel-head"><h2>Keywords on this page</h2></div>
      <div class="table-scroll"><table class="list-table seo-kw">
        <thead><tr><th>Keyword</th><th>Title</th><th>Description</th><th>H1</th><th>H2</th><th>Address</th><th>First 100 words</th><th>Times · density</th><th>Score</th></tr></thead>
        <tbody>${rows.map((k) => `<tr><td><b>${esc(k.keyword)}</b> <a class="small" href="https://www.google.com/search?q=${encodeURIComponent(k.keyword)}" target="_blank" rel="noopener" title="Search Google">↗</a></td><td>${yes(k.title)}</td><td>${yes(k.description)}</td><td>${yes(k.h1)}</td><td>${yes(k.h2)}</td><td>${yes(k.url)}</td><td>${yes(k.intro)}</td>
          <td>${k.count} · ${k.density}%${k.stuffing ? ' <span class="seo-warn" title="Over 4% reads as keyword stuffing">▲ too often</span>' : ''}</td><td><b class="${grade(k.score)}">${k.score}</b></td></tr>`).join('')}</tbody>
      </table></div>
      <p class="muted small">Put each keyword in the title, the H1 and early in the text, naturally. Around 1–2% of the words is plenty.</p>
    </section>`;
  }

  // ---------------------------------------------------------------- quick check

  function checkView() {
    return `
      <form class="panel seo-quick" data-form="seo-check">
        <h2>Check any page</h2>
        <p class="muted small">Audits the address once, without saving it. Good for a competitor’s page or a page you’re about to publish.</p>
        <div class="row wrap"><input name="url" required placeholder="https://example.com/page" aria-label="Page address" /><input name="keyword" placeholder="Keyword (optional)" aria-label="Keyword" maxlength="80" /><button class="btn primary"${s.checking ? ' disabled' : ''}>${s.checking ? 'Checking…' : 'Check'}</button></div>
      </form>
      ${s.quick ? `<section class="panel seo-hero">${ring(s.quick.score, 'big')}<div><h2>${esc(host(s.quick.finalUrl))}</h2><p class="muted small">${gradeWord(s.quick.score)} · checked ${esc(when(s.quick.at))}</p></div></section>${auditBody(s.quick)}` : ''}`;
  }

  // ---------------------------------------------------------------- settings

  function settingsView() {
    if (!s.data.admin) return '<section class="panel"><p class="muted">Only workspace owners and admins change who can see SEO.</p></section>';
    return `<form class="panel hr-settings" data-form="seo-settings">
      <h2>Access</h2>
      <label>Who else can see SEO<input name="viewers" value="${esc(s.data.settings.viewers.join(', '))}" placeholder="marketer@agency.com" /><small class="muted">Workspace owners and admins always can. People added here can audit and change keywords; only owners and admins add or remove sites.</small></label>
      <div class="row end"><button class="btn primary">Save</button></div>
    </form>`;
  }

  // ---------------------------------------------------------------- actions

  function siteDialog(site) {
    const admin = s.data.admin;
    const node = document.createElement('dialog');
    node.className = 'dialog hr-dialog';
    node.innerHTML = `<form><h2>${site ? `Edit ${esc(site.name)}` : 'Add a site or page'}</h2>
      ${admin ? `<label>Address<input name="url" required value="${esc(site?.url || '')}" placeholder="https://yourshop.com" /></label>
      <label>Name<input name="name" maxlength="80" value="${esc(site?.name || '')}" placeholder="Shop home page" /></label>` : ''}
      <label>Keywords people search to find it (one per line, up to 15)<textarea name="keywords" rows="4" placeholder="cheap flights dhaka&#10;hotel booking bangladesh">${esc((site?.keywords || []).join('\n'))}</textarea></label>
      <p class="auth-error" hidden></p>
      <div class="row end">${site && admin ? '<button type="button" class="btn danger" data-delete>Remove</button>' : ''}<span class="spacer"></span><button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">${site ? 'Save' : 'Add and audit'}</button></div></form>`;
    document.body.append(node);
    const form = node.querySelector('form');
    const fail = (err) => {
      const box = node.querySelector('.auth-error');
      box.textContent = err.message;
      box.hidden = false;
    };
    node.addEventListener('close', () => node.remove());
    node.querySelector('[data-cancel]').addEventListener('click', () => node.close());
    node.querySelector('[data-delete]')?.addEventListener('click', async () => {
      if (!confirm(`Remove ${site.name} and its audit history?`)) return;
      try {
        await api('DELETE', path(`/sites/${encodeURIComponent(site.id)}`));
        node.close();
        go(base());
      } catch (err) {
        fail(err);
      }
    });
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const submit = form.querySelector('button.primary');
      submit.disabled = true;
      submit.textContent = site ? 'Saving…' : 'Auditing…';
      try {
        const body = Object.fromEntries(new FormData(form));
        if (site) await api('PATCH', path(`/sites/${encodeURIComponent(site.id)}`), body);
        else {
          const out = await api('POST', path('/sites'), body);
          node.close();
          toast(`Score ${out.audit.score} / 100`);
          return go(`${base()}/site/${encodeURIComponent(out.site.id)}`);
        }
        node.close();
        refresh();
      } catch (err) {
        fail(err);
        submit.disabled = false;
        submit.textContent = site ? 'Save' : 'Add and audit';
      }
    });
    node.showModal();
  }

  const clickActions = {
    'seo-site': (t) => siteDialog(t.dataset.id ? (s.detail?.site.id === t.dataset.id ? s.detail.site : s.data.sites.find((x) => x.id === t.dataset.id)) : null),
    'seo-audit': async (t) => {
      const id = t.dataset.id;
      s.busy.add(id);
      render();
      try {
        const out = await api('POST', path(`/sites/${encodeURIComponent(id)}/audit`));
        toast(`${out.site.name}: ${out.audit.score} / 100`);
      } catch (err) {
        toast(err.message);
      }
      s.busy.delete(id);
      refresh();
    },
  };

  const formActions = {
    'seo-check': async (form) => {
      const body = Object.fromEntries(new FormData(form));
      s.checking = true;
      render();
      try {
        s.quick = (await api('POST', path('/check'), body)).audit;
      } catch (err) {
        toast(err.message);
      }
      s.checking = false;
      render();
      const input = document.querySelector('.seo-quick [name=url]');
      if (input) input.value = body.url;
      const kw = document.querySelector('.seo-quick [name=keyword]');
      if (kw) kw.value = body.keyword || '';
    },
    'seo-settings': async (form) => {
      try {
        await api('PATCH', path('/settings'), { viewers: form.querySelector('[name=viewers]').value });
        toast('Saved');
        refresh();
      } catch (err) {
        toast(err.message);
      }
    },
  };

  return { load, ready, view, clickActions, changeActions: {}, inputActions: {}, formActions };
}
