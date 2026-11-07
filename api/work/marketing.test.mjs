import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bodyToHtml, bodyToText, extractLinks, merge, renderCampaignEmail } from '../../lyrsoft/marketing-email.js';
import {
  audienceOf,
  cleanCampaign,
  cleanForm,
  cleanSettings,
  cleanSignup,
  cleanSubscriber,
  clickTarget,
  planSubscriberImport,
  readLinkParams,
  readyToSendError,
  recipientUrls,
} from './marketing-model.mjs';
import { ValidationError } from './model.mjs';

const SECRET = 'test-secret';

test('merge tags fill in subscriber details with fallbacks', () => {
  assert.equal(merge('Hi {{first_name|there}}!', { name: 'Ada Lovelace' }), 'Hi Ada!');
  assert.equal(merge('Hi {{first_name|there}}!', {}), 'Hi there!');
  assert.equal(merge('{{last_name}} <{{email}}>', { name: 'Ada King Lovelace', email: 'a@x.io' }), 'King Lovelace <a@x.io>');
  assert.equal(merge('{{unknown}} stays', {}), '{{unknown}} stays');
});

test('body formatting becomes email HTML, with everything escaped', () => {
  const html = bodyToHtml('# Big news\n\nHello **world** and *you* <script>\n\n- one\n- two\n\n[button: Shop now](https://shop.example/sale)\n\n![Photo](https://img.example/a.jpg)\n\n---\n\n> quoted');
  assert.match(html, /<h2[^>]*>Big news<\/h2>/);
  assert.match(html, /<strong>world<\/strong> and <em>you<\/em> &lt;script&gt;/);
  assert.match(html, /<ul[^>]*><li[^>]*>one<\/li><li[^>]*>two<\/li><\/ul>/);
  assert.match(html, /href="https:\/\/shop\.example\/sale"[^>]*>Shop now<\/a>/);
  assert.match(html, /<img src="https:\/\/img\.example\/a\.jpg" alt="Photo"/);
  assert.match(html, /<hr/);
  assert.match(html, /<blockquote[^>]*>quoted<\/blockquote>/);
  assert.doesNotMatch(html, /<script>/);
});

