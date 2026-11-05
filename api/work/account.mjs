// Lyrsoft accounts: profile rows, mobile number verification, and the emails the work API sends
// through Amazon SES (the welcome email for a new account and the product updates the super admin
// sends from the admin console). Pure helpers only; the routes live in index.mjs.
//
// Profile rows sit in the work table: PK "PROFILE#<cognito sub>", SK "META", listed through
// GSI1 ("PROFILE" / email). Mobile codes are texted through Amazon SNS; only an HMAC of the code is
// stored, with an expiry and an attempt count. Every update email carries a signed unsubscribe link
// (GET /public/unsubscribe), so no one has to sign in to stop them.
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

export const CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_CODE_ATTEMPTS = 5;
export const SMS_PER_USER_PER_DAY = 5;
export const SMS_SITE_PER_DAY = 200;
export const NAME_MAX = 120;
export const UPDATE_SUBJECT_MAX = 150;
export const UPDATE_MESSAGE_MAX = 5000;
export const UPDATES_KEPT = 20;

export const profileKey = (userId) => ({ PK: `PROFILE#${userId}`, SK: 'META' });

// ------------------------------------------------------------------ mobile numbers

// "+91 98765-43210" → "+919876543210". E.164: a "+", then 8 to 15 digits not starting with 0.
export function normalizePhone(input) {
  if (typeof input !== 'string') return null;
  const compact = input.trim().replace(/[\s().-]/g, '').replace(/^00/, '+');
  return /^\+[1-9]\d{7,14}$/.test(compact) ? compact : null;
}

export const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

export const hashCode = (secret, userId, phone, code) =>
  createHmac('sha256', secret).update(`phone:${userId}:${phone}:${code}`).digest('base64url');

export const smsMessage = (code) => `${code} is your Lyrsoft verification code. It expires in 10 minutes. Don't share it with anyone.`;

// Checks `code` against the pending verification on `profile`. Returns { ok, phone } or
// { error: [status, message], wrong? }.
export function checkCode(secret, profile, code, now = Date.now()) {
  const pending = profile?.phonePending;
  if (!pending?.phone || !pending.hash) return { error: [400, 'Send a code to your number first.'] };
  if (now > pending.expiresAt) return { error: [400, 'That code has expired. Send a new one.'] };
  if ((pending.attempts || 0) >= MAX_CODE_ATTEMPTS) return { error: [429, 'Too many wrong codes. Send a new one.'] };
  if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) return { error: [400, 'Enter the 6-digit code.'] };
  const expected = Buffer.from(pending.hash);
  const given = Buffer.from(hashCode(secret, profile.userId, pending.phone, code.trim()));
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { error: [400, 'That code isn’t right.'], wrong: true };
  return { ok: true, phone: pending.phone };
}

// Shows only the first and last digits of a number to admins.
export const maskPhone = (phone) => (phone ? `${phone.slice(0, 3)}••••${phone.slice(-3)}` : null);

// ------------------------------------------------------------------ profile shapes

// What the signed-in person sees about their own account.
export function selfProfile(profile, role) {
  return {
    userId: profile.userId,
    email: profile.email ?? null,
    name: profile.name ?? null,
    provider: profile.provider ?? null,
    role,
    emailVerified: true, // only verified emails get this far (see emailTrusted in roles.mjs)
    phone: profile.phoneVerified ? profile.phone ?? null : null,
    phoneVerified: Boolean(profile.phoneVerified && profile.phone),
    phonePending: profile.phonePending?.expiresAt > Date.now() ? profile.phonePending.phone : null,
    emailUpdates: profile.emailUpdates !== false,
    welcomeSentAt: profile.welcomeSentAt ?? null,
    createdAt: profile.createdAt ?? null,
    lastLoginAt: profile.lastLoginAt ?? null,
  };
}

