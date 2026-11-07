// Web Push for Lyr Chat: devices subscribe (lyrsoft.com/chat/sw.js) and get a notification for new
// messages and incoming calls even when the app is closed.
//   PUSH#<email>  <endpoint hash>   { endpoint, keys, ua, createdAt }
import { createHash } from 'node:crypto';
import webpush from 'web-push';
import { cleanSubscription, PUSH_SUBSCRIPTIONS_MAX, vapidKeysFrom } from './lyrchat-model.mjs';

const SEND_TIMEOUT_MS = 4000;
const endpointKey = (endpoint) => createHash('sha256').update(endpoint).digest('hex').slice(0, 32);

export function createPush({ db, getSecret, now, contact = 'mailto:hello@lyrsoft.com' }) {
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
    const jobs = [];
    for (const email of [...new Set(emails)].slice(0, 100)) {
      const body = JSON.stringify(typeof payload === 'function' ? payload(email) : payload);
      jobs.push(list(email).then((subs) => Promise.all(subs.map((s) =>
        webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, body, details).then(
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

  return { publicKey: async () => (await vapid()).publicKey, subscribe, unsubscribe, send };
}
