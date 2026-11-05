import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkCode,
  hashCode,
  maskPhone,
  normalizePhone,
  selfUpdateError,
  unsubscribeToken,
  updateEmail,
  updateEmailError,
  updateRecipients,
  validUnsubscribeToken,
  welcomeEmail,
} from './account.mjs';

const SITE = 'https://lyrsoft.com';

test('mobile numbers are normalised to E.164', () => {
  assert.equal(normalizePhone('+91 98765-43210'), '+919876543210');
  assert.equal(normalizePhone('0091 (98765) 43210'), '+919876543210');
  assert.equal(normalizePhone('98765 43210'), null);
  assert.equal(normalizePhone('+0123456789'), null);
  assert.equal(maskPhone('+919876543210'), '+91••••210');
});

test('mobile codes: right code, wrong code, expiry and attempt limit', () => {
  const profile = { userId: 'u1', phonePending: { phone: '+15551234567', hash: hashCode('s', 'u1', '+15551234567', '123456'), expiresAt: Date.now() + 60_000, attempts: 0 } };
  assert.deepEqual(checkCode('s', profile, '123456'), { ok: true, phone: '+15551234567' });
  assert.equal(checkCode('s', profile, '654321').wrong, true);
  assert.equal(checkCode('s', profile, '12ab').error[0], 400);
  assert.equal(checkCode('s', { ...profile, phonePending: { ...profile.phonePending, attempts: 5 } }, '123456').error[0], 429);
  assert.match(checkCode('s', profile, '123456', Date.now() + 120_000).error[1], /expired/);
  assert.match(checkCode('s', { userId: 'u1' }, '123456').error[1], /first/);
});

test('people may change only their name and update emails', () => {
  assert.equal(selfUpdateError({ name: 'Ada' }), null);
  assert.equal(selfUpdateError({ emailUpdates: false }), null);
  assert.equal(selfUpdateError({ name: '  ' })?.[0], 400);
  assert.equal(selfUpdateError({ role: 'admin' })?.[0], 400);
  assert.equal(selfUpdateError({})?.[0], 400);
});

test('welcome and update emails are Lyrsoft-branded and escape input', () => {
  const welcome = welcomeEmail({ name: 'Ada Lovelace' }, SITE);
  assert.equal(welcome.subject, 'Welcome to Lyrsoft, Ada');
  assert.match(welcome.html, /lyrsoft\.com\/brand\/icon-192\.png/);
  const update = updateEmail({ subject: 'News', message: 'Hi <b>all</b>\n\nSee https://lyrsoft.com/x.', unsubscribeUrl: 'https://api/u' }, SITE);
  assert.match(update.html, /&lt;b&gt;all&lt;\/b&gt;/);
  assert.match(update.html, /href="https:\/\/lyrsoft\.com\/x"/);
  assert.match(update.text, /Unsubscribe: https:\/\/api\/u/);
});

test('update emails: validation, recipients and unsubscribe tokens', () => {
  assert.equal(updateEmailError({ subject: 'S', message: 'M' }), null);
  assert.equal(updateEmailError({ subject: '', message: 'M' })?.[0], 400);
  assert.equal(updateEmailError({ updateId: 'abc12345-1234abcd' }), null);
  assert.equal(updateEmailError({ updateId: 'bad id' })?.[0], 400);
  const people = [{ email: 'a@x.com' }, { email: 'b@x.com', emailUpdates: false }, { email: 'c@x.com', disabled: true }, { email: null }];
  assert.deepEqual(updateRecipients(people).map((p) => p.email), ['a@x.com']);
  const token = unsubscribeToken('s', 'u1');
  assert.equal(validUnsubscribeToken('s', 'u1', token), true);
  assert.equal(validUnsubscribeToken('s', 'u2', token), false);
  assert.equal(validUnsubscribeToken('s', 'u1', 'nope'), false);
});

test('profile photos: uploads, initials and the sign-in photo', async () => {
  const { avatarFor, selfProfile } = await import('./account.mjs');
  const jpeg = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
  assert.equal(selfUpdateError({ avatar: jpeg }), null);
  assert.equal(selfUpdateError({ avatar: null }), null);
  assert.equal(selfUpdateError({ avatar: 'initials' }), null);
  assert.equal(selfUpdateError({ avatar: 'data:image/svg+xml;base64,PHN2Zz4=' })?.[0], 400);
  assert.equal(selfUpdateError({ avatar: `data:image/jpeg;base64,${'A'.repeat(70_000)}` })?.[0], 400);
  const google = 'https://lh3.googleusercontent.com/a/photo';
  assert.equal(avatarFor({ picture: google }), google);
  assert.equal(avatarFor({ picture: google, avatar: jpeg }), jpeg);
  assert.equal(avatarFor({ picture: google, avatar: 'initials' }), null);
  assert.equal(avatarFor({ picture: 'javascript:alert(1)' }), null);
  assert.equal(selfProfile({ userId: 'u', picture: google, avatar: jpeg }, 'user').avatarSource, 'upload');
});
