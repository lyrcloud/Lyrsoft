// Lyrsoft work API: workspaces, members, boards, items and item updates (comments).
// Every route sits behind a Cognito JWT authorizer (same user pool as Lyrcloud).
//
// Single DynamoDB table, keys:
//   WS#<ws>     META               workspace          GSI1: WORKSPACE / <createdAt>#<ws>
//   WS#<ws>     MEMBER#<email>     membership         GSI1: USER#<email> / WS#<ws>
//   WS#<ws>     BOARD#<board>      board (columns, groups)
//   BOARD#<b>   ITEM#<item>        item
//   ITEM#<i>    UPDATE#<iso>#<id>  item update (comment)
//   CONFIG      LEADS              where website enquiries go: { wsId, boardId }
//   RATE#contact#<ip>  <hour>      contact form submissions per IP per hour (expires via TTL)
//   RATE#lyrbot#<ip>   <hour>      Lyrbot questions per IP per hour (expires via TTL)
//   RATE#lyrbot#all    <day>       Lyrbot questions for the whole site per day (expires via TTL)
//
//   PROFILE#<sub> META             Lyrsoft account profile GSI1: PROFILE / <email>
//   CONFIG      UPDATES            product update emails sent so far (newest first)
//   RATE#sms#<sub> | RATE#sms#all  <day>   mobile codes texted (expires via TTL)
//   CONTACTS#<sub> C#<id>          a contact in someone's address book (contacts.mjs)
//   MKT#<ws> …, MKTC#<campaign> …   Lyrsoft Marketing: subscribers, campaigns, forms (marketing.mjs)
//
// Members are keyed by email, so people can be invited before they first sign in. Emails are
// only trusted from Google sign-ins and from email-and-password accounts that confirmed theirs
// with a code (roles.mjs emailTrusted); GitHub passes through whatever GitHub reports, so it's
// refused.
//
// Public routes: POST /public/contact, the lyrsoft.com contact form (each enquiry becomes an
// item on the "Website leads" board and a conversation in the hello@lyrsoft.com Lyrsoft Mail inbox),
// POST /public/lyrbot, the site's help assistant (lyrbot.mjs), POST /public/call ("Decline" on a
// Lyr Chat call notification, signed per call and person), and GET|POST /public/unsubscribe,
// the signed link in product update emails. Lyrsoft Marketing adds /public/m/open|click|unsubscribe
// (campaign tracking and unsubscribe links) and /public/subscribe (signup forms), served through
// lyrsoft.com/public/*, and handles non-HTTP events: its own background sends, the one-minute tick
// and SES bounce/complaint notifications (marketing.mjs).
//
// Accounts (account.mjs): GET /me creates or refreshes the caller's profile (a new one gets the
// welcome email); PATCH /me/profile, POST /me/phone, POST /me/phone/verify and DELETE /me/phone edit
// it. Admin console: GET /admin/users, PATCH /admin/users/{id} (role, disabled), GET|POST
// /admin/updates (product update emails, sent by the super admin).
import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { ChimeSDKMeetingsClient } from '@aws-sdk/client-chime-sdk-meetings';
import { AdminGetUserCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { S3Client } from '@aws-sdk/client-s3';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { emailTrusted, isStaff, providerFromUsername, roleFor, userUpdateError } from '../account/roles.mjs';
import { buildRawEmail, canUseMailbox, mailDomains } from '../mail/model.mjs';
import {
  adminProfile,
  checkCode,
  CODE_TTL_MS,
  hashCode,
  newCode,
  normalizePhone,
  profileKey,
  selfProfile,
  selfUpdateError,
  SMS_PER_USER_PER_DAY,
  SMS_SITE_PER_DAY,
  smsMessage,
  unsubscribePage,
  unsubscribeToken,
  updateEmail,
  updateEmailError,
  updateRecipients,
  UPDATES_KEPT,
  validUnsubscribeToken,
  welcomeEmail,
} from './account.mjs';
import { registerMailRoutes } from '../mail/routes.mjs';
import { createMailStore } from '../mail/store.mjs';
import { channelId, registerCollabRoutes } from './collab.mjs';
import { registerContactRoutes } from './contacts.mjs';
import { createPush } from './push.mjs';
import { registerMarketingRoutes } from './marketing.mjs';
import { CONTACT_LIMIT_PER_HOUR, cleanContact, contactSubject, contactText, leadsBoard, leadValues } from './leads.mjs';
import {
  cleanLyrbotMessages,
  LYRBOT_DAILY_LIMIT,
  LYRBOT_DAILY_MESSAGE,
  LYRBOT_FALLBACK_REPLY,
  LYRBOT_HOURLY_LIMIT,
  LYRBOT_HOURLY_MESSAGE,
  lyrbotReply,
} from './lyrbot.mjs';
import {
  can,
  cleanColumns,
  cleanGroups,
  cleanName,
  cleanValues,
  defaultBoard,
  effectiveRole,
  EMAIL_RE,
  ID_RE,
  memberChangeError,
  newId,
  ValidationError,
} from './model.mjs';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const TABLE = process.env.TABLE_NAME;
const ACCOUNTS_TABLE = process.env.ACCOUNTS_TABLE_NAME;
const SUPER_ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL || 'lyrclouds@gmail.com';
// Cognito Hosted UI domain; its userInfo endpoint turns an access token into the caller's profile.
const COGNITO_DOMAIN = process.env.COGNITO_DOMAIN || 'lyrcloud-auth.auth.us-east-1.amazoncognito.com';
const MAIL_BUCKET = process.env.MAIL_BUCKET;
const CONTACT_MAILBOX = (process.env.CONTACT_MAILBOX || 'hello@lyrsoft.com').toLowerCase();
const SITE_URL = (process.env.SITE_URL || 'https://lyrsoft.com').replace(/\/$/, '');
// Secrets Manager secret holding the Anthropic API key for Lyrbot; ANTHROPIC_API_KEY wins (local dev).
const ANTHROPIC_SECRET = process.env.ANTHROPIC_SECRET;
// Secrets Manager secret that signs unsubscribe links and mobile codes; APP_SECRET wins (local dev).
const APP_SECRET_NAME = process.env.APP_SECRET_NAME;
// SES sender for account emails, e.g. "Lyrsoft <no-reply@lyrsoft.com>"; without it none are sent.
const MAIL_FROM = process.env.MAIL_FROM;
const MAIL_REPLY_TO = process.env.MAIL_REPLY_TO;
const USER_POOL_ID = process.env.USER_POOL_ID;
// Lyrsoft Marketing: campaigns go out from MARKETING_FROM (unless staff pick another address on a mail
// domain) through the MARKETING_CONFIG_SET configuration set, whose bounces and complaints come back via
// SNS. Public links (tracking, unsubscribe, signup pages) use PUBLIC_BASE_URL, lyrsoft.com in production.
const MARKETING_FROM = process.env.MARKETING_FROM || 'campaigns@lyrsoft.com';
const MARKETING_CONFIG_SET = process.env.MARKETING_CONFIG_SET;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || SITE_URL).replace(/\/$/, '');
const s3 = new S3Client({});
const ses = new SESv2Client({});
const sns = new SNSClient({});
const cognito = new CognitoIdentityProviderClient({});
const mailStore = createMailStore({ ddb, s3, table: TABLE, bucket: MAIL_BUCKET });

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const json = (statusCode, body) => ({ statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const now = () => new Date().toISOString();

// ------------------------------------------------------------------ data access

const get = async (PK, SK) => (await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK, SK } }))).Item;
const put = (Item) => ddb.send(new PutCommand({ TableName: TABLE, Item }));
const del = (PK, SK) => ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK, SK } }));

