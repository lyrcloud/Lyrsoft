// Lyrsoft Contacts routes, mounted on the work API (index.mjs) like the chat and mail routes.
// Each person's address book is private to them.
//   GET    /contacts                    { contacts, max }
//   POST   /contacts                    { contact } add one
//   PATCH  /contacts/{id}               { ...fields } edit (fields left out are kept)
//   DELETE /contacts/{id}
//   POST   /contacts/delete             { ids } delete several
//   POST   /contacts/import             { contacts, source } add up to 500, merging with people already
//                                        in the book (same email or phone): { created, updated, unchanged, skipped }
//   GET    /contacts/duplicates         { groups: [[id, …]] } people who appear more than once
//   POST   /contacts/merge              { ids } fold the others into the first and delete them
// Importing from phones, Google, Meta, LinkedIn … and exporting (vCard, CSV, JSON) happens in the
// browser (lyrsoft/contacts-formats.js); the API only stores clean records.
//
// Keys in the work table:
//   CONTACTS#<userId>  C#<id>          a contact
import { BULK_MAX, CONTACTS_MAX, IMPORT_BATCH_MAX, cleanContact, findDuplicates, mergeContact, planImport } from './contacts-model.mjs';
import { ID_RE, ValidationError } from './model.mjs';

export function registerContactRoutes(route, { db, HttpError, now, newId }) {
  const { get, put, del, queryAll, putMany, deleteKeys } = db;
  const pk = (me) => `CONTACTS#${me.userId}`;
  const out = ({ PK, SK, ...c }) => c;
  const all = async (me) => (await queryAll({ KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)', ExpressionAttributeValues: { ':pk': pk(me), ':sk': 'C#' } })).map(out);
  const row = (me, c) => ({ PK: pk(me), SK: `C#${c.id}`, ...c });

  async function open(me, id) {
    const c = ID_RE.test(id) ? await get(pk(me), `C#${id}`) : null;
    if (!c) throw new HttpError(404, 'Contact not found.');
    return out(c);
  }

  route('GET', '/contacts', async (me) => ({ contacts: await all(me), max: CONTACTS_MAX }));

  route('POST', '/contacts', async (me, _p, body) => {
    const clean = cleanContact(body.contact || body, { strict: true, source: 'manual' });
    if ((await all(me)).length >= CONTACTS_MAX) throw new HttpError(409, `Your address book is full (${CONTACTS_MAX.toLocaleString('en')} contacts).`);
    const at = now();
    const contact = { id: newId(), ...clean, createdAt: at, updatedAt: at };
    await put(row(me, contact));
    return [201, { contact }];
  });

  route('PATCH', '/contacts/{id}', async (me, { id }, body) => {
    const existing = await open(me, id);
    const clean = cleanContact({ ...existing, ...body, sources: existing.sources }, { strict: true });
    const contact = { ...existing, ...clean, updatedAt: now() };
    await put(row(me, contact));
    return { contact };
  });

  route('DELETE', '/contacts/{id}', async (me, { id }) => {
    await open(me, id);
    await del(pk(me), `C#${id}`);
    return { ok: true };
  });

  route('POST', '/contacts/delete', async (me, _p, body) => {
    const ids = [...new Set(Array.isArray(body.ids) ? body.ids : [])].filter((id) => ID_RE.test(String(id)));
    if (!ids.length) throw new HttpError(400, 'Pick the contacts to delete.');
    if (ids.length > BULK_MAX) throw new HttpError(400, `Delete at most ${BULK_MAX} at a time.`);
    await deleteKeys(ids.map((id) => ({ PK: pk(me), SK: `C#${id}` })));
    return { deleted: ids.length };
  });

  route('POST', '/contacts/import', async (me, _p, body) => {
    const incoming = Array.isArray(body.contacts) ? body.contacts : [];
    if (!incoming.length) throw new HttpError(400, 'No contacts to import.');
    if (incoming.length > IMPORT_BATCH_MAX) throw new HttpError(400, `Send at most ${IMPORT_BATCH_MAX} contacts at a time.`);
    const source = typeof body.source === 'string' ? body.source : undefined;
    const cleaned = [];
    let skipped = 0;
    for (const raw of incoming) {
      try {
        cleaned.push(cleanContact(raw, { source }));
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        skipped += 1;
      }
    }
    const existing = await all(me);
    const { creates, updates, unchanged } = planImport(existing, cleaned);
    const room = Math.max(0, CONTACTS_MAX - existing.length);
    const at = now();
    const fresh = creates.slice(0, room).map((c) => ({ id: newId(), ...c, createdAt: at, updatedAt: at }));
    await putMany([...fresh, ...updates.map((c) => ({ ...c, updatedAt: at }))].map((c) => row(me, c)));
    return { created: fresh.length, updated: updates.length, unchanged, skipped: skipped + (creates.length - fresh.length), full: creates.length > room };
  });

  route('GET', '/contacts/duplicates', async (me) => ({ groups: findDuplicates(await all(me)) }));

  route('POST', '/contacts/merge', async (me, _p, body) => {
    const ids = [...new Set(Array.isArray(body.ids) ? body.ids : [])];
    if (ids.length < 2 || ids.length > 50) throw new HttpError(400, 'Pick two or more contacts to merge.');
    const [first, ...rest] = await Promise.all(ids.map((id) => open(me, String(id))));
    let merged = first;
    for (const c of rest) merged = mergeContact(merged, c).contact;
    const contact = { ...merged, updatedAt: now() };
    await put(row(me, contact));
    await deleteKeys(rest.map((c) => ({ PK: pk(me), SK: `C#${c.id}` })));
    return { contact };
  });
}
