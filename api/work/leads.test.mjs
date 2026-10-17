import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanContact, contactSubject, contactText, leadsBoard, leadValues } from './leads.mjs';
import { cleanColumns, cleanGroups, cleanValues } from './model.mjs';

const valid = { name: ' Jane Founder ', email: 'Jane@Startup.io', company: 'Startup', service: 'Mobile app', budget: '$10k – $50k', message: 'We need an MVP for our logistics app.' };

test('contact form input is cleaned and validated', () => {
  const contact = cleanContact(valid);
  assert.equal(contact.name, 'Jane Founder');
  assert.equal(contact.email, 'jane@startup.io');
  assert.equal(cleanContact({ ...valid, service: '<script>' }).service, '');
  assert.throws(() => cleanContact({ ...valid, name: '' }), /name/);
  assert.throws(() => cleanContact({ ...valid, email: 'nope' }), /email/);
  assert.throws(() => cleanContact({ ...valid, message: 'hi' }), /more/);
  assert.equal(cleanContact({ ...valid, website: 'http://spam.example' }), null);
});

test('the leads board template passes board validation and accepts lead values', () => {
  const board = leadsBoard();
  const columns = cleanColumns(board.columns);
  cleanGroups(board.groups);
  const values = cleanValues(leadValues(cleanContact(valid)), columns);
  assert.equal(values.stage, 'new');
  assert.equal(values.email, 'jane@startup.io');
  assert.equal('followup' in values, false);
});

test('the inbox message carries the details and a link to the lead', () => {
  const contact = cleanContact(valid);
  assert.equal(contactSubject(contact), 'Website enquiry from Jane Founder (Startup)');
  const body = contactText(contact, 'https://lyrsoft.com/app/#/w/a/b/c?item=d');
  assert.match(body, /^We need an MVP/);
  assert.match(body, /Email: jane@startup.io/);
  assert.match(body, /Lead: https:\/\/lyrsoft.com\/app\//);
});
