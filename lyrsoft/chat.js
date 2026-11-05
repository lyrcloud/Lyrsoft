// Lyrsoft Work messages (#/chat, #/chat/<conversation>), plugged into app.js like mail.js.
// Each workspace has a team channel, and people who share a workspace can message each other
// directly. The open conversation polls for new messages every 4 seconds, and the sidebar badge
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

  const allConversations = () => [...(chat.list?.channels || []), ...(chat.list?.dms || [])];
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
        const changed = JSON.stringify(list.channels.concat(list.dms).map((c) => [c.id, c.lastMessageAt, c.unread])) !== JSON.stringify(allConversations().map((c) => [c.id, c.lastMessageAt, c.unread]));
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

  const convLink = (c) => `
    <a class="chat-conv${c.unread ? ' unread' : ''}" href="#/chat/${encodeURIComponent(c.id)}"${chat.open?.id === c.id || route?.conv === c.id ? ' aria-current="page"' : ''}>
      <span class="chat-conv-icon" aria-hidden="true">${c.type === 'ws' ? '#' : initial(c.title)}</span>
      <span class="chat-conv-text"><b>${esc(c.title)}</b><small>${esc(c.lastSnippet || (c.type === 'ws' ? 'Team channel' : 'Say hello 👋'))}</small></span>
      ${c.lastMessageAt ? `<time>${timeOf(c.lastMessageAt)}</time>` : ''}
    </a>`;

  function listItemsHtml() {
    const { channels = [], dms = [] } = chat.list || {};
    return `
      <p class="chat-section">Team channels</p>
      ${channels.map(convLink).join('') || '<p class="muted small chat-none">Join a workspace to get its channel.</p>'}
      <p class="chat-section">Direct messages</p>
      ${dms.map(convLink).join('') || '<p class="muted small chat-none">No direct messages yet.</p>'}`;
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

  function view() {
    const list = chat.list;
    const open = chat.open;
    const current = open && findConversation(open.id);
    const contacts = list.contacts || [];
    return `
      <div class="page-head"><div><h1>Messages</h1><p>Team channels for each workspace, and direct messages with the people you work with.</p></div></div>
      <div class="chat-layout${route.conv ? ' has-conv' : ''}">
        <aside class="chat-list" aria-label="Conversations">
          <form class="chat-new" data-form="chat-new-dm">
            <select name="email" aria-label="Message someone" required>
              <option value="">✎ New message to…</option>
              ${contacts.map((c) => `<option value="${esc(c.email)}">${esc(c.name ? `${c.name} (${c.email})` : c.email)}</option>`).join('')}
            </select>
            <button class="btn small primary" type="submit">Open</button>
          </form>
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
              <span class="chat-conv-icon" aria-hidden="true">${current?.type === 'ws' ? '#' : initial(current?.title)}</span>
              <div><h2>${esc(current?.title || open.conversation.title || 'Conversation')}</h2><small class="muted">${current?.type === 'ws' ? 'Everyone in this workspace' : esc(current?.with || '')}</small></div>
              <button class="btn small" data-click="chat-call" title="Start a video call with everyone here">📹 Start call</button>
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
    'chat-new-dm': async (form, data) => {
      const email = data.get('email');
      if (!email) return;
      try {
        const { id } = await api('POST', '/chat/dm', { email });
        chat.focusComposer = true;
        go(`#/chat/${encodeURIComponent(id)}`);
      } catch (error) {
        toast(error.message);
      }
    },
  };

  const clickActions = {
    'chat-call': async () => {
      const current = findConversation(chat.open.id);
      try {
        const { meeting } = await api('POST', '/meetings', {
          title: current?.type === 'ws' ? `${current.title} team call` : `Call with ${getMe().name || getMe().email}`,
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
