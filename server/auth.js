import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { db, now } from './db.js';
import { config } from './config.js';
import { fail } from './http.js';

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'lyr_sid';

export const ROLES = ['super_admin', 'admin', 'manager', 'member', 'client'];
export const ROLE_LABELS = {
  super_admin: 'Super admin', admin: 'Admin', manager: 'Manager', member: 'Member', client: 'Client',
};

export const isAdmin = (user) => user?.role === 'super_admin' || user?.role === 'admin';
export const isStaff = (user) => !!user && user.role !== 'client';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('base64url');

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  if (!stored) return false;
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), 64);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 10) fail(400, 'Password must be at least 10 characters');
  if (password.length > 200) fail(400, 'Password is too long');
}

export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id, email: user.email, name: user.name, title: user.title, role: user.role,
    active: !!user.active, hasPassword: !!user.password_hash,
    createdAt: user.created_at, lastLoginAt: user.last_login_at,
  };
}

// --- sessions ---

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieHeader(value, maxAgeSeconds) {
  return [
    `${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`,
    config.production ? 'Secure' : null,
  ].filter(Boolean).join('; ');
}

export function startSession(res, userId) {
  const token = randomToken();
  const expires = new Date(Date.now() + config.sessionDays * 864e5).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(sha256(token), userId, expires, now());
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now(), userId);
  res.setHeader('Set-Cookie', cookieHeader(token, config.sessionDays * 86400));
}

export function endSession(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  res.setHeader('Set-Cookie', cookieHeader('', 0));
}

export function endAllSessions(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function loadUser(req, _res, next) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  req.user = null;
  if (token) {
    const row = db.prepare(`
      SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`).get(sha256(token), now());
    if (row) req.user = row;
  }
  next();
}

export function requireAuth(req, _res, next) {
  if (!req.user) fail(401, 'Please sign in');
  next();
}

export const requireStaff = (req, _res, next) => {
  if (!req.user) fail(401, 'Please sign in');
  if (!isStaff(req.user)) fail(403, 'Not available for client accounts');
  next();
};

export const requireAdmin = (req, _res, next) => {
  if (!req.user) fail(401, 'Please sign in');
  if (!isAdmin(req.user)) fail(403, 'Admins only');
  next();
};

// Requests from our own pages always carry this header; a cross-site form or image cannot set it,
// and a cross-site fetch that sets it fails the CORS preflight. Together with SameSite=Lax this blocks CSRF.
export function csrfGuard(req, _res, next) {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('x-lyrsoft') !== '1') {
    fail(403, 'Missing request header');
  }
  next();
}

// --- one-time tokens (invites, password resets) ---

export function issueToken(userId, purpose, hours) {
  const token = randomToken();
  db.prepare('UPDATE tokens SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL').run(now(), userId, purpose);
  db.prepare('INSERT INTO tokens (token_hash, user_id, purpose, expires_at) VALUES (?, ?, ?, ?)')
    .run(sha256(token), userId, purpose, new Date(Date.now() + hours * 36e5).toISOString());
  return token;
}

export function consumeToken(token) {
  if (typeof token !== 'string' || !token) return null;
  const row = db.prepare('SELECT * FROM tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?')
    .get(sha256(token), now());
  if (!row) return null;
  db.prepare('UPDATE tokens SET used_at = ? WHERE token_hash = ?').run(now(), row.token_hash);
  return row;
}

export function peekToken(token) {
  if (typeof token !== 'string' || !token) return null;
  return db.prepare('SELECT * FROM tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?')
    .get(sha256(token), now()) || null;
}

export function setupLink(token) {
  return `${config.baseUrl}/hub/#/set-password?token=${encodeURIComponent(token)}`;
}
