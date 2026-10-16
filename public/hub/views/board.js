import {
  api, attempt, avatar, confirmDialog, events, field, fmtDate, fmtDateTime, formValues, go, h, menu, modal, mount,
  popover, timeAgo, today,
} from '../lib.js';
import { loadDirectory, state, userById } from '../state.js';

const GROUP_COLORS = ['#579bfc', '#a25ddc', '#00c875', '#fdab3d', '#e2445c', '#037f4c', '#ff7575', '#5559df', '#c4c4c4'];
const COLUMN_TYPES = [
  ['status', 'Status'], ['person', 'Person'], ['date', 'Date'], ['text', 'Text'], ['longtext', 'Long text'], ['number', 'Number'], ['email', 'Email'],
];
const DONE = new Set(['Done', 'Won', 'Lost']);

let ctx = null; // { root, data, view, filter, person, collapsed:Set }

export async function renderBoard(root, boardId, query = {}) {
  const [data] = await Promise.all([api(`/boards/${boardId}`), loadDirectory()]);
  const saved = ctx?.data.board.id === boardId ? ctx : null;
  ctx = {
    root, data,
    view: saved?.view || localStorage.getItem(`lyr-view-${boardId}`) || 'table',
    filter: saved?.filter || '', person: saved?.person || '', collapsed: saved?.collapsed || new Set(),
  };
  draw();
  if (query.item) openItem(Number(query.item));
}

async function reload() {
  ctx.data = await api(`/boards/${ctx.data.board.id}`);
  draw();
}

function setBoard(payload) {
  ctx.data = payload;
  draw();
}

const can = (p) => ctx.data.permissions[p];
const statusColumn = () => ctx.data.columns.find((c) => c.type === 'status');

async function saveItem(item, patch) {
  const res = await attempt(() => api(`/items/${item.id}`, { method: 'PATCH', body: patch }));
  if (res) {
    const i = ctx.data.items.findIndex((x) => x.id === item.id);
    ctx.data.items[i] = { ...res.item, updateCount: item.updateCount };
    draw();
    panelRefresh?.(res.item.id);
  }
  return res;
}

const setValue = (item, column, value) => saveItem(item, { data: { [column.id]: value } });

function visibleItems() {
  const q = ctx.filter.toLowerCase();
  const people = ctx.data.columns.filter((c) => c.type === 'person');
  return ctx.data.items.filter((item) => {
    if (q && !item.name.toLowerCase().includes(q) && !JSON.stringify(item.data).toLowerCase().includes(q)) return false;
    if (ctx.person && !people.some((c) => String(item.data[c.id]) === ctx.person)) return false;
    return true;
  });
}

// --- header ---

function header() {
  const { board, members } = ctx.data;
  const title = h('h1', { class: 'board-title' }, board.name);
  if (can('manage')) {
    title.setAttribute('contenteditable', 'true');
    title.setAttribute('spellcheck', 'false');
    title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); title.blur(); } });
    title.addEventListener('blur', async () => {
      const name = title.textContent.trim();
      if (!name || name === board.name) { title.textContent = board.name; return; }
      const res = await attempt(() => api(`/boards/${board.id}`, { method: 'PATCH', body: { name } }));
      if (res) { setBoard(res); events.dispatchEvent(new Event('boards-changed')); } else title.textContent = board.name;
    });
  }
  const viewBtn = (v, label) => h('button', {
    class: `seg${ctx.view === v ? ' on' : ''}`,
    onclick: () => { ctx.view = v; localStorage.setItem(`lyr-view-${board.id}`, v); draw(); },
  }, label);

  const search = h('input', { type: 'search', class: 'input-sm', placeholder: 'Filter items', value: ctx.filter, oninput: () => { ctx.filter = search.value; drawBody(); } });
  const personFilter = h('select', { class: 'input-sm', onchange: () => { ctx.person = personFilter.value; drawBody(); } },
    h('option', { value: '' }, 'Everyone'),
    state.users.map((u) => h('option', { value: String(u.id), selected: ctx.person === String(u.id) }, u.name)));

  return h('div', { class: 'board-head' },
    h('div', { class: 'board-head-top' },
      h('div', null, title, board.description ? h('p', { class: 'muted board-desc' }, board.description) : null),
      h('div', { class: 'board-actions' },
        h('div', { class: 'avatars', title: 'Board members' }, members.slice(0, 5).map((m) => avatar(m, 30)),
          members.length > 5 ? h('span', { class: 'avatar more' }, `+${members.length - 5}`) : null),
        can('manage') ? h('button', { class: 'btn', onclick: membersDialog }, 'Members') : null,
        can('manage') ? h('button', { class: 'icon-btn', 'aria-label': 'Board menu', onclick: (e) => boardMenu(e.currentTarget) }, '⋯') : null)),
    h('div', { class: 'toolbar' },
      can('edit') ? h('button', { class: 'btn btn-primary', onclick: () => newItemDialog() }, 'New item') : null,
      h('div', { class: 'segmented' }, viewBtn('table', 'Table'), viewBtn('kanban', 'Kanban')),
      search, personFilter,
      board.visibility === 'private' ? h('span', { class: 'chip' }, '🔒 Private') : null));
}

