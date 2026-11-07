// Push for Lyr Chat: browsers subscribe with Web Push (lyrsoft.com/chat/sw.js) and the phone apps with a
// Firebase Cloud Messaging token; both get a notification for new messages and incoming calls even when
// Lyr Chat is closed. FCM is used once its service account (getFcmAccount) is set up.
//   PUSH#<email>  <endpoint hash>       { endpoint, keys, ua, createdAt }        a browser
//   PUSH#<email>  fcm-<token hash>      { fcmToken, platform, createdAt }        a phone app
import { createHash, createSign } from 'node:crypto';
import webpush from 'web-push';
import { cleanNativeToken, cleanSubscription, fcmMessage, PUSH_SUBSCRIPTIONS_MAX, vapidKeysFrom } from './lyrchat-model.mjs';

const SEND_TIMEOUT_MS = 4000;
const endpointKey = (endpoint) => createHash('sha256').update(endpoint).digest('hex').slice(0, 32);

export function createPush({ db, getSecret, now, contact = 'mailto:hello@lyrsoft.com', getFcmAccount = async () => null, fetchFn = (...a) => fetch(...a) }) {
  let keys = null;
  const vapid = async () => (keys ??= vapidKeysFrom(await getSecret()));
  const list = (email) => db.queryAll({ KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': `PUSH#${email}` } });

  async function subscribe(email, subscription, ua = '') {
    const sub = cleanSubscription(subscription);
    const existing = await list(email);
    // Oldest devices make room for new ones.
    const extra = existing.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, Math.max(0, existing.length - PUSH_SUBSCRIPTIONS_MAX + 1));
    for (const row of extra) if (row.SK !== endpointKey(sub.endpoint)) await db.del(row.PK, row.SK);
    await db.put({ PK: `PUSH#${email}`, SK: endpointKey(sub.endpoint), ...sub, ua: String(ua).slice(0, 200), createdAt: now() });
  }

  const unsubscribe = (email, endpoint) => db.del(`PUSH#${email}`, endpointKey(String(endpoint || '')));

  async function subscribeNative(email, token, platform) {
    const fcmToken = cleanNativeToken(token);
    await db.put({ PK: `PUSH#${email}`, SK: `fcm-${endpointKey(fcmToken)}`, fcmToken, platform: platform === 'ios' ? 'ios' : 'android', createdAt: now() });
  }
  const unsubscribeNative = (email, token) => db.del(`PUSH#${email}`, `fcm-${endpointKey(String(token || ''))}`);

  // An OAuth access token for FCM from the service account (a signed JWT), kept until it nearly expires.
  let fcmAuth = null;
  let fcmAuthPending = null; // one token request at a time, shared by parallel sends
  function fcmAccess(account) {
    if (fcmAuth && fcmAuth.email === account.client_email && Date.now() < fcmAuth.expiresAt) return Promise.resolve(fcmAuth.token);
    fcmAuthPending ??= newFcmAccess(account).finally(() => (fcmAuthPending = null));
    return fcmAuthPending;
  }
  async function newFcmAccess(account) {
    const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const iat = Math.floor(Date.now() / 1000);
    const tokenUri = account.token_uri || 'https://oauth2.googleapis.com/token';
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: account.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: tokenUri, iat, exp: iat + 3600 })}`;
    const assertion = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(account.private_key, 'base64url')}`;
    const res = await fetchFn(tokenUri, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) });
    if (!res.ok) throw new Error(`FCM auth ${res.status}`);
    const data = await res.json();
    fcmAuth = { email: account.client_email, token: data.access_token, expiresAt: Date.now() + (data.expires_in - 120) * 1000 };
    return fcmAuth.token;
  }

  async function sendFcm(account, row, payload, options) {
    try {
      const res = await fetchFn(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await fcmAccess(account)}`, 'content-type': 'application/json' },
        body: JSON.stringify(fcmMessage(row.fcmToken, payload, options)),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (res.ok) return 1;
      const text = await res.text();
      // The app was uninstalled or the token rotated.
      if (res.status === 404 || /UNREGISTERED|registration-token-not-registered|INVALID_ARGUMENT/.test(text)) await db.del(row.PK, row.SK).catch(() => {});
      else console.warn('FCM push failed', res.status, text.slice(0, 200));
    } catch (error) {
      console.warn('FCM push failed', error.message);
    }
    return 0;
  }

  // Sends `payload` (or payloadFor(email)) to every device of every email. Never throws; gone
  // subscriptions are removed. `topic` lets a newer push replace an undelivered one.
  async function send(emails, payload, { ttl = 3600, urgency = 'normal', topic } = {}) {
    if (!emails.length) return 0;
    let details;
    try {
      const { publicKey, privateKey } = await vapid();
      details = { vapidDetails: { subject: contact, publicKey, privateKey }, TTL: ttl, urgency, ...(topic ? { topic: topic.replace(/[^\w-]/g, '').slice(0, 32) } : {}), timeout: SEND_TIMEOUT_MS };
    } catch (error) {
      console.error('Push keys unavailable', error);
      return 0;
    }
    const fcm = await getFcmAccount().catch(() => null);
    const jobs = [];
    for (const email of [...new Set(emails)].slice(0, 100)) {
      const data = typeof payload === 'function' ? payload(email) : payload;
      const body = JSON.stringify(data);
      jobs.push(list(email).then((subs) => Promise.all(subs.map((s) => s.fcmToken
        ? (fcm ? sendFcm(fcm, s, data, { ttl, urgency }) : 0)
        : webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, body, details).then(
          () => 1,
          async (error) => {
            if (error.statusCode === 404 || error.statusCode === 410) await db.del(s.PK, s.SK).catch(() => {});
            else console.warn('Push failed', error.statusCode || error.message);
            return 0;
          },
        )))));
    }
    const results = await Promise.allSettled(jobs);
    return results.reduce((n, r) => n + (r.status === 'fulfilled' ? r.value.reduce((a, b) => a + b, 0) : 0), 0);
  }

  return { publicKey: async () => (await vapid()).publicKey, subscribe, unsubscribe, subscribeNative, unsubscribeNative, send, nativeReady: async () => Boolean(await getFcmAccount().catch(() => null)) };
}
