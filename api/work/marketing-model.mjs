// Lyrsoft Marketing: pure rules behind the marketing routes (marketing.mjs), tested in
// marketing.test.mjs. Subscribers, campaigns, signup forms and settings are validated here; so are
// who a campaign goes to, the signed tracking/unsubscribe links, and the sender address.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { extractLinks, safeUrl } from '../../lyrsoft/marketing-email.js';
import { ValidationError } from './model.mjs';

export const SUBSCRIBERS_MAX = 50_000; // per workspace
export const IMPORT_BATCH_MAX = 1000; // subscribers per import request (the app sends big lists in chunks)
export const BULK_MAX = 1000;
export const TAGS_MAX = 20;
export const CAMPAIGNS_MAX = 500;
export const FORMS_MAX = 50;
export const BODY_MAX = 50_000;
export const TEST_SENDS_PER_DAY = 50; // per workspace
// Emails a workspace may send per day. Staff workspaces get more; SES allows 50,000 a day account-wide.
export const DAILY_LIMIT = 2_000;
export const STAFF_DAILY_LIMIT = 40_000;
export const SUBSCRIBES_PER_IP_PER_HOUR = 10;
export const SUBSCRIBES_PER_FORM_PER_DAY = 2_000;

export const STATUSES = ['subscribed', 'unsubscribed', 'bounced', 'complained'];
export const CAMPAIGN_STATUSES = ['draft', 'scheduled', 'sending', 'sent', 'cancelled'];
export const STAT_KEYS = ['recipients', 'sent', 'failed', 'opens', 'uniqueOpens', 'clicks', 'uniqueClicks', 'unsubscribes', 'bounces', 'complaints'];

