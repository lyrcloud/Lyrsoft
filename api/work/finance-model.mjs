// Lyrsoft Costs & analytics: pure rules behind finance.mjs (tested in finance.test.mjs). Cost and
// income entries, categories with monthly budgets, recurring costs, and the analysis built from them
// plus what other Lyrsoft modules already know: payroll (HR) and ad spend (Ads & budget).
import { ValidationError } from './model.mjs';

export const ENTRIES_PER_IMPORT = 1000;
export const PAYMENT_METHODS = ['cash', 'bank', 'card', 'bkash', 'nagad', 'rocket', 'cheque', 'other'];
export const FREQUENCIES = ['monthly', 'quarterly', 'yearly'];
// Linked categories are filled from other modules and can't be typed into.
export const LINKED = { payroll: 'Salaries (payroll)', ads: 'Advertising (ads)' };
export const DEFAULT_CATEGORIES = [
  { id: 'rent', name: 'Rent & utilities', kind: 'cost', budget: 0 },
  { id: 'software', name: 'Software & cloud', kind: 'cost', budget: 0 },
  { id: 'office', name: 'Office & supplies', kind: 'cost', budget: 0 },
  { id: 'travel', name: 'Travel & transport', kind: 'cost', budget: 0 },
  { id: 'marketing', name: 'Marketing (other)', kind: 'cost', budget: 0 },
  { id: 'contractors', name: 'Contractors & services', kind: 'cost', budget: 0 },
  { id: 'equipment', name: 'Equipment', kind: 'cost', budget: 0 },
  { id: 'tax', name: 'Taxes & fees', kind: 'cost', budget: 0 },
  { id: 'other', name: 'Other costs', kind: 'cost', budget: 0 },
  { id: 'sales', name: 'Sales', kind: 'income', budget: 0 },
  { id: 'services', name: 'Services & projects', kind: 'income', budget: 0 },
  { id: 'other-income', name: 'Other income', kind: 'income', budget: 0 },
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const EMAIL_RE = /^[^\s@<>(),;:"]{1,64}@[^\s@<>(),;:"]{1,190}\.[^\s@<>(),;:"]{2,63}$/;
const text = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
export const amount = (v) => {
  const s = String(v ?? '').replace(/[,\s]/g, '').replace(/^\((.*)\)$/, '-$1');
  const n = Math.abs(Number(s));
  return Number.isFinite(n) ? round2(n) : 0;
};
export const isDate = (v) => {
  if (!DATE_RE.test(String(v || ''))) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v; // 2026-02-31 doesn't roll over to March
};
export const isMonth = (v) => MONTH_RE.test(String(v || ''));
export const daysInMonth = (m) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate();
export const addMonths = (m, n) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + n, 1)).toISOString().slice(0, 7);
export const monthsBack = (m, n) => Array.from({ length: n }, (_, i) => addMonths(m, i - n + 1));
const slug = (s) => text(s, 40).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'category';

// ------------------------------------------------------------------ settings

export function cleanSettings(input = {}, current = {}) {
  const s = { currency: current.currency || 'BDT', categories: current.categories || DEFAULT_CATEGORIES, viewers: current.viewers || [] };
  if ('currency' in input) s.currency = text(input.currency, 8).toUpperCase() || 'BDT';
  if ('categories' in input) {
    const list = Array.isArray(input.categories) ? input.categories : [];
    const seen = new Set();
    s.categories = [];
    for (const c of list.slice(0, 60)) {
      const name = text(c?.name, 60);
      if (!name) continue;
      let id = c.id && /^[a-z0-9-]{1,40}$/.test(c.id) ? c.id : slug(name);
      while (seen.has(id) || id in LINKED) id = `${id}-x`;
      seen.add(id);
      s.categories.push({ id, name, kind: c.kind === 'income' ? 'income' : 'cost', budget: amount(c.budget) });
    }
    if (!s.categories.some((c) => c.kind === 'cost')) throw new ValidationError('Keep at least one cost category.');
  }
  if ('viewers' in input) {
    const raw = Array.isArray(input.viewers) ? input.viewers : String(input.viewers || '').split(/[\s,;]+/);
    s.viewers = [...new Set(raw.map((e) => text(e, 254).toLowerCase()).filter((e) => EMAIL_RE.test(e)))].slice(0, 50);
  }
  return s;
}

