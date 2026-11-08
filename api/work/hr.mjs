// Lyrsoft HR routes (#/w/<ws>/hr in the app), mounted on the work API (index.mjs) like marketing.
// Each workspace runs its own HR: employees, attendance, leave, payroll and biometric devices.
//
// Who can do what: HR managers (workspace owners and admins, plus anyone listed in HR settings) see
// and change everything. Everyone else only sees themselves: an employee whose email is their
// Lyrsoft sign-in can check in and out, see their attendance, ask for leave and read their payslips.
//
//   GET    /workspaces/{ws}/hr                              overview (managers: the whole team today)
//   PATCH  /workspaces/{ws}/hr/settings                     work rules, holidays, leave allowances
//   GET    /workspaces/{ws}/hr/employees                    { employees }
//   POST   /workspaces/{ws}/hr/employees                    add one
//   PATCH  /workspaces/{ws}/hr/employees/{id}               edit (fields left out are kept)
//   DELETE /workspaces/{ws}/hr/employees/{id}               with their attendance and leave
//   GET    /workspaces/{ws}/hr/attendance?date=             everyone's day
//   GET    /workspaces/{ws}/hr/attendance/month?month=&emp= one person's month (managers, or yourself)
//   GET    /workspaces/{ws}/hr/attendance/report?month=     everyone's month totals
//   PATCH  /workspaces/{ws}/hr/attendance/{date}/{emp}      a manager's correction { in, out, status, note } or { clear }
//   POST   /workspaces/{ws}/hr/me/punch                     check in / out from the web { geo? }
//   GET    /workspaces/{ws}/hr/leave?year=                  managers: everyone's; others: their own
//   POST   /workspaces/{ws}/hr/leave                        ask for leave (managers can add it approved, for anyone)
//   POST   /workspaces/{ws}/hr/leave/{id}/decide            { status: approved | rejected }
//   POST   /workspaces/{ws}/hr/leave/{id}/cancel
//   GET    /workspaces/{ws}/hr/payroll                      payroll runs
//   GET    /workspaces/{ws}/hr/payroll/{month}              one run with every payslip
//   POST   /workspaces/{ws}/hr/payroll/{month}              create or recalculate the draft
//   PATCH  /workspaces/{ws}/hr/payroll/{month}/lines/{emp}  { bonus, advance, deduction, note }
//   POST   /workspaces/{ws}/hr/payroll/{month}/status       { status: final | paid | draft }
//   DELETE /workspaces/{ws}/hr/payroll/{month}              a draft
//   GET    /workspaces/{ws}/hr/me/payslips                  your final payslips
//   GET|POST /workspaces/{ws}/hr/devices, DELETE …/devices/{id}, POST …/devices/{id}/key
//
// Public, for biometric devices and their bridges (no sign-in; the device key is the password):
//   POST /public/hr/punch   { key, punches: [{ user, at }] }  user = the person's ID on the device
//                           (or their employee code); at = ISO time, device-local "YYYY-MM-DD HH:MM:SS"
//                           or epoch seconds. Sent without punches, it just checks the key.
//
// Keys in the work table:
//   HR#<ws>  SETTINGS                 work rules
//   HR#<ws>  EMP#<id>                 an employee
//   HR#<ws>  ATT#<date>#<emp>         a work day: punches, a manager's override
//   HR#<ws>  LEAVE#<id>               a leave request
//   HR#<ws>  PAY#<yyyy-mm>            a payroll run with its payslips
//   HR#<ws>  DEV#<id>                 a biometric device
//   HRKEY#<sha256 of key>  META       which workspace and device a device key belongs to
import { createHash, randomBytes } from 'node:crypto';
import {
  addDays,
  addPunch,
  cleanEmployee,
  cleanLeave,
  cleanSettings,
  computePay,
  DAY_STATUSES,
  dayStatus,
  DEFAULT_SETTINGS,
  DEVICE_BATCH_MAX,
  employedOn,
  grossOf,
  EMPLOYEES_MAX,
  isDate,
  isMonth,
  leaveBalance,
  leaveCovering,
  leaveDays,
  localParts,
  monthDates,
  payrollTotals,
  readDevicePunch,
  round2,
  summarize,
  toMinutes,
  workDateFor,
} from './hr-model.mjs';
import { ID_RE, ValidationError } from './model.mjs';

const DEVICE_PUNCHES_PER_HOUR = 20000;