// What admins see in the admin console.
export function adminProfile(profile, role) {
  return {
    userId: profile.userId,
    email: profile.email ?? null,
    name: profile.name ?? null,
    provider: profile.provider ?? null,
    role,
    disabled: profile.disabled === true && role !== 'superadmin',
    phone: profile.phoneVerified ? maskPhone(profile.phone) : null,
    emailUpdates: profile.emailUpdates !== false,
    createdAt: profile.createdAt ?? null,
    lastLoginAt: profile.lastLoginAt ?? null,
  };
}

// Returns [statusCode, message] when someone may not make `changes` to their own profile, else null.
export function selfUpdateError(changes) {
  const keys = Object.keys(changes || {});
  if (!keys.length) return [400, 'Nothing to change.'];
  const unknown = keys.find((key) => !['name', 'emailUpdates'].includes(key));
  if (unknown) return [400, `Unknown field "${unknown}".`];
  if ('name' in changes) {
    const name = typeof changes.name === 'string' ? changes.name.trim() : '';
    if (!name || name.length > NAME_MAX) return [400, `Name must be 1 to ${NAME_MAX} characters.`];
  }
  if ('emailUpdates' in changes && typeof changes.emailUpdates !== 'boolean') return [400, '"emailUpdates" must be true or false.'];
  return null;
}

// ------------------------------------------------------------------ emails

const BRAND = '#5034ff';
const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