async function queryAll(params) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(new QueryCommand({ TableName: TABLE, ...params, ExclusiveStartKey }));
    items.push(...(page.Items || []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

const queryPrefix = (PK, prefix) =>
  queryAll({
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: { ':pk': PK, ':sk': prefix },
  });

async function deleteKeys(keys) {
  for (let i = 0; i < keys.length; i += 25) {
    let RequestItems = { [TABLE]: keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } })) };
    while (RequestItems && Object.keys(RequestItems).length) {
      RequestItems = (await ddb.send(new BatchWriteCommand({ RequestItems }))).UnprocessedItems;
    }
  }
}

async function putMany(items) {
  for (let i = 0; i < items.length; i += 25) {
    let RequestItems = { [TABLE]: items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } })) };
    while (RequestItems && Object.keys(RequestItems).length) {
      RequestItems = (await ddb.send(new BatchWriteCommand({ RequestItems }))).UnprocessedItems;
    }
  }
}

async function deleteBoardData(boardId) {
  const items = await queryPrefix(`BOARD#${boardId}`, 'ITEM#');
  for (const item of items) {
    const updates = await queryPrefix(`ITEM#${item.itemId}`, 'UPDATE#');
    await deleteKeys(updates.map(({ PK, SK }) => ({ PK, SK })));
  }
  await deleteKeys(items.map(({ PK, SK }) => ({ PK, SK })));
}

// ------------------------------------------------------------------ caller identity

const identityCache = new Map(); // access token -> { identity, expires }

// The caller's Cognito attributes. Hosted UI tokens (Google) work with userInfo; tokens from the
// email-and-password form don't carry the openid scope, so those are read with AdminGetUser.
async function cognitoUser(token, username) {
  const res = await fetch(`https://${COGNITO_DOMAIN}/oauth2/userInfo`, { headers: { authorization: `Bearer ${token}` } });
  if (res.ok) return res.json();
  const detail = (await res.text()).slice(0, 300);
  if (username && USER_POOL_ID) {
    try {
      const { UserAttributes = [], Username } = await cognito.send(new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: username }));
      return { ...Object.fromEntries(UserAttributes.map(({ Name, Value }) => [Name, Value])), username: Username };
    } catch (error) {
      console.warn('AdminGetUser failed', error.name, error.message);
    }
  }
  console.warn('userInfo failed', res.status, detail);
  throw new HttpError(401, 'Your session has expired. Please sign in again.');
}

const getProfile = (userId) => get(profileKey(userId).PK, 'META');

async function identify(event) {
  const claims = event.requestContext?.authorizer?.jwt?.claims;
  if (!claims?.sub) throw new HttpError(401, 'unauthorized');
  const token = (event.headers?.authorization || '').replace(/^Bearer\s+/i, '');
  const cached = identityCache.get(token);
  if (cached && cached.expires > Date.now()) return cached.identity;

  // userInfo, not GetUser: GetUser needs the aws.cognito.signin.user.admin scope, which the app
  // client doesn't grant, so every call failed and signed-in users were sent back to sign in.
  const user = await cognitoUser(token, claims.username);
  // The provider comes from the username ("GoogleOIDC_123…"), in whatever case Cognito sends it.
  const provider = providerFromUsername(user.username || claims.username);
  const email = String(user.email || '').toLowerCase();
  if (!email || !emailTrusted(provider, user.email_verified)) {
    throw new HttpError(403, 'Please sign in with Google, or with an email address you’ve confirmed. GitHub sign-in isn’t supported in Lyrsoft.');
  }

  const [account, profile] = await Promise.all([
    ACCOUNTS_TABLE ? ddb.send(new GetCommand({ TableName: ACCOUNTS_TABLE, Key: { userId: claims.sub } })).then((r) => r.Item) : null,
    getProfile(claims.sub),
  ]);
  // Admins come from either Lyrcloud (the shared account row) or Lyrsoft's own admin console.
  const storedRole = account?.role === 'admin' || profile?.role === 'admin' ? 'admin' : 'user';
  const globalRole = roleFor({ provider, email, role: storedRole }, SUPER_ADMIN_EMAIL);
  if (profile?.disabled === true && globalRole !== 'superadmin') {
    throw new HttpError(403, 'This account has been disabled. Contact hello@lyrsoft.com.');
  }
  const providerName = user.name || '';
  const identity = {
    userId: claims.sub,
    email,
    provider,
    providerName,
    providerPicture: user.picture || null,
    name: (profile?.nameLocked ? profile.name : providerName || profile?.name) || '',
    globalRole,
  };
  identityCache.set(token, { identity, expires: Date.now() + 60_000 });
  if (identityCache.size > 500) identityCache.delete(identityCache.keys().next().value);
  return identity;
}

// Loads a workspace and the caller's role in it; 404s rather than revealing workspaces the caller can't see.
async function openWorkspace(me, wsId, ability = 'view') {
  if (!ID_RE.test(wsId)) throw new HttpError(404, 'Workspace not found.');
  const [workspace, membership] = await Promise.all([get(`WS#${wsId}`, 'META'), get(`WS#${wsId}`, `MEMBER#${me.email}`)]);
  const role = workspace ? effectiveRole(me.globalRole, membership?.role) : null;
  if (!role) throw new HttpError(404, 'Workspace not found.');
  if (!can(role, ability)) throw new HttpError(403, "You don't have permission to do that in this workspace.");
  return { workspace, role };
}