function boardMenu(anchor) {
  const { board } = ctx.data;
  menu(anchor, [
    { label: 'Edit description', onClick: () => {
      const form = h('form', { class: 'stack', onsubmit: async (e) => {
        e.preventDefault();
        const res = await attempt(() => api(`/boards/${board.id}`, { method: 'PATCH', body: formValues(form) }));
        if (res) { close(); setBoard(res); }
      } },
      field('Description', h('textarea', { name: 'description', rows: 3, maxlength: 500 }, board.description)),
      field('Visibility', h('select', { name: 'visibility' },
        h('option', { value: 'team', selected: board.visibility === 'team' }, 'Team'),
        h('option', { value: 'private', selected: board.visibility === 'private' }, 'Private'))),
      h('button', { class: 'btn btn-primary' }, 'Save'));
      const close = modal('Board settings', form);
    } },
    { label: 'Add group', onClick: addGroup },
    { label: 'Add column', onClick: () => columnDialog() },
    { label: 'Archive board', danger: true, onClick: async () => {
      if (!(await confirmDialog('Archive board?', `"${board.name}" will disappear for everyone.`, { label: 'Archive' }))) return;
      if (await attempt(() => api(`/boards/${board.id}`, { method: 'DELETE' }), 'Board archived')) {
        events.dispatchEvent(new Event('boards-changed'));
        go('#/');
      }
    } },
  ]);
}

function membersDialog() {
  const { board } = ctx.data;
  const list = h('div', { class: 'stack' });
  const paint = () => {
    const ids = new Set(ctx.data.members.map((m) => m.id));
    const picker = h('select', null, state.users.filter((u) => !ids.has(u.id)).map((u) => h('option', { value: u.id }, `${u.name} (${u.email})`)));
    mount(list,
      h('p', { class: 'muted' }, board.visibility === 'team'
        ? 'This is a team board: every staff member can already see it. Add clients here to share it with them.'
        : 'This board is private: only these members (and admins) can see it.'),
      ctx.data.members.map((m) => h('div', { class: 'member-row' }, avatar(m), h('span', null, m.name, h('small', { class: 'muted' }, ` · ${m.email}`)),
        h('button', { class: 'btn btn-sm', onclick: async () => {
          const res = await attempt(() => api(`/boards/${board.id}/members/${m.id}`, { method: 'DELETE' }));
          if (res) { setBoard(res); paint(); }
        } }, 'Remove'))),
      picker.options.length ? h('div', { class: 'row' }, picker, h('button', { class: 'btn btn-primary', onclick: async () => {
        const res = await attempt(() => api(`/boards/${board.id}/members`, { method: 'POST', body: { userId: Number(picker.value) } }));
        if (res) { setBoard(res); paint(); }
      } }, 'Add')) : null);
  };
  paint();
  modal('Board members', list);
}

