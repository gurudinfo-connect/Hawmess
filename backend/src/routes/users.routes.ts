import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { query } from '../db/pool';
import { requireAuth, requireRole, logAudit } from '../lib/auth';
import { UUID_RE } from '../lib/access';
import { joinDefaultChannels } from '../lib/chat';

const router = Router();
router.use(requireAuth);

const ROLES = ['admin', 'hr', 'employee'] as const;
const pw = z.string().min(8, 'Password must be at least 8 characters').max(128);

// ---------- MY PROFILE (every role) ----------
const PROFILE_SELECT = `SELECT u.id, u.name, u.email, u.phone, d.name AS department, u.department_id, u.designation, u.theme, u.notif_prefs, u.profile_photo, u.is_active, u.created_at, u.last_login_at, r.name AS role
  FROM users u LEFT JOIN departments d ON d.id=u.department_id JOIN company_users cu ON cu.user_id=u.id JOIN roles r ON r.id=cu.role_id`;
router.get('/me', async (req, res) => {
  res.json((await query(`${PROFILE_SELECT} WHERE u.id=$1`, [req.user!.id]))[0]);
});
router.patch('/me', async (req, res) => {
  // Role, e-mail, status and permissions can never be changed here - a request that tries is refused outright.
  const forbidden = ['role', 'role_id', 'permissions', 'is_active', 'email', 'company_id', 'password', 'password_hash', 'id'].filter(k => k in (req.body || {}));
  if (forbidden.length) {
    await logAudit({ company_id: req.user!.company_id, user_id: req.user!.id, action: 'denied', entity_type: 'user', entity_id: req.user!.id, description: `${req.user!.role.replace(/_/g, ' ')} attempted to change ${forbidden.join(', ')} on own profile` });
    return res.status(403).json({ error: `Forbidden: you cannot change ${forbidden.join(', ')}. Only an admin can change these.` });
  }
  const p = z.object({ name: z.string().trim().min(1).max(120).optional(), phone: z.string().max(30).optional().nullable(), profile_photo: z.string().max(400000).optional().nullable(), theme: z.enum(['light', 'dark']).optional(), notif_prefs: z.object({ inapp: z.boolean(), email: z.boolean() }).optional() }).strict().safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'Invalid profile data' });
  const f = Object.keys(p.data); if (!f.length) return res.json((await query(`${PROFILE_SELECT} WHERE u.id=$1`, [req.user!.id]))[0]);
  await query(`UPDATE users SET ${f.map((k, i) => `${k}=$${i + 1}`).join(', ')} WHERE id=$${f.length + 1}`, [...f.map(k => k === 'notif_prefs' ? JSON.stringify((p.data as any)[k]) : (p.data as any)[k]), req.user!.id]);
  await logAudit({ company_id: req.user!.company_id, user_id: req.user!.id, action: 'update', entity_type: 'user', entity_id: req.user!.id, description: `${req.user!.role.replace(/_/g, ' ')} updated own profile` });
  res.json((await query(`${PROFILE_SELECT} WHERE u.id=$1`, [req.user!.id]))[0]);
});
router.post('/me/password', async (req, res) => {
  const p = z.object({ current_password: z.string().min(1), new_password: pw }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: p.error.issues[0]?.message || 'Invalid password' });
  const u = (await query<any>(`SELECT password_hash FROM users WHERE id=$1`, [req.user!.id]))[0];
  if (!(await bcrypt.compare(p.data.current_password, u.password_hash))) return res.status(400).json({ error: 'Current password is incorrect' });
  await query(`UPDATE users SET password_hash=$1 WHERE id=$2`, [await bcrypt.hash(p.data.new_password, 10), req.user!.id]);
  await logAudit({ company_id: req.user!.company_id, user_id: req.user!.id, action: 'change_password', entity_type: 'user', entity_id: req.user!.id, description: `${req.user!.role.replace(/_/g, ' ')} changed own password` });
  res.json({ ok: true });
});


