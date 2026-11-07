import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findAccounts, fromGravatar, newAccounts, phoneChecks, profileKey, searchLinks, sha256Hex } from './contacts-find.js';

const json = (status, body) => ({ status, ok: status < 300, json: async () => body });

test('Gravatar verified accounts become contact profiles; hidden ones are skipped', () => {
  const g = fromGravatar({
    display_name: 'Ada',
    verified_accounts: [
      { service_type: 'twitter', url: 'https://x.com/ada', is_hidden: false },
      { service_type: 'linkedin', url: 'https://www.linkedin.com/in/ada' },
      { service_type: 'instagram', url: 'https://instagram.com/ada', is_hidden: true },
      { service_type: 'mastodon', url: 'https://mastodon.social/@ada' },
    ],
  });
  assert.equal(g.name, 'Ada');
  assert.deepEqual(g.accounts.map((a) => a.network), ['x', 'linkedin', 'other']);
});

test('email hash is SHA-256 of the trimmed, lower-cased address', async () => {
  assert.equal(await sha256Hex('beau@automattic.com'), '27205e5c51cb03f862138b22bcb5dc20f94a342e744ff6df1b8dc8af3c865109');
});

test('profiles already on the contact are not suggested again', () => {
  assert.equal(profileKey({ network: 'x', value: 'https://www.x.com/Ada/' }), profileKey({ network: 'x', value: '@ada' }));
  const contact = { socials: [{ network: 'x', value: '@ada' }] };
  const found = [{ network: 'x', value: 'https://x.com/ada' }, { network: 'github', value: 'https://github.com/ada' }, { network: 'github', value: 'https://github.com/ada' }];
  assert.deepEqual(newAccounts(contact, found).map((a) => a.network), ['github']);
});

test('findAccounts queries Gravatar and GitHub per email and survives failures', async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    if (url.includes('gravatar')) return json(200, { display_name: 'Ada', verified_accounts: [{ service_type: 'github', url: 'https://github.com/ada' }] });
    return json(403, {});
  };
  const { found, sources } = await findAccounts({ emails: [{ value: ' Ada@Example.com ' }], socials: [] }, fetchFn);
  assert.equal(calls.length, 2);
  assert.ok(calls.some((u) => /ada%40example\.com%20in%3Aemail/.test(u)));
  assert.deepEqual(found.map((a) => a.value), ['https://github.com/ada']);
  assert.equal(sources.find((s) => s.source === 'GitHub').ok, false);
});

test('Gravatar 404 means no profile', async () => {
  const { found, sources } = await findAccounts({ emails: [{ value: 'nobody@example.com' }], socials: [] }, async (url) => (url.includes('gravatar') ? json(404, {}) : json(200, { items: [] })));
  assert.deepEqual(found, []);
  assert.ok(sources.every((s) => s.ok));
});

test('phone checks and search links', () => {
  assert.deepEqual(phoneChecks('00 44 7700 900123').map((a) => a.href), ['https://wa.me/447700900123', 'https://t.me/+447700900123', 'viber://chat?number=%2B447700900123', 'https://signal.me/#p/+447700900123']);
  assert.deepEqual(phoneChecks('123'), []);
  const links = searchLinks({ name: 'Ada Lovelace', emails: [{ value: 'ada@example.com' }], phones: [{ value: '+1 555 0100' }] });
  assert.ok(links.some((l) => l.network === 'facebook' && l.href.includes('Ada%20Lovelace')));
  assert.ok(links.some((l) => l.network === 'github' && l.by === 'ada@example.com'));
  assert.equal(links.filter((l) => l.label === 'Google').length, 2);
});
