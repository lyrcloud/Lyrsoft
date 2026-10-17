// Lyrsoft Mail: pure helpers for mailboxes, threading and building outgoing MIME messages.
// No AWS calls here, so everything is covered by model.test.mjs.
import { randomBytes } from 'node:crypto';

export const newId = () => randomBytes(9).toString('base64url');
const EMAIL_RE = /^[^\s@<>",;]{1,64}@[^\s@<>",;]{1,190}\.[^\s@<>",;]{2,63}$/;
const LOCAL_PART_RE = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/;

export const THREAD_STATUSES = ['open', 'closed', 'spam'];

// ------------------------------------------------------------------ mailboxes and access

export function mailDomains(env = process.env.MAIL_DOMAINS) {
  return String(env || '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
}

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

// Staff (super admin and Lyrcloud admins) can open every mailbox; others need to be listed on it.
export const isMailStaff = (globalRole) => globalRole === 'superadmin' || globalRole === 'admin';
export const canUseMailbox = (me, mailbox) => isMailStaff(me.globalRole) || (mailbox.members || []).includes(me.email);
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

export function buildRawEmail({ from, to, cc = [], subject, text, html, inReplyTo, references = [], date = new Date() }) {
  const boundary = `lyr-${randomBytes(12).toString('hex')}`;
  const headers = [
    ['From', formatAddress(from)],
    ['To', to.join(', ')],
    ...(cc.length ? [['Cc', cc.join(', ')]] : []),
    ['Subject', encodeHeaderValue(subject)],
    ['Date', date.toUTCString().replace('GMT', '+0000')],
    ...(inReplyTo ? [['In-Reply-To', inReplyTo]] : []),
    ...(references.length ? [['References', references.join(' ')]] : []),
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
