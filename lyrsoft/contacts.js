// Lyrsoft Contacts (#/contacts, #/contacts/<id>), plugged into app.js like chat.js.
// Everyone's own address book: numbers, emails, social profiles, addresses, birthdays, labels and notes.
// Import from this phone (Contact Picker, Chrome on Android), Google (People API when a Google client
// is configured, otherwise Google's export file), Facebook / Messenger / Instagram, LinkedIn, Telegram,
// Outlook, iCloud and any vCard, CSV or JSON file, or the people you work with in Lyrsoft. Export as
// vCard, Google CSV, Outlook CSV or a Lyrsoft backup, as a download or through the phone's share sheet.
// Parsing and writing those formats lives in contacts-formats.js.
import { GOOGLE_CLIENT_ID } from './config.js';
import {
  fromDeviceContact,
  fromGooglePerson,
  parseContactsFile,
  SOCIAL_NETWORKS,
  socialUrl,
  splitName,
  toGoogleCSV,
  toLyrsoftJSON,
  toOutlookCSV,
  toVCard,
} from './contacts-formats.js';

const SHOWN_MAX = 400; // rows drawn at once; search narrows the rest
const IMPORT_CHUNK = 400;
const LABELS = ['mobile', 'home', 'work', 'main', 'other'];
const SOURCE_NAMES = {
  manual: 'Added here', device: 'This phone', google: 'Google', facebook: 'Facebook', instagram: 'Instagram', linkedin: 'LinkedIn',
  telegram: 'Telegram', outlook: 'Outlook', icloud: 'iCloud', yahoo: 'Yahoo', vcard: 'vCard file', csv: 'CSV file', json: 'JSON file', lyrsoft: 'Lyrsoft team',
};
const AVATAR_COLORS = ['#6c5ce7', '#00a65f', '#e17055', '#0984e3', '#d63031', '#00b894', '#e84393', '#fdab3d', '#2d3436', '#a25ddc'];

