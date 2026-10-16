import { api, h, mount } from '../lib.js';
import { activityList } from './dashboard.js';

export async function renderActivity(root) {
  const { activity } = await api('/activity?limit=200');
  mount(root, h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('h1', null, 'Activity'), h('p', { class: 'muted' }, 'The latest 200 changes across boards you can see.')),
    h('section', { class: 'panel' }, activityList(activity))));
}
