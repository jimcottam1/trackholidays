const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const https = require('https');
const { db, initDatabase } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'hr-system-secret-key-change-in-production';

// Get public holidays as a Set of date strings for quick lookup
async function getPublicHolidayDates() {
  const result = await db.execute('SELECT holidays_json FROM public_holidays LIMIT 1');
  if (result.rows.length > 0 && result.rows[0].holidays_json) {
    const holidays = JSON.parse(result.rows[0].holidays_json);
    return new Set(holidays.map(h => h.date));
  }
  return new Set();
}

// Calculate working days between two dates (excluding weekends and public holidays)
async function calculateWorkingDays(startDate, endDate) {
  const publicHolidays = await getPublicHolidayDates();
  const start = new Date(startDate);
  const end = new Date(endDate);
  let days = 0;
  const current = new Date(start);

  while (current <= end) {
    const dayOfWeek = current.getDay();
    const dateStr = current.toISOString().split('T')[0];

    if (dayOfWeek !== 0 && dayOfWeek !== 6 && !publicHolidays.has(dateStr)) {
      days++;
    }
    current.setDate(current.getDate() + 1);
  }

  return days;
}

// Initialize default data
async function initializeData() {
  try {
    // Default admin user
    const adminCheck = await db.execute('SELECT id FROM users WHERE email = ?', ['admin@company.com']);
    if (adminCheck.rows.length === 0) {
      const hashedPassword = bcrypt.hashSync('admin123', 10);
      await db.execute(
        'INSERT INTO users (email, password, role) VALUES (?, ?, ?)',
        ['admin@company.com', hashedPassword, 'admin']
      );
      console.log('Default admin user created');
    }

    // Default departments
    const deptCheck = await db.execute('SELECT COUNT(*) as count FROM departments');
    if (deptCheck.rows[0].count === 0) {
      const depts = ['Engineering', 'Human Resources', 'Sales', 'Marketing', 'Finance'];
      for (const name of depts) {
        await db.execute('INSERT INTO departments (name) VALUES (?)', [name]);
      }
      console.log('Default departments created');
    }

    // Default settings
    const settingsCheck = await db.execute('SELECT id FROM settings LIMIT 1');
    if (settingsCheck.rows.length === 0) {
      await db.execute('INSERT INTO settings (company_name, working_hours_per_day) VALUES (?, ?)', ['My Company', 8]);
      console.log('Default settings created');
    }
  } catch (err) {
    console.error('Error initializing data:', err);
  }
}

