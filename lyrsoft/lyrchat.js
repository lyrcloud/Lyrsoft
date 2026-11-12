// Lyr Chat (lyrsoft.com/chat/): a phone-first messaging app on the same accounts and conversations as
// Lyrsoft Work's Messages. Chats, voice and video calls that ring, voice messages, message requests
// from people outside your workspaces, call history and push notifications.
//
//   #/                 chats            #/chat/<conv>   a conversation    #/requests   message requests
//   #/new              new chat (phone number, email, co-workers, your Contacts)    #/group   new group
//   #/contacts         your Lyrsoft Contacts: who's on Lyr Chat (chat or call them), and inviting the rest
//   #/calls            call history     #/settings      notifications, install, blocked people, sign out
//   #/call/<id>        an incoming call (opened from its notification)
//   #/meet/<id>        join a group call or meeting
//
// Conversations are ConversationView (conversation.js); calls use the meeting call room (meet.js) on
// Amazon Chime. Calls ring through GET /calls/ringing while the app is open, and by Web Push
// (lyrchat-sw.js, served as /chat/sw.js) when it isn't.
import { authFetch, clearTokens, exchangeCodeForTokens, getTokens, logout, redirectToLogin } from './auth.js';
import { avatarHtml } from './avatar.js';
import { WORK_API_BASE } from './config.js';
import { ConversationView } from './conversation.js';
import { createMeetings } from './meet.js';
import { showSignIn } from './signin.js';
import { APK_URL, inApp, isAndroid, showAndroidAppBar } from './android-app.js';

const TOKENS_KEY = 'lyrcloud.auth.tokens';
const KEEP_KEY = 'lyrchat.tokens';
const POLL_LIST_MS = 6000;
const POLL_RING_MS = 3000;
const POLL_CALL_MS = 2000;
const RING_MS = 45_000;
const INVITE_URL = `${location.origin}/chat/`;
const INVITE_TEXT = `Let’s chat on Lyr Chat, free messages and calls: ${INVITE_URL}`;

// ------------------------------------------------------------------ helpers

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const initial = (text) => esc(String(text || '?').trim()[0]?.toUpperCase() || '?');
const formatDateTime = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const timeOf = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (today - d < 6 * 864e5) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};
const durationText = (s) => (s == null ? '' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
const digits = (phone) => String(phone || '').replace(/\D/g, '');
const looksLikeEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const looksLikePhone = (v) => /^\+?[\d\s().-]{7,}$/.test(v) && digits(v).length >= 7;
const isWide = () => window.matchMedia('(min-width: 820px)').matches;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function toast(message) {
  const node = document.createElement('div');
  node.className = 'toast';
  node.setAttribute('role', 'status');
  node.textContent = message;
  document.body.append(node);
  setTimeout(() => node.remove(), 3500);
}

// Sign-in is kept on this device (Lyrsoft Work keeps it per tab), so the installed app opens signed in.
try {
  if (!sessionStorage.getItem(TOKENS_KEY) && localStorage.getItem(KEEP_KEY)) sessionStorage.setItem(TOKENS_KEY, localStorage.getItem(KEEP_KEY));
} catch {}
function keepTokens() {
  try {
    const tokens = sessionStorage.getItem(TOKENS_KEY);
    if (tokens) localStorage.setItem(KEEP_KEY, tokens);
  } catch {}
}

async function api(method, path, body) {
  let response;
  try {
    response = await authFetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }, WORK_API_BASE);
  } catch (error) {
    if (error.message === 'not_authenticated') {
      signInScreen();
      await new Promise(() => {});
    }
    throw new Error('Can’t reach Lyrsoft. Check your connection.');
  }
  keepTokens();
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    try {
      localStorage.removeItem(KEEP_KEY);
    } catch {}
    signInScreen();
    await new Promise(() => {});
  }
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

// ------------------------------------------------------------------ state

const S = {
  me: null,
  list: null, // GET /chat
  calls: null, // GET /calls
  blocked: null, // GET /chat/blocked
  book: null, // GET /contacts (the address book), loaded automatically
  matches: new Map(), // contact id -> { via, email, name, conv } from GET /chat/address-book
  bookLoadedAt: 0,
  bookLimited: false,
  contactQuery: '',
  route: { view: 'chats', params: new URLSearchParams() },
  search: '',
  newQuery: '',
  notFound: null, // { to } after a phone/email that isn't on Lyrsoft
  incoming: null, // a call ringing for me
  outgoing: null, // { call, startedAt, title, timer }
  current: null, // the call I'm in: { id, convType, sawOther }
  menu: false,
  push: 'unknown', // 'granted' | 'denied' | 'default' | 'unsupported'
  installEvent: null,
  dismissedRing: new Set(),
};

const views = new Map();
const allConversations = () => [...(S.list?.dms || []), ...(S.list?.groups || []), ...(S.list?.channels || []), ...(S.list?.requests || [])];
const findConversation = (id) => allConversations().find((c) => c.id === id);
const getMe = () => S.me;

