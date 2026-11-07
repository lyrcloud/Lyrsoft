// Lyrsoft Contacts: everyone's own address book (contacts.mjs routes, lyrsoft/contacts.js app).
// Pure functions, tested in contacts.test.mjs: validation, matching the same person across imports,
// merging two records and finding duplicates.
import { ValidationError } from './model.mjs';

export const CONTACTS_MAX = 10000; // per person
export const IMPORT_BATCH_MAX = 500; // contacts per import request (the app sends big files in chunks)
export const BULK_MAX = 1000; // ids per bulk delete
export const SOCIAL_NETWORKS = ['whatsapp', 'facebook', 'messenger', 'instagram', 'threads', 'x', 'linkedin', 'telegram', 'tiktok', 'youtube', 'snapchat', 'github', 'viber', 'signal', 'wechat', 'skype', 'discord', 'line', 'kakaotalk', 'imo', 'pinterest', 'reddit', 'twitch', 'bluesky', 'other'];
export const SOURCES = ['manual', 'device', 'google', 'facebook', 'instagram', 'linkedin', 'telegram', 'outlook', 'icloud', 'yahoo', 'vcard', 'csv', 'json', 'lyrsoft'];

const EMAIL_RE = /^[^\s@<>(),;:"]{1,64}@[^\s@<>(),;:"]{1,190}\.[^\s@<>(),;:"]{2,63}$/;
const BIRTHDAY_RE = /^(\d{4}|-)-\d{2}-\d{2}$/;
const LIMITS = { emails: 10, phones: 10, addresses: 5, websites: 10, socials: 20, tags: 20 };

const text = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const multiline = (value, max) => String(value ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim().slice(0, max);
const list = (value) => (Array.isArray(value) ? value : value == null || value === '' ? [] : [value]);

export const phoneKey = (phone) => {
  const digits = String(phone || '').replace(/\D/g, '');
  // The last 9 digits match "+880 1712-345678" with "01712345678" and "+1 (415) 555-0100" with "4155550100".
  return digits.length >= 6 ? digits.slice(-9) : '';
};
const nameKey = (name) => text(name, 200).toLowerCase();

function cleanEntries(value, field, { strict }) {
  const out = [];
  for (const raw of list(value)) {
    const entry = typeof raw === 'object' && raw ? raw : { value: raw };
    const label = text(entry.label, 30).toLowerCase();
    if (field === 'emails') {
      const email = text(entry.value, 254).toLowerCase().replace(/^mailto:/, '');
      if (!email) continue;
      if (!EMAIL_RE.test(email)) {
        if (strict) throw new ValidationError(`“${email}” isn’t an email address.`);
        continue;
      }
      if (!out.some((e) => e.value === email)) out.push({ value: email, label });
    } else if (field === 'phones') {
      const phone = text(entry.value, 40).replace(/^tel:/i, '');
      if (!phone) continue;
      if (!/^[0-9+()\-. /#*,;wpx]+$/i.test(phone) || phone.replace(/\D/g, '').length < 3) {
        if (strict) throw new ValidationError(`“${phone}” isn’t a phone number.`);
        continue;
      }
      if (!out.some((p) => p.value.replace(/\D/g, '') === phone.replace(/\D/g, ''))) out.push({ value: phone, label });
    } else {
      const address = text(entry.value, 300);
      if (address && !out.some((a) => a.value === address)) out.push({ value: address, label });
    }
    if (out.length >= LIMITS[field]) break;
  }
  return out;
}

// Validates a contact from the app or an import. `strict` (typing it in) rejects bad emails and
// phones; imports quietly drop them. Throws when nothing identifies the person.
export function cleanContact(input, { strict = false, source } = {}) {
  if (!input || typeof input !== 'object') throw new ValidationError('Send a contact.');
  const c = {
    given: text(input.given, 100),
    family: text(input.family, 100),
    nickname: text(input.nickname, 100),
    company: text(input.company, 150),
    title: text(input.title, 150),
    emails: cleanEntries(input.emails, 'emails', { strict }),
    phones: cleanEntries(input.phones, 'phones', { strict }),
    addresses: cleanEntries(input.addresses, 'addresses', { strict }),
    websites: [...new Set(list(input.websites).map((w) => text(typeof w === 'object' ? w?.value : w, 300)).filter(Boolean))].slice(0, LIMITS.websites),
    socials: [],
    birthday: BIRTHDAY_RE.test(String(input.birthday || '')) ? String(input.birthday) : '',
    notes: multiline(input.notes, 4000),
    tags: [...new Set(list(input.tags).map((t) => text(t, 40)).filter(Boolean))].slice(0, LIMITS.tags),
    favorite: input.favorite === true,
    sources: [...new Set([...list(input.sources), source || input.source].filter((s) => SOURCES.includes(s)))],
  };
  for (const s of list(input.socials)) {
    const value = text(s?.value, 300);
    const network = SOCIAL_NETWORKS.includes(s?.network) ? s.network : 'other';
    if (value && !c.socials.some((x) => x.network === network && x.value.toLowerCase() === value.toLowerCase())) c.socials.push({ network, value });
    if (c.socials.length >= LIMITS.socials) break;
  }
  if (!c.sources.length) c.sources = ['manual'];
  c.name = text(input.name, 200) || text(`${c.given} ${c.family}`, 200) || c.nickname || c.company || c.emails[0]?.value || c.phones[0]?.value || '';
  if (!c.name) throw new ValidationError('Give the contact a name, an email or a phone number.');
  return c;
}

// Keys that identify the same person: any email or phone; the name only for name-only records
// (a Facebook friends list), so re-importing it doesn't double up.
export function matchKeys(c) {
  const keys = [...c.emails.map((e) => `e:${e.value}`), ...c.phones.map((p) => phoneKey(p.value)).filter(Boolean).map((k) => `p:${k}`)];
  return keys.length ? keys : [`n:${nameKey(c.name)}`];
}

const sameEntries = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Folds `incoming` into `base`: lists are combined, empty fields filled, nothing is overwritten.
// Returns { contact, changed }.
export function mergeContact(base, incoming) {
  const out = { ...base };
  for (const field of ['given', 'family', 'nickname', 'company', 'title', 'birthday']) if (!out[field] && incoming[field]) out[field] = incoming[field];
  if ((!out.name || out.name === out.emails[0]?.value || out.name === out.phones[0]?.value) && incoming.name) out.name = incoming.name;
  const union = (a, b, key, max) => {
    const result = [...a];
    for (const x of b) if (!result.some((y) => key(y) === key(x)) && result.length < max) result.push(x);
    return result;
  };
  out.emails = union(base.emails, incoming.emails, (e) => e.value, LIMITS.emails);
  out.phones = union(base.phones, incoming.phones, (p) => phoneKey(p.value) || p.value, LIMITS.phones);
  out.addresses = union(base.addresses, incoming.addresses, (a) => a.value.toLowerCase(), LIMITS.addresses);
  out.websites = union(base.websites, incoming.websites, (w) => w.toLowerCase(), LIMITS.websites);
  out.socials = union(base.socials, incoming.socials, (s) => `${s.network}:${s.value.toLowerCase()}`, LIMITS.socials);
  out.tags = union(base.tags, incoming.tags, (t) => t.toLowerCase(), LIMITS.tags);
  out.sources = union(base.sources || [], incoming.sources || [], (s) => s, SOURCES.length);
  out.favorite = Boolean(base.favorite || incoming.favorite);
  if (incoming.notes && !base.notes.includes(incoming.notes)) out.notes = [base.notes, incoming.notes].filter(Boolean).join('\n\n').slice(0, 4000);
  const changed = Object.keys(out).some((k) => (Array.isArray(out[k]) ? !sameEntries(out[k], base[k]) : out[k] !== base[k]));
  return { contact: out, changed };
}

// Plans an import against the existing book: what to create and which existing records gain
// something. People repeated inside the import are merged together too.
export function planImport(existing, incoming) {
  const index = new Map();
  const records = existing.map((c) => ({ contact: c, isNew: false, changed: false }));
  const remember = (record) => {
    for (const key of matchKeys(record.contact)) if (!index.has(key)) index.set(key, record);
  };
  records.forEach(remember);
  let unchanged = 0;
  for (const c of incoming) {
    const record = matchKeys(c).map((k) => index.get(k)).find(Boolean);
    if (!record) {
      const fresh = { contact: c, isNew: true, changed: true };
      records.push(fresh);
      remember(fresh);
      continue;
    }
    const { contact, changed } = mergeContact(record.contact, c);
    if (changed) {
      record.contact = contact;
      record.changed = true;
      remember(record);
    } else if (!record.isNew) unchanged += 1;
  }
  return {
    creates: records.filter((r) => r.isNew).map((r) => r.contact),
    updates: records.filter((r) => !r.isNew && r.changed).map((r) => r.contact),
    unchanged,
  };
}

// Groups of contact ids that look like the same person: a shared email or phone, or the same name.
export function findDuplicates(contacts) {
  const parent = new Map(contacts.map((c) => [c.id, c.id]));
  const find = (id) => (parent.get(id) === id ? id : (parent.set(id, find(parent.get(id))), parent.get(id)));
  const owner = new Map();
  for (const c of contacts) {
    const keys = [...c.emails.map((e) => `e:${e.value}`), ...c.phones.map((p) => phoneKey(p.value)).filter(Boolean).map((k) => `p:${k}`)];
    if (nameKey(c.name).length >= 3) keys.push(`n:${nameKey(c.name)}`);
    for (const key of keys) {
      if (owner.has(key)) parent.set(find(c.id), find(owner.get(key)));
      else owner.set(key, c.id);
    }
  }
  const groups = new Map();
  for (const c of contacts) {
    const root = find(c.id);
    groups.set(root, [...(groups.get(root) || []), c.id]);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}
