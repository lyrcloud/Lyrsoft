// Lyrsoft Ad revenue: pure rules behind ads.mjs (tested in ads.test.mjs). Which ad networks a
// workspace can connect to earn from its own websites and apps, what connecting each one needs,
// earnings rows (one per day and site or app) and the month report built from them.
import { createHash } from 'node:crypto';
import { ValidationError } from './model.mjs';

export { seal, unseal } from './growth-model.mjs';

// `fields` are what the connect form asks for; `secret: true` fields are stored encrypted and never
// sent back. Both networks use the workspace's own Google OAuth client and a refresh token.
const oauthFields = (scope, idLabel, idHelp) => [
  { key: 'clientId', label: 'OAuth client ID', required: true, placeholder: '1234-abc.apps.googleusercontent.com', help: 'Google Cloud → APIs & Services → Credentials → Create OAuth client ID (Web application). Add https://developers.google.com/oauthplayground as a redirect URI.' },
  { key: 'clientSecret', label: 'OAuth client secret', secret: true, required: true },
  { key: 'refreshToken', label: 'Refresh token', secret: true, required: true, help: `OAuth Playground → ⚙ → “Use your own OAuth credentials” → scope ${scope} → Authorize → Exchange for tokens → copy the refresh token.` },
  { key: 'accountId', label: idLabel, placeholder: 'pub-1234567890123456', help: idHelp },
];

export const PLATFORMS = {
  adsense: {
    name: 'Google AdSense', short: 'AdSense', icon: '🌐', color: '#4285f4', what: 'Ads on your websites', property: 'Site',
    scope: 'https://www.googleapis.com/auth/adsense.readonly',
    api: 'AdSense Management API',
    fields: oauthFields('https://www.googleapis.com/auth/adsense.readonly', 'Publisher ID', 'AdSense → Account → Account information. Leave empty to use the first account the sign-in can see.'),
    docs: 'https://developers.google.com/adsense/management/getting_started',
  },
  admob: {
    name: 'Google AdMob', short: 'AdMob', icon: '📱', color: '#ea4335', what: 'Ads in your phone apps', property: 'App',
    scope: 'https://www.googleapis.com/auth/admob.readonly',
    api: 'AdMob API',
    fields: oauthFields('https://www.googleapis.com/auth/admob.readonly', 'Publisher ID', 'AdMob → Settings → Account information. Leave empty to use the first account the sign-in can see.'),
    docs: 'https://developers.google.com/admob/api/v1/getting-started',
  },
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const text = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const money = (v) => {
  const n = Number(String(v ?? '').replace(/[,\s]/g, ''));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 10000) / 10000 : 0;
};
const count = (v) => Math.max(0, Math.round(Number(String(v ?? '').replace(/[,\s]/g, '')) || 0));
export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
export const isDate = (v) => DATE_RE.test(String(v || '')) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
export const isMonth = (v) => MONTH_RE.test(String(v || ''));
export const daysInMonth = (m) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate();
export const shiftMonth = (m, n) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + n, 1)).toISOString().slice(0, 7);

