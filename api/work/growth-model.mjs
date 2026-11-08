// Lyrsoft Ads & budget: pure rules behind growth.mjs (tested in growth.test.mjs). Which marketing
// platforms there are and what connecting each one needs, campaign plans, monthly budgets per
// channel, spend rows (synced from a platform's API or typed in) and the numbers built from them:
// budget vs actual, pacing, cost per click / result.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { ValidationError } from './model.mjs';

// kind: 'ads' (spend comes from the API), 'social' (followers and reach), 'messaging', 'manual'
// (no API: spend is typed in). `fields` are what the connect form asks for; `secret: true` fields
// are stored encrypted and never sent back.
export const PLATFORMS = {
  meta: {
    name: 'Meta (Facebook, Instagram, Messenger)', short: 'Meta', icon: '∞', color: '#0866ff', kind: 'ads', channels: ['facebook', 'instagram', 'messenger', 'audience_network'],
    fields: [
      { key: 'accessToken', label: 'System user access token', secret: true, required: true, help: 'Business Settings → Users → System users → Generate token, with ads_read, pages_read_engagement, instagram_basic.' },
      { key: 'adAccountId', label: 'Ad account ID', required: true, placeholder: 'act_1234567890', help: 'Ads Manager → account menu. Starts with act_.' },
      { key: 'pageId', label: 'Facebook Page ID', placeholder: 'For followers (optional)' },
      { key: 'igUserId', label: 'Instagram business account ID', placeholder: 'For followers (optional)' },
    ],
    docs: 'https://developers.facebook.com/docs/marketing-api/insights',
  },
  google: {
    name: 'Google Ads (Search, Display, YouTube ads)', short: 'Google Ads', icon: 'G', color: '#34a853', kind: 'ads', channels: ['google', 'youtube'],
    fields: [
      { key: 'developerToken', label: 'Developer token', secret: true, required: true, help: 'Google Ads → Tools → API Center.' },
      { key: 'clientId', label: 'OAuth client ID', required: true, help: 'Google Cloud → APIs & Services → Credentials (Desktop or Web app).' },
      { key: 'clientSecret', label: 'OAuth client secret', secret: true, required: true },
      { key: 'refreshToken', label: 'Refresh token', secret: true, required: true, help: 'From the OAuth Playground with scope https://www.googleapis.com/auth/adwords.' },
      { key: 'customerId', label: 'Customer ID', required: true, placeholder: '123-456-7890' },
      { key: 'loginCustomerId', label: 'Manager (MCC) customer ID', placeholder: 'Only when the account sits under a manager' },
      { key: 'apiVersion', label: 'API version', placeholder: 'v21' },
    ],
    docs: 'https://developers.google.com/google-ads/api/docs/start',
  },
  tiktok: {
    name: 'TikTok Ads', short: 'TikTok', icon: '♪', color: '#111111', kind: 'ads', channels: ['tiktok'],
    fields: [
      { key: 'accessToken', label: 'Access token', secret: true, required: true, help: 'TikTok for Business → Developers → your app → advertiser authorisation.' },
      { key: 'advertiserId', label: 'Advertiser ID', required: true },
    ],
    docs: 'https://business-api.tiktok.com/portal/docs',
  },
  youtube: {
    name: 'YouTube channel', short: 'YouTube', icon: '▶', color: '#ff0000', kind: 'social', channels: ['youtube'],
    fields: [
      { key: 'apiKey', label: 'YouTube Data API key', secret: true, required: true, help: 'Google Cloud → enable “YouTube Data API v3” → Credentials → API key.' },
      { key: 'channelId', label: 'Channel ID', required: true, placeholder: 'UC…' },
    ],
    docs: 'https://developers.google.com/youtube/v3/docs/channels/list',
  },
  whatsapp: {
    name: 'WhatsApp Business (Cloud API)', short: 'WhatsApp', icon: '✆', color: '#25d366', kind: 'messaging', channels: ['whatsapp'],
    fields: [
      { key: 'accessToken', label: 'Permanent access token', secret: true, required: true, help: 'Meta Business → System user token with whatsapp_business_management and whatsapp_business_messaging.' },
      { key: 'phoneNumberId', label: 'Phone number ID', required: true, help: 'WhatsApp Manager → API setup.' },
      { key: 'wabaId', label: 'WhatsApp Business account ID', required: true },
    ],
    docs: 'https://developers.facebook.com/docs/whatsapp/cloud-api',
  },
  wechat: {
    name: 'WeChat Official Account', short: 'WeChat', icon: '微', color: '#07c160', kind: 'social', channels: ['wechat'],
    fields: [
      { key: 'appId', label: 'AppID', required: true },
      { key: 'appSecret', label: 'AppSecret', secret: true, required: true, help: 'WeChat Official Accounts Platform → Settings → Basic configuration. Add Lyrsoft’s server IP to the IP whitelist.' },
    ],
    docs: 'https://developers.weixin.qq.com/doc/offiaccount/en/Analytics/User_Analysis_Data_Interface.html',
  },
  telegram: {
    name: 'Telegram channel', short: 'Telegram', icon: '✈', color: '#229ed9', kind: 'social', channels: ['telegram'],
    fields: [
      { key: 'botToken', label: 'Bot token', secret: true, required: true, help: 'From @BotFather. Add the bot to your channel as an admin.' },
      { key: 'chatId', label: 'Channel', required: true, placeholder: '@yourchannel' },
    ],
    docs: 'https://core.telegram.org/bots/api#getchatmembercount',
  },
};
// Channels without an API connection here: spend and results are typed in.
export const MANUAL_CHANNELS = {
  linkedin: ['LinkedIn', '#0a66c2'], x: ['X (Twitter)', '#111111'], snapchat: ['Snapchat', '#e8d600'], pinterest: ['Pinterest', '#e60023'],
  viber: ['Viber', '#7360f2'], imo: ['imo', '#1a73e8'], sms: ['SMS', '#6c5ce7'], email: ['Email', '#a25ddc'], seo: ['SEO / content', '#00a65f'],
  influencer: ['Influencers', '#ff5ac4'], offline: ['Print, TV, outdoor', '#8a90a2'], events: ['Events', '#fdab3d'], other: ['Other', '#676f83'],
};
// Every channel a plan, budget or spend row can be on, with its label and colour.
export const CHANNELS = {
  facebook: ['Facebook', '#0866ff'], instagram: ['Instagram', '#e1306c'], messenger: ['Messenger', '#a033ff'], audience_network: ['Meta Audience Network', '#5b7cfa'],
  google: ['Google Search & Display', '#34a853'], youtube: ['YouTube', '#ff0000'], tiktok: ['TikTok', '#111111'], whatsapp: ['WhatsApp', '#25d366'],
  wechat: ['WeChat', '#07c160'], telegram: ['Telegram', '#229ed9'], ...MANUAL_CHANNELS,
};
export const OBJECTIVES = ['awareness', 'traffic', 'engagement', 'leads', 'sales', 'app installs', 'messages', 'video views', 'followers'];
export const PLAN_STATUSES = ['idea', 'planned', 'live', 'paused', 'done'];
export const PLANS_MAX = 500;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const text = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const multiline = (v, max) => String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim().slice(0, max);
export const amount = (v) => {
  const n = Number(String(v ?? '').replace(/[,\s]/g, ''));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : 0;
};
const count = (v) => Math.max(0, Math.round(Number(String(v ?? '').replace(/[,\s]/g, '')) || 0));
export const isDate = (v) => DATE_RE.test(String(v || '')) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
export const isMonth = (v) => MONTH_RE.test(String(v || ''));
export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
export const daysInMonth = (m) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate();

