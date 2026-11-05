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
// Keys in the work table:
//   CHAT#<conv>      META                conversation (lastMessageAt, lastSnippet, lastAuthor; members for DMs)
//   CHAT#<conv>      MSG#<iso>#<id>      message
//   CHAT#<conv>      MEMBER#<email>      DM membership     GSI1: CHATUSER#<email> / <conv>
//   CHATREAD#<email> <conv>              when this person last read the conversation
//   MEETING#<id>     META                meeting
//   MEETING#<id>     INVITE#<email>      host and invitees  GSI1: MEETUSER#<email> / <startsAt>#<id>
import { CreateAttendeeCommand, CreateMeetingCommand, DeleteMeetingCommand, GetMeetingCommand } from '@aws-sdk/client-chime-sdk-meetings';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { safeFilename } from '../mail/model.mjs';
import { randomBytes, randomUUID } from 'node:crypto';
import { meetingInviteEmail } from './account.mjs';
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

export function registerCollabRoutes(route, { db, HttpError, openWorkspace, isStaff, memberships, listProfiles, sendEmail, siteUrl, chime, now, newId, s3, bucket }) {
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

  async function postMessage(me, conv, meta, { body, kind = 'text', meetingId = null, replyTo = null, attachments = [] }) {
    const createdAt = now();
    const id = newId();
    const message = { PK: `CHAT#${conv}`, SK: `MSG#${createdAt}#${id}`, id, conv, body, kind, meetingId, replyTo, attachments, authorEmail: me.email, authorName: me.name || '', createdAt, updatedAt: createdAt };
    await put(message);
    // A channel's title comes from its workspace, so it isn't stored; a group keeps its own name.
    const { title, ...rest } = meta;
    const stored = meta.type === 'group' ? meta : rest;
    await put({ ...stored, PK: `CHAT#${conv}`, SK: 'META', conv, lastMessageAt: createdAt, lastSnippet: snippetOf(kind === 'meeting' ? `📹 ${body}` : body || (attachments.length ? `📎 ${attachments.length === 1 ? attachments[0].name : `${attachments.length} files`}` : '')), lastAuthor: me.email });
    await put({ PK: `CHATREAD#${me.email}`, SK: conv, lastReadAt: createdAt });
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
        return out(row.conv, meta, { type: 'dm', title: names.get(other) || meta.names?.[other] || other, with: other, activeAt: await lastSeen(other) });
      }),
    )).filter(Boolean);
    const dms = rows.filter((c) => c.type === 'dm');
    const groups = rows.filter((c) => c.type === 'group');
    const byRecent = (a, b) => String(b.lastMessageAt || '').localeCompare(String(a.lastMessageAt || '')) || a.title.localeCompare(b.title);
    return {
      channels: channels.sort(byRecent),
      groups: groups.sort(byRecent),
      dms: dms.sort(byRecent),
      contacts,
      unreadCount: [...channels, ...groups, ...dms].filter((c) => c.unread).length,
    };
  });

  route('POST', '/chat/dm', async (me, _p, body) => {
    const email = String(body.email || '').trim().toLowerCase();
    if (!email || email === me.email) throw bad('Choose someone to message.');
    const contact = (await contactsFor(me)).find((c) => c.email === email);
    if (!contact) throw new HttpError(403, 'You can message people who share a workspace with you.');
    const conv = dmId(me.email, email);
    if (!(await get(`CHAT#${conv}`, 'META'))) {
      const createdAt = now();
      await put({ PK: `CHAT#${conv}`, SK: 'META', conv, type: 'dm', members: [me.email, email].sort(), names: { [me.email]: me.name || '', [email]: contact.name || '' }, createdAt });
      for (const member of [me.email, email]) {
        await put({ PK: `CHAT#${conv}`, SK: `MEMBER#${member}`, GSI1PK: `CHATUSER#${member}`, GSI1SK: conv, conv, email: member });
      }
    }
    return { id: conv, title: contact.name || email, with: email };
  });

  // ---------------------------------------------------------------- groups

  const memberRow = (conv, email) => ({ PK: `CHAT#${conv}`, SK: `MEMBER#${email}`, GSI1PK: `CHATUSER#${email}`, GSI1SK: conv, conv, email });

  // Emails the caller may put in a group: people they share a workspace with (anyone, for staff).
  async function groupPeople(me, emails) {
    const contacts = new Map((await contactsFor(me)).map((c) => [c.email, c]));
    const list = tryClean(() => cleanInvitees(emails)).filter((e) => e !== me.email);
    const stranger = list.find((e) => !contacts.has(e));
    if (stranger) throw new HttpError(403, `You can add people who share a workspace with you. ${stranger} doesn’t.`);
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
    return {
      serverTime,
      conversation: { id: conv, type: meta.type || (conv.startsWith('ws.') ? 'ws' : 'dm'), title: meta.title || null, members: meta.members || null, names: meta.names || {}, createdBy: meta.createdBy || null, meetingId: meta.meetingId || null },
      messages: await Promise.all(messages.map((m) => messageOut(m, me, nameOf))),
      typing,
      reads,
      active,
    };
  });

  route('POST', '/chat/{conv}/messages', async (me, { conv }, body) => {
    const { meta } = await openConversation(me, conv);
    const attachments = tryClean(() => cleanAttachments(body.attachments, conv));
    const text = attachments.length && !String(body.body || '').trim() ? '' : tryClean(() => cleanMessage(body.body));
    let replyTo = null;
    if (body.replyTo) replyTo = replyQuote(await openMessage(conv, body.replyTo.id, body.replyTo.at));
    const message = await postMessage(me, conv, meta, { body: text, replyTo, attachments });
    await db.del(`CHAT#${conv}`, `TYPING#${me.email}`);
    return [201, { message: await messageOut(message, me) }];
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
    createdAt: m.createdAt,
  });

  async function openMeeting(me, id) {
    const meeting = MEETING_ID_RE.test(id) ? await get(`MEETING#${id}`, 'META') : null;
    if (!meeting || !canSeeMeeting(meeting, me.email, isStaff(me.globalRole))) throw new HttpError(404, 'Meeting not found.');
    return meeting;
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
    return { meetings: meetings.map((m) => meetingOut(m, me)).sort((a, b) => a.startsAt.localeCompare(b.startsAt)), contacts: await contactsFor(me) };
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
    const names = Object.fromEntries([[me.email, me.name || ''], ...contacts.map((c) => [c.email, c.name])].filter(([email]) => email === me.email || clean.invitees.includes(email)));
    const meeting = {
      PK: `MEETING#${randomUUID()}`,
      SK: 'META',
      ...clean,
      hostEmail: me.email,
      hostName: me.name || '',
      names,
      conv: conversation?.conv || null,
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
    return [201, { meeting: meetingOut(meeting, me), emailed }];
  });

  route('GET', '/meetings/{id}', async (me, { id }) => ({ meeting: meetingOut(await openMeeting(me, id), me) }));

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

  route('POST', '/meetings/{id}/join', async (me, { id }) => {
    let meeting = await openMeeting(me, id);
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
}

export { channelId, validTimeZone };
