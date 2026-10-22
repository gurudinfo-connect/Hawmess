import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool';
import { requireAuth, logAudit } from '../lib/auth';
import { isAdmin, isStaff, loadTicketFor, taskScope, UUID_RE } from '../lib/access';
import { bad, forbidden, notFound, pageParams, parse } from '../lib/http';
import { notify } from '../lib/notify';
import { withRefRetry } from '../lib/refId';

const router = Router();
router.use(requireAuth);

const SELECT = `SELECT t.id, t.task_no, t.title, t.description, t.priority, t.status, t.start_date::text AS start_date, t.due_date::text AS due_date, t.created_at, t.updated_at, t.assigned_to, t.created_by, t.project_id, t.ticket_id, t.team_id,
  a.name AS assignee_name, c.name AS creator_name, p.name AS project_name, p.code AS project_code, tk.ticket_no, tm.name AS team_name,
  (t.due_date IS NOT NULL AND t.due_date < CURRENT_DATE AND t.status IN ('pending','in_progress')) AS is_overdue
  FROM tasks t LEFT JOIN users a ON a.id=t.assigned_to LEFT JOIN users c ON c.id=t.created_by LEFT JOIN projects p ON p.id=t.project_id LEFT JOIN tickets tk ON tk.id=t.ticket_id LEFT JOIN teams tm ON tm.id=t.team_id`;

router.get('/', async (req, res) => {
  const u = req.user!; const params: any[] = [u.company_id]; const conds = ['t.company_id=$1'];
  const sc = taskScope(u, params); if (sc) conds.push(sc);
  const view = String(req.query.view || 'mine'); params.push(u.id); const me = `$${params.length}`;
  if (view === 'mine') conds.push(`t.assigned_to=${me}`);
  else if (view === 'created') conds.push(`t.created_by=${me}`);
  else if (view === 'team') { if (u.role === 'employee') throw forbidden('Team tasks are not available to your role'); conds.push(`(t.assigned_to IS DISTINCT FROM ${me})`); }
  else if (view === 'all') { if (!isAdmin(u)) throw forbidden('Only admins can see all tasks'); }
  else if (view === 'overdue') conds.push(`t.due_date < CURRENT_DATE AND t.status IN ('pending','in_progress')`);
  else if (view === 'completed') conds.push(`t.status='completed'`);
  if (view !== 'completed' && !req.query.status && view !== 'all' && view !== 'created') conds.push(`t.status <> 'completed'`);
  if (req.query.status) { params.push(String(req.query.status)); conds.push(`t.status=$${params.length}`); }
  if (req.query.priority) { params.push(String(req.query.priority)); conds.push(`t.priority=$${params.length}`); }
  if (req.query.project_id && UUID_RE.test(String(req.query.project_id))) { params.push(String(req.query.project_id)); conds.push(`t.project_id=$${params.length}`); }
  const s = String(req.query.search || '').trim(); if (s) { params.push(`%${s}%`); conds.push(`(t.title ILIKE $${params.length} OR t.task_no ILIKE $${params.length})`); }
  const { page, pageSize, offset } = pageParams(req.query);
  const total = (await query<any>(`SELECT COUNT(*)::int n FROM tasks t WHERE ${conds.join(' AND ')}`, params))[0].n;
  const rows = await query(`${SELECT} WHERE ${conds.join(' AND ')} ORDER BY (t.status='completed'), t.due_date NULLS LAST, CASE t.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END LIMIT ${pageSize} OFFSET ${offset}`, params);
  res.json({ data: rows, total, page, pageSize });
});

router.get('/summary', async (req, res) => {
  const u = req.user!; const params: any[] = [u.id];
  const r = (await query<any>(`SELECT COUNT(*) FILTER (WHERE status IN ('pending','in_progress'))::int AS open, COUNT(*) FILTER (WHERE status='completed')::int AS completed,
    COUNT(*) FILTER (WHERE status IN ('pending','in_progress') AND due_date < CURRENT_DATE)::int AS overdue, COUNT(*) FILTER (WHERE status IN ('pending','in_progress') AND due_date = CURRENT_DATE)::int AS due_today FROM tasks WHERE assigned_to=$1`, params))[0];
  res.json(r);
});