// ------------------------------------------------------------------ entries

export function cleanEntry(input, categories, current = null) {
  const e = current ? { ...current } : {};
  const has = (k) => k in (input || {}) || !current;
  if (has('type')) e.type = input.type === 'income' ? 'income' : 'cost';
  if (has('date')) {
    if (!isDate(input.date)) throw new ValidationError('Pick the date.');
    e.date = input.date;
  }
  if (has('amount')) e.amount = amount(input.amount);
  if (has('category')) e.category = String(input.category || '');
  if (has('vendor')) e.vendor = text(input.vendor, 120);
  if (has('description')) e.description = text(input.description, 300);
  if (has('department')) e.department = text(input.department, 80);
  if (has('project')) e.project = text(input.project, 80);
  if (has('method')) e.method = PAYMENT_METHODS.includes(input.method) ? input.method : '';
  if (has('status')) e.status = input.status === 'unpaid' ? 'unpaid' : 'paid';
  if (has('dueDate')) e.dueDate = isDate(input.dueDate) ? input.dueDate : '';
  if (has('reference')) e.reference = text(input.reference, 80);
  if (!e.amount) throw new ValidationError('Type the amount.');
  const cat = categories.find((c) => c.id === e.category);
  if (!cat) e.category = categories.find((c) => c.kind === e.type && /other/.test(c.id))?.id || categories.find((c) => c.kind === e.type)?.id || '';
  else if (cat.kind !== e.type) e.type = cat.kind;
  if (!e.category) throw new ValidationError(`Add an ${e.type} category first.`);
  return e;
}

// Guesses a category for an imported line from words in it ("Uber" → travel, "AWS" → software).
const HINTS = [
  [/rent|electric|desco|dpdc|wasa|titas|gas bill|water|internet|broadband|link3|amber/i, 'rent'],
  [/aws|amazon web|google cloud|gcp|azure|github|figma|slack|notion|zoom|microsoft|adobe|openai|anthropic|cloudflare|hosting|domain|software|saas/i, 'software'],
  [/uber|pathao|obhai|taxi|fuel|petrol|octane|bus|train|flight|biman|us-bangla|hotel|travel/i, 'travel'],
  [/facebook|meta|google ads|tiktok|linkedin|ads|boost|promotion|marketing/i, 'marketing'],
  [/stationery|office|tea|snacks|cleaning|supplies|printer|paper/i, 'office'],
  [/laptop|computer|monitor|phone|equipment|furniture|chair|desk/i, 'equipment'],
  [/vat|tax|fee|charge|bank charge|commission/i, 'tax'],
  [/freelanc|contract|consult|agency|service/i, 'contractors'],
];
export function guessCategory(textValue, type, categories) {
  if (type === 'cost') for (const [re, id] of HINTS) if (re.test(textValue) && categories.some((c) => c.id === id)) return id;
  return '';
}

// Rows from a bank statement or spreadsheet: date, description, amount (negative or a debit column = cost).
export function readImportRow(row, categories) {
  const date = toIsoDate(row.date);
  if (!date) return null;
  let value = Number(String(row.amount ?? '').replace(/[,\s]/g, '').replace(/^\((.*)\)$/, '-$1'));
  const debit = amount(row.debit);
  const credit = amount(row.credit);
  if (!Number.isFinite(value) || !value) value = credit ? credit : debit ? -debit : 0;
  if (!value) return null;
  const type = row.type === 'income' || row.type === 'cost' ? row.type : value < 0 ? 'cost' : 'income';
  const description = text(row.description, 300);
  const category = categories.find((c) => c.name.toLowerCase() === String(row.category || '').toLowerCase())?.id || guessCategory(`${description} ${row.vendor || ''}`, type, categories);
  return { type, date, amount: Math.abs(value), description, vendor: text(row.vendor, 120), category, department: text(row.department, 80), reference: text(row.reference, 80) };
}
export function toIsoDate(v) {
  const s = String(v || '').trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return pad(m[1], m[2], m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/); // day first, as Bangladeshi and most banks print it
  if (m) return pad(m[3].length === 2 ? `20${m[3]}` : m[3], m[2], m[1]);
  const t = Date.parse(s);
  return Number.isNaN(t) ? '' : new Date(t).toISOString().slice(0, 10);
}
function pad(y, mo, d) {
  const out = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return isDate(out) && Number(mo) <= 12 ? out : '';
}

