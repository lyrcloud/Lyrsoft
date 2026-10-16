import { api, attempt, field, formValues, h, mount, toast } from '../lib.js';
import { ROLE_LABELS, state } from '../state.js';

export function renderAccount(root) {
  const profile = h('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault();
    const res = await attempt(() => api('/auth/me', { method: 'PATCH', body: formValues(profile) }), 'Profile saved');
    if (res) state.me = res.user;
  } },
  field('Name', h('input', { name: 'name', value: state.me.name, required: true, maxlength: 100 })),
  field('Title', h('input', { name: 'title', value: state.me.title, maxlength: 100, placeholder: 'e.g. Lead engineer' })),
  field('Email', h('input', { value: state.me.email, disabled: true })),
  field('Role', h('input', { value: ROLE_LABELS[state.me.role], disabled: true })),
  h('button', { class: 'btn btn-primary' }, 'Save profile'));

  const password = h('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault();
    const { current, password: next, confirm } = formValues(password);
    if (next !== confirm) return toast('Passwords do not match', 'err');
    if (await attempt(() => api('/auth/change-password', { method: 'POST', body: { current, password: next } }), 'Password changed. Other sessions were signed out.')) password.reset();
  } },
  field('Current password', h('input', { name: 'current', type: 'password', required: true, autocomplete: 'current-password' })),
  field('New password', h('input', { name: 'password', type: 'password', minlength: 10, required: true, autocomplete: 'new-password' }), 'At least 10 characters'),
  field('Repeat new password', h('input', { name: 'confirm', type: 'password', minlength: 10, required: true, autocomplete: 'new-password' })),
  h('button', { class: 'btn btn-primary' }, 'Change password'));

  mount(root, h('div', { class: 'page narrow' },
    h('div', { class: 'page-head' }, h('h1', null, 'Account')),
    h('section', { class: 'panel' }, h('h2', null, 'Profile'), profile),
    h('section', { class: 'panel' }, h('h2', null, 'Password'), password)));
}
