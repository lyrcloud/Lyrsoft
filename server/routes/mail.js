import { Router } from 'express';
import { db, now } from '../db.js';
import { config } from '../config.js';
import { fail, id, isEmail, str } from '../http.js';
import { requireAdmin } from '../auth.js';
import { cancel, enqueue, processQueue, retry, sendTemplate, transportName, workerState } from '../mail/queue.js';
import { render } from '../mail/templates.js';

export const router = Router();
router.use(requireAdmin);

const STATUSES = ['queued', 'sending', 'sent', 'failed', 'suppressed', 'cancelled'];

const summary = (m) => ({
  id: m.id, to: m.to_addr, subject: m.subject, template: m.template, category: m.category, status: m.status,
  attempts: m.attempts, maxAttempts: m.max_attempts, nextAttemptAt: m.next_attempt_at, lastError: m.last_error,
  createdAt: m.created_at, sentAt: m.sent_at,
});

router.get('/overview', (req, res) => {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const r of db.prepare('SELECT status, COUNT(*) n FROM mail_messages GROUP BY status').all()) counts[r.status] = r.n;
  const since = new Date(Date.now() - 13 * 864e5).toISOString().slice(0, 10);
  const rows = db.prepare(`SELECT substr(created_at, 1, 10) day, status, COUNT(*) n FROM mail_messages
    WHERE created_at >= ? GROUP BY day, status`).all(since);
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const day = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    const sent = rows.filter((r) => r.day === day && r.status === 'sent').reduce((a, r) => a + r.n, 0);
    const failed = rows.filter((r) => r.day === day && r.status === 'failed').reduce((a, r) => a + r.n, 0);
    days.push({ day, sent, failed });
  }
  res.json({
    counts, days,
    config: { transport: transportName(), from: config.mail.from, maxAttempts: config.mail.maxAttempts, pollMs: config.mail.pollMs },
    worker: workerState,
  });
});

router.get('/messages', (req, res) => {
  const where = [];
  const params = [];
  if (STATUSES.includes(req.query.status)) { where.push('status = ?'); params.push(req.query.status); }
  const q = String(req.query.q || '').trim();
  if (q) { where.push('(to_addr LIKE ? OR subject LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  const page = Math.max(1, Number(req.query.page) || 1);
  const sql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { n } = db.prepare(`SELECT COUNT(*) n FROM mail_messages ${sql}`).get(...params);
  const rows = db.prepare(`SELECT * FROM mail_messages ${sql} ORDER BY id DESC LIMIT 50 OFFSET ?`).all(...params, (page - 1) * 50);
  res.json({ messages: rows.map(summary), total: n, page, pages: Math.max(1, Math.ceil(n / 50)) });
});

router.get('/messages/:id', (req, res) => {
  const m = db.prepare('SELECT * FROM mail_messages WHERE id = ?').get(id(req.params.id));
  if (!m) fail(404, 'Message not found');
  const events = db.prepare('SELECT event, detail, created_at createdAt FROM mail_events WHERE message_id = ? ORDER BY id').all(m.id);
  res.json({ message: { ...summary(m), from: m.from_addr, replyTo: m.reply_to, text: m.text_body, providerId: m.provider_id }, events });
});

router.post('/messages/:id/retry', (req, res) => {
  if (!retry(id(req.params.id))) fail(400, 'Only failed or cancelled messages can be retried');
  res.json({ ok: true });
});

router.post('/messages/:id/cancel', (req, res) => {
  if (!cancel(id(req.params.id))) fail(400, 'Only queued messages can be cancelled');
  res.json({ ok: true });
});

// Compose: send to listed addresses and/or everyone with a given role.
router.post('/send', (req, res) => {
  const subject = str(req.body.subject, { max: 200, required: true, field: 'Subject' });
  const body = str(req.body.body, { max: 20000, required: true, field: 'Message' });
  const recipients = new Set();
  for (const raw of String(req.body.to || '').split(/[\s,;]+/).filter(Boolean)) {
    if (!isEmail(raw)) fail(400, `Not a valid email: ${raw}`);
    recipients.add(raw.toLowerCase());
  }
  const audiences = Array.isArray(req.body.audiences) ? req.body.audiences : [];
  for (const role of audiences) {
    for (const u of db.prepare('SELECT email FROM users WHERE active = 1 AND (role = ? OR ? = \'everyone\')').all(String(role), String(role))) {
      recipients.add(u.email.toLowerCase());
    }
  }
  if (!recipients.size) fail(400, 'Add at least one recipient');
  if (recipients.size > 2000) fail(400, 'Too many recipients (max 2000 per send)');
  const { text, html } = render('custom', { subject, body });
  const category = audiences.length ? 'broadcast' : 'manual';
  const ids = [...recipients].map((to) => enqueue({ to, subject, text, html, template: 'custom', category, createdBy: req.user.id }));
  res.status(201).json({ queued: ids.length });
});

router.post('/test', (req, res) => {
  const to = str(req.body.to || req.user.email, { max: 254, field: 'Email' });
  if (!isEmail(to)) fail(400, 'Enter a valid email');
  const messageId = sendTemplate('test', to, {}, { createdBy: req.user.id, category: 'test' });
  res.status(201).json({ messageId });
});

router.post('/run', async (_req, res) => {
  res.json({ processed: await processQueue() });
});

router.get('/suppressions', (_req, res) => {
  res.json({ suppressions: db.prepare('SELECT email, reason, created_at createdAt FROM mail_suppressions ORDER BY created_at DESC').all() });
});

router.post('/suppressions', (req, res) => {
  const email = str(req.body.email, { max: 254, required: true, field: 'Email' }).toLowerCase();
  if (!isEmail(email)) fail(400, 'Enter a valid email');
  const reason = str(req.body.reason, { max: 200, field: 'Reason' }) || 'Added by admin';
  db.prepare('INSERT OR REPLACE INTO mail_suppressions (email, reason, created_at) VALUES (?, ?, ?)').run(email, reason, now());
  res.status(201).json({ ok: true });
});

router.delete('/suppressions/:email', (req, res) => {
  db.prepare('DELETE FROM mail_suppressions WHERE email = ?').run(String(req.params.email));
  res.json({ ok: true });
});