async function openBoard(wsId, boardId) {
  const board = ID_RE.test(boardId) ? await get(`WS#${wsId}`, `BOARD#${boardId}`) : null;
  if (!board) throw new HttpError(404, 'Board not found.');
  return board;
}

async function openItem(boardId, itemId) {
  const item = ID_RE.test(itemId) ? await get(`BOARD#${boardId}`, `ITEM#${itemId}`) : null;
  if (!item) throw new HttpError(404, 'Item not found.');
  return item;
}

// ------------------------------------------------------------------ shapes

const workspaceOut = (ws, role) => ({ id: ws.wsId, name: ws.name, ownerEmail: ws.ownerEmail, createdAt: ws.createdAt, role });
const memberOut = (m) => ({ email: m.email, role: m.role, name: m.name || '', addedAt: m.addedAt, joined: Boolean(m.userId) });
const boardOut = (b) => ({ id: b.boardId, name: b.name, description: b.description || '', columns: b.columns, groups: b.groups, createdAt: b.createdAt, updatedAt: b.updatedAt });
const boardSummary = (b) => ({ id: b.boardId, name: b.name, updatedAt: b.updatedAt });
const itemOut = (i) => ({ id: i.itemId, groupId: i.groupId, name: i.name, values: i.values || {}, position: i.position, createdAt: i.createdAt, updatedAt: i.updatedAt, updatedBy: i.updatedBy, updateCount: i.updateCount || 0 });
const updateOut = (u) => ({ id: u.updateId, body: u.body, authorEmail: u.authorEmail, authorName: u.authorName, createdAt: u.createdAt });

const memberRow = (wsId, wsName, email, role, extra = {}) => ({
  PK: `WS#${wsId}`,
  SK: `MEMBER#${email}`,
  GSI1PK: `USER#${email}`,
  GSI1SK: `WS#${wsId}`,
  wsId,
  wsName,
  email,
  role,
  ...extra,
});

async function createWorkspace({ name, ownerEmail, ownerUserId, ownerName, firstBoard }) {
  const wsId = newId();
  const createdAt = now();
  const workspace = { PK: `WS#${wsId}`, SK: 'META', GSI1PK: 'WORKSPACE', GSI1SK: `${createdAt}#${wsId}`, wsId, name, ownerEmail, createdAt };
  await put(workspace);
  await put(memberRow(wsId, name, ownerEmail, 'owner', { userId: ownerUserId, name: ownerName, addedAt: createdAt, addedBy: ownerEmail }));
  const boardId = newId();
  await put({ PK: `WS#${wsId}`, SK: `BOARD#${boardId}`, boardId, wsId, ...firstBoard, createdAt, updatedAt: createdAt, createdBy: ownerEmail });
  return { workspace, boardId };
}

// ------------------------------------------------------------------ routes

const routes = [];
const route = (method, pattern, fn) => {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/\{(\w+)\}/g, (_, key) => (keys.push(key), '([^/]+)'))}$`);
  routes.push({ method, re, keys, fn });
};

route('GET', '/me', async (me) => {
  // Mark pending invitations as joined, so owners can see who has signed in.
  const memberships = await queryAll({
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk',
    ExpressionAttributeValues: { ':pk': `USER#${me.email}` },
  });
  await Promise.all(
    memberships
      .filter((m) => !m.userId || m.name !== me.name)
      .map((m) => ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { PK: m.PK, SK: m.SK },
        UpdateExpression: 'SET userId = :u, #n = :n',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeNames: { '#n': 'name' },
        ExpressionAttributeValues: { ':u': me.userId, ':n': me.name },
      })).catch(() => {})),
  );

  let workspaces = memberships.map((m) => ({ id: m.wsId, name: m.wsName, role: effectiveRole(me.globalRole, m.role) }));
  if (me.globalRole === 'superadmin' || me.globalRole === 'admin') {
    const all = await queryAll({ IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :pk', ExpressionAttributeValues: { ':pk': 'WORKSPACE' } });
    const mine = new Map(workspaces.map((w) => [w.id, w]));
    workspaces = all.map((ws) => mine.get(ws.wsId) || { ...workspaceOut(ws, effectiveRole(me.globalRole, null)), staffAccess: true });
  }
  workspaces.sort((a, b) => a.name.localeCompare(b.name));
  const mailboxCount = (await mailStore.listMailboxes()).filter((m) => canUseMailbox(me, m)).length;
  const profile = await touchProfile(me);
  return { email: me.email, name: me.name, globalRole: me.globalRole, workspaces, mailboxCount, profile: selfProfile(profile, me.globalRole) };
});

// ------------------------------------------------------------------ accounts

let appSecret;
async function getAppSecret() {
  if (process.env.APP_SECRET) return process.env.APP_SECRET;
  if (!APP_SECRET_NAME) throw new HttpError(503, 'Account security isn’t set up yet (APP_SECRET_NAME).');
  appSecret ??= (await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: APP_SECRET_NAME }))).SecretString.trim();
  return appSecret;
}

async function sendAccountEmail(to, { subject, text, html }, headers = []) {
  if (!MAIL_FROM) throw new Error('MAIL_FROM is not set');
  const [, fromName = '', fromAddress = MAIL_FROM] = MAIL_FROM.match(/^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/) || [];
  const raw = buildRawEmail({
    from: { name: fromName, address: fromAddress },
    to: [to],
    subject,
    text,
    html,
    headers: [...(MAIL_REPLY_TO ? [['Reply-To', MAIL_REPLY_TO]] : []), ...headers],
  });
  await ses.send(new SendEmailCommand({
    FromEmailAddress: fromAddress,
    Destination: { ToAddresses: [to] },
    Content: { Raw: { Data: Buffer.from(raw) } },
  }));
}

// Creates or refreshes the caller's profile row on each app load. A new account gets the welcome email.
async function touchProfile(me) {
  const existing = await getProfile(me.userId);
  const at = now();
  const profile = {
    ...existing,
    ...profileKey(me.userId),
    GSI1PK: 'PROFILE',
    GSI1SK: me.email,
    userId: me.userId,
    email: me.email,
    name: existing?.nameLocked ? existing.name : me.providerName || existing?.name || null,
    provider: me.provider,
    picture: me.providerPicture || existing?.picture || null,
    createdAt: existing?.createdAt || at,
    lastLoginAt: at,
  };
  if (!profile.welcomeSentAt && MAIL_FROM) {
    try {
      await sendAccountEmail(profile.email, welcomeEmail(profile, SITE_URL));
      profile.welcomeSentAt = at;
    } catch (error) {
      console.error('Welcome email failed', error);
    }
  }
  await put(profile);
  return profile;
}

