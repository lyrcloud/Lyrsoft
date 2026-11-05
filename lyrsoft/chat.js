// Lyrsoft Work messages (#/chat, #/chat/<conversation>), plugged into app.js like mail.js.
// Conversations are groups (any people you work with, with a name), direct messages with one person,
// and each workspace's team channel. The open conversation polls for new messages every 4 seconds, and the sidebar badge
// checks for unread conversations every 30 seconds. Polling updates the page in place, so it never
// disturbs a message being typed.
const POLL_OPEN_MS = 4000;
const POLL_BADGE_MS = 30000;

export function createChat({ api, esc, toast, render, go, initial, formatDateTime, getMe }) {
  const chat = {
    list: null, // GET /chat: { channels, dms, contacts, unreadCount }
    open: null, // { id, conversation, messages }
    drafts: new Map(), // conversation id -> unsent text
    sending: false,
    unreadCount: 0,
  };
  let route = null;
  let openTimer = null;
  let badgeTimer = null;

  const allConversations = () => [...(chat.list?.groups || []), ...(chat.list?.dms || []), ...(chat.list?.channels || [])];
  const findConversation = (id) => allConversations().find((c) => c.id === id);
  const timeOf = (iso) => {
    const date = new Date(iso);
    return date.toDateString() === new Date().toDateString()
      ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
      : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  async function loadList() {
    chat.list = await api('GET', '/chat');
    chat.unreadCount = chat.list.unreadCount;
  }

  async function loadMessages(id) {
    const data = await api('GET', `/chat/${encodeURIComponent(id)}/messages`);
    chat.open = { id, ...data };
    const listed = findConversation(id);
    if (listed?.unread) {
      listed.unread = false;
      chat.unreadCount = Math.max(0, chat.unreadCount - 1);
    }
  }

  async function load(next) {
    route = next;
    if (next.view !== 'chat') {
      stopOpenPolling();
      return;
    }
    await loadList();
    const id = next.conv || allConversations()[0]?.id;
    if (!next.conv && id) return go(`#/chat/${encodeURIComponent(id)}`);
    if (id && chat.open?.id !== id) {
      chat.open = null;
      render();
      await loadMessages(id);
    }
    startOpenPolling();
  }

  // ---------------------------------------------------------------- polling

  function stopOpenPolling() {
    clearInterval(openTimer);
    openTimer = null;
  }

  function startOpenPolling() {
    stopOpenPolling();
    openTimer = setInterval(async () => {
      if (route?.view !== 'chat' || !chat.open || document.hidden) return;
      const last = chat.open.messages.at(-1)?.createdAt;
      try {
        const { messages } = await api('GET', `/chat/${encodeURIComponent(chat.open.id)}/messages${last ? `?after=${encodeURIComponent(last)}` : ''}`);
        const fresh = messages.filter((m) => !chat.open.messages.some((x) => x.id === m.id));
        if (fresh.length) {
          chat.open.messages.push(...fresh);
          patchMessages();
        }
        const list = await api('GET', '/chat');
        const changed = JSON.stringify([...list.groups, ...list.dms, ...list.channels].map((c) => [c.id, c.lastMessageAt, c.unread, c.title])) !== JSON.stringify(allConversations().map((c) => [c.id, c.lastMessageAt, c.unread, c.title]));
        chat.list = list;
        chat.unreadCount = list.unreadCount;
        if (changed) patchList();
        updateBadge();
      } catch {
        // Try again on the next tick.
      }
    }, POLL_OPEN_MS);
  }

  // Keeps the sidebar badge fresh on every page, without re-rendering anything.
  function startBadgePolling() {
    if (badgeTimer) return;
    const tick = async () => {
      if (document.hidden || route?.view === 'chat') return;
      try {
        const list = await api('GET', '/chat');
        chat.unreadCount = list.unreadCount;
        updateBadge();
      } catch {}
    };
    tick();
    badgeTimer = setInterval(tick, POLL_BADGE_MS);
  }

  function updateBadge() {
    for (const node of document.querySelectorAll('[data-chat-badge]')) {
      node.textContent = chat.unreadCount || '';
      node.hidden = !chat.unreadCount;
    }
  }

  function patchMessages() {
    const box = document.querySelector('.chat-messages');
    if (!box) return render();
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    box.innerHTML = messagesHtml();
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  function patchList() {
    const node = document.querySelector('.chat-list-items');
    if (node) node.innerHTML = listItemsHtml();
  }

  // ---------------------------------------------------------------- views

  function sidebarLinks(current) {
    startBadgePolling();
    return `
      <nav aria-label="Communicate">
        <p class="nav-label">Communicate</p>
        <a href="#/chat"${current.view === 'chat' ? ' aria-current="page"' : ''}><span class="nav-icon" aria-hidden="true">💬</span>Messages<span class="count" data-chat-badge${chat.unreadCount ? '' : ' hidden'}>${chat.unreadCount || ''}</span></a>
        <a href="#/meetings"${current.view === 'meetings' || current.view === 'meet' ? ' aria-current="page"' : ''}><span class="nav-icon" aria-hidden="true">📹</span>Meetings</a>
      </nav>`;
  }

  const iconOf = (c) => (c?.type === 'ws' ? '#' : c?.type === 'group' ? '👥' : initial(c?.title));
  const convLink = (c) => `
    <a class="chat-conv${c.unread ? ' unread' : ''}" href="#/chat/${encodeURIComponent(c.id)}"${chat.open?.id === c.id || route?.conv === c.id ? ' aria-current="page"' : ''}>
      <span class="chat-conv-icon${c.type === 'group' ? ' group' : ''}" aria-hidden="true">${iconOf(c)}</span>
      <span class="chat-conv-text"><b>${esc(c.title)}</b><small>${esc(c.lastSnippet || (c.type === 'ws' ? 'Team channel' : c.type === 'group' ? `${c.memberCount} people` : 'Say hello 👋'))}</small></span>
      ${c.lastMessageAt ? `<time>${timeOf(c.lastMessageAt)}</time>` : ''}
    </a>`;

  function listItemsHtml() {
    const { channels = [], groups = [], dms = [] } = chat.list || {};
    return `
      <p class="chat-section">Groups</p>
      ${groups.map(convLink).join('') || '<p class="muted small chat-none">No groups yet. Start one with 👥 New group.</p>'}
      <p class="chat-section">Direct messages</p>
      ${dms.map(convLink).join('') || '<p class="muted small chat-none">No direct messages yet.</p>'}
      <p class="chat-section">Team channels</p>
      ${channels.map(convLink).join('') || '<p class="muted small chat-none">Join a workspace to get its channel.</p>'}`;
  }

  function messagesHtml() {
    const me = getMe();
    const messages = chat.open?.messages || [];
    if (!messages.length) return '<p class="empty-list">No messages yet. Start the conversation.</p>';
    let lastDay = '';
    return messages
      .map((m) => {
        const day = new Date(m.createdAt).toDateString();
        const divider = day !== lastDay ? `<p class="chat-day">${new Date(m.createdAt).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</p>` : '';
        lastDay = day;
        if (m.kind === 'system') return `${divider}<p class="chat-system">${esc(m.body)}</p>`;
        const mine = m.authorEmail === me.email;
        const body =
          m.kind === 'meeting'
            ? `<div class="chat-meeting"><span aria-hidden="true">📹</span><span><b>Video meeting</b><small>${esc(m.body)}</small></span><a class="btn small primary" href="#/meet/${encodeURIComponent(m.meetingId)}">Join</a></div>`
            : `<p>${esc(m.body).replace(/https:\/\/[^\s<]+[^\s<.,;:!?)]/g, (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`)}</p>`;
        return `${divider}
          <div class="chat-msg${mine ? ' mine' : ''}">
            ${mine ? '' : `<span class="avatar small" title="${esc(m.authorEmail)}">${initial(m.authorName || m.authorEmail)}</span>`}
            <div class="chat-bubble">
              ${mine ? '' : `<span class="chat-author">${esc(m.authorName || m.authorEmail)}</span>`}
              ${body}
              <time title="${esc(formatDateTime(m.createdAt))}">${new Date(m.createdAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</time>
            </div>
          </div>`;
      })
      .join('');
  }

  function subtitle(current, conversation) {
    if (current?.type === 'ws') return 'Everyone in this workspace';
    if (current?.type === 'group') {
      const names = (conversation.members || []).map((e) => (e === getMe().email ? 'You' : conversation.names?.[e] || e));
      return esc(`${names.length} people: ${names.slice(0, 6).join(', ')}${names.length > 6 ? ` +${names.length - 6}` : ''}`);
    }
    return esc(current?.with || '');
  }

  // A people picker: one person (a direct message) or several plus a name (a group).
  // Resolves to { emails, name } or null.
  function pickPeople({ title, multiple, askName = false, nameValue = '', submitLabel, exclude = [] }) {
    const people = (chat.list?.contacts || []).filter((c) => !exclude.includes(c.email));
    return new Promise((resolve) => {
      const node = document.createElement('dialog');
      node.className = 'dialog wide people-dialog';
      node.innerHTML = `
        <form method="dialog">
          <h2>${esc(title)}</h2>
          ${askName ? `<label>Group name<input name="name" required maxlength="80" value="${esc(nameValue)}" placeholder="e.g. Design team" /></label>` : ''}
          ${
            people.length
              ? `<input type="search" class="people-search" placeholder="Search people" aria-label="Search people" />
                 <div class="people-list">${people
                   .map(
                     (c) => `<label class="person-option" data-search="${esc(`${c.name} ${c.email}`.toLowerCase())}">
                       <input type="${multiple ? 'checkbox' : 'radio'}" name="email" value="${esc(c.email)}" />
                       <span class="avatar small">${initial(c.name || c.email)}</span>
                       <span><b>${esc(c.name || c.email)}</b><small>${esc(c.email)}</small></span>
                     </label>`,
                   )
                   .join('')}</div>`
              : '<p class="muted">Everyone you work with is already here.</p>'
          }
          <p class="people-error auth-error" hidden></p>
          <div class="row end"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok"${people.length ? '' : ' disabled'}>${esc(submitLabel)}</button></div>
        </form>`;
      document.body.append(node);
      const form = node.querySelector('form');
      node.querySelector('.people-search')?.addEventListener('input', (event) => {
        const q = event.target.value.trim().toLowerCase();
        for (const option of node.querySelectorAll('.person-option')) option.hidden = Boolean(q) && !option.dataset.search.includes(q);
      });
      form.addEventListener('submit', (event) => {
        if (event.submitter?.value !== 'ok') return;
        if (!form.querySelector('input[name="email"]:checked')) {
          event.preventDefault();
          const error = node.querySelector('.people-error');
          error.textContent = multiple ? 'Pick at least one person.' : 'Pick someone to message.';
          error.hidden = false;
        }
      });
      node.addEventListener('close', () => {
        const result = node.returnValue === 'ok'
          ? { emails: [...form.querySelectorAll('input[name="email"]:checked')].map((i) => i.value), name: form.querySelector('input[name="name"]')?.value || '' }
          : null;
        node.remove();
        resolve(result);
      });
      node.showModal();
      node.querySelector(askName ? 'input[name="name"]' : '.people-search')?.focus();
    });
  }

  function view() {
    const list = chat.list;
    const open = chat.open;
    const current = open && findConversation(open.id);
    const contacts = list.contacts || [];
    return `
      <div class="page-head"><div><h1>Messages</h1><p>Team channels for each workspace, and direct messages with the people you work with.</p></div></div>
      <div class="chat-layout${route.conv ? ' has-conv' : ''}">
        <aside class="chat-list" aria-label="Conversations">
          <div class="chat-new">
            <button class="btn small primary" data-click="chat-new-dm"${contacts.length ? '' : ' disabled title="Join a workspace with other people first"'}>✎ Message</button>
            <button class="btn small" data-click="chat-new-group"${contacts.length ? '' : ' disabled title="Join a workspace with other people first"'}>👥 New group</button>
          </div>
          <div class="chat-list-items">${listItemsHtml()}</div>
        </aside>
        <section class="chat-pane" aria-label="Conversation">
          ${
            !route.conv
              ? '<div class="empty-list convo-empty"><span aria-hidden="true">💬</span><p>Pick a conversation, or start a new one.</p></div>'
              : !open
                ? '<p class="loading">Loading…</p>'
                : `
            <header class="chat-head">
              <a class="btn ghost small back-to-list" href="#/chat">←</a>
              <span class="chat-conv-icon${current?.type === 'group' ? ' group' : ''}" aria-hidden="true">${iconOf(current)}</span>
              <div><h2>${esc(current?.title || open.conversation.title || 'Conversation')}</h2><small class="muted">${subtitle(current, open.conversation)}</small></div>
              <div class="chat-head-actions">
                <button class="btn small" data-click="chat-call" title="Start a video call with everyone here">📹 Call</button>
                ${
                  current?.type === 'group'
                    ? `<button class="btn small" data-click="chat-group-add" title="Add people">👥 Add</button>
                       <button class="btn small ghost" data-click="chat-group-rename" title="Rename the group">✎</button>
                       <button class="btn small ghost" data-click="chat-group-leave" title="Leave the group">Leave</button>`
                    : ''
                }
              </div>
            </header>
            <div class="chat-messages" aria-live="polite">${messagesHtml()}</div>
            <form class="chat-compose" data-form="chat-send">
              <textarea name="body" rows="1" maxlength="4000" placeholder="Message ${esc(current?.title || '')}" data-input="chat-draft" aria-label="Message">${esc(chat.drafts.get(open.id) || '')}</textarea>
              <button class="btn primary" type="submit"${chat.sending ? ' disabled' : ''} aria-label="Send">Send ➤</button>
            </form>`
          }
        </section>
      </div>`;
  }

  // Scrolls to the newest message and keeps the composer focused after a full render.
  function afterRender() {
    if (route?.view !== 'chat') return;
    const box = document.querySelector('.chat-messages');
    if (box) box.scrollTop = box.scrollHeight;
    const input = document.querySelector('.chat-compose textarea');
    if (input && chat.focusComposer) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      chat.focusComposer = false;
    }
    autosize(input);
  }

  function autosize(input) {
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  }

  // ---------------------------------------------------------------- actions

  async function send(form) {
    const input = form.querySelector('textarea');
    const body = input.value.trim();
    if (!body || chat.sending) return;
    chat.sending = true;
    const id = chat.open.id;
    try {
      const { message } = await api('POST', `/chat/${encodeURIComponent(id)}/messages`, { body });
      chat.drafts.delete(id);
      if (chat.open?.id === id) chat.open.messages.push(message);
      const listed = findConversation(id);
      if (listed) Object.assign(listed, { lastMessageAt: message.createdAt, lastSnippet: body.slice(0, 120) });
      chat.focusComposer = true;
    } catch (error) {
      toast(error.message);
    }
    chat.sending = false;
    render();
  }

  const formActions = {
    'chat-send': (form) => send(form),
  };

  // Reloads the conversation list and the open conversation (after a group changes).
  async function refresh(id) {
    await loadList();
    if (id) await loadMessages(id);
    render();
  }

  const clickActions = {
    'chat-new-dm': async () => {
      const picked = await pickPeople({ title: 'New message', multiple: false, submitLabel: 'Message' });
      if (!picked) return;
      try {
        const { id } = await api('POST', '/chat/dm', { email: picked.emails[0] });
        chat.focusComposer = true;
        go(`#/chat/${encodeURIComponent(id)}`);
      } catch (error) {
        toast(error.message);
      }
    },
    'chat-new-group': async () => {
      const picked = await pickPeople({ title: 'New group', multiple: true, askName: true, submitLabel: 'Create group' });
      if (!picked) return;
      try {
        const { id } = await api('POST', '/chat/groups', { name: picked.name, members: picked.emails });
        chat.focusComposer = true;
        toast('Group created');
        go(`#/chat/${encodeURIComponent(id)}`);
      } catch (error) {
        toast(error.message);
      }
    },
    'chat-group-add': async () => {
      const id = chat.open.id;
      const picked = await pickPeople({ title: 'Add people to the group', multiple: true, submitLabel: 'Add', exclude: chat.open.conversation.members || [] });
      if (!picked) return;
      try {
        await api('PATCH', `/chat/${encodeURIComponent(id)}`, { add: picked.emails });
        await refresh(id);
        toast(`Added ${picked.emails.length} ${picked.emails.length === 1 ? 'person' : 'people'}`);
      } catch (error) {
        toast(error.message);
      }
    },
    'chat-group-rename': async () => {
      const id = chat.open.id;
      const current = findConversation(id);
      const node = document.createElement('dialog');
      node.className = 'dialog';
      node.innerHTML = `<form method="dialog"><h2>Rename group</h2><label>Group name<input name="name" required maxlength="80" value="${esc(current?.title || '')}" /></label>
        <div class="row end"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok">Save</button></div></form>`;
      document.body.append(node);
      const name = await new Promise((resolve) => {
        node.addEventListener('close', () => {
          resolve(node.returnValue === 'ok' ? node.querySelector('input').value : null);
          node.remove();
        });
        node.showModal();
      });
      if (!name) return;
      try {
        await api('PATCH', `/chat/${encodeURIComponent(id)}`, { name });
        await refresh(id);
        toast('Group renamed');
      } catch (error) {
        toast(error.message);
      }
    },
    'chat-group-leave': async () => {
      const current = findConversation(chat.open.id);
      if (!confirm(`Leave “${current?.title}”? You won’t see its messages unless someone adds you back.`)) return;
      try {
        await api('POST', `/chat/${encodeURIComponent(chat.open.id)}/leave`);
        chat.open = null;
        await loadList();
        toast('You left the group');
        go('#/chat');
      } catch (error) {
        toast(error.message);
      }
    },
    'chat-call': async () => {
      const current = findConversation(chat.open.id);
      try {
        const { meeting } = await api('POST', '/meetings', {
          title: current?.type === 'ws' ? `${current.title} team call` : current?.type === 'group' ? `${current.title} call` : `Call with ${getMe().name || getMe().email}`,
          conv: chat.open.id,
          durationMin: 30,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          notify: false,
        });
        go(`#/meet/${encodeURIComponent(meeting.id)}`);
      } catch (error) {
        toast(error.message);
      }
    },
  };

  const inputActions = {
    'chat-draft': (target) => {
      chat.drafts.set(chat.open.id, target.value);
      autosize(target);
    },
  };

  // Enter sends, Shift+Enter adds a line.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || !event.target.matches('.chat-compose textarea')) return;
    event.preventDefault();
    send(event.target.form);
  });

  return {
    load,
    ready: (r) => r.view !== 'chat' || Boolean(chat.list),
    view,
    sidebarLinks,
    afterRender,
    clickActions,
    formActions,
    inputActions,
  };
}