// Plain text → HTML paragraphs, with bare https links made clickable.
function textToHtml(text) {
  return String(text)
    .trim()
    .split(/\n{2,}/)
    .map((paragraph) =>
      `<p style="margin:0 0 16px">${escapeHtml(paragraph)
        .replace(/https:\/\/[^\s<]+[^\s<.,;:!?)]/g, (url) => `<a href="${url}" style="color:${BRAND}">${url}</a>`)
        .replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function layout(siteUrl, { heading, bodyHtml, footerHtml }) {
  return `<!doctype html><html><body style="margin:0;background:#f4f4fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#15172a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4fa;padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;border:1px solid #e4e5ef">
<tr><td style="padding:26px 32px 0"><table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td><img src="${siteUrl}/brand/icon-192.png" width="36" height="36" alt="" style="display:block;border-radius:9px"></td>
<td style="padding-left:10px;font-size:20px;font-weight:700;color:#15172a">Lyrsoft</td></tr></table></td></tr>
<tr><td style="padding:20px 32px 8px;font-size:15px;line-height:1.6">
<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#15172a">${escapeHtml(heading)}</h1>
${bodyHtml}
</td></tr>
<tr><td style="padding:16px 32px 28px;font-size:12px;line-height:1.5;color:#5d6178;border-top:1px solid #eeeff5">${footerHtml}</td></tr>
</table></td></tr></table></body></html>`;
}

const button = (href, label) =>
  `<p style="margin:24px 0"><a href="${href}" style="display:inline-block;background:${BRAND};color:#ffffff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:10px">${escapeHtml(label)}</a></p>`;

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';

export function welcomeEmail({ name }, siteUrl) {
  const hello = firstName(name) ? `Welcome to Lyrsoft, ${firstName(name)}` : 'Welcome to Lyrsoft';
  const app = `${siteUrl}/app/`;
  const text = `${hello}!

Your Lyrsoft account is ready. Here's how to get going:

1. Create a workspace for your team or a client: ${app}
2. Add a board and track work in a table or on a kanban board
3. Invite your team by email from Team & settings
4. Verify your mobile number in your profile: ${app}#/profile

Questions? Just reply to this email or write to hello@lyrsoft.com.

— The Lyrsoft team

You're getting this one-off email because you created a Lyrsoft account.`;
  const html = layout(siteUrl, {
    heading: `${hello}!`,
    bodyHtml: `<p style="margin:0 0 16px">Your Lyrsoft account is ready. Here’s how to get going:</p>
<ol style="margin:0 0 16px;padding-left:20px">
<li>Create a workspace for your team or a client</li>
<li>Add a board and track work in a table or on a kanban board</li>
<li>Invite your team by email from Team &amp; settings</li>
<li>Verify your mobile number in your profile</li>
</ol>
${button(app, 'Open Lyrsoft Work')}
<p style="margin:0">Questions? Just reply to this email or write to <a href="mailto:hello@lyrsoft.com" style="color:${BRAND}">hello@lyrsoft.com</a>.</p>
<p style="margin:16px 0 0">— The Lyrsoft team</p>`,
    footerHtml: 'You’re getting this one-off email because you created a Lyrsoft account.',
  });
  return { subject: hello, text, html };
}

export function updateEmail({ subject, message, unsubscribeUrl }, siteUrl) {
  const settings = `${siteUrl}/app/#/profile`;
  const text = `${message.trim()}

— The Lyrsoft team

Don't want product updates? Unsubscribe: ${unsubscribeUrl}
Or turn them off in your profile: ${settings}`;
  const html = layout(siteUrl, {
    heading: subject,
    bodyHtml: `${textToHtml(message)}<p style="margin:0">— The Lyrsoft team</p>`,
    footerHtml: `You’re getting this because you have a Lyrsoft account with product updates turned on.
<a href="${unsubscribeUrl}" style="color:#5d6178">Unsubscribe</a> or change it in <a href="${settings}" style="color:#5d6178">your profile</a>.`,
  });
  return { subject, text, html };
}

// Returns [statusCode, message] when an update email can't be sent as given, else null.
export function updateEmailError(body) {
  if (body?.updateId !== undefined) return /^[0-9a-z-]{8,64}$/.test(String(body.updateId)) ? null : [400, 'Invalid updateId.'];
  const subject = typeof body?.subject === 'string' ? body.subject.trim() : '';
  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  if (!subject || subject.length > UPDATE_SUBJECT_MAX) return [400, `Subject must be 1 to ${UPDATE_SUBJECT_MAX} characters.`];
  if (!message || message.length > UPDATE_MESSAGE_MAX) return [400, `Message must be 1 to ${UPDATE_MESSAGE_MAX} characters.`];
  return null;
}

// Who an update goes to: everyone with an email who hasn't switched updates off or been disabled.
export const updateRecipients = (profiles) => profiles.filter((p) => p.email && p.emailUpdates !== false && p.disabled !== true);

// Unsubscribe links: /public/unsubscribe?u=<userId>&t=<HMAC of the userId>.
export const unsubscribeToken = (secret, userId) => createHmac('sha256', secret).update(`unsubscribe:${userId}`).digest('base64url');

export function validUnsubscribeToken(secret, userId, token) {
  if (!secret || !userId || typeof token !== 'string') return false;
  const expected = Buffer.from(unsubscribeToken(secret, userId));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// state: "confirm" (a button that POSTs to `action`), "done" or "invalid".
export function unsubscribePage(state, siteUrl, action = '') {
  const settings = button(`${siteUrl}/app/#/profile`, 'Email settings');
  const pages = {
    confirm: ['Unsubscribe from Lyrsoft updates?', `<p style="margin:0 0 16px">You’ll stop getting product update emails. Emails about your account and security still arrive.</p>
<form method="post" action="${escapeHtml(action)}" style="margin:24px 0"><button type="submit" style="background:${BRAND};color:#ffffff;border:0;font:inherit;font-weight:600;padding:12px 20px;border-radius:10px;cursor:pointer">Unsubscribe</button></form>`],
    done: ['You’re unsubscribed', `<p style="margin:0 0 16px">You won’t get Lyrsoft product updates any more. Emails about your account and security still arrive.</p>${settings}`],
    invalid: ['This link didn’t work', `<p style="margin:0 0 16px">The unsubscribe link is incomplete or out of date. You can turn updates off in your profile.</p>${settings}`],
  };
  const [heading, bodyHtml] = pages[state] || pages.invalid;
  return layout(siteUrl, { heading, bodyHtml, footerHtml: `Lyrsoft · <a href="${siteUrl}" style="color:#5d6178">lyrsoft.com</a>` });
}