async function saveProfile(me, changes, remove = []) {
  const profile = { ...(await getProfile(me.userId)), ...changes };
  for (const key of remove) delete profile[key];
  await put(profile);
  return profile;
}

route('PATCH', '/me/profile', async (me, _p, body) => {
  const refused = selfUpdateError(body);
  if (refused) throw new HttpError(...refused);
  const changes = { profileUpdatedAt: now() };
  if ('name' in body) {
    // A name the person picked sticks over the identity provider's on later sign-ins.
    changes.name = body.name.trim();
    changes.nameLocked = true;
    me.name = changes.name;
  }
  if ('emailUpdates' in body) {
    changes.emailUpdates = body.emailUpdates;
    changes.emailUpdatesChangedAt = changes.profileUpdatedAt;
  }
  // null goes back to the sign-in provider's photo; "initials" shows no photo.
  if ('avatar' in body) {
    if (body.avatar === null) return { profile: selfProfile(await saveProfile(me, changes, ['avatar']), me.globalRole) };
    changes.avatar = body.avatar;
  }
  return { profile: selfProfile(await saveProfile(me, changes), me.globalRole) };
});

route('POST', '/me/phone', async (me, _p, body) => {
  const phone = normalizePhone(body.phone);
  if (!phone) throw new HttpError(400, 'Enter your mobile number with its country code, e.g. +91 98765 43210.');
  const profile = await getProfile(me.userId);
  if (profile?.phoneVerified && profile.phone === phone) throw new HttpError(400, 'That number is already verified.');
  if (Date.now() - (profile?.phonePending?.sentAt || 0) < 30_000) throw new HttpError(429, 'Wait 30 seconds before asking for another code.');
  if ((await countUse(`sms#${me.userId}`, 'day')) > SMS_PER_USER_PER_DAY) throw new HttpError(429, 'That’s enough codes for today. Try again tomorrow.');
  if ((await countUse('sms#all', 'day')) > SMS_SITE_PER_DAY) throw new HttpError(429, 'Text messages are busy right now. Try again later.');
  const secret = await getAppSecret();
  const code = newCode();
  try {
    await sns.send(new PublishCommand({
      PhoneNumber: phone,
      Message: smsMessage(code),
      MessageAttributes: { 'AWS.SNS.SMS.SMSType': { DataType: 'String', StringValue: 'Transactional' } },
    }));
  } catch (error) {
    console.error('SMS failed', error);
    throw new HttpError(502, 'We couldn’t text that number. Check it and try again.');
  }
  const phonePending = { phone, hash: hashCode(secret, me.userId, phone, code), expiresAt: Date.now() + CODE_TTL_MS, attempts: 0, sentAt: Date.now() };
  return { profile: selfProfile(await saveProfile(me, { phonePending }), me.globalRole) };
});

route('POST', '/me/phone/verify', async (me, _p, body) => {
  const profile = await getProfile(me.userId);
  const result = checkCode(await getAppSecret(), profile, body.code);
  if (result.error) {
    if (result.wrong) await saveProfile(me, { phonePending: { ...profile.phonePending, attempts: (profile.phonePending.attempts || 0) + 1 } });
    throw new HttpError(...result.error);
  }
  const saved = await saveProfile(me, { phone: result.phone, phoneVerified: true, phoneVerifiedAt: now() }, ['phonePending']);
  return { profile: selfProfile(saved, me.globalRole) };
});

route('DELETE', '/me/phone', async (me) => ({
  profile: selfProfile(await saveProfile(me, {}, ['phone', 'phoneVerified', 'phoneVerifiedAt', 'phonePending']), me.globalRole),
}));

// ------------------------------------------------------------------ admin console

const requireStaff = (me) => {
  if (!isStaff(me.globalRole)) throw new HttpError(403, 'Admins only.');
};