function parseRoute() {
  const [path, query = ''] = location.hash.replace(/^#/, '').split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const params = new URLSearchParams(query);
  if (parts[0] === 'chat' && parts[1]) return { view: 'chat', conv: parts[1], params };
  if (['calls', 'contacts', 'requests', 'new', 'group', 'settings'].includes(parts[0])) return { view: parts[0], params };
  if (parts[0] === 'call' && parts[1]) return { view: 'incoming', callId: parts[1], params };
  if (parts[0] === 'meet' && parts[1]) return { view: 'meet', meetingId: parts[1], params };
  return { view: 'chats', params };
}
const go = (hash) => {
  if (location.hash === hash) route();
  else location.hash = hash;
};

// ------------------------------------------------------------------ conversations and calls

function viewFor(id) {
  if (!views.has(id)) {
    views.set(id, new ConversationView({
      id, api, esc, toast, initial, getMe,
      onCall: (video) => startCall(id, video),
      onJoinMeeting: (meetingId) => joinMeeting(meetingId),
      onUpdate: (view) => {
        const listed = findConversation(id);
        const last = view.messages.at(-1);
        if (listed && last && last.createdAt !== listed.lastMessageAt) {
          Object.assign(listed, { lastMessageAt: last.createdAt, lastSnippet: last.deleted ? 'Message unsent' : last.body || (last.attachments.length ? (last.attachments.every((a) => a.type.startsWith('audio/')) ? '🎙 Voice message' : '📎 File') : ''), unread: false });
          if (!isWide() || S.route.view !== 'chat') patchList();
        }
        patchConvHead();
      },
    }));
  }
  return views.get(id);
}

const meetings = createMeetings({
  api, esc, toast, initial, formatDateTime, getMe, go,
  render: () => renderBanner(),
  dialog: null,
  chat: { viewFor },
  callRoute: false,
  onCallChange,
});

const ringer = (() => {
  let ctx = null;
  let timer = null;
  const unlock = () => {
    try {
      ctx ??= new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') ctx.resume();
    } catch {}
  };
  for (const type of ['pointerdown', 'keydown', 'touchstart']) addEventListener(type, unlock, { passive: true });
  const tone = (freqs, seconds) => {
    if (!ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.16, t + 0.03);
    gain.gain.setValueAtTime(0.16, t + seconds - 0.06);
    gain.gain.linearRampToValueAtTime(0, t + seconds);
    gain.connect(ctx.destination);
    for (const f of freqs) {
      const osc = ctx.createOscillator();
      osc.frequency.value = f;
      osc.connect(gain);
      osc.start(t);
      osc.stop(t + seconds);
    }
  };
  const stop = () => {
    clearInterval(timer);
    timer = null;
    navigator.vibrate?.(0);
  };
  return {
    // Incoming: two quick trills and a buzz every 2.5 s.
    ring() {
      stop();
      const once = () => {
        tone([880, 1320], 0.35);
        setTimeout(() => tone([880, 1320], 0.35), 480);
        navigator.vibrate?.([400, 200, 400]);
      };
      once();
      timer = setInterval(once, 2500);
    },
    // Outgoing: the long "ringing" tone the caller hears.
    back() {
      stop();
      const once = () => tone([440, 480], 1.4);
      once();
      timer = setInterval(once, 4000);
    },
    stop,
  };
})();

async function startCall(conv, video) {
  if (meetings.currentCall()) return toast('You’re already in a call.');
  const listed = findConversation(conv);
  try {
    const { call } = await api('POST', '/calls', { conv, video });
    S.outgoing = { call, startedAt: Date.now(), title: listed?.title || call.title, timer: setInterval(watchOutgoing, POLL_CALL_MS) };
    S.current = { id: call.id, convType: call.convType, sawOther: false };
    ringer.back();
    renderCalling();
    await meetings.joinCall(call.meetingId, video);
  } catch (error) {
    stopOutgoing();
    toast(error.message);
  }
}

async function watchOutgoing() {
  const out = S.outgoing;
  if (!out) return;
  try {
    const { call } = await api('GET', `/calls/${encodeURIComponent(out.call.id)}`);
    if (S.outgoing !== out) return;
    if (call.answered) return answeredOutgoing();
    if (call.status === 'declined') {
      toast(`${out.title} declined the call.`);
      stopOutgoing();
      return meetings.leaveCall();
    }
    if (Date.now() - out.startedAt > RING_MS) {
      toast('No answer.');
      stopOutgoing();
      return meetings.leaveCall();
    }
  } catch {}
}

function answeredOutgoing() {
  stopOutgoing();
}

function stopOutgoing() {
  if (S.outgoing) clearInterval(S.outgoing.timer);
  S.outgoing = null;
  ringer.stop();
  renderCalling();
}

// The call room tells us when people come and go, and when the call is over.
function onCallChange(info, endedMeetingId) {
  if (info) {
    if (info.people > 1 && S.current) S.current.sawOther = true;
    if (info.people > 1 && S.outgoing) answeredOutgoing();
    // A one-to-one call is over when the other person hangs up.
    if (S.current?.convType === 'dm' && S.current.sawOther && info.people <= 1) {
      toast('Call ended.');
      meetings.leaveCall();
    }
    return renderBanner();
  }
  const current = S.current;
  S.current = null;
  stopOutgoing();
  if (current) api('POST', `/calls/${encodeURIComponent(current.id)}/end`).catch(() => {}).finally(() => S.route.view === 'calls' && loadCalls());
  renderBanner();
  void endedMeetingId;
}

async function answer(call, video) {
  ringer.stop();
  S.incoming = null;
  renderRing();
  try {
    await api('POST', `/calls/${encodeURIComponent(call.id)}/answer`);
    S.current = { id: call.id, convType: call.convType, sawOther: false };
    await meetings.joinCall(call.meetingId, video);
    if (call.conv && isWide()) go(`#/chat/${encodeURIComponent(call.conv)}`);
  } catch (error) {
    toast(error.message);
  }
}

async function decline(call) {
  ringer.stop();
  S.incoming = null;
  S.dismissedRing.add(call.id);
  renderRing();
  await api('POST', `/calls/${encodeURIComponent(call.id)}/decline`).catch(() => {});
}

async function pollRinging() {
  if (!S.me || document.hidden) return;
  try {
    const { calls } = await api('GET', '/calls/ringing');
    const ringing = calls.find((c) => !S.dismissedRing.has(c.id) && c.id !== S.current?.id);
    if (S.incoming && !calls.some((c) => c.id === S.incoming.id)) {
      toast(`Missed call from ${S.incoming.from}`);
      S.incoming = null;
      ringer.stop();
      renderRing();
      refreshList();
    }
    if (ringing && S.incoming?.id !== ringing.id) {
      S.incoming = ringing;
      // Inside Lyrsoft Work, bring Lyr Chat into view.
      if (window.parent !== window) window.parent.postMessage({ type: 'lyrchat-ring' }, location.origin);
      ringer.ring();
      renderRing();
    }
  } catch {}
}

async function joinMeeting(meetingId) {
  if (meetings.currentCall()?.meetingId === meetingId) return meetings.showCall();
  try {
    await meetings.joinCall(meetingId, false);
  } catch (error) {
    toast(error.message);
  }
}

// ------------------------------------------------------------------ data

async function refreshList() {
  try {
    S.list = await api('GET', '/chat');
    patchList();
    patchConvHead();
    const unread = S.list.unreadCount + (S.list.requestCount || 0);
    document.title = unread ? `(${unread}) Lyr Chat` : 'Lyr Chat';
    navigator.setAppBadge?.(unread).catch?.(() => {});
  } catch {}
}

async function loadCalls() {
  try {
    S.calls = (await api('GET', '/calls')).calls;
    if (S.route.view === 'calls') renderSide();
  } catch (error) {
    toast(error.message);
  }
}

async function loadBlocked() {
  try {
    S.blocked = (await api('GET', '/chat/blocked')).blocked;
    if (S.route.view === 'settings') renderSide();
  } catch {}
}

// People I can add to a group: co-workers and people I already chat with.
function people() {
  const map = new Map((S.list?.contacts || []).map((c) => [c.email, c]));
  for (const dm of S.list?.dms || []) if (dm.with && dm.request === 'none' && !map.has(dm.with)) map.set(dm.with, { email: dm.with, name: dm.title });
  return [...map.values()].sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
}

async function openDm(target) {
  const to = String(target || '').trim();
  if (!to) return;
  const body = looksLikeEmail(to) ? { email: to.toLowerCase() } : looksLikePhone(to) ? { phone: to } : null;
  if (!body) return toast('Enter a phone number with its country code (+…) or an email address.');
  try {
    const dm = await api('POST', '/chat/dm', body);
    S.notFound = null;
    await refreshList();
    go(`#/chat/${encodeURIComponent(dm.id)}`);
  } catch (error) {
    if (/no lyrsoft account|verified that number/i.test(error.message)) {
      S.notFound = { to, phone: body.phone || null, email: body.email || null };
      renderSide();
    } else toast(error.message);
  }
}

// ------------------------------------------------------------------ the phone app (Capacitor, mobile/)
// The Android (and later iOS) app loads this page. Google won't sign in inside an app's web view, so
// Google sign-in opens in the phone's browser and comes back on com.lyrsoft.lyrchat://signin with a
// code that only this app (holding the PKCE verifier) can exchange. Push uses Firebase Cloud Messaging
// once the app was built with Firebase (LyrApp.info().firebase); until then calls ring while it's open.

const Native = window.Capacitor?.isNativePlatform?.() ? window.Capacitor.Plugins : null;
const APP_REDIRECT = 'com.lyrsoft.lyrchat://signin';

if (Native?.Browser && Native?.App) {
  window.lyrNativeSignIn = () => redirectToLogin('/chat/', 'google', { redirectUri: APP_REDIRECT, open: (url) => Native.Browser.open({ url, presentationStyle: 'popover' }) });
  Native.App.addListener('appUrlOpen', async ({ url }) => {
    if (!String(url).startsWith(APP_REDIRECT)) return;
    Native.Browser.close().catch(() => {});
    const code = new URL(url).searchParams.get('code');
    if (!code) return toast('Sign-in was cancelled.');
    try {
      await exchangeCodeForTokens(code, APP_REDIRECT);
      keepTokens();
      location.replace('/chat/');
    } catch {
      toast('Google sign-in didn’t finish. Please try again.');
    }
  });
}

let nativeToken = null;
async function enableNativePush(ask) {
  const P = Native?.PushNotifications;
  const info = await Native?.LyrApp?.info?.().catch(() => null);
  if (!P || !info?.firebase) {
    S.push = 'native-later';
    return;
  }
  let { receive } = await P.checkPermissions();
  if (receive === 'prompt' || receive === 'prompt-with-rationale') receive = ask || !nativeToken ? (await P.requestPermissions()).receive : receive;
  S.push = receive === 'granted' ? 'granted' : receive === 'denied' ? 'denied' : 'default';
  if (receive !== 'granted') return;
  await P.createChannel?.({ id: 'calls', name: 'Calls', description: 'Incoming voice and video calls', importance: 5, visibility: 1, vibration: true, sound: 'default' }).catch(() => {});
  await P.createChannel?.({ id: 'messages', name: 'Messages', description: 'New messages', importance: 4, visibility: 0, vibration: true }).catch(() => {});
  if (!enableNativePush.listening) {
    enableNativePush.listening = true;
    P.addListener('registration', async ({ value }) => {
      nativeToken = value;
      await api('POST', '/push/native', { token: value, platform: window.Capacitor.getPlatform() }).catch(() => {});
    });
    // A push while the app is open: ring or refresh straight away.
    P.addListener('pushNotificationReceived', (n) => {
      const data = n.data || {};
      if (data.type === 'call' || data.type === 'call-end') pollRinging();
      if (data.type === 'message') refreshList();
    });
    P.addListener('pushNotificationActionPerformed', ({ notification }) => {
      const url = notification?.data?.url;
      if (url) location.hash = new URL(url, location.origin).hash;
    });
  }
  await P.register();
}

// ------------------------------------------------------------------ push notifications

const b64ToBytes = (b64) => {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

async function swRegistration() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register('/chat/sw.js', { scope: '/chat/' });
  } catch {
    return null;
  }
}