// Middleware
app.use(cors({ credentials: true, origin: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));

// Auth middleware
function authenticate(req, res, next) {
  const token = req.cookies.token || req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// ============ AUTH ROUTES ============

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const result = await db.execute('SELECT * FROM users WHERE email = ?', [email]);
    const user = result.rows[0];

    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Update last login
    await db.execute('UPDATE users SET last_login = ? WHERE id = ?', [new Date().toISOString(), user.id]);

    // Get employee info if linked
    let employee = null;
    if (user.employee_id) {
      const empResult = await db.execute('SELECT * FROM employees WHERE id = ?', [user.employee_id]);
      employee = empResult.rows[0] || null;
    }

    const token = jwt.sign(
      { id: user.id.toString(), email: user.email, role: user.role, employeeId: user.employee_id?.toString() },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.cookie('token', token, { httpOnly: true, maxAge: 24 * 60 * 60 * 1000 });
    res.json({
      user: { id: user.id, email: user.email, role: user.role, employee },
      token
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ message: 'Logged out' });
});

app.get('/api/auth/me', authenticate, async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM users WHERE id = ?', [req.user.id]);
    const user = result.rows[0];

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    let employee = null;
    if (user.employee_id) {
      const empResult = await db.execute(`
        SELECT e.*, d.name as department_name
        FROM employees e
        LEFT JOIN departments d ON e.department_id = d.id
        WHERE e.id = ?
      `, [user.employee_id]);
      employee = empResult.rows[0] || null;
    }

    res.json({
      id: user.id,
      email: user.email,
      role: user.role,
      employeeId: user.employee_id,
      employee
    });
  } catch (err) {
    console.error('Auth check error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ USER MANAGEMENT ROUTES ============

app.get('/api/users', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const result = await db.execute(`
      SELECT u.*, e.first_name, e.last_name
      FROM users u
      LEFT JOIN employees e ON u.employee_id = e.id
    `);

    const users = result.rows.map(u => ({
      id: u.id,
      email: u.email,
      role: u.role,
      employee_id: u.employee_id,
      created_at: u.created_at,
      last_login: u.last_login,
      first_name: u.first_name,
      last_name: u.last_name
    }));

    res.json(users);
  } catch (err) {
    console.error('Get users error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/users', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const { email, password, role, employee_id } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const existing = await db.execute('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Email already exists' });
    }

    const hashedPassword = bcrypt.hashSync(password, 10);
    const result = await db.execute(
      'INSERT INTO users (email, password, role, employee_id) VALUES (?, ?, ?, ?) RETURNING id',
      [email, hashedPassword, role || 'employee', employee_id || null]
    );

    res.status(201).json({ id: result.rows[0].id, email, role: role || 'employee' });
  } catch (err) {
    console.error('Create user error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/users/:id', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const { email, password, role, employee_id } = req.body;

    const existing = await db.execute('SELECT id FROM users WHERE id = ?', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (password) {
      const hashedPassword = bcrypt.hashSync(password, 10);
      await db.execute(
        'UPDATE users SET email = ?, password = ?, role = ?, employee_id = ? WHERE id = ?',
        [email, hashedPassword, role, employee_id || null, id]
      );
    } else {
      await db.execute(
        'UPDATE users SET email = ?, role = ?, employee_id = ? WHERE id = ?',
        [email, role, employee_id || null, id]
      );
    }

    res.json({ message: 'User updated' });
  } catch (err) {
    console.error('Update user error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/users/:id', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.execute('DELETE FROM users WHERE id = ? RETURNING id', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ message: 'User deleted' });
  } catch (err) {
    console.error('Delete user error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ DEPARTMENT ROUTES ============

app.get('/api/departments', authenticate, async (req, res) => {
  try {
    const result = await db.execute(`
      SELECT d.*,
        (SELECT COUNT(*) FROM employees WHERE department_id = d.id AND status = 'active') as employee_count,
        e.first_name || ' ' || e.last_name as manager_name
      FROM departments d
      LEFT JOIN employees e ON d.manager_id = e.id
    `);

    const departments = result.rows.map(d => ({
      id: d.id,
      name: d.name,
      managerId: d.manager_id,
      createdAt: d.created_at,
      employee_count: d.employee_count,
      manager_name: d.manager_name
    }));

    res.json(departments);
  } catch (err) {
    console.error('Get departments error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/departments', authenticate, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { name, manager_id } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Department name required' });
    }

    const result = await db.execute(
      'INSERT INTO departments (name, manager_id) VALUES (?, ?) RETURNING id',
      [name, manager_id || null]
    );

    res.status(201).json({ id: result.rows[0].id, name, managerId: manager_id });
  } catch (err) {
    console.error('Create department error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/departments/:id', authenticate, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, manager_id } = req.body;

    const existing = await db.execute('SELECT id FROM departments WHERE id = ?', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Department not found' });
    }

    await db.execute(
      'UPDATE departments SET name = ?, manager_id = ? WHERE id = ?',
      [name, manager_id || null, id]
    );

    res.json({ message: 'Department updated' });
  } catch (err) {
    console.error('Update department error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/departments/:id', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const { id } = req.params;

    const empCheck = await db.execute('SELECT id FROM employees WHERE department_id = ? LIMIT 1', [id]);
    if (empCheck.rows.length > 0) {
      return res.status(400).json({ error: 'Cannot delete department with employees' });
    }

    const result = await db.execute('DELETE FROM departments WHERE id = ? RETURNING id', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Department not found' });
    }

    res.json({ message: 'Department deleted' });
  } catch (err) {
    console.error('Delete department error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ EMPLOYEE ROUTES ============

app.get('/api/employees', authenticate, async (req, res) => {
  try {
    const { status, department_id } = req.query;
    let query = `
      SELECT e.*, d.name as department_name
      FROM employees e
      LEFT JOIN departments d ON e.department_id = d.id
      WHERE 1=1
    `;
    const params = [];

    if (status) {
      query += ' AND e.status = ?';
      params.push(status);
    }
    if (department_id) {
      query += ' AND e.department_id = ?';
      params.push(department_id);
    }

    query += ' ORDER BY e.last_name, e.first_name';

    const result = await db.execute(query, params);

    const employees = result.rows.map(e => ({
      id: e.id,
      employee_number: e.employee_number,
      first_name: e.first_name,
      last_name: e.last_name,
      email: e.email,
      phone: e.phone,
      department_id: e.department_id,
      department_name: e.department_name,
      job_title: e.job_title,
      start_date: e.start_date,
      salary: e.salary,
      holiday_allowance: e.holiday_allowance,
      address: e.address,
      emergency_contact_name: e.emergency_contact_name,
      emergency_contact_phone: e.emergency_contact_phone,
      status: e.status
    }));

    res.json(employees);
  } catch (err) {
    console.error('Get employees error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/employees/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.execute(`
      SELECT e.*, d.name as department_name
      FROM employees e
      LEFT JOIN departments d ON e.department_id = d.id
      WHERE e.id = ?
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    const e = result.rows[0];
    res.json({
      id: e.id,
      employeeNumber: e.employee_number,
      firstName: e.first_name,
      lastName: e.last_name,
      email: e.email,
      phone: e.phone,
      departmentId: e.department_id,
      department_name: e.department_name,
      jobTitle: e.job_title,
      startDate: e.start_date,
      salary: e.salary,
      holidayAllowance: e.holiday_allowance,
      address: e.address,
      emergencyContactName: e.emergency_contact_name,
      emergencyContactPhone: e.emergency_contact_phone,
      status: e.status
    });
  } catch (err) {
    console.error('Get employee error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/employees', authenticate, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const {
      employee_number, first_name, last_name, email, phone,
      department_id, job_title, start_date, salary, holiday_allowance,
      address, emergency_contact_name, emergency_contact_phone
    } = req.body;

    if (!first_name || !last_name || !email) {
      return res.status(400).json({ error: 'First name, last name, and email required' });
    }

    const emailCheck = await db.execute('SELECT id FROM employees WHERE email = ?', [email]);
    if (emailCheck.rows.length > 0) {
      return res.status(400).json({ error: 'Email already exists' });
    }

    if (employee_number) {
      const numCheck = await db.execute('SELECT id FROM employees WHERE employee_number = ?', [employee_number]);
      if (numCheck.rows.length > 0) {
        return res.status(400).json({ error: 'Employee number already exists' });
      }
    }

    const result = await db.execute(`
      INSERT INTO employees (
        employee_number, first_name, last_name, email, phone,
        department_id, job_title, start_date, salary, holiday_allowance,
        address, emergency_contact_name, emergency_contact_phone, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
    `, [
      employee_number || null, first_name, last_name, email, phone || null,
      department_id || null, job_title || null, start_date || null, salary || null,
      holiday_allowance || 25, address || null, emergency_contact_name || null,
      emergency_contact_phone || null, 'active'
    ]);

    res.status(201).json({ id: result.rows[0].id, first_name, last_name, email });
  } catch (err) {
    console.error('Create employee error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/employees/:id', authenticate, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { id } = req.params;
    const {
      employee_number, first_name, last_name, email, phone,
      department_id, job_title, start_date, salary, holiday_allowance,
      address, emergency_contact_name, emergency_contact_phone, status
    } = req.body;

    const existing = await db.execute('SELECT id FROM employees WHERE id = ?', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    await db.execute(`
      UPDATE employees SET
        employee_number = ?, first_name = ?, last_name = ?, email = ?, phone = ?,
        department_id = ?, job_title = ?, start_date = ?, salary = ?, holiday_allowance = ?,
        address = ?, emergency_contact_name = ?, emergency_contact_phone = ?, status = ?,
        updated_at = ?
      WHERE id = ?
    `, [
      employee_number || null, first_name, last_name, email, phone || null,
      department_id || null, job_title || null, start_date || null, salary || null,
      holiday_allowance || 25, address || null, emergency_contact_name || null,
      emergency_contact_phone || null, status || 'active', new Date().toISOString(), id
    ]);

    res.json({ message: 'Employee updated' });
  } catch (err) {
    console.error('Update employee error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/employees/:id', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const { id } = req.params;

    const result = await db.execute('DELETE FROM employees WHERE id = ? RETURNING id', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    // Also delete their holidays and time entries
    await db.execute('DELETE FROM holidays WHERE employee_id = ?', [id]);
    await db.execute('DELETE FROM time_entries WHERE employee_id = ?', [id]);

    res.json({ message: 'Employee deleted' });
  } catch (err) {
    console.error('Delete employee error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ HOLIDAY ROUTES ============

app.get('/api/holidays', authenticate, async (req, res) => {
  try {
    const { employee_id, year, month } = req.query;
    let query = `
      SELECT h.*, e.first_name, e.last_name
      FROM holidays h
      LEFT JOIN employees e ON h.employee_id = e.id
      WHERE 1=1
    `;
    const params = [];

    if (employee_id) {
      query += ' AND h.employee_id = ?';
      params.push(employee_id);
    }

    query += ' ORDER BY h.start_date DESC';

    const result = await db.execute(query, params);

    let holidays = result.rows.map(h => ({
      id: h.id,
      employee_id: h.employee_id,
      employee_name: h.first_name && h.last_name ? `${h.first_name} ${h.last_name}` : 'Unknown',
      first_name: h.first_name,
      last_name: h.last_name,
      start_date: h.start_date,
      end_date: h.end_date,
      days: h.days,
      type: h.type,
      notes: h.notes,
      status: h.status,
      created_at: h.created_at
    }));

    if (year) {
      holidays = holidays.filter(h => new Date(h.start_date).getFullYear().toString() === year);
    }
    if (month) {
      holidays = holidays.filter(h => (new Date(h.start_date).getMonth() + 1).toString().padStart(2, '0') === month.padStart(2, '0'));
    }

    res.json(holidays);
  } catch (err) {
    console.error('Get holidays error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/holidays', authenticate, async (req, res) => {
  try {
    const { employee_id, start_date, end_date, type, notes } = req.body;

    const targetEmployeeId = employee_id || req.user.employeeId;

    if (req.user.role === 'employee' && targetEmployeeId !== req.user.employeeId) {
      return res.status(403).json({ error: 'Cannot book holidays for others' });
    }

    if (!targetEmployeeId || !start_date || !end_date) {
      return res.status(400).json({ error: 'Employee, start date, and end date required' });
    }

    const empCheck = await db.execute('SELECT id FROM employees WHERE id = ?', [targetEmployeeId]);
    if (empCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    const days = await calculateWorkingDays(start_date, end_date);

    const result = await db.execute(`
      INSERT INTO holidays (employee_id, start_date, end_date, days, type, notes, status)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id
    `, [targetEmployeeId, start_date, end_date, days, type || 'annual', notes || null, 'approved']);

    res.status(201).json({ id: result.rows[0].id, employee_id: targetEmployeeId, start_date, end_date, days });
  } catch (err) {
    console.error('Create holiday error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/holidays/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { start_date, end_date, type, notes, status } = req.body;

    const existing = await db.execute('SELECT * FROM holidays WHERE id = ?', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Holiday not found' });
    }

    const holiday = existing.rows[0];

    if (req.user.role === 'employee' && holiday.employee_id.toString() !== req.user.employeeId) {
      return res.status(403).json({ error: 'Cannot edit others holidays' });
    }

    const newStartDate = start_date || holiday.start_date;
    const newEndDate = end_date || holiday.end_date;
    const days = await calculateWorkingDays(newStartDate, newEndDate);

    await db.execute(`
      UPDATE holidays SET start_date = ?, end_date = ?, days = ?, type = ?, notes = ?, status = ?
      WHERE id = ?
    `, [newStartDate, newEndDate, days, type || holiday.type, notes !== undefined ? notes : holiday.notes, status || holiday.status, id]);

    res.json({ message: 'Holiday updated' });
  } catch (err) {
    console.error('Update holiday error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/holidays/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await db.execute('SELECT * FROM holidays WHERE id = ?', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Holiday not found' });
    }

    const holiday = existing.rows[0];

    if (req.user.role === 'employee' && holiday.employee_id.toString() !== req.user.employeeId) {
      return res.status(403).json({ error: 'Cannot delete others holidays' });
    }

    await db.execute('DELETE FROM holidays WHERE id = ?', [id]);
    res.json({ message: 'Holiday deleted' });
  } catch (err) {
    console.error('Delete holiday error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/holidays/summary/:employeeId', authenticate, async (req, res) => {
  try {
    const { employeeId } = req.params;
    const year = req.query.year || new Date().getFullYear();

    const empResult = await db.execute('SELECT holiday_allowance FROM employees WHERE id = ?', [employeeId]);
    if (empResult.rows.length === 0) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    const allowance = empResult.rows[0].holiday_allowance;

    const holidaysResult = await db.execute(
      "SELECT SUM(days) as used FROM holidays WHERE employee_id = ? AND status = 'approved' AND type = 'annual' AND strftime('%Y', start_date) = ?",
      [employeeId, year.toString()]
    );

    const used = holidaysResult.rows[0].used || 0;

    res.json({
      allowance,
      used,
      remaining: allowance - used
    });
  } catch (err) {
    console.error('Get holiday summary error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ TIME & ATTENDANCE ROUTES ============

app.get('/api/timesheet', authenticate, async (req, res) => {
  try {
    const { employee_id, start_date, end_date } = req.query;
    let query = `
      SELECT t.*, e.first_name, e.last_name
      FROM time_entries t
      LEFT JOIN employees e ON t.employee_id = e.id
      WHERE 1=1
    `;
    const params = [];

    if (req.user.role === 'employee') {
      query += ' AND t.employee_id = ?';
      params.push(req.user.employeeId);
    } else if (employee_id) {
      query += ' AND t.employee_id = ?';
      params.push(employee_id);
    }

    if (start_date) {
      query += ' AND t.date >= ?';
      params.push(start_date);
    }
    if (end_date) {
      query += ' AND t.date <= ?';
      params.push(end_date);
    }

    query += ' ORDER BY t.date DESC';

    const result = await db.execute(query, params);

    const timeEntries = result.rows.map(t => ({
      id: t.id,
      employee_id: t.employee_id,
      first_name: t.first_name,
      last_name: t.last_name,
      date: t.date,
      clock_in: t.clock_in,
      clock_out: t.clock_out,
      break_minutes: t.break_minutes,
      total_hours: t.total_hours,
      overtime_hours: t.overtime_hours,
      notes: t.notes
    }));

    res.json(timeEntries);
  } catch (err) {
    console.error('Get timesheet error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/timesheet/clock-in', authenticate, async (req, res) => {
  try {
    const employeeId = req.user.employeeId;

    if (!employeeId) {
      return res.status(400).json({ error: 'No employee profile linked to your account' });
    }

    const today = new Date().toISOString().split('T')[0];
    const now = new Date().toTimeString().split(' ')[0].slice(0, 5);

    const existing = await db.execute(
      'SELECT id FROM time_entries WHERE employee_id = ? AND date = ? AND clock_out IS NULL',
      [employeeId, today]
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Already clocked in today' });
    }

    const result = await db.execute(
      'INSERT INTO time_entries (employee_id, date, clock_in) VALUES (?, ?, ?) RETURNING id',
      [employeeId, today, now]
    );

    res.status(201).json({ id: result.rows[0].id, date: today, clock_in: now });
  } catch (err) {
    console.error('Clock in error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/timesheet/clock-out', authenticate, async (req, res) => {
  try {
    const employeeId = req.user.employeeId;
    const { break_minutes } = req.body;

    if (!employeeId) {
      return res.status(400).json({ error: 'No employee profile linked to your account' });
    }

    const today = new Date().toISOString().split('T')[0];
    const now = new Date().toTimeString().split(' ')[0].slice(0, 5);

    const existing = await db.execute(
      'SELECT * FROM time_entries WHERE employee_id = ? AND date = ? AND clock_out IS NULL',
      [employeeId, today]
    );
    if (existing.rows.length === 0) {
      return res.status(400).json({ error: 'No active clock-in found for today' });
    }

    const entry = existing.rows[0];

    // Calculate hours
    const clockIn = entry.clock_in.split(':');
    const clockOut = now.split(':');
    const inMinutes = parseInt(clockIn[0]) * 60 + parseInt(clockIn[1]);
    const outMinutes = parseInt(clockOut[0]) * 60 + parseInt(clockOut[1]);
    const breakMins = break_minutes || 0;
    const totalMinutes = outMinutes - inMinutes - breakMins;
    const totalHours = Math.round((totalMinutes / 60) * 100) / 100;
    const overtime = Math.max(0, totalHours - 8);

    await db.execute(
      'UPDATE time_entries SET clock_out = ?, break_minutes = ?, total_hours = ?, overtime_hours = ? WHERE id = ?',
      [now, breakMins, totalHours, overtime, entry.id]
    );

    res.json({ clock_out: now, total_hours: totalHours, overtime_hours: overtime });
  } catch (err) {
    console.error('Clock out error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/timesheet', authenticate, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { employee_id, date, clock_in, clock_out, break_minutes, notes } = req.body;

    if (!employee_id || !date || !clock_in) {
      return res.status(400).json({ error: 'Employee, date, and clock in time required' });
    }

    let totalHours = null;
    let overtime = 0;

    if (clock_out) {
      const inParts = clock_in.split(':');
      const outParts = clock_out.split(':');
      const inMinutes = parseInt(inParts[0]) * 60 + parseInt(inParts[1]);
      const outMinutes = parseInt(outParts[0]) * 60 + parseInt(outParts[1]);
      const breakMins = break_minutes || 0;
      const totalMinutes = outMinutes - inMinutes - breakMins;
      totalHours = Math.round((totalMinutes / 60) * 100) / 100;
      overtime = Math.max(0, totalHours - 8);
    }

    const result = await db.execute(`
      INSERT INTO time_entries (employee_id, date, clock_in, clock_out, break_minutes, total_hours, overtime_hours, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
    `, [employee_id, date, clock_in, clock_out || null, break_minutes || 0, totalHours, overtime, notes || null]);

    res.status(201).json({ id: result.rows[0].id });
  } catch (err) {
    console.error('Create time entry error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/timesheet/:id', authenticate, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { id } = req.params;

    const result = await db.execute('DELETE FROM time_entries WHERE id = ? RETURNING id', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Time entry not found' });
    }

    res.json({ message: 'Time entry deleted' });
  } catch (err) {
    console.error('Delete time entry error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ DASHBOARD STATS ============

app.get('/api/dashboard/stats', authenticate, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    const empResult = await db.execute("SELECT COUNT(*) as count FROM employees WHERE status = 'active'");
    const totalEmployees = empResult.rows[0].count;

    const holidayResult = await db.execute(
      "SELECT COUNT(*) as count FROM holidays WHERE status = 'approved' AND ? BETWEEN start_date AND end_date",
      [today]
    );
    const onHolidayToday = holidayResult.rows[0].count;

    const clockedResult = await db.execute(
      'SELECT COUNT(*) as count FROM time_entries WHERE date = ? AND clock_in IS NOT NULL AND clock_out IS NULL',
      [today]
    );
    const clockedInToday = clockedResult.rows[0].count;

    res.json({
      totalEmployees,
      onHolidayToday,
      clockedInToday
    });
  } catch (err) {
    console.error('Get dashboard stats error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============ PUBLIC HOLIDAYS ============

app.get('/api/public-holidays', authenticate, async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM public_holidays LIMIT 1');
    if (result.rows.length > 0) {
      const row = result.rows[0];
      res.json({
        country: row.country,
        lastUpdated: row.last_updated,
        holidays: JSON.parse(row.holidays_json || '[]')
      });
    } else {
      res.json({ country: 'Ireland', holidays: [] });
    }
  } catch (err) {
    console.error('Get public holidays error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/public-holidays/:year', authenticate, async (req, res) => {
  try {
    const { year } = req.params;
    const result = await db.execute('SELECT * FROM public_holidays LIMIT 1');

    if (result.rows.length > 0) {
      const row = result.rows[0];
      const holidays = JSON.parse(row.holidays_json || '[]');
      const filtered = holidays.filter(h => h.date.startsWith(year));
      res.json({ country: row.country, holidays: filtered });
    } else {
      res.json({ country: 'Ireland', holidays: [] });
    }
  } catch (err) {
    console.error('Get public holidays by year error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/public-holidays', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const { date, name } = req.body;

    if (!date || !name) {
      return res.status(400).json({ error: 'Date and name required' });
    }

    const result = await db.execute('SELECT * FROM public_holidays LIMIT 1');
    let holidays = [];

    if (result.rows.length > 0) {
      holidays = JSON.parse(result.rows[0].holidays_json || '[]');
      holidays.push({ date, name });
      holidays.sort((a, b) => a.date.localeCompare(b.date));
      await db.execute('UPDATE public_holidays SET holidays_json = ? WHERE id = ?', [JSON.stringify(holidays), result.rows[0].id]);
    } else {
      holidays = [{ date, name }];
      await db.execute('INSERT INTO public_holidays (country, holidays_json) VALUES (?, ?)', ['Ireland', JSON.stringify(holidays)]);
    }

    res.status(201).json({ date, name });
  } catch (err) {
    console.error('Add public holiday error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/public-holidays/:date', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const { date } = req.params;
    const result = await db.execute('SELECT * FROM public_holidays LIMIT 1');

    if (result.rows.length > 0) {
      let holidays = JSON.parse(result.rows[0].holidays_json || '[]');
      holidays = holidays.filter(h => h.date !== date);
      await db.execute('UPDATE public_holidays SET holidays_json = ? WHERE id = ?', [JSON.stringify(holidays), result.rows[0].id]);
    }

    res.json({ message: 'Public holiday deleted' });
  } catch (err) {
    console.error('Delete public holiday error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Fetch public holidays from Nager.Date API
function fetchHolidaysFromAPI(year, countryCode) {
  return new Promise((resolve, reject) => {
    const url = `https://date.nager.at/api/v3/PublicHolidays/${year}/${countryCode}`;

    https.get(url, (response) => {
      let data = '';

      response.on('data', chunk => {
        data += chunk;
      });

      response.on('end', () => {
        try {
          if (response.statusCode === 200) {
            const holidays = JSON.parse(data);
            resolve(holidays);
          } else {
            reject(new Error(`API returned status ${response.statusCode}`));
          }
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

app.post('/api/public-holidays/refresh', authenticate, requireRole('admin'), async (req, res) => {
  const { country = 'IE', years } = req.body;

  const currentYear = new Date().getFullYear();
  const yearsToFetch = years || [currentYear, currentYear + 1];

  try {
    const allHolidays = [];

    for (const year of yearsToFetch) {
      const holidays = await fetchHolidaysFromAPI(year, country);
      holidays.forEach(h => {
        allHolidays.push({
          date: h.date,
          name: h.localName || h.name
        });
      });
    }

    allHolidays.sort((a, b) => a.date.localeCompare(b.date));

    const countryNames = {
      'IE': 'Ireland',
      'GB': 'United Kingdom',
      'US': 'United States',
      'DE': 'Germany',
      'FR': 'France'
    };

    const existing = await db.execute('SELECT id FROM public_holidays LIMIT 1');
    if (existing.rows.length > 0) {
      await db.execute(
        'UPDATE public_holidays SET country = ?, last_updated = ?, holidays_json = ? WHERE id = ?',
        [countryNames[country] || country, new Date().toISOString(), JSON.stringify(allHolidays), existing.rows[0].id]
      );
    } else {
      await db.execute(
        'INSERT INTO public_holidays (country, last_updated, holidays_json) VALUES (?, ?, ?)',
        [countryNames[country] || country, new Date().toISOString(), JSON.stringify(allHolidays)]
      );
    }

    res.json({
      message: 'Public holidays refreshed successfully',
      count: allHolidays.length,
      years: yearsToFetch
    });
  } catch (err) {
    console.error('Failed to refresh public holidays:', err);
    res.status(500).json({ error: 'Failed to fetch public holidays: ' + err.message });
  }
});

// ============ SETTINGS ============

app.get('/api/settings', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM settings LIMIT 1');
    if (result.rows.length > 0) {
      res.json({
        companyName: result.rows[0].company_name,
        workingHoursPerDay: result.rows[0].working_hours_per_day
      });
    } else {
      res.json({ companyName: 'My Company', workingHoursPerDay: 8 });
    }
  } catch (err) {
    console.error('Get settings error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/settings', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const { companyName, workingHoursPerDay } = req.body;

    const existing = await db.execute('SELECT id FROM settings LIMIT 1');
    if (existing.rows.length > 0) {
      await db.execute(
        'UPDATE settings SET company_name = ?, working_hours_per_day = ? WHERE id = ?',
        [companyName, workingHoursPerDay, existing.rows[0].id]
      );
    } else {
      await db.execute(
        'INSERT INTO settings (company_name, working_hours_per_day) VALUES (?, ?)',
        [companyName, workingHoursPerDay]
      );
    }

    res.json({ message: 'Settings updated' });
  } catch (err) {
    console.error('Update settings error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Start server
async function start() {
  try {
    await initDatabase();
    await initializeData();

    app.listen(PORT, () => {
      console.log(`\nHR System running at http://localhost:${PORT}`);
      console.log(`\nDefault login credentials:`);
      console.log(`  Email: admin@company.com`);
      console.log(`  Password: admin123\n`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
