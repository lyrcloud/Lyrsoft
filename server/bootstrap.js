import { db, getSetting, now, setSetting } from './db.js';
import { config } from './config.js';
import { issueToken, setupLink } from './auth.js';
import { createBoard } from './boards.js';
import { sendTemplate } from './mail/queue.js';

// Runs on every start: makes sure the super admin and the built-in boards exist.
export function bootstrap({ quiet = false } = {}) {
  const email = config.superAdminEmail;
  let admin = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!admin) {
    db.prepare(`INSERT INTO users (email, name, title, role, created_at) VALUES (?, 'Lyrsoft Admin', 'Super admin', 'super_admin', ?)`)
      .run(email, now());
    admin = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  } else if (admin.role !== 'super_admin' || !admin.active) {
    db.prepare(`UPDATE users SET role = 'super_admin', active = 1 WHERE id = ?`).run(admin.id);
  }
  // Only one super admin: whoever is configured.
  db.prepare(`UPDATE users SET role = 'admin' WHERE role = 'super_admin' AND id != ?`).run(admin.id);

  if (!admin.password_hash) {
    const pending = db.prepare(`SELECT 1 FROM tokens WHERE user_id = ? AND purpose = 'setup' AND used_at IS NULL AND expires_at > ?`).get(admin.id, now());
    if (!pending) {
      const url = setupLink(issueToken(admin.id, 'setup', 24 * 7));
      sendTemplate('super_admin_setup', email, { url });
      if (!quiet) console.log(`\n[setup] Super admin ${email} has no password yet.\n[setup] Set it here (also emailed): ${url}\n`);
    } else if (!quiet) {
      console.log(`\n[setup] Super admin ${email} has no password yet. A setup link was emailed; for a new one run: npm run admin-link\n`);
    }
  }

  if (!getSetting('leads_board_id')) {
    const leads = createBoard({ name: 'Website leads', description: 'Every message from the lyrsoft.com contact form lands here.', template: 'crm', ownerId: admin.id });
    setSetting('leads_board_id', leads);
    createBoard({ name: 'Delivery — client projects', description: 'Track every active client engagement.', template: 'project', ownerId: admin.id });
    createBoard({ name: 'Engineering sprint', description: 'Current sprint across the dev team.', template: 'sprint', ownerId: admin.id });
  }
  return admin;
}