async function enablePush(ask) {
  if (Native) return enableNativePush(ask);
  if (!('PushManager' in window) || !('Notification' in window)) {
    S.push = 'unsupported';
    return;
  }
  const reg = await swRegistration();
  if (!reg) {
    S.push = 'unsupported';
    return;
  }
  let permission = Notification.permission;
  if (permission === 'default' && ask) permission = await Notification.requestPermission();
  S.push = permission;
  if (permission !== 'granted') return;
  try {
    const { publicKey } = await api('GET', '/push/key');
    if (!publicKey) return;
    await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    const key = sub?.options?.applicationServerKey;
    if (sub && key && btoa(String.fromCharCode(...new Uint8Array(key))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== publicKey) {
      await sub.unsubscribe();
      sub = null;
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
    await api('POST', '/push/subscribe', { subscription: sub.toJSON() });
    if (ask) toast('Notifications are on for this device.');
  } catch (error) {
    if (ask) toast(`Couldn’t turn on notifications: ${error.message}`);
  }
}

async function disablePush() {
  if (Native) {
    if (nativeToken) await api('POST', '/push/unsubscribe', { token: nativeToken }).catch(() => {});
    await Native.PushNotifications?.unregister?.().catch(() => {});
    S.push = 'off';
    return;
  }
  const reg = await swRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await api('POST', '/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe().catch(() => {});
  }
  S.push = 'off';
  toast('Notifications are off for this device.');
}

// ------------------------------------------------------------------ rendering

const app = document.getElementById('app');

function shell() {
  if (app.querySelector('.lc')) return;
  app.innerHTML = `
    <div class="lc">
      <aside class="lc-side"></aside>
      <main class="lc-main"></main>
    </div>
    <div class="lc-banner" hidden></div>
    <div class="lc-calling" hidden></div>
    <div class="lc-ring" hidden></div>`;
}

function render() {
  shell();
  const { view } = S.route;
  app.querySelector('.lc').classList.toggle('show-main', ['chat', 'meet'].includes(view));
  renderSide();
  renderMain();
  renderBanner();
  renderCalling();
  renderRing();
}

const tabs = () => {
  const unread = (S.list?.unreadCount || 0) + (S.list?.requestCount || 0);
  const v = S.route.view;
  const tab = (hash, icon, label, on, badge = '') => `<a class="lc-tab${on ? ' on' : ''}" href="${hash}"><span aria-hidden="true">${icon}</span>${label}${badge}</a>`;
  return `<nav class="lc-tabs">
    ${S.me?.mailboxCount ? `<a class="lc-tab" href="/app/#/mail" title="Your team’s mailboxes in Lyrsoft Mail"><span aria-hidden="true">✉️</span>Mail</a>` : ''}
    ${tab('#/', '💬', 'Chats', ['chats', 'chat', 'requests', 'new', 'group'].includes(v), unread ? `<b class="lc-badge">${unread}</b>` : '')}
    ${tab('#/contacts', '👤', 'Contacts', v === 'contacts', S.matches.size ? `<b class="lc-badge soft">${S.matches.size}</b>` : '')}
    ${tab('#/calls', '📞', 'Calls', v === 'calls')}
    ${tab('#/settings', '⚙️', 'Settings', v === 'settings')}
  </nav>`;
};

function sideHead(title, actions = '', back = '') {
  return `<header class="lc-head">${back ? `<a class="lc-icon" href="${back}" aria-label="Back">←</a>` : ''}<h1>${title}</h1><div class="lc-head-actions">${actions}</div></header>`;
}

function renderSide() {
  const side = app.querySelector('.lc-side');
  if (!side) return;
  const v = S.route.view;
  const body = { calls: callsHtml, contacts: contactsHtml, settings: settingsHtml, requests: requestsHtml, new: newChatHtml, group: newGroupHtml }[v] || chatsHtml;
  side.innerHTML = body() + tabs();
}

function convRow(c) {
  const icon = c.type === 'group' ? '👥' : c.type === 'ws' ? '🏢' : '';
  const name = c.title || 'Chat';
  const avatar = icon ? `<span class="avatar lc-av group" aria-hidden="true">${icon}</span>` : avatarHtml({ name }, 'avatar lc-av');
  const active = c.type === 'dm' && c.activeAt && Date.now() - Date.parse(c.activeAt) < 2 * 60_000;
  const current = S.route.conv === c.id;
  return `<a class="lc-row${c.unread ? ' unread' : ''}${current ? ' current' : ''}" href="#/chat/${encodeURIComponent(c.id)}">
    <span class="lc-av-wrap">${avatar}${active ? '<i class="lc-online" title="Active now"></i>' : ''}</span>
    <span class="lc-row-main"><b>${esc(name)}</b><small>${c.request === 'outgoing' ? '⏳ Request sent · ' : ''}${c.blocked ? '🚫 Blocked · ' : ''}${esc(c.lastSnippet || (c.type === 'ws' ? 'Team channel' : 'No messages yet'))}</small></span>
    <span class="lc-row-side"><small>${esc(timeOf(c.lastMessageAt))}</small>${c.unread ? '<i class="lc-dot" aria-label="Unread"></i>' : ''}</span>
  </a>`;
}

function chatsListHtml() {
  if (!S.list) return '<p class="loading">Loading…</p>';
  const q = S.search.trim().toLowerCase();
  const rows = [...S.list.dms, ...S.list.groups, ...S.list.channels]
    .filter((c) => !q || (c.title || '').toLowerCase().includes(q) || (c.lastSnippet || '').toLowerCase().includes(q))
    .sort((a, b) => String(b.lastMessageAt || '').localeCompare(String(a.lastMessageAt || '')));
  const requests = S.list.requestCount ? `<a class="lc-row lc-requests" href="#/requests"><span class="avatar lc-av group" aria-hidden="true">✉</span><span class="lc-row-main"><b>Message requests</b><small>${S.list.requestCount} ${S.list.requestCount === 1 ? 'person wants' : 'people want'} to chat with you</small></span><span class="lc-row-side"><b class="lc-badge">${S.list.requestCount}</b></span></a>` : '';
  const pushHint = S.push === 'default' || (!Native && isIos() && !standalone() && S.push === 'unsupported')
    ? `<div class="lc-hint">${!Native && isIos() && !standalone() ? '📲 To get calls and messages when the app is closed, tap <b>Share → Add to Home Screen</b>, then open Lyr Chat from there.' : `🔔 Get calls and messages even when the app is closed. <button class="btn small primary" data-act="push-on">Turn on</button>`}</div>`
    : '';
  const onChat = S.matches.size && rows.length < 3 && !q
    ? `<a class="lc-row lc-requests" href="#/contacts"><span class="avatar lc-av group" aria-hidden="true">👤</span><span class="lc-row-main"><b>${S.matches.size} of your contacts ${S.matches.size === 1 ? 'is' : 'are'} on Lyr Chat</b><small>Say hello or give them a call</small></span></a>`
    : '';
  return `${pushHint}${requests}${onChat}${rows.map(convRow).join('') || `<div class="lc-empty"><p>${q ? 'No chats match.' : 'No chats yet.'}</p><a class="btn primary" href="#/new">Start a chat</a></div>`}`;
}

function chatsHtml() {
  return `${sideHead('Lyr Chat', `<a class="lc-icon" href="#/group" title="New group" aria-label="New group">👥</a><a class="lc-icon" href="#/new" title="New chat" aria-label="New chat">✎</a>`)}
    <div class="lc-search"><input type="search" placeholder="Search chats" value="${esc(S.search)}" data-input="search" aria-label="Search chats" /></div>
    <div class="lc-list">${chatsListHtml()}</div>
    <a class="lc-fab" href="#/new" aria-label="New chat">✎</a>`;
}

function patchList() {
  const list = app.querySelector('.lc-list');
  if (list && ['chats', 'chat'].includes(S.route.view)) list.innerHTML = chatsListHtml();
  else if (S.route.view === 'requests') renderSide();
  const tabsNode = app.querySelector('.lc-tabs');
  if (tabsNode) tabsNode.outerHTML = tabs();
}

function requestsHtml() {
  const rows = S.list?.requests || [];
  return `${sideHead('Message requests', '', '#/')}
    <p class="lc-note">People outside your workspaces. They won’t know you’ve seen their message until you accept or reply.</p>
    <div class="lc-list">${rows.map(convRow).join('') || '<div class="lc-empty"><p>No message requests.</p></div>'}</div>`;
}

function newChatHtml() {
  const q = S.newQuery.trim().toLowerCase();
  const match = (p) => !q || (p.name || '').toLowerCase().includes(q) || (p.email || '').toLowerCase().includes(q);
  const coworkers = (S.list?.contacts || []).filter(match);
  const book = onLyrChat().filter((c) => contactMatches(c, q));
  const nf = S.notFound;
  const inviteRow = nf ? `
    <div class="lc-invite">
      <p><b>${esc(nf.to)}</b> isn’t on Lyr Chat yet${nf.phone ? ' (or hasn’t verified that number)' : ''}. Invite them:</p>
      <div class="lc-invite-buttons">
        ${nf.phone ? `<a class="btn" href="https://wa.me/${digits(nf.phone)}?text=${encodeURIComponent(INVITE_TEXT)}" target="_blank" rel="noopener">🟢 WhatsApp</a><a class="btn" href="sms:${esc(nf.phone.replace(/[^\d+]/g, ''))}?&body=${encodeURIComponent(INVITE_TEXT)}">💬 SMS</a>` : ''}
        ${(S.book || []).some((c) => (nf.phone && c.phones.some((x) => sameNumber(x.value, nf.phone))) || (nf.email && c.emails.some((x) => x.value === nf.email.toLowerCase()))) ? '' : `<button class="btn" data-act="add-contact" data-phone="${esc(nf.phone || '')}" data-email="${esc(nf.email || '')}">＋ Save contact</button>`}
        ${nf.email ? `<a class="btn" href="mailto:${esc(nf.email)}?subject=${encodeURIComponent('Chat with me on Lyr Chat')}&body=${encodeURIComponent(INVITE_TEXT)}">✉ Email</a>` : ''}
        <button class="btn" data-act="share-invite">↗ Share link</button>
      </div>
    </div>` : '';
  return `${sideHead('New chat', '', '#/')}
    <form class="lc-new" data-form="new-chat">
      <input name="to" placeholder="Phone number (+…) or email" autocomplete="off" value="${esc(S.newQuery)}" data-input="new-query" aria-label="Phone number or email" />
      <button class="btn primary">Chat</button>
    </form>
    <p class="lc-note">Anyone on Lyrsoft: by email, or by the mobile number they verified. People outside your workspaces get a message request first.</p>
    ${inviteRow}
    <a class="lc-row" href="#/group"><span class="avatar lc-av group" aria-hidden="true">👥</span><span class="lc-row-main"><b>New group</b><small>Chat and call with several people</small></span></a>
    <div class="lc-list">
      ${coworkers.length ? `<h2 class="lc-section">People you work with</h2>${coworkers.map((p) => `<button class="lc-row" data-act="dm" data-to="${esc(p.email)}">${avatarHtml(p, 'avatar lc-av')}<span class="lc-row-main"><b>${esc(p.name || p.email)}</b><small>${esc(p.email)}</small></span></button>`).join('')}` : ''}
      <h2 class="lc-section">Your contacts on Lyr Chat</h2>
      ${S.book === null ? '<p class="loading">Loading your contacts…</p>' : book.length ? book.slice(0, 300).map(contactRow).join('') : `<p class="lc-note">${S.matches.size ? 'No contacts match.' : 'None of your contacts are on Lyr Chat yet.'} <a href="#/contacts">All contacts</a></p>`}
    </div>`;
}

// ---------------------------------------------------------------- Contacts tab

const contactMatches = (c, q) => !q || c.name.toLowerCase().includes(q) || c.phones.some((p) => digits(q) && digits(p.value).includes(digits(q))) || c.emails.some((e) => e.value.toLowerCase().includes(q));
const onLyrChat = () => (S.book || []).filter((c) => S.matches.has(c.id));
const reachableContact = (c) => !S.matches.has(c.id) && (c.phones.length || c.emails.length);

function contactRow(c) {
  const m = S.matches.get(c.id);
  const sub = m ? (m.via === 'email' ? m.email : `On Lyr Chat${m.name && m.name.toLowerCase() !== c.name.split(' ')[0].toLowerCase() ? ` as ${m.name}` : ''} · ${c.phones[0]?.value || ''}`) : [c.phones[0]?.value, c.emails[0]?.value].filter(Boolean).join(' · ');
  return `<div class="lc-row lc-contact">
    <button class="lc-call-open" data-act="${m ? 'chat-contact' : 'invite-contact'}" data-id="${esc(c.id)}">${avatarHtml({ name: c.name }, 'avatar lc-av')}<span class="lc-row-main"><b>${esc(c.name)}</b><small>${esc(sub)}</small></span></button>
    ${m
      ? `<button class="lc-icon" data-act="call-contact" data-id="${esc(c.id)}" data-video="0" aria-label="Voice call ${esc(c.name)}">📞</button><button class="lc-icon" data-act="call-contact" data-id="${esc(c.id)}" data-video="1" aria-label="Video call ${esc(c.name)}">📹</button>`
      : `<button class="btn small" data-act="invite-contact" data-id="${esc(c.id)}">Invite</button>`}
  </div>`;
}

function contactsListHtml() {
  if (S.book === null) return '<p class="loading">Loading your contacts…</p>';
  if (!S.book.length) return `<div class="lc-empty"><p>Your Lyrsoft Contacts are empty.</p><p class="lc-note">Import your phone’s or Google’s contacts there, and everyone who’s on Lyrsoft shows up here.</p><div class="lc-invite-buttons"><button class="btn primary" data-act="add-contact">＋ New contact</button><a class="btn" href="/app/#/contacts" target="_blank" rel="noopener">📇 Import contacts</a></div></div>`;
  const q = S.contactQuery.trim().toLowerCase();
  const on = onLyrChat().filter((c) => contactMatches(c, q));
  const rest = S.book.filter(reachableContact).filter((c) => contactMatches(c, q));
  return `
    <h2 class="lc-section">On Lyr Chat · ${on.length}</h2>
    ${on.map(contactRow).join('') || `<p class="lc-note">${q ? 'No one matches.' : 'None of your contacts are on Lyrsoft yet. Invite them below.'}</p>`}
    ${S.bookLimited ? '<p class="lc-note">You’ve checked a lot of numbers today; new phone numbers will be matched tomorrow.</p>' : ''}
    <h2 class="lc-section">Invite to Lyr Chat · ${rest.length}</h2>
    ${rest.slice(0, 500).map(contactRow).join('')}
    ${rest.length > 500 ? `<p class="lc-note">Showing 500 of ${rest.length}. Search to find others.</p>` : ''}`;
}

function contactsHtml() {
  return `${sideHead('Contacts', '<a class="lc-icon" href="/app/#/contacts" target="_blank" rel="noopener" title="Import contacts" aria-label="Import contacts">📇</a><button class="lc-icon" data-act="add-contact" title="New contact" aria-label="New contact">＋</button>')}
    <div class="lc-search"><input type="search" placeholder="Search contacts" value="${esc(S.contactQuery)}" data-input="contact-search" aria-label="Search contacts" /></div>
    <p class="lc-note">From your Lyrsoft Contacts. People who are on Lyrsoft (by email, or by a mobile number they verified) appear automatically.</p>
    <div class="lc-list lc-contacts">${contactsListHtml()}</div>`;
}

// The address book and who in it is on Lyr Chat: on start, then again when it's over 5 minutes old.
async function loadBook(force = false) {
  if (!force && S.book && Date.now() - S.bookLoadedAt < 5 * 60_000) return;
  S.bookLoadedAt = Date.now();
  try {
    const [book, found] = await Promise.all([api('GET', '/contacts'), api('GET', '/chat/address-book')]);
    S.book = book.contacts.sort((a, b) => a.name.localeCompare(b.name));
    S.matches = new Map(found.matches.map((m) => [m.id, m]));
    S.bookLimited = found.limited;
  } catch (error) {
    S.book ??= [];
    if (S.route.view === 'contacts') toast(error.message);
  }
  if (['contacts', 'new'].includes(S.route.view)) renderSide();
  else patchList();
}

async function dmContact(id) {
  const dm = await api('POST', '/chat/dm', { contactId: id });
  const m = S.matches.get(id);
  if (m) m.conv = dm.id;
  refreshList();
  return dm;
}

function inviteDialog(c) {
  const phone = c.phones[0]?.value;
  const email = c.emails[0]?.value;
  const node = document.createElement('dialog');
  node.className = 'dialog lc-dialog';
  node.innerHTML = `<form method="dialog"><h2>Invite ${esc(c.name)}</h2><p class="muted">${esc(c.name.split(' ')[0])} isn’t on Lyr Chat yet${phone ? ' (or hasn’t verified their number)' : ''}. Send them the link:</p>
    <div class="lc-invite-buttons">
      ${phone ? `<a class="btn" href="https://wa.me/${digits(phone).replace(/^00/, '')}?text=${encodeURIComponent(INVITE_TEXT)}" target="_blank" rel="noopener">🟢 WhatsApp</a><a class="btn" href="sms:${esc(phone.replace(/[^\d+]/g, ''))}?&body=${encodeURIComponent(INVITE_TEXT)}">💬 SMS</a>` : ''}
      ${email ? `<a class="btn" href="mailto:${esc(email)}?subject=${encodeURIComponent('Chat with me on Lyr Chat')}&body=${encodeURIComponent(INVITE_TEXT)}">✉ Email</a>` : ''}
      <button type="button" class="btn" data-act="share-invite">↗ Share</button>
    </div>
    <div class="row end"><button class="btn primary">Done</button></div></form>`;
  document.body.append(node);
  node.addEventListener('close', () => node.remove());
  node.addEventListener('click', (e) => e.target.closest('a') && setTimeout(() => node.close(), 100));
  node.showModal();
}

// Saving someone straight from Lyr Chat: a name and a mobile number (an email is optional). The number
// can be typed any way (Bangla digits, spaces, dashes, pasted from WhatsApp); the API tidies it.
const DIGIT_ZEROS = [0x660, 0x6f0, 0x966, 0x9e6, 0xff10]; // Arabic-Indic, Persian, Devanagari, Bangla, full-width
const asciiDigits = (v) => String(v || '').replace(/[٠-٩۰-۹०-९০-৯０-９]/g, (d) => {
  const code = d.charCodeAt(0);
  return String(code - DIGIT_ZEROS.find((z) => code >= z && code <= z + 9));
});
const sameNumber = (a, b) => {
  const x = digits(asciiDigits(a)).slice(-9);
  return x.length >= 6 && x === digits(asciiDigits(b)).slice(-9);
};

function addContactDialog({ name = '', phone = '', email = '' } = {}) {
  const node = document.createElement('dialog');
  node.className = 'dialog lc-dialog';
  node.innerHTML = `<form class="lc-add-contact"><h2>New contact</h2>
    <label>Name<input name="name" maxlength="200" autocomplete="off" value="${esc(name)}" placeholder="Their name" /></label>
    <label>Mobile number<input name="phone" type="tel" inputmode="tel" autocomplete="off" value="${esc(phone)}" placeholder="01712-345678 or +880 1712-345678" /></label>
    <label>Email <small class="muted">(optional)</small><input name="email" type="text" inputmode="email" autocomplete="off" value="${esc(email)}" placeholder="name@example.com" /></label>
    <p class="lc-form-error" role="alert" hidden></p>
    <p class="lc-note">Saved to your own Lyrsoft Contacts. Only you can see them.</p>
    <div class="row end"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Save</button></div></form>`;
  document.body.append(node);
  const form = node.querySelector('form');
  const error = node.querySelector('.lc-form-error');
  const fail = (message) => {
    error.textContent = message;
    error.hidden = false;
  };
  node.addEventListener('close', () => node.remove());
  node.querySelector('[data-close]').addEventListener('click', () => node.close());
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.hidden = true;
    const data = new FormData(form);
    const n = String(data.get('name')).trim();
    const p = String(data.get('phone')).trim();
    const e = String(data.get('email')).trim();
    if (!n && !p && !e) return fail('Type a name and a mobile number.');
    if (p && digits(asciiDigits(p)).length < 3) return fail('Type the mobile number with digits, like 01712-345678.');
    const already = p && (S.book || []).find((c) => c.phones.some((x) => sameNumber(x.value, p)));
    if (already) return fail(`${already.name} already has this number in your contacts.`);
    const button = form.querySelector('button.primary');
    button.disabled = true;
    try {
      const { contact } = await api('POST', '/contacts', { contact: { name: n, phones: p ? [{ value: p, label: 'mobile' }] : [], emails: e ? [{ value: e, label: '' }] : [] } });
      node.close();
      toast(`Saved ${contact.name}`);
      S.book = [...(S.book || []), contact].sort((a, b) => a.name.localeCompare(b.name));
      if (S.route.view === 'contacts') renderSide();
      loadBook(true);
    } catch (err) {
      fail(err.message);
      button.disabled = false;
    }
  });
  node.showModal();
  setTimeout(() => form.querySelector(name ? 'input[name="phone"]' : 'input[name="name"]').focus());
}

