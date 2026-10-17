// Lyrsoft work management: permissions, validation and board templates.
// Pure functions only, so they can be tested without AWS (see model.test.mjs).
import { randomBytes } from 'node:crypto';

export const newId = () => randomBytes(9).toString('base64url');
export const ID_RE = /^[A-Za-z0-9_-]{1,24}$/;
export const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;

// ------------------------------------------------------------------ permissions

// Workspace roles, strongest first. The owner created the workspace; admins manage the
// team and boards; members work on boards.
export const WORKSPACE_ROLES = ['owner', 'admin', 'member'];
const rank = (role) => (WORKSPACE_ROLES.includes(role) ? WORKSPACE_ROLES.length - WORKSPACE_ROLES.indexOf(role) : 0);

// Lyrcloud staff (see api/account/roles.mjs) can open every workspace: the super admin as
// owner, admins as admin. Everyone else gets their membership role, or no access (null).
export function effectiveRole(globalRole, memberRole) {
  if (globalRole === 'superadmin') return 'owner';
  const staff = globalRole === 'admin' ? 'admin' : null;
  return rank(memberRole) >= rank(staff) ? memberRole || null : staff;
}

const ABILITIES = {
  view: 'member',
  editBoards: 'member',
  manageMembers: 'admin',
  renameWorkspace: 'admin',
  deleteWorkspace: 'owner',
};

export const can = (role, ability) => rank(role) >= rank(ABILITIES[ability]);

// Returns [statusCode, message] when `actorRole` may not set `targetEmail`'s role to `newRole`
// (null newRole = remove), else null.
export function memberChangeError({ actorRole, actorEmail, targetEmail, targetRole, newRole }) {
  const self = actorEmail === targetEmail;
  if (newRole === null && self && targetRole !== 'owner') return null; // anyone but the owner can leave
  if (!can(actorRole, 'manageMembers')) return [403, 'Only workspace owners and admins manage the team.'];
  if (newRole !== null && !['admin', 'member'].includes(newRole)) return [400, 'Role must be "admin" or "member".'];
  if (targetRole === 'owner') return [400, "The workspace owner can't be changed or removed."];
  if (targetRole === 'admin' && actorRole !== 'owner') return [403, 'Only the owner changes or removes admins.'];
  return null;
}

// ------------------------------------------------------------------ validation

export const COLUMN_TYPES = ['status', 'person', 'date', 'text', 'number'];
export const COLORS = ['#00c875', '#fdab3d', '#e2445c', '#579bfc', '#a25ddc', '#ff642e', '#037f4c', '#c4c4c4', '#ff5ac4', '#66ccff', '#9d50dd', '#784bd1'];
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const text = (value, max) => String(value ?? '').trim().slice(0, max);

class ValidationError extends Error {}
export { ValidationError };
const fail = (message) => {
  throw new ValidationError(message);
};

export function cleanName(value, what, max = 120) {
  const name = text(value, max);
  if (!name) fail(`${what} name is required.`);
  return name;
}

export function cleanColumns(columns) {
  if (!Array.isArray(columns) || columns.length > 30) fail('A board can have up to 30 columns.');
  const ids = new Set();
  return columns.map((column) => {
    if (!ID_RE.test(column?.id || '') || ids.has(column.id)) fail('Each column needs a unique id.');
    ids.add(column.id);
    if (!COLUMN_TYPES.includes(column.type)) fail(`Unknown column type "${column.type}".`);
    const clean = { id: column.id, title: cleanName(column.title, 'Column', 60), type: column.type };
    if (column.type === 'status') {
      const labels = Array.isArray(column.labels) ? column.labels : [];
      if (!labels.length || labels.length > 20) fail('A status column needs 1 to 20 labels.');
      const labelIds = new Set();
      clean.labels = labels.map((label) => {
        if (!ID_RE.test(label?.id || '') || labelIds.has(label.id)) fail('Each status label needs a unique id.');
        labelIds.add(label.id);
        return { id: label.id, label: text(label.label, 40), color: COLOR_RE.test(label.color) ? label.color : '#c4c4c4' };
      });
    }
    return clean;
  });
}

export function cleanGroups(groups) {
  if (!Array.isArray(groups) || !groups.length || groups.length > 50) fail('A board needs 1 to 50 groups.');
  const ids = new Set();
  return groups.map((group) => {
    if (!ID_RE.test(group?.id || '') || ids.has(group.id)) fail('Each group needs a unique id.');
    ids.add(group.id);
    return { id: group.id, title: cleanName(group.title, 'Group', 80), color: COLOR_RE.test(group.color) ? group.color : COLORS[3] };
  });
}

// Keeps only values for known columns, each checked against its column type.
// An empty string or null clears a cell.
export function cleanValues(values, columns) {
  if (values == null) return {};
  if (typeof values !== 'object' || Array.isArray(values)) fail('Item values must be an object.');
  const clean = {};
  for (const column of columns) {
    if (!(column.id in values)) continue;
    const value = values[column.id];
    if (value === null || value === '') {
      clean[column.id] = null;
      continue;
    }
    switch (column.type) {
      case 'status':
        if (!column.labels.some((label) => label.id === value)) fail(`Unknown status for "${column.title}".`);
        clean[column.id] = value;
        break;
      case 'person':
        if (!EMAIL_RE.test(String(value))) fail(`"${column.title}" needs an email address.`);
        clean[column.id] = String(value).toLowerCase();
        break;
      case 'date':
        if (!DATE_RE.test(String(value)) || Number.isNaN(Date.parse(value))) fail(`"${column.title}" needs a date (YYYY-MM-DD).`);
        clean[column.id] = String(value);
        break;
      case 'number': {
        const number = Number(value);
        if (!Number.isFinite(number)) fail(`"${column.title}" needs a number.`);
        clean[column.id] = number;
        break;
      }
      default:
        clean[column.id] = text(value, 2000);
    }
  }
  return clean;
}

// ------------------------------------------------------------------ templates

const statusColumn = (id, title, labels) => ({
  id,
  title,
  type: 'status',
  labels: labels.map(([labelId, label, color]) => ({ id: labelId, label, color })),
});

export function defaultBoard(name) {
  return {
    name,
    description: '',
    columns: [
      { id: 'owner', title: 'Owner', type: 'person' },
      statusColumn('status', 'Status', [
        ['todo', 'Not started', '#c4c4c4'],
        ['working', 'Working on it', '#fdab3d'],
        ['stuck', 'Stuck', '#e2445c'],
        ['done', 'Done', '#00c875'],
      ]),
      { id: 'due', title: 'Due date', type: 'date' },
      statusColumn('priority', 'Priority', [
        ['high', 'High', '#e2445c'],
        ['medium', 'Medium', '#579bfc'],
        ['low', 'Low', '#a25ddc'],
      ]),
      { id: 'notes', title: 'Notes', type: 'text' },
    ],
    groups: [
      { id: 'todo', title: 'To do', color: '#579bfc' },
      { id: 'doing', title: 'In progress', color: '#fdab3d' },
      { id: 'done', title: 'Completed', color: '#00c875' },
    ],
  };
}
