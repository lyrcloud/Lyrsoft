// Lyrsoft HR: pure rules behind hr.mjs (and tested in hr.test.mjs). Employees, the company's work
// rules (shift, weekly days off, holidays, leave allowances, overtime), attendance from punches
// (web check-in, a manager's edit or a biometric device), leave and monthly payroll.
//
// Times: punches are stored as UTC instants. Everything people see (the work day a punch belongs
// to, late arrivals, overtime) is worked out in the company's time zone (settings.timezone).
import { ValidationError } from './model.mjs';

export const EMPLOYEES_MAX = 2000;
export const PUNCHES_PER_DAY_MAX = 20;
export const DEVICE_BATCH_MAX = 500;
export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export const EMPLOYMENT_TYPES = ['full-time', 'part-time', 'contract', 'intern'];
export const LEAVE_TYPES = ['annual', 'sick', 'casual', 'maternity', 'unpaid', 'other'];
export const PAID_LEAVE = ['annual', 'sick', 'casual', 'maternity', 'other'];
export const DAY_STATUSES = ['present', 'late', 'absent', 'leave', 'unpaid', 'off', 'holiday', 'half'];
export const SALARY_PARTS = ['basic', 'house', 'medical', 'transport', 'food', 'other'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL_RE = /^[^\s@<>(),;:"]{1,64}@[^\s@<>(),;:"]{1,190}\.[^\s@<>(),;:"]{2,63}$/;

const text = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const multiline = (value, max) => String(value ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim().slice(0, max);
const money = (value) => {
  const n = Number(String(value ?? '').replace(/[,\s]/g, ''));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : 0;
};
const percent = (value) => Math.min(100, money(value));
const intIn = (value, min, max, fallback) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
export const isDate = (v) => DATE_RE.test(String(v || '')) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
export const isMonth = (v) => MONTH_RE.test(String(v || '')) && Number(String(v).slice(5)) >= 1 && Number(String(v).slice(5)) <= 12;
export const toMinutes = (hhmm) => (TIME_RE.test(hhmm || '') ? Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)) : null);
export const fromMinutes = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

// ------------------------------------------------------------------ dates in the company's time zone

export function validTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map();
// { date: 'YYYY-MM-DD', time: 'HH:MM', minutes } of an instant, in `tz`.
export function localParts(iso, tz) {
  if (!formatters.has(tz)) formatters.set(tz, new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
  const parts = Object.fromEntries(formatters.get(tz).formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  const time = `${parts.hour}:${parts.minute}`;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time, minutes: toMinutes(time) };
}

// The UTC instant of a wall-clock "YYYY-MM-DD" + "HH:MM[:SS]" in `tz`.
export function zonedToIso(date, time, tz) {
  const [h, mi, s = 0] = time.split(':').map(Number);
  const guess = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), h, mi, s);
  let at = guess;
  for (let i = 0; i < 2; i += 1) {
    const p = localParts(new Date(at).toISOString(), tz);
    const shown = Date.UTC(Number(p.date.slice(0, 4)), Number(p.date.slice(5, 7)) - 1, Number(p.date.slice(8, 10)), Math.floor(p.minutes / 60), p.minutes % 60, s);
    at += guess - shown;
  }
  return new Date(at).toISOString();
}

export const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
export const weekday = (date) => WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
export const daysInMonth = (month) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
export const monthDates = (month) => Array.from({ length: daysInMonth(month) }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);

// ------------------------------------------------------------------ settings