// ------------------------------------------------------------------ credentials

// Secret fields are sealed with AES-256-GCM under a key derived from the app secret.
const keyFor = (appSecret) => createHash('sha256').update(`lyrsoft-growth:${appSecret}`).digest();
export function seal(appSecret, data) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(appSecret), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${body.toString('base64url')}`;
}
export function unseal(appSecret, sealed) {
  if (!sealed) return {};
  const [, iv, tag, body] = String(sealed).split('.');
  const decipher = createDecipheriv('aes-256-gcm', keyFor(appSecret), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8'));
}

// Splits a connect form into public settings and secrets. Secret fields left blank keep their
// stored value, so an admin can change the account ID without pasting the token again.
export function cleanConnection(platform, input, current = { config: {}, secrets: {} }) {
  const def = PLATFORMS[platform];
  if (!def) throw new ValidationError('Unknown platform.');
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
  if (platform === 'meta' && config.adAccountId && !config.adAccountId.startsWith('act_')) config.adAccountId = `act_${config.adAccountId.replace(/\D/g, '')}`;
  if (platform === 'google') {
    config.customerId = config.customerId.replace(/\D/g, '');
    config.loginCustomerId = config.loginCustomerId.replace(/\D/g, '');
    if (!/^v\d{2}$/.test(config.apiVersion)) config.apiVersion = 'v21';
  }
  if (platform === 'telegram' && config.chatId && !/^(@|-?\d)/.test(config.chatId)) config.chatId = `@${config.chatId}`;
  return { config, secrets };
}
export const secretHints = (platform, secrets) => Object.fromEntries(PLATFORMS[platform].fields.filter((f) => f.secret).map((f) => [f.key, secrets[f.key] ? `…${String(secrets[f.key]).slice(-4)}` : '']));

// ------------------------------------------------------------------ plans, budgets, spend

export function cleanPlan(input, current = null) {
  const p = current ? { ...current } : {};
  const has = (k) => k in (input || {}) || !current;
  if (has('name')) p.name = text(input.name, 120);
  if (has('channels')) p.channels = [...new Set((Array.isArray(input.channels) ? input.channels : [input.channels]).filter((c) => c in CHANNELS))];
  if (has('objective')) p.objective = OBJECTIVES.includes(input.objective) ? input.objective : 'awareness';
  if (has('status')) p.status = PLAN_STATUSES.includes(input.status) ? input.status : 'planned';
  if (has('start')) p.start = isDate(input.start) ? input.start : '';
  if (has('end')) p.end = isDate(input.end) ? input.end : '';
  if (has('budget')) p.budget = amount(input.budget);
  if (has('targetMetric')) p.targetMetric = ['', 'impressions', 'clicks', 'results', 'reach'].includes(input.targetMetric) ? input.targetMetric : '';
  if (has('targetValue')) p.targetValue = count(input.targetValue);
  if (has('match')) p.match = text(input.match, 120);
  if (has('owner')) p.owner = text(input.owner, 120);
  if (has('audience')) p.audience = text(input.audience, 300);
  if (has('notes')) p.notes = multiline(input.notes, 4000);
  if (!p.name) throw new ValidationError('Name the plan.');
  if (!p.channels.length) throw new ValidationError('Pick at least one channel.');
  if (p.start && p.end && p.end < p.start) throw new ValidationError('The plan can’t end before it starts.');
  return p;
}

export function cleanBudget(input) {
  const out = {};
  for (const [ch, v] of Object.entries(input?.channels || {})) if (ch in CHANNELS && amount(v)) out[ch] = amount(v);
  return { channels: out, total: round2(Object.values(out).reduce((s, v) => s + v, 0)), note: text(input?.note, 300) };
}

// A spend row, from a platform's API or typed in.
export function cleanSpend(input, { source = 'manual' } = {}) {
  if (!isDate(input?.date)) throw new ValidationError('Pick the date.');
  if (!(input.channel in CHANNELS)) throw new ValidationError('Pick the channel.');
  return {
    date: input.date,
    channel: input.channel,
    campaign: text(input.campaign, 160) || '(no campaign)',
    campaignId: text(input.campaignId, 60),
    spend: amount(input.spend),
    impressions: count(input.impressions),
    clicks: count(input.clicks),
    reach: count(input.reach),
    results: count(input.results),
    source,
    note: text(input.note, 300),
  };
}
export const spendKey = (s) => `SPEND#${s.date}#${s.channel}#${createHash('sha1').update(`${s.source}:${s.campaignId || s.campaign}`).digest('hex').slice(0, 12)}`;

