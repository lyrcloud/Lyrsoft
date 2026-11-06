import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanContact, findDuplicates, mergeContact, phoneKey, planImport } from './contacts-model.mjs';
import {
  fixMojibake,
  fromDeviceContact,
  fromGooglePerson,
  parseContactsFile,
  parseCSV,
  parseJSON,
  parseVCard,
  socialUrl,
  toGoogleCSV,
  toLyrsoftJSON,
  toOutlookCSV,
  toVCard,
} from '../../lyrsoft/contacts-formats.js';

const ANDROID_VCF = [
  'BEGIN:VCARD',
  'VERSION:2.1',
  'N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=E0=A6=B0=E0=A6=B9=E0=A6=BF=E0=A6=AE;Karim;;;',
  'FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Karim =E0=A6=B0=E0=A6=B9=E0=A6=BF=',
  '=E0=A6=AE',
  'TEL;CELL;PREF:+880 1712-345678',
  'TEL;HOME:02-9876543',
  'EMAIL;HOME:Karim@Example.com',
  'END:VCARD',
  'BEGIN:VCARD',
  'VERSION:3.0',
  'FN:Jane Doe',
  'N:Doe;Jane;;;',
  'ORG:Acme Inc.;Sales',
  'TITLE:Head of Sales',
  'item1.URL:https://www.linkedin.com/in/janedoe',
  'item1.X-ABLabel:LinkedIn',
  'X-SOCIALPROFILE;type=twitter;x-user=janed:http://twitter.com/janed',
  'NOTE:Met at the expo\\, 2025\\nLikes tea',
  'BDAY:1990-04-02',
  'ADR;TYPE=WORK:;;1 Main St;Springfield;IL;62701;USA',
  'PHOTO;ENCODING=b;TYPE=JPEG:AAAA',
  ' BBBB',
  'END:VCARD',
].join('\r\n');

test('vCard: Android 2.1 quoted-printable and iPhone/Google 3.0', () => {
  const [karim, jane] = parseVCard(ANDROID_VCF);
  assert.equal(karim.name, 'Karim রহিম');
  assert.equal(karim.family, 'রহিম');
  assert.deepEqual(karim.phones, [{ value: '+880 1712-345678', label: 'mobile' }, { value: '02-9876543', label: 'home' }]);
  assert.deepEqual(karim.emails, [{ value: 'karim@example.com', label: 'home' }]);
  assert.equal(jane.company, 'Acme Inc., Sales');
  assert.equal(jane.title, 'Head of Sales');
  assert.deepEqual(jane.socials, [{ network: 'linkedin', value: 'https://www.linkedin.com/in/janedoe' }, { network: 'x', value: 'http://twitter.com/janed' }]);
  assert.equal(jane.websites.length, 0);
  assert.equal(jane.notes, 'Met at the expo, 2025\nLikes tea');
  assert.equal(jane.birthday, '1990-04-02');
  assert.equal(jane.addresses[0].value, '1 Main St, Springfield IL 62701, USA');
  assert.equal(jane.addresses[0].label, 'work');
});

test('vCard export reads back the same', () => {
  const [, jane] = parseVCard(ANDROID_VCF);
  const again = parseVCard(toVCard([{ ...jane, tags: ['Clients', 'VIP'], name: 'Jane Doe; the “second”' }]))[0];
  assert.equal(again.name, 'Jane Doe; the “second”');
  assert.deepEqual(again.tags, ['Clients', 'VIP']);
  assert.deepEqual(again.socials.map((s) => s.network), ['linkedin', 'x']);
  assert.equal(again.notes, jane.notes);
  for (const line of toVCard([{ ...jane, notes: 'x'.repeat(300) }]).split('\r\n')) assert.ok(new TextEncoder().encode(line).length <= 75);
});

test('CSV: Google Contacts export', () => {
  const csv = [
    'First Name,Middle Name,Last Name,Organization Name,Organization Title,Organization Department,Labels,E-mail 1 - Label,E-mail 1 - Value,Phone 1 - Label,Phone 1 - Value,Website 1 - Label,Website 1 - Value,Address 1 - Label,Address 1 - Formatted',
    'Ana,,Silva,Lyr Co,CEO,Board,* myContacts ::: * starred ::: Family,* Work,ana@lyr.co ::: ana@gmail.com,Mobile,+351 912 345 678,Profile,https://instagram.com/ana,Home,"Rua 1\nLisboa"',
  ].join('\n');
  const [ana] = parseCSV(csv, 'google');
  assert.equal(ana.name, 'Ana Silva');
  assert.equal(ana.company, 'Lyr Co');
  assert.equal(ana.title, 'CEO');
  assert.equal(ana.favorite, true);
  assert.deepEqual(ana.tags, ['Family']);
  assert.deepEqual(ana.emails.map((e) => e.value), ['ana@lyr.co', 'ana@gmail.com']);
  assert.deepEqual(ana.phones, [{ value: '+351 912 345 678', label: 'mobile' }]);
  assert.deepEqual(ana.socials, [{ network: 'instagram', value: 'https://instagram.com/ana' }]);
  assert.deepEqual(ana.addresses, [{ value: 'Rua 1, Lisboa', label: 'home' }]);
});