async function loadTask(u: any, id: string) {
  if (!UUID_RE.test(id)) throw notFound('Task not found');
  const params: any[] = [id, u.company_id]; const sc = taskScope(u, params);
  const t = (await query<any>(`${SELECT} WHERE t.id=$1 AND t.company_id=$2 ${sc ? 'AND ' + sc : ''}`, params))[0]; if (!t) throw notFound('Task not found'); return t;
}
router.get('/:id', async (req, res) => {
  const t = await loadTask(req.user!, req.params.id);
  res.json({ ...t, updates: await query(`SELECT tu.id, tu.type, tu.status, tu.note, tu.created_at, u.name AS user_name FROM task_updates tu LEFT JOIN users u ON u.id=tu.user_id WHERE tu.task_id=$1 ORDER BY tu.created_at`, [t.id]) });
});

const base = z.object({ title: z.string().trim().min(2).max(200), description: z.string().max(5000).optional().nullable(), assigned_to: z.string().uuid().optional().nullable(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium'), start_date: z.string().optional().nullable(), due_date: z.string().optional().nullable(),
  project_id: z.string().uuid().optional().nullable(), ticket_id: z.string().uuid().optional().nullable(), team_id: z.string().uuid().optional().nullable() });
const emptyToNull = (b: any) => Object.fromEntries(Object.entries(b || {}).map(([k, v]) => [k, v === '' ? null : v]));

async function validateLinks(u: any, d: any) {
  if (d.start_date && d.due_date && d.due_date < d.start_date) throw bad('Due date cannot be before the start date');
  if (d.project_id) { const ok = isStaff(u) ? await query(`SELECT 1 FROM projects WHERE id=$1 AND company_id=$2`, [d.project_id, u.company_id]) : await query(`SELECT 1 FROM projects p WHERE p.id=$1 AND p.company_id=$2 AND (p.manager_id=$3 OR EXISTS (SELECT 1 FROM project_members m WHERE m.project_id=p.id AND m.user_id=$3))`, [d.project_id, u.company_id, u.id]); if (!ok.length) throw bad('Project not found or not accessible'); }
  if (d.ticket_id && !(await loadTicketFor(u, d.ticket_id))) throw bad('Ticket not found or not accessible');
  if (d.team_id && !(await query(`SELECT 1 FROM teams WHERE id=$1 AND company_id=$2`, [d.team_id, u.company_id])).length) throw bad('Team not found');
}
router.post('/', async (req, res) => {
  const u = req.user!; const d = parse(base, emptyToNull(req.body)); await validateLinks(u, d);
  let assignee = d.assigned_to || u.id;
  if (assignee !== u.id) {
    if (u.role === 'employee') throw forbidden('You can only create tasks for yourself');
    if (!(await query(`SELECT 1 FROM users x JOIN company_users cu ON cu.user_id=x.id WHERE x.id=$1 AND cu.company_id=$2 AND x.is_active`, [assignee, u.company_id])).length) throw bad('Assignee not found');
  }
  const t = await withRefRetry(async () => (await query<any>(`INSERT INTO tasks (company_id, title, description, assigned_to, created_by, priority, start_date, due_date, project_id, ticket_id, team_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [u.company_id, d.title, d.description || null, assignee, u.id, d.priority, d.start_date || null, d.due_date || null, d.project_id || null, d.ticket_id || null, d.team_id || null]))[0]);
  await query(`INSERT INTO task_updates (company_id, task_id, user_id, type, status, note) VALUES ($1,$2,$3,'assigned','pending',$4)`, [u.company_id, t.id, u.id, assignee === u.id ? 'Created' : 'Assigned']);
  if (assignee !== u.id) await notify(u.company_id, assignee, 'task_assigned', `New task: ${t.title}`, d.due_date ? `Due ${d.due_date}` : undefined, 'task', t.id);
  await logAudit({ company_id: u.company_id, user_id: u.id, action: 'create', entity_type: 'task', entity_id: t.id, module: 'tasks', description: `${u.name} created task ${t.task_no}: ${t.title}` });
  res.status(201).json(t);
});

router.patch('/:id', async (req, res) => {
  const u = req.user!; const t = await loadTask(u, req.params.id);
  const isAssignee = t.assigned_to === u.id; const canEdit = isAdmin(u) || t.created_by === u.id || u.role === 'hr';
  const d = parse(base.partial().extend({ status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']).optional(), note: z.string().max(2000).optional().nullable() }), emptyToNull(req.body));
  const { status, note, ...fields } = d;
  if (Object.keys(fields).length && !canEdit) throw forbidden('Only the creator, HR or an admin can edit task details');
  if (status && !(isAssignee || canEdit)) throw forbidden();
  await validateLinks(u, { ...t, ...fields, start_date: 'start_date' in fields ? fields.start_date : t.start_date, due_date: 'due_date' in fields ? fields.due_date : t.due_date });
  if (fields.assigned_to && fields.assigned_to !== t.assigned_to) {
    if (u.role === 'employee') throw forbidden('You cannot reassign tasks');
    if (!(await query(`SELECT 1 FROM users x JOIN company_users cu ON cu.user_id=x.id WHERE x.id=$1 AND cu.company_id=$2 AND x.is_active`, [fields.assigned_to, u.company_id])).length) throw bad('Assignee not found');
  }
  const f = Object.entries(fields).filter(([, v]) => v !== undefined); const vals: any[] = [t.id]; const sets = ['updated_at=now()'];
  for (const [k, v] of f) { vals.push(v); sets.push(`${k}=$${vals.length}`); }
  if (status) { vals.push(status); sets.push(`status=$${vals.length}`); }
  await query(`UPDATE tasks SET ${sets.join(', ')} WHERE id=$1`, vals);
  if (status && status !== t.status) {
    await query(`INSERT INTO task_updates (company_id, task_id, user_id, type, status, note) VALUES ($1,$2,$3,'status_change',$4,$5)`, [u.company_id, t.id, u.id, status, note || null]);
    if (t.created_by && t.created_by !== u.id) await notify(u.company_id, t.created_by, 'task_status', `Task ${status.replace('_', ' ')}: ${t.title}`, `${u.name} updated it`, 'task', t.id);
  }
  if (fields.assigned_to && fields.assigned_to !== t.assigned_to) {
    await query(`INSERT INTO task_updates (company_id, task_id, user_id, type, note) VALUES ($1,$2,$3,'assigned','Reassigned')`, [u.company_id, t.id, u.id]);
    await notify(u.company_id, fields.assigned_to, 'task_assigned', `Task assigned: ${t.title}`, undefined, 'task', t.id);
  }
  await logAudit({ company_id: u.company_id, user_id: u.id, action: status ? 'status_change' : 'update', entity_type: 'task', entity_id: t.id, module: 'tasks', description: `${u.name} ${status ? `set task ${t.task_no} to ${status.replace('_', ' ')}` : `updated task ${t.task_no}`}` });
  res.json(await loadTask(u, t.id));
});
router.post('/:id/notes', async (req, res) => {
  const u = req.user!; const t = await loadTask(u, req.params.id); const d = parse(z.object({ note: z.string().trim().min(1).max(2000) }), req.body);
  await query(`INSERT INTO task_updates (company_id, task_id, user_id, type, note) VALUES ($1,$2,$3,'note',$4)`, [u.company_id, t.id, u.id, d.note]);
  const other = t.assigned_to === u.id ? t.created_by : t.assigned_to; if (other && other !== u.id) await notify(u.company_id, other, 'task_note', `Update on task: ${t.title}`, d.note.slice(0, 140), 'task', t.id);
  res.status(201).json({ ok: true });
});
router.delete('/:id', async (req, res) => {
  const u = req.user!; const t = await loadTask(u, req.params.id); if (!(isAdmin(u) || t.created_by === u.id)) throw forbidden('Only the creator or an admin can delete a task');
  await query(`DELETE FROM tasks WHERE id=$1`, [t.id]); await logAudit({ company_id: u.company_id, user_id: u.id, action: 'delete', entity_type: 'task', entity_id: t.id, module: 'tasks', description: `${u.name} deleted task ${t.task_no}` }); res.json({ ok: true });
});

export default router;
