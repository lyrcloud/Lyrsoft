// Lyrsoft Work — workspaces, boards and items for teams and their clients.
// A dependency-free, hash-routed app on top of the Lyrsoft work API (api/work/), signed in
// through the shared Lyrcloud Cognito user pool (src/auth.js).
import { authFetch, getTokens, logout, redirectToLogin } from './auth.js';
import { WORK_API_BASE } from './config.js';
import { createMail } from './mail.js';

const app = document.getElementById('app');
const SIGN_IN_RETRY_KEY = 'lyrsoft.signin.retry_at';

// ------------------------------------------------------------------ helpers

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const uid = () => Math.random().toString(36).slice(2, 10);
const ROLE_LABELS = { owner: 'Owner', admin: 'Admin', member: 'Member', superadmin: 'Super admin' };
const COLORS = ['#579bfc', '#00c875', '#fdab3d', '#e2445c', '#a25ddc', '#ff642e', '#037f4c', '#c4c4c4', '#ff5ac4', '#66ccff', '#784bd1'];
const COLUMN_TYPES = { status: 'Status', person: 'Person', date: 'Date', text: 'Text', number: 'Number' };
const formatDateTime = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const formatDay = (day) => (day ? new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');
const initial = (text) => esc(String(text || '?').trim()[0]?.toUpperCase() || '?');

function toast(message) {
  const node = document.createElement('div');
  node.className = 'toast';
  node.setAttribute('role', 'status');
  node.textContent = message;
  document.body.append(node);
  setTimeout(() => node.remove(), 3200);
}

async function api(method, path, body) {
  let response;
  try {
    response = await authFetch(
      path,
      { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined },
      WORK_API_BASE,
    );
  } catch (error) {
    if (error.message === 'not_authenticated') {
      redirectToLogin(location.pathname + location.hash, 'google');
      await new Promise(() => {});
    }
    throw new Error('Can’t reach Lyrsoft. Check your connection and try again.');
  }
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    // Send the visitor to sign in again, but only once a minute: if the API still refuses a fresh
    // sign-in, show the error instead of bouncing between the app and Google forever.
    const last = Number(sessionStorage.getItem(SIGN_IN_RETRY_KEY) || 0);
    if (Date.now() - last > 60_000) {
      sessionStorage.setItem(SIGN_IN_RETRY_KEY, String(Date.now()));
      redirectToLogin(location.pathname + location.hash, 'google');
      await new Promise(() => {});
    }
    throw new Error(`Couldn’t sign you in to Lyrsoft: ${data.error || data.message || 'unauthorized'}. Please try again in a minute.`);
  }
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

// ------------------------------------------------------------------ state

const state = {
  me: null,
  ws: null, // { workspace, members, boards }
  board: null,
  items: [],
  updates: null, // comments of the open item
  error: '',
  collapsed: new Set(),
  filter: '',
};

const canManage = () => ['owner', 'admin'].includes(state.ws?.workspace.role);
const findItem = (id) => state.items.find((item) => item.id === id);
const column = (id) => state.board.columns.find((col) => col.id === id);
const firstStatusColumn = () => state.board?.columns.find((col) => col.type === 'status');
const wsPath = (path = '') => `/workspaces/${encodeURIComponent(state.ws.workspace.id)}${path}`;
const boardPath = (path = '') => wsPath(`/boards/${encodeURIComponent(state.board.id)}${path}`);

function parseRoute() {
  const [path, query = ''] = location.hash.replace(/^#/, '').split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const params = new URLSearchParams(query);
  if (parts[0] === 'mail') {
    if (parts[1] === 'settings') return { view: 'mailSettings', params };
    return { view: 'mail', mailbox: parts[1]?.toLowerCase() || null, params };
  }
  if (parts[0] === 'w' && parts[1]) {
    if (parts[2] === 'b' && parts[3]) return { view: 'board', ws: parts[1], board: parts[3], params };
    if (parts[2] === 'team') return { view: 'team', ws: parts[1], params };
    return { view: 'workspace', ws: parts[1], params };
  }
  return { view: 'home', params };
}

let route = parseRoute();
const go = (hash) => {
  if (location.hash === hash) load();
  else location.hash = hash;
};
const withParams = (changes) => {
  const params = new URLSearchParams(route.params);
  for (const [key, value] of Object.entries(changes)) {
    if (value == null || value === '') params.delete(key);
    else params.set(key, value);
  }
  const base = location.hash.split('?')[0] || '#/';
  return params.toString() ? `${base}?${params}` : base;
};

const mail = createMail({ api, esc, toast, render: () => render(), go, withParams, initial, formatDateTime, getMe: () => state.me });

// Fetches whatever the current route needs, then renders.
let loadSeq = 0;
async function load() {
  route = parseRoute();
  const seq = ++loadSeq;
  state.error = '';
  try {
    if (!state.me) state.me = await api('GET', '/me');
    if (route.ws && state.ws?.workspace.id !== route.ws) {
      state.ws = null;
      state.board = null;
      render();
      state.ws = await api('GET', `/workspaces/${encodeURIComponent(route.ws)}`);
    }
    if (!route.ws) state.ws = null;
    if (route.view === 'workspace' && state.ws?.boards.length) {
      return go(`#/w/${encodeURIComponent(route.ws)}/b/${encodeURIComponent(state.ws.boards[0].id)}`);
    }
    if (route.view === 'board' && state.board?.id !== route.board) {
      state.board = null;
      render();
      const data = await api('GET', `/workspaces/${encodeURIComponent(route.ws)}/boards/${encodeURIComponent(route.board)}`);
      state.board = data.board;
      state.items = data.items;
      state.filter = '';
    }
    const itemId = route.params.get('item');
    if (itemId && state.updates?.itemId !== itemId && findItem(itemId)) {
      state.updates = { itemId, list: null };
      render();
      const { updates } = await api('GET', boardPath(`/items/${encodeURIComponent(itemId)}/updates`));
      if (state.updates?.itemId === itemId) state.updates.list = updates;
    }
    if (!itemId) state.updates = null;
    await mail.load(route);
  } catch (error) {
    if (seq === loadSeq) state.error = error.message;
  }
  if (seq === loadSeq) render();
}

// ------------------------------------------------------------------ shell

function sidebar() {
  const workspaces = state.me?.workspaces || [];
  const ws = state.ws;
  return `
    <aside class="sidebar">
      <a class="brand" href="#/"><span class="brand-mark" aria-hidden="true">◆</span><span>Lyrsoft <b>Work</b></span></a>
      <label class="ws-picker">
        <span class="nav-label">Workspace</span>
        <select data-change="pick-ws">
          <option value="">All workspaces</option>
          ${workspaces.map((w) => `<option value="${esc(w.id)}"${w.id === route.ws ? ' selected' : ''}>${esc(w.name)}</option>`).join('')}
        </select>
      </label>
      ${
        ws
          ? `<nav aria-label="Boards">
              <p class="nav-label">Boards</p>
              ${ws.boards
                .map((b) => `<a href="#/w/${esc(ws.workspace.id)}/b/${esc(b.id)}"${b.id === route.board ? ' aria-current="page"' : ''}><span class="nav-icon" aria-hidden="true">▦</span>${esc(b.name)}</a>`)
                .join('')}
              <button class="nav-add" data-click="new-board">+ New board</button>
              <p class="nav-label">Workspace</p>
              <a href="#/w/${esc(ws.workspace.id)}/team"${route.view === 'team' ? ' aria-current="page"' : ''}><span class="nav-icon" aria-hidden="true">👥</span>Team &amp; settings</a>
            </nav>`
          : ''
      }
      ${mail.sidebarLinks(route)}
    </aside>`;
}

function topbar() {
  const me = state.me;
  const staff = me && me.globalRole !== 'user' ? `<span class="pill pill-staff">${ROLE_LABELS[me.globalRole]}</span>` : '';
  return `
    <header class="topbar">
      <button class="icon-btn menu-toggle" data-click="toggle-sidebar" aria-label="Toggle navigation">☰</button>
      <span class="crumb">${esc(route.view.startsWith('mail') ? 'Mail' : state.ws?.workspace.name || 'Lyrsoft Work')}</span>
      <div class="topbar-right">
        ${staff}
        ${me ? `<span class="avatar" title="${esc(me.email)}">${initial(me.name || me.email)}</span>` : ''}
        <button class="btn ghost small" data-click="sign-out">Sign out</button>
      </div>
    </header>`;
}

const pageHead = (title, subtitle = '', actions = '') => `
  <div class="page-head">
    <div><h1>${title}</h1>${subtitle ? `<p>${subtitle}</p>` : ''}</div>
    ${actions ? `<div class="page-actions">${actions}</div>` : ''}
  </div>`;

function render() {
  let content;
  if (state.error) {
    content = `<section class="panel empty"><h2>Something went wrong</h2><p>${esc(state.error)}</p><a class="btn primary" href="#/">Go to my workspaces</a></section>`;
  } else if (!state.me || (route.ws && !state.ws) || (route.view === 'board' && !state.board) || (route.view.startsWith('mail') && !mail.ready(route))) {
    content = '<p class="loading">Loading…</p>';
  } else {
    content = route.view.startsWith('mail') ? mail.view(route) : views[route.view]();
  }
  app.innerHTML = `
    ${sidebar()}
    <div class="main">
      ${topbar()}
      <main class="content">${content}</main>
    </div>
    ${route.params.get('item') && state.board ? drawer() : ''}`;
  app.classList.remove('sidebar-open');
  mail.afterRender();
  document.title = `${route.view.startsWith('mail') ? (route.mailbox || 'Mail') : state.board?.name || state.ws?.workspace.name || 'Workspaces'} | Lyrsoft Work`;
}

// ------------------------------------------------------------------ views

const views = {
  home() {
    const workspaces = state.me.workspaces;
    return `
      ${pageHead(`Hi${state.me.name ? `, ${esc(state.me.name.split(' ')[0])}` : ''}`, 'Your workspaces. Each company or client gets its own private workspace.')}
      <div class="ws-grid">
        ${workspaces
          .map(
            (w) => `
          <a class="panel ws-card" href="#/w/${esc(w.id)}">
            <span class="ws-mark" style="background:${COLORS[w.name.length % COLORS.length]}">${initial(w.name)}</span>
            <span><b>${esc(w.name)}</b><small>${w.staffAccess ? 'Staff access' : ROLE_LABELS[w.role] || ''}</small></span>
          </a>`,
          )
          .join('')}
        <form class="panel ws-card new" data-form="new-workspace">
          <label for="new-ws-name"><b>New workspace</b><small>For your team or a client company</small></label>
          <div class="row"><input id="new-ws-name" name="name" required maxlength="80" placeholder="e.g. Lyrtrip operations" /><button class="btn primary" type="submit">Create</button></div>
        </form>
      </div>`;
  },

  workspace() {
    return `
      ${pageHead(esc(state.ws.workspace.name))}
      <section class="panel empty">
        <h2>No boards yet</h2>
        <p>Boards hold your work: projects, client requests, sales pipelines and more.</p>
        <button class="btn primary" data-click="new-board">+ New board</button>
      </section>`;
  },

  team() {
    const { workspace, members } = state.ws;
    const manage = canManage();
    const meEmail = state.me.email;
    const roleCell = (m) => {
      if (!manage || m.role === 'owner' || (m.role === 'admin' && workspace.role !== 'owner')) {
        return `<span class="pill role-${m.role}">${ROLE_LABELS[m.role]}</span>`;
      }
      return `<select data-change="member-role" data-email="${esc(m.email)}" aria-label="Role for ${esc(m.email)}">
        ${['admin', 'member'].map((r) => `<option value="${r}"${r === m.role ? ' selected' : ''}>${ROLE_LABELS[r]}</option>`).join('')}
      </select>`;
    };
    const removeCell = (m) => {
      if (m.role === 'owner') return '';
      if (m.email === meEmail) return '<button class="btn small" data-click="leave-ws">Leave</button>';
      if (!manage || (m.role === 'admin' && workspace.role !== 'owner')) return '';
      return `<button class="btn small danger" data-click="remove-member" data-email="${esc(m.email)}">Remove</button>`;
    };
    return `
      ${pageHead('Team & settings', esc(workspace.name))}
      <section class="panel">
        <div class="panel-head"><h2>Members</h2><span class="muted">${members.length}</span></div>
        ${
          manage
            ? `<form class="invite-form" data-form="invite">
                <input name="email" type="email" required placeholder="name@company.com" aria-label="Email to invite" />
                <select name="role" aria-label="Role"><option value="member">Member</option><option value="admin">Admin</option></select>
                <button class="btn primary" type="submit">Invite</button>
              </form>
              <p class="muted small">People you invite get access the first time they sign in to lyrsoft.com with Google using that email.</p>`
            : ''
        }
        <div class="table-scroll"><table class="list-table">
          <thead><tr><th>Member</th><th>Role</th><th>Status</th><th></th></tr></thead>
          <tbody>${members
            .sort((a, b) => a.email.localeCompare(b.email))
            .map(
              (m) => `
            <tr>
              <td><span class="avatar small">${initial(m.name || m.email)}</span> <b>${esc(m.name || m.email)}</b>${m.name ? `<br><small class="muted">${esc(m.email)}</small>` : ''}</td>
              <td>${roleCell(m)}</td>
              <td>${m.joined ? '<span class="ok">Joined</span>' : '<span class="muted">Invited</span>'}</td>
              <td class="right">${removeCell(m)}</td>
            </tr>`,
            )
            .join('')}</tbody>
        </table></div>
      </section>
      ${
        manage
          ? `<section class="panel">
              <div class="panel-head"><h2>Workspace</h2></div>
              <form class="row" data-form="rename-ws">
                <input name="name" required maxlength="80" value="${esc(workspace.name)}" aria-label="Workspace name" />
                <button class="btn" type="submit">Rename</button>
              </form>
              ${workspace.role === 'owner' ? '<div class="danger-zone"><div><b>Delete workspace</b><p class="muted">Deletes every board, item and comment in it. This can’t be undone.</p></div><button class="btn danger" data-click="delete-ws">Delete workspace</button></div>' : ''}
            </section>`
          : ''
      }`;
  },

  board() {
    const board = state.board;
    const view = route.params.get('view') === 'kanban' ? 'kanban' : 'table';
    return `
      <div class="board-head">
        <input class="board-title" value="${esc(board.name)}" data-change="board-name" aria-label="Board name" maxlength="120" />
        <div class="board-tools">
          <div class="segmented" role="group" aria-label="View">
            <a href="${withParams({ view: null })}"${view === 'table' ? ' aria-current="page"' : ''}>▤ Table</a>
            <a href="${withParams({ view: 'kanban' })}"${view === 'kanban' ? ' aria-current="page"' : ''}>▥ Kanban</a>
          </div>
          <input type="search" class="search" placeholder="Search items" value="${esc(state.filter)}" data-input="filter" aria-label="Search items" />
          <button class="btn primary" data-click="new-item">+ New item</button>
          <button class="icon-btn" data-click="board-menu" aria-label="Board options">⋯</button>
        </div>
      </div>
      ${view === 'kanban' ? kanban() : table()}
      <datalist id="member-emails">${state.ws.members.map((m) => `<option value="${esc(m.email)}">${esc(m.name)}</option>`).join('')}</datalist>`;
  },
};

// ------------------------------------------------------------------ board: cells

function cell(col, item) {
  const value = item.values[col.id];
  const data = `data-item="${esc(item.id)}" data-col="${esc(col.id)}"`;
  switch (col.type) {
    case 'status': {
      const label = col.labels.find((l) => l.id === value);
      return `<button class="status-cell${label ? '' : ' empty'}" style="--status:${label ? label.color : 'transparent'}" data-click="status-menu" ${data} aria-label="${esc(col.title)}: ${label ? esc(label.label) : 'not set'}">${label ? esc(label.label) : ''}</button>`;
    }
    case 'person':
      return `<input class="cell-input" type="email" list="member-emails" value="${esc(value || '')}" placeholder="Assign" data-change="cell" ${data} aria-label="${esc(col.title)}" />`;
    case 'date':
      return `<input class="cell-input" type="date" value="${esc(value || '')}" data-change="cell" ${data} aria-label="${esc(col.title)}" />`;
    case 'number':
      return `<input class="cell-input num" type="number" step="any" value="${esc(value ?? '')}" data-change="cell" ${data} aria-label="${esc(col.title)}" />`;
    default:
      return `<input class="cell-input" value="${esc(value || '')}" data-change="cell" ${data} aria-label="${esc(col.title)}" />`;
  }
}

const matchesFilter = (item) => {
  const q = state.filter.trim().toLowerCase();
  if (!q) return true;
  return [item.name, ...Object.values(item.values)].some((v) => String(v).toLowerCase().includes(q));
};

function table() {
  const board = state.board;
  const cols = board.columns;
  return board.groups
    .map((group) => {
      const items = state.items.filter((item) => item.groupId === group.id && matchesFilter(item));
      const collapsed = state.collapsed.has(group.id);
      return `
      <section class="group" style="--group:${group.color}">
        <div class="group-head">
          <button class="icon-btn" data-click="toggle-group" data-group="${esc(group.id)}" aria-expanded="${!collapsed}" aria-label="Collapse group">${collapsed ? '▸' : '▾'}</button>
          <input class="group-title" value="${esc(group.title)}" data-change="group-title" data-group="${esc(group.id)}" aria-label="Group name" maxlength="80" />
          <span class="muted small">${items.length} item${items.length === 1 ? '' : 's'}</span>
          <button class="icon-btn" data-click="group-menu" data-group="${esc(group.id)}" aria-label="Group options">⋯</button>
        </div>
        ${
          collapsed
            ? ''
            : `<div class="table-scroll"><table class="board-table">
              <thead><tr>
                <th class="name-col">Item</th>
                ${cols.map((col) => `<th class="type-${col.type}"><button class="col-head" data-click="column-menu" data-col="${esc(col.id)}">${esc(col.title)}</button></th>`).join('')}
                <th class="add-col"><button class="icon-btn" data-click="add-column" aria-label="Add column">+</button></th>
              </tr></thead>
              <tbody>
                ${items
                  .map(
                    (item) => `
                  <tr>
                    <td class="name-col"><div class="name-wrap">
                      <input class="cell-input name" value="${esc(item.name)}" data-change="item-name" data-item="${esc(item.id)}" aria-label="Item name" maxlength="200" />
                      <a class="open-item" href="${withParams({ item: item.id })}" title="Open item">${item.updateCount ? `💬 ${item.updateCount}` : '↗'}</a>
                    </div></td>
                    ${cols.map((col) => `<td class="type-${col.type}">${cell(col, item)}</td>`).join('')}
                    <td></td>
                  </tr>`,
                  )
                  .join('')}
                <tr class="add-row"><td class="name-col" colspan="${cols.length + 2}">
                  <form data-form="add-item" data-group="${esc(group.id)}"><input name="name" placeholder="+ Add item" aria-label="New item in ${esc(group.title)}" maxlength="200" /></form>
                </td></tr>
              </tbody>
            </table></div>`
        }
      </section>`;
    })
    .join('') + '<button class="btn ghost add-group" data-click="add-group">+ Add group</button>';
}

function kanban() {
  const statusCol = column(route.params.get('by')) || firstStatusColumn();
  if (!statusCol || statusCol.type !== 'status') {
    return '<section class="panel empty"><h2>Add a status column</h2><p>Kanban lanes come from a status column.</p><button class="btn primary" data-click="add-column">+ Add column</button></section>';
  }
  const statusCols = state.board.columns.filter((col) => col.type === 'status');
  const lanes = [...statusCol.labels, { id: '', label: 'No status', color: '#c4c4c4' }];
  const person = state.board.columns.find((col) => col.type === 'person');
  const due = state.board.columns.find((col) => col.type === 'date');
  const items = state.items.filter(matchesFilter);
  return `
    ${statusCols.length > 1 ? `<label class="lane-by">Lanes by <select data-change="kanban-by">${statusCols.map((col) => `<option value="${esc(col.id)}"${col.id === statusCol.id ? ' selected' : ''}>${esc(col.title)}</option>`).join('')}</select></label>` : ''}
    <div class="kanban">
      ${lanes
        .map((lane) => {
          const laneItems = items.filter((item) => (item.values[statusCol.id] || '') === lane.id);
          return `
        <section class="lane" data-lane="${esc(lane.id)}" data-col="${esc(statusCol.id)}" style="--status:${lane.color}">
          <h2>${esc(lane.label)} <span>${laneItems.length}</span></h2>
          <div class="lane-cards">
            ${laneItems
              .map(
                (item) => `
              <a class="card" draggable="true" data-item="${esc(item.id)}" href="${withParams({ item: item.id })}">
                <b>${esc(item.name)}</b>
                <span class="card-meta">
                  ${person && item.values[person.id] ? `<span class="avatar small" title="${esc(item.values[person.id])}">${initial(item.values[person.id])}</span>` : ''}
                  ${due && item.values[due.id] ? `<span>📅 ${formatDay(item.values[due.id])}</span>` : ''}
                  ${item.updateCount ? `<span>💬 ${item.updateCount}</span>` : ''}
                </span>
              </a>`,
              )
              .join('')}
          </div>
        </section>`;
        })
        .join('')}
    </div>`;
}

function drawer() {
  const item = findItem(route.params.get('item'));
  if (!item) return '';
  const updates = state.updates?.itemId === item.id ? state.updates.list : null;
  return `
    <div class="drawer-backdrop" data-click="close-item"></div>
    <aside class="drawer" aria-label="Item details">
      <div class="drawer-head">
        <input class="drawer-title" value="${esc(item.name)}" data-change="item-name" data-item="${esc(item.id)}" aria-label="Item name" maxlength="200" />
        <button class="icon-btn" data-click="close-item" aria-label="Close">✕</button>
      </div>
      <dl class="fields">
        <dt>Group</dt>
        <dd><select data-change="item-group" data-item="${esc(item.id)}">${state.board.groups.map((g) => `<option value="${esc(g.id)}"${g.id === item.groupId ? ' selected' : ''}>${esc(g.title)}</option>`).join('')}</select></dd>
        ${state.board.columns.map((col) => `<dt>${esc(col.title)}</dt><dd class="type-${col.type}">${cell(col, item)}</dd>`).join('')}
      </dl>
      <p class="muted small">Updated ${formatDateTime(item.updatedAt)}${item.updatedBy ? ` by ${esc(item.updatedBy)}` : ''}</p>
      <h3>Updates</h3>
      <form class="update-form" data-form="post-update" data-item="${esc(item.id)}">
        <textarea name="body" rows="3" placeholder="Write an update or ask a question…" required maxlength="5000"></textarea>
        <button class="btn primary" type="submit">Post update</button>
      </form>
      ${
        updates === null
          ? '<p class="muted">Loading updates…</p>'
          : updates.length
            ? `<ol class="updates">${updates
                .map((u) => `<li><div class="update-meta"><span class="avatar small">${initial(u.authorName || u.authorEmail)}</span><b>${esc(u.authorName || u.authorEmail)}</b><time>${formatDateTime(u.createdAt)}</time></div><p>${esc(u.body)}</p></li>`)
                .join('')}</ol>`
            : '<p class="muted">No updates yet.</p>'
      }
      <button class="btn danger small" data-click="delete-item" data-item="${esc(item.id)}">Delete item</button>
    </aside>`;
}

// ------------------------------------------------------------------ popover menus and dialogs

function closeMenu() {
  document.querySelector('.menu')?.remove();
}

// Shows a small menu next to `anchor`. options: [{ label, color?, danger?, onSelect }]
function openMenu(anchor, options) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = options
    .map((option, index) => `<button role="menuitem" data-index="${index}" class="${option.danger ? 'danger' : ''}" ${option.color ? `style="--status:${option.color}"` : ''}>${option.color ? '<span class="swatch"></span>' : ''}${esc(option.label)}</button>`)
    .join('');
  document.body.append(menu);
  const rect = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  menu.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - menu.offsetHeight - 8) + window.scrollY}px`;
  menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) + window.scrollX}px`;
  menu.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-index]');
    if (!button) return;
    closeMenu();
    options[Number(button.dataset.index)].onSelect();
  });
  menu.querySelector('button')?.focus();
}