function newGroupHtml() {
  const list = people();
  return `${sideHead('New group', '', '#/new')}
    <form class="lc-group" data-form="new-group">
      <input name="name" maxlength="80" required placeholder="Group name" aria-label="Group name" />
      <div class="lc-pick">${list.map((p) => `<label class="lc-row"><input type="checkbox" name="m" value="${esc(p.email)}" />${avatarHtml(p, 'avatar lc-av')}<span class="lc-row-main"><b>${esc(p.name || p.email)}</b><small>${esc(p.email)}</small></span></label>`).join('') || '<p class="lc-note">Groups can have people you work with or already chat with. Start a chat with someone first.</p>'}</div>
      <button class="btn primary big">Create group</button>
    </form>`;
}

function callsHtml() {
  const rows = S.calls;
  const role = S.me?.globalRole;
  const admin = role === 'admin' || role === 'superadmin';
  return `${sideHead('Calls', admin && rows?.length ? '<button class="btn small ghost" data-act="calls-clear" title="Clear your call history">Clear</button>' : '')}
    <div class="lc-list">${rows === null ? '<p class="loading">Loading…</p>' : rows.map((c) => {
      const arrow = c.direction === 'outgoing' ? '↗' : '↙';
      const what = c.missed ? 'Missed' : c.declined ? 'Declined' : c.direction === 'outgoing' ? 'Outgoing' : 'Incoming';
      return `<div class="lc-row lc-call${c.missed ? ' missed' : ''}">
        <a class="lc-call-open" href="#/chat/${encodeURIComponent(c.conv)}">${c.convType === 'group' ? '<span class="avatar lc-av group" aria-hidden="true">👥</span>' : avatarHtml({ name: c.title }, 'avatar lc-av')}
        <span class="lc-row-main"><b>${esc(c.title)}</b><small>${arrow} ${what} ${c.video ? 'video' : 'voice'} · ${esc(timeOf(c.startedAt))}${c.durationSec ? ` · ${durationText(c.durationSec)}` : ''}</small></span></a>
        <button class="lc-icon" data-act="call" data-conv="${esc(c.conv)}" data-video="0" aria-label="Voice call">📞</button>
        <button class="lc-icon" data-act="call" data-conv="${esc(c.conv)}" data-video="1" aria-label="Video call">📹</button>
        ${admin ? `<button class="lc-icon" data-act="call-delete" data-id="${esc(c.id)}" aria-label="Remove from call history" title="Remove from my history">🗑</button>` : ''}
        ${role === 'superadmin' ? `<button class="lc-icon" data-act="call-delete" data-id="${esc(c.id)}" data-everyone="1" aria-label="Delete for everyone" title="Delete for everyone">⛔</button>` : ''}
      </div>`;
    }).join('') || '<div class="lc-empty"><p>No calls yet. Open a chat and tap 📞 or 📹.</p></div>'}</div>`;
}

