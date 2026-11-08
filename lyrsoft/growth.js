// Lyrsoft Ads & budget (#/w/<ws>/growth[/<tab>]?month=), plugged into app.js like hr.js. Connect the
// marketing platforms (Meta, Google Ads, TikTok, YouTube, WhatsApp, WeChat, Telegram…), plan
// campaigns across channels, set a monthly budget per channel and follow spend and results.
const TABS = [
  ['overview', '📊 Overview'],
  ['plan', '🗓 Plan'],
  ['budget', '💸 Budget'],
  ['spend', '🧾 Spend'],
  ['channels', '🔌 Channels'],
];
const STATUS_LABELS = { idea: 'Idea', planned: 'Planned', live: 'Live', paused: 'Paused', done: 'Done' };
const METRICS = { '': 'No target', impressions: 'Impressions', clicks: 'Clicks', results: 'Results (leads, sales, messages…)', reach: 'Reach' };

export function createGrowth({ api, esc, toast, render, go, formatDateTime }) {
  const g = { ws: null, data: null, spend: null };
  let route = null;

  const base = () => `#/w/${encodeURIComponent(g.ws)}/growth`;
  const path = (p = '') => `/workspaces/${encodeURIComponent(g.ws)}/growth${p}`;
  const d = () => g.data;
  const cat = () => g.data.catalog;
  const money = (n) => `${d().currency} ${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  const num = (n) => (n == null ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }));
  const compact = (n) => (n == null ? '—' : Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n));
  const chName = (ch) => cat().channels[ch]?.[0] || ch;
  const chColor = (ch) => cat().channels[ch]?.[1] || '#8a90a2';
  const chDot = (ch) => `<span class="gr-dot" style="background:${chColor(ch)}"></span>`;
  const chTag = (ch) => `<span class="gr-ch">${chDot(ch)}${esc(chName(ch))}</span>`;
  const monthName = (m) => new Date(`${m}-01T00:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const shiftMonth = (m, n) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + n, 1)).toISOString().slice(0, 7);
  const bar = (pct, tone = '') => `<span class="gr-bar${tone ? ` ${tone}` : ''}"><i style="width:${Math.min(100, Math.max(0, pct || 0))}%"></i></span>`;
  const tile = (label, value, sub = '', tone = '') => `<div class="panel stat hr-tile${tone ? ` hr-tone-${tone}` : ''}"><span>${label}</span><b>${value}</b>${sub ? `<small class="muted">${sub}</small>` : ''}</div>`;
  const tab = () => (TABS.some(([id]) => id === route?.tab) ? route.tab : 'overview');

  // ---------------------------------------------------------------- loading

  async function load(next) {
    route = next;
    if (next.view !== 'growth') return;
    if (g.ws !== next.ws) Object.assign(g, { ws: next.ws, data: null, spend: null });
    const month = next.params.get('month') || '';
    g.data = await api('GET', path(month ? `?month=${month}` : ''));
    if (tab() === 'spend') g.spend = await api('GET', path(`/spend?month=${g.data.month}`));
  }
  const ready = (r) => r.view !== 'growth' || Boolean(g.data && g.ws === r.ws);
  const refresh = async () => {
    await load(route);
    render();
  };

  // ---------------------------------------------------------------- shell

  function view() {
    const t = tab();
    const monthNav = ['overview', 'budget', 'spend'].includes(t)
      ? `<span class="row gr-month"><a class="btn small" href="${base()}/${t}?month=${shiftMonth(d().month, -1)}" aria-label="Previous month">‹</a><b>${esc(monthName(d().month))}</b><a class="btn small" href="${base()}/${t}?month=${shiftMonth(d().month, 1)}" aria-label="Next month">›</a></span>`
      : '';
    return `
      <div class="page-head"><div><h1>Ads &amp; budget</h1><p>Plan campaigns on every platform, set budgets and see what they bring in.</p></div>${monthNav ? `<div class="page-actions">${monthNav}</div>` : ''}</div>
      <nav class="segmented hr-tabs" aria-label="Ads and budget">${TABS.map(([id, label]) => `<a href="${base()}/${id}${id !== 'plan' && id !== 'channels' ? `?month=${d().month}` : ''}"${t === id ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>
      <div class="hr-body">${{ overview: overviewView, plan: planView, budget: budgetView, spend: spendView, channels: channelsView }[t]()}</div>`;
  }

  // ---------------------------------------------------------------- overview

  function overviewView() {
    const r = d().report;
    const t = r.totals;
    const connected = d().connections.filter((c) => c.status === 'connected').length;
    const audience = audienceList();
    const live = d().plans.filter((p) => p.status === 'live');
    return `
      ${!d().connections.length && !r.channels.length ? `<section class="panel hr-welcome"><h2>Get started</h2><ol>
        <li><b>Connect your platforms</b>: Meta (Facebook, Instagram), Google Ads and YouTube, TikTok, WhatsApp, WeChat, Telegram. <a href="${base()}/channels">Channels</a></li>
        <li><b>Set this month’s budget</b> per channel. <a href="${base()}/budget?month=${d().month}">Budget</a></li>
        <li><b>Plan your campaigns</b> with a budget and a target. <a href="${base()}/plan">Plan</a></li>
        <li>No API for a channel (LinkedIn, X, SMS, influencers, print…)? <a href="${base()}/spend?month=${d().month}">Add its spend by hand</a>.</li></ol></section>` : ''}
      <div class="stat-row">
        ${tile('Budget', r.budget ? money(r.budget) : '—', r.budget ? '' : `<a href="${base()}/budget?month=${d().month}">Set a budget</a>`)}
        ${tile('Spent', money(t.spend), t.used != null ? `${t.used}% of budget · ${r.elapsed}/${r.days} days` : `${r.elapsed}/${r.days} days`, t.over ? 'warn' : '')}
        ${tile('Month-end forecast', r.elapsed ? money(t.projected) : '—', t.over ? '⚠ over budget at this pace' : r.budget && r.elapsed ? 'within budget' : '', t.over ? 'warn' : 'ok')}
        ${tile('Impressions', compact(t.impressions), t.cpm != null ? `${money(t.cpm)} per 1,000` : '')}
        ${tile('Clicks', compact(t.clicks), t.ctr != null ? `${t.ctr}% CTR · ${money(t.cpc)} each` : '')}
        ${tile('Results', compact(t.results), t.cpr != null ? `${money(t.cpr)} each` : 'leads, sales, messages', 'ok')}
      </div>
      <section class="panel">
        <div class="panel-head spread"><h2>Daily spend</h2><span class="muted small">${connected ? `${connected} platform${connected === 1 ? '' : 's'} syncing` : r.totals.spend ? 'From spend added by hand' : 'Connect platforms or add spend to fill this in'}</span></div>
        ${dailyChart(r)}
      </section>
      <div class="hr-grid">
        <section class="panel">
          <div class="panel-head spread"><h2>Budget by channel</h2><a class="btn small" href="${base()}/budget?month=${d().month}">Edit budget</a></div>
          ${r.channels.length ? `<ul class="gr-channels">${r.channels.map((c) => `<li><span class="gr-row">${chTag(c.channel)}<span class="muted">${money(c.spend)}${c.budget ? ` / ${money(c.budget)}` : ''}</span></span>${c.budget ? bar(c.used, c.over ? 'warn' : '') : bar(100, 'none')}<small class="muted">${c.budget ? `${c.used}% used${c.over ? ` · ⚠ heading for ${money(c.projected)}` : ''}` : 'no budget set'}${c.results ? ` · ${num(c.results)} results` : ''}${c.cpc != null ? ` · ${money(c.cpc)}/click` : ''}</small></li>`).join('')}</ul>` : '<p class="muted">No budget or spend this month yet.</p>'}
        </section>
        <section class="panel">
          <div class="panel-head spread"><h2>Audience</h2><a class="btn small" href="${base()}/channels">Channels</a></div>
          ${audience.length ? `<ul class="gr-audience">${audience.map((a) => `<li>${chTag(a.channel)}<b>${compact(a.followers)}</b><small class="muted">${esc(a.label)}</small></li>`).join('')}</ul>` : '<p class="muted">Connect a Facebook Page, Instagram, YouTube, Telegram or WeChat account to see followers here.</p>'}
        </section>
        <section class="panel">
          <div class="panel-head spread"><h2>Live campaigns</h2><a class="btn small" href="${base()}/plan">All plans</a></div>
          ${live.length ? live.map(planMini).join('') : '<p class="muted">No plans are live. Mark a plan “Live” to follow it here.</p>'}
        </section>
      </div>
      <section class="panel flush">
        <h2 class="hr-pad">Top campaigns · ${esc(monthName(d().month))}</h2>
        ${campaignsTable(d().campaigns.slice(0, 15))}
      </section>`;
  }

  function audienceList() {
    const out = [];
    for (const c of d().connections) {
      for (const [ch, s] of Object.entries(c.stats || {})) {
        if (s && s.followers != null) out.push({ channel: ch, followers: s.followers, label: `${s.name || ''}${ch === 'youtube' ? ' · subscribers' : ' · followers'}` });
      }
    }
    return out.sort((a, b) => b.followers - a.followers);
  }

  function dailyChart(r) {
    const max = Math.max(...r.daily.map((x) => x.spend), 1);
    const budgetPerDay = r.budget ? r.budget / r.days : 0;
    const top = Math.max(max, budgetPerDay) * 1.1;
    const w = 100 / r.daily.length;
    const y = (v) => 100 - (v / top) * 100;
    return `<div class="gr-chart"><svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Spend per day">
      ${r.daily.map((x, i) => `<rect x="${i * w + w * 0.15}" y="${y(x.spend)}" width="${w * 0.7}" height="${100 - y(x.spend)}" rx="0.6" class="gr-col${x.date > d().today ? ' future' : ''}"><title>${esc(x.date)}: ${esc(money(x.spend))}${x.clicks ? `, ${x.clicks} clicks` : ''}${x.results ? `, ${x.results} results` : ''}</title></rect>`).join('')}
      ${budgetPerDay ? `<line x1="0" x2="100" y1="${y(budgetPerDay)}" y2="${y(budgetPerDay)}" class="gr-budget-line" vector-effect="non-scaling-stroke"></line>` : ''}
    </svg><div class="gr-axis"><span>1</span><span>${Math.ceil(r.days / 2)}</span><span>${r.days}</span></div>
    <p class="muted small">${budgetPerDay ? `Dashed line: daily budget (${money(budgetPerDay)}). ` : ''}Highest day ${money(max)}.</p></div>`;
  }

  function campaignsTable(list) {
    if (!list.length) return '<p class="muted hr-pad">No campaign data this month.</p>';
    return `<div class="table-scroll"><table class="data-table hr-table">
      <thead><tr><th>Campaign</th><th>Channel</th><th class="num">Spend</th><th class="num">Impressions</th><th class="num">Clicks</th><th class="num">CTR</th><th class="num">CPC</th><th class="num">Results</th><th class="num">Cost / result</th></tr></thead>
      <tbody>${list.map((c) => `<tr><td><b>${esc(c.campaign)}</b><small class="muted"> ${c.source === 'manual' ? 'by hand' : esc(cat().platforms[c.source]?.short || c.source)}</small></td><td>${chTag(c.channel)}</td><td class="num">${money(c.spend)}</td><td class="num">${compact(c.impressions)}</td><td class="num">${compact(c.clicks)}</td><td class="num">${c.ctr != null ? `${c.ctr}%` : '—'}</td><td class="num">${c.cpc != null ? money(c.cpc) : '—'}</td><td class="num">${num(c.results)}</td><td class="num">${c.cpr != null ? money(c.cpr) : '—'}</td></tr>`).join('')}</tbody></table></div>`;
  }

  // ---------------------------------------------------------------- plan

  const planMini = (p) => {
    const pr = p.progress;
    return `<div class="gr-plan-mini"><span class="gr-row"><b>${esc(p.name)}</b><span class="muted small">${money(pr.spend)}${p.budget ? ` / ${money(p.budget)}` : ''}</span></span>${p.budget ? bar(pr.budgetUsed, pr.budgetUsed > 100 ? 'warn' : '') : ''}${p.targetMetric && p.targetValue ? `<small class="muted">${num(pr[p.targetMetric])} of ${num(p.targetValue)} ${esc(p.targetMetric)} (${pr.targetDone}%)</small>` : ''}</div>`;
  };

  function planView() {
    const plans = d().plans;
    const months = [shiftMonth(d().today.slice(0, 7), -1), d().today.slice(0, 7), shiftMonth(d().today.slice(0, 7), 1), shiftMonth(d().today.slice(0, 7), 2)];
    const from = `${months[0]}-01`;
    const toDate = new Date(Date.UTC(Number(months[3].slice(0, 4)), Number(months[3].slice(5, 7)), 0)).toISOString().slice(0, 10);
    const span = (Date.parse(toDate) - Date.parse(from)) / 86400000 + 1;
    const pos = (date) => Math.min(100, Math.max(0, ((Date.parse(date) - Date.parse(from)) / 86400000 / span) * 100));
    const dated = plans.filter((p) => p.start && (p.end || p.start) >= from && p.start <= toDate);
    const totalBudget = plans.filter((p) => p.status !== 'done' && p.status !== 'idea').reduce((s, p) => s + (p.budget || 0), 0);
    return `
      <div class="hr-toolbar"><span class="muted">${plans.length} plan${plans.length === 1 ? '' : 's'} · ${money(totalBudget)} budgeted in planned and live campaigns</span><span class="spacer"></span><button class="btn primary" data-click="gr-new-plan">+ New plan</button></div>
      ${dated.length ? `<section class="panel"><h2>Timeline</h2><div class="gr-timeline">
        <div class="gr-tl-months">${months.map((m) => `<span>${esc(new Date(`${m}-01T00:00:00`).toLocaleDateString(undefined, { month: 'short', year: '2-digit' }))}</span>`).join('')}</div>
        <span class="gr-tl-today" style="left:calc(var(--lab) + (100% - var(--lab)) * ${pos(d().today) / 100})"></span>
        ${dated.map((p) => `<button class="gr-tl-row" data-click="gr-edit-plan" data-id="${esc(p.id)}"><span class="gr-tl-name">${esc(p.name)}</span><span class="gr-tl-track"><span class="gr-tl-bar gr-st-${esc(p.status)}" style="left:${pos(p.start)}%;width:${Math.max(1.5, pos(p.end || p.start) - pos(p.start) + 100 / span)}%;--c:${chColor(p.channels[0])}">${p.channels.map(chDot).join('')}</span></span></button>`).join('')}
      </div></section>` : ''}
      ${plans.length ? `<div class="gr-plans">${plans.map((p) => {
        const pr = p.progress;
        return `<article class="panel gr-plan">
          <header class="gr-row"><span class="hr-badge gr-st-${esc(p.status)}">${STATUS_LABELS[p.status]}</span><button class="btn small ghost" data-click="gr-edit-plan" data-id="${esc(p.id)}">Edit</button></header>
          <h3>${esc(p.name)}</h3>
          <p class="gr-tags">${p.channels.map(chTag).join('')}</p>
          <p class="muted small">${esc(p.objective)}${p.start ? ` · ${esc(p.start)}${p.end ? ` → ${esc(p.end)}` : ''}` : ''}${p.owner ? ` · ${esc(p.owner)}` : ''}</p>
          ${p.audience ? `<p class="small">🎯 ${esc(p.audience)}</p>` : ''}
          <div class="gr-row"><span>Spent <b>${money(pr.spend)}</b></span><span class="muted">${p.budget ? `of ${money(p.budget)}` : 'no budget'}</span></div>
          ${p.budget ? bar(pr.budgetUsed, pr.budgetUsed > 100 ? 'warn' : '') : ''}
          ${p.targetMetric && p.targetValue ? `<div class="gr-row"><span>${esc(METRICS[p.targetMetric].split(' (')[0])} <b>${num(pr[p.targetMetric])}</b></span><span class="muted">target ${num(p.targetValue)}</span></div>${bar(pr.targetDone, 'ok')}` : ''}
          <p class="muted small">${compact(pr.impressions)} impressions · ${compact(pr.clicks)} clicks${pr.cpr != null ? ` · ${money(pr.cpr)} per result` : ''}</p>
          ${p.notes ? `<p class="small gr-notes">${esc(p.notes)}</p>` : ''}
        </article>`;
      }).join('')}</div>` : '<section class="panel hr-empty"><p class="muted">No plans yet. A plan holds a campaign idea: channels, dates, budget, audience and a target, and tracks its spend and results as they come in.</p><button class="btn primary" data-click="gr-new-plan">+ New plan</button></section>'}`;
  }

  function planDialog(existing) {
    const p = existing || { channels: [], status: 'planned', objective: 'awareness', start: d().today, end: '', budget: '', targetMetric: '', targetValue: '' };
    const node = document.createElement('dialog');
    node.className = 'dialog wide hr-dialog';
    node.innerHTML = `<form><h2>${existing ? 'Edit plan' : 'New plan'}</h2>
      <label>Name *<input name="name" required maxlength="120" value="${esc(p.name || '')}" placeholder="Winter sale, product launch, Eid campaign…" /></label>
      <fieldset><legend>Channels *</legend><p class="gr-pick">${Object.keys(cat().channels).map((ch) => `<label class="chip-check"><input type="checkbox" name="channels" value="${ch}"${p.channels.includes(ch) ? ' checked' : ''} /> ${chDot(ch)}${esc(chName(ch))}</label>`).join('')}</p></fieldset>
      <div class="form-grid">
        <label>Objective<select name="objective">${cat().objectives.map((o) => `<option${o === p.objective ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select></label>
        <label>Status<select name="status">${cat().statuses.map((s) => `<option value="${s}"${s === p.status ? ' selected' : ''}>${STATUS_LABELS[s]}</option>`).join('')}</select></label>
        <label>Starts<input type="date" name="start" value="${esc(p.start || '')}" /></label>
        <label>Ends<input type="date" name="end" value="${esc(p.end || '')}" /></label>
        <label>Budget (${esc(d().currency)})<input name="budget" inputmode="decimal" value="${esc(p.budget || '')}" placeholder="0" /></label>
        <label>Owner<input name="owner" maxlength="120" value="${esc(p.owner || '')}" placeholder="Who runs it" /></label>
        <label>Target<select name="targetMetric">${Object.entries(METRICS).map(([k, v]) => `<option value="${k}"${k === p.targetMetric ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
        <label>Target number<input name="targetValue" inputmode="numeric" value="${esc(p.targetValue || '')}" placeholder="e.g. 500" /></label>
      </div>
      <label>Audience<input name="audience" maxlength="300" value="${esc(p.audience || '')}" placeholder="Women 18–34 in Dhaka who like fashion" /></label>
      <label>Track campaigns whose name contains<input name="match" maxlength="120" value="${esc(p.match || '')}" placeholder="e.g. winter (empty = everything on these channels in these dates)" /></label>
      <label>Notes, ideas, creative brief<textarea name="notes" rows="4" maxlength="4000">${esc(p.notes || '')}</textarea></label>
      <p class="auth-error" hidden></p>
      <div class="row end">${existing ? '<button type="button" class="btn danger ghost" data-delete>Delete</button><span class="spacer"></span>' : ''}<button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">${existing ? 'Save' : 'Create plan'}</button></div></form>`;
    document.body.append(node);
    const form = node.querySelector('form');
    node.addEventListener('close', () => node.remove());
    node.querySelector('[data-cancel]').addEventListener('click', () => node.close());
    node.querySelector('[data-delete]')?.addEventListener('click', async () => {
      if (!confirm(`Delete “${p.name}”?`)) return;
      await api('DELETE', path(`/plans/${encodeURIComponent(p.id)}`)).catch((e) => toast(e.message));
      node.close();
      refresh();
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const body = Object.fromEntries(data);
      body.channels = data.getAll('channels');
      try {
        await (existing ? api('PATCH', path(`/plans/${encodeURIComponent(p.id)}`), body) : api('POST', path('/plans'), body));
        node.close();
        toast(existing ? 'Plan saved' : 'Plan created');
        refresh();
      } catch (err) {
        const e = node.querySelector('.auth-error');
        e.textContent = err.message;
        e.hidden = false;
      }
    });
    node.showModal();
  }

  // ---------------------------------------------------------------- budget

  function budgetView() {
    const r = d().report;
    const byCh = new Map(r.channels.map((c) => [c.channel, c]));
    const used = new Set([...Object.keys(d().budget?.channels || {}), ...r.channels.map((c) => c.channel), ...d().connections.flatMap((c) => cat().platforms[c.platform]?.channels || [])]);
    const list = [...used, ...Object.keys(cat().channels).filter((c) => !used.has(c))];
    const manage = d().manage;
    return `
      <form class="panel flush" data-form="gr-budget">
        <div class="hr-pad gr-row"><h2>Budget for ${esc(monthName(d().month))}</h2><span class="muted">${r.elapsed}/${r.days} days gone</span></div>
        <div class="table-scroll"><table class="data-table hr-table">
          <thead><tr><th>Channel</th><th class="num">Budget (${esc(d().currency)})</th><th class="num">Spent</th><th>Used</th><th class="num">Remaining</th><th class="num">Forecast</th><th class="num">Results</th></tr></thead>
          <tbody>${list.map((ch, i) => {
            const c = byCh.get(ch) || { spend: 0, used: null, remaining: 0, projected: 0, results: 0 };
            const value = d().budget?.channels?.[ch] || '';
            const quiet = !value && !c.spend;
            return `<tr class="${quiet && i >= used.size ? 'gr-quiet' : ''}"><td>${chTag(ch)}</td><td class="num">${manage ? `<input class="hr-cell gr-budget-in" name="ch.${ch}" value="${value}" inputmode="decimal" placeholder="0" aria-label="Budget for ${esc(chName(ch))}" />` : value ? money(value) : '—'}</td>
              <td class="num">${c.spend ? money(c.spend) : '—'}</td><td>${value ? `${bar(c.used, c.over ? 'warn' : '')}<small class="muted">${c.used ?? 0}%</small>` : ''}</td>
              <td class="num">${value ? money(value - c.spend) : '—'}</td><td class="num">${c.projected ? `${money(c.projected)}${c.over ? ' ⚠' : ''}` : '—'}</td><td class="num">${c.results ? num(c.results) : '—'}</td></tr>`;
          }).join('')}</tbody>
          <tfoot><tr><th>Total</th><th class="num" data-budget-total>${money(r.budget)}</th><th class="num">${money(r.totals.spend)}</th><th>${r.budget ? bar(r.totals.used, r.totals.over ? 'warn' : '') : ''}</th><th class="num">${r.budget ? money(r.totals.remaining) : '—'}</th><th class="num">${r.totals.projected ? money(r.totals.projected) : '—'}</th><th class="num">${num(r.totals.results)}</th></tr></tfoot>
        </table></div>
        ${manage ? `<div class="hr-pad row end gr-row"><label class="row">Note <input name="note" class="hr-search" maxlength="300" value="${esc(d().budget?.note || '')}" placeholder="e.g. Eid push on Meta" /></label><span class="spacer"></span><button type="button" class="btn" data-click="gr-currency">Currency: ${esc(d().currency)}</button><button type="button" class="btn" data-click="gr-copy-budget">Copy last month</button><button class="btn primary">Save budget</button></div>` : '<p class="muted small hr-pad">Only workspace owners and admins set budgets.</p>'}
      </form>
      <p class="muted small">Forecast = spend so far ÷ days gone × days in the month. ⚠ means the channel is heading more than 5% over its budget.</p>`;
  }

  // ---------------------------------------------------------------- spend

  function spendView() {
    const rows = g.spend?.rows || [];
    return `
      <div class="hr-toolbar"><span class="muted">${rows.length} row${rows.length === 1 ? '' : 's'} · ${money(rows.reduce((s, r) => s + r.spend, 0))}</span><span class="spacer"></span>
        <button class="btn" data-click="gr-export-spend">⬇ Export</button><button class="btn primary" data-click="gr-add-spend">+ Add spend</button></div>
      <section class="panel flush">${rows.length ? `<div class="table-scroll"><table class="data-table hr-table">
        <thead><tr><th>Date</th><th>Channel</th><th>Campaign</th><th class="num">Spend</th><th class="num">Impr.</th><th class="num">Clicks</th><th class="num">Results</th><th>From</th><th></th></tr></thead>
        <tbody>${rows.slice(0, 1000).map((r) => `<tr><td>${esc(r.date)}</td><td>${chTag(r.channel)}</td><td>${esc(r.campaign)}${r.note ? `<small class="muted"> · ${esc(r.note)}</small>` : ''}</td><td class="num">${money(r.spend)}</td><td class="num">${compact(r.impressions)}</td><td class="num">${compact(r.clicks)}</td><td class="num">${num(r.results)}</td>
          <td><small class="muted">${r.source === 'manual' ? `by hand${r.by ? ` · ${esc(r.by)}` : ''}` : `🔌 ${esc(cat().platforms[r.source]?.short || r.source)}`}</small></td><td>${r.source === 'manual' ? `<button class="btn small ghost" data-click="gr-del-spend" data-key="${esc(r.key)}" aria-label="Delete">✕</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`
        : '<div class="hr-empty"><p class="muted">No spend this month. Connected platforms add theirs automatically; add the rest by hand.</p></div>'}</section>`;
  }

  function spendDialog() {
    const node = document.createElement('dialog');
    node.className = 'dialog hr-dialog';
    const day = d().month === d().today.slice(0, 7) ? d().today : `${d().month}-01`;
    node.innerHTML = `<form><h2>Add spend</h2>
      <div class="form-grid"><label>Date<input type="date" name="date" required value="${day}" /></label>
      <label>Channel<select name="channel">${Object.keys(cat().channels).map((ch) => `<option value="${ch}"${ch === 'linkedin' ? ' selected' : ''}>${esc(chName(ch))}</option>`).join('')}</select></label></div>
      <label>Campaign<input name="campaign" maxlength="160" placeholder="e.g. Influencer – @rafa, Billboard Gulshan" list="gr-campaigns" /></label>
      <datalist id="gr-campaigns">${d().plans.map((p) => `<option value="${esc(p.name)}"></option>`).join('')}</datalist>
      <div class="form-grid"><label>Spent (${esc(d().currency)})<input name="spend" inputmode="decimal" placeholder="0" /></label><label>Results<input name="results" inputmode="numeric" placeholder="Leads, sales, messages" /></label>
      <label>Impressions<input name="impressions" inputmode="numeric" placeholder="0" /></label><label>Clicks<input name="clicks" inputmode="numeric" placeholder="0" /></label></div>
      <label>Note<input name="note" maxlength="300" /></label>
      <p class="auth-error" hidden></p>
      <div class="row end"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">Add</button></div></form>`;
    document.body.append(node);
    const form = node.querySelector('form');
    node.addEventListener('close', () => node.remove());
    node.querySelector('[data-cancel]').addEventListener('click', () => node.close());
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        await api('POST', path('/spend'), Object.fromEntries(new FormData(form)));
        node.close();
        toast('Spend added');
        refresh();
      } catch (err) {
        const e = node.querySelector('.auth-error');
        e.textContent = err.message;
        e.hidden = false;
      }
    });
    node.showModal();
  }

  // ---------------------------------------------------------------- channels

  function channelsView() {
    const conns = new Map(d().connections.map((c) => [c.platform, c]));
    const manage = d().manage;
    return `
      <p class="muted">Connect each platform with your own API keys. Lyrsoft reads spend, results and followers every 6 hours (or when you press Sync). Keys are stored encrypted and only their last 4 characters are ever shown.</p>
      <div class="gr-platforms">${Object.entries(cat().platforms).map(([key, p]) => {
        const c = conns.get(key);
        const stats = c ? Object.entries(c.stats || {}).filter(([, s]) => s && typeof s === 'object') : [];
        return `<article class="panel gr-platform${c ? ` is-${esc(c.status)}` : ''}">
          <header><span class="gr-logo" style="background:${p.color}">${esc(p.icon)}</span><div><h3>${esc(p.short)}</h3><small class="muted">${esc(p.name)}</small></div>
            <span class="hr-badge ${c ? (c.status === 'connected' ? 'hr-present' : 'hr-absent') : 'hr-off'}">${c ? (c.status === 'connected' ? 'Connected' : 'Error') : 'Not connected'}</span></header>
          ${c ? `<p class="small">${c.account?.name ? `<b>${esc(c.account.name)}</b>` : ''}${c.account?.currency && c.account.currency !== d().currency ? ` <span class="hr-badge hr-late" title="Amounts are recorded as the platform reports them">reports in ${esc(c.account.currency)}</span>` : ''}</p>
            ${c.error ? `<p class="gr-error">${esc(c.error)}</p>` : ''}
            ${stats.map(([ch, s]) => `<p class="small">${chTag(ch)} ${s.error ? `<span class="gr-error">${esc(s.error)}</span>` : `${s.followers != null ? `<b>${compact(s.followers)}</b> ${ch === 'youtube' ? 'subscribers' : 'followers'}` : ''}${s.views != null ? ` · ${compact(s.views)} views` : ''}${s.posts != null ? ` · ${compact(s.posts)} posts` : ''}${s.gained7d != null ? ` · +${s.gained7d} / −${s.lost7d} this week` : ''}${s.quality ? `Quality ${esc(s.quality)} · limit ${esc(s.limit)} · ${s.approved} approved templates` : ''}`}</p>`).join('')}
            <p class="muted small">${c.lastSyncAt ? `Synced ${esc(formatDateTime(c.lastSyncAt))}${c.lastSyncRows != null && p.kind === 'ads' ? ` · ${c.lastSyncRows} rows` : ''}` : 'Not synced yet'}</p>
            <div class="row"><button class="btn small primary" data-click="gr-sync" data-platform="${key}">↻ Sync</button>${manage ? `<button class="btn small" data-click="gr-connect" data-platform="${key}">Settings</button>${key === 'whatsapp' ? '<button class="btn small" data-click="gr-wa-test">Send test</button>' : ''}<button class="btn small danger ghost" data-click="gr-disconnect" data-platform="${key}">Disconnect</button>` : ''}</div>`
          : `<p class="small muted">${p.kind === 'ads' ? 'Spend, impressions, clicks and results per campaign and day.' : p.kind === 'messaging' ? 'Account health, message templates and test sends.' : 'Followers and growth.'}</p>
            ${manage ? `<button class="btn small primary" data-click="gr-connect" data-platform="${key}">Connect</button>` : '<p class="muted small">A workspace owner or admin connects it.</p>'}`}
        </article>`;
      }).join('')}</div>
      <section class="panel"><h2>Tracked by hand</h2><p class="muted">These have no API connection here. Add their spend and results under <a href="${base()}/spend?month=${d().month}">Spend</a>, and give them a budget like any other channel.</p>
        <p class="gr-tags">${cat().manual.map(chTag).join('')}</p></section>`;
  }

  function connectDialog(platform) {
    const p = cat().platforms[platform];
    const c = d().connections.find((x) => x.platform === platform);
    const node = document.createElement('dialog');
    node.className = 'dialog wide hr-dialog';
    node.innerHTML = `<form><h2><span class="gr-logo" style="background:${p.color}">${esc(p.icon)}</span> Connect ${esc(p.short)}</h2>
      <p class="muted small">You’ll need a developer app or token from ${esc(p.short)}. <a href="${esc(p.docs)}" target="_blank" rel="noopener">${esc(p.short)} API docs ↗</a></p>
      ${p.fields.map((f) => `<label>${esc(f.label)}${f.required ? ' *' : ''}<input name="${f.key}" ${f.secret ? 'type="password" autocomplete="new-password"' : 'autocomplete="off"'} value="${f.secret ? '' : esc(c?.config?.[f.key] || '')}" placeholder="${esc(f.secret && c?.hints?.[f.key] ? `Saved (${c.hints[f.key]}). Leave empty to keep it.` : f.placeholder || '')}" />${f.help ? `<small class="muted">${esc(f.help)}</small>` : ''}</label>`).join('')}
      <p class="auth-error" hidden></p>
      <div class="row end"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">Test and connect</button></div></form>`;
    document.body.append(node);
    const form = node.querySelector('form');
    node.addEventListener('close', () => node.remove());
    node.querySelector('[data-cancel]').addEventListener('click', () => node.close());
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = form.querySelector('button.primary');
      button.disabled = true;
      button.textContent = 'Connecting…';
      try {
        const { connection } = await api('POST', path(`/connections/${platform}`), Object.fromEntries(new FormData(form)));
        node.close();
        toast(connection.status === 'connected' ? `${p.short} connected ✓` : `${p.short} connected, but the first sync failed: ${connection.error}`);
        refresh();
      } catch (err) {
        const e = node.querySelector('.auth-error');
        e.textContent = err.message;
        e.hidden = false;
        button.disabled = false;
        button.textContent = 'Test and connect';
      }
    });
    node.showModal();
  }

  // ---------------------------------------------------------------- actions

  function download(name, rows) {
    const csv = rows.map((r) => r.map((v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''))).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const clickActions = {
    'gr-new-plan': () => planDialog(null),
    'gr-edit-plan': (t) => planDialog(d().plans.find((p) => p.id === t.dataset.id)),
    'gr-add-spend': () => spendDialog(),
    'gr-del-spend': async (t) => {
      if (!confirm('Delete this row?')) return;
      try {
        await api('POST', path('/spend/delete'), { key: t.dataset.key });
        refresh();
      } catch (err) {
        toast(err.message);
      }
    },
    'gr-export-spend': () => download(`spend-${d().month}.csv`, [
      ['Date', 'Channel', 'Campaign', 'Spend', 'Impressions', 'Clicks', 'Reach', 'Results', 'From', 'Note'],
      ...(g.spend?.rows || []).map((r) => [r.date, chName(r.channel), r.campaign, r.spend, r.impressions, r.clicks, r.reach, r.results, r.source, r.note]),
    ]),
    'gr-connect': (t) => connectDialog(t.dataset.platform),
    'gr-sync': async (t) => {
      t.disabled = true;
      t.textContent = 'Syncing…';
      try {
        const { connection } = await api('POST', path(`/connections/${t.dataset.platform}/sync`), { days: 30 });
        toast(connection.status === 'connected' ? 'Synced ✓' : connection.error);
      } catch (err) {
        toast(err.message);
      }
      refresh();
    },
    'gr-disconnect': async (t) => {
      if (!confirm('Disconnect? Its keys are deleted. Spend already pulled in stays.')) return;
      try {
        await api('DELETE', path(`/connections/${t.dataset.platform}`));
        refresh();
      } catch (err) {
        toast(err.message);
      }
    },
    'gr-wa-test': async () => {
      const to = prompt('Send WhatsApp’s “hello_world” template to (with country code, e.g. 8801712345678):');
      if (!to) return;
      try {
        await api('POST', path('/connections/whatsapp/test-message'), { to });
        toast('Test message sent ✓');
      } catch (err) {
        toast(err.message);
      }
    },
    'gr-currency': async () => {
      const currency = prompt('Currency for budgets and spend (e.g. BDT, USD, EUR):', d().currency);
      if (!currency) return;
      try {
        await api('PATCH', path('/settings'), { currency });
        refresh();
      } catch (err) {
        toast(err.message);
      }
    },
    'gr-copy-budget': async () => {
      try {
        const prev = await api('GET', path(`?month=${shiftMonth(d().month, -1)}`));
        const chans = prev.budget?.channels || {};
        if (!Object.keys(chans).length) return toast('Last month had no budget.');
        for (const input of document.querySelectorAll('.gr-budget-in')) input.value = chans[input.name.slice(3)] || '';
        toast('Copied. Check it and press Save.');
      } catch (err) {
        toast(err.message);
      }
    },
  };

  const formActions = {
    'gr-budget': async (form, data) => {
      const channels = {};
      for (const [k, v] of data) if (k.startsWith('ch.') && v) channels[k.slice(3)] = v;
      try {
        await api('POST', path(`/budget/${d().month}`), { channels, note: data.get('note') });
        toast('Budget saved');
        refresh();
      } catch (err) {
        toast(err.message);
      }
    },
  };

  return { load, ready, view, clickActions, changeActions: {}, inputActions: {}, formActions };
}
