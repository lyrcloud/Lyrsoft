import { db, now } from '../db.js';
import { config } from '../config.js';
import { isEmail } from '../http.js';
import { render } from './templates.js';
import { createTransport } from './transport.js';

let transport = null;
let timer = null;
let running = false;

export const workerState = { startedAt: null, lastRunAt: null, lastError: null };

function event(messageId, name, detail = '') {
  db.prepare('INSERT INTO mail_events (message_id, event, detail, created_at) VALUES (?, ?, ?, ?)')
    .run(messageId, name, String(detail).slice(0, 2000), now());
}

export function isSuppressed(email) {
  return !!db.prepare('SELECT 1 FROM mail_suppressions WHERE email = ?').get(email);
}

// Put one message on the queue. Returns its id. Suppressed addresses are recorded but never sent.
export function enqueue({ to, subject, text, html = null, template = 'custom', category = 'transactional', replyTo = null, createdBy = null, sendAt = null }) {
  const address = String(to).trim().toLowerCase();
  if (!isEmail(address)) throw new Error(`Invalid recipient: ${to}`);
  const suppressed = isSuppressed(address);
  const result = db.prepare(`
    INSERT INTO mail_messages (to_addr, from_addr, reply_to, subject, text_body, html_body, template, category, status,
      max_attempts, next_attempt_at, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    address, config.mail.from, replyTo, subject, text, html, template, category,
    suppressed ? 'suppressed' : 'queued', config.mail.maxAttempts, sendAt || now(), createdBy, now());
  const messageId = Number(result.lastInsertRowid);
  event(messageId, suppressed ? 'suppressed' : 'queued', suppressed ? 'Recipient is on the suppression list' : '');
  if (!suppressed) kick();
  return messageId;
}

export function sendTemplate(key, to, vars = {}, options = {}) {
  const { subject, text, html } = render(key, vars);
  return enqueue({ to, subject, text, html, template: key, ...options });
}

// Wait 1, 4, 16, 64... minutes between attempts (capped at 6 hours).
export const backoffMs = (attempt) => Math.min(60_000 * 4 ** (attempt - 1), 6 * 36e5);

async function deliver(msg) {
  const attempt = msg.attempts + 1;
  try {
    transport ??= createTransport();
    const providerId = await transport.send({
      from: msg.from_addr, to: msg.to_addr, replyTo: msg.reply_to || undefined,
      subject: msg.subject, text: msg.text_body, html: msg.html_body || undefined,
      headers: { 'X-Lyrsoft-Message': String(msg.id) },
    });
    db.prepare(`UPDATE mail_messages SET status = 'sent', attempts = ?, sent_at = ?, provider_id = ?, last_error = NULL WHERE id = ?`)
      .run(attempt, now(), providerId || null, msg.id);
    event(msg.id, 'sent', `Attempt ${attempt} via ${transport.name}${providerId ? ` · ${providerId}` : ''}`);
  } catch (err) {
    const error = String(err?.message || err).slice(0, 1000);
    // 5xx SMTP replies (mailbox does not exist, rejected...) will not succeed on retry.
    const permanent = err?.responseCode >= 500 && err?.responseCode < 600;
    if (permanent || attempt >= msg.max_attempts) {
      db.prepare(`UPDATE mail_messages SET status = 'failed', attempts = ?, last_error = ? WHERE id = ?`).run(attempt, error, msg.id);
      event(msg.id, 'failed', `Attempt ${attempt}: ${error}`);
    } else {
      const next = new Date(Date.now() + backoffMs(attempt)).toISOString();
      db.prepare(`UPDATE mail_messages SET status = 'queued', attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?`)
        .run(attempt, error, next, msg.id);
      event(msg.id, 'deferred', `Attempt ${attempt}: ${error} · retry at ${next}`);
    }
  }
}

// Send everything that is due. Safe to call often: only one run happens at a time.
export async function processQueue({ limit = 25 } = {}) {
  if (running) return 0;
  running = true;
  let count = 0;
  try {
    const due = db.prepare(`SELECT * FROM mail_messages WHERE status = 'queued' AND next_attempt_at <= ? ORDER BY next_attempt_at, id LIMIT ?`)
      .all(now(), limit);
    for (const msg of due) {
      const claimed = db.prepare(`UPDATE mail_messages SET status = 'sending' WHERE id = ? AND status = 'queued'`).run(msg.id);
      if (!claimed.changes) continue;
      await deliver(msg);
      count++;
    }
    workerState.lastError = null;
  } catch (err) {
    workerState.lastError = String(err?.message || err);
    console.error('[mail] queue run failed:', err);
  } finally {
    workerState.lastRunAt = now();
    running = false;
  }
  return count;
}

function kick() {
  if (timer) setImmediate(() => processQueue());
}

export function startWorker() {
  // Anything left "sending" by a crash goes back on the queue.
  db.prepare(`UPDATE mail_messages SET status = 'queued' WHERE status = 'sending'`).run();
  transport = createTransport();
  workerState.startedAt = now();
  timer = setInterval(() => processQueue(), config.mail.pollMs);
  timer.unref();
  processQueue();
  console.log(`[mail] worker started, transport: ${transport.name}`);
}

export function stopWorker() {
  clearInterval(timer);
  timer = null;
}

export function transportName() {
  try { return (transport ??= createTransport()).name; } catch (err) { return `misconfigured: ${err.message}`; }
}

export function retry(messageId) {
  const res = db.prepare(`UPDATE mail_messages SET status = 'queued', next_attempt_at = ?, attempts = 0 WHERE id = ? AND status IN ('failed','cancelled')`)
    .run(now(), messageId);
  if (res.changes) { event(messageId, 'requeued', 'Manual retry'); kick(); }
  return res.changes > 0;
}

export function cancel(messageId) {
  const res = db.prepare(`UPDATE mail_messages SET status = 'cancelled' WHERE id = ? AND status = 'queued'`).run(messageId);
  if (res.changes) event(messageId, 'cancelled', 'Cancelled by an admin');
  return res.changes > 0;
}