const empty = () => ({ spend: 0, impressions: 0, clicks: 0, reach: 0, results: 0 });
const add = (t, s) => {
  for (const k of ['spend', 'impressions', 'clicks', 'reach', 'results']) t[k] += s[k] || 0;
  return t;
};
export const ratios = (t) => ({
  ...t,
  spend: round2(t.spend),
  ctr: t.impressions ? round2((t.clicks / t.impressions) * 100) : null,
  cpc: t.clicks ? round2(t.spend / t.clicks) : null,
  cpm: t.impressions ? round2((t.spend / t.impressions) * 1000) : null,
  cpr: t.results ? round2(t.spend / t.results) : null,
});

// Budget vs actual for a month: per channel, with pace (spend so far projected to month end).
export function monthReport({ month, budget, rows, today }) {
  const days = daysInMonth(month);
  const elapsed = today.slice(0, 7) > month ? days : today.slice(0, 7) < month ? 0 : Number(today.slice(8, 10));
  const byChannel = {};
  const byDay = {};
  const total = empty();
  for (const r of rows) {
    add((byChannel[r.channel] ??= empty()), r);
    add((byDay[r.date] ??= empty()), r);
    add(total, r);
  }
  const channels = [...new Set([...Object.keys(budget?.channels || {}), ...Object.keys(byChannel)])].map((ch) => {
    const t = byChannel[ch] || empty();
    const planned = budget?.channels?.[ch] || 0;
    const projected = elapsed ? round2((t.spend / elapsed) * days) : 0;
    return { channel: ch, budget: planned, ...ratios(t), remaining: round2(planned - t.spend), used: planned ? round2((t.spend / planned) * 100) : null, projected, over: Boolean(planned && projected > planned * 1.05) };
  }).sort((a, b) => b.spend - a.spend || b.budget - a.budget);
  const planned = budget?.total || 0;
  const projected = elapsed ? round2((total.spend / elapsed) * days) : 0;
  return {
    month,
    days,
    elapsed,
    budget: planned,
    totals: { ...ratios(total), remaining: round2(planned - total.spend), used: planned ? round2((total.spend / planned) * 100) : null, projected, over: Boolean(planned && projected > planned * 1.05) },
    channels,
    daily: Array.from({ length: days }, (_, i) => {
      const date = `${month}-${String(i + 1).padStart(2, '0')}`;
      return { date, spend: round2(byDay[date]?.spend || 0), clicks: byDay[date]?.clicks || 0, results: byDay[date]?.results || 0 };
    }),
  };
}

