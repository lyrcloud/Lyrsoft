// Prints a fresh password-setup link for the super admin (for first setup or a lost password).
import { db } from './db.js';
import { config } from './config.js';
import { issueToken, setupLink } from './auth.js';
import { bootstrap } from './bootstrap.js';

bootstrap({ quiet: true });
const admin = db.prepare('SELECT * FROM users WHERE email = ?').get(config.superAdminEmail);
console.log(`Password link for ${admin.email} (valid 1 hour):\n${setupLink(issueToken(admin.id, 'reset', 1))}`);
