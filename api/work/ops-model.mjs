// Lyrsoft Performance & maintenance: pure rules behind ops.mjs (tested in ops.test.mjs). Monitors for
// websites, web apps and APIs (uptime, response time, page size, SSL and domain expiry), incidents,
// planned maintenance windows and a recurring maintenance checklist.
import { ValidationError } from './model.mjs';

export const KINDS = { website: 'Website', webapp: 'Web app', api: 'API', mobile: 'App backend', other: 'Other' };
export const INTERVALS = [1, 5, 10, 15, 30, 60]; // minutes
export const TASK_FREQUENCIES = ['once', 'weekly', 'monthly', 'quarterly', 'yearly'];
export const TASK_AREAS = { backup: 'Backups', updates: 'Updates & patches', security: 'Security', renewal: 'Renewals (domain, SSL, hosting)', performance: 'Performance', content: 'Content & SEO', other: 'Other' };
export const RECENT = 60; // checks kept on the monitor row for the status strip
export const RAW_TTL_HOURS = 50; // raw checks; days are kept as rollups
export const EXPIRY_WARN_DAYS = 21;

const EMAIL_RE = /^[^\s@<>(),;:"]{1,64}@[^\s@<>(),;:"]{1,190}\.[^\s@<>(),;:"]{2,63}$/;
const text = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const longText = (v, max) => String(v ?? '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').trim().slice(0, max);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isDate = (v) => DATE_RE.test(String(v || '')) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const emails = (v) => {
  const raw = Array.isArray(v) ? v : String(v || '').split(/[\s,;]+/);
  return [...new Set(raw.map((e) => text(e, 254).toLowerCase()).filter((e) => EMAIL_RE.test(e)))].slice(0, 30);
};

// ------------------------------------------------------------------ addresses

// Monitors run from Lyrsoft's servers, so they may only reach the public internet.
export function isPrivateAddress(ip) {
  const v = String(ip).toLowerCase().replace(/^::ffff:/, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v)) {
    const [a, b] = v.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  return v === '::' || v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || /^ff/.test(v);
}

export function cleanUrl(value) {
  let raw = text(value, 2000);
  if (raw && !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError('Enter the address to check, like https://example.com.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new ValidationError('Only http and https addresses can be checked.');
  if (url.username || url.password) throw new ValidationError('Leave the user name and password out of the address.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host.includes('.') && !host.includes(':')) throw new ValidationError('Use a public address, like https://example.com.');
  if (/^localhost$|\.local$|\.internal$|\.localhost$/i.test(host) || ((/^[\d.]+$/.test(host) || host.includes(':')) && isPrivateAddress(host))) throw new ValidationError('Private and local addresses can’t be checked from Lyrsoft.');
  if (url.port && !['80', '443', '8080', '8443'].includes(url.port)) throw new ValidationError('Use port 80, 443, 8080 or 8443.');
  url.hash = '';
  return url.toString();
}

// ------------------------------------------------------------------ monitors

export function cleanMonitor(input = {}, current = null) {
  const m = current ? { ...current } : { kind: 'website', method: 'GET', interval: 5, timeoutMs: 10000, slowMs: 2000, expect: '2xx-3xx', keyword: '', failuresToAlert: 2, checkSsl: true, checkDomain: true, paused: false, notes: '' };
  const has = (k) => k in input;
  if (has('name') || !current) {
    m.name = text(input.name, 80);
    if (!m.name) throw new ValidationError('Give the monitor a name.');
  }
  if (has('url') || !current) m.url = cleanUrl(input.url);
  if (has('kind')) m.kind = input.kind in KINDS ? input.kind : 'other';
  if (has('method')) m.method = input.method === 'HEAD' ? 'HEAD' : 'GET';
  if (has('interval')) m.interval = INTERVALS.includes(Number(input.interval)) ? Number(input.interval) : 5;
  if (has('timeoutMs')) m.timeoutMs = Math.min(15000, Math.max(2000, Math.round(Number(input.timeoutMs) || 10000)));
  if (has('slowMs')) m.slowMs = Math.min(15000, Math.max(200, Math.round(Number(input.slowMs) || 2000)));
  if (has('expect')) {
    const e = text(input.expect, 7);
    m.expect = /^[1-5]\d\d$/.test(e) ? e : '2xx-3xx';
  }
  if (has('keyword')) m.keyword = text(input.keyword, 120);
  if (m.keyword) m.method = 'GET';
  if (has('failuresToAlert')) m.failuresToAlert = Math.min(5, Math.max(1, Math.round(Number(input.failuresToAlert) || 2)));
  for (const k of ['checkSsl', 'checkDomain', 'paused']) if (has(k)) m[k] = input[k] === true || input[k] === 'on' || input[k] === 'true';
  if (has('notes')) m.notes = longText(input.notes, 2000);
  return m;
}

export const statusMatches = (expect, code) => (expect === '2xx-3xx' ? code >= 200 && code < 400 : String(code) === expect);

// One check's outcome: up, slow, down, or maintenance (a failure inside a maintenance window).
export function judge(monitor, { code = 0, ms = 0, error = '', body = null }, maintenance = false) {
  let problem = error;
  if (!problem && !statusMatches(monitor.expect, code)) problem = `HTTP ${code || 'no response'}`;
  if (!problem && monitor.keyword && body != null && !body.toLowerCase().includes(monitor.keyword.toLowerCase())) problem = `“${monitor.keyword}” not found on the page`;
  if (problem) return { status: maintenance ? 'maintenance' : 'down', problem };
  return { status: ms > monitor.slowMs ? 'slow' : 'up', problem: '' };
}

// What changes on the monitor after a check, and whether an incident opens or closes.
export function afterCheck(monitor, result, at) {
  const fails = result.status === 'down' ? (monitor.fails || 0) + 1 : 0;
  const recent = [...(monitor.recent || []), { at, s: result.status, ms: result.ms, code: result.code || 0 }].slice(-RECENT);
  const confirmed = result.status !== 'down' || fails >= monitor.failuresToAlert;
  // A first failure is retried before the monitor shows down (unless failuresToAlert is 1).
  const status = confirmed ? result.status : ['up', 'slow', 'down'].includes(monitor.status) ? monitor.status : 'up';
  const next = { ...monitor, fails, recent, status, lastCheckAt: at, lastMs: result.ms, lastCode: result.code || 0, lastProblem: result.problem || '' };
  if (result.status === 'up' || result.status === 'slow') next.lastUpAt = at;
  const open = result.status === 'down' && confirmed && !monitor.incident;
  const close = (result.status === 'up' || result.status === 'slow') && Boolean(monitor.incident);
  return { monitor: next, open, close };
}

// Adds a check to the day's rollup.
export function rollup(day = {}, result) {
  const d = { checks: 0, up: 0, slow: 0, down: 0, maintenance: 0, msSum: 0, msCount: 0, msMax: 0, bytesSum: 0, ...day };
  d.checks += 1;
  d[result.status] = (d[result.status] || 0) + 1;
  if (result.status === 'up' || result.status === 'slow') {
    d.msSum += result.ms;
    d.msCount += 1;
    d.msMax = Math.max(d.msMax, result.ms);
    d.bytesSum += result.bytes || 0;
  }
  return d;
}

// Uptime over rollups: maintenance is left out; slow still counts as up.
export function uptime(days) {
  let counted = 0;
  let good = 0;
  let msSum = 0;
  let msCount = 0;
  let bytesSum = 0;
  for (const d of days) {
    counted += (d.checks || 0) - (d.maintenance || 0);
    good += (d.up || 0) + (d.slow || 0);
    msSum += d.msSum || 0;
    msCount += d.msCount || 0;
    bytesSum += d.bytesSum || 0;
  }
  return { checks: counted, uptime: counted ? Math.floor((good / counted) * 10000) / 100 : null, avgMs: msCount ? Math.round(msSum / msCount) : null, avgBytes: msCount ? Math.round(bytesSum / msCount) : null };
}

export function percentile(values, p) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1)];
}

// Server Timing-style grade for the average response time.
export const speedGrade = (ms) => (ms == null ? null : ms < 300 ? 'fast' : ms < 1000 ? 'good' : ms < 2500 ? 'slow' : 'poor');

export const daysUntil = (iso, nowMs) => (iso ? Math.floor((Date.parse(iso) - nowMs) / 86400000) : null);

// ------------------------------------------------------------------ maintenance windows

export function cleanWindow(input = {}, current = null) {
  const w = current ? { ...current } : { notes: '', monitorIds: [] };
  if ('title' in input || !current) {
    w.title = text(input.title, 120);
    if (!w.title) throw new ValidationError('Give the maintenance a title.');
  }
  for (const k of ['startsAt', 'endsAt']) {
    if (k in input || !current) {
      const t = Date.parse(input[k]);
      if (Number.isNaN(t)) throw new ValidationError(k === 'startsAt' ? 'Pick when it starts.' : 'Pick when it ends.');
      w[k] = new Date(t).toISOString();
    }
  }
  if (w.endsAt <= w.startsAt) throw new ValidationError('It has to end after it starts.');
  if (Date.parse(w.endsAt) - Date.parse(w.startsAt) > 14 * 86400000) throw new ValidationError('Plan maintenance in windows of up to 14 days.');
  if ('monitorIds' in input) w.monitorIds = (Array.isArray(input.monitorIds) ? input.monitorIds : []).map((x) => text(x, 24)).filter(Boolean).slice(0, 100);
  if ('notes' in input) w.notes = longText(input.notes, 2000);
  return w;
}

export const covers = (w, monitorId, at) => at >= w.startsAt && at < w.endsAt && (!w.monitorIds?.length || w.monitorIds.includes(monitorId));

// ------------------------------------------------------------------ maintenance tasks

export function addPeriod(date, frequency) {
  const [y, m, d] = date.split('-').map(Number);
  if (frequency === 'weekly') return new Date(Date.UTC(y, m - 1, d + 7)).toISOString().slice(0, 10);
  const months = { monthly: 1, quarterly: 3, yearly: 12 }[frequency];
  if (!months) return null;
  const last = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate(); // 31 Jan + 1 month = 28/29 Feb
  return new Date(Date.UTC(y, m - 1 + months, Math.min(d, last))).toISOString().slice(0, 10);
}

export function cleanTask(input = {}, current = null) {
  const t = current ? { ...current } : { frequency: 'monthly', area: 'other', assignee: '', monitorId: '', notes: '' };
  if ('title' in input || !current) {
    t.title = text(input.title, 140);
    if (!t.title) throw new ValidationError('Say what needs doing.');
  }
  if ('frequency' in input) t.frequency = TASK_FREQUENCIES.includes(input.frequency) ? input.frequency : 'once';
  if ('area' in input) t.area = input.area in TASK_AREAS ? input.area : 'other';
  if ('due' in input || !current) {
    if (!isDate(input.due)) throw new ValidationError('Pick when it’s due.');
    t.due = input.due;
  }
  if ('assignee' in input) t.assignee = emails([input.assignee])[0] || '';
  if ('monitorId' in input) t.monitorId = text(input.monitorId, 24);
  if ('notes' in input) t.notes = longText(input.notes, 2000);
  return t;
}

// Marking a task done: recurring ones move to their next due date (past the done date), one-offs close.
export function completeTask(task, doneOn) {
  if (task.frequency === 'once') return { ...task, done: true, doneOn };
  let due = addPeriod(task.due, task.frequency); // done early still moves it on one period
  for (let i = 0; i < 400 && due <= doneOn; i += 1) due = addPeriod(due, task.frequency);
  return { ...task, due, lastDoneOn: doneOn };
}

export const taskState = (task, today) => (task.done ? 'done' : task.due < today ? 'overdue' : daysUntil(`${task.due}T00:00:00Z`, Date.parse(`${today}T00:00:00Z`)) <= 7 ? 'soon' : 'later');

// Suggested checklist for a new workspace, so the page isn't empty.
export function starterTasks(today) {
  const at = (n) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  return [
    { title: 'Check that backups ran and a restore works', area: 'backup', frequency: 'monthly', due: at(7) },
    { title: 'Update CMS, plugins, packages and server OS', area: 'updates', frequency: 'monthly', due: at(14) },
    { title: 'Review user accounts, passwords and API keys', area: 'security', frequency: 'quarterly', due: at(30) },
    { title: 'Run a speed test (PageSpeed / Lighthouse) and fix the worst issue', area: 'performance', frequency: 'monthly', due: at(10) },
    { title: 'Check broken links, forms and the contact page', area: 'content', frequency: 'monthly', due: at(21) },
    { title: 'Renew domain and hosting before they expire', area: 'renewal', frequency: 'yearly', due: at(60) },
  ];
}

// ------------------------------------------------------------------ settings

export function cleanSettings(input = {}, current = {}) {
  const s = { alertEmails: current.alertEmails || [], viewers: current.viewers || [], seeded: current.seeded || false };
  if ('alertEmails' in input) s.alertEmails = emails(input.alertEmails);
  if ('viewers' in input) s.viewers = emails(input.viewers);
  return s;
}