function settingsHtml() {
  const me = S.me;
  const profile = me.profile || {};
  const pushRow = {
    'native-later': '<p>📞 Calls and messages ring while Lyr Chat is open. Notifications when it’s closed are coming in an app update.</p>',
    granted: '<p>🔔 Notifications are on for this device.</p><button class="btn small" data-act="push-off">Turn off</button>',
    off: '<p>🔕 Notifications are off for this device.</p><button class="btn small primary" data-act="push-on">Turn on</button>',
    default: '<p>Get messages and calls when the app is closed.</p><button class="btn small primary" data-act="push-on">Turn on notifications</button>',
    denied: '<p>🔕 Notifications are blocked. Allow them for lyrsoft.com in your browser’s site settings.</p>',
    unsupported: isIos() && !standalone()
      ? '<p>📲 On iPhone and iPad, tap <b>Share → Add to Home Screen</b>, then open Lyr Chat from your home screen to turn on notifications.</p>'
      : '<p>This browser can’t show notifications.</p>',
  }[S.push] || '<p class="muted">Checking notifications…</p>';
  return `${sideHead('Settings')}
    <div class="lc-settings">
      <section class="lc-card lc-me">${avatarHtml({ name: me.name, email: me.email, avatar: profile.avatar }, 'avatar lc-av big')}<div><b>${esc(me.name || me.email)}</b><small>${esc(me.email)}</small><small>${profile.phoneVerified ? `📱 ${esc(profile.phone)} · people can find you by this number` : '📱 <a href="/app/#/profile" target="_blank" rel="noopener">Verify your mobile number</a> so people can find you by it'}</small></div></section>
      <section class="lc-card"><h2>Notifications</h2>${pushRow}</section>
      ${isAndroid() && !inApp() ? `<section class="lc-card"><h2>Android app</h2><p>Get Lyr Chat as an app on this phone.</p><a class="btn small primary" href="${APK_URL}" download="LyrChat.apk">⬇ Download for Android</a><p class="muted">Open the downloaded file. If Android asks, allow your browser to install apps, then tap Install.</p></section>` : S.installEvent ? '<section class="lc-card"><h2>Install</h2><p>Add Lyr Chat to your home screen or desktop.</p><button class="btn small primary" data-act="install">⬇ Install Lyr Chat</button></section>' : ''}
      <section class="lc-card"><h2>Blocked people</h2>${S.blocked === null ? '<p class="muted">Loading…</p>' : S.blocked.length ? `<ul class="lc-blocked">${S.blocked.map((b) => `<li><span>${esc(b.name)}</span><button class="btn small" data-act="unblock" data-conv="${esc(b.conv)}">Unblock</button></li>`).join('')}</ul>` : '<p class="muted">No one. Block someone from the ⋮ menu in a chat.</p>'}</section>
      <section class="lc-card"><h2>More</h2>
        <p><a href="/app/#/contacts" target="_blank" rel="noopener">📇 Contacts</a> · <a href="/app/#/meetings" target="_blank" rel="noopener">📅 Scheduled meetings</a> · <a href="/app/" target="_blank" rel="noopener">Lyrsoft Work</a></p>
        <button class="btn small ghost danger" data-act="sign-out">Sign out</button>
      </section>
    </div>`;
}