// ---------- DIRECTORY (admin + HR) and LOOKUP (every signed-in user: needed for chat, task assignment, mentions) ----------
router.get('/directory/list', requireRole('admin', 'hr'), async (req, res) => {
  const params: any[] = [req.user!.company_id]; const conds = ['cu.company_id=$1'];
  const role = String(req.query.role || ''); if ((ROLES as readonly string[]).includes(role)) { params.push(role); conds.push(`r.name=$${params.length}`); }
  if (req.user!.role === 'hr' && !role) conds.push(`r.name IN ('employee','hr','admin')`);
  const dept = String(req.query.department_id || ''); if (UUID_RE.test(dept)) { params.push(dept); conds.push(`u.department_id=$${params.length}`); }
  const status = String(req.query.status || 'active'); if (status === 'active') conds.push('u.is_active'); else if (status === 'inactive') conds.push('NOT u.is_active');
  const s = String(req.query.search || '').trim(); if (s) { params.push(`%${s}%`); conds.push(`(u.name ILIKE $${params.length} OR u.email ILIKE $${params.length} OR u.designation ILIKE $${params.length})`); }
  const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1); const size = Math.min(200, parseInt(String(req.query.pageSize || '60'), 10) || 60);
  const base = `FROM users u LEFT JOIN departments d ON d.id=u.department_id JOIN company_users cu ON cu.user_id=u.id JOIN roles r ON r.id=cu.role_id WHERE ${conds.join(' AND ')}`;
  const total = (await query<any>(`SELECT COUNT(*)::int n ${base}`, params))[0].n;
  const rows = await query(`SELECT u.id, u.name, u.email, u.phone, u.designation, d.name AS department, u.department_id, u.is_active, u.last_login_at, r.name AS role, ${STATS} ${base} ORDER BY u.name LIMIT ${size} OFFSET ${(page - 1) * size}`, params);
  const departments = await query(`SELECT d.id, d.name, COUNT(u.id)::int AS count FROM departments d LEFT JOIN users u ON u.department_id=d.id AND u.is_active WHERE d.company_id=$1 GROUP BY d.id ORDER BY d.name`, [req.user!.company_id]);
  res.json({ data: rows, total, departments });
});
router.get('/lookup/all', async (req, res) => {
  res.json({ data: await query(`SELECT u.id, u.name, u.designation, d.name AS department, r.name AS role FROM users u LEFT JOIN departments d ON d.id=u.department_id JOIN company_users cu ON cu.user_id=u.id JOIN roles r ON r.id=cu.role_id WHERE cu.company_id=$1 AND u.is_active ORDER BY u.name`, [req.user!.company_id]) });
});

// ---------- USER MANAGEMENT (admin only) ----------
const STATS = `
  (SELECT COUNT(*)::int FROM tickets t WHERE t.requester_id=u.id) AS tickets_raised,
  (SELECT COUNT(*)::int FROM tickets t WHERE t.assignee_id=u.id AND t.status NOT IN ('resolved','closed','cancelled')) AS tickets_assigned,
  (SELECT COUNT(*)::int FROM tasks t WHERE t.assigned_to=u.id AND t.status IN ('pending','in_progress')) AS open_tasks,
  (SELECT COUNT(*)::int FROM tasks t WHERE t.assigned_to=u.id AND t.status='completed') AS completed_tasks`;

router.get('/', requireRole('admin'), async (req, res) => {
  const cid = req.user!.company_id; const params: any[] = [cid]; const conds = ['cu.company_id=$1'];
  const role = String(req.query.role || ''); if (role && (ROLES as readonly string[]).includes(role)) { params.push(role); conds.push(`r.name=$${params.length}`); }
  const status = String(req.query.status || ''); if (status === 'active') conds.push('u.is_active'); if (status === 'inactive') conds.push('NOT u.is_active');
  const search = String(req.query.search || '').trim(); if (search) { params.push(`%${search}%`); conds.push(`(u.name ILIKE $${params.length} OR u.email ILIKE $${params.length} OR u.phone ILIKE $${params.length})`); }
  const rows = await query(`SELECT u.id, u.name, u.email, u.phone, d.name AS department, u.department_id, u.designation, u.profile_photo, u.is_active, u.created_at, u.last_login_at, r.name AS role, ${STATS}
    FROM users u LEFT JOIN departments d ON d.id=u.department_id JOIN company_users cu ON cu.user_id=u.id JOIN roles r ON r.id=cu.role_id WHERE ${conds.join(' AND ')} ORDER BY u.created_at`, params);
  res.json({ data: rows });
});

