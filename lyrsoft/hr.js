// Lyrsoft HR (#/w/<ws>/hr[/<tab>[/<id>]]), plugged into app.js like marketing.js. Employees, time and
// attendance (web check-in and biometric devices), leave, payroll with payslips, and HR settings.
// HR managers (workspace owners and admins, and people named in HR settings) see the whole team;
// everyone else sees "My time": their own check-in, attendance, leave and payslips.
const MANAGER_TABS = [
  ['overview', '📊 Overview'],
  ['employees', '👥 Employees'],
  ['attendance', '🕘 Attendance'],
  ['leave', '🌴 Leave'],
  ['payroll', '💰 Payroll'],
  ['me', '🙋 My time'],
  ['settings', '⚙ Settings'],
];
const SELF_TABS = [
  ['me', '🙋 My time'],
  ['leave', '🌴 My leave'],
  ['payslips', '💰 Payslips'],
];
const STATUS = {
  present: ['Present', 'P'],
  late: ['Late', 'L'],
  half: ['Half day', 'H'],
  absent: ['Absent', 'A'],
  leave: ['On leave', 'LV'],
  unpaid: ['Unpaid leave', 'U'],
  off: ['Day off', '–'],
  holiday: ['Holiday', 'HD'],
  pending: ['Not in yet', '·'],
  upcoming: ['', ''],
  untracked: ['Before HR started', ''],
  none: ['', ''],
};
const LEAVE_TYPES = { annual: 'Annual', sick: 'Sick', casual: 'Casual', maternity: 'Maternity', unpaid: 'Unpaid', other: 'Other' };
const LEAVE_STATUS = { pending: 'Waiting', approved: 'Approved', rejected: 'Rejected', cancelled: 'Cancelled' };
const PAY_STATUS = { draft: 'Draft', final: 'Final', paid: 'Paid' };
const WEEKDAYS = [['sat', 'Sat'], ['sun', 'Sun'], ['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri']];
const EMPLOYMENT = { 'full-time': 'Full time', 'part-time': 'Part time', contract: 'Contract', intern: 'Intern' };
const SALARY_PARTS = [['basic', 'Basic'], ['house', 'House rent'], ['medical', 'Medical'], ['transport', 'Transport'], ['food', 'Food'], ['other', 'Other allowance']];

