// Lyrsoft Mail: shared inboxes (support@lyrtrip.com and so on) inside Lyrsoft Work.
// Routes: #/mail/<address>?status=open|closed|spam&thread=<id>, and #/mail/settings (super admin).
// The app shell (app.js) owns routing and rendering; this module loads mail data and renders views.

const STATUS_LABELS = { open: 'Open', closed: 'Closed', spam: 'Spam' };
const REMOTE_URL = /^\s*(https?:)?\/\//i;
const CSS_REMOTE_URL = /url\(\s*(['"]?)\s*(https?:)?\/\/[^)]*\)/gi; // for replace()
const HAS_CSS_REMOTE_URL = /url\(\s*(['"]?)\s*(https?:)?\/\//i; // for test(): no /g, so no lastIndex state

// Removes everything in an email's HTML that would make the browser fetch from the sender's
// servers (tracking pixels, remote images, CSS backgrounds, stylesheets). The page's
// Content-Security-Policy alone isn't enough: browsers start fetching images before they read it.
// DOMParser builds an inert document, so parsing here fetches nothing. Returns { html, blocked }.
function blockRemoteContent(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  let blocked = 0;
  for (const node of doc.querySelectorAll('script, link, object, embed, iframe, frame, base, meta[http-equiv]')) node.remove();
  for (const node of doc.querySelectorAll('[srcset]')) {
    node.removeAttribute('srcset');
    blocked += 1;
  }
  for (const node of doc.querySelectorAll('img[src], image, input[src], video, audio, source')) {
    const src = node.getAttribute('src') || node.getAttribute('href') || node.getAttribute('poster') || '';
    if (REMOTE_URL.test(src) || node.hasAttribute('poster')) {
      node.removeAttribute('src');
      node.removeAttribute('href');
      node.removeAttribute('poster');
      blocked += 1;
    }
  }
  for (const node of doc.querySelectorAll('[background]')) {
    if (REMOTE_URL.test(node.getAttribute('background'))) {
      node.removeAttribute('background');
      blocked += 1;
    }
  }
  for (const node of doc.querySelectorAll('[style]')) {
    const style = node.getAttribute('style');
    if (HAS_CSS_REMOTE_URL.test(style)) {
      node.setAttribute('style', style.replace(CSS_REMOTE_URL, 'none'));
      blocked += 1;
    }
  }
  for (const node of doc.querySelectorAll('style')) {
    if (HAS_CSS_REMOTE_URL.test(node.textContent) || /@import/i.test(node.textContent)) {
      node.textContent = node.textContent.replace(/@import[^;]*;?/gi, '').replace(CSS_REMOTE_URL, 'none');
      blocked += 1;
    }
  }
  return { html: doc.body.innerHTML, head: [...doc.head.querySelectorAll('style')].map((n) => n.outerHTML).join(''), blocked };
}

export function createMail({ api, esc, toast, render, go, withParams, initial, formatDateTime, getMe }) {
  const mail = {
    boxes: null, // GET /mail/mailboxes
    list: null, // { key, threads, cursor }
    convo: null, // { key, thread, messages }
    showImages: new Set(),
  };

  const box = (address) => mail.boxes?.mailboxes.find((m) => m.address === address);
  const boxPath = (address, path = '') => `/mail/mailboxes/${encodeURIComponent(address)}${path}`;
  const shortDate = (iso) => {
    const date = new Date(iso);
    return date.toDateString() === new Date().toDateString()
      ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
      : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };
  const person = (p) => (p?.name ? `${esc(p.name)} <span class="muted">&lt;${esc(p.address)}&gt;</span>` : esc(p?.address || ''));
  const hasMail = () => Boolean(getMe()?.mailboxCount || getMe()?.globalRole === 'superadmin');

  async function loadBoxes(force = false) {
    if (!mail.boxes || force) mail.boxes = await api('GET', '/mail/mailboxes');
  }

  // ------------------------------------------------------------------ loading

  async function load(route) {
    if (!hasMail() && route.view !== 'mailSettings') return;
    await loadBoxes();
    if (route.view !== 'mail') return;
    if (!route.mailbox) {
      const first = mail.boxes.mailboxes[0];
      if (first) return go(`#/mail/${encodeURIComponent(first.address)}`);
      return;
    }
    if (!box(route.mailbox)) throw new Error('Mailbox not found.');
    const status = STATUS_LABELS[route.params.get('status')] ? route.params.get('status') : 'open';
    const key = `${route.mailbox}|${status}`;
    if (mail.list?.key !== key) {
      mail.list = { key, threads: null, cursor: null };
      render();
      const data = await api('GET', `${boxPath(route.mailbox, '/threads')}?status=${status}`);
      if (mail.list.key === key) Object.assign(mail.list, data);
    }
    const threadId = route.params.get('thread');
    const convoKey = threadId && `${route.mailbox}|${threadId}`;
    if (!threadId) mail.convo = null;
    else if (mail.convo?.key !== convoKey) {
      mail.convo = { key: convoKey, thread: null, messages: null };
      render();
      const data = await api('GET', boxPath(route.mailbox, `/threads/${encodeURIComponent(threadId)}`));
      if (mail.convo?.key === convoKey) Object.assign(mail.convo, data);
      const listed = mail.list?.threads?.find((t) => t.id === threadId);
      if (listed) listed.unread = false;
    }
  }

  const refreshList = async (route) => {
    mail.list = null;
    await loadBoxes(true);
    await load(route);
  };

  // ------------------------------------------------------------------ sidebar

  function sidebarLinks(route) {
    if (!hasMail()) return '';
    const boxes = mail.boxes?.mailboxes || [];
    return `
      <nav aria-label="Mail">
        <p class="nav-label">Mail</p>
        ${boxes
          .map(
            (m) => `<a href="#/mail/${encodeURIComponent(m.address)}"${route.view === 'mail' && route.mailbox === m.address ? ' aria-current="page"' : ''}>
              <span class="nav-icon" aria-hidden="true">✉</span><span class="nav-text">${esc(m.address)}</span>${m.openCount ? `<span class="count">${m.openCount}</span>` : ''}</a>`,
          )
          .join('')}
        ${mail.boxes?.canManage ? `<a href="#/mail/settings"${route.view === 'mailSettings' ? ' aria-current="page"' : ''}><span class="nav-icon" aria-hidden="true">⚙</span>Mailbox settings</a>` : ''}
      </nav>`;
  }

  // ------------------------------------------------------------------ inbox view

  function threadRow(t, route) {
    const who = t.lastDirection === 'out' ? `To: ${esc(t.participants[0] || '')}` : esc(t.lastFrom?.name || t.lastFrom?.address || '');
    const href = `#/mail/${encodeURIComponent(route.mailbox)}?${new URLSearchParams({ ...(route.params.get('status') ? { status: route.params.get('status') } : {}), thread: t.id })}`;
    return `
      <a class="thread-row${t.unread ? ' unread' : ''}" href="${href}"${route.params.get('thread') === t.id ? ' aria-current="true"' : ''}>
        <span class="thread-top"><b>${who}</b><time>${shortDate(t.lastMessageAt)}</time></span>
        <span class="thread-subject">${esc(t.subject)}${t.messageCount > 1 ? ` <span class="muted">(${t.messageCount})</span>` : ''}</span>
        <span class="thread-snippet">${esc(t.snippet)}</span>
        <span class="thread-tags">
          ${t.attachmentCount ? '<span title="Has attachments">📎</span>' : ''}
          ${t.assignee ? `<span class="avatar small" title="Assigned to ${esc(t.assignee)}">${initial(t.assignee)}</span>` : ''}
        </span>
      </a>`;
  }

  function messageFrame(message, allowImages, content) {
    const csp = `default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data: cid:${allowImages ? ' https: http:' : ''}`;
    const doc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank"><style>body{margin:0;font:14px/1.5 system-ui,sans-serif;color:#1f2433;background:#fff;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}</style>${content.head}</head><body>${content.html}</body></html>`;
    return `<iframe class="mail-frame" title="Message from ${esc(message.from?.address)}" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" srcdoc="${esc(doc)}"></iframe>`;
  }

  function htmlBody(message) {
    const allowImages = mail.showImages.has(message.id);
    const content = allowImages ? { html: message.html, head: '', blocked: 0 } : blockRemoteContent(message.html);
    const note = content.blocked
      ? `<p class="images-note">Remote images are hidden so the sender can’t tell when you open this. <button class="link-btn" data-click="mail-show-images" data-id="${esc(message.id)}">Show images</button></p>`
      : '';
    return note + messageFrame(message, allowImages, content);
  }

  function messageCard(message) {
    const warn = message.verdicts && ['spf', 'dkim', 'dmarc'].filter((k) => message.verdicts[k] === 'FAIL');
    return `
      <article class="message ${message.direction}">
        <header>
          <span class="avatar">${initial(message.from?.name || message.from?.address)}</span>
          <div>
            <div>${person(message.from)}${message.sentBy ? ` <span class="muted small">· sent by ${esc(message.sentBy)}</span>` : ''}</div>
            <div class="muted small">To ${message.to.map(esc).join(', ')}${message.cc.length ? ` · Cc ${message.cc.map(esc).join(', ')}` : ''}</div>
          </div>
          <time class="muted small">${formatDateTime(message.createdAt)}</time>
        </header>
        ${warn?.length ? `<p class="warning">⚠ This message failed ${warn.map((k) => k.toUpperCase()).join(' and ')} checks. The sender may not be who they claim.</p>` : ''}
        ${message.html ? htmlBody(message) : `<div class="message-text">${esc(message.text)}</div>`}
        ${message.textTruncated && !message.html ? '<p class="muted small">This message was shortened.</p>' : ''}
        ${
          message.attachments.length
            ? `<div class="attachments">${message.attachments
                .map(
                  (a, n) => `<button class="attachment" data-click="mail-attachment" data-message="${esc(message.id)}" data-n="${n}">📎 ${esc(a.filename)} <span class="muted">${Math.max(1, Math.round(a.size / 1024))} KB</span></button>`,
                )
                .join('')}</div>`
            : ''
        }
      </article>`;
  }

  // Default reply recipients: the sender (or their Reply-To) of the latest incoming message.
  function replyRecipients(messages, mailboxAddress) {
    const lastIn = [...messages].reverse().find((m) => m.direction === 'in');
    if (!lastIn) return { to: messages.at(-1)?.to || [], cc: [] };
    const to = lastIn.replyTo?.length ? lastIn.replyTo : [lastIn.from.address];
    const cc = [...lastIn.to, ...lastIn.cc].filter((a) => a !== mailboxAddress && !to.includes(a));
    return { to, cc };
  }

  function conversation(route) {
    const convo = mail.convo;
    if (!convo?.thread) return '<p class="loading">Loading conversation…</p>';
    const { thread, messages } = convo;
    const me = getMe();
    const { to, cc } = replyRecipients(messages, route.mailbox);
    const sandbox = mail.boxes?.setup?.sandbox;
    return `
      <div class="convo-head">
        <a class="btn ghost small back-to-list" href="${withParams({ thread: null })}">← Back</a>
        <h2>${esc(thread.subject)}</h2>
        <div class="convo-actions">
          ${thread.status === 'open' ? '<button class="btn small" data-click="mail-status" data-status="closed">✓ Close</button>' : '<button class="btn small" data-click="mail-status" data-status="open">Reopen</button>'}
          ${thread.status === 'spam' ? '' : '<button class="btn small" data-click="mail-status" data-status="spam">Spam</button>'}
          ${thread.assignee === me.email ? '<button class="btn small" data-click="mail-assign" data-assignee="">Unassign</button>' : '<button class="btn small" data-click="mail-assign" data-assignee="me">Assign to me</button>'}
          <button class="btn small ghost" data-click="mail-unread">Mark unread</button>
        </div>
        ${thread.assignee ? `<p class="muted small">Assigned to ${esc(thread.assignee)}</p>` : ''}
      </div>
      <div class="messages">${messages.map(messageCard).join('')}</div>
      <form class="reply-box" data-form="mail-reply">
        <label>To <input name="to" value="${esc(to.join(', '))}" required aria-label="To" /></label>
        <label>Cc <input name="cc" value="${esc(cc.join(', '))}" aria-label="Cc" /></label>
        <textarea name="text" rows="5" required placeholder="Write your reply…" aria-label="Reply"></textarea>
        <div class="row end">
          ${sandbox ? '<span class="muted small">SES sandbox: replies only reach verified addresses.</span>' : ''}
          <button class="btn primary" type="submit">Send reply</button>
        </div>
      </form>`;
  }

  function inbox(route) {
    const current = box(route.mailbox);
    const status = STATUS_LABELS[route.params.get('status')] ? route.params.get('status') : 'open';
    const list = mail.list?.threads;
    const showingThread = Boolean(route.params.get('thread'));
    return `
      <div class="page-head">
        <div><h1>${esc(current.displayName || current.address)}</h1><p>${esc(current.address)}${current.catchAll ? ' · catch-all' : ''}</p></div>
        <div class="page-actions"><button class="btn primary" data-click="mail-compose">✎ New email</button></div>
      </div>
      <div class="mail-layout${showingThread ? ' has-thread' : ''}">
        <section class="thread-list" aria-label="Conversations">
          <div class="segmented tabs" role="group" aria-label="Folder">
            ${Object.entries(STATUS_LABELS)
              .map(([key, label]) => `<a href="${withParams({ status: key === 'open' ? null : key, thread: null })}"${key === status ? ' aria-current="page"' : ''}>${label}${key === 'open' && current.openCount ? ` ${current.openCount}` : ''}</a>`)
              .join('')}
          </div>
          ${
            list === null || list === undefined
              ? '<p class="loading">Loading…</p>'
              : list.length
                ? `${list.map((t) => threadRow(t, route)).join('')}${mail.list.cursor ? '<button class="btn ghost load-more" data-click="mail-more">Load more</button>' : ''}`
                : `<p class="empty-list">${status === 'open' ? 'All caught up. 🎉' : `No ${STATUS_LABELS[status].toLowerCase()} conversations.`}</p>`
          }
        </section>
        <section class="conversation" aria-label="Conversation">
          ${showingThread ? conversation(route) : '<p class="empty-list">Select a conversation.</p>'}
        </section>
      </div>`;
  }

  function noMailboxes() {
    return `
      <section class="panel empty">
        <h2>No mailboxes yet</h2>
        <p>${mail.boxes?.canManage ? 'Create support@ and other shared addresses for your domains.' : 'Ask the super admin to add you to a mailbox.'}</p>
        ${mail.boxes?.canManage ? '<a class="btn primary" href="#/mail/settings">Set up mailboxes</a>' : ''}
      </section>`;
  }

  // ------------------------------------------------------------------ settings view (super admin)

  function settings() {
    const { mailboxes, domains, setup, canManage } = mail.boxes;
    if (!canManage) return '<section class="panel empty"><h2>Not available</h2><p>Only the super admin manages mailboxes.</p></section>';
    const statusCell = (ok, text) => `<span class="${ok ? 'ok' : 'warn-text'}">${ok ? '✓' : '✗'} ${text}</span>`;
    return `
      <div class="page-head"><div><h1>Mailbox settings</h1><p>Shared addresses for ${domains.length} domains.</p></div></div>
      ${
        setup?.sandbox
          ? `<section class="panel callout">
              <h2>Sending is limited: Amazon SES is in sandbox mode</h2>
              <p>Receiving works. Replies and new emails only reach addresses verified in SES, at most 200 a day, until AWS grants production access (SES console → Account dashboard → Request production access).</p>
            </section>`
          : ''
      }
      <section class="panel">
        <div class="panel-head"><h2>Domains</h2></div>
        <div class="table-scroll"><table class="list-table">
          <thead><tr><th>Domain</th><th>Sending</th><th>DKIM</th></tr></thead>
          <tbody>${(setup?.domains || [])
            .map((d) => `<tr><td><b>${esc(d.domain)}</b></td><td>${statusCell(d.sending, d.sending ? 'Verified' : 'Not verified')}</td><td>${statusCell(d.dkim === 'SUCCESS', esc(d.dkim || '—'))}</td></tr>`)
            .join('')}</tbody>
        </table></div>
        <p class="muted small">Receiving needs an MX record on each domain: <code>10 inbound-smtp.us-east-1.amazonaws.com</code>. <code>scripts/deploy-lyrsoft.sh</code> prints every DNS record to add in Cloudflare.</p>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Mailboxes</h2><span class="muted">${mailboxes.length}</span></div>
        <form class="mailbox-form" data-form="mail-create">
          <div class="address-input"><input name="local" required placeholder="support" aria-label="Address name" pattern="[A-Za-z0-9._+\\-]+" /><span>@</span>
            <select name="domain" aria-label="Domain">${domains.map((d) => `<option>${esc(d)}</option>`).join('')}</select></div>
          <input name="displayName" placeholder="Display name, e.g. Lyrtrip Support" aria-label="Display name" maxlength="80" />
          <input name="members" placeholder="Who can use it (emails, comma separated)" aria-label="Members" />
          <label class="check"><input type="checkbox" name="catchAll" /> Catch-all for this domain</label>
          <button class="btn primary" type="submit">Create mailbox</button>
        </form>
        <p class="muted small">You and Lyrcloud admins can open every mailbox. A catch-all receives mail for any address on its domain that has no mailbox of its own.</p>
        <div class="table-scroll"><table class="list-table">
          <thead><tr><th>Address</th><th>Members</th><th></th></tr></thead>
          <tbody>${mailboxes
            .map(
              (m) => `<tr>
                <td><b>${esc(m.address)}</b>${m.catchAll ? ' <span class="pill">catch-all</span>' : ''}<br><small class="muted">${esc(m.displayName || 'No display name')}</small></td>
                <td>${m.members?.length ? m.members.map(esc).join('<br>') : '<span class="muted">Staff only</span>'}</td>
                <td class="right"><button class="btn small" data-click="mail-edit-box" data-address="${esc(m.address)}">Edit</button>
                  <button class="btn small danger" data-click="mail-delete-box" data-address="${esc(m.address)}">Delete</button></td>
              </tr>`,
            )
            .join('')}</tbody>
        </table></div>
      </section>`;
  }

  // ------------------------------------------------------------------ forms in dialogs

  function formDialog(title, body, submitLabel) {
    return new Promise((resolve) => {
      const node = document.createElement('dialog');
      node.className = 'dialog wide';
      node.innerHTML = `<form method="dialog"><h2>${esc(title)}</h2>${body}
        <div class="row end"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok">${esc(submitLabel)}</button></div></form>`;
      document.body.append(node);
      node.addEventListener('close', () => {
        const form = node.querySelector('form');
        const values = node.returnValue === 'ok' ? { ...Object.fromEntries(new FormData(form)), _checked: [...form.querySelectorAll('input[type=checkbox]:checked')].map((i) => i.name) } : null;
        node.remove();
        resolve(values);
      });
      node.showModal();
    });
  }

  // ------------------------------------------------------------------ actions

  const currentRoute = { value: null };
  const threadPath = () => boxPath(currentRoute.value.mailbox, `/threads/${encodeURIComponent(currentRoute.value.params.get('thread'))}`);

  async function patchThread(changes, message) {
    try {
      const { thread } = await api('PATCH', threadPath(), changes);
      mail.convo.thread = thread;
      await refreshList(currentRoute.value);
      if ('status' in changes && changes.status !== (currentRoute.value.params.get('status') || 'open')) {
        go(withParams({ thread: null }));
      } else render();
      if (message) toast(message);
    } catch (error) {
      toast(error.message);
    }
  }

  const clickActions = {
    'mail-show-images': (target) => {
      mail.showImages.add(target.dataset.id);
      render();
    },
    'mail-status': (target) => patchThread({ status: target.dataset.status }, { closed: 'Conversation closed', open: 'Conversation reopened', spam: 'Moved to spam' }[target.dataset.status]),
    'mail-assign': (target) => patchThread({ assignee: target.dataset.assignee === 'me' ? getMe().email : null }, target.dataset.assignee ? 'Assigned to you' : 'Unassigned'),
    'mail-unread': async () => {
      await patchThread({ unread: true });
      go(withParams({ thread: null }));
    },
    'mail-more': async () => {
      const route = currentRoute.value;
      const status = route.params.get('status') || 'open';
      try {
        const data = await api('GET', `${boxPath(route.mailbox, '/threads')}?status=${status}&cursor=${encodeURIComponent(mail.list.cursor)}`);
        mail.list.threads.push(...data.threads);
        mail.list.cursor = data.cursor;
        render();
      } catch (error) {
        toast(error.message);
      }
    },
    'mail-attachment': async (target) => {
      try {
        const { url } = await api('GET', `${threadPath()}/messages/${encodeURIComponent(target.dataset.message)}/attachments/${target.dataset.n}`);
        location.href = url;
      } catch (error) {
        toast(error.message);
      }
    },
    'mail-compose': async () => {
      const route = currentRoute.value;
      const values = await formDialog(`New email from ${route.mailbox}`, `
        <label>To<input name="to" required placeholder="name@example.com, …" /></label>
        <label>Cc<input name="cc" placeholder="Optional" /></label>
        <label>Subject<input name="subject" required maxlength="300" /></label>
        <label>Message<textarea name="text" rows="8" required></textarea></label>`, 'Send');
      if (!values) return;
      try {
        const { thread } = await api('POST', boxPath(route.mailbox, '/send'), values);
        await refreshList(route);
        go(`#/mail/${encodeURIComponent(route.mailbox)}?thread=${encodeURIComponent(thread.id)}`);
        toast('Sent');
      } catch (error) {
        toast(error.message);
      }
    },
    'mail-edit-box': async (target) => {
      const m = box(target.dataset.address);
      const values = await formDialog(`Edit ${m.address}`, `
        <label>Display name<input name="displayName" value="${esc(m.displayName)}" maxlength="80" /></label>
        <label>Members (emails, comma separated)<textarea name="members" rows="3">${esc((m.members || []).join(', '))}</textarea></label>
        <label class="check"><input type="checkbox" name="catchAll"${m.catchAll ? ' checked' : ''} /> Catch-all for @${esc(m.address.split('@')[1])}</label>`, 'Save');
      if (!values) return;
      try {
        await api('PATCH', boxPath(m.address), { displayName: values.displayName, members: values.members, catchAll: values._checked.includes('catchAll') });
        await loadBoxes(true);
        render();
        toast('Mailbox saved');
      } catch (error) {
        toast(error.message);
      }
    },
    'mail-delete-box': async (target) => {
      const address = target.dataset.address;
      if (!confirm(`Delete ${address}? New mail to it stops being filed (unless a catch-all picks it up). Past conversations are kept and come back if you re-create it.`)) return;
      try {
        await api('DELETE', boxPath(address));
        await loadBoxes(true);
        render();
        toast(`${address} deleted`);
      } catch (error) {
        toast(error.message);
      }
    },
  };

  const formActions = {
    'mail-reply': async (form, data) => {
      const button = form.querySelector('[type="submit"]');
      button.disabled = true;
      try {
        await api('POST', `${threadPath()}/reply`, { to: data.get('to'), cc: data.get('cc'), text: data.get('text') });
        mail.convo = null;
        await refreshList(currentRoute.value);
        render();
        toast('Reply sent');
      } catch (error) {
        button.disabled = false;
        toast(error.message);
      }
    },
    'mail-create': async (form, data) => {
      try {
        await api('POST', '/mail/mailboxes', {
          address: `${String(data.get('local')).trim()}@${data.get('domain')}`,
          displayName: data.get('displayName'),
          members: data.get('members'),
          catchAll: data.get('catchAll') === 'on',
        });
        await loadBoxes(true);
        render();
        toast('Mailbox created');
      } catch (error) {
        toast(error.message);
      }
    },
  };

  // Sizes each message frame to its content once it has loaded.
  function afterRender() {
    for (const frame of document.querySelectorAll('iframe.mail-frame')) {
      frame.addEventListener('load', () => {
        frame.style.height = `${frame.contentDocument.documentElement.scrollHeight + 4}px`;
      });
    }
  }

  return {
    hasMail,
    load: (route) => {
      currentRoute.value = route;
      return load(route);
    },
    ready: (route) => Boolean(mail.boxes) || (!hasMail() && route.view !== 'mailSettings'),
    view: (route) => {
      currentRoute.value = route;
      if (route.view === 'mailSettings') return settings();
      if (!mail.boxes?.mailboxes.length) return noMailboxes();
      if (!route.mailbox || !box(route.mailbox)) return '<p class="loading">Loading…</p>';
      return inbox(route);
    },
    sidebarLinks,
    afterRender,
    clickActions,
    formActions,
  };
}
