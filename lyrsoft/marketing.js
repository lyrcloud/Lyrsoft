// Lyrsoft Marketing (#/w/<ws>/marketing[/<tab>[/<id>]]), plugged into app.js like contacts.js.
// Each workspace gets an audience of subscribers, signup forms for any website, email campaigns with a
// live preview, sending (now or scheduled) and reports: opens, clicks, unsubscribes, bounces.
// The email itself is drawn by marketing-email.js, the same code the API sends with.
import { parseContactsFile } from './contacts-formats.js';
import { DEFAULT_COLOR, extractLinks, merge, renderCampaignEmail } from './marketing-email.js';

const TABS = [
  ['overview', '📊 Overview'],
  ['campaigns', '✉ Campaigns'],
  ['audience', '👥 Audience'],
  ['forms', '📝 Signup forms'],
  ['settings', '⚙ Settings'],
];
const STATUS_LABELS = { draft: 'Draft', scheduled: 'Scheduled', sending: 'Sending', sent: 'Sent', cancelled: 'Stopped' };
const SUB_LABELS = { subscribed: 'Subscribed', unsubscribed: 'Unsubscribed', bounced: 'Bounced', complained: 'Marked as spam' };
const SOURCE_LABELS = { manual: 'Added by hand', form: 'Signup form', csv: 'File', vcard: 'File', paste: 'Pasted', contacts: 'Contacts', team: 'Team', import: 'Import' };
const SHOWN_MAX = 500;
const IMPORT_CHUNK = 1000;
const SAMPLE_BODY = `# Hello {{first_name|there}} 👋

Here's what's new this month.

**Big news:** write the headline of your update here, then a sentence or two about why it matters to your readers.

- One thing worth knowing
- Another thing worth knowing
- A third, with [a link](https://lyrsoft.com)

[button: Read more](https://lyrsoft.com)

Thanks for reading,
The team`;