// ---------------------------------------------------------------- the open conversation

function convInfo(id) {
  const listed = findConversation(id);
  const conversation = views.get(id)?.conversation;
  const type = conversation?.type || listed?.type || 'dm';
  return {
    type,
    title: listed?.title || conversation?.title || 'Chat',
    request: conversation?.request || listed?.request || 'none',
    blocked: conversation?.blocked ?? listed?.blocked ?? false,
    support: Boolean(conversation?.support),
    label: conversation?.label || '',
    canCall: conversation ? conversation.canCall : ['dm', 'group'].includes(type) && (listed?.request || 'none') === 'none',
    members: conversation?.members?.length || listed?.memberCount || 0,
    canDelete: Boolean(conversation?.canDelete ?? listed?.canDelete),
  };
}

function convHeadHtml(id) {
  const c = convInfo(id);
  const view = views.get(id);
  const sub = c.type === 'group' ? `${c.members} members` : c.type === 'ws' ? 'Team channel' : view?.activeText() || '';
  const avatar = c.type === 'group' ? '<span class="avatar lc-av group" aria-hidden="true">👥</span>' : c.type === 'ws' ? '<span class="avatar lc-av group" aria-hidden="true">🏢</span>' : avatarHtml({ name: c.title }, 'avatar lc-av');
  const callButtons = ['dm', 'group'].includes(c.type)
    ? `<button class="lc-icon" data-act="call" data-conv="${esc(id)}" data-video="0"${c.canCall ? '' : ' disabled'} title="${c.canCall ? 'Voice call' : 'Calls work once they accept your request'}" aria-label="Voice call">📞</button><button class="lc-icon" data-act="call" data-conv="${esc(id)}" data-video="1"${c.canCall ? '' : ' disabled'} title="${c.canCall ? 'Video call' : 'Calls work once they accept your request'}" aria-label="Video call">📹</button>`
    : '';
  const menu = S.menu
    ? `<div class="lc-menu" role="menu">
        ${c.type === 'dm' ? `${c.blocked ? `<button data-act="unblock" data-conv="${esc(id)}">✅ Unblock</button>` : `<button data-act="block" data-conv="${esc(id)}">🚫 Block</button>`}<button data-act="report" data-conv="${esc(id)}">⚠️ Report and block</button>` : ''}
        ${c.type === 'group' ? `<button data-act="group-add" data-conv="${esc(id)}">➕ Add people</button><button data-act="group-rename" data-conv="${esc(id)}">✎ Rename</button><button data-act="group-leave" data-conv="${esc(id)}">🚪 Leave group</button>` : ''}
        ${c.canDelete ? `<button class="danger" data-act="conv-delete" data-conv="${esc(id)}">🗑 ${c.type === 'ws' ? 'Clear history' : 'Delete for everyone'}</button>` : ''}
        <a href="/app/#/chat/${encodeURIComponent(id)}" target="_blank" rel="noopener">Open in Lyrsoft Work</a>
      </div>`
    : '';
  return `<a class="lc-icon lc-back" href="#/" aria-label="Back">←</a>${avatar}<div class="lc-conv-title"><b>${esc(c.title)}</b><small>${esc(sub)}</small></div>
    <div class="lc-head-actions">${callButtons}<button class="lc-icon" data-act="menu" aria-label="More">⋮</button>${menu}</div>`;
}

function requestBarHtml(id) {
  const c = convInfo(id);
  if (c.blocked) return `<div class="lc-request">You blocked ${esc(c.title)}. They can’t message or call you here. <button class="btn small" data-act="unblock" data-conv="${esc(id)}">Unblock</button></div>`;
  if (c.request === 'incoming' && c.support) {
    return `<div class="lc-request"><p><b>${esc(c.title)}</b> wrote to Lyrsoft Support from ${esc(c.label || 'a Lyr site')}. Reply to help them. They see you as Lyrsoft Support, never your email.</p>
      <div class="lc-request-buttons"><button class="btn primary small" data-act="accept" data-conv="${esc(id)}">Accept</button><button class="btn small" data-act="delete-request" data-conv="${esc(id)}">Delete</button><button class="btn small" data-act="block" data-conv="${esc(id)}">Block</button></div></div>`;
  }
  if (c.request === 'outgoing' && c.support) return `<div class="lc-request muted">💬 You’re chatting with Lyrsoft Support. We usually reply within a few hours; you’ll get a notification.</div>`;
  if (c.request === 'incoming') {
    return `<div class="lc-request"><p><b>${esc(c.title)}</b> isn’t in your workspaces and wants to chat. Accepting (or replying) lets them see your email and call you.</p>
      <div class="lc-request-buttons"><button class="btn primary small" data-act="accept" data-conv="${esc(id)}">Accept</button><button class="btn small" data-act="delete-request" data-conv="${esc(id)}">Delete</button><button class="btn small" data-act="block" data-conv="${esc(id)}">Block</button><button class="btn small ghost danger" data-act="report" data-conv="${esc(id)}">Report</button></div></div>`;
  }
  if (c.request === 'outgoing') return `<div class="lc-request muted">⏳ Message request sent. ${esc(c.title.split(' · ')[0] || 'They')} can read your messages and accept. You can call once they do.</div>`;
  return '';
}

function patchConvHead() {
  const main = app.querySelector('.lc-main');
  const id = main?.dataset.conv;
  if (!id) return;
  const head = main.querySelector('.lc-conv-head');
  if (head) head.innerHTML = convHeadHtml(id);
  const bar = main.querySelector('.lc-request-host');
  if (bar) bar.innerHTML = requestBarHtml(id);
}