export function createHR({ api, esc, toast, render, go, formatDateTime, getMe }) {
  const h = { ws: null, overview: null, employees: null, day: null, report: null, month: null, leave: null, runs: null, run: null, payslips: null, devices: null, query: '', dept: '', reportMode: false, leaveFilter: 'pending' };
  let route = null;
  let clock = null;

  const base = () => `#/w/${encodeURIComponent(h.ws)}/hr`;
  const path = (p = '') => `/workspaces/${encodeURIComponent(h.ws)}/hr${p}`;
  const o = () => h.overview;
  const isManager = () => Boolean(h.overview?.manager);
  const cur = () => o()?.settings.currency || 'BDT';
  const money = (n) => `${cur()} ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
  const num = (n) => Number(n || 0).toLocaleString();
  const hours = (min) => (min ? `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m` : '—');
  const monthName = (m) => new Date(`${m}-01T00:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const dayName = (d) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  const shiftMonth = (m, n) => {
    const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + n, 1));
    return d.toISOString().slice(0, 7);
  };
  const shiftDay = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  const badge = (status) => (STATUS[status]?.[0] ? `<span class="hr-badge hr-${esc(status)}">${esc(STATUS[status][0])}</span>` : '');
  const initials = (name) => esc(String(name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase());
  const person = (e, sub = '') => `<span class="hr-person"><span class="hr-avatar" aria-hidden="true">${initials(e.name)}</span><span><b>${esc(e.name)}</b><small>${esc(sub || [e.code, e.designation || e.department].filter(Boolean).join(' · '))}</small></span></span>`;
  const tile = (label, value, sub = '', tone = '') => `<div class="panel stat hr-tile${tone ? ` hr-tone-${tone}` : ''}"><span>${label}</span><b>${value}</b>${sub ? `<small class="muted">${sub}</small>` : ''}</div>`;

  // ---------------------------------------------------------------- loading

  async function load(next) {
    route = next;
    if (next.view !== 'hr') return stopClock();
    if (h.ws !== next.ws) Object.assign(h, { ws: next.ws, overview: null, employees: null, day: null, report: null, month: null, leave: null, runs: null, run: null, payslips: null, devices: null, query: '', dept: '' });
    h.overview = await api('GET', path());
    const tab = currentTab();
    const p = next.params;
    if (isManager() && ['employees', 'attendance', 'payroll', 'leave'].includes(tab) && !h.employees) h.employees = (await api('GET', path('/employees'))).employees;
    if (tab === 'employees' && next.id) h.month = await api('GET', path(`/attendance/month?emp=${encodeURIComponent(next.id)}&month=${p.get('month') || o().today.slice(0, 7)}`));
    if (tab === 'attendance') {
      const date = p.get('date') || o().today;
      const month = p.get('month') || date.slice(0, 7);
      h.reportMode = p.get('view') === 'month';
      if (h.reportMode) h.report = await api('GET', path(`/attendance/report?month=${month}`));
      else h.day = await api('GET', path(`/attendance?date=${date}`));
    }
    if (tab === 'me' && o().self) h.month = await api('GET', path(`/attendance/month?month=${p.get('month') || o().today.slice(0, 7)}`));
    if (tab === 'leave') h.leave = await api('GET', path(`/leave?year=${p.get('year') || o().today.slice(0, 4)}`));
    if (tab === 'payroll') {
      h.runs = (await api('GET', path('/payroll'))).runs;
      const month = next.id;
      h.run = month ? await api('GET', path(`/payroll/${month}`)).then((r) => r.run).catch(() => ({ month, missing: true })) : null;
    }
    if (tab === 'payslips' || (tab === 'me' && o().self)) h.payslips = (await api('GET', path('/me/payslips'))).payslips;
    if (tab === 'settings' && isManager()) h.devices = (await api('GET', path('/devices'))).devices;
  }

  function currentTab() {
    const tabs = isManager() ? MANAGER_TABS : SELF_TABS;
    const tab = route?.tab && route.tab !== 'overview' ? route.tab : tabs[0][0];
    return tabs.some(([id]) => id === tab) ? tab : tabs[0][0];
  }

  const ready = (r) => r.view !== 'hr' || Boolean(h.overview && h.ws === r.ws);

  // ---------------------------------------------------------------- shell

  function view() {
    const tab = currentTab();
    const tabs = isManager() ? MANAGER_TABS : SELF_TABS;
    const company = o().settings.company || o().workspace.name;
    const body = {
      overview: overviewView,
      employees: () => (route.id ? employeeView() : employeesView()),
      attendance: attendanceView,
      leave: leaveView,
      payroll: payrollView,
      payslips: payslipsView,
      me: meView,
      settings: settingsView,
    }[tab]();
    setTimeout(startClock);
    return `
      <div class="page-head"><div><h1>HR · ${esc(company)}</h1><p>${isManager() ? 'Employees, time and attendance, leave and payroll.' : 'Your check-in, attendance, leave and payslips.'}</p></div></div>
      <nav class="segmented hr-tabs" aria-label="HR">${tabs.map(([id, label]) => `<a href="${base()}/${id}"${tab === id ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>
      <div class="hr-body">${body}</div>`;
  }

  // ---------------------------------------------------------------- overview (managers)

  function overviewView() {
    const s = o().stats;
    const noEmployees = !s.employees && !s.inactive;
    return `
      ${noEmployees ? `<section class="panel hr-welcome"><h2>Set up HR in three steps</h2><ol>
        <li><b>Check your work rules</b>: shift, days off, holidays, leave allowances. <a href="${base()}/settings">Settings</a></li>
        <li><b>Add your employees</b> with their salary. Use their Lyrsoft sign-in email so they can check in themselves. <button class="btn small primary" data-click="hr-new-employee">+ Add employee</button></li>
        <li><b>Run payroll</b> at the end of the month: attendance, leave and overtime are counted for you.</li></ol></section>` : ''}
      <div class="stat-row">
        ${tile('Employees', num(s.employees), s.departments ? `${s.departments} department${s.departments === 1 ? '' : 's'}` : '')}
        ${tile('In today', num(s.present + s.late), s.late ? `${s.late} late` : 'on time', 'ok')}
        ${tile('Not in yet', num(s.notIn), s.absent ? `${s.absent} absent` : '', s.notIn ? 'warn' : '')}
        ${tile('On leave', num(s.leave), s.off ? `${s.off} off today` : '')}
        ${tile('Leave requests', num(s.pendingLeave), 'waiting for you', s.pendingLeave ? 'warn' : '')}
        ${tile('Monthly salaries', money(s.monthlyGross), 'gross, active employees')}
      </div>
      <div class="hr-grid">
        <section class="panel">
          <div class="panel-head spread"><h2>Today · ${esc(dayName(o().today))}</h2><a class="btn small" href="${base()}/attendance">Open attendance</a></div>
          <p class="muted">${num(s.present + s.late)} of ${num(s.employees)} checked in${s.checkedOut ? `, ${num(s.checkedOut)} checked out` : ''}.</p>
          <div class="hr-meter" role="img" aria-label="Attendance today">${['present', 'late', 'leave', 'notIn', 'absent', 'off'].map((k) => (s[k] ? `<span class="hr-seg hr-seg-${k}" style="flex:${s[k]}" title="${k}: ${s[k]}"></span>` : '')).join('') || '<span class="hr-seg hr-seg-empty" style="flex:1"></span>'}</div>
          <p class="hr-legend"><span class="hr-dot hr-seg-present"></span>Present <span class="hr-dot hr-seg-late"></span>Late <span class="hr-dot hr-seg-leave"></span>Leave <span class="hr-dot hr-seg-notIn"></span>Not in <span class="hr-dot hr-seg-absent"></span>Absent</p>
        </section>
        <section class="panel">
          <div class="panel-head spread"><h2>Leave requests</h2><a class="btn small" href="${base()}/leave">All leave</a></div>
          ${o().recentLeave.length ? `<ul class="hr-list">${o().recentLeave.map((l) => `<li>${person(l.employee, `${LEAVE_TYPES[l.type]} · ${l.from === l.to ? dayName(l.from) : `${dayName(l.from)} – ${dayName(l.to)}`} · ${l.days} day${l.days === 1 ? '' : 's'}`)}<span class="row"><button class="btn small primary" data-click="hr-leave-decide" data-id="${esc(l.id)}" data-status="approved">Approve</button><button class="btn small" data-click="hr-leave-decide" data-id="${esc(l.id)}" data-status="rejected">Reject</button></span></li>`).join('')}</ul>` : '<p class="muted">No requests waiting.</p>'}
        </section>
        <section class="panel">
          <div class="panel-head spread"><h2>Payroll</h2><a class="btn small" href="${base()}/payroll">Open payroll</a></div>
          ${o().lastPayroll ? `<p><b>${esc(monthName(o().lastPayroll.month))}</b> ${payBadge(o().lastPayroll.status)}</p><p class="hr-big">${money(o().lastPayroll.totals.net)}</p><p class="muted">net pay for ${num(o().lastPayroll.totals.employees)} employees</p>` : `<p class="muted">No payroll yet.</p><button class="btn small primary" data-click="hr-run-payroll" data-month="${esc(o().today.slice(0, 7))}">Prepare ${esc(monthName(o().today.slice(0, 7)))}</button>`}
        </section>
        <section class="panel">
          <h2>Coming up</h2>
          ${o().upcomingHolidays.length || o().birthdays.length ? `<ul class="hr-list plain">${o().upcomingHolidays.map((x) => `<li>🎉 <b>${esc(x.name)}</b><small class="muted">${esc(dayName(x.date))}</small></li>`).join('')}${o().birthdays.map((b) => `<li>🎂 <b>${esc(b.name)}</b><small class="muted">birthday ${esc(b.date)}</small></li>`).join('')}</ul>` : `<p class="muted">No holidays or birthdays coming up. <a href="${base()}/settings">Add holidays</a></p>`}
        </section>
      </div>`;
  }

  // ---------------------------------------------------------------- employees

  function employeesView() {
    const list = h.employees || [];
    const q = h.query.trim().toLowerCase();
    const depts = [...new Set(list.map((e) => e.department).filter(Boolean))].sort();
    const shown = list.filter((e) => (!h.dept || e.department === h.dept) && (!q || [e.name, e.code, e.email, e.phone, e.department, e.designation].some((v) => String(v || '').toLowerCase().includes(q))));
    return `
      <div class="hr-toolbar">
        <input type="search" class="hr-search" placeholder="Search name, ID, email, phone…" value="${esc(h.query)}" data-input="hr-search" aria-label="Search employees" />
        ${depts.length ? `<select data-change="hr-dept" aria-label="Department"><option value="">All departments</option>${depts.map((d) => `<option${d === h.dept ? ' selected' : ''}>${esc(d)}</option>`).join('')}</select>` : ''}
        <span class="spacer"></span>
        <button class="btn" data-click="hr-export-employees">⬇ Export</button>
        <button class="btn primary" data-click="hr-new-employee">+ Add employee</button>
      </div>
      <section class="panel flush">
        ${list.length ? `<div class="table-scroll"><table class="data-table hr-table">
          <thead><tr><th>Employee</th><th>Department</th><th>Type</th><th>Joined</th><th>Contact</th><th class="num">Gross salary</th><th>Status</th></tr></thead>
          <tbody>${shown.map((e) => `<tr class="hr-click${e.status === 'inactive' ? ' is-disabled' : ''}" data-click="hr-open-employee" data-id="${esc(e.id)}">
            <td>${person(e)}</td><td>${esc(e.department || '—')}</td><td>${esc(EMPLOYMENT[e.type] || '')}</td><td>${esc(e.joinDate || '—')}</td>
            <td><small>${esc(e.phone || '')}${e.phone && e.email ? '<br>' : ''}${esc(e.email || '')}</small></td>
            <td class="num">${money(gross(e))}</td><td>${e.status === 'active' ? '<span class="hr-badge hr-present">Active</span>' : '<span class="hr-badge hr-off">Inactive</span>'}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No one matches.</td></tr>'}</tbody></table></div>`
          : '<div class="hr-empty"><p>No employees yet.</p><button class="btn primary" data-click="hr-new-employee">+ Add your first employee</button></div>'}
      </section>`;
  }

  const gross = (e) => SALARY_PARTS.reduce((s, [k]) => s + (Number(e.salary?.[k]) || 0), 0);

  function employeeView() {
    const e = (h.employees || []).find((x) => x.id === route.id);
    if (!e) return `<section class="panel empty"><p>Employee not found.</p><a class="btn" href="${base()}/employees">Back to employees</a></section>`;
    const m = h.month;
    const field = (label, value) => (value ? `<div><dt>${label}</dt><dd>${esc(value)}</dd></div>` : '');
    return `
      <p><a href="${base()}/employees">← All employees</a></p>
      <section class="panel hr-profile">
        <div class="hr-profile-head">
          <span class="hr-avatar big" aria-hidden="true">${initials(e.name)}</span>
          <div><h2>${esc(e.name)}</h2><p class="muted">${esc([e.designation, e.department, e.code].filter(Boolean).join(' · '))}</p>${e.status === 'inactive' ? '<span class="hr-badge hr-off">Inactive</span>' : ''}</div>
          <span class="spacer"></span>
          <button class="btn" data-click="hr-add-leave" data-emp="${esc(e.id)}">🌴 Add leave</button>
          <button class="btn primary" data-click="hr-edit-employee" data-id="${esc(e.id)}">Edit</button>
        </div>
        <div class="hr-cols">
          <dl class="hr-facts"><h3>Job</h3>${field('Employee ID', e.code)}${field('Type', EMPLOYMENT[e.type])}${field('Joined', e.joinDate)}${field('Last day', e.leaveDate)}${field('Shift', e.shiftStart && e.shiftEnd ? `${e.shiftStart} – ${e.shiftEnd}` : `${o().settings.shiftStart} – ${o().settings.shiftEnd} (company)`)}${field('Device ID', e.deviceUserId)}</dl>
          <dl class="hr-facts"><h3>Contact</h3>${field('Email', e.email)}${field('Phone', e.phone)}${field('Address', e.address)}${field('Emergency contact', e.emergencyContact)}${field('Birthday', e.birthday)}${field('National ID', e.nationalId)}</dl>
          <dl class="hr-facts"><h3>Salary</h3>${SALARY_PARTS.map(([k, label]) => (e.salary?.[k] ? `<div><dt>${label}</dt><dd>${money(e.salary[k])}</dd></div>` : '')).join('')}<div><dt><b>Gross</b></dt><dd><b>${money(gross(e))}</b></dd></div>${e.salary?.taxPercent ? `<div><dt>Tax</dt><dd>${e.salary.taxPercent}%</dd></div>` : ''}${e.salary?.pfPercent ? `<div><dt>Provident fund</dt><dd>${e.salary.pfPercent}% of basic</dd></div>` : ''}${field('Bank', [e.bankName, e.bankAccount].filter(Boolean).join(' · '))}</dl>
        </div>
        ${e.notes ? `<p class="hr-notes">${esc(e.notes)}</p>` : ''}
      </section>
      ${m ? monthPanel(m, `${base()}/employees/${encodeURIComponent(e.id)}`, true) : ''}`;
  }

  // A month of one person's attendance: totals and a calendar.
  function monthPanel(m, link, editable) {
    const s = m.summary;
    const first = new Date(`${m.month}-01T00:00:00Z`).getUTCDay(); // 0 = Sunday
    const lead = (first + 1) % 7; // the calendar starts on Saturday
    return `
      <section class="panel">
        <div class="panel-head spread"><h2>${esc(monthName(m.month))}</h2>
          <span class="row"><a class="btn small" href="${link}?month=${shiftMonth(m.month, -1)}" aria-label="Previous month">‹</a><a class="btn small" href="${link}?month=${shiftMonth(m.month, 1)}" aria-label="Next month">›</a></span></div>
        <div class="hr-chips">
          <span class="hr-badge hr-present">Present ${s.present}</span><span class="hr-badge hr-late">Late ${s.late}</span>${s.half ? `<span class="hr-badge hr-half">Half day ${s.half}</span>` : ''}<span class="hr-badge hr-absent">Absent ${s.absent}</span><span class="hr-badge hr-leave">Leave ${s.leave + s.unpaid}</span>
          <span class="muted">Worked ${hours(s.worked)} · Overtime ${hours(s.overtime)}${s.lateMinutes ? ` · Late by ${hours(s.lateMinutes)} in total` : ''}</span>
        </div>
        <div class="hr-cal">
          ${WEEKDAYS.map(([, d]) => `<span class="hr-cal-head">${d}</span>`).join('')}
          ${'<span></span>'.repeat(lead)}
          ${m.days.map((d) => `<${editable ? 'button type="button" data-click="hr-edit-day" data-date="' + esc(d.date) + '" data-emp="' + esc(m.employee.id) + '"' : 'div'} class="hr-cal-day hr-${esc(d.status)}${d.date === o().today ? ' is-today' : ''}" title="${esc(STATUS[d.status]?.[0] || '')}${d.holiday ? ` · ${esc(d.holiday)}` : ''}${d.note ? ` · ${esc(d.note)}` : ''}">
            <b>${Number(d.date.slice(8))}</b><small>${d.in ? `${esc(d.in)}${d.out ? `–${esc(d.out)}` : ''}` : esc(STATUS[d.status]?.[1] || '')}</small>${d.overtime ? `<i>+${hours(d.overtime)}</i>` : ''}${d.edited ? '<em title="Edited by a manager">✎</em>' : ''}</${editable ? 'button' : 'div'}>`).join('')}
        </div>
      </section>`;
  }

  async function employeeDialog(existing) {
    const e = existing || { salary: {}, type: 'full-time', status: 'active', joinDate: o().today };
    const f = (name, label, value = '', attrs = '') => `<label>${label}<input name="${name}" value="${esc(value ?? '')}" ${attrs} /></label>`;
    const node = document.createElement('dialog');
    node.className = 'dialog wide hr-dialog';
    node.innerHTML = `<form>
      <h2>${existing ? `Edit ${esc(e.name)}` : 'Add employee'}</h2>
      <fieldset><legend>Person</legend><div class="form-grid">
        ${f('name', 'Full name *', e.name, 'required maxlength="120" autocomplete="off"')}
        ${f('code', 'Employee ID', e.code, `maxlength="30" placeholder="${existing ? '' : 'Automatic, e.g. E001'}"`)}
        ${f('email', 'Email (their Lyrsoft sign-in)', e.email, 'type="email" maxlength="254" placeholder="For self check-in"')}
        ${f('phone', 'Mobile', e.phone, 'type="tel" maxlength="40"')}
        ${f('birthday', 'Birthday', e.birthday, 'type="date"')}
        <label>Gender<select name="gender">${['', 'Female', 'Male', 'Other'].map((g) => `<option${g === (e.gender || '') ? ' selected' : ''}>${g}</option>`).join('')}</select></label>
        ${f('nationalId', 'National ID', e.nationalId, 'maxlength="40"')}
        ${f('emergencyContact', 'Emergency contact', e.emergencyContact, 'maxlength="160" placeholder="Name and phone"')}
      </div><label>Address<textarea name="address" rows="2" maxlength="400">${esc(e.address || '')}</textarea></label></fieldset>
      <fieldset><legend>Job</legend><div class="form-grid">
        ${f('department', 'Department', e.department, `maxlength="80" list="hr-depts"`)}
        ${f('designation', 'Designation', e.designation, 'maxlength="80"')}
        <label>Type<select name="type">${Object.entries(EMPLOYMENT).map(([k, v]) => `<option value="${k}"${k === e.type ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
        <label>Status<select name="status"><option value="active"${e.status !== 'inactive' ? ' selected' : ''}>Active</option><option value="inactive"${e.status === 'inactive' ? ' selected' : ''}>Inactive</option></select></label>
        ${f('joinDate', 'Joining date', e.joinDate, 'type="date"')}
        ${f('leaveDate', 'Last working day', e.leaveDate, 'type="date"')}
        ${f('shiftStart', 'Own shift start', e.shiftStart, `type="time" placeholder="${esc(o().settings.shiftStart)}"`)}
        ${f('shiftEnd', 'Own shift end', e.shiftEnd, `type="time"`)}
        ${f('deviceUserId', 'Biometric device ID', e.deviceUserId, 'maxlength="30" placeholder="Their number on the fingerprint/face device"')}
      </div>
      <datalist id="hr-depts">${[...new Set((h.employees || []).map((x) => x.department).filter(Boolean))].map((d) => `<option value="${esc(d)}"></option>`).join('')}</datalist>
      <p class="muted small">Leave the shift empty to use the company’s (${esc(o().settings.shiftStart)} – ${esc(o().settings.shiftEnd)}).</p></fieldset>
      <fieldset><legend>Salary per month (${esc(cur())})</legend><div class="form-grid hr-salary">
        ${SALARY_PARTS.map(([k, label]) => f(`salary.${k}`, label, e.salary?.[k] || '', 'inputmode="decimal" placeholder="0"')).join('')}
        ${f('salary.taxPercent', 'Tax (% of gross)', e.salary?.taxPercent || '', 'inputmode="decimal" placeholder="0"')}
        ${f('salary.pfPercent', 'Provident fund (% of basic)', e.salary?.pfPercent || '', 'inputmode="decimal" placeholder="0"')}
        ${f('salary.overtimeHourly', 'Overtime per hour', e.salary?.overtimeHourly || '', `inputmode="decimal" placeholder="Automatic: basic ÷ ${o().settings.daysPerMonth * 8} × ${o().settings.overtimeMultiplier}"`)}
        <label class="check"><input type="checkbox" name="salary.overtimeEligible"${e.salary?.overtimeEligible === false ? '' : ' checked'} /> Gets overtime</label>
      </div><p class="hr-gross">Gross: <b data-gross>${money(gross(e))}</b></p></fieldset>
      <fieldset><legend>Bank</legend><div class="form-grid">${f('bankName', 'Bank / mobile banking', e.bankName, 'maxlength="80" placeholder="e.g. BRAC Bank, bKash"')}${f('bankAccount', 'Account number', e.bankAccount, 'maxlength="60"')}</div></fieldset>
      <label>Notes<textarea name="notes" rows="2" maxlength="2000">${esc(e.notes || '')}</textarea></label>
      <p class="auth-error" hidden></p>
      <div class="row end">${existing ? '<button type="button" class="btn danger" data-delete>Delete</button><span class="spacer"></span>' : ''}<button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">${existing ? 'Save' : 'Add employee'}</button></div>
    </form>`;
    document.body.append(node);
    const form = node.querySelector('form');
    const error = node.querySelector('.auth-error');
    node.addEventListener('close', () => node.remove());
    node.querySelector('[data-cancel]').addEventListener('click', () => node.close());
    form.addEventListener('input', () => {
      const sum = SALARY_PARTS.reduce((s, [k]) => s + (Number(String(form.elements[`salary.${k}`].value).replace(/[,\s]/g, '')) || 0), 0);
      node.querySelector('[data-gross]').textContent = money(sum);
    });
    node.querySelector('[data-delete]')?.addEventListener('click', async () => {
      if (!confirm(`Delete ${e.name} with all their attendance and leave? To keep their history, set them to Inactive instead.`)) return;
      try {
        await api('DELETE', path(`/employees/${encodeURIComponent(e.id)}`));
        node.close();
        h.employees = h.employees.filter((x) => x.id !== e.id);
        toast(`${e.name} deleted`);
        go(`${base()}/employees`);
      } catch (err) {
        toast(err.message);
      }
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const body = { salary: {} };
      for (const [k, v] of data) {
        if (k.startsWith('salary.')) body.salary[k.slice(7)] = v;
        else body[k] = String(v).trim();
      }
      body.salary.overtimeEligible = data.get('salary.overtimeEligible') === 'on';
      const button = form.querySelector('button.primary');
      button.disabled = true;
      try {
        const { employee } = existing ? await api('PATCH', path(`/employees/${encodeURIComponent(e.id)}`), body) : await api('POST', path('/employees'), body);
        node.close();
        h.employees = [...(h.employees || []).filter((x) => x.id !== employee.id), employee];
        toast(existing ? 'Saved' : `${employee.name} added as ${employee.code}`);
        if (existing) render();
        else go(`${base()}/employees/${encodeURIComponent(employee.id)}`);
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
        button.disabled = false;
        error.scrollIntoView({ block: 'nearest' });
      }
    });
    node.showModal();
  }

  // ---------------------------------------------------------------- attendance

  function attendanceView() {
    const toggle = `<nav class="segmented small"><a href="${base()}/attendance?date=${esc(h.day?.date || o().today)}"${h.reportMode ? '' : ' aria-current="page"'}>Daily</a><a href="${base()}/attendance?view=month&month=${esc(h.report?.month || o().today.slice(0, 7))}"${h.reportMode ? ' aria-current="page"' : ''}>Monthly report</a></nav>`;
    return h.reportMode ? reportView(toggle) : dailyView(toggle);
  }

  function dailyView(toggle) {
    const d = h.day;
    const rows = d.rows;
    const count = (s) => rows.filter((r) => r.day.status === s).length;
    return `
      <div class="hr-toolbar">${toggle}
        <span class="row"><a class="btn small" href="${base()}/attendance?date=${shiftDay(d.date, -1)}" aria-label="Previous day">‹</a>
        <input type="date" value="${esc(d.date)}" data-change="hr-date" aria-label="Date" />
        <a class="btn small" href="${base()}/attendance?date=${shiftDay(d.date, 1)}" aria-label="Next day">›</a>${d.date !== d.today ? `<a class="btn small" href="${base()}/attendance">Today</a>` : ''}</span>
        <span class="spacer"></span><button class="btn" data-click="hr-export-day">⬇ Export</button></div>
      <p class="hr-chips"><b>${esc(dayName(d.date))}</b> <span class="hr-badge hr-present">Present ${count('present') + count('half')}</span><span class="hr-badge hr-late">Late ${count('late')}</span><span class="hr-badge hr-absent">Absent ${count('absent')}</span><span class="hr-badge hr-leave">Leave ${count('leave') + count('unpaid')}</span>${count('pending') ? `<span class="hr-badge hr-pending">Not in yet ${count('pending')}</span>` : ''}</p>
      <section class="panel flush">${rows.length ? `<div class="table-scroll"><table class="data-table hr-table">
        <thead><tr><th>Employee</th><th>Status</th><th>In</th><th>Out</th><th>Worked</th><th>Overtime</th><th>Punches</th><th></th></tr></thead>
        <tbody>${rows.map(({ employee: e, day }) => `<tr>
          <td>${person(e)}</td><td>${badge(day.status)}${day.lateBy ? `<small class="muted"> ${day.lateBy} min</small>` : ''}${day.holiday ? `<small class="muted"> ${esc(day.holiday)}</small>` : ''}${day.leaveType ? `<small class="muted"> ${esc(LEAVE_TYPES[day.leaveType])}</small>` : ''}</td>
          <td>${esc(day.in || '—')}</td><td>${esc(day.out || '—')}</td><td>${hours(day.worked)}</td><td>${day.overtime ? hours(day.overtime) : '—'}</td>
          <td><small class="muted">${day.punches.map((p) => `${esc(p.time)} ${p.source === 'device' ? '🖐' : p.source === 'web' ? '💻' : '✎'}${p.geo ? '📍' : ''}`).join(', ') || ''}${day.edited ? ` ✎ ${esc(day.note || 'edited')}` : ''}</small></td>
          <td><button class="btn small" data-click="hr-edit-day" data-date="${esc(d.date)}" data-emp="${esc(e.id)}">Edit</button></td></tr>`).join('')}</tbody></table></div>`
        : `<div class="hr-empty"><p>No employees on this day.</p><a class="btn primary" href="${base()}/employees">Add employees</a></div>`}</section>
      <p class="muted small">💻 web check-in · 🖐 biometric device · ✎ edited by a manager · 📍 with location</p>`;
  }

  function reportView(toggle) {
    const r = h.report;
    const days = r.rows[0]?.marks.length || 0;
    return `
      <div class="hr-toolbar">${toggle}
        <span class="row"><a class="btn small" href="${base()}/attendance?view=month&month=${shiftMonth(r.month, -1)}" aria-label="Previous month">‹</a><b>${esc(monthName(r.month))}</b><a class="btn small" href="${base()}/attendance?view=month&month=${shiftMonth(r.month, 1)}" aria-label="Next month">›</a></span>
        <span class="spacer"></span><button class="btn" data-click="hr-export-report">⬇ Export</button></div>
      <section class="panel flush"><div class="table-scroll"><table class="data-table hr-table hr-report">
        <thead><tr><th>Employee</th>${Array.from({ length: days }, (_, i) => `<th class="hr-mark-h">${i + 1}</th>`).join('')}<th class="num">P</th><th class="num">L</th><th class="num">A</th><th class="num">Leave</th><th class="num">Worked</th><th class="num">OT</th></tr></thead>
        <tbody>${r.rows.map(({ employee: e, summary: s, marks }) => `<tr><td><a href="${base()}/employees/${encodeURIComponent(e.id)}?month=${r.month}">${esc(e.name)}</a><small class="muted"> ${esc(e.code || '')}</small></td>
          ${marks.map((m) => `<td class="hr-mark hr-${esc(m)}" title="${esc(STATUS[m]?.[0] || '')}">${esc(STATUS[m]?.[1] || '')}</td>`).join('')}
          <td class="num">${s.present + s.half}</td><td class="num">${s.late}</td><td class="num">${s.absent}</td><td class="num">${s.leave + s.unpaid}</td><td class="num">${hours(s.worked)}</td><td class="num">${hours(s.overtime)}</td></tr>`).join('') || `<tr><td class="muted" colspan="${days + 7}">No employees this month.</td></tr>`}</tbody></table></div></section>
      <p class="muted small">P present · L late · H half day · A absent · LV leave · U unpaid · HD holiday · – day off</p>`;
  }

  async function editDay(date, empId) {
    const row = h.day?.date === date ? h.day.rows.find((r) => r.employee.id === empId) : null;
    const fromMonth = h.month?.employee.id === empId ? h.month.days.find((d) => d.date === date) : null;
    const day = row?.day || fromMonth || {};
    const emp = row?.employee || h.month?.employee || (h.employees || []).find((e) => e.id === empId) || { name: '' };
    const node = document.createElement('dialog');
    node.className = 'dialog';
    node.innerHTML = `<form><h2>${esc(emp.name)} · ${esc(dayName(date))}</h2>
      <p class="muted">${day.punches?.length ? `Punches: ${day.punches.map((p) => esc(p.time)).join(', ')}` : 'No punches this day.'}</p>
      <div class="form-grid"><label>In<input type="time" name="in" value="${esc(day.in || '')}" /></label><label>Out<input type="time" name="out" value="${esc(day.out || '')}" /></label></div>
      <label>Mark as<select name="status"><option value="">Work it out from the times</option>${['present', 'late', 'half', 'absent', 'leave', 'unpaid', 'off', 'holiday'].map((s) => `<option value="${s}"${day.edited && day.status === s ? ' selected' : ''}>${STATUS[s][0]}</option>`).join('')}</select></label>
      <label>Note<input name="note" maxlength="300" value="${esc(day.note || '')}" placeholder="Why it was changed" /></label>
      <p class="auth-error" hidden></p>
      <div class="row end">${day.edited ? '<button type="button" class="btn" data-clear>Undo edit</button><span class="spacer"></span>' : ''}<button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">Save</button></div></form>`;
    document.body.append(node);
    const form = node.querySelector('form');
    node.addEventListener('close', () => node.remove());
    node.querySelector('[data-cancel]').addEventListener('click', () => node.close());
    const save = async (body) => {
      try {
        await api('PATCH', path(`/attendance/${date}/${encodeURIComponent(empId)}`), body);
        node.close();
        toast('Attendance updated');
        await load(route);
        render();
      } catch (err) {
        const e = node.querySelector('.auth-error');
        e.textContent = err.message;
        e.hidden = false;
      }
    };
    node.querySelector('[data-clear]')?.addEventListener('click', () => save({ clear: true }));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      save(Object.fromEntries(new FormData(form)));
    });
    node.showModal();
  }

  // ---------------------------------------------------------------- my time (everyone)

  function meView() {
    const self = o().self;
    if (!self) {
      return `<section class="panel hr-empty"><h2>You aren’t on the employee list here</h2><p class="muted">Ask HR to add you with your sign-in email (<b>${esc(getMe()?.email || '')}</b>). Then you can check in and out, see your attendance, ask for leave and read your payslips here.</p>${isManager() ? `<button class="btn primary" data-click="hr-new-employee">+ Add employees</button>` : ''}</section>`;
    }
    const d = o().myDay;
    const s = o().settings;
    const inNow = d.punches.length % 2 === 1;
    const b = o().myBalance;
    return `
      <div class="hr-grid">
        <section class="panel hr-punch">
          <p class="muted">${esc(dayName(o().today))} · shift ${esc(self.shiftStart || s.shiftStart)} – ${esc(self.shiftEnd || s.shiftEnd)}</p>
          <p class="hr-clock" data-tz="${esc(s.timezone)}">--:--:--</p>
          ${badge(d.status)}${d.lateBy ? ` <small class="muted">${d.lateBy} min late</small>` : ''}
          ${s.webCheckIn ? `<button class="hr-punch-btn${inNow ? ' out' : ''}" data-click="hr-punch">${inNow ? 'Check out' : d.punches.length ? 'Check in again' : 'Check in'}</button>` : '<p class="muted">Check in on the attendance device.</p>'}
          <p class="hr-times"><span>In <b>${esc(d.in || '—')}</b></span><span>Out <b>${esc(d.out || '—')}</b></span><span>Worked <b>${hours(d.worked)}</b></span></p>
          ${d.punches.length ? `<p class="muted small">Punches today: ${d.punches.map((p) => `${esc(p.time)}${p.source === 'device' ? ' 🖐' : ''}`).join(' · ')}</p>` : ''}
          ${s.requireLocation ? '<p class="muted small">📍 Your location is recorded with each check-in.</p>' : ''}
        </section>
        <section class="panel">
          <div class="panel-head spread"><h2>My leave ${esc(o().today.slice(0, 4))}</h2><button class="btn small primary" data-click="hr-add-leave">Ask for leave</button></div>
          <div class="hr-balances">${Object.entries(b).filter(([k, v]) => k !== 'unpaid' && v.allowed && (k !== 'maternity' || self.gender === 'Female' || v.used || v.pending)).map(([k, v]) => `<div><span>${LEAVE_TYPES[k]}</span><b>${v.left}</b><small class="muted">of ${v.allowed} left${v.pending ? ` · ${v.pending} waiting` : ''}</small></div>`).join('')}</div>
          ${o().myPendingLeave ? `<p class="muted">${o().myPendingLeave} request${o().myPendingLeave === 1 ? '' : 's'} waiting. <a href="${base()}/leave">See them</a></p>` : ''}
        </section>
        <section class="panel">
          <div class="panel-head spread"><h2>Payslips</h2>${h.payslips?.length ? `<a class="btn small" href="${base()}/payslips">All</a>` : ''}</div>
          ${h.payslips?.length ? `<p><b>${esc(monthName(h.payslips[0].month))}</b> ${payBadge(h.payslips[0].status)}</p><p class="hr-big">${money(h.payslips[0].line.net)}</p><button class="btn small" data-click="hr-payslip" data-month="${esc(h.payslips[0].month)}" data-self="1">View payslip</button>` : '<p class="muted">No payslips yet.</p>'}
        </section>
      </div>
      ${h.month ? monthPanel(h.month, `${base()}/me`, false) : ''}`;
  }

  function startClock() {
    stopClock();
    const node = document.querySelector('.hr-clock');
    if (!node) return;
    const fmt = new Intl.DateTimeFormat(undefined, { timeZone: node.dataset.tz, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const tick = () => {
      if (!node.isConnected) return stopClock();
      node.textContent = fmt.format(new Date());
    };
    tick();
    clock = setInterval(tick, 1000);
  }
  function stopClock() {
    clearInterval(clock);
    clock = null;
  }

  const where = () =>
    new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition((p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }), () => resolve(null), { timeout: 8000, maximumAge: 60000, enableHighAccuracy: true });
    });

  // ---------------------------------------------------------------- leave

  function leaveView() {
    const L = h.leave;
    const list = L.leaves.filter((l) => !isManager() || h.leaveFilter === 'all' || l.status === h.leaveFilter);
    const year = Number(L.year);
    return `
      <div class="hr-toolbar">
        ${isManager() ? `<nav class="segmented small">${['pending', 'approved', 'all'].map((f) => `<a role="button" tabindex="0" data-click="hr-leave-filter" data-filter="${f}"${h.leaveFilter === f ? ' aria-current="page"' : ''}>${f === 'pending' ? `Waiting (${L.leaves.filter((l) => l.status === 'pending').length})` : f === 'approved' ? 'Approved' : 'All'}</a>`).join('')}</nav>` : ''}
        <span class="row"><a class="btn small" href="${base()}/leave?year=${year - 1}">‹</a><b>${year}</b><a class="btn small" href="${base()}/leave?year=${year + 1}">›</a></span>
        <span class="spacer"></span>
        <button class="btn primary" data-click="hr-add-leave">${isManager() ? '+ Add leave' : 'Ask for leave'}</button>
      </div>
      <section class="panel flush">${list.length ? `<div class="table-scroll"><table class="data-table hr-table">
        <thead><tr>${isManager() ? '<th>Employee</th>' : ''}<th>Type</th><th>Dates</th><th class="num">Days</th><th>Reason</th><th>Status</th><th></th></tr></thead>
        <tbody>${list.map((l) => `<tr>${isManager() ? `<td>${person(l.employee)}</td>` : ''}<td>${esc(LEAVE_TYPES[l.type])}</td><td>${esc(l.from === l.to ? dayName(l.from) : `${dayName(l.from)} – ${dayName(l.to)}`)}${l.half ? ' (half)' : ''}</td><td class="num">${l.days}</td>
          <td><small>${esc(l.reason || '')}</small></td><td><span class="hr-badge hr-lv-${esc(l.status)}">${LEAVE_STATUS[l.status]}</span>${l.decidedBy && l.status !== 'pending' ? `<small class="muted"> by ${esc(l.decidedBy)}</small>` : ''}</td>
          <td class="row">${isManager() && l.status === 'pending' ? `<button class="btn small primary" data-click="hr-leave-decide" data-id="${esc(l.id)}" data-status="approved">Approve</button><button class="btn small" data-click="hr-leave-decide" data-id="${esc(l.id)}" data-status="rejected">Reject</button>` : ''}${(l.status === 'pending' || (isManager() && l.status === 'approved')) ? `<button class="btn small ghost" data-click="hr-leave-cancel" data-id="${esc(l.id)}">Cancel</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`
        : `<div class="hr-empty"><p class="muted">${h.leaveFilter === 'pending' && isManager() ? 'No requests waiting.' : 'No leave this year.'}</p></div>`}</section>
      ${isManager() && h.employees?.length ? balancesTable(L) : ''}`;
  }

  function balancesTable(L) {
    const types = Object.entries(o().settings.leaveAllowance).filter(([, v]) => v).map(([k]) => k);
    return `<section class="panel flush"><h2 class="hr-pad">Leave balance ${esc(L.year)}</h2><div class="table-scroll"><table class="data-table hr-table">
      <thead><tr><th>Employee</th>${types.map((t) => `<th class="num">${LEAVE_TYPES[t]}</th>`).join('')}<th class="num">Unpaid</th></tr></thead>
      <tbody>${h.employees.filter((e) => e.status === 'active').map((e) => {
        const b = L.balances[e.id] || {};
        return `<tr><td>${esc(e.name)}</td>${types.map((t) => `<td class="num">${b[t] ? `<b>${b[t].left}</b><small class="muted"> / ${b[t].allowed}</small>` : '—'}</td>`).join('')}<td class="num">${b.unpaid?.used || 0}</td></tr>`;
      }).join('')}</tbody></table></div><p class="muted small hr-pad">Days left / allowed per year. Weekly days off and holidays inside a leave aren’t counted.</p></section>`;
  }

  function leaveDialog(empId) {
    const manager = isManager();
    const node = document.createElement('dialog');
    node.className = 'dialog';
    const people = (h.employees || []).filter((e) => e.status === 'active');
    node.innerHTML = `<form><h2>${manager ? 'Add leave' : 'Ask for leave'}</h2>
      ${manager ? `<label>Employee<select name="empId" required>${o().self && !empId ? `<option value="${esc(o().self.id)}">Me (${esc(o().self.name)})</option>` : ''}${people.filter((e) => e.id !== o().self?.id || empId).map((e) => `<option value="${esc(e.id)}"${e.id === empId ? ' selected' : ''}>${esc(e.name)}${e.code ? ` (${esc(e.code)})` : ''}</option>`).join('')}</select></label>` : ''}
      <label>Type<select name="type">${Object.entries(LEAVE_TYPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
      <div class="form-grid"><label>From<input type="date" name="from" required value="${esc(o().today)}" /></label><label>To<input type="date" name="to" required value="${esc(o().today)}" /></label></div>
      <label class="check"><input type="checkbox" name="half" /> Half a day</label>
      <label>Reason<textarea name="reason" rows="2" maxlength="1000"></textarea></label>
      ${manager ? '<label class="check"><input type="checkbox" name="approve" checked /> Approve it now</label>' : '<p class="muted small">Your manager gets the request to approve.</p>'}
      <p class="auth-error" hidden></p>
      <div class="row end"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">${manager ? 'Add leave' : 'Send request'}</button></div></form>`;
    document.body.append(node);
    const form = node.querySelector('form');
    node.addEventListener('close', () => node.remove());
    node.querySelector('[data-cancel]').addEventListener('click', () => node.close());
    form.elements.from.addEventListener('change', () => {
      if (form.elements.to.value < form.elements.from.value) form.elements.to.value = form.elements.from.value;
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      data.half = data.half === 'on';
      data.approve = data.approve === 'on';
      try {
        const { leave } = await api('POST', path('/leave'), data);
        node.close();
        toast(leave.status === 'approved' ? `Leave added: ${leave.days} day${leave.days === 1 ? '' : 's'}` : 'Request sent');
        await load(route);
        render();
      } catch (err) {
        const e = node.querySelector('.auth-error');
        e.textContent = err.message;
        e.hidden = false;
      }
    });
    node.showModal();
  }

  // ---------------------------------------------------------------- payroll

  const payBadge = (s) => `<span class="hr-badge hr-pay-${esc(s)}">${PAY_STATUS[s] || s}</span>`;

  function payrollView() {
    if (h.run) return runView();
    const thisMonth = o().today.slice(0, 7);
    const months = [thisMonth, shiftMonth(thisMonth, -1)].filter((m) => !h.runs.some((r) => r.month === m));
    return `
      <div class="hr-toolbar"><span class="muted">Payroll counts salary, attendance, unpaid leave, late arrivals and overtime. Add bonuses and deductions, then make it final.</span><span class="spacer"></span>
        ${months.map((m) => `<button class="btn${m === thisMonth ? '' : ' primary'}" data-click="hr-run-payroll" data-month="${m}">Prepare ${esc(monthName(m))}</button>`).join('')}
        <label class="row small">Other month <input type="month" data-change="hr-pick-month" aria-label="Pick a month" /></label></div>
      <section class="panel flush">${h.runs.length ? `<div class="table-scroll"><table class="data-table hr-table">
        <thead><tr><th>Month</th><th>Status</th><th class="num">Employees</th><th class="num">Gross</th><th class="num">Deductions</th><th class="num">Net pay</th><th>Updated</th></tr></thead>
        <tbody>${h.runs.map((r) => `<tr class="hr-click" data-click="hr-open-run" data-month="${esc(r.month)}"><td><b>${esc(monthName(r.month))}</b></td><td>${payBadge(r.status)}</td><td class="num">${num(r.totals.employees)}</td><td class="num">${money(r.totals.earnings)}</td><td class="num">${money(r.totals.deductions)}</td><td class="num"><b>${money(r.totals.net)}</b></td><td><small class="muted">${esc(formatDateTime(r.updatedAt))}</small></td></tr>`).join('')}</tbody></table></div>`
        : '<div class="hr-empty"><p class="muted">No payroll yet. Prepare this month’s to see everyone’s pay.</p></div>'}</section>`;
  }

  function runView() {
    const r = h.run;
    if (r.missing) return `<p><a href="${base()}/payroll">← All payroll</a></p><section class="panel hr-empty"><p>No payroll for ${esc(monthName(r.month))} yet.</p><button class="btn primary" data-click="hr-run-payroll" data-month="${esc(r.month)}">Prepare it</button></section>`;
    const draft = r.status === 'draft';
    const t = r.totals;
    return `
      <p><a href="${base()}/payroll">← All payroll</a></p>
      <div class="hr-toolbar"><h2 class="hr-h2">${esc(monthName(r.month))} ${payBadge(r.status)}</h2><span class="spacer"></span>
        ${draft ? `<button class="btn" data-click="hr-run-payroll" data-month="${esc(r.month)}">↻ Recalculate</button><button class="btn danger ghost" data-click="hr-delete-run">Delete draft</button><button class="btn primary" data-click="hr-run-status" data-status="final">✓ Make final</button>` : ''}
        ${r.status === 'final' ? '<button class="btn" data-click="hr-run-status" data-status="draft">Reopen</button><button class="btn primary" data-click="hr-run-status" data-status="paid">Mark as paid</button>' : ''}
        ${r.status === 'paid' ? `<span class="muted">Paid ${esc(formatDateTime(r.paidAt))}</span><button class="btn small ghost" data-click="hr-run-status" data-status="final">Undo paid</button>` : ''}
        <button class="btn" data-click="hr-export-run">⬇ Bank sheet</button><button class="btn" data-click="hr-print-all">🖨 All payslips</button></div>
      <div class="stat-row">${tile('Employees', num(t.employees))}${tile('Gross pay', money(t.earnings), t.overtimePay ? `incl. ${money(t.overtimePay)} overtime` : '')}${tile('Deductions', money(t.deductions))}${tile('Net pay', money(t.net), 'to transfer', 'ok')}</div>
      ${draft ? '<p class="muted small">This is a draft: numbers follow attendance until you make it final. Type bonuses and deductions straight into the table.</p>' : '<p class="muted small">Final: employees can see their payslips. Reopen to change it.</p>'}
      <section class="panel flush"><div class="table-scroll"><table class="data-table hr-table hr-pay">
        <thead><tr><th>Employee</th><th class="num">Salary</th><th class="num">Days</th><th class="num">Absence</th><th class="num">Overtime</th><th class="num">Bonus</th><th class="num">Tax + PF</th><th class="num">Advance</th><th class="num">Other ded.</th><th class="num">Net pay</th><th></th></tr></thead>
        <tbody>${r.lines.map((l) => {
          const a = r.adjust?.[l.empId] || {};
          const cell = (k, v) => (draft ? `<input class="hr-cell" data-change="hr-adjust" data-emp="${esc(l.empId)}" data-key="${k}" value="${v || ''}" inputmode="decimal" placeholder="0" aria-label="${k} for ${esc(l.name)}" />` : v ? money(v) : '—');
          return `<tr><td>${person(l)}</td><td class="num">${money(l.earned)}${l.employedDays < Number(r.month && new Date(Date.UTC(+r.month.slice(0, 4), +r.month.slice(5), 0)).getUTCDate()) ? `<small class="muted"><br>${l.employedDays} days</small>` : ''}</td>
            <td class="num"><small>${l.attendance.present + l.attendance.late + l.attendance.half} in${l.attendance.absent ? ` · ${l.attendance.absent} A` : ''}${l.attendance.late ? ` · ${l.attendance.late} L` : ''}</small></td>
            <td class="num">${l.absenceDeduction ? `−${money(l.absenceDeduction)}<small class="muted"><br>${l.unpaidDays} day${l.unpaidDays === 1 ? '' : 's'}</small>` : '—'}</td>
            <td class="num">${l.overtimePay ? `${money(l.overtimePay)}<small class="muted"><br>${l.overtimeHours} h</small>` : '—'}</td>
            <td class="num">${cell('bonus', a.bonus)}</td><td class="num">${l.tax + l.pf ? `−${money(l.tax + l.pf)}` : '—'}</td><td class="num">${cell('advance', a.advance)}</td><td class="num">${cell('deduction', a.deduction)}</td>
            <td class="num"><b>${money(l.net)}</b></td><td><button class="btn small" data-click="hr-payslip" data-month="${esc(r.month)}" data-emp="${esc(l.empId)}">Payslip</button></td></tr>`;
        }).join('')}</tbody>
        <tfoot><tr><th>Total</th><th class="num">${money(r.lines.reduce((s, l) => s + l.earned, 0))}</th><th></th><th class="num">−${money(r.lines.reduce((s, l) => s + l.absenceDeduction, 0))}</th><th class="num">${money(t.overtimePay)}</th><th class="num">${money(r.lines.reduce((s, l) => s + l.bonus, 0))}</th><th class="num">−${money(r.lines.reduce((s, l) => s + l.tax + l.pf, 0))}</th><th class="num">−${money(r.lines.reduce((s, l) => s + l.advance, 0))}</th><th class="num">−${money(r.lines.reduce((s, l) => s + l.otherDeduction, 0))}</th><th class="num">${money(t.net)}</th><th></th></tr></tfoot>
      </table></div></section>`;
  }

  function payslipsView() {
    const list = h.payslips || [];
    return `<section class="panel flush">${list.length ? `<div class="table-scroll"><table class="data-table hr-table">
      <thead><tr><th>Month</th><th>Status</th><th class="num">Gross</th><th class="num">Deductions</th><th class="num">Net pay</th><th></th></tr></thead>
      <tbody>${list.map((p) => `<tr><td><b>${esc(monthName(p.month))}</b></td><td>${payBadge(p.status)}</td><td class="num">${money(p.line.earnings)}</td><td class="num">${money(p.line.deductions)}</td><td class="num"><b>${money(p.line.net)}</b></td><td><button class="btn small" data-click="hr-payslip" data-month="${esc(p.month)}" data-self="1">View</button></td></tr>`).join('')}</tbody></table></div>`
      : '<div class="hr-empty"><p class="muted">No payslips yet. They appear here once HR makes the month’s payroll final.</p></div>'}</section>`;
  }

  // A printable payslip (one page per employee), opened in a new window.
  function payslipHtml(run, l) {
    const m = (n) => Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const row = (label, value, minus = false) => (value ? `<tr><td>${esc(label)}</td><td class="n">${minus ? '−' : ''}${m(value)}</td></tr>` : '');
    const a = l.attendance;
    return `<section class="slip">
      <header><div><h1>${esc(run.company || o().settings.company || o().workspace.name)}</h1><p>Payslip · ${esc(monthName(run.month))}</p></div><div class="st">${esc(PAY_STATUS[run.status] || '')}</div></header>
      <table class="who"><tr><td>Name</td><td><b>${esc(l.name)}</b></td><td>Employee ID</td><td>${esc(l.code)}</td></tr>
        <tr><td>Designation</td><td>${esc(l.designation || '—')}</td><td>Department</td><td>${esc(l.department || '—')}</td></tr>
        <tr><td>Bank</td><td>${esc([l.bankName, l.bankAccount].filter(Boolean).join(' · ') || '—')}</td><td>Days</td><td>${l.employedDays} employed · ${a.present + a.late + a.half} attended · ${a.absent} absent · ${a.leave} leave${a.unpaid ? ` · ${a.unpaid} unpaid` : ''} · ${a.late} late</td></tr></table>
      <div class="cols"><table><thead><tr><th>Earnings</th><th class="n">${esc(run.currency)}</th></tr></thead><tbody>
        ${SALARY_PARTS.map(([k, label]) => row(label, l.salary[k])).join('')}
        ${l.earned !== l.gross ? row(`Paid for ${l.employedDays} days`, l.earned) : ''}
        ${row(`Overtime (${l.overtimeHours} h × ${m(l.overtimeRate)})`, l.overtimePay)}${row('Bonus', l.bonus)}
        </tbody><tfoot><tr><th>Total earnings</th><th class="n">${m(l.earnings)}</th></tr></tfoot></table>
      <table><thead><tr><th>Deductions</th><th class="n">${esc(run.currency)}</th></tr></thead><tbody>
        ${row(`Absence (${l.unpaidDays} day${l.unpaidDays === 1 ? '' : 's'}${l.lateDays ? `, incl. ${l.lateDays} for late arrivals` : ''})`, l.absenceDeduction)}${row('Income tax', l.tax)}${row('Provident fund', l.pf)}${row('Advance', l.advance)}${row('Other', l.otherDeduction)}
        ${l.deductions ? '' : '<tr><td colspan="2">None</td></tr>'}</tbody><tfoot><tr><th>Total deductions</th><th class="n">${m(l.deductions)}</th></tr></tfoot></table></div>
      <p class="net">Net pay <b>${esc(run.currency)} ${m(l.net)}</b></p>
      ${l.note ? `<p class="note">${esc(l.note)}</p>` : ''}
      <footer><span>Employee signature</span><span>Authorised signature</span></footer>
      <p class="small">Generated by Lyrsoft HR · ${esc(new Date().toLocaleDateString())}</p>
    </section>`;
  }

  function printSlips(run, lines) {
    const win = window.open('', '_blank');
    if (!win) return toast('Allow pop-ups to open payslips.');
    win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Payslip ${esc(run.month)}</title><style>
      body{font:13px/1.45 system-ui,sans-serif;color:#1f2433;margin:0;background:#eef0f5}
      .bar{position:sticky;top:0;padding:10px;text-align:center;background:#1f2433}.bar button{font:inherit;padding:8px 18px;border:0;border-radius:8px;background:#6c5ce7;color:#fff;cursor:pointer}
      .slip{max-width:760px;margin:16px auto;padding:28px 32px;background:#fff;border-radius:10px;page-break-after:always}
      header{display:flex;justify-content:space-between;border-bottom:3px solid #6c5ce7;padding-bottom:10px;margin-bottom:14px}h1{margin:0;font-size:20px}header p{margin:2px 0 0;color:#676f83}
      .st{align-self:center;padding:3px 10px;border-radius:99px;background:#efedfd;color:#5847d6;font-weight:700}
      table{width:100%;border-collapse:collapse}td,th{padding:6px 8px;border-bottom:1px solid #e2e5ee;text-align:left;vertical-align:top}.n{text-align:right;white-space:nowrap}
      .who td:nth-child(odd){color:#676f83;width:16%}.cols{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:16px}thead th{background:#f1f3f8}tfoot th{border-top:2px solid #1f2433}
      .net{margin:18px 0 0;padding:12px 16px;border-radius:8px;background:#f1f3f8;font-size:16px;display:flex;justify-content:space-between}.net b{font-size:20px}
      .note{color:#676f83}footer{display:flex;justify-content:space-between;margin-top:56px}footer span{border-top:1px solid #1f2433;padding-top:4px;width:40%;text-align:center;color:#676f83}.small{color:#9aa1b5;font-size:11px;text-align:center}
      @media print{body{background:#fff}.bar{display:none}.slip{margin:0;border-radius:0;max-width:none}}
      @media (max-width:640px){.cols{grid-template-columns:1fr}.slip{padding:18px}}
    </style></head><body><div class="bar"><button onclick="print()">🖨 Print or save as PDF</button></div>${lines.map((l) => payslipHtml(run, l)).join('')}</body></html>`);
    win.document.close();
  }

  // ---------------------------------------------------------------- settings

  function settingsView() {
    const s = o().settings;
    const tzs = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [s.timezone];
    return `
      <form class="panel hr-settings" data-form="hr-settings">
        <h2>Company and work rules</h2>
        <div class="form-grid">
          <label>Company name (on payslips)<input name="company" value="${esc(s.company)}" maxlength="120" placeholder="${esc(o().workspace.name)}" /></label>
          <label>Currency<input name="currency" value="${esc(s.currency)}" maxlength="8" placeholder="BDT" /></label>
          <label>Time zone<select name="timezone">${tzs.map((tz) => `<option${tz === s.timezone ? ' selected' : ''}>${esc(tz)}</option>`).join('')}</select></label>
          <label>Late after (minutes of grace)<input name="graceMinutes" type="number" min="0" max="240" value="${s.graceMinutes}" /></label>
          <label>Shift starts<input name="shiftStart" type="time" value="${esc(s.shiftStart)}" required /></label>
          <label>Shift ends<input name="shiftEnd" type="time" value="${esc(s.shiftEnd)}" required /></label>
          <label>Half day if worked less than (minutes)<input name="halfDayMinutes" type="number" min="0" max="720" value="${s.halfDayMinutes}" /></label>
          <label>Days per month for the daily rate<input name="daysPerMonth" type="number" min="20" max="31" value="${s.daysPerMonth}" /></label>
          <label>Overtime pay (× basic hourly)<input name="overtimeMultiplier" inputmode="decimal" value="${s.overtimeMultiplier}" /></label>
          <label>Count overtime from (minutes)<input name="overtimeMinMinutes" type="number" min="0" max="240" value="${s.overtimeMinMinutes}" /></label>
          <label>Count attendance from<input name="trackingFrom" type="date" value="${esc(s.trackingFrom)}" /><small class="muted">Days before this are never counted as absent</small></label>
          <label>Late arrivals that cost a day’s pay<input name="latesPerDeduction" type="number" min="0" max="31" value="${s.latesPerDeduction}" /><small class="muted">0 = never</small></label>
        </div>
        <fieldset><legend>Weekly days off</legend><p class="hr-days">${WEEKDAYS.map(([k, label]) => `<label class="chip-check"><input type="checkbox" name="weeklyOff" value="${k}"${s.weeklyOff.includes(k) ? ' checked' : ''} /> ${label}</label>`).join('')}</p></fieldset>
        <fieldset><legend>Paid leave per year (days)</legend><div class="form-grid hr-salary">${['annual', 'sick', 'casual', 'maternity', 'other'].map((k) => `<label>${LEAVE_TYPES[k]}<input name="leave.${k}" type="number" min="0" max="365" value="${s.leaveAllowance[k] || 0}" /></label>`).join('')}</div></fieldset>
        <fieldset><legend>Holidays</legend><p class="muted small">One per line: <code>2026-12-16 Victory Day</code></p>
          <textarea name="holidays" rows="5" placeholder="2026-12-16 Victory Day&#10;2026-12-25 Christmas">${esc(s.holidays.map((x) => `${x.date} ${x.name}`).join('\n'))}</textarea></fieldset>
        <fieldset><legend>Check-in</legend>
          <label class="check"><input type="checkbox" name="webCheckIn"${s.webCheckIn ? ' checked' : ''} /> Employees can check in and out from the web and the Lyrsoft app</label>
          <label class="check"><input type="checkbox" name="requireLocation"${s.requireLocation ? ' checked' : ''} /> Require their location with each web check-in</label></fieldset>
        ${o().admin ? `<label>HR managers besides workspace owners and admins<input name="managers" value="${esc(s.managers.join(', '))}" placeholder="hr@company.com, accounts@company.com" /><small class="muted">They see everyone’s attendance, leave and salaries.</small></label>` : ''}
        <div class="row end"><button class="btn primary">Save settings</button></div>
      </form>
      <section class="panel">
        <div class="panel-head spread"><h2>🖐 Biometric devices</h2><button class="btn small primary" data-click="hr-new-device">+ Add device</button></div>
        <p class="muted">Fingerprint and face attendance machines (ZKTeco and others) send punches to Lyrsoft. Give each employee their <b>device ID</b> (the number they’re enrolled with on the machine) on their employee page.</p>
        ${h.devices?.length ? `<div class="table-scroll"><table class="data-table hr-table"><thead><tr><th>Device</th><th>Key</th><th>Last seen</th><th class="num">Punches</th><th></th></tr></thead><tbody>${h.devices.map((d) => `<tr><td><b>${esc(d.name)}</b><small class="muted"> ${esc(d.location || '')}</small></td><td><code>lyrhr_…${esc(d.keyHint)}</code></td><td>${d.lastSeenAt ? esc(formatDateTime(d.lastSeenAt)) : '<span class="muted">Never</span>'}</td><td class="num">${num(d.punches)}</td><td class="row"><button class="btn small" data-click="hr-device-key" data-id="${esc(d.id)}">New key</button><button class="btn small danger ghost" data-click="hr-device-delete" data-id="${esc(d.id)}" data-name="${esc(d.name)}">Remove</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No devices yet.</p>'}
        <details class="hr-api"><summary>How a device or its bridge sends punches</summary>
          <pre>POST ${esc(location.origin)}/public/hr/punch
Content-Type: application/json

{ "key": "lyrhr_…",
  "punches": [ { "user": "17", "at": "2026-11-08 09:02:41" } ] }</pre>
          <p class="muted small"><b>user</b> is the person’s ID on the device (or their employee ID). <b>at</b> is the device’s local time (read in ${esc(s.timezone)}), an ISO time, or epoch seconds. Send up to 500 punches at once; repeats within a minute are ignored, so resending is safe. Post with no punches to test the key.</p></details>
      </section>`;
  }

  function showKey(device, key) {
    const node = document.createElement('dialog');
    node.className = 'dialog';
    node.innerHTML = `<form method="dialog"><h2>Key for ${esc(device.name)}</h2><p>Copy it into the device bridge now. It isn’t shown again; make a new one if it’s lost.</p>
      <p><code class="hr-key">${esc(key)}</code></p><div class="row end"><button type="button" class="btn" data-copy>Copy</button><button class="btn primary">Done</button></div></form>`;
    document.body.append(node);
    node.addEventListener('close', () => node.remove());
    node.querySelector('[data-copy]').addEventListener('click', async () => {
      await navigator.clipboard?.writeText(key).catch(() => {});
      toast('Key copied');
    });
    node.showModal();
  }

  // ---------------------------------------------------------------- exports

  function download(name, rows) {
    const csv = rows.map((r) => r.map((v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------------------------------------------------------------- actions

  const refresh = async () => {
    await load(route);
    render();
  };
  const runPath = () => path(`/payroll/${h.run.month}`);

  const clickActions = {
    'hr-new-employee': () => employeeDialog(null),
    'hr-edit-employee': (t) => employeeDialog((h.employees || []).find((e) => e.id === t.dataset.id)),
    'hr-open-employee': (t) => go(`${base()}/employees/${encodeURIComponent(t.dataset.id)}`),
    'hr-edit-day': (t) => editDay(t.dataset.date, t.dataset.emp),
    'hr-add-leave': (t) => leaveDialog(t.dataset.emp),
    'hr-punch': async (t) => {
      t.disabled = true;
      try {
        const geo = o().settings.requireLocation ? await where() : null;
        const { day } = await api('POST', path('/me/punch'), geo ? { geo } : {});
        toast(day.punches.length % 2 ? `Checked in at ${day.punches.at(-1).time} ✓` : `Checked out at ${day.punches.at(-1).time} ✓`);
        await refresh();
      } catch (err) {
        toast(err.message);
        t.disabled = false;
      }
    },
    'hr-leave-filter': (t) => {
      h.leaveFilter = t.dataset.filter;
      render();
    },
    'hr-leave-decide': async (t) => {
      try {
        await api('POST', path(`/leave/${encodeURIComponent(t.dataset.id)}/decide`), { status: t.dataset.status });
        toast(t.dataset.status === 'approved' ? 'Leave approved' : 'Leave rejected');
        await refresh();
      } catch (err) {
        toast(err.message);
      }
    },
    'hr-leave-cancel': async (t) => {
      if (!confirm('Cancel this leave?')) return;
      try {
        await api('POST', path(`/leave/${encodeURIComponent(t.dataset.id)}/cancel`));
        toast('Leave cancelled');
        await refresh();
      } catch (err) {
        toast(err.message);
      }
    },
    'hr-run-payroll': async (t) => {
      t.disabled = true;
      try {
        const { run } = await api('POST', path(`/payroll/${t.dataset.month}`));
        h.run = run;
        toast(`Payroll for ${monthName(run.month)} calculated`);
        if (route.id === run.month) render();
        else go(`${base()}/payroll/${run.month}`);
      } catch (err) {
        toast(err.message);
        t.disabled = false;
      }
    },
    'hr-open-run': (t) => go(`${base()}/payroll/${t.dataset.month}`),
    'hr-run-status': async (t) => {
      const s = t.dataset.status;
      if (s === 'final' && !confirm('Make this payroll final? Employees will see their payslips.')) return;
      try {
        h.run = (await api('POST', path(`/payroll/${h.run.month}/status`), { status: s })).run;
        toast({ final: 'Payroll is final', paid: 'Marked as paid', draft: 'Reopened as a draft' }[s]);
        render();
      } catch (err) {
        toast(err.message);
      }
    },
    'hr-delete-run': async () => {
      if (!confirm('Delete this draft payroll?')) return;
      try {
        await api('DELETE', runPath());
        h.run = null;
        go(`${base()}/payroll`);
      } catch (err) {
        toast(err.message);
      }
    },
    'hr-payslip': (t) => {
      if (t.dataset.self) {
        const p = h.payslips.find((x) => x.month === t.dataset.month);
        return printSlips({ month: p.month, status: p.status, currency: p.currency, company: p.company }, [p.line]);
      }
      printSlips(h.run, h.run.lines.filter((l) => l.empId === t.dataset.emp));
    },
    'hr-print-all': () => printSlips(h.run, h.run.lines),
    'hr-export-run': () => {
      const r = h.run;
      download(`payroll-${r.month}.csv`, [
        ['Employee ID', 'Name', 'Department', 'Designation', 'Bank', 'Account', 'Gross salary', 'Earned', 'Overtime hours', 'Overtime pay', 'Bonus', 'Absence days', 'Absence deduction', 'Tax', 'Provident fund', 'Advance', 'Other deduction', 'Net pay', 'Note'],
        ...r.lines.map((l) => [l.code, l.name, l.department, l.designation, l.bankName, l.bankAccount, l.gross, l.earned, l.overtimeHours, l.overtimePay, l.bonus, l.unpaidDays, l.absenceDeduction, l.tax, l.pf, l.advance, l.otherDeduction, l.net, l.note]),
        [],
        ['', 'Total', '', '', '', '', r.totals.gross, '', '', r.totals.overtimePay, '', '', '', '', '', '', '', r.totals.net],
      ]);
    },
    'hr-export-employees': () => download('employees.csv', [
      ['Employee ID', 'Name', 'Email', 'Phone', 'Department', 'Designation', 'Type', 'Status', 'Joined', 'Last day', 'Device ID', ...SALARY_PARTS.map(([, l]) => l), 'Gross', 'Tax %', 'PF %', 'Bank', 'Account'],
      ...(h.employees || []).map((e) => [e.code, e.name, e.email, e.phone, e.department, e.designation, EMPLOYMENT[e.type], e.status, e.joinDate, e.leaveDate, e.deviceUserId, ...SALARY_PARTS.map(([k]) => e.salary?.[k] || 0), gross(e), e.salary?.taxPercent || 0, e.salary?.pfPercent || 0, e.bankName, e.bankAccount]),
    ]),
    'hr-export-day': () => download(`attendance-${h.day.date}.csv`, [
      ['Employee ID', 'Name', 'Department', 'Status', 'In', 'Out', 'Worked (min)', 'Overtime (min)', 'Late (min)', 'Punches', 'Note'],
      ...h.day.rows.map(({ employee: e, day: d }) => [e.code, e.name, e.department, STATUS[d.status]?.[0] || d.status, d.in, d.out, d.worked, d.overtime, d.lateBy, d.punches.map((p) => `${p.time} ${p.source}`).join(' | '), d.note]),
    ]),
    'hr-export-report': () => {
      const r = h.report;
      const days = r.rows[0]?.marks.length || 0;
      download(`attendance-${r.month}.csv`, [
        ['Employee ID', 'Name', ...Array.from({ length: days }, (_, i) => String(i + 1)), 'Present', 'Late', 'Half days', 'Absent', 'Leave', 'Unpaid', 'Worked (h)', 'Overtime (h)'],
        ...r.rows.map(({ employee: e, summary: s, marks }) => [e.code, e.name, ...marks.map((m) => STATUS[m]?.[1] || ''), s.present, s.late, s.half, s.absent, s.leave, s.unpaid, Math.round(s.worked / 6) / 10, Math.round(s.overtime / 6) / 10]),
      ]);
    },
    'hr-new-device': async () => {
      const name = prompt('Device name, like “Front door” or “Factory gate”:');
      if (!name) return;
      try {
        const { device, key } = await api('POST', path('/devices'), { name });
        h.devices = [...(h.devices || []), device];
        render();
        showKey(device, key);
      } catch (err) {
        toast(err.message);
      }
    },
    'hr-device-key': async (t) => {
      if (!confirm('Make a new key? The device stops sending until you give it the new one.')) return;
      try {
        const { device, key } = await api('POST', path(`/devices/${encodeURIComponent(t.dataset.id)}/key`));
        await refresh();
        showKey(device, key);
      } catch (err) {
        toast(err.message);
      }
    },
    'hr-device-delete': async (t) => {
      if (!confirm(`Remove ${t.dataset.name}? It can’t send punches any more; punches it sent stay.`)) return;
      try {
        await api('DELETE', path(`/devices/${encodeURIComponent(t.dataset.id)}`));
        await refresh();
      } catch (err) {
        toast(err.message);
      }
    },
  };

  const changeActions = {
    'hr-dept': (t) => {
      h.dept = t.value;
      render();
    },
    'hr-date': (t) => t.value && go(`${base()}/attendance?date=${t.value}`),
    'hr-pick-month': (t) => t.value && go(`${base()}/payroll/${t.value}`),
    'hr-adjust': async (t) => {
      const emp = t.dataset.emp;
      const current = { ...(h.run.adjust?.[emp] || {}) };
      current[t.dataset.key] = t.value;
      try {
        h.run = (await api('PATCH', path(`/payroll/${h.run.month}/lines/${encodeURIComponent(emp)}`), current)).run;
        render();
      } catch (err) {
        toast(err.message);
      }
    },
  };

  const inputActions = {
    'hr-search': (t) => {
      h.query = t.value;
      const at = t.selectionStart;
      render();
      const s = document.querySelector('.hr-search');
      s?.focus();
      s?.setSelectionRange(at, at);
    },
  };

  const formActions = {
    'hr-settings': async (form, data) => {
      const body = {};
      for (const k of ['company', 'currency', 'timezone', 'shiftStart', 'shiftEnd', 'graceMinutes', 'halfDayMinutes', 'daysPerMonth', 'overtimeMultiplier', 'overtimeMinMinutes', 'latesPerDeduction', 'trackingFrom']) body[k] = data.get(k);
      body.weeklyOff = data.getAll('weeklyOff');
      body.leaveAllowance = Object.fromEntries(['annual', 'sick', 'casual', 'maternity', 'other'].map((k) => [k, data.get(`leave.${k}`)]));
      body.holidays = String(data.get('holidays') || '').split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
        const m = line.match(/^(\d{4}-\d{2}-\d{2})\s*[-–:,]?\s*(.*)$/);
        return m ? { date: m[1], name: m[2] } : null;
      }).filter(Boolean);
      body.webCheckIn = data.get('webCheckIn') === 'on';
      body.requireLocation = data.get('requireLocation') === 'on';
      if (data.has('managers')) body.managers = data.get('managers');
      try {
        h.overview.settings = (await api('PATCH', path('/settings'), body)).settings;
        toast('HR settings saved');
        render();
      } catch (err) {
        toast(err.message);
      }
    },
  };

  return { load, ready, view, clickActions, changeActions, inputActions, formActions };
}