export function registerHrRoutes(route, { db, HttpError, openWorkspace, now, newId, countUse }) {
  const { get, put, del, queryAll, putMany, deleteKeys } = db;
  const pk = (ws) => `HR#${ws}`;
  const prefix = (ws, sk) => queryAll({ KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)', ExpressionAttributeValues: { ':pk': pk(ws), ':sk': sk } });
  const strip = ({ PK, SK, ...rest }) => rest;
  const hashKey = (key) => createHash('sha256').update(String(key)).digest('hex');

  const getSettings = async (ws) => ({ ...DEFAULT_SETTINGS, ...strip((await get(pk(ws), 'SETTINGS')) || { PK: '', SK: '' }) });
  const employees = async (ws) => (await prefix(ws, 'EMP#')).map(strip).sort((a, b) => (a.code || '').localeCompare(b.code || '', undefined, { numeric: true }) || a.name.localeCompare(b.name));
  const leaves = async (ws) => (await prefix(ws, 'LEAVE#')).map(strip);
  const attendance = async (ws, datePrefix) => (await prefix(ws, `ATT#${datePrefix}`)).map(strip);
  const attKey = (ws, date, empId) => ({ PK: pk(ws), SK: `ATT#${date}#${empId}` });
  const today = (settings) => localParts(now(), settings.timezone).date;

  async function access(me, ws) {
    const { workspace, role } = await openWorkspace(me, ws, 'view');
    const settings = await getSettings(ws);
    const list = await employees(ws);
    const self = list.find((e) => e.email && e.email === me.email) || null;
    // Attendance counts from the day HR started (the first employee added) unless settings say otherwise.
    if (!settings.trackingFrom && list.length) settings.trackingFrom = localParts(list.reduce((min, e) => (e.createdAt < min ? e.createdAt : min), list[0].createdAt), settings.timezone).date;
    const manager = ['owner', 'admin'].includes(role) || settings.managers.includes(me.email);
    return { workspace, role, settings, employees: list, self, manager, admin: ['owner', 'admin'].includes(role) };
  }
  const requireManager = (a) => {
    if (!a.manager) throw new HttpError(403, 'Only HR managers can do that. Ask a workspace owner or admin.');
  };
  const findEmployee = (a, id) => {
    const e = ID_RE.test(String(id)) ? a.employees.find((x) => x.id === id) : null;
    if (!e) throw new HttpError(404, 'Employee not found.');
    return e;
  };
  // Managers see everything; employees see only themselves.
  const canSee = (a, empId) => a.manager || a.self?.id === empId;

  const employeeOut = (e, full) => (full ? e : { id: e.id, name: e.name, code: e.code, department: e.department, designation: e.designation, email: e.email });

  // ---------------------------------------------------------------- overview

  route('GET', '/workspaces/{ws}/hr', async (me, { ws }) => {
    const a = await access(me, ws);
    const day = today(a.settings);
    const allLeaves = await leaves(ws);
    const out = {
      workspace: { id: ws, name: a.workspace.name },
      manager: a.manager,
      admin: a.admin,
      settings: a.settings,
      today: day,
      self: a.self,
      myDay: null,
      myBalance: null,
    };
    if (a.self) {
      const record = await get(attKey(ws, day, a.self.id).PK, attKey(ws, day, a.self.id).SK);
      out.myDay = dayStatus({ date: day, employee: a.self, settings: a.settings, record, leave: leaveCovering(allLeaves, a.self.id, day), today: day });
      out.myBalance = leaveBalance(allLeaves, a.self, a.settings, day.slice(0, 4));
      out.myPendingLeave = allLeaves.filter((l) => l.empId === a.self.id && l.status === 'pending').length;
    }
    if (a.manager) {
      const rows = new Map((await attendance(ws, day)).map((r) => [r.empId, r]));
      const active = a.employees.filter((e) => e.status === 'active' && employedOn(e, day));
      const days = active.map((e) => dayStatus({ date: day, employee: e, settings: a.settings, record: rows.get(e.id), leave: leaveCovering(allLeaves, e.id, day), today: day }));
      const count = (s) => days.filter((d) => d.status === s).length;
      const runs = (await prefix(ws, 'PAY#')).map(strip).sort((x, y) => y.month.localeCompare(x.month));
      out.stats = {
        employees: active.length,
        inactive: a.employees.length - active.length,
        present: count('present') + count('half'),
        late: count('late'),
        leave: count('leave') + count('unpaid'),
        notIn: count('pending'),
        absent: count('absent'),
        off: count('off') + count('holiday'),
        checkedOut: days.filter((d) => d.out).length,
        pendingLeave: allLeaves.filter((l) => l.status === 'pending').length,
        departments: [...new Set(active.map((e) => e.department).filter(Boolean))].length,
        monthlyGross: round2(active.reduce((s, e) => s + grossOf(e.salary), 0)),
      };
      out.lastPayroll = runs[0] ? payrollSummary(runs[0]) : null;
      out.upcomingHolidays = a.settings.holidays.filter((h) => h.date >= day).slice(0, 5);
      out.recentLeave = allLeaves.filter((l) => l.status === 'pending').sort((x, y) => x.from.localeCompare(y.from)).slice(0, 8).map((l) => leaveOut(l, a));
      out.birthdays = active.filter((e) => e.birthday && e.birthday.slice(5, 7) === day.slice(5, 7)).map((e) => ({ id: e.id, name: e.name, date: e.birthday.slice(5) })).sort((x, y) => x.date.localeCompare(y.date));
    }
    return out;
  });

  route('PATCH', '/workspaces/{ws}/hr/settings', async (me, { ws }, body) => {
    const a = await access(me, ws);
    requireManager(a);
    if ('managers' in body && !a.admin) throw new HttpError(403, 'Only workspace owners and admins choose the HR managers.');
    const settings = cleanSettings(body, a.settings);
    await put({ PK: pk(ws), SK: 'SETTINGS', ...settings, updatedAt: now(), updatedBy: me.email });
    return { settings };
  });

  // ---------------------------------------------------------------- employees

  route('GET', '/workspaces/{ws}/hr/employees', async (me, { ws }) => {
    const a = await access(me, ws);
    if (!a.manager) return { employees: a.self ? [a.self] : [] };
    return { employees: a.employees };
  });

  function checkUnique(a, e, id) {
    const others = a.employees.filter((x) => x.id !== id);
    if (e.code && others.some((x) => x.code && x.code.toLowerCase() === e.code.toLowerCase())) throw new HttpError(409, `Employee ID ${e.code} is already taken.`);
    if (e.email && others.some((x) => x.email === e.email)) throw new HttpError(409, `${e.email} is already an employee here.`);
    if (e.deviceUserId && others.some((x) => x.deviceUserId === e.deviceUserId)) throw new HttpError(409, `Device ID ${e.deviceUserId} already belongs to someone else.`);
  }
  function nextCode(list) {
    const n = list.reduce((max, e) => Math.max(max, Number(/^E?(\d+)$/i.exec(e.code || '')?.[1] || 0)), 0) + 1;
    return `E${String(n).padStart(3, '0')}`;
  }

  route('POST', '/workspaces/{ws}/hr/employees', async (me, { ws }, body) => {
    const a = await access(me, ws);
    requireManager(a);
    if (a.employees.length >= EMPLOYEES_MAX) throw new HttpError(409, `You can have up to ${EMPLOYEES_MAX} employees.`);
    const clean = cleanEmployee(body);
    if (!clean.code) clean.code = nextCode(a.employees);
    if (!clean.joinDate) clean.joinDate = today(a.settings);
    checkUnique(a, clean);
    const at = now();
    const employee = { id: newId(), ...clean, createdAt: at, updatedAt: at, createdBy: me.email };
    await put({ PK: pk(ws), SK: `EMP#${employee.id}`, ...employee });
    return [201, { employee }];
  });

  route('PATCH', '/workspaces/{ws}/hr/employees/{id}', async (me, { ws, id }, body) => {
    const a = await access(me, ws);
    requireManager(a);
    const existing = findEmployee(a, id);
    const clean = cleanEmployee(body, existing);
    checkUnique(a, clean, id);
    const employee = { ...clean, id, updatedAt: now() };
    await put({ PK: pk(ws), SK: `EMP#${id}`, ...employee });
    return { employee };
  });

  route('DELETE', '/workspaces/{ws}/hr/employees/{id}', async (me, { ws, id }) => {
    const a = await access(me, ws);
    requireManager(a);
    findEmployee(a, id);
    const rows = [...(await prefix(ws, 'ATT#')).filter((r) => r.empId === id), ...(await prefix(ws, 'LEAVE#')).filter((r) => r.empId === id)];
    await deleteKeys([...rows.map(({ PK, SK }) => ({ PK, SK })), { PK: pk(ws), SK: `EMP#${id}` }]);
    return { ok: true };
  });

  // ---------------------------------------------------------------- attendance

  async function monthFor(ws, a, employee, month, allLeaves) {
    const rows = new Map((await attendance(ws, month)).filter((r) => r.empId === employee.id).map((r) => [r.date, r]));
    const day = today(a.settings);
    const days = monthDates(month).map((date) => dayStatus({ date, employee, settings: a.settings, record: rows.get(date), leave: leaveCovering(allLeaves, employee.id, date), today: day }));
    return { days, summary: summarize(days) };
  }

  route('GET', '/workspaces/{ws}/hr/attendance', async (me, { ws }, _b, query) => {
    const a = await access(me, ws);
    requireManager(a);
    const day = today(a.settings);
    const date = isDate(query.get('date')) ? query.get('date') : day;
    const rows = new Map((await attendance(ws, date)).map((r) => [r.empId, r]));
    const allLeaves = await leaves(ws);
    const list = a.employees.filter((e) => employedOn(e, date) && (e.status === 'active' || rows.has(e.id)));
    return {
      date,
      today: day,
      rows: list.map((e) => ({ employee: employeeOut(e), day: dayStatus({ date, employee: e, settings: a.settings, record: rows.get(e.id), leave: leaveCovering(allLeaves, e.id, date), today: day }) })),
    };
  });

  route('GET', '/workspaces/{ws}/hr/attendance/month', async (me, { ws }, _b, query) => {
    const a = await access(me, ws);
    const month = isMonth(query.get('month')) ? query.get('month') : today(a.settings).slice(0, 7);
    const empId = query.get('emp') || a.self?.id;
    if (!empId || !canSee(a, empId)) throw new HttpError(a.self ? 403 : 404, a.self ? 'You can only see your own attendance.' : 'You aren’t on this workspace’s employee list yet.');
    const employee = findEmployee(a, empId);
    const allLeaves = await leaves(ws);
    return { month, employee: employeeOut(employee, a.manager), ...(await monthFor(ws, a, employee, month, allLeaves)) };
  });

  route('GET', '/workspaces/{ws}/hr/attendance/report', async (me, { ws }, _b, query) => {
    const a = await access(me, ws);
    requireManager(a);
    const month = isMonth(query.get('month')) ? query.get('month') : today(a.settings).slice(0, 7);
    const allRows = await attendance(ws, month);
    const allLeaves = await leaves(ws);
    const day = today(a.settings);
    const first = `${month}-01`;
    const last = monthDates(month).at(-1);
    const people = a.employees.filter((e) => (!e.joinDate || e.joinDate <= last) && (!e.leaveDate || e.leaveDate >= first) && (e.status === 'active' || allRows.some((r) => r.empId === e.id)));
    return {
      month,
      rows: people.map((e) => {
        const rows = new Map(allRows.filter((r) => r.empId === e.id).map((r) => [r.date, r]));
        const days = monthDates(month).map((date) => dayStatus({ date, employee: e, settings: a.settings, record: rows.get(date), leave: leaveCovering(allLeaves, e.id, date), today: day }));
        return { employee: employeeOut(e), summary: summarize(days), marks: days.map((d) => d.status) };
      }),
    };
  });

  route('PATCH', '/workspaces/{ws}/hr/attendance/{date}/{emp}', async (me, { ws, date, emp }, body) => {
    const a = await access(me, ws);
    requireManager(a);
    if (!isDate(date)) throw new HttpError(400, 'Pick a date.');
    const employee = findEmployee(a, emp);
    const key = attKey(ws, date, emp);
    const existing = (await get(key.PK, key.SK)) || { ...key, date, empId: emp, punches: [] };
    if (body.clear) {
      delete existing.override;
    } else {
      const override = {};
      for (const k of ['in', 'out']) {
        const v = String(body[k] || '').trim();
        if (v && toMinutes(v) === null) throw new ValidationError('Times look like 09:00.');
        if (v) override[k] = v;
      }
      if (body.status) {
        if (!DAY_STATUSES.includes(body.status)) throw new ValidationError('Pick a status.');
        override.status = body.status;
      }
      override.note = String(body.note || '').slice(0, 300);
      override.by = me.email;
      override.at = now();
      existing.override = override;
    }
    if (!existing.punches.length && !existing.override) await del(key.PK, key.SK);
    else await put(existing);
    const allLeaves = await leaves(ws);
    return { day: dayStatus({ date, employee, settings: a.settings, record: existing, leave: leaveCovering(allLeaves, emp, date), today: today(a.settings) }) };
  });

  // Records one punch for an employee and returns their day.
  async function punch(ws, settings, employee, entry) {
    const local = localParts(entry.at, settings.timezone).date;
    const prevKey = attKey(ws, addDays(local, -1), employee.id);
    const previous = await get(prevKey.PK, prevKey.SK);
    const date = workDateFor(entry.at, settings.timezone, previous);
    const key = attKey(ws, date, employee.id);
    const record = date === previous?.date ? previous : (await get(key.PK, key.SK)) || { ...key, date, empId: employee.id, punches: [] };
    const punches = addPunch(record.punches, entry);
    if (!punches) return { record, duplicate: true };
    const next = { ...record, punches, updatedAt: now() };
    await put(next);
    return { record: next, duplicate: false };
  }

  route('POST', '/workspaces/{ws}/hr/me/punch', async (me, { ws }, body) => {
    const a = await access(me, ws);
    if (!a.self) throw new HttpError(404, 'You aren’t on this workspace’s employee list yet. Ask HR to add you with your sign-in email.');
    if (a.self.status !== 'active') throw new HttpError(403, 'Your employee record isn’t active.');
    if (!a.settings.webCheckIn) throw new HttpError(403, 'Checking in from the web is turned off here. Use the attendance device.');
    const geo = body.geo && Number.isFinite(Number(body.geo.lat)) && Number.isFinite(Number(body.geo.lng))
      ? { lat: Math.round(Number(body.geo.lat) * 1e5) / 1e5, lng: Math.round(Number(body.geo.lng) * 1e5) / 1e5, accuracy: Math.round(Number(body.geo.accuracy) || 0) }
      : null;
    if (a.settings.requireLocation && !geo) throw new HttpError(400, 'Allow location so your check-in can be recorded.');
    const { record, duplicate } = await punch(ws, a.settings, a.self, { at: now(), source: 'web', ...(geo ? { geo } : {}) });
    if (duplicate) throw new HttpError(409, 'You just punched. Wait a minute before punching again.');
    const allLeaves = await leaves(ws);
    return { day: dayStatus({ date: record.date, employee: a.self, settings: a.settings, record, leave: leaveCovering(allLeaves, a.self.id, record.date), today: today(a.settings) }) };
  });

  // ---------------------------------------------------------------- leave

  const leaveOut = (l, a) => ({ ...l, employee: employeeOut(a.employees.find((e) => e.id === l.empId) || { id: l.empId, name: 'Former employee' }) });

  route('GET', '/workspaces/{ws}/hr/leave', async (me, { ws }, _b, query) => {
    const a = await access(me, ws);
    const year = /^\d{4}$/.test(query.get('year') || '') ? query.get('year') : today(a.settings).slice(0, 4);
    const all = await leaves(ws);
    const mine = a.manager ? all : all.filter((l) => l.empId === a.self?.id);
    const list = mine.filter((l) => l.from.startsWith(year) || l.to.startsWith(year) || l.status === 'pending').sort((x, y) => y.from.localeCompare(x.from));
    const balances = {};
    for (const e of a.manager ? a.employees : a.self ? [a.self] : []) balances[e.id] = leaveBalance(all, e, a.settings, year);
    return { year, leaves: list.map((l) => leaveOut(l, a)), balances };
  });

  route('POST', '/workspaces/{ws}/hr/leave', async (me, { ws }, body) => {
    const a = await access(me, ws);
    const empId = a.manager && body.empId ? body.empId : a.self?.id;
    if (!empId) throw new HttpError(404, 'You aren’t on this workspace’s employee list yet.');
    const employee = findEmployee(a, empId);
    const clean = cleanLeave(body);
    const days = leaveDays(clean, employee, a.settings);
    if (!days) throw new ValidationError('Those days are all days off or holidays.');
    const all = await leaves(ws);
    const clash = all.find((l) => l.empId === empId && ['pending', 'approved'].includes(l.status) && l.from <= clean.to && l.to >= clean.from);
    if (clash) throw new HttpError(409, `There’s already a ${clash.status} leave from ${clash.from} to ${clash.to}.`);
    const approve = a.manager && body.approve !== false && empId !== a.self?.id ? true : a.manager && body.approve === true;
    const at = now();
    const leave = { id: newId(), empId, ...clean, days, status: approve ? 'approved' : 'pending', requestedBy: me.email, createdAt: at, ...(approve ? { decidedBy: me.email, decidedAt: at } : {}) };
    await put({ PK: pk(ws), SK: `LEAVE#${leave.id}`, ...leave });
    return [201, { leave: leaveOut(leave, a) }];
  });

  async function openLeave(ws, id) {
    const row = ID_RE.test(id) ? await get(pk(ws), `LEAVE#${id}`) : null;
    if (!row) throw new HttpError(404, 'Leave not found.');
    return row;
  }

  route('POST', '/workspaces/{ws}/hr/leave/{id}/decide', async (me, { ws, id }, body) => {
    const a = await access(me, ws);
    requireManager(a);
    const row = await openLeave(ws, id);
    if (!['approved', 'rejected'].includes(body.status)) throw new ValidationError('Approve or reject.');
    const next = { ...row, status: body.status, decidedBy: me.email, decidedAt: now(), comment: String(body.comment || '').slice(0, 300) };
    await put(next);
    return { leave: leaveOut(strip(next), a) };
  });

  route('POST', '/workspaces/{ws}/hr/leave/{id}/cancel', async (me, { ws, id }) => {
    const a = await access(me, ws);
    const row = await openLeave(ws, id);
    const own = row.empId === a.self?.id;
    if (!a.manager && !(own && row.status === 'pending')) throw new HttpError(403, 'You can cancel your own leave while it’s waiting for approval.');
    const next = { ...row, status: 'cancelled', decidedBy: me.email, decidedAt: now() };
    await put(next);
    return { leave: leaveOut(strip(next), a) };
  });

  // ---------------------------------------------------------------- payroll

  const payrollSummary = (run) => ({ month: run.month, status: run.status, totals: run.totals, currency: run.currency, createdAt: run.createdAt, updatedAt: run.updatedAt, finalizedAt: run.finalizedAt || null, paidAt: run.paidAt || null });

  async function openRun(ws, month) {
    if (!isMonth(month)) throw new HttpError(400, 'Pick a month.');
    return get(pk(ws), `PAY#${month}`);
  }

  async function calculate(ws, a, month, adjust) {
    const first = `${month}-01`;
    const last = monthDates(month).at(-1);
    const allRows = await attendance(ws, month);
    const allLeaves = await leaves(ws);
    const day = today(a.settings);
    const people = a.employees.filter((e) => (!e.joinDate || e.joinDate <= last) && (!e.leaveDate || e.leaveDate >= first) && (e.status === 'active' || e.leaveDate));
    return people.map((e) => {
      const rows = new Map(allRows.filter((r) => r.empId === e.id).map((r) => [r.date, r]));
      // Days still to come in the month count as worked: payroll for the current month can be prepared early.
      const days = monthDates(month).map((date) => {
        const d = dayStatus({ date, employee: e, settings: a.settings, record: rows.get(date), leave: leaveCovering(allLeaves, e.id, date), today: day });
        return ['pending', 'upcoming', 'untracked'].includes(d.status) ? { ...d, status: 'present' } : d;
      });
      return computePay({ employee: e, settings: a.settings, month, summary: summarize(days), adjust: adjust[e.id] || {} });
    });
  }

  async function saveRun(ws, a, month, existing, adjust, me) {
    const lines = await calculate(ws, a, month, adjust);
    const at = now();
    const run = {
      PK: pk(ws),
      SK: `PAY#${month}`,
      month,
      status: 'draft',
      currency: a.settings.currency,
      company: a.settings.company || a.workspace.name,
      adjust,
      lines,
      totals: payrollTotals(lines),
      createdAt: existing?.createdAt || at,
      createdBy: existing?.createdBy || me.email,
      updatedAt: at,
      updatedBy: me.email,
    };
    await put(run);
    return strip(run);
  }

  route('GET', '/workspaces/{ws}/hr/payroll', async (me, { ws }) => {
    const a = await access(me, ws);
    requireManager(a);
    return { runs: (await prefix(ws, 'PAY#')).map(strip).sort((x, y) => y.month.localeCompare(x.month)).map(payrollSummary) };
  });

  route('GET', '/workspaces/{ws}/hr/payroll/{month}', async (me, { ws, month }) => {
    const a = await access(me, ws);
    requireManager(a);
    const run = await openRun(ws, month);
    if (!run) throw new HttpError(404, 'No payroll for that month yet.');
    return { run: strip(run) };
  });

  route('POST', '/workspaces/{ws}/hr/payroll/{month}', async (me, { ws, month }) => {
    const a = await access(me, ws);
    requireManager(a);
    const existing = await openRun(ws, month);
    if (existing && existing.status !== 'draft') throw new HttpError(409, 'This payroll is final. Reopen it to recalculate.');
    if (!a.employees.length) throw new HttpError(400, 'Add employees first.');
    return [existing ? 200 : 201, { run: await saveRun(ws, a, month, existing, existing?.adjust || {}, me) }];
  });

  route('PATCH', '/workspaces/{ws}/hr/payroll/{month}/lines/{emp}', async (me, { ws, month, emp }, body) => {
    const a = await access(me, ws);
    requireManager(a);
    const existing = await openRun(ws, month);
    if (!existing) throw new HttpError(404, 'No payroll for that month yet.');
    if (existing.status !== 'draft') throw new HttpError(409, 'This payroll is final. Reopen it to change payslips.');
    if (!existing.lines.some((l) => l.empId === emp)) throw new HttpError(404, 'That employee isn’t in this payroll.');
    const adjust = { ...existing.adjust, [emp]: { bonus: body.bonus, advance: body.advance, deduction: body.deduction, note: String(body.note || '').slice(0, 300) } };
    return { run: await saveRun(ws, a, month, existing, adjust, me) };
  });

  route('POST', '/workspaces/{ws}/hr/payroll/{month}/status', async (me, { ws, month }, body) => {
    const a = await access(me, ws);
    requireManager(a);
    const existing = await openRun(ws, month);
    if (!existing) throw new HttpError(404, 'No payroll for that month yet.');
    const allowed = { draft: ['final'], final: ['paid', 'draft'], paid: ['final'] }[existing.status] || [];
    if (!allowed.includes(body.status)) throw new HttpError(409, `A ${existing.status} payroll can’t become ${body.status}.`);
    const at = now();
    const next = { ...existing, status: body.status, updatedAt: at, updatedBy: me.email };
    if (body.status === 'final') Object.assign(next, { finalizedAt: existing.finalizedAt && existing.status === 'paid' ? existing.finalizedAt : at, finalizedBy: me.email });
    if (body.status === 'paid') Object.assign(next, { paidAt: at, paidBy: me.email });
    if (body.status === 'draft') delete next.finalizedAt;
    if (body.status !== 'paid') delete next.paidAt;
    await put(next);
    return { run: strip(next) };
  });

  route('DELETE', '/workspaces/{ws}/hr/payroll/{month}', async (me, { ws, month }) => {
    const a = await access(me, ws);
    requireManager(a);
    const existing = await openRun(ws, month);
    if (!existing) throw new HttpError(404, 'No payroll for that month yet.');
    if (existing.status !== 'draft') throw new HttpError(409, 'Only a draft payroll can be deleted.');
    await del(pk(ws), `PAY#${month}`);
    return { ok: true };
  });

  route('GET', '/workspaces/{ws}/hr/me/payslips', async (me, { ws }) => {
    const a = await access(me, ws);
    if (!a.self) return { payslips: [] };
    const runs = (await prefix(ws, 'PAY#')).filter((r) => ['final', 'paid'].includes(r.status));
    const payslips = runs
      .map((r) => ({ month: r.month, status: r.status, currency: r.currency, company: r.company, paidAt: r.paidAt || null, line: r.lines.find((l) => l.empId === a.self.id) }))
      .filter((p) => p.line)
      .sort((x, y) => y.month.localeCompare(x.month));
    return { payslips };
  });

  // ---------------------------------------------------------------- biometric devices

  const deviceOut = (d) => ({ id: d.id, name: d.name, location: d.location, keyHint: d.keyHint, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt || null, lastPunchAt: d.lastPunchAt || null, punches: d.punches || 0 });

  async function issueKey(ws, device) {
    const key = `lyrhr_${randomBytes(24).toString('base64url')}`;
    if (device.keyHash) await del(`HRKEY#${device.keyHash}`, 'META');
    device.keyHash = hashKey(key);
    device.keyHint = key.slice(-4);
    await put({ PK: `HRKEY#${device.keyHash}`, SK: 'META', ws, devId: device.id });
    await put({ PK: pk(ws), SK: `DEV#${device.id}`, ...device });
    return key;
  }

  route('GET', '/workspaces/{ws}/hr/devices', async (me, { ws }) => {
    const a = await access(me, ws);
    requireManager(a);
    return { devices: (await prefix(ws, 'DEV#')).map(deviceOut) };
  });

  route('POST', '/workspaces/{ws}/hr/devices', async (me, { ws }, body) => {
    const a = await access(me, ws);
    requireManager(a);
    const name = String(body.name || '').trim().slice(0, 80);
    if (!name) throw new ValidationError('Name the device, like “Front door”.');
    if ((await prefix(ws, 'DEV#')).length >= 50) throw new HttpError(409, 'You can register up to 50 devices.');
    const device = { id: newId(), name, location: String(body.location || '').trim().slice(0, 120), createdAt: now(), createdBy: me.email };
    const key = await issueKey(ws, device);
    return [201, { device: deviceOut(device), key }];
  });

  route('POST', '/workspaces/{ws}/hr/devices/{id}/key', async (me, { ws, id }) => {
    const a = await access(me, ws);
    requireManager(a);
    const device = ID_RE.test(id) ? await get(pk(ws), `DEV#${id}`) : null;
    if (!device) throw new HttpError(404, 'Device not found.');
    const key = await issueKey(ws, strip(device));
    return { device: deviceOut(device), key };
  });

  route('DELETE', '/workspaces/{ws}/hr/devices/{id}', async (me, { ws, id }) => {
    const a = await access(me, ws);
    requireManager(a);
    const device = ID_RE.test(id) ? await get(pk(ws), `DEV#${id}`) : null;
    if (!device) throw new HttpError(404, 'Device not found.');
    await deleteKeys([{ PK: `HRKEY#${device.keyHash}`, SK: 'META' }, { PK: pk(ws), SK: `DEV#${id}` }]);
    return { ok: true };
  });

  // POST /public/hr/punch from a device (or the small bridge program next to it).
  async function publicPunch(body, headers = {}) {
    const key = String(body.key || headers['x-device-key'] || '').trim();
    const link = key.startsWith('lyrhr_') ? await get(`HRKEY#${hashKey(key)}`, 'META') : null;
    if (!link) throw new HttpError(401, 'Unknown device key.');
    const { ws, devId } = link;
    if ((await countUse(`hrdev#${devId}`)) > DEVICE_PUNCHES_PER_HOUR / 50) throw new HttpError(429, 'Too many requests from this device. Send punches in batches.');
    const settings = await getSettings(ws);
    const device = await get(pk(ws), `DEV#${devId}`);
    const raw = Array.isArray(body.punches) ? body.punches : body.user ? [body] : [];
    if (raw.length > DEVICE_BATCH_MAX) throw new HttpError(400, `Send at most ${DEVICE_BATCH_MAX} punches at a time.`);
    let accepted = 0;
    let duplicates = 0;
    const unknown = new Set();
    let invalid = 0;
    if (raw.length) {
      const list = await employees(ws);
      const byDevice = new Map(list.filter((e) => e.deviceUserId).map((e) => [e.deviceUserId, e]));
      const byCode = new Map(list.filter((e) => e.code).map((e) => [e.code.toLowerCase(), e]));
      const entries = raw.map((p) => readDevicePunch(p, settings.timezone)).sort((x, y) => (x && y ? x.at.localeCompare(y.at) : 0));
      for (const entry of entries) {
        if (!entry) {
          invalid += 1;
          continue;
        }
        const employee = byDevice.get(entry.user) || byCode.get(entry.user.toLowerCase());
        if (!employee) {
          unknown.add(entry.user);
          continue;
        }
        const { duplicate } = await punch(ws, settings, employee, { at: entry.at, source: 'device', device: device?.name || 'Device' });
        if (duplicate) duplicates += 1;
        else accepted += 1;
      }
    }
    if (device) {
      await put({ ...device, lastSeenAt: now(), ...(accepted ? { lastPunchAt: now(), punches: (device.punches || 0) + accepted } : {}) });
    }
    return { ok: true, device: device?.name || '', timezone: settings.timezone, serverTime: now(), accepted, duplicates, invalid, unknown: [...unknown] };
  }

  return { publicPunch };
}