export const DEFAULT_SETTINGS = {
  company: '',
  currency: 'BDT',
  timezone: 'Asia/Dhaka',
  shiftStart: '09:00',
  shiftEnd: '18:00',
  graceMinutes: 15,
  halfDayMinutes: 240, // worked less than this (but some) = half day
  weeklyOff: ['fri'],
  daysPerMonth: 30, // daily rate = gross / this
  overtimeMultiplier: 2, // of the basic hourly rate
  overtimeMinMinutes: 30, // overtime shorter than this isn't counted
  latesPerDeduction: 3, // every N late arrivals cost one day's pay (0 = never)
  leaveAllowance: { annual: 14, sick: 14, casual: 10, maternity: 112, other: 0 },
  holidays: [],
  webCheckIn: true,
  requireLocation: false,
  managers: [], // members (beyond workspace owners and admins) who run HR
  trackingFrom: '', // days before this aren't counted as absent (blank: from the first employee added)
};

export function cleanSettings(input = {}, current = DEFAULT_SETTINGS) {
  const base = { ...DEFAULT_SETTINGS, ...current };
  const s = { ...base };
  if ('company' in input) s.company = text(input.company, 120);
  if ('currency' in input) s.currency = text(input.currency, 8).toUpperCase() || 'BDT';
  if ('timezone' in input) {
    const tz = text(input.timezone, 60);
    if (!validTimezone(tz)) throw new ValidationError(`“${tz}” isn’t a time zone. Try Asia/Dhaka.`);
    s.timezone = tz;
  }
  for (const key of ['shiftStart', 'shiftEnd']) {
    if (key in input) {
      if (toMinutes(input[key]) === null) throw new ValidationError('Shift times look like 09:00.');
      s[key] = input[key];
    }
  }
  if ('graceMinutes' in input) s.graceMinutes = intIn(input.graceMinutes, 0, 240, base.graceMinutes);
  if ('halfDayMinutes' in input) s.halfDayMinutes = intIn(input.halfDayMinutes, 0, 720, base.halfDayMinutes);
  if ('weeklyOff' in input) s.weeklyOff = [...new Set((Array.isArray(input.weeklyOff) ? input.weeklyOff : [input.weeklyOff]).filter((d) => WEEKDAYS.includes(d)))];
  if ('daysPerMonth' in input) s.daysPerMonth = intIn(input.daysPerMonth, 20, 31, base.daysPerMonth);
  if ('overtimeMultiplier' in input) s.overtimeMultiplier = Math.min(5, money(input.overtimeMultiplier));
  if ('overtimeMinMinutes' in input) s.overtimeMinMinutes = intIn(input.overtimeMinMinutes, 0, 240, base.overtimeMinMinutes);
  if ('latesPerDeduction' in input) s.latesPerDeduction = intIn(input.latesPerDeduction, 0, 31, base.latesPerDeduction);
  if ('leaveAllowance' in input && input.leaveAllowance && typeof input.leaveAllowance === 'object') {
    s.leaveAllowance = { ...base.leaveAllowance };
    for (const type of PAID_LEAVE) if (type in input.leaveAllowance) s.leaveAllowance[type] = intIn(input.leaveAllowance[type], 0, 365, 0);
  }
  if ('holidays' in input) {
    const list = Array.isArray(input.holidays) ? input.holidays : [];
    s.holidays = list
      .map((h) => ({ date: String(h?.date || ''), name: text(h?.name, 80) || 'Holiday' }))
      .filter((h) => isDate(h.date))
      .filter((h, i, all) => all.findIndex((x) => x.date === h.date) === i)
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(0, 200);
  }
  if ('trackingFrom' in input) s.trackingFrom = isDate(input.trackingFrom) ? input.trackingFrom : '';
  if ('webCheckIn' in input) s.webCheckIn = input.webCheckIn === true || input.webCheckIn === 'on' || input.webCheckIn === 'true';
  if ('requireLocation' in input) s.requireLocation = input.requireLocation === true || input.requireLocation === 'on' || input.requireLocation === 'true';
  if ('managers' in input) {
    const list = Array.isArray(input.managers) ? input.managers : String(input.managers || '').split(/[\s,;]+/);
    s.managers = [...new Set(list.map((e) => text(e, 254).toLowerCase()).filter((e) => EMAIL_RE.test(e)))].slice(0, 50);
  }
  if (toMinutes(s.shiftEnd) === toMinutes(s.shiftStart)) throw new ValidationError('The shift has to end at a different time than it starts.');
  return s;
}

