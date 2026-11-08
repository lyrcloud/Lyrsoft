// Lyrsoft Ads & budget routes (#/w/<ws>/growth in the app), mounted on the work API (index.mjs).
// Each workspace connects its marketing platforms (growth-connectors.mjs), plans campaigns across
// channels, sets a monthly budget per channel and sees budget vs actual spend and results.
// Workspace owners and admins connect platforms and set budgets; members plan and add spend by hand.
//
//   GET    /workspaces/{ws}/growth?month=                       dashboard: budget vs actual, campaigns, plans, connections
//   PATCH  /workspaces/{ws}/growth/settings                     { currency }
//   POST   /workspaces/{ws}/growth/budget/{month}               { channels: { facebook: 50000, … }, note }
//   POST   /workspaces/{ws}/growth/plans                        new plan
//   PATCH  /workspaces/{ws}/growth/plans/{id}                   edit
//   DELETE /workspaces/{ws}/growth/plans/{id}
//   GET    /workspaces/{ws}/growth/spend?month=                 every spend row of the month
//   POST   /workspaces/{ws}/growth/spend                        add spend by hand
//   POST   /workspaces/{ws}/growth/spend/delete                 { key } remove a hand-typed row
//   POST   /workspaces/{ws}/growth/connections/{platform}       connect or update (tests it first)
//   POST   /workspaces/{ws}/growth/connections/{platform}/sync  pull the last { days } (default 30)
//   POST   /workspaces/{ws}/growth/connections/{platform}/test-message   WhatsApp: { to }
//   DELETE /workspaces/{ws}/growth/connections/{platform}
//
// Connected platforms also sync on their own every 6 hours (the one-minute marketing tick calls tick()).
//
// Keys in the work table:
//   GRO#<ws>  SETTINGS                       currency
//   GRO#<ws>  BUD#<yyyy-mm>                  a month's budget per channel
//   GRO#<ws>  PLAN#<id>                      a campaign plan
//   GRO#<ws>  CONN#<platform>                a connection: public config, sealed secrets, status, stats
//   GRO#<ws>  SPEND#<date>#<channel>#<hash>  a day's spend and results for one campaign
//   GROWCH    <ws>#<platform>                index of connections, for the background sync
import { CONNECTORS, PlatformError } from './growth-connectors.mjs';
import {
  campaignTable,
  CHANNELS,
  cleanBudget,
  cleanConnection,
  cleanPlan,
  cleanSpend,
  isMonth,
  MANUAL_CHANNELS,
  monthReport,
  OBJECTIVES,
  PLAN_STATUSES,
  planProgress,
  PLATFORMS,
  PLANS_MAX,
  seal,
  secretHints,
  spendKey,
  unseal,
} from './growth-model.mjs';
import { ID_RE, ValidationError } from './model.mjs';

const SYNC_EVERY_MS = 6 * 3600 * 1000;
const DEFAULT_DAYS = 30;

