import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addPeriod, afterCheck, cleanMonitor, cleanTask, cleanUrl, cleanWindow, completeTask, covers, isPrivateAddress, judge, percentile, rollup, taskState, uptime } from './ops-model.mjs';

test('addresses: public only', () => {
  assert.equal(cleanUrl('example.com'), 'https://example.com/');
  assert.equal(cleanUrl('http://shop.example.com/health#x'), 'http://shop.example.com/health');
  for (const bad of ['ftp://example.com', 'http://localhost:3000', 'http://10.0.0.5', 'http://169.254.169.254/latest', 'https://[::1]/', 'http://intranet', 'https://u:p@example.com', 'https://example.com:22']) assert.throws(() => cleanUrl(bad), undefined, bad);
  assert.deepEqual(['8.8.8.8', '192.168.1.1', '172.20.0.1', '100.64.0.1', '::ffff:127.0.0.1', 'fd00::1', '2606:4700::1'].map(isPrivateAddress), [false, true, true, true, true, true, false]);
});

test('monitors and verdicts', () => {
  const m = cleanMonitor({ name: 'Shop', url: 'shop.example.com', keyword: 'Add to cart', method: 'HEAD', interval: 7 });
  assert.equal(m.method, 'GET', 'a keyword needs the page');
  assert.equal(m.interval, 5);
  assert.throws(() => cleanMonitor({ url: 'example.com' }), /name/);
  assert.deepEqual(judge(m, { code: 200, ms: 300, body: '<button>Add to cart</button>' }), { status: 'up', problem: '' });
  assert.equal(judge(m, { code: 200, ms: 5000, body: 'add to cart' }).status, 'slow');
  assert.match(judge(m, { code: 200, ms: 300, body: 'Sold out' }).problem, /not found/);
  assert.equal(judge(m, { code: 503, ms: 300, body: '' }).problem, 'HTTP 503');
  assert.equal(judge(m, { error: 'Timed out' }, true).status, 'maintenance');
  assert.equal(judge({ ...m, keyword: '', expect: '301' }, { code: 301, ms: 50 }).status, 'up');
});

test('a failure is retried before an incident opens, and recovery closes it', () => {
  let m = { ...cleanMonitor({ name: 'API', url: 'api.example.com' }), id: 'a', status: 'up', recent: [] };
  const down = { status: 'down', ms: 10000, problem: 'Timed out' };
  let r = afterCheck(m, down, '2026-11-08T10:00:00Z');
  assert.equal(r.open, false);
  assert.equal(r.monitor.status, 'up');
  r = afterCheck(r.monitor, down, '2026-11-08T10:05:00Z');
  assert.equal(r.open, true);
  assert.equal(r.monitor.status, 'down');
  m = { ...r.monitor, incident: 'i1' };
  r = afterCheck(m, down, '2026-11-08T10:10:00Z');
  assert.equal(r.open, false, 'one incident per outage');
  r = afterCheck(r.monitor, { status: 'up', ms: 200 }, '2026-11-08T10:15:00Z');
  assert.equal(r.close, true);
  assert.equal(r.monitor.status, 'up');
  assert.equal(r.monitor.recent.length, 4);
});

test('rollups and uptime', () => {
  let d = {};
  for (const [status, ms] of [['up', 100], ['slow', 3000], ['down', 0], ['maintenance', 0]]) d = rollup(d, { status, ms });
  assert.deepEqual(uptime([d]), { checks: 3, uptime: 66.66, avgMs: 1550, avgBytes: 0 });
  assert.equal(uptime([]).uptime, null);
  assert.equal(percentile([5, 1, 4, 2, 3], 95), 5);
  assert.equal(percentile([5, 1, 4, 2, 3], 50), 3);
});

test('maintenance windows and tasks', () => {
  const w = cleanWindow({ title: 'Server move', startsAt: '2026-11-08T20:00:00Z', endsAt: '2026-11-08T22:00:00Z', monitorIds: ['a'] });
  assert.equal(covers(w, 'a', '2026-11-08T21:00:00.000Z'), true);
  assert.equal(covers(w, 'b', '2026-11-08T21:00:00.000Z'), false);
  assert.equal(covers({ ...w, monitorIds: [] }, 'b', '2026-11-08T21:00:00.000Z'), true);
  assert.throws(() => cleanWindow({ title: 'x', startsAt: '2026-11-08T22:00:00Z', endsAt: '2026-11-08T20:00:00Z' }), /after/);
  assert.equal(addPeriod('2026-01-31', 'monthly'), '2026-02-28');
  assert.equal(addPeriod('2026-11-08', 'weekly'), '2026-11-15');
  assert.equal(addPeriod('2024-02-29', 'yearly'), '2025-02-28');
  const t = cleanTask({ title: 'Backups', frequency: 'monthly', due: '2026-09-10' });
  assert.equal(completeTask(t, '2026-11-08').due, '2026-11-10', 'rolls past today');
  assert.equal(completeTask({ ...t, due: '2026-11-15' }, '2026-11-08').due, '2026-12-15', 'done early: next period');
  assert.equal(completeTask({ ...t, frequency: 'once' }, '2026-11-08').done, true);
  assert.equal(taskState(t, '2026-11-08'), 'overdue');
  assert.equal(taskState({ ...t, due: '2026-11-12' }, '2026-11-08'), 'soon');
  assert.throws(() => cleanTask({ title: 'x', due: '2026-02-30' }), /due/);
});
