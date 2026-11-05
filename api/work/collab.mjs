// Lyrsoft chat and meetings, mounted on the work API (api/work/index.mjs) like the mail routes.
//
// Chat: every workspace has a team channel ("ws.<wsId>", its members), and any two people who share a
// workspace (or a staff member and anyone) can message each other directly ("dm.<hash>"). The app
// polls for new messages while a conversation is open.
//   GET  /chat                                  conversations, unread flags and people I can message
//   POST /chat/dm                               { email } open (or create) a direct conversation
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
import { randomUUID } from 'node:crypto';
import { meetingInviteEmail } from './account.mjs';
import {
  attendeeExternalId,
  canManageMeeting,
  canSeeMeeting,
  channelId,
  cleanInvitees,
  cleanMeeting,
  cleanMessage,
  CONV_RE,
  dmId,
  formatMeetingTime,
  isUnread,
  snippetOf,
  validTimeZone,
} from './collab-model.mjs';

const MEETING_ID_RE = /^[0-9a-f-]{36}$/;

export function registerCollabRoutes(route, { db, HttpError, openWorkspace, isStaff, memberships, listProfiles, sendEmail, siteUrl, chime, now, newId }) {
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

  const messageOut = (m) => ({ id: m.id, body: m.body, kind: m.kind || 'text', meetingId: m.meetingId || null, authorEmail: m.authorEmail, authorName: m.authorName || '', createdAt: m.createdAt });

  async function postMessage(me, conv, meta, { body, kind = 'text', meetingId = null }) {
    const createdAt = now();
    const id = newId();
    const message = { PK: `CHAT#${conv}`, SK: `MSG#${createdAt}#${id}`, id, conv, body, kind, meetingId, authorEmail: me.email, authorName: me.name || '', createdAt };
    await put(message);
    const { title, ...stored } = meta;
    await put({ ...stored, PK: `CHAT#${conv}`, SK: 'META', conv, lastMessageAt: createdAt, lastSnippet: snippetOf(kind === 'meeting' ? `📹 ${body}` : body), lastAuthor: me.email });
    await put({ PK: `CHATREAD#${me.email}`, SK: conv, lastReadAt: createdAt });
    return message;
  }

  route('GET', '/chat', async (me) => {
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
    const dms = await Promise.all(
      dmRows.map(async (row) => {
        const meta = await get(`CHAT#${row.conv}`, 'META');
        const other = meta?.members.find((e) => e !== me.email) || me.email;
        return out(row.conv, meta, { type: 'dm', title: names.get(other) || meta?.names?.[other] || other, with: other });
      }),
    );
    const byRecent = (a, b) => String(b.lastMessageAt || '').localeCompare(String(a.lastMessageAt || '')) || a.title.localeCompare(b.title);
    return { channels: channels.sort(byRecent), dms: dms.sort(byRecent), contacts, unreadCount: [...channels, ...dms].filter((c) => c.unread).length };
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

  route('GET', '/chat/{conv}/messages', async (me, { conv }, _b, query) => {
    const { meta } = await openConversation(me, conv);
    const after = query.get('after');
    let messages = await queryAll({ KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)', ExpressionAttributeValues: { ':pk': `CHAT#${conv}`, ':sk': 'MSG#' } });
    if (after) messages = messages.filter((m) => m.createdAt > after);
    messages = messages.slice(-100);
    if (meta.lastMessageAt) await put({ PK: `CHATREAD#${me.email}`, SK: conv, lastReadAt: meta.lastMessageAt });
    return { conversation: { id: conv, type: meta.type || (conv.startsWith('ws.') ? 'ws' : 'dm'), title: meta.title || null, members: meta.members || null }, messages: messages.map(messageOut) };
  });

  route('POST', '/chat/{conv}/messages', async (me, { conv }, body) => {
    const { meta } = await openConversation(me, conv);
    const message = await postMessage(me, conv, meta, { body: tryClean(() => cleanMessage(body.body)) });
    return [201, { message: messageOut(message) }];
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
    const meeting = await openMeeting(me, id);
    if (meeting.cancelledAt) throw bad('This meeting was cancelled.');
    let chimeMeeting;
    try {
      chimeMeeting = await chimeMeetingFor(meeting);
    } catch (error) {
      console.error('Chime meeting failed', error);
      throw new HttpError(502, 'Couldn’t start the video call. Please try again.');
    }
    const { Attendee } = await chime.send(new CreateAttendeeCommand({ MeetingId: chimeMeeting.MeetingId, ExternalUserId: attendeeExternalId(me.email) }));
    return { meeting: meetingOut(meeting, me), chime: { meeting: chimeMeeting, attendee: Attendee }, names: { ...meeting.names, [me.email]: me.name || meeting.names?.[me.email] || '' } };
  });
}

export { channelId, validTimeZone };
