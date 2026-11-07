// Lyrsoft Marketing routes, mounted on the work API (index.mjs) like contacts and chat. Each workspace
// has its own audience (subscribers with tags), signup forms, email campaigns and sender settings.
// Members draft campaigns and manage subscribers; owners and admins change settings and send.
//
//   GET    /workspaces/{ws}/marketing                       overview: settings, campaigns, forms, tags, sending limit
//   GET    /workspaces/{ws}/marketing/subscribers           { subscribers }
//   POST   /workspaces/{ws}/marketing/subscribers           { email, name, tags } add one
//   PATCH  /workspaces/{ws}/marketing/subscribers/{email}   { name?, tags?, unsubscribe? }
//   POST   /workspaces/{ws}/marketing/subscribers/delete    { emails }
//   POST   /workspaces/{ws}/marketing/subscribers/import    { subscribers, tags, source }
//   POST   /workspaces/{ws}/marketing/subscribers/tag       { emails, add, remove }
//   PATCH  /workspaces/{ws}/marketing/settings              sender name and address, reply-to, postal address, colour, logo
//   POST   /workspaces/{ws}/marketing/campaigns             new draft
//   GET    /workspaces/{ws}/marketing/campaigns/{id}        campaign with stats
//   PATCH  /workspaces/{ws}/marketing/campaigns/{id}        edit a draft
//   DELETE /workspaces/{ws}/marketing/campaigns/{id}
//   POST   /workspaces/{ws}/marketing/campaigns/{id}/duplicate
//   POST   /workspaces/{ws}/marketing/campaigns/{id}/test   { emails } send a test copy
//   POST   /workspaces/{ws}/marketing/campaigns/{id}/send   { at? } send now, or schedule for `at`
//   POST   /workspaces/{ws}/marketing/campaigns/{id}/cancel unschedule, or stop a send part-way
//   GET    /workspaces/{ws}/marketing/campaigns/{id}/recipients
//   POST|PATCH|DELETE /workspaces/{ws}/marketing/forms[/{id}]
//
// Public (no sign-in), served at https://lyrsoft.com/public/… through CloudFront:
//   GET  /public/m/open         1×1 pixel that counts an open
//   GET  /public/m/click        counts a click and redirects to the campaign's link
//   GET|POST /public/m/unsubscribe   confirm page / unsubscribe (also mail apps' one-click)
//   GET|POST /public/subscribe  hosted signup page / signup from that page or a form embedded anywhere
//
// Sending happens in the background: starting a send snapshots the audience into recipient rows,
// then the Lambda invokes itself (or, locally, a timer) to send for ~20 seconds at a time until none
// are left. A one-minute EventBridge tick starts scheduled campaigns and resumes stalled sends. SES
// bounce and complaint events arrive through SNS and suppress those addresses.
//
// Keys in the work table:
//   MKT#<ws>        SETTINGS          sender settings
//   MKT#<ws>        SUB#<email>       subscriber
//   MKT#<ws>        CAMP#<id>         campaign (s_<stat> counters)  GSI1: MKT_ACTIVE / <time>#<ws>#<id> while scheduled or sending
//   MKT#<ws>        FORM#<id>         signup form
//   MKTC#<id>       R#<email>         a campaign's recipient: queued, sent or failed, opened, clicked
//   RATE#mkt#<ws>   <day>             emails sent today (sending limit)
import { escapeHtml, renderCampaignEmail } from '../../lyrsoft/marketing-email.js';
import {
  audienceOf,
  BULK_MAX,
  CAMPAIGNS_MAX,
  campaignLinks,
  campaignStats,
  cleanCampaign,
  cleanEmail,
  cleanForm,
  cleanSettings,
  cleanSignup,
  cleanSubscriber,
  cleanTags,
  clickTarget,
  DAILY_LIMIT,
  FORMS_MAX,
  IMPORT_BATCH_MAX,
  planSubscriberImport,
  readLinkParams,
  readyToSendError,
  recipientUrls,
  senderFor,
  STAFF_DAILY_LIMIT,
  SUBSCRIBERS_MAX,
  SUBSCRIBES_PER_FORM_PER_DAY,
  SUBSCRIBES_PER_IP_PER_HOUR,
  TEST_SENDS_PER_DAY,
  validEmail,
} from './marketing-model.mjs';
import { ID_RE, ValidationError } from './model.mjs';