// Campaigns in the rows, best spenders first.
export function campaignTable(rows) {
  const map = new Map();
  for (const r of rows) {
    // Hand-typed rows for the same campaign name add up; synced ones group by the platform's campaign ID.
    const key = `${r.channel}|${r.source === 'manual' ? r.campaign.toLowerCase() : r.campaignId || r.campaign}`;
    const t = map.get(key) || { channel: r.channel, campaign: r.campaign, campaignId: r.campaignId, source: r.source, ...empty() };
    map.set(key, add(t, r));
  }
  return [...map.values()].map(ratios).sort((a, b) => b.spend - a.spend);
}

// A plan's results: spend rows on its channels, inside its dates, whose campaign name contains the
// plan's match text (or all of them on those channels when the match is empty).
export function planProgress(plan, rows) {
  const needle = (plan.match || '').toLowerCase();
  const mine = rows.filter((r) => plan.channels.includes(r.channel) && (!plan.start || r.date >= plan.start) && (!plan.end || r.date <= plan.end) && (!needle || r.campaign.toLowerCase().includes(needle)));
  const t = ratios(mine.reduce(add, empty()));
  const target = plan.targetMetric ? t[plan.targetMetric] || 0 : 0;
  return {
    ...t,
    budgetUsed: plan.budget ? round2((t.spend / plan.budget) * 100) : null,
    targetDone: plan.targetMetric && plan.targetValue ? round2((target / plan.targetValue) * 100) : null,
  };
}
