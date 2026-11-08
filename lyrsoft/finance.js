// Lyrsoft Costs & analytics (#/w/<ws>/finance[/<tab>]?month=&range=), plugged into app.js like hr.js.
// Record costs and income (by hand, from a bank statement, or recurring), set monthly budgets per
// category, and read the analysis: income vs costs, profit, where the money goes, budget pace,
// vendors and departments. Salaries (HR payroll) and ad spend (Ads & budget) come in by themselves.
import { barList, columnChart, lineChart, mountCharts, segmentedBar } from './charts.js';

const TABS = [
  ['overview', '📊 Analysis'],
  ['entries', '🧾 Entries'],
  ['recurring', '🔁 Recurring'],
  ['settings', '⚙ Budgets & categories'],
];
// Categorical slots in fixed order; a category keeps its slot by its rank over the whole range.
const SLOTS = ['var(--viz-1)', 'var(--viz-2)', 'var(--viz-3)', 'var(--viz-4)', 'var(--viz-5)', 'var(--viz-6)'];
const OTHER = 'var(--viz-muted)';
const METHOD_LABELS = { cash: 'Cash', bank: 'Bank transfer', card: 'Card', bkash: 'bKash', nagad: 'Nagad', rocket: 'Rocket', cheque: 'Cheque', other: 'Other' };

