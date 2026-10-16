import { Router } from 'express';
import { db, logActivity, now, tx } from '../db.js';
import { config } from '../config.js';
import { fail, id, str } from '../http.js';
import { isStaff, requireAuth, requireStaff } from '../auth.js';
import {
  BOARD_TEMPLATES, DONE_LABELS, boardColumns, canEditItems, canManage, canView, cleanValue, createBoard, getBoard,
  serializeItem, visibleBoards,
} from '../boards.js';
import { sendTemplate } from '../mail/queue.js';

export const router = Router();
router.use(requireAuth);

const COLUMN_TYPES = ['text', 'longtext', 'status', 'person', 'date', 'number', 'email'];
const itemUrl = (boardId, itemId) => `${config.baseUrl}/hub/#/boards/${boardId}?item=${itemId}`;

function loadBoard(req, need = 'view') {
  const board = getBoard(id(req.params.boardId));
  if (!board || !canView(req.user, board)) fail(404, 'Board not found');
  if (need === 'edit' && !canEditItems(req.user, board)) fail(403, 'You can only view this board');
  if (need === 'manage' && !canManage(req.user, board)) fail(403, 'Only board owners, managers and admins can change this board');
  return board;
}

function loadItem(req, need = 'view') {
  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(id(req.params.itemId));
  const board = row && getBoard(row.board_id);
  if (!board || !canView(req.user, board)) fail(404, 'Item not found');
  if (need === 'edit' && !canEditItems(req.user, board)) fail(403, 'You can only view this board');
  return { row, board };
}

function cleanOptions(options) {
  if (!Array.isArray(options) || options.length === 0 || options.length > 30) fail(400, 'Status columns need 1–30 options');
  const seen = new Set();
  return options.map((o) => {
    const label = str(o?.label, { max: 40, required: true, field: 'Option label' });
    if (seen.has(label)) fail(400, `Duplicate option "${label}"`);
    seen.add(label);
    const color = /^#[0-9a-f]{6}$/i.test(o?.color) ? o.color : '#c4c4c4';
    return { label, color };
  });
}

function boardPayload(board, user) {
  const groups = db.prepare('SELECT id, name, color, position FROM board_groups WHERE board_id = ? ORDER BY position, id').all(board.id);
  const items = db.prepare('SELECT * FROM items WHERE board_id = ? ORDER BY position, id').all(board.id).map(serializeItem);
  const members = db.prepare(`SELECT u.id, u.name, u.email, u.role FROM board_members m JOIN users u ON u.id = m.user_id
    WHERE m.board_id = ? ORDER BY u.name`).all(board.id);
  const counts = Object.fromEntries(db.prepare(`SELECT u.item_id, COUNT(*) n FROM item_updates u JOIN items i ON i.id = u.item_id
    WHERE i.board_id = ? GROUP BY u.item_id`).all(board.id).map((r) => [r.item_id, r.n]));
  for (const item of items) item.updateCount = counts[item.id] || 0;
  return {
    board: {
      id: board.id, name: board.name, description: board.description, kind: board.kind, visibility: board.visibility,
      ownerId: board.owner_id, createdAt: board.created_at,
    },
    groups, columns: boardColumns(board.id), items, members,
    permissions: { edit: canEditItems(user, board), manage: canManage(user, board) },
  };
}

// --- boards ---

router.get('/boards', (req, res) => {
  const boards = visibleBoards(req.user).map((b) => {
    const { n } = db.prepare('SELECT COUNT(*) n FROM items WHERE board_id = ?').get(b.id);
    return { id: b.id, name: b.name, description: b.description, kind: b.kind, visibility: b.visibility, itemCount: n };
  });
  res.json({ boards, templates: Object.entries(BOARD_TEMPLATES).map(([value, t]) => ({ value, label: t.label })) });
});

