import assert from 'node:assert/strict';
import { test } from 'node:test';
import PostalMime from 'postal-mime';
import {
  baseSubject,
  buildRawEmail,
  canUseMailbox,
  cleanEmailList,
  cleanMailboxAddress,
  encodeHeaderValue,
  messageIds,
  quoteReply,
  replySubject,
  routeRecipient,
  safeFilename,
  snippet,
  textToHtml,
} from './model.mjs';

const DOMAINS = ['lyrcloud.com', 'lyrtrip.com'];

test('mailbox addresses must be on a configured domain', () => {
  assert.equal(cleanMailboxAddress(' Support@LyrTrip.com ', DOMAINS), 'support@lyrtrip.com');
  assert.throws(() => cleanMailboxAddress('support@gmail.com', DOMAINS), /Use an address/);
  assert.throws(() => cleanMailboxAddress('a b@lyrtrip.com', DOMAINS), /Use an address/);
  assert.throws(() => cleanMailboxAddress('x@y@lyrtrip.com', DOMAINS), /Use an address/);
});

test('email lists are normalised, de-duplicated and validated', () => {
  assert.deepEqual(cleanEmailList('A@x.com, b@y.org;a@x.com'), ['a@x.com', 'b@y.org']);
  assert.throws(() => cleanEmailList(['nope']), /valid/);
});

test('mailbox access: staff everywhere, others only when listed', () => {
  const box = { members: ['ana@x.com'] };
  assert.equal(canUseMailbox({ globalRole: 'superadmin', email: 'z@z.com' }, box), true);
  assert.equal(canUseMailbox({ globalRole: 'admin', email: 'z@z.com' }, box), true);
  assert.equal(canUseMailbox({ globalRole: 'user', email: 'ana@x.com' }, box), true);
  assert.equal(canUseMailbox({ globalRole: 'user', email: 'bob@x.com' }, box), false);
});

test('recipients route to an exact mailbox, else the domain catch-all', () => {
  const boxes = [
    { address: 'support@lyrtrip.com' },
    { address: 'hello@lyrtrip.com', catchAll: true },
    { address: 'support@lyrcloud.com' },
  ];
  assert.equal(routeRecipient('Support@lyrtrip.com', boxes).address, 'support@lyrtrip.com');
  assert.equal(routeRecipient('sales@lyrtrip.com', boxes).address, 'hello@lyrtrip.com');
  assert.equal(routeRecipient('sales@lyrcloud.com', boxes), null);
});

test('threading helpers', () => {
  assert.deepEqual(messageIds('<a@b.com>\r\n <c@d.com>'), ['<a@b.com>', '<c@d.com>']);
  assert.deepEqual(messageIds(['<a@b>', 'junk <c@d>']), ['<a@b>', '<c@d>']);
  assert.equal(baseSubject('Re: Fwd: RE: Booking'), 'Booking');
  assert.equal(replySubject('Booking'), 'Re: Booking');
  assert.equal(replySubject('RE: Booking'), 'RE: Booking');
  assert.equal(snippet('a\n\n b   c'), 'a b c');
  assert.equal(snippet('x'.repeat(200)).length, 160);
});

test('text bodies become escaped HTML with links', () => {
  const html = textToHtml('<b>hi</b>\nsee https://lyrtrip.com/x?a=1&b=2');
  assert.match(html, /&lt;b&gt;hi&lt;\/b&gt;<br>/);
  assert.match(html, /<a href="https:\/\/lyrtrip.com\/x\?a=1&amp;b=2">/);
});

test('replies quote the previous message', () => {
  const text = quoteReply('Thanks!', { createdAt: '2026-10-16T10:00:00Z', from: { name: 'Ana', address: 'ana@x.com' }, text: 'Hi\nthere' });
  assert.match(text, /^Thanks!\n\nOn .+, Ana <ana@x.com> wrote:\n> Hi\n> there$/);
});

test('non-ASCII headers use short encoded words', () => {
  assert.equal(encodeHeaderValue('Plain subject'), 'Plain subject');
  const encoded = encodeHeaderValue('Réservation confirmée — ' + 'é'.repeat(40));
  for (const word of encoded.split('\r\n ')) assert.ok(word.length <= 75, word);
});

test('built messages parse back with the same content and threading headers', async () => {
  const raw = buildRawEmail({
    from: { name: 'Lyrtrip Support', address: 'support@lyrtrip.com' },
    to: ['ana@example.com'],
    cc: ['ops@lyrtrip.com'],
    subject: 'Re: Votre réservation ✈️',
    text: 'Bonjour Ana,\nC’est confirmé.',
    inReplyTo: '<abc@mail.example.com>',
    references: ['<root@mail.example.com>', '<abc@mail.example.com>'],
  });
  assert.ok(raw.split('\r\n').every((line) => line.length <= 998));
  const parsed = await PostalMime.parse(raw);
  assert.equal(parsed.subject, 'Re: Votre réservation ✈️');
  assert.equal(parsed.from.name, 'Lyrtrip Support');
  assert.equal(parsed.from.address, 'support@lyrtrip.com');
  assert.equal(parsed.to[0].address, 'ana@example.com');
  assert.equal(parsed.cc[0].address, 'ops@lyrtrip.com');
  assert.equal(parsed.text.trim(), 'Bonjour Ana,\nC’est confirmé.');
  assert.match(parsed.html, /Bonjour Ana,<br>/);
  assert.equal(parsed.inReplyTo, '<abc@mail.example.com>');
  assert.match(parsed.references, /<root@mail.example.com>/);
});