export function createFinance({ api, esc, toast, render, go }) {
  const f = { ws: null, data: null, query: '', type: 'all' };
  let route = null;

  const base = () => `#/w/${encodeURIComponent(f.ws)}/finance`;
  const path = (p = '') => `/workspaces/${encodeURIComponent(f.ws)}/finance${p}`;
  const d = () => f.data;
  const a = () => f.data.analysis;
  const cur = () => d().settings.currency;
  const money = (n) => `${cur()} ${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  const compact = (n) => `${cur()} ${Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n || 0)}`;
  const monthName = (m, short = false) => new Date(`${m}-01T00:00:00`).toLocaleDateString(undefined, short ? { month: 'short', year: '2-digit' } : { month: 'long', year: 'numeric' });
  const shiftMonth = (m, n) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + n, 1)).toISOString().slice(0, 7);
  const catName = (id) => d().settings.categories.find((c) => c.id === id)?.name || d().linkedNames[id] || id;
  const tab = () => (TABS.some(([id]) => id === route?.tab) ? route.tab : 'overview');
  const q = (extra = {}) => {
    const p = new URLSearchParams({ month: d().month, range: String(d().range), ...extra });
    return `?${p}`;
  };

  async function load(next) {
    route = next;
    if (next.view !== 'finance') return;
    if (f.ws !== next.ws) Object.assign(f, { ws: next.ws, data: null, query: '' });
    const p = new URLSearchParams();
    if (next.params.get('month')) p.set('month', next.params.get('month'));
    if (next.params.get('range')) p.set('range', next.params.get('range'));
    f.data = await api('GET', path(p.toString() ? `?${p}` : ''));
  }
  const ready = (r) => r.view !== 'finance' || Boolean(f.data && f.ws === r.ws);
  const refresh = async () => {
    await load(route);
    render();
  };

  // ---------------------------------------------------------------- shell

  function view() {
    const t = tab();
    setTimeout(() => mountCharts(document.querySelector('.fin')));
    return `<div class="fin">
      <div class="page-head"><div><h1>Costs &amp; analytics</h1><p>Where the money comes from and where it goes, against your budgets.</p></div></div>
      <nav class="segmented hr-tabs" aria-label="Costs and analytics">${TABS.map(([id, label]) => `<a href="${base()}/${id}${q()}"${t === id ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>
      ${t === 'overview' || t === 'entries' ? filters() : ''}
      <div class="hr-body">${{ overview: overviewView, entries: entriesView, recurring: recurringView, settings: settingsView }[t]()}</div></div>`;
  }

  // One row of filters above everything they scope.
  function filters() {
    const t = tab();
    return `<div class="hr-toolbar fin-filters">
      <span class="row"><a class="btn small" href="${base()}/${t}${q({ month: shiftMonth(d().month, -1) })}" aria-label="Previous month">‹</a>
      <input type="month" value="${esc(d().month)}" data-change="fin-month" aria-label="Month" />
      <a class="btn small" href="${base()}/${t}${q({ month: shiftMonth(d().month, 1) })}" aria-label="Next month">›</a>${d().month !== d().today.slice(0, 7) ? `<a class="btn small" href="${base()}/${t}${q({ month: d().today.slice(0, 7) })}">This month</a>` : ''}</span>
      ${t === 'overview' ? `<nav class="segmented small" aria-label="Trend range">${[6, 12, 24].map((r) => `<a href="${base()}/overview${q({ range: r })}"${d().range === r ? ' aria-current="page"' : ''}>${r} months</a>`).join('')}</nav>` : ''}
      <span class="spacer"></span>
      <button class="btn" data-click="fin-import">⬆ Import statement</button>
      <button class="btn primary" data-click="fin-add" data-type="cost">+ Cost</button>
      <button class="btn" data-click="fin-add" data-type="income">+ Income</button>
    </div>`;
  }

  // ---------------------------------------------------------------- analysis

  function delta(now, before, upIsGood) {
    if (before == null || !before) return '';
    const pct = Math.round(((now - before) / Math.abs(before)) * 100);
    if (!pct) return '<small class="muted">same as last month</small>';
    const good = (pct > 0) === upIsGood;
    return `<small class="fin-delta ${good ? 'good' : 'bad'}">${pct > 0 ? '▲' : '▼'} ${Math.abs(pct)}% <span class="muted">vs last month</span></small>`;
  }

  function overviewView() {
    const A = a();
    const t = A.totals;
    const s = A.series;
    const empty = !s.some((x) => x.income || x.costs);
    if (empty) {
      return `<section class="panel hr-welcome"><h2>Start tracking money</h2><ol>
        <li><b>Add a cost or an income</b> with the buttons above, or <b>import a bank statement</b> (CSV from your bank or a spreadsheet).</li>
        <li><b>Add recurring costs</b> like rent and subscriptions once; they add themselves every month. <a href="${base()}/recurring">Recurring</a></li>
        <li><b>Set monthly budgets</b> per category. <a href="${base()}/settings">Budgets &amp; categories</a></li>
        <li>Salaries from <b>HR payroll</b> (once final) and spend from <b>Ads &amp; budget</b> appear here automatically.</li></ol></section>`;
    }
    // Category colours: top 6 over the whole range keep their slot; the rest fold into "Other".
    const totalsByCat = {};
    for (const m of s) for (const [k, v] of Object.entries(m.byCategory)) if (d().settings.categories.find((c) => c.id === k)?.kind !== 'income') totalsByCat[k] = (totalsByCat[k] || 0) + v;
    const ranked = Object.entries(totalsByCat).sort((x, y) => y[1] - x[1]).map(([k]) => k);
    const top = ranked.slice(0, SLOTS.length);
    const colorOf = (id) => (top.includes(id) ? SLOTS[top.indexOf(id)] : OTHER);
    const stacks = [...top.map((id) => ({ name: catName(id), color: colorOf(id), id })), ...(ranked.length > top.length ? [{ name: 'Other', color: OTHER, id: '__other' }] : [])];
    const labels = s.map((m) => monthName(m.month, true));
    const budgetRows = A.categories.filter((c) => c.amount || c.budget);
    const shareParts = [...top.map((id) => ({ name: catName(id), value: A.categories.find((c) => c.id === id)?.amount || 0, color: colorOf(id), dark: SLOTS.indexOf(colorOf(id)) === 3 })), { name: 'Other', value: A.categories.filter((c) => !top.includes(c.id)).reduce((sum, c) => sum + c.amount, 0), color: OTHER }].filter((p) => p.value > 0);
    const budget = t.budget;
    const lastIncome = s.at(-1).income;
    return `
      <div class="stat-row">
        <div class="panel stat hr-tile"><span>Income · ${esc(monthName(d().month))}</span><b>${money(t.income)}</b>${delta(t.income, t.previous?.income, true)}</div>
        <div class="panel stat hr-tile"><span>Costs</span><b>${money(t.costs)}</b>${delta(t.costs, t.previous?.costs, false)}</div>
        <div class="panel stat hr-tile"><span>${t.profit < 0 ? 'Loss' : 'Profit'}</span><b class="${t.profit < 0 ? 'fin-neg' : ''}">${t.profit < 0 ? '−' : ''}${money(Math.abs(t.profit))}</b>${t.margin != null ? `<small class="muted">${t.margin}% margin</small>` : '<small class="muted">no income this month</small>'}</div>
        <div class="panel stat hr-tile"><span>Budget used</span><b>${t.budgetUsed != null ? `${t.budgetUsed}%` : '—'}</b>${budget ? `<span class="fin-meter${t.budgetUsed > 100 ? ' over' : t.budgetUsed > 85 ? ' warn' : ''}"><i style="width:${Math.min(100, t.budgetUsed)}%"></i></span><small class="muted">of ${money(budget)}${t.budgetUsed > 100 ? ' · ⚠ over' : ''}</small>` : `<small><a href="${base()}/settings">Set budgets</a></small>`}</div>
        <div class="panel stat hr-tile"><span>Unpaid bills</span><b>${money(t.unpaid)}</b><small class="muted">${t.unpaidCount} bill${t.unpaidCount === 1 ? '' : 's'}</small></div>
      </div>
      <div class="fin-grid two">
        <section class="panel">${lineChart({ title: 'Income and costs', sub: `Last ${s.length} months, ${cur()}`, labels, series: [{ name: 'Income', color: 'var(--viz-1)', values: s.map((m) => m.income) }, { name: 'Costs', color: 'var(--viz-2)', values: s.map((m) => m.costs) }], format: money })}</section>
        <section class="panel">${columnChart({ title: 'Profit and loss', sub: `Income minus costs, ${cur()}`, columns: s.map((m) => ({ label: monthName(m.month, true), values: [m.profit] })), stacks: [{ name: 'Profit', color: 'var(--viz-pos)' }], colorOf: (v) => (v < 0 ? 'var(--viz-neg)' : 'var(--viz-pos)'), legend: [{ name: 'Profit', color: 'var(--viz-pos)' }, { name: 'Loss', color: 'var(--viz-neg)' }], format: money })}</section>
      </div>
      <section class="panel">${columnChart({ title: 'Costs by category', sub: `Last ${s.length} months, ${cur()}`, columns: s.map((m) => ({ label: monthName(m.month, true), values: stacks.map((st) => (st.id === '__other' ? Object.entries(m.byCategory).filter(([k]) => !top.includes(k) && d().settings.categories.find((c) => c.id === k)?.kind !== 'income').reduce((sum, [, v]) => sum + v, 0) : m.byCategory[st.id] || 0)) })), stacks, format: money, height: 260 })}</section>
      <div class="fin-grid two">
        <section class="panel">${barList({ title: `Spending vs budget · ${monthName(d().month)}`, sub: 'The mark on each bar is its monthly budget', rows: budgetRows.map((c) => ({ name: c.name, value: c.amount, target: c.budget || 0, flag: c.over ? 'over budget' : '', note: c.linked ? 'from ' + (c.id === 'payroll' ? 'HR payroll' : 'Ads & budget') : c.budget ? `${c.used}% of budget` : '' })), format: money })}</section>
        <section class="panel">${lineChart({ title: 'Costs through the month', sub: budget ? 'Your costs (not payroll or ads), running total against an even pace to the budget' : 'Your costs (not payroll or ads), running total', labels: A.cumulative.map((x) => String(x.day)), series: [{ name: 'Spent so far', color: 'var(--viz-2)', values: A.cumulative.map((x) => (x.future ? null : x.total)) }, ...(budget ? [{ name: 'Budget pace', color: 'var(--viz-muted)', dashed: true, values: A.cumulative.map((x) => Math.round((budget / A.days) * x.day)) }] : [])], format: money, area: true, endLabels: true })}
          ${A.elapsed && A.elapsed < A.days ? `<p class="muted small">Forecast for the whole month, with payroll and ads: <b>${money(t.projected)}</b>. Recurring costs and payroll are counted once; the rest keeps its pace so far.</p>` : ''}</section>
      </div>
      <div class="fin-grid three">
        <section class="panel">${shareParts.length > 1 ? segmentedBar({ title: 'Where the money went', sub: monthName(d().month), parts: shareParts, format: money }) : '<p class="muted">One category this month.</p>'}
          ${A.incomeCategories.length ? `<h3 class="fin-h3">Income by source</h3><ul class="fin-list">${A.incomeCategories.map((c) => `<li><span>${esc(c.name)}</span><b>${money(c.amount)}</b></li>`).join('')}</ul>` : ''}</section>
        <section class="panel">${A.vendors.length ? barList({ title: 'Top vendors', sub: monthName(d().month), rows: A.vendors.slice(0, 8).map((v) => ({ name: v.name, value: v.amount, note: `${v.count} payment${v.count === 1 ? '' : 's'}` })), format: money, color: 'var(--viz-2)' }) : '<h3 class="fin-h3">Top vendors</h3><p class="muted">Add a vendor to costs to see who you pay most.</p>'}</section>
        <section class="panel">${A.departments.length ? barList({ title: 'Costs by department', sub: monthName(d().month), rows: A.departments.map((v) => ({ name: v.name, value: v.amount })), format: money, color: 'var(--viz-3)' }) : '<h3 class="fin-h3">Costs by department</h3><p class="muted">Tag costs with a department to compare teams.</p>'}
          ${A.projects.length ? `<h3 class="fin-h3">By project</h3><ul class="fin-list">${A.projects.map((p) => `<li><span>${esc(p.name)}</span><b>${money(p.amount)}</b></li>`).join('')}</ul>` : ''}</section>
      </div>
      ${A.unpaid.length ? `<section class="panel flush"><h2 class="hr-pad">Unpaid bills</h2><div class="table-scroll"><table class="data-table hr-table"><thead><tr><th>Due</th><th>Vendor</th><th>What</th><th>Category</th><th class="num">Amount</th><th></th></tr></thead><tbody>
        ${A.unpaid.map((e) => `<tr><td>${esc(e.dueDate || e.date)}${(e.dueDate || e.date) < d().today ? ' <span class="hr-badge hr-absent">⚠ overdue</span>' : ''}</td><td>${esc(e.vendor || '—')}</td><td>${esc(e.description || '')}</td><td>${esc(catName(e.category))}</td><td class="num">${money(e.amount)}</td><td><button class="btn small" data-click="fin-paid" data-date="${esc(e.date)}" data-id="${esc(e.id)}">Mark paid</button></td></tr>`).join('')}</tbody></table></div></section>` : ''}
      <p class="muted small">${d().linked.payroll ? `Includes ${money(d().linked.payroll)} of salaries from HR payroll. ` : ''}${d().linked.ads ? `Includes ${money(d().linked.ads)} of ad spend from Ads &amp; budget. ` : ''}${lastIncome ? '' : ''}Every chart has “Show as table” for the exact numbers.</p>`;
  }

  // ---------------------------------------------------------------- entries

  function entriesView() {
    const qtext = f.query.trim().toLowerCase();
    const list = d().entries.filter((e) => (f.type === 'all' || e.type === f.type) && (!qtext || [e.description, e.vendor, e.department, e.project, e.reference, catName(e.category)].some((v) => String(v || '').toLowerCase().includes(qtext))));
    const sum = (type) => list.filter((e) => e.type === type).reduce((s, e) => s + e.amount, 0);
    return `
      <div class="hr-toolbar">
        <nav class="segmented small">${[['all', 'All'], ['cost', 'Costs'], ['income', 'Income']].map(([k, l]) => `<a role="button" tabindex="0" data-click="fin-type" data-type="${k}"${f.type === k ? ' aria-current="page"' : ''}>${l}</a>`).join('')}</nav>
        <input type="search" class="hr-search" placeholder="Search vendor, description, category…" value="${esc(f.query)}" data-input="fin-search" aria-label="Search entries" />
        <span class="spacer"></span><span class="muted">Costs <b>${money(sum('cost'))}</b> · Income <b>${money(sum('income'))}</b></span>
        <button class="btn" data-click="fin-export">⬇ Export</button>
      </div>
      <section class="panel flush">${list.length ? `<div class="table-scroll"><table class="data-table hr-table">
        <thead><tr><th>Date</th><th>Description</th><th>Category</th><th>Vendor / from</th><th>Department</th><th>Paid by</th><th class="num">Amount</th><th></th></tr></thead>
        <tbody>${list.map((e) => `<tr class="hr-click" data-click="fin-edit" data-date="${esc(e.date)}" data-id="${esc(e.id)}"><td>${esc(e.date)}</td>
          <td>${esc(e.description || '—')}${e.recurringId ? ' <small class="muted">🔁</small>' : ''}${e.imported ? ' <small class="muted">⬆</small>' : ''}${e.status === 'unpaid' ? ' <span class="hr-badge hr-late">unpaid</span>' : ''}</td>
          <td>${esc(catName(e.category))}</td><td>${esc(e.vendor || '')}</td><td>${esc(e.department || '')}</td><td>${esc(METHOD_LABELS[e.method] || '')}</td>
          <td class="num"><b class="${e.type === 'income' ? 'fin-in' : ''}">${e.type === 'income' ? '+' : '−'}${money(e.amount)}</b></td><td><span class="muted">›</span></td></tr>`).join('')}</tbody></table></div>`
        : `<div class="hr-empty"><p class="muted">Nothing in ${esc(monthName(d().month))}${qtext ? ' matches' : ' yet'}.</p></div>`}</section>
      <p class="muted small">🔁 added by a recurring cost · ⬆ imported. Salaries and ad spend are added from HR and Ads &amp; budget, so they aren’t listed here.</p>`;
  }

  function entryDialog(existing, type = 'cost') {
    const e = existing || { type, date: d().month === d().today.slice(0, 7) ? d().today : `${d().month}-01`, status: 'paid', method: '' };
    const cats = d().settings.categories;
    const node = document.createElement('dialog');
    node.className = 'dialog wide hr-dialog';
    const opts = (kind) => cats.filter((c) => c.kind === kind).map((c) => `<option value="${esc(c.id)}"${c.id === e.category ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
    const vendors = [...new Set(d().entries.map((x) => x.vendor).filter(Boolean))];
    const depts = [...new Set(d().entries.map((x) => x.department).filter(Boolean))];
    node.innerHTML = `<form><h2>${existing ? 'Edit' : 'Add'} <span data-kind>${e.type === 'income' ? 'income' : 'cost'}</span></h2>
      <nav class="segmented small"><label><input type="radio" name="type" value="cost"${e.type !== 'income' ? ' checked' : ''} hidden />Cost</label><label><input type="radio" name="type" value="income"${e.type === 'income' ? ' checked' : ''} hidden />Income</label></nav>
      <div class="form-grid">
        <label>Amount (${esc(cur())}) *<input name="amount" required inputmode="decimal" value="${esc(e.amount || '')}" placeholder="0" /></label>
        <label>Date *<input type="date" name="date" required value="${esc(e.date)}" /></label>
        <label>Category<select name="category" data-cats>${opts(e.type === 'income' ? 'income' : 'cost')}</select></label>
        <label><span data-who>${e.type === 'income' ? 'From (client)' : 'Vendor'}</span><input name="vendor" maxlength="120" value="${esc(e.vendor || '')}" list="fin-vendors" /></label>
      </div>
      <label>Description<input name="description" maxlength="300" value="${esc(e.description || '')}" placeholder="What was it for?" /></label>
      <div class="form-grid">
        <label>Department<input name="department" maxlength="80" value="${esc(e.department || '')}" list="fin-depts" /></label>
        <label>Project / client<input name="project" maxlength="80" value="${esc(e.project || '')}" /></label>
        <label>Paid by<select name="method"><option value="">—</option>${d().methods.map((m) => `<option value="${m}"${m === e.method ? ' selected' : ''}>${METHOD_LABELS[m]}</option>`).join('')}</select></label>
        <label>Reference<input name="reference" maxlength="80" value="${esc(e.reference || '')}" placeholder="Invoice or receipt no." /></label>
        <label>Status<select name="status"><option value="paid"${e.status !== 'unpaid' ? ' selected' : ''}>Paid</option><option value="unpaid"${e.status === 'unpaid' ? ' selected' : ''}>Unpaid (a bill to pay)</option></select></label>
        <label>Due date<input type="date" name="dueDate" value="${esc(e.dueDate || '')}" /></label>
      </div>
      <datalist id="fin-vendors">${vendors.map((v) => `<option value="${esc(v)}"></option>`).join('')}</datalist><datalist id="fin-depts">${depts.map((v) => `<option value="${esc(v)}"></option>`).join('')}</datalist>
      <p class="auth-error" hidden></p>
      <div class="row end">${existing ? '<button type="button" class="btn danger ghost" data-delete>Delete</button><span class="spacer"></span>' : ''}<button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">${existing ? 'Save' : 'Add'}</button></div></form>`;
    document.body.append(node);
    const form = node.querySelector('form');
    const sync = () => {
      const t = form.elements.type.value;
      node.querySelector('[data-kind]').textContent = t;
      node.querySelector('[data-who]').textContent = t === 'income' ? 'From (client)' : 'Vendor';
      node.querySelector('[data-cats]').innerHTML = opts(t);
      node.querySelectorAll('.segmented label').forEach((l) => l.toggleAttribute('aria-current', l.querySelector('input').checked));
    };
    node.querySelectorAll('.segmented label').forEach((l) => l.toggleAttribute('aria-current', l.querySelector('input').checked));
    form.addEventListener('change', (ev) => ev.target.name === 'type' && sync());
    node.addEventListener('close', () => node.remove());
    node.querySelector('[data-cancel]').addEventListener('click', () => node.close());
    node.querySelector('[data-delete]')?.addEventListener('click', async () => {
      if (!confirm('Delete this entry?')) return;
      try {
        await api('DELETE', path(`/entries/${e.date}/${encodeURIComponent(e.id)}`));
        node.close();
        refresh();
      } catch (err) {
        toast(err.message);
      }
    });
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const body = Object.fromEntries(new FormData(form));
      try {
        await (existing ? api('PATCH', path(`/entries/${e.date}/${encodeURIComponent(e.id)}`), body) : api('POST', path('/entries'), body));
        node.close();
        toast(existing ? 'Saved' : `${body.type === 'income' ? 'Income' : 'Cost'} added`);
        refresh();
      } catch (err) {
        const box = node.querySelector('.auth-error');
        box.textContent = err.message;
        box.hidden = false;
      }
    });
    node.showModal();
    setTimeout(() => form.elements.amount.focus());
  }

  // A bank statement or spreadsheet: pick the file, match its columns, import.
  function importDialog() {
    const node = document.createElement('dialog');
    node.className = 'dialog wide hr-dialog';
    node.innerHTML = `<form><h2>Import a statement</h2>
      <p class="muted">A CSV from your bank (BRAC, City, DBBL, EBL…), bKash or Nagad, or any spreadsheet saved as CSV. Money going out becomes a cost, money coming in an income; categories are guessed from the description and can be changed later.</p>
      <label>File<input type="file" name="file" accept=".csv,text/csv" required /></label>
      <div data-map hidden></div>
      <p class="auth-error" hidden></p>
      <div class="row end"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary" disabled>Import</button></div></form>`;
    document.body.append(node);
    const form = node.querySelector('form');
    const button = form.querySelector('button.primary');
    let rows = [];
    let headers = [];
    node.addEventListener('close', () => node.remove());
    node.querySelector('[data-cancel]').addEventListener('click', () => node.close());
    const guess = (re) => headers.find((h) => re.test(h)) || '';
    form.elements.file.addEventListener('change', async () => {
      const file = form.elements.file.files[0];
      if (!file) return;
      const textValue = await file.text();
      const lines = rawCSV(textValue);
      headers = lines[0] || [];
      rows = lines.slice(1).filter((r) => r.some((c) => c.trim())).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
      const pick = (name, label, re, optional = true) => `<label>${label}<select name="map.${name}">${optional ? '<option value="">—</option>' : ''}${headers.map((h) => `<option${h === guess(re) ? ' selected' : ''}>${esc(h)}</option>`).join('')}</select></label>`;
      const map = node.querySelector('[data-map]');
      map.hidden = false;
      map.innerHTML = `<p><b>${rows.length.toLocaleString()} rows.</b> Which column is which?</p><div class="form-grid">
        ${pick('date', 'Date *', /date|তারিখ|time/i, false)}${pick('description', 'Description', /desc|particular|narration|details|remark|memo|note/i)}
        ${pick('amount', 'Amount (− = cost)', /^amount|^amt|value|taka|bdt/i)}${pick('debit', 'Or: money out (debit)', /debit|withdraw|out|dr\b/i)}
        ${pick('credit', 'Money in (credit)', /credit|deposit|in\b|cr\b/i)}${pick('vendor', 'Vendor', /vendor|payee|merchant|party|name/i)}
        ${pick('category', 'Category', /categor/i)}${pick('reference', 'Reference', /ref|cheque|txn|transaction id/i)}</div>`;
      button.disabled = !rows.length;
    });
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const data = new FormData(form);
      const col = (k) => data.get(`map.${k}`) || '';
      const entries = rows.map((r) => ({ date: r[col('date')], description: r[col('description')], amount: col('amount') ? r[col('amount')] : '', debit: col('debit') ? r[col('debit')] : '', credit: col('credit') ? r[col('credit')] : '', vendor: col('vendor') ? r[col('vendor')] : '', category: col('category') ? r[col('category')] : '', reference: col('reference') ? r[col('reference')] : '' }));
      button.disabled = true;
      try {
        let imported = 0;
        let skipped = 0;
        for (let i = 0; i < entries.length; i += 1000) {
          const res = await api('POST', path('/import'), { entries: entries.slice(i, i + 1000) });
          imported += res.imported;
          skipped += res.skipped;
        }
        node.close();
        toast(`Imported ${imported} entr${imported === 1 ? 'y' : 'ies'}${skipped ? `, skipped ${skipped} without a date or amount` : ''}`);
        refresh();
      } catch (err) {
        const box = node.querySelector('.auth-error');
        box.textContent = err.message;
        box.hidden = false;
        button.disabled = false;
      }
    });
    node.showModal();
  }

  // ---------------------------------------------------------------- recurring

  function recurringView() {
    const list = d().recurring;
    const monthly = list.filter((r) => r.active).reduce((s, r) => s + r.amount / ({ monthly: 1, quarterly: 3, yearly: 12 }[r.frequency] || 1), 0);
    return `
      <div class="hr-toolbar"><span class="muted">${list.filter((r) => r.active).length} active · about <b>${money(monthly)}</b> a month</span><span class="spacer"></span><button class="btn primary" data-click="fin-rec">+ Recurring cost</button></div>
      <section class="panel flush">${list.length ? `<div class="table-scroll"><table class="data-table hr-table"><thead><tr><th>Cost</th><th>Category</th><th>Vendor</th><th>Every</th><th>From</th><th class="num">Amount</th><th>Status</th></tr></thead><tbody>
        ${list.map((r) => `<tr class="hr-click${r.active ? '' : ' is-disabled'}" data-click="fin-rec" data-id="${esc(r.id)}"><td><b>${esc(r.name)}</b></td><td>${esc(catName(r.category))}</td><td>${esc(r.vendor || '')}</td><td>${esc(r.frequency)} on day ${r.day}</td><td>${esc(r.start)}${r.end ? ` → ${esc(r.end)}` : ''}</td><td class="num">${money(r.amount)}</td><td>${r.active ? '<span class="hr-badge hr-present">Active</span>' : '<span class="hr-badge hr-off">Paused</span>'}</td></tr>`).join('')}</tbody></table></div>`
        : '<div class="hr-empty"><p class="muted">Rent, salaries paid outside payroll, internet, software subscriptions, loan instalments: add them once and they’re added to your costs on their day every month.</p><button class="btn primary" data-click="fin-rec">+ Recurring cost</button></div>'}</section>`;
  }

  function recurringDialog(existing) {
    const r = existing || { frequency: 'monthly', day: 1, start: d().today.slice(0, 7), active: true };
    const node = document.createElement('dialog');
    node.className = 'dialog hr-dialog';
    node.innerHTML = `<form><h2>${existing ? 'Edit' : 'New'} recurring cost</h2>
      <label>Name *<input name="name" required maxlength="120" value="${esc(r.name || '')}" placeholder="Office rent, internet, Figma…" /></label>
      <div class="form-grid">
        <label>Amount (${esc(cur())}) *<input name="amount" required inputmode="decimal" value="${esc(r.amount || '')}" /></label>
        <label>Category<select name="category">${d().settings.categories.filter((c) => c.kind === 'cost').map((c) => `<option value="${esc(c.id)}"${c.id === r.category ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
        <label>Every<select name="frequency">${d().frequencies.map((x) => `<option${x === r.frequency ? ' selected' : ''}>${x}</option>`).join('')}</select></label>
        <label>On day<input name="day" type="number" min="1" max="28" value="${r.day}" /></label>
        <label>First month<input type="month" name="start" required value="${esc(r.start)}" /></label>
        <label>Last month<input type="month" name="end" value="${esc(r.end || '')}" /></label>
        <label>Vendor<input name="vendor" maxlength="120" value="${esc(r.vendor || '')}" /></label>
        <label>Department<input name="department" maxlength="80" value="${esc(r.department || '')}" /></label>
      </div>
      <label class="check"><input type="checkbox" name="active"${r.active ? ' checked' : ''} /> Active</label>
      <p class="muted small">Past months from the first month are added straight away; changes apply from the next time it’s due.</p>
      <p class="auth-error" hidden></p>
      <div class="row end">${existing ? '<button type="button" class="btn danger ghost" data-delete>Delete</button><span class="spacer"></span>' : ''}<button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">Save</button></div></form>`;
    document.body.append(node);
    const form = node.querySelector('form');
    node.addEventListener('close', () => node.remove());
    node.querySelector('[data-cancel]').addEventListener('click', () => node.close());
    node.querySelector('[data-delete]')?.addEventListener('click', async () => {
      if (!confirm('Delete this recurring cost? Entries it already added stay.')) return;
      await api('DELETE', path(`/recurring/${encodeURIComponent(r.id)}`)).catch((err) => toast(err.message));
      node.close();
      refresh();
    });
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const body = Object.fromEntries(new FormData(form));
      body.active = body.active === 'on';
      try {
        await (existing ? api('PATCH', path(`/recurring/${encodeURIComponent(r.id)}`), body) : api('POST', path('/recurring'), body));
        node.close();
        toast('Saved');
        refresh();
      } catch (err) {
        const box = node.querySelector('.auth-error');
        box.textContent = err.message;
        box.hidden = false;
      }
    });
    node.showModal();
  }

  // ---------------------------------------------------------------- settings

  function settingsView() {
    const s = d().settings;
    const row = (c = { id: '', name: '', kind: 'cost', budget: 0 }) => `<tr class="fin-cat"><td><input name="name" value="${esc(c.name)}" maxlength="60" placeholder="Category name" aria-label="Category name" /><input type="hidden" name="id" value="${esc(c.id)}" /></td>
      <td><select name="kind" aria-label="Kind"><option value="cost"${c.kind === 'cost' ? ' selected' : ''}>Cost</option><option value="income"${c.kind === 'income' ? ' selected' : ''}>Income</option></select></td>
      <td class="num"><input name="budget" class="hr-cell" inputmode="decimal" value="${c.budget || ''}" placeholder="0" aria-label="Monthly budget" /></td><td><button type="button" class="btn small ghost" data-remove-cat aria-label="Remove">✕</button></td></tr>`;
    return `<form class="panel flush hr-settings fin-settings" data-form="fin-settings">
      <div class="hr-pad"><h2>Categories and monthly budgets</h2><p class="muted">A cost category’s budget is what you plan to spend on it each month. Income categories group money coming in.</p></div>
      <div class="table-scroll"><table class="data-table hr-table"><thead><tr><th>Category</th><th>Kind</th><th class="num">Monthly budget (${esc(s.currency)})</th><th></th></tr></thead>
        <tbody data-cats>${s.categories.map(row).join('')}</tbody>
        <tfoot><tr><th colspan="4"><button type="button" class="btn small" data-add-cat>+ Add category</button></th></tr></tfoot></table></div>
      <div class="hr-pad"><p class="muted small">Salaries come from HR payroll and advertising from Ads &amp; budget, as their own categories. Budget those in HR and Ads &amp; budget.</p>
        <div class="form-grid"><label>Currency<input name="currency" value="${esc(s.currency)}" maxlength="8" /></label>
        ${d().admin ? `<label>Who else can see finances<input name="viewers" value="${esc(s.viewers.join(', '))}" placeholder="accounts@company.com" /><small class="muted">Workspace owners and admins always can.</small></label>` : ''}</div>
        <div class="row end"><button class="btn primary">Save</button></div></div>
      <template data-row>${row()}</template>
    </form>`;
  }

  // ---------------------------------------------------------------- actions

  function rawCSV(textValue) {
    const out = [];
    let row = [];
    let cell = '';
    let quoted = false;
    const s = textValue.replace(/^﻿/, '');
    const sep = (s.split('\n')[0].match(/;/g) || []).length > (s.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
    for (let i = 0; i < s.length; i += 1) {
      const ch = s[i];
      if (quoted) {
        if (ch === '"' && s[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === sep) {
        row.push(cell.trim());
        cell = '';
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && s[i + 1] === '\n') i += 1;
        row.push(cell.trim());
        out.push(row);
        row = [];
        cell = '';
      } else cell += ch;
    }
    if (cell || row.length) out.push([...row, cell.trim()]);
    // Bank exports often start with a few lines of account details: start at the first row that has a "date" column.
    const start = out.findIndex((r) => r.some((c) => /date|তারিখ/i.test(c)));
    return start > 0 ? out.slice(start) : out;
  }

  const clickActions = {
    'fin-add': (t) => entryDialog(null, t.dataset.type),
    'fin-edit': (t) => entryDialog(d().entries.find((e) => e.id === t.dataset.id)),
    'fin-import': () => importDialog(),
    'fin-type': (t) => {
      f.type = t.dataset.type;
      render();
    },
    'fin-paid': async (t) => {
      try {
        await api('PATCH', path(`/entries/${t.dataset.date}/${encodeURIComponent(t.dataset.id)}`), { status: 'paid' });
        toast('Marked paid');
        refresh();
      } catch (err) {
        toast(err.message);
      }
    },
    'fin-rec': (t) => recurringDialog(t.dataset.id ? d().recurring.find((r) => r.id === t.dataset.id) : null),
    'fin-export': () => {
      const rows = [['Date', 'Type', 'Category', 'Description', 'Vendor', 'Department', 'Project', 'Paid by', 'Reference', 'Status', 'Amount'], ...d().entries.map((e) => [e.date, e.type, catName(e.category), e.description, e.vendor, e.department, e.project, METHOD_LABELS[e.method] || '', e.reference, e.status, e.type === 'cost' ? -e.amount : e.amount])];
      const csv = rows.map((r) => r.map((v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''))).join(',')).join('\r\n');
      const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }));
      const link = Object.assign(document.createElement('a'), { href: url, download: `finance-${d().month}.csv` });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  };

  const changeActions = {
    'fin-month': (t) => t.value && go(`${base()}/${tab()}${q({ month: t.value })}`),
  };

  const inputActions = {
    'fin-search': (t) => {
      f.query = t.value;
      const at = t.selectionStart;
      render();
      const s = document.querySelector('.fin .hr-search');
      s?.focus();
      s?.setSelectionRange(at, at);
    },
  };

  const formActions = {
    'fin-settings': async (form) => {
      const categories = [...form.querySelectorAll('.fin-cat')].map((tr) => ({ id: tr.querySelector('[name=id]').value, name: tr.querySelector('[name=name]').value, kind: tr.querySelector('[name=kind]').value, budget: tr.querySelector('[name=budget]').value })).filter((c) => c.name.trim());
      const body = { categories, currency: form.querySelector('[name=currency]').value };
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

  // Rows in the categories table are added and removed in place (no re-render while typing).
  document.addEventListener('click', (e) => {
    const form = e.target.closest('.fin-settings');
    if (!form) return;
    if (e.target.closest('[data-add-cat]')) {
      form.querySelector('[data-cats]').append(form.querySelector('template[data-row]').content.cloneNode(true));
      form.querySelector('[data-cats] tr:last-child input')?.focus();
    }
    if (e.target.closest('[data-remove-cat]')) e.target.closest('tr').remove();
  });

  return { load, ready, view, clickActions, changeActions, inputActions, formActions };
}
