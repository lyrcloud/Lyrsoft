// Lyrsoft chat and meetings, mounted on the work API (api/work/index.mjs) like the mail routes.
//
// Chat: every workspace has a team channel ("ws.<wsId>", its members); any two people who share a
// workspace (or a staff member and anyone) can message each other directly ("dm.<hash>"); and anyone
// can start a group with people they work with ("grp.<random>"). The app polls for new messages while
// a conversation is open.
//   GET  /chat                                  conversations, unread flags and people I can message
//   POST /chat/dm                               { email } open (or create) a direct conversation
//   POST /chat/groups                           { name, members } start a group
//   PATCH /chat/{conv}                          { name?, add? } rename a group or add people (members)
//   POST /chat/{conv}/leave                     leave a group
//   POST /chat/{conv}/uploads                   { name, type, size } a short-lived upload URL for a photo or file
//   POST /chat/{conv}/typing                    "I'm typing" (shown to others for a few seconds)
//   PATCH /chat/{conv}/messages/{id}            { at, body } edit your message
//   DELETE /chat/{conv}/messages/{id}?at=       unsend your message (its files are deleted)
//   POST /chat/{conv}/messages/{id}/react       { at, emoji } add or remove your reaction
// Messages can reply to another ({ replyTo: { id, at } }) and carry files ({ attachments }). GET
// messages?since=<serverTime> returns what's new or changed since the last poll, plus who's typing,
// who has seen what (DMs and groups) and who's active. Every meeting has a conversation for its chat:
// the one it was started from, or a group of the host and invitees made with the meeting.
//   GET  /chat/{conv}/messages?after=<iso>      messages (newest 100, or those after `after`); marks read
//   POST /chat/{conv}/messages                  { body }
//
// Meetings: scheduled or instant video calls on Amazon Chime SDK. The invitees get an email with a
// Join link (/app/#/meet/<id>); joining creates the Chime meeting on first use (Chime ends it a few
// minutes after everyone leaves, and the next join starts a fresh one).
//   GET    /meetings                           my upcoming and recent meetings
//   POST   /meetings                           { title, startsAt?, durationMin, invitees?, timeZone, conv?, notify? }
//                                               (from a conversation, invitees default to everyone in it)
//   GET    /meetings/{id}                      details
//   POST   /meetings/{id}/invite               { invitees } invite more people (host or staff)
//   POST   /meetings/{id}/join                 Chime meeting + attendee for this person
//   DELETE /meetings/{id}                      cancel (host or staff); invitees are emailed
//
// Lyr Chat (lyrsoft.com/chat/) adds, on top of the above:
//   POST /chat/dm                               { email } or { phone }: anyone on Lyrsoft, not only co-workers.
//                                               A stranger's first chat is a message request (see lyrchat-model.mjs).
//   POST /chat/{conv}/request                   { action: 'accept' | 'delete' } a request someone sent me
//   POST /chat/{conv}/block                     { on, report? } block (and report) or unblock the other person
//   GET  /chat/blocked                          people I've blocked
//   POST /calls                                 { conv, video } ring everyone in a DM or group
//   GET  /calls                                 my call history       GET /calls/ringing   calls ringing for me
//   GET  /calls/{id}                            status (the caller watches for answer / decline)
//   POST /calls/{id}/answer | decline | end
//   POST /public/call                           { id, email, t } "Decline" from a notification (signed token)
//   GET  /push/key, POST /push/subscribe, POST /push/unsubscribe   Web Push for new messages and calls
//
// Keys in the work table:
//   CHAT#<conv>      META                conversation (lastMessageAt, lastSnippet, lastAuthor; members for DMs)
//   CHAT#<conv>      MSG#<iso>#<id>      message
//   CHAT#<conv>      MEMBER#<email>      DM membership     GSI1: CHATUSER#<email> / <conv>
//   CHATREAD#<email> <conv>              when this person last read the conversation
//   MEETING#<id>     META                meeting
//   MEETING#<id>     INVITE#<email>      host and invitees  GSI1: MEETUSER#<email> / <startsAt>#<id>
//   BLOCK#<email>    <blocked email>     { conv, name, at }
//   REPORT#<iso>     <conv>              a reported chat (also emailed to the super admin)
//   CALL#<id>        META                a ringing or finished call (lyrchat-model.mjs)
//   CALL#<id>        USER#<email>        caller and callees  GSI1: CALLUSER#<email> / <startedAt>#<id>
import { CreateAttendeeCommand, CreateMeetingCommand, DeleteMeetingCommand, GetMeetingCommand } from '@aws-sdk/client-chime-sdk-meetings';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { safeFilename } from '../mail/model.mjs';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { meetingInviteEmail } from './account.mjs';
import {
  answerCall,
  CALL_RING_MS,
  callLogEntry,
  callSummary,
  callToken,
  canCall,
  declineCall,
  DM_REQUESTS_PER_DAY,
  endCall,
  maskFor,
  maskJson,
  messagePush,
  postBlocked,
  REPORT_MESSAGES,
  requestState,
  ringsFor,
  validCallToken,
} from './lyrchat-model.mjs';
import {
  ACTIVE_MS,
  ATTACHMENT_BYTES_MAX,
  attachmentPrefix,
  cleanAttachments,
  reactionsOut,
  replyQuote,
  toggleReaction,
  TYPING_MS,
  attendeeExternalId,
  canManageMeeting,
  canSeeMeeting,
  GUEST_KEY_RE,
  newGuestKey,
  PHONE_LOOKUPS_PER_DAY,
  profileForPhone,
  channelId,
  cleanInvitees,
  cleanMeeting,
  cleanGroupName,
  cleanMessage,
  CONV_RE,
  GROUP_MEMBERS_MAX,
  groupId,
  dmId,
  formatMeetingTime,
  isUnread,
  snippetOf,
  validTimeZone,
} from './collab-model.mjs';

const MEETING_ID_RE = /^[0-9a-f-]{36}$/;
const CALL_ID_RE = /^[0-9a-f-]{36}$/;
const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';