// A modal form. fields: [{ name, label, type?: 'text'|'select', options?, value? }]. Resolves to values or null.
function dialog(title, fields, submitLabel = 'Save', extra = '') {
  return new Promise((resolve) => {
    const node = document.createElement('dialog');
    node.className = 'dialog';
    node.innerHTML = `
      <form method="dialog">
        <h2>${esc(title)}</h2>
        ${fields
          .map((f) =>
            f.type === 'select'
              ? `<label>${esc(f.label)}<select name="${f.name}">${f.options.map(([value, label]) => `<option value="${esc(value)}"${value === f.value ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select></label>`
              : `<label>${esc(f.label)}<input name="${f.name}" value="${esc(f.value || '')}" required maxlength="${f.maxlength || 80}" /></label>`,
          )
          .join('')}
        ${extra}
        <div class="row end"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok">${esc(submitLabel)}</button></div>
      </form>`;
    document.body.append(node);
    node.addEventListener('close', () => {
      const values = node.returnValue === 'ok' ? Object.fromEntries(new FormData(node.querySelector('form'))) : null;
      node.remove();
      resolve(values);
    });
    node.showModal();
  });
}

// Status labels editor: one row per label (name + color).
async function editLabels(col) {
  const rows = (labels) =>
    labels
      .map(
        (l, i) => `<div class="label-row"><input name="label-${i}" value="${esc(l.label)}" maxlength="40" aria-label="Label ${i + 1}" />
          <select name="color-${i}" aria-label="Color ${i + 1}">${COLORS.map((c) => `<option value="${c}"${c === l.color ? ' selected' : ''} style="background:${c}">${c}</option>`).join('')}</select>
          <input type="hidden" name="id-${i}" value="${esc(l.id)}" /></div>`,
      )
      .join('');
  const labels = [...col.labels, { id: uid(), label: '', color: COLORS[col.labels.length % COLORS.length] }];
  const values = await dialog(`Labels for “${col.title}”`, [], 'Save labels', `<p class="muted small">Clear a name to remove that label. Fill the last row to add one.</p>${rows(labels)}`);
  if (!values) return;
  const next = labels.map((l, i) => ({ id: values[`id-${i}`], label: String(values[`label-${i}`] || '').trim(), color: values[`color-${i}`] })).filter((l) => l.label);
  if (!next.length) return toast('A status column needs at least one label.');
  await saveBoard({ columns: state.board.columns.map((c) => (c.id === col.id ? { ...c, labels: next } : c)) }, 'Labels saved');
}

// ------------------------------------------------------------------ mutations

async function saveBoard(changes, message) {
  const previous = state.board;
  state.board = { ...state.board, ...changes };
  render();
  try {
    const { board } = await api('PATCH', boardPath(), changes);
    state.board = board;
    const summary = state.ws.boards.find((b) => b.id === board.id);
    if (summary) summary.name = board.name;
    if (changes.groups) {
      const kept = new Set(board.groups.map((g) => g.id));
      for (const item of state.items) if (!kept.has(item.groupId)) item.groupId = board.groups[0].id;
    }
    render();
    if (message) toast(message);
  } catch (error) {
    state.board = previous;
    render();
    toast(error.message);
  }
}

async function patchItem(itemId, changes, { rerender = true } = {}) {
  const item = findItem(itemId);
  const previous = structuredClone(item);
  if (changes.values) Object.assign(item.values, changes.values);
  if ('name' in changes) item.name = changes.name;
  if ('groupId' in changes) item.groupId = changes.groupId;
  if (rerender) render();
  try {
    const { item: saved } = await api('PATCH', boardPath(`/items/${encodeURIComponent(itemId)}`), changes);
    Object.assign(item, saved);
    if (rerender) render();
  } catch (error) {
    Object.assign(item, previous);
    render();
    toast(error.message);
  }
}

async function createItem(groupId, name) {
  const { item } = await api('POST', boardPath('/items'), { groupId, name });
  state.items.push(item);
  return item;
}

// ------------------------------------------------------------------ event handlers

const clickActions = {
  'toggle-sidebar': () => app.classList.toggle('sidebar-open'),
  'sign-out': () => logout(),
  'close-item': () => go(withParams({ item: null })),
  'toggle-group': (target) => {
    const id = target.dataset.group;
    if (state.collapsed.has(id)) state.collapsed.delete(id);
    else state.collapsed.add(id);
    render();
  },
  'new-board': async () => {
    const values = await dialog('New board', [{ name: 'name', label: 'Board name', maxlength: 120 }], 'Create board');
    if (!values) return;
    try {
      const { board } = await api('POST', wsPath('/boards'), { name: values.name });
      state.ws.boards.push({ id: board.id, name: board.name });
      go(`#/w/${encodeURIComponent(state.ws.workspace.id)}/b/${encodeURIComponent(board.id)}`);
    } catch (error) {
      toast(error.message);
    }
  },
  'new-item': async () => {
    try {
      const item = await createItem(state.board.groups[0].id, 'New item');
      go(withParams({ item: item.id }));
    } catch (error) {
      toast(error.message);
    }
  },
  'board-menu': (target) =>
    openMenu(target, [
      { label: 'Add group', onSelect: () => clickActions['add-group']() },
      { label: 'Add column', onSelect: () => clickActions['add-column']() },
      {
        label: 'Delete board',
        danger: true,
        onSelect: async () => {
          if (!confirm(`Delete “${state.board.name}” and all of its items?`)) return;
          try {
            await api('DELETE', boardPath());
            state.ws.boards = state.ws.boards.filter((b) => b.id !== state.board.id);
            state.board = null;
            toast('Board deleted');
            go(`#/w/${encodeURIComponent(state.ws.workspace.id)}`);
          } catch (error) {
            toast(error.message);
          }
        },
      },
    ]),
  'add-group': async () => {
    const values = await dialog('New group', [{ name: 'title', label: 'Group name' }], 'Add group');
    if (!values) return;
    const color = COLORS[state.board.groups.length % COLORS.length];
    await saveBoard({ groups: [...state.board.groups, { id: uid(), title: values.title, color }] }, 'Group added');
  },
  'group-menu': (target) => {
    const group = state.board.groups.find((g) => g.id === target.dataset.group);
    openMenu(target, [
      ...COLORS.slice(0, 8).map((color) => ({
        label: 'Color',
        color,
        onSelect: () => saveBoard({ groups: state.board.groups.map((g) => (g.id === group.id ? { ...g, color } : g)) }),
      })),
      {
        label: 'Delete group',
        danger: true,
        onSelect: () => {
          if (state.board.groups.length === 1) return toast('A board needs at least one group.');
          if (!confirm(`Delete “${group.title}”? Its items move to the first remaining group.`)) return;
          saveBoard({ groups: state.board.groups.filter((g) => g.id !== group.id) }, 'Group deleted');
        },
      },
    ]);
  },
  'add-column': async () => {
    const values = await dialog('New column', [
      { name: 'title', label: 'Column name', maxlength: 60 },
      { name: 'type', label: 'Type', type: 'select', options: Object.entries(COLUMN_TYPES), value: 'text' },
    ], 'Add column');
    if (!values) return;
    const col = { id: uid(), title: values.title, type: values.type };
    if (col.type === 'status') col.labels = [{ id: uid(), label: 'Done', color: '#00c875' }, { id: uid(), label: 'Working on it', color: '#fdab3d' }, { id: uid(), label: 'Stuck', color: '#e2445c' }];
    await saveBoard({ columns: [...state.board.columns, col] }, 'Column added');
  },
  'column-menu': (target) => {
    const col = column(target.dataset.col);
    const index = state.board.columns.indexOf(col);
    const move = (delta) => {
      const columns = [...state.board.columns];
      columns.splice(index, 1);
      columns.splice(index + delta, 0, col);
      saveBoard({ columns });
    };
    openMenu(target, [
      {
        label: 'Rename',
        onSelect: async () => {
          const values = await dialog('Rename column', [{ name: 'title', label: 'Column name', value: col.title, maxlength: 60 }]);
          if (values) saveBoard({ columns: state.board.columns.map((c) => (c.id === col.id ? { ...c, title: values.title } : c)) });
        },
      },
      ...(col.type === 'status' ? [{ label: 'Edit labels', onSelect: () => editLabels(col) }] : []),
      ...(index > 0 ? [{ label: 'Move left', onSelect: () => move(-1) }] : []),
      ...(index < state.board.columns.length - 1 ? [{ label: 'Move right', onSelect: () => move(1) }] : []),
      {
        label: 'Delete column',
        danger: true,
        onSelect: () => {
          if (!confirm(`Delete the “${col.title}” column? Its values are hidden from every item.`)) return;
          saveBoard({ columns: state.board.columns.filter((c) => c.id !== col.id) }, 'Column deleted');
        },
      },
    ]);
  },
  'status-menu': (target) => {
    const col = column(target.dataset.col);
    const itemId = target.dataset.item;
    openMenu(target, [
      ...col.labels.map((l) => ({ label: l.label, color: l.color, onSelect: () => patchItem(itemId, { values: { [col.id]: l.id } }) })),
      { label: 'Clear', onSelect: () => patchItem(itemId, { values: { [col.id]: null } }) },
      { label: 'Edit labels…', onSelect: () => editLabels(col) },
    ]);
  },
  'delete-item': async (target) => {
    const item = findItem(target.dataset.item);
    if (!confirm(`Delete “${item.name}” and its updates?`)) return;
    try {
      await api('DELETE', boardPath(`/items/${encodeURIComponent(item.id)}`));
      state.items = state.items.filter((i) => i.id !== item.id);
      toast('Item deleted');
      go(withParams({ item: null }));
    } catch (error) {
      toast(error.message);
    }
  },
  'remove-member': async (target) => {
    const email = target.dataset.email;
    if (!confirm(`Remove ${email} from ${state.ws.workspace.name}?`)) return;
    try {
      await api('DELETE', wsPath(`/members/${encodeURIComponent(email)}`));
      state.ws.members = state.ws.members.filter((m) => m.email !== email);
      render();
      toast(`${email} removed`);
    } catch (error) {
      toast(error.message);
    }
  },
  'leave-ws': async () => {
    if (!confirm(`Leave ${state.ws.workspace.name}? You’ll need a new invite to come back.`)) return;
    try {
      await api('DELETE', wsPath(`/members/${encodeURIComponent(state.me.email)}`));
      state.me = null;
      go('#/');
    } catch (error) {
      toast(error.message);
    }
  },
  'delete-ws': async () => {
    const name = state.ws.workspace.name;
    if (prompt(`This deletes every board and item in “${name}”. Type the workspace name to confirm.`) !== name) return;
    try {
      await api('DELETE', wsPath());
      state.me = null;
      state.ws = null;
      toast('Workspace deleted');
      go('#/');
    } catch (error) {
      toast(error.message);
    }
  },
};