// ------------------------------------------------------------------ employees

export function cleanEmployee(input, current = null) {
  if (!input || typeof input !== 'object') throw new ValidationError('Send an employee.');
  const e = current ? { ...current } : {};
  const set = (key, value) => {
    if (key in input || !current) e[key] = value(input[key]);
  };
  set('name', (v) => text(v, 120));
  set('code', (v) => text(v, 30));
  set('email', (v) => text(v, 254).toLowerCase());
  set('phone', (v) => text(v, 40));
  set('department', (v) => text(v, 80));
  set('designation', (v) => text(v, 80));
  set('type', (v) => (EMPLOYMENT_TYPES.includes(v) ? v : 'full-time'));
  set('status', (v) => (v === 'inactive' ? 'inactive' : 'active'));
  set('joinDate', (v) => (isDate(v) ? v : ''));
  set('leaveDate', (v) => (isDate(v) ? v : ''));
  set('gender', (v) => text(v, 20));
  set('birthday', (v) => (isDate(v) ? v : ''));
  set('nationalId', (v) => text(v, 40));
  set('address', (v) => multiline(v, 400));
  set('emergencyContact', (v) => text(v, 160));
  set('bankName', (v) => text(v, 80));
  set('bankAccount', (v) => text(v, 60));
  set('deviceUserId', (v) => text(v, 30));
  set('notes', (v) => multiline(v, 2000));
  set('shiftStart', (v) => (toMinutes(v) !== null ? v : ''));
  set('shiftEnd', (v) => (toMinutes(v) !== null ? v : ''));
  set('weeklyOff', (v) => (Array.isArray(v) ? [...new Set(v.filter((d) => WEEKDAYS.includes(d)))] : null));
  if ('salary' in input || !current) {
    const raw = input.salary && typeof input.salary === 'object' ? input.salary : {};
    const old = current?.salary || {};
    const salary = {};
    for (const part of SALARY_PARTS) salary[part] = part in raw ? money(raw[part]) : old[part] || 0;
    salary.taxPercent = 'taxPercent' in raw ? percent(raw.taxPercent) : old.taxPercent || 0;
    salary.pfPercent = 'pfPercent' in raw ? percent(raw.pfPercent) : old.pfPercent || 0;
    salary.overtimeHourly = 'overtimeHourly' in raw ? money(raw.overtimeHourly) : old.overtimeHourly || 0;
    salary.overtimeEligible = 'overtimeEligible' in raw ? raw.overtimeEligible !== false && raw.overtimeEligible !== 'false' : old.overtimeEligible !== false;
    e.salary = salary;
  }
  if (!e.name) throw new ValidationError('Give the employee a name.');
  if (e.email && !EMAIL_RE.test(e.email)) throw new ValidationError(`“${e.email}” isn’t an email address.`);
  if (e.joinDate && e.leaveDate && e.leaveDate < e.joinDate) throw new ValidationError('The last day can’t be before the joining date.');
  return e;
}

export const grossOf = (salary = {}) => round2(SALARY_PARTS.reduce((sum, part) => sum + (Number(salary[part]) || 0), 0));

// An employee's own shift and days off, or the company's.
export function shiftFor(employee, settings) {
  return {
    start: toMinutes(employee?.shiftStart) ?? toMinutes(settings.shiftStart),
    end: toMinutes(employee?.shiftEnd) ?? toMinutes(settings.shiftEnd),
    weeklyOff: Array.isArray(employee?.weeklyOff) && employee.weeklyOff.length ? employee.weeklyOff : settings.weeklyOff,
  };
}
const shiftLength = ({ start, end }) => (end > start ? end - start : end + 1440 - start);

