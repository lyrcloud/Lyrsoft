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
//
// Members are keyed by email, so people can be invited before they first sign in. Emails are
// only trusted from Google sign-ins (Cognito doesn't mark them verified, and the GitHub bridge
// passes through whatever GitHub reports), so other providers are refused.
//
// One route is public: POST /public/contact, the lyrsoft.com contact form. Each enquiry becomes an
// item on the "Website leads" board and a conversation in the hello@lyrsoft.com Lyrsoft Mail inbox.
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
import { S3Client } from '@aws-sdk/client-s3';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { roleFor, SUPER_ADMIN_PROVIDER } from '../account/roles.mjs';
import { canUseMailbox } from '../mail/model.mjs';
import { registerMailRoutes } from '../mail/routes.mjs';
import { createMailStore } from '../mail/store.mjs';
import { CONTACT_LIMIT_PER_HOUR, cleanContact, contactSubject, contactText, leadsBoard, leadValues } from './leads.mjs';
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
const s3 = new S3Client({});
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

async function identify(event) {
  const claims = event.requestContext?.authorizer?.jwt?.claims;
  if (!claims?.sub) throw new HttpError(401, 'unauthorized');
  const token = (event.headers?.authorization || '').replace(/^Bearer\s+/i, '');
  const cached = identityCache.get(token);
  if (cached && cached.expires > Date.now()) return cached.identity;

  // userInfo, not GetUser: GetUser needs the aws.cognito.signin.user.admin scope, which the app
  // client doesn't grant, so every call failed and signed-in users were sent back to sign in.
  const res = await fetch(`https://${COGNITO_DOMAIN}/oauth2/userInfo`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    console.warn('userInfo failed', res.status, (await res.text()).slice(0, 300));
    throw new HttpError(401, 'Your session has expired. Please sign in again.');
  }
  const user = await res.json();
  const attr = (name) => user[name] ?? null;
  const provider = String(user.username || '').split('_')[0];
  const email = String(attr('email') || '').toLowerCase();
  if (provider !== SUPER_ADMIN_PROVIDER || !email) throw new HttpError(403, 'Please sign in with Google to use Lyrsoft.');

  const account = ACCOUNTS_TABLE
    ? (await ddb.send(new GetCommand({ TableName: ACCOUNTS_TABLE, Key: { userId: claims.sub } }))).Item
    : null;
  const identity = {
    userId: claims.sub,
    email,
    name: attr('name') || '',
    globalRole: roleFor({ provider, email, role: account?.role }, SUPER_ADMIN_EMAIL),
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
  return { email: me.email, name: me.name, globalRole: me.globalRole, workspaces, mailboxCount };
});

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
  return { deleted: true };
});

route('POST', '/workspaces/{ws}/members', async (me, { ws }, body) => {
  const { workspace, role } = await openWorkspace(me, ws, 'manageMembers');
  const email = String(body.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  const newRole = body.role || 'member';
  const refused = memberChangeError({ actorRole: role, actorEmail: me.email, targetEmail: email, targetRole: null, newRole });
  if (refused) throw new HttpError(...refused);
  if (await get(`WS#${ws}`, `MEMBER#${email}`)) throw new HttpError(409, `${email} is already in this workspace.`);
  const row = memberRow(ws, workspace.name, email, newRole, { addedAt: now(), addedBy: me.email });
  await put(row);
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

registerMailRoutes(route, { store: mailStore, s3, ses: new SESv2Client({}), bucket: MAIL_BUCKET, HttpError });

// ------------------------------------------------------------------ public contact form

// Counts this IP's submissions in the current hour; false once over the limit.
async function underContactLimit(ip) {
  const { Attributes } = await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { PK: `RATE#contact#${ip}`, SK: now().slice(0, 13) },
    UpdateExpression: 'ADD hits :one SET expiresAt = :expires',
    ExpressionAttributeValues: { ':one': 1, ':expires': Math.floor(Date.now() / 1000) + 2 * 3600 },
    ReturnValues: 'ALL_NEW',
  }));
  return Attributes.hits <= CONTACT_LIMIT_PER_HOUR;
}

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

// ------------------------------------------------------------------ entry point

function parseBody(event) {
  if (!event.body) return {};
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    const body = JSON.parse(raw);
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

export const handler = async (event) => {
  const method = event.requestContext?.http?.method;
  const path = event.requestContext?.http?.path || '';
  try {
    if (method === 'POST' && path === '/public/contact') return await submitContact(event);
    const me = await identify(event);
    for (const { method: m, re, keys, fn } of routes) {
      const match = m === method && path.match(re);
      if (!match) continue;
      const params = Object.fromEntries(keys.map((key, i) => [key, decodeURIComponent(match[i + 1])]));
      const body = parseBody(event);
      if (body === null) throw new HttpError(400, 'Invalid JSON body.');
      const result = await fn(me, params, body, new URLSearchParams(event.rawQueryString || ''));
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
