// The marketing platforms' APIs behind Lyrsoft Ads & budget (growth.mjs). Each connector can test()
// its connection and sync() a date range into spend rows (see cleanSpend) and account stats
// (followers, subscribers…). `fetch` is passed in so tests can fake the platforms.
//
//   meta      Graph API: ad account insights per campaign and day, split by publisher platform
//             (Facebook, Instagram, Messenger, Audience Network), Page and Instagram followers
//   google    Google Ads API searchStream (GAQL), cost per campaign and day; YouTube network → youtube
//   tiktok    TikTok Business API integrated report per campaign and day
//   youtube   YouTube Data API v3: subscribers, views and videos
//   whatsapp  WhatsApp Cloud API: number, quality rating, messaging limit, approved templates, test send
//   wechat    Official Account: followers (getusercumulate) and new / lost followers (getusersummary)
//   telegram  Bot API: channel title and member count
const GRAPH = 'https://graph.facebook.com/v21.0';

class PlatformError extends Error {}
export { PlatformError };

async function call(fetch, url, init = {}, what = 'The platform') {
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
  } catch (error) {
    throw new PlatformError(`${what} didn’t answer (${error.name === 'TimeoutError' ? 'timed out' : error.message}).`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = Array.isArray(body) ? body[0]?.error : body.error;
    const message = e?.message || e?.error_user_msg || body.error_description || body.message || body.errmsg || body.description || (typeof body.error === 'string' ? body.error : '') || `HTTP ${res.status}`;
    const detail = e?.details?.[0]?.errors?.[0]?.message; // Google Ads puts the useful part here
    throw new PlatformError(`${what}: ${detail || message}`);
  }
  return body;
}
const qs = (params) => new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== '')).toString();

// ------------------------------------------------------------------ Meta

const META_RESULT_ACTIONS = ['lead', 'purchase', 'complete_registration', 'mobile_app_install', 'onsite_conversion.messaging_conversation_started_7d', 'offsite_conversion.fb_pixel_lead', 'offsite_conversion.fb_pixel_purchase'];
const META_PLATFORM = { facebook: 'facebook', instagram: 'instagram', messenger: 'messenger', audience_network: 'audience_network' };

const meta = {
  async test({ config, secrets, fetch }) {
    const a = await call(fetch, `${GRAPH}/${encodeURIComponent(config.adAccountId)}?${qs({ fields: 'name,currency,account_status,timezone_name', access_token: secrets.accessToken })}`, {}, 'Meta');
    return { name: a.name, currency: a.currency, timezone: a.timezone_name, active: a.account_status === 1 };
  },
  async sync({ config, secrets, fetch }, { since, until }) {
    const rows = [];
    let url = `${GRAPH}/${encodeURIComponent(config.adAccountId)}/insights?${qs({
      level: 'campaign',
      time_increment: 1,
      breakdowns: 'publisher_platform',
      time_range: JSON.stringify({ since, until }),
      fields: 'campaign_id,campaign_name,spend,impressions,clicks,reach,actions',
      limit: 500,
      access_token: secrets.accessToken,
    })}`;
    for (let page = 0; url && page < 40; page += 1) {
      const body = await call(fetch, url, {}, 'Meta');
      for (const r of body.data || []) {
        const results = (r.actions || []).filter((a) => META_RESULT_ACTIONS.includes(a.action_type)).reduce((s, a) => s + Number(a.value || 0), 0);
        rows.push({ date: r.date_start, channel: META_PLATFORM[r.publisher_platform] || 'facebook', campaign: r.campaign_name, campaignId: r.campaign_id, spend: r.spend, impressions: r.impressions, clicks: r.clicks, reach: r.reach, results });
      }
      url = body.paging?.next || null;
    }
    const stats = {};
    if (config.pageId) {
      const p = await call(fetch, `${GRAPH}/${encodeURIComponent(config.pageId)}?${qs({ fields: 'name,followers_count,fan_count', access_token: secrets.accessToken })}`, {}, 'Facebook Page').catch((e) => ({ error: e.message }));
      stats.facebook = p.error ? { error: p.error } : { name: p.name, followers: p.followers_count ?? p.fan_count ?? null };
    }
    if (config.igUserId) {
      const ig = await call(fetch, `${GRAPH}/${encodeURIComponent(config.igUserId)}?${qs({ fields: 'username,followers_count,media_count', access_token: secrets.accessToken })}`, {}, 'Instagram').catch((e) => ({ error: e.message }));
      stats.instagram = ig.error ? { error: ig.error } : { name: `@${ig.username}`, followers: ig.followers_count ?? null, posts: ig.media_count ?? null };
    }
    return { rows, stats };
  },
};

// ------------------------------------------------------------------ Google Ads