async function addGroup() {
  const name = await prompt1('New group', 'Group name');
  if (!name) return;
  const color = GROUP_COLORS[ctx.data.groups.length % GROUP_COLORS.length];
  const res = await attempt(() => api(`/boards/${ctx.data.board.id}/groups`, { method: 'POST', body: { name, color } }));
  if (res) setBoard(res);
}

function prompt1(title, label, value = '') {
  return new Promise((resolve) => {
    const input = h('input', { value, maxlength: 80, required: true });
    const form = h('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); close(); resolve(input.value.trim()); } },
      field(label, input), h('button', { class: 'btn btn-primary' }, 'Save'));
    const close = modal(title, form);
  });
}

function columnDialog(column = null) {
  const { board } = ctx.data;
  const type = h('select', { name: 'type', disabled: !!column }, COLUMN_TYPES.map(([v, l]) => h('option', { value: v, selected: column?.type === v }, l)));
  const options = h('div', { class: 'stack options-editor' });
  const rows = (column?.options?.length ? column.options : [{ label: 'Not started', color: '#c4c4c4' }, { label: 'Working on it', color: '#fdab3d' }, { label: 'Done', color: '#00c875' }]).map((o) => ({ ...o }));
  const paintOptions = () => {
    if ((column?.type || type.value) !== 'status') return mount(options);
    mount(options, h('span', { class: 'field-label' }, 'Labels'), rows.map((o, i) => h('div', { class: 'row' },
      h('input', { type: 'color', value: o.color, oninput: (e) => { o.color = e.target.value; } }),
      h('input', { value: o.label, maxlength: 40, oninput: (e) => { o.label = e.target.value; } }),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Remove label', onclick: () => { rows.splice(i, 1); paintOptions(); } }, '✕'))),
    h('button', { type: 'button', class: 'btn btn-sm', onclick: () => { rows.push({ label: '', color: GROUP_COLORS[rows.length % GROUP_COLORS.length] }); paintOptions(); } }, '+ Add label'));
  };
  type.addEventListener('change', paintOptions);
  const form = h('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault();
    const body = { name: form.elements.name.value, type: column?.type || type.value, options: rows.filter((o) => o.label.trim()) };
    const res = await attempt(() => (column
      ? api(`/boards/${board.id}/columns/${column.id}`, { method: 'PATCH', body })
      : api(`/boards/${board.id}/columns`, { method: 'POST', body })));
    if (res) { close(); setBoard(res); }
  } },
  field('Column name', h('input', { name: 'name', required: true, maxlength: 40, value: column?.name || '' })),
  field('Type', type), options,
  h('div', { class: 'row space' },
    column ? h('button', { type: 'button', class: 'btn btn-danger', onclick: async () => {
      if (!(await confirmDialog('Delete column?', `All values in "${column.name}" will be lost.`, { label: 'Delete' }))) return;
      const res = await attempt(() => api(`/boards/${board.id}/columns/${column.id}`, { method: 'DELETE' }));
      if (res) { close(); setBoard(res); }
    } }, 'Delete column') : h('span'),
    h('button', { class: 'btn btn-primary' }, column ? 'Save' : 'Add column')));
  paintOptions();
  const close = modal(column ? 'Edit column' : 'New column', form);
}

// --- cells ---

function statusPill(column, value) {
  const option = column.options.find((o) => o.label === value);
  return h('span', { class: `pill${option ? '' : ' empty'}`, style: option ? { background: option.color } : null }, value || '');
}

function personChip(value) {
  const user = userById(value);
  return user ? h('span', { class: 'person' }, avatar(user, 24), h('span', { class: 'person-name' }, user.name.split(' ')[0])) : avatar(null, 24);
}

