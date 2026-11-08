// Lyrsoft Costs & analytics routes (#/w/<ws>/finance in the app), mounted on the work API (index.mjs).
// Each workspace records its costs and income, sets a monthly budget per category, keeps recurring
// costs (rent, subscriptions) that add themselves every month, and sees the analysis with charts.
// Salaries come in from HR payroll (final or paid runs) and ad spend from Ads & budget, so the whole
// cost picture is in one place.
//
// Who: workspace owners and admins, plus the people named in finance settings. Money is private.
//
//   GET    /workspaces/{ws}/finance?month=&range=12          analysis + the month's entries
//   PATCH  /workspaces/{ws}/finance/settings                 { currency, categories, viewers }
//   POST   /workspaces/{ws}/finance/entries                  add a cost or income
//   PATCH  /workspaces/{ws}/finance/entries/{date}/{id}      edit (a new date moves it)
//   DELETE /workspaces/{ws}/finance/entries/{date}/{id}
//   POST   /workspaces/{ws}/finance/import                   { entries: [{ date, description, amount | debit/credit, … }] }
//   POST   /workspaces/{ws}/finance/recurring                add a recurring cost
//   PATCH  /workspaces/{ws}/finance/recurring/{id}
//   DELETE /workspaces/{ws}/finance/recurring/{id}
//
// Keys in the work table:
//   FIN#<ws>  SETTINGS               currency, categories with budgets, viewers
//   FIN#<ws>  E#<date>#<id>          an entry (recurring ones carry recurringId)
//   FIN#<ws>  REC#<id>               a recurring cost (made: months already added)
import {
  addMonths,
  analyse,
  cleanEntry,
  cleanRecurring,
  cleanSettings,
  DEFAULT_CATEGORIES,
  ENTRIES_PER_IMPORT,
  FREQUENCIES,
  isDate,
  isMonth,
  LINKED,
  monthsBack,
  PAYMENT_METHODS,
  readImportRow,
  recursIn,
  round2,
} from './finance-model.mjs';
import { ID_RE, ValidationError } from './model.mjs';

