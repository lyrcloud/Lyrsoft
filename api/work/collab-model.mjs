// Pure rules for Lyrsoft chat and meetings (routes in collab.mjs).
import { createHash, randomBytes } from 'node:crypto';

export const MESSAGE_MAX = 4000;
export const MEETING_TITLE_MAX = 120;
export const MEETING_INVITEES_MAX = 50;
export const MEETING_DURATIONS = [15, 30, 45, 60, 90, 120];
const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

// Conversation ids: a workspace's team channel is "ws.<wsId>"; a direct message between two people is
// "dm.<hash of both emails>", so the same pair always lands in the same conversation.
export const channelId = (wsId) => `ws.${wsId}`;
export const dmId = (a, b) =>
  `dm.${createHash('sha256').update([String(a).toLowerCase(), String(b).toLowerCase()].sort().join('\n')).digest('hex').slice(0, 24)}`;
// A group chat someone created: "grp.<random>".
export const groupId = (randomHex) => `grp.${String(randomHex).slice(0, 24)}`;
export const CONV_RE = /^(ws\.[\w-]{1,40}|dm\.[0-9a-f]{24}|grp\.[0-9a-f]{24})$/;
export const GROUP_NAME_MAX = 80;
export const GROUP_MEMBERS_MAX = 100;

export function cleanGroupName(value) {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!name || name.length > GROUP_NAME_MAX) throw new Error(`Give the group a name (up to ${GROUP_NAME_MAX} characters).`);
  return name;
}

export function cleanMessage(body) {
  const text = typeof body === 'string' ? body.replace(/\r\n/g, '\n').trim() : '';
  if (!text) throw new Error('Write a message first.');
  if (text.length > MESSAGE_MAX) throw new Error(`Messages can be at most ${MESSAGE_MAX} characters.`);
  return text;
}

export const snippetOf = (text) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 120);

// A conversation is unread when someone else wrote after the person last read it.
export const isUnread = (conv, me, lastReadAt) =>
  Boolean(conv?.lastMessageAt && conv.lastAuthor !== me && (!lastReadAt || conv.lastMessageAt > lastReadAt));

// Cleans a new meeting: { title, startsAt (ISO, default now), durationMin, invitees, timeZone }.
export function cleanMeeting(body, hostEmail, now = Date.now()) {
  const title = typeof body?.title === 'string' ? body.title.trim().replace(/\s+/g, ' ') : '';
  if (!title || title.length > MEETING_TITLE_MAX) throw new Error(`Give the meeting a title (up to ${MEETING_TITLE_MAX} characters).`);
  const startsAt = body?.startsAt ? new Date(body.startsAt) : new Date(now);
  if (Number.isNaN(startsAt.getTime())) throw new Error('Pick a valid start time.');
  if (startsAt.getTime() < now - 60 * 60 * 1000) throw new Error('The start time is in the past.');
  if (startsAt.getTime() > now + 366 * 864e5) throw new Error('Meetings can be scheduled up to a year ahead.');
  const durationMin = MEETING_DURATIONS.includes(Number(body?.durationMin)) ? Number(body.durationMin) : 30;
  const invitees = cleanInvitees(body?.invitees).filter((email) => email !== hostEmail);
  return { title, startsAt: startsAt.toISOString(), durationMin, invitees, timeZone: validTimeZone(body?.timeZone) };
}

// "a@x.com, b@y.com" or ["a@x.com"] → unique, lower-cased, valid emails.
export function cleanInvitees(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[\s,;]+/);
  const emails = [...new Set(list.map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
  const bad = emails.find((e) => !EMAIL_RE.test(e));
  if (bad) throw new Error(`“${bad}” isn’t a valid email address.`);
  if (emails.length > MEETING_INVITEES_MAX) throw new Error(`Invite at most ${MEETING_INVITEES_MAX} people.`);
  return emails;
}

export function validTimeZone(zone) {
  try {
    if (typeof zone === 'string' && zone.length < 60) {
      new Intl.DateTimeFormat('en-US', { timeZone: zone });
      return zone;
    }
  } catch {}
  return 'UTC';
}

export const formatMeetingTime = (iso, timeZone = 'UTC') =>
  // dateStyle can't be combined with timeZoneName, so spell the parts out.
  new Intl.DateTimeFormat('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
    timeZone: validTimeZone(timeZone), timeZoneName: 'short',
  }).format(new Date(iso));

