// Lyrsoft Ad revenue routes (#/w/<ws>/ads in the app), mounted on the work API (index.mjs). Each
// workspace connects its own Google AdSense (websites) and AdMob (apps) accounts with its own Google
// OAuth client (ads-connectors.mjs) and sees earnings per day, site and app. Workspace owners and
// admins connect and disconnect; every member can view and sync.
//
//   GET    /workspaces/{ws}/ads?month=                       earnings report and connections
//   PATCH  /workspaces/{ws}/ads/settings                     { currency } shown when nothing has synced yet
//   POST   /workspaces/{ws}/ads/connections/{platform}       connect or update (tests it first, then syncs)
//   POST   /workspaces/{ws}/ads/connections/{platform}/sync  pull the last { days } (default 30, up to 90)
//   DELETE /workspaces/{ws}/ads/connections/{platform}       forget the keys (earnings already pulled stay)
//
// Connected networks also sync on their own every 6 hours (the one-minute marketing tick calls tick()).
//
// Keys in the work table:
//   ADS#<ws>  SETTINGS                          currency
//   ADS#<ws>  CONN#<platform>                   a connection: public config, sealed secrets, status, account
//   ADS#<ws>  EARN#<date>#<platform>#<hash>     a day's earnings for one site or app
//   ADSCH     <ws>#<platform>                   index of connections, for the background sync
import { CONNECTORS, PlatformError } from './ads-connectors.mjs';
import { cleanConnection, cleanEarning, earningKey, isMonth, monthReport, PLATFORMS, seal, secretHints, shiftMonth, unseal } from './ads-model.mjs';

const SYNC_EVERY_MS = 6 * 3600 * 1000;
const DEFAULT_DAYS = 30;