router.get('/:id', requireRole('admin', 'hr'), async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'User not found' });
  const rows = await query<any>(`SELECT u.id, u.name, u.email, u.phone, d.name AS department, u.department_id, u.designation, u.is_active, u.created_at, u.last_login_at, r.name AS role, ${STATS}
    FROM users u LEFT JOIN departments d ON d.id=u.department_id JOIN company_users cu ON cu.user_id=u.id JOIN roles r ON r.id=cu.role_id WHERE u.id=$1 AND cu.company_id=$2`, [req.params.id, req.user!.company_id]);
  if (!rows.length) return res.status(404).json({ error: 'User not found' });
  const id = req.params.id; const isAdminUser = req.user!.role === 'admin';
  res.json({ ...rows[0],
    teams: await query(`SELECT t.id, t.name FROM team_members m JOIN teams t ON t.id=m.team_id WHERE m.user_id=$1`, [id]),
    projects: await query(`SELECT p.id, p.code, p.name, p.status FROM projects p WHERE p.manager_id=$1 OR EXISTS (SELECT 1 FROM project_members m WHERE m.project_id=p.id AND m.user_id=$1) ORDER BY p.created_at DESC LIMIT 20`, [id]),
    tickets: await query(`SELECT id, ticket_no, subject, status, priority FROM tickets WHERE requester_id=$1 ${isAdminUser ? '' : 'AND category_id IN (SELECT id FROM ticket_categories WHERE hr_visible)'} ORDER BY created_at DESC LIMIT 10`, [id]),
    tasks: await query(`SELECT id, title, status, due_date::text AS due_date, priority FROM tasks WHERE assigned_to=$1 ORDER BY created_at DESC LIMIT 10`, [id]),
    activity: isAdminUser ? await query(`SELECT created_at, action, description FROM audit_logs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 15`, [id]) : [] });
});

const createSchema = z.object({ name: z.string().trim().min(1).max(120), email: z.string().email(), phone: z.string().max(30).optional().nullable(), department_id: z.string().uuid().optional().nullable(), designation: z.string().max(80).optional().nullable(),
  password: pw, role: z.enum(ROLES) });
router.post('/', requireRole('admin'), async (req, res) => {
  const p = createSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: p.error.issues[0]?.message || 'Invalid user data' });
  const d = p.data; const cid = req.user!.company_id;
  if ((await query(`SELECT 1 FROM users WHERE lower(email)=lower($1)`, [d.email])).length) return res.status(409).json({ error: 'A user with this email already exists' });
  const roleId = (await query<any>(`SELECT id FROM roles WHERE name=$1`, [d.role]))[0]?.id;
  if (!roleId) return res.status(500).json({ error: `Role ${d.role} is not configured - run the seed` });
  const u = (await query<any>(`INSERT INTO users (name, email, password_hash, phone, department_id, designation) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, email`, [d.name, d.email.toLowerCase(), await bcrypt.hash(d.password, 10), d.phone || null, d.department_id || null, d.designation || null]))[0];
  await query(`INSERT INTO company_users (company_id, user_id, role_id) VALUES ($1,$2,$3)`, [cid, u.id, roleId]);
  await joinDefaultChannels(cid, u.id);
  await logAudit({ company_id: cid, user_id: req.user!.id, action: 'create', entity_type: 'user', entity_id: u.id, module: 'users', description: `admin created ${d.role.replace('_', ' ')} ${d.name}` });
  res.status(201).json({ ...u, role: d.role });
});

/** Guard: never leave the company without an active admin, and never let admins lock themselves out. */
async function activeAdminsExcluding(cid: string, uid: string) {
  return (await query<any>(`SELECT COUNT(*)::int n FROM company_users cu JOIN roles r ON r.id=cu.role_id JOIN users u ON u.id=cu.user_id WHERE cu.company_id=$1 AND r.name='admin' AND u.is_active AND u.id<>$2`, [cid, uid]))[0].n;
}
const patchSchema = z.object({ name: z.string().trim().min(1).max(120).optional(), phone: z.string().max(30).optional().nullable(), department_id: z.string().uuid().optional().nullable(), designation: z.string().max(80).optional().nullable(),
  role: z.enum(ROLES).optional(), is_active: z.boolean().optional() }).strict();
