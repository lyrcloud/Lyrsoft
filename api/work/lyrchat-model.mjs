// Lyr Chat (lyrsoft.com/chat/): the rules behind message requests, blocking, ringing calls and push
// notifications. Pure functions, used by collab.mjs and push.mjs and tested in lyrchat-model.test.mjs.
import { createECDH, createHmac, timingSafeEqual } from 'node:crypto';

export const DM_REQUESTS_PER_DAY = 30; // new chats with strangers per person per day
export const CALL_RING_MS = 45_000; // a call rings this long before it counts as missed
export const PUSH_SUBSCRIPTIONS_MAX = 10; // devices per person
export const REPORT_MESSAGES = 20; // recent messages attached to a report

// ------------------------------------------------------------------ message requests
//
// A DM between people who don't share a workspace starts as a request: meta.request =
// { from, to, status: 'pending' | 'accepted' | 'blocked', at, masked }. The sender can write; the
// receiver sees it under Message requests and accepts (or replies, which accepts), deletes or blocks.
// `masked` means the sender found them by phone number: until they accept, the sender never sees
// the receiver's email, only their first name and the number.

export function requestState(meta, email) {
  const r = meta?.request;
  if (!r || r.status === 'accepted') return 'none';
  if (r.status === 'blocked') return 'blocked';
  return r.to === email ? 'incoming' : 'outgoing';
}

// Can `email` post in this DM? Returns null or the reason they can't.
export function postBlocked(meta, email, blocked) {
  if (blocked) return 'You can’t message this person.';
  const state = requestState(meta, email);
  if (state === 'blocked') return 'You can’t message this person.';
  return null;
}

// Calls need an accepted chat (or a co-worker DM, which never had a request).
export const canCall = (meta, email, blocked) => !blocked && requestState(meta, email) === 'none';

// Who to hide from whom: { email, alias } when `viewer` mustn't see the other member's address.
export function maskFor(meta, viewer) {
  const r = meta?.request;
  if (!r?.masked || r.status === 'accepted' || r.from !== viewer) return null;
  return { email: r.to, alias: `peer.${meta.conv || 'dm'}` };
}

// Replaces an email everywhere in an API response (keys and values).
export function maskJson(value, mask) {
  if (!mask) return value;
  return JSON.parse(JSON.stringify(value).split(mask.email).join(mask.alias));
}

// ------------------------------------------------------------------ calls
//
// CALL#<id> META = { callId, conv, convType, meetingId, from, fromName, video, members (everyone but
// the caller), status: 'ringing' | 'answered' | 'missed' | 'declined' | 'ended', startedAt,
// answeredAt?, endedAt?, answeredBy: [], declinedBy: [] }.

export const callRinging = (call, now = Date.now()) => call?.status === 'ringing' && now - Date.parse(call.startedAt) < CALL_RING_MS;

// Is this call ringing for `email` right now?
export const ringsFor = (call, email, now = Date.now()) =>
  callRinging(call, now) && call.from !== email && call.members.includes(email) && !call.declinedBy?.includes(email) && !call.answeredBy?.includes(email);

export function answerCall(call, email, at) {
  if (!call.members.includes(email)) throw new Error('That call isn’t for you.');
  if (!['ringing', 'answered'].includes(call.status)) throw new Error(call.status === 'missed' ? 'The call ended before you answered.' : 'This call has ended.');
  return { ...call, status: 'answered', answeredAt: call.answeredAt || at, answeredBy: [...new Set([...(call.answeredBy || []), email])] };
}

export function declineCall(call, email) {
  if (!call.members.includes(email)) throw new Error('That call isn’t for you.');
  const declinedBy = [...new Set([...(call.declinedBy || []), email])];
  // A DM call (one person rung) is over once they decline; a group call keeps ringing the others.
  const everyone = call.members.every((m) => declinedBy.includes(m));
  return { ...call, declinedBy, status: call.status === 'ringing' && everyone ? 'declined' : call.status };
}

