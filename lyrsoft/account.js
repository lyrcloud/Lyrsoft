// Lyrsoft Work account pages, plugged into app.js like mail.js:
//   #/profile        your profile: name, verified email, mobile number (texted 6-digit code), email updates
//   #/admin          admin console (admins and the super admin): every account, roles, disabling
//   #/admin/updates  product update emails to everyone opted in (sent by the super admin)
import { avatarHtml, imageFileToAvatar } from './avatar.js';

const PROVIDERS = { GoogleOIDC: 'Google', Cognito: 'Email and password', GitHubBridge: 'GitHub' };
const ROLE_NAMES = { superadmin: 'Super admin', admin: 'Admin', user: 'User' };

export function createAccount({ api, esc, toast, render, go, initial, formatDateTime, getMe }) {
  const admin = { users: null, updates: null, sending: false, filter: '' };
  const profile = () => getMe()?.profile || {};
  const isStaff = () => ['admin', 'superadmin'].includes(getMe()?.globalRole);
  const isSuper = () => getMe()?.globalRole === 'superadmin';
  const setProfile = (next) => {
    const me = getMe();
    me.profile = next;
    me.name = next.name || me.name;
  };
  const when = (iso) => (iso ? formatDateTime(iso) : '—');

  function sidebarLinks(route) {
    return `
      <nav aria-label="Account">
        <p class="nav-label">Account</p>
        <a href="#/profile"${route.view === 'profile' ? ' aria-current="page"' : ''}><span class="nav-icon" aria-hidden="true">👤</span>My profile${profile().phoneVerified ? '' : '<span class="dot" title="Mobile number not verified"></span>'}</a>
        ${isStaff() ? `<a href="#/admin"${route.view === 'admin' ? ' aria-current="page"' : ''}><span class="nav-icon" aria-hidden="true">🛡</span>Admin console</a>` : ''}
      </nav>`;
  }

  // ---------------------------------------------------------------- profile

  function profileView() {
    const p = profile();
    const me = getMe();
    const pending = p.phonePending;
    return `
      <div class="page-head"><div><h1>My profile</h1><p>Your Lyrsoft account, contact details and email settings.</p></div></div>
      <div class="profile-grid">
        <section class="panel profile-card">
          <div class="photo-edit">
            ${avatarHtml(p, 'avatar huge')}
            <label class="photo-button" title="Change photo"><input type="file" accept="image/*" data-change="avatar-file" hidden />📷</label>
          </div>
          <div class="photo-actions">
            <label class="btn small">${p.avatarSource === 'upload' ? 'Change photo' : 'Upload photo'}<input type="file" accept="image/*" data-change="avatar-file" hidden /></label>
            ${p.avatarSource !== 'provider' && p.hasProviderPhoto ? '<button class="btn small" data-click="avatar-provider">Use Google photo</button>' : ''}
            ${p.avatar ? '<button class="btn small ghost" data-click="avatar-remove">Remove photo</button>' : ''}
          </div>
          <h2>${esc(p.name || p.email)}</h2>
          <p class="muted">${esc(p.email)}</p>
          ${me.globalRole === 'user' ? '<span class="pill">User</span>' : `<a class="pill pill-staff" href="#/admin" title="Open the admin console">${ROLE_NAMES[me.globalRole]} · Admin console →</a>`}
          <dl class="facts">
            <dt>Signed in with</dt><dd>${esc(PROVIDERS[p.provider] || p.provider || '—')}</dd>
            <dt>Member since</dt><dd>${when(p.createdAt)}</dd>
            <dt>Last sign-in</dt><dd>${when(p.lastLoginAt)}</dd>
          </dl>
        </section>

        <div class="profile-main">
          <section class="panel">
            <div class="panel-head"><h2>Details</h2></div>
            <form class="stack" data-form="profile-name">
              <label>Name<input name="name" value="${esc(p.name || '')}" required maxlength="120" autocomplete="name" /></label>
              <div class="row"><button class="btn primary" type="submit">Save name</button></div>
            </form>
          </section>

          <section class="panel">
            <div class="panel-head"><h2>Email</h2><span class="badge ok">✓ Verified</span></div>
            <p><b>${esc(p.email)}</b></p>
            <p class="muted small">${p.provider === 'Cognito' ? 'You confirmed this address with a code we emailed you.' : 'Verified by Google when you signed in.'}</p>
          </section>

          <section class="panel">
            <div class="panel-head"><h2>Mobile number</h2>${p.phoneVerified ? '<span class="badge ok">✓ Verified</span>' : '<span class="badge warn">Not verified</span>'}</div>
            ${
              p.phoneVerified
                ? `<p><b>${esc(p.phone)}</b></p>
                   <div class="row"><button class="btn small" data-click="phone-change">Change number</button><button class="btn small danger" data-click="phone-remove">Remove</button></div>`
                : ''
            }
            ${
              !p.phoneVerified || admin.changingPhone
                ? `<form class="stack" data-form="phone-send">
                    <label>Mobile number with country code<input name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+91 98765 43210" value="${esc(pending || '')}" required /></label>
                    <div class="row"><button class="btn ${pending ? '' : 'primary'}" type="submit">${pending ? 'Send a new code' : 'Text me a code'}</button></div>
                  </form>
                  ${
                    pending
                      ? `<form class="stack verify-form" data-form="phone-verify">
                          <label>6-digit code sent to ${esc(pending)}<input name="code" class="code-input" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required /></label>
                          <div class="row"><button class="btn primary" type="submit">Verify number</button></div>
                        </form>`
                      : ''
                  }
                  <p class="muted small">We text a one-time code to confirm the number is yours. Codes expire after 10 minutes.</p>`
                : ''
            }
          </section>

          <section class="panel">
            <div class="panel-head"><h2>Emails from Lyrsoft</h2></div>
            <label class="toggle"><input type="checkbox" data-change="email-updates"${p.emailUpdates ? ' checked' : ''} /> <span>Product updates and news</span></label>
            <p class="muted small">Account and security emails always arrive. ${p.welcomeSentAt ? `Welcome email sent ${when(p.welcomeSentAt)}.` : ''}</p>
          </section>
        </div>
      </div>`;
  }

  // ---------------------------------------------------------------- admin console

  async function load(route) {
    if (route.view !== 'admin' || !isStaff()) return;
    if (route.tab === 'updates') {
      admin.updates = await api('GET', '/admin/updates');
    } else {
      admin.users = (await api('GET', '/admin/users')).users;
    }
  }

  const ready = (route) => route.view !== 'admin' || !isStaff() || (route.tab === 'updates' ? Boolean(admin.updates) : Boolean(admin.users));

  function tabs(route) {
    return `
      <div class="segmented admin-tabs" role="tablist">
        <a href="#/admin"${route.tab !== 'updates' ? ' aria-current="page"' : ''}>👥 Users</a>
        <a href="#/admin/updates"${route.tab === 'updates' ? ' aria-current="page"' : ''}>✉ Update emails</a>
      </div>`;
  }

  function usersView() {
    const users = admin.users;
    const q = admin.filter.trim().toLowerCase();
    const shown = users.filter((u) => !q || [u.name, u.email].some((v) => String(v || '').toLowerCase().includes(q)));
    const count = (fn) => users.filter(fn).length;
    const stats = [
      ['Accounts', users.length],
      ['Admins', count((u) => u.role !== 'user')],
      ['Mobile verified', count((u) => u.phone)],
      ['Active this week', count((u) => u.lastLoginAt && Date.now() - Date.parse(u.lastLoginAt) < 7 * 864e5)],
    ];
    const row = (u) => {
      const editableRole = isSuper() && u.role !== 'superadmin';
      const canDisable = u.role === 'user' ? isStaff() : u.role === 'admin' && isSuper();
      return `
        <tr${u.disabled ? ' class="is-disabled"' : ''}>
          <td><div class="user-cell">${avatarHtml(u)}<span><b>${esc(u.name || '—')}</b><small>${esc(u.email)}</small></span></div></td>
          <td>${esc(PROVIDERS[u.provider] || u.provider || '—')}</td>
          <td>${u.phone ? `<span class="badge ok">✓ ${esc(u.phone)}</span>` : '<span class="muted">—</span>'}</td>
          <td>${
            editableRole
              ? `<select data-change="admin-role" data-user="${esc(u.userId)}" aria-label="Role for ${esc(u.email)}">${['user', 'admin'].map((r) => `<option value="${r}"${r === u.role ? ' selected' : ''}>${ROLE_NAMES[r]}</option>`).join('')}</select>${u.lyrcloudAdmin ? '<small class="muted"> (Lyrcloud admin)</small>' : ''}`
              : `<span class="pill ${u.role === 'user' ? '' : 'pill-staff'}">${ROLE_NAMES[u.role]}</span>`
          }</td>
          <td>${u.emailUpdates ? 'On' : '<span class="muted">Off</span>'}</td>
          <td title="${esc(u.lastLoginAt || '')}">${when(u.lastLoginAt)}</td>
          <td>${canDisable ? `<button class="btn small ${u.disabled ? '' : 'danger'}" data-click="admin-disable" data-user="${esc(u.userId)}">${u.disabled ? 'Enable' : 'Disable'}</button>` : ''}</td>
        </tr>`;
    };
    return `
      <div class="stat-row">${stats.map(([label, value]) => `<div class="panel stat"><span>${label}</span><b>${value}</b></div>`).join('')}</div>
      <section class="panel">
        <div class="panel-head spread"><h2>Accounts</h2><input type="search" class="search" placeholder="Search name or email" value="${esc(admin.filter)}" data-input="admin-filter" aria-label="Search accounts" /></div>
        <div class="table-scroll"><table class="data-table">
          <thead><tr><th>Person</th><th>Sign-in</th><th>Mobile</th><th>Role</th><th>Updates</th><th>Last sign-in</th><th></th></tr></thead>
          <tbody>${shown.map(row).join('') || '<tr><td colspan="7" class="muted">No accounts match.</td></tr>'}</tbody>
        </table></div>
        <p class="muted small">${isSuper() ? 'Admins see every workspace and can disable regular users. Only you can make or remove admins.' : 'Only the super admin can change roles.'}</p>
      </section>`;
  }

  function updatesView() {
    const { updates, recipients, mailEnabled } = admin.updates;
    return `
      ${
        isSuper()
          ? `<section class="panel">
              <div class="panel-head"><h2>Email an update</h2><span class="muted small">Goes to ${recipients} ${recipients === 1 ? 'person' : 'people'} with updates turned on</span></div>
              ${mailEnabled ? '' : '<p class="auth-error">Email sending isn’t set up yet.</p>'}
              <form class="stack" data-form="send-update">
                <label>Subject<input name="subject" required maxlength="150" placeholder="What’s new in Lyrsoft" /></label>
                <label>Message<textarea name="message" rows="9" required maxlength="5000" placeholder="Write in plain text. Blank lines start new paragraphs; https:// links become clickable."></textarea></label>
                <div class="row"><button class="btn primary" type="submit"${admin.sending || !mailEnabled ? ' disabled' : ''}>${admin.sending ? 'Sending…' : 'Send to everyone'}</button></div>
              </form>
              <p class="muted small">Every email has an unsubscribe link, and people can turn updates off in their profile.</p>
            </section>`
          : '<section class="panel"><p class="muted">Only the super admin can send update emails.</p></section>'
      }
      <section class="panel">
        <div class="panel-head"><h2>Sent updates</h2></div>
        ${
          updates.length
            ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>Subject</th><th>Sent</th><th>By</th><th>Delivered</th><th>Failed</th></tr></thead><tbody>
                ${updates.map((u) => `<tr><td><b>${esc(u.subject)}</b></td><td>${when(u.sentAt)}</td><td>${esc(u.sentBy)}</td><td>${u.sent}</td><td>${u.failed ? `<span class="badge warn">${u.failed}</span>` : '0'}</td></tr>`).join('')}
              </tbody></table></div>`
            : '<p class="muted">No updates sent yet.</p>'
        }
      </section>`;
  }

  function adminView(route) {
    if (!isStaff()) return '<section class="panel empty"><h2>Admins only</h2><p>You need an admin role to open the admin console.</p></section>';
    return `
      <div class="page-head"><div><h1>Admin console</h1><p>${isSuper() ? 'You’re the super admin.' : 'You’re an admin.'} Manage Lyrsoft accounts and update emails.</p></div>${tabs(route)}</div>
      ${route.tab === 'updates' ? updatesView() : usersView()}`;
  }

  // ---------------------------------------------------------------- actions

  const userPatch = async (userId, changes) => {
    try {
      const { user } = await api('PATCH', `/admin/users/${encodeURIComponent(userId)}`, changes);
      admin.users = admin.users.map((u) => (u.userId === user.userId ? user : u));
      return user;
    } catch (error) {
      toast(error.message);
      return null;
    } finally {
      render();
    }
  };

  const saveAvatar = async (avatar, message) => {
    try {
      setProfile((await api('PATCH', '/me/profile', { avatar })).profile);
      toast(message);
    } catch (error) {
      toast(error.message);
    }
    render();
  };

  const clickActions = {
    'avatar-provider': () => saveAvatar(null, 'Using your Google photo'),
    'avatar-remove': () => saveAvatar('initials', 'Photo removed'),
    'phone-change': () => {
      admin.changingPhone = true;
      render();
    },
    'phone-remove': async () => {
      if (!confirm('Remove your mobile number?')) return;
      try {
        setProfile((await api('DELETE', '/me/phone')).profile);
        toast('Mobile number removed');
      } catch (error) {
        toast(error.message);
      }
      render();
    },
    'admin-disable': async (target) => {
      const user = admin.users.find((u) => u.userId === target.dataset.user);
      if (!user) return;
      if (!user.disabled && !confirm(`Disable ${user.email}? They won’t be able to use Lyrsoft until you enable them again.`)) return;
      const saved = await userPatch(user.userId, { disabled: !user.disabled });
      if (saved) toast(`${saved.email} ${saved.disabled ? 'disabled' : 'enabled'}`);
    },
  };

  const changeActions = {
    'avatar-file': async (target) => {
      const file = target.files?.[0];
      if (!file) return;
      toast('Uploading photo…');
      try {
        await saveAvatar(await imageFileToAvatar(file), 'Profile photo updated');
      } catch (error) {
        toast(error.message);
      }
    },
    'email-updates': async (target) => {
      try {
        setProfile((await api('PATCH', '/me/profile', { emailUpdates: target.checked })).profile);
        toast(target.checked ? 'Product updates turned on' : 'Product updates turned off');
      } catch (error) {
        toast(error.message);
        render();
      }
    },
    'admin-role': async (target) => {
      const saved = await userPatch(target.dataset.user, { role: target.value });
      if (saved) toast(`${saved.email} is now ${ROLE_NAMES[saved.role].toLowerCase()}`);
    },
  };

  const busy = (form, fn) => async (...args) => {
    const button = form.querySelector('[type="submit"]');
    if (button) button.disabled = true;
    try {
      await fn(...args);
    } catch (error) {
      toast(error.message);
    } finally {
      if (button?.isConnected) button.disabled = false;
    }
  };

  const formActions = {
    'profile-name': (form, data) =>
      busy(form, async () => {
        setProfile((await api('PATCH', '/me/profile', { name: data.get('name') })).profile);
        toast('Name saved');
        render();
      })(),
    'phone-send': (form, data) =>
      busy(form, async () => {
        setProfile((await api('POST', '/me/phone', { phone: data.get('phone') })).profile);
        toast(`Code sent to ${profile().phonePending}`);
        render();
        document.querySelector('.verify-form input')?.focus();
      })(),
    'phone-verify': (form, data) =>
      busy(form, async () => {
        setProfile((await api('POST', '/me/phone/verify', { code: data.get('code') })).profile);
        admin.changingPhone = false;
        toast('Mobile number verified');
        render();
      })(),
    'send-update': async (form, data) => {
      const subject = String(data.get('subject')).trim();
      if (!confirm(`Email “${subject}” to ${admin.updates.recipients} people now?`)) return;
      admin.sending = true;
      render();
      try {
        // Large lists are sent in batches; keep calling with the updateId until none remain.
        let result = await api('POST', '/admin/updates', { subject, message: data.get('message') });
        while (result.remaining > 0) result = await api('POST', '/admin/updates', { updateId: result.update.id });
        toast(`Update sent to ${result.update.sent} ${result.update.sent === 1 ? 'person' : 'people'}${result.update.failed ? ` (${result.update.failed} failed)` : ''}`);
        admin.updates = await api('GET', '/admin/updates');
      } catch (error) {
        toast(error.message);
      }
      admin.sending = false;
      render();
    },
  };

  const inputActions = {
    'admin-filter': (target) => {
      admin.filter = target.value;
      const { selectionStart } = target;
      render();
      const search = document.querySelector('[data-input="admin-filter"]');
      search?.focus();
      search?.setSelectionRange(selectionStart, selectionStart);
    },
  };

  return {
    load,
    ready,
    sidebarLinks,
    view: (route) => (route.view === 'profile' ? profileView() : adminView(route)),
    // A nudge on the home page until the mobile number is verified.
    homeBanner: () =>
      getMe()?.profile && !profile().phoneVerified
        ? `<a class="panel banner" href="#/profile"><span aria-hidden="true">📱</span><span><b>Verify your mobile number</b><small>Add a number so your team can reach you and to keep your account secure.</small></span><span class="btn small primary">Verify now</span></a>`
        : '',
    clickActions,
    changeActions,
    formActions,
    inputActions,
  };
}
