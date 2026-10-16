import { api, attempt, confirmDialog, field, fmtDateTime, formValues, go, h, modal, mount, timeAgo } from '../lib.js';
import { statTile } from './dashboard.js';

const STATUS_TONE = { queued: 'info', sending: 'info', sent: 'ok', failed: 'bad', suppressed: 'warn', cancelled: 'muted' };
const statusChip = (s) => h('span', { class: `chip chip-${STATUS_TONE[s]}` }, s);

export async function renderMail(root, tab, query) {
  const tabs = [['overview', 'Overview'], ['messages', 'Delivery log'], ['compose', 'Compose'], ['suppressions', 'Suppressions']];
  const body = h('div');
  mount(root, h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Lyrsoft Mail'),
      h('p', { class: 'muted' }, 'Every email the platform sends — invites, resets, notifications, lead alerts and your own campaigns — goes through this queue.'))),
    h('nav', { class: 'tabs' }, tabs.map(([k, l]) => h('a', { class: `tab${tab === k ? ' on' : ''}`, href: `#/mail/${k}` }, l))),
    body));
  const views = { overview, messages, compose, suppressions };
  await (views[tab] || overview)(body, query);
}

// Daily sent vs failed, two series side by side per day, legend above, value on hover.
function volumeChart(days) {
  const max = Math.max(1, ...days.map((d) => Math.max(d.sent, d.failed)));
  return h('figure', { class: 'chart' },
    h('ul', { class: 'legend' },
      h('li', null, h('span', { class: 'swatch s-sent' }), 'Sent'),
      h('li', null, h('span', { class: 'swatch s-failed' }), 'Failed')),
    h('div', { class: 'bars', role: 'img', 'aria-label': 'Emails per day for the last 14 days' }, days.map((d) => {
      const label = new Date(`${d.day}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      return h('div', { class: 'bar-day', title: `${label}: ${d.sent} sent, ${d.failed} failed` },
        h('div', { class: 'bar-pair' },
          h('span', { class: 'bar s-sent', style: { height: `${(d.sent / max) * 100}%` } }),
          h('span', { class: 'bar s-failed', style: { height: `${(d.failed / max) * 100}%` } })),
        h('small', null, label.replace(/\s/, ' ')));
    })),
    h('details', { class: 'table-toggle' }, h('summary', null, 'Show as table'),
      h('table', { class: 'table compact' }, h('thead', null, h('tr', null, h('th', null, 'Day'), h('th', null, 'Sent'), h('th', null, 'Failed'))),
        h('tbody', null, days.map((d) => h('tr', null, h('td', null, d.day), h('td', null, String(d.sent)), h('td', null, String(d.failed))))))));
}

async function overview(body) {
  const data = await api('/mail/overview');
  const { counts, config, worker } = data;
  const testTo = h('input', { type: 'email', placeholder: 'you@example.com', class: 'input-sm' });
  mount(body,
    h('div', { class: 'stats' },
      statTile('Sent', counts.sent, null, null),
      statTile('Queued', counts.queued + counts.sending, 'waiting or retrying'),
      statTile('Failed', counts.failed, 'gave up after retries', counts.failed ? 'bad' : null),
      statTile('Suppressed', counts.suppressed, 'blocked recipients')),
    h('div', { class: 'cols' },
      h('section', { class: 'panel' }, h('h2', null, 'Last 14 days'), volumeChart(data.days)),
      h('section', { class: 'panel' }, h('h2', null, 'Delivery setup'),
        h('dl', { class: 'kvlist' },
          h('dt', null, 'Transport'), h('dd', null, config.transport),
          h('dt', null, 'From'), h('dd', null, config.from),
          h('dt', null, 'Retries'), h('dd', null, `${config.maxAttempts} attempts, backoff 1m → 4m → 16m → 1h …`),
          h('dt', null, 'Worker'), h('dd', null, worker.startedAt ? `Running · checks every ${config.pollMs / 1000}s · last run ${timeAgo(worker.lastRunAt)}` : 'Not running'),
          worker.lastError ? [h('dt', null, 'Last error'), h('dd', { class: 'late' }, worker.lastError)] : null),
        config.transport.startsWith('log') ? h('p', { class: 'note' }, 'Development mode: messages are written to the outbox folder instead of being delivered. Set MAIL_TRANSPORT=smtp to send for real.') : null,
        h('div', { class: 'row' }, testTo,
          h('button', { class: 'btn', onclick: async () => {
            if (await attempt(() => api('/mail/test', { method: 'POST', body: { to: testTo.value || undefined } }), 'Test email queued')) overview(body);
          } }, 'Send test'),
          h('button', { class: 'btn', onclick: async () => {
            const res = await attempt(() => api('/mail/run', { method: 'POST' }));
            if (res) overview(body);
          } }, 'Run queue now')))));
}

async function messages(body, query) {
  const status = query.status || '';
  const q = query.q || '';
  const page = Number(query.page) || 1;
  const params = new URLSearchParams({ ...(status && { status }), ...(q && { q }), page: String(page) });
  const data = await api(`/mail/messages?${params}`);
  const nav = (patch) => go(`#/mail/messages?${new URLSearchParams({ status, q, page: '1', ...patch })}`);
  const search = h('input', { type: 'search', class: 'input-sm', placeholder: 'Recipient or subject', value: q, onkeydown: (e) => { if (e.key === 'Enter') nav({ q: search.value }); } });

  mount(body,
    h('div', { class: 'toolbar' },
      h('select', { class: 'input-sm', onchange: (e) => nav({ status: e.target.value }) },
        ['', 'queued', 'sent', 'failed', 'suppressed', 'cancelled'].map((s) => h('option', { value: s, selected: s === status }, s || 'All statuses'))),
      search, h('span', { class: 'muted' }, `${data.total} message${data.total === 1 ? '' : 's'}`)),
    h('section', { class: 'panel flush' }, h('div', { class: 'table-wrap' }, h('table', { class: 'table clickable' },
      h('thead', null, h('tr', null, ['Status', 'To', 'Subject', 'Type', 'Tries', 'Created'].map((t) => h('th', null, t)))),
      h('tbody', null, data.messages.length ? data.messages.map((m) => h('tr', { onclick: () => messageDialog(m.id, () => messages(body, query)) },
        h('td', null, statusChip(m.status)), h('td', null, m.to), h('td', null, m.subject),
        h('td', { class: 'muted' }, m.template), h('td', null, `${m.attempts}/${m.maxAttempts}`), h('td', { class: 'muted', title: fmtDateTime(m.createdAt) }, timeAgo(m.createdAt))))
        : h('tr', null, h('td', { colspan: 6, class: 'muted pad' }, 'No messages')))))),
    data.pages > 1 ? h('div', { class: 'row pager' },
      h('button', { class: 'btn btn-sm', disabled: page <= 1, onclick: () => nav({ page: String(page - 1) }) }, '← Newer'),
      h('span', { class: 'muted' }, `Page ${page} of ${data.pages}`),
      h('button', { class: 'btn btn-sm', disabled: page >= data.pages, onclick: () => nav({ page: String(page + 1) }) }, 'Older →')) : null);
}

async function messageDialog(messageId, refresh) {
  const { message: m, events } = await api(`/mail/messages/${messageId}`);
  const act = (path, msg) => async () => {
    if (await attempt(() => api(`/mail/messages/${m.id}/${path}`, { method: 'POST' }), msg)) { close(); refresh(); }
  };
  const close = modal(m.subject, h('div', { class: 'stack' },
    h('dl', { class: 'kvlist' },
      h('dt', null, 'Status'), h('dd', null, statusChip(m.status)),
      h('dt', null, 'To'), h('dd', null, m.to), h('dt', null, 'From'), h('dd', null, m.from),
      m.replyTo ? [h('dt', null, 'Reply-to'), h('dd', null, m.replyTo)] : null,
      h('dt', null, 'Template'), h('dd', null, `${m.template} · ${m.category}`),
      h('dt', null, 'Attempts'), h('dd', null, `${m.attempts} of ${m.maxAttempts}`),
      m.status === 'queued' ? [h('dt', null, 'Next try'), h('dd', null, fmtDateTime(m.nextAttemptAt))] : null,
      m.providerId ? [h('dt', null, 'Message-ID'), h('dd', { class: 'mono' }, m.providerId)] : null,
      m.lastError ? [h('dt', null, 'Last error'), h('dd', { class: 'late' }, m.lastError)] : null),
    h('h3', null, 'Timeline'),
    h('ul', { class: 'timeline' }, events.map((e) => h('li', null, statusChip(e.event in STATUS_TONE ? e.event : 'queued'), ' ', h('strong', null, e.event), e.detail ? ` — ${e.detail}` : '', h('small', { class: 'muted' }, ` · ${fmtDateTime(e.createdAt)}`)))),
    h('h3', null, 'Message'), h('pre', { class: 'mail-body' }, m.text)),
  { wide: true, actions: [
    ['failed', 'cancelled'].includes(m.status) ? h('button', { class: 'btn btn-primary', onclick: act('retry', 'Message re-queued') }, 'Retry') : null,
    m.status === 'queued' ? h('button', { class: 'btn btn-danger', onclick: act('cancel', 'Message cancelled') }, 'Cancel send') : null,
  ].filter(Boolean) });
}

function compose(body) {
  const audiences = [['everyone', 'Everyone with an account'], ['admin', 'Admins'], ['manager', 'Managers'], ['member', 'Members'], ['client', 'Clients']];
  const form = h('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault();
    const values = formValues(form);
    const picked = audiences.map(([v]) => v).filter((v) => form.elements[`aud-${v}`].checked);
    const recipients = [values.to, ...picked].filter(Boolean).join(', ');
    if (!(await confirmDialog('Send email?', `Send "${values.subject}" to ${recipients || 'nobody'}?`, { danger: false, label: 'Send' }))) return;
    const res = await attempt(() => api('/mail/send', { method: 'POST', body: { to: values.to, subject: values.subject, body: values.body, audiences: picked } }));
    if (res) { form.reset(); go('#/mail/messages'); }
  } },
  field('To', h('input', { name: 'to', placeholder: 'client@example.com, another@example.com' }), 'Separate addresses with commas. Suppressed addresses are skipped automatically.'),
  h('fieldset', { class: 'checks' }, h('legend', null, 'Also send to'), audiences.map(([v, l]) => h('label', null, h('input', { type: 'checkbox', name: `aud-${v}` }), l))),
  field('Subject', h('input', { name: 'subject', required: true, maxlength: 200 })),
  field('Message', h('textarea', { name: 'body', rows: 10, required: true, maxlength: 20000 }), 'Plain text. Blank lines start a new paragraph; it is wrapped in the Lyrsoft email layout.'),
  h('button', { class: 'btn btn-primary' }, 'Queue email'));
  mount(body, h('section', { class: 'panel narrow' }, form));
}

async function suppressions(body) {
  const { suppressions: rows } = await api('/mail/suppressions');
  const form = h('form', { class: 'row', onsubmit: async (e) => {
    e.preventDefault();
    if (await attempt(() => api('/mail/suppressions', { method: 'POST', body: formValues(form) }), 'Address suppressed')) suppressions(body);
  } },
  h('input', { name: 'email', type: 'email', required: true, placeholder: 'email@example.com', class: 'input-sm' }),
  h('input', { name: 'reason', placeholder: 'Reason (bounced, unsubscribed…)', class: 'input-sm' }),
  h('button', { class: 'btn' }, 'Suppress'));
  mount(body,
    h('p', { class: 'muted' }, 'Lyrsoft Mail never sends to these addresses. Messages to them are logged as “suppressed”.'),
    form,
    h('section', { class: 'panel flush' }, h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', null, h('tr', null, ['Email', 'Reason', 'Added', ''].map((t) => h('th', null, t)))),
      h('tbody', null, rows.length ? rows.map((r) => h('tr', null, h('td', null, r.email), h('td', { class: 'muted' }, r.reason), h('td', { class: 'muted' }, timeAgo(r.createdAt)),
        h('td', { class: 'actions' }, h('button', { class: 'btn btn-sm', onclick: async () => {
          if (await attempt(() => api(`/mail/suppressions/${encodeURIComponent(r.email)}`, { method: 'DELETE' }), 'Removed')) suppressions(body);
        } }, 'Remove'))))
        : h('tr', null, h('td', { colspan: 4, class: 'muted pad' }, 'No suppressed addresses')))))));
}
