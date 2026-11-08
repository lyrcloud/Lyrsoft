import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONNECTORS } from './growth-connectors.mjs';
import { campaignTable, cleanConnection, cleanPlan, cleanSpend, monthReport, planProgress, seal, secretHints, unseal } from './growth-model.mjs';

// A fake fetch answering by URL pattern; records what was asked.
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

test('secrets are sealed, never echoed, and kept when left blank', () => {
  const sealed = seal('app-secret', { accessToken: 'EAAG-very-secret-1234' });
  assert.ok(!sealed.includes('very-secret'));
  assert.deepEqual(unseal('app-secret', sealed), { accessToken: 'EAAG-very-secret-1234' });
  assert.throws(() => unseal('other-secret', sealed));
  const first = cleanConnection('meta', { accessToken: 'EAAG-very-secret-1234', adAccountId: '1234567890' });
  assert.equal(first.config.adAccountId, 'act_1234567890');
  assert.equal(first.config.accessToken, undefined, 'the token is not in the public config');
  assert.deepEqual(secretHints('meta', first.secrets), { accessToken: '…1234' });
  const again = cleanConnection('meta', { accessToken: '', adAccountId: 'act_999' }, first);
  assert.equal(again.secrets.accessToken, 'EAAG-very-secret-1234');
  assert.throws(() => cleanConnection('meta', { adAccountId: 'act_1' }), /access token is needed/);
  assert.equal(cleanConnection('google', { developerToken: 'd', clientId: 'c', clientSecret: 's', refreshToken: 'r', customerId: '123-456-7890' }).config.customerId, '1234567890');
});

test('budget vs actual, pacing and plan progress', () => {
  const rows = [
    cleanSpend({ date: '2026-11-01', channel: 'facebook', campaign: 'Winter sale – FB', spend: 1000, impressions: 50000, clicks: 500, results: 10 }),
    cleanSpend({ date: '2026-11-05', channel: 'instagram', campaign: 'Winter sale – IG', spend: 2000, impressions: 80000, clicks: 400, results: 20 }),
    cleanSpend({ date: '2026-11-05', channel: 'google', campaign: 'Brand search', spend: 500, clicks: 250 }),
  ];
  const r = monthReport({ month: '2026-11', budget: { channels: { facebook: 5000, instagram: 4000 }, total: 9000 }, rows, today: '2026-11-10' });
  assert.equal(r.totals.spend, 3500);
  assert.equal(r.totals.projected, 10500, '3,500 in 10 days → 10,500 for 30');
  assert.equal(r.totals.over, true);
  const ig = r.channels.find((c) => c.channel === 'instagram');
  assert.deepEqual([ig.spend, ig.remaining, ig.used, ig.over], [2000, 2000, 50, true]);
  assert.equal(r.channels.find((c) => c.channel === 'google').budget, 0, 'unbudgeted spend still shows');
  assert.equal(r.daily.length, 30);
  const plan = cleanPlan({ name: 'Winter sale', channels: ['facebook', 'instagram'], start: '2026-11-01', end: '2026-11-30', budget: 6000, match: 'winter', targetMetric: 'results', targetValue: 60 });
  const p = planProgress(plan, rows);
  assert.deepEqual([p.spend, p.results, p.budgetUsed, p.targetDone, p.cpr], [3000, 30, 50, 50, 100]);
  assert.throws(() => cleanPlan({ name: 'x', channels: [] }), /channel/);
  const twice = [cleanSpend({ date: '2026-11-01', channel: 'linkedin', campaign: 'B2B', spend: 10, campaignId: 'a' }), cleanSpend({ date: '2026-11-02', channel: 'linkedin', campaign: 'b2b', spend: 5, campaignId: 'b' })];
  assert.equal(campaignTable(twice).length, 1, 'hand-typed rows of one campaign add up');
});