router.post('/boards', requireStaff, (req, res) => {
  const name = str(req.body.name, { max: 80, required: true, field: 'Board name' });
  const description = str(req.body.description, { max: 500, field: 'Description' });
  const template = BOARD_TEMPLATES[req.body.template] ? req.body.template : 'project';
  const visibility = req.body.visibility === 'private' ? 'private' : 'team';
  const boardId = createBoard({ name, description, template, visibility, ownerId: req.user.id });
  logActivity({ userId: req.user.id, boardId, action: 'board.created', detail: name });
  res.status(201).json(boardPayload(getBoard(boardId), req.user));
});

router.get('/boards/:boardId', (req, res) => {
  res.json(boardPayload(loadBoard(req), req.user));
});

router.patch('/boards/:boardId', (req, res) => {
  const board = loadBoard(req, 'manage');
  const name = str(req.body.name ?? board.name, { max: 80, required: true, field: 'Board name' });
  const description = str(req.body.description ?? board.description, { max: 500, field: 'Description' });
  const visibility = req.body.visibility === undefined ? board.visibility : (req.body.visibility === 'private' ? 'private' : 'team');
  db.prepare('UPDATE boards SET name = ?, description = ?, visibility = ? WHERE id = ?').run(name, description, visibility, board.id);
  if (name !== board.name) logActivity({ userId: req.user.id, boardId: board.id, action: 'board.renamed', detail: `${board.name} → ${name}` });
  res.json(boardPayload(getBoard(board.id), req.user));
});

router.delete('/boards/:boardId', (req, res) => {
  const board = loadBoard(req, 'manage');
  if (String(board.id) === db.prepare(`SELECT value FROM settings WHERE key = 'leads_board_id'`).get()?.value) {
    fail(400, 'The website leads board cannot be archived');
  }
  db.prepare('UPDATE boards SET archived = 1 WHERE id = ?').run(board.id);
  logActivity({ userId: req.user.id, boardId: board.id, action: 'board.archived', detail: board.name });
  res.json({ ok: true });
});

router.post('/boards/:boardId/members', (req, res) => {
  const board = loadBoard(req, 'manage');
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(id(req.body.userId));
  if (!user) fail(404, 'User not found');
  db.prepare('INSERT OR IGNORE INTO board_members (board_id, user_id) VALUES (?, ?)').run(board.id, user.id);
  logActivity({ userId: req.user.id, boardId: board.id, action: 'board.member_added', detail: user.name });
  res.json(boardPayload(board, req.user));
});

router.delete('/boards/:boardId/members/:userId', (req, res) => {
  const board = loadBoard(req, 'manage');
  db.prepare('DELETE FROM board_members WHERE board_id = ? AND user_id = ?').run(board.id, id(req.params.userId));
  res.json(boardPayload(board, req.user));
});

// --- groups ---

router.post('/boards/:boardId/groups', (req, res) => {
  const board = loadBoard(req, 'manage');
  const name = str(req.body.name, { max: 80, required: true, field: 'Group name' });
  const color = /^#[0-9a-f]{6}$/i.test(req.body.color) ? req.body.color : '#579bfc';
  const { p } = db.prepare('SELECT COALESCE(MIN(position), 0) - 1 p FROM board_groups WHERE board_id = ?').get(board.id);
  db.prepare('INSERT INTO board_groups (board_id, name, color, position) VALUES (?, ?, ?, ?)').run(board.id, name, color, p);
  res.status(201).json(boardPayload(board, req.user));
});

router.patch('/boards/:boardId/groups/:groupId', (req, res) => {
  const board = loadBoard(req, 'manage');
  const group = db.prepare('SELECT * FROM board_groups WHERE id = ? AND board_id = ?').get(id(req.params.groupId), board.id);
  if (!group) fail(404, 'Group not found');
  const name = str(req.body.name ?? group.name, { max: 80, required: true, field: 'Group name' });
  const color = /^#[0-9a-f]{6}$/i.test(req.body.color) ? req.body.color : group.color;
  db.prepare('UPDATE board_groups SET name = ?, color = ? WHERE id = ?').run(name, color, group.id);
  res.json(boardPayload(board, req.user));
});

