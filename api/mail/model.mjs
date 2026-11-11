// Lyrsoft Mail: pure helpers for mailboxes, threading and building outgoing MIME messages.
// No AWS calls here, so everything is covered by model.test.mjs.
import { randomBytes } from 'node:crypto';

export const newId = () => randomBytes(9).toString('base64url');
const EMAIL_RE = /^[^\s@<>",;]{1,64}@[^\s@<>",;]{1,190}\.[^\s@<>",;]{2,63}$/;
const LOCAL_PART_RE = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/;

// Folders: open (Inbox), closed, spam, and trash, where deleted conversations wait until someone
// restores them or empties the trash.
export const THREAD_STATUSES = ['open', 'closed', 'spam', 'trash'];
// Folders whose conversations can be deleted for good.
export const PURGEABLE_STATUSES = ['spam', 'trash'];
export const BULK_ACTIONS = ['open', 'closed', 'spam', 'trash', 'restore', 'read', 'unread', 'delete'];

// The changes `action` makes to `thread`, or null when it can't apply (e.g. "delete" outside Spam and
// Trash). "trash" remembers where the conversation was, so "restore" can put it back.
export function threadActionChanges(thread, action, now = new Date().toISOString()) {
  if (action === 'read') return { unread: false };
  if (action === 'unread') return { unread: true };
  if (action === 'restore') return thread.status === 'trash' ? { status: thread.trashedFrom || 'open', trashedFrom: null, trashedAt: null } : null;
  if (action === 'trash') return thread.status === 'trash' ? null : { status: 'trash', trashedFrom: thread.status, trashedAt: now, unread: false };
  if (['open', 'closed', 'spam'].includes(action)) return { status: action, trashedFrom: null, trashedAt: null };
  return null;
}

// ------------------------------------------------------------------ mailboxes and access

export function mailDomains(env = process.env.MAIL_DOMAINS) {
  return String(env || '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
}

// A mailbox's profile: what people see in the app and in the From line, plus a signature added to
// every email sent from it. Members of the mailbox can edit it. Throws Error with a readable message.
export const MAILBOX_AVATAR_MAX = 60_000;
const AVATAR_DATA_RE = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

export function cleanMailboxProfile(body) {
  const out = {};
  const text = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  if ('displayName' in body) {
    out.displayName = text(body.displayName, 80);
    if (/[<>"]/.test(out.displayName)) throw new Error('The display name can’t contain <, > or ".');
  }
  if ('description' in body) out.description = text(body.description, 200);
  if ('signature' in body) out.signature = String(body.signature ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim().slice(0, 1000);
  if ('color' in body) {
    if (body.color && !/^#[0-9a-f]{6}$/i.test(body.color)) throw new Error('Pick a colour like #6c5ce7.');
    out.color = body.color ? body.color.toLowerCase() : '';
  }
  if ('avatar' in body) {
    const avatar = body.avatar;
    if (avatar !== null && !(typeof avatar === 'string' && avatar.length <= MAILBOX_AVATAR_MAX && AVATAR_DATA_RE.test(avatar))) {
      throw new Error('The photo must be a JPEG, PNG or WebP image under 45 KB.');
    }
    out.avatar = avatar;
  }
  if (!Object.keys(out).length) throw new Error('Nothing to change.');
  return out;
}

// The text of an outgoing email with the mailbox's signature under the usual "-- " separator.
export const withSignature = (text, signature) => (signature ? `${String(text).trimEnd()}\n\n-- \n${signature}` : String(text));

export function cleanMailboxAddress(address, domains) {
  const value = String(address || '').trim().toLowerCase();
  const [local, domain, extra] = value.split('@');
  if (extra !== undefined || !LOCAL_PART_RE.test(local || '') || !domains.includes(domain)) {
    throw new Error(`Use an address at one of: ${domains.join(', ')}.`);
  }
  return value;
}

export function cleanEmailList(value, { max = 50, label = 'address' } = {}) {
  const list = (Array.isArray(value) ? value : String(value || '').split(/[,;\s]+/))
    .map((email) => String(email).trim().toLowerCase())
    .filter(Boolean);
  for (const email of list) if (!EMAIL_RE.test(email)) throw new Error(`“${email}” isn’t a valid ${label}.`);
  if (list.length > max) throw new Error(`Up to ${max} ${label}es.`);
  return [...new Set(list)];
}

// Staff (super admin and Lyrcloud admins) can open every mailbox; others need to be listed on it, or
// belong to a workspace linked to the mailbox's domain (`linked`: addresses from linkedAddresses).
export const isMailStaff = (globalRole) => globalRole === 'superadmin' || globalRole === 'admin';
export const canUseMailbox = (me, mailbox, linked = null) =>
  isMailStaff(me.globalRole) || (mailbox.members || []).includes(me.email) || Boolean(linked?.has(mailbox.address));

// ------------------------------------------------------------------ workspaces linked to a domain
// The super admin links workspaces to a mail domain (Lyrtrip's workspace to lyrtrip.com). Everyone in a
// linked workspace, including people who join later, can use that domain's shared inbox.

// The shared inbox of a domain: support@<domain>, else the domain's catch-all mailbox, else none.
export function sharedMailbox(domain, mailboxes) {
  return mailboxes.find((m) => m.address === `support@${domain}`) || mailboxes.find((m) => m.catchAll && m.address.split('@')[1] === domain) || null;
}

// { domain: [wsId, …] } with only real domains and well-formed workspace ids.
export function cleanMailLinks(input, domains) {
  const out = {};
  for (const [domain, ids] of Object.entries(input && typeof input === 'object' ? input : {})) {
    if (!domains.includes(domain)) continue;
    const list = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter((id) => /^[\w-]{1,64}$/.test(id)))].slice(0, 50);
    if (list.length) out[domain] = list;
  }
  return out;
}

// Addresses of the shared inboxes my workspaces are linked to.
export function linkedAddresses(links, wsIds, mailboxes) {
  const mine = new Set(wsIds);
  const out = new Set();
  for (const [domain, ids] of Object.entries(links || {})) {
    if (!ids.some((id) => mine.has(id))) continue;
    const box = sharedMailbox(domain, mailboxes);
    if (box) out.add(box.address);
  }
  return out;
}

// Workspaces whose name matches a domain ("Lyrtrip" ~ lyrtrip.com), offered as links to the super admin.
export function suggestMailLinks(workspaces, domains) {
  const key = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const out = {};
  for (const domain of domains) {
    const label = key(domain.split('.')[0]);
    const ids = workspaces.filter((w) => key(w.name) === label || key(w.name).startsWith(label)).map((w) => w.id);
    if (ids.length) out[domain] = ids;
  }
  return out;
}
export const canManageMailboxes = (me) => me.globalRole === 'superadmin';

// Picks the mailboxes an incoming recipient lands in: an exact address match, else the
// domain's catch-all mailbox (if one is set), else none.
export function routeRecipient(recipient, mailboxes) {
  const address = String(recipient).toLowerCase();
  const exact = mailboxes.find((m) => m.address === address);
  if (exact) return exact;
  const domain = address.split('@')[1];
  return mailboxes.find((m) => m.catchAll && m.address.split('@')[1] === domain) || null;
}

// ------------------------------------------------------------------ threading and display

// "<a@b> <c@d>" / ["<a@b>"] -> ["<a@b>", "<c@d>"]
export function messageIds(value) {
  const text = Array.isArray(value) ? value.join(' ') : String(value || '');
  return [...text.matchAll(/<[^<>\s]+>/g)].map((match) => match[0]);
}

export const baseSubject = (subject) => String(subject || '').replace(/^\s*((re|fw|fwd|aw|sv)\s*(\[\d+\])?\s*:\s*)+/i, '').trim();
export const replySubject = (subject) => (/^\s*re\s*:/i.test(subject || '') ? subject : `Re: ${baseSubject(subject) || '(no subject)'}`);

export function snippet(text, length = 160) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export function textToHtml(text) {
  const body = escapeHtml(text)
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
    .replace(/\r?\n/g, '<br>\n');
  return `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1f2433">${body}</body></html>`;
}

// Quotes the previous message under a reply, Gmail style.
export function quoteReply(text, previous) {
  if (!previous) return text;
  const when = new Date(previous.createdAt).toUTCString();
  const who = previous.from?.name ? `${previous.from.name} <${previous.from.address}>` : previous.from?.address;
  const quoted = String(previous.text || '').split(/\r?\n/).map((line) => `> ${line}`).join('\n');
  return `${text}\n\nOn ${when}, ${who} wrote:\n${quoted}`;
}

// ------------------------------------------------------------------ outgoing MIME

const isAscii = (value) => /^[\x20-\x7e]*$/.test(value);

// RFC 2047 encoded words, split so each stays within the 75-character limit.
export function encodeHeaderValue(value) {
  const text = String(value ?? '').replace(/[\r\n]+/g, ' ');
  if (isAscii(text)) return text;
  const words = [];
  let chunk = '';
  for (const char of text) {
    if (Buffer.byteLength(chunk + char) > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += char;
  }
  if (chunk) words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word).toString('base64')}?=`).join('\r\n ');
}

export function formatAddress({ name, address }) {
  if (!name) return address;
  const display = isAscii(name) ? `"${name.replace(/["\\]/g, '\\$&')}"` : encodeHeaderValue(name);
  return `${display} <${address}>`;
}

