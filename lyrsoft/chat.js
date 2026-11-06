// Lyrsoft Work messages (#/chat, #/chat/<conversation>), plugged into app.js like mail.js.
// Conversations are groups (any people you work with, with a name), direct messages with one person,
// and each workspace's team channel. The conversation itself (messages, replies, reactions, photos and
// files, typing, seen) is a ConversationView (conversation.js), shared with the chat panel in calls.
// The list and the sidebar badge poll for unread conversations; nothing re-renders while you type.
import { ConversationView } from './conversation.js';
import { pickPeople as sharedPickPeople } from './people.js';

const POLL_LIST_MS = 8000;
const POLL_BADGE_MS = 30000;

export function createChat({ api, esc, toast, render, go, initial, formatDateTime, getMe }) {
  const chat = {
    list: null, // GET /chat: { groups, dms, channels, contacts, unreadCount }
    unreadCount: 0,
  };
  const views = new Map(); // conversation id -> ConversationView (kept, so drafts and scroll survive)
  let route = null;
  let listTimer = null;
  let badgeTimer = null;

  const allConversations = () => [...(chat.list?.groups || []), ...(chat.list?.dms || []), ...(chat.list?.channels || [])];
  const findConversation = (id) => allConversations().find((c) => c.id === id);
  const timeOf = (iso) => {
    const date = new Date(iso);
    return date.toDateString() === new Date().toDateString()
      ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
      : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };
  const activeNow = (iso) => iso && Date.now() - Date.parse(iso) < 2 * 60000;

  // The view for a conversation, made once and reused (by the Messages page and call panels).
  function viewFor(id) {
    if (!views.has(id)) {
      views.set(id, new ConversationView({
        id,
        api,
        esc,
        toast,
        initial,
        getMe,
        onUpdate: (view) => {
          // Keep the header's "Active now" and the list's snippet in step with the open conversation.
          for (const node of document.querySelectorAll(`[data-cv-active="${CSS.escape(id)}"]`)) node.textContent = view.activeText() || node.dataset.fallback || '';
          const listed = findConversation(id);
          const last = view.messages.at(-1);
          if (listed && last && last.createdAt !== listed.lastMessageAt) {
            Object.assign(listed, { lastMessageAt: last.createdAt, lastSnippet: last.deleted ? 'Message unsent' : last.body || (last.attachments.length ? '📎 File' : ''), unread: false });
            patchList();
          }
        },
      }));
    }
    return views.get(id);
  }

  async function loadList() {
    chat.list = await api('GET', '/chat');
    chat.unreadCount = chat.list.unreadCount;
  }

  async function load(next) {
    const previous = route;
    route = next;
    // Leaving a conversation stops its polling (unless a call panel is showing it).
    if (previous?.view === 'chat' && previous.conv && previous.conv !== next.conv) {
      const old = views.get(previous.conv);
      if (old && !old.el?.closest('#call-root')) old.unmount();
    }
    if (next.view !== 'chat') {
      clearInterval(listTimer);
      listTimer = null;
      return;
    }
    await loadList();
    const id = next.conv || allConversations()[0]?.id;
    // On wide screens open the newest conversation; on phones show the list first.
    if (!next.conv && id && window.matchMedia('(min-width: 861px)').matches) return go(`#/chat/${encodeURIComponent(id)}`);
    if (next.conv) {
      const listed = findConversation(next.conv);
      if (listed?.unread) {
        listed.unread = false;
        chat.unreadCount = Math.max(0, chat.unreadCount - 1);
      }
    }
    if (!listTimer) listTimer = setInterval(pollList, POLL_LIST_MS);
  }

  async function pollList() {
    if (route?.view !== 'chat' || document.hidden) return;
    try {
      const list = await api('GET', '/chat');
      const key = (l) => JSON.stringify([...l.groups, ...l.dms, ...l.channels].map((c) => [c.id, c.lastMessageAt, c.unread && c.id !== route.conv, c.title, activeNow(c.activeAt)]));
      const changed = !chat.list || key(list) !== key(chat.list);
      for (const c of [...list.groups, ...list.dms, ...list.channels]) if (c.id === route.conv) c.unread = false;
      chat.list = list;
      chat.unreadCount = [...list.groups, ...list.dms, ...list.channels].filter((c) => c.unread).length;
      if (changed) patchList();
      updateBadge();
    } catch {}
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
        <a href="#/contacts"${current.view === 'contacts' ? ' aria-current="page"' : ''}><span class="nav-icon" aria-hidden="true">📇</span>Contacts</a>
      </nav>`;
  }

  const iconOf = (c) => (c?.type === 'ws' ? '#' : c?.type === 'group' ? '👥' : initial(c?.title));
  const convLink = (c) => `
    <a class="chat-conv${c.unread ? ' unread' : ''}" href="#/chat/${encodeURIComponent(c.id)}"${route?.conv === c.id ? ' aria-current="page"' : ''}>
      <span class="chat-conv-icon${c.type === 'group' ? ' group' : ''}" aria-hidden="true">${iconOf(c)}${c.type === 'dm' && activeNow(c.activeAt) ? '<i class="online" title="Active now"></i>' : ''}</span>
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

  function subtitle(current) {
    if (current?.type === 'ws') return 'Everyone in this workspace';
    if (current?.type === 'group') {
      const names = (current.members || []).map((e) => (e === getMe().email ? 'You' : (chat.list.contacts.find((c) => c.email === e)?.name || e)));
      return `${names.length} people: ${names.slice(0, 6).join(', ')}${names.length > 6 ? ` +${names.length - 6}` : ''}`;
    }
    return current?.with || '';
  }

  // The shared people picker (people.js), over everyone I can message.
  const pickPeople = (options) => sharedPickPeople({ contacts: chat.list?.contacts || [], ...options });

  function view() {
    const contacts = chat.list.contacts || [];
    const current = route.conv && findConversation(route.conv);
    const sub = route.conv ? subtitle(current) : '';
    return `
      <div class="page-head"><div><h1>Messages</h1><p>Groups, direct messages and team channels. Photos, files, reactions and replies.</p></div></div>
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
              : `
            <header class="chat-head">
              <a class="btn ghost small back-to-list" href="#/chat">←</a>
              <span class="chat-conv-icon${current?.type === 'group' ? ' group' : ''}" aria-hidden="true">${iconOf(current)}</span>
              <div><h2>${esc(current?.title || 'Conversation')}</h2><small class="muted" data-cv-active="${esc(route.conv)}" data-fallback="${esc(sub)}">${esc(sub)}</small></div>
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
            <div class="chat-cv-host"></div>`
          }
        </section>
      </div>`;
  }

  // The app re-draws the page; put the open conversation (with its state) back into it.
  function afterRender() {
    if (route?.view !== 'chat' || !route.conv) return;
    const host = document.querySelector('.chat-cv-host');
    if (!host) return;
    const view = viewFor(route.conv);
    // Focus the composer on computers; on phones that would pop the keyboard up over the messages.
    view.mount(host).then(() => window.matchMedia('(pointer: fine)').matches && view.focus()).catch((error) => {
      host.innerHTML = `<p class="empty-list">${esc(error.message)}</p>`;
    });
  }

  // Reloads the conversation list and the open conversation (after a group changes).
  async function refresh(id) {
    await loadList();
    if (id) await viewFor(id).load();
    render();
  }

  const clickActions = {
    'chat-new-dm': async () => {
      const picked = await pickPeople({ title: 'New message', multiple: false, submitLabel: 'Message' });
      if (!picked) return;
      try {
        const { id } = await api('POST', '/chat/dm', { email: picked.emails[0] });
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
        toast('Group created');
        go(`#/chat/${encodeURIComponent(id)}`);
      } catch (error) {
        toast(error.message);
      }
    },
    'chat-group-add': async () => {
      const id = route.conv;
      const picked = await pickPeople({ title: 'Add people to the group', multiple: true, submitLabel: 'Add', exclude: viewFor(id).conversation?.members || [] });
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
      const id = route.conv;
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
      const id = route.conv;
      const current = findConversation(id);
      if (!confirm(`Leave “${current?.title}”? You won’t see its messages unless someone adds you back.`)) return;
      try {
        await api('POST', `/chat/${encodeURIComponent(id)}/leave`);
        views.get(id)?.unmount();
        views.delete(id);
        await loadList();
        toast('You left the group');
        go('#/chat');
      } catch (error) {
        toast(error.message);
      }
    },
    'chat-call': async () => {
      const current = findConversation(route.conv);
      try {
        const { meeting } = await api('POST', '/meetings', {
          title: current?.type === 'ws' ? `${current.title} team call` : current?.type === 'group' ? `${current.title} call` : `Call with ${getMe().name || getMe().email}`,
          conv: route.conv,
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

  return {
    load,
    ready: (r) => r.view !== 'chat' || Boolean(chat.list),
    view,
    sidebarLinks,
    afterRender,
    viewFor,
    clickActions,
    formActions: {},
    inputActions: {},
  };
}