export function registerCollabRoutes(route, { db, HttpError, openWorkspace, isStaff, memberships, listProfiles, sendEmail, siteUrl, chime, now, newId, s3, bucket, addWorkspaceMember, countUse, push, getSecret, reportTo }) {
  const { get, put, queryAll } = db;
  const bad = (message) => new HttpError(400, message);
  const tryClean = (fn) => {
    try {
      return fn();
    } catch (error) {
      throw bad(error.message);
    }
  };

  // ---------------------------------------------------------------- chat

  // Opens a conversation the caller may use: a workspace channel (workspace members and staff) or a DM
  // they're part of. Returns { conv, meta, members } where members are emails (null = the workspace's).
  async function openConversation(me, conv) {
    if (!CONV_RE.test(conv)) throw new HttpError(404, 'Conversation not found.');
    if (conv.startsWith('ws.')) {
      const { workspace } = await openWorkspace(me, conv.slice(3));
      const meta = (await get(`CHAT#${conv}`, 'META')) || { conv, type: 'ws', wsId: workspace.wsId };
      return { conv, meta: { ...meta, title: workspace.name }, workspace };
    }
    const meta = await get(`CHAT#${conv}`, 'META');
    if (!meta || !meta.members.includes(me.email)) throw new HttpError(404, 'Conversation not found.');
    return { conv, meta };
  }

  // People the caller can message: everyone in their workspaces; staff can message every account.
  async function contactsFor(me) {
    const people = new Map();
    if (isStaff(me.globalRole)) {
      for (const p of await listProfiles()) if (p.email) people.set(p.email, { email: p.email, name: p.name || '' });
    }
    for (const m of await memberships(me.email)) {
      for (const member of await queryAll({ KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)', ExpressionAttributeValues: { ':pk': `WS#${m.wsId}`, ':sk': 'MEMBER#' } })) {
        if (!people.has(member.email) || !people.get(member.email).name) people.set(member.email, { email: member.email, name: member.name || '' });
      }
    }
    people.delete(me.email);
    return [...people.values()].sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
  }

  // ---------------------------------------------------------------- blocking and people beyond co-workers

  const blockedBy = async (blocker, email) => Boolean(await get(`BLOCK#${blocker}`, email));
  const eitherBlocked = async (a, b) => (await blockedBy(a, b)) || (await blockedBy(b, a));
  const profileByEmail = async (email) => (await listProfiles()).find((p) => p.email === email && !p.disabled) || null;
  const otherOf = (meta, email) => meta.members.find((e) => e !== email) || email;

  // Everyone I can put in a group or call: co-workers plus people I have an accepted chat with.
  async function peopleFor(me) {
    const people = new Map((await contactsFor(me)).map((c) => [c.email, c]));
    const rows = await queryAll({ IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :pk', ExpressionAttributeValues: { ':pk': `CHATUSER#${me.email}` } });
    for (const row of rows.filter((r) => r.conv.startsWith('dm.'))) {
      const meta = await get(`CHAT#${row.conv}`, 'META');
      if (!meta || requestState(meta, me.email) !== 'none') continue;
      const other = otherOf(meta, me.email);
      if (other !== me.email && !people.has(other) && !(await blockedBy(me.email, other))) people.set(other, { email: other, name: meta.names?.[other] || '' });
    }
    return [...people.values()].sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
  }

  // New messages reach everyone else's devices (the service worker hides them while the app is in view).
  async function notifyMessage(me, conv, meta, message) {
    if (!push || !['dm', 'group'].includes(meta.type) || ['system', 'call'].includes(message.kind)) return;
    const recipients = [];
    for (const email of meta.members.filter((e) => e !== me.email).slice(0, 100)) {
      if (!(await blockedBy(email, me.email))) recipients.push(email);
    }
    const snippet = message.body ? snippetOf(message.body) : message.attachments?.length ? (message.attachments.some((a) => /^audio\//.test(a.type)) ? '🎙 Voice message' : message.attachments.some((a) => /^image\//.test(a.type)) ? '📷 Photo' : '📎 File') : '';
    const request = requestState(meta, me.email) === 'outgoing';
    await push.send(recipients, messagePush({ conv, meta, author: me.name || me.email, snippet, request }), { ttl: 86400, topic: `m${conv.replace(/\W/g, '')}` });
  }

  // Photos and files are private in the mail bucket; the app gets links that work for an hour.
  const signedUrl = (key, download) =>
    getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key, ...(download ? { ResponseContentDisposition: `attachment; filename="${download.replace(/"/g, '')}"` } : {}) }), { expiresIn: 3600 });

  async function messageOut(m, me, nameOf = (e) => e) {
    const deleted = Boolean(m.deletedAt);
    return {
      id: m.id,
      at: m.createdAt,
      body: deleted ? '' : m.body,
      kind: m.kind || 'text',
      meetingId: m.meetingId || null,
      callId: m.callId || null,
      video: m.video ?? null,
      authorEmail: m.authorEmail,
      authorName: m.authorName || '',
      createdAt: m.createdAt,
      editedAt: m.editedAt || null,
      deleted,
      replyTo: deleted ? null : m.replyTo || null,
      reactions: deleted ? [] : reactionsOut(m.reactions, me.email, nameOf),
      attachments: deleted
        ? []
        : await Promise.all((m.attachments || []).map(async (a) => ({ name: a.name, type: a.type, size: a.size, url: await signedUrl(a.key), download: await signedUrl(a.key, a.name) }))),
    };
  }

  async function postMessage(me, conv, meta, { body, kind = 'text', meetingId = null, replyTo = null, attachments = [], callId = null, video = null }) {
    const createdAt = now();
    const id = newId();
    const message = { PK: `CHAT#${conv}`, SK: `MSG#${createdAt}#${id}`, id, conv, body, kind, meetingId, callId, video, replyTo, attachments, authorEmail: me.email, authorName: me.name || '', createdAt, updatedAt: createdAt };
    await put(message);
    // A channel's title comes from its workspace, so it isn't stored; a group keeps its own name.
    const { title, ...rest } = meta;
    const stored = meta.type === 'group' ? meta : rest;
    await put({ ...stored, PK: `CHAT#${conv}`, SK: 'META', conv, lastMessageAt: createdAt, lastSnippet: snippetOf(kind === 'meeting' ? `📹 ${body}` : kind === 'call' ? `${video ? '📹' : '📞'} ${body}` : body || (attachments.length ? (attachments.every((a) => /^audio\//.test(a.type)) ? '🎙 Voice message' : `📎 ${attachments.length === 1 ? attachments[0].name : `${attachments.length} files`}`) : '')), lastAuthor: me.email });
    await put({ PK: `CHATREAD#${me.email}`, SK: conv, lastReadAt: createdAt });
    await notifyMessage(me, conv, meta, message).catch((error) => console.error('Message push failed', error));
    return message;
  }

  // Presence: when each person last had Lyrsoft open (refreshed by their chat polling).
  const touchPresence = (me) => put({ PK: `PRESENCE#${me.email}`, SK: 'META', at: now() });
  const lastSeen = async (email) => (await get(`PRESENCE#${email}`, 'META'))?.at || null;

  route('GET', '/chat', async (me) => {
    await touchPresence(me);
    const reads = new Map((await queryAll({ KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': `CHATREAD#${me.email}` } })).map((r) => [r.SK, r.lastReadAt]));
    const out = (conv, meta, extra) => ({
      id: conv,
      lastMessageAt: meta?.lastMessageAt || null,
      lastSnippet: meta?.lastSnippet || '',
      lastAuthor: meta?.lastAuthor || null,
      unread: isUnread(meta, me.email, reads.get(conv)),
      ...extra,
    });
    const channels = await Promise.all(
      (await memberships(me.email)).map(async (m) => out(channelId(m.wsId), await get(`CHAT#${channelId(m.wsId)}`, 'META'), { type: 'ws', title: m.wsName, wsId: m.wsId })),
    );
    const dmRows = await queryAll({ IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :pk', ExpressionAttributeValues: { ':pk': `CHATUSER#${me.email}` } });
    const contacts = await contactsFor(me);
    const names = new Map(contacts.map((c) => [c.email, c.name]));
    const rows = (await Promise.all(
      dmRows.map(async (row) => {
        const meta = await get(`CHAT#${row.conv}`, 'META');
        if (!meta) return null;
        if (meta.type === 'group') {
          return out(row.conv, meta, { type: 'group', title: meta.title, memberCount: meta.members.length, members: meta.members });
        }
        const other = meta.members.find((e) => e !== me.email) || me.email;
        const request = requestState(meta, me.email);
        // A request I blocked disappears; one I sent to someone who blocked me just stays unanswered.
        if (request === 'blocked' && meta.request.to === me.email) return null;
        const mask = maskFor(meta, me.email);
        const name = names.get(other) || meta.names?.[other] || '';
        return out(row.conv, meta, {
          type: 'dm',
          title: mask ? [name, meta.request.label].filter(Boolean).join(' · ') : name || other,
          with: mask ? null : other,
          activeAt: mask || request !== 'none' ? null : await lastSeen(other),
          request: request === 'blocked' ? 'outgoing' : request,
          blocked: await blockedBy(me.email, other),
        });
      }),
    )).filter(Boolean);
    const requests = rows.filter((c) => c.type === 'dm' && c.request === 'incoming');
    const dms = rows.filter((c) => c.type === 'dm' && c.request !== 'incoming');
    const groups = rows.filter((c) => c.type === 'group');
    const byRecent = (a, b) => String(b.lastMessageAt || '').localeCompare(String(a.lastMessageAt || '')) || a.title.localeCompare(b.title);
    return {
      channels: channels.sort(byRecent),
      groups: groups.sort(byRecent),
      dms: dms.sort(byRecent),
      requests: requests.sort(byRecent),
      contacts,
      requestCount: requests.length,
      unreadCount: [...channels, ...groups, ...dms].filter((c) => c.unread).length,
    };
  });

  // A DM with a co-worker opens straight away. Anyone else on Lyrsoft (found by email, or by the mobile
  // number they verified) gets a message request; found by number, their email stays hidden from me.
  route('POST', '/chat/dm', async (me, _p, body) => {
    const byPhone = !body.email && Boolean(body.phone);
    let email = String(body.email || '').trim().toLowerCase();
    let account = null;
    if (byPhone) {
      account = await accountForPhone(me, body.phone);
      if (!account) throw new HttpError(404, 'No one on Lyrsoft has verified that number yet. Invite them instead.');
      email = account.email;
    }
    if (!email || email === me.email) throw bad(email ? 'That’s you.' : 'Choose someone to message.');
    if (!EMAIL_RE.test(email)) throw bad('Enter a valid email address.');
    const conv = dmId(me.email, email);
    const existing = await get(`CHAT#${conv}`, 'META');
    const contact = (await contactsFor(me)).find((c) => c.email === email);
    if (existing) {
      // A request I had deleted comes back when I open the chat myself.
      if (!existing.members.includes(me.email)) throw new HttpError(404, 'Conversation not found.');
      await put(memberRow(conv, me.email));
      return dmOut(me, existing, contact);
    }
    let request = null;
    if (!contact) {
      if ((await countUse(`dm-request#${me.userId}`, 'day')) > DM_REQUESTS_PER_DAY) throw new HttpError(429, 'You’ve started a lot of new chats today. Try again tomorrow.');
      account ??= await profileByEmail(email);
      if (!account) throw new HttpError(404, 'There’s no Lyrsoft account with that email yet. Invite them instead.');
      if (await blockedBy(email, me.email)) throw new HttpError(403, 'You can’t message this person.');
      request = { from: me.email, to: email, status: 'pending', at: now(), masked: byPhone, label: byPhone ? String(body.phone).trim().slice(0, 30) : '' };
    }
    const createdAt = now();
    const otherName = contact?.name || (byPhone ? firstName(account?.name) : account?.name || '');
    const meta = { PK: `CHAT#${conv}`, SK: 'META', conv, type: 'dm', members: [me.email, email].sort(), names: { [me.email]: me.name || '', [email]: otherName }, createdAt, ...(request ? { request } : {}) };
    await put(meta);
    for (const member of [me.email, email]) await put(memberRow(conv, member));
    return dmOut(me, meta, contact);
  });

  function dmOut(me, meta, contact) {
    const other = otherOf(meta, me.email);
    const mask = maskFor(meta, me.email);
    const name = contact?.name || meta.names?.[other] || '';
    return { id: meta.conv, title: mask ? [name, meta.request.label].filter(Boolean).join(' · ') : name || other, with: mask ? null : other, request: requestState(meta, me.email) };
  }

  route('POST', '/chat/{conv}/request', async (me, { conv }, body) => {
    const { meta } = await openConversation(me, conv);
    if (requestState(meta, me.email) !== 'incoming') throw bad('There’s no message request here.');
    if (body.action === 'accept') {
      await put({ ...meta, request: { ...meta.request, status: 'accepted', acceptedAt: now() } });
      return { accepted: true };
    }
    if (body.action === 'delete') {
      await db.del(`CHAT#${conv}`, `MEMBER#${me.email}`);
      return { deleted: true };
    }
    throw bad('Accept or delete the request.');
  });

  // Blocking stops their messages and calls in your DM (group chats are unaffected). Reporting also
  // sends the chat's recent messages to Lyrsoft.
  route('POST', '/chat/{conv}/block', async (me, { conv }, body) => {
    const { meta } = await openConversation(me, conv);
    if (meta.type !== 'dm') throw bad('You can block people from a direct chat.');
    const other = otherOf(meta, me.email);
    if (body.on === false) {
      await db.del(`BLOCK#${me.email}`, other);
      if (meta.request?.status === 'blocked' && meta.request.to === me.email) await put({ ...meta, request: { ...meta.request, status: 'accepted', acceptedAt: now() } });
      return { blocked: false };
    }
    const mask = maskFor(meta, me.email);
    await put({ PK: `BLOCK#${me.email}`, SK: other, conv, name: [meta.names?.[other], mask ? meta.request.label : ''].filter(Boolean).join(' · ') || (mask ? 'Someone' : other), at: now() });
    if (requestState(meta, me.email) === 'incoming') await put({ ...meta, request: { ...meta.request, status: 'blocked' } });
    if (body.report) {
      const rows = await queryAll({ KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)', ExpressionAttributeValues: { ':pk': `CHAT#${conv}`, ':sk': 'MSG#' } });
      const recent = rows.slice(-REPORT_MESSAGES).map((m) => `[${m.createdAt}] ${m.authorEmail}: ${m.deletedAt ? '(unsent)' : m.body || (m.attachments || []).map((a) => `📎 ${a.name}`).join(', ')}`);
      await put({ PK: `REPORT#${now()}`, SK: conv, conv, by: me.email, about: other, reason: String(body.reason || '').slice(0, 500), messages: recent });
      if (reportTo) {
        const text = `${me.name || me.email} <${me.email}> reported ${meta.names?.[other] || ''} <${other}> in Lyr Chat.\n\nReason: ${String(body.reason || '(none given)').slice(0, 500)}\nConversation: ${conv}\n\nRecent messages:\n${recent.join('\n') || '(none)'}\n`;
        await sendEmail(reportTo, { subject: `Lyr Chat report: ${other}`, text, html: `<pre style="white-space:pre-wrap;font:14px/1.5 monospace">${text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])}</pre>` }).catch((error) => console.error('Report email failed', error));
      }
    }
    return { blocked: true, reported: Boolean(body.report) };
  });

  route('GET', '/chat/blocked', async (me) => {
    const rows = await queryAll({ KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': `BLOCK#${me.email}` } });
    return { blocked: rows.map((r) => ({ conv: r.conv, name: r.name, at: r.at })) };
  });

  // ---------------------------------------------------------------- groups

  const memberRow = (conv, email) => ({ PK: `CHAT#${conv}`, SK: `MEMBER#${email}`, GSI1PK: `CHATUSER#${email}`, GSI1SK: conv, conv, email });

  // Emails the caller may put in a group: people they share a workspace with (anyone, for staff).
  async function groupPeople(me, emails) {
    const contacts = new Map((await peopleFor(me)).map((c) => [c.email, c]));
    const list = tryClean(() => cleanInvitees(emails)).filter((e) => e !== me.email);
    const stranger = list.find((e) => !contacts.has(e));
    if (stranger) throw new HttpError(403, `You can add people you work with or already chat with. ${stranger} isn’t one yet: message them first.`);
    return list.map((e) => contacts.get(e));
  }

  async function openGroup(me, conv) {
    const { meta } = await openConversation(me, conv);
    if (meta.type !== 'group') throw bad('Only groups can be changed.');
    return meta;
  }

  // A one-line notice in the conversation ("Ada added Ben").
  const notice = (me, conv, meta, body) => postMessage(me, conv, meta, { body, kind: 'system' });

  route('POST', '/chat/groups', async (me, _p, body) => {
    const name = tryClean(() => cleanGroupName(body.name));
    const people = await groupPeople(me, body.members);
    if (!people.length) throw bad('Add at least one person to the group.');
    if (people.length + 1 > GROUP_MEMBERS_MAX) throw bad(`A group can have up to ${GROUP_MEMBERS_MAX} people.`);
    const conv = groupId(randomBytes(12).toString('hex'));
    const members = [me.email, ...people.map((p) => p.email)];
    const meta = {
      PK: `CHAT#${conv}`,
      SK: 'META',
      conv,
      type: 'group',
      title: name,
      members,
      names: Object.fromEntries([[me.email, me.name || ''], ...people.map((p) => [p.email, p.name || ''])]),
      createdBy: me.email,
      createdAt: now(),
    };
    await put(meta);
    for (const email of members) await put(memberRow(conv, email));
    await notice(me, conv, meta, `${me.name || me.email} created the group “${name}”`);
    return [201, { id: conv, title: name }];
  });

  route('PATCH', '/chat/{conv}', async (me, { conv }, body) => {
    let meta = await openGroup(me, conv);
    if ('name' in body) {
      const name = tryClean(() => cleanGroupName(body.name));
      if (name !== meta.title) {
        meta = { ...meta, title: name };
        await put(meta);
        await notice(me, conv, meta, `${me.name || me.email} renamed the group to “${name}”`);
      }
    }
    if (body.add) {
      const added = (await groupPeople(me, body.add)).filter((p) => !meta.members.includes(p.email));
      if (!added.length) throw bad('Everyone you picked is already in the group.');
      if (meta.members.length + added.length > GROUP_MEMBERS_MAX) throw bad(`A group can have up to ${GROUP_MEMBERS_MAX} people.`);
      meta = { ...meta, members: [...meta.members, ...added.map((p) => p.email)], names: { ...meta.names, ...Object.fromEntries(added.map((p) => [p.email, p.name || ''])) } };
      await put(meta);
      for (const p of added) await put(memberRow(conv, p.email));
      await notice(me, conv, meta, `${me.name || me.email} added ${added.map((p) => p.name || p.email).join(', ')}`);
    }
    const { PK, SK, ...group } = meta;
    return { group: { id: conv, title: group.title, members: group.members, names: group.names } };
  });

  route('POST', '/chat/{conv}/leave', async (me, { conv }) => {
    const meta = await openGroup(me, conv);
    const next = { ...meta, members: meta.members.filter((e) => e !== me.email) };
    await notice(me, conv, next, `${me.name || me.email} left the group`);
    await put({ ...(await get(`CHAT#${conv}`, 'META')), members: next.members });
    await db.del(`CHAT#${conv}`, `MEMBER#${me.email}`);
    return { left: true };
  });

  const messageKey = (conv, id, at) => {
    if (!/^[\w-]{6,40}$/.test(String(id)) || !/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(String(at))) throw bad('Which message?');
    return [`CHAT#${conv}`, `MSG#${at}#${id}`];
  };
  async function openMessage(conv, id, at) {
    const message = await get(...messageKey(conv, id, at));
    if (!message) throw new HttpError(404, 'Message not found.');
    return message;
  }

  route('GET', '/chat/{conv}/messages', async (me, { conv }, _b, query) => {
    const serverTime = now();
    const { meta } = await openConversation(me, conv);
    const since = query.get('since') || query.get('after');
    const rows = await queryAll({ KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)', ExpressionAttributeValues: { ':pk': `CHAT#${conv}`, ':sk': 'MSG#' } });
    // New or changed (edited, unsent, reacted to) since the last poll; else the newest 100.
    const messages = since ? rows.filter((m) => m.createdAt > since || (m.updatedAt || '') > since) : rows.slice(-100);
    if (meta.lastMessageAt) await put({ PK: `CHATREAD#${me.email}`, SK: conv, lastReadAt: meta.lastMessageAt });
    await touchPresence(me);
    const nameOf = (email) => (email === me.email ? 'You' : meta.names?.[email] || email);
    const typingRows = await queryAll({ KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)', ExpressionAttributeValues: { ':pk': `CHAT#${conv}`, ':sk': 'TYPING#' } });
    const typing = typingRows
      .filter((t) => t.email !== me.email && Date.now() - Date.parse(t.at) < TYPING_MS)
      .map((t) => t.name || t.email);
    // Seen receipts and active status for DMs and groups (not for whole-workspace channels).
    const others = (meta.members || []).filter((e) => e !== me.email).slice(0, 30);
    const reads = Object.fromEntries(await Promise.all(others.map(async (e) => [e, (await get(`CHATREAD#${e}`, conv))?.lastReadAt || null])));
    const active = Object.fromEntries(await Promise.all(others.map(async (e) => [e, await lastSeen(e)])));
    const type = meta.type || (conv.startsWith('ws.') ? 'ws' : 'dm');
    const other = type === 'dm' ? otherOf(meta, me.email) : null;
    const blocked = other ? await blockedBy(me.email, other) : false;
    const request = type === 'dm' ? requestState(meta, me.email) : 'none';
    const out = {
      serverTime,
      conversation: {
        id: conv, type, title: meta.title || null, members: meta.members || null, names: meta.names || {}, createdBy: meta.createdBy || null, meetingId: meta.meetingId || null,
        request: request === 'blocked' ? 'outgoing' : request,
        label: meta.request?.label || '',
        blocked,
        canCall: type === 'group' || (type === 'dm' && canCall(meta, me.email, blocked || (await blockedBy(other, me.email)))),
      },
      messages: await Promise.all(messages.map((m) => messageOut(m, me, nameOf))),
      typing,
      // No read receipts or "active" until a request is accepted.
      reads: request === 'none' ? reads : {},
      active: request === 'none' ? active : {},
    };
    return maskJson(out, maskFor(meta, me.email));
  });

  route('POST', '/chat/{conv}/messages', async (me, { conv }, body) => {
    let { meta } = await openConversation(me, conv);
    if (meta.type === 'dm') {
      const other = otherOf(meta, me.email);
      const reason = postBlocked(meta, me.email, await eitherBlocked(me.email, other));
      if (reason) throw new HttpError(403, reason);
      // Replying to a request accepts it; writing again to a deleted request brings it back for them.
      if (requestState(meta, me.email) === 'incoming') {
        meta = { ...meta, request: { ...meta.request, status: 'accepted', acceptedAt: now() } };
        await put(meta);
      } else if (requestState(meta, me.email) === 'outgoing') await put(memberRow(conv, other));
    }
    const attachments = tryClean(() => cleanAttachments(body.attachments, conv));
    const text = attachments.length && !String(body.body || '').trim() ? '' : tryClean(() => cleanMessage(body.body));
    let replyTo = null;
    if (body.replyTo) replyTo = replyQuote(await openMessage(conv, body.replyTo.id, body.replyTo.at));
    const message = await postMessage(me, conv, meta, { body: text, replyTo, attachments });
    await db.del(`CHAT#${conv}`, `TYPING#${me.email}`);
    return [201, maskJson({ message: await messageOut(message, me) }, maskFor(meta, me.email))];
  });

  route('PATCH', '/chat/{conv}/messages/{id}', async (me, { conv, id }, body) => {
    await openConversation(me, conv);
    const message = await openMessage(conv, id, body.at);
    if (message.authorEmail !== me.email || message.kind !== 'text' || message.deletedAt) throw new HttpError(403, 'You can only edit your own messages.');
    const text = message.attachments?.length && !String(body.body || '').trim() ? '' : tryClean(() => cleanMessage(body.body));
    const next = { ...message, body: text, editedAt: now(), updatedAt: now() };
    await put(next);
    return { message: await messageOut(next, me) };
  });

  route('DELETE', '/chat/{conv}/messages/{id}', async (me, { conv, id }, _b, query) => {
    await openConversation(me, conv);
    const message = await openMessage(conv, id, query.get('at'));
    if (message.authorEmail !== me.email || message.kind !== 'text') throw new HttpError(403, 'You can only unsend your own messages.');
    for (const a of message.attachments || []) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: a.key })).catch(() => {});
    const next = { ...message, body: '', attachments: [], reactions: {}, replyTo: null, deletedAt: now(), updatedAt: now() };
    await put(next);
    // If it was the latest message, the conversation list shouldn't keep previewing it.
    const stored = await get(`CHAT#${conv}`, 'META');
    if (stored?.lastMessageAt === message.createdAt) await put({ ...stored, lastSnippet: 'Message unsent' });
    return { message: await messageOut(next, me) };
  });

  route('POST', '/chat/{conv}/messages/{id}/react', async (me, { conv, id }, body) => {
    await openConversation(me, conv);
    const message = await openMessage(conv, id, body.at);
    if (message.deletedAt || message.kind === 'system') throw bad('You can’t react to that.');
    const next = { ...message, reactions: tryClean(() => toggleReaction(message.reactions, body.emoji, me.email)), updatedAt: now() };
    await put(next);
    return { message: await messageOut(next, me) };
  });

  route('POST', '/chat/{conv}/typing', async (me, { conv }) => {
    await openConversation(me, conv);
    await put({ PK: `CHAT#${conv}`, SK: `TYPING#${me.email}`, email: me.email, name: me.name || '', at: now(), expiresAt: Math.floor(Date.now() / 1000) + 600 });
    return { ok: true };
  });

  route('POST', '/chat/{conv}/uploads', async (me, { conv }, body) => {
    await openConversation(me, conv);
    const size = Number(body.size);
    if (!Number.isFinite(size) || size <= 0) throw bad('That file is empty.');
    if (size > ATTACHMENT_BYTES_MAX) throw bad('Files can be up to 25 MB.');
    const name = safeFilename(body.name);
    const type = /^[\w.+-]+\/[\w.+-]+$/.test(String(body.type)) ? String(body.type) : 'application/octet-stream';
    const key = `${attachmentPrefix(conv)}${randomUUID()}/${name}`;
    const url = await getSignedUrl(s3, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: type }), { expiresIn: 600 });
    return { key, url, name, type, size };
  });

  // ---------------------------------------------------------------- meetings

  const meetingOut = (m, me) => ({
    id: m.meetingId,
    title: m.title,
    startsAt: m.startsAt,
    durationMin: m.durationMin,
    timeZone: m.timeZone,
    hostEmail: m.hostEmail,
    hostName: m.hostName || '',
    invitees: m.invitees || [],
    names: m.names || {},
    conv: m.conv || null,
    cancelled: Boolean(m.cancelledAt),
    canManage: canManageMeeting(m, me.email, isStaff(me.globalRole)),
    joinUrl: `${siteUrl}/app/#/meet/${m.meetingId}`,
    // Hosts get a link anyone can use (after signing in), to send by WhatsApp, SMS or anywhere.
    guestUrl: canManageMeeting(m, me.email, isStaff(me.globalRole)) && m.guestKey ? `${siteUrl}/app/#/meet/${m.meetingId}?k=${m.guestKey}` : null,
    createdAt: m.createdAt,
  });

  const keyMatches = (meeting, key) =>
    Boolean(meeting.guestKey && GUEST_KEY_RE.test(String(key || '')) && timingSafeEqual(Buffer.from(meeting.guestKey), Buffer.from(String(key))));

  // `key` is a guest link's secret: whoever opens the link (signed in) becomes an invitee.
  async function openMeeting(me, id, key) {
    let meeting = MEETING_ID_RE.test(id) ? await get(`MEETING#${id}`, 'META') : null;
    if (meeting && !canSeeMeeting(meeting, me.email, isStaff(me.globalRole)) && keyMatches(meeting, key) && !meeting.cancelledAt) {
      meeting = { ...meeting, invitees: [...(meeting.invitees || []), me.email], names: { ...meeting.names, [me.email]: me.name || '' } };
      await put(meeting);
      await put(inviteRow(meeting, me.email));
    }
    if (!meeting || !canSeeMeeting(meeting, me.email, isStaff(me.globalRole))) throw new HttpError(404, 'Meeting not found.');
    return meeting;
  }

  // The one Lyrsoft account with this verified mobile number, or null. Limited per person per day.
  async function accountForPhone(me, phone) {
    if ((await countUse(`phone-lookup#${me.userId}`, 'day')) > PHONE_LOOKUPS_PER_DAY) throw new HttpError(429, 'That’s a lot of phone lookups today. Try again tomorrow.');
    return profileForPhone(await listProfiles(), phone);
  }

  const inviteRow = (meeting, email) => ({
    PK: `MEETING#${meeting.meetingId}`,
    SK: `INVITE#${email}`,
    GSI1PK: `MEETUSER#${email}`,
    GSI1SK: `${meeting.startsAt}#${meeting.meetingId}`,
    meetingId: meeting.meetingId,
    email,
  });

  async function emailInvites(meeting, emails, cancelled = false) {
    let sent = 0;
    for (const email of emails) {
      try {
        await sendEmail(email, meetingInviteEmail({
          title: meeting.title,
          hostName: meeting.hostName,
          hostEmail: meeting.hostEmail,
          when: formatMeetingTime(meeting.startsAt, meeting.timeZone),
          durationMin: meeting.durationMin,
          joinUrl: `${siteUrl}/app/#/meet/${meeting.meetingId}`,
          cancelled,
        }, siteUrl));
        sent += 1;
      } catch (error) {
        console.error('Meeting email failed', email, error);
      }
    }
    return sent;
  }

  route('GET', '/meetings', async (me) => {
    const rows = await queryAll({ IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :pk', ExpressionAttributeValues: { ':pk': `MEETUSER#${me.email}` } });
    const since = new Date(Date.now() - 30 * 864e5).toISOString();
    const meetings = (await Promise.all(rows.filter((r) => r.GSI1SK >= since).map((r) => get(`MEETING#${r.meetingId}`, 'META')))).filter(Boolean);
    return { meetings: meetings.filter((m) => !m.callId).map((m) => meetingOut(m, me)).sort((a, b) => a.startsAt.localeCompare(b.startsAt)), contacts: await contactsFor(me) };
  });

  // Everyone in a conversation: both people in a DM, or every member of the workspace for a channel.
  async function conversationPeople(conversation) {
    if (conversation.meta.members) return conversation.meta.members;
    const rows = await queryAll({ KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)', ExpressionAttributeValues: { ':pk': `WS#${conversation.workspace.wsId}`, ':sk': 'MEMBER#' } });
    return rows.map((r) => r.email);
  }

  // The meeting's chat: the conversation it was started from, or a group of the host and invitees.
  async function ensureMeetingChat(meeting) {
    if (meeting.conv) return meeting;
    const conv = groupId(randomBytes(12).toString('hex'));
    const members = [meeting.hostEmail, ...meeting.invitees];
    const meta = {
      PK: `CHAT#${conv}`,
      SK: 'META',
      conv,
      type: 'group',
      title: `📹 ${meeting.title}`.slice(0, 80),
      members,
      names: meeting.names || {},
      createdBy: meeting.hostEmail,
      meetingId: meeting.meetingId,
      createdAt: now(),
    };
    await put(meta);
    for (const email of members) await put(memberRow(conv, email));
    const next = { ...meeting, conv };
    await put(next);
    return next;
  }

  // Adds people to a meeting's own group chat (not to a channel or DM it was started from).
  async function addToMeetingChat(meeting, emails) {
    const meta = meeting.conv && (await get(`CHAT#${meeting.conv}`, 'META'));
    if (!meta || meta.meetingId !== meeting.meetingId) return;
    const added = emails.filter((e) => !meta.members.includes(e));
    if (!added.length) return;
    await put({ ...meta, members: [...meta.members, ...added] });
    for (const email of added) await put(memberRow(meeting.conv, email));
  }

  route('POST', '/meetings', async (me, _p, body) => {
    let conversation = null;
    if (body.conv) conversation = await openConversation(me, String(body.conv));
    // A call started from a conversation invites everyone in it unless invitees are given.
    if (conversation && !body.invitees) body = { ...body, invitees: await conversationPeople(conversation) };
    const clean = tryClean(() => cleanMeeting(body, me.email));
    const contacts = await contactsFor(me);
    // Phone numbers invite the Lyrsoft accounts that verified them, if they share a workspace with
    // the host; anyone else gets the guest link (sent by WhatsApp or SMS from the app).
    const phoneMatches = [];
    for (const phone of (Array.isArray(body.invitePhones) ? body.invitePhones : []).slice(0, 10)) {
      const account = await accountForPhone(me, phone);
      const known = account && contacts.some((c) => c.email === account.email);
      phoneMatches.push({ phone: String(phone), invited: Boolean(known), name: known ? account.name || '' : '' });
      if (known && account.email !== me.email && !clean.invitees.includes(account.email)) clean.invitees.push(account.email);
    }
    const names = Object.fromEntries([[me.email, me.name || ''], ...contacts.map((c) => [c.email, c.name])].filter(([email]) => email === me.email || clean.invitees.includes(email)));
    const meeting = {
      PK: `MEETING#${randomUUID()}`,
      SK: 'META',
      ...clean,
      hostEmail: me.email,
      hostName: me.name || '',
      names,
      conv: conversation?.conv || null,
      guestKey: newGuestKey(),
      createdAt: now(),
    };
    meeting.meetingId = meeting.PK.slice('MEETING#'.length);
    await put(meeting);
    if (!conversation) Object.assign(meeting, await ensureMeetingChat(meeting));
    for (const email of [me.email, ...clean.invitees]) await put(inviteRow(meeting, email));
    const emailed = body.notify === false ? 0 : await emailInvites(meeting, clean.invitees);
    if (conversation) {
      await postMessage(me, conversation.conv, conversation.meta, { body: `${meeting.title} · ${formatMeetingTime(meeting.startsAt, meeting.timeZone)}`, kind: 'meeting', meetingId: meeting.meetingId });
    }
    return [201, { meeting: meetingOut(meeting, me), emailed, phones: phoneMatches }];
  });

  route('GET', '/meetings/{id}', async (me, { id }, _b, query) => {
    let meeting = await openMeeting(me, id, query?.get('k'));
    // Meetings from before guest links get one the first time their host opens them.
    if (!meeting.guestKey && canManageMeeting(meeting, me.email, isStaff(me.globalRole))) {
      meeting = { ...meeting, guestKey: newGuestKey() };
      await put(meeting);
    }
    return { meeting: meetingOut(meeting, me) };
  });

  // Who is this phone number on Lyrsoft? Only accounts that verified the number count. A co-worker
  // comes back with their email; anyone else only as "found", unless `addToWs` adds them to one of
  // my workspaces (I must be its owner or an admin), after which we share a workspace anyway.
  route('POST', '/people/phone', async (me, _p, body) => {
    const account = await accountForPhone(me, body.phone);
    if (!account) return { found: false };
    if (account.email === me.email) return { found: true, self: true };
    const coworker = (await contactsFor(me)).some((c) => c.email === account.email);
    if (!coworker && body.addToWs) {
      await addWorkspaceMember(me, String(body.addToWs), account.email);
      return { found: true, coworker: true, added: true, email: account.email, name: account.name || '' };
    }
    return coworker ? { found: true, coworker: true, email: account.email, name: account.name || '' } : { found: true, coworker: false, name: account.name ? account.name.split(' ')[0] : '' };
  });

  route('POST', '/meetings/{id}/invite', async (me, { id }, body) => {
    const meeting = await openMeeting(me, id);
    if (!canManageMeeting(meeting, me.email, isStaff(me.globalRole))) throw new HttpError(403, 'Only the host can invite people.');
    if (meeting.cancelledAt) throw bad('This meeting was cancelled.');
    const added = tryClean(() => cleanInvitees(body.invitees)).filter((e) => e !== meeting.hostEmail && !meeting.invitees.includes(e));
    if (!added.length) throw bad('Everyone you entered is already invited.');
    const next = { ...meeting, invitees: [...meeting.invitees, ...added].slice(0, 50) };
    await put(next);
    await addToMeetingChat(next, added);
    for (const email of added) await put(inviteRow(next, email));
    const emailed = body.notify === false ? 0 : await emailInvites(next, added);
    return { meeting: meetingOut(next, me), emailed };
  });

  route('DELETE', '/meetings/{id}', async (me, { id }) => {
    const meeting = await openMeeting(me, id);
    if (!canManageMeeting(meeting, me.email, isStaff(me.globalRole))) throw new HttpError(403, 'Only the host can cancel this meeting.');
    if (meeting.chimeMeetingId) await chime.send(new DeleteMeetingCommand({ MeetingId: meeting.chimeMeetingId })).catch(() => {});
    await put({ ...meeting, cancelledAt: now(), chimeMeetingId: null, chimeMeeting: null });
    const emailed = new Date(meeting.startsAt).getTime() + meeting.durationMin * 60_000 > Date.now() ? await emailInvites(meeting, meeting.invitees, true) : 0;
    return { cancelled: true, emailed };
  });

  // The Chime meeting for this Lyrsoft meeting: the stored one while it's still running, else a new one.
  async function chimeMeetingFor(meeting) {
    if (meeting.chimeMeetingId) {
      try {
        const { Meeting } = await chime.send(new GetMeetingCommand({ MeetingId: meeting.chimeMeetingId }));
        if (Meeting) return Meeting;
      } catch (error) {
        if (error.name !== 'NotFoundException') throw error;
      }
    }
    const { Meeting } = await chime.send(new CreateMeetingCommand({
      ClientRequestToken: randomUUID(),
      MediaRegion: process.env.AWS_REGION || 'us-east-1',
      ExternalMeetingId: `lyrsoft-${meeting.meetingId}`.slice(0, 64),
    }));
    await put({ ...meeting, chimeMeetingId: Meeting.MeetingId, chimeStartedAt: now() });
    return Meeting;
  }

  route('POST', '/meetings/{id}/join', async (me, { id }, body) => {
    let meeting = await openMeeting(me, id, body?.k);
    if (meeting.cancelledAt) throw bad('This meeting was cancelled.');
    // Meetings made before meeting chats get one now; staff joining uninvited get added to it.
    meeting = await ensureMeetingChat(meeting);
    await addToMeetingChat(meeting, [me.email]);
    let chimeMeeting;
    try {
      chimeMeeting = await chimeMeetingFor(meeting);
    } catch (error) {
      console.error('Chime meeting failed', error);
      throw new HttpError(502, 'Couldn’t start the video call. Please try again.');
    }
    const { Attendee } = await chime.send(new CreateAttendeeCommand({ MeetingId: chimeMeeting.MeetingId, ExternalUserId: attendeeExternalId(me.email) }));
    return { meeting: meetingOut(meeting, me), conv: meeting.conv, chime: { meeting: chimeMeeting, attendee: Attendee }, names: { ...meeting.names, [me.email]: me.name || meeting.names?.[me.email] || '' } };
  });

  // ---------------------------------------------------------------- calls (Lyr Chat)
  // A call is a meeting (so it runs on the same Chime call room) plus a CALL record that rings
  // everyone else in the DM or group: in the open app (GET /calls/ringing) and by push notification.

  const callUserRow = (call, email) => ({ PK: `CALL#${call.callId}`, SK: `USER#${email}`, GSI1PK: `CALLUSER#${email}`, GSI1SK: `${call.startedAt}#${call.callId}`, callId: call.callId, email });

  async function openCall(me, id) {
    const call = CALL_ID_RE.test(String(id)) ? await get(`CALL#${id}`, 'META') : null;
    if (!call || (call.from !== me.email && !call.members.includes(me.email))) throw new HttpError(404, 'Call not found.');
    return call;
  }

  const callOut = (call, me) => ({
    id: call.callId,
    conv: call.conv,
    convType: call.convType,
    meetingId: call.meetingId,
    video: Boolean(call.video),
    from: call.from === me.email ? 'me' : call.fromName || 'Someone',
    title: call.title,
    status: call.status,
    ringing: ringsFor(call, me.email),
    answered: (call.answeredBy || []).length,
    declined: (call.declinedBy || []).length,
    members: call.members.length,
    startedAt: call.startedAt,
  });

  // A DM call's ending is written into the chat once ("Missed voice call", "Voice call · 2:31"), and
  // anyone it was still ringing for gets the ringing notification replaced.
  async function finishCall(call) {
    if (call.summaryPosted || !['missed', 'declined', 'ended'].includes(call.status)) return call;
    const next = { ...call, summaryPosted: true };
    await put(next);
    if (call.convType === 'dm') {
      const meta = await get(`CHAT#${call.conv}`, 'META');
      if (meta) await postMessage({ email: call.from, name: call.fromName }, call.conv, meta, { body: callSummary(call), kind: 'call', callId: call.callId, meetingId: call.meetingId, video: Boolean(call.video) });
    }
    const unanswered = call.members.filter((e) => !(call.answeredBy || []).includes(e) && !(call.declinedBy || []).includes(e));
    await push?.send(call.members, (email) => ({
      type: 'call-end',
      callId: call.callId,
      tag: `call-${call.callId}`,
      ...(unanswered.includes(email) && call.status === 'missed'
        ? { missed: true, title: `Missed ${call.video ? 'video' : 'voice'} call`, body: call.convType === 'group' ? `${call.fromName} · ${call.title}` : call.fromName, url: `/chat/#/chat/${encodeURIComponent(call.conv)}` }
        : {}),
    }), { ttl: 600, urgency: 'high', topic: `c${call.callId.replace(/-/g, '').slice(0, 30)}` });
    return next;
  }

  route('POST', '/calls', async (me, _p, body) => {
    const { conv, meta } = await openConversation(me, String(body.conv || ''));
    if (!['dm', 'group'].includes(meta.type)) throw bad('Calls work in direct chats and groups.');
    let members = meta.members.filter((e) => e !== me.email);
    if (meta.type === 'dm') {
      const blocked = await eitherBlocked(me.email, members[0]);
      if (!canCall(meta, me.email, blocked)) throw new HttpError(403, blocked ? 'You can’t call this person.' : 'You can call once they accept your message request.');
    } else {
      const open = [];
      for (const email of members) if (!(await blockedBy(email, me.email))) open.push(email);
      members = open.slice(0, 49);
    }
    if (!members.length) throw bad('There’s no one else here to call.');
    const video = Boolean(body.video);
    const startedAt = now();
    const callId = randomUUID();
    const other = meta.type === 'dm' ? members[0] : null;
    const title = meta.type === 'group' ? meta.title : `${firstName(me.name) || me.email} and ${firstName(meta.names?.[other]) || other}`;
    const meetingId = randomUUID();
    const meeting = {
      PK: `MEETING#${meetingId}`, SK: 'META', meetingId, callId,
      title: `${video ? '📹' : '📞'} ${title}`.slice(0, 120),
      startsAt: startedAt, durationMin: 60, invitees: members, timeZone: 'UTC',
      hostEmail: me.email, hostName: me.name || '', names: { ...meta.names, [me.email]: me.name || '' },
      conv, guestKey: newGuestKey(), createdAt: startedAt,
    };
    await put(meeting);
    for (const email of [me.email, ...members]) await put(inviteRow(meeting, email));
    const call = { PK: `CALL#${callId}`, SK: 'META', callId, conv, convType: meta.type, meetingId, from: me.email, fromName: me.name || me.email, title: meta.type === 'group' ? meta.title : me.name || me.email, video, members, status: 'ringing', startedAt, answeredBy: [], declinedBy: [] };
    await put(call);
    for (const email of [me.email, ...members]) await put(callUserRow(call, email));
    // A group call stays joinable from the chat; a DM call is summed up in the chat when it ends.
    if (meta.type === 'group') await postMessage(me, conv, meta, { body: `${me.name || me.email} started a ${video ? 'video' : 'voice'} call`, kind: 'call', callId, meetingId, video });
    const secret = await getSecret();
    await push?.send(members, (email) => ({
      type: 'call',
      callId,
      conv,
      video,
      title: `Incoming ${video ? 'video' : 'voice'} call`,
      body: meta.type === 'group' ? `${me.name || me.email} · ${meta.title}` : me.name || me.email,
      tag: `call-${callId}`,
      url: `/chat/#/call/${callId}`,
      email,
      token: callToken(secret, callId, email),
    }), { ttl: Math.round(CALL_RING_MS / 1000), urgency: 'high', topic: `c${callId.replace(/-/g, '').slice(0, 30)}` });
    return [201, { call: callOut(call, me) }];
  });

  route('GET', '/calls/ringing', async (me) => {
    const since = new Date(Date.now() - CALL_RING_MS - 5000).toISOString();
    const rows = await queryAll({ IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :pk AND GSI1SK >= :since', ExpressionAttributeValues: { ':pk': `CALLUSER#${me.email}`, ':since': since } });
    const calls = (await Promise.all(rows.map((r) => get(`CALL#${r.callId}`, 'META')))).filter((c) => c && ringsFor(c, me.email));
    return { serverTime: now(), calls: calls.map((c) => callOut(c, me)) };
  });

  route('GET', '/calls', async (me) => {
    const since = new Date(Date.now() - 90 * 864e5).toISOString();
    const rows = await queryAll({ IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :pk AND GSI1SK >= :since', ExpressionAttributeValues: { ':pk': `CALLUSER#${me.email}`, ':since': since } });
    const recent = rows.sort((a, b) => b.GSI1SK.localeCompare(a.GSI1SK)).slice(0, 100);
    const metas = new Map();
    const calls = [];
    for (const row of recent) {
      const call = await get(`CALL#${row.callId}`, 'META');
      if (!call) continue;
      if (!metas.has(call.conv)) metas.set(call.conv, await get(`CHAT#${call.conv}`, 'META'));
      const meta = metas.get(call.conv);
      const other = call.convType === 'dm' && meta ? otherOf(meta, me.email) : null;
      calls.push({ ...callLogEntry(call, me.email), title: call.convType === 'group' ? meta?.title || call.title : meta?.names?.[other] || other || call.title });
    }
    return { calls };
  });

  route('GET', '/calls/{id}', async (me, { id }) => ({ call: callOut(await openCall(me, id), me) }));

  route('POST', '/calls/{id}/answer', async (me, { id }) => {
    let call = await openCall(me, id);
    call = tryClean(() => answerCall(call, me.email, now()));
    await put(call);
    // Stop it ringing on this person's other devices.
    await push?.send([me.email], { type: 'call-end', callId: call.callId, tag: `call-${call.callId}` }, { ttl: 60, urgency: 'high' });
    return { call: callOut(call, me) };
  });

  async function decline(email, call) {
    let next = tryClean(() => declineCall(call, email));
    await put(next);
    next = await finishCall(next);
    await push?.send([email], { type: 'call-end', callId: call.callId, tag: `call-${call.callId}` }, { ttl: 60, urgency: 'high' });
    return next;
  }

  route('POST', '/calls/{id}/decline', async (me, { id }) => ({ call: callOut(await decline(me.email, await openCall(me, id)), me) }));

  // Hanging up. The caller hanging up before anyone answered makes it a missed call; in a DM either
  // person hanging up ends it. A group call ends for the record when its caller leaves.
  route('POST', '/calls/{id}/end', async (me, { id }) => {
    let call = await openCall(me, id);
    if (call.convType === 'dm' || call.from === me.email) {
      if (call.status === 'ringing' && call.from !== me.email) call = declineCall(call, me.email);
      else call = endCall(call, now());
      await put(call);
      call = await finishCall(call);
    }
    return { call: callOut(call, me) };
  });

  // ---------------------------------------------------------------- push notifications

  route('GET', '/push/key', async () => ({ publicKey: push ? await push.publicKey() : null }));

  route('POST', '/push/subscribe', async (me, _p, body, _q, event) => {
    if (!push) throw new HttpError(503, 'Notifications aren’t set up.');
    await tryCleanAsync(() => push.subscribe(me.email, body.subscription, event?.headers?.['user-agent'] || ''));
    return { subscribed: true };
  });

  route('POST', '/push/unsubscribe', async (me, _p, body) => {
    await push?.unsubscribe(me.email, body.endpoint);
    return { subscribed: false };
  });

  async function tryCleanAsync(fn) {
    try {
      return await fn();
    } catch (error) {
      throw bad(error.message);
    }
  }

  // "Decline" on a call notification: the service worker has no sign-in, so the push carried a token.
  async function publicCall(body) {
    const call = CALL_ID_RE.test(String(body?.id)) ? await get(`CALL#${body.id}`, 'META') : null;
    const email = String(body?.email || '').toLowerCase();
    if (!call || !call.members.includes(email) || !validCallToken(await getSecret(), call.callId, email, body?.t)) throw new HttpError(404, 'Call not found.');
    if (body.action !== 'decline') throw bad('Unknown action.');
    if (call.status === 'ringing') await decline(email, call);
    return { declined: true };
  }

  return { publicCall };
}

export { channelId, validTimeZone };
