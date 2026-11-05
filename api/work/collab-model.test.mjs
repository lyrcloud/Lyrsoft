import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canManageMeeting, canSeeMeeting, channelId, cleanInvitees, cleanMeeting, cleanMessage, CONV_RE, dmId, formatMeetingTime, isUnread, validTimeZone } from './collab-model.mjs';

test('conversation ids: one channel per workspace, one DM per pair of people', () => {
  assert.equal(channelId('abc'), 'ws.abc');
  assert.equal(dmId('a@x.com', 'B@x.com'), dmId('b@x.com', 'a@x.com'));
  assert.notEqual(dmId('a@x.com', 'b@x.com'), dmId('a@x.com', 'c@x.com'));
  assert.match(dmId('a@x.com', 'b@x.com'), CONV_RE);
  assert.match('ws.qcihYGee7Dhw', CONV_RE);
  assert.doesNotMatch('ws.../x', CONV_RE);
});

test('messages are trimmed and limited', () => {
  assert.equal(cleanMessage('  hi\r\nthere '), 'hi\nthere');
  assert.throws(() => cleanMessage('   '), /Write a message/);
  assert.throws(() => cleanMessage('x'.repeat(4001)), /at most/);
});

test('unread means someone else wrote after I last read', () => {
  const conv = { lastMessageAt: '2026-11-05T10:00:00Z', lastAuthor: 'b@x.com' };
  assert.equal(isUnread(conv, 'a@x.com', null), true);
  assert.equal(isUnread(conv, 'a@x.com', '2026-11-05T10:00:00Z'), false);
  assert.equal(isUnread(conv, 'b@x.com', null), false);
  assert.equal(isUnread(null, 'a@x.com', null), false);
});

test('meetings: title, start, length, invitees and time zone', () => {
  const now = Date.parse('2026-11-05T10:00:00Z');
  const m = cleanMeeting({ title: ' Weekly  sync ', startsAt: '2026-11-06T09:30:00Z', durationMin: 45, invitees: 'b@x.com, B@x.com; host@x.com', timeZone: 'Asia/Kolkata' }, 'host@x.com', now);
  assert.deepEqual(m, { title: 'Weekly sync', startsAt: '2026-11-06T09:30:00.000Z', durationMin: 45, invitees: ['b@x.com'], timeZone: 'Asia/Kolkata' });
  assert.equal(cleanMeeting({ title: 'Now' }, 'h@x.com', now).startsAt, new Date(now).toISOString());
  assert.equal(cleanMeeting({ title: 'Odd', durationMin: 7 }, 'h@x.com', now).durationMin, 30);
  assert.throws(() => cleanMeeting({ title: '' }, 'h@x.com', now), /title/);
  assert.throws(() => cleanMeeting({ title: 'Old', startsAt: '2026-11-01T00:00:00Z' }, 'h@x.com', now), /past/);
  assert.throws(() => cleanInvitees('not-an-email'), /valid email/);
  assert.equal(validTimeZone('Mars/Base'), 'UTC');
  assert.match(formatMeetingTime('2026-11-06T09:30:00Z', 'Asia/Kolkata'), /3:00 PM/);
});

test('who sees and manages a meeting', () => {
  const meeting = { hostEmail: 'h@x.com', invitees: ['i@x.com'] };
  assert.equal(canSeeMeeting(meeting, 'i@x.com', false), true);
  assert.equal(canSeeMeeting(meeting, 'o@x.com', false), false);
  assert.equal(canSeeMeeting(meeting, 'o@x.com', true), true);
  assert.equal(canManageMeeting(meeting, 'i@x.com', false), false);
  assert.equal(canManageMeeting(meeting, 'h@x.com', false), true);
});

test('groups: ids and names', async () => {
  const { groupId, cleanGroupName } = await import('./collab-model.mjs');
  const id = groupId('0123456789abcdef01234567ffff');
  assert.equal(id, 'grp.0123456789abcdef01234567');
  assert.match(id, CONV_RE);
  assert.doesNotMatch('grp.xyz', CONV_RE);
  assert.equal(cleanGroupName('  Design   team '), 'Design team');
  assert.throws(() => cleanGroupName(' '), /name/);
  assert.throws(() => cleanGroupName('x'.repeat(81)), /name/);
});
