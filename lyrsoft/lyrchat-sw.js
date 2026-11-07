// Lyr Chat's service worker, served as /chat/sw.js (scope /chat/). It shows push notifications for new
// messages and incoming calls while the app is closed or in the background, and opens the right chat
// when one is tapped. While the app is on screen, pushes are passed to it instead (it rings and
// refreshes itself). "Decline" on a call works without opening the app: the push carries a signed
// token for POST /public/call.
const ICON = '/brand/icon-192.png';
const BADGE = '/brand/icon-192.png';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

const appWindows = async () =>
  (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).filter((c) => new URL(c.url).pathname.startsWith('/chat/'));

async function closeTagged(tag) {
  for (const n of await self.registration.getNotifications({ tag })) n.close();
}

async function onPush(data) {
  const windows = await appWindows();
  const visible = windows.filter((c) => c.visibilityState === 'visible');
  for (const c of windows) c.postMessage({ type: 'push', data });

  if (data.type === 'call-end') {
    await closeTagged(data.tag);
    if (data.missed) {
      await self.registration.showNotification(data.title, { body: data.body, tag: data.tag, icon: ICON, badge: BADGE, data: { url: data.url } });
    } else if (!visible.length) {
      // Browsers expect a notification for every push; show the update and clear it straight away.
      await self.registration.showNotification('Call ended', { tag: data.tag, silent: true, icon: ICON });
      await closeTagged(data.tag);
    }
    return;
  }
  // The open app rings for calls and shows new messages itself.
  if (visible.length) return;
  if (data.type === 'call') {
    await self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.tag,
      icon: ICON,
      badge: BADGE,
      renotify: true,
      requireInteraction: true,
      vibrate: [400, 200, 400, 200, 400, 200, 400],
      actions: [{ action: 'answer', title: 'Answer' }, { action: 'decline', title: 'Decline' }],
      data: { url: data.url, callId: data.callId, email: data.email, token: data.token },
    });
    return;
  }
  await self.registration.showNotification(data.title || 'Lyr Chat', {
    body: data.body || '',
    tag: data.tag,
    icon: ICON,
    badge: BADGE,
    renotify: true,
    data: { url: data.url || '/chat/' },
  });
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data?.json() || {};
  } catch {
    data = { title: 'Lyr Chat', body: event.data?.text() || '' };
  }
  event.waitUntil(onPush(data));
});

self.addEventListener('notificationclick', (event) => {
  const n = event.notification;
  const data = n.data || {};
  n.close();
  event.waitUntil((async () => {
    if (event.action === 'decline' && data.callId) {
      await fetch('/public/call', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: data.callId, email: data.email, t: data.token, action: 'decline' }),
      }).catch(() => {});
      return;
    }
    const url = new URL(data.url || '/chat/', self.location.origin);
    const [client] = await appWindows();
    if (client) {
      await client.focus().catch(() => {});
      client.postMessage({ type: 'open', hash: url.hash });
      return;
    }
    await self.clients.openWindow(url.href);
  })());
});