const listProfiles = () => queryAll({ IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :pk', ExpressionAttributeValues: { ':pk': 'PROFILE' } });

// A profile's role, counting admins made in Lyrcloud as well as in Lyrsoft.
async function roleOf(profile) {
  const account = ACCOUNTS_TABLE ? (await ddb.send(new GetCommand({ TableName: ACCOUNTS_TABLE, Key: { userId: profile.userId } }))).Item : null;
  const role = roleFor({ provider: profile.provider, email: profile.email, role: profile.role === 'admin' || account?.role === 'admin' ? 'admin' : 'user' }, SUPER_ADMIN_EMAIL);
  return { role, lyrcloudAdmin: account?.role === 'admin' };
}

route('GET', '/admin/users', async (me) => {
  requireStaff(me);
  const users = await Promise.all((await listProfiles()).map(async (profile) => {
    const { role, lyrcloudAdmin } = await roleOf(profile);
    return { ...adminProfile(profile, role), lyrcloudAdmin };
  }));
  users.sort((a, b) => String(b.lastLoginAt).localeCompare(String(a.lastLoginAt)));
  return { users };
});

route('PATCH', '/admin/users/{userId}', async (me, { userId }, body) => {
  requireStaff(me);
  const target = await getProfile(userId);
  if (!target) throw new HttpError(404, 'No such user.');
  const { role: targetRole, lyrcloudAdmin } = await roleOf(target);
  const refused = userUpdateError(me.globalRole, targetRole, body);
  if (refused) throw new HttpError(...refused);
  const changes = Object.fromEntries(Object.entries(body).filter(([key]) => ['role', 'disabled'].includes(key)));
  if (changes.role === 'user' && lyrcloudAdmin) throw new HttpError(400, 'This person is an admin in Lyrcloud. Change their role there.');
  const next = { ...target, ...changes, updatedAt: now(), updatedBy: me.email };
  await put(next);
  const { role } = await roleOf(next);
  return { user: { ...adminProfile(next, role), lyrcloudAdmin } };
});

// Deletes a workspace's marketing data (subscribers, campaigns and their recipients, forms, settings).
async function deleteMarketingData(ws) {
  const rows = await queryAll({ KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': `MKT#${ws}` }, ProjectionExpression: 'PK, SK' });
  for (const row of rows.filter((r) => r.SK.startsWith('CAMP#'))) {
    const recipients = await queryAll({ KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': `MKTC#${row.SK.slice(5)}` }, ProjectionExpression: 'PK, SK' });
    await deleteKeys(recipients);
  }
  await deleteKeys(rows);
}

const getUpdates = async () => (await get('CONFIG', 'UPDATES'))?.updates || [];
const saveUpdates = (updates) => put({ PK: 'CONFIG', SK: 'UPDATES', updates: updates.slice(0, UPDATES_KEPT) });
const apiBaseUrl = (event) => (event?.requestContext?.domainName ? `https://${event.requestContext.domainName}` : process.env.API_BASE_URL || 'http://localhost:8787');

route('GET', '/admin/updates', async (me) => {
  requireStaff(me);
  return {
    updates: (await getUpdates()).map(({ message, ...update }) => update),
    recipients: updateRecipients(await listProfiles()).length,
    mailEnabled: Boolean(MAIL_FROM),
  };
});

// Sends an update to everyone opted in who hasn't had it yet, for up to ~20 seconds (API Gateway
// gives up at 30). The console calls again with the updateId until nothing remains.
route('POST', '/admin/updates', async (me, _p, body, _q, event) => {
  if (me.globalRole !== 'superadmin') throw new HttpError(403, 'Only the super admin can email updates.');
  if (!MAIL_FROM) throw new HttpError(503, 'Email sending isn’t set up yet (MAIL_FROM).');
  const refused = updateEmailError(body);
  if (refused) throw new HttpError(...refused);
  const updates = await getUpdates();
  let update;
  if (body.updateId) {
    update = updates.find((item) => item.id === body.updateId);
    if (!update) throw new HttpError(404, 'No such update.');
  } else {
    update = { id: `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`, subject: body.subject.trim(), message: body.message.trim(), sentAt: now(), sentBy: me.email, sent: 0, failed: 0 };
    updates.unshift(update);
    await saveUpdates(updates);
  }

  const secret = await getAppSecret();
  const base = apiBaseUrl(event);
  const queue = updateRecipients(await listProfiles()).filter((p) => p.lastUpdateId !== update.id && p.failedUpdateId !== update.id);
  const deadline = Date.now() + 20_000;
  const worker = async () => {
    while (queue.length && Date.now() < deadline) {
      const profile = queue.shift();
      const url = `${base}/public/unsubscribe?u=${encodeURIComponent(profile.userId)}&t=${unsubscribeToken(secret, profile.userId)}`;
      try {
        await sendAccountEmail(profile.email, updateEmail({ subject: update.subject, message: update.message, unsubscribeUrl: url }, SITE_URL), [
          ['List-Unsubscribe', `<${url}>`],
          ['List-Unsubscribe-Post', 'List-Unsubscribe=One-Click'],
        ]);
        await put({ ...(await getProfile(profile.userId)), lastUpdateId: update.id });
        update.sent += 1;
      } catch (error) {
        console.error('Update email failed', profile.userId, error);
        await put({ ...(await getProfile(profile.userId)), failedUpdateId: update.id });
        update.failed += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));

  // Re-read so a send running alongside isn't overwritten, then store this update's counts.
  const latest = await getUpdates();
  const index = latest.findIndex((item) => item.id === update.id);
  if (index === -1) latest.unshift(update);
  else latest[index] = update;
  await saveUpdates(latest);
  return { update: { ...update, message: undefined }, remaining: queue.length };
});

// GET shows a button (so mail scanners that open links don't unsubscribe anyone); POST unsubscribes,
// which is also what mail apps' one-click "Unsubscribe" sends.
async function unsubscribe(event, method) {
  const html = (statusCode, body) => ({ statusCode, headers: { 'content-type': 'text/html; charset=utf-8' }, body });
  const params = new URLSearchParams(event.rawQueryString || '');
  const userId = params.get('u');
  const token = params.get('t');
  const profile = userId && ID_SAFE.test(userId) ? await getProfile(userId) : null;
  if (!profile || !validUnsubscribeToken(await getAppSecret(), userId, token)) return html(400, unsubscribePage('invalid', SITE_URL));
  if (method === 'GET') {
    return html(200, unsubscribePage('confirm', SITE_URL, `/public/unsubscribe?u=${encodeURIComponent(userId)}&t=${encodeURIComponent(token)}`));
  }
  await put({ ...profile, emailUpdates: false, emailUpdatesChangedAt: now() });
  return html(200, unsubscribePage('done', SITE_URL));
}
const ID_SAFE = /^[\w@.:-]{1,128}$/;

route('POST', '/workspaces', async (me, _p, body) => {
  const { workspace, boardId } = await createWorkspace({
    name: cleanName(body.name, 'Workspace', 80),
    ownerEmail: me.email,
    ownerUserId: me.userId,
    ownerName: me.name,
    firstBoard: defaultBoard('Getting started'),
  });
  return [201, { workspace: workspaceOut(workspace, 'owner'), firstBoardId: boardId }];
});

route('GET', '/workspaces/{ws}', async (me, { ws }) => {
  const { workspace, role } = await openWorkspace(me, ws);
  const rows = await queryAll({ KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': `WS#${ws}` } });
  return {
    workspace: workspaceOut(workspace, role),
    members: rows.filter((r) => r.SK.startsWith('MEMBER#')).map(memberOut),
    boards: rows.filter((r) => r.SK.startsWith('BOARD#')).map(boardSummary).sort((a, b) => a.name.localeCompare(b.name)),
  };
});

route('PATCH', '/workspaces/{ws}', async (me, { ws }, body) => {
  const { role } = await openWorkspace(me, ws, 'renameWorkspace');
  const name = cleanName(body.name, 'Workspace', 80);
  const { Attributes } = await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { PK: `WS#${ws}`, SK: 'META' },
    UpdateExpression: 'SET #n = :n',
    ExpressionAttributeNames: { '#n': 'name' },
    ExpressionAttributeValues: { ':n': name },
    ReturnValues: 'ALL_NEW',
  }));
  const members = await queryPrefix(`WS#${ws}`, 'MEMBER#');
  await Promise.all(members.map((m) => put({ ...m, wsName: name })));
  return { workspace: workspaceOut(Attributes, role) };
});

route('DELETE', '/workspaces/{ws}', async (me, { ws }) => {
  await openWorkspace(me, ws, 'deleteWorkspace');
  const rows = await queryAll({ KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': `WS#${ws}` } });
  for (const board of rows.filter((r) => r.SK.startsWith('BOARD#'))) await deleteBoardData(board.boardId);
  await deleteKeys(rows.map(({ PK, SK }) => ({ PK, SK })));
  // The workspace's team chat goes with it.
  const chat = await queryAll({ KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': `CHAT#${channelId(ws)}` } });
  await deleteKeys(chat.map(({ PK, SK }) => ({ PK, SK })));
  await deleteMarketingData(ws);
  return { deleted: true };
});

// Adds someone to a workspace by email (owners and admins). Also used to add a contact found by phone.
async function addWorkspaceMember(me, ws, rawEmail, newRole = 'member') {
  const { workspace, role } = await openWorkspace(me, ws, 'manageMembers');
  const email = String(rawEmail || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  const refused = memberChangeError({ actorRole: role, actorEmail: me.email, targetEmail: email, targetRole: null, newRole });
  if (refused) throw new HttpError(...refused);
  if (await get(`WS#${ws}`, `MEMBER#${email}`)) throw new HttpError(409, `${email} is already in this workspace.`);
  const row = memberRow(ws, workspace.name, email, newRole, { addedAt: now(), addedBy: me.email });
  await put(row);
  return row;
}

route('POST', '/workspaces/{ws}/members', async (me, { ws }, body) => {
  const row = await addWorkspaceMember(me, ws, body.email, body.role || 'member');
  return [201, { member: memberOut(row) }];
});

route('PATCH', '/workspaces/{ws}/members/{email}', async (me, { ws, email }, body) => {
  const { role } = await openWorkspace(me, ws);
  const target = await get(`WS#${ws}`, `MEMBER#${email.toLowerCase()}`);
  if (!target) throw new HttpError(404, 'Member not found.');
  const refused = memberChangeError({ actorRole: role, actorEmail: me.email, targetEmail: target.email, targetRole: target.role, newRole: body.role });
  if (refused) throw new HttpError(...refused);
  const row = { ...target, role: body.role };
  await put(row);
  return { member: memberOut(row) };
});

route('DELETE', '/workspaces/{ws}/members/{email}', async (me, { ws, email }) => {
  const { role } = await openWorkspace(me, ws);
  const target = await get(`WS#${ws}`, `MEMBER#${email.toLowerCase()}`);
  if (!target) throw new HttpError(404, 'Member not found.');
  const refused = memberChangeError({ actorRole: role, actorEmail: me.email, targetEmail: target.email, targetRole: target.role, newRole: null });
  if (refused) throw new HttpError(...refused);
  await del(target.PK, target.SK);
  return { removed: true };
});

route('POST', '/workspaces/{ws}/boards', async (me, { ws }, body) => {
  await openWorkspace(me, ws, 'editBoards');
  const boardId = newId();
  const createdAt = now();
  const board = { PK: `WS#${ws}`, SK: `BOARD#${boardId}`, boardId, wsId: ws, ...defaultBoard(cleanName(body.name, 'Board')), createdAt, updatedAt: createdAt, createdBy: me.email };
  await put(board);
  return [201, { board: boardOut(board) }];
});

route('GET', '/workspaces/{ws}/boards/{board}', async (me, { ws, board: boardId }) => {
  await openWorkspace(me, ws);
  const board = await openBoard(ws, boardId);
  const items = await queryPrefix(`BOARD#${boardId}`, 'ITEM#');
  return { board: boardOut(board), items: items.map(itemOut).sort((a, b) => a.position - b.position) };
});

route('PATCH', '/workspaces/{ws}/boards/{board}', async (me, { ws, board: boardId }, body) => {
  await openWorkspace(me, ws, 'editBoards');
  const board = await openBoard(ws, boardId);
  const next = { ...board, updatedAt: now() };
  if ('name' in body) next.name = cleanName(body.name, 'Board');
  if ('description' in body) next.description = String(body.description ?? '').slice(0, 2000);
  if ('columns' in body) next.columns = cleanColumns(body.columns);
  if ('groups' in body) {
    next.groups = cleanGroups(body.groups);
    // Items in a removed group move to the first remaining group.
    const kept = new Set(next.groups.map((g) => g.id));
    const orphans = (await queryPrefix(`BOARD#${boardId}`, 'ITEM#')).filter((item) => !kept.has(item.groupId));
    await Promise.all(orphans.map((item) => put({ ...item, groupId: next.groups[0].id })));
  }
  await put(next);
  return { board: boardOut(next) };
});

route('DELETE', '/workspaces/{ws}/boards/{board}', async (me, { ws, board: boardId }) => {
  await openWorkspace(me, ws, 'editBoards');
  await openBoard(ws, boardId);
  await deleteBoardData(boardId);
  await del(`WS#${ws}`, `BOARD#${boardId}`);
  return { deleted: true };
});

route('POST', '/workspaces/{ws}/boards/{board}/items', async (me, { ws, board: boardId }, body) => {
  await openWorkspace(me, ws, 'editBoards');
  const board = await openBoard(ws, boardId);
  const groupId = board.groups.some((g) => g.id === body.groupId) ? body.groupId : board.groups[0].id;
  const createdAt = now();
  const itemId = newId();
  const item = {
    PK: `BOARD#${boardId}`,
    SK: `ITEM#${itemId}`,
    itemId,
    boardId,
    groupId,
    name: cleanName(body.name, 'Item', 200),
    values: cleanValues(body.values, board.columns),
    position: Number.isFinite(body.position) ? body.position : Date.now(),
    createdAt,
    updatedAt: createdAt,
    updatedBy: me.email,
  };
  await put(item);
  return [201, { item: itemOut(item) }];
});

route('PATCH', '/workspaces/{ws}/boards/{board}/items/{item}', async (me, { ws, board: boardId, item: itemId }, body) => {
  await openWorkspace(me, ws, 'editBoards');
  const board = await openBoard(ws, boardId);
  const item = await openItem(boardId, itemId);
  const next = { ...item, updatedAt: now(), updatedBy: me.email };
  if ('name' in body) next.name = cleanName(body.name, 'Item', 200);
  if ('groupId' in body) {
    if (!board.groups.some((g) => g.id === body.groupId)) throw new HttpError(400, 'Unknown group.');
    next.groupId = body.groupId;
  }
  if ('position' in body && Number.isFinite(body.position)) next.position = body.position;
  if ('values' in body) {
    const merged = { ...item.values, ...cleanValues(body.values, board.columns) };
    next.values = Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== null));
  }
  await put(next);
  return { item: itemOut(next) };
});

route('DELETE', '/workspaces/{ws}/boards/{board}/items/{item}', async (me, { ws, board: boardId, item: itemId }) => {
  await openWorkspace(me, ws, 'editBoards');
  await openBoard(ws, boardId);
  await openItem(boardId, itemId);
  const updates = await queryPrefix(`ITEM#${itemId}`, 'UPDATE#');
  await deleteKeys(updates.map(({ PK, SK }) => ({ PK, SK })));
  await del(`BOARD#${boardId}`, `ITEM#${itemId}`);
  return { deleted: true };
});

route('GET', '/workspaces/{ws}/boards/{board}/items/{item}/updates', async (me, { ws, board: boardId, item: itemId }) => {
  await openWorkspace(me, ws);
  await openBoard(ws, boardId);
  await openItem(boardId, itemId);
  const updates = await queryPrefix(`ITEM#${itemId}`, 'UPDATE#');
  return { updates: updates.map(updateOut).reverse() };
});

route('POST', '/workspaces/{ws}/boards/{board}/items/{item}/updates', async (me, { ws, board: boardId, item: itemId }, body) => {
  await openWorkspace(me, ws, 'editBoards');
  await openBoard(ws, boardId);
  await openItem(boardId, itemId);
  const text = String(body.body ?? '').trim().slice(0, 5000);
  if (!text) throw new HttpError(400, 'Write something first.');
  const createdAt = now();
  const updateId = newId();
  const update = { PK: `ITEM#${itemId}`, SK: `UPDATE#${createdAt}#${updateId}`, updateId, body: text, authorEmail: me.email, authorName: me.name, createdAt };
  await put(update);
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { PK: `BOARD#${boardId}`, SK: `ITEM#${itemId}` },
    UpdateExpression: 'ADD updateCount :one',
    ConditionExpression: 'attribute_exists(PK)',
    ExpressionAttributeValues: { ':one': 1 },
  })).catch(() => {});
  return [201, { update: updateOut(update) }];
});

registerMailRoutes(route, { store: mailStore, s3, ses, bucket: MAIL_BUCKET, HttpError });

// The Lyr Chat phone apps' push goes through Firebase Cloud Messaging with a Google service account kept
// in the FCM_SECRET secret (lyrsoft/fcm). Until that secret exists, phones only ring while the app is open.
const FCM_SECRET = process.env.FCM_SECRET;
let fcmAccount = { at: 0, value: null };
async function getFcmAccount() {
  if (process.env.FCM_SERVICE_ACCOUNT) return JSON.parse(process.env.FCM_SERVICE_ACCOUNT);
  if (!FCM_SECRET) return null;
  if (Date.now() - fcmAccount.at < 10 * 60_000) return fcmAccount.value;
  let value = null;
  try {
    value = JSON.parse((await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: FCM_SECRET }))).SecretString);
    if (!value?.client_email || !value?.private_key || !value?.project_id) value = null;
  } catch (error) {
    if (error.name !== 'ResourceNotFoundException') console.warn('FCM secret unreadable', error.name);
  }
  fcmAccount = { at: Date.now(), value };
  return value;
}
const push = createPush({ db: { put, del, queryAll }, getSecret: () => getAppSecret(), now, getFcmAccount });
const collab = registerCollabRoutes(route, {
  db: { get, put, del, queryAll },
  HttpError,
  openWorkspace,
  isStaff,
  memberships: (email) => queryAll({ IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :pk', ExpressionAttributeValues: { ':pk': `USER#${email}` } }),
  listProfiles: () => listProfiles(),
  sendEmail: (to, email) => sendAccountEmail(to, email),
  siteUrl: SITE_URL,
  chime: new ChimeSDKMeetingsClient({}),
  s3,
  bucket: MAIL_BUCKET,
  now,
  newId,
  addWorkspaceMember,
  countUse: (key, period) => countUse(key, period),
  push,
  getSecret: () => getAppSecret(),
  reportTo: SUPER_ADMIN_EMAIL,
  // Chats started from Lyrbot's "Lyr Chat" button go to this account (SUPPORT_CHAT_EMAIL, default the super admin).
  supportEmail: (process.env.SUPPORT_CHAT_EMAIL || SUPER_ADMIN_EMAIL).toLowerCase(),
});

registerContactRoutes(route, { db: { get, put, del, queryAll, putMany, deleteKeys }, HttpError, now, newId });

// One marketing email through SES, tagged so bounce and complaint events can find the workspace.
async function sendMarketingEmail({ from, to, replyTo, subject, text, html, headers = [], tags = {} }) {
  const raw = buildRawEmail({
    from,
    to: [to],
    subject,
    text,
    html,
    headers: [...(replyTo ? [['Reply-To', replyTo]] : []), ...headers],
  });
  const result = await ses.send(new SendEmailCommand({
    FromEmailAddress: from.address,
    Destination: { ToAddresses: [to] },
    Content: { Raw: { Data: Buffer.from(raw) } },
    ...(MARKETING_CONFIG_SET ? { ConfigurationSetName: MARKETING_CONFIG_SET } : {}),
    EmailTags: Object.entries(tags).filter(([, v]) => v).map(([Name, Value]) => ({ Name, Value: String(Value).replace(/[^\w-]/g, '_') })),
  }));
  return result.MessageId;
}

const lambda = new LambdaClient({});
// Hands a campaign's next batch to a fresh run: the Lambda invokes itself asynchronously; locally, a timer.
async function continueSending(ws, campaignId) {
  const task = { lyrsoftTask: 'marketing-send', ws, campaignId };
  if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
    setTimeout(() => marketing.handleTask(task).catch((error) => console.error('marketing send', error)), 50);
    return;
  }
  await lambda.send(new InvokeCommand({ FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME, InvocationType: 'Event', Payload: Buffer.from(JSON.stringify(task)) }));
}

const marketing = registerMarketingRoutes(route, {
  db: { get, put, del, queryAll, putMany, deleteKeys, update: (params) => ddb.send(new UpdateCommand({ TableName: TABLE, ...params })) },
  HttpError,
  openWorkspace,
  isStaff,
  now,
  newId,
  sendRaw: sendMarketingEmail,
  getAppSecret: () => getAppSecret(),
  defaultFrom: MARKETING_FROM,
  mailDomains: mailDomains(),
  publicBase: PUBLIC_BASE_URL,
  siteUrl: SITE_URL,
  continueSending,
});

// ------------------------------------------------------------------ public contact form

// Counts one use of `key` in the current hour (or day) and returns the new count.
async function countUse(key, period = 'hour') {
  const { Attributes } = await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { PK: `RATE#${key}`, SK: now().slice(0, period === 'day' ? 10 : 13) },
    UpdateExpression: 'ADD hits :one SET expiresAt = :expires',
    ExpressionAttributeValues: { ':one': 1, ':expires': Math.floor(Date.now() / 1000) + (period === 'day' ? 26 : 2) * 3600 },
    ReturnValues: 'ALL_NEW',
  }));
  return Attributes.hits;
}

// Counts this IP's submissions in the current hour; false once over the limit.
const underContactLimit = async (ip) => (await countUse(`contact#${ip}`)) <= CONTACT_LIMIT_PER_HOUR;

// The leads board lives in a "Lyrsoft" workspace owned by the super admin, created with the first
// enquiry. If someone deletes the board or workspace, the next enquiry sets it up again.
async function leadsLocation() {
  const config = await get('CONFIG', 'LEADS');
  if (config && (await get(`WS#${config.wsId}`, `BOARD#${config.boardId}`))) return config;
  const { workspace, boardId } = await createWorkspace({ name: 'Lyrsoft', ownerEmail: SUPER_ADMIN_EMAIL, firstBoard: leadsBoard() });
  const location = { PK: 'CONFIG', SK: 'LEADS', wsId: workspace.wsId, boardId };
  await put(location);
  return location;
}

async function contactMailbox() {
  const existing = await mailStore.getMailbox(CONTACT_MAILBOX);
  if (existing) return existing;
  const mailbox = {
    PK: `MAILBOX#${CONTACT_MAILBOX}`,
    SK: 'META',
    GSI1PK: 'MAILBOX',
    GSI1SK: CONTACT_MAILBOX,
    address: CONTACT_MAILBOX,
    displayName: 'Lyrsoft',
    members: [],
    catchAll: false,
    createdAt: now(),
    createdBy: 'website',
  };
  await mailStore.putMailbox(mailbox);
  return mailbox;
}

async function submitContact(event) {
  const body = parseBody(event);
  if (body === null) throw new HttpError(400, 'Invalid JSON body.');
  const contact = cleanContact(body);
  if (!contact) return json(200, { ok: true }); // bot
  if (!(await underContactLimit(event.requestContext?.http?.sourceIp || 'unknown'))) {
    throw new HttpError(429, 'Too many messages from your network. Please try again in an hour.');
  }

  const { wsId, boardId } = await leadsLocation();
  const createdAt = now();
  const itemId = newId();
  const board = await get(`WS#${wsId}`, `BOARD#${boardId}`);
  await put({
    PK: `BOARD#${boardId}`,
    SK: `ITEM#${itemId}`,
    itemId,
    boardId,
    groupId: board.groups[0].id,
    name: contact.company ? `${contact.name} · ${contact.company}` : contact.name,
    values: cleanValues(leadValues(contact), board.columns),
    position: -Date.now(), // newest first
    createdAt,
    updatedAt: createdAt,
    updatedBy: contact.email,
  });

  const mailbox = await contactMailbox();
  const leadUrl = `${SITE_URL}/app/#/w/${wsId}/b/${boardId}?item=${itemId}`;
  await mailStore.saveMessage(mailbox.address, {
    direction: 'in',
    from: { name: contact.name, address: contact.email },
    to: [mailbox.address],
    replyTo: [contact.email],
    subject: contactSubject(contact),
    text: contactText(contact, leadUrl),
    createdAt,
  });
  await mailStore.touchMailbox(mailbox.address, 'lastReceivedAt');
  return json(201, { ok: true });
}

// ------------------------------------------------------------------ Lyrbot

let anthropicKey;
async function getAnthropicKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_SECRET) return null;
  anthropicKey ??= (await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: ANTHROPIC_SECRET }))).SecretString.trim();
  return anthropicKey;
}

