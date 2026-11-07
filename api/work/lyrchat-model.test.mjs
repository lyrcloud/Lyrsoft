import assert from 'node:assert/strict';
import { createECDH } from 'node:crypto';
import { test } from 'node:test';
import {
  answerCall,
  callLogEntry,
  callSummary,
  callToken,
  canCall,
  cleanSubscription,
  declineCall,
  durationText,
  endCall,
  maskFor,
  maskJson,
  messagePush,
  postBlocked,
  requestState,
  ringsFor,
  validCallToken,
  vapidKeysFrom,
} from './lyrchat-model.mjs';

const pending = { conv: 'dm.abc', type: 'dm', members: ['a@x.com', 'b@y.com'], request: { from: 'a@x.com', to: 'b@y.com', status: 'pending', masked: true, label: '+1 555 0100' } };

test('message requests: who sees what', () => {
  assert.equal(requestState(pending, 'a@x.com'), 'outgoing');
  assert.equal(requestState(pending, 'b@y.com'), 'incoming');
  assert.equal(requestState({ ...pending, request: { ...pending.request, status: 'accepted' } }, 'b@y.com'), 'none');
  assert.equal(requestState({ type: 'dm' }, 'a@x.com'), 'none');
  assert.equal(postBlocked(pending, 'a@x.com', false), null);
  assert.match(postBlocked(pending, 'a@x.com', true), /can’t message/);
  assert.match(postBlocked({ ...pending, request: { ...pending.request, status: 'blocked' } }, 'a@x.com', false), /can’t message/);
});

test('no calls until a request is accepted, and never when blocked', () => {
  assert.equal(canCall(pending, 'a@x.com', false), false);
  assert.equal(canCall(pending, 'b@y.com', false), false);
  assert.equal(canCall({ type: 'dm' }, 'a@x.com', false), true);
  assert.equal(canCall({ type: 'dm' }, 'a@x.com', true), false);
});

test('found by phone: the sender never sees the receiver’s email until they accept', () => {
  const mask = maskFor(pending, 'a@x.com');
  assert.deepEqual(mask, { email: 'b@y.com', alias: 'peer.dm.abc' });
  assert.equal(maskFor(pending, 'b@y.com'), null);
  assert.equal(maskFor({ ...pending, request: { ...pending.request, masked: false } }, 'a@x.com'), null);
  assert.equal(maskFor({ ...pending, request: { ...pending.request, status: 'accepted' } }, 'a@x.com'), null);
  const out = maskJson({ members: ['a@x.com', 'b@y.com'], names: { 'b@y.com': 'Ben' }, reads: { 'b@y.com': null } }, mask);
  assert.ok(!JSON.stringify(out).includes('b@y.com'));
  assert.equal(out.names['peer.dm.abc'], 'Ben');
});

const call = { callId: 'c1', conv: 'dm.abc', convType: 'dm', from: 'a@x.com', fromName: 'Ada', members: ['b@y.com'], video: false, status: 'ringing', startedAt: '2026-11-07T10:00:00.000Z', answeredBy: [], declinedBy: [] };
const at = (s) => Date.parse('2026-11-07T10:00:00.000Z') + s * 1000;

test('a call rings the callee, not the caller, until 45 seconds pass', () => {
  assert.equal(ringsFor(call, 'b@y.com', at(10)), true);
  assert.equal(ringsFor(call, 'a@x.com', at(10)), false);
  assert.equal(ringsFor(call, 'b@y.com', at(50)), false);
  assert.equal(ringsFor(declineCall(call, 'b@y.com'), 'b@y.com', at(10)), false);
});

test('answer, decline and hang up', () => {
  const answered = answerCall(call, 'b@y.com', '2026-11-07T10:00:05.000Z');
  assert.equal(answered.status, 'answered');
  assert.throws(() => answerCall(call, 'c@z.com', 'x'), /isn’t for you/);
  const ended = endCall(answered, '2026-11-07T10:02:36.000Z');
  assert.equal(ended.status, 'ended');
  assert.equal(callSummary(ended), 'Voice call · 2:31');
  assert.equal(endCall(ended, 'later'), ended);
  assert.throws(() => answerCall(ended, 'b@y.com', 'x'), /ended/);
  const missed = endCall(call, '2026-11-07T10:00:30.000Z');
  assert.equal(missed.status, 'missed');
  assert.equal(callSummary({ ...missed, video: true }), 'Missed video call');
  assert.equal(declineCall(call, 'b@y.com').status, 'declined');
  // A group call keeps ringing the others when one person declines.
  const group = { ...call, convType: 'group', members: ['b@y.com', 'c@z.com'] };
  assert.equal(declineCall(group, 'b@y.com').status, 'ringing');
  assert.equal(declineCall(declineCall(group, 'b@y.com'), 'c@z.com').status, 'declined');
});

test('call history entries', () => {
  const missed = endCall(call, '2026-11-07T10:00:30.000Z');
  assert.deepEqual(
    [callLogEntry(missed, 'b@y.com').missed, callLogEntry(missed, 'a@x.com').direction, callLogEntry(missed, 'b@y.com').direction],
    [true, 'outgoing', 'incoming'],
  );
  const ended = endCall(answerCall(call, 'b@y.com', '2026-11-07T10:00:05.000Z'), '2026-11-07T10:01:05.000Z');
  assert.equal(callLogEntry(ended, 'b@y.com').durationSec, 60);
  assert.equal(callLogEntry(ended, 'b@y.com').missed, false);
  assert.equal(durationText(3725), '1:02:05');
});

test('decline tokens are per call and person', () => {
  const t = callToken('s3cret', 'c1', 'b@y.com');
  assert.equal(validCallToken('s3cret', 'c1', 'b@y.com', t), true);
  assert.equal(validCallToken('s3cret', 'c2', 'b@y.com', t), false);
  assert.equal(validCallToken('s3cret', 'c1', 'c@z.com', t), false);
  assert.equal(validCallToken('s3cret', 'c1', 'b@y.com', 'nope'), false);
});

test('push keys come from the app secret and form a valid P-256 pair', () => {
  const keys = vapidKeysFrom('app-secret');
  assert.deepEqual(vapidKeysFrom('app-secret'), keys);
  assert.notEqual(vapidKeysFrom('other').publicKey, keys.publicKey);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(keys.privateKey, 'base64url'));
  assert.equal(ecdh.getPublicKey().toString('base64url'), keys.publicKey);
  assert.equal(Buffer.from(keys.publicKey, 'base64url').length, 65);
});

test('push subscriptions and message notifications', () => {
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc123def456', keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } };
  assert.deepEqual(cleanSubscription(sub), sub);
  assert.throws(() => cleanSubscription({ endpoint: 'http://x' }), /isn’t a push/);
  assert.throws(() => cleanSubscription({ endpoint: sub.endpoint, keys: {} }), /no keys/);
  const dm = messagePush({ conv: 'dm.abc', meta: { type: 'dm' }, author: 'Ada', snippet: 'Hi' });
  assert.deepEqual([dm.title, dm.body, dm.url], ['Ada', 'Hi', '/chat/#/chat/dm.abc']);
  const group = messagePush({ conv: 'grp.1', meta: { type: 'group', title: 'Family' }, author: 'Ada', snippet: 'Hi' });
  assert.deepEqual([group.title, group.body], ['Family', 'Ada: Hi']);
  assert.match(messagePush({ conv: 'dm.abc', meta: { type: 'dm' }, author: 'Ada', snippet: 'Hi', request: true }).title, /Message request/);
});
