import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyse, cleanEntry, cleanRecurring, cleanSettings, DEFAULT_CATEGORIES, guessCategory, monthsBack, readImportRow, recursIn, toIsoDate } from './finance-model.mjs';

const cats = cleanSettings({ categories: DEFAULT_CATEGORIES.map((c) => (c.id === 'rent' ? { ...c, budget: 50000 } : c.id === 'software' ? { ...c, budget: 10000 } : c)) }).categories;
const e = (date, type, amount, category, extra = {}) => ({ id: `${date}${amount}`, ...cleanEntry({ date, type, amount, category, ...extra }, cats) });

test('entries, categories and recurring costs', () => {
  assert.equal(cleanEntry({ date: '2026-11-02', type: 'cost', amount: '12,500', category: 'rent' }, cats).amount, 12500);
  assert.equal(cleanEntry({ date: '2026-11-02', type: 'cost', amount: 5, category: 'sales' }, cats).type, 'income', 'the category decides');
  assert.equal(cleanEntry({ date: '2026-11-02', type: 'cost', amount: 5, category: 'nope' }, cats).category, 'other');
  assert.throws(() => cleanEntry({ date: '2026-11-02', amount: 0 }, cats), /amount/);
  assert.throws(() => cleanSettings({ categories: [{ name: 'Sales', kind: 'income' }] }), /cost category/);
  assert.deepEqual(cleanSettings({ categories: [{ name: 'Payroll' }, { name: 'payroll!' }] }).categories.map((c) => c.id), ['payroll-x', 'payroll-x-x'], 'ids stay unique and never clash with linked ones');
  const rent = cleanRecurring({ name: 'Office rent', amount: 45000, category: 'rent', start: '2026-01', frequency: 'quarterly' }, cats);
  assert.deepEqual(['2026-01', '2026-02', '2026-04', '2026-07'].map((m) => recursIn({ ...rent, active: true }, m)), [true, false, true, true]);
});

test('bank statement rows: dates, debit/credit, guessed categories', () => {
  assert.equal(toIsoDate('07/11/2026'), '2026-11-07', 'day first');
  assert.equal(toIsoDate('2026/11/7'), '2026-11-07');
  assert.equal(toIsoDate('31/02/2026'), '');
  assert.deepEqual(readImportRow({ date: '05-11-2026', description: 'AWS EMEA invoice', amount: '-3,200.50' }, cats), { type: 'cost', date: '2026-11-05', amount: 3200.5, description: 'AWS EMEA invoice', vendor: '', category: 'software', department: '', reference: '' });
  assert.equal(readImportRow({ date: '2026-11-06', description: 'Client payment', credit: '80,000' }, cats).type, 'income');
  assert.equal(readImportRow({ date: '2026-11-06', description: 'Pathao ride', debit: '350' }, cats).category, 'travel');
  assert.equal(guessCategory('DESCO prepaid', 'cost', cats), 'rent');
  assert.equal(readImportRow({ date: 'soon', amount: 5 }, cats), null);
});

test('analysis: totals, profit, budgets, linked payroll and ads, pace', () => {
  const months = monthsBack('2026-11', 3);
  assert.deepEqual(months, ['2026-09', '2026-10', '2026-11']);
  const entries = [
    e('2026-10-01', 'cost', 50000, 'rent'),
    e('2026-10-20', 'income', 200000, 'services'),
    e('2026-11-01', 'cost', 50000, 'rent', { vendor: 'Landlord' }),
    e('2026-11-03', 'cost', 12000, 'software', { vendor: 'AWS', department: 'Engineering' }),
    e('2026-11-05', 'cost', 3000, 'software', { vendor: 'AWS', department: 'Engineering' }),
    e('2026-11-06', 'income', 150000, 'services'),
    e('2026-11-07', 'cost', 8000, 'office', { status: 'unpaid', dueDate: '2026-11-15' }),
  ];
  const a = analyse({ month: '2026-11', months, entries, linked: { payroll: { '2026-11': 100000 }, ads: { '2026-11': 20000 }, adsDaily: { '2026-11': { 2: 20000 } } }, categories: cats, today: '2026-11-10' });
  assert.deepEqual([a.totals.income, a.totals.costs, a.totals.profit], [150000, 193000, -43000]);
  assert.equal(a.totals.budget, 60000);
  assert.equal(a.totals.budgetUsed, 121.67, 'typed costs only count against category budgets');
  const sw = a.categories.find((c) => c.id === 'software');
  assert.deepEqual([sw.amount, sw.used, sw.over], [15000, 150, true]);
  assert.equal(a.categories.find((c) => c.id === 'payroll').amount, 100000);
  assert.deepEqual(a.vendors[0], { name: 'Landlord', amount: 50000, count: 1 });
  assert.equal(a.vendors[1].amount, 15000);
  assert.equal(a.cumulative[1].total, 50000, 'the running total is the budgeted costs only');
  assert.equal(a.cumulative[29].total, 73000);
  // 50,000 rent (recurring, counted once) + (23,000 other + 20,000 ads) over 10 days → ×3, + payroll.
  const withRent = analyse({ month: '2026-11', months, entries: entries.map((x) => (x.category === 'rent' ? { ...x, recurringId: 'r1' } : x)), linked: { payroll: { '2026-11': 100000 }, ads: { '2026-11': 20000 } }, categories: cats, today: '2026-11-10', recurringDue: 50000 });
  assert.equal(withRent.totals.projected, 50000 + 43000 * 3 + 100000);
  assert.equal(a.cumulative[15].future, true);
  assert.equal(a.totals.unpaidCount, 1);
  assert.equal(a.series.find((s) => s.month === '2026-10').profit, 150000);
  assert.equal(a.totals.previous.income, 200000);
});
