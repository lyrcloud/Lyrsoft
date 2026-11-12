// Lyrsoft Ad revenue (#/w/<ws>/ads[/<tab>]?month=), plugged into app.js above SEO. Earning from ads
// on the workspace's own websites (Google AdSense) and apps (Google AdMob), as opposed to Ads &
// budget, which tracks money spent on advertising. Owners and admins connect each network with their
// own Google OAuth client (api/work/ads.mjs); earnings sync every 6 hours or when someone presses Sync.
import { columnChart, mountCharts } from './charts.js';

const TABS = [
  ['overview', '💰 Earnings'],
  ['accounts', '🔌 Accounts'],
];
const COLORS = { adsense: 'var(--viz-1)', admob: 'var(--viz-2)' };

export function createAds({ api, esc, toast, render, formatDateTime }) {
  const s = { ws: null, data: null };
  let route = null;

  const base = () => `#/w/${encodeURIComponent(s.ws)}/ads`;
  const path = (p = '') => `/workspaces/${encodeURIComponent(s.ws)}/ads${p}`;
  const d = () => s.data;
  const plat = (k) => d().catalog.platforms[k];
  const tab = () => (TABS.some(([id]) => id === route?.tab) ? route.tab : 'overview');
  const money = (n, digits = 2) => `${d().currency} ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
  const num = (n) => (n == null ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }));
  const monthName = (m) => new Date(`${m}-01T00:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const shiftMonth = (m, n) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + n, 1)).toISOString().slice(0, 7);
  const tile = (label, value, sub = '', tone = '') => `<div class="panel stat hr-tile${tone ? ` hr-tone-${tone}` : ''}"><span>${label}</span><b>${value}</b>${sub ? `<small class="muted">${sub}</small>` : ''}</div>`;
  const logo = (k) => `<span class="gr-logo" style="background:${plat(k).color}" aria-hidden="true">${plat(k).icon}</span>`;

  async function load(next) {
    route = next;
    if (next.view !== 'ads') return;
    if (s.ws !== next.ws) Object.assign(s, { ws: next.ws, data: null });
    const month = next.params.get('month') || '';
    s.data = await api('GET', path(month ? `?month=${month}` : ''));
  }
  const ready = (r) => r.view !== 'ads' || Boolean(s.data && s.ws === r.ws);
  const refresh = async () => {
    await load(route);
    render();
  };

  function view() {
    const t = tab();
    setTimeout(() => mountCharts(document.querySelector('.ads')));
    const monthNav = t === 'overview'
      ? `<span class="row gr-month"><a class="btn small" href="${base()}/overview?month=${shiftMonth(d().month, -1)}" aria-label="Previous month">‹</a><b>${esc(monthName(d().month))}</b><a class="btn small" href="${base()}/overview?month=${shiftMonth(d().month, 1)}" aria-label="Next month">›</a></span>`
      : '';
    return `<div class="ads">
      <div class="page-head"><div><h1>Ad revenue</h1><p>What ads on your own websites and apps earn. Money you spend on ads lives in Ads &amp; budget.</p></div>${monthNav ? `<div class="page-actions">${monthNav}</div>` : ''}</div>
      <nav class="segmented hr-tabs" aria-label="Ad revenue">${TABS.map(([id, label]) => `<a href="${base()}/${id}"${t === id ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>
      <div class="hr-body">${t === 'accounts' ? accountsView() : overviewView()}</div></div>`;
  }

  // ---------------------------------------------------------------- earnings

  function overviewView() {
    const r = d().report;
    const t = r.totals;
    const conns = d().connections;
    if (!conns.length && !t.earnings) {
      return `<section class="panel hr-welcome"><h2>Get started</h2>
        <p>Connect the ad accounts you already have and Lyrsoft shows what they earn, per day, site and app.</p>
        <div class="ads-grid">${Object.keys(d().catalog.platforms).map((k) => `<div class="ads-pick">${logo(k)}<div><b>${esc(plat(k).name)}</b><small class="muted">${esc(plat(k).what)}</small></div></div>`).join('')}</div>
        ${d().manage ? `<p><a class="btn primary" href="${base()}/accounts">Connect an account</a></p>` : '<p class="muted">A workspace owner or admin connects the accounts.</p>'}</section>`;
    }
    const changeTone = t.change == null ? '' : t.change >= 0 ? 'ok' : 'warn';
    const past = r.daily.filter((x) => !x.future);
    return `
      ${r.mixedCurrencies ? '<p class="gr-error">Your accounts report in different currencies, so totals mix them. Set both to one currency in AdSense and AdMob.</p>' : ''}
      ${conns.some((c) => c.status === 'error') ? `<p class="gr-error">A connection needs attention. <a href="${base()}/accounts">Accounts</a></p>` : ''}
      <div class="stat-row">
        ${tile('Earned', money(t.earnings), r.elapsed && r.elapsed < r.days ? `heading for ${money(t.projected, 0)}` : 'whole month')}
        ${tile('vs last month', t.change == null ? '—' : `${t.change >= 0 ? '▲' : '▼'} ${Math.abs(t.change)}%`, `same days last month: ${money(t.previousSoFar)}`, changeTone)}
        ${tile('Impressions', num(t.impressions), `${num(t.clicks)} clicks · CTR ${t.ctr == null ? '—' : `${t.ctr}%`}`)}
        ${tile(t.rpm != null ? 'Page RPM' : 'eCPM', t.rpm != null ? money(t.rpm) : t.ecpm != null ? money(t.ecpm) : '—', t.rpm != null ? 'per 1,000 page views' : 'per 1,000 impressions')}
      </div>
      <section class="panel">${columnChart({
        title: 'Earnings per day',
        sub: `${monthName(r.month)}, ${d().currency}`,
        columns: past.map((x) => ({ label: String(Number(x.date.slice(8))), values: [x.adsense, x.admob] })),
        stacks: Object.keys(d().catalog.platforms).map((k) => ({ name: plat(k).short, color: COLORS[k] })),
        format: (v) => money(v),
        height: 220,
      })}</section>
      <div class="hr-grid">
        <section class="panel flush"><h2 class="hr-pad">By network</h2>${r.platforms.length ? `<div class="table-scroll"><table class="data-table hr-table"><thead><tr><th>Network</th><th class="num">Earned</th><th class="num">Impressions</th><th class="num">Clicks</th><th class="num">eCPM</th></tr></thead><tbody>${r.platforms.map((p) => `<tr><td>${esc(plat(p.platform)?.short || p.platform)}</td><td class="num">${money(p.earnings)}</td><td class="num">${num(p.impressions)}</td><td class="num">${num(p.clicks)}</td><td class="num">${p.ecpm == null ? '—' : money(p.ecpm)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted hr-pad">Nothing earned this month yet.</p>'}</section>
        <section class="panel flush"><h2 class="hr-pad">Sites and apps</h2>${r.properties.length ? `<div class="table-scroll"><table class="data-table hr-table"><thead><tr><th>Site or app</th><th class="num">Earned</th><th class="num">${r.properties.some((p) => p.pageViews) ? 'Page views' : 'Impressions'}</th><th class="num">RPM / eCPM</th></tr></thead><tbody>${r.properties.slice(0, 50).map((p) => `<tr><td>${esc(p.property)} <small class="muted">${esc(plat(p.platform)?.property || '')}</small></td><td class="num">${money(p.earnings)}</td><td class="num">${num(p.pageViews || p.impressions)}</td><td class="num">${p.rpm != null ? money(p.rpm) : p.ecpm != null ? money(p.ecpm) : '—'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted hr-pad">Nothing earned this month yet.</p>'}</section>
      </div>
      <p class="muted small">Estimated earnings, as AdSense and AdMob report them. Final amounts can change for a few days and are settled monthly by Google.</p>`;
  }

  // ---------------------------------------------------------------- accounts

  function accountsView() {
    const conns = new Map(d().connections.map((c) => [c.platform, c]));
    const manage = d().manage;
    return `
      <p class="muted">Connect each network with your own Google sign-in. Lyrsoft only reads reports (read-only access), syncs every 6 hours or when you press Sync, and stores your keys encrypted: only their last 4 characters are ever shown.</p>
      <div class="gr-platforms">${Object.entries(d().catalog.platforms).map(([key, p]) => {
        const c = conns.get(key);
        return `<article class="panel gr-platform${c ? ` is-${esc(c.status)}` : ''}">
          <header>${logo(key)}<div><h3>${esc(p.name)}</h3><small class="muted">${esc(p.what)}</small></div>
            <span class="hr-badge ${c ? (c.status === 'connected' ? 'hr-present' : 'hr-absent') : 'hr-off'}">${c ? (c.status === 'connected' ? 'Connected' : 'Error') : 'Not connected'}</span></header>
          ${c ? `<p class="small"><b>${esc(c.account?.name || c.config.accountId || '')}</b>${c.account?.id && c.account.id !== c.account.name ? ` <span class="muted">${esc(c.account.id)}</span>` : ''}${c.account?.currency ? ` · ${esc(c.account.currency)}` : ''}</p>
            ${c.error ? `<p class="gr-error">${esc(c.error)}</p>` : ''}
            <p class="muted small">${c.lastSyncAt ? `Synced ${esc(formatDateTime(c.lastSyncAt))}${c.lastSyncRows != null ? ` · ${c.lastSyncRows} days × ${p.property.toLowerCase()}s` : ''}` : 'Not synced yet'}</p>
            <div class="row"><button class="btn small primary" data-click="ads-sync" data-platform="${key}">↻ Sync</button>${manage ? `<button class="btn small" data-click="ads-connect" data-platform="${key}">Settings</button><button class="btn small danger ghost" data-click="ads-disconnect" data-platform="${key}">Disconnect</button>` : ''}</div>`
          : `<p class="small muted">Earnings, impressions and clicks per day and ${p.property.toLowerCase()}.</p>
            ${manage ? `<button class="btn small primary" data-click="ads-connect" data-platform="${key}">Connect</button>` : '<p class="muted small">A workspace owner or admin connects it.</p>'}`}
        </article>`;
      }).join('')}</div>
      <section class="panel"><h2>How to connect (about 5 minutes)</h2><ol class="ads-steps">
        <li>In <a href="https://console.cloud.google.com/apis/library" target="_blank" rel="noopener">Google Cloud ↗</a>, pick or create a project and enable the <b>AdSense Management API</b> and/or the <b>AdMob API</b>.</li>
        <li>Under <b>APIs &amp; Services → OAuth consent screen</b>, add yourself as a test user. Under <b>Credentials</b>, create an <b>OAuth client ID</b> (Web application) with the redirect URI <code>https://developers.google.com/oauthplayground</code>.</li>
        <li>Open the <a href="https://developers.google.com/oauthplayground" target="_blank" rel="noopener">OAuth Playground ↗</a>, press ⚙ and tick <b>Use your own OAuth credentials</b>, paste the client ID and secret, enter the scope shown in the connect form, press <b>Authorize APIs</b>, sign in with the Google account that owns AdSense/AdMob, then <b>Exchange authorization code for tokens</b>.</li>
        <li>Press <b>Connect</b> above and paste the client ID, client secret and refresh token. Lyrsoft checks them and pulls the last 30 days straight away.</li>
      </ol></section>`;
  }

  function connectDialog(platform) {
    const p = plat(platform);
    const c = d().connections.find((x) => x.platform === platform);
    const node = document.createElement('dialog');
    node.className = 'dialog wide hr-dialog';
    node.innerHTML = `<form><h2>${logo(platform)} Connect ${esc(p.short)}</h2>
      <p class="muted small">Read-only access with your own Google OAuth client and the scope <code>${esc(p.scope)}</code>. Enable the ${esc(p.api)} in Google Cloud first. <a href="${esc(p.docs)}" target="_blank" rel="noopener">${esc(p.api)} docs ↗</a></p>
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

  const clickActions = {
    'ads-connect': (t) => connectDialog(t.dataset.platform),
    'ads-sync': async (t) => {
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
    'ads-disconnect': async (t) => {
      if (!confirm('Disconnect? Its keys are deleted. Earnings already pulled in stay.')) return;
      try {
        await api('DELETE', path(`/connections/${t.dataset.platform}`));
        toast('Disconnected');
        refresh();
      } catch (err) {
        toast(err.message);
      }
    },
  };

  return { load, ready, view, clickActions };
}