const EMAIL_RE = /^[^\s@<>(),;:"]{1,64}@[^\s@<>(),;:"]{1,190}\.[^\s@<>(),;:"]{2,63}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const LOCAL_RE = /^[a-z0-9][a-z0-9._+-]{0,63}$/i;

const fail = (message) => {
  throw new ValidationError(message);
};
const text = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const multiline = (value, max) => String(value ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim().slice(0, max);
const list = (value) => (Array.isArray(value) ? value : value == null || value === '' ? [] : String(value).split(','));

export const cleanEmail = (value) => text(value, 254).toLowerCase().replace(/^mailto:/, '');
export const validEmail = (email) => EMAIL_RE.test(email);
export const cleanTags = (value) => [...new Set(list(value).map((t) => text(t, 40)).filter(Boolean))].slice(0, TAGS_MAX);

// ------------------------------------------------------------------ subscribers

// A subscriber typed in or imported. Throws on a missing or bad email.
export function cleanSubscriber(input) {
  if (!input || typeof input !== 'object') fail('Send a subscriber.');
  const email = cleanEmail(input.email);
  if (!validEmail(email)) fail(email ? `“${email}” isn’t an email address.` : 'Enter an email address.');
  return { email, name: text(input.name, 120), tags: cleanTags(input.tags) };
}

// Merges imported people into the list. Existing people keep their status (an unsubscribe is never
// undone by an import) and gain any new name and tags. Returns rows to write and counts.
export function planSubscriberImport(existing, incoming, { tags = [], source = 'import', at }) {
  const byEmail = new Map(existing.map((s) => [s.email, s]));
  const writes = new Map();
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  for (const person of incoming) {
    const current = writes.get(person.email) || byEmail.get(person.email);
    const mergedTags = cleanTags([...(current?.tags || []), ...person.tags, ...tags]);
    if (!current) {
      writes.set(person.email, { email: person.email, name: person.name, tags: mergedTags, status: 'subscribed', source, createdAt: at, updatedAt: at });
      created += 1;
      continue;
    }
    const name = current.name || person.name;
    if (name === current.name && mergedTags.length === current.tags.length) {
      if (!writes.has(person.email)) unchanged += 1;
      continue;
    }
    if (!writes.has(person.email) && byEmail.has(person.email)) updated += 1;
    writes.set(person.email, { ...current, name, tags: mergedTags, updatedAt: at });
  }
  return { rows: [...writes.values()], created, updated, unchanged };
}

// ------------------------------------------------------------------ audiences

// audience: { tags: [] } — everyone subscribed, or those with any of the tags.
export function cleanAudience(input) {
  return { tags: cleanTags(input?.tags) };
}

export function audienceOf(subscribers, audience) {
  const tags = audience?.tags || [];
  return subscribers.filter((s) => s.status === 'subscribed' && (!tags.length || s.tags?.some((t) => tags.includes(t))));
}

// ------------------------------------------------------------------ campaigns

export function cleanCampaign(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object') fail('Send a campaign.');
  const out = {};
  if (!partial || 'name' in input) out.name = text(input.name, 120) || 'Untitled campaign';
  if (!partial || 'subject' in input) out.subject = text(input.subject, 200);
  if (!partial || 'preheader' in input) out.preheader = text(input.preheader, 200);
  if (!partial || 'body' in input) {
    out.body = multiline(input.body, BODY_MAX + 1);
    if (out.body.length > BODY_MAX) fail(`The email is too long (at most ${BODY_MAX.toLocaleString('en')} characters).`);
  }
  if (!partial || 'audience' in input) out.audience = cleanAudience(input.audience);
  return out;
}

// What must be true before a campaign can be sent or scheduled.
export function readyToSendError(campaign, settings) {
  if (!campaign.subject) return 'Add a subject line.';
  if (!campaign.body || campaign.body.length < 10) return 'Write the email first.';
  if (!settings?.fromName) return 'Set the sender name in Marketing settings.';
  if (!settings?.address) return 'Add your postal address in Marketing settings (the law in most countries requires it in marketing email).';
  return null;
}

export const campaignLinks = (campaign) => extractLinks(campaign.body).slice(0, 200);

export function campaignStats(row) {
  const stats = Object.fromEntries(STAT_KEYS.map((k) => [k, Number(row[`s_${k}`] || 0)]));
  stats.linkClicks = (row.links || []).map((url, i) => ({ url, clicks: Number(row[`s_link${i}`] || 0) }));
  return stats;
}

// ------------------------------------------------------------------ settings

// Sender settings for a workspace. `domains` are the verified SES domains; only staff may send from
// them directly. Everyone else sends from `defaultFrom` with their name and their own reply-to.
export function cleanSettings(input, { staff = false, domains = [] } = {}) {
  if (!input || typeof input !== 'object') fail('Send the settings.');
  const fromName = text(input.fromName, 80);
  if (!fromName) fail('Enter the sender name people will see.');
  if (/[<>"@]/.test(fromName)) fail('The sender name can’t contain <, >, " or @.');
  const replyTo = cleanEmail(input.replyTo);
  if (replyTo && !validEmail(replyTo)) fail('The reply-to address isn’t an email address.');
  let fromEmail = '';
  if (staff && input.fromEmail) {
    fromEmail = cleanEmail(input.fromEmail);
    const [local, domain] = fromEmail.split('@');
    if (!LOCAL_RE.test(local || '') || !domains.includes(domain)) fail(`Send from an address at ${domains.join(', ')}.`);
  }
  const color = COLOR_RE.test(input.color || '') ? input.color.toLowerCase() : '#5034ff';
  const logoUrl = text(input.logoUrl, 500);
  if (logoUrl && !/^https:\/\/\S+$/i.test(logoUrl)) fail('The logo must be an https:// image link.');
  return { fromName, fromEmail, replyTo, address: multiline(input.address, 300), color, logoUrl };
}

export function senderFor(settings, defaultFrom) {
  const address = settings.fromEmail || defaultFrom;
  return { name: settings.fromName, address };
}

// ------------------------------------------------------------------ signup forms

export function cleanForm(input) {
  if (!input || typeof input !== 'object') fail('Send a form.');
  const redirectUrl = text(input.redirectUrl, 500);
  if (redirectUrl && !/^https:\/\/\S+$/i.test(redirectUrl)) fail('The thank-you page must be an https:// link.');
  return {
    name: text(input.name, 80) || 'Signup form',
    title: text(input.title, 120) || 'Join our newsletter',
    description: multiline(input.description, 600),
    buttonLabel: text(input.buttonLabel, 40) || 'Subscribe',
    successMessage: text(input.successMessage, 300) || 'Thanks! You’re subscribed.',
    askName: input.askName !== false,
    tags: cleanTags(input.tags),
    redirectUrl,
    consent: text(input.consent, 300),
  };
}

// A submission from a public signup form. Returns null for a bot (the hidden "website" field).
export function cleanSignup(body) {
  if (text(body?.website, 200)) return null;
  const email = cleanEmail(body?.email);
  if (!validEmail(email)) fail('Please enter a valid email address.');
  return { email, name: text(body?.name, 120) };
}

// ------------------------------------------------------------------ signed links

const encodeEmail = (email) => Buffer.from(email).toString('base64url');
export const decodeEmail = (value) => {
  try {
    const email = Buffer.from(String(value || ''), 'base64url').toString('utf8');
    return validEmail(email) ? email : null;
  } catch {
    return null;
  }
};

export const linkToken = (secret, ws, campaignId, email) =>
  createHmac('sha256', secret).update(`mkt:${ws}:${campaignId}:${email}`).digest('base64url').slice(0, 24);

export function validLinkToken(secret, ws, campaignId, email, token) {
  if (!secret || typeof token !== 'string') return false;
  const expected = Buffer.from(linkToken(secret, ws, campaignId, email));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// The per-recipient links in a campaign email.
export function recipientUrls(base, secret, ws, campaignId, email, links) {
  const q = `w=${encodeURIComponent(ws)}&c=${encodeURIComponent(campaignId)}&e=${encodeEmail(email)}&t=${linkToken(secret, ws, campaignId, email)}`;
  return {
    unsubscribe: `${base}/public/m/unsubscribe?${q}`,
    pixel: `${base}/public/m/open?${q}`,
    link: (url) => {
      const index = links.indexOf(url);
      return index === -1 ? url : `${base}/public/m/click?${q}&l=${index}`;
    },
  };
}

// Reads w, c, e, t (and l) from a public link's query string; null when anything is off.
export function readLinkParams(params, secret) {
  const ws = params.get('w') || '';
  const campaignId = params.get('c') || '';
  const email = decodeEmail(params.get('e'));
  if (!/^[A-Za-z0-9_-]{1,24}$/.test(ws) || !/^[A-Za-z0-9_-]{0,24}$/.test(campaignId) || !email) return null;
  if (!validLinkToken(secret, ws, campaignId, email, params.get('t'))) return null;
  const l = params.get('l');
  return { ws, campaignId, email, linkIndex: l != null && /^\d{1,3}$/.test(l) ? Number(l) : null };
}

// Redirect target for a click: only links that are in the campaign, so it's never an open redirect.
export const clickTarget = (links, index) => (index != null && links?.[index] ? safeUrl(links[index]) : '');
