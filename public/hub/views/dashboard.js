import { api, fmtDate, h, mount, timeAgo } from '../lib.js';
import { isAdmin, state } from '../state.js';

export function statTile(label, value, note, tone) {
  return h('div', { class: `stat${tone ? ` stat-${tone}` : ''}` }, h('span', { class: 'stat-label' }, label), h('strong', { class: 'stat-value' }, String(value)), note ? h('small', null, note) : null);
}

// One stacked bar of all items by status label, with a legend that carries names and counts.
function statusBreakdown(rows) {
  const total = rows.reduce((a, r) => a + r.count, 0);
  if (!total) return h('p', { class: 'muted' }, 'No items yet.');
  return h('div', { class: 'breakdown' },
    h('div', { class: 'stackbar', role: 'img', 'aria-label': rows.map((r) => `${r.label} ${r.count}`).join(', ') },
      rows.map((r) => h('span', { title: `${r.label}: ${r.count} (${Math.round((r.count / total) * 100)}%)`, style: { background: r.color, flexGrow: String(r.count) } }))),
    h('ul', { class: 'legend' }, rows.map((r) => h('li', null, h('span', { class: 'swatch', style: { background: r.color } }), r.label, h('b', null, String(r.count))))));
}

export function activityList(rows) {
  if (!rows.length) return h('p', { class: 'muted' }, 'Nothing has happened yet.');
  return h('ul', { class: 'feed' }, rows.map((a) => h('li', null,
    h('div', null, h('strong', null, a.userName || 'Website'), ' ', h('span', { class: 'muted' }, a.action.replace('.', ' ').replace('_', ' ')), ' · ', a.detail),
    h('small', { class: 'muted' }, a.boardName ? h('a', { href: a.itemId ? `#/boards/${a.boardId}?item=${a.itemId}` : `#/boards/${a.boardId}` }, a.boardName) : null, ` ${timeAgo(a.createdAt)}`))));
}

export async function renderDashboard(root) {
  const [dash, { activity }, mail] = await Promise.all([
    api('/dashboard'), api('/activity?limit=12'), isAdmin() ? api('/mail/overview') : null,
  ]);
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  mount(root, h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, `${greet}, ${state.me.name.split(' ')[0]}`),
      h('p', { class: 'muted' }, state.me.role === 'super_admin' ? 'You are the super admin — every board, user and email is under your control.' : 'Here is what needs your attention.'))),
    h('div', { class: 'stats' },
      statTile('Boards', dash.stats.boards),
      statTile('Items', dash.stats.items),
      statTile('Assigned to me', dash.stats.mine, 'open'),
      statTile('Overdue', dash.stats.overdue, 'past due, not done', dash.stats.overdue ? 'bad' : null),
      mail ? statTile('Emails sent', mail.counts.sent, `${mail.counts.queued} queued · ${mail.counts.failed} failed`, mail.counts.failed ? 'warn' : null) : null),
    h('div', { class: 'cols' },
      h('section', { class: 'panel' }, h('h2', null, 'My work'),
        dash.mine.length ? h('ul', { class: 'mywork' }, dash.mine.map((i) => h('li', null,
          h('a', { href: `#/boards/${i.boardId}?item=${i.id}` }, i.name),
          h('span', { class: 'muted' }, i.boardName),
          i.status ? h('span', { class: 'pill', style: { background: i.statusColor || '#c4c4c4' } }, i.status) : h('span'),
          h('span', { class: i.overdue ? 'late' : 'muted' }, i.due ? fmtDate(i.due) : '')))) : h('p', { class: 'muted' }, 'Nothing assigned to you. 🎉')),
      h('section', { class: 'panel' }, h('h2', null, 'All items by status'), statusBreakdown(dash.status))),
    h('section', { class: 'panel' }, h('div', { class: 'row space' }, h('h2', null, 'Recent activity'), h('a', { href: '#/activity' }, 'View all')), activityList(activity))));
}