router.delete('/boards/:boardId/groups/:groupId', (req, res) => {
  const board = loadBoard(req, 'manage');
  const { n } = db.prepare('SELECT COUNT(*) n FROM board_groups WHERE board_id = ?').get(board.id);
  if (n <= 1) fail(400, 'A board needs at least one group');
  db.prepare('DELETE FROM board_groups WHERE id = ? AND board_id = ?').run(id(req.params.groupId), board.id);
  res.json(boardPayload(board, req.user));
});

// --- columns ---

router.post('/boards/:boardId/columns', (req, res) => {
  const board = loadBoard(req, 'manage');
  const name = str(req.body.name, { max: 40, required: true, field: 'Column name' });
  const type = String(req.body.type);
  if (!COLUMN_TYPES.includes(type)) fail(400, 'Unknown column type');
  const options = type === 'status' ? cleanOptions(req.body.options) : [];
  const { p } = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 p FROM board_columns WHERE board_id = ?').get(board.id);
  db.prepare('INSERT INTO board_columns (board_id, name, type, options, position) VALUES (?, ?, ?, ?, ?)')
    .run(board.id, name, type, JSON.stringify(options), p);
  res.status(201).json(boardPayload(board, req.user));
});

router.patch('/boards/:boardId/columns/:columnId', (req, res) => {
  const board = loadBoard(req, 'manage');
  const column = boardColumns(board.id).find((c) => c.id === id(req.params.columnId));
  if (!column) fail(404, 'Column not found');
  const name = str(req.body.name ?? column.name, { max: 40, required: true, field: 'Column name' });
  const options = column.type === 'status' && req.body.options ? cleanOptions(req.body.options) : column.options;
  db.prepare('UPDATE board_columns SET name = ?, options = ? WHERE id = ?').run(name, JSON.stringify(options), column.id);
  res.json(boardPayload(board, req.user));
});

router.delete('/boards/:boardId/columns/:columnId', (req, res) => {
  const board = loadBoard(req, 'manage');
  const columnId = id(req.params.columnId);
  tx(() => {
    db.prepare('DELETE FROM board_columns WHERE id = ? AND board_id = ?').run(columnId, board.id);
    for (const row of db.prepare('SELECT id, data FROM items WHERE board_id = ?').all(board.id)) {
      const data = JSON.parse(row.data);
      if (columnId in data) {
        delete data[columnId];
        db.prepare('UPDATE items SET data = ? WHERE id = ?').run(JSON.stringify(data), row.id);
      }
    }
  });
  res.json(boardPayload(board, req.user));
});

// --- items ---

function applyValues(board, current, incoming) {
  if (incoming === undefined) return { data: current, changed: [] };
  if (typeof incoming !== 'object' || incoming === null || Array.isArray(incoming)) fail(400, 'data must be an object');
  const columns = boardColumns(board.id);
  const data = { ...current };
  const changed = [];
  for (const [key, value] of Object.entries(incoming)) {
    const column = columns.find((c) => String(c.id) === key);
    if (!column) fail(400, `Unknown column ${key}`);
    let clean;
    try { clean = cleanValue(column, value); } catch (err) { fail(400, err.message); }
    if (clean === null) delete data[key]; else data[key] = clean;
    if (clean !== (current[key] ?? null)) changed.push({ column, from: current[key] ?? null, to: clean });
  }
  return { data, changed };
}

function notifyAssignees(actor, board, itemId, itemName, changed) {
  for (const { column, to } of changed) {
    if (column.type !== 'person' || !to || to === actor.id) continue;
    const assignee = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(to);
    if (!assignee) continue;
    sendTemplate('item_assigned', assignee.email, {
      name: assignee.name, actor: actor.name, item: itemName, board: board.name, url: itemUrl(board.id, itemId),
    }, { category: 'notifications', createdBy: actor.id });
  }
}

function describe(change) {
  const show = (v) => {
    if (v === null) return 'empty';
    if (change.column.type === 'person') return db.prepare('SELECT name FROM users WHERE id = ?').get(v)?.name || 'someone';
    return String(v).length > 60 ? `${String(v).slice(0, 60)}…` : String(v);
  };
  return `${change.column.name}: ${show(change.from)} → ${show(change.to)}`;
}