async function lyrbotChat(event) {
  const apiKey = await getAnthropicKey();
  if (!apiKey) return json(503, { error: LYRBOT_FALLBACK_REPLY });
  const body = parseBody(event);
  if (body === null) throw new HttpError(400, 'Invalid JSON body.');
  const conversation = cleanLyrbotMessages(body.messages);
  if (!conversation) return json(422, { error: 'Type a question for Lyrbot.' });
  if ((await countUse(`lyrbot#${event.requestContext?.http?.sourceIp || 'unknown'}`)) > LYRBOT_HOURLY_LIMIT) {
    return json(429, { error: LYRBOT_HOURLY_MESSAGE });
  }
  if ((await countUse('lyrbot#all', 'day')) > LYRBOT_DAILY_LIMIT) return json(429, { error: LYRBOT_DAILY_MESSAGE });
  const [status, reply] = await lyrbotReply(apiKey, conversation);
  return json(status, reply);
}

// ------------------------------------------------------------------ entry point

function parseBody(event) {
  if (!event.body) return {};
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    // Signup forms embedded on other websites post ordinary HTML forms.
    if (/application\/x-www-form-urlencoded/i.test(event.headers?.['content-type'] || '')) return Object.fromEntries(new URLSearchParams(raw));
    const body = JSON.parse(raw);
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

export const handler = async (event) => {
  if (marketing.isTask(event)) return marketing.handleTask(event);
  const method = event.requestContext?.http?.method;
  const path = event.requestContext?.http?.path || '';
  try {
    if (method === 'POST' && path === '/public/contact') return await submitContact(event);
    if (method === 'POST' && path === '/public/lyrbot') return await lyrbotChat(event);
    if ((method === 'GET' || method === 'POST') && path === '/public/unsubscribe') return await unsubscribe(event, method);
    if (method === 'POST' && path === '/public/call') {
      const body = parseBody(event);
      if (!body) throw new HttpError(400, 'Invalid JSON body.');
      return json(200, await collab.publicCall(body));
    }
    if (path.startsWith('/public/m/') || path === '/public/subscribe') {
      const params = new URLSearchParams(event.rawQueryString || '');
      if (method === 'GET' && path === '/public/m/open') return await marketing.publicOpen(params);
      if (method === 'GET' && path === '/public/m/click') return await marketing.publicClick(params);
      if ((method === 'GET' || method === 'POST') && path === '/public/m/unsubscribe') return await marketing.publicUnsubscribe(params, method);
      if (method === 'GET' || method === 'POST') {
        const body = method === 'POST' ? parseBody(event) : {};
        if (body === null) throw new HttpError(400, 'Invalid form.');
        return await marketing.publicSubscribe(event, params, method, body, event.requestContext?.http?.sourceIp || 'unknown');
      }
    }
    const me = await identify(event);
    for (const { method: m, re, keys, fn } of routes) {
      const match = m === method && path.match(re);
      if (!match) continue;
      const params = Object.fromEntries(keys.map((key, i) => [key, decodeURIComponent(match[i + 1])]));
      const body = parseBody(event);
      if (body === null) throw new HttpError(400, 'Invalid JSON body.');
      const result = await fn(me, params, body, new URLSearchParams(event.rawQueryString || ''), event);
      return Array.isArray(result) ? json(result[0], result[1]) : json(200, result);
    }
    return json(404, { error: 'not_found' });
  } catch (error) {
    if (error instanceof HttpError) return json(error.status, { error: error.message });
    if (error instanceof ValidationError) return json(400, { error: error.message });
    console.error(error);
    return json(500, { error: 'Something went wrong. Please try again.' });
  }
};