export const canSeeMeeting = (meeting, email, staff) => staff || meeting.hostEmail === email || (meeting.invitees || []).includes(email);
export const canManageMeeting = (meeting, email, staff) => staff || meeting.hostEmail === email;

// Chime ExternalUserId: 2-64 characters; the app maps it back to a name with the meeting's people.
export const attendeeExternalId = (email) => String(email).slice(0, 64);

// ------------------------------------------------------------------ Messenger-style message features

export const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
export const ATTACHMENTS_MAX = 10;
export const ATTACHMENT_BYTES_MAX = 25 * 1024 * 1024;
export const TYPING_MS = 6000; // "typing…" shows this long after the last keystroke ping
export const ACTIVE_MS = 2 * 60 * 1000; // "Active now" if seen this recently

// Where a conversation's uploads live in the mail bucket.
export const attachmentPrefix = (conv) => `chat/${conv}/`;

// Attachments sent with a message: files already uploaded under this conversation's prefix.
export function cleanAttachments(list, conv) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > ATTACHMENTS_MAX) throw new Error(`Send up to ${ATTACHMENTS_MAX} files at a time.`);
  return list.map((a) => {
    const key = String(a?.key || '');
    if (!key.startsWith(attachmentPrefix(conv)) || key.includes('..') || key.length > 400) throw new Error('That file wasn’t uploaded to this conversation.');
    const size = Number(a.size);
    if (!Number.isFinite(size) || size <= 0 || size > ATTACHMENT_BYTES_MAX) throw new Error('Files can be up to 25 MB.');
    return { key, name: String(a.name || 'file').slice(0, 120), type: String(a.type || 'application/octet-stream').slice(0, 100), size };
  });
}

// Adds or removes `email`'s `emoji` reaction; returns the new { emoji: [emails] } map.
export function toggleReaction(reactions, emoji, email) {
  if (!REACTIONS.includes(emoji)) throw new Error('Unknown reaction.');
  const next = Object.fromEntries(Object.entries(reactions || {}).map(([k, v]) => [k, [...v]]));
  const list = next[emoji] || [];
  next[emoji] = list.includes(email) ? list.filter((e) => e !== email) : [...list, email];
  if (!next[emoji].length) delete next[emoji];
  return next;
}

// Reactions as the app shows them: [{ emoji, count, mine, names }] in the standard order.
export const reactionsOut = (reactions, me, nameOf = (e) => e) =>
  REACTIONS.filter((emoji) => reactions?.[emoji]?.length).map((emoji) => ({
    emoji,
    count: reactions[emoji].length,
    mine: reactions[emoji].includes(me),
    names: reactions[emoji].map(nameOf),
  }));

// What a reply quotes: who wrote the original and the start of it.
export const replyQuote = (m) => ({
  id: m.id,
  at: m.createdAt,
  authorEmail: m.authorEmail,
  authorName: m.authorName || '',
  snippet: m.deletedAt ? 'Message unsent' : snippetOf(m.body) || (m.attachments?.length ? `📎 ${m.attachments.length} file${m.attachments.length === 1 ? '' : 's'}` : ''),
});

// ------------------------------------------------------------------ reaching people by phone number

export const PHONE_LOOKUPS_PER_DAY = 60; // per person, so nobody can sweep numbers to find accounts

// Finds the one Lyrsoft account whose *verified* mobile is `input`. "+880 1712-345678" and
// "00880…" match exactly; a number written without its country code ("01712 345678") matches on its
// last 10 digits (9 for short national numbers), but only when exactly one account fits.
export function profileForPhone(profiles, input) {
  const raw = String(input || '').trim();
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  const verified = profiles.filter((p) => p.phoneVerified && typeof p.phone === 'string' && p.email);
  if (/^(\+|00)/.test(raw)) {
    const e164 = `+${raw.startsWith('00') ? digits.slice(2) : digits}`;
    return verified.find((p) => p.phone === e164) || null;
  }
  const tail = digits.replace(/^0+/, '').slice(-10);
  if (tail.length < 9) return null;
  const found = verified.filter((p) => p.phone.replace(/\D/g, '').endsWith(tail));
  return found.length === 1 ? found[0] : null;
}

// A secret for a meeting's guest link: anyone who opens it and signs in joins the meeting.
export const newGuestKey = () => randomBytes(12).toString('base64url');
export const GUEST_KEY_RE = /^[A-Za-z0-9_-]{16}$/;