test('CSV: Outlook, LinkedIn and semicolon spreadsheets', () => {
  const outlook = 'First Name,Last Name,Company,E-mail Address,E-mail 2 Address,Mobile Phone,Business Phone,Home Street,Home City,Home Postal Code,Birthday\nBo,Li,Q,bo@q.com,,555 0100,555 0199,9 Elm,Austin,73301,4/2/1990\n';
  const [bo] = parseCSV(outlook, 'outlook');
  assert.equal(bo.name, 'Bo Li');
  assert.deepEqual(bo.phones.map((p) => p.label), ['mobile', 'work']);
  assert.equal(bo.addresses[0].value, '9 Elm, Austin 73301');
  assert.equal(bo.birthday, '1990-04-02');

  const linkedin = 'Notes:\n"When exporting your connection data, you may notice that some of the email addresses are missing."\n\nFirst Name,Last Name,URL,Email Address,Company,Position,Connected On\nMia,Kay,https://www.linkedin.com/in/miakay,,Orbit,CTO,01 Jan 2024\n';
  const [mia] = parseContactsFile('Connections.csv', linkedin).contacts;
  assert.equal(mia.source, 'linkedin');
  assert.equal(mia.title, 'CTO');
  assert.deepEqual(mia.socials, [{ network: 'linkedin', value: 'https://www.linkedin.com/in/miakay' }]);

  const [x] = parseCSV('Name;Phone;WhatsApp;Instagram\nRafi;01712345678;+8801712345678;@rafi\n');
  assert.equal(x.name, 'Rafi');
  assert.equal(x.phones.length, 1, 'the WhatsApp number is the same phone');
  assert.deepEqual(x.socials, [{ network: 'whatsapp', value: '+8801712345678' }, { network: 'instagram', value: '@rafi' }]);
});

test('Google and Outlook CSV exports read back', () => {
  const people = [{ name: 'Ana Silva', given: 'Ana', family: 'Silva', company: 'Lyr', title: '', nickname: '', emails: [{ value: 'a@l.co', label: 'work' }], phones: [{ value: '+1 555 0100', label: 'mobile' }], addresses: [], websites: ['https://lyr.co'], socials: [{ network: 'facebook', value: 'ana.s' }], birthday: '1990-04-02', notes: 'Hi, "there"', tags: ['VIP'], favorite: true }];
  const [g] = parseCSV(toGoogleCSV(people));
  assert.equal(g.name, 'Ana Silva');
  assert.equal(g.favorite, true);
  assert.deepEqual(g.tags, ['VIP']);
  assert.equal(g.notes, 'Hi, "there"');
  assert.deepEqual(g.socials, [{ network: 'facebook', value: 'https://facebook.com/ana.s' }]);
  assert.deepEqual(g.websites, ['https://lyr.co']);
  const [o] = parseCSV(toOutlookCSV(people));
  assert.equal(o.emails[0].value, 'a@l.co');
  assert.equal(o.birthday, '1990-04-02');
});

test('JSON: Facebook friends, uploaded contacts, Instagram, Telegram and Lyrsoft backups', () => {
  const friends = parseContactsFile('your_friends.json', JSON.stringify({ friends_v2: [{ name: 'JosÃ© LuÃ­s', timestamp: 1 }] })).contacts;
  assert.deepEqual(friends.map((c) => [c.name, c.source]), [['José Luís', 'facebook']]);

  const uploaded = parseJSON(JSON.stringify([{ label_values: [{ label: 'Name', value: 'Sam' }, { label: 'Phone numbers', vec: [{ value: '+1 415 555 0100' }] }, { label: 'Emails', vec: [{ value: 'sam@x.com' }] }] }]), 'facebook');
  assert.equal(uploaded[0].name, 'Sam');
  assert.equal(uploaded[0].phones[0].value, '+1 415 555 0100');
  assert.equal(uploaded[0].emails[0].value, 'sam@x.com');

  const following = parseContactsFile('following.json', JSON.stringify({ relationships_following: [{ title: 'nasa', string_list_data: [{ href: 'https://www.instagram.com/nasa', timestamp: 1 }] }] })).contacts;
  assert.deepEqual(following.map((c) => [c.name, c.socials[0].network]), [['nasa', 'instagram']]);

  const telegram = parseContactsFile('result.json', JSON.stringify({ contacts: { list: [{ first_name: 'Tim', last_name: 'B', phone_number: '+44 7700 900123' }] }, chats: { list: [{ name: 'Group', messages: [{ title: 'renamed' }] }] } })).contacts;
  assert.deepEqual(telegram.map((c) => [c.name, c.source]), [['Tim B', 'telegram']]);

  const backup = parseJSON(toLyrsoftJSON([{ id: 'x', name: 'Ana', emails: [{ value: 'a@b.co', label: '' }], tags: ['VIP'] }]));
  assert.equal(backup[0].name, 'Ana');
  assert.equal(backup[0].id, undefined);
});