const base64Lines = (text) => Buffer.from(text, 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n');

// `headers`: extra [name, value] pairs, e.g. List-Unsubscribe on update emails.
export function buildRawEmail({ from, to, cc = [], subject, text, html, inReplyTo, references = [], date = new Date(), headers: extra = [] }) {
  const boundary = `lyr-${randomBytes(12).toString('hex')}`;
  const headers = [
    ['From', formatAddress(from)],
    ['To', to.join(', ')],
    ...(cc.length ? [['Cc', cc.join(', ')]] : []),
    ['Subject', encodeHeaderValue(subject)],
    ['Date', date.toUTCString().replace('GMT', '+0000')],
    ...(inReplyTo ? [['In-Reply-To', inReplyTo]] : []),
    ...(references.length ? [['References', references.join(' ')]] : []),
    ...extra,
    ['MIME-Version', '1.0'],
    ['Content-Type', `multipart/alternative; boundary="${boundary}"`],
  ];
  return [
    ...headers.map(([key, value]) => `${key}: ${value}`),
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(text),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(html ?? textToHtml(text)),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

// Attachment names become S3 key segments; keep them readable but safe.
export const safeFilename = (name) =>
  String(name || 'attachment').normalize('NFKC').replace(/[^\w.\- ()]+/g, '_').replace(/^\.+/, '').slice(0, 120) || 'attachment';