function renderMain() {
  const main = app.querySelector('.lc-main');
  if (!main) return;
  const { view, conv } = S.route;
  if (view === 'chat') {
    if (main.dataset.conv !== conv) {
      main.dataset.conv = conv;
      S.menu = false;
      main.innerHTML = `<header class="lc-conv-head"></header><div class="lc-request-host"></div><div class="lc-conv-host"></div>`;
      const v = viewFor(conv);
      v.mount(main.querySelector('.lc-conv-host')).then(() => {
        patchConvHead();
        if (isWide()) v.focus();
      }).catch((error) => {
        main.querySelector('.lc-conv-host').innerHTML = `<div class="lc-empty"><p>${esc(error.message)}</p><a class="btn" href="#/">Back to chats</a></div>`;
      });
    }
    patchConvHead();
    return;
  }
  // Leaving a conversation stops its polling, unless the call's chat panel is showing it.
  const old = main.dataset.conv && views.get(main.dataset.conv);
  if (old && !old.el?.closest('#call-root')) old.unmount();
  delete main.dataset.conv;
  if (view === 'meet') {
    main.innerHTML = `<div class="lc-empty lc-join"><span class="lc-join-icon" aria-hidden="true">📹</span><h2>Join the call</h2><p class="muted">Your browser will ask for your microphone and camera.</p>
      <div class="lc-invite-buttons"><button class="btn primary big" data-act="join" data-meeting="${esc(S.route.meetingId)}" data-video="0">📞 Join with audio</button><button class="btn big" data-act="join" data-meeting="${esc(S.route.meetingId)}" data-video="1">📹 Join with video</button></div>
      <a class="btn ghost" href="#/">Back to chats</a></div>`;
    return;
  }
  main.innerHTML = `<div class="lc-empty lc-welcome"><img src="/brand/lyrsoft-mark.svg" alt="" width="64" height="64" /><h2>Lyr Chat</h2><p class="muted">Messages, voice and video calls with anyone on Lyrsoft.</p><a class="btn primary" href="#/new">Start a chat</a></div>`;
}

// ---------------------------------------------------------------- call overlays

function renderBanner() {
  const node = app.querySelector('.lc-banner');
  if (!node) return;
  const html = meetings.banner();
  node.hidden = !html;
  node.innerHTML = html;
}

function renderCalling() {
  const node = app.querySelector('.lc-calling');
  if (!node) return;
  const out = S.outgoing;
  node.hidden = !out;
  node.innerHTML = out ? `<span class="lc-pulse" aria-hidden="true">${out.call.video ? '📹' : '📞'}</span><span>Calling <b>${esc(out.title)}</b>… <small>Ringing</small></span><button class="btn small danger" data-act="cancel-call">End</button>` : '';
}

function renderRing() {
  const node = app.querySelector('.lc-ring');
  if (!node) return;
  const call = S.incoming;
  node.hidden = !call;
  if (!call) return (node.innerHTML = '');
  const group = call.convType === 'group';
  node.innerHTML = `
    <div class="lc-ring-card" role="dialog" aria-label="Incoming call">
      ${avatarHtml({ name: call.from }, 'avatar lc-av huge')}
      <p class="lc-ring-what">Incoming ${call.video ? 'video' : 'voice'} call${group ? ` · ${esc(call.title)}` : ''}</p>
      <h2>${esc(call.from)}</h2>
      <div class="lc-ring-buttons">
        <button class="lc-ring-btn decline" data-act="decline-call" aria-label="Decline"><span>📞</span>Decline</button>
        ${call.video ? '<button class="lc-ring-btn answer" data-act="answer-call" data-video="0" aria-label="Answer with audio"><span>📞</span>Audio</button>' : ''}
        <button class="lc-ring-btn answer" data-act="answer-call" data-video="${call.video ? '1' : '0'}" aria-label="Answer"><span>${call.video ? '📹' : '📞'}</span>${call.video ? 'Video' : 'Answer'}</button>
      </div>
    </div>`;
}

// ------------------------------------------------------------------ routing and events

async function route() {
  S.route = parseRoute();
  const { view } = S.route;
  if (view === 'calls' && S.calls === null) loadCalls();
  if (view === 'calls' && S.calls) loadCalls();
  if (view === 'settings') loadBlocked();
  if (view === 'contacts' || view === 'new') loadBook();
  if (view === 'new' && S.route.params.get('to') === 'support') {
    // From Lyrbot's "Lyr Chat" button on a Lyr site: straight into a chat with Lyrsoft Support.
    try {
      const dm = await api('POST', '/chat/dm', { support: S.route.params.get('site') || 'Lyrsoft' });
      await refreshList();
      return go(`#/chat/${encodeURIComponent(dm.id)}`);
    } catch (error) {
      toast(error.message);
    }
  } else if (view === 'new' && S.route.params.get('to')) {
    S.newQuery = S.route.params.get('to');
    openDm(S.newQuery);
  }
  if (view === 'incoming') {
    try {
      const { call } = await api('GET', `/calls/${encodeURIComponent(S.route.callId)}`);
      if (call.ringing) {
        S.incoming = call;
        ringer.ring();
      } else toast(call.status === 'answered' ? 'This call was answered on another device.' : 'This call has ended.');
    } catch (error) {
      toast(error.message);
    }
    history.replaceState(null, '', S.incoming?.conv ? `#/chat/${encodeURIComponent(S.incoming.conv)}` : '#/');
    S.route = parseRoute();
  }
  if (view === 'chat' && !findConversation(S.route.conv)) refreshList();
  render();
}

const actions = {
  'push-on': () => enablePush(true).then(render),
  'push-off': () => disablePush().then(render),
  install: async () => {
    const event = S.installEvent;
    S.installEvent = null;
    await event?.prompt();
    render();
  },
  'sign-out': async () => {
    if (!confirm('Sign out of Lyr Chat on this device?')) return;
    await disablePush().catch(() => {});
    try {
      localStorage.removeItem(KEEP_KEY);
    } catch {}
    // In the phone app, signing out just forgets this device's session.
    if (Native) {
      clearTokens();
      return location.replace('/chat/');
    }
    logout();
  },
  dm: (t) => openDm(t.dataset.to),
  'chat-contact': async (t) => {
    try {
      const dm = await dmContact(t.dataset.id);
      go(`#/chat/${encodeURIComponent(dm.id)}`);
    } catch (error) {
      toast(error.message);
    }
  },
  'call-contact': async (t) => {
    try {
      const dm = await dmContact(t.dataset.id);
      if (dm.request === 'outgoing') {
        toast('They need to accept your message first. Say hello!');
        return go(`#/chat/${encodeURIComponent(dm.id)}`);
      }
      await startCall(dm.id, t.dataset.video === '1');
    } catch (error) {
      toast(error.message);
    }
  },
  'add-contact': (t) => addContactDialog({ phone: t.dataset.phone || '', email: t.dataset.email || '' }),
  'invite-contact': (t) => {
    const c = S.book?.find((x) => x.id === t.dataset.id);
    if (c) inviteDialog(c);
  },
  'share-invite': async () => {
    try {
      if (navigator.share) await navigator.share({ title: 'Lyr Chat', text: INVITE_TEXT, url: INVITE_URL });
      else {
        await navigator.clipboard.writeText(INVITE_TEXT);
        toast('Invite copied');
      }
    } catch {}
  },
  call: (t) => startCall(t.dataset.conv, t.dataset.video === '1'),
  'cancel-call': () => {
    stopOutgoing();
    meetings.leaveCall();
  },
  'answer-call': (t) => S.incoming && answer(S.incoming, t.dataset.video === '1'),
  'decline-call': () => S.incoming && decline(S.incoming),
  join: (t) => joinMeeting(t.dataset.meeting),
  menu: () => {
    S.menu = !S.menu;
    patchConvHead();
  },
  accept: async (t) => {
    try {
      await api('POST', `/chat/${encodeURIComponent(t.dataset.conv)}/request`, { action: 'accept' });
      await reloadConversation(t.dataset.conv);
      toast('Accepted. You can chat and call now.');
    } catch (error) {
      toast(error.message);
    }
  },
  'delete-request': async (t) => {
    if (!confirm('Delete this message request? They won’t be told.')) return;
    try {
      await api('POST', `/chat/${encodeURIComponent(t.dataset.conv)}/request`, { action: 'delete' });
      await refreshList();
      go('#/requests');
    } catch (error) {
      toast(error.message);
    }
  },
  block: async (t) => {
    const c = convInfo(t.dataset.conv);
    if (!confirm(`Block ${c.title}? They won’t be able to message or call you in this chat. They aren’t told.`)) return;
    await blockAction(t.dataset.conv, { on: true });
  },
  report: async (t) => {
    const c = convInfo(t.dataset.conv);
    const reason = prompt(`Report ${c.title} to Lyrsoft? Their recent messages in this chat are sent with your report, and they’ll be blocked.\n\nWhat’s wrong? (optional)`, '');
    if (reason === null) return;
    await blockAction(t.dataset.conv, { on: true, report: true, reason });
  },
  unblock: async (t) => {
    await blockAction(t.dataset.conv, { on: false });
    if (S.route.view === 'settings') loadBlocked();
  },
  'group-add': async (t) => {
    const conv = t.dataset.conv;
    const members = new Set(views.get(conv)?.conversation?.members || []);
    const choices = people().filter((p) => !members.has(p.email));
    if (!choices.length) return toast('Everyone you chat with is already in this group.');
    const picked = await pickDialog('Add people', choices);
    if (!picked?.length) return;
    try {
      await api('PATCH', `/chat/${encodeURIComponent(conv)}`, { add: picked });
      await reloadConversation(conv);
    } catch (error) {
      toast(error.message);
    }
  },
  'group-rename': async (t) => {
    const conv = t.dataset.conv;
    const name = prompt('Group name', convInfo(conv).title);
    if (!name?.trim()) return;
    try {
      await api('PATCH', `/chat/${encodeURIComponent(conv)}`, { name });
      await reloadConversation(conv);
    } catch (error) {
      toast(error.message);
    }
  },
  'conv-delete': async (t) => {
    const conv = t.dataset.conv;
    S.menu = false;
    if (!confirm(conv.startsWith('ws.') ? 'Clear every message in this channel, for everyone?' : 'Delete this chat and all its messages and files, for everyone? This can’t be undone.')) return renderMain();
    try {
      await api('DELETE', `/chat/${encodeURIComponent(conv)}`);
      views.delete(conv);
      await refreshList();
      toast(conv.startsWith('ws.') ? 'Channel cleared' : 'Chat deleted');
      go('#/');
    } catch (error) {
      toast(error.message);
    }
  },
  // Call history: admins remove calls from their list; the super admin can delete a call for everyone.
  'call-delete': async (t) => {
    const everyone = t.dataset.everyone === '1';
    if (everyone && !confirm('Delete this call for everyone who was on it?')) return;
    try {
      await api('DELETE', `/calls/${encodeURIComponent(t.dataset.id)}${everyone ? '?everyone=1' : ''}`);
      S.calls = (S.calls || []).filter((c) => c.id !== t.dataset.id);
      renderSide();
    } catch (error) {
      toast(error.message);
    }
  },
  'calls-clear': async () => {
    if (!confirm('Clear your whole call history?')) return;
    try {
      await api('DELETE', '/calls');
      S.calls = [];
      renderSide();
      toast('Call history cleared');
    } catch (error) {
      toast(error.message);
    }
  },
  'group-leave': async (t) => {
    if (!confirm('Leave this group?')) return;
    try {
      await api('POST', `/chat/${encodeURIComponent(t.dataset.conv)}/leave`);
      views.delete(t.dataset.conv);
      await refreshList();
      go('#/');
    } catch (error) {
      toast(error.message);
    }
  },
  'meet-show-call': () => meetings.showCall(),
};