export function createMarketing({ api, esc, toast, render, go, formatDateTime, getMe, getWs }) {
  const m = { ws: null, overview: null, subscribers: null, campaign: null, recipients: null, recipientFilter: 'all', query: '', filter: 'subscribed', selected: new Set(), preview: 'desktop' };
  let route = null;
  let saveTimer = null;
  let pollTimer = null;

  const base = () => `#/w/${encodeURIComponent(m.ws)}/marketing`;
  const path = (p) => `/workspaces/${encodeURIComponent(m.ws)}/marketing${p}`;
  const pct = (n, d) => (d ? `${Math.round((n / d) * 1000) / 10}%` : '—');
  const num = (n) => Number(n || 0).toLocaleString();
  const plural = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;

  // ---------------------------------------------------------------- loading

  async function loadOverview() {
    m.overview = await api('GET', path(''));
  }
  async function loadSubscribers() {
    m.subscribers = (await api('GET', path('/subscribers'))).subscribers;
    for (const e of m.selected) if (!m.subscribers.some((s) => s.email === e)) m.selected.delete(e);
  }

  async function load(next) {
    route = next;
    clearInterval(pollTimer);
    pollTimer = null;
    if (next.view !== 'marketing') return;
    if (m.ws !== next.ws) Object.assign(m, { ws: next.ws, overview: null, subscribers: null, campaign: null, recipients: null, selected: new Set(), query: '' });
    await loadOverview();
    if (next.tab === 'audience' && !m.subscribers) await loadSubscribers();
    if (next.tab === 'campaigns' && next.id) {
      if (m.campaign?.id !== next.id) {
        m.campaign = (await api('GET', path(`/campaigns/${encodeURIComponent(next.id)}`))).campaign;
        m.recipients = null;
      }
      if (m.campaign.status === 'sending') startPolling();
    } else {
      m.campaign = null;
    }
  }

  // While a campaign sends, refresh its numbers every few seconds.
  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      if (route?.view !== 'marketing' || !m.campaign || m.campaign.status !== 'sending') {
        clearInterval(pollTimer);
        return;
      }
      try {
        m.campaign = (await api('GET', path(`/campaigns/${encodeURIComponent(m.campaign.id)}`))).campaign;
        if (m.campaign.status !== 'sending') {
          clearInterval(pollTimer);
          await loadOverview();
          toast(m.campaign.status === 'sent' ? 'Campaign sent ✓' : 'Sending stopped');
        }
        render();
      } catch {
        /* try again next time */
      }
    }, 3000);
  }

  // ---------------------------------------------------------------- pieces

  function tabs() {
    const tab = route.tab || 'overview';
    return `<nav class="segmented mkt-tabs" aria-label="Marketing">${TABS.map(([id, label]) => `<a href="${base()}${id === 'overview' ? '' : `/${id}`}"${tab === id ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>`;
  }

  const statusBadge = (status) => `<span class="mkt-status mkt-status-${esc(status)}">${esc(STATUS_LABELS[status] || status)}</span>`;
  const subBadge = (status) => `<span class="mkt-status mkt-sub-${esc(status)}">${esc(SUB_LABELS[status] || status)}</span>`;
  const audienceLabel = (a) => (a?.tags?.length ? `Tagged ${a.tags.map((t) => `“${esc(t)}”`).join(' or ')}` : 'All subscribers');
  const tile = (label, value, sub = '') => `<div class="panel stat"><span>${label}</span><b>${value}</b>${sub ? `<small class="muted">${sub}</small>` : ''}</div>`;

  function audienceSize(audience) {
    const o = m.overview;
    if (!audience?.tags?.length) return o.counts.subscribed;
    // An upper bound from tag counts; exact once the audience list is loaded.
    if (m.subscribers) return m.subscribers.filter((s) => s.status === 'subscribed' && s.tags?.some((t) => audience.tags.includes(t))).length;
    return null;
  }

  function settingsComplete() {
    const s = m.overview.settings;
    return Boolean(s.fromName && s.address);
  }

  // ---------------------------------------------------------------- overview

  function overviewView() {
    const o = m.overview;
    const sent = o.campaigns.filter((c) => c.status === 'sent' || c.status === 'cancelled');
    const delivered = sent.reduce((t, c) => t + c.stats.sent, 0);
    const opens = sent.reduce((t, c) => t + c.stats.uniqueOpens, 0);
    const clicks = sent.reduce((t, c) => t + c.stats.uniqueClicks, 0);
    const steps = [
      [settingsComplete(), 'Set your sender name and postal address', `${base()}/settings`],
      [o.counts.total > 0, 'Add or import subscribers', `${base()}/audience`],
      [o.forms.length > 0, 'Create a signup form for your website', `${base()}/forms`],
      [sent.length > 0, 'Send your first campaign', `${base()}/campaigns`],
    ];
    const todo = steps.filter(([done]) => !done).length;
    return `
      <div class="stat-row">
        ${tile('Subscribed', num(o.counts.subscribed), o.newLast30Days ? `+${num(o.newLast30Days)} in 30 days` : '')}
        ${tile('Campaigns sent', num(sent.length), delivered ? `${num(delivered)} emails delivered` : '')}
        ${tile('Open rate', pct(opens, delivered), 'unique opens, all campaigns')}
        ${tile('Click rate', pct(clicks, delivered), 'unique clicks, all campaigns')}
        ${tile('Sent today', num(o.limits.sentToday), `of ${num(o.limits.daily)} a day`)}
      </div>
      ${todo ? `
      <section class="panel">
        <h2 class="mkt-h2">Get set up <span class="muted small">${steps.length - todo} of ${steps.length} done</span></h2>
        <ol class="mkt-steps">${steps.map(([done, label, href]) => `<li class="${done ? 'done' : ''}"><span aria-hidden="true">${done ? '✓' : '○'}</span><a href="${href}">${esc(label)}</a></li>`).join('')}</ol>
      </section>` : ''}
      <section class="panel">
        <div class="panel-head spread"><h2 class="mkt-h2">Recent campaigns</h2><button class="btn small primary" data-click="mkt-new-campaign">+ New campaign</button></div>
        ${o.campaigns.length ? campaignTable(o.campaigns.slice(0, 6)) : '<p class="muted">No campaigns yet. Write one and send it to your subscribers.</p>'}
      </section>
      ${o.tags.length ? `
      <section class="panel">
        <h2 class="mkt-h2">Tags</h2>
        <p class="mkt-tag-list">${o.tags.map((t) => `<a class="chip" href="${base()}/audience" data-click="mkt-filter-tag" data-tag="${esc(t.tag)}">${esc(t.tag)} <b>${num(t.count)}</b></a>`).join('')}</p>
      </section>` : ''}`;
  }

  // ---------------------------------------------------------------- campaigns

  function campaignTable(list) {
    return `
      <div class="table-scroll"><table class="data-table mkt-table">
        <thead><tr><th>Campaign</th><th>Status</th><th>Audience</th><th class="num">Recipients</th><th class="num">Opened</th><th class="num">Clicked</th><th>Date</th></tr></thead>
        <tbody>${list.map((c) => {
          const s = c.stats;
          const when = c.status === 'scheduled' ? c.scheduledAt : c.finishedAt || c.startedAt || c.updatedAt;
          return `<tr>
            <td><a class="mkt-camp-link" href="${base()}/campaigns/${encodeURIComponent(c.id)}"><b>${esc(c.name)}</b><small class="muted">${esc(c.subject || 'No subject yet')}</small></a></td>
            <td>${statusBadge(c.status)}</td>
            <td class="muted small">${audienceLabel(c.audience)}</td>
            <td class="num">${s.recipients ? num(s.recipients) : '—'}</td>
            <td class="num">${s.sent ? pct(s.uniqueOpens, s.sent) : '—'}</td>
            <td class="num">${s.sent ? pct(s.uniqueClicks, s.sent) : '—'}</td>
            <td class="muted small">${when ? `${c.status === 'scheduled' ? 'Sends ' : ''}${esc(formatDateTime(when))}` : ''}</td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>`;
  }

  function campaignsView() {
    const list = m.overview.campaigns;
    return `
      <div class="panel-head spread mkt-section-head"><p class="muted">Write an email, preview it, send a test, then send it to everyone or a tagged group, now or later.</p><button class="btn primary" data-click="mkt-new-campaign">+ New campaign</button></div>
      ${list.length ? `<section class="panel">${campaignTable(list)}</section>` : `
      <section class="panel empty mkt-empty">
        <div class="mkt-empty-icon" aria-hidden="true">✉</div>
        <h2>No campaigns yet</h2>
        <p class="muted">Newsletters, announcements, offers: write it once and send it to your whole audience.</p>
        <button class="btn primary" data-click="mkt-new-campaign">Write your first campaign</button>
      </section>`}`;
  }

  // The editor (drafts) or the report (everything else).
  function campaignView() {
    const c = m.campaign;
    return c.status === 'draft' ? editorView(c) : reportView(c);
  }

  const previewRecipient = () => ({ name: getMe()?.name || '', email: getMe()?.email || '' });

  function previewHtml(c) {
    const me = getMe();
    const settings = { ...m.overview.settings, fromName: m.overview.settings.fromName || 'Your name' };
    return renderCampaignEmail(c, settings, { recipient: { name: me?.name || '', email: me?.email || '' } }).html;
  }

  function editorView(c) {
    const o = m.overview;
    const tags = o.tags;
    const size = audienceSize(c.audience);
    const ready = settingsComplete();
    return `
      <div class="mkt-editor-head">
        <a class="btn ghost small" href="${base()}/campaigns">← Campaigns</a>
        <input class="mkt-name" data-input="mkt-field" name="name" value="${esc(c.name)}" maxlength="120" aria-label="Campaign name" />
        ${statusBadge(c.status)}
        <span class="muted small mkt-saved" aria-live="polite">Saved</span>
      </div>
      ${c.error ? `<div class="callout warning"><p>${esc(c.error)}</p></div>` : ''}
      <div class="mkt-editor">
        <section class="panel mkt-compose">
          <label>Subject line<input data-input="mkt-field" name="subject" value="${esc(c.subject)}" maxlength="200" placeholder="e.g. {{first_name|Hi}}, our spring collection is here" /></label>
          <label>Preview text <span class="muted small">shown after the subject in most inboxes</span><input data-input="mkt-field" name="preheader" value="${esc(c.preheader)}" maxlength="200" placeholder="A short teaser" /></label>
          <fieldset class="mkt-audience">
            <legend>Send to</legend>
            <label class="check"><input type="radio" name="mkt-aud" value="all" data-change="mkt-audience-mode"${c.audience.tags.length ? '' : ' checked'} /> All subscribers <span class="muted small">(${num(o.counts.subscribed)})</span></label>
            <label class="check"><input type="radio" name="mkt-aud" value="tags" data-change="mkt-audience-mode"${c.audience.tags.length ? ' checked' : ''}${tags.length ? '' : ' disabled'} /> People with any of these tags${tags.length ? '' : ' <span class="muted small">(tag subscribers first)</span>'}</label>
            ${c.audience.tags.length || tags.length ? `<div class="mkt-tag-picks"${c.audience.tags.length ? '' : ' hidden'}>${tags.map((t) => `<label class="chip-check"><input type="checkbox" data-change="mkt-audience-tag" value="${esc(t.tag)}"${c.audience.tags.includes(t.tag) ? ' checked' : ''} /> ${esc(t.tag)} <span class="muted">${num(t.count)}</span></label>`).join('')}</div>` : ''}
            <p class="muted small mkt-aud-size">${size == null ? 'Audience size is counted when you send.' : `${plural(size, 'person', 'people')} will get this email.`}</p>
          </fieldset>
          <div class="mkt-body-label">
            <span>Email</span>
            <div class="mkt-toolbar" role="toolbar" aria-label="Formatting">
              <button type="button" class="icon-btn" data-click="mkt-fmt" data-fmt="h1" title="Heading">H</button>
              <button type="button" class="icon-btn" data-click="mkt-fmt" data-fmt="bold" title="Bold"><b>B</b></button>
              <button type="button" class="icon-btn" data-click="mkt-fmt" data-fmt="italic" title="Italic"><i>I</i></button>
              <button type="button" class="icon-btn" data-click="mkt-fmt" data-fmt="link" title="Link">🔗</button>
              <button type="button" class="icon-btn" data-click="mkt-fmt" data-fmt="list" title="Bullet list">•≡</button>
              <button type="button" class="icon-btn" data-click="mkt-fmt" data-fmt="button" title="Button">▭</button>
              <button type="button" class="icon-btn" data-click="mkt-fmt" data-fmt="image" title="Image">🖼</button>
              <button type="button" class="icon-btn" data-click="mkt-fmt" data-fmt="divider" title="Divider">—</button>
              <button type="button" class="icon-btn" data-click="mkt-fmt" data-fmt="name" title="Insert first name">{ }</button>
            </div>
          </div>
          <textarea class="mkt-body" data-input="mkt-field" name="body" rows="18" spellcheck="true" aria-label="Email body" placeholder="Write your email…">${esc(c.body)}</textarea>
          <details class="mkt-help"><summary>Formatting help</summary>
            <p class="small muted"><code># Heading</code> · <code>**bold**</code> · <code>*italic*</code> · <code>[text](https://…)</code> · <code>- list item</code> · <code>&gt; quote</code> · <code>---</code> divider<br>
            <code>[button: Shop now](https://…)</code> and <code>![description](https://…/photo.jpg)</code> go on their own line.<br>
            <code>{{first_name|there}}</code> becomes each person’s first name, or “there” if we don’t know it. Also <code>{{name}}</code>, <code>{{last_name}}</code>, <code>{{email}}</code>.</p>
          </details>
        </section>
        <section class="panel mkt-preview-panel">
          <div class="panel-head spread">
            <h2 class="mkt-h2">Preview</h2>
            <div class="segmented small-seg">
              <button type="button" data-click="mkt-preview" data-size="desktop" aria-pressed="${m.preview === 'desktop'}">🖥 Desktop</button>
              <button type="button" data-click="mkt-preview" data-size="mobile" aria-pressed="${m.preview === 'mobile'}">📱 Phone</button>
            </div>
          </div>
          <div class="mkt-inbox-line"><b>${esc(o.settings.fromName || 'Your name')}</b><span class="mkt-preview-subject">${esc(merge(c.subject, previewRecipient()) || '(no subject)')}</span><span class="muted mkt-preview-pre">${esc(merge(c.preheader, previewRecipient()))}</span></div>
          <div class="mkt-frame-wrap ${m.preview}"><iframe class="mkt-frame" title="Email preview" sandbox="allow-popups allow-popups-to-escape-sandbox" srcdoc="${esc(previewHtml(c))}"></iframe></div>
        </section>
      </div>
      <div class="mkt-send-bar">
        <button class="btn ghost danger" data-click="mkt-delete-campaign">Delete</button>
        <span class="spacer"></span>
        <button class="btn" data-click="mkt-test">Send a test</button>
        ${o.canSend
          ? `<button class="btn" data-click="mkt-schedule"${ready ? '' : ' disabled title="Finish Marketing settings first"'}>🕑 Schedule</button>
             <button class="btn primary" data-click="mkt-send"${ready ? '' : ' disabled title="Finish Marketing settings first"'}>Send now</button>`
          : '<span class="muted small">A workspace owner or admin sends campaigns.</span>'}
      </div>
      ${ready ? '' : `<p class="muted small mkt-note">Before sending, add your sender name and postal address in <a href="${base()}/settings">Settings</a>.</p>`}`;
  }

  function reportView(c) {
    const s = c.stats;
    const progress = s.recipients ? Math.min(100, Math.round(((s.sent + s.failed) / s.recipients) * 100)) : 0;
    const filters = [['all', 'Everyone'], ['opened', 'Opened'], ['clicked', 'Clicked'], ['unsubscribed', 'Unsubscribed'], ['failed', 'Failed or bounced']];
    return `
      <div class="mkt-editor-head">
        <a class="btn ghost small" href="${base()}/campaigns">← Campaigns</a>
        <h1 class="mkt-title">${esc(c.name)}</h1>
        ${statusBadge(c.status)}
        <span class="spacer"></span>
        ${c.status === 'scheduled' && m.overview.canSend ? '<button class="btn small" data-click="mkt-cancel">Unschedule</button>' : ''}
        ${c.status === 'sending' && m.overview.canSend ? '<button class="btn small danger" data-click="mkt-cancel">Stop sending</button>' : ''}
        <button class="btn small" data-click="mkt-duplicate">⧉ Duplicate</button>
        ${c.status !== 'sending' && m.overview.canSend ? '<button class="btn small ghost danger" data-click="mkt-delete-campaign">Delete</button>' : ''}
      </div>
      <p class="muted mkt-report-meta">“${esc(c.subject)}” · ${audienceLabel(c.audience)}${c.status === 'scheduled' ? ` · sends ${esc(formatDateTime(c.scheduledAt))}` : c.startedAt ? ` · sent ${esc(formatDateTime(c.startedAt))}` : ''}${c.sentBy ? ` by ${esc(c.sentBy)}` : ''}</p>
      ${c.error ? `<div class="callout warning"><p>${esc(c.error)}</p></div>` : ''}
      ${c.status === 'sending' ? `<div class="panel mkt-progress"><div class="row spread"><b>Sending… ${num(s.sent + s.failed)} of ${num(s.recipients)}</b><span class="muted small">You can leave this page; sending continues.</span></div><div class="mkt-bar"><span style="width:${progress}%"></span></div></div>` : ''}
      ${c.status === 'scheduled' ? '' : `
      <div class="stat-row">
        ${tile('Delivered', num(s.sent), s.failed ? `${num(s.failed)} failed` : `of ${num(s.recipients)}`)}
        ${tile('Opened', pct(s.uniqueOpens, s.sent), `${plural(s.uniqueOpens, 'person', 'people')} · ${plural(s.opens, 'open')}`)}
        ${tile('Clicked', pct(s.uniqueClicks, s.sent), `${plural(s.uniqueClicks, 'person', 'people')} · ${plural(s.clicks, 'click')}`)}
        ${tile('Unsubscribed', num(s.unsubscribes), pct(s.unsubscribes, s.sent))}
        ${tile('Bounced / spam', `${num(s.bounces)} / ${num(s.complaints)}`, 'removed from future sends')}
      </div>`}
      <div class="mkt-report">
        <div>
          ${s.linkClicks.length && c.status !== 'scheduled' ? `
          <section class="panel">
            <h2 class="mkt-h2">Links clicked</h2>
            <table class="data-table"><thead><tr><th>Link</th><th class="num">Clicks</th></tr></thead><tbody>
              ${s.linkClicks.map((l) => `<tr><td class="mkt-url"><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.url.replace(/^https?:\/\//, ''))}</a></td><td class="num">${num(l.clicks)}</td></tr>`).join('')}
            </tbody></table>
          </section>` : ''}
          ${c.status === 'scheduled' ? '' : `
          <section class="panel">
            <div class="panel-head spread"><h2 class="mkt-h2">Recipients</h2>
              <select data-change="mkt-recipient-filter" aria-label="Show">${filters.map(([v, l]) => `<option value="${v}"${m.recipientFilter === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
            </div>
            ${m.recipients ? recipientsTable() : '<button class="btn small" data-click="mkt-load-recipients">Show recipients</button>'}
          </section>`}
        </div>
        <section class="panel mkt-preview-panel">
          <h2 class="mkt-h2">Email</h2>
          <div class="mkt-frame-wrap desktop"><iframe class="mkt-frame" title="Email preview" sandbox="allow-popups allow-popups-to-escape-sandbox" srcdoc="${esc(previewHtml(c))}"></iframe></div>
        </section>
      </div>`;
  }

  function recipientsTable() {
    const { recipients, total } = m.recipients;
    if (!recipients.length) return '<p class="muted">Nobody here.</p>';
    const state = (r) => (r.status === 'failed' ? `Failed${r.error ? `: ${esc(r.error)}` : ''}` : r.bouncedAt ? 'Bounced' : r.complainedAt ? 'Marked as spam' : r.status === 'skipped' ? `Skipped (${esc(r.error || '')})` : r.status === 'queued' ? 'Waiting' : 'Delivered');
    return `
      <div class="table-scroll"><table class="data-table">
        <thead><tr><th>Email</th><th>Delivery</th><th>Opened</th><th>Clicked</th></tr></thead>
        <tbody>${recipients.map((r) => `<tr>
          <td>${esc(r.email)}${r.name ? `<br><small class="muted">${esc(r.name)}</small>` : ''}${r.unsubscribedAt ? ' <span class="mkt-status mkt-sub-unsubscribed">Unsubscribed</span>' : ''}</td>
          <td class="small">${state(r)}</td>
          <td class="small">${r.openedAt ? `${esc(formatDateTime(r.openedAt))}${r.opens > 1 ? ` <span class="muted">×${r.opens}</span>` : ''}` : '<span class="muted">—</span>'}</td>
          <td class="small">${r.clickedAt ? `${esc(formatDateTime(r.clickedAt))}${r.clicks > 1 ? ` <span class="muted">×${r.clicks}</span>` : ''}` : '<span class="muted">—</span>'}</td>
        </tr>`).join('')}</tbody>
      </table></div>
      ${total > recipients.length ? `<p class="muted small">Showing ${num(recipients.length)} of ${num(total)}.</p>` : ''}`;
  }

  // ---------------------------------------------------------------- audience

  function shownSubscribers() {
    const q = m.query.trim().toLowerCase();
    return m.subscribers.filter((s) => {
      if (m.filter.startsWith('tag:')) {
        if (s.status !== 'subscribed' || !s.tags?.includes(m.filter.slice(4))) return false;
      } else if (m.filter !== 'all' && s.status !== m.filter) return false;
      return !q || s.email.includes(q) || (s.name || '').toLowerCase().includes(q) || s.tags?.some((t) => t.toLowerCase().includes(q));
    });
  }

  function audienceRows() {
    const list = shownSubscribers();
    if (!m.subscribers.length) return '<tr><td colspan="6" class="muted mkt-empty-row">No subscribers yet. Import a list, bring in your contacts, or add a signup form to your website.</td></tr>';
    if (!list.length) return '<tr><td colspan="6" class="muted mkt-empty-row">Nobody matches.</td></tr>';
    return list.slice(0, SHOWN_MAX).map((s) => `<tr>
      <td><input type="checkbox" data-change="mkt-select" value="${esc(s.email)}"${m.selected.has(s.email) ? ' checked' : ''} aria-label="Select ${esc(s.email)}" /></td>
      <td><button class="link-btn mkt-sub-email" data-click="mkt-edit-sub" data-email="${esc(s.email)}">${esc(s.email)}</button>${s.name ? `<br><small class="muted">${esc(s.name)}</small>` : ''}</td>
      <td>${(s.tags || []).map((t) => `<span class="chip mkt-chip">${esc(t)}</span>`).join(' ')}</td>
      <td>${subBadge(s.status)}</td>
      <td class="muted small">${esc(SOURCE_LABELS[s.source] || s.source || '')}</td>
      <td class="muted small">${esc(formatDateTime(s.createdAt))}</td>
    </tr>`).join('') + (list.length > SHOWN_MAX ? `<tr><td colspan="6" class="muted small">Showing ${SHOWN_MAX} of ${num(list.length)}. Search to find the rest.</td></tr>` : '');
  }

  function bulkHtml() {
    const n = m.selected.size;
    return n
      ? `<b>${num(n)} selected</b>
         <button class="btn small" data-click="mkt-bulk-tag">🏷 Tag</button>
         <button class="btn small" data-click="mkt-bulk-untag">Remove tag</button>
         <button class="btn small" data-click="mkt-bulk-unsubscribe">Unsubscribe</button>
         <button class="btn small danger" data-click="mkt-bulk-delete">Delete</button>
         <button class="btn small ghost" data-click="mkt-clear-selection">Clear</button>`
      : `<label class="check"><input type="checkbox" data-change="mkt-select-all" /> Select all shown</label><span class="muted small">${plural(shownSubscribers().length, 'person', 'people')}</span>`;
  }

  function audienceView() {
    const o = m.overview;
    const option = (value, label) => `<option value="${esc(value)}"${m.filter === value ? ' selected' : ''}>${esc(label)}</option>`;
    return `
      <div class="stat-row">
        ${tile('Subscribed', num(o.counts.subscribed))}
        ${tile('Unsubscribed', num(o.counts.unsubscribed))}
        ${tile('Bounced', num(o.counts.bounced))}
        ${tile('Marked as spam', num(o.counts.complained))}
      </div>
      <section class="panel">
        <div class="mkt-audience-tools">
          <input type="search" class="mkt-search" data-input="mkt-search" value="${esc(m.query)}" placeholder="Search email, name or tag…" aria-label="Search subscribers" />
          <select data-change="mkt-filter" aria-label="Filter">
            ${option('subscribed', 'Subscribed')}${option('all', 'Everyone')}${option('unsubscribed', 'Unsubscribed')}${option('bounced', 'Bounced')}${option('complained', 'Marked as spam')}
            ${o.tags.length ? `<optgroup label="Tag">${o.tags.map((t) => option(`tag:${t.tag}`, `${t.tag} (${t.count})`)).join('')}</optgroup>` : ''}
          </select>
          <span class="spacer"></span>
          <button class="btn primary" data-click="mkt-add-sub">+ Add</button>
          <button class="btn" data-click="mkt-import">⬆ Import</button>
          <button class="btn" data-click="mkt-export"${m.subscribers.length ? '' : ' disabled'}>⬇ Export CSV</button>
        </div>
        <div class="mkt-bulk">${bulkHtml()}</div>
        <div class="table-scroll"><table class="data-table mkt-table mkt-sub-table">
          <thead><tr><th></th><th>Subscriber</th><th>Tags</th><th>Status</th><th>Source</th><th>Added</th></tr></thead>
          <tbody class="mkt-sub-rows">${audienceRows()}</tbody>
        </table></div>
      </section>`;
  }

  function patchAudience() {
    const rows = document.querySelector('.mkt-sub-rows');
    if (rows) rows.innerHTML = audienceRows();
    const bulk = document.querySelector('.mkt-bulk');
    if (bulk) bulk.innerHTML = bulkHtml();
  }

  // ---------------------------------------------------------------- forms

  const embedCode = (f) => `<form action="${f.url}" method="post" style="display:flex;flex-wrap:wrap;gap:8px;max-width:440px;font-family:inherit">
${f.askName ? '  <input name="name" placeholder="Your name" autocomplete="name" style="flex:1 1 160px;padding:10px 12px;border:1px solid #cfd1e0;border-radius:8px">\n' : ''}  <input name="email" type="email" required placeholder="you@example.com" autocomplete="email" style="flex:1 1 200px;padding:10px 12px;border:1px solid #cfd1e0;border-radius:8px">
  <input name="website" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-5000px">
  <button type="submit" style="padding:10px 18px;border:0;border-radius:8px;background:${esc(m.overview.settings.color || DEFAULT_COLOR)};color:#fff;font-weight:600;cursor:pointer">${esc(f.buttonLabel)}</button>
</form>`;

  function formsView() {
    const forms = m.overview.forms;
    return `
      <div class="panel-head spread mkt-section-head"><p class="muted">Collect subscribers anywhere: share the hosted page, or paste the form into your own website.</p><button class="btn primary" data-click="mkt-new-form">+ New signup form</button></div>
      ${forms.length ? forms.map((f) => `
        <section class="panel mkt-form-card">
          <div class="panel-head spread">
            <div><h2 class="mkt-h2">${esc(f.name)}</h2><p class="muted small">${plural(f.submissions || 0, 'signup')}${f.tags.length ? ` · tags new people ${f.tags.map((t) => `“${esc(t)}”`).join(', ')}` : ''}</p></div>
            <div class="row"><button class="btn small" data-click="mkt-edit-form" data-id="${esc(f.id)}">✎ Edit</button><button class="btn small ghost danger" data-click="mkt-delete-form" data-id="${esc(f.id)}">Delete</button></div>
          </div>
          <label class="mkt-copy">Hosted signup page
            <span class="row"><input readonly value="${esc(f.url)}" /><button class="btn small" data-click="mkt-copy" data-text="${esc(f.url)}">Copy</button><a class="btn small" href="${esc(f.url)}" target="_blank" rel="noopener">Open ↗</a></span>
          </label>
          <label class="mkt-copy">Embed on your website <span class="muted small">paste this HTML where the form should appear</span>
            <textarea readonly rows="5">${esc(embedCode(f))}</textarea>
            <span class="row"><button class="btn small" data-click="mkt-copy" data-form="${esc(f.id)}">Copy HTML</button></span>
          </label>
        </section>`).join('') : `
      <section class="panel empty mkt-empty">
        <div class="mkt-empty-icon" aria-hidden="true">📝</div>
        <h2>No signup forms yet</h2>
        <p class="muted">A form gives you a shareable signup page and HTML for your website. New subscribers are tagged however you like.</p>
        <button class="btn primary" data-click="mkt-new-form">Create a signup form</button>
      </section>`}`;
  }

  // ---------------------------------------------------------------- settings

  function settingsView() {
    const o = m.overview;
    const s = o.settings;
    return `
      <section class="panel mkt-settings">
        <form data-form="mkt-settings" class="stack">
          <h2 class="mkt-h2">Sender</h2>
          <div class="form-grid">
            <label>Sender name<input name="fromName" value="${esc(s.fromName || o.settings.fromName || '')}" maxlength="80" required placeholder="e.g. Acme Coffee" /></label>
            <label>Replies go to<input name="replyTo" type="email" value="${esc(s.replyTo || '')}" maxlength="254" placeholder="${esc(getMe()?.email || 'you@example.com')}" /></label>
          </div>
          ${o.staff
            ? `<label>Send from <span class="muted small">staff only: any address on ${esc(o.domains.join(', '))}</span><input name="fromEmail" type="email" value="${esc(s.fromEmail || '')}" placeholder="${esc(o.defaultFrom)}" /></label>`
            : `<p class="muted small">Campaigns are sent from <b>${esc(s.fromEmail || o.defaultFrom)}</b> with your sender name; replies go to the address above.</p>`}
          <label>Postal address <span class="muted small">shown in every email’s footer, as anti-spam laws (CAN-SPAM, GDPR) require</span><textarea name="address" rows="2" maxlength="300" required placeholder="Street, city, country">${esc(s.address || '')}</textarea></label>
          <h2 class="mkt-h2">Look</h2>
          <div class="form-grid">
            <label>Brand colour<span class="row"><input type="color" name="color" value="${esc(s.color || DEFAULT_COLOR)}" class="mkt-color" /><span class="muted small">buttons, links and the top stripe</span></span></label>
            <label>Logo <span class="muted small">optional https:// image link</span><input name="logoUrl" type="url" value="${esc(s.logoUrl || '')}" placeholder="https://example.com/logo.png" /></label>
          </div>
          <div class="row end">${o.canSend ? '<button class="btn primary">Save settings</button>' : '<span class="muted small">Only workspace owners and admins change these.</span>'}</div>
        </form>
      </section>
      <section class="panel">
        <h2 class="mkt-h2">Sending limits</h2>
        <p class="muted">This workspace can send <b>${num(o.limits.daily)}</b> campaign emails a day (${num(o.limits.sentToday)} sent today) and keep up to ${num(o.limits.subscribersMax)} subscribers. Bounced addresses and people who mark an email as spam are removed from future sends automatically. Every email carries a one-click unsubscribe link.</p>
      </section>`;
  }

  // ---------------------------------------------------------------- page

  function view() {
    const ws = getWs();
    const tab = route.tab || 'overview';
    const inCampaign = tab === 'campaigns' && m.campaign;
    const body = inCampaign ? campaignView() : { overview: overviewView, campaigns: campaignsView, audience: audienceView, forms: formsView, settings: settingsView }[tab]?.() || overviewView();
    return `
      ${inCampaign ? '' : `
      <div class="page-head">
        <div><h1>Marketing</h1><p>Email campaigns, subscribers and signup forms for ${esc(ws?.workspace?.name || 'this workspace')}.</p></div>
      </div>
      ${tabs()}`}
      <div class="mkt-page">${body}</div>`;
  }

  // ---------------------------------------------------------------- dialogs

  function openDialog(html, { wide = false, setup } = {}) {
    return new Promise((resolve) => {
      const node = document.createElement('dialog');
      node.className = `dialog${wide ? ' wide' : ''} mkt-dialog`;
      node.innerHTML = html;
      document.body.append(node);
      let result = null;
      const done = (value) => {
        result = value;
        node.close();
      };
      node.addEventListener('close', () => {
        node.remove();
        resolve(result);
      });
      node.addEventListener('click', (event) => {
        if (event.target.closest('[data-dialog-close]')) done(null);
      });
      const form = node.querySelector('form');
      form?.addEventListener('submit', (event) => {
        event.preventDefault();
        if (setup?.submit) setup.submit(new FormData(form), done, node);
        else done(Object.fromEntries(new FormData(form)));
      });
      setup?.open?.(node, done);
      node.showModal();
    });
  }

  const tagsField = (value = [], label = 'Tags') => `
    <label>${label} <span class="muted small">comma separated</span><input name="tags" value="${esc(value.join(', '))}" list="mkt-tags" autocomplete="off" placeholder="e.g. customers, newsletter" /></label>
    <datalist id="mkt-tags">${m.overview.tags.map((t) => `<option value="${esc(t.tag)}">`).join('')}</datalist>`;
  const splitTags = (value) => String(value || '').split(',').map((t) => t.trim()).filter(Boolean);

  async function subscriberDialog(existing) {
    return openDialog(`
      <form><h2>${existing ? 'Edit subscriber' : 'Add a subscriber'}</h2>
        <label>Email<input name="email" type="email" required maxlength="254" value="${esc(existing?.email || '')}"${existing ? ' readonly' : ''} /></label>
        <label>Name<input name="name" maxlength="120" value="${esc(existing?.name || '')}" /></label>
        ${tagsField(existing?.tags || [])}
        ${existing ? `<p class="muted small">${subBadge(existing.status)} · from ${esc(SOURCE_LABELS[existing.source] || existing.source || '—')} · added ${esc(formatDateTime(existing.createdAt))}</p>` : '<p class="muted small">Only add people who agreed to hear from you.</p>'}
        <div class="row end">
          ${existing?.status === 'subscribed' ? '<button type="button" class="btn ghost" data-unsubscribe>Unsubscribe</button><span class="spacer"></span>' : ''}
          <button type="button" class="btn" data-dialog-close>Cancel</button><button class="btn primary">${existing ? 'Save' : 'Add'}</button>
        </div>
      </form>`, {
      setup: {
        open(node, done) {
          node.querySelector('[data-unsubscribe]')?.addEventListener('click', () => done({ unsubscribe: true }));
        },
      },
    });
  }

  async function campaignAudienceSize(c) {
    if (!m.subscribers) await loadSubscribers();
    return audienceSize(c.audience);
  }

  // Import: paste, a file (CSV, vCard, JSON), my Contacts or the workspace team.
  async function importDialog() {
    const result = await openDialog(`
      <form><h2>Import subscribers</h2>
        <div class="segmented mkt-import-tabs" role="tablist">
          <a href="#" data-src="paste" aria-current="page">Paste</a><a href="#" data-src="file">File</a><a href="#" data-src="contacts">My contacts</a><a href="#" data-src="team">Team</a>
        </div>
        <div data-pane="paste"><label>One per line: <code>email</code> or <code>email, name</code><textarea name="paste" rows="8" placeholder="ada@example.com, Ada Lovelace&#10;grace@example.com"></textarea></label></div>
        <div data-pane="file" hidden><label>CSV, vCard (.vcf) or JSON file — from Mailchimp, Google, Outlook, a spreadsheet…<input type="file" name="file" accept=".csv,.vcf,.vcard,.json,.txt,text/csv,text/vcard" /></label><p class="muted small" data-file-info></p></div>
        <div data-pane="contacts" hidden><p class="muted small">Everyone in your <a href="#/contacts">Contacts</a> who has an email address.</p><label>Only people with this label <span class="muted small">optional</span><input name="contactTag" placeholder="e.g. Clients" /></label></div>
        <div data-pane="team" hidden><p class="muted small">Everyone in this workspace’s team.</p></div>
        ${tagsField([], 'Tag everyone imported')}
        <label class="check"><input type="checkbox" name="consent" required /> These people agreed to get emails from us</label>
        <p class="muted small">People who unsubscribed stay unsubscribed. Matching emails are merged, not duplicated.</p>
        <p class="import-progress muted small" aria-live="polite"></p>
        <div class="row end"><button type="button" class="btn" data-dialog-close>Cancel</button><button class="btn primary">Import</button></div>
      </form>`, {
      wide: true,
      setup: {
        open(node) {
          node.dataset.src = 'paste';
          node.querySelectorAll('[data-src]').forEach((a) => a.addEventListener('click', (event) => {
            event.preventDefault();
            node.dataset.src = a.dataset.src;
            node.querySelectorAll('[data-src]').forEach((b) => (b === a ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
            node.querySelectorAll('[data-pane]').forEach((p) => (p.hidden = p.dataset.pane !== a.dataset.src));
          }));
        },
        async submit(data, done, node) {
          const progress = node.querySelector('.import-progress');
          const button = node.querySelector('button.primary');
          try {
            button.disabled = true;
            progress.textContent = 'Reading…';
            const people = await collect(node.dataset.src, data);
            if (!people.length) {
              progress.textContent = 'No email addresses found.';
              button.disabled = false;
              return;
            }
            const totals = { created: 0, updated: 0, unchanged: 0, skipped: 0 };
            for (let i = 0; i < people.length; i += IMPORT_CHUNK) {
              progress.textContent = `Importing ${num(Math.min(i + IMPORT_CHUNK, people.length))} of ${num(people.length)}…`;
              const r = await api('POST', path('/subscribers/import'), { subscribers: people.slice(i, i + IMPORT_CHUNK), tags: splitTags(data.get('tags')), source: node.dataset.src === 'file' ? 'csv' : node.dataset.src });
              for (const k of Object.keys(totals)) totals[k] += r[k] || 0;
              if (r.full) break;
            }
            done(totals);
          } catch (error) {
            progress.textContent = error.message;
            button.disabled = false;
          }
        },
      },
    });
    if (!result) return;
    toast(`Imported: ${num(result.created)} new, ${num(result.updated)} updated${result.skipped ? `, ${num(result.skipped)} skipped` : ''}`);
    await Promise.all([loadOverview(), loadSubscribers()]);
    render();
  }

  async function collect(source, data) {
    if (source === 'paste') {
      return String(data.get('paste') || '').split(/\r?\n/).map((line) => {
        const email = (line.match(/[^\s,;<>"]+@[^\s,;<>"]+\.[^\s,;<>"]+/) || [''])[0];
        const name = line.replace(email, '').replace(/[<>"]/g, '').replace(/^[\s,;]+|[\s,;]+$/g, '').trim();
        return email ? { email, name } : null;
      }).filter(Boolean);
    }
    if (source === 'file') {
      const file = data.get('file');
      if (!file?.size) throw new Error('Choose a file.');
      const text = await file.text();
      // Mailchimp-style CSVs and plain lists both go through the Contacts parser.
      const { contacts } = parseContactsFile(file.name, text);
      const fromContacts = contacts.flatMap((c) => (c.emails || []).slice(0, 1).map((e) => ({ email: e.value, name: c.name || [c.given, c.family].filter(Boolean).join(' '), tags: c.tags || [] })));
      if (fromContacts.length) return fromContacts;
      return collect('paste', new Map([['paste', text]]));
    }
    if (source === 'contacts') {
      const { contacts } = await api('GET', '/contacts');
      const tag = String(data.get('contactTag') || '').trim().toLowerCase();
      return contacts.filter((c) => !tag || c.tags.some((t) => t.toLowerCase() === tag)).flatMap((c) => (c.emails[0] ? [{ email: c.emails[0].value, name: c.name }] : []));
    }
    if (source === 'team') return (getWs()?.members || []).map((p) => ({ email: p.email, name: p.name }));
    return [];
  }

  function exportCsv() {
    const cell = (v) => {
      const s = String(v ?? '');
      const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
      return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    const list = m.selected.size ? m.subscribers.filter((s) => m.selected.has(s.email)) : shownSubscribers();
    const rows = [['email', 'name', 'tags', 'status', 'source', 'created_at'], ...list.map((s) => [s.email, s.name, (s.tags || []).join(', '), s.status, s.source, s.createdAt])];
    const blob = new Blob([`﻿${rows.map((r) => r.map(cell).join(',')).join('\n')}`], { type: 'text/csv' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `subscribers-${new Date().toISOString().slice(0, 10)}.csv` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(`Exported ${plural(list.length, 'person', 'people')}`);
  }

  async function formDialog(existing) {
    const f = existing || { name: '', title: 'Join our newsletter', description: '', buttonLabel: 'Subscribe', successMessage: 'Thanks! You’re subscribed.', askName: true, tags: [], redirectUrl: '', consent: '' };
    return openDialog(`
      <form><h2>${existing ? 'Edit signup form' : 'New signup form'}</h2>
        <label>Name <span class="muted small">just for you</span><input name="name" maxlength="80" required value="${esc(f.name)}" placeholder="e.g. Website footer" /></label>
        <label>Heading<input name="title" maxlength="120" value="${esc(f.title)}" /></label>
        <label>Description <span class="muted small">optional</span><textarea name="description" rows="2" maxlength="600">${esc(f.description)}</textarea></label>
        <div class="form-grid">
          <label>Button<input name="buttonLabel" maxlength="40" value="${esc(f.buttonLabel)}" /></label>
          ${tagsField(f.tags, 'Tag new subscribers')}
        </div>
        <label class="check"><input type="checkbox" name="askName"${f.askName ? ' checked' : ''} /> Ask for their name</label>
        <label>Thank-you message<input name="successMessage" maxlength="300" value="${esc(f.successMessage)}" /></label>
        <label>Or send them to a page <span class="muted small">optional https:// link</span><input name="redirectUrl" type="url" value="${esc(f.redirectUrl)}" placeholder="https://example.com/thanks" /></label>
        <label>Small print <span class="muted small">optional, under the button</span><input name="consent" maxlength="300" value="${esc(f.consent)}" placeholder="We’ll email you about once a month. Unsubscribe any time." /></label>
        <div class="row end"><button type="button" class="btn" data-dialog-close>Cancel</button><button class="btn primary">${existing ? 'Save' : 'Create form'}</button></div>
      </form>`, { wide: true });
  }

  // ---------------------------------------------------------------- editing a draft

  function scheduleSave() {
    const saved = document.querySelector('.mkt-saved');
    if (saved) saved.textContent = 'Saving…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 700);
  }

  async function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    const c = m.campaign;
    if (!c || c.status !== 'draft') return;
    try {
      const { campaign } = await api('PATCH', path(`/campaigns/${encodeURIComponent(c.id)}`), { name: c.name, subject: c.subject, preheader: c.preheader, body: c.body, audience: c.audience });
      if (m.campaign?.id === campaign.id) m.campaign.updatedAt = campaign.updatedAt;
      const saved = document.querySelector('.mkt-saved');
      if (saved) saved.textContent = 'Saved';
    } catch (error) {
      toast(error.message);
    }
  }

  // Refreshes the preview and audience count without redrawing the form (keeps the cursor).
  let previewTimer = null;
  function refreshPreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      const c = m.campaign;
      const frame = document.querySelector('.mkt-frame');
      if (frame && c) frame.srcdoc = previewHtml(c);
      const subj = document.querySelector('.mkt-preview-subject');
      if (subj) subj.textContent = merge(c.subject, previewRecipient()) || '(no subject)';
      const pre = document.querySelector('.mkt-preview-pre');
      if (pre) pre.textContent = merge(c.preheader, previewRecipient());
      const size = document.querySelector('.mkt-aud-size');
      const n = audienceSize(c.audience);
      if (size) size.textContent = n == null ? 'Audience size is counted when you send.' : `${plural(n, 'person', 'people')} will get this email.`;
    }, 150);
  }

  function insert(fmt) {
    const area = document.querySelector('.mkt-body');
    if (!area) return;
    const { selectionStart: a, selectionEnd: b, value } = area;
    const sel = value.slice(a, b);
    const block = (text) => `${a && value[a - 1] !== '\n' ? '\n\n' : ''}${text}\n\n`;
    const snippets = {
      h1: () => block(`# ${sel || 'Heading'}`),
      bold: () => `**${sel || 'bold text'}**`,
      italic: () => `*${sel || 'italic text'}*`,
      link: () => {
        const url = prompt('Link address', 'https://');
        return url && url !== 'https://' ? `[${sel || 'link text'}](${url.trim()})` : null;
      },
      list: () => block((sel || 'First item\nSecond item').split('\n').map((l) => `- ${l.replace(/^[-*]\s+/, '')}`).join('\n')),
      button: () => {
        const url = prompt('Where should the button go?', 'https://');
        return url && url !== 'https://' ? block(`[button: ${sel || 'Learn more'}](${url.trim()})`) : null;
      },
      image: () => {
        const url = prompt('Image address (https://…, a JPG, PNG or GIF on the web)', 'https://');
        return url && url !== 'https://' ? block(`![${sel || 'Image'}](${url.trim()})`) : null;
      },
      divider: () => block('---'),
      name: () => '{{first_name|there}}',
    };
    const text = snippets[fmt]?.();
    if (text == null) return;
    area.setRangeText(text, a, b, 'end');
    area.focus();
    m.campaign.body = area.value;
    scheduleSave();
    refreshPreview();
  }

  // ---------------------------------------------------------------- actions

  const guard = (fn) => async (target) => {
    try {
      await fn(target);
    } catch (error) {
      toast(error.message);
    }
  };

  const clickActions = {
    'mkt-new-campaign': guard(async () => {
      const { campaign } = await api('POST', path('/campaigns'), { name: `Campaign ${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`, subject: '', preheader: '', body: SAMPLE_BODY, audience: { tags: [] } });
      m.campaign = campaign;
      go(`${base()}/campaigns/${encodeURIComponent(campaign.id)}`);
    }),
    'mkt-fmt': (target) => insert(target.dataset.fmt),
    'mkt-preview': (target) => {
      m.preview = target.dataset.size;
      document.querySelectorAll('[data-click="mkt-preview"]').forEach((b) => b.setAttribute('aria-pressed', String(b === target)));
      const wrap = document.querySelector('.mkt-frame-wrap');
      if (wrap) wrap.className = `mkt-frame-wrap ${m.preview}`;
    },
    'mkt-test': guard(async () => {
      await saveNow();
      const values = await openDialog(`
        <form><h2>Send a test</h2>
          <label>Send to <span class="muted small">up to 5 addresses, comma separated</span><input name="emails" required value="${esc(getMe()?.email || '')}" /></label>
          <p class="muted small">Tests show “[Test]” in the subject. Links work but aren’t counted.</p>
          <div class="row end"><button type="button" class="btn" data-dialog-close>Cancel</button><button class="btn primary">Send test</button></div>
        </form>`);
      if (!values) return;
      const { sent } = await api('POST', path(`/campaigns/${encodeURIComponent(m.campaign.id)}/test`), { emails: values.emails.split(/[,\s;]+/).filter(Boolean) });
      toast(`Test sent to ${plural(sent, 'address', 'addresses')}`);
    }),
    'mkt-send': guard(async () => {
      await saveNow();
      const c = m.campaign;
      const n = await campaignAudienceSize(c);
      const links = extractLinks(c.body).length;
      if (!c.subject) return toast('Add a subject line first.');
      if (!confirm(`Send “${c.subject}” to ${plural(n, 'person', 'people')} now?${links ? '' : '\n\n(This email has no links.)'}\n\nThis can’t be undone.`)) return;
      const { campaign } = await api('POST', path(`/campaigns/${encodeURIComponent(c.id)}/send`), {});
      m.campaign = { ...m.campaign, ...campaign };
      toast('Sending…');
      await loadOverview();
      startPolling();
      render();
    }),
    'mkt-schedule': guard(async () => {
      await saveNow();
      const soon = new Date(Date.now() + 3600e3);
      soon.setMinutes(0, 0, 0);
      const local = new Date(soon.getTime() - soon.getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
      const values = await openDialog(`
        <form><h2>Schedule</h2>
          <label>Send on<input type="datetime-local" name="at" required value="${local}" min="${new Date(Date.now() - new Date().getTimezoneOffset() * 60e3).toISOString().slice(0, 16)}" /></label>
          <p class="muted small">Your time zone: ${esc(Intl.DateTimeFormat().resolvedOptions().timeZone)}. It goes to whoever is subscribed at that moment.</p>
          <div class="row end"><button type="button" class="btn" data-dialog-close>Cancel</button><button class="btn primary">Schedule</button></div>
        </form>`);
      if (!values?.at) return;
      const { campaign } = await api('POST', path(`/campaigns/${encodeURIComponent(m.campaign.id)}/send`), { at: new Date(values.at).toISOString() });
      m.campaign = { ...m.campaign, ...campaign };
      await loadOverview();
      toast(`Scheduled for ${formatDateTime(campaign.scheduledAt)}`);
      render();
    }),
    'mkt-cancel': guard(async () => {
      const c = m.campaign;
      if (c.status === 'sending' && !confirm('Stop sending? People who already got it keep it; nobody else will.')) return;
      const { campaign } = await api('POST', path(`/campaigns/${encodeURIComponent(c.id)}/cancel`));
      m.campaign = (await api('GET', path(`/campaigns/${encodeURIComponent(campaign.id)}`))).campaign;
      await loadOverview();
      toast(campaign.status === 'draft' ? 'Unscheduled: it’s a draft again' : 'Sending stopped');
      render();
    }),
    'mkt-duplicate': guard(async () => {
      const { campaign } = await api('POST', path(`/campaigns/${encodeURIComponent(m.campaign.id)}/duplicate`));
      m.campaign = campaign;
      toast('Copied as a new draft');
      go(`${base()}/campaigns/${encodeURIComponent(campaign.id)}`);
    }),
    'mkt-delete-campaign': guard(async () => {
      if (!confirm(`Delete “${m.campaign.name}”${m.campaign.status === 'draft' ? '' : ' and its report'}?`)) return;
      clearTimeout(saveTimer);
      await api('DELETE', path(`/campaigns/${encodeURIComponent(m.campaign.id)}`));
      m.campaign = null;
      toast('Campaign deleted');
      go(`${base()}/campaigns`);
    }),
    'mkt-load-recipients': guard(async () => {
      m.recipients = await api('GET', path(`/campaigns/${encodeURIComponent(m.campaign.id)}/recipients?filter=${m.recipientFilter}`));
      render();
    }),
    'mkt-filter-tag': (target) => {
      m.filter = `tag:${target.dataset.tag}`;
    },
    'mkt-add-sub': guard(async () => {
      const values = await subscriberDialog(null);
      if (!values) return;
      await api('POST', path('/subscribers'), { email: values.email, name: values.name, tags: splitTags(values.tags) });
      toast('Subscriber added');
      await Promise.all([loadOverview(), loadSubscribers()]);
      render();
    }),
    'mkt-edit-sub': guard(async (target) => {
      const s = m.subscribers.find((x) => x.email === target.dataset.email);
      const values = await subscriberDialog(s);
      if (!values) return;
      const body = values.unsubscribe ? { unsubscribe: true } : { name: values.name, tags: splitTags(values.tags) };
      if (values.unsubscribe && !confirm(`Unsubscribe ${s.email}? Only they can subscribe again, through a signup form.`)) return;
      await api('PATCH', path(`/subscribers/${encodeURIComponent(s.email)}`), body);
      await Promise.all([loadOverview(), loadSubscribers()]);
      render();
    }),
    'mkt-import': () => importDialog(),
    'mkt-export': () => exportCsv(),
    'mkt-clear-selection': () => {
      m.selected.clear();
      patchAudience();
    },
    'mkt-bulk-tag': guard(async () => bulkTag('add')),
    'mkt-bulk-untag': guard(async () => bulkTag('remove')),
    'mkt-bulk-unsubscribe': guard(async () => {
      const emails = [...m.selected].filter((e) => m.subscribers.find((s) => s.email === e)?.status === 'subscribed');
      if (!emails.length || !confirm(`Unsubscribe ${plural(emails.length, 'person', 'people')}?`)) return;
      for (let i = 0; i < emails.length; i += 10) await Promise.all(emails.slice(i, i + 10).map((e) => api('PATCH', path(`/subscribers/${encodeURIComponent(e)}`), { unsubscribe: true })));
      m.selected.clear();
      await Promise.all([loadOverview(), loadSubscribers()]);
      toast(`Unsubscribed ${plural(emails.length, 'person', 'people')}`);
      render();
    }),
    'mkt-bulk-delete': guard(async () => {
      const emails = [...m.selected];
      if (!confirm(`Delete ${plural(emails.length, 'subscriber')}? Deleted people can be imported again; to stop emailing someone for good, unsubscribe them instead.`)) return;
      for (let i = 0; i < emails.length; i += 1000) await api('POST', path('/subscribers/delete'), { emails: emails.slice(i, i + 1000) });
      m.selected.clear();
      await Promise.all([loadOverview(), loadSubscribers()]);
      toast('Deleted');
      render();
    }),
    'mkt-new-form': guard(async () => {
      const values = await formDialog(null);
      if (!values) return;
      await api('POST', path('/forms'), { ...values, askName: values.askName === 'on', tags: splitTags(values.tags) });
      await loadOverview();
      toast('Signup form created');
      render();
    }),
    'mkt-edit-form': guard(async (target) => {
      const f = m.overview.forms.find((x) => x.id === target.dataset.id);
      const values = await formDialog(f);
      if (!values) return;
      await api('PATCH', path(`/forms/${encodeURIComponent(f.id)}`), { ...values, askName: values.askName === 'on', tags: splitTags(values.tags) });
      await loadOverview();
      toast('Saved');
      render();
    }),
    'mkt-delete-form': guard(async (target) => {
      const f = m.overview.forms.find((x) => x.id === target.dataset.id);
      if (!confirm(`Delete “${f.name}”? Its page and embedded forms stop working. Subscribers stay.`)) return;
      await api('DELETE', path(`/forms/${encodeURIComponent(f.id)}`));
      await loadOverview();
      render();
    }),
    'mkt-copy': async (target) => {
      const f = target.dataset.form && m.overview.forms.find((x) => x.id === target.dataset.form);
      const text = f ? embedCode(f) : target.dataset.text;
      try {
        await navigator.clipboard.writeText(text);
        toast('Copied');
      } catch {
        toast('Couldn’t copy. Select the text and copy it yourself.');
      }
    },
  };

  async function bulkTag(mode) {
    const values = await openDialog(`
      <form><h2>${mode === 'add' ? 'Tag' : 'Remove a tag from'} ${plural(m.selected.size, 'person', 'people')}</h2>
        <label>Tag<input name="tag" required maxlength="40" list="mkt-tags" autocomplete="off" /></label>
        <datalist id="mkt-tags">${m.overview.tags.map((t) => `<option value="${esc(t.tag)}">`).join('')}</datalist>
        <div class="row end"><button type="button" class="btn" data-dialog-close>Cancel</button><button class="btn primary">${mode === 'add' ? 'Add tag' : 'Remove tag'}</button></div>
      </form>`);
    if (!values?.tag) return;
    const emails = [...m.selected];
    for (let i = 0; i < emails.length; i += 1000) await api('POST', path('/subscribers/tag'), { emails: emails.slice(i, i + 1000), [mode]: [values.tag.trim()] });
    await Promise.all([loadOverview(), loadSubscribers()]);
    toast(mode === 'add' ? `Tagged “${values.tag}”` : `Removed “${values.tag}”`);
    render();
  }

  const changeActions = {
    'mkt-audience-mode': (target) => {
      const picks = document.querySelector('.mkt-tag-picks');
      if (picks) picks.hidden = target.value !== 'tags';
      if (target.value === 'all') {
        m.campaign.audience = { tags: [] };
        document.querySelectorAll('[data-change="mkt-audience-tag"]').forEach((box) => (box.checked = false));
      }
      scheduleSave();
      refreshPreview();
    },
    'mkt-audience-tag': async (target) => {
      const tags = new Set(m.campaign.audience.tags);
      if (target.checked) tags.add(target.value);
      else tags.delete(target.value);
      m.campaign.audience = { tags: [...tags] };
      scheduleSave();
      if (!m.subscribers) await loadSubscribers().catch(() => {});
      refreshPreview();
    },
    'mkt-recipient-filter': guard(async (target) => {
      m.recipientFilter = target.value;
      m.recipients = await api('GET', path(`/campaigns/${encodeURIComponent(m.campaign.id)}/recipients?filter=${m.recipientFilter}`));
      render();
    }),
    'mkt-filter': (target) => {
      m.filter = target.value;
      m.selected.clear();
      patchAudience();
    },
    'mkt-select': (target) => {
      if (target.checked) m.selected.add(target.value);
      else m.selected.delete(target.value);
      const bulk = document.querySelector('.mkt-bulk');
      if (bulk) bulk.innerHTML = bulkHtml();
    },
    'mkt-select-all': () => {
      for (const s of shownSubscribers().slice(0, SHOWN_MAX)) m.selected.add(s.email);
      patchAudience();
    },
  };

  const inputActions = {
    'mkt-field': (target) => {
      if (!m.campaign) return;
      m.campaign[target.name] = target.value;
      scheduleSave();
      refreshPreview();
    },
    'mkt-search': (target) => {
      m.query = target.value;
      patchAudience();
    },
  };

  const formActions = {
    'mkt-settings': async (form, data) => {
      try {
        const body = Object.fromEntries(data);
        const { settings } = await api('PATCH', path('/settings'), body);
        m.overview.settings = settings;
        toast('Settings saved');
        render();
      } catch (error) {
        toast(error.message);
      }
    },
  };

  return {
    load,
    ready: (r) => r.view !== 'marketing' || Boolean(m.overview && m.ws === r.ws && (r.tab !== 'audience' || m.subscribers) && (!(r.tab === 'campaigns' && r.id) || m.campaign)),
    view,
    clickActions,
    changeActions,
    inputActions,
    formActions,
    // Leaving the editor saves any pending change first.
    flush: () => (saveTimer ? saveNow() : null),
  };
}