// Whether the employee works for the company on `date` (joined, not yet left).
export const employedOn = (employee, date) => (!employee.joinDate || employee.joinDate <= date) && (!employee.leaveDate || employee.leaveDate >= date);

// ------------------------------------------------------------------ punches and the work day

// Which work day a punch belongs to. A punch shortly after midnight closes the day before when that
// day is still open (an odd number of punches, the last within 16 hours): night shifts and late
// check-outs stay on the day they started.
export function workDateFor(atIso, tz, previous) {
  const { date } = localParts(atIso, tz);
  const prior = previous?.punches || [];
  if (previous && previous.date === addDays(date, -1) && prior.length % 2 === 1) {
    const last = Date.parse(prior[prior.length - 1].at);
    if (Date.parse(atIso) - last < 16 * 3600 * 1000) return previous.date;
  }
  return date;
}

// Adds a punch to a day's record unless the same person punched within the last minute (devices
// often send a scan twice). Returns the new list, or null for a duplicate.
export function addPunch(punches = [], punch) {
  const at = Date.parse(punch.at);
  if (punches.some((p) => Math.abs(Date.parse(p.at) - at) < 60 * 1000)) return null;
  if (punches.length >= PUNCHES_PER_DAY_MAX) throw new ValidationError('Too many punches for one day.');
  return [...punches, punch].sort((a, b) => a.at.localeCompare(b.at));
}

// What a day looks like for one employee: status, in/out, worked and overtime minutes.
// `record` is the stored attendance row (punches, a manager's override) or undefined; `leave` is an
// approved leave covering the day; `today` is the company's date now.
export function dayStatus({ date, employee, settings, record, leave, today }) {
  const shift = shiftFor(employee, settings);
  const holiday = settings.holidays.find((h) => h.date === date);
  const off = shift.weeklyOff.includes(weekday(date));
  const o = record?.override || {};
  const punches = record?.punches || [];
  const local = punches.map((p) => ({ ...p, ...localParts(p.at, settings.timezone) }));
  const inTime = o.in || local[0]?.time || '';
  const outTime = o.out || (local.length > 1 ? local[local.length - 1].time : '');
  const inMin = toMinutes(inTime);
  let outMin = toMinutes(outTime);
  if (inMin !== null && outMin !== null && outMin < inMin) outMin += 1440; // past midnight
  const worked = inMin !== null && outMin !== null ? outMin - inMin : 0;
  const shiftEnd = shift.end > shift.start ? shift.end : shift.end + 1440;
  let overtime = outMin !== null && inMin !== null ? Math.max(0, outMin - Math.max(shiftEnd, inMin + shiftLength(shift))) : 0;
  if (overtime < settings.overtimeMinMinutes) overtime = 0;
  const lateBy = inMin !== null ? Math.max(0, inMin - shift.start) : 0;
  let status;
  if (!employedOn(employee, date)) status = 'none';
  else if (o.status) status = o.status;
  else if (settings.trackingFrom && date < settings.trackingFrom && !punches.length && !leave) status = 'untracked';
  else if (leave) status = leave.type === 'unpaid' ? 'unpaid' : 'leave';
  else if (inMin !== null) {
    status = lateBy > settings.graceMinutes ? 'late' : 'present';
    if (outMin !== null && settings.halfDayMinutes && worked < settings.halfDayMinutes) status = 'half';
  } else if (holiday) status = 'holiday';
  else if (off) status = 'off';
  else if (date < today) status = 'absent';
  else status = date === today ? 'pending' : 'upcoming';
  // Working on a day off or holiday is all overtime.
  if ((holiday || off) && inMin !== null && !o.status && !leave) {
    status = 'present';
    overtime = worked >= settings.overtimeMinMinutes ? worked : 0;
  }
  return {
    date,
    status,
    in: inTime,
    out: outTime,
    worked,
    overtime: employee?.salary?.overtimeEligible === false ? 0 : overtime,
    lateBy: status === 'late' ? lateBy : 0,
    holiday: holiday?.name || '',
    leaveType: leave?.type || '',
    note: o.note || '',
    punches: local.map((p) => ({ at: p.at, time: p.time, source: p.source, device: p.device || '', geo: p.geo || null })),
    edited: Boolean(record?.override),
  };
}