async function blockAction(conv, body) {
  try {
    const result = await api('POST', `/chat/${encodeURIComponent(conv)}/block`, body);
    toast(result.reported ? 'Reported and blocked. Thanks for telling us.' : result.blocked ? 'Blocked.' : 'Unblocked.');
    S.menu = false;
    await reloadConversation(conv);
    if (result.blocked && convInfo(conv).request !== 'none') go('#/');
  } catch (error) {
    toast(error.message);
  }
}

async function reloadConversation(conv) {
  const v = views.get(conv);
  if (v) await v.load().catch(() => {});
  if (v?.el) v.render();
  await refreshList();
  patchConvHead();
}

function pickDialog(title, choices) {
  return new Promise((resolve) => {
    const node = document.createElement('dialog');
    node.className = 'dialog lc-dialog';
    node.innerHTML = `<form method="dialog"><h2>${esc(title)}</h2><div class="lc-pick">${choices.map((p) => `<label class="lc-row"><input type="checkbox" value="${esc(p.email)}" />${avatarHtml(p, 'avatar lc-av')}<span class="lc-row-main"><b>${esc(p.name || p.email)}</b><small>${esc(p.email)}</small></span></label>`).join('')}</div>
      <div class="row end"><button class="btn" value="cancel">Cancel</button><button class="btn primary" value="ok">Add</button></div></form>`;
    document.body.append(node);
    node.addEventListener('close', () => {
      const picked = node.returnValue === 'ok' ? [...node.querySelectorAll('input:checked')].map((i) => i.value) : null;
      node.remove();
      resolve(picked);
    });
    node.showModal();
  });
}

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-act], [data-click="meet-show-call"]');
  if (S.menu && !event.target.closest('.lc-menu, [data-act="menu"]')) {
    S.menu = false;
    patchConvHead();
  }
  if (!target) return;
  const name = target.dataset.act || target.dataset.click;
  if (actions[name]) {
    event.preventDefault();
    actions[name](target);
  }
});

document.addEventListener('input', (event) => {
  const t = event.target.closest('[data-input]');
  if (!t) return;
  if (t.dataset.input === 'search') {
    S.search = t.value;
    patchList();
  }
  if (t.dataset.input === 'contact-search') {
    S.contactQuery = t.value;
    const list = app.querySelector('.lc-contacts');
    if (list) list.innerHTML = contactsListHtml();
  }
  if (t.dataset.input === 'new-query') {
    S.newQuery = t.value;
    S.notFound = null;
    const list = app.querySelector('.lc-side .lc-list');
    // Re-render the lists without touching the input being typed in.
    if (list) {
      const tmp = document.createElement('div');
      tmp.innerHTML = newChatHtml();
      list.replaceWith(tmp.querySelector('.lc-list'));
      app.querySelector('.lc-invite')?.remove();
    }
  }
});

document.addEventListener('submit', async (event) => {
  const form = event.target.closest('[data-form]');
  if (!form) return;
  event.preventDefault();
  if (form.dataset.form === 'new-chat') return openDm(new FormData(form).get('to'));
  if (form.dataset.form === 'new-group') {
    const data = new FormData(form);
    const members = data.getAll('m');
    if (!members.length) return toast('Pick at least one person.');
    try {
      const group = await api('POST', '/chat/groups', { name: data.get('name'), members });
      await refreshList();
      go(`#/chat/${encodeURIComponent(group.id)}`);
    } catch (error) {
      toast(error.message);
    }
  }
});

window.addEventListener('hashchange', route);
showAndroidAppBar({ top: true });
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  S.installEvent = event;
  if (S.route.view === 'settings') renderSide();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !S.me) return;
  refreshList();
  pollRinging();
});

// The service worker forwards pushes while the app is open, and notification taps.
navigator.serviceWorker?.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'open' && data.hash) location.hash = data.hash;
  if (data.type === 'push') {
    const push = data.data || {};
    if (push.type === 'call') pollRinging();
    if (push.type === 'call-end' && S.incoming?.id === push.callId) pollRinging();
    if (push.type === 'message') {
      refreshList();
      const open = S.route.view === 'chat' && S.route.conv === push.conv;
      if (!open) toast(`${push.title}: ${push.body}`);
    }
  }
});

// ------------------------------------------------------------------ start

function signInScreen() {
  const screen = document.createElement('div');
  screen.className = 'lc-signin';
  app.replaceChildren(screen);
  showSignIn(screen, () => {
    keepTokens();
    screen.remove();
    start();
  });
  const intro = document.createElement('div');
  intro.className = 'lc-signin-intro';
  intro.innerHTML = '<img src="/brand/lyrsoft-mark.svg" alt="" width="56" height="56" /><h1>Lyr Chat</h1><p>Free messages, voice and video calls with anyone on Lyrsoft.</p>';
  screen.prepend(intro);
}

let started = false;
async function start() {
  try {
    S.me = await api('GET', '/me');
  } catch (error) {
    app.innerHTML = `<div class="lc-empty"><p>${esc(error.message)}</p><button class="btn" onclick="location.reload()">Try again</button></div>`;
    return;
  }
  keepTokens();
  await refreshList();
  loadBook();
  if (Native) enableNativePush(false).then(() => S.route.view === 'settings' && renderSide());
  else {
    S.push = !('PushManager' in window) || !('Notification' in window) ? 'unsupported' : Notification.permission;
    swRegistration();
    if (S.push === 'granted') enablePush(false);
  }
  await route();
  if (!started) {
    started = true;
    setInterval(() => !document.hidden && refreshList(), POLL_LIST_MS);
    setInterval(pollRinging, POLL_RING_MS);
    pollRinging();
  }
}

if (!getTokens()) signInScreen();
else start();