// Hanging up: before anyone answered it's a missed call; after, the call has ended.
export function endCall(call, at) {
  if (['missed', 'declined', 'ended'].includes(call.status)) return call;
  return { ...call, status: call.status === 'answered' ? 'ended' : 'missed', endedAt: at };
}

export const durationText = (seconds) => {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
};

// The line a finished DM call leaves in the chat.
export function callSummary(call) {
  const kind = call.video ? 'Video call' : 'Voice call';
  if (call.status === 'missed') return `Missed ${kind.toLowerCase()}`;
  if (call.status === 'declined') return `${kind} declined`;
  if (call.status === 'ended' && call.answeredAt && call.endedAt) return `${kind} · ${durationText((Date.parse(call.endedAt) - Date.parse(call.answeredAt)) / 1000)}`;
  return kind;
}

// One call in someone's Calls tab.
export function callLogEntry(call, me) {
  const outgoing = call.from === me;
  const missed = !outgoing && (call.status === 'missed' || (call.status !== 'ringing' && !call.answeredBy?.includes(me) && !call.declinedBy?.includes(me) && call.convType === 'dm'));
  return {
    id: call.callId,
    conv: call.conv,
    convType: call.convType,
    video: Boolean(call.video),
    direction: outgoing ? 'outgoing' : 'incoming',
    status: call.status,
    missed,
    declined: Boolean(call.declinedBy?.includes(me)) || (outgoing && call.status === 'declined'),
    startedAt: call.startedAt,
    durationSec: call.answeredAt && call.endedAt ? Math.round((Date.parse(call.endedAt) - Date.parse(call.answeredAt)) / 1000) : null,
  };
}

// A notification's "Decline" button works without the app open: the push carries this token.
export const callToken = (secret, callId, email) => createHmac('sha256', String(secret)).update(`call:${callId}:${email}`).digest('base64url').slice(0, 32);
export function validCallToken(secret, callId, email, token) {
  const expected = Buffer.from(callToken(secret, callId, email));
  const given = Buffer.from(String(token || ''));
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// ------------------------------------------------------------------ push notifications

// VAPID keys (P-256) derived from the app secret, so no extra secret has to be kept anywhere.
const P256_ORDER = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
export function vapidKeysFrom(secret) {
  for (let i = 0; i < 16; i += 1) {
    const d = createHmac('sha256', String(secret)).update(`lyrsoft-vapid-${i}`).digest();
    const n = BigInt(`0x${d.toString('hex')}`);
    if (n === 0n || n >= P256_ORDER) continue;
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(d);
    return { publicKey: ecdh.getPublicKey().toString('base64url'), privateKey: d.toString('base64url') };
  }
  throw new Error('Couldn’t derive push keys.');
}

// A browser's push subscription, as PushSubscription.toJSON() gives it.
export function cleanSubscription(sub) {
  const endpoint = String(sub?.endpoint || '');
  const { p256dh, auth } = sub?.keys || {};
  if (!/^https:\/\/[^\s]{10,800}$/.test(endpoint)) throw new Error('That isn’t a push subscription.');
  if (!/^[\w-]{40,200}$/.test(String(p256dh || '')) || !/^[\w-]{10,60}$/.test(String(auth || ''))) throw new Error('That push subscription has no keys.');
  return { endpoint, keys: { p256dh: String(p256dh), auth: String(auth) } };
}

// What a new message's notification says. Requests say so; groups show who wrote.
export function messagePush({ conv, meta, author, snippet, request }) {
  const group = meta.type === 'group';
  return {
    type: 'message',
    conv,
    title: request ? `Message request from ${author}` : group ? meta.title : author,
    body: (group ? `${author}: ` : '') + (snippet || 'Sent you a message'),
    tag: `conv-${conv}`,
    url: request ? '/chat/#/requests' : `/chat/#/chat/${encodeURIComponent(conv)}`,
  };
}
