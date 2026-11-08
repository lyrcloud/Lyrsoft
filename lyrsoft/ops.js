// Lyrsoft Performance & maintenance (#/w/<ws>/ops[/<tab>] and #/w/<ws>/ops/monitor/<id>?range=),
// plugged into app.js like finance.js. Uptime and speed of a workspace's websites, web apps and APIs,
// SSL and domain expiry, incidents, planned maintenance windows and a maintenance checklist.
import { columnChart, lineChart, mountCharts } from './charts.js';

const TABS = [
  ['overview', '🩺 Status'],
  ['incidents', '🚨 Incidents'],
  ['maintenance', '🛠 Maintenance'],
  ['settings', '⚙ Alerts & access'],
];
// Status is never colour alone: each has its own symbol and word.
const STATUS = {
  up: { label: 'Up', icon: '●', cls: 'ops-up' },
  slow: { label: 'Slow', icon: '▲', cls: 'ops-slow' },
  down: { label: 'Down', icon: '✕', cls: 'ops-down' },
  maintenance: { label: 'Maintenance', icon: '🛠', cls: 'ops-maint' },
  paused: { label: 'Paused', icon: '❚❚', cls: 'ops-paused' },
  new: { label: 'Checking…', icon: '○', cls: 'ops-paused' },
};
const RANGES = ['24h', '7d', '30d', '90d'];