// Totals for a set of days (a month, usually).
export function summarize(days) {
  const s = { present: 0, late: 0, half: 0, absent: 0, leave: 0, unpaid: 0, off: 0, holiday: 0, workDays: 0, worked: 0, overtime: 0, lateMinutes: 0 };
  for (const d of days) {
    if (d.status in s) s[d.status] += 1;
    if (['present', 'late', 'half', 'absent', 'leave', 'unpaid'].includes(d.status)) s.workDays += 1;
    s.worked += d.worked;
    s.overtime += d.overtime;
    s.lateMinutes += d.lateBy;
  }
  s.attended = s.present + s.late + s.half;
  return s;
}

// ------------------------------------------------------------------ leave

export function cleanLeave(input) {
  const type = LEAVE_TYPES.includes(input?.type) ? input.type : null;
  if (!type) throw new ValidationError('Pick a leave type.');
  const from = String(input.from || '');
  const to = String(input.to || input.from || '');
  if (!isDate(from) || !isDate(to)) throw new ValidationError('Pick the first and last day of the leave.');
  if (to < from) throw new ValidationError('The last day can’t be before the first.');
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > 180) throw new ValidationError('A leave can be at most 180 days. Split longer ones.');
  return { type, from, to, half: input.half === true || input.half === 'on', reason: multiline(input.reason, 1000) };
}

// Working days a leave uses: weekly days off and holidays inside it don't count.
export function leaveDays(leave, employee, settings) {
  if (leave.half) return 0.5;
  const shift = shiftFor(employee, settings);
  let n = 0;
  for (let d = leave.from; d <= leave.to; d = addDays(d, 1)) {
    if (!shift.weeklyOff.includes(weekday(d)) && !settings.holidays.some((h) => h.date === d)) n += 1;
  }
  return n;
}

export const leaveCovering = (leaves, empId, date) => leaves.find((l) => l.empId === empId && l.status === 'approved' && l.from <= date && l.to >= date);

// Days used and left of each paid leave type in `year`.
export function leaveBalance(leaves, employee, settings, year) {
  const out = {};
  for (const type of PAID_LEAVE) out[type] = { allowed: settings.leaveAllowance?.[type] || 0, used: 0, pending: 0 };
  out.unpaid = { allowed: 0, used: 0, pending: 0 };
  for (const l of leaves) {
    if (l.empId !== employee.id || !l.from.startsWith(String(year)) || !out[l.type]) continue;
    if (l.status === 'approved') out[l.type].used += l.days;
    if (l.status === 'pending') out[l.type].pending += l.days;
  }
  for (const v of Object.values(out)) v.left = Math.max(0, v.allowed - v.used);
  return out;
}

// ------------------------------------------------------------------ payroll

