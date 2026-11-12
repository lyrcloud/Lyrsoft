import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONNECTORS } from './ads-connectors.mjs';
import { cleanConnection, cleanEarning, earningKey, monthReport, secretHints } from './ads-model.mjs';

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const hit = routes.find(([re]) => re.test(String(url)));
    if (!hit) return new Response('{"error":{"message":"no route"}}', { status: 404 });
    const [, body, status = 200] = hit;
    return new Response(JSON.stringify(typeof body === 'function' ? body(String(url), init) : body), { status });
  };
  fn.calls = calls;
  return fn;
}
const token = [/oauth2\.googleapis\.com\/token/, { access_token: 'ya29.test' }];
const base = { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'secret-abcd', refreshToken: '1//refresh-wxyz' };

test('connection form: secrets kept apart, publisher ID tidied, blanks keep saved secrets', () => {
  const first = cleanConnection('adsense', { ...base, accountId: 'ca-pub-1234567890123456' });
  assert.equal(first.config.accountId, 'pub-1234567890123456');
  assert.equal(first.config.clientSecret, undefined);
  assert.deepEqual(secretHints('adsense', first.secrets), { clientSecret: '…abcd', refreshToken: '…wxyz' });
  const again = cleanConnection('adsense', { clientId: 'cid', accountId: '' }, first);
  assert.equal(again.secrets.refreshToken, '1//refresh-wxyz');
  assert.equal(again.config.accountId, '');
  assert.throws(() => cleanConnection('admob', { clientId: 'cid' }), /client secret is needed/);
  assert.throws(() => cleanConnection('nope', base), /Unknown/);
});

test('AdSense: finds the account and reads earnings per day and site', async () => {
  const fetch = fakeFetch([
    token,
    [/adsense\.googleapis\.com\/v2\/accounts\?/, { accounts: [{ name: 'accounts/pub-111', displayName: 'Lyrsoft', timeZone: { id: 'America/New_York' } }] }],
    [/reports:generate/, {
      headers: [{ name: 'DATE' }, { name: 'DOMAIN_NAME' }, { name: 'ESTIMATED_EARNINGS', currencyCode: 'USD' }, { name: 'PAGE_VIEWS' }, { name: 'IMPRESSIONS' }, { name: 'CLICKS' }, { name: 'AD_REQUESTS' }],
      rows: [{ cells: [{ value: '2026-11-01' }, { value: 'lyrsoft.com' }, { value: '1.25' }, { value: '400' }, { value: '900' }, { value: '7' }, { value: '950' }] }],
    }],
  ]);
  const ctx = { config: { clientId: 'cid', accountId: '' }, secrets: base, fetch };
  const account = await CONNECTORS.adsense.test(ctx);
  assert.equal(account.id, 'pub-111');
  const { rows, currency } = await CONNECTORS.adsense.sync(ctx, { since: '2026-11-01', until: '2026-11-11', account });
  assert.equal(currency, 'USD');
  const url = fetch.calls.at(-1).url;
  assert.match(url, /accounts\/pub-111\/reports:generate/);
  assert.match(url, /startDate\.day=1/);
  assert.match(url, /dimensions=DOMAIN_NAME/);
  const e = cleanEarning(rows[0], { platform: 'adsense' });
  assert.deepEqual([e.date, e.property, e.earnings, e.pageViews, e.clicks], ['2026-11-01', 'lyrsoft.com', 1.25, 400, 7]);
  await assert.rejects(CONNECTORS.adsense.test({ ...ctx, config: { accountId: 'pub-999' } }), /isn’t one of this sign-in’s accounts/);
});

test('AdMob: reads earnings per day and app from the streamed report', async () => {
  const fetch = fakeFetch([
    token,
    [/admob\.googleapis\.com\/v1\/accounts\?/, { account: [{ name: 'accounts/pub-222', publisherId: 'pub-222', currencyCode: 'USD', reportingTimeZone: 'America/Los_Angeles' }] }],
    [/networkReport:generate/, [
      { header: { localizationSettings: { currencyCode: 'USD' } } },
      { row: { dimensionValues: { DATE: { value: '20261102' }, APP: { value: 'ca-app-pub-222~1', displayLabel: 'Lyr Chat' } }, metricValues: { ESTIMATED_EARNINGS: { microsValue: '2500000' }, IMPRESSIONS: { integerValue: '1000' }, CLICKS: { integerValue: '12' }, AD_REQUESTS: { integerValue: '1100' } } } },
      { footer: { matchingRowCount: '1' } },
    ]],
  ]);
  const ctx = { config: { clientId: 'cid', accountId: 'pub-222' }, secrets: base, fetch };
  const account = await CONNECTORS.admob.test(ctx);
  const { rows } = await CONNECTORS.admob.sync(ctx, { since: '2026-11-01', until: '2026-11-11', account });
  const spec = JSON.parse(fetch.calls.at(-1).init.body).reportSpec;
  assert.deepEqual(spec.dateRange.startDate, { year: 2026, month: 11, day: 1 });
  const e = cleanEarning(rows[0], { platform: 'admob' });
  assert.deepEqual([e.date, e.property, e.propertyId, e.earnings, e.impressions], ['2026-11-02', 'Lyr Chat', 'ca-app-pub-222~1', 2.5, 1000]);
});

test('month report: totals, projection, per site and app, change against last month', () => {
  const rows = [
    cleanEarning({ date: '2026-11-01', property: 'lyrsoft.com', earnings: 2, pageViews: 1000, impressions: 2000, clicks: 20, currency: 'USD' }, { platform: 'adsense' }),
    cleanEarning({ date: '2026-11-02', property: 'lyrsoft.com', earnings: 3, pageViews: 1000, impressions: 2000, clicks: 10, currency: 'USD' }, { platform: 'adsense' }),
    cleanEarning({ date: '2026-11-02', property: 'Lyr Chat', propertyId: 'app1', earnings: 5, impressions: 1000, currency: 'USD' }, { platform: 'admob' }),
  ];
  const previous = [
    cleanEarning({ date: '2026-10-01', property: 'lyrsoft.com', earnings: 4 }, { platform: 'adsense' }),
    cleanEarning({ date: '2026-10-20', property: 'lyrsoft.com', earnings: 100 }, { platform: 'adsense' }),
  ];
  const r = monthReport({ month: '2026-11', rows, previous, today: '2026-11-02' });
  assert.equal(r.totals.earnings, 10);
  assert.equal(r.totals.projected, 150); // 10 over 2 days → 30 days
  assert.equal(r.totals.previousSoFar, 4);
  assert.equal(r.totals.change, 150);
  assert.equal(r.currency, 'USD');
  assert.deepEqual(Object.fromEntries(r.platforms.map((p) => [p.platform, p.earnings])), { adsense: 5, admob: 5 });
  assert.equal(r.properties.find((p) => p.property === 'lyrsoft.com').rpm, 2.5);
  assert.equal(r.daily[1].total, 8);
  assert.equal(r.daily[2].future, true);
  assert.notEqual(earningKey(rows[1]), earningKey(rows[2]));
});