test('Google People API and the phone contact picker', () => {
  const g = fromGooglePerson({ names: [{ displayName: 'Lee Park', givenName: 'Lee', familyName: 'Park' }], emailAddresses: [{ value: 'lee@x.com', type: 'work' }], phoneNumbers: [{ value: '010-1234-5678', type: 'mobile' }], birthdays: [{ date: { month: 3, day: 9 } }], urls: [{ value: 'https://github.com/lee' }] });
  assert.equal(g.name, 'Lee Park');
  assert.equal(g.birthday, '--03-09');
  assert.deepEqual(g.socials, [{ network: 'github', value: 'https://github.com/lee' }]);
  const d = fromDeviceContact({ name: ['Mum'], tel: ['+44 7700 900123'], email: [] });
  assert.equal(d.name, 'Mum');
  assert.equal(d.source, 'device');
  assert.equal(fromDeviceContact({ name: [], tel: [], email: [] }), null);
});

test('social links and mojibake', () => {
  assert.equal(socialUrl({ network: 'whatsapp', value: '+880 1712-345678' }), 'https://wa.me/8801712345678');
  assert.equal(socialUrl({ network: 'instagram', value: '@nasa' }), 'https://instagram.com/nasa');
  assert.equal(socialUrl({ network: 'x', value: 'https://x.com/a' }), 'https://x.com/a');
  assert.equal(socialUrl({ network: 'signal', value: 'abc' }), null);
  assert.equal(fixMojibake('plain'), 'plain');
});

test('cleanContact validates, and is strict only when typed in', () => {
  const c = cleanContact({ given: ' Ana ', family: 'Silva', emails: ['A@B.co', 'bad'], phones: [{ value: '+1 555 0100', label: 'Mobile' }, { value: 'abc' }], socials: [{ network: 'myspace', value: 'x' }], birthday: 'nope', source: 'google' });
  assert.equal(c.name, 'Ana Silva');
  assert.deepEqual(c.emails, [{ value: 'a@b.co', label: '' }]);
  assert.deepEqual(c.phones, [{ value: '+1 555 0100', label: 'mobile' }]);
  assert.deepEqual(c.socials, [{ network: 'other', value: 'x' }]);
  assert.equal(c.birthday, '');
  assert.deepEqual(c.sources, ['google']);
  assert.throws(() => cleanContact({ emails: ['bad'] }, { strict: true }), /isn’t an email/);
  assert.throws(() => cleanContact({ notes: 'only notes' }), /name, an email or a phone/);
  assert.equal(cleanContact({ phones: ['01712345678'] }).name, '01712345678');
});

test('imports merge with people already in the book', () => {
  assert.equal(phoneKey('+880 1712-345678'), phoneKey('01712345678'));
  const existing = [{ id: 'a1', ...cleanContact({ name: 'Rafi', phones: ['01712345678'] }) }, { id: 'b2', ...cleanContact({ name: 'Bo', emails: ['bo@q.com'] }) }];
  const incoming = [
    cleanContact({ name: 'Rafi Ahmed', phones: ['+8801712345678'], emails: ['rafi@x.com'], source: 'google' }),
    cleanContact({ name: 'Bo', emails: ['BO@q.com'] }),
    cleanContact({ name: 'New One', emails: ['n@x.com'] }),
    cleanContact({ name: 'New One', phones: ['555 0100'], emails: ['n@x.com'] }),
    cleanContact({ name: 'Friend Only', source: 'facebook' }),
    cleanContact({ name: 'friend only', source: 'facebook' }),
  ];
  const plan = planImport(existing, incoming);
  assert.equal(plan.unchanged, 1);
  assert.deepEqual(plan.updates.map((c) => c.id), ['a1']);
  assert.equal(plan.updates[0].name, 'Rafi', 'existing names are kept');
  assert.deepEqual(plan.updates[0].emails.map((e) => e.value), ['rafi@x.com']);
  assert.deepEqual(plan.updates[0].sources, ['manual', 'google']);
  assert.deepEqual(plan.creates.map((c) => [c.name, c.phones.length]), [['New One', 1], ['Friend Only', 0]]);
});

test('duplicates are found and merged without losing anything', () => {
  const book = [
    { id: '1', ...cleanContact({ name: 'Ana', emails: ['a@x.com'], notes: 'one' }) },
    { id: '2', ...cleanContact({ name: 'Ana S', emails: ['a@x.com'], phones: ['555 0100'], favorite: true, notes: 'two' }) },
    { id: '3', ...cleanContact({ name: 'Other', phones: ['5550100'] }) },
    { id: '4', ...cleanContact({ name: 'Solo', emails: ['s@x.com'] }) },
  ];
  assert.deepEqual(findDuplicates(book), [['1', '2', '3']]);
  const { contact } = mergeContact(book[0], book[1]);
  assert.equal(contact.id, '1');
  assert.equal(contact.favorite, true);
  assert.equal(contact.phones.length, 1);
  assert.equal(contact.notes, 'one\n\ntwo');
});