test('attachment names are made safe for storage keys', () => {
  assert.equal(safeFilename('../../etc/passwd'), '_.._etc_passwd');
  assert.equal(safeFilename('Invoice #12 (final).pdf'), 'Invoice _12 (final).pdf');
  assert.equal(safeFilename(''), 'attachment');
});

test('folders: trash remembers where a conversation came from, and restore puts it back', async () => {
  const { threadActionChanges } = await import('./model.mjs');
  const at = '2026-11-05T00:00:00.000Z';
  assert.deepEqual(threadActionChanges({ status: 'closed' }, 'trash', at), { status: 'trash', trashedFrom: 'closed', trashedAt: at, unread: false });
  assert.deepEqual(threadActionChanges({ status: 'trash', trashedFrom: 'closed' }, 'restore'), { status: 'closed', trashedFrom: null, trashedAt: null });
  assert.equal(threadActionChanges({ status: 'trash' }, 'restore').status, 'open');
  assert.equal(threadActionChanges({ status: 'open' }, 'restore'), null);
  assert.equal(threadActionChanges({ status: 'trash' }, 'trash'), null);
  assert.equal(threadActionChanges({ status: 'spam' }, 'open').status, 'open');
  assert.deepEqual(threadActionChanges({ status: 'open' }, 'read'), { unread: false });
  assert.equal(threadActionChanges({ status: 'open' }, 'delete'), null);
});

test('mailbox profiles: photo, name, colour, signature', async () => {
  const { cleanMailboxProfile, withSignature } = await import('./model.mjs');
  assert.deepEqual(cleanMailboxProfile({ displayName: '  Lyrtrip   Support ', color: '#AABBCC', signature: 'Thanks,\r\nTeam\u0007' }), { displayName: 'Lyrtrip Support', color: '#aabbcc', signature: 'Thanks,\nTeam' });
  assert.deepEqual(cleanMailboxProfile({ avatar: null }), { avatar: null });
  assert.equal(cleanMailboxProfile({ avatar: 'data:image/jpeg;base64,AAAA' }).avatar, 'data:image/jpeg;base64,AAAA');
  assert.throws(() => cleanMailboxProfile({ avatar: 'https://evil.example/x.png' }), /photo/);
  assert.throws(() => cleanMailboxProfile({ displayName: 'Bad <x@y.z>' }), /display name/);
  assert.throws(() => cleanMailboxProfile({ color: 'red' }), /colour/);
  assert.throws(() => cleanMailboxProfile({}), /Nothing/);
  assert.equal(withSignature('Hello\n', 'Team'), 'Hello\n\n-- \nTeam');
  assert.equal(withSignature('Hello', ''), 'Hello');
});

test('workspaces linked to a domain share its support inbox', async () => {
  const { canUseMailbox, cleanMailLinks, linkedAddresses, sharedMailbox, suggestMailLinks } = await import('./model.mjs');
  const boxes = [{ address: 'support@lyrtrip.com', members: [] }, { address: 'sales@lyrtrip.com', members: [] }, { address: 'all@lyrshop.com', catchAll: true, members: [] }];
  assert.equal(sharedMailbox('lyrtrip.com', boxes).address, 'support@lyrtrip.com');
  assert.equal(sharedMailbox('lyrshop.com', boxes).address, 'all@lyrshop.com', 'no support@, so the catch-all');
  assert.equal(sharedMailbox('lyrpay.com', boxes), null);
  assert.equal(sharedMailbox('mrshihab.com', [{ address: 'hello@mrshihab.com' }]).address, 'hello@mrshihab.com', 'a domain’s only mailbox');
  assert.equal(sharedMailbox('x.com', [{ address: 'a@x.com' }, { address: 'b@x.com' }]), null, 'ambiguous without support@');
  const links = cleanMailLinks({ 'lyrtrip.com': ['ws1', 'ws1', 'bad id!'], 'evil.com': ['ws2'] }, ['lyrtrip.com', 'lyrshop.com']);
  assert.deepEqual(links, { 'lyrtrip.com': ['ws1'] });
  const linked = linkedAddresses(links, ['ws1'], boxes);
  assert.deepEqual([...linked], ['support@lyrtrip.com']);
  const me = { email: 'ana@gmail.com', globalRole: 'user' };
  assert.equal(canUseMailbox(me, boxes[0], linked), true);
  assert.equal(canUseMailbox(me, boxes[1], linked), false, 'only the shared inbox, not every address on the domain');
  assert.equal(linkedAddresses(links, ['ws9'], boxes).size, 0);
  assert.deepEqual(suggestMailLinks([{ id: 'a', name: 'Lyrtrip' }, { id: 'b', name: 'Lyr Shop' }, { id: 'c', name: 'Other' }], ['lyrtrip.com', 'lyrshop.com']), { 'lyrtrip.com': ['a'], 'lyrshop.com': ['b'] });
});