const SEND_BUDGET_MS = 20_000; // per run; the Lambda times out at 29 s
const SEND_RATE = 12; // emails per second (SES allows 14)
const WORKERS = 8;
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function registerMarketingRoutes(route, deps) {
  const { db, HttpError, openWorkspace, isStaff, now, newId, sendRaw, getAppSecret, defaultFrom, mailDomains, publicBase, siteUrl, continueSending } = deps;
  const { get, put, del, queryAll, putMany, deleteKeys, update } = db;

  const pk = (ws) => `MKT#${ws}`;
  const prefix = (PK, sk, extra = {}) => queryAll({ KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)', ExpressionAttributeValues: { ':pk': PK, ':sk': sk }, ...extra });
  const strip = ({ PK, SK, GSI1PK, GSI1SK, ...rest }) => rest;
  const subscribers = async (ws) => (await prefix(pk(ws), 'SUB#')).map(strip);
  const subRow = (ws, s) => ({ PK: pk(ws), SK: `SUB#${s.email}`, ...s });
  const getSettings = async (ws) => strip((await get(pk(ws), 'SETTINGS')) || { PK: '', SK: '' });

  async function access(me, ws, ability = 'view') {
    const { workspace, role } = await openWorkspace(me, ws, ability);
    return { workspace, role, canSend: ['owner', 'admin'].includes(role), staff: isStaff(me.globalRole) };
  }
  const requireSender = (a) => {
    if (!a.canSend) throw new HttpError(403, 'Only workspace owners and admins can send campaigns and change marketing settings.');
  };

  const dailyKey = (ws) => ({ PK: `RATE#mkt#${ws}`, SK: now().slice(0, 10) });
  const sentToday = async (ws) => Number((await get(dailyKey(ws).PK, dailyKey(ws).SK))?.hits || 0);
  const addSent = (ws, n) => update({
    Key: dailyKey(ws),
    UpdateExpression: 'ADD hits :n SET expiresAt = :e',
    ExpressionAttributeValues: { ':n': n, ':e': Math.floor(Date.now() / 1000) + 26 * 3600 },
  });
  const limitFor = (staff) => (staff ? STAFF_DAILY_LIMIT : DAILY_LIMIT);
  async function countUp(key, period) {
    const { Attributes } = await update({
      Key: { PK: `RATE#${key}`, SK: now().slice(0, period === 'day' ? 10 : 13) },
      UpdateExpression: 'ADD hits :one SET expiresAt = :e',
      ExpressionAttributeValues: { ':one': 1, ':e': Math.floor(Date.now() / 1000) + (period === 'day' ? 26 : 2) * 3600 },
      ReturnValues: 'ALL_NEW',
    });
    return Attributes.hits;
  }

  // ---------------------------------------------------------------- shapes

  const campaignOut = (row, { full = false } = {}) => ({
    id: row.id,
    name: row.name,
    subject: row.subject,
    preheader: row.preheader,
    ...(full ? { body: row.body } : {}),
    audience: row.audience || { tags: [] },
    status: row.status,
    scheduledAt: row.scheduledAt || null,
    startedAt: row.startedAt || null,
    finishedAt: row.finishedAt || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdBy: row.createdBy,
    sentBy: row.sentBy || null,
    error: row.error || null,
    stats: campaignStats(row),
  });
  const formOut = (ws, f) => ({ ...strip(f), url: `${publicBase}/public/subscribe?w=${encodeURIComponent(ws)}&f=${encodeURIComponent(f.id)}` });

  async function openCampaign(ws, id) {
    const row = ID_RE.test(id) ? await get(pk(ws), `CAMP#${id}`) : null;
    if (!row) throw new HttpError(404, 'Campaign not found.');
    return row;
  }

  // ---------------------------------------------------------------- overview

  route('GET', '/workspaces/{ws}/marketing', async (me, { ws }) => {
    const a = await access(me, ws);
    const [settings, subs, campaigns, forms, used] = await Promise.all([
      getSettings(ws),
      subscribers(ws),
      prefix(pk(ws), 'CAMP#'),
      prefix(pk(ws), 'FORM#'),
      sentToday(ws),
    ]);
    const counts = { total: subs.length, subscribed: 0, unsubscribed: 0, bounced: 0, complained: 0 };
    const tags = new Map();
    for (const s of subs) {
      counts[s.status] = (counts[s.status] || 0) + 1;
      if (s.status === 'subscribed') for (const t of s.tags || []) tags.set(t, (tags.get(t) || 0) + 1);
    }
    const recent = subs.filter((s) => Date.now() - Date.parse(s.createdAt) < 30 * 864e5 && s.status === 'subscribed').length;
    campaigns.sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)));
    return {
      settings,
      counts,
      newLast30Days: recent,
      tags: [...tags].map(([tag, count]) => ({ tag, count })).sort((x, y) => x.tag.localeCompare(y.tag)),
      campaigns: campaigns.map((c) => campaignOut(c)),
      forms: forms.map((f) => formOut(ws, f)).sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt))),
      limits: { daily: limitFor(a.staff), sentToday: used, subscribersMax: SUBSCRIBERS_MAX },
      role: a.role,
      canSend: a.canSend,
      staff: a.staff,
      domains: a.staff ? mailDomains : [],
      defaultFrom,
      publicBase,
    };
  });

  // ---------------------------------------------------------------- subscribers

  route('GET', '/workspaces/{ws}/marketing/subscribers', async (me, { ws }) => {
    await access(me, ws);
    const subs = await subscribers(ws);
    subs.sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)));
    return { subscribers: subs };
  });

  route('POST', '/workspaces/{ws}/marketing/subscribers', async (me, { ws }, body) => {
    await access(me, ws, 'editBoards');
    const s = cleanSubscriber(body);
    const existing = await get(pk(ws), `SUB#${s.email}`);
    if (existing) throw new HttpError(409, `${s.email} is already in your audience.`);
    if ((await subscribers(ws)).length >= SUBSCRIBERS_MAX) throw new HttpError(409, `Your audience is full (${SUBSCRIBERS_MAX.toLocaleString('en')} people).`);
    const at = now();
    const subscriber = { ...s, status: 'subscribed', source: 'manual', createdAt: at, updatedAt: at, addedBy: me.email };
    await put(subRow(ws, subscriber));
    return [201, { subscriber }];
  });

  route('PATCH', '/workspaces/{ws}/marketing/subscribers/{email}', async (me, { ws, email }, body) => {
    await access(me, ws, 'editBoards');
    const row = await get(pk(ws), `SUB#${cleanEmail(email)}`);
    if (!row) throw new HttpError(404, 'Subscriber not found.');
    const next = { ...strip(row), updatedAt: now() };
    if ('name' in body) next.name = cleanSubscriber({ email: row.email, name: body.name }).name;
    if ('tags' in body) next.tags = cleanTags(body.tags);
    // People unsubscribe themselves back in through a signup form; the team can only unsubscribe them.
    if (body.unsubscribe === true && next.status === 'subscribed') {
      next.status = 'unsubscribed';
      next.unsubscribedAt = next.updatedAt;
      next.unsubscribedBy = me.email;
    }
    await put(subRow(ws, next));
    return { subscriber: next };
  });

  route('POST', '/workspaces/{ws}/marketing/subscribers/delete', async (me, { ws }, body) => {
    await access(me, ws, 'editBoards');
    const emails = [...new Set((Array.isArray(body.emails) ? body.emails : []).map(cleanEmail))].filter(validEmail);
    if (!emails.length) throw new HttpError(400, 'Pick the people to delete.');
    if (emails.length > BULK_MAX) throw new HttpError(400, `Delete at most ${BULK_MAX} at a time.`);
    await deleteKeys(emails.map((e) => ({ PK: pk(ws), SK: `SUB#${e}` })));
    return { deleted: emails.length };
  });

  route('POST', '/workspaces/{ws}/marketing/subscribers/import', async (me, { ws }, body) => {
    await access(me, ws, 'editBoards');
    const incoming = Array.isArray(body.subscribers) ? body.subscribers : [];
    if (!incoming.length) throw new HttpError(400, 'Nobody to import.');
    if (incoming.length > IMPORT_BATCH_MAX) throw new HttpError(400, `Send at most ${IMPORT_BATCH_MAX} people at a time.`);
    const cleaned = [];
    let skipped = 0;
    for (const raw of incoming) {
      try {
        cleaned.push(cleanSubscriber(raw));
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        skipped += 1;
      }
    }
    const existing = await subscribers(ws);
    const source = ['csv', 'paste', 'contacts', 'team', 'vcard', 'import'].includes(body.source) ? body.source : 'import';
    const plan = planSubscriberImport(existing, cleaned, { tags: cleanTags(body.tags), source, at: now() });
    const room = Math.max(0, SUBSCRIBERS_MAX - existing.length);
    const known = new Set(existing.map((s) => s.email));
    let fresh = 0;
    const rows = plan.rows.filter((r) => known.has(r.email) || fresh++ < room);
    await putMany(rows.map((r) => subRow(ws, { ...r, addedBy: r.addedBy || me.email })));
    return { created: Math.min(plan.created, room), updated: plan.updated, unchanged: plan.unchanged, skipped: skipped + Math.max(0, plan.created - room), full: plan.created > room };
  });

  route('POST', '/workspaces/{ws}/marketing/subscribers/tag', async (me, { ws }, body) => {
    await access(me, ws, 'editBoards');
    const emails = new Set((Array.isArray(body.emails) ? body.emails : []).map(cleanEmail));
    if (!emails.size || emails.size > BULK_MAX) throw new HttpError(400, `Pick 1 to ${BULK_MAX} people.`);
    const add = cleanTags(body.add);
    const remove = new Set(cleanTags(body.remove));
    const at = now();
    const changed = (await subscribers(ws))
      .filter((s) => emails.has(s.email))
      .map((s) => ({ ...s, tags: cleanTags([...(s.tags || []).filter((t) => !remove.has(t)), ...add]), updatedAt: at }));
    await putMany(changed.map((s) => subRow(ws, s)));
    return { updated: changed.length };
  });

  // ---------------------------------------------------------------- settings

  route('PATCH', '/workspaces/{ws}/marketing/settings', async (me, { ws }, body) => {
    const a = await access(me, ws);
    requireSender(a);
    const current = await getSettings(ws);
    // Only staff can pick a From address; keep one they set when someone else edits the rest.
    const settings = cleanSettings({ ...current, ...body, fromEmail: a.staff ? body.fromEmail ?? current.fromEmail : '' }, { staff: a.staff, domains: mailDomains });
    if (!a.staff && current.fromEmail) settings.fromEmail = current.fromEmail;
    const saved = { ...settings, updatedAt: now(), updatedBy: me.email };
    await put({ PK: pk(ws), SK: 'SETTINGS', ...saved });
    return { settings: saved };
  });

  // ---------------------------------------------------------------- campaigns

  route('POST', '/workspaces/{ws}/marketing/campaigns', async (me, { ws }, body) => {
    await access(me, ws, 'editBoards');
    if ((await prefix(pk(ws), 'CAMP#', { ProjectionExpression: 'SK' })).length >= CAMPAIGNS_MAX) throw new HttpError(409, `A workspace can keep ${CAMPAIGNS_MAX} campaigns. Delete old ones first.`);
    const at = now();
    const campaign = { id: newId(), ...cleanCampaign(body.campaign || body), status: 'draft', createdAt: at, updatedAt: at, createdBy: me.email };
    await put({ PK: pk(ws), SK: `CAMP#${campaign.id}`, ...campaign });
    return [201, { campaign: campaignOut(campaign, { full: true }) }];
  });

  route('GET', '/workspaces/{ws}/marketing/campaigns/{id}', async (me, { ws, id }) => {
    await access(me, ws);
    return { campaign: campaignOut(await openCampaign(ws, id), { full: true }) };
  });

  route('PATCH', '/workspaces/{ws}/marketing/campaigns/{id}', async (me, { ws, id }, body) => {
    await access(me, ws, 'editBoards');
    const row = await openCampaign(ws, id);
    if (row.status !== 'draft') throw new HttpError(409, 'Only drafts can be edited. Duplicate this campaign to change it.');
    const next = { ...row, ...cleanCampaign(body, { partial: true }), updatedAt: now(), updatedBy: me.email };
    await put(next);
    return { campaign: campaignOut(next, { full: true }) };
  });

  route('DELETE', '/workspaces/{ws}/marketing/campaigns/{id}', async (me, { ws, id }) => {
    const a = await access(me, ws, 'editBoards');
    const row = await openCampaign(ws, id);
    if (row.status === 'sending') throw new HttpError(409, 'Stop the send before deleting this campaign.');
    if (row.status !== 'draft') requireSender(a);
    const recipients = await prefix(`MKTC#${id}`, 'R#', { ProjectionExpression: 'PK, SK' });
    await deleteKeys(recipients.map(({ PK, SK }) => ({ PK, SK })));
    await del(pk(ws), `CAMP#${id}`);
    return { ok: true };
  });

  route('POST', '/workspaces/{ws}/marketing/campaigns/{id}/duplicate', async (me, { ws, id }) => {
    await access(me, ws, 'editBoards');
    const row = await openCampaign(ws, id);
    const at = now();
    const campaign = { id: newId(), ...cleanCampaign({ ...row, name: `${row.name} (copy)` }), status: 'draft', createdAt: at, updatedAt: at, createdBy: me.email };
    await put({ PK: pk(ws), SK: `CAMP#${campaign.id}`, ...campaign });
    return [201, { campaign: campaignOut(campaign, { full: true }) }];
  });

  route('POST', '/workspaces/{ws}/marketing/campaigns/{id}/test', async (me, { ws, id }, body) => {
    await access(me, ws, 'editBoards');
    const row = await openCampaign(ws, id);
    const settings = await getSettings(ws);
    const missing = readyToSendError(row, { ...settings, fromName: settings.fromName || me.name || 'Lyrsoft', address: settings.address || '-' });
    if (missing) throw new HttpError(400, missing);
    const emails = [...new Set((Array.isArray(body.emails) ? body.emails : [me.email]).map(cleanEmail))].filter(validEmail).slice(0, 5);
    if (!emails.length) throw new HttpError(400, 'Enter an email address to send the test to.');
    if ((await countUp(`mkt-test#${ws}`, 'day')) > TEST_SENDS_PER_DAY) throw new HttpError(429, `That’s ${TEST_SENDS_PER_DAY} test emails today. Try again tomorrow.`);
    const sender = senderFor({ ...settings, fromName: settings.fromName || me.name || 'Lyrsoft' }, defaultFrom);
    const subscriber = (await get(pk(ws), `SUB#${me.email}`)) || { email: me.email, name: me.name };
    for (const to of emails) {
      const email = renderCampaignEmail(row, settings, { recipient: { ...subscriber, email: to } });
      await sendRaw({ from: sender, to, replyTo: settings.replyTo || me.email, subject: `[Test] ${email.subject}`, text: email.text, html: email.html, tags: { ws, kind: 'test' } });
    }
    return { sent: emails.length };
  });

  route('POST', '/workspaces/{ws}/marketing/campaigns/{id}/send', async (me, { ws, id }, body) => {
    const a = await access(me, ws);
    requireSender(a);
    const row = await openCampaign(ws, id);
    if (!['draft', 'scheduled'].includes(row.status)) throw new HttpError(409, 'This campaign has already been sent.');
    const settings = await getSettings(ws);
    const missing = readyToSendError(row, settings);
    if (missing) throw new HttpError(400, missing);
    const size = audienceOf(await subscribers(ws), row.audience).length;
    if (!size) throw new HttpError(400, 'Nobody in this audience is subscribed.');
    if (body.at) {
      const at = new Date(body.at);
      if (Number.isNaN(at.getTime()) || at.getTime() < Date.now() + 60_000) throw new HttpError(400, 'Pick a time at least a minute from now.');
      if (at.getTime() > Date.now() + 365 * 864e5) throw new HttpError(400, 'Schedule within the next year.');
      const next = { ...row, status: 'scheduled', scheduledAt: at.toISOString(), scheduledBy: me.email, sentBy: me.email, staffSender: a.staff, GSI1PK: 'MKT_ACTIVE', GSI1SK: `${at.toISOString()}#${ws}#${id}`, updatedAt: now() };
      await put(next);
      return { campaign: campaignOut(next) };
    }
    const campaign = await startSend(ws, row, { by: me.email, staff: a.staff });
    return { campaign: campaignOut(campaign) };
  });

  route('POST', '/workspaces/{ws}/marketing/campaigns/{id}/cancel', async (me, { ws, id }) => {
    const a = await access(me, ws);
    requireSender(a);
    const row = await openCampaign(ws, id);
    if (row.status === 'scheduled') {
      const { GSI1PK, GSI1SK, scheduledAt, ...rest } = row;
      const next = { ...rest, status: 'draft', updatedAt: now() };
      await put(next);
      return { campaign: campaignOut(next) };
    }
    if (row.status !== 'sending') throw new HttpError(409, 'Only scheduled or sending campaigns can be stopped.');
    await update({
      Key: { PK: pk(ws), SK: `CAMP#${id}` },
      UpdateExpression: 'SET #s = :c, finishedAt = :at, #e = :why REMOVE GSI1PK, GSI1SK',
      ExpressionAttributeNames: { '#s': 'status', '#e': 'error' },
      ExpressionAttributeValues: { ':c': 'cancelled', ':at': now(), ':why': `Stopped by ${me.email}` },
    });
    return { campaign: campaignOut(await openCampaign(ws, id)) };
  });

  route('GET', '/workspaces/{ws}/marketing/campaigns/{id}/recipients', async (me, { ws, id }, _b, query) => {
    await access(me, ws);
    await openCampaign(ws, id);
    const filter = query.get('filter') || 'all';
    const rows = (await prefix(`MKTC#${id}`, 'R#')).map(strip).filter((r) =>
      filter === 'opened' ? r.openedAt : filter === 'clicked' ? r.clickedAt : filter === 'failed' ? r.status === 'failed' || r.bouncedAt : filter === 'unsubscribed' ? r.unsubscribedAt : true);
    rows.sort((x, y) => String(y.clickedAt || y.openedAt || '').localeCompare(String(x.clickedAt || x.openedAt || '')) || x.email.localeCompare(y.email));
    return { recipients: rows.slice(0, 2000), total: rows.length };
  });

  // ---------------------------------------------------------------- forms

  route('POST', '/workspaces/{ws}/marketing/forms', async (me, { ws }, body) => {
    await access(me, ws, 'editBoards');
    if ((await prefix(pk(ws), 'FORM#')).length >= FORMS_MAX) throw new HttpError(409, `A workspace can have ${FORMS_MAX} forms.`);
    const at = now();
    const form = { id: newId(), ...cleanForm(body), submissions: 0, createdAt: at, updatedAt: at, createdBy: me.email };
    await put({ PK: pk(ws), SK: `FORM#${form.id}`, ...form });
    return [201, { form: formOut(ws, form) }];
  });

  route('PATCH', '/workspaces/{ws}/marketing/forms/{id}', async (me, { ws, id }, body) => {
    await access(me, ws, 'editBoards');
    const row = ID_RE.test(id) ? await get(pk(ws), `FORM#${id}`) : null;
    if (!row) throw new HttpError(404, 'Form not found.');
    const next = { ...row, ...cleanForm({ ...strip(row), ...body }), updatedAt: now() };
    await put(next);
    return { form: formOut(ws, next) };
  });

  route('DELETE', '/workspaces/{ws}/marketing/forms/{id}', async (me, { ws, id }) => {
    await access(me, ws, 'editBoards');
    if (!ID_RE.test(id)) throw new HttpError(404, 'Form not found.');
    await del(pk(ws), `FORM#${id}`);
    return { ok: true };
  });

  // ---------------------------------------------------------------- sending

  // Snapshots the audience into recipient rows and starts the background sender.
  async function startSend(ws, row, { by, staff }) {
    const settings = await getSettings(ws);
    const missing = readyToSendError(row, settings);
    if (missing) throw new HttpError(400, missing);
    const people = audienceOf(await subscribers(ws), row.audience);
    if (!people.length) throw new HttpError(400, 'Nobody in this audience is subscribed.');
    const limit = limitFor(staff);
    const used = await sentToday(ws);
    if (used + people.length > limit) {
      throw new HttpError(429, `This campaign goes to ${people.length.toLocaleString('en')} people, but this workspace can send ${Math.max(0, limit - used).toLocaleString('en')} more emails today (limit ${limit.toLocaleString('en')} a day). Narrow the audience or send tomorrow.`);
    }
    // Claim the campaign so a double click or the scheduler can't start it twice.
    const at = now();
    try {
      await update({
        Key: { PK: pk(ws), SK: `CAMP#${row.id}` },
        UpdateExpression: 'SET #s = :sending, startedAt = :at, sentBy = :by, links = :links, sender = :sender, s_recipients = :n, GSI1PK = :g, GSI1SK = :gs, updatedAt = :at REMOVE scheduledAt',
        ConditionExpression: '#s IN (:draft, :scheduled)',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: {
          ':sending': 'sending', ':draft': 'draft', ':scheduled': 'scheduled', ':at': at, ':by': by,
          ':links': campaignLinks(row), ':sender': settings, ':n': people.length, ':g': 'MKT_ACTIVE', ':gs': `${at}#${ws}#${row.id}`,
        },
      });
    } catch (error) {
      if (error.name === 'ConditionalCheckFailedException') throw new HttpError(409, 'This campaign is already sending.');
      throw error;
    }
    await addSent(ws, people.length);
    await putMany(people.map((p) => ({ PK: `MKTC#${row.id}`, SK: `R#${p.email}`, email: p.email, name: p.name || '', status: 'queued' })));
    await continueSending(ws, row.id);
    return get(pk(ws), `CAMP#${row.id}`);
  }

  // Sends queued recipients for up to SEND_BUDGET_MS, then hands over to the next run.
  async function sendBatch(ws, id) {
    const key = { PK: pk(ws), SK: `CAMP#${id}` };
    const lease = Date.now() + SEND_BUDGET_MS + 15_000;
    try {
      await update({
        Key: key,
        UpdateExpression: 'SET leaseUntil = :lease',
        ConditionExpression: '#s = :sending AND (attribute_not_exists(leaseUntil) OR leaseUntil < :now)',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':lease': lease, ':sending': 'sending', ':now': Date.now() },
      });
    } catch (error) {
      if (error.name === 'ConditionalCheckFailedException') return { skipped: true };
      throw error;
    }
    const campaign = await get(key.PK, key.SK);
    const deadline = Date.now() + SEND_BUDGET_MS;
    const secret = await getAppSecret();
    const settings = campaign.sender || (await getSettings(ws));
    const from = senderFor(settings, defaultFrom);
    const links = campaign.links || [];
    const subs = new Map((await subscribers(ws)).map((s) => [s.email, s]));
    const queue = (await prefix(`MKTC#${id}`, 'R#', { FilterExpression: '#s = :q', ExpressionAttributeNames: { '#s': 'status' }, ExpressionAttributeValues: { ':pk': `MKTC#${id}`, ':sk': 'R#', ':q': 'queued' } })).map(strip);
    let stopped = false;
    let nextSlot = Date.now();
    let checked = Date.now();

    const worker = async () => {
      while (queue.length && Date.now() < deadline && !stopped) {
        // Every few seconds, notice a "Stop sending" from the app.
        if (Date.now() - checked > 3000) {
          checked = Date.now();
          if ((await get(key.PK, key.SK))?.status !== 'sending') {
            stopped = true;
            break;
          }
        }
        const r = queue.shift();
        const wait = nextSlot - Date.now();
        nextSlot = Math.max(nextSlot, Date.now()) + 1000 / SEND_RATE;
        if (wait > 0) await sleep(wait);
        const sub = subs.get(r.email);
        const rowKey = { PK: `MKTC#${id}`, SK: `R#${r.email}` };
        if (!sub || sub.status !== 'subscribed') {
          await update({ Key: rowKey, UpdateExpression: 'SET #s = :s, #e = :e', ExpressionAttributeNames: { '#s': 'status', '#e': 'error' }, ExpressionAttributeValues: { ':s': 'skipped', ':e': sub ? sub.status : 'removed' } });
          continue;
        }
        const email = renderCampaignEmail(campaign, settings, { recipient: sub, urls: recipientUrls(publicBase, secret, ws, id, r.email, links) });
        const unsubscribe = recipientUrls(publicBase, secret, ws, id, r.email, links).unsubscribe;
        try {
          const messageId = await sendRaw({
            from, to: r.email, replyTo: settings.replyTo, subject: email.subject, text: email.text, html: email.html,
            headers: [['List-Unsubscribe', `<${unsubscribe}>`], ['List-Unsubscribe-Post', 'List-Unsubscribe=One-Click']],
            tags: { ws, campaign: id, kind: 'campaign' },
          });
          await update({ Key: rowKey, UpdateExpression: 'SET #s = :s, sentAt = :at, messageId = :m', ExpressionAttributeNames: { '#s': 'status' }, ExpressionAttributeValues: { ':s': 'sent', ':at': now(), ':m': messageId || '' } });
        } catch (error) {
          if (['TooManyRequestsException', 'Throttling', 'ThrottlingException', 'LimitExceededException'].includes(error.name)) {
            queue.push(r); // try again shortly
            await sleep(1000);
            continue;
          }
          console.error('Campaign email failed', id, error.name, error.message);
          await update({ Key: rowKey, UpdateExpression: 'SET #s = :s, #e = :e', ExpressionAttributeNames: { '#s': 'status', '#e': 'error' }, ExpressionAttributeValues: { ':s': 'failed', ':e': String(error.message || error.name).slice(0, 200) } });
        }
      }
    };
    await Promise.all(Array.from({ length: WORKERS }, worker));

    // Recount from the recipient rows, so the numbers are right even after a crash part-way.
    const all = await prefix(`MKTC#${id}`, 'R#', { ProjectionExpression: '#s', ExpressionAttributeNames: { '#s': 'status' } });
    const sent = all.filter((r) => r.status === 'sent').length;
    const failed = all.filter((r) => r.status === 'failed').length;
    const remaining = all.filter((r) => r.status === 'queued').length;
    const finished = remaining === 0 && !stopped;
    const params = {
      Key: key,
      UpdateExpression: 'SET s_sent = :sent, s_failed = :failed, leaseUntil = :zero',
      ExpressionAttributeValues: { ':sent': sent, ':failed': failed, ':zero': 0 },
    };
    if (finished) {
      params.UpdateExpression += ', #s = :sentStatus, finishedAt = :at REMOVE GSI1PK, GSI1SK';
      params.ConditionExpression = '#s = :sending';
      params.ExpressionAttributeNames = { '#s': 'status' };
      Object.assign(params.ExpressionAttributeValues, { ':sentStatus': 'sent', ':at': now(), ':sending': 'sending' });
    }
    await update(params).catch((error) => {
      if (error.name !== 'ConditionalCheckFailedException') throw error;
    });
    const done = remaining === 0 || stopped;
    if (!done) await continueSending(ws, id);
    return { sent, failed, remaining };
  }

  // The one-minute tick: start campaigns whose time has come and pick up sends that stalled.
  async function tick() {
    const active = await queryAll({ IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :pk', ExpressionAttributeValues: { ':pk': 'MKT_ACTIVE' } });
    for (const row of active) {
      const ws = row.PK.slice(4);
      try {
        if (row.status === 'scheduled' && Date.parse(row.scheduledAt) <= Date.now()) {
          await startSend(ws, row, { by: row.sentBy || row.scheduledBy, staff: row.staffSender === true }).catch(async (error) => {
            // Couldn't start (over the daily limit, nobody subscribed …): put it back to draft with the reason.
            const { GSI1PK, GSI1SK, ...rest } = row;
            await put({ ...rest, status: 'draft', error: `Scheduled send didn’t start: ${error.message}`, updatedAt: now() });
          });
        } else if (row.status === 'sending' && !(row.leaseUntil > Date.now())) {
          await continueSending(ws, row.id);
        }
      } catch (error) {
        console.error('Marketing tick failed for', row.SK, error);
      }
    }
    return { active: active.length };
  }

  // ---------------------------------------------------------------- tracking

  async function recordOpen(p, at) {
    const rowKey = { PK: `MKTC#${p.campaignId}`, SK: `R#${p.email}` };
    try {
      const { Attributes } = await update({
        Key: rowKey,
        UpdateExpression: 'SET openedAt = if_not_exists(openedAt, :at) ADD opens :one',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeValues: { ':at': at, ':one': 1 },
        ReturnValues: 'UPDATED_OLD',
      });
      const first = !Attributes?.openedAt;
      await update({
        Key: { PK: pk(p.ws), SK: `CAMP#${p.campaignId}` },
        UpdateExpression: first ? 'ADD s_opens :one, s_uniqueOpens :one' : 'ADD s_opens :one',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeValues: { ':one': 1 },
      });
    } catch (error) {
      if (error.name !== 'ConditionalCheckFailedException') throw error;
    }
  }

  async function recordClick(p, at) {
    const rowKey = { PK: `MKTC#${p.campaignId}`, SK: `R#${p.email}` };
    try {
      const { Attributes } = await update({
        Key: rowKey,
        UpdateExpression: 'SET clickedAt = if_not_exists(clickedAt, :at), openedAt = if_not_exists(openedAt, :at) ADD clicks :one',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeValues: { ':at': at, ':one': 1 },
        ReturnValues: 'UPDATED_OLD',
      });
      const parts = ['s_clicks :one', `s_link${p.linkIndex} :one`];
      if (!Attributes?.clickedAt) parts.push('s_uniqueClicks :one');
      if (!Attributes?.openedAt) parts.push('s_uniqueOpens :one', 's_opens :one'); // images were blocked, but they clearly opened it
      await update({ Key: { PK: pk(p.ws), SK: `CAMP#${p.campaignId}` }, UpdateExpression: `ADD ${parts.join(', ')}`, ConditionExpression: 'attribute_exists(PK)', ExpressionAttributeValues: { ':one': 1 } });
    } catch (error) {
      if (error.name !== 'ConditionalCheckFailedException') throw error;
    }
  }

  async function suppress(ws, email, status, campaignId, at) {
    const row = await get(pk(ws), `SUB#${email}`);
    if (row && row.status !== status && !(status === 'unsubscribed' && row.status !== 'subscribed')) {
      await put({ ...row, status, [`${status}At`]: at, updatedAt: at });
    }
    if (!campaignId) return Boolean(row);
    const stat = { unsubscribed: 'unsubscribes', bounced: 'bounces', complained: 'complaints' }[status];
    const field = { unsubscribed: 'unsubscribedAt', bounced: 'bouncedAt', complained: 'complainedAt' }[status];
    try {
      const { Attributes } = await update({
        Key: { PK: `MKTC#${campaignId}`, SK: `R#${email}` },
        UpdateExpression: `SET ${field} = if_not_exists(${field}, :at)`,
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeValues: { ':at': at },
        ReturnValues: 'UPDATED_OLD',
      });
      if (!Attributes?.[field]) {
        await update({ Key: { PK: pk(ws), SK: `CAMP#${campaignId}` }, UpdateExpression: `ADD s_${stat} :one`, ConditionExpression: 'attribute_exists(PK)', ExpressionAttributeValues: { ':one': 1 } });
      }
    } catch (error) {
      if (error.name !== 'ConditionalCheckFailedException') throw error;
    }
    return Boolean(row);
  }

  // ---------------------------------------------------------------- public pages

  const html = (statusCode, body, headers = {}) => ({ statusCode, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers }, body });

  function page({ title, bodyHtml, color = '#5034ff', brand = '' }) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<meta name="robots" content="noindex">
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f4fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#15172a;padding:24px 16px}
main{width:100%;max-width:440px;background:#fff;border:1px solid #e4e5ef;border-top:4px solid ${color};border-radius:16px;padding:28px}
h1{font-size:22px;line-height:1.3;margin:0 0 10px}p{line-height:1.6;margin:0 0 16px;color:#3b3f57}.brand{font-weight:700;font-size:14px;color:#5d6178;margin:0 0 14px}
label{display:block;font-size:14px;font-weight:600;margin:0 0 14px}input{display:block;width:100%;margin-top:6px;font:inherit;font-weight:400;padding:11px 12px;border:1px solid #cfd1e0;border-radius:10px}
input:focus{outline:2px solid ${color};outline-offset:1px;border-color:transparent}
button{width:100%;font:inherit;font-weight:600;color:#fff;background:${color};border:0;border-radius:10px;padding:12px 16px;cursor:pointer}
.small{font-size:12px;color:#5d6178;margin:14px 0 0}.hp{position:absolute;left:-5000px}footer{margin-top:18px;font-size:12px;color:#8a8ea6;text-align:center}footer a{color:inherit}
</style></head><body><div><main>${brand ? `<p class="brand">${escapeHtml(brand)}</p>` : ''}${bodyHtml}</main><footer>Powered by <a href="${siteUrl}">Lyrsoft</a></footer></div></body></html>`;
  }

  async function publicOpen(params) {
    const p = readLinkParams(params, await getAppSecret());
    if (p?.campaignId) await recordOpen(p, now()).catch((error) => console.error('open', error));
    return { statusCode: 200, headers: { 'content-type': 'image/gif', 'cache-control': 'no-store, max-age=0' }, body: PIXEL.toString('base64'), isBase64Encoded: true };
  }

  async function publicClick(params) {
    const p = readLinkParams(params, await getAppSecret());
    if (!p?.campaignId) return html(400, page({ title: 'Link not valid', bodyHtml: '<h1>This link didn’t work</h1><p>It may have been cut short when it was copied.</p>' }));
    const campaign = await get(pk(p.ws), `CAMP#${p.campaignId}`);
    const target = clickTarget(campaign?.links, p.linkIndex);
    if (!target) return { statusCode: 302, headers: { location: siteUrl } };
    await recordClick(p, now()).catch((error) => console.error('click', error));
    return { statusCode: 302, headers: { location: target, 'cache-control': 'no-store' } };
  }

  // GET shows a button, so link scanners don't unsubscribe anyone; POST (the button, or a mail
  // app's one-click unsubscribe) does it.
  async function publicUnsubscribe(params, method) {
    const p = readLinkParams(params, await getAppSecret());
    const settings = p ? await getSettings(p.ws) : {};
    const brand = settings.fromName || '';
    const color = settings.color || '#5034ff';
    if (!p) return html(400, page({ title: 'Link not valid', bodyHtml: '<h1>This link didn’t work</h1><p>The unsubscribe link is incomplete. Reply to the email and ask to be removed instead.</p>' }));
    if (method === 'GET') {
      return html(200, page({
        brand, color, title: 'Unsubscribe',
        bodyHtml: `<h1>Unsubscribe?</h1><p><b>${escapeHtml(p.email)}</b> will stop getting emails from ${escapeHtml(brand || 'this sender')}.</p>
<form method="post"><button type="submit">Unsubscribe</button></form>`,
      }));
    }
    await suppress(p.ws, p.email, 'unsubscribed', p.campaignId, now());
    return html(200, page({ brand, color, title: 'Unsubscribed', bodyHtml: `<h1>You’re unsubscribed</h1><p>${escapeHtml(p.email)} won’t get any more emails from ${escapeHtml(brand || 'this sender')}.</p>` }));
  }

  function formPage(ws, form, settings, { message = '', error = '', values = {} } = {}) {
    const action = `${publicBase}/public/subscribe?w=${encodeURIComponent(ws)}&f=${encodeURIComponent(form.id)}`;
    return page({
      brand: settings.fromName || '',
      color: settings.color || '#5034ff',
      title: form.title,
      bodyHtml: message
        ? `<h1>${escapeHtml(form.title)}</h1><p role="status">${escapeHtml(message)}</p>`
        : `<h1>${escapeHtml(form.title)}</h1>${form.description ? `<p>${escapeHtml(form.description).replace(/\n/g, '<br>')}</p>` : ''}
${error ? `<p role="alert" style="color:#c62828">${escapeHtml(error)}</p>` : ''}
<form method="post" action="${escapeHtml(action)}">
${form.askName ? `<label>Name<input name="name" autocomplete="name" maxlength="120" value="${escapeHtml(values.name || '')}"></label>` : ''}
<label>Email<input name="email" type="email" required autocomplete="email" maxlength="254" value="${escapeHtml(values.email || '')}"></label>
<label class="hp" aria-hidden="true">Website<input name="website" tabindex="-1" autocomplete="off"></label>
<button type="submit">${escapeHtml(form.buttonLabel)}</button>
${form.consent ? `<p class="small">${escapeHtml(form.consent)}</p>` : ''}
</form>`,
    });
  }

  async function publicSubscribe(event, params, method, body, ip) {
    const ws = params.get('w') || body.w || '';
    const formId = params.get('f') || body.f || '';
    const form = ID_RE.test(ws) && ID_RE.test(formId) ? await get(pk(ws), `FORM#${formId}`) : null;
    const wantsJson = /json/.test(event.headers?.['content-type'] || '') || /json/.test(event.headers?.accept || '');
    const reply = (statusCode, message, extra = {}) => (wantsJson ? { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: statusCode < 300, message }) } : html(statusCode, extra.page));
    if (!form) return reply(400, 'This signup form no longer exists.', { page: page({ title: 'Form not found', bodyHtml: '<h1>This signup form no longer exists</h1>' }) });
    const settings = await getSettings(ws);
    if (method === 'GET') return html(200, formPage(ws, form, settings));

    let signup;
    try {
      signup = cleanSignup(body);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      return reply(400, error.message, { page: formPage(ws, form, settings, { error: error.message, values: body }) });
    }
    const thanks = form.successMessage;
    const done = () => (form.redirectUrl && !wantsJson ? { statusCode: 303, headers: { location: form.redirectUrl } } : reply(200, thanks, { page: formPage(ws, form, settings, { message: thanks }) }));
    if (!signup) return done(); // bot
    if ((await countUp(`mkt-sub#${ip}`, 'hour')) > SUBSCRIBES_PER_IP_PER_HOUR || (await countUp(`mkt-form#${formId}`, 'day')) > SUBSCRIBES_PER_FORM_PER_DAY) {
      return reply(429, 'Too many signups from your network. Please try again later.', { page: formPage(ws, form, settings, { error: 'Too many signups right now. Please try again later.', values: body }) });
    }
    const at = now();
    const existing = await get(pk(ws), `SUB#${signup.email}`);
    // Signing up again is an explicit opt-in, so it resubscribes people who left.
    const subscriber = existing
      ? { ...strip(existing), name: existing.name || signup.name, tags: cleanTags([...(existing.tags || []), ...form.tags]), status: 'subscribed', resubscribedAt: existing.status === 'subscribed' ? existing.resubscribedAt : at, updatedAt: at }
      : { email: signup.email, name: signup.name, tags: form.tags, status: 'subscribed', source: 'form', formId, consentAt: at, consentIp: ip, createdAt: at, updatedAt: at };
    if (!existing && (await prefix(pk(ws), 'SUB#', { ProjectionExpression: 'SK' })).length >= SUBSCRIBERS_MAX) return done();
    await put(subRow(ws, subscriber));
    await update({ Key: { PK: pk(ws), SK: `FORM#${formId}` }, UpdateExpression: 'ADD submissions :one', ExpressionAttributeValues: { ':one': 1 } });
    return done();
  }

  // ---------------------------------------------------------------- SES events (SNS)

  async function sesEvent(message) {
    const type = message.eventType || message.notificationType;
    const tags = message.mail?.tags || {};
    const ws = tags.ws?.[0];
    const campaignId = tags.campaign?.[0] || '';
    if (!ws || !ID_RE.test(ws)) return;
    const at = now();
    if (type === 'Bounce' && message.bounce?.bounceType === 'Permanent') {
      for (const r of message.bounce.bouncedRecipients || []) await suppress(ws, cleanEmail(r.emailAddress), 'bounced', campaignId, at);
    } else if (type === 'Complaint') {
      for (const r of message.complaint?.complainedRecipients || []) await suppress(ws, cleanEmail(r.emailAddress), 'complained', campaignId, at);
    }
  }

  // Everything that doesn't come through API Gateway: self-invocations, the tick and SES events.
  async function handleTask(event) {
    if (event.lyrsoftTask === 'marketing-send') return sendBatch(event.ws, event.campaignId);
    if (event.lyrsoftTask === 'marketing-tick') return tick();
    if (Array.isArray(event.Records)) {
      for (const record of event.Records) {
        if (record.EventSource !== 'aws:sns') continue;
        try {
          await sesEvent(JSON.parse(record.Sns.Message));
        } catch (error) {
          console.error('SES event failed', error);
        }
      }
      return { ok: true };
    }
    return { ignored: true };
  }

  const isTask = (event) => Boolean(event?.lyrsoftTask) || (Array.isArray(event?.Records) && event.Records[0]?.EventSource === 'aws:sns');

  return { publicOpen, publicClick, publicUnsubscribe, publicSubscribe, handleTask, isTask, sendBatch, tick };
}
