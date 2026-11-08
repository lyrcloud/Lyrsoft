// Lyrsoft Performance & maintenance routes (#/w/<ws>/ops in the app), mounted on the work API (index.mjs).
// A workspace adds its websites, web apps and APIs as monitors. The one-minute tick checks each one
// on its interval from Lyrsoft's servers: status code, response time (first byte and full load), page
// size, an optional keyword, the SSL certificate's expiry and the domain's expiry (RDAP, daily).
// Confirmed failures open an incident and email the alert list; recovery closes it. Planned
// maintenance windows keep failures out of uptime and alerts, and a checklist of recurring
// maintenance tasks (backups, updates, renewals) rolls forward when done.
//
// Who: workspace owners and admins, plus the people named in its settings.
//
//   GET    /workspaces/{ws}/ops                               overview: monitors, incidents, windows, tasks
//   PATCH  /workspaces/{ws}/ops/settings                      { alertEmails, viewers }
//   POST   /workspaces/{ws}/ops/monitors                      add (checked straight away)
//   GET    /workspaces/{ws}/ops/monitors/{id}?range=24h|7d|30d|90d
//   PATCH  /workspaces/{ws}/ops/monitors/{id}
//   DELETE /workspaces/{ws}/ops/monitors/{id}
//   POST   /workspaces/{ws}/ops/monitors/{id}/check           check now
//   PATCH  /workspaces/{ws}/ops/incidents/{id}                { cause, notes }
//   POST   /workspaces/{ws}/ops/windows · PATCH/DELETE …/windows/{id}
//   POST   /workspaces/{ws}/ops/tasks · PATCH/DELETE …/tasks/{id} · POST …/tasks/{id}/done { note }
//
// Keys in the work table:
//   OPS#<ws>  SETTINGS                 alert emails, viewers
//   OPS#<ws>  MON#<id>                 monitor + its latest state (recent checks, SSL, domain, open incident)
//   OPS#<ws>  CHK#<id>#<at>            one check (expires after RAW_TTL_HOURS)
//   OPS#<ws>  DAY#<date>#<id>          the day's rollup for a monitor
//   OPS#<ws>  INC#<id>                 incident
//   OPS#<ws>  WIN#<id>                 planned maintenance window
//   OPS#<ws>  TASK#<id>, LOG#<at>#<id> maintenance task, and the log of work done
//   OPSMON    <ws>#<id>                what the tick reads: nextAt for every active monitor
import { lookup } from 'node:dns/promises';
import tls from 'node:tls';
import {
  afterCheck,
  cleanMonitor,
  cleanSettings,
  cleanTask,
  cleanWindow,
  completeTask,
  covers,
  EXPIRY_WARN_DAYS,
  INTERVALS,
  isPrivateAddress,
  judge,
  KINDS,
  percentile,
  RAW_TTL_HOURS,
  rollup,
  starterTasks,
  TASK_AREAS,
  TASK_FREQUENCIES,
  uptime,
} from './ops-model.mjs';
import { ID_RE } from './model.mjs';

const MAX_MONITORS = 25;
const MAX_BODY = 3 * 1024 * 1024;
const PER_TICK = 30;
const UA = 'LyrsoftMonitor/1.0 (+https://lyrsoft.com/app/)';