async function googleToken({ config, secrets, fetch }) {
  const body = await call(fetch, 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: qs({ grant_type: 'refresh_token', client_id: config.clientId, client_secret: secrets.clientSecret, refresh_token: secrets.refreshToken }),
  }, 'Google sign-in');
  return body.access_token;
}
async function gaql(ctx, query) {
  const { config, secrets, fetch } = ctx;
  const token = await googleToken(ctx);
  const chunks = await call(fetch, `https://googleads.googleapis.com/${config.apiVersion || 'v21'}/customers/${config.customerId}/googleAds:searchStream`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'developer-token': secrets.developerToken,
      'content-type': 'application/json',
      ...(config.loginCustomerId ? { 'login-customer-id': config.loginCustomerId } : {}),
    },
    body: JSON.stringify({ query }),
  }, 'Google Ads');
  return (Array.isArray(chunks) ? chunks : [chunks]).flatMap((c) => c.results || []);
}

const google = {
  async test(ctx) {
    const [r] = await gaql(ctx, 'SELECT customer.descriptive_name, customer.currency_code, customer.time_zone FROM customer LIMIT 1');
    return { name: r?.customer?.descriptiveName || ctx.config.customerId, currency: r?.customer?.currencyCode, timezone: r?.customer?.timeZone, active: true };
  },
  async sync(ctx, { since, until }) {
    const results = await gaql(ctx, `SELECT segments.date, segments.ad_network_type, campaign.id, campaign.name, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions FROM campaign WHERE segments.date BETWEEN '${since}' AND '${until}' AND metrics.impressions > 0`);
    const rows = results.map((r) => ({
      date: r.segments.date,
      channel: /YOUTUBE/.test(r.segments.adNetworkType || '') ? 'youtube' : 'google',
      campaign: r.campaign.name,
      campaignId: String(r.campaign.id),
      spend: Number(r.metrics.costMicros || 0) / 1e6,
      impressions: r.metrics.impressions,
      clicks: r.metrics.clicks,
      results: Math.round(Number(r.metrics.conversions || 0)),
    }));
    return { rows, stats: {} };
  },
};

// ------------------------------------------------------------------ TikTok

const TIKTOK = 'https://business-api.tiktok.com/open_api/v1.3';
async function tiktokGet({ secrets, fetch }, path, params) {
  const body = await call(fetch, `${TIKTOK}${path}?${qs(params)}`, { headers: { 'Access-Token': secrets.accessToken } }, 'TikTok');
  if (body.code !== 0) throw new PlatformError(`TikTok: ${body.message || `error ${body.code}`}`);
  return body.data;
}
const tiktok = {
  async test(ctx) {
    const data = await tiktokGet(ctx, '/advertiser/info/', { advertiser_ids: JSON.stringify([ctx.config.advertiserId]), fields: JSON.stringify(['name', 'currency', 'timezone', 'status']) });
    const a = data.list?.[0] || {};
    return { name: a.name || ctx.config.advertiserId, currency: a.currency, timezone: a.timezone, active: a.status === 'STATUS_ENABLE' };
  },
  async sync(ctx, { since, until }) {
    const rows = [];
    for (let page = 1, pages = 1; page <= pages && page <= 20; page += 1) {
      const data = await tiktokGet(ctx, '/report/integrated/get/', {
        advertiser_id: ctx.config.advertiserId,
        report_type: 'BASIC',
        data_level: 'AUCTION_CAMPAIGN',
        dimensions: JSON.stringify(['campaign_id', 'stat_time_day']),
        metrics: JSON.stringify(['campaign_name', 'spend', 'impressions', 'clicks', 'reach', 'conversion']),
        start_date: since,
        end_date: until,
        page,
        page_size: 1000,
      });
      pages = data.page_info?.total_page || 1;
      for (const r of data.list || []) {
        rows.push({ date: String(r.dimensions.stat_time_day).slice(0, 10), channel: 'tiktok', campaign: r.metrics.campaign_name, campaignId: r.dimensions.campaign_id, spend: r.metrics.spend, impressions: r.metrics.impressions, clicks: r.metrics.clicks, reach: r.metrics.reach, results: r.metrics.conversion });
      }
    }
    return { rows, stats: {} };
  },
};

// ------------------------------------------------------------------ YouTube

const youtube = {
  async test(ctx) {
    const s = await youtube.channel(ctx);
    return { name: s.name, active: true };
  },
  async channel({ config, secrets, fetch }) {
    const body = await call(fetch, `https://www.googleapis.com/youtube/v3/channels?${qs({ part: 'snippet,statistics', id: config.channelId, key: secrets.apiKey })}`, {}, 'YouTube');
    const c = body.items?.[0];
    if (!c) throw new PlatformError('YouTube: no channel with that ID.');
    return { name: c.snippet.title, followers: c.statistics.hiddenSubscriberCount ? null : Number(c.statistics.subscriberCount), views: Number(c.statistics.viewCount), posts: Number(c.statistics.videoCount) };
  },
  async sync(ctx) {
    return { rows: [], stats: { youtube: await youtube.channel(ctx) } };
  },
};

// ------------------------------------------------------------------ WhatsApp