export function createOps({ api, esc, toast, render, go }) {
  const o = { ws: null, data: null, detail: null, busy: new Set() };
  let route = null;

  const base = () => `#/w/${encodeURIComponent(o.ws)}/ops`;
  const path = (p = '') => `/workspaces/${encodeURIComponent(o.ws)}/ops${p}`;
  const d = () => o.data;
  const tab = () => (route?.tab === 'monitor' && route.id ? 'monitor' : TABS.some(([id]) => id === route?.tab) ? route.tab : 'overview');
  const badge = (s) => {
    const x = STATUS[s] || STATUS.new;
    return `<span class="ops-badge ${x.cls}"><i aria-hidden="true">${x.icon}</i>${x.label}</span>`;
  };
  const pct = (v) => (v == null ? '—' : `${v >= 99.995 ? '100' : v.toFixed(2)}%`);
  const ms = (v) => (v == null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`);
  const size = (b) => (!b ? '—' : b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
  const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
  const ago = (iso) => {
    if (!iso) return 'never';
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
  };
  const daysLeft = (iso) => (iso ? Math.floor((Date.parse(iso) - Date.now()) / 86400000) : null);
  const duration = (from, to) => {
    const m = Math.max(1, Math.round(((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 60000));
    return m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`;
  };
  const host = (url) => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  };
  const monName = (id) => d().monitors.find((m) => m.id === id)?.name || 'Removed monitor';
  const expiry = (label, iso, warn) => {
    const n = daysLeft(iso);
    if (n == null) return `<em class="ops-exp-item muted">${esc(label)}: unknown</em>`;
    return `<em class="ops-exp-item ${n < 0 ? 'ops-txt-down' : n <= warn ? 'ops-txt-slow' : ''}">${esc(label)}: ${n < 0 ? 'expired' : `${n} days`}</em>`;
  };

  async function load(next) {
    route = next;
    if (next.view !== 'ops') return;
    if (o.ws !== next.ws) Object.assign(o, { ws: next.ws, data: null, detail: null });
    const wantDetail = next.tab === 'monitor' && next.id;
    const range = RANGES.includes(next.params.get('range')) ? next.params.get('range') : '24h';
    const [data, detail] = await Promise.all([api('GET', path()), wantDetail ? api('GET', path(`/monitors/${encodeURIComponent(next.id)}?range=${range}`)) : null]);
    o.data = data;
    o.detail = detail;
  }
  const ready = (r) => r.view !== 'ops' || Boolean(o.data && o.ws === r.ws && (!(r.tab === 'monitor' && r.id) || o.detail?.monitor.id === r.id));
  const refresh = async () => {
    await load(route);
    render();
  };

  // Live page: re-read every minute while it's open, so checks from the tick show up.
  let timer = null;
  function keepFresh() {
    clearInterval(timer);
    timer = setInterval(() => {
      if (route?.view !== 'ops' || document.hidden || document.querySelector('dialog[open]')) return;
      if (!document.querySelector('.ops')) return clearInterval(timer);
      refresh().catch(() => {});
    }, 60000);
  }

  // ---------------------------------------------------------------- shell

  function view() {
    const t = tab();
    keepFresh();
    setTimeout(() => mountCharts(document.querySelector('.ops')));
    const counts = countsOf();
    return `<div class="ops">
      <div class="page-head"><div><h1>Performance &amp; maintenance</h1><p>Uptime and speed of your websites, apps and APIs, with incidents, planned maintenance and the upkeep checklist.</p></div>
        ${d().admin ? '<div class="row"><button class="btn primary" data-click="ops-monitor">+ Add site or app</button></div>' : ''}</div>
      <nav class="segmented hr-tabs" aria-label="Performance and maintenance">${TABS.map(([id, label]) => `<a href="${base()}/${id}"${t === id || (t === 'monitor' && id === 'overview') ? ' aria-current="page"' : ''}>${label}${id === 'incidents' && counts.open ? ` <span class="count">${counts.open}</span>` : id === 'maintenance' && counts.overdue ? ` <span class="count">${counts.overdue}</span>` : ''}</a>`).join('')}</nav>
      <div class="hr-body">${{ overview: overviewView, monitor: monitorView, incidents: incidentsView, maintenance: maintenanceView, settings: settingsView }[t]()}</div></div>`;
  }

  function countsOf() {
    const ms_ = d().monitors;
    return {
      up: ms_.filter((m) => m.status === 'up').length,
      slow: ms_.filter((m) => m.status === 'slow').length,
      down: ms_.filter((m) => m.status === 'down').length,
      other: ms_.filter((m) => !['up', 'slow', 'down'].includes(m.status)).length,
      open: d().incidents.filter((i) => !i.resolvedAt).length,
      overdue: d().tasks.filter((t) => !t.done && t.due < d().today).length,
    };
  }

  // The last checks as a strip of bars: height is response time, colour and gap mark failures.
  function strip(recent = [], slowMs = 2000) {
    if (!recent.length) return '<div class="ops-strip empty"><span class="muted small">No checks yet</span></div>';
    const max = Math.max(slowMs, ...recent.map((c) => c.ms || 0));
    const cells = Array.from({ length: 60 - recent.length }, () => '<i class="none"></i>').join('') + recent.map((c) => `<i class="${STATUS[c.s]?.cls || ''}" style="--h:${c.s === 'down' || c.s === 'maintenance' ? 100 : Math.max(12, Math.round(((c.ms || 0) / max) * 100))}%" title="${esc(when(c.at))} · ${esc(STATUS[c.s]?.label || c.s)}${c.s === 'down' ? '' : ` · ${ms(c.ms)}`}${c.code ? ` · HTTP ${c.code}` : ''}"></i>`).join('');
    return `<div class="ops-strip" role="img" aria-label="Last ${recent.length} checks: ${recent.filter((c) => c.s === 'down').length} failed">${cells}</div>`;
  }

  // ---------------------------------------------------------------- status

  function overviewView() {
    const list = d().monitors;
    if (!list.length) {
      return `<section class="panel hr-welcome"><h2>Watch your sites and apps</h2><ol>
        <li><b>Add a website, web app or API</b> with its address. Lyrsoft checks it every few minutes from its servers.</li>
        <li>See <b>uptime, response time and page size</b>, plus when the <b>SSL certificate</b> and <b>domain</b> expire.</li>
        <li>When it goes down, an <b>incident</b> opens and the people in <a href="${base()}/settings">Alerts &amp; access</a> get an email; another when it’s back.</li>
        <li>Plan <b>maintenance windows</b> so planned downtime doesn’t count, and keep the <a href="${base()}/maintenance">maintenance checklist</a> (backups, updates, renewals) on schedule.</li></ol>
        ${d().admin ? '<button class="btn primary" data-click="ops-monitor">+ Add site or app</button>' : '<p class="muted">Ask a workspace owner or admin to add the first one.</p>'}</section>
        ${upcomingBlocks()}`;
    }
    const c = countsOf();
    const active = list.filter((m) => !m.paused);
    const avg = (k) => {
      const v = active.map((m) => m[k]).filter((x) => x != null);
      return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
    };
    const expiring = list.flatMap((m) => [
      ...(m.ssl?.validTo && daysLeft(m.ssl.validTo) <= d().expiryWarnDays ? [{ m, what: 'SSL certificate', at: m.ssl.validTo }] : []),
      ...(m.domain?.expiresAt && daysLeft(m.domain.expiresAt) <= d().expiryWarnDays * 2 ? [{ m, what: `Domain ${m.domain.name}`, at: m.domain.expiresAt }] : []),
    ]);
    const open = d().incidents.filter((i) => !i.resolvedAt);
    const allGood = !c.down && !open.length;
    return `
      <div class="ops-banner ${c.down ? 'bad' : c.slow ? 'warn' : 'good'}" role="status"><b>${c.down ? `✕ ${c.down} of ${list.length} down` : c.slow ? `▲ ${c.slow} slow, the rest up` : allGood && c.up ? '● All systems up' : '○ Waiting for the first checks'}</b><span class="muted">Checked from Lyrsoft’s servers · refreshes every minute</span></div>
      <div class="stat-row">
        <div class="panel stat hr-tile"><span>Up</span><b>${c.up + c.slow}<small class="muted"> / ${list.length}</small></b><small class="muted">${c.slow ? `${c.slow} slow` : 'all fast'}${c.other ? ` · ${c.other} paused or new` : ''}</small></div>
        <div class="panel stat hr-tile"><span>Uptime · 30 days</span><b>${pct(avg('uptime30d'))}</b><small class="muted">7 days: ${pct(avg('uptime7d'))}</small></div>
        <div class="panel stat hr-tile"><span>Avg response · 7 days</span><b>${ms(avg('avgMs7d'))}</b><small class="muted">across ${active.length} monitor${active.length === 1 ? '' : 's'}</small></div>
        <div class="panel stat hr-tile"><span>Open incidents</span><b class="${open.length ? 'ops-txt-down' : ''}">${open.length}</b><small><a href="${base()}/incidents">${d().incidents.length} in history</a></small></div>
        <div class="panel stat hr-tile"><span>Maintenance due</span><b class="${c.overdue ? 'ops-txt-slow' : ''}">${d().tasks.filter((t) => !t.done && t.due <= addDays(d().today, 7)).length}</b><small><a href="${base()}/maintenance">${c.overdue ? `${c.overdue} overdue` : 'this week'}</a></small></div>
      </div>
      ${expiring.length ? `<section class="panel ops-warn"><h2>⚠ Renew soon</h2><ul class="fin-list">${expiring.map((x) => `<li><span>${esc(x.what)} · <a href="${base()}/monitor/${esc(x.m.id)}">${esc(x.m.name)}</a></span><b>${daysLeft(x.at) < 0 ? 'expired' : `${daysLeft(x.at)} days`} · ${esc(x.at.slice(0, 10))}</b></li>`).join('')}</ul></section>` : ''}
      ${upcomingBlocks()}
      <div class="ops-cards">${list.map(card).join('')}</div>`;
  }

  const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

  function upcomingBlocks() {
    const nowIso = d().now;
    const live = d().windows.filter((w) => w.startsAt <= nowIso && w.endsAt > nowIso);
    const soon = d().windows.filter((w) => w.startsAt > nowIso && w.startsAt < new Date(Date.parse(nowIso) + 7 * 86400000).toISOString());
    if (!live.length && !soon.length) return '';
    return `<section class="panel ops-maint-note">${[...live.map((w) => `<p>🛠 <b>Maintenance now:</b> ${esc(w.title)} until ${esc(when(w.endsAt))} · ${w.monitorIds?.length ? esc(w.monitorIds.map(monName).join(', ')) : 'all monitors'}</p>`), ...soon.map((w) => `<p>🗓 <b>Planned:</b> ${esc(w.title)}, ${esc(when(w.startsAt))} → ${esc(when(w.endsAt))}</p>`)].join('')}</section>`;
  }

  function card(m) {
    const busy = o.busy.has(m.id);
    return `<article class="panel ops-card ${STATUS[m.status]?.cls || ''}">
      <header><a class="ops-card-title" href="${base()}/monitor/${esc(m.id)}"><b>${esc(m.name)}</b><small>${esc(d().kinds[m.kind] || '')} · ${esc(host(m.url))}</small></a>${badge(m.paused ? 'paused' : m.status)}</header>
      ${strip(m.recent, m.slowMs)}
      <dl class="ops-facts">
        <div><dt>Response</dt><dd>${ms(m.lastMs)}</dd></div>
        <div><dt>Uptime 7d</dt><dd>${pct(m.uptime7d)}</dd></div>
        <div><dt>Uptime 30d</dt><dd>${pct(m.uptime30d)}</dd></div>
        <div><dt>Page</dt><dd>${size(m.avgBytes7d)}</dd></div>
      </dl>
      ${m.lastProblem && m.status !== 'up' ? `<p class="ops-problem">${esc(m.lastProblem)}</p>` : ''}
      <footer><span class="muted small">Checked ${esc(ago(m.lastCheckAt))} · every ${m.interval} min</span>
        <span class="ops-exp small">${m.url.startsWith('https:') && m.checkSsl ? expiry('SSL', m.ssl?.validTo, d().expiryWarnDays) : ''}${m.checkDomain ? expiry('Domain', m.domain?.expiresAt, d().expiryWarnDays * 2) : ''}</span>
        <button class="btn small" data-click="ops-check" data-id="${esc(m.id)}"${busy ? ' disabled' : ''}>${busy ? 'Checking…' : '↻ Check now'}</button></footer>
    </article>`;
  }

  // ---------------------------------------------------------------- one monitor

  function monitorView() {
    const x = o.detail;
    const m = x.monitor;
    const s = x.stats;
    const labelsFromChecks = x.checks.map((c) => new Date(c.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }));
    const dayLabel = (date) => new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    const responseChart = x.range === '24h'
      ? x.checks.length > 1
        ? lineChart({ title: 'Response time', sub: 'Every check in the last 24 hours (gaps are failures)', labels: labelsFromChecks, series: [{ name: 'Full response', color: 'var(--viz-1)', values: x.checks.map((c) => (c.status === 'down' || c.status === 'maintenance' ? null : c.ms)) }, { name: 'First byte', color: 'var(--viz-3)', values: x.checks.map((c) => (c.status === 'down' || c.status === 'maintenance' ? null : c.ttfb || null)) }, { name: 'Slow above', color: 'var(--viz-muted)', dashed: true, values: x.checks.map(() => m.slowMs) }], format: ms, endLabels: false })
        : '<p class="muted">The chart fills in as checks come in.</p>'
      : x.days.length
        ? lineChart({ title: 'Average response time', sub: `Per day, last ${x.range}`, labels: x.days.map((d_) => dayLabel(d_.date)), series: [{ name: 'Average', color: 'var(--viz-1)', values: x.days.map((d_) => (d_.msCount ? Math.round(d_.msSum / d_.msCount) : null)) }, { name: 'Slowest', color: 'var(--viz-2)', values: x.days.map((d_) => d_.msMax || null) }], format: ms, endLabels: false })
        : '<p class="muted">No checks in this range yet.</p>';
    const uptimeChart = x.days.length
      ? columnChart({ title: 'Checks per day', sub: 'Up, slow, failed and during maintenance', columns: x.days.map((d_) => ({ label: dayLabel(d_.date), values: [d_.up || 0, d_.slow || 0, d_.down || 0, d_.maintenance || 0] })), stacks: [{ name: 'Up', color: 'var(--viz-3)' }, { name: 'Slow', color: 'var(--viz-4)' }, { name: 'Down', color: 'var(--viz-neg)' }, { name: 'Maintenance', color: 'var(--viz-muted)' }], format: (v) => `${v} checks`, height: 200 })
      : '';
    const last = x.checks.slice(-40).reverse();
    return `
      <p><a href="${base()}/overview">‹ All monitors</a></p>
      <section class="panel ops-head">
        <div><h2>${esc(m.name)} ${badge(m.paused ? 'paused' : m.status)}</h2>
          <p><a href="${esc(m.url)}" target="_blank" rel="noopener noreferrer">${esc(m.url)}</a> · ${esc(d().kinds[m.kind] || '')} · ${m.method} every ${m.interval} min · expects ${m.expect === '2xx-3xx' ? 'any 2xx or 3xx' : `HTTP ${m.expect}`}${m.keyword ? ` and “${esc(m.keyword)}” on the page` : ''}</p>
          ${m.lastProblem && m.status !== 'up' ? `<p class="ops-problem">${esc(m.lastProblem)}</p>` : ''}
          ${m.notes ? `<p class="muted">${esc(m.notes)}</p>` : ''}</div>
        <div class="row">${d().admin ? `<button class="btn" data-click="ops-monitor" data-id="${esc(m.id)}">Edit</button><button class="btn" data-click="ops-pause" data-id="${esc(m.id)}">${m.paused ? '▶ Resume' : '❚❚ Pause'}</button>` : ''}<button class="btn primary" data-click="ops-check" data-id="${esc(m.id)}"${o.busy.has(m.id) ? ' disabled' : ''}>${o.busy.has(m.id) ? 'Checking…' : '↻ Check now'}</button></div>
      </section>
      <nav class="segmented small" aria-label="Range">${RANGES.map((r) => `<a href="${base()}/monitor/${esc(m.id)}?range=${r}"${x.range === r ? ' aria-current="page"' : ''}>${r}</a>`).join('')}</nav>
      <div class="stat-row">
        <div class="panel stat hr-tile"><span>Uptime · ${x.range}</span><b>${pct(s.uptime)}</b><small class="muted">${s.checks} checks</small></div>
        <div class="panel stat hr-tile"><span>Average response</span><b>${ms(s.avgMs)}</b><small class="muted">${s.p95 != null ? `95% under ${ms(s.p95)}` : x.range === '24h' ? '' : `last 60: 95% under ${ms(m.p95Recent)}`}</small></div>
        <div class="panel stat hr-tile"><span>${s.ttfb != null ? 'First byte' : 'Page size'}</span><b>${s.ttfb != null ? ms(s.ttfb) : size(s.avgBytes)}</b><small class="muted">${s.ttfb != null ? `page ${size(s.avgBytes)}` : 'average'}</small></div>
        <div class="panel stat hr-tile"><span>Incidents · ${x.range}</span><b class="${s.incidents ? 'ops-txt-down' : ''}">${s.incidents}</b><small class="muted">last up ${esc(ago(m.lastUpAt))}</small></div>
        <div class="panel stat hr-tile"><span>SSL certificate</span><b class="${daysLeft(m.ssl?.validTo) != null && daysLeft(m.ssl.validTo) <= d().expiryWarnDays ? 'ops-txt-slow' : ''}">${m.url.startsWith('https:') && m.checkSsl && m.ssl?.validTo ? `${daysLeft(m.ssl.validTo)} days` : '—'}</b><small>${m.checkDomain ? expiry(`Domain ${m.domain?.name || ''}`.trim(), m.domain?.expiresAt, d().expiryWarnDays * 2) : '<em class="ops-exp-item muted">domain not checked</em>'}</small></div>
      </div>
      ${m.ssl?.validTo ? `<p class="muted small">SSL by ${esc(m.ssl.issuer || 'unknown issuer')}, valid until ${esc(when(m.ssl.validTo))}${m.ssl.trusted === false ? ` · <span class="ops-txt-down">not trusted: ${esc(m.ssl.error || 'check the certificate chain')}</span>` : ''}${m.domain?.expiresAt ? ` · domain ${esc(m.domain.name)} registered until ${esc(m.domain.expiresAt.slice(0, 10))}${m.domain.registrar ? ` with ${esc(m.domain.registrar)}` : ''}` : ''}.</p>` : ''}
      <section class="panel">${responseChart}</section>
      ${uptimeChart ? `<section class="panel">${uptimeChart}</section>` : ''}
      <div class="fin-grid two">
        <section class="panel flush"><h2 class="hr-pad">Recent checks</h2>${last.length ? `<div class="table-scroll"><table class="data-table hr-table"><thead><tr><th>When</th><th>Result</th><th class="num">Response</th><th class="num">First byte</th><th class="num">Size</th><th>HTTP</th></tr></thead><tbody>
          ${last.map((c) => `<tr><td>${esc(when(c.at))}</td><td>${badge(c.status)}${c.problem ? `<br><small class="muted">${esc(c.problem)}</small>` : ''}</td><td class="num">${ms(c.ms)}</td><td class="num">${ms(c.ttfb)}</td><td class="num">${size(c.bytes)}</td><td>${c.code || '—'}${c.location ? `<br><small class="muted">→ ${esc(c.location.slice(0, 60))}</small>` : ''}</td></tr>`).join('')}</tbody></table></div>` : `<p class="hr-pad muted">${x.range === '24h' ? 'No checks in the last 24 hours.' : 'Pick 24h to see each check.'}</p>`}</section>
        <section class="panel flush"><h2 class="hr-pad">Incidents</h2>${incidentTable(x.incidents, false)}</section>
      </div>`;
  }

  // ---------------------------------------------------------------- incidents

  function incidentTable(list, withMonitor = true) {
    if (!list.length) return '<p class="hr-pad muted">No incidents. 🎉</p>';
    return `<div class="table-scroll"><table class="data-table hr-table"><thead><tr><th>Started</th>${withMonitor ? '<th>Monitor</th>' : ''}<th>Problem</th><th>Lasted</th><th>Cause &amp; notes</th></tr></thead><tbody>
      ${list.map((i) => `<tr class="hr-click" data-click="ops-incident" data-id="${esc(i.id)}"><td>${esc(when(i.startedAt))}</td>${withMonitor ? `<td><b>${esc(i.monitorName || monName(i.monitorId))}</b></td>` : ''}<td>${esc(i.problem || '')}</td><td>${i.resolvedAt ? esc(duration(i.startedAt, i.resolvedAt)) : `<span class="ops-badge ops-down"><i aria-hidden="true">✕</i>Ongoing · ${esc(duration(i.startedAt))}</span>`}</td><td>${i.cause ? `<b>${esc(i.cause)}</b>` : '<span class="muted">add a cause</span>'}${i.notes ? `<br><small class="muted">${esc(i.notes.slice(0, 120))}</small>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
  }

  function incidentsView() {
    const list = d().incidents;
    const resolved = list.filter((i) => i.resolvedAt && i.minutes);
    const mttr = resolved.length ? Math.round(resolved.reduce((s, i) => s + i.minutes, 0) / resolved.length) : null;
    const month = d().today.slice(0, 7);
    return `
      <div class="stat-row">
        <div class="panel stat hr-tile"><span>Ongoing</span><b class="${list.some((i) => !i.resolvedAt) ? 'ops-txt-down' : ''}">${list.filter((i) => !i.resolvedAt).length}</b></div>
        <div class="panel stat hr-tile"><span>This month</span><b>${list.filter((i) => i.startedAt.startsWith(month)).length}</b></div>
        <div class="panel stat hr-tile"><span>Average time to recover</span><b>${mttr == null ? '—' : mttr < 60 ? `${mttr} min` : `${(mttr / 60).toFixed(1)} h`}</b><small class="muted">over ${resolved.length} resolved</small></div>
      </div>
      <section class="panel flush"><div class="hr-pad"><h2>Incident history</h2><p class="muted small">An incident opens after the failures in a row set on the monitor (2 by default), and closes on the first good check. Open one to record what caused it.</p></div>${incidentTable(list)}</section>`;
  }

  function incidentDialog(i) {
    const node = document.createElement('dialog');
    node.className = 'dialog hr-dialog';
    node.innerHTML = `<form><h2>Incident · ${esc(i.monitorName || monName(i.monitorId))}</h2>
      <p class="muted">${esc(when(i.startedAt))} → ${i.resolvedAt ? esc(when(i.resolvedAt)) : 'ongoing'} · ${esc(i.problem || '')}</p>
      <label>Cause<input name="cause" maxlength="300" value="${esc(i.cause || '')}" placeholder="Hosting outage, expired SSL, bad deploy…" /></label>
      <label>Notes and what was done<textarea name="notes" rows="5" maxlength="4000">${esc(i.notes || '')}</textarea></label>
      <p class="auth-error" hidden></p>
      <div class="row end"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">Save</button></div></form>`;
    wire(node, (body) => api('PATCH', path(`/incidents/${encodeURIComponent(i.id)}`), body));
  }

  // ---------------------------------------------------------------- maintenance

  function maintenanceView() {
    const tasks = d().tasks;
    const today = d().today;
    const state = (t) => (t.done ? 'done' : t.due < today ? 'overdue' : t.due <= addDays(today, 7) ? 'soon' : 'later');
    const badgeOf = { overdue: '<span class="hr-badge hr-absent">⚠ Overdue</span>', soon: '<span class="hr-badge hr-late">This week</span>', later: '<span class="hr-badge hr-leave">Planned</span>', done: '<span class="hr-badge hr-present">✓ Done</span>' };
    const nowIso = d().now;
    const windows = d().windows;
    return `
      <div class="hr-toolbar"><h2 class="ops-h2">Checklist</h2><span class="muted">${tasks.filter((t) => !t.done && state(t) === 'overdue').length} overdue · ${tasks.filter((t) => !t.done).length} open</span><span class="spacer"></span><button class="btn primary" data-click="ops-task">+ Task</button></div>
      <section class="panel flush">${tasks.length ? `<div class="table-scroll"><table class="data-table hr-table"><thead><tr><th>Task</th><th>Area</th><th>Every</th><th>Due</th><th>Who</th><th></th></tr></thead><tbody>
        ${tasks.map((t) => `<tr class="${t.done ? 'is-disabled' : ''}"><td class="hr-click" data-click="ops-task" data-id="${esc(t.id)}"><b>${esc(t.title)}</b>${t.monitorId ? `<br><small class="muted">${esc(monName(t.monitorId))}</small>` : ''}${t.lastDoneOn ? `<br><small class="muted">last done ${esc(t.lastDoneOn)}</small>` : ''}</td><td>${esc(d().areas[t.area] || t.area)}</td><td>${esc(t.frequency === 'once' ? 'once' : t.frequency)}</td><td>${esc(t.done ? t.doneOn : t.due)} ${badgeOf[state(t)]}</td><td>${esc(t.assignee || '—')}</td><td>${t.done ? '' : `<button class="btn small" data-click="ops-done" data-id="${esc(t.id)}">✓ Done</button>`}</td></tr>`).join('')}</tbody></table></div>`
        : '<div class="hr-empty"><p class="muted">Backups, updates, security reviews, renewals: add the upkeep your sites and apps need, and when it’s due.</p><button class="btn primary" data-click="ops-task">+ Task</button></div>'}</section>

      <div class="hr-toolbar"><h2 class="ops-h2">Planned maintenance</h2><span class="muted">Failures during a window don’t open incidents or count against uptime.</span><span class="spacer"></span><button class="btn primary" data-click="ops-window">+ Plan maintenance</button></div>
      <section class="panel flush">${windows.length ? `<div class="table-scroll"><table class="data-table hr-table"><thead><tr><th>What</th><th>From</th><th>Until</th><th>Monitors</th><th>Status</th></tr></thead><tbody>
        ${windows.map((w) => `<tr class="hr-click" data-click="ops-window" data-id="${esc(w.id)}"><td><b>${esc(w.title)}</b>${w.notes ? `<br><small class="muted">${esc(w.notes.slice(0, 100))}</small>` : ''}</td><td>${esc(when(w.startsAt))}</td><td>${esc(when(w.endsAt))}</td><td>${w.monitorIds?.length ? esc(w.monitorIds.map(monName).join(', ')) : 'All'}</td><td>${w.endsAt <= nowIso ? '<span class="hr-badge hr-off">Finished</span>' : w.startsAt <= nowIso ? '<span class="hr-badge hr-leave">🛠 Now</span>' : '<span class="hr-badge hr-late">Upcoming</span>'}</td></tr>`).join('')}</tbody></table></div>`
        : '<p class="hr-pad muted">Moving servers, a big update, a database migration: plan it here first.</p>'}</section>

      <h2 class="ops-h2">Work log</h2>
      <section class="panel flush">${d().log.length ? `<ul class="ops-log">${d().log.map((l) => `<li><time>${esc(when(l.at))}</time><span><b>${esc(l.title)}</b>${l.note ? ` · ${esc(l.note)}` : ''}<br><small class="muted">${esc(l.byName || l.by)} · ${esc(d().areas[l.area] || '')}</small></span></li>`).join('')}</ul>` : '<p class="hr-pad muted">Tasks marked done appear here, with any note about what was done.</p>'}</section>`;
  }

  function taskDialog(existing) {
    const t = existing || { frequency: 'monthly', area: 'other', due: addDays(d().today, 7), assignee: '', monitorId: '', notes: '' };
    const node = document.createElement('dialog');
    node.className = 'dialog hr-dialog';
    node.innerHTML = `<form><h2>${existing ? 'Edit' : 'New'} maintenance task</h2>
      <label>Task *<input name="title" required maxlength="140" value="${esc(t.title || '')}" placeholder="Update WordPress plugins, test backup restore…" /></label>
      <div class="form-grid">
        <label>Area<select name="area">${Object.entries(d().areas).map(([k, v]) => `<option value="${k}"${k === t.area ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
        <label>Every<select name="frequency">${d().frequencies.map((f) => `<option${f === t.frequency ? ' selected' : ''}>${f}</option>`).join('')}</select></label>
        <label>Due *<input type="date" name="due" required value="${esc(t.due)}" /></label>
        <label>Who does it<input type="email" name="assignee" value="${esc(t.assignee || '')}" placeholder="dev@company.com" /></label>
        <label>Site or app<select name="monitorId"><option value="">All / none</option>${d().monitors.map((m) => `<option value="${esc(m.id)}"${m.id === t.monitorId ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>
      </div>
      <label>Notes / how to<textarea name="notes" rows="3" maxlength="2000">${esc(t.notes || '')}</textarea></label>
      ${existing?.done ? '<label class="check"><input type="checkbox" name="reopen" /> Reopen this task</label>' : ''}
      <p class="auth-error" hidden></p>
      <div class="row end">${existing ? '<button type="button" class="btn danger ghost" data-delete>Delete</button><span class="spacer"></span>' : ''}<button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">Save</button></div></form>`;
    wire(
      node,
      (body) => {
        body.reopen = body.reopen === 'on';
        return existing ? api('PATCH', path(`/tasks/${encodeURIComponent(t.id)}`), body) : api('POST', path('/tasks'), body);
      },
      existing && { confirm: 'Delete this task? Its past log entries stay.', run: () => api('DELETE', path(`/tasks/${encodeURIComponent(t.id)}`)) },
    );
  }

  const localInput = (iso) => {
    const dt = new Date(iso);
    return new Date(dt.getTime() - dt.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };

  function windowDialog(existing) {
    const start = new Date(Math.ceil(Date.now() / 3600000) * 3600000 + 86400000);
    const w = existing || { title: '', startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 2 * 3600000).toISOString(), monitorIds: [], notes: '' };
    const node = document.createElement('dialog');
    node.className = 'dialog hr-dialog';
    node.innerHTML = `<form><h2>${existing ? 'Edit' : 'Plan'} maintenance</h2>
      <label>What’s happening *<input name="title" required maxlength="120" value="${esc(w.title)}" placeholder="Server upgrade, database migration…" /></label>
      <div class="form-grid">
        <label>Starts *<input type="datetime-local" name="startsAt" required value="${esc(localInput(w.startsAt))}" /></label>
        <label>Ends *<input type="datetime-local" name="endsAt" required value="${esc(localInput(w.endsAt))}" /></label>
      </div>
      <fieldset class="ops-pick"><legend>Which sites and apps</legend><p class="muted small">None ticked means all of them.</p>
        ${d().monitors.map((m) => `<label class="check"><input type="checkbox" name="monitorIds" value="${esc(m.id)}"${w.monitorIds?.includes(m.id) ? ' checked' : ''} /> ${esc(m.name)}</label>`).join('') || '<p class="muted small">No monitors yet.</p>'}</fieldset>
      <label>Notes<textarea name="notes" rows="3" maxlength="2000">${esc(w.notes || '')}</textarea></label>
      <p class="auth-error" hidden></p>
      <div class="row end">${existing ? '<button type="button" class="btn danger ghost" data-delete>Delete</button><span class="spacer"></span>' : ''}<button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">Save</button></div></form>`;
    wire(
      node,
      (body, form) => {
        body.monitorIds = [...form.querySelectorAll('[name=monitorIds]:checked')].map((x) => x.value);
        body.startsAt = new Date(body.startsAt).toISOString();
        body.endsAt = new Date(body.endsAt).toISOString();
        return existing ? api('PATCH', path(`/windows/${encodeURIComponent(w.id)}`), body) : api('POST', path('/windows'), body);
      },
      existing && { confirm: 'Delete this maintenance window?', run: () => api('DELETE', path(`/windows/${encodeURIComponent(w.id)}`)) },
    );
  }

  // ---------------------------------------------------------------- monitor form

  function monitorDialog(existing) {
    const m = existing || { kind: 'website', method: 'GET', interval: 5, timeoutMs: 10000, slowMs: 2000, expect: '2xx-3xx', failuresToAlert: 2, checkSsl: true, checkDomain: true, keyword: '', notes: '' };
    const node = document.createElement('dialog');
    node.className = 'dialog hr-dialog';
    node.innerHTML = `<form><h2>${existing ? 'Edit' : 'Add'} site or app</h2>
      <div class="form-grid">
        <label>Name *<input name="name" required maxlength="80" value="${esc(m.name || '')}" placeholder="Company website" /></label>
        <label>Type<select name="kind">${Object.entries(d().kinds).map(([k, v]) => `<option value="${k}"${k === m.kind ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
      </div>
      <label>Address to check *<input name="url" required maxlength="2000" value="${esc(m.url || '')}" placeholder="https://example.com or https://api.example.com/health" inputmode="url" /></label>
      <div class="form-grid">
        <label>Check every<select name="interval">${d().intervals.map((n) => `<option value="${n}"${n === m.interval ? ' selected' : ''}>${n === 60 ? '1 hour' : `${n} min`}</option>`).join('')}</select></label>
        <label>Method<select name="method"><option${m.method === 'GET' ? ' selected' : ''}>GET</option><option${m.method === 'HEAD' ? ' selected' : ''}>HEAD</option></select></label>
        <label>Slow above (ms)<input name="slowMs" type="number" min="200" max="15000" step="100" value="${m.slowMs}" /></label>
        <label>Give up after (ms)<input name="timeoutMs" type="number" min="2000" max="15000" step="500" value="${m.timeoutMs}" /></label>
        <label>Expected answer<input name="expect" value="${esc(m.expect)}" placeholder="2xx-3xx" /><small class="muted">2xx-3xx, or one code like 200</small></label>
        <label>Alert after failures in a row<select name="failuresToAlert">${[1, 2, 3, 5].map((n) => `<option${n === m.failuresToAlert ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
      </div>
      <label>Page must contain (optional)<input name="keyword" maxlength="120" value="${esc(m.keyword || '')}" placeholder="Add to cart" /><small class="muted">Catches pages that load but are broken or empty.</small></label>
      <label class="check"><input type="checkbox" name="checkSsl"${m.checkSsl ? ' checked' : ''} /> Watch the SSL certificate’s expiry</label>
      <label class="check"><input type="checkbox" name="checkDomain"${m.checkDomain ? ' checked' : ''} /> Watch the domain’s expiry</label>
      <label>Notes (hosting, who to call)<textarea name="notes" rows="2" maxlength="2000">${esc(m.notes || '')}</textarea></label>
      <p class="auth-error" hidden></p>
      <div class="row end">${existing ? '<button type="button" class="btn danger ghost" data-delete>Delete</button><span class="spacer"></span>' : ''}<button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">${existing ? 'Save' : 'Add and check'}</button></div></form>`;
    wire(
      node,
      async (body) => {
        body.checkSsl = body.checkSsl === 'on';
        body.checkDomain = body.checkDomain === 'on';
        if (existing) return api('PATCH', path(`/monitors/${encodeURIComponent(m.id)}`), body);
        const res = await api('POST', path('/monitors'), body);
        go(`${base()}/monitor/${encodeURIComponent(res.monitor.id)}`);
        return res;
      },
      existing && {
        confirm: `Delete ${m.name}? Its history and checks go too.`,
        run: async () => {
          await api('DELETE', path(`/monitors/${encodeURIComponent(m.id)}`));
          go(`${base()}/overview`);
        },
      },
    );
  }

  // Shared dialog plumbing: submit → save → refresh; errors stay in the dialog.
  function wire(node, save, remove = null) {
    document.body.append(node);
    const form = node.querySelector('form');
    node.addEventListener('close', () => node.remove());
    node.querySelector('[data-cancel]').addEventListener('click', () => node.close());
    const fail = (err) => {
      const box = node.querySelector('.auth-error');
      box.textContent = err.message;
      box.hidden = false;
    };
    node.querySelector('[data-delete]')?.addEventListener('click', async () => {
      if (!remove || !confirm(remove.confirm)) return;
      try {
        await remove.run();
        node.close();
        refresh();
      } catch (err) {
        fail(err);
      }
    });
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const submit = form.querySelector('button.primary');
      submit.disabled = true;
      try {
        await save(Object.fromEntries(new FormData(form)), form);
        node.close();
        toast('Saved');
        refresh();
      } catch (err) {
        fail(err);
      } finally {
        submit.disabled = false;
      }
    });
    node.showModal();
  }

  // ---------------------------------------------------------------- settings

  function settingsView() {
    const s = d().settings;
    return `<form class="panel hr-settings" data-form="ops-settings">
      <h2>Alerts</h2>
      <label>Email these people when something goes down or comes back, and before SSL or a domain expires<textarea name="alertEmails" rows="2" placeholder="dev@company.com, owner@company.com">${esc(s.alertEmails.join(', '))}</textarea></label>
      ${d().admin ? `<h2>Access</h2><label>Who else can see this page<input name="viewers" value="${esc(s.viewers.join(', '))}" placeholder="developer@agency.com" /><small class="muted">Workspace owners and admins always can. People added here can check, plan maintenance and tick off tasks; only owners and admins add or change monitors.</small></label>` : ''}
      <div class="row end"><button class="btn primary">Save</button></div>
    </form>`;
  }

  // ---------------------------------------------------------------- actions

  const clickActions = {
    'ops-monitor': (t) => monitorDialog(t.dataset.id ? (o.detail?.monitor.id === t.dataset.id ? o.detail.monitor : d().monitors.find((m) => m.id === t.dataset.id)) : null),
    'ops-check': async (t) => {
      const id = t.dataset.id;
      o.busy.add(id);
      render();
      try {
        const res = await api('POST', path(`/monitors/${encodeURIComponent(id)}/check`));
        toast(`${res.monitor.name}: ${STATUS[res.check.status]?.label || res.check.status}${res.check.status === 'down' ? ` (${res.check.problem})` : ` in ${ms(res.check.ms)}`}`);
      } catch (err) {
        toast(err.message);
      }
      o.busy.delete(id);
      refresh();
    },
    'ops-pause': async (t) => {
      const m = o.detail?.monitor;
      try {
        await api('PATCH', path(`/monitors/${encodeURIComponent(t.dataset.id)}`), { paused: !m?.paused });
        refresh();
      } catch (err) {
        toast(err.message);
      }
    },
    'ops-incident': (t) => incidentDialog((o.detail?.incidents || []).concat(d().incidents).find((i) => i.id === t.dataset.id)),
    'ops-task': (t) => taskDialog(t.dataset.id ? d().tasks.find((x) => x.id === t.dataset.id) : null),
    'ops-window': (t) => windowDialog(t.dataset.id ? d().windows.find((x) => x.id === t.dataset.id) : null),
    'ops-done': (t) => {
      const task = d().tasks.find((x) => x.id === t.dataset.id);
      const node = document.createElement('dialog');
      node.className = 'dialog hr-dialog';
      node.innerHTML = `<form><h2>✓ ${esc(task.title)}</h2>
        <label>What was done (optional)<textarea name="note" rows="3" maxlength="1000" placeholder="Updated 12 plugins, restore test passed…"></textarea></label>
        <p class="muted small">${task.frequency === 'once' ? 'This one-off task will close.' : `It comes back ${esc(task.frequency)}; the next due date is set for you.`}</p>
        <p class="auth-error" hidden></p>
        <div class="row end"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">Mark done</button></div></form>`;
      wire(node, (body) => api('POST', path(`/tasks/${encodeURIComponent(task.id)}/done`), body));
    },
  };

  const formActions = {
    'ops-settings': async (form) => {
      const body = { alertEmails: form.querySelector('[name=alertEmails]').value };
      const viewers = form.querySelector('[name=viewers]');
      if (viewers) body.viewers = viewers.value;
      try {
        await api('PATCH', path('/settings'), body);
        toast('Saved');
        refresh();
      } catch (err) {
        toast(err.message);
      }
    },
  };

  return { load, ready, view, clickActions, changeActions: {}, inputActions: {}, formActions };
}