const changeActions = {
  'pick-ws': (target) => go(target.value ? `#/w/${encodeURIComponent(target.value)}` : '#/'),
  'kanban-by': (target) => go(withParams({ by: target.value })),
  'board-name': (target) => {
    const name = target.value.trim();
    if (!name) return render();
    saveBoard({ name });
  },
  'group-title': (target) => {
    const title = target.value.trim();
    if (!title) return render();
    saveBoard({ groups: state.board.groups.map((g) => (g.id === target.dataset.group ? { ...g, title } : g)) });
  },
  'item-name': (target) => {
    const name = target.value.trim();
    if (!name) return render();
    patchItem(target.dataset.item, { name }, { rerender: false });
  },
  'item-group': (target) => patchItem(target.dataset.item, { groupId: target.value }),
  cell: (target) => {
    const col = column(target.dataset.col);
    let value = target.value.trim();
    if (col.type === 'number') value = value === '' ? null : Number(value);
    patchItem(target.dataset.item, { values: { [col.id]: value === '' ? null : value } }, { rerender: false });
  },
  'member-role': async (target) => {
    try {
      const { member } = await api('PATCH', wsPath(`/members/${encodeURIComponent(target.dataset.email)}`), { role: target.value });
      state.ws.members = state.ws.members.map((m) => (m.email === member.email ? member : m));
      toast(`${member.email} is now ${ROLE_LABELS[member.role].toLowerCase()}`);
    } catch (error) {
      toast(error.message);
    }
    render();
  },
};

