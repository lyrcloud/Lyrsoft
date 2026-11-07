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

test('reactions toggle per person and come out in a fixed order', async () => {
  const { toggleReaction, reactionsOut } = await import('./collab-model.mjs');
  let r = toggleReaction({}, '❤️', 'a@x.com');
  r = toggleReaction(r, '👍', 'b@x.com');
  r = toggleReaction(r, '❤️', 'b@x.com');
  assert.deepEqual(r, { '❤️': ['a@x.com', 'b@x.com'], '👍': ['b@x.com'] });
  assert.deepEqual(reactionsOut(r, 'a@x.com').map((x) => [x.emoji, x.count, x.mine]), [['👍', 1, false], ['❤️', 2, true]]);
  r = toggleReaction(r, '👍', 'b@x.com');
  assert.equal('👍' in r, false);
  assert.throws(() => toggleReaction({}, '💩', 'a@x.com'), /Unknown reaction/);
});

test('attachments must be uploaded to the same conversation and within limits', async () => {
  const { cleanAttachments } = await import('./collab-model.mjs');
  const ok = { key: 'chat/grp.0123456789abcdef01234567/u/photo.jpg', name: 'photo.jpg', type: 'image/jpeg', size: 1000 };
  assert.deepEqual(cleanAttachments([ok], 'grp.0123456789abcdef01234567'), [ok]);
  assert.deepEqual(cleanAttachments(undefined, 'x'), []);
  assert.throws(() => cleanAttachments([ok], 'ws.other'), /wasn’t uploaded/);
  assert.throws(() => cleanAttachments([{ ...ok, key: 'chat/grp.0123456789abcdef01234567/../x' }], 'grp.0123456789abcdef01234567'), /wasn’t uploaded/);
  assert.throws(() => cleanAttachments([{ ...ok, size: 26 * 1024 * 1024 }], 'grp.0123456789abcdef01234567'), /25 MB/);
  assert.throws(() => cleanAttachments(Array(11).fill(ok), 'grp.0123456789abcdef01234567'), /up to 10/);
});

test('a reply quotes the author and the start of the message', async () => {
  const { replyQuote } = await import('./collab-model.mjs');
  assert.deepEqual(replyQuote({ id: 'm1', createdAt: 't', authorEmail: 'a@x.com', authorName: 'Ada', body: 'Hello   there' }), { id: 'm1', at: 't', authorEmail: 'a@x.com', authorName: 'Ada', snippet: 'Hello there' });
  assert.equal(replyQuote({ id: 'm', createdAt: 't', authorEmail: 'a', body: '', attachments: [{}, {}] }).snippet, '📎 2 files');
  assert.equal(replyQuote({ id: 'm', createdAt: 't', authorEmail: 'a', body: 'x', deletedAt: 't' }).snippet, 'Message unsent');
});

test('phone numbers find verified Lyrsoft accounts only, and only unambiguously', async () => {
  const { profileForPhone, newGuestKey, GUEST_KEY_RE } = await import('./collab-model.mjs');
  const profiles = [
    { email: 'ada@x.com', phone: '+8801712345678', phoneVerified: true },
    { email: 'bob@x.com', phone: '+14155550100', phoneVerified: true },
    { email: 'cy@x.com', phone: '+8801999999999', phoneVerified: false },
    { email: 'di@x.com', phone: '+4407700900123', phoneVerified: true },
    { email: 'ed@x.com', phone: '+4917700900123', phoneVerified: true },
  ];
  assert.equal(profileForPhone(profiles, '+880 1712-345678')?.email, 'ada@x.com');
  assert.equal(profileForPhone(profiles, '00880 1712 345678')?.email, 'ada@x.com');
  assert.equal(profileForPhone(profiles, '01712-345678')?.email, 'ada@x.com');
  assert.equal(profileForPhone(profiles, '(415) 555-0100')?.email, 'bob@x.com');
  assert.equal(profileForPhone(profiles, '+8801999999999'), null); // not verified
  assert.equal(profileForPhone(profiles, '07700 900123'), null); // two accounts end the same way
  assert.equal(profileForPhone(profiles, '12345'), null);
  assert.equal(profileForPhone(profiles, '+15550000000'), null);
  assert.match(newGuestKey(), GUEST_KEY_RE);
});