router.patch('/:id', requireRole('admin'), async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'User not found' });
  const p = patchSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'Invalid user data' });
  const cid = req.user!.company_id; const d = p.data;
  const cur = (await query<any>(`SELECT u.*, r.name AS role FROM users u JOIN company_users cu ON cu.user_id=u.id JOIN roles r ON r.id=cu.role_id WHERE u.id=$1 AND cu.company_id=$2`, [req.params.id, cid]))[0];
  if (!cur) return res.status(404).json({ error: 'User not found' });
  const self = req.params.id === req.user!.id;
  if (self && ((d.role && d.role !== cur.role) || d.is_active === false)) return res.status(400).json({ error: 'You cannot change your own role or deactivate your own account' });
  if (cur.role === 'admin' && ((d.role && d.role !== 'admin') || d.is_active === false) && (await activeAdminsExcluding(cid, cur.id)) === 0) return res.status(400).json({ error: 'At least one active admin is required' });
  const { role, ...userFields } = d; const f = Object.keys(userFields);
  if (f.length) await query(`UPDATE users SET ${f.map((k, i) => `${k}=$${i + 1}`).join(', ')} WHERE id=$${f.length + 1}`, [...f.map(k => (userFields as any)[k]), req.params.id]);
  if (role && role !== cur.role) {
    const rid = (await query<any>(`SELECT id FROM roles WHERE name=$1`, [role]))[0].id;
    await query(`UPDATE company_users SET role_id=$1 WHERE company_id=$2 AND user_id=$3`, [rid, cid, req.params.id]);
  }
  await logAudit({ company_id: cid, user_id: req.user!.id, action: role && role !== cur.role ? 'change_role' : 'update', entity_type: 'user', entity_id: req.params.id, module: 'users', old_value: { role: cur.role, is_active: cur.is_active }, new_value: d,
    description: role && role !== cur.role ? `admin changed ${cur.name} from ${cur.role.replace('_', ' ')} to ${role.replace('_', ' ')}` : d.is_active === false ? `admin deactivated ${cur.name}` : d.is_active === true ? `admin activated ${cur.name}` : `admin updated user ${cur.name}` });
  res.json({ ok: true });
});
router.post('/:id/reset-password', requireRole('admin'), async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'User not found' });
  const p = z.object({ password: pw }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: p.error.issues[0]?.message || 'Invalid password' });
  const r = await query<any>(`UPDATE users SET password_hash=$1 WHERE id=$2 AND id IN (SELECT user_id FROM company_users WHERE company_id=$3) RETURNING name`, [await bcrypt.hash(p.data.password, 10), req.params.id, req.user!.company_id]);
  if (!r.length) return res.status(404).json({ error: 'User not found' });
  await logAudit({ company_id: req.user!.company_id, user_id: req.user!.id, action: 'reset_password', entity_type: 'user', entity_id: req.params.id, module: 'users', description: `admin reset the password of ${r[0].name}` });
  res.json({ ok: true });
});
// "Delete" deactivates: history, tickets and audit trails keep pointing at a real user.
router.delete('/:id', requireRole('admin'), async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'User not found' });
  if (req.params.id === req.user!.id) return res.status(400).json({ error: 'You cannot deactivate your own account' });
  const cid = req.user!.company_id;
  const cur = (await query<any>(`SELECT u.name, r.name AS role FROM users u JOIN company_users cu ON cu.user_id=u.id JOIN roles r ON r.id=cu.role_id WHERE u.id=$1 AND cu.company_id=$2`, [req.params.id, cid]))[0];
  if (!cur) return res.status(404).json({ error: 'User not found' });
  if (cur.role === 'admin' && (await activeAdminsExcluding(cid, req.params.id)) === 0) return res.status(400).json({ error: 'At least one active admin is required' });
  await query(`UPDATE users SET is_active=false WHERE id=$1`, [req.params.id]);
  await logAudit({ company_id: cid, user_id: req.user!.id, action: 'deactivate', entity_type: 'user', entity_id: req.params.id, module: 'users', description: `admin deactivated ${cur.name}` });
  res.json({ ok: true });
});

export default router;