router.post('/boards/:boardId/items', (req, res) => {
  const board = loadBoard(req, 'edit');
  const name = str(req.body.name, { max: 200, required: true, field: 'Item name' });
  const groupId = req.body.groupId ? id(req.body.groupId)
    : db.prepare('SELECT id FROM board_groups WHERE board_id = ? ORDER BY position, id LIMIT 1').get(board.id)?.id;
  if (!db.prepare('SELECT 1 FROM board_groups WHERE id = ? AND board_id = ?').get(groupId, board.id)) fail(400, 'Unknown group');
  const { data, changed } = applyValues(board, {}, req.body.data || {});
  const { p } = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 p FROM items WHERE group_id = ?').get(groupId);
  const itemId = Number(db.prepare(`INSERT INTO items (board_id, group_id, name, data, position, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(board.id, groupId, name, JSON.stringify(data), p, req.user.id, now(), now()).lastInsertRowid);
  logActivity({ userId: req.user.id, boardId: board.id, itemId, action: 'item.created', detail: name });
  notifyAssignees(req.user, board, itemId, name, changed);
  res.status(201).json({ item: serializeItem(db.prepare('SELECT * FROM items WHERE id = ?').get(itemId)) });
});

router.patch('/items/:itemId', (req, res) => {
  const { row, board } = loadItem(req, 'edit');
  const name = str(req.body.name ?? row.name, { max: 200, required: true, field: 'Item name' });
  let groupId = row.group_id;
  if (req.body.groupId !== undefined) {
    groupId = id(req.body.groupId);
    if (!db.prepare('SELECT 1 FROM board_groups WHERE id = ? AND board_id = ?').get(groupId, board.id)) fail(400, 'Unknown group');
  }
  const position = Number.isFinite(req.body.position) ? req.body.position : row.position;
  const { data, changed } = applyValues(board, JSON.parse(row.data), req.body.data);
  db.prepare('UPDATE items SET name = ?, group_id = ?, data = ?, position = ?, updated_at = ? WHERE id = ?')
    .run(name, groupId, JSON.stringify(data), position, now(), row.id);
  const notes = changed.map(describe);
  if (name !== row.name) notes.unshift(`Renamed from "${row.name}"`);
  if (groupId !== row.group_id) notes.push(`Moved to ${db.prepare('SELECT name FROM board_groups WHERE id = ?').get(groupId).name}`);
  for (const detail of notes) logActivity({ userId: req.user.id, boardId: board.id, itemId: row.id, action: 'item.updated', detail: `${name} · ${detail}` });
  notifyAssignees(req.user, board, row.id, name, changed);
  res.json({ item: serializeItem(db.prepare('SELECT * FROM items WHERE id = ?').get(row.id)) });
});

router.delete('/items/:itemId', (req, res) => {
  const { row, board } = loadItem(req, 'edit');
  db.prepare('DELETE FROM items WHERE id = ?').run(row.id);
  logActivity({ userId: req.user.id, boardId: board.id, itemId: row.id, action: 'item.deleted', detail: row.name });
  res.json({ ok: true });
});

router.get('/items/:itemId', (req, res) => {
  const { row, board } = loadItem(req);
  const updates = db.prepare(`SELECT u.id, u.body, u.created_at createdAt, u.user_id userId, usr.name userName
    FROM item_updates u LEFT JOIN users usr ON usr.id = u.user_id WHERE u.item_id = ? ORDER BY u.id DESC`).all(row.id);
  const activity = db.prepare(`SELECT a.id, a.action, a.detail, a.created_at createdAt, usr.name userName
    FROM activity a LEFT JOIN users usr ON usr.id = a.user_id WHERE a.item_id = ? ORDER BY a.id DESC LIMIT 50`).all(row.id);
  res.json({ item: serializeItem(row), boardName: board.name, updates, activity });
});

router.post('/items/:itemId/updates', (req, res) => {
  const { row, board } = loadItem(req);
  const body = str(req.body.body, { max: 5000, required: true, field: 'Update' });
  db.prepare('INSERT INTO item_updates (item_id, user_id, body, created_at) VALUES (?, ?, ?, ?)').run(row.id, req.user.id, body, now());
  logActivity({ userId: req.user.id, boardId: board.id, itemId: row.id, action: 'item.commented', detail: row.name });
  // Tell everyone assigned to the item.
  const data = JSON.parse(row.data);
  const people = new Set(boardColumns(board.id).filter((c) => c.type === 'person').map((c) => data[c.id]).filter(Boolean));
  people.delete(req.user.id);
  for (const userId of people) {
    const u = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(userId);
    if (u) sendTemplate('item_update', u.email, { name: u.name, actor: req.user.name, item: row.name, board: board.name, body, url: itemUrl(board.id, row.id) },
      { category: 'notifications', createdBy: req.user.id });
  }
  res.status(201).json({ ok: true });
});

// --- dashboard, activity, search ---

router.get('/activity', (req, res) => {
  const boardIds = new Set(visibleBoards(req.user).map((b) => b.id));
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const rows = db.prepare(`SELECT a.*, u.name userName, b.name boardName FROM activity a
    LEFT JOIN users u ON u.id = a.user_id LEFT JOIN boards b ON b.id = a.board_id ORDER BY a.id DESC LIMIT 1000`).all();
  const visible = rows.filter((r) => (r.board_id ? boardIds.has(r.board_id) : req.user.role === 'super_admin' || req.user.role === 'admin'))
    .slice(0, limit)
    .map((r) => ({ id: r.id, action: r.action, detail: r.detail, createdAt: r.created_at, userName: r.userName, boardId: r.board_id, boardName: r.boardName, itemId: r.item_id }));
  res.json({ activity: visible });
});

router.get('/dashboard', (req, res) => {
  const boards = visibleBoards(req.user);
  const today = new Date().toISOString().slice(0, 10);
  const mine = [];
  let total = 0;
  let overdue = 0;
  const statusTotals = {};
  for (const board of boards) {
    const columns = boardColumns(board.id);
    const people = columns.filter((c) => c.type === 'person');
    const status = columns.find((c) => c.type === 'status');
    const dates = columns.filter((c) => c.type === 'date');
    for (const row of db.prepare('SELECT * FROM items WHERE board_id = ?').all(board.id)) {
      const item = serializeItem(row);
      total++;
      const label = status ? item.data[status.id] : null;
      const done = DONE_LABELS.has(label);
      if (status) {
        const option = status.options.find((o) => o.label === label);
        const key = label || 'No status';
        statusTotals[key] ??= { label: key, color: option?.color || '#c4c4c4', count: 0 };
        statusTotals[key].count++;
      }
      const due = dates.map((c) => item.data[c.id]).filter(Boolean).sort()[0] || null;
      const isOverdue = !done && due && due < today;
      if (isOverdue) overdue++;
      if (people.some((c) => item.data[c.id] === req.user.id) && !done) {
        mine.push({ id: item.id, name: item.name, boardId: board.id, boardName: board.name, status: label || null,
          statusColor: status?.options.find((o) => o.label === label)?.color || null, due, overdue: !!isOverdue });
      }
    }
  }
  mine.sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
  res.json({
    stats: { boards: boards.length, items: total, overdue, mine: mine.length },
    status: Object.values(statusTotals).sort((a, b) => b.count - a.count),
    mine: mine.slice(0, 30),
    canSeeMail: isStaff(req.user) && ['super_admin', 'admin'].includes(req.user.role),
  });
});

router.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (q.length < 2) return res.json({ results: [] });
  const results = [];
  for (const board of visibleBoards(req.user)) {
    if (board.name.toLowerCase().includes(q)) results.push({ type: 'board', id: board.id, name: board.name });
    for (const row of db.prepare('SELECT id, name, data FROM items WHERE board_id = ?').all(board.id)) {
      if (row.name.toLowerCase().includes(q) || row.data.toLowerCase().includes(q)) {
        results.push({ type: 'item', id: row.id, name: row.name, boardId: board.id, boardName: board.name });
      }
    }
    if (results.length >= 40) break;
  }
  res.json({ results: results.slice(0, 40) });
});
