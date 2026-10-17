// Lyrsoft Mail storage, shared by the inbound processor (inbound.mjs) and the work API's mail
// routes (api/work/mail-routes.mjs). Lives in the lyrsoft-work table next to boards:
//
//   MAILBOX#<address>         META                 mailbox         GSI1: MAILBOX / <address>
//   MAILBOX#<address>         THREAD#<thread>      conversation    GSI1: INBOX#<address>#<status> / <lastMessageAt>#<thread>
//   THREAD#<thread>           MSG#<iso>#<msg>      message
//   MSGID#<address>#<header>  META                 Message-ID -> thread, for threading replies
//   INBOUND#<ses id>#<addr>   META                 dedupe marker (SES can deliver an event twice)
//
// Bodies over a few KB and all HTML live in the mail bucket, not DynamoDB (400 KB item limit):
//   inbound/<ses id>   raw email (written by SES)       html/<msg>.html
//   outbound/<msg>.eml raw email we sent                attachments/<msg>/<n>/<filename>
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { newId, snippet } from './model.mjs';

const MAX_TEXT = 60_000;

export function createMailStore({ ddb, s3, table, bucket }) {
  const get = async (PK, SK) => (await ddb.send(new GetCommand({ TableName: table, Key: { PK, SK } }))).Item;

  async function queryAll(params) {
    const items = [];
    let ExclusiveStartKey;
    do {
      const page = await ddb.send(new QueryCommand({ TableName: table, ...params, ExclusiveStartKey }));
      items.push(...(page.Items || []));
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  }

  const listMailboxes = () =>
    queryAll({ IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :pk', ExpressionAttributeValues: { ':pk': 'MAILBOX' } });

  const getMailbox = (address) => get(`MAILBOX#${address}`, 'META');
  const putMailbox = (mailbox) => ddb.send(new PutCommand({ TableName: table, Item: mailbox }));
  // Conversations stay in the table, so re-creating the address brings its history back.
  const deleteMailbox = (address) => ddb.send(new DeleteCommand({ TableName: table, Key: { PK: `MAILBOX#${address}`, SK: 'META' } }));
  const getThread = (address, threadId) => get(`MAILBOX#${address}`, `THREAD#${threadId}`);

  const threadIndexKeys = (address, status, lastMessageAt, threadId) => ({
    GSI1PK: `INBOX#${address}#${status}`,
    GSI1SK: `${lastMessageAt}#${threadId}`,
  });

  async function putObject(Key, Body, ContentType) {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key, Body, ContentType }));
  }

  async function readObject(Key) {
    const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key }));
    return Buffer.from(await result.Body.transformToByteArray());
  }

  // Finds the thread a message belongs to from its In-Reply-To/References ids (newest first).
  async function findThreadByMessageIds(address, ids) {
    for (const id of [...ids].reverse()) {
      const hit = await get(`MSGID#${address}#${id}`, 'META');
      if (hit) {
        const thread = await getThread(address, hit.threadId);
        if (thread) return thread;
      }
    }
    return null;
  }

  // Stores one message in `mailbox` and creates or updates its thread. Returns { thread, message }.
  // `message`: { direction, from, to, cc, subject, text, html, headerMessageId, referenceIds,
  //              attachments, rawKey, verdicts, sentBy, createdAt }
  async function saveMessage(address, message, { threadId: knownThreadId, newThreadStatus = 'open' } = {}) {
    const createdAt = message.createdAt || new Date().toISOString();
    const id = message.id || newId();

    let thread = knownThreadId
      ? await getThread(address, knownThreadId)
      : await findThreadByMessageIds(address, message.referenceIds || []);
    const isNew = !thread;
    const threadId = thread?.threadId || newId();

    let htmlKey = null;
    if (message.html) {
      htmlKey = `html/${id}.html`;
      await putObject(htmlKey, message.html, 'text/html; charset=utf-8');
    }

    const participants = new Set(thread?.participants || []);
    for (const person of [message.from, ...(message.to || []).map((a) => ({ address: a })), ...(message.cc || []).map((a) => ({ address: a }))]) {
      if (person?.address && person.address !== address) participants.add(person.address.toLowerCase());
    }

    const item = {
      PK: `THREAD#${threadId}`,
      SK: `MSG#${createdAt}#${id}`,
      id,
      threadId,
      mailbox: address,
      direction: message.direction,
      from: message.from,
      to: message.to || [],
      cc: message.cc || [],
      replyTo: message.replyTo || [],
      subject: message.subject || '',
      text: String(message.text || '').slice(0, MAX_TEXT),
      textTruncated: String(message.text || '').length > MAX_TEXT,
      htmlKey,
      headerMessageId: message.headerMessageId || null,
      attachments: message.attachments || [],
      rawKey: message.rawKey || null,
      verdicts: message.verdicts || null,
      sentBy: message.sentBy || null,
      createdAt,
    };
    await ddb.send(new PutCommand({ TableName: table, Item: item }));
    if (item.headerMessageId) {
      await ddb.send(new PutCommand({ TableName: table, Item: { PK: `MSGID#${address}#${item.headerMessageId}`, SK: 'META', threadId } }));
    }

    // Incoming mail reopens a closed conversation and marks it unread; our own replies don't.
    const inbound = message.direction === 'in';
    const status = isNew ? newThreadStatus : inbound && thread.status === 'closed' ? 'open' : thread.status;
    const next = {
      ...(thread || {
        PK: `MAILBOX#${address}`,
        SK: `THREAD#${threadId}`,
        threadId,
        mailbox: address,
        subject: message.subject || '(no subject)',
        createdAt,
        messageCount: 0,
        assignee: null,
      }),
      ...threadIndexKeys(address, status, createdAt, threadId),
      status,
      participants: [...participants].slice(0, 50),
      lastMessageAt: createdAt,
      lastDirection: message.direction,
      lastFrom: message.from,
      snippet: snippet(message.text),
      unread: inbound,
      messageCount: (thread?.messageCount || 0) + 1,
      attachmentCount: (thread?.attachmentCount || 0) + item.attachments.length,
    };
    await ddb.send(new PutCommand({ TableName: table, Item: next }));
    return { thread: next, message: item };
  }

  // Changes status / assignee / unread, keeping the inbox index in step with the status.
  async function updateThread(address, threadId, changes) {
    const thread = await getThread(address, threadId);
    if (!thread) return null;
    const next = { ...thread, ...changes };
    Object.assign(next, threadIndexKeys(address, next.status, next.lastMessageAt, threadId));
    await ddb.send(new PutCommand({ TableName: table, Item: next }));
    return next;
  }

  async function listThreads(address, status, { limit = 50, cursor } = {}) {
    const page = await ddb.send(new QueryCommand({
      TableName: table,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': `INBOX#${address}#${status}` },
      ScanIndexForward: false,
      Limit: limit,
      ExclusiveStartKey: cursor ? JSON.parse(Buffer.from(cursor, 'base64url').toString()) : undefined,
    }));
    return {
      threads: page.Items || [],
      cursor: page.LastEvaluatedKey ? Buffer.from(JSON.stringify(page.LastEvaluatedKey)).toString('base64url') : null,
    };
  }

  async function countThreads(address, status) {
    const page = await ddb.send(new QueryCommand({
      TableName: table,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': `INBOX#${address}#${status}` },
      Select: 'COUNT',
    }));
    return page.Count || 0;
  }

  const listMessages = (threadId) =>
    queryAll({ KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)', ExpressionAttributeValues: { ':pk': `THREAD#${threadId}`, ':sk': 'MSG#' } });

  // Records that this SES message was already stored for this mailbox; false if it was.
  async function claimInbound(sesMessageId, address) {
    try {
      await ddb.send(new PutCommand({
        TableName: table,
        Item: { PK: `INBOUND#${sesMessageId}#${address}`, SK: 'META', at: new Date().toISOString() },
        ConditionExpression: 'attribute_not_exists(PK)',
      }));
      return true;
    } catch (error) {
      if (error.name === 'ConditionalCheckFailedException') return false;
      throw error;
    }
  }

  async function touchMailbox(address, field) {
    await ddb.send(new UpdateCommand({
      TableName: table,
      Key: { PK: `MAILBOX#${address}`, SK: 'META' },
      UpdateExpression: 'SET #f = :now',
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeNames: { '#f': field },
      ExpressionAttributeValues: { ':now': new Date().toISOString() },
    })).catch(() => {});
  }

  return {
    get,
    queryAll,
    listMailboxes,
    getMailbox,
    putMailbox,
    deleteMailbox,
    getThread,
    saveMessage,
    updateThread,
    listThreads,
    countThreads,
    listMessages,
    claimInbound,
    touchMailbox,
    putObject,
    readObject,
  };
}
