import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addPunch,
  cleanEmployee,
  cleanLeave,
  cleanSettings,
  computePay,
  dayStatus,
  DEFAULT_SETTINGS,
  leaveBalance,
  leaveDays,
  localParts,
  readDevicePunch,
  summarize,
  workDateFor,
  zonedToIso,
} from './hr-model.mjs';

const settings = cleanSettings({ holidays: [{ date: '2026-11-16', name: 'Victory Day (test)' }] });
const emp = cleanEmployee({ name: 'Rafi Ahmed', code: 'E001', salary: { basic: 30000, house: 15000, medical: 3000, transport: 2000 } });
emp.id = 'e1';
const at = (date, time) => zonedToIso(date, time, 'Asia/Dhaka');
const rec = (date, ...times) => ({ date, punches: times.map((t) => ({ at: at(date, t), source: 'web' })) });

test('Dhaka times round-trip and punches land on the right work day', () => {
  assert.equal(at('2026-11-10', '09:05'), '2026-11-10T03:05:00.000Z');
  assert.deepEqual(localParts('2026-11-10T03:05:00.000Z', 'Asia/Dhaka'), { date: '2026-11-10', time: '09:05', minutes: 545 });
  const open = rec('2026-11-10', '20:00');
  assert.equal(workDateFor(at('2026-11-11', '02:00'), 'Asia/Dhaka', open), '2026-11-10', 'a night shift checks out on the day it started');
  assert.equal(workDateFor(at('2026-11-11', '09:00'), 'Asia/Dhaka', rec('2026-11-10', '09:00', '18:00')), '2026-11-11');
  assert.equal(addPunch(open.punches, { at: new Date(Date.parse(open.punches[0].at) + 20000).toISOString() }), null, 'double scans are ignored');
});

test('day status: on time, late, half day, overtime, absent, off and holidays', () => {
  const day = (date, record, extra = {}) => dayStatus({ date, employee: emp, settings, record, today: '2026-11-20', ...extra });
  const ontime = day('2026-11-10', rec('2026-11-10', '09:10', '18:00'));
  assert.equal(ontime.status, 'present');
  assert.equal(ontime.worked, 530);
  const late = day('2026-11-11', rec('2026-11-11', '09:40', '20:30'));
  assert.equal(late.status, 'late');
  assert.equal(late.lateBy, 40);
  assert.equal(late.overtime, 110, 'overtime starts after a full shift: 09:40 + 9h = 18:40');
  assert.equal(day('2026-11-12', rec('2026-11-12', '09:00', '11:00')).status, 'half');
  assert.equal(day('2026-11-12', undefined).status, 'absent');
  assert.equal(day('2026-11-13', undefined).status, 'off', '13 Nov 2026 is a Friday');
  assert.equal(day('2026-11-16', undefined).status, 'holiday');
  const friday = day('2026-11-13', rec('2026-11-13', '10:00', '14:00'));
  assert.equal(friday.overtime, 240, 'work on a day off is all overtime');
  assert.equal(day('2026-11-25', undefined).status, 'upcoming');
  const started = { ...settings, trackingFrom: '2026-11-12' };
  assert.equal(dayStatus({ date: '2026-11-10', employee: emp, settings: started, today: '2026-11-20' }).status, 'untracked', 'before HR started, no one is absent');
  assert.equal(dayStatus({ date: '2026-11-12', employee: emp, settings: started, today: '2026-11-20' }).status, 'absent');
  assert.equal(day('2026-11-12', { override: { status: 'present', in: '09:00', out: '18:00' } }).status, 'present');
  assert.equal(day('2026-11-12', undefined, { leave: { type: 'sick' } }).status, 'leave');
});

test('leave counts working days only and tracks balances', () => {
  const leave = { ...cleanLeave({ type: 'annual', from: '2026-11-12', to: '2026-11-17' }), empId: 'e1', status: 'approved' };
  assert.equal(leaveDays(leave, emp, settings), 4, 'Fri 13 is off and Mon 16 a holiday: 12, 14, 15, 17 count');
  leave.days = 4;
  const balance = leaveBalance([leave], emp, settings, 2026);
  assert.deepEqual(balance.annual, { allowed: 14, used: 4, pending: 0, left: 10 });
  assert.throws(() => cleanLeave({ type: 'annual', from: '2026-11-12', to: '2026-11-10' }), /before the first/);
});

test('payroll: absence, late rule, overtime, tax, PF and proration', () => {
  const summary = summarize([
    ...Array(20).fill({ status: 'present', worked: 540, overtime: 0, lateBy: 0 }),
    ...Array(3).fill({ status: 'late', worked: 540, overtime: 60, lateBy: 30 }),
    { status: 'absent', worked: 0, overtime: 0, lateBy: 0 },
  ]);
  const withTax = { ...emp, salary: { ...emp.salary, taxPercent: 5, pfPercent: 10 } };
  const pay = computePay({ employee: withTax, settings, month: '2026-11', summary, adjust: { bonus: 1000 } });
  assert.equal(pay.gross, 50000);
  assert.equal(pay.lateDays, 1, '3 lates = 1 day');
  assert.equal(pay.absenceDeduction, round(2 * (50000 / 30)));
  assert.equal(pay.overtimeHours, 3);
  assert.equal(pay.overtimeRate, round((30000 / 240) * 2));
  assert.equal(pay.tax, 2500);
  assert.equal(pay.pf, 3000);
  assert.equal(pay.net, round(50000 + 750 + 1000 - pay.absenceDeduction - 2500 - 3000));
  const joined = computePay({ employee: { ...emp, joinDate: '2026-11-16' }, settings, month: '2026-11', summary: summarize([]) });
  assert.equal(joined.employedDays, 15);
  assert.equal(joined.earned, 25000);
});

test('settings, employees and device punches are validated', () => {
  assert.equal(DEFAULT_SETTINGS.timezone, 'Asia/Dhaka');
  assert.throws(() => cleanSettings({ timezone: 'Mars/Base' }), /time zone/);
  assert.deepEqual(cleanSettings({ managers: 'A@x.com, bad, b@y.org' }).managers, ['a@x.com', 'b@y.org']);
  assert.throws(() => cleanEmployee({ name: '' }), /name/);
  assert.equal(cleanEmployee({ name: 'X', salary: { basic: '25,000' } }).salary.basic, 25000);
  const now = new Date();
  const local = localParts(now.toISOString(), 'Asia/Dhaka');
  const p = readDevicePunch({ user: '17', at: `${local.date} ${local.time}:00` }, 'Asia/Dhaka');
  assert.equal(p.user, '17');
  assert.ok(Math.abs(Date.parse(p.at) - now.getTime()) < 61000);
  assert.equal(readDevicePunch({ user: '17', at: '1999-01-01 09:00' }, 'Asia/Dhaka'), null, 'clock far off');
  assert.equal(readDevicePunch({ at: now.toISOString() }, 'Asia/Dhaka'), null);
});

function round(n) {
  return Math.round(n * 100) / 100;
}
