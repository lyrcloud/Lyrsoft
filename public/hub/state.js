import { api } from './lib.js';

export const state = { me: null, users: [], roles: [], boards: [], templates: [] };

export const isAdmin = () => state.me && ['super_admin', 'admin'].includes(state.me.role);
export const isStaff = () => state.me && state.me.role !== 'client';
export const userById = (id) => state.users.find((u) => u.id === id) || null;

export async function loadDirectory() {
  const { users, roles } = await api('/users');
  state.users = users;
  state.roles = roles;
}

export async function loadBoards() {
  const { boards, templates } = await api('/boards');
  state.boards = boards;
  state.templates = templates;
}

export const ROLE_LABELS = { super_admin: 'Super admin', admin: 'Admin', manager: 'Manager', member: 'Member', client: 'Client' };
