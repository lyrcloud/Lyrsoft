import { Router } from 'express';
import { db, logActivity, now } from '../db.js';
import { fail, id, isEmail, str } from '../http.js';
import {
  ROLES, ROLE_LABELS, endAllSessions, isAdmin, issueToken, publicUser, requireAdmin, requireAuth, setupLink,
} from '../auth.js';
import { sendTemplate } from '../mail/queue.js';

export const router = Router();

const ASSIGNABLE = ROLES.filter((r) => r !== 'super_admin');

// Who may change whom: nobody touches the super admin except themselves (and never their role),
// and only the super admin manages other admins.
function assertCanManage(actor, target) {
  if (target.role === 'super_admin') fail(403, 'The super admin account cannot be changed by others');
  if (target.role === 'admin' && actor.role !== 'super_admin') fail(403, 'Only the super admin can manage admins');
}

function assertCanGrant(actor, role) {
  if (!ASSIGNABLE.includes(role)) fail(400, 'Invalid role');
  if (role === 'admin' && actor.role !== 'super_admin') fail(403, 'Only the super admin can grant admin');
}

function invite(actor, user) {
  const token = issueToken(user.id, 'invite', 24 * 7);
  return sendTemplate('invite', user.email, {
    name: user.name, inviter: actor.name, role: ROLE_LABELS[user.role], url: setupLink(token),
  }, { createdBy: actor.id });
}

router.get('/', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM users ORDER BY active DESC, name COLLATE NOCASE').all();
  const users = rows.map(publicUser);
  // Directory for person pickers; only admins see account details.
  res.json({
    users: isAdmin(req.user) ? users : users.filter((u) => u.active).map(({ id, name, title, role, email }) => ({ id, name, title, role, email })),
    roles: ASSIGNABLE.map((r) => ({ value: r, label: ROLE_LABELS[r] })),
  });
});

router.post('/', requireAdmin, (req, res) => {
  const email = str(req.body.email, { max: 254, required: true, field: 'Email' }).toLowerCase();
  if (!isEmail(email)) fail(400, 'Enter a valid email');
  const name = str(req.body.name, { max: 100, required: true, field: 'Name' });
  const title = str(req.body.title, { max: 100, field: 'Title' });
  const role = String(req.body.role || 'member');
  assertCanGrant(req.user, role);
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) fail(409, 'Someone with that email already exists');
  const userId = Number(db.prepare('INSERT INTO users (email, name, title, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(email, name, title, role, now()).lastInsertRowid);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  invite(req.user, user);
  logActivity({ userId: req.user.id, action: 'user.invited', detail: `${name} <${email}> as ${ROLE_LABELS[role]}` });
  res.status(201).json({ user: publicUser(user) });
});

router.patch('/:id', requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id(req.params.id));
  if (!target) fail(404, 'User not found');
  assertCanManage(req.user, target);
  const name = str(req.body.name ?? target.name, { max: 100, required: true, field: 'Name' });
  const title = str(req.body.title ?? target.title, { max: 100, field: 'Title' });
  const role = req.body.role ?? target.role;
  if (role !== target.role) assertCanGrant(req.user, role);
  const active = req.body.active === undefined ? target.active : (req.body.active ? 1 : 0);
  if (target.id === req.user.id && (!active || role !== target.role)) fail(400, 'You cannot change your own role or deactivate yourself');
  db.prepare('UPDATE users SET name = ?, title = ?, role = ?, active = ? WHERE id = ?').run(name, title, role, active, target.id);
  if (!active || role !== target.role) endAllSessions(target.id);
  const changes = [role !== target.role && `role → ${ROLE_LABELS[role]}`, active !== target.active && (active ? 'reactivated' : 'deactivated')].filter(Boolean);
  if (changes.length) logActivity({ userId: req.user.id, action: 'user.updated', detail: `${name}: ${changes.join(', ')}` });
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(target.id)) });
});

router.post('/:id/invite', requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id(req.params.id));
  if (!target) fail(404, 'User not found');
  assertCanManage(req.user, target);
  if (!target.active) fail(400, 'Reactivate this user first');
  const messageId = invite(req.user, target);
  res.json({ ok: true, messageId });
});
