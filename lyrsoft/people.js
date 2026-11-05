// People pickers shared by Messages (chat.js) and Meetings (meet.js).
//
// pickPeople(): a pop-up with a search box over everyone you work with (tick one or several), and,
// with allowEmail, an "Invite name@example.com" row for an address that isn't in the list yet.
// Resolves to { emails, name } or null.
//
// inviteeField() + attachInviteeField(): an inline field for forms (scheduling a meeting): type a name
// or email and matching people pop up underneath; picked people become removable chips. The chosen
// emails are kept in a hidden input, so the form submits them like a normal field.
const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const initialOf = (text) => esc(String(text || '?').trim()[0]?.toUpperCase() || '?');
const matches = (person, q) => !q || `${person.name || ''} ${person.email}`.toLowerCase().includes(q);

const optionHtml = (c, type) => `
  <label class="person-option" data-email="${esc(c.email)}">
    <input type="${type}" name="email" value="${esc(c.email)}" />
    <span class="avatar small">${initialOf(c.name || c.email)}</span>
    <span><b>${esc(c.name || c.email)}</b><small>${esc(c.email)}</small></span>
  </label>`;

export function pickPeople({ contacts = [], title, multiple = true, askName = false, nameValue = '', submitLabel = 'Done', exclude = [], allowEmail = false, extraHtml = '' }) {
  let people = contacts.filter((c) => !exclude.includes(c.email));
  const type = multiple ? 'checkbox' : 'radio';
  return new Promise((resolve) => {
    const node = document.createElement('dialog');
    node.className = 'dialog wide people-dialog';
    node.innerHTML = `
      <form method="dialog">
        <h2>${esc(title)}</h2>
        ${askName ? `<label>Group name<input name="name" required maxlength="80" value="${esc(nameValue)}" placeholder="e.g. Design team" /></label>` : ''}
        <input type="search" class="people-search" placeholder="${allowEmail ? 'Search people or type an email' : 'Search people'}" aria-label="Search people" autocomplete="off" />
        <p class="people-picked muted small" hidden></p>
        <div class="people-list">
          ${allowEmail ? `<label class="person-option new-email" hidden><input type="${type}" name="email" value="" /><span class="avatar small">＋</span><span><b>Invite <span class="new-address"></span></b><small>Not in your workspaces yet: they’ll get an email</small></span></label>` : ''}
          ${people.map((c) => optionHtml(c, type)).join('')}
          <p class="people-none muted small"${people.length ? ' hidden' : ''}>${allowEmail ? 'Type an email address to invite someone new.' : 'Everyone you work with is already here.'}</p>
        </div>
        ${extraHtml}
        <p class="people-error auth-error" hidden></p>
        <div class="row end"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok">${esc(submitLabel)}</button></div>
      </form>`;
    document.body.append(node);
    const form = node.querySelector('form');
    const search = node.querySelector('.people-search');
    const newRow = node.querySelector('.new-email');
    const picked = () => [...form.querySelectorAll('input[name="email"]:checked')].map((i) => i.value).filter(Boolean);

    const showCount = () => {
      const count = picked().length;
      const label = node.querySelector('.people-picked');
      label.hidden = !multiple || !count;
      label.textContent = `${count} selected`;
    };

    // Filter as you type; a full email that isn't listed becomes an "Invite …" row.
    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      let shown = 0;
      for (const option of node.querySelectorAll('.person-option:not(.new-email)')) {
        const person = people.find((c) => c.email === option.dataset.email);
        option.hidden = !matches(person, q);
        if (!option.hidden) shown += 1;
      }
      const typedEmail = allowEmail && EMAIL_RE.test(q) && !people.some((c) => c.email === q) && !exclude.includes(q);
      if (newRow) {
        newRow.hidden = !typedEmail;
        newRow.querySelector('.new-address').textContent = q;
        newRow.querySelector('input').value = typedEmail ? q : '';
      }
      node.querySelector('.people-none').hidden = shown > 0 || typedEmail;
    });

    // Enter in the search box picks the first match (or the typed email) instead of submitting.
    search.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const first = [...node.querySelectorAll('.person-option')].find((o) => !o.hidden);
      if (!first) return;
      const input = first.querySelector('input');
      if (newRow && first === newRow) {
        // Keep the typed address as a normal, ticked row so the search can move on.
        const person = { email: input.value, name: '' };
        people = [person, ...people];
        newRow.insertAdjacentHTML('afterend', optionHtml(person, type));
        newRow.nextElementSibling.querySelector('input').checked = true;
        newRow.hidden = true;
      } else input.checked = multiple ? !input.checked : true;
      search.value = '';
      search.dispatchEvent(new Event('input'));
      showCount();
    });
    form.addEventListener('change', showCount);

    form.addEventListener('submit', (event) => {
      if (event.submitter?.value !== 'ok') return;
      if (!picked().length) {
        event.preventDefault();
        const error = node.querySelector('.people-error');
        error.textContent = multiple ? 'Pick at least one person.' : 'Pick someone.';
        error.hidden = false;
      }
    });
    node.addEventListener('close', () => {
      const result = node.returnValue === 'ok' ? { emails: [...new Set(picked())], name: form.querySelector('input[name="name"]')?.value || '' } : null;
      node.remove();
      resolve(result);
    });
    node.showModal();
    (askName ? node.querySelector('input[name="name"]') : search).focus();
  });
}

