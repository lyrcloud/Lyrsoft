import { api, attempt, avatar, confirmDialog, field, formValues, h, modal, mount, timeAgo } from '../lib.js';
import { ROLE_LABELS, loadDirectory, state } from '../state.js';

export async function renderTeam(root) {
  await loadDirectory();
  const me = state.me;
  const canTouch = (u) => u.role !== 'super_admin' && u.id !== me.id && (u.role !== 'admin' || me.role === 'super_admin');
  const grantable = state.roles.filter((r) => r.value !== 'admin' || me.role === 'super_admin');

  async function update(user, patch, msg) {
    if (await attempt(() => api(`/users/${user.id}`, { method: 'PATCH', body: patch }), msg)) renderTeam(root);
  }

  function inviteDialog() {
    const form = h('form', { class: 'stack', onsubmit: async (e) => {
      e.preventDefault();
      if (await attempt(() => api('/users', { method: 'POST', body: formValues(form) }), 'Invite sent')) { close(); renderTeam(root); }
    } },
    field('Full name', h('input', { name: 'name', required: true, maxlength: 100 })),
    field('Email', h('input', { name: 'email', type: 'email', required: true, maxlength: 254 })),
    field('Title', h('input', { name: 'title', maxlength: 100, placeholder: 'e.g. Backend engineer, or client company' })),
    field('Role', h('select', { name: 'role' }, grantable.map((r) => h('option', { value: r.value, selected: r.value === 'member' }, r.label))),
      'Clients only see boards they are added to, and can comment but not edit.'),
    h('button', { class: 'btn btn-primary' }, 'Send invite'));
    const close = modal('Invite to Lyrsoft Hub', form);
  }

  const rows = state.users.map((u) => h('tr', { class: u.active ? null : 'inactive' },
    h('td', null, h('div', { class: 'who' }, avatar(u, 32), h('div', null, h('strong', null, u.name), h('small', { class: 'muted' }, u.email)))),
    h('td', null, canTouch(u)
      ? h('select', { class: 'input-sm', onchange: (e) => update(u, { role: e.target.value }, 'Role updated') },
        grantable.concat(u.role === 'admin' && me.role !== 'super_admin' ? [{ value: 'admin', label: 'Admin' }] : [])
          .map((r) => h('option', { value: r.value, selected: r.value === u.role }, r.label)))
      : h('span', { class: `role role-${u.role}` }, ROLE_LABELS[u.role])),
    h('td', { class: 'muted' }, u.title || '—'),
    h('td', null, !u.active ? h('span', { class: 'chip' }, 'Deactivated') : u.hasPassword ? h('span', { class: 'chip ok' }, 'Active') : h('span', { class: 'chip warn' }, 'Invite pending')),
    h('td', { class: 'muted' }, timeAgo(u.lastLoginAt)),
    h('td', { class: 'actions' }, canTouch(u) ? [
      u.active && !u.hasPassword ? h('button', { class: 'btn btn-sm', onclick: () => attempt(() => api(`/users/${u.id}/invite`, { method: 'POST' }), 'Invite re-sent') }, 'Resend invite') : null,
      u.active
        ? h('button', { class: 'btn btn-sm', onclick: async () => {
          if (await confirmDialog('Deactivate user?', `${u.name} will be signed out and can no longer sign in.`, { label: 'Deactivate' })) update(u, { active: false }, 'User deactivated');
        } }, 'Deactivate')
        : h('button', { class: 'btn btn-sm', onclick: () => update(u, { active: true }, 'User reactivated') }, 'Reactivate'),
    ] : u.role === 'super_admin' ? h('small', { class: 'muted' }, 'Protected') : null)));

  mount(root, h('div', { class: 'page' },
    h('div', { class: 'page-head' },
      h('div', null, h('h1', null, 'Team & clients'), h('p', { class: 'muted' }, `${state.users.filter((u) => u.active).length} active accounts`)),
      h('button', { class: 'btn btn-primary', onclick: inviteDialog }, 'Invite people')),
    h('section', { class: 'panel flush' }, h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', null, h('tr', null, ['Person', 'Role', 'Title', 'Status', 'Last sign-in', ''].map((t) => h('th', null, t)))),
      h('tbody', null, rows)))),
    h('section', { class: 'panel' }, h('h2', null, 'Roles'), h('dl', { class: 'roles' },
      h('dt', null, 'Super admin'), h('dd', null, 'Full control, including managing admins. Exactly one account, set by SUPER_ADMIN_EMAIL; cannot be changed by anyone else.'),
      h('dt', null, 'Admin'), h('dd', null, 'Manages users (except admins), all boards, and Lyrsoft Mail.'),
      h('dt', null, 'Manager'), h('dd', null, 'Creates boards and changes any board\'s columns, groups and members.'),
      h('dt', null, 'Member'), h('dd', null, 'Works on items in team boards and boards they belong to.'),
      h('dt', null, 'Client'), h('dd', null, 'Sees only boards they are added to; can comment but not edit.')))));
}