const whatsapp = {
  async test(ctx) {
    const n = await whatsapp.number(ctx);
    return { name: `${n.verified_name} (${n.display_phone_number})`, active: true };
  },
  number: ({ config, secrets, fetch }) => call(fetch, `${GRAPH}/${encodeURIComponent(config.phoneNumberId)}?${qs({ fields: 'display_phone_number,verified_name,quality_rating,messaging_limit_tier', access_token: secrets.accessToken })}`, {}, 'WhatsApp'),
  async sync(ctx) {
    const n = await whatsapp.number(ctx);
    const t = await call(ctx.fetch, `${GRAPH}/${encodeURIComponent(ctx.config.wabaId)}/message_templates?${qs({ fields: 'name,status,category,language', limit: 200, access_token: ctx.secrets.accessToken })}`, {}, 'WhatsApp templates').catch((e) => ({ error: e.message }));
    const templates = (t.data || []).map((x) => ({ name: x.name, status: x.status, category: x.category, language: x.language }));
    return { rows: [], stats: { whatsapp: { name: `${n.verified_name} · ${n.display_phone_number}`, quality: n.quality_rating || '', limit: n.messaging_limit_tier || '', templates, approved: templates.filter((x) => x.status === 'APPROVED').length, ...(t.error ? { error: t.error } : {}) } } };
  },
  // Sends an approved template (hello_world by default) to one number, to prove the setup works.
  async sendTest({ config, secrets, fetch }, { to, template = 'hello_world', language = 'en_US' }) {
    const digits = String(to || '').replace(/\D/g, '');
    if (digits.length < 8) throw new PlatformError('Type the number with its country code, like 8801712345678.');
    const body = await call(fetch, `${GRAPH}/${encodeURIComponent(config.phoneNumberId)}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secrets.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: digits, type: 'template', template: { name: template, language: { code: language } } }),
    }, 'WhatsApp');
    return { id: body.messages?.[0]?.id || null };
  },
};

// ------------------------------------------------------------------ WeChat

async function wechatToken({ config, secrets, fetch }) {
  const body = await call(fetch, `https://api.weixin.qq.com/cgi-bin/token?${qs({ grant_type: 'client_credential', appid: config.appId, secret: secrets.appSecret })}`, {}, 'WeChat');
  if (!body.access_token) throw new PlatformError(`WeChat: ${body.errmsg || `error ${body.errcode}`}${body.errcode === 40164 ? ' (add Lyrsoft’s server IP to the IP whitelist)' : ''}`);
  return body.access_token;
}
async function wechatPost(ctx, token, path, payload) {
  const body = await call(ctx.fetch, `https://api.weixin.qq.com/datacube/${path}?access_token=${encodeURIComponent(token)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }, 'WeChat');
  if (body.errcode) throw new PlatformError(`WeChat: ${body.errmsg || `error ${body.errcode}`}`);
  return body.list || [];
}
const wechat = {
  async test(ctx) {
    await wechatToken(ctx);
    return { name: ctx.config.appId, active: true };
  },
  async sync(ctx, { until }) {
    const token = await wechatToken(ctx);
    // WeChat's analytics run a day behind and take at most 7 days per call.
    const end = new Date(Date.parse(`${until}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
    const start = new Date(Date.parse(`${end}T00:00:00Z`) - 6 * 86400000).toISOString().slice(0, 10);
    const cumulate = await wechatPost(ctx, token, 'getusercumulate', { begin_date: start, end_date: end });
    const summary = await wechatPost(ctx, token, 'getusersummary', { begin_date: start, end_date: end });
    const last = cumulate.at(-1);
    return { rows: [], stats: { wechat: { name: ctx.config.appId, followers: last ? Number(last.cumulate_user) : null, gained7d: summary.reduce((s, x) => s + Number(x.new_user || 0), 0), lost7d: summary.reduce((s, x) => s + Number(x.cancel_user || 0), 0) } } };
  },
};

// ------------------------------------------------------------------ Telegram

async function telegramCall({ secrets, fetch }, method, params) {
  const body = await call(fetch, `https://api.telegram.org/bot${secrets.botToken}/${method}?${qs(params)}`, {}, 'Telegram');
  if (!body.ok) throw new PlatformError(`Telegram: ${body.description || 'error'}`);
  return body.result;
}
const telegram = {
  async test(ctx) {
    const chat = await telegramCall(ctx, 'getChat', { chat_id: ctx.config.chatId });
    return { name: chat.title || chat.username || ctx.config.chatId, active: true };
  },
  async sync(ctx) {
    const chat = await telegramCall(ctx, 'getChat', { chat_id: ctx.config.chatId });
    const members = await telegramCall(ctx, 'getChatMemberCount', { chat_id: ctx.config.chatId });
    return { rows: [], stats: { telegram: { name: chat.title || ctx.config.chatId, followers: Number(members) } } };
  },
};

export const CONNECTORS = { meta, google, tiktok, youtube, whatsapp, wechat, telegram };
