import { db, now, tx } from './db.js';
import { isAdmin, isStaff } from './auth.js';

export const STATUS_PRESETS = {
  work: [
    { label: 'Not started', color: '#c4c4c4' },
    { label: 'Working on it', color: '#fdab3d' },
    { label: 'Stuck', color: '#e2445c' },
    { label: 'In review', color: '#a25ddc' },
    { label: 'Done', color: '#00c875' },
  ],
  priority: [
    { label: 'Low', color: '#579bfc' },
    { label: 'Medium', color: '#5559df' },
    { label: 'High', color: '#fdab3d' },
    { label: 'Critical', color: '#e2445c' },
  ],
  lead: [
    { label: 'New', color: '#579bfc' },
    { label: 'Contacted', color: '#fdab3d' },
    { label: 'Proposal sent', color: '#a25ddc' },
    { label: 'Won', color: '#00c875' },
    { label: 'Lost', color: '#e2445c' },
  ],
};

export const DONE_LABELS = new Set(['Done', 'Won', 'Lost']);

const col = (name, type, options = []) => ({ name, type, options });

export const BOARD_TEMPLATES = {
  project: {
    label: 'Client project',
    groups: [['To do', '#579bfc'], ['In progress', '#fdab3d'], ['Done', '#00c875']],
    columns: [col('Owner', 'person'), col('Status', 'status', STATUS_PRESETS.work), col('Priority', 'status', STATUS_PRESETS.priority), col('Due date', 'date'), col('Estimate (h)', 'number')],
  },
  sprint: {
    label: 'Engineering sprint',
    groups: [['Backlog', '#c4c4c4'], ['This sprint', '#5559df'], ['Shipped', '#00c875']],
    columns: [col('Assignee', 'person'), col('Status', 'status', STATUS_PRESETS.work), col('Priority', 'status', STATUS_PRESETS.priority), col('Story points', 'number'), col('Due date', 'date')],
  },
  crm: {
    label: 'Sales pipeline',
    groups: [['Inbound', '#579bfc'], ['Qualified', '#a25ddc'], ['Closed', '#00c875']],
    columns: [col('Status', 'status', STATUS_PRESETS.lead), col('Owner', 'person'), col('Email', 'email'), col('Company', 'text'), col('Budget', 'text'), col('Service', 'text'), col('Message', 'longtext'), col('Follow up', 'date')],
  },
  blank: {
    label: 'Blank board',
    groups: [['Group 1', '#579bfc']],
    columns: [col('Owner', 'person'), col('Status', 'status', STATUS_PRESETS.work), col('Date', 'date')],
  },
};

export function createBoard({ name, description = '', template = 'project', visibility = 'team', ownerId = null }) {
  const tpl = BOARD_TEMPLATES[template] || BOARD_TEMPLATES.blank;
  return tx(() => {
    const boardId = Number(db.prepare('INSERT INTO boards (name, description, kind, visibility, owner_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(name, description, template, visibility, ownerId, now()).lastInsertRowid);
    tpl.groups.forEach(([g, color], i) => db.prepare('INSERT INTO board_groups (board_id, name, color, position) VALUES (?, ?, ?, ?)').run(boardId, g, color, i));
    tpl.columns.forEach((c, i) => db.prepare('INSERT INTO board_columns (board_id, name, type, options, position) VALUES (?, ?, ?, ?, ?)')
      .run(boardId, c.name, c.type, JSON.stringify(c.options), i));
    if (ownerId) db.prepare('INSERT OR IGNORE INTO board_members (board_id, user_id) VALUES (?, ?)').run(boardId, ownerId);
    return boardId;
  });
}

export const getBoard = (boardId) => db.prepare('SELECT * FROM boards WHERE id = ? AND archived = 0').get(boardId);

const isMember = (user, boardId) => !!db.prepare('SELECT 1 FROM board_members WHERE board_id = ? AND user_id = ?').get(boardId, user.id);

export function canView(user, board) {
  if (!user || !board) return false;
  if (isAdmin(user)) return true;
  if (isMember(user, board.id)) return true;
  return board.visibility === 'team' && isStaff(user);
}

// Staff who can see a board can work on its items. Clients can only read and comment.
export const canEditItems = (user, board) => canView(user, board) && isStaff(user);

// Changing a board's structure (columns, groups, members, settings) is for admins, managers and the board owner.
export const canManage = (user, board) =>
  canView(user, board) && (isAdmin(user) || user.role === 'manager' || board.owner_id === user.id);

export function visibleBoards(user) {
  const boards = db.prepare('SELECT * FROM boards WHERE archived = 0 ORDER BY name COLLATE NOCASE').all();
  return boards.filter((b) => canView(user, b));
}

export function boardColumns(boardId) {
  return db.prepare('SELECT * FROM board_columns WHERE board_id = ? ORDER BY position, id').all(boardId)
    .map((c) => ({ id: c.id, name: c.name, type: c.type, options: JSON.parse(c.options), position: c.position }));
}

export function serializeItem(row) {
  return {
    id: row.id, boardId: row.board_id, groupId: row.group_id, name: row.name, data: JSON.parse(row.data),
    position: row.position, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

// Validates a value for a column. Returns the cleaned value, or null to clear it.
export function cleanValue(column, value) {
  if (value === null || value === undefined || value === '') return null;
  switch (column.type) {
    case 'status': {
      const label = String(value);
      if (!column.options.some((o) => o.label === label)) throw new Error(`"${label}" is not an option of ${column.name}`);
      return label;
    }
    case 'person': {
      const userId = Number(value);
      if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) throw new Error('Unknown person');
      return userId;
    }
    case 'date':
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) throw new Error('Dates use YYYY-MM-DD');
      return String(value);
    case 'number': {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(`${column.name} must be a number`);
      return n;
    }
    case 'longtext':
      return String(value).slice(0, 5000);
    default:
      return String(value).slice(0, 500);
  }
}
