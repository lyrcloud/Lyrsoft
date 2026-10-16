import { api, attempt, events, field, formValues, go, h, modal, mount, parseHash, toast } from './lib.js';
import { ROLE_LABELS, isAdmin, isStaff, loadBoards, loadDirectory, state } from './state.js';
import { renderDashboard } from './views/dashboard.js';
import { renderBoard } from './views/board.js';
import { renderMail } from './views/mail.js';
import { renderTeam } from './views/team.js';
import { renderActivity } from './views/activity.js';
import { renderAccount } from './views/account.js';
import { avatar } from './lib.js';

const app = document.getElementById('app');
const PUBLIC_ROUTES = ['login', 'forgot', 'set-password'];

events.addEventListener('unauthorized', () => {
  state.me = null;
  if (!PUBLIC_ROUTES.includes(parseHash().parts[0])) go('#/login');
});
events.addEventListener('boards-changed', async () => { await loadBoards(); renderSidebar(); });

// --- sign-in pages ---

function authCard(title, subtitle, form, footer) {
  return h('div', { class: 'auth' },
    h('div', { class: 'auth-card' },
      h('a', { class: 'auth-brand', href: '/' }, h('span', { class: 'logo' }), 'Lyrsoft Hub'),
      h('h1', null, title), subtitle ? h('p', { class: 'muted' }, subtitle) : null, form, footer));
}

function loginView() {
  const form = h('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault();
    const { user } = await attempt(() => api('/auth/login', { method: 'POST', body: formValues(form) })) || {};
    if (user) { state.me = user; await start(); go('#/'); }
  } },
  field('Email', h('input', { name: 'email', type: 'email', required: true, autocomplete: 'username' })),
  field('Password', h('input', { name: 'password', type: 'password', required: true, autocomplete: 'current-password' })),
  h('button', { class: 'btn btn-primary btn-block' }, 'Sign in'));
  mount(app, authCard('Sign in', 'Projects, clients, team and mail — all in one place.', form,
    h('p', { class: 'auth-foot' }, h('a', { href: '#/forgot' }, 'Forgot your password?'))));
}

function forgotView() {
  const form = h('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault();
    const ok = await attempt(() => api('/auth/forgot', { method: 'POST', body: formValues(form) }));
    if (ok) mount(form, h('p', null, 'If that email has an account, a reset link is on its way. It is valid for 1 hour.'));
  } },
  field('Email', h('input', { name: 'email', type: 'email', required: true })),
  h('button', { class: 'btn btn-primary btn-block' }, 'Send reset link'));
  mount(app, authCard('Reset password', 'We will email you a link to choose a new password.', form,
    h('p', { class: 'auth-foot' }, h('a', { href: '#/login' }, 'Back to sign in'))));
}

async function setPasswordView(token) {
  let info;
  try { info = await api(`/auth/token?token=${encodeURIComponent(token || '')}`); } catch (err) {
    return mount(app, authCard('Link not valid', err.message, h('a', { class: 'btn btn-primary btn-block', href: '#/forgot' }, 'Request a new link')));
  }
  const form = h('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault();
    const { password, confirm } = formValues(form);
    if (password !== confirm) return toast('Passwords do not match', 'err');
    const res = await attempt(() => api('/auth/set-password', { method: 'POST', body: { token, password } }));
    if (res) { state.me = res.user; await start(); go('#/'); toast('Password saved. Welcome!'); }
  } },
  field('Email', h('input', { value: info.email, disabled: true })),
  field('New password', h('input', { name: 'password', type: 'password', minlength: 10, required: true, autocomplete: 'new-password' }), 'At least 10 characters'),
  field('Repeat password', h('input', { name: 'confirm', type: 'password', minlength: 10, required: true, autocomplete: 'new-password' })),
  h('button', { class: 'btn btn-primary btn-block' }, 'Save password and sign in'));
  mount(app, authCard(info.purpose === 'reset' ? 'Choose a new password' : `Welcome, ${info.name}`, null, form));
}

// --- app shell ---

let main;
let sidebar;

function newBoardDialog() {
  const form = h('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault();
    const res = await attempt(() => api('/boards', { method: 'POST', body: formValues(form) }));
    if (res) { close(); events.dispatchEvent(new Event('boards-changed')); go(`#/boards/${res.board.id}`); }
  } },
  field('Board name', h('input', { name: 'name', required: true, maxlength: 80, placeholder: 'e.g. Acme mobile app' })),
  field('Template', h('select', { name: 'template' }, state.templates.map((t) => h('option', { value: t.value }, t.label)))),
  field('Visibility', h('select', { name: 'visibility' },
    h('option', { value: 'team' }, 'Team — every staff member can see it'),
    h('option', { value: 'private' }, 'Private — only board members and admins'))),
  field('Description', h('textarea', { name: 'description', rows: 2, maxlength: 500 })),
  h('button', { class: 'btn btn-primary' }, 'Create board'));
  const close = modal('New board', form);
}