export function createContacts({ api, esc, toast, render, go, initial, formatDateTime }) {
  const book = { contacts: null, max: 10000, query: '', filter: 'all', selected: new Set() };
  let route = null;

  const byId = (id) => book.contacts?.find((c) => c.id === id);
  const sortKey = (c) => (c.name || '').toLocaleLowerCase();
  const avatarColor = (name) => AVATAR_COLORS[[...String(name || '')].reduce((h, ch) => (h * 31 + ch.codePointAt(0)) >>> 0, 7) % AVATAR_COLORS.length];
  const avatar = (c, size = '') => `<span class="contact-avatar ${size}" style="background:${avatarColor(c.name)}" aria-hidden="true">${initial(c.name)}</span>`;
  const firstPhone = (c) => c.phones?.[0]?.value || '';
  const waNumber = (c) => (c.socials || []).find((s) => s.network === 'whatsapp' && s.value.replace(/\D/g, '').length >= 7)?.value || firstPhone(c);

  async function reload() {
    const data = await api('GET', '/contacts');
    book.contacts = data.contacts.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    book.max = data.max;
    for (const id of book.selected) if (!byId(id)) book.selected.delete(id);
  }

  async function load(next) {
    route = next;
    if (next.view !== 'contacts') return;
    if (!book.contacts) await reload();
  }

  // ---------------------------------------------------------------- list

  function matches(c, q) {
    if (book.filter === 'favorites' && !c.favorite) return false;
    if (book.filter.startsWith('tag:') && !c.tags.includes(book.filter.slice(4))) return false;
    if (book.filter.startsWith('src:') && !c.sources.includes(book.filter.slice(4))) return false;
    if (!q) return true;
    const digits = q.replace(/\D/g, '');
    const hay = [c.name, c.nickname, c.company, c.title, ...c.emails.map((e) => e.value), ...c.tags, ...c.socials.map((s) => s.value)].join(' ').toLowerCase();
    return hay.includes(q) || (digits.length >= 3 && c.phones.some((p) => p.value.replace(/\D/g, '').includes(digits)));
  }

  const shown = () => book.contacts.filter((c) => matches(c, book.query.trim().toLowerCase()));

  function rowHtml(c) {
    const sub = [c.title && c.company ? `${c.title}, ${c.company}` : c.company || c.title, firstPhone(c) || c.emails[0]?.value].filter(Boolean).join(' · ');
    return `
      <div class="contact-row${route?.id === c.id ? ' current' : ''}">
        <input type="checkbox" data-change="contacts-select" value="${esc(c.id)}"${book.selected.has(c.id) ? ' checked' : ''} aria-label="Select ${esc(c.name)}" />
        <a href="#/contacts/${encodeURIComponent(c.id)}"${route?.id === c.id ? ' aria-current="page"' : ''}>
          ${avatar(c)}
          <span class="contact-row-text"><b>${esc(c.name)}</b><small>${esc(sub) || '&nbsp;'}</small></span>
          ${c.favorite ? '<span class="contact-star" title="Favourite">★</span>' : ''}
        </a>
      </div>`;
  }

  function itemsHtml() {
    const list = shown();
    if (!book.contacts.length) return '<p class="empty-list">No contacts yet. Import them from your phone, Google, Facebook and more, or add one.</p>';
    if (!list.length) return '<p class="empty-list">Nobody matches.</p>';
    let letter = '';
    const rows = list.slice(0, SHOWN_MAX).map((c) => {
      const first = (c.name.trim()[0] || '#').toLocaleUpperCase();
      const head = /\p{L}/u.test(first) ? first : '#';
      const divider = head !== letter && !book.query ? `<p class="contact-letter">${esc(head)}</p>` : '';
      letter = head;
      return divider + rowHtml(c);
    });
    return rows.join('') + (list.length > SHOWN_MAX ? `<p class="muted small contact-more">Showing ${SHOWN_MAX} of ${list.length.toLocaleString()}. Search to find the rest.</p>` : '');
  }

  function bulkHtml() {
    const count = book.selected.size;
    const total = shown().length;
    return count
      ? `<span><b>${count}</b> selected</span>
         <button class="btn small" data-click="contacts-export" data-scope="selected">⬇ Export</button>
         <button class="btn small" data-click="contacts-label-selected">🏷 Label</button>
         <button class="btn small danger" data-click="contacts-delete-selected">Delete</button>
         <button class="btn small ghost" data-click="contacts-clear-selection">Clear</button>`
      : `<label class="check"><input type="checkbox" data-change="contacts-select-all"${total ? '' : ' disabled'} /> Select all</label><span class="muted small">${book.contacts.length.toLocaleString()} contact${book.contacts.length === 1 ? '' : 's'}</span>`;
  }

  function filterOptions() {
    const tags = [...new Set(book.contacts.flatMap((c) => c.tags))].sort();
    const sources = [...new Set(book.contacts.flatMap((c) => c.sources))].sort();
    const option = (value, label) => `<option value="${esc(value)}"${book.filter === value ? ' selected' : ''}>${esc(label)}</option>`;
    return [
      option('all', 'All contacts'),
      option('favorites', '★ Favourites'),
      tags.length ? `<optgroup label="Labels">${tags.map((t) => option(`tag:${t}`, t)).join('')}</optgroup>` : '',
      sources.length ? `<optgroup label="Came from">${sources.map((s) => option(`src:${s}`, SOURCE_NAMES[s] || s)).join('')}</optgroup>` : '',
    ].join('');
  }

  function patchList() {
    const items = document.querySelector('.contacts-items');
    if (items) items.innerHTML = itemsHtml();
    const bulk = document.querySelector('.contacts-bulk');
    if (bulk) bulk.innerHTML = bulkHtml();
  }

  // ---------------------------------------------------------------- detail

  const labelOf = (l) => (l ? `<span class="muted small">${esc(l)}</span>` : '');

  function detailHtml(c) {
    const phone = firstPhone(c);
    const email = c.emails[0]?.value;
    const wa = waNumber(c);
    const actions = [
      phone && `<a class="contact-action" href="tel:${esc(phone.replace(/[^\d+#*,;]/g, ''))}"><span>📞</span>Call</a>`,
      phone && `<a class="contact-action" href="sms:${esc(phone.replace(/[^\d+]/g, ''))}"><span>💬</span>Text</a>`,
      wa && wa.replace(/\D/g, '').length >= 7 && `<a class="contact-action" href="${esc(socialUrl({ network: 'whatsapp', value: wa }))}" target="_blank" rel="noopener"><span>🟢</span>WhatsApp</a>`,
      email && `<a class="contact-action" href="mailto:${esc(email)}"><span>✉</span>Email</a>`,
    ].filter(Boolean).join('');
    const section = (title, body) => (body ? `<section class="contact-section"><h3>${title}</h3>${body}</section>` : '');
    const socials = c.socials.map((s) => {
      const net = SOCIAL_NETWORKS[s.network] || SOCIAL_NETWORKS.other;
      const url = socialUrl(s);
      const shownValue = esc(s.value.replace(/^https?:\/\/(www\.)?/i, ''));
      return `<li><span class="social-icon net-${esc(s.network)}" aria-hidden="true">${net.icon}</span><span><small class="muted">${esc(net.label)}</small>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${shownValue}</a>` : `<span>${shownValue}</span>`}</span></li>`;
    }).join('');
    return `
      <header class="contact-head">
        <a class="btn ghost small back-to-list" href="#/contacts">←</a>
        ${avatar(c, 'big')}
        <div>
          <h2>${esc(c.name)} ${c.favorite ? '<span class="contact-star">★</span>' : ''}</h2>
          ${c.title || c.company ? `<p class="muted">${esc([c.title, c.company].filter(Boolean).join(' · '))}</p>` : ''}
          ${c.nickname && c.nickname !== c.name ? `<p class="muted small">“${esc(c.nickname)}”</p>` : ''}
        </div>
      </header>
      ${actions ? `<div class="contact-actions">${actions}</div>` : ''}
      <div class="contact-tools">
        <button class="btn small" data-click="contacts-edit" data-id="${esc(c.id)}">✎ Edit</button>
        <button class="btn small" data-click="contacts-favorite" data-id="${esc(c.id)}">${c.favorite ? '☆ Unfavourite' : '★ Favourite'}</button>
        <button class="btn small" data-click="contacts-share-one" data-id="${esc(c.id)}">↗ Share</button>
        <button class="btn small ghost danger" data-click="contacts-delete" data-id="${esc(c.id)}">Delete</button>
      </div>
      ${section('Phone', c.phones.length ? `<ul class="contact-values">${c.phones.map((p) => `<li><a href="tel:${esc(p.value.replace(/[^\d+#*,;]/g, ''))}">${esc(p.value)}</a>${labelOf(p.label)}</li>`).join('')}</ul>` : '')}
      ${section('Email', c.emails.length ? `<ul class="contact-values">${c.emails.map((e) => `<li><a href="mailto:${esc(e.value)}">${esc(e.value)}</a>${labelOf(e.label)}</li>`).join('')}</ul>` : '')}
      ${section('Social', socials ? `<ul class="contact-values social">${socials}</ul>` : '')}
      ${section('Websites', c.websites.length ? `<ul class="contact-values">${c.websites.map((w) => `<li><a href="${esc(/^[a-z]+:/i.test(w) ? w : `https://${w}`)}" target="_blank" rel="noopener">${esc(w)}</a></li>`).join('')}</ul>` : '')}
      ${section('Address', c.addresses.length ? `<ul class="contact-values">${c.addresses.map((a) => `<li><a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(a.value)}" target="_blank" rel="noopener">${esc(a.value)}</a>${labelOf(a.label)}</li>`).join('')}</ul>` : '')}
      ${section('Birthday', c.birthday ? `<p>${esc(formatBirthday(c.birthday))}</p>` : '')}
      ${section('Labels', c.tags.length ? `<p class="contact-tags">${c.tags.map((t) => `<button class="chip" data-click="contacts-filter-tag" data-tag="${esc(t)}">${esc(t)}</button>`).join('')}</p>` : '')}
      ${section('Notes', c.notes ? `<p class="contact-notes">${esc(c.notes)}</p>` : '')}
      <p class="muted small contact-meta">From ${c.sources.map((s) => esc(SOURCE_NAMES[s] || s)).join(', ')} · added ${esc(formatDateTime(c.createdAt))}${c.updatedAt !== c.createdAt ? ` · updated ${esc(formatDateTime(c.updatedAt))}` : ''}</p>`;
  }

  function formatBirthday(b) {
    const noYear = b.startsWith('--');
    const date = new Date(`${noYear ? '2000' : b.slice(0, 4)}-${b.slice(-5)}T00:00:00`);
    return date.toLocaleDateString(undefined, noYear ? { month: 'long', day: 'numeric' } : { year: 'numeric', month: 'long', day: 'numeric' });
  }

  // ---------------------------------------------------------------- page

  function view() {
    const current = route.id && byId(route.id);
    return `
      <div class="page-head">
        <div><h1>Contacts</h1><p>Your own address book. Bring in contacts from your phone, Google, Facebook and more, and send them anywhere.</p></div>
        <div class="page-actions">
          <button class="btn primary" data-click="contacts-new">+ New contact</button>
          <button class="btn" data-click="contacts-import">⬆ Import</button>
          <button class="btn" data-click="contacts-export" data-scope="all"${book.contacts.length ? '' : ' disabled'}>⬇ Export</button>
          <button class="btn ghost" data-click="contacts-duplicates"${book.contacts.length > 1 ? '' : ' disabled'}>Merge duplicates</button>
        </div>
      </div>
      <div class="contacts-layout${route.id ? ' has-detail' : ''}">
        <aside class="contacts-list" aria-label="Contacts">
          <div class="contacts-tools">
            <input type="search" class="contacts-search" data-input="contacts-search" value="${esc(book.query)}" placeholder="Search name, number, email, label…" aria-label="Search contacts" />
            <select data-change="contacts-filter" aria-label="Show">${filterOptions()}</select>
          </div>
          <div class="contacts-bulk">${bulkHtml()}</div>
          <div class="contacts-items">${itemsHtml()}</div>
        </aside>
        <section class="contact-detail" aria-label="Contact">
          ${current ? detailHtml(current) : route.id ? '<p class="empty-list">This contact was deleted.</p>' : '<div class="empty-list"><span aria-hidden="true" class="contacts-empty-icon">📇</span><p>Pick a contact, or import your address book.</p></div>'}
        </section>
      </div>`;
  }

  // ---------------------------------------------------------------- dialogs

  function openDialog(html, { wide = true, setup } = {}) {
    return new Promise((resolve) => {
      const node = document.createElement('dialog');
      node.className = `dialog${wide ? ' wide' : ''} contacts-dialog`;
      node.innerHTML = html;
      document.body.append(node);
      let result = null;
      const done = (value) => {
        result = value;
        node.close();
      };
      node.addEventListener('close', () => {
        node.remove();
        resolve(result);
      });
      node.addEventListener('click', (event) => {
        if (event.target.closest('[data-dialog-close]')) done(null);
      });
      setup?.(node, done);
      node.showModal();
    });
  }

  const labelSelect = (name, value) => `
    <select name="${name}" aria-label="Label">
      ${[...new Set([...LABELS, value].filter(Boolean))].map((l) => `<option value="${esc(l)}"${l === value ? ' selected' : ''}>${esc(l)}</option>`).join('')}
      <option value=""${value ? '' : ' selected'}>no label</option>
    </select>`;
  const networkSelect = (value) => `<select name="social-network" aria-label="Network">${Object.entries(SOCIAL_NETWORKS).map(([k, n]) => `<option value="${k}"${k === value ? ' selected' : ''}>${esc(n.label)}</option>`).join('')}</select>`;
  const ROWS = {
    phone: (v = {}) => `<div class="multi-row">${labelSelect('phone-label', v.label || 'mobile')}<input name="phone" type="tel" value="${esc(v.value || '')}" placeholder="+880 1712-345678" autocomplete="off" /><button type="button" class="icon-btn" data-remove-row aria-label="Remove">✕</button></div>`,
    email: (v = {}) => `<div class="multi-row">${labelSelect('email-label', v.label || '')}<input name="email" type="email" value="${esc(v.value || '')}" placeholder="name@example.com" autocomplete="off" /><button type="button" class="icon-btn" data-remove-row aria-label="Remove">✕</button></div>`,
    social: (v = {}) => `<div class="multi-row">${networkSelect(v.network || 'whatsapp')}<input name="social" value="${esc(v.value || '')}" placeholder="Number, @handle or profile link" autocomplete="off" /><button type="button" class="icon-btn" data-remove-row aria-label="Remove">✕</button></div>`,
    address: (v = {}) => `<div class="multi-row">${labelSelect('address-label', v.label || 'home')}<input name="address" value="${esc(v.value || '')}" placeholder="Street, city, country" autocomplete="off" /><button type="button" class="icon-btn" data-remove-row aria-label="Remove">✕</button></div>`,
    website: (v = '') => `<div class="multi-row"><input name="website" type="url" value="${esc(v)}" placeholder="https://" autocomplete="off" /><button type="button" class="icon-btn" data-remove-row aria-label="Remove">✕</button></div>`,
  };

  async function editContact(existing) {
    const c = existing || { name: '', given: '', family: '', nickname: '', company: '', title: '', emails: [], phones: [], socials: [], addresses: [], websites: [], birthday: '', notes: '', tags: [], favorite: false };
    const [given, family] = c.given || c.family ? [c.given, c.family] : splitName(c.name);
    const group = (kind, title, values, empty, one) => `
      <fieldset class="multi" data-kind="${kind}"><legend>${title}</legend>
        <div class="multi-rows">${(values.length ? values : empty ? [undefined] : []).map((v) => ROWS[kind](v)).join('')}</div>
        <button type="button" class="btn small ghost" data-add-row="${kind}">+ Add ${one}</button>
      </fieldset>`;
    return openDialog(`
      <form class="contact-form">
        <h2>${existing ? 'Edit contact' : 'New contact'}</h2>
        <div class="form-grid">
          <label>First name<input name="given" value="${esc(given)}" maxlength="100" autocomplete="off" /></label>
          <label>Last name<input name="family" value="${esc(family)}" maxlength="100" autocomplete="off" /></label>
          <label>Company<input name="company" value="${esc(c.company)}" maxlength="150" autocomplete="off" /></label>
          <label>Job title<input name="title" value="${esc(c.title)}" maxlength="150" autocomplete="off" /></label>
          <label>Nickname<input name="nickname" value="${esc(c.nickname)}" maxlength="100" autocomplete="off" /></label>
          <label>Birthday<input name="birthday" value="${esc(c.birthday)}" placeholder="YYYY-MM-DD or --MM-DD" pattern="(\\d{4}|-)-\\d{2}-\\d{2}" autocomplete="off" /></label>
        </div>
        ${group('phone', 'Phones', c.phones, true, 'phone')}
        ${group('email', 'Emails', c.emails, true, 'email')}
        ${group('social', 'Social profiles', c.socials, false, 'profile')}
        ${group('address', 'Addresses', c.addresses, false, 'address')}
        ${group('website', 'Websites', c.websites, false, 'website')}
        <label>Labels<input name="tags" value="${esc(c.tags.join(', '))}" placeholder="Family, Clients, VIP" autocomplete="off" /></label>
        <label>Notes<textarea name="notes" rows="3" maxlength="4000">${esc(c.notes)}</textarea></label>
        <label class="check"><input type="checkbox" name="favorite"${c.favorite ? ' checked' : ''} /> Favourite</label>
        <p class="auth-error" hidden></p>
        <div class="row end"><button type="button" class="btn" data-dialog-close>Cancel</button><button class="btn primary">${existing ? 'Save' : 'Add contact'}</button></div>
      </form>`, {
      setup(node, done) {
        const form = node.querySelector('form');
        node.addEventListener('click', (event) => {
          const add = event.target.closest('[data-add-row]');
          if (add) {
            const rows = add.previousElementSibling;
            rows.insertAdjacentHTML('beforeend', ROWS[add.dataset.addRow]());
            rows.lastElementChild.querySelector('input')?.focus();
          }
          event.target.closest('[data-remove-row]')?.closest('.multi-row').remove();
        });
        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          const rows = (kind) => [...form.querySelectorAll(`[data-kind="${kind}"] .multi-row`)];
          const pair = (kind, labelName) => rows(kind).map((r) => ({ value: r.querySelector(`input[name="${kind}"]`).value.trim(), label: r.querySelector(`[name="${labelName}"]`)?.value || '' })).filter((x) => x.value);
          const data = new FormData(form);
          const g = String(data.get('given')).trim();
          const f = String(data.get('family')).trim();
          const body = {
            name: `${g} ${f}`.trim(),
            given: g,
            family: f,
            company: data.get('company'),
            title: data.get('title'),
            nickname: data.get('nickname'),
            birthday: String(data.get('birthday')).trim(),
            phones: pair('phone', 'phone-label'),
            emails: pair('email', 'email-label'),
            addresses: pair('address', 'address-label'),
            socials: rows('social').map((r) => ({ network: r.querySelector('[name="social-network"]').value, value: r.querySelector('input[name="social"]').value.trim() })).filter((s) => s.value),
            websites: rows('website').map((r) => r.querySelector('input').value.trim()).filter(Boolean),
            tags: String(data.get('tags')).split(',').map((t) => t.trim()).filter(Boolean),
            notes: data.get('notes'),
            favorite: data.get('favorite') === 'on',
          };
          const button = form.querySelector('button.primary');
          button.disabled = true;
          try {
            const { contact } = existing
              ? await api('PATCH', `/contacts/${encodeURIComponent(existing.id)}`, body)
              : await api('POST', '/contacts', { contact: body });
            done(contact);
          } catch (error) {
            const node2 = form.querySelector('.auth-error');
            node2.textContent = error.message;
            node2.hidden = false;
            button.disabled = false;
          }
        });
        setTimeout(() => form.querySelector('input[name="given"]').focus());
      },
    });
  }

  // ---------------------------------------------------------------- import

  const hasPicker = () => 'contacts' in navigator && 'select' in navigator.contacts;

  async function sendImport(contacts, source, progress) {
    const totals = { created: 0, updated: 0, unchanged: 0, skipped: 0, full: false };
    for (let i = 0; i < contacts.length; i += IMPORT_CHUNK) {
      progress?.(i, contacts.length);
      const result = await api('POST', '/contacts/import', { contacts: contacts.slice(i, i + IMPORT_CHUNK), source });
      for (const k of ['created', 'updated', 'unchanged', 'skipped']) totals[k] += result[k];
      totals.full ||= result.full;
    }
    progress?.(contacts.length, contacts.length);
    return totals;
  }

  const summary = (t) =>
    [t.created && `${t.created.toLocaleString()} added`, t.updated && `${t.updated.toLocaleString()} updated with new details`, t.unchanged && `${t.unchanged.toLocaleString()} already here`, t.skipped && `${t.skipped.toLocaleString()} skipped`].filter(Boolean).join(', ') || 'Nothing new';

  async function loadScript(src) {
    if (document.querySelector(`script[src="${src}"]`)) return;
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Couldn’t reach Google. Check your connection.'));
      document.head.append(s);
    });
  }

  // Google People API through Google Identity Services: the person picks their Google account and
  // allows read-only access to their contacts; the token stays in this tab.
  async function fetchGoogleContacts(onPage) {
    await loadScript('https://accounts.google.com/gsi/client');
    const token = await new Promise((resolve, reject) => {
      const client = window.google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: 'https://www.googleapis.com/auth/contacts.readonly',
        callback: (response) => (response.error ? reject(new Error('Google didn’t allow access to your contacts.')) : resolve(response.access_token)),
        error_callback: () => reject(new Error('Google sign-in was closed.')),
      });
      client.requestAccessToken();
    });
    const people = [];
    let pageToken = '';
    do {
      const url = new URL('https://people.googleapis.com/v1/people/me/connections');
      url.searchParams.set('personFields', 'names,nicknames,emailAddresses,phoneNumbers,organizations,addresses,birthdays,urls,biographies,imClients');
      url.searchParams.set('pageSize', '1000');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(`Google Contacts said no (${response.status}).`);
      const data = await response.json();
      people.push(...(data.connections || []));
      onPage?.(people.length);
      pageToken = data.nextPageToken || '';
    } while (pageToken);
    window.google.accounts.oauth2.revoke?.(token, () => {});
    return people.map(fromGooglePerson).filter(Boolean);
  }

  const SOURCES_HELP = {
    google: GOOGLE_CLIENT_ID
      ? ''
      : `<ol><li>Open <a href="https://contacts.google.com/" target="_blank" rel="noopener">contacts.google.com</a> and pick <b>Export</b> (left menu, or ⋮ on a phone).</li><li>Choose <b>vCard</b> or <b>Google CSV</b> and download.</li><li>Choose that file below.</li></ol>`,
    meta: `<p>Meta doesn’t let other apps read Facebook, Messenger, Instagram or WhatsApp contacts directly. Download them instead:</p>
      <ol><li>Open <a href="https://accountscenter.facebook.com/info_and_permissions/dyi/" target="_blank" rel="noopener">Accounts Center → Download your information</a>.</li>
      <li>Pick your Facebook or Instagram account, choose <b>Connections</b> (friends, followers, uploaded contacts), format <b>JSON</b>.</li>
      <li>When the download is ready, unzip it and choose files like <code>your_friends.json</code>, <code>following.json</code> or <code>your_uploaded_contacts.json</code> below.</li></ol>
      <p class="muted small">WhatsApp uses your phone’s contacts, so import those from <b>This phone</b>.</p>`,
    linkedin: `<ol><li>LinkedIn → <a href="https://www.linkedin.com/mypreferences/d/download-my-data" target="_blank" rel="noopener">Settings → Data privacy → Get a copy of your data</a>.</li><li>Tick <b>Connections</b> and request the archive.</li><li>Choose <code>Connections.csv</code> below.</li></ol>`,
    phone: `<p>Your browser can’t open the phone’s address book directly (that works in Chrome on Android). Export it as a file instead:</p>
      <ul><li><b>Android:</b> Contacts app → ⋮ or Settings → <b>Export</b> → .vcf file.</li>
      <li><b>iPhone:</b> Contacts → Lists → long-press <b>All Contacts</b> → <b>Export</b>. Or on a computer, <a href="https://www.icloud.com/contacts" target="_blank" rel="noopener">icloud.com/contacts</a> → select all → Export vCard.</li></ul>`,
    others: `<ul><li><b>Outlook / Microsoft:</b> <a href="https://outlook.live.com/people/" target="_blank" rel="noopener">People</a> → Manage contacts → Export contacts (CSV).</li>
      <li><b>Telegram:</b> Telegram Desktop → Settings → Advanced → Export Telegram data → Contacts list, format JSON → <code>result.json</code>.</li>
      <li><b>Yahoo:</b> Contacts → ⋯ → Export (CSV).</li>
      <li><b>Any spreadsheet</b> with columns like Name, Phone, Email, Company, Instagram… saved as CSV.</li></ul>`,
  };

  async function importDialog() {
    let pending = null; // { contacts, source, label }
    await openDialog(`
      <div class="import-dialog">
        <div class="row spread"><h2>Import contacts</h2><button type="button" class="icon-btn" data-dialog-close aria-label="Close">✕</button></div>
        <div class="import-step" data-step="pick">
          <div class="import-sources">
            <button type="button" class="import-source" data-source="phone"><span class="import-icon">📱</span><b>This phone</b><small>${hasPicker() ? 'Pick contacts from your address book' : 'From your phone’s Contacts app'}</small></button>
            <button type="button" class="import-source" data-source="google"><span class="import-icon g">G</span><b>Google</b><small>${GOOGLE_CLIENT_ID ? 'Connect your Google account' : 'Google Contacts export'}</small></button>
            <button type="button" class="import-source" data-source="meta"><span class="import-icon f">f</span><b>Facebook · Instagram</b><small>Friends, followers, Messenger contacts</small></button>
            <button type="button" class="import-source" data-source="linkedin"><span class="import-icon in">in</span><b>LinkedIn</b><small>Your connections</small></button>
            <button type="button" class="import-source" data-source="team"><span class="import-icon">👥</span><b>Lyrsoft team</b><small>Everyone you work with here</small></button>
            <button type="button" class="import-source" data-source="others"><span class="import-icon">⋯</span><b>Outlook, iCloud, Telegram…</b><small>Any vCard, CSV or JSON</small></button>
          </div>
          <div class="import-help" hidden></div>
          <label class="import-drop">
            <input type="file" multiple accept=".vcf,.vcard,.csv,.json,.txt,text/vcard,text/x-vcard,text/csv,application/json" hidden />
            <span>📂 <b>Choose files</b> or drop them here</span>
            <small class="muted">vCard (.vcf), CSV or JSON, from any app, phone or service</small>
          </label>
        </div>
        <div class="import-step" data-step="preview" hidden></div>
        <p class="auth-error" hidden></p>
      </div>`, {
      setup(node, done) {
        const help = node.querySelector('.import-help');
        const error = node.querySelector('.auth-error');
        const showError = (message) => {
          error.textContent = message;
          error.hidden = !message;
        };
        const step = (name) => node.querySelectorAll('.import-step').forEach((s) => (s.hidden = s.dataset.step !== name));
        const preview = node.querySelector('[data-step="preview"]');

        const showPreview = (contacts, source, label) => {
          showError('');
          if (!contacts.length) return showError(`No contacts found in ${label}.`);
          pending = { contacts, source, label };
          const withPhone = contacts.filter((c) => c.phones.length).length;
          const withEmail = contacts.filter((c) => c.emails.length).length;
          const withSocial = contacts.filter((c) => c.socials.length).length;
          preview.innerHTML = `
            <p><b>${contacts.length.toLocaleString()}</b> contact${contacts.length === 1 ? '' : 's'} found in ${esc(label)}.</p>
            <p class="muted small">${withPhone.toLocaleString()} with a phone · ${withEmail.toLocaleString()} with an email · ${withSocial.toLocaleString()} with social profiles</p>
            <ul class="import-sample">${contacts.slice(0, 6).map((c) => `<li>${avatar(c)}<span><b>${esc(c.name)}</b><small>${esc(c.phones[0]?.value || c.emails[0]?.value || (c.socials[0] ? SOCIAL_NETWORKS[c.socials[0].network]?.label : '') || '')}</small></span></li>`).join('')}${contacts.length > 6 ? `<li class="muted small">…and ${(contacts.length - 6).toLocaleString()} more</li>` : ''}</ul>
            <p class="muted small">People already in your contacts (same phone or email) get the new details added; nothing is overwritten.</p>
            <div class="import-progress" hidden><progress max="1" value="0"></progress><span></span></div>
            <div class="row end"><button type="button" class="btn" data-import-back>Back</button><button type="button" class="btn primary" data-import-go>Import ${contacts.length.toLocaleString()}</button></div>`;
          step('preview');
        };

        const readFiles = async (files) => {
          showError('');
          const found = [];
          const names = [];
          for (const file of files) {
            if (file.size > 30 * 1024 * 1024) {
              showError(`${file.name} is too big (30 MB at most).`);
              continue;
            }
            const { contacts } = parseContactsFile(file.name, await file.text());
            found.push(...contacts);
            names.push(file.name);
          }
          if (names.length) showPreview(found, null, names.length === 1 ? names[0] : `${names.length} files`);
        };

        const input = node.querySelector('input[type="file"]');
        input.addEventListener('change', () => readFiles([...input.files]));
        const drop = node.querySelector('.import-drop');
        drop.addEventListener('dragover', (event) => {
          event.preventDefault();
          drop.classList.add('drop');
        });
        drop.addEventListener('dragleave', () => drop.classList.remove('drop'));
        drop.addEventListener('drop', (event) => {
          event.preventDefault();
          drop.classList.remove('drop');
          readFiles([...event.dataTransfer.files]);
        });

        node.addEventListener('click', async (event) => {
          const pick = event.target.closest('[data-source]');
          if (pick) {
            showError('');
            node.querySelectorAll('.import-source').forEach((b) => b.classList.toggle('active', b === pick));
            const source = pick.dataset.source;
            help.hidden = true;
            try {
              if (source === 'phone' && hasPicker()) {
                const props = await navigator.contacts.getProperties();
                const entries = await navigator.contacts.select(['name', 'email', 'tel', ...(props.includes('address') ? ['address'] : [])], { multiple: true });
                return showPreview(entries.map(fromDeviceContact).filter(Boolean), 'device', 'your phone');
              }
              if (source === 'google' && GOOGLE_CLIENT_ID) {
                pick.querySelector('small').textContent = 'Connecting…';
                const contacts = await fetchGoogleContacts((n) => (pick.querySelector('small').textContent = `${n.toLocaleString()} read…`));
                pick.querySelector('small').textContent = 'Connect your Google account';
                return showPreview(contacts, 'google', 'your Google account');
              }
              if (source === 'team') {
                const { contacts = [] } = await api('GET', '/chat');
                return showPreview(contacts.map((p) => ({ name: p.name || p.email, emails: [{ value: p.email, label: 'work' }], phones: [], socials: [], tags: ['Lyrsoft'] })), 'lyrsoft', 'your Lyrsoft workspaces');
              }
              help.innerHTML = SOURCES_HELP[source] || '';
              help.hidden = !help.innerHTML;
            } catch (err) {
              if (err?.name !== 'AbortError' && err?.name !== 'InvalidStateError') showError(err.message || String(err));
            }
            return;
          }
          if (event.target.closest('[data-import-back]')) return step('pick');
          const go2 = event.target.closest('[data-import-go]');
          if (go2 && pending) {
            go2.disabled = true;
            node.querySelector('[data-import-back]').disabled = true;
            const bar = preview.querySelector('.import-progress');
            bar.hidden = false;
            try {
              const totals = await sendImport(pending.contacts, pending.source, (doneCount, total) => {
                bar.querySelector('progress').value = total ? doneCount / total : 1;
                bar.querySelector('span').textContent = `${doneCount.toLocaleString()} of ${total.toLocaleString()}`;
              });
              await reload();
              toast(`Import finished: ${summary(totals)}.${totals.full ? ' Your address book is full.' : ''}`);
              done(totals);
            } catch (err) {
              await reload().catch(() => {});
              showError(`${err.message} Contacts sent before this were saved; importing again won’t duplicate them.`);
              go2.disabled = false;
              node.querySelector('[data-import-back]').disabled = false;
            }
          }
        });
      },
    });
    render();
  }

  // ---------------------------------------------------------------- export

  const FORMATS = {
    vcf: { label: 'vCard (.vcf)', hint: 'Phones (Android, iPhone), Google, iCloud, Outlook, WhatsApp and Telegram via your phone', ext: 'vcf', type: 'text/vcard', make: toVCard },
    google: { label: 'Google CSV', hint: 'contacts.google.com → Import', ext: 'csv', type: 'text/csv', make: toGoogleCSV },
    outlook: { label: 'Outlook CSV', hint: 'Outlook / Microsoft 365 / Hotmail → People → Import contacts, and Excel', ext: 'csv', type: 'text/csv', make: toOutlookCSV },
    json: { label: 'Lyrsoft backup (.json)', hint: 'Everything, to import back into Lyrsoft later', ext: 'json', type: 'application/json', make: toLyrsoftJSON },
  };

  function makeFile(list, format) {
    const f = FORMATS[format];
    const stamp = new Date().toISOString().slice(0, 10);
    const base = list.length === 1 ? list[0].name.replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || 'contact' : `lyrsoft-contacts-${stamp}`;
    const name = `${base}${format === 'google' ? '-google' : format === 'outlook' ? '-outlook' : ''}.${f.ext}`;
    return new File([f.make(list)], name, { type: f.type });
  }

  function download(file) {
    const url = URL.createObjectURL(file);
    const a = Object.assign(document.createElement('a'), { href: url, download: file.name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  const canShareFile = (file) => Boolean(navigator.canShare?.({ files: [file] }));

  async function shareFile(file, title) {
    try {
      await navigator.share({ files: [file], title });
      return true;
    } catch (error) {
      if (error.name === 'AbortError') return true;
      return false;
    }
  }

  async function exportDialog(scope) {
    const lists = { all: book.contacts, shown: shown(), selected: book.contacts.filter((c) => book.selected.has(c.id)) };
    const initialScope = scope === 'selected' && lists.selected.length ? 'selected' : 'all';
    const probe = new File(['x'], 'x.vcf', { type: 'text/vcard' });
    await openDialog(`
      <form class="export-dialog">
        <div class="row spread"><h2>Export contacts</h2><button type="button" class="icon-btn" data-dialog-close aria-label="Close">✕</button></div>
        <fieldset class="choice"><legend>Which contacts</legend>
          <label class="check"><input type="radio" name="scope" value="all"${initialScope === 'all' ? ' checked' : ''} /> All (${lists.all.length.toLocaleString()})</label>
          ${lists.shown.length !== lists.all.length ? `<label class="check"><input type="radio" name="scope" value="shown" /> Shown by the search or filter (${lists.shown.length.toLocaleString()})</label>` : ''}
          ${lists.selected.length ? `<label class="check"><input type="radio" name="scope" value="selected"${initialScope === 'selected' ? ' checked' : ''} /> Selected (${lists.selected.length.toLocaleString()})</label>` : ''}
        </fieldset>
        <fieldset class="choice"><legend>Format</legend>
          ${Object.entries(FORMATS).map(([k, f], i) => `<label class="check format"><input type="radio" name="format" value="${k}"${i === 0 ? ' checked' : ''} /><span><b>${f.label}</b><small class="muted">${f.hint}</small></span></label>`).join('')}
        </fieldset>
        <details class="export-help"><summary>How to add them to other apps</summary>
          <ul>
            <li><b>Android / iPhone:</b> share or open the .vcf file and choose Contacts → Import / Add all.</li>
            <li><b>WhatsApp, Telegram, Viber, Signal:</b> they use your phone’s contacts, so add the .vcf to your phone.</li>
            <li><b>Facebook, Messenger, Instagram:</b> add them to your phone, then turn on <i>Upload contacts</i> / <i>Sync contacts</i> in the app’s settings.</li>
            <li><b>Google:</b> <a href="https://contacts.google.com/" target="_blank" rel="noopener">contacts.google.com</a> → Import → the .vcf or Google CSV.</li>
            <li><b>iCloud:</b> <a href="https://www.icloud.com/contacts" target="_blank" rel="noopener">icloud.com/contacts</a> → ⚙ → Import vCard.</li>
            <li><b>Outlook:</b> People → Manage contacts → Import contacts → the Outlook CSV.</li>
          </ul>
        </details>
        <div class="row end">
          ${canShareFile(probe) ? '<button type="button" class="btn" data-export="share">↗ Share</button>' : ''}
          <button type="button" class="btn primary" data-export="download">⬇ Download</button>
        </div>
      </form>`, {
      setup(node, done) {
        node.addEventListener('click', async (event) => {
          const action = event.target.closest('[data-export]')?.dataset.export;
          if (!action) return;
          const form = node.querySelector('form');
          const list = lists[form.scope.value] || lists.all;
          if (!list.length) return toast('No contacts to export.');
          const file = makeFile(list, form.format.value);
          if (action === 'share' && (await shareFile(file, 'Contacts'))) return done(true);
          download(file);
          toast(`Saved ${file.name} (${list.length.toLocaleString()} contact${list.length === 1 ? '' : 's'})`);
          done(true);
        });
      },
    });
  }

  // ---------------------------------------------------------------- duplicates

  async function duplicatesDialog() {
    const { groups } = await api('GET', '/contacts/duplicates');
    if (!groups.length) return toast('No duplicates found.');
    const describe = (c) => esc([c.phones[0]?.value, c.emails[0]?.value, SOURCE_NAMES[c.sources[0]]].filter(Boolean).join(' · '));
    await openDialog(`
      <div class="dupes-dialog">
        <div class="row spread"><h2>${groups.length} possible duplicate${groups.length === 1 ? '' : 's'}</h2><button type="button" class="icon-btn" data-dialog-close aria-label="Close">✕</button></div>
        <p class="muted small">These share a phone number, email or name. Merging keeps every number, email and profile, and the first name shown.</p>
        <div class="dupes-list">
          ${groups.map((ids, i) => `
            <div class="dupe-group" data-group="${i}">
              <ul>${ids.map((id) => byId(id)).filter(Boolean).map((c) => `<li>${avatar(c)}<span><b>${esc(c.name)}</b><small>${describe(c)}</small></span></li>`).join('')}</ul>
              <button type="button" class="btn small" data-merge="${i}">Merge</button>
            </div>`).join('')}
        </div>
        <div class="row end"><button type="button" class="btn" data-dialog-close>Done</button><button type="button" class="btn primary" data-merge-all>Merge all</button></div>
      </div>`, {
      setup(node) {
        const merge = async (i) => {
          const box = node.querySelector(`[data-group="${i}"]`);
          if (!box || box.classList.contains('merged')) return;
          box.querySelector('button').disabled = true;
          await api('POST', '/contacts/merge', { ids: groups[i] });
          box.classList.add('merged');
          box.querySelector('button').textContent = 'Merged ✓';
        };
        node.addEventListener('click', async (event) => {
          try {
            const one = event.target.closest('[data-merge]');
            if (one) await merge(Number(one.dataset.merge));
            if (event.target.closest('[data-merge-all]')) {
              event.target.disabled = true;
              for (let i = 0; i < groups.length; i += 1) await merge(i);
              toast('Duplicates merged');
            }
          } catch (error) {
            toast(error.message);
          }
        });
      },
    });
    await reload();
    render();
  }

  // ---------------------------------------------------------------- actions

  async function deleteIds(ids) {
    for (let i = 0; i < ids.length; i += 1000) await api('POST', '/contacts/delete', { ids: ids.slice(i, i + 1000) });
    for (const id of ids) book.selected.delete(id);
    await reload();
  }

  async function patchContact(c, changes) {
    const { contact } = await api('PATCH', `/contacts/${encodeURIComponent(c.id)}`, changes);
    Object.assign(c, contact);
    return c;
  }

  const clickActions = {
    'contacts-new': async () => {
      const contact = await editContact(null);
      if (!contact) return;
      await reload();
      toast('Contact added');
      go(`#/contacts/${encodeURIComponent(contact.id)}`);
    },
    'contacts-edit': async (target) => {
      const c = byId(target.dataset.id);
      if (!c) return;
      const contact = await editContact(c);
      if (!contact) return;
      Object.assign(c, contact);
      book.contacts.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
      render();
      toast('Saved');
    },
    'contacts-favorite': async (target) => {
      const c = byId(target.dataset.id);
      try {
        await patchContact(c, { favorite: !c.favorite });
        render();
      } catch (error) {
        toast(error.message);
      }
    },
    'contacts-delete': async (target) => {
      const c = byId(target.dataset.id);
      if (!c || !confirm(`Delete ${c.name}?`)) return;
      try {
        await deleteIds([c.id]);
        toast('Contact deleted');
        go('#/contacts');
      } catch (error) {
        toast(error.message);
      }
    },
    'contacts-share-one': async (target) => {
      const c = byId(target.dataset.id);
      const file = makeFile([c], 'vcf');
      if (canShareFile(file) && (await shareFile(file, c.name))) return;
      download(file);
      toast(`Saved ${file.name}: open it to add ${c.name} to another phone or app`);
    },
    'contacts-import': () => importDialog(),
    'contacts-export': (target) => exportDialog(target.dataset.scope),
    'contacts-duplicates': async () => {
      try {
        await duplicatesDialog();
      } catch (error) {
        toast(error.message);
      }
    },
    'contacts-filter-tag': (target) => {
      book.filter = `tag:${target.dataset.tag}`;
      go('#/contacts');
    },
    'contacts-clear-selection': () => {
      book.selected.clear();
      patchList();
    },
    'contacts-delete-selected': async () => {
      const ids = [...book.selected];
      if (!ids.length || !confirm(`Delete ${ids.length} contact${ids.length === 1 ? '' : 's'}? This can’t be undone.`)) return;
      try {
        await deleteIds(ids);
        toast(`Deleted ${ids.length}`);
        if (route.id && !byId(route.id)) go('#/contacts');
        else render();
      } catch (error) {
        toast(error.message);
      }
    },
    'contacts-label-selected': async () => {
      const ids = [...book.selected];
      const tag = await openDialog(`
        <form><h2>Label ${ids.length} contact${ids.length === 1 ? '' : 's'}</h2>
          <label>Label<input name="tag" required maxlength="40" placeholder="e.g. Clients" list="contact-tags" autocomplete="off" /></label>
          <datalist id="contact-tags">${[...new Set(book.contacts.flatMap((c) => c.tags))].map((t) => `<option value="${esc(t)}">`).join('')}</datalist>
          <div class="row end"><button type="button" class="btn" data-dialog-close>Cancel</button><button class="btn primary">Add label</button></div>
        </form>`, {
        wide: false,
        setup(node, done) {
          node.querySelector('form').addEventListener('submit', (event) => {
            event.preventDefault();
            done(node.querySelector('input').value.trim());
          });
        },
      });
      if (!tag) return;
      try {
        const targets = ids.map(byId).filter((c) => c && !c.tags.includes(tag));
        for (let i = 0; i < targets.length; i += 8) await Promise.all(targets.slice(i, i + 8).map((c) => patchContact(c, { tags: [...c.tags, tag] })));
        toast(`Labelled ${ids.length} “${tag}”`);
        render();
      } catch (error) {
        toast(error.message);
        await reload();
        render();
      }
    },
  };

  const changeActions = {
    'contacts-filter': (target) => {
      book.filter = target.value;
      patchList();
    },
    'contacts-select': (target) => {
      if (target.checked) book.selected.add(target.value);
      else book.selected.delete(target.value);
      const bulk = document.querySelector('.contacts-bulk');
      if (bulk) bulk.innerHTML = bulkHtml();
    },
    'contacts-select-all': () => {
      for (const c of shown()) book.selected.add(c.id);
      patchList();
    },
  };

  const inputActions = {
    'contacts-search': (target) => {
      book.query = target.value;
      patchList();
    },
  };

  return {
    load,
    ready: (r) => r.view !== 'contacts' || Boolean(book.contacts),
    view,
    clickActions,
    changeActions,
    inputActions,
    formActions: {},
  };
}
