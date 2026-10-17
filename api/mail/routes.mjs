// Lyrsoft Mail routes, mounted on the work API (api/work/index.mjs) so they share its sign-in.
//   GET    /mail/mailboxes                                   mailboxes I can use (+ setup status for the super admin)
//   POST   /mail/mailboxes                                   create (super admin)
//   PATCH  /mail/mailboxes/{address}                         name, members, catch-all (super admin)
//   DELETE /mail/mailboxes/{address}                         stop receiving; history is kept (super admin)
//   GET    /mail/mailboxes/{address}/threads?status=&cursor= conversation list
//   POST   /mail/mailboxes/{address}/send                    start a new conversation
//   GET    /mail/mailboxes/{address}/threads/{thread}        conversation with messages (marks it read)
//   PATCH  /mail/mailboxes/{address}/threads/{thread}        status, assignee, unread
//   POST   /mail/mailboxes/{address}/threads/{thread}/reply  reply
//   GET    .../threads/{thread}/messages/{msg}/attachments/{n}  short-lived download link
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { GetAccountCommand, GetEmailIdentityCommand, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  buildRawEmail,
  canManageMailboxes,
  canUseMailbox,
  cleanEmailList,
  cleanMailboxAddress,
  isMailStaff,
  mailDomains,
  newId,
  quoteReply,
  replySubject,
  THREAD_STATUSES,
} from './model.mjs';