const formActions = {
  'new-workspace': async (form, data) => {
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      const { workspace, firstBoardId } = await api('POST', '/workspaces', { name: data.get('name') });
      state.me.workspaces.push({ id: workspace.id, name: workspace.name, role: 'owner' });
      go(`#/w/${encodeURIComponent(workspace.id)}/b/${encodeURIComponent(firstBoardId)}`);
    } catch (error) {
      button.disabled = false;
      toast(error.message);
    }
  },
  'add-item': async (form, data) => {
    const name = String(data.get('name')).trim();
    if (!name) return;
    form.querySelector('input').disabled = true;
    try {
      await createItem(form.dataset.group, name);
      render();
      document.querySelector(`form[data-form="add-item"][data-group="${CSS.escape(form.dataset.group)}"] input`)?.focus();
    } catch (error) {
      form.querySelector('input').disabled = false;
      toast(error.message);
    }
  },
  invite: async (form, data) => {
    try {
      const { member } = await api('POST', wsPath('/members'), { email: data.get('email'), role: data.get('role') });
      state.ws.members.push(member);
      render();
      toast(`Invited ${member.email}`);
    } catch (error) {
      toast(error.message);
    }
  },
  'rename-ws': async (form, data) => {
    try {
      const { workspace } = await api('PATCH', wsPath(), { name: data.get('name') });
      state.ws.workspace = workspace;
      const entry = state.me.workspaces.find((w) => w.id === workspace.id);
      if (entry) entry.name = workspace.name;
      render();
      toast('Workspace renamed');
    } catch (error) {
      toast(error.message);
    }
  },
  'post-update': async (form, data) => {
    const item = findItem(form.dataset.item);
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      const { update } = await api('POST', boardPath(`/items/${encodeURIComponent(item.id)}/updates`), { body: data.get('body') });
      if (state.updates?.itemId === item.id) state.updates.list = [update, ...(state.updates.list || [])];
      item.updateCount = (item.updateCount || 0) + 1;
      render();
    } catch (error) {
      button.disabled = false;
      toast(error.message);
    }
  },
};