// Splits a connect form into public settings and secrets. Secret fields left blank keep their
// stored value, so an admin can change the publisher ID without pasting the token again.
export function cleanConnection(platform, input, current = { config: {}, secrets: {} }) {
  const def = PLATFORMS[platform];
  if (!def) throw new ValidationError('Unknown ad network.');
  const config = {};
  const secrets = { ...current.secrets };
  for (const f of def.fields) {
    const raw = text(input?.[f.key], 2000);
    if (f.secret) {
      if (raw) secrets[f.key] = raw;
      if (f.required && !secrets[f.key]) throw new ValidationError(`${f.label} is needed.`);
    } else {
      config[f.key] = raw;
      if (f.required && !raw) throw new ValidationError(`${f.label} is needed.`);
    }
  }
  if (config.accountId) {
    const digits = config.accountId.replace(/^accounts\//, '').replace(/^ca-/, '').replace(/^pub-/, '').replace(/\D/g, '');
    if (!digits) throw new ValidationError('The publisher ID looks like pub-1234567890123456.');
    config.accountId = `pub-${digits}`;
  }
  return { config, secrets };
}
export const secretHints = (platform, secrets) => Object.fromEntries(PLATFORMS[platform].fields.filter((f) => f.secret).map((f) => [f.key, secrets[f.key] ? `…${String(secrets[f.key]).slice(-4)}` : '']));

// One day's earnings for one site (AdSense) or app (AdMob), as the network reports it.
export function cleanEarning(input, { platform }) {
  if (!PLATFORMS[platform]) throw new ValidationError('Unknown ad network.');
  if (!isDate(input?.date)) throw new ValidationError('Pick the date.');
  return {
    date: input.date,
    platform,
    property: text(input.property, 200) || '(not set)',
    propertyId: text(input.propertyId, 200),
    earnings: money(input.earnings),
    impressions: count(input.impressions),
    clicks: count(input.clicks),
    pageViews: count(input.pageViews),
    requests: count(input.requests),
    currency: text(input.currency, 8).toUpperCase(),
  };
}
export const earningKey = (e) => `EARN#${e.date}#${e.platform}#${createHash('sha1').update(e.propertyId || e.property).digest('hex').slice(0, 12)}`;

const empty = () => ({ earnings: 0, impressions: 0, clicks: 0, pageViews: 0, requests: 0 });
const add = (t, r) => {
  for (const k of Object.keys(empty())) t[k] += r[k] || 0;
  return t;
};
// RPM: earnings per 1,000 page views (sites) or eCPM: per 1,000 impressions; CTR in %.
export const ratios = (t) => ({
  ...t,
  earnings: round2(t.earnings),
  ctr: t.impressions ? round2((t.clicks / t.impressions) * 100) : null,
  ecpm: t.impressions ? round2((t.earnings / t.impressions) * 1000) : null,
  rpm: t.pageViews ? round2((t.earnings / t.pageViews) * 1000) : null,
});

// A month of earnings: totals, per network, per site or app, per day, a month-end projection and the
// change against the same days of the previous month.
export function monthReport({ month, rows, previous = [], today }) {
  const days = daysInMonth(month);
  const elapsed = today.slice(0, 7) > month ? days : today.slice(0, 7) < month ? 0 : Number(today.slice(8, 10));
  const total = empty();
  const byPlatform = {};
  const byProperty = new Map();
  for (const r of rows) {
    add(total, r);
    add((byPlatform[r.platform] ??= empty()), r);
    const key = `${r.platform}|${r.propertyId || r.property}`;
    if (!byProperty.has(key)) byProperty.set(key, { platform: r.platform, property: r.property, propertyId: r.propertyId, ...empty() });
    add(byProperty.get(key), r);
  }
  // Same span of the previous month (its first `elapsed` days), for a fair comparison.
  const prevMonth = shiftMonth(month, -1);
  const cutoff = `${prevMonth}-${String(Math.min(elapsed || days, daysInMonth(prevMonth))).padStart(2, '0')}`;
  const prevSoFar = previous.filter((r) => r.date <= cutoff).reduce((s, r) => s + (r.earnings || 0), 0);
  const prevTotal = previous.reduce((s, r) => s + (r.earnings || 0), 0);
  const daily = {};
  for (const r of rows) {
    const d = (daily[r.date] ??= { adsense: 0, admob: 0 });
    d[r.platform] = round2(d[r.platform] + r.earnings);
  }
  const currencies = [...new Set(rows.map((r) => r.currency).filter(Boolean))];
  return {
    month,
    days,
    elapsed,
    currency: currencies.length === 1 ? currencies[0] : null,
    mixedCurrencies: currencies.length > 1,
    totals: { ...ratios(total), projected: elapsed && elapsed < days ? round2((total.earnings / elapsed) * days) : round2(total.earnings), previous: round2(prevTotal), previousSoFar: round2(prevSoFar), change: prevSoFar ? round2(((total.earnings - prevSoFar) / prevSoFar) * 100) : null },
    platforms: Object.entries(byPlatform).map(([platform, t]) => ({ platform, ...ratios(t) })).sort((a, b) => b.earnings - a.earnings),
    properties: [...byProperty.values()].map(ratios).sort((a, b) => b.earnings - a.earnings),
    daily: Array.from({ length: days }, (_, i) => {
      const date = `${month}-${String(i + 1).padStart(2, '0')}`;
      const d = daily[date] || { adsense: 0, admob: 0 };
      return { date, adsense: d.adsense, admob: d.admob, total: round2(d.adsense + d.admob), future: date > today };
    }),
  };
}