// ------------------------------------------------------------------ recurring

export function cleanRecurring(input, categories, current = null) {
  const r = current ? { ...current } : {};
  const has = (k) => k in (input || {}) || !current;
  if (has('name')) r.name = text(input.name, 120);
  if (has('amount')) r.amount = amount(input.amount);
  if (has('category')) r.category = categories.some((c) => c.id === input.category && c.kind === 'cost') ? input.category : categories.find((c) => c.kind === 'cost')?.id;
  if (has('vendor')) r.vendor = text(input.vendor, 120);
  if (has('department')) r.department = text(input.department, 80);
  if (has('frequency')) r.frequency = FREQUENCIES.includes(input.frequency) ? input.frequency : 'monthly';
  if (has('day')) r.day = Math.min(28, Math.max(1, Math.round(Number(input.day) || 1)));
  if (has('start')) r.start = isMonth(input.start) ? input.start : '';
  if (has('end')) r.end = isMonth(input.end) ? input.end : '';
  if (has('active')) r.active = input.active !== false && input.active !== 'false';
  if (!r.name) throw new ValidationError('Name the recurring cost, like “Office rent”.');
  if (!r.amount) throw new ValidationError('Type the amount.');
  if (!r.start) throw new ValidationError('Pick the first month.');
  return r;
}

// Whether a recurring cost falls in `month`.
export function recursIn(r, month) {
  if (!r.active || month < r.start || (r.end && month > r.end)) return false;
  const gap = (Number(month.slice(0, 4)) - Number(r.start.slice(0, 4))) * 12 + Number(month.slice(5, 7)) - Number(r.start.slice(5, 7));
  return gap % ({ monthly: 1, quarterly: 3, yearly: 12 }[r.frequency] || 1) === 0;
}

// ------------------------------------------------------------------ analysis