// One employee's pay for a month from their salary and the month's attendance summary.
// `adjust` carries what a manager added by hand: bonus, other deduction, advance, a note.
export function computePay({ employee, settings, month, summary, adjust = {} }) {
  const salary = employee.salary || {};
  const gross = grossOf(salary);
  const total = daysInMonth(month);
  const first = `${month}-01`;
  const last = `${month}-${String(total).padStart(2, '0')}`;
  const from = employee.joinDate && employee.joinDate > first ? employee.joinDate : first;
  const to = employee.leaveDate && employee.leaveDate < last ? employee.leaveDate : last;
  const employedDays = to >= from ? (Date.parse(to) - Date.parse(from)) / 86400000 + 1 : 0;
  const earned = round2(employedDays >= total ? gross : (gross * employedDays) / total);
  const dailyRate = gross / (settings.daysPerMonth || 30);
  const lateDays = settings.latesPerDeduction ? Math.floor(summary.late / settings.latesPerDeduction) : 0;
  const unpaidDays = summary.absent + summary.unpaid + summary.half * 0.5 + lateDays;
  const absenceDeduction = round2(Math.min(earned, unpaidDays * dailyRate));
  const hourly = salary.overtimeHourly || ((salary.basic || 0) / ((settings.daysPerMonth || 30) * 8)) * (settings.overtimeMultiplier || 0);
  const overtimeHours = round2(summary.overtime / 60);
  const overtimePay = salary.overtimeEligible === false ? 0 : round2(overtimeHours * hourly);
  const bonus = money(adjust.bonus);
  const tax = round2((gross * (salary.taxPercent || 0)) / 100);
  const pf = round2(((salary.basic || 0) * (salary.pfPercent || 0)) / 100);
  const advance = money(adjust.advance);
  const otherDeduction = money(adjust.deduction);
  const earnings = round2(earned + overtimePay + bonus);
  const deductions = round2(absenceDeduction + tax + pf + advance + otherDeduction);
  return {
    empId: employee.id,
    name: employee.name,
    code: employee.code || '',
    department: employee.department || '',
    designation: employee.designation || '',
    bankName: employee.bankName || '',
    bankAccount: employee.bankAccount || '',
    salary: Object.fromEntries(SALARY_PARTS.map((p) => [p, salary[p] || 0])),
    gross,
    employedDays,
    earned,
    attendance: { present: summary.present, late: summary.late, half: summary.half, absent: summary.absent, leave: summary.leave, unpaid: summary.unpaid, off: summary.off, holiday: summary.holiday, workDays: summary.workDays, worked: summary.worked },
    lateDays,
    unpaidDays: round2(unpaidDays),
    dailyRate: round2(dailyRate),
    absenceDeduction,
    overtimeHours,
    overtimeRate: round2(hourly),
    overtimePay,
    bonus,
    tax,
    pf,
    advance,
    otherDeduction,
    note: text(adjust.note, 300),
    earnings,
    deductions,
    net: round2(Math.max(0, earnings - deductions)),
  };
}

export const payrollTotals = (lines) => ({
  employees: lines.length,
  gross: round2(lines.reduce((s, l) => s + l.gross, 0)),
  earnings: round2(lines.reduce((s, l) => s + l.earnings, 0)),
  deductions: round2(lines.reduce((s, l) => s + l.deductions, 0)),
  overtimePay: round2(lines.reduce((s, l) => s + l.overtimePay, 0)),
  net: round2(lines.reduce((s, l) => s + l.net, 0)),
});

// ------------------------------------------------------------------ biometric devices

// A punch as a device sends it: { user: the person's ID on the device (or employee code), at }.
// `at` is an ISO time with an offset, or the device's local "YYYY-MM-DD HH:MM[:SS]" (read in the
// company's time zone), or epoch seconds/milliseconds.
export function readDevicePunch(raw, tz) {
  const user = text(raw?.user ?? raw?.userId ?? raw?.pin ?? raw?.id ?? raw?.code, 30);
  if (!user) return null;
  const value = raw?.at ?? raw?.time ?? raw?.timestamp;
  let at = null;
  if (typeof value === 'number' || /^\d{10,13}$/.test(String(value ?? ''))) {
    const n = Number(value);
    at = new Date(n < 1e12 ? n * 1000 : n).toISOString();
  } else {
    const s = String(value || '').trim();
    const local = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/);
    if (local) at = zonedToIso(local[1], local[2], tz);
    else if (!Number.isNaN(Date.parse(s))) at = new Date(s).toISOString();
  }
  if (!at) return null;
  const t = Date.parse(at);
  if (t > Date.now() + 10 * 60 * 1000 || t < Date.now() - 90 * 86400000) return null; // clock badly off
  return { user, at };
}
