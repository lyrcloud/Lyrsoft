import { Router } from 'express';
import { db } from '../db.js';
import { fail, rateLimit, str } from '../http.js';
import {
  consumeToken, endAllSessions, endSession, hashPassword, issueToken, peekToken, publicUser, requireAuth,
  setupLink, startSession, validatePassword, verifyPassword,
} from '../auth.js';
import { sendTemplate } from '../mail/queue.js';

export const router = Router();
const limiter = rateLimit({ windowMs: 15 * 60_000, max: 20 });

router.post('/login', limiter, async (req, res) => {
  const email = str(req.body.email, { max: 254, field: 'Email' }).toLowerCase();
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email);
  if (!user || !(await verifyPassword(password, user.password_hash))) fail(401, 'Wrong email or password');
  startSession(res, user.id);
  res.json({ user: publicUser(user) });
});

router.post('/logout', (req, res) => {
  endSession(req, res);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  res.json({ user: publicUser(req.user) });
});

router.post('/forgot', limiter, (req, res) => {
  const email = str(req.body.email, { max: 254, field: 'Email' }).toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email);
  if (user) {
    const token = issueToken(user.id, 'reset', 1);
    sendTemplate('password_reset', user.email, { name: user.name, url: setupLink(token) });
  }
  // Same answer either way so this cannot be used to discover accounts.
  res.json({ ok: true });
});

router.get('/token', limiter, (req, res) => {
  const row = peekToken(String(req.query.token || ''));
  if (!row) fail(404, 'This link has expired or was already used');
  const user = db.prepare('SELECT email, name FROM users WHERE id = ?').get(row.user_id);
  res.json({ email: user.email, name: user.name, purpose: row.purpose });
});

router.post('/set-password', limiter, async (req, res) => {
  validatePassword(req.body.password);
  if (!peekToken(String(req.body.token || ''))) fail(400, 'This link has expired or was already used');
  const hash = await hashPassword(req.body.password);
  const row = consumeToken(String(req.body.token));
  if (!row) fail(400, 'This link has expired or was already used');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, row.user_id);
  endAllSessions(row.user_id);
  startSession(res, row.user_id);
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id)) });
});

router.post('/change-password', requireAuth, async (req, res) => {
  if (!(await verifyPassword(String(req.body.current || ''), req.user.password_hash))) fail(400, 'Current password is wrong');
  validatePassword(req.body.password);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(req.body.password), req.user.id);
  endAllSessions(req.user.id);
  startSession(res, req.user.id);
  res.json({ ok: true });
});

router.patch('/me', requireAuth, (req, res) => {
  const name = str(req.body.name ?? req.user.name, { max: 100, required: true, field: 'Name' });
  const title = str(req.body.title ?? req.user.title, { max: 100, field: 'Title' });
  db.prepare('UPDATE users SET name = ?, title = ? WHERE id = ?').run(name, title, req.user.id);
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
});
