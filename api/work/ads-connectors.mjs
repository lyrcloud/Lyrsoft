// The ad networks' APIs behind Lyrsoft Ad revenue (ads.mjs). Each connector can test() its
// connection (finds the publisher account) and sync() a date range into earnings rows (see
// cleanEarning). `fetch` is passed in so tests can fake the networks.
//
//   adsense  AdSense Management API v2: reports:generate by DATE and DOMAIN_NAME
//   admob    AdMob API v1: networkReport:generate by DATE and APP
import { PlatformError } from './growth-connectors.mjs';

export { PlatformError };

async function call(fetch, url, init = {}, what) {
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
  } catch (error) {
    throw new PlatformError(`${what} didn’t answer (${error.name === 'TimeoutError' ? 'timed out' : error.message}).`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = Array.isArray(body) ? body[0]?.error : body.error;
    const message = e?.message || body.error_description || (typeof body.error === 'string' ? body.error : '') || `HTTP ${res.status}`;
    throw new PlatformError(`${what}: ${message}`);
  }
  return body;
}

async function googleToken({ config, secrets, fetch }) {
  const body = await call(fetch, 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: config.clientId, client_secret: secrets.clientSecret, refresh_token: secrets.refreshToken }).toString(),
  }, 'Google sign-in');
  return body.access_token;
}
const ymd = (date) => {
  const [year, month, day] = date.split('-').map(Number);
  return { year, month, day };
};
const accountName = (id) => `accounts/${id}`;
const pickAccount = (list, wanted, what) => {
  if (!list.length) throw new PlatformError(`${what}: this Google sign-in has no ${what} account.`);
  if (!wanted) return list[0];
  const hit = list.find((a) => a.name === accountName(wanted));
  if (!hit) throw new PlatformError(`${what}: ${wanted} isn’t one of this sign-in’s accounts (${list.map((a) => a.name.replace('accounts/', '')).join(', ')}).`);
  return hit;
};

// ------------------------------------------------------------------ AdSense

const ADSENSE = 'https://adsense.googleapis.com/v2';
const adsense = {
  async test(ctx) {
    const token = await googleToken(ctx);
    const body = await call(ctx.fetch, `${ADSENSE}/accounts?pageSize=50`, { headers: { authorization: `Bearer ${token}` } }, 'AdSense');
    const a = pickAccount(body.accounts || [], ctx.config.accountId, 'AdSense');
    return { id: a.name.replace('accounts/', ''), name: a.displayName || a.name.replace('accounts/', ''), timezone: a.timeZone?.id || '', active: a.state !== 'CLOSED', pending: a.pendingTasks?.length ? a.pendingTasks : undefined };
  },
  async sync(ctx, { since, until, account }) {
    const token = await googleToken(ctx);
    const s = ymd(since);
    const u = ymd(until);
    const q = new URLSearchParams({
      dateRange: 'CUSTOM',
      'startDate.year': s.year, 'startDate.month': s.month, 'startDate.day': s.day,
      'endDate.year': u.year, 'endDate.month': u.month, 'endDate.day': u.day,
      limit: 100000,
    });
    for (const d of ['DATE', 'DOMAIN_NAME']) q.append('dimensions', d);
    for (const m of ['ESTIMATED_EARNINGS', 'PAGE_VIEWS', 'IMPRESSIONS', 'CLICKS', 'AD_REQUESTS']) q.append('metrics', m);
    const body = await call(ctx.fetch, `${ADSENSE}/${accountName(account.id)}/reports:generate?${q}`, { headers: { authorization: `Bearer ${token}` } }, 'AdSense');
    const headers = (body.headers || []).map((h) => h.name);
    const currency = body.headers?.find((h) => h.name === 'ESTIMATED_EARNINGS')?.currencyCode || '';
    const col = (row, name) => row.cells?.[headers.indexOf(name)]?.value;
    const rows = (body.rows || []).map((r) => ({
      date: col(r, 'DATE'),
      property: col(r, 'DOMAIN_NAME') || '(other)',
      propertyId: col(r, 'DOMAIN_NAME') || '',
      earnings: col(r, 'ESTIMATED_EARNINGS'),
      pageViews: col(r, 'PAGE_VIEWS'),
      impressions: col(r, 'IMPRESSIONS'),
      clicks: col(r, 'CLICKS'),
      requests: col(r, 'AD_REQUESTS'),
      currency,
    }));
    return { rows, currency };
  },
};

// ------------------------------------------------------------------ AdMob

const ADMOB = 'https://admob.googleapis.com/v1';
const admob = {
  async test(ctx) {
    const token = await googleToken(ctx);
    const body = await call(ctx.fetch, `${ADMOB}/accounts?pageSize=50`, { headers: { authorization: `Bearer ${token}` } }, 'AdMob');
    const a = pickAccount(body.account || [], ctx.config.accountId, 'AdMob');
    return { id: a.publisherId || a.name.replace('accounts/', ''), name: a.publisherId || a.name.replace('accounts/', ''), timezone: a.reportingTimeZone || '', currency: a.currencyCode || '', active: true };
  },
  async sync(ctx, { since, until, account }) {
    const token = await googleToken(ctx);
    const body = await call(ctx.fetch, `${ADMOB}/${accountName(account.id)}/networkReport:generate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        reportSpec: {
          dateRange: { startDate: ymd(since), endDate: ymd(until) },
          dimensions: ['DATE', 'APP'],
          metrics: ['ESTIMATED_EARNINGS', 'IMPRESSIONS', 'CLICKS', 'AD_REQUESTS'],
        },
      }),
    }, 'AdMob');
    const parts = Array.isArray(body) ? body : [body];
    const currency = parts.find((p) => p.header)?.header?.localizationSettings?.currencyCode || account.currency || '';
    const int = (m) => m?.integerValue ?? 0;
    const rows = parts.filter((p) => p.row).map(({ row }) => {
      const d = row.dimensionValues?.DATE?.value || '';
      const app = row.dimensionValues?.APP || {};
      const m = row.metricValues || {};
      return {
        date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
        property: app.displayLabel || app.value || '(other)',
        propertyId: app.value || '',
        earnings: Number(m.ESTIMATED_EARNINGS?.microsValue || 0) / 1e6,
        impressions: int(m.IMPRESSIONS),
        clicks: int(m.CLICKS),
        requests: int(m.AD_REQUESTS),
        currency,
      };
    });
    return { rows, currency };
  },
};

export const CONNECTORS = { adsense, admob };