Object.assign(clickActions, mail.clickActions);
Object.assign(formActions, mail.formActions);

app.addEventListener('click', (event) => {
  const target = event.target.closest('[data-click]');
  if (target) clickActions[target.dataset.click]?.(target);
});
app.addEventListener('change', (event) => {
  const target = event.target.closest('[data-change]');
  if (target) changeActions[target.dataset.change]?.(target);
});
app.addEventListener('input', (event) => {
  if (event.target.dataset.input !== 'filter') return;
  state.filter = event.target.value;
  const { selectionStart } = event.target;
  render();
  const search = document.querySelector('.search');
  search.focus();
  search.setSelectionRange(selectionStart, selectionStart);
});
app.addEventListener('submit', (event) => {
  const form = event.target.closest('[data-form]');
  if (!form) return;
  event.preventDefault();
  formActions[form.dataset.form]?.(form, new FormData(form));
});
// Enter in an inline cell commits it (by blurring, which fires "change").
app.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && event.target.matches('.cell-input, .board-title, .group-title, .drawer-title')) event.target.blur();
});
document.addEventListener('click', (event) => {
  if (!event.target.closest('.menu, [data-click$="-menu"]')) closeMenu();
});
// Escape closes an open menu first, then the item panel.
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || document.querySelector('dialog[open]')) return;
  if (document.querySelector('.menu')) closeMenu();
  else if (route.params.get('item')) go(withParams({ item: null }));
});

