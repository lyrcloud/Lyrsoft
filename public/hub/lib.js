// Tiny DOM + API helpers. Everything is built with createElement/textContent, so user data is never parsed as HTML.

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'style') for (const [k, v] of Object.entries(value)) k.startsWith('--') ? el.style.setProperty(k, v) : (el.style[k] = v);
    else if (key === 'class') el.className = value;
    else if (key === 'value' || key === 'checked' || key === 'selected') el[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function mount(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

export const events = new EventTarget();

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'x-lyrsoft': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/auth/')) events.dispatchEvent(new Event('unauthorized'));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

export function toast(message, kind = 'ok') {
  const el = h('div', { class: `toast toast-${kind}` }, message);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.classList.add('out'), 3200);
  setTimeout(() => el.remove(), 3600);
}

// Wraps an async action: shows its error as a toast instead of failing silently.
export async function attempt(fn, success) {
  try {
    const out = await fn();
    if (success) toast(success);
    return out;
  } catch (err) {
    toast(err.message, 'err');
    return undefined;
  }
}

export function modal(title, body, { actions = [], wide = false } = {}) {
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const overlay = h('div', { class: 'overlay', onmousedown: (e) => { if (e.target === overlay) close(); } },
    h('div', { class: `modal${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'modal-head' }, h('h2', null, title), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close }, '✕')),
      h('div', { class: 'modal-body' }, body),
      actions.length ? h('div', { class: 'modal-foot' }, actions) : null));
  document.body.append(overlay);
  document.addEventListener('keydown', onKey);
  overlay.querySelector('input, select, textarea')?.focus();
  return close;
}

export function confirmDialog(title, message, { danger = true, label = 'Confirm' } = {}) {
  return new Promise((resolve) => {
    let close;
    const done = (v) => { close(); resolve(v); };
    close = modal(title, h('p', null, message), {
      actions: [
        h('button', { class: 'btn', onclick: () => done(false) }, 'Cancel'),
        h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, onclick: () => done(true) }, label),
      ],
    });
  });
}

// Anchored dropdown menu. items: [{label, onClick, color, danger}] or a custom Node.
export function popover(anchor, content) {
  document.querySelector('.popover')?.remove();
  const pop = h('div', { class: 'popover' }, content);
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  const left = Math.min(r.left, window.innerWidth - pop.offsetWidth - 8);
  const top = r.bottom + pop.offsetHeight + 8 > window.innerHeight ? r.top - pop.offsetHeight - 4 : r.bottom + 4;
  Object.assign(pop.style, { left: `${Math.max(8, left)}px`, top: `${Math.max(8, top)}px` });
  const away = (e) => { if (!pop.contains(e.target)) close(); };
  const close = () => { pop.remove(); document.removeEventListener('mousedown', away, true); };
  setTimeout(() => document.addEventListener('mousedown', away, true));
  pop.close = close;
  return pop;
}

export function menu(anchor, items) {
  const pop = popover(anchor, h('div', { class: 'menu' }, items.map((it) => h('button', {
    class: `menu-item${it.danger ? ' danger' : ''}`,
    onclick: () => { pop.close(); it.onClick(); },
  }, it.color ? h('span', { class: 'swatch', style: { background: it.color } }) : null, it.label))));
  return pop;
}

export function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', null, label), input, hint ? h('small', { class: 'muted' }, hint) : null);
}

export function formValues(form) {
  return Object.fromEntries(new FormData(form));
}

export const initials = (name = '?') => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

const AVATAR_COLORS = ['#5034ff', '#00a3a3', '#e2445c', '#fdab3d', '#00c875', '#a25ddc', '#579bfc', '#ff7575'];
export function avatar(user, size = 28) {
  if (!user) return h('span', { class: 'avatar empty', style: { width: `${size}px`, height: `${size}px` }, title: 'Unassigned' }, '');
  return h('span', {
    class: 'avatar', title: user.name,
    style: { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.4)}px`, background: AVATAR_COLORS[user.id % AVATAR_COLORS.length] },
  }, initials(user.name));
}

export function timeAgo(iso) {
  if (!iso) return '—';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

export const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
export const fmtDate = (ymd) => (ymd ? new Date(`${ymd}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');
export const today = () => new Date().toISOString().slice(0, 10);

export function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs = ''] = raw.split('?');
  return { path, parts: path.split('/').filter(Boolean), query: Object.fromEntries(new URLSearchParams(qs)) };
}

export const go = (hash) => { location.hash = hash; };