export function registerMailRoutes(route, { store, s3, ses, bucket, HttpError }) {
  const domains = mailDomains();
  const bad = (message) => new HttpError(400, message);
  const clean = (fn) => {
    try {
      return fn();
    } catch (error) {
      throw bad(error.message);
    }
  };

  async function openMailbox(me, address) {
    const mailbox = await store.getMailbox(String(address).toLowerCase());
    if (!mailbox || !canUseMailbox(me, mailbox)) throw new HttpError(404, 'Mailbox not found.');
    return mailbox;
  }

  async function openThread(me, address, threadId) {
    const mailbox = await openMailbox(me, address);
    const thread = await store.getThread(mailbox.address, threadId);
    if (!thread) throw new HttpError(404, 'Conversation not found.');
    return { mailbox, thread };
  }

  const mailboxOut = (m, me, counts = {}) => ({
    address: m.address,
    displayName: m.displayName || '',
    catchAll: Boolean(m.catchAll),
    members: canManageMailboxes(me) ? m.members || [] : undefined,
    lastReceivedAt: m.lastReceivedAt || null,
    ...counts,
  });

  const threadOut = (t) => ({
    id: t.threadId,
    subject: t.subject,
    status: t.status,
    assignee: t.assignee || null,
    unread: Boolean(t.unread),
    participants: t.participants || [],
    lastMessageAt: t.lastMessageAt,
    lastDirection: t.lastDirection,
    lastFrom: t.lastFrom || null,
    snippet: t.snippet || '',
    messageCount: t.messageCount || 0,
    attachmentCount: t.attachmentCount || 0,
  });

  const messageOut = (m, html) => ({
    id: m.id,
    direction: m.direction,
    from: m.from,
    to: m.to,
    cc: m.cc,
    replyTo: m.replyTo || [],
    subject: m.subject,
    text: m.text,
    textTruncated: Boolean(m.textTruncated),
    html,
    attachments: (m.attachments || []).map(({ filename, contentType, size }) => ({ filename, contentType, size })),
    verdicts: m.verdicts,
    sentBy: m.sentBy,
    createdAt: m.createdAt,
  });

  // Setup checklist for the super admin: is each domain verified for sending, and is SES out of the sandbox?
  async function sendingStatus() {
    const [account, identities] = await Promise.all([
      ses.send(new GetAccountCommand({})).catch(() => null),
      Promise.all(
        domains.map((domain) =>
          ses
            .send(new GetEmailIdentityCommand({ EmailIdentity: domain }))
            .then((identity) => ({ domain, sending: Boolean(identity.VerifiedForSendingStatus), dkim: identity.DkimAttributes?.Status || null }))
            .catch(() => ({ domain, sending: false, dkim: 'NOT_SET_UP' })),
        ),
      ),
    ]);
    return { sandbox: account ? !account.ProductionAccessEnabled : null, domains: identities };
  }

  async function send(me, mailbox, { to, cc, subject, text, inReplyTo, references, threadId }) {
    if (!to.length) throw bad('Add at least one recipient.');
    if (!String(text || '').trim()) throw bad('Write a message first.');
    const raw = buildRawEmail({
      from: { name: mailbox.displayName || '', address: mailbox.address },
      to,
      cc,
      subject,
      text,
      inReplyTo,
      references,
    });
    let sent;
    try {
      sent = await ses.send(new SendEmailCommand({
        FromEmailAddress: mailbox.address,
        Destination: { ToAddresses: to, CcAddresses: cc },
        Content: { Raw: { Data: Buffer.from(raw) } },
      }));
    } catch (error) {
      console.error('SES send failed', error);
      if (/not verified/i.test(error.message)) {
        throw bad('Amazon SES is still in sandbox mode, so mail can only go to addresses verified in SES. Request production access to email anyone.');
      }
      throw bad(`Couldn’t send: ${error.message}`);
    }
    const id = newId();
    const rawKey = `outbound/${id}.eml`;
    await store.putObject(rawKey, raw, 'message/rfc822');
    const { thread } = await store.saveMessage(
      mailbox.address,
      {
        id,
        direction: 'out',
        from: { name: mailbox.displayName || '', address: mailbox.address },
        to,
        cc,
        subject,
        text,
        html: null,
        // SES replaces our Message-ID with its own; replies reference that one.
        headerMessageId: `<${sent.MessageId}@email.amazonses.com>`,
        rawKey,
        sentBy: me.email,
      },
      threadId ? { threadId } : {},
    );
    return thread;
  }

  route('GET', '/mail/mailboxes', async (me) => {
    const mailboxes = (await store.listMailboxes()).filter((m) => canUseMailbox(me, m));
    const out = await Promise.all(
      mailboxes.map(async (m) => mailboxOut(m, me, { openCount: await store.countThreads(m.address, 'open') })),
    );
    out.sort((a, b) => a.address.localeCompare(b.address));
    return {
      mailboxes: out,
      domains,
      canManage: canManageMailboxes(me),
      staff: isMailStaff(me.globalRole),
      setup: canManageMailboxes(me) ? await sendingStatus() : undefined,
    };
  });

  route('POST', '/mail/mailboxes', async (me, _p, body) => {
    if (!canManageMailboxes(me)) throw new HttpError(403, 'Only the super admin creates mailboxes.');
    const address = clean(() => cleanMailboxAddress(body.address, domains));
    const members = clean(() => cleanEmailList(body.members, { label: 'member email' }));
    const existing = await store.listMailboxes();
    if (existing.some((m) => m.address === address)) throw new HttpError(409, `${address} already exists.`);
    if (body.catchAll && existing.some((m) => m.catchAll && m.address.endsWith(`@${address.split('@')[1]}`))) {
      throw bad(`@${address.split('@')[1]} already has a catch-all mailbox.`);
    }
    const mailbox = {
      PK: `MAILBOX#${address}`,
      SK: 'META',
      GSI1PK: 'MAILBOX',
      GSI1SK: address,
      address,
      displayName: String(body.displayName || '').trim().slice(0, 80),
      members,
      catchAll: Boolean(body.catchAll),
      createdAt: new Date().toISOString(),
      createdBy: me.email,
    };
    await store.putMailbox(mailbox);
    return [201, { mailbox: mailboxOut(mailbox, me, { openCount: 0 }) }];
  });

  route('PATCH', '/mail/mailboxes/{address}', async (me, { address }, body) => {
    if (!canManageMailboxes(me)) throw new HttpError(403, 'Only the super admin changes mailboxes.');
    const mailbox = await openMailbox(me, address);
    const next = { ...mailbox };
    if ('displayName' in body) next.displayName = String(body.displayName || '').trim().slice(0, 80);
    if ('members' in body) next.members = clean(() => cleanEmailList(body.members, { label: 'member email' }));
    if ('catchAll' in body) {
      const domain = mailbox.address.split('@')[1];
      if (body.catchAll && (await store.listMailboxes()).some((m) => m.catchAll && m.address !== mailbox.address && m.address.endsWith(`@${domain}`))) {
        throw bad(`@${domain} already has a catch-all mailbox.`);
      }
      next.catchAll = Boolean(body.catchAll);
    }
    await store.putMailbox(next);
    return { mailbox: mailboxOut(next, me) };
  });

  route('DELETE', '/mail/mailboxes/{address}', async (me, { address }) => {
    if (!canManageMailboxes(me)) throw new HttpError(403, 'Only the super admin deletes mailboxes.');
    const mailbox = await openMailbox(me, address);
    await store.deleteMailbox(mailbox.address);
    return { deleted: true };
  });

  route('GET', '/mail/mailboxes/{address}/threads', async (me, { address }, _b, query) => {
    const mailbox = await openMailbox(me, address);
    const status = THREAD_STATUSES.includes(query.get('status')) ? query.get('status') : 'open';
    const { threads, cursor } = await store.listThreads(mailbox.address, status, { cursor: query.get('cursor') || undefined });
    return { threads: threads.map(threadOut), cursor };
  });

  route('POST', '/mail/mailboxes/{address}/send', async (me, { address }, body) => {
    const mailbox = await openMailbox(me, address);
    const to = clean(() => cleanEmailList(body.to, { label: 'recipient', max: 20 }));
    const cc = clean(() => cleanEmailList(body.cc, { label: 'recipient', max: 20 }));
    const subject = String(body.subject || '').trim().slice(0, 300);
    if (!subject) throw bad('Add a subject.');
    const thread = await send(me, mailbox, { to, cc, subject, text: String(body.text || '').slice(0, 100_000) });
    return [201, { thread: threadOut(thread) }];
  });

  route('GET', '/mail/mailboxes/{address}/threads/{thread}', async (me, { address, thread: threadId }) => {
    const { mailbox, thread } = await openThread(me, address, threadId);
    const messages = await store.listMessages(threadId);
    const withHtml = await Promise.all(
      messages.map(async (m) => messageOut(m, m.htmlKey ? (await store.readObject(m.htmlKey)).toString('utf8') : null)),
    );
    const current = thread.unread ? await store.updateThread(mailbox.address, threadId, { unread: false }) : thread;
    return { thread: threadOut(current), messages: withHtml };
  });

  route('PATCH', '/mail/mailboxes/{address}/threads/{thread}', async (me, { address, thread: threadId }, body) => {
    const { mailbox } = await openThread(me, address, threadId);
    const changes = {};
    if ('status' in body) {
      if (!THREAD_STATUSES.includes(body.status)) throw bad('Unknown status.');
      changes.status = body.status;
    }
    if ('assignee' in body) {
      changes.assignee = body.assignee ? clean(() => cleanEmailList([body.assignee], { label: 'assignee' })[0]) : null;
    }
    if ('unread' in body) changes.unread = Boolean(body.unread);
    const thread = await store.updateThread(mailbox.address, threadId, changes);
    return { thread: threadOut(thread) };
  });

  route('POST', '/mail/mailboxes/{address}/threads/{thread}/reply', async (me, { address, thread: threadId }, body) => {
    const { mailbox, thread } = await openThread(me, address, threadId);
    const messages = await store.listMessages(threadId);
    const last = messages.at(-1);
    const to = clean(() => cleanEmailList(body.to, { label: 'recipient', max: 20 }));
    const cc = clean(() => cleanEmailList(body.cc, { label: 'recipient', max: 20 }));
    const ids = messages.map((m) => m.headerMessageId).filter(Boolean);
    const updated = await send(me, mailbox, {
      to,
      cc,
      subject: replySubject(thread.subject),
      text: quoteReply(String(body.text || '').slice(0, 100_000), body.quote === false ? null : last),
      inReplyTo: ids.at(-1),
      references: ids.slice(-10),
      threadId,
    });
    return [201, { thread: threadOut(updated) }];
  });

  route('GET', '/mail/mailboxes/{address}/threads/{thread}/messages/{msg}/attachments/{n}', async (me, { address, thread: threadId, msg, n }) => {
    await openThread(me, address, threadId);
    const message = (await store.listMessages(threadId)).find((m) => m.id === msg);
    const attachment = message?.attachments?.[Number(n)];
    if (!attachment) throw new HttpError(404, 'Attachment not found.');
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: bucket,
        Key: attachment.key,
        ResponseContentDisposition: `attachment; filename="${attachment.filename.replace(/"/g, '')}"`,
      }),
      { expiresIn: 300 },
    );
    return { url, filename: attachment.filename };
  });
}