function cell(item, column) {
  const value = item.data[column.id];
  const editable = can('edit');
  switch (column.type) {
    case 'status':
      return h('button', { class: 'cell cell-status', disabled: !editable, onclick: (e) => {
        const pop = popover(e.currentTarget, h('div', { class: 'status-menu' },
          column.options.map((o) => h('button', { class: 'pill', style: { background: o.color }, onclick: () => { pop.close(); setValue(item, column, o.label); } }, o.label)),
          h('button', { class: 'pill empty', onclick: () => { pop.close(); setValue(item, column, null); } }, 'Clear')));
      } }, statusPill(column, value));
    case 'person':
      return h('button', { class: 'cell cell-person', disabled: !editable, onclick: (e) => {
        const pop = popover(e.currentTarget, h('div', { class: 'menu person-menu' },
          state.users.map((u) => h('button', { class: `menu-item${u.id === value ? ' on' : ''}`, onclick: () => { pop.close(); setValue(item, column, u.id); } }, avatar(u, 22), u.name)),
          value ? h('button', { class: 'menu-item', onclick: () => { pop.close(); setValue(item, column, null); } }, 'Unassign') : null));
      } }, personChip(value));
    case 'date': {
      const status = statusColumn();
      const late = value && value < today() && !DONE.has(item.data[status?.id]);
      if (!editable) return h('span', { class: `cell${late ? ' late' : ''}` }, fmtDate(value));
      return h('input', { class: `cell cell-input${late ? ' late' : ''}`, type: 'date', value: value || '', onchange: (e) => setValue(item, column, e.target.value || null) });
    }
    case 'longtext':
      return h('button', { class: 'cell cell-long', onclick: () => openItem(item.id) }, value ? String(value).slice(0, 80) : '');
    default: {
      if (!editable) return h('span', { class: 'cell' }, value ?? '');
      const input = h('input', {
        class: 'cell cell-input', value: value ?? '', type: column.type === 'number' ? 'number' : column.type === 'email' ? 'email' : 'text',
        onkeydown: (e) => { if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') { input.value = value ?? ''; input.blur(); } },
        onblur: () => { const v = input.value.trim(); if (v !== String(value ?? '')) setValue(item, column, v || null); },
      });
      return input;
    }
  }
}

// --- table view ---

function groupMenu(anchor, group) {
  const { board } = ctx.data;
  menu(anchor, [
    { label: 'Rename group', onClick: async () => {
      const name = await prompt1('Rename group', 'Group name', group.name);
      if (name) { const res = await attempt(() => api(`/boards/${board.id}/groups/${group.id}`, { method: 'PATCH', body: { name } })); if (res) setBoard(res); }
    } },
    ...GROUP_COLORS.map((color) => ({ label: 'Color', color, onClick: async () => {
      const res = await attempt(() => api(`/boards/${board.id}/groups/${group.id}`, { method: 'PATCH', body: { color } }));
      if (res) setBoard(res);
    } })),
    { label: 'Delete group and its items', danger: true, onClick: async () => {
      if (!(await confirmDialog('Delete group?', `"${group.name}" and all its items will be deleted.`, { label: 'Delete' }))) return;
      const res = await attempt(() => api(`/boards/${board.id}/groups/${group.id}`, { method: 'DELETE' }));
      if (res) setBoard(res);
    } },
  ]);
}

function tableView(items) {
  const { groups, columns } = ctx.data;
  const template = `minmax(240px, 2fr) ${columns.map((c) => (c.type === 'longtext' ? 'minmax(180px, 1.5fr)' : c.type === 'person' ? '130px' : 'minmax(130px, 1fr)')).join(' ')}${can('manage') ? ' 44px' : ''}`;
  const grid = (cls, ...cells) => h('div', { class: `grid-row ${cls}`, style: { gridTemplateColumns: template } }, cells);

  return h('div', { class: 'table-view' }, groups.map((group) => {
    const rows = items.filter((i) => i.groupId === group.id);
    const collapsed = ctx.collapsed.has(group.id);
    const status = statusColumn();
    const summary = status ? h('div', { class: 'mini-bar', title: 'Status breakdown' }, status.options.map((o) => {
      const n = rows.filter((r) => r.data[status.id] === o.label).length;
      return n ? h('span', { title: `${o.label}: ${n}`, style: { background: o.color, flexGrow: String(n) } }) : null;
    })) : null;

    return h('section', { class: 'group', style: { '--group': group.color } },
      h('div', { class: 'group-head' },
        h('button', { class: 'icon-btn caret', 'aria-label': collapsed ? 'Expand group' : 'Collapse group', onclick: () => {
          collapsed ? ctx.collapsed.delete(group.id) : ctx.collapsed.add(group.id);
          drawBody();
        } }, collapsed ? '▸' : '▾'),
        h('h2', null, group.name), h('span', { class: 'muted count' }, `${rows.length} item${rows.length === 1 ? '' : 's'}`),
        collapsed ? summary : null,
        can('manage') ? h('button', { class: 'icon-btn', 'aria-label': 'Group menu', onclick: (e) => groupMenu(e.currentTarget, group) }, '⋯') : null),
      collapsed ? null : h('div', { class: 'grid' },
        grid('grid-head', h('div', { class: 'hcell first' }, 'Item'),
          columns.map((c) => h('div', { class: 'hcell' }, can('manage')
            ? h('button', { class: 'hcell-btn', onclick: () => columnDialog(c) }, c.name) : c.name)),
          can('manage') ? h('button', { class: 'hcell add-col', title: 'Add column', 'aria-label': 'Add column', onclick: () => columnDialog() }, '+') : null),
        rows.map((item) => grid('grid-item',
          h('div', { class: 'cell-name' },
            h('button', { class: 'item-link', onclick: () => openItem(item.id) }, item.name),
            h('button', { class: `bubble${item.updateCount ? ' has' : ''}`, title: 'Updates', onclick: () => openItem(item.id) }, item.updateCount ? String(item.updateCount) : '💬')),
          columns.map((c) => h('div', { class: 'gcell' }, cell(item, c))),
          can('manage') ? h('div', { class: 'gcell' }) : null)),
        can('edit') ? grid('grid-add', h('div', { class: 'cell-name' }, addItemInput(group)), columns.map(() => h('div')), can('manage') ? h('div') : null) : null,
        status && rows.length ? grid('grid-foot', h('div'), columns.map((c) => h('div', { class: 'gcell' }, c.id === status.id ? summary : null)), can('manage') ? h('div') : null) : null));
  }));
}

function addItemInput(group) {
  const input = h('input', { class: 'add-item', placeholder: '+ Add item', maxlength: 200, onkeydown: async (e) => {
    if (e.key !== 'Enter' || !input.value.trim()) return;
    const name = input.value.trim();
    input.value = '';
    const res = await attempt(() => api(`/boards/${ctx.data.board.id}/items`, { method: 'POST', body: { name, groupId: group.id } }));
    if (res) {
      ctx.data.items.push({ ...res.item, updateCount: 0 });
      drawBody();
      ctx.root.querySelectorAll('.add-item')[ctx.data.groups.findIndex((g) => g.id === group.id)]?.focus();
    }
  } });
  return input;
}

// --- kanban view ---

function kanbanView(items) {
  const status = statusColumn();
  if (!status) return h('div', { class: 'empty-state' }, h('p', null, 'Kanban needs a status column.'), can('manage') ? h('button', { class: 'btn', onclick: () => columnDialog() }, 'Add a status column') : null);
  const person = ctx.data.columns.find((c) => c.type === 'person');
  const date = ctx.data.columns.find((c) => c.type === 'date');
  const lanes = [...status.options, { label: null, color: '#c4c4c4' }];
  return h('div', { class: 'kanban' }, lanes.map((lane) => {
    const cards = items.filter((i) => (i.data[status.id] ?? null) === lane.label);
    const col = h('div', { class: 'lane', style: { '--lane': lane.color } },
      h('div', { class: 'lane-head' }, h('span', null, lane.label || 'No status'), h('span', { class: 'lane-count' }, String(cards.length))),
      h('div', { class: 'lane-cards' }, cards.map((item) => h('div', {
        class: 'card', draggable: can('edit') ? 'true' : null,
        ondragstart: (e) => { e.dataTransfer.setData('text/plain', String(item.id)); e.currentTarget.classList.add('dragging'); },
        ondragend: (e) => e.currentTarget.classList.remove('dragging'),
        onclick: () => openItem(item.id),
      },
      h('strong', null, item.name),
      h('div', { class: 'card-meta' },
        h('span', { class: 'muted' }, ctx.data.groups.find((g) => g.id === item.groupId)?.name),
        date && item.data[date.id] ? h('span', { class: 'chip' }, fmtDate(item.data[date.id])) : null,
        person ? personChip(item.data[person.id]) : null)))));
    if (can('edit')) {
      col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('over'); });
      col.addEventListener('dragleave', () => col.classList.remove('over'));
      col.addEventListener('drop', (e) => {
        e.preventDefault();
        col.classList.remove('over');
        const item = ctx.data.items.find((i) => i.id === Number(e.dataTransfer.getData('text/plain')));
        if (item && (item.data[status.id] ?? null) !== lane.label) setValue(item, status, lane.label);
      });
    }
    return col;
  }));
}

