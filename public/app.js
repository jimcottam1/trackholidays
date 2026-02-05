// State
let currentUser = null;
let employees = [];
let departments = [];
let holidays = [];
let timeEntries = [];
let currentCalendarDate = new Date();

// API Helper
async function api(endpoint, options = {}) {
  const res = await fetch(`/api${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers
    },
    credentials: 'include'
  });

  if (res.status === 401) {
    logout();
    throw new Error('Session expired');
  }

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || 'Request failed');
  }

  return data;
}

// Auth
async function login(email, password) {
  const data = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password })
  });
  currentUser = data.user;
  showApp();
}

function logout() {
  api('/auth/logout', { method: 'POST' }).catch(() => {});
  currentUser = null;
  document.body.className = '';
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
}

async function checkAuth() {
  try {
    const user = await api('/auth/me');
    currentUser = user;
    showApp();
  } catch {
    document.getElementById('login-screen').classList.remove('hidden');
  }
}

function showApp() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');

  document.getElementById('user-email').textContent = currentUser.email;
  document.getElementById('user-role').textContent = currentUser.role;
  document.getElementById('user-role').className = `badge ${currentUser.role}`;

  document.body.className = `role-${currentUser.role}`;

  loadDashboard();
  loadEmployees();
  loadDepartments();
}

// Navigation
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    const view = item.dataset.view;

    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    item.classList.add('active');

    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(`${view}-view`).classList.add('active');

    // Load data for view
    switch (view) {
      case 'dashboard': loadDashboard(); break;
      case 'employees': loadEmployees(); break;
      case 'holidays': loadHolidays(); break;
      case 'calendar': renderCalendar(); break;
      case 'timesheet': loadTimesheet(); break;
      case 'departments': loadDepartments(); break;
      case 'users': loadUsers(); break;
    }
  });
});

// Modal helpers
function openModal(modalId) {
  document.getElementById(modalId).classList.add('active');
}

function closeModal(modalId) {
  document.getElementById(modalId).classList.remove('active');
}

document.querySelectorAll('.modal .close-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    btn.closest('.modal').classList.remove('active');
  });
});

document.querySelectorAll('.modal').forEach(modal => {
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.classList.remove('active');
    }
  });
});

// Dashboard
async function loadDashboard() {
  try {
    const stats = await api('/dashboard/stats');
    document.getElementById('stat-employees').textContent = stats.totalEmployees;
    document.getElementById('stat-holiday').textContent = stats.onHolidayToday;
    document.getElementById('stat-clocked').textContent = stats.clockedInToday;

    // Load upcoming holidays
    const holidays = await api('/holidays');
    const upcoming = holidays
      .filter(h => new Date(h.start_date) >= new Date())
      .slice(0, 5);

    const upcomingEl = document.getElementById('upcoming-holidays');
    if (upcoming.length === 0) {
      upcomingEl.innerHTML = '<p class="empty-state">No upcoming holidays</p>';
    } else {
      upcomingEl.innerHTML = `<ul class="activity-list">${upcoming.map(h => `
        <li class="activity-item">
          <span class="name">${h.employee_name}</span>
          <br>
          <span class="date">${formatDate(h.start_date)} - ${formatDate(h.end_date)}</span>
        </li>
      `).join('')}</ul>`;
    }

    // Recent activity
    const recentEl = document.getElementById('recent-activity');
    const recent = holidays.slice(0, 5);
    if (recent.length === 0) {
      recentEl.innerHTML = '<p class="empty-state">No recent activity</p>';
    } else {
      recentEl.innerHTML = `<ul class="activity-list">${recent.map(h => `
        <li class="activity-item">
          <span class="name">${h.employee_name}</span> booked ${h.days} day(s)
          <br>
          <span class="date">${formatDate(h.created_at)}</span>
        </li>
      `).join('')}</ul>`;
    }
  } catch (err) {
    console.error('Failed to load dashboard:', err);
  }
}

// Employees
async function loadEmployees() {
  try {
    const status = document.getElementById('employee-status-filter').value;
    const deptId = document.getElementById('employee-dept-filter').value;

    let url = '/employees?';
    if (status) url += `status=${status}&`;
    if (deptId) url += `department_id=${deptId}`;

    employees = await api(url);
    renderEmployeesTable();
    populateEmployeeSelects();
  } catch (err) {
    console.error('Failed to load employees:', err);
  }
}

function renderEmployeesTable() {
  const tbody = document.querySelector('#employees-table tbody');
  const isManagerOrAdmin = ['admin', 'manager'].includes(currentUser.role);

  if (employees.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No employees found</td></tr>';
    return;
  }

  tbody.innerHTML = employees.map(e => {
    const remaining = e.holidays_remaining !== undefined ? e.holidays_remaining : e.holiday_allowance;
    const allowance = e.holiday_allowance || 25;
    const holidayClass = remaining <= 0 ? 'danger' : remaining <= 5 ? 'warning' : 'success';
    return `
    <tr>
      <td>${e.first_name} ${e.last_name}</td>
      <td>${e.email}</td>
      <td>${e.department_name || '-'}</td>
      <td>${e.job_title || '-'}</td>
      <td><span class="badge ${holidayClass}">${remaining} / ${allowance}</span></td>
      <td><span class="badge ${e.status}">${e.status}</span></td>
      <td class="actions">
        <button class="btn btn-sm" onclick="viewEmployee(${e.id})">View</button>
        ${isManagerOrAdmin ? `
          <button class="btn btn-sm" onclick="editEmployee(${e.id})">Edit</button>
          <button class="btn btn-sm btn-danger" onclick="deleteEmployee(${e.id})">Delete</button>
        ` : ''}
      </td>
    </tr>
  `;
  }).join('');
}

function populateEmployeeSelects() {
  const selects = [
    'holiday-employee',
    'holiday-employee-filter',
    'timesheet-employee-filter',
    'department-manager',
    'user-employee',
    'timeentry-employee'
  ];

  selects.forEach(id => {
    const select = document.getElementById(id);
    if (!select) return;

    const currentValue = select.value;
    const firstOption = select.querySelector('option');
    select.innerHTML = '';
    if (firstOption) select.appendChild(firstOption);

    employees.filter(e => e.status === 'active').forEach(e => {
      const opt = document.createElement('option');
      opt.value = e.id;
      opt.textContent = `${e.first_name} ${e.last_name}`;
      select.appendChild(opt);
    });

    select.value = currentValue;
  });
}

document.getElementById('add-employee-btn').addEventListener('click', () => {
  document.getElementById('employee-modal-title').textContent = 'Add Employee';
  document.getElementById('employee-form').reset();
  document.getElementById('employee-id').value = '';
  populateDepartmentSelect('employee-department');
  openModal('employee-modal');
});

async function viewEmployee(id) {
  // For now, just edit - could add a view-only modal later
  editEmployee(id);
}

async function editEmployee(id) {
  const emp = employees.find(e => e.id === id);
  if (!emp) return;

  document.getElementById('employee-modal-title').textContent = 'Edit Employee';
  document.getElementById('employee-id').value = emp.id;
  document.getElementById('employee-first-name').value = emp.first_name;
  document.getElementById('employee-last-name').value = emp.last_name;
  document.getElementById('employee-email').value = emp.email;
  document.getElementById('employee-phone').value = emp.phone || '';
  document.getElementById('employee-number').value = emp.employee_number || '';
  document.getElementById('employee-job-title').value = emp.job_title || '';
  document.getElementById('employee-start-date').value = emp.start_date || '';
  document.getElementById('employee-allowance').value = emp.holiday_allowance || 25;
  document.getElementById('employee-status').value = emp.status;
  document.getElementById('employee-address').value = emp.address || '';
  document.getElementById('employee-emergency-name').value = emp.emergency_contact_name || '';
  document.getElementById('employee-emergency-phone').value = emp.emergency_contact_phone || '';

  populateDepartmentSelect('employee-department', emp.department_id);
  openModal('employee-modal');
}

async function deleteEmployee(id) {
  if (!confirm('Are you sure you want to delete this employee?')) return;

  try {
    await api(`/employees/${id}`, { method: 'DELETE' });
    loadEmployees();
  } catch (err) {
    alert(err.message);
  }
}

document.getElementById('employee-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const id = document.getElementById('employee-id').value;
  const data = {
    first_name: document.getElementById('employee-first-name').value,
    last_name: document.getElementById('employee-last-name').value,
    email: document.getElementById('employee-email').value,
    phone: document.getElementById('employee-phone').value,
    employee_number: document.getElementById('employee-number').value,
    department_id: document.getElementById('employee-department').value || null,
    job_title: document.getElementById('employee-job-title').value,
    start_date: document.getElementById('employee-start-date').value,
    holiday_allowance: parseInt(document.getElementById('employee-allowance').value) || 25,
    status: document.getElementById('employee-status').value,
    address: document.getElementById('employee-address').value,
    emergency_contact_name: document.getElementById('employee-emergency-name').value,
    emergency_contact_phone: document.getElementById('employee-emergency-phone').value
  };

  try {
    if (id) {
      await api(`/employees/${id}`, { method: 'PUT', body: JSON.stringify(data) });
    } else {
      await api('/employees', { method: 'POST', body: JSON.stringify(data) });
    }
    closeModal('employee-modal');
    loadEmployees();
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById('employee-dept-filter').addEventListener('change', loadEmployees);
document.getElementById('employee-status-filter').addEventListener('change', loadEmployees);

// Departments
async function loadDepartments() {
  try {
    departments = await api('/departments');
    renderDepartmentsTable();
    populateDepartmentFilters();
  } catch (err) {
    console.error('Failed to load departments:', err);
  }
}

function renderDepartmentsTable() {
  const tbody = document.querySelector('#departments-table tbody');

  if (departments.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-state">No departments found</td></tr>';
    return;
  }

  tbody.innerHTML = departments.map(d => `
    <tr>
      <td>${d.name}</td>
      <td>${d.manager_name || '-'}</td>
      <td>${d.employee_count}</td>
      <td class="actions">
        <button class="btn btn-sm" onclick="editDepartment(${d.id})">Edit</button>
        <button class="btn btn-sm btn-danger" onclick="deleteDepartment(${d.id})">Delete</button>
      </td>
    </tr>
  `).join('');
}

function populateDepartmentFilters() {
  const filter = document.getElementById('employee-dept-filter');
  const currentValue = filter.value;
  filter.innerHTML = '<option value="">All Departments</option>';
  departments.forEach(d => {
    filter.innerHTML += `<option value="${d.id}">${d.name}</option>`;
  });
  filter.value = currentValue;
}

function populateDepartmentSelect(selectId, selectedId = null) {
  const select = document.getElementById(selectId);
  select.innerHTML = '<option value="">No Department</option>';
  departments.forEach(d => {
    select.innerHTML += `<option value="${d.id}" ${d.id == selectedId ? 'selected' : ''}>${d.name}</option>`;
  });
}

document.getElementById('add-department-btn').addEventListener('click', () => {
  document.getElementById('department-modal-title').textContent = 'Add Department';
  document.getElementById('department-form').reset();
  document.getElementById('department-id').value = '';
  openModal('department-modal');
});

async function editDepartment(id) {
  const dept = departments.find(d => d.id === id);
  if (!dept) return;

  document.getElementById('department-modal-title').textContent = 'Edit Department';
  document.getElementById('department-id').value = dept.id;
  document.getElementById('department-name').value = dept.name;
  document.getElementById('department-manager').value = dept.manager_id || '';
  openModal('department-modal');
}

async function deleteDepartment(id) {
  if (!confirm('Are you sure you want to delete this department?')) return;

  try {
    await api(`/departments/${id}`, { method: 'DELETE' });
    loadDepartments();
  } catch (err) {
    alert(err.message);
  }
}

document.getElementById('department-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const id = document.getElementById('department-id').value;
  const data = {
    name: document.getElementById('department-name').value,
    manager_id: document.getElementById('department-manager').value || null
  };

  try {
    if (id) {
      await api(`/departments/${id}`, { method: 'PUT', body: JSON.stringify(data) });
    } else {
      await api('/departments', { method: 'POST', body: JSON.stringify(data) });
    }
    closeModal('department-modal');
    loadDepartments();
  } catch (err) {
    alert(err.message);
  }
});

// Holidays
async function loadHolidays() {
  try {
    const employeeId = document.getElementById('holiday-employee-filter').value;
    const year = document.getElementById('holiday-year-filter').value;

    let url = '/holidays?';
    if (employeeId) url += `employee_id=${employeeId}&`;
    if (year) url += `year=${year}`;

    holidays = await api(url);
    renderHolidaysTable();
  } catch (err) {
    console.error('Failed to load holidays:', err);
  }
}

function renderHolidaysTable() {
  const tbody = document.querySelector('#holidays-table tbody');
  const isManagerOrAdmin = ['admin', 'manager'].includes(currentUser.role);

  if (holidays.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No holidays found</td></tr>';
    return;
  }

  tbody.innerHTML = holidays.map(h => `
    <tr>
      <td>${h.employee_name}</td>
      <td>${formatDate(h.start_date)}</td>
      <td>${formatDate(h.end_date)}</td>
      <td>${h.days}</td>
      <td><span class="badge ${h.type}">${h.type}</span></td>
      <td><span class="badge ${h.status}">${h.status}</span></td>
      <td class="actions">
        ${isManagerOrAdmin || h.employee_id === currentUser.employeeId ? `
          <button class="btn btn-sm" onclick="editHoliday(${h.id})">Edit</button>
          <button class="btn btn-sm btn-danger" onclick="deleteHoliday(${h.id})">Delete</button>
        ` : ''}
      </td>
    </tr>
  `).join('');
}

// Initialize year filter
function initYearFilter() {
  const select = document.getElementById('holiday-year-filter');
  const currentYear = new Date().getFullYear();
  select.innerHTML = '';
  for (let y = currentYear + 1; y >= currentYear - 2; y--) {
    select.innerHTML += `<option value="${y}" ${y === currentYear ? 'selected' : ''}>${y}</option>`;
  }
}

document.getElementById('add-holiday-btn').addEventListener('click', () => {
  document.getElementById('holiday-modal-title').textContent = 'Book Holiday';
  document.getElementById('holiday-form').reset();
  document.getElementById('holiday-id').value = '';

  // Reset half day fields
  document.getElementById('holiday-half-day').checked = false;
  document.getElementById('half-day-period-group').style.display = 'none';
  document.getElementById('holiday-end').disabled = false;

  // If employee, preselect themselves
  if (currentUser.employeeId) {
    document.getElementById('holiday-employee').value = currentUser.employeeId;
    updateHolidayAllowanceInfo();
  }

  openModal('holiday-modal');
});

async function editHoliday(id) {
  const holiday = holidays.find(h => h.id === id);
  if (!holiday) return;

  document.getElementById('holiday-modal-title').textContent = 'Edit Holiday';
  document.getElementById('holiday-id').value = holiday.id;
  document.getElementById('holiday-employee').value = holiday.employee_id;
  document.getElementById('holiday-start').value = holiday.start_date;
  document.getElementById('holiday-end').value = holiday.end_date;
  document.getElementById('holiday-type').value = holiday.type;

  // Check if this is a half day (0.5 days)
  const isHalfDay = holiday.days === 0.5;
  document.getElementById('holiday-half-day').checked = isHalfDay;

  if (isHalfDay) {
    document.getElementById('half-day-period-group').style.display = 'block';
    document.getElementById('holiday-end').disabled = true;
    // Try to extract period from notes
    const notes = holiday.notes || '';
    if (notes.startsWith('PM half day')) {
      document.getElementById('holiday-half-day-period').value = 'PM';
      document.getElementById('holiday-notes').value = notes.replace(/^PM half day\.?\s*/, '');
    } else if (notes.startsWith('AM half day')) {
      document.getElementById('holiday-half-day-period').value = 'AM';
      document.getElementById('holiday-notes').value = notes.replace(/^AM half day\.?\s*/, '');
    } else {
      document.getElementById('holiday-notes').value = notes;
    }
  } else {
    document.getElementById('half-day-period-group').style.display = 'none';
    document.getElementById('holiday-end').disabled = false;
    document.getElementById('holiday-notes').value = holiday.notes || '';
  }

  updateHolidayAllowanceInfo();
  openModal('holiday-modal');
}

async function deleteHoliday(id) {
  if (!confirm('Are you sure you want to delete this holiday?')) return;

  try {
    await api(`/holidays/${id}`, { method: 'DELETE' });
    loadHolidays();
  } catch (err) {
    alert(err.message);
  }
}

document.getElementById('holiday-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const isHalfDay = document.getElementById('holiday-half-day').checked;
  const id = document.getElementById('holiday-id').value;
  const data = {
    employee_id: document.getElementById('holiday-employee').value,
    start_date: document.getElementById('holiday-start').value,
    end_date: document.getElementById('holiday-end').value,
    type: document.getElementById('holiday-type').value,
    notes: document.getElementById('holiday-notes').value,
    is_half_day: isHalfDay,
    half_day_period: isHalfDay ? document.getElementById('holiday-half-day-period').value : null
  };

  try {
    if (id) {
      await api(`/holidays/${id}`, { method: 'PUT', body: JSON.stringify(data) });
    } else {
      await api('/holidays', { method: 'POST', body: JSON.stringify(data) });
    }
    closeModal('holiday-modal');
    loadHolidays();
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById('holiday-employee').addEventListener('change', updateHolidayAllowanceInfo);

// Half day toggle
document.getElementById('holiday-half-day').addEventListener('change', function() {
  const periodGroup = document.getElementById('half-day-period-group');
  const endDateInput = document.getElementById('holiday-end');
  const startDateInput = document.getElementById('holiday-start');

  if (this.checked) {
    periodGroup.style.display = 'block';
    // For half day, end date should be same as start date
    endDateInput.value = startDateInput.value;
    endDateInput.disabled = true;
  } else {
    periodGroup.style.display = 'none';
    endDateInput.disabled = false;
  }
});

// Sync end date with start date when half day is checked
document.getElementById('holiday-start').addEventListener('change', function() {
  if (document.getElementById('holiday-half-day').checked) {
    document.getElementById('holiday-end').value = this.value;
  }
});

async function updateHolidayAllowanceInfo() {
  const employeeId = document.getElementById('holiday-employee').value;
  const infoBox = document.getElementById('holiday-allowance-info');

  if (!employeeId) {
    infoBox.innerHTML = '';
    return;
  }

  try {
    const summary = await api(`/holidays/summary/${employeeId}`);
    infoBox.innerHTML = `
      Allowance: <strong>${summary.allowance}</strong> days |
      Used: <strong>${summary.used}</strong> days |
      Remaining: <strong>${summary.remaining}</strong> days
    `;
  } catch {
    infoBox.innerHTML = '';
  }
}

document.getElementById('holiday-employee-filter').addEventListener('change', loadHolidays);
document.getElementById('holiday-year-filter').addEventListener('change', loadHolidays);

// Calendar
async function renderCalendar() {
  const grid = document.getElementById('calendar-grid');
  const monthLabel = document.getElementById('current-month');

  const year = currentCalendarDate.getFullYear();
  const month = currentCalendarDate.getMonth();

  monthLabel.textContent = new Date(year, month).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  // Get first day of month and total days
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrevMonth = new Date(year, month, 0).getDate();

  // Load holidays and public holidays for this month
  const [monthHolidays, publicHolidaysData] = await Promise.all([
    api(`/holidays?year=${year}&month=${month + 1}`),
    api(`/public-holidays/${year}`)
  ]);

  // Create a map of public holidays for quick lookup
  const publicHolidayMap = {};
  if (publicHolidaysData && publicHolidaysData.holidays) {
    publicHolidaysData.holidays.forEach(h => {
      publicHolidayMap[h.date] = h.name;
    });
  }

  let html = '';
  const today = new Date();

  // Previous month days
  for (let i = firstDay - 1; i >= 0; i--) {
    const day = daysInPrevMonth - i;
    html += `<div class="calendar-day other-month"><div class="day-number">${day}</div></div>`;
  }

  // Current month days
  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(year, month, day);
    const dateStr = date.toISOString().split('T')[0];
    const isToday = date.toDateString() === today.toDateString();
    const isWeekend = date.getDay() === 0 || date.getDay() === 6;
    const publicHoliday = publicHolidayMap[dateStr];

    // Find employee holidays for this day
    const dayHolidays = monthHolidays.filter(h => {
      const start = new Date(h.start_date);
      const end = new Date(h.end_date);
      return date >= start && date <= end;
    });

    let classes = 'calendar-day';
    if (isToday) classes += ' today';
    if (isWeekend) classes += ' weekend';
    if (publicHoliday) classes += ' public-holiday';

    html += `
      <div class="${classes}">
        <div class="day-number">${day}</div>
        ${publicHoliday ? `<div class="holiday-event public" title="${publicHoliday}">${publicHoliday}</div>` : ''}
        ${dayHolidays.slice(0, publicHoliday ? 2 : 3).map(h => `
          <div class="holiday-event ${h.type}" title="${h.employee_name}">${h.employee_name}</div>
        `).join('')}
        ${dayHolidays.length > (publicHoliday ? 2 : 3) ? `<div class="holiday-event other">+${dayHolidays.length - (publicHoliday ? 2 : 3)} more</div>` : ''}
      </div>
    `;
  }

  // Next month days
  const totalCells = Math.ceil((firstDay + daysInMonth) / 7) * 7;
  const remaining = totalCells - (firstDay + daysInMonth);
  for (let i = 1; i <= remaining; i++) {
    html += `<div class="calendar-day other-month"><div class="day-number">${i}</div></div>`;
  }

  grid.innerHTML = html;
}

document.getElementById('prev-month').addEventListener('click', () => {
  currentCalendarDate.setMonth(currentCalendarDate.getMonth() - 1);
  renderCalendar();
});

document.getElementById('next-month').addEventListener('click', () => {
  currentCalendarDate.setMonth(currentCalendarDate.getMonth() + 1);
  renderCalendar();
});

// Refresh public holidays from external API
document.getElementById('refresh-public-holidays-btn').addEventListener('click', async () => {
  const btn = document.getElementById('refresh-public-holidays-btn');
  const originalText = btn.textContent;

  if (!confirm('This will fetch the latest public holidays for Ireland from an online source. Continue?')) {
    return;
  }

  try {
    btn.disabled = true;
    btn.textContent = 'Refreshing...';

    const result = await api('/public-holidays/refresh', {
      method: 'POST',
      body: JSON.stringify({ country: 'IE' })
    });

    alert(`Public holidays refreshed successfully!\n${result.count} holidays loaded for years: ${result.years.join(', ')}`);
    renderCalendar();
  } catch (err) {
    alert('Failed to refresh public holidays: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
});

// Timesheet
async function loadTimesheet() {
  try {
    const employeeId = document.getElementById('timesheet-employee-filter').value;
    const startDate = document.getElementById('timesheet-start-date').value;
    const endDate = document.getElementById('timesheet-end-date').value;

    let url = '/timesheet?';
    if (employeeId) url += `employee_id=${employeeId}&`;
    if (startDate) url += `start_date=${startDate}&`;
    if (endDate) url += `end_date=${endDate}`;

    timeEntries = await api(url);
    renderTimesheetTable();

    // Show summary
    const summary = document.getElementById('timesheet-summary');
    const totalHours = timeEntries.reduce((sum, t) => sum + (t.total_hours || 0), 0);
    const overtimeHours = timeEntries.reduce((sum, t) => sum + (t.overtime_hours || 0), 0);
    summary.innerHTML = `
      <span>Total Hours: <strong>${totalHours.toFixed(1)}</strong></span>
      <span>Overtime: <strong>${overtimeHours.toFixed(1)}</strong></span>
      <span>Entries: <strong>${timeEntries.length}</strong></span>
    `;
  } catch (err) {
    console.error('Failed to load timesheet:', err);
  }
}

function renderTimesheetTable() {
  const tbody = document.querySelector('#timesheet-table tbody');
  const isManagerOrAdmin = ['admin', 'manager'].includes(currentUser.role);

  if (timeEntries.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No time entries found</td></tr>';
    return;
  }

  tbody.innerHTML = timeEntries.map(t => `
    <tr>
      <td>${t.first_name} ${t.last_name}</td>
      <td>${formatDate(t.date)}</td>
      <td>${t.clock_in || '-'}</td>
      <td>${t.clock_out || '-'}</td>
      <td>${t.break_minutes || 0} min</td>
      <td>${t.total_hours ? t.total_hours.toFixed(1) : '-'}</td>
      <td>${t.overtime_hours ? t.overtime_hours.toFixed(1) : '-'}</td>
      <td class="actions manager-only">
        ${isManagerOrAdmin ? `
          <button class="btn btn-sm btn-danger" onclick="deleteTimeEntry(${t.id})">Delete</button>
        ` : ''}
      </td>
    </tr>
  `).join('');
}

document.getElementById('clock-in-btn').addEventListener('click', async () => {
  try {
    await api('/timesheet/clock-in', { method: 'POST' });
    alert('Clocked in successfully!');
    loadTimesheet();
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById('clock-out-btn').addEventListener('click', async () => {
  const breakMinutes = prompt('Enter break time in minutes:', '0');
  if (breakMinutes === null) return;

  try {
    await api('/timesheet/clock-out', {
      method: 'POST',
      body: JSON.stringify({ break_minutes: parseInt(breakMinutes) || 0 })
    });
    alert('Clocked out successfully!');
    loadTimesheet();
  } catch (err) {
    alert(err.message);
  }
});

async function deleteTimeEntry(id) {
  if (!confirm('Are you sure you want to delete this time entry?')) return;

  try {
    await api(`/timesheet/${id}`, { method: 'DELETE' });
    loadTimesheet();
  } catch (err) {
    alert(err.message);
  }
}

document.getElementById('filter-timesheet-btn').addEventListener('click', loadTimesheet);
document.getElementById('timesheet-employee-filter').addEventListener('change', loadTimesheet);

// Users
async function loadUsers() {
  try {
    const users = await api('/users');
    renderUsersTable(users);
  } catch (err) {
    console.error('Failed to load users:', err);
  }
}

function renderUsersTable(users) {
  const tbody = document.querySelector('#users-table tbody');

  if (users.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No users found</td></tr>';
    return;
  }

  tbody.innerHTML = users.map(u => `
    <tr>
      <td>${u.email}</td>
      <td><span class="badge ${u.role}">${u.role}</span></td>
      <td>${u.first_name ? `${u.first_name} ${u.last_name}` : '-'}</td>
      <td>${u.last_login ? formatDate(u.last_login) : 'Never'}</td>
      <td class="actions">
        <button class="btn btn-sm" onclick="editUser(${u.id}, '${u.email}', '${u.role}', ${u.employee_id || 'null'})">Edit</button>
        <button class="btn btn-sm btn-danger" onclick="deleteUser(${u.id})">Delete</button>
      </td>
    </tr>
  `).join('');
}

document.getElementById('add-user-btn').addEventListener('click', () => {
  document.getElementById('user-modal-title').textContent = 'Add User';
  document.getElementById('user-form').reset();
  document.getElementById('user-id').value = '';
  document.getElementById('password-required').textContent = '*';
  document.getElementById('user-password').required = true;
  openModal('user-modal');
});

function editUser(id, email, role, employeeId) {
  document.getElementById('user-modal-title').textContent = 'Edit User';
  document.getElementById('user-id').value = id;
  document.getElementById('user-email-input').value = email;
  document.getElementById('user-password').value = '';
  document.getElementById('user-role-select').value = role;
  document.getElementById('user-employee').value = employeeId || '';
  document.getElementById('password-required').textContent = '';
  document.getElementById('user-password').required = false;
  openModal('user-modal');
}

async function deleteUser(id) {
  if (!confirm('Are you sure you want to delete this user?')) return;

  try {
    await api(`/users/${id}`, { method: 'DELETE' });
    loadUsers();
  } catch (err) {
    alert(err.message);
  }
}

document.getElementById('user-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const id = document.getElementById('user-id').value;
  const data = {
    email: document.getElementById('user-email-input').value,
    role: document.getElementById('user-role-select').value,
    employee_id: document.getElementById('user-employee').value || null
  };

  const password = document.getElementById('user-password').value;
  if (password) {
    data.password = password;
  }

  try {
    if (id) {
      await api(`/users/${id}`, { method: 'PUT', body: JSON.stringify(data) });
    } else {
      if (!password) {
        alert('Password is required for new users');
        return;
      }
      await api('/users', { method: 'POST', body: JSON.stringify(data) });
    }
    closeModal('user-modal');
    loadUsers();
  } catch (err) {
    alert(err.message);
  }
});

// Helpers
function formatDate(dateStr) {
  if (!dateStr) return '-';
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

// Login form
document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;
  const errorEl = document.getElementById('login-error');

  try {
    errorEl.textContent = '';
    await login(email, password);
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

// Logout
document.getElementById('logout-btn').addEventListener('click', logout);

// Initialize
initYearFilter();
checkAuth();