export function registerAdsRoutes(route, { db, HttpError, openWorkspace, now, getAppSecret, fetch = globalThis.fetch }) {
  const { get, put, del, queryAll, putMany, deleteKeys } = db;
  const pk = (ws) => `ADS#${ws}`;
  const prefix = (PK, sk) => queryAll({ KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)', ExpressionAttributeValues: { ':pk': PK, ':sk': sk } });
  const strip = ({ PK, SK, ...rest }) => rest;
  const today = () => now().slice(0, 10);
  const minusDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);

  async function access(me, ws) {
    const { workspace, role } = await openWorkspace(me, ws, 'view');
    return { workspace, role, manage: ['owner', 'admin'].includes(role) };
  }
  const requireManage = (a) => {
    if (!a.manage) throw new HttpError(403, 'Only workspace owners and admins can connect ad accounts.');
  };
  const platformOf = (p) => {
    if (!PLATFORMS[p]) throw new HttpError(404, 'Unknown ad network.');
    return p;
  };
  const connectionOut = (c) => ({
    platform: c.platform,
    config: c.config,
    hints: c.hints || {},
    status: c.status,
    account: c.account || null,
    error: c.error || null,
    connectedAt: c.connectedAt,
    connectedBy: c.connectedBy,
    lastSyncAt: c.lastSyncAt || null,
    lastSyncRows: c.lastSyncRows ?? null,
  });

  route('GET', '/workspaces/{ws}/ads', async (me, { ws }, _b, query) => {
    const a = await access(me, ws);
    const month = isMonth(query.get('month')) ? query.get('month') : today().slice(0, 7);
    const [settings, connections, rows, previous] = await Promise.all([
      get(pk(ws), 'SETTINGS'),
      prefix(pk(ws), 'CONN#'),
      prefix(pk(ws), `EARN#${month}`),
      prefix(pk(ws), `EARN#${shiftMonth(month, -1)}`),
    ]);
    const report = monthReport({ month, rows, previous, today: today() });
    return {
      workspace: { id: ws, name: a.workspace.name },
      manage: a.manage,
      currency: report.currency || connections.map((c) => c.account?.currency).find(Boolean) || settings?.currency || 'USD',
      month,
      today: today(),
      report,
      connections: connections.map(strip).map(connectionOut),
      catalog: { platforms: PLATFORMS },
    };
  });

  route('PATCH', '/workspaces/{ws}/ads/settings', async (me, { ws }, body) => {
    const a = await access(me, ws);
    requireManage(a);
    const currency = String(body.currency || '').trim().toUpperCase().slice(0, 8) || 'USD';
    await put({ PK: pk(ws), SK: 'SETTINGS', currency, updatedAt: now(), updatedBy: me.email });
    return { currency };
  });

  async function ctxFor(row) {
    return { config: row.config, secrets: unseal(await getAppSecret(), row.sealed), fetch };
  }

  async function sync(ws, platform, days = DEFAULT_DAYS) {
    const row = await get(pk(ws), `CONN#${platform}`);
    if (!row) throw new HttpError(404, 'That ad network isn’t connected.');
    const until = today();
    const since = minusDays(until, Math.min(90, Math.max(1, days)) - 1);
    const index = (lastSyncAt) => put({ PK: 'ADSCH', SK: `${ws}#${platform}`, ws, platform, lastSyncAt });
    let result;
    try {
      result = await CONNECTORS[platform].sync(await ctxFor(row), { since, until, account: row.account });
    } catch (error) {
      if (!(error instanceof PlatformError)) console.error('ads sync', platform, error);
      const failed = { ...row, status: 'error', error: error instanceof PlatformError ? error.message : 'Sync failed. Try again later.', lastSyncAt: now() };
      await put(failed);
      await index(failed.lastSyncAt);
      return connectionOut(strip(failed));
    }
    const rows = [];
    for (const raw of result.rows) {
      try {
        const clean = cleanEarning(raw, { platform });
        rows.push({ PK: pk(ws), SK: earningKey(clean), ...clean, at: now() });
      } catch {
        /* a row the network sent without a usable date */
      }
    }
    await putMany(rows);
    const next = { ...row, status: 'connected', error: null, account: { ...row.account, currency: result.currency || row.account?.currency || '' }, lastSyncAt: now(), lastSyncRows: rows.length };
    await put(next);
    await index(next.lastSyncAt);
    return connectionOut(strip(next));
  }

  route('POST', '/workspaces/{ws}/ads/connections/{platform}', async (me, { ws, platform }, body) => {
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
    await put({
      PK: pk(ws),
      SK: `CONN#${platform}`,
      platform,
      config: { ...config, accountId: account.id },
      sealed: seal(appSecret, secrets),
      hints: secretHints(platform, secrets),
      status: 'connected',
      account,
      error: null,
      connectedAt: existing?.connectedAt || at,
      connectedBy: existing?.connectedBy || me.email,
      updatedAt: at,
    });
    await put({ PK: 'ADSCH', SK: `${ws}#${platform}`, ws, platform, lastSyncAt: existing?.lastSyncAt || '' });
    // Pull earnings straight away so the page fills in.
    return { connection: await sync(ws, platform) };
  });

  route('POST', '/workspaces/{ws}/ads/connections/{platform}/sync', async (me, { ws, platform }, body) => {
    await access(me, ws);
    platformOf(platform);
    return { connection: await sync(ws, platform, Number(body.days) || DEFAULT_DAYS) };
  });

  route('DELETE', '/workspaces/{ws}/ads/connections/{platform}', async (me, { ws, platform }) => {
    const a = await access(me, ws);
    requireManage(a);
    platformOf(platform);
    await deleteKeys([{ PK: pk(ws), SK: `CONN#${platform}` }, { PK: 'ADSCH', SK: `${ws}#${platform}` }]);
    return { ok: true };
  });

  // Background sync: every minute the marketing tick asks; connections synced over 6 hours ago pull
  // the last 7 days again (networks finalise earnings a few days late), one per run.
  async function tick() {
    const all = await queryAll({ KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': 'ADSCH' } });
    const due = all.filter((r) => !r.lastSyncAt || Date.now() - Date.parse(r.lastSyncAt) > SYNC_EVERY_MS).slice(0, 1);
    for (const r of due) {
      try {
        await sync(r.ws, r.platform, 7);
      } catch (error) {
        console.error('ads tick', r.SK, error);
        if (error.status === 404) await del('ADSCH', r.SK);
      }
    }
  }

  return { tick };
}