// --- item dialog ---

function newItemDialog() {
  const form = h('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault();
    const { name, groupId } = formValues(form);
    const res = await attempt(() => api(`/boards/${ctx.data.board.id}/items`, { method: 'POST', body: { name, groupId: Number(groupId) } }));
    if (res) { close(); ctx.data.items.push({ ...res.item, updateCount: 0 }); draw(); openItem(res.item.id); }
  } },
  field('Name', h('input', { name: 'name', required: true, maxlength: 200 })),
  field('Group', h('select', { name: 'groupId' }, ctx.data.groups.map((g) => h('option', { value: g.id }, g.name)))),
  h('button', { class: 'btn btn-primary' }, 'Create item'));
  const close = modal('New item', form);
}

let panelRefresh = null;

async function openItem(itemId) {
  document.querySelector('.drawer-wrap')?.remove();
  const wrap = h('div', { class: 'drawer-wrap', onmousedown: (e) => { if (e.target === wrap) close(); } });
  const drawer = h('aside', { class: 'drawer', role: 'dialog', 'aria-label': 'Item' });
  wrap.append(drawer);
  document.body.append(wrap);
  const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.overlay')) close(); };
  document.addEventListener('keydown', onKey);
  function close() {
    wrap.remove();
    panelRefresh = null;
    document.removeEventListener('keydown', onKey);
    if (location.hash.includes('item=')) history.replaceState(null, '', `#/boards/${ctx.data.board.id}`);
  }
  let tab = 'updates';

  async function paint() {
    let detail;
    try { detail = await api(`/items/${itemId}`); } catch (err) { mount(drawer, h('p', { class: 'pad' }, err.message)); return; }
    const item = ctx.data.items.find((i) => i.id === itemId) || detail.item;
    const name = h('h2', { class: 'drawer-title', contenteditable: can('edit') ? 'true' : null, spellcheck: 'false' }, detail.item.name);
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); name.blur(); } });
    name.addEventListener('blur', () => { const v = name.textContent.trim(); if (v && v !== item.name) saveItem(item, { name: v }); else name.textContent = item.name; });

    const fields = h('div', { class: 'fields' },
      h('div', { class: 'kv' }, h('span', null, 'Group'), can('edit')
        ? h('select', { class: 'input-sm', onchange: (e) => saveItem(item, { groupId: Number(e.target.value) }) },
          ctx.data.groups.map((g) => h('option', { value: g.id, selected: g.id === item.groupId }, g.name)))
        : h('span', null, ctx.data.groups.find((g) => g.id === item.groupId)?.name)),
      ctx.data.columns.map((c) => h('div', { class: `kv${c.type === 'longtext' ? ' kv-long' : ''}` }, h('span', null, c.name),
        c.type === 'longtext' ? longText(item, c) : cell(item, c))));

    const body = h('div', { class: 'drawer-tab' });
    if (tab === 'updates') {
      const text = h('textarea', { rows: 3, placeholder: 'Write an update… assignees get an email.', maxlength: 5000 });
      mount(body,
        h('form', { class: 'stack', onsubmit: async (e) => {
          e.preventDefault();
          if (!text.value.trim()) return;
          if (await attempt(() => api(`/items/${itemId}/updates`, { method: 'POST', body: { body: text.value } }))) {
            item.updateCount = (item.updateCount || 0) + 1;
            draw();
            paint();
          }
        } }, text, h('button', { class: 'btn btn-primary btn-sm' }, 'Post update')),
        detail.updates.length ? detail.updates.map((u) => h('div', { class: 'update' },
          h('div', { class: 'update-head' }, avatar(userById(u.userId) || { id: 0, name: u.userName || '?' }, 26), h('strong', null, u.userName || 'Deleted user'),
            h('small', { class: 'muted', title: fmtDateTime(u.createdAt) }, timeAgo(u.createdAt))),
          h('p', null, u.body))) : h('p', { class: 'muted' }, 'No updates yet.'));
    } else {
      mount(body, detail.activity.length ? h('ul', { class: 'timeline' }, detail.activity.map((a) => h('li', null,
        h('strong', null, a.userName || 'Website'), ' ', a.detail.replace(/^.*? · /, ''), h('small', { class: 'muted' }, ` · ${timeAgo(a.createdAt)}`)))) : h('p', { class: 'muted' }, 'No activity yet.'));
    }

    mount(drawer,
      h('div', { class: 'drawer-head' }, name,
        h('div', { class: 'row' },
          can('edit') ? h('button', { class: 'icon-btn', title: 'Delete item', 'aria-label': 'Delete item', onclick: async () => {
            if (!(await confirmDialog('Delete item?', `"${item.name}" will be deleted.`, { label: 'Delete' }))) return;
            if (await attempt(() => api(`/items/${itemId}`, { method: 'DELETE' }), 'Item deleted')) {
              ctx.data.items = ctx.data.items.filter((i) => i.id !== itemId);
              close();
              draw();
            }
          } }, '🗑') : null,
          h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close }, '✕'))),
      h('p', { class: 'muted small' }, `Created ${fmtDateTime(detail.item.createdAt)}`),
      fields,
      h('div', { class: 'tabs' },
        h('button', { class: `tab${tab === 'updates' ? ' on' : ''}`, onclick: () => { tab = 'updates'; paint(); } }, `Updates (${detail.updates.length})`),
        h('button', { class: `tab${tab === 'activity' ? ' on' : ''}`, onclick: () => { tab = 'activity'; paint(); } }, 'Activity')),
      body);
  }

  panelRefresh = (id) => { if (id === itemId) paint(); };
  mount(drawer, h('p', { class: 'pad muted' }, 'Loading…'));
  paint();
}

function longText(item, column) {
  const value = item.data[column.id] || '';
  if (!can('edit')) return h('p', { class: 'longtext' }, value);
  const ta = h('textarea', { rows: 4, maxlength: 5000, onblur: () => { if (ta.value !== value) setValue(item, column, ta.value.trim() || null); } }, value);
  return ta;
}

// --- drawing ---

let bodyEl = null;

function drawBody() {
  if (!bodyEl) return;
  const items = visibleItems();
  mount(bodyEl, ctx.view === 'kanban' ? kanbanView(items) : tableView(items),
    !ctx.data.items.length && can('edit') ? h('p', { class: 'muted pad' }, 'No items yet — type in "+ Add item" to create the first one.') : null);
}

function draw() {
  bodyEl = h('div', { class: 'board-body' });
  const scroll = ctx.root.scrollTop;
  mount(ctx.root, h('div', { class: 'page page-board' }, header(), bodyEl));
  drawBody();
  ctx.root.scrollTop = scroll;
}