export function registerGrowthRoutes(route, { db, HttpError, openWorkspace, now, newId, getAppSecret, fetch = globalThis.fetch }) {
  const { get, put, del, queryAll, putMany, deleteKeys } = db;
  const pk = (ws) => `GRO#${ws}`;
  const prefix = (PK, sk) => queryAll({ KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)', ExpressionAttributeValues: { ':pk': PK, ':sk': sk } });
  const strip = ({ PK, SK, ...rest }) => rest;
  const today = () => now().slice(0, 10);
  const minusDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);

  async function access(me, ws) {
    const { workspace, role } = await openWorkspace(me, ws, 'view');
    return { workspace, role, manage: ['owner', 'admin'].includes(role) };
  }
  const requireManage = (a) => {
    if (!a.manage) throw new HttpError(403, 'Only workspace owners and admins can connect platforms and set budgets.');
  };
  const platformOf = (p) => {
    if (!PLATFORMS[p]) throw new HttpError(404, 'Unknown platform.');
    return p;
  };

  const connectionOut = (c) => ({
    platform: c.platform,
    config: c.config,
    hints: c.hints || {},
    status: c.status,
    account: c.account || null,
    stats: c.stats || {},
    error: c.error || null,
    connectedAt: c.connectedAt,
    connectedBy: c.connectedBy,
    lastSyncAt: c.lastSyncAt || null,
    lastSyncRows: c.lastSyncRows ?? null,
  });

  // ---------------------------------------------------------------- dashboard

  route('GET', '/workspaces/{ws}/growth', async (me, { ws }, _b, query) => {
    const a = await access(me, ws);
    const month = isMonth(query.get('month')) ? query.get('month') : today().slice(0, 7);
    const [settings, budget, plans, connections, rows] = await Promise.all([
      get(pk(ws), 'SETTINGS'),
      get(pk(ws), `BUD#${month}`),
      prefix(pk(ws), 'PLAN#'),
      prefix(pk(ws), 'CONN#'),
      prefix(pk(ws), `SPEND#${month}`),
    ]);
    // Plans reach past the month, so their progress uses all the spend in their dates.
    const planRows = plans.length ? await spendFor(ws, plans) : [];
    return {
      workspace: { id: ws, name: a.workspace.name },
      manage: a.manage,
      currency: settings?.currency || 'BDT',
      month,
      today: today(),
      budget: budget ? strip(budget) : null,
      report: monthReport({ month, budget, rows, today: today() }),
      campaigns: campaignTable(rows).slice(0, 100),
      plans: plans.map(strip).map((p) => ({ ...p, progress: planProgress(p, planRows) })).sort((x, y) => (x.start || '9').localeCompare(y.start || '9')),
      connections: connections.map(strip).map(connectionOut),
      catalog: {
        platforms: Object.fromEntries(Object.entries(PLATFORMS).map(([k, p]) => [k, { ...p, fields: p.fields }])),
        channels: CHANNELS,
        manual: Object.keys(MANUAL_CHANNELS),
        objectives: OBJECTIVES,
        statuses: PLAN_STATUSES,
      },
    };
  });

  async function spendFor(ws, plans) {
    const starts = plans.map((p) => p.start).filter(Boolean).sort();
    const from = (starts[0] || minusDays(today(), 365)).slice(0, 7);
    const months = [];
    for (let m = from; m <= today().slice(0, 7) && months.length < 24; ) {
      months.push(m);
      const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 1));
      m = d.toISOString().slice(0, 7);
    }
    return (await Promise.all(months.map((m) => prefix(pk(ws), `SPEND#${m}`)))).flat();
  }

  route('PATCH', '/workspaces/{ws}/growth/settings', async (me, { ws }, body) => {
    const a = await access(me, ws);
    requireManage(a);
    const currency = String(body.currency || '').trim().toUpperCase().slice(0, 8) || 'BDT';
    await put({ PK: pk(ws), SK: 'SETTINGS', currency, updatedAt: now(), updatedBy: me.email });
    return { currency };
  });

  route('POST', '/workspaces/{ws}/growth/budget/{month}', async (me, { ws, month }, body) => {
    const a = await access(me, ws);
    requireManage(a);
    if (!isMonth(month)) throw new HttpError(400, 'Pick a month.');
    const budget = { month, ...cleanBudget(body), updatedAt: now(), updatedBy: me.email };
    await put({ PK: pk(ws), SK: `BUD#${month}`, ...budget });
    return { budget };
  });

  // ---------------------------------------------------------------- plans

  route('POST', '/workspaces/{ws}/growth/plans', async (me, { ws }, body) => {
    await access(me, ws);
    if ((await prefix(pk(ws), 'PLAN#')).length >= PLANS_MAX) throw new HttpError(409, `You can have up to ${PLANS_MAX} plans.`);
    const at = now();
    const plan = { id: newId(), ...cleanPlan(body), createdAt: at, updatedAt: at, createdBy: me.email };
    await put({ PK: pk(ws), SK: `PLAN#${plan.id}`, ...plan });
    return [201, { plan }];
  });

  async function openPlan(ws, id) {
    const row = ID_RE.test(id) ? await get(pk(ws), `PLAN#${id}`) : null;
    if (!row) throw new HttpError(404, 'Plan not found.');
    return strip(row);
  }

  route('PATCH', '/workspaces/{ws}/growth/plans/{id}', async (me, { ws, id }, body) => {
    await access(me, ws);
    const plan = { ...cleanPlan(body, await openPlan(ws, id)), id, updatedAt: now() };
    await put({ PK: pk(ws), SK: `PLAN#${id}`, ...plan });
    return { plan };
  });

  route('DELETE', '/workspaces/{ws}/growth/plans/{id}', async (me, { ws, id }) => {
    await access(me, ws);
    await openPlan(ws, id);
    await del(pk(ws), `PLAN#${id}`);
    return { ok: true };
  });

  // ---------------------------------------------------------------- spend

  route('GET', '/workspaces/{ws}/growth/spend', async (me, { ws }, _b, query) => {
    await access(me, ws);
    const month = isMonth(query.get('month')) ? query.get('month') : today().slice(0, 7);
    const rows = (await prefix(pk(ws), `SPEND#${month}`)).map((r) => ({ key: r.SK, ...strip(r) }));
    return { month, rows: rows.sort((x, y) => y.date.localeCompare(x.date) || y.spend - x.spend) };
  });

  route('POST', '/workspaces/{ws}/growth/spend', async (me, { ws }, body) => {
    await access(me, ws);
    const row = { ...cleanSpend(body), by: me.email, at: now() };
    if (!row.spend && !row.impressions && !row.clicks && !row.results) throw new ValidationError('Type the amount spent or some results.');
    row.campaignId = row.campaignId || newId(); // each hand-typed row stands alone
    const key = spendKey(row);
    await put({ PK: pk(ws), SK: key, ...row });
    return [201, { row: { key, ...row } }];
  });

  route('POST', '/workspaces/{ws}/growth/spend/delete', async (me, { ws }, body) => {
    await access(me, ws);
    const key = String(body.key || '');
    const row = key.startsWith('SPEND#') ? await get(pk(ws), key) : null;
    if (!row) throw new HttpError(404, 'Row not found.');
    if (row.source !== 'manual') throw new HttpError(409, 'Rows from a connected platform come back on the next sync. Change them on the platform.');
    await del(pk(ws), key);
    return { ok: true };
  });

  // ---------------------------------------------------------------- connections

  async function ctxFor(row) {
    const secrets = unseal(await getAppSecret(), row.sealed);
    return { config: row.config, secrets, fetch };
  }

  async function sync(ws, platform, days = DEFAULT_DAYS) {
    const row = await get(pk(ws), `CONN#${platform}`);
    if (!row) throw new HttpError(404, 'That platform isn’t connected.');
    const until = today();
    const since = minusDays(until, Math.min(90, Math.max(1, days)) - 1);
    let result;
    try {
      result = await CONNECTORS[platform].sync(await ctxFor(row), { since, until });
    } catch (error) {
      if (!(error instanceof PlatformError)) console.error('growth sync', platform, error);
      const failed = { ...row, status: 'error', error: error instanceof PlatformError ? error.message : 'Sync failed. Try again later.', lastSyncAt: now() };
      await put(failed);
      await put({ PK: 'GROWCH', SK: `${ws}#${platform}`, ws, platform, lastSyncAt: failed.lastSyncAt });
      return connectionOut(strip(failed));
    }
    const rows = [];
    for (const raw of result.rows) {
      try {
        const clean = cleanSpend(raw, { source: platform });
        rows.push({ PK: pk(ws), SK: spendKey(clean), ...clean, at: now() });
      } catch {
        /* a row the platform sent without a date or with an unknown channel */
      }
    }
    await putMany(rows);
    const next = { ...row, status: 'connected', error: null, stats: { ...(row.stats || {}), ...result.stats }, lastSyncAt: now(), lastSyncRows: rows.length };
    await put(next);
    await put({ PK: 'GROWCH', SK: `${ws}#${platform}`, ws, platform, lastSyncAt: next.lastSyncAt });
    return connectionOut(strip(next));
  }

  route('POST', '/workspaces/{ws}/growth/connections/{platform}', async (me, { ws, platform }, body) => {
    const a = await access(me, ws);
    requireManage(a);
    platformOf(platform);
    const existing = await get(pk(ws), `CONN#${platform}`);
    const appSecret = await getAppSecret();
    const current = existing ? { config: existing.config, secrets: unseal(appSecret, existing.sealed) } : undefined;
    const { config, secrets } = cleanConnection(platform, body, current);
    let account;
    try {
      account = await CONNECTORS[platform].test({ config, secrets, fetch });
    } catch (error) {
      if (error instanceof PlatformError) throw new HttpError(400, `Couldn’t connect. ${error.message}`);
      throw error;
    }
    const at = now();
    const row = {
      PK: pk(ws),
      SK: `CONN#${platform}`,
      platform,
      config,
      sealed: seal(appSecret, secrets),
      hints: secretHints(platform, secrets),
      status: 'connected',
      account,
      stats: existing?.stats || {},
      error: null,
      connectedAt: existing?.connectedAt || at,
      connectedBy: existing?.connectedBy || me.email,
      updatedAt: at,
    };
    await put(row);
    await put({ PK: 'GROWCH', SK: `${ws}#${platform}`, ws, platform, lastSyncAt: existing?.lastSyncAt || '' });
    // Pull data straight away so the dashboard fills in.
    return { connection: await sync(ws, platform) };
  });

  route('POST', '/workspaces/{ws}/growth/connections/{platform}/sync', async (me, { ws, platform }, body) => {
    await access(me, ws);
    platformOf(platform);
    return { connection: await sync(ws, platform, Number(body.days) || DEFAULT_DAYS) };
  });

  route('POST', '/workspaces/{ws}/growth/connections/{platform}/test-message', async (me, { ws, platform }, body) => {
    const a = await access(me, ws);
    requireManage(a);
    if (platform !== 'whatsapp') throw new HttpError(404, 'Only WhatsApp sends test messages.');
    const row = await get(pk(ws), 'CONN#whatsapp');
    if (!row) throw new HttpError(404, 'WhatsApp isn’t connected.');
    try {
      return await CONNECTORS.whatsapp.sendTest(await ctxFor(row), { to: body.to, template: String(body.template || 'hello_world').slice(0, 100), language: String(body.language || 'en_US').slice(0, 10) });
    } catch (error) {
      if (error instanceof PlatformError) throw new HttpError(400, error.message);
      throw error;
    }
  });

  route('DELETE', '/workspaces/{ws}/growth/connections/{platform}', async (me, { ws, platform }) => {
    const a = await access(me, ws);
    requireManage(a);
    platformOf(platform);
    await deleteKeys([{ PK: pk(ws), SK: `CONN#${platform}` }, { PK: 'GROWCH', SK: `${ws}#${platform}` }]);
    return { ok: true };
  });

  // Background sync: every minute the marketing tick asks; connections synced over 6 hours ago are
  // refreshed, one per run so the Lambda stays well inside its time limit.
  async function tick() {
    const all = await queryAll({ KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': 'GROWCH' } });
    const due = all.filter((r) => !r.lastSyncAt || Date.now() - Date.parse(r.lastSyncAt) > SYNC_EVERY_MS).slice(0, 1);
    for (const r of due) {
      try {
        await sync(r.ws, r.platform, 7);
      } catch (error) {
        console.error('growth tick', r.SK, error);
        if (error.status === 404) await del('GROWCH', r.SK);
      }
    }
  }

  return { tick };
}