function navLink(hash, icon, label) {
  const active = (location.hash || '#/') === hash || (hash !== '#/' && location.hash.startsWith(hash));
  return h('a', { class: `nav-link${active ? ' active' : ''}`, href: hash }, h('span', { class: 'nav-ico' }, icon), label);
}

function renderSidebar() {
  if (!sidebar) return;
  mount(sidebar,
    h('a', { class: 'side-brand', href: '#/' }, h('span', { class: 'logo' }), h('span', null, 'Lyrsoft ', h('b', null, 'Hub'))),
    h('nav', { class: 'side-nav' },
      navLink('#/', '⌂', 'Home'),
      navLink('#/activity', '↻', 'Activity'),
      isAdmin() ? navLink('#/team', '☺', 'Team') : null,
      isAdmin() ? navLink('#/mail', '✉', 'Mail') : null,
      navLink('#/account', '⚙', 'Account')),
    h('div', { class: 'side-section' },
      h('span', null, 'Boards'),
      isStaff() ? h('button', { class: 'icon-btn', title: 'New board', 'aria-label': 'New board', onclick: newBoardDialog }, '+') : null),
    h('nav', { class: 'side-boards' }, state.boards.map((b) =>
      navLink(`#/boards/${b.id}`, b.visibility === 'private' ? '🔒' : '▦', b.name))),
    h('div', { class: 'side-user' }, avatar(state.me, 32),
      h('div', null, h('strong', null, state.me.name), h('small', null, ROLE_LABELS[state.me.role])),
      h('button', { class: 'icon-btn', title: 'Sign out', 'aria-label': 'Sign out', onclick: async () => {
        await api('/auth/logout', { method: 'POST' }).catch(() => {});
        state.me = null;
        go('#/login');
      } }, '⎋')));
}

function searchBox() {
  let timer;
  const results = h('div', { class: 'search-results' });
  const input = h('input', { type: 'search', placeholder: 'Search boards and items…', 'aria-label': 'Search', oninput: () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = input.value.trim();
      if (q.length < 2) return mount(results);
      const { results: found } = await api(`/search?q=${encodeURIComponent(q)}`);
      mount(results, found.length ? found.map((r) => h('a', {
        href: r.type === 'board' ? `#/boards/${r.id}` : `#/boards/${r.boardId}?item=${r.id}`,
        onclick: () => { input.value = ''; mount(results); },
      }, h('strong', null, r.name), h('small', null, r.type === 'board' ? 'Board' : r.boardName))) : h('p', { class: 'muted pad' }, 'Nothing found'));
    }, 200);
  } });
  return h('div', { class: 'search' }, input, results);
}

function shell() {
  sidebar = h('aside', { class: 'sidebar' });
  main = h('main', { class: 'main' });
  const toggle = h('button', { class: 'icon-btn menu-toggle', 'aria-label': 'Menu', onclick: () => document.body.classList.toggle('side-open') }, '☰');
  mount(app, h('div', { class: 'layout' }, sidebar,
    h('div', { class: 'content' }, h('header', { class: 'topbar' }, toggle, searchBox(),
      h('a', { class: 'btn btn-ghost-dark', href: '/', target: '_blank', rel: 'noopener' }, 'lyrsoft.com ↗')), main)));
  renderSidebar();
}

async function start() {
  await Promise.all([loadDirectory(), loadBoards()]);
  shell();
}

async function route() {
  const { parts, query } = parseHash();
  document.body.classList.remove('side-open');
  document.querySelector('.popover')?.remove();
  if (parts[0] === 'set-password') { state.me = null; return setPasswordView(query.token); }
  if (!state.me) {
    if (parts[0] === 'forgot') return forgotView();
    if (parts[0] !== 'login') return go('#/login');
    return loginView();
  }
  if (!main || !document.body.contains(main)) shell();
  if (PUBLIC_ROUTES.includes(parts[0])) return go('#/');
  renderSidebar();
  main.scrollTop = 0;
  const views = {
    '': () => renderDashboard(main),
    boards: () => renderBoard(main, Number(parts[1]), query),
    mail: () => renderMail(main, parts[1] || 'overview', query),
    team: () => renderTeam(main),
    activity: () => renderActivity(main),
    account: () => renderAccount(main),
  };
  const view = views[parts[0] || ''];
  if (!view) return mount(main, h('div', { class: 'page' }, h('h1', null, 'Not found')));
  try { await view(); } catch (err) {
    mount(main, h('div', { class: 'page' }, h('h1', null, 'Something went wrong'), h('p', { class: 'muted' }, err.message)));
  }
}

window.addEventListener('hashchange', route);

(async () => {
  const { user } = await api('/auth/me').catch(() => ({ user: null }));
  state.me = user;
  if (user && parseHash().parts[0] !== 'set-password') await start();
  route();
})();