export function registerOpsRoutes(route, { db, HttpError, openWorkspace, now, newId, sendEmail, siteUrl = 'https://lyrsoft.com' }) {
  const { get, put, del, queryAll, putMany, deleteKeys } = db;
  const pk = (ws) => `OPS#${ws}`;
  const strip = ({ PK, SK, GSI1PK, GSI1SK, expiresAt, ...rest }) => rest;
  const prefix = (PK, sk) => queryAll({ KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)', ExpressionAttributeValues: { ':pk': PK, ':sk': sk } });
  const between = (PK, a, b) => queryAll({ KeyConditionExpression: 'PK = :pk AND SK BETWEEN :a AND :b', ExpressionAttributeValues: { ':pk': PK, ':a': a, ':b': b } });
  const today = () => now().slice(0, 10);
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

  async function access(me, ws) {
    const { workspace, role } = await openWorkspace(me, ws, 'view');
    const settings = cleanSettings({}, (await get(pk(ws), 'SETTINGS')) || {});
    const admin = ['owner', 'admin'].includes(role);
    if (!admin && !settings.viewers.includes(me.email)) throw new HttpError(403, 'Performance & maintenance is open to workspace owners and admins, and to people they add in its settings.');
    return { workspace, admin, settings };
  }

  // ---------------------------------------------------------------- checking

  async function assertPublicHost(host) {
    const bare = host.replace(/^\[|\]$/g, '');
    const addresses = /^[\d.]+$/.test(bare) || bare.includes(':') ? [{ address: bare }] : await lookup(bare, { all: true });
    if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) throw new Error('Address points to a private network');
  }

  const reason = (error) => {
    const code = error?.cause?.code || error?.code || '';
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'Timed out';
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'Domain not found (DNS)';
    if (code === 'ECONNREFUSED') return 'Connection refused';
    if (code === 'ECONNRESET') return 'Connection reset';
    if (/CERT|SSL|TLS/i.test(code)) return `SSL problem (${code})`;
    return String(error?.message || 'Request failed').slice(0, 160);
  };

  // One HTTP check. Redirects aren't followed, so a 3xx counts as the answer (and can't lead inside).
  async function probe(m) {
    const started = Date.now();
    const out = { code: 0, ms: 0, ttfb: 0, bytes: 0, error: '', body: null };
    try {
      await assertPublicHost(new URL(m.url).hostname);
      const res = await fetch(m.url, { method: m.method, redirect: 'manual', signal: AbortSignal.timeout(m.timeoutMs), headers: { 'user-agent': UA, accept: '*/*', 'cache-control': 'no-cache' } });
      out.ttfb = Date.now() - started;
      out.code = res.status;
      out.location = res.headers.get('location') || '';
      out.server = (res.headers.get('server') || '').slice(0, 60);
      if (m.method === 'GET' && res.body) {
        const reader = res.body.getReader();
        const chunks = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          out.bytes += value.length;
          if (m.keyword && out.bytes <= MAX_BODY) chunks.push(value);
          if (out.bytes > MAX_BODY * 4) {
            await reader.cancel();
            break;
          }
        }
        if (m.keyword) out.body = Buffer.concat(chunks).toString('utf8');
      } else {
        out.bytes = Number(res.headers.get('content-length')) || 0;
        await res.body?.cancel();
      }
    } catch (error) {
      out.error = reason(error);
    }
    out.ms = Date.now() - started;
    return out;
  }

  function certificate(url) {
    const { hostname, port } = new URL(url);
    return new Promise((resolve) => {
      const socket = tls.connect({ host: hostname, port: Number(port) || 443, servername: hostname, timeout: 8000, rejectUnauthorized: false }, () => {
        const c = socket.getPeerCertificate();
        resolve(c?.valid_to ? { validTo: new Date(c.valid_to).toISOString(), issuer: String(c.issuer?.O || c.issuer?.CN || '').slice(0, 80), trusted: socket.authorized, error: socket.authorized ? '' : String(socket.authorizationError || '') } : null);
        socket.end();
      });
      socket.on('timeout', () => (socket.destroy(), resolve(null)));
      socket.on('error', () => resolve(null));
    });
  }

  // Registration expiry over RDAP; walks up from the host name until a registry answers.
  async function domainExpiry(url) {
    const labels = new URL(url).hostname.split('.');
    for (let i = Math.max(0, labels.length - 4); i <= labels.length - 2; i += 1) {
      const name = labels.slice(i).join('.');
      try {
        const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(6000), headers: { accept: 'application/rdap+json', 'user-agent': UA } });
        if (!res.ok) continue;
        const data = await res.json();
        const ev = (data.events || []).find((e) => e.eventAction === 'expiration');
        return { name, expiresAt: ev?.eventDate ? new Date(ev.eventDate).toISOString() : null, registrar: String((data.entities || []).find((e) => e.roles?.includes('registrar'))?.vcardArray?.[1]?.find((v) => v[0] === 'fn')?.[3] || '').slice(0, 80) };
      } catch {
        // try the next level up
      }
    }
    return { name: labels.slice(-2).join('.'), expiresAt: null, registrar: '' };
  }

  async function alert(settings, subject, lines) {
    if (!sendEmail || !settings.alertEmails.length) return;
    const textBody = `${lines.join('\n')}\n\n— Lyrsoft Performance & maintenance`;
    const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5">${lines.map((l) => `<p>${String(l).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])}</p>`).join('')}<p style="color:#667">— Lyrsoft Performance &amp; maintenance</p></div>`;
    await Promise.all(settings.alertEmails.map((to) => sendEmail(to, { subject, text: textBody, html }).catch((e) => console.error('ops alert', to, e))));
  }

  const scheduleRow = (ws, m, nextAt) => ({ PK: 'OPSMON', SK: `${ws}#${m.id}`, ws, id: m.id, nextAt });

  // Checks a monitor, stores the result and handles incidents, SSL and domain expiry.
  async function runCheck(ws, monitorRow, { manual = false } = {}) {
    let m = strip(monitorRow);
    const at = now();
    const [settings, windows] = await Promise.all([get(pk(ws), 'SETTINGS').then((s) => cleanSettings({}, s || {})), prefix(pk(ws), 'WIN#')]);
    const maintenance = windows.some((w) => covers(w, m.id, at));
    const raw = await probe(m);
    const verdict = judge(m, raw, maintenance);
    const result = { at, ms: raw.ms, ttfb: raw.ttfb, bytes: raw.bytes, code: raw.code, status: verdict.status, problem: verdict.problem, location: raw.location || '' };
    const { monitor, open, close } = afterCheck(m, result, at);
    m = monitor;
    const writes = [{ PK: pk(ws), SK: `CHK#${m.id}#${at}`, ...result, expiresAt: Math.floor(Date.now() / 1000) + RAW_TTL_HOURS * 3600 }];
    const dayKey = `DAY#${at.slice(0, 10)}#${m.id}`;
    const day = await get(pk(ws), dayKey);
    writes.push({ PK: pk(ws), SK: dayKey, monitorId: m.id, date: at.slice(0, 10), ...rollup(day ? strip(day) : {}, result) });
    if (open) {
      const id = newId();
      m.incident = id;
      writes.push({ PK: pk(ws), SK: `INC#${id}`, id, monitorId: m.id, monitorName: m.name, url: m.url, startedAt: m.recent.at(-m.fails)?.at || at, resolvedAt: null, problem: verdict.problem, cause: '', notes: '' });
      await alert(settings, `🔴 Down: ${m.name}`, [`${m.name} (${m.url}) is down.`, `Problem: ${verdict.problem}`, `Since: ${at.replace('T', ' ').slice(0, 16)} UTC`, `Open it: ${siteUrl}/app/#/w/${ws}/ops/monitor/${m.id}`]);
    }
    if (close) {
      const inc = await get(pk(ws), `INC#${m.incident}`);
      if (inc) {
        const mins = Math.max(1, Math.round((Date.parse(at) - Date.parse(inc.startedAt)) / 60000));
        writes.push({ ...inc, resolvedAt: at, minutes: mins });
        await alert(settings, `✅ Back up: ${m.name}`, [`${m.name} (${m.url}) is back up after about ${mins} minute${mins === 1 ? '' : 's'}.`, `Response time now: ${raw.ms} ms`]);
      }
      delete m.incident;
    }
    // SSL and domain: once a day (or when checked by hand), and a warning email once per expiry date.
    const stale = (x) => !x?.checkedAt || Date.now() - Date.parse(x.checkedAt) > 86400000;
    if (m.url.startsWith('https:') && m.checkSsl && (manual || stale(m.ssl))) {
      const cert = await certificate(m.url);
      m.ssl = { ...(cert || { validTo: null, issuer: '', trusted: false, error: 'Couldn’t read the certificate' }), checkedAt: at, warned: m.ssl?.validTo === cert?.validTo ? m.ssl?.warned : false };
      const left = m.ssl.validTo ? Math.floor((Date.parse(m.ssl.validTo) - Date.now()) / 86400000) : null;
      if (left != null && left <= EXPIRY_WARN_DAYS && !m.ssl.warned) {
        m.ssl.warned = true;
        await alert(settings, `⚠ SSL certificate expires in ${left} days: ${m.name}`, [`The SSL certificate for ${new URL(m.url).hostname} expires on ${m.ssl.validTo.slice(0, 10)} (${left} days).`, 'Renew it before then, or visitors will see a security warning.']);
      }
    }
    if (m.checkDomain && (manual ? stale(m.domain) || !m.domain?.expiresAt : stale(m.domain))) {
      const dom = await domainExpiry(m.url);
      m.domain = { ...dom, checkedAt: at, warned: m.domain?.expiresAt === dom.expiresAt ? m.domain?.warned : false };
      const left = dom.expiresAt ? Math.floor((Date.parse(dom.expiresAt) - Date.now()) / 86400000) : null;
      if (left != null && left <= EXPIRY_WARN_DAYS * 2 && !m.domain.warned) {
        m.domain.warned = true;
        await alert(settings, `⚠ Domain expires in ${left} days: ${dom.name}`, [`The domain ${dom.name} expires on ${dom.expiresAt.slice(0, 10)} (${left} days).`, dom.registrar ? `Registrar: ${dom.registrar}` : '', 'Renew it so the site and email keep working.'].filter(Boolean));
      }
    }
    writes.push({ PK: pk(ws), SK: `MON#${m.id}`, ...m });
    if (!m.paused) writes.push(scheduleRow(ws, m, new Date(Date.now() + m.interval * 60000 - 5000).toISOString()));
    await putMany(writes);
    return { monitor: m, check: result };
  }

  // The one-minute tick (index.mjs): every monitor whose time has come, in parallel.
  async function tick() {
    const all = await queryAll({ KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': 'OPSMON' } });
    const due = all.filter((r) => r.nextAt <= now()).sort((a, b) => a.nextAt.localeCompare(b.nextAt)).slice(0, PER_TICK);
    await Promise.all(
      due.map(async (r) => {
        try {
          const row = await get(pk(r.ws), `MON#${r.id}`);
          if (!row || row.paused) return del('OPSMON', r.SK);
          await runCheck(r.ws, row);
        } catch (error) {
          console.error('ops tick', r.SK, error);
          await put({ ...r, nextAt: new Date(Date.now() + 5 * 60000).toISOString() }).catch(() => {});
        }
      }),
    );
  }

  // ---------------------------------------------------------------- reading

  const monitorOut = (m, days) => {
    const mine = (n) => days.filter((d) => d.monitorId === m.id && d.date >= daysAgo(n - 1));
    const today7 = uptime(mine(7));
    return {
      ...m,
      uptimeToday: uptime(mine(1)).uptime,
      uptime7d: today7.uptime,
      uptime30d: uptime(mine(30)).uptime,
      avgMs7d: today7.avgMs,
      avgBytes7d: today7.avgBytes,
      p95Recent: percentile((m.recent || []).filter((c) => c.s === 'up' || c.s === 'slow').map((c) => c.ms), 95),
    };
  };

  async function seed(ws, settings, by) {
    if (settings.seeded) return;
    const tasks = starterTasks(today()).map((t) => {
      const id = newId();
      return { PK: pk(ws), SK: `TASK#${id}`, id, ...cleanTask(t), createdAt: now(), createdBy: 'lyrsoft' };
    });
    await putMany([...tasks, { PK: pk(ws), SK: 'SETTINGS', ...settings, seeded: true, updatedAt: now(), updatedBy: by }]);
  }

  route('GET', '/workspaces/{ws}/ops', async (me, { ws }) => {
    const a = await access(me, ws);
    if (a.admin) await seed(ws, a.settings, me.email);
    const [monitors, days, incidents, windows, tasks, log] = await Promise.all([
      prefix(pk(ws), 'MON#'),
      between(pk(ws), `DAY#${daysAgo(29)}`, `DAY#${today()}~`),
      prefix(pk(ws), 'INC#'),
      prefix(pk(ws), 'WIN#'),
      prefix(pk(ws), 'TASK#'),
      between(pk(ws), `LOG#${daysAgo(180)}`, 'LOG#~'),
    ]);
    const at = now();
    return {
      workspace: { id: ws, name: a.workspace.name },
      admin: a.admin,
      settings: { alertEmails: a.settings.alertEmails, viewers: a.settings.viewers },
      now: at,
      today: today(),
      kinds: KINDS,
      intervals: INTERVALS,
      frequencies: TASK_FREQUENCIES,
      areas: TASK_AREAS,
      expiryWarnDays: EXPIRY_WARN_DAYS,
      monitors: monitors.map(strip).map((m) => monitorOut(m, days)).sort((x, y) => x.name.localeCompare(y.name)),
      incidents: incidents.map(strip).sort((x, y) => y.startedAt.localeCompare(x.startedAt)).slice(0, 100),
      windows: windows.map(strip).filter((w) => w.endsAt > daysAgo(60)).sort((x, y) => y.startsAt.localeCompare(x.startsAt)),
      tasks: tasks.map(strip).sort((x, y) => (x.done === y.done ? x.due.localeCompare(y.due) : x.done ? 1 : -1)),
      log: log.map(strip).sort((x, y) => y.at.localeCompare(x.at)).slice(0, 60),
    };
  });

  route('GET', '/workspaces/{ws}/ops/monitors/{id}', async (me, { ws, id }, _b, query) => {
    await access(me, ws);
    const m = await openMonitor(ws, id);
    const range = ['24h', '7d', '30d', '90d'].includes(query.get('range')) ? query.get('range') : '24h';
    const n = { '24h': 2, '7d': 7, '30d': 30, '90d': 90 }[range];
    const [days, checks, incidents] = await Promise.all([
      between(pk(ws), `DAY#${daysAgo(n - 1)}`, `DAY#${today()}~`).then((rows) => rows.filter((d) => d.monitorId === id).map(strip)),
      range === '24h' ? between(pk(ws), `CHK#${id}#${new Date(Date.now() - 86400000).toISOString()}`, `CHK#${id}#~`).then((rows) => rows.map(strip)) : [],
      prefix(pk(ws), 'INC#').then((rows) => rows.filter((r) => r.monitorId === id).map(strip).sort((x, y) => y.startedAt.localeCompare(x.startedAt)).slice(0, 50)),
    ]);
    const good = checks.filter((c) => c.status === 'up' || c.status === 'slow');
    return {
      monitor: monitorOut(m, days),
      range,
      days: days.sort((x, y) => x.date.localeCompare(y.date)),
      checks: checks.sort((x, y) => x.at.localeCompare(y.at)),
      stats: { ...uptime(range === '24h' ? [checks.reduce((d, c) => rollup(d, c), {})] : days), p50: percentile(good.map((c) => c.ms), 50), p95: percentile(good.map((c) => c.ms), 95), ttfb: good.length ? Math.round(good.reduce((s, c) => s + (c.ttfb || 0), 0) / good.length) : null, incidents: incidents.filter((i) => i.startedAt >= new Date(Date.now() - n * 86400000).toISOString()).length },
      incidents,
    };
  });

  // ---------------------------------------------------------------- monitors

  async function openMonitor(ws, id) {
    const row = ID_RE.test(id) ? await get(pk(ws), `MON#${id}`) : null;
    if (!row) throw new HttpError(404, 'Monitor not found.');
    return strip(row);
  }
  const requireAdmin = (a) => {
    if (!a.admin) throw new HttpError(403, 'Only workspace owners and admins can change monitors.');
  };

  route('POST', '/workspaces/{ws}/ops/monitors', async (me, { ws }, body) => {
    const a = await access(me, ws);
    requireAdmin(a);
    if ((await prefix(pk(ws), 'MON#')).length >= MAX_MONITORS) throw new HttpError(409, `A workspace can have up to ${MAX_MONITORS} monitors.`);
    const m = { id: newId(), ...cleanMonitor(body), status: 'new', recent: [], fails: 0, createdAt: now(), createdBy: me.email };
    await put({ PK: pk(ws), SK: `MON#${m.id}`, ...m });
    const { monitor } = await runCheck(ws, m, { manual: true });
    return [201, { monitor }];
  });

  route('PATCH', '/workspaces/{ws}/ops/monitors/{id}', async (me, { ws, id }, body) => {
    const a = await access(me, ws);
    requireAdmin(a);
    const current = await openMonitor(ws, id);
    const m = { ...cleanMonitor(body, current), id, updatedAt: now(), updatedBy: me.email };
    if (m.url !== current.url) Object.assign(m, { ssl: null, domain: null });
    if (m.paused) m.status = 'paused';
    else if (current.paused) m.status = 'new';
    await put({ PK: pk(ws), SK: `MON#${id}`, ...m });
    if (m.paused) await del('OPSMON', `${ws}#${id}`);
    else await put(scheduleRow(ws, m, now()));
    return { monitor: m };
  });

  route('DELETE', '/workspaces/{ws}/ops/monitors/{id}', async (me, { ws, id }) => {
    const a = await access(me, ws);
    requireAdmin(a);
    await openMonitor(ws, id);
    const checks = await prefix(pk(ws), `CHK#${id}#`);
    await deleteKeys([{ PK: pk(ws), SK: `MON#${id}` }, { PK: 'OPSMON', SK: `${ws}#${id}` }, ...checks.map((c) => ({ PK: c.PK, SK: c.SK }))]);
    return { ok: true };
  });

  route('POST', '/workspaces/{ws}/ops/monitors/{id}/check', async (me, { ws, id }) => {
    await access(me, ws);
    const m = await openMonitor(ws, id);
    return runCheck(ws, m, { manual: true });
  });

  route('PATCH', '/workspaces/{ws}/ops/incidents/{id}', async (me, { ws, id }, body) => {
    await access(me, ws);
    const row = ID_RE.test(id) ? await get(pk(ws), `INC#${id}`) : null;
    if (!row) throw new HttpError(404, 'Incident not found.');
    const next = { ...row, cause: String(body.cause ?? row.cause ?? '').trim().slice(0, 300), notes: String(body.notes ?? row.notes ?? '').trim().slice(0, 4000), updatedAt: now(), updatedBy: me.email };
    await put(next);
    return { incident: strip(next) };
  });

  route('PATCH', '/workspaces/{ws}/ops/settings', async (me, { ws }, body) => {
    const a = await access(me, ws);
    if ('viewers' in body && !a.admin) throw new HttpError(403, 'Only workspace owners and admins choose who can see this.');
    const settings = cleanSettings(body, a.settings);
    await put({ PK: pk(ws), SK: 'SETTINGS', ...settings, updatedAt: now(), updatedBy: me.email });
    return { settings };
  });

  // ---------------------------------------------------------------- maintenance windows

  async function openRow(ws, kind, id, label) {
    const row = ID_RE.test(id) ? await get(pk(ws), `${kind}#${id}`) : null;
    if (!row) throw new HttpError(404, `${label} not found.`);
    return strip(row);
  }

  route('POST', '/workspaces/{ws}/ops/windows', async (me, { ws }, body) => {
    await access(me, ws);
    const w = { id: newId(), ...cleanWindow(body), createdAt: now(), createdBy: me.email };
    await put({ PK: pk(ws), SK: `WIN#${w.id}`, ...w });
    return [201, { window: w }];
  });
  route('PATCH', '/workspaces/{ws}/ops/windows/{id}', async (me, { ws, id }, body) => {
    await access(me, ws);
    const w = { ...cleanWindow(body, await openRow(ws, 'WIN', id, 'Maintenance window')), id, updatedAt: now() };
    await put({ PK: pk(ws), SK: `WIN#${id}`, ...w });
    return { window: w };
  });
  route('DELETE', '/workspaces/{ws}/ops/windows/{id}', async (me, { ws, id }) => {
    await access(me, ws);
    await openRow(ws, 'WIN', id, 'Maintenance window');
    await del(pk(ws), `WIN#${id}`);
    return { ok: true };
  });

  // ---------------------------------------------------------------- maintenance tasks

  route('POST', '/workspaces/{ws}/ops/tasks', async (me, { ws }, body) => {
    await access(me, ws);
    const t = { id: newId(), ...cleanTask(body), createdAt: now(), createdBy: me.email };
    await put({ PK: pk(ws), SK: `TASK#${t.id}`, ...t });
    return [201, { task: t }];
  });
  route('PATCH', '/workspaces/{ws}/ops/tasks/{id}', async (me, { ws, id }, body) => {
    await access(me, ws);
    const current = await openRow(ws, 'TASK', id, 'Task');
    const t = { ...cleanTask(body, current), id, updatedAt: now() };
    if (body.reopen) delete t.done;
    await put({ PK: pk(ws), SK: `TASK#${id}`, ...t });
    return { task: t };
  });
  route('DELETE', '/workspaces/{ws}/ops/tasks/{id}', async (me, { ws, id }) => {
    await access(me, ws);
    await openRow(ws, 'TASK', id, 'Task');
    await del(pk(ws), `TASK#${id}`);
    return { ok: true };
  });
  route('POST', '/workspaces/{ws}/ops/tasks/{id}/done', async (me, { ws, id }, body) => {
    await access(me, ws);
    const current = await openRow(ws, 'TASK', id, 'Task');
    const t = { ...completeTask(current, today()), updatedAt: now() };
    const at = now();
    await putMany([
      { PK: pk(ws), SK: `TASK#${id}`, ...t },
      { PK: pk(ws), SK: `LOG#${at}#${newId()}`, at, taskId: id, title: current.title, area: current.area, monitorId: current.monitorId || '', by: me.email, byName: me.name || '', note: String(body.note || '').trim().slice(0, 1000) },
    ]);
    return { task: t };
  });

  return { tick };
}