// ------------------------------------------------------------------ inline invitee field

export function inviteeField({ name = 'invitees', placeholder = 'Type a name or email' } = {}) {
  return `
    <div class="invitee-field" data-invitee-field>
      <div class="invitee-chips"></div>
      <input type="text" class="invitee-input" placeholder="${esc(placeholder)}" autocomplete="off" aria-label="Invite people" />
      <input type="hidden" name="${esc(name)}" value="" />
      <div class="invitee-suggest" role="listbox" hidden></div>
    </div>`;
}

// Wires up every invitee field inside `root`. getContacts() returns [{ email, name }].
export function attachInviteeField(root, getContacts) {
  for (const field of root.querySelectorAll('[data-invitee-field]:not([data-ready])')) {
    field.dataset.ready = '1';
    const input = field.querySelector('.invitee-input');
    const hidden = field.querySelector('input[type="hidden"]');
    const chips = field.querySelector('.invitee-chips');
    const suggest = field.querySelector('.invitee-suggest');
    const chosen = new Map(); // email -> name
    let active = 0;

    const sync = () => {
      hidden.value = [...chosen.keys()].join(', ');
      chips.innerHTML = [...chosen].map(([email, name]) => `<span class="invitee-chip" title="${esc(email)}">${esc(name || email)}<button type="button" data-remove="${esc(email)}" aria-label="Remove ${esc(name || email)}">✕</button></span>`).join('');
    };
    const add = (email, name = '') => {
      if (!email || chosen.has(email)) return;
      chosen.set(email, name);
      sync();
    };
    const options = () => {
      const q = input.value.trim().toLowerCase();
      const people = getContacts().filter((c) => !chosen.has(c.email) && matches(c, q)).slice(0, 8);
      const typed = EMAIL_RE.test(q) && !getContacts().some((c) => c.email === q) && !chosen.has(q) ? [{ email: q, name: '', isNew: true }] : [];
      return [...typed, ...people];
    };
    const draw = () => {
      const list = options();
      active = Math.min(active, Math.max(0, list.length - 1));
      suggest.hidden = !list.length || document.activeElement !== input;
      suggest.innerHTML = list
        .map((c, i) => `<button type="button" class="invitee-option${i === active ? ' active' : ''}" data-email="${esc(c.email)}" data-name="${esc(c.name)}" role="option">
          <span class="avatar small">${c.isNew ? '＋' : initialOf(c.name || c.email)}</span><span><b>${c.isNew ? `Invite ${esc(c.email)}` : esc(c.name || c.email)}</b><small>${c.isNew ? 'They’ll get an email' : esc(c.email)}</small></span></button>`)
        .join('');
    };

    input.addEventListener('focus', draw);
    input.addEventListener('input', () => {
      active = 0;
      draw();
    });
    input.addEventListener('blur', () => setTimeout(() => (suggest.hidden = true), 150));
    input.addEventListener('keydown', (event) => {
      const list = options();
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        active = (active + (event.key === 'ArrowDown' ? 1 : list.length - 1)) % Math.max(1, list.length);
        draw();
      } else if (event.key === 'Enter' || event.key === ',' || event.key === 'Tab') {
        const pick = list[active];
        const typed = input.value.trim().toLowerCase().replace(/,$/, '');
        if (pick && (event.key !== 'Tab' || input.value.trim())) {
          event.preventDefault();
          add(pick.email, pick.name);
        } else if (EMAIL_RE.test(typed)) {
          event.preventDefault();
          add(typed);
        } else if (event.key === 'Enter') event.preventDefault();
        else return;
        input.value = '';
        active = 0;
        draw();
      } else if (event.key === 'Backspace' && !input.value && chosen.size) {
        chosen.delete([...chosen.keys()].pop());
        sync();
        draw();
      }
    });
    // A pasted list of addresses becomes chips at once.
    input.addEventListener('paste', (event) => {
      const text = event.clipboardData?.getData('text') || '';
      const emails = text.split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter((e) => EMAIL_RE.test(e));
      if (emails.length > 1) {
        event.preventDefault();
        for (const email of emails) add(email, getContacts().find((c) => c.email === email)?.name || '');
        draw();
      }
    });
    suggest.addEventListener('mousedown', (event) => event.preventDefault()); // keep focus in the input
    suggest.addEventListener('click', (event) => {
      const option = event.target.closest('.invitee-option');
      if (!option) return;
      add(option.dataset.email, option.dataset.name);
      input.value = '';
      draw();
      input.focus();
    });
    chips.addEventListener('click', (event) => {
      const button = event.target.closest('[data-remove]');
      if (!button) return;
      chosen.delete(button.dataset.remove);
      sync();
      input.focus();
    });
    field.addEventListener('click', (event) => {
      if (event.target === field || event.target === chips) input.focus();
    });
    // Let other code (a "Browse people" button) add people too.
    field.addPeople = (people) => {
      for (const p of people) add(p.email, p.name || getContacts().find((c) => c.email === p.email)?.name || '');
      draw();
    };
    field.chosenEmails = () => [...chosen.keys()];
  }
}