// Kanban drag and drop between lanes.
app.addEventListener('dragstart', (event) => {
  const card = event.target.closest('.card');
  if (!card) return;
  event.dataTransfer.setData('text/plain', card.dataset.item);
  event.dataTransfer.effectAllowed = 'move';
});
app.addEventListener('dragover', (event) => {
  const lane = event.target.closest('.lane');
  if (!lane) return;
  event.preventDefault();
  document.querySelectorAll('.lane.drop').forEach((node) => node !== lane && node.classList.remove('drop'));
  lane.classList.add('drop');
});
app.addEventListener('drop', (event) => {
  const lane = event.target.closest('.lane');
  if (!lane) return;
  event.preventDefault();
  const itemId = event.dataTransfer.getData('text/plain');
  const item = findItem(itemId);
  if (item && (item.values[lane.dataset.col] || '') !== lane.dataset.lane) {
    patchItem(itemId, { values: { [lane.dataset.col]: lane.dataset.lane || null } });
  } else {
    render();
  }
});

app.addEventListener('dragend', () => document.querySelectorAll('.lane.drop').forEach((node) => node.classList.remove('drop')));

window.addEventListener('hashchange', () => {
  closeMenu();
  load();
});

// ------------------------------------------------------------------ start

// Local development only (scripts/lyrsoft-dev-api.mjs): ?dev-login=email signs in with a fake token.
const devLogin = new URLSearchParams(location.search).get('dev-login');
if (devLogin && WORK_API_BASE.startsWith('http://localhost')) {
  sessionStorage.setItem('lyrcloud.auth.tokens', JSON.stringify({ accessToken: `dev.${devLogin}`, expiresAt: Date.now() + 864e5 }));
  history.replaceState(null, '', location.pathname + location.hash);
}

if (!getTokens()) {
  app.innerHTML = `
    <div class="welcome">
      <span class="brand-mark big" aria-hidden="true">◆</span>
      <h1>Lyrsoft <b>Work</b></h1>
      <p>Plan, track and deliver work with your team and your clients: boards, owners, due dates and updates in one place.</p>
      <button class="btn primary big" data-click="sign-in">Continue with Google</button>
      <p class="muted small">A <a href="https://www.lyrcloud.com">Lyrcloud</a> product.</p>
    </div>`;
  app.querySelector('[data-click="sign-in"]').addEventListener('click', () => redirectToLogin(location.pathname + location.hash, 'google'));
} else {
  load();
}