test('only safe link schemes become links', () => {
  const html = bodyToHtml('[bad](javascript:alert(1)) and [ok](https://ok.example)');
  assert.doesNotMatch(html, /href="javascript/);
  assert.match(html, /href="https:\/\/ok\.example"/);
});

test('links are found in order and run through the tracker', () => {
  const body = 'Read https://a.example/post then [b](https://b.example).\n\n[button: Go](https://c.example/x?y=1)\n\nAgain https://a.example/post';
  assert.deepEqual(extractLinks(body), ['https://a.example/post', 'https://b.example', 'https://c.example/x?y=1']);
  const html = bodyToHtml(body, { link: (url) => `T(${url})` });
  assert.match(html, /href="T\(https:\/\/a\.example\/post\)"/);
  assert.match(html, /href="T\(https:\/\/b\.example\)"/);
  assert.match(html, /href="T\(https:\/\/c\.example\/x\?y=1\)"/);
});

test('plain text version keeps links readable', () => {
  const text = bodyToText('## Hi {{first_name}}\n\nSee [the post](https://a.example).\n\n[button: Buy](https://b.example)', { recipient: { name: 'Sam Lee' } });
  assert.equal(text, 'Hi Sam\n\nSee the post (https://a.example).\n\nBuy: https://b.example');
});

test('the full email has preheader, footer address, unsubscribe and pixel', () => {
  const email = renderCampaignEmail(
    { subject: 'Hello {{first_name}}', preheader: 'Inside: news', body: 'Hi there' },
    { fromName: 'Acme', address: '1 Main St\nTown', color: '#112233' },
    { recipient: { name: 'Jo Doe', email: 'jo@x.io' }, urls: { unsubscribe: 'https://u.example/x', pixel: 'https://p.example/o.gif' } },
  );
  assert.equal(email.subject, 'Hello Jo');
  assert.match(email.html, /Inside: news/);
  assert.match(email.html, /1 Main St, Town/);
  assert.match(email.html, /href="https:\/\/u\.example\/x"/);
  assert.match(email.html, /src="https:\/\/p\.example\/o\.gif"/);
  assert.match(email.html, /#112233/);
  assert.match(email.text, /Unsubscribe: https:\/\/u\.example\/x/);
});

test('subscribers need a valid email; tags are cleaned', () => {
  assert.deepEqual(cleanSubscriber({ email: ' Ada@Example.COM ', name: ' Ada ', tags: 'vip, vip, news' }), { email: 'ada@example.com', name: 'Ada', tags: ['vip', 'news'] });
  assert.throws(() => cleanSubscriber({ email: 'nope' }), ValidationError);
});

test('imports merge with the list and never resubscribe people who left', () => {
  const existing = [
    { email: 'a@x.io', name: 'A', tags: ['old'], status: 'unsubscribed' },
    { email: 'b@x.io', name: '', tags: [], status: 'subscribed' },
  ];
  const incoming = [
    { email: 'a@x.io', name: 'Alice', tags: ['new'] },
    { email: 'b@x.io', name: 'Bob', tags: [] },
    { email: 'c@x.io', name: 'Cy', tags: [] },
    { email: 'c@x.io', name: 'Cy', tags: ['dup'] },
  ];
  const plan = planSubscriberImport(existing, incoming, { tags: ['launch'], at: 'T' });
  const by = Object.fromEntries(plan.rows.map((r) => [r.email, r]));
  assert.equal(plan.created, 1);
  assert.equal(plan.updated, 2);
  assert.equal(by['a@x.io'].status, 'unsubscribed');
  assert.deepEqual(by['a@x.io'].tags, ['old', 'new', 'launch']);
  assert.equal(by['b@x.io'].name, 'Bob');
  assert.deepEqual(by['c@x.io'].tags, ['launch', 'dup']);
  assert.equal(by['c@x.io'].status, 'subscribed');
});

test('audiences are subscribed people, optionally with any of some tags', () => {
  const subs = [
    { email: 'a', status: 'subscribed', tags: ['vip'] },
    { email: 'b', status: 'subscribed', tags: [] },
    { email: 'c', status: 'unsubscribed', tags: ['vip'] },
    { email: 'd', status: 'bounced', tags: [] },
  ];
  assert.deepEqual(audienceOf(subs, { tags: [] }).map((s) => s.email), ['a', 'b']);
  assert.deepEqual(audienceOf(subs, { tags: ['vip'] }).map((s) => s.email), ['a']);
});

test('campaigns and sending checks', () => {
  const c = cleanCampaign({ subject: ' Hi ', body: 'Hello everyone', audience: { tags: ['x'] } });
  assert.equal(c.name, 'Untitled campaign');
  assert.deepEqual(cleanCampaign({ subject: 'New' }, { partial: true }), { subject: 'New' });
  assert.equal(readyToSendError({ subject: '', body: 'long enough body' }, { fromName: 'A', address: 'B' }), 'Add a subject line.');
  assert.match(readyToSendError({ subject: 'S', body: 'long enough body' }, { fromName: 'A' }), /postal address/);
  assert.equal(readyToSendError({ subject: 'S', body: 'long enough body' }, { fromName: 'A', address: 'B' }), null);
});

test('only staff choose the From address, and only on mail domains', () => {
  assert.equal(cleanSettings({ fromName: 'Acme', fromEmail: 'news@lyrsoft.com' }, { staff: false, domains: ['lyrsoft.com'] }).fromEmail, '');
  assert.equal(cleanSettings({ fromName: 'Acme', fromEmail: 'news@lyrsoft.com' }, { staff: true, domains: ['lyrsoft.com'] }).fromEmail, 'news@lyrsoft.com');
  assert.throws(() => cleanSettings({ fromName: 'Acme', fromEmail: 'x@gmail.com' }, { staff: true, domains: ['lyrsoft.com'] }), ValidationError);
  assert.throws(() => cleanSettings({ fromName: 'Evil <x@y.z>' }), ValidationError);
  assert.throws(() => cleanSettings({ fromName: 'A', logoUrl: 'http://insecure' }), ValidationError);
});

test('signed links round-trip and reject tampering', () => {
  const urls = recipientUrls('https://lyrsoft.com', SECRET, 'ws1', 'camp1', 'ada@x.io', ['https://a.example']);
  const params = new URL(urls.link('https://a.example')).searchParams;
  assert.deepEqual(readLinkParams(params, SECRET), { ws: 'ws1', campaignId: 'camp1', email: 'ada@x.io', linkIndex: 0 });
  assert.equal(urls.link('https://not-in-campaign.example'), 'https://not-in-campaign.example');
  params.set('w', 'ws2');
  assert.equal(readLinkParams(params, SECRET), null);
  assert.equal(readLinkParams(new URL(urls.unsubscribe).searchParams, 'other-secret'), null);
  assert.equal(clickTarget(['https://a.example'], 0), 'https://a.example');
  assert.equal(clickTarget(['https://a.example'], 5), '');
});

test('signup forms and submissions', () => {
  const form = cleanForm({ name: 'Footer', tags: ['site'] });
  assert.equal(form.title, 'Join our newsletter');
  assert.deepEqual(form.tags, ['site']);
  assert.throws(() => cleanForm({ redirectUrl: 'javascript:alert(1)' }), ValidationError);
  assert.equal(cleanSignup({ email: 'a@x.io', website: 'spam' }), null);
  assert.deepEqual(cleanSignup({ email: 'A@X.io', name: 'A' }), { email: 'a@x.io', name: 'A' });
  assert.throws(() => cleanSignup({ email: 'bad' }), ValidationError);
});
