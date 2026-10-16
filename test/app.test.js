import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lyrsoft-test-'));
process.env.DB_PATH = ':memory:';
process.env.MAIL_TRANSPORT = 'log';
process.env.MAIL_OUTBOX_DIR = path.join(tmp, 'outbox');
process.env.SUPER_ADMIN_EMAIL = 'lyrclouds@gmail.com';

const { db } = await import('../server/db.js');
const { createApp } = await import('../server/app.js');
const { bootstrap } = await import('../server/bootstrap.js');
const { issueToken } = await import('../server/auth.js');
const { processQueue, enqueue } = await import('../server/mail/queue.js');

let server;
let base;

before(async () => {
  bootstrap({ quiet: true });
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

// A minimal cookie-keeping client.
function client() {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'x-lyrsoft': '1', cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

async function setPassword(call, email, password) {
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  const token = issueToken(user.id, 'invite', 1);
  return call('POST', '/api/auth/set-password', { token, password });
}

const superAdmin = client();
const admin = client();
const member = client();
const outsider = client();

test('super admin is created on boot and can set a password from the setup link', async () => {
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get('lyrclouds@gmail.com');
  assert.equal(row.role, 'super_admin');
  const setup = db.prepare(`SELECT * FROM mail_messages WHERE template = 'super_admin_setup'`).get();
  assert.equal(setup.to_addr, 'lyrclouds@gmail.com');

  const res = await setPassword(superAdmin, 'lyrclouds@gmail.com', 'correct-horse-battery');
  assert.equal(res.status, 200);
  assert.equal(res.body.user.role, 'super_admin');
  const me = await superAdmin('GET', '/api/auth/me');
  assert.equal(me.body.user.email, 'lyrclouds@gmail.com');
});

test('login rejects a wrong password and accepts the right one', async () => {
  const c = client();
  assert.equal((await c('POST', '/api/auth/login', { email: 'lyrclouds@gmail.com', password: 'nope-nope-nope' })).status, 401);
  assert.equal((await c('POST', '/api/auth/login', { email: 'LYRCLOUDS@gmail.com', password: 'correct-horse-battery' })).status, 200);
});

test('mutating requests without the CSRF header are refused', async () => {
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 403);
});

test('super admin invites people; invites go out by email', async () => {
  for (const [email, role] of [['ada@lyrsoft.com', 'admin'], ['max@lyrsoft.com', 'member'], ['cli@client.com', 'client']]) {
    const res = await superAdmin('POST', '/api/users', { email, name: email.split('@')[0], role });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM mail_messages WHERE template = 'invite'`).get().n, 3);
  await setPassword(admin, 'ada@lyrsoft.com', 'admin-password-1');
  await setPassword(member, 'max@lyrsoft.com', 'member-password-1');
  await setPassword(outsider, 'cli@client.com', 'client-password-1');
});

test('nobody else can change or remove the super admin, and admins cannot grant admin', async () => {
  const sa = db.prepare('SELECT id FROM users WHERE email = ?').get('lyrclouds@gmail.com');
  assert.equal((await admin('PATCH', `/api/users/${sa.id}`, { role: 'member' })).status, 403);
  assert.equal((await admin('PATCH', `/api/users/${sa.id}`, { active: false })).status, 403);
  assert.equal((await admin('POST', '/api/users', { email: 'x@lyrsoft.com', name: 'X', role: 'admin' })).status, 403);
  assert.equal((await superAdmin('PATCH', `/api/users/${sa.id}`, { role: 'admin' })).status, 403);
  assert.equal((await member('POST', '/api/users', { email: 'y@lyrsoft.com', name: 'Y' })).status, 403);
  assert.equal((await superAdmin('POST', '/api/users', { email: 'z@lyrsoft.com', name: 'Z', role: 'super_admin' })).status, 400);
});

test('boards: create, add items, assign people (with email), and visibility rules', async () => {
  const created = await member('POST', '/api/boards', { name: 'Acme app', template: 'project', visibility: 'private' });
  assert.equal(created.status, 201);
  const { board, columns, groups } = created.body;
  const owner = columns.find((c) => c.type === 'person');
  const status = columns.find((c) => c.type === 'status');
  const adaId = db.prepare('SELECT id FROM users WHERE email = ?').get('ada@lyrsoft.com').id;

  const item = await member('POST', `/api/boards/${board.id}/items`, { name: 'Login screen', groupId: groups[0].id });
  assert.equal(item.status, 201);
  const bad = await member('PATCH', `/api/items/${item.body.item.id}`, { data: { [status.id]: 'Not a real status' } });
  assert.equal(bad.status, 400);
  const ok = await member('PATCH', `/api/items/${item.body.item.id}`, { data: { [status.id]: 'Working on it', [owner.id]: adaId } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.item.data[owner.id], adaId);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM mail_messages WHERE template = 'item_assigned' AND to_addr = 'ada@lyrsoft.com'`).get().n, 1);

  // Private board: the client cannot see it until added; then can read and comment but not edit.
  assert.equal((await outsider('GET', `/api/boards/${board.id}`)).status, 404);
  const cliId = db.prepare('SELECT id FROM users WHERE email = ?').get('cli@client.com').id;
  const leadsBoard = db.prepare(`SELECT value FROM settings WHERE key = 'leads_board_id'`).get().value;
  assert.equal((await member('POST', `/api/boards/${leadsBoard}/members`, { userId: cliId })).status, 403); // not the owner
  assert.equal((await superAdmin('POST', `/api/boards/${board.id}/members`, { userId: cliId })).status, 200);
  assert.equal((await outsider('GET', `/api/boards/${board.id}`)).status, 200);
  assert.equal((await outsider('PATCH', `/api/items/${item.body.item.id}`, { name: 'hacked' })).status, 403);
  assert.equal((await outsider('POST', `/api/items/${item.body.item.id}/updates`, { body: 'Looks great' })).status, 201);
  // Ada is assigned, so she is emailed about the client's update.
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM mail_messages WHERE template = 'item_update' AND to_addr = 'ada@lyrsoft.com'`).get().n, 1);

  const dash = await admin('GET', '/api/dashboard');
  assert.equal(dash.body.stats.mine, 1);
});

test('website contact form creates a lead item and queues two emails', async () => {
  const anon = client();
  const before = db.prepare('SELECT COUNT(*) n FROM mail_messages').get().n;
  const res = await anon('POST', '/api/public/contact', { name: 'Jane Founder', email: 'jane@startup.io', company: 'Startup', message: 'We need an MVP' });
  assert.equal(res.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM mail_messages').get().n, before + 2);
  const lead = db.prepare(`SELECT * FROM mail_messages WHERE template = 'lead_notification' ORDER BY id DESC`).get();
  assert.equal(lead.to_addr, 'lyrclouds@gmail.com');
  assert.equal(lead.reply_to, 'jane@startup.io');
  assert.ok(db.prepare(`SELECT 1 FROM items WHERE name = 'Jane Founder'`).get());
  assert.equal((await anon('POST', '/api/public/contact', { name: 'x', email: 'bad', message: 'y' })).status, 400);
});

test('mail queue delivers, honours suppressions, and retries then fails', async () => {
  db.prepare(`INSERT INTO mail_suppressions (email, reason, created_at) VALUES ('blocked@example.com', 'bounced', ?)`).run(new Date().toISOString());
  const blocked = enqueue({ to: 'blocked@example.com', subject: 's', text: 't' });
  assert.equal(db.prepare('SELECT status FROM mail_messages WHERE id = ?').get(blocked).status, 'suppressed');

  await processQueue({ limit: 500 });
  const queued = db.prepare(`SELECT COUNT(*) n FROM mail_messages WHERE status = 'queued'`).get().n;
  assert.equal(queued, 0);
  assert.ok(fs.readdirSync(process.env.MAIL_OUTBOX_DIR).length > 5);

  // Make delivery fail by pointing the outbox at a file, then check backoff and final failure.
  const id = enqueue({ to: 'retry@example.com', subject: 'r', text: 'r' });
  db.prepare('UPDATE mail_messages SET max_attempts = 2 WHERE id = ?').run(id);
  const { config } = await import('../server/config.js');
  const realDir = config.mail.outboxDir;
  const blocker = path.join(tmp, 'not-a-dir');
  fs.writeFileSync(blocker, '');
  config.mail.outboxDir = blocker;
  await processQueue();
  let m = db.prepare('SELECT * FROM mail_messages WHERE id = ?').get(id);
  assert.equal(m.status, 'queued');
  assert.equal(m.attempts, 1);
  assert.ok(m.next_attempt_at > new Date().toISOString());
  db.prepare('UPDATE mail_messages SET next_attempt_at = ? WHERE id = ?').run(new Date(0).toISOString(), id);
  await processQueue();
  m = db.prepare('SELECT * FROM mail_messages WHERE id = ?').get(id);
  assert.equal(m.status, 'failed');
  config.mail.outboxDir = realDir;

  const retry = await superAdmin('POST', `/api/mail/messages/${id}/retry`);
  assert.equal(retry.status, 200);
  await processQueue();
  assert.equal(db.prepare('SELECT status FROM mail_messages WHERE id = ?').get(id).status, 'sent');
});

test('mail admin API is admins-only', async () => {
  assert.equal((await member('GET', '/api/mail/overview')).status, 403);
  assert.equal((await admin('GET', '/api/mail/overview')).status, 200);
  const sent = await superAdmin('POST', '/api/mail/send', { subject: 'Hello team', body: 'Hi all', audiences: ['member'] });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.queued, 1);
});
