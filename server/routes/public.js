import { Router } from 'express';
import { db, getSetting, logActivity, now } from '../db.js';
import { config } from '../config.js';
import { fail, isEmail, rateLimit, str } from '../http.js';
import { boardColumns } from '../boards.js';
import { sendTemplate } from '../mail/queue.js';

export const router = Router();

router.post('/contact', rateLimit({ windowMs: 60 * 60_000, max: 5 }), (req, res) => {
  // Bots fill every field, including this hidden one.
  if (req.body.website) return res.json({ ok: true });
  const name = str(req.body.name, { max: 100, required: true, field: 'Name' });
  const email = str(req.body.email, { max: 254, required: true, field: 'Email' }).toLowerCase();
  if (!isEmail(email)) fail(400, 'Enter a valid email');
  const company = str(req.body.company, { max: 120, field: 'Company' });
  const service = str(req.body.service, { max: 80, field: 'Service' });
  const budget = str(req.body.budget, { max: 80, field: 'Budget' });
  const message = str(req.body.message, { max: 5000, required: true, field: 'Message' });

  const boardId = Number(getSetting('leads_board_id'));
  const columns = boardColumns(boardId);
  const group = db.prepare('SELECT id FROM board_groups WHERE board_id = ? ORDER BY position, id LIMIT 1').get(boardId);
  if (!group) fail(500, 'Leads board is missing');
  const byName = Object.fromEntries(columns.map((c) => [c.name, c.id]));
  const data = {
    [byName.Status]: 'New', [byName.Email]: email, [byName.Company]: company || null,
    [byName.Budget]: budget || null, [byName.Service]: service || null, [byName.Message]: message,
  };
  delete data.undefined;
  const itemId = Number(db.prepare('INSERT INTO items (board_id, group_id, name, data, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(boardId, group.id, name, JSON.stringify(data), -Date.now(), now(), now()).lastInsertRowid);
  logActivity({ boardId, itemId, action: 'lead.received', detail: `${name} <${email}> via website` });

  const inbox = getSetting('lead_inbox', config.superAdminEmail);
  sendTemplate('lead_notification', inbox, {
    name, email, company, service, budget, message, url: `${config.baseUrl}/hub/#/boards/${boardId}?item=${itemId}`,
  }, { replyTo: email, category: 'leads' });
  sendTemplate('contact_receipt', email, { name }, { category: 'leads' });
  res.json({ ok: true });
});