// `entries`: typed and recurring entries; `linked`: { payroll: { 'YYYY-MM': amount }, ads: { … } }.
// Linked costs land on the last day of their month (payroll) or are spread by month (ads).
// `recurringDue`: what this month's recurring costs add up to, whether or not their day has come.
export function analyse({ month, months, entries, olderUnpaid = [], linked = {}, categories, today, recurringDue = 0 }) {
  const cats = [...categories, ...Object.entries(LINKED).map(([id, name]) => ({ id, name, kind: 'cost', budget: 0, linked: true }))];
  const kindOf = new Map(cats.map((c) => [c.id, c.kind]));
  const series = months.map((m) => {
    const rows = entries.filter((e) => e.date.startsWith(m));
    const byCat = {};
    let income = 0;
    let costs = 0;
    for (const e of rows) {
      byCat[e.category] = (byCat[e.category] || 0) + e.amount;
      if (e.type === 'income') income += e.amount;
      else costs += e.amount;
    }
    for (const id of Object.keys(LINKED)) {
      const v = linked[id]?.[m] || 0;
      if (v) {
        byCat[id] = (byCat[id] || 0) + v;
        costs += v;
      }
    }
    return { month: m, income: round2(income), costs: round2(costs), profit: round2(income - costs), byCategory: Object.fromEntries(Object.entries(byCat).map(([k, v]) => [k, round2(v)])) };
  });
  const cur = series.find((s) => s.month === month) || { income: 0, costs: 0, profit: 0, byCategory: {} };
  const prev = series.find((s) => s.month === addMonths(month, -1)) || null;
  const rows = entries.filter((e) => e.date.startsWith(month));
  const costRows = rows.filter((e) => e.type === 'cost');
  const budgetTotal = round2(categories.filter((c) => c.kind === 'cost').reduce((s, c) => s + c.budget, 0));
  const days = daysInMonth(month);
  const elapsed = today.slice(0, 7) > month ? days : today.slice(0, 7) < month ? 0 : Number(today.slice(8, 10));
  // Running total of the budgeted (typed and recurring) costs through the month, to set against the
  // budget's even pace. Payroll and ads have their own budgets in HR and Ads & budget.
  const perDay = Array(days).fill(0);
  for (const e of costRows) perDay[Number(e.date.slice(8, 10)) - 1] += e.amount;
  let run = 0;
  const cumulative = perDay.map((v, i) => ({ day: i + 1, total: (run = round2(run + v)), future: i + 1 > elapsed }));
  const group = (key) => {
    const map = new Map();
    for (const e of costRows) {
      const k = e[key] || '';
      if (!k) continue;
      const t = map.get(k) || { name: k, amount: 0, count: 0 };
      t.amount += e.amount;
      t.count += 1;
      map.set(k, t);
    }
    return [...map.values()].map((t) => ({ ...t, amount: round2(t.amount) })).sort((a, b) => b.amount - a.amount);
  };
  const categoriesOut = cats
    .map((c) => ({ id: c.id, name: c.name, kind: c.kind, linked: Boolean(c.linked), budget: c.budget, amount: cur.byCategory[c.id] || 0, previous: prev?.byCategory[c.id] || 0 }))
    .map((c) => ({ ...c, used: c.budget ? round2((c.amount / c.budget) * 100) : null, over: Boolean(c.budget && c.amount > c.budget) }));
  // Month-end forecast: recurring costs and payroll count once (they don't grow with the days);
  // everything else keeps its pace so far.
  function forecast() {
    if (!elapsed || elapsed >= days) return cur.costs;
    const typed = costRows.reduce((s, e) => s + e.amount, 0);
    const recurringSoFar = costRows.filter((e) => e.recurringId).reduce((s, e) => s + e.amount, 0);
    const variable = typed - recurringSoFar;
    const ads = linked.ads?.[month] || 0;
    const payroll = linked.payroll?.[month] || linked.payroll?.[addMonths(month, -1)] || 0;
    return round2(Math.max(recurringSoFar, recurringDue) + ((variable + ads) / elapsed) * days + payroll);
  }
  const unpaid = [...olderUnpaid, ...entries].filter((e) => e.type === 'cost' && e.status === 'unpaid').sort((a, b) => (a.dueDate || a.date).localeCompare(b.dueDate || b.date));
  const avgCosts = round2(series.filter((s) => s.month < month && s.costs).reduce((s, x, _, all) => s + x.costs / all.length, 0));
  return {
    month,
    series,
    totals: {
      income: cur.income,
      costs: cur.costs,
      profit: cur.profit,
      margin: cur.income ? round2((cur.profit / cur.income) * 100) : null,
      budget: budgetTotal,
      budgetUsed: budgetTotal ? round2((costRows.reduce((s, e) => s + e.amount, 0) / budgetTotal) * 100) : null,
      projected: forecast(),
      previous: prev ? { income: prev.income, costs: prev.costs, profit: prev.profit } : null,
      averageCosts: avgCosts,
      unpaid: round2(unpaid.reduce((s, e) => s + e.amount, 0)),
      unpaidCount: unpaid.length,
    },
    categories: categoriesOut.filter((c) => c.kind === 'cost' && (c.amount || c.budget || c.previous)).sort((a, b) => b.amount - a.amount || b.budget - a.budget),
    incomeCategories: categoriesOut.filter((c) => c.kind === 'income' && (c.amount || c.previous)).sort((a, b) => b.amount - a.amount),
    vendors: group('vendor').slice(0, 15),
    departments: group('department'),
    projects: group('project'),
    cumulative,
    days,
    elapsed,
    unpaid: unpaid.slice(0, 20),
  };
}