test('Meta insights split by Facebook / Instagram, with followers', async () => {
  const fetch = fakeFetch([
    [/\/insights\?/, (url) => (url.includes('after=') ? { data: [] } : {
      data: [
        { date_start: '2026-11-01', publisher_platform: 'facebook', campaign_id: '1', campaign_name: 'Sale', spend: '120.50', impressions: '9000', clicks: '210', reach: '7000', actions: [{ action_type: 'lead', value: '4' }, { action_type: 'link_click', value: '210' }] },
        { date_start: '2026-11-01', publisher_platform: 'instagram', campaign_id: '1', campaign_name: 'Sale', spend: '80', impressions: '6000', clicks: '90', reach: '5000' },
      ],
      paging: { next: 'https://graph.facebook.com/v21.0/act_1/insights?after=x' },
    })],
    [/\/111\?/, { name: 'Acme', followers_count: 15200 }],
    [/\/222\?/, { username: 'acme', followers_count: 8100, media_count: 340 }],
  ]);
  const { rows, stats } = await CONNECTORS.meta.sync({ config: { adAccountId: 'act_1', pageId: '111', igUserId: '222' }, secrets: { accessToken: 't' }, fetch }, { since: '2026-11-01', until: '2026-11-07' });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => [r.channel, Number(r.spend), r.results]), [['facebook', 120.5, 4], ['instagram', 80, 0]]);
  assert.ok(decodeURIComponent(fetch.calls[0].url).includes('"since":"2026-11-01"'));
  assert.deepEqual(stats.instagram, { name: '@acme', followers: 8100, posts: 340 });
  assert.equal(cleanSpend(rows[0], { source: 'meta' }).spend, 120.5);
});

test('Google Ads cost in micros, YouTube network split out', async () => {
  const fetch = fakeFetch([
    [/oauth2\.googleapis\.com\/token/, { access_token: 'ya29' }],
    [/googleAds:searchStream/, [{ results: [
      { segments: { date: '2026-11-02', adNetworkType: 'SEARCH' }, campaign: { id: '9', name: 'Brand' }, metrics: { costMicros: '2500000', impressions: '1000', clicks: '80', conversions: 3.4 } },
      { segments: { date: '2026-11-02', adNetworkType: 'YOUTUBE' }, campaign: { id: '10', name: 'Video' }, metrics: { costMicros: '1000000', impressions: '5000', clicks: '12' } },
    ] }]],
  ]);
  const { rows } = await CONNECTORS.google.sync({ config: { customerId: '1234567890', clientId: 'c', apiVersion: 'v21' }, secrets: { developerToken: 'd', clientSecret: 's', refreshToken: 'r' }, fetch }, { since: '2026-11-01', until: '2026-11-07' });
  assert.deepEqual(rows.map((r) => [r.channel, r.spend, r.results]), [['google', 2.5, 3], ['youtube', 1, 0]]);
  const ads = fetch.calls.find((c) => c.url.includes('searchStream'));
  assert.equal(ads.init.headers['developer-token'], 'd');
  assert.match(JSON.parse(ads.init.body).query, /BETWEEN '2026-11-01' AND '2026-11-07'/);
});

test('TikTok report and platform errors read clearly', async () => {
  const fetch = fakeFetch([[/report\/integrated/, { code: 0, data: { page_info: { total_page: 1 }, list: [{ dimensions: { campaign_id: '5', stat_time_day: '2026-11-03 00:00:00' }, metrics: { campaign_name: 'Launch', spend: '50.00', impressions: '7000', clicks: '140', reach: '6000', conversion: '7' } }] } }]]);
  const { rows } = await CONNECTORS.tiktok.sync({ config: { advertiserId: 'a' }, secrets: { accessToken: 't' }, fetch }, { since: '2026-11-01', until: '2026-11-07' });
  assert.deepEqual([rows[0].date, rows[0].channel, rows[0].spend], ['2026-11-03', 'tiktok', '50.00']);
  const bad = fakeFetch([[/act_1\?/, { error: { message: 'Invalid OAuth access token.' } }, 400]]);
  await assert.rejects(CONNECTORS.meta.test({ config: { adAccountId: 'act_1' }, secrets: { accessToken: 'x' }, fetch: bad }), /Meta: Invalid OAuth access token/);
  const tg = fakeFetch([[/getChat\?/, { ok: true, result: { title: 'Acme News' } }], [/getChatMemberCount/, { ok: true, result: 4321 }]]);
  assert.deepEqual((await CONNECTORS.telegram.sync({ config: { chatId: '@acme' }, secrets: { botToken: 'b' }, fetch: tg })).stats.telegram, { name: 'Acme News', followers: 4321 });
});