export function registerFinanceRoutes(route, { db, HttpError, openWorkspace, now, newId }) {
  const { get, put, del, queryAll, putMany } = db;
  const pk = (ws) => `FIN#${ws}`;
  const strip = ({ PK, SK, ...rest }) => rest;
  const prefix = (PK, sk) => queryAll({ KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)', ExpressionAttributeValues: { ':pk': PK, ':sk': sk } });
  const between = (PK, from, to) => queryAll({ KeyConditionExpression: 'PK = :pk AND SK BETWEEN :a AND :b', ExpressionAttributeValues: { ':pk': PK, ':a': from, ':b': to } });
  const today = () => now().slice(0, 10);

  async function access(me, ws) {
    const { workspace, role } = await openWorkspace(me, ws, 'view');
    const stored = await get(pk(ws), 'SETTINGS');
    const settings = cleanSettings({}, stored || { categories: DEFAULT_CATEGORIES });
    const admin = ['owner', 'admin'].includes(role);
    if (!admin && !settings.viewers.includes(me.email)) throw new HttpError(403, 'Costs & analytics is open to workspace owners and admins, and to people they add in its settings.');
    return { workspace, role, admin, settings };
  }

  // Adds this month's (and any missed earlier months') entries for each recurring cost, up to today.
  async function materialise(ws, settings) {
    const recs = (await prefix(pk(ws), 'REC#')).filter((r) => r.active);
    const month = today().slice(0, 7);
    for (const r of recs) {
      const made = new Set(r.made || []);
      const add = [];
      for (let m = r.start; m <= month && add.length < 36; m = addMonths(m, 1)) {
        if (made.has(m) || !recursIn(r, m)) continue;
        const date = `${m}-${String(r.day).padStart(2, '0')}`;
        if (date > today()) continue;
        const id = newId();
        add.push({ PK: pk(ws), SK: `E#${date}#${id}`, id, type: 'cost', date, amount: r.amount, category: settings.categories.some((c) => c.id === r.category) ? r.category : 'other', vendor: r.vendor || '', description: r.name, department: r.department || '', project: '', method: '', status: 'paid', dueDate: '', reference: '', recurringId: r.id, createdAt: now(), createdBy: 'recurring' });
        made.add(m);
      }
      if (add.length) {
        await putMany(add);
        await put({ ...r, made: [...made].sort().slice(-48) });
      }
    }
  }

  // What HR payroll and Ads & budget already know, per month.
  async function linkedCosts(ws, from, to) {
    const payroll = {};
    for (const run of await prefix(`HR#${ws}`, 'PAY#')) {
      if (['final', 'paid'].includes(run.status) && run.month >= from && run.month <= to) payroll[run.month] = round2(run.totals?.earnings ?? run.totals?.net ?? 0);
    }
    const ads = {};
    const adsDaily = {};
    for (const r of await between(`GRO#${ws}`, `SPEND#${from}`, `SPEND#${to}~`)) {
      const m = r.date.slice(0, 7);
      ads[m] = round2((ads[m] || 0) + (r.spend || 0));
      (adsDaily[m] ??= {})[Number(r.date.slice(8, 10))] = round2((adsDaily[m][Number(r.date.slice(8, 10))] || 0) + (r.spend || 0));
    }
    return { payroll, ads, adsDaily };
  }

  route('GET', '/workspaces/{ws}/finance', async (me, { ws }, _b, query) => {
    const a = await access(me, ws);
    await materialise(ws, a.settings);
    const month = isMonth(query.get('month')) ? query.get('month') : today().slice(0, 7);
    const range = [6, 12, 24].includes(Number(query.get('range'))) ? Number(query.get('range')) : 12;
    const months = monthsBack(month, range);
    const [entries, linked, recurring] = await Promise.all([
      between(pk(ws), `E#${months[0]}`, `E#${month}~`),
      linkedCosts(ws, months[0], month),
      prefix(pk(ws), 'REC#'),
    ]);
    const list = entries.map(strip);
    // Unpaid bills from before the range still matter.
    const olderUnpaid = (await between(pk(ws), 'E#0000', `E#${months[0]}`)).map(strip).filter((e) => e.status === 'unpaid');
    return {
      workspace: { id: ws, name: a.workspace.name },
      admin: a.admin,
      settings: a.settings,
      month,
      range,
      today: today(),
      linkedNames: LINKED,
      methods: PAYMENT_METHODS,
      frequencies: FREQUENCIES,
      analysis: analyse({ month, months, entries: list, olderUnpaid, linked, categories: a.settings.categories, today: today(), recurringDue: recurring.filter((r) => recursIn(r, month)).reduce((s, r) => s + r.amount, 0) }),
      entries: list.filter((e) => e.date.startsWith(month)).sort((x, y) => y.date.localeCompare(x.date)),
      recurring: recurring.map(strip).sort((x, y) => x.name.localeCompare(y.name)),
      linked: { payroll: linked.payroll[month] || 0, ads: linked.ads[month] || 0 },
    };
  });

  route('PATCH', '/workspaces/{ws}/finance/settings', async (me, { ws }, body) => {
    const a = await access(me, ws);
    if ('viewers' in body && !a.admin) throw new HttpError(403, 'Only workspace owners and admins choose who sees finances.');
    const settings = cleanSettings(body, a.settings);
    await put({ PK: pk(ws), SK: 'SETTINGS', ...settings, updatedAt: now(), updatedBy: me.email });
    return { settings };
  });

  // ---------------------------------------------------------------- entries

  route('POST', '/workspaces/{ws}/finance/entries', async (me, { ws }, body) => {
    const a = await access(me, ws);
    const entry = { id: newId(), ...cleanEntry(body, a.settings.categories), createdAt: now(), createdBy: me.email };
    await put({ PK: pk(ws), SK: `E#${entry.date}#${entry.id}`, ...entry });
    return [201, { entry }];
  });

  async function openEntry(ws, date, id) {
    const row = isDate(date) && ID_RE.test(id) ? await get(pk(ws), `E#${date}#${id}`) : null;
    if (!row) throw new HttpError(404, 'Entry not found.');
    return strip(row);
  }

  route('PATCH', '/workspaces/{ws}/finance/entries/{date}/{id}', async (me, { ws, date, id }, body) => {
    const a = await access(me, ws);
    const existing = await openEntry(ws, date, id);
    const entry = { ...cleanEntry(body, a.settings.categories, existing), id, updatedAt: now(), updatedBy: me.email };
    if (entry.date !== date) await del(pk(ws), `E#${date}#${id}`);
    await put({ PK: pk(ws), SK: `E#${entry.date}#${id}`, ...entry });
    return { entry };
  });

  route('DELETE', '/workspaces/{ws}/finance/entries/{date}/{id}', async (me, { ws, date, id }) => {
    await access(me, ws);
    await openEntry(ws, date, id);
    await del(pk(ws), `E#${date}#${id}`);
    return { ok: true };
  });

  route('POST', '/workspaces/{ws}/finance/import', async (me, { ws }, body) => {
    const a = await access(me, ws);
    const rows = Array.isArray(body.entries) ? body.entries : [];
    if (!rows.length) throw new ValidationError('No rows to import.');
    if (rows.length > ENTRIES_PER_IMPORT) throw new ValidationError(`Import at most ${ENTRIES_PER_IMPORT} rows at a time.`);
    const out = [];
    let skipped = 0;
    for (const raw of rows) {
      const read = readImportRow(raw, a.settings.categories);
      if (!read) {
        skipped += 1;
        continue;
      }
      try {
        const entry = { id: newId(), ...cleanEntry({ ...read, method: raw.method, status: 'paid' }, a.settings.categories), imported: true, createdAt: now(), createdBy: me.email };
        out.push({ PK: pk(ws), SK: `E#${entry.date}#${entry.id}`, ...entry });
      } catch {
        skipped += 1;
      }
    }
    await putMany(out);
    return { imported: out.length, skipped, costs: out.filter((e) => e.type === 'cost').length, income: out.filter((e) => e.type === 'income').length };
  });

  // ---------------------------------------------------------------- recurring

  route('POST', '/workspaces/{ws}/finance/recurring', async (me, { ws }, body) => {
    const a = await access(me, ws);
    const rec = { id: newId(), active: true, made: [], ...cleanRecurring(body, a.settings.categories), createdAt: now(), createdBy: me.email };
    await put({ PK: pk(ws), SK: `REC#${rec.id}`, ...rec });
    await materialise(ws, a.settings);
    return [201, { recurring: rec }];
  });

  async function openRec(ws, id) {
    const row = ID_RE.test(id) ? await get(pk(ws), `REC#${id}`) : null;
    if (!row) throw new HttpError(404, 'Recurring cost not found.');
    return strip(row);
  }

  route('PATCH', '/workspaces/{ws}/finance/recurring/{id}', async (me, { ws, id }, body) => {
    const a = await access(me, ws);
    const existing = await openRec(ws, id);
    const rec = { ...cleanRecurring(body, a.settings.categories, existing), id, made: existing.made || [], updatedAt: now() };
    await put({ PK: pk(ws), SK: `REC#${id}`, ...rec });
    return { recurring: rec };
  });

  route('DELETE', '/workspaces/{ws}/finance/recurring/{id}', async (me, { ws, id }) => {
    await access(me, ws);
    await openRec(ws, id);
    await del(pk(ws), `REC#${id}`);
    return { ok: true };
  });
}
