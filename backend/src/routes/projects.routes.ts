import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db/pool';
import { requireAuth, requireRole, logAudit, AuthUser } from '../lib/auth';
import { isAdmin, isStaff, taskScope, ticketScope, UUID_RE } from '../lib/access';
import { bad, notFound, parse } from '../lib/http';
import { notify } from '../lib/notify';

const router = Router();
router.use(requireAuth);

/** admin + HR see every project; employees only those they manage or belong to. */
const projScope = (u: AuthUser, params: any[]) => { if (isStaff(u)) return ''; params.push(u.id); return `(p.manager_id=$${params.length} OR EXISTS (SELECT 1 FROM project_members m WHERE m.project_id=p.id AND m.user_id=$${params.length}))`; };
const STATS = `(SELECT COUNT(*)::int FROM project_members m WHERE m.project_id=p.id) AS member_count,
  (SELECT COUNT(*)::int FROM tickets t WHERE t.project_id=p.id) AS ticket_count,
  (SELECT COUNT(*)::int FROM tickets t WHERE t.project_id=p.id AND t.status NOT IN ('resolved','closed','cancelled')) AS open_ticket_count,
  (SELECT COUNT(*)::int FROM tasks k WHERE k.project_id=p.id AND k.status<>'cancelled') AS task_total,
  (SELECT COUNT(*)::int FROM tasks k WHERE k.project_id=p.id AND k.status='completed') AS task_done,
  (p.due_date IS NOT NULL AND p.due_date < CURRENT_DATE AND p.status IN ('planning','active','on_hold')) AS is_overdue`;
const progress = (r: any) => ({ ...r, progress: r.task_total > 0 ? Math.round((r.task_done / r.task_total) * 100) : (r.status === 'completed' ? 100 : null) });

router.get('/', async (req, res) => {
  const u = req.user!; const params: any[] = [u.company_id]; const conds = ['p.company_id=$1']; const sc = projScope(u, params); if (sc) conds.push(sc);
  const st = String(req.query.status || ''); if (st === 'ongoing') conds.push(`p.status IN ('planning','active','on_hold')`); else if (st) { params.push(st); conds.push(`p.status=$${params.length}`); }
  const s = String(req.query.search || '').trim(); if (s) { params.push(`%${s}%`); conds.push(`(p.name ILIKE $${params.length} OR p.code ILIKE $${params.length})`); }
  const rows = await query<any>(`SELECT p.*, m.name AS manager_name, ${STATS} FROM projects p LEFT JOIN users m ON m.id=p.manager_id WHERE ${conds.join(' AND ')} ORDER BY (p.status='completed'), p.due_date NULLS LAST, p.created_at DESC`, params);
  res.json({ data: rows.map(progress) });
});

router.get('/:id', async (req, res) => {
  const u = req.user!; if (!UUID_RE.test(req.params.id)) throw notFound('Project not found');
  const params: any[] = [req.params.id, u.company_id]; const sc = projScope(u, params);
  const p = (await query<any>(`SELECT p.*, m.name AS manager_name, ${STATS} FROM projects p LEFT JOIN users m ON m.id=p.manager_id WHERE p.id=$1 AND p.company_id=$2 ${sc ? 'AND ' + sc : ''}`, params))[0];
  if (!p) throw notFound('Project not found');
  const tp: any[] = [u.company_id, p.id]; const tsc = ticketScope(u, tp);
  const kp: any[] = [p.id]; const ksc = isAdmin(u) || u.id === p.manager_id ? '' : taskScope(u, kp, 'k.');
  res.json({ ...progress(p),
    members: await query(`SELECT u.id, u.name, u.designation, d.name AS department, pm.project_role, r.name AS role FROM project_members pm JOIN users u ON u.id=pm.user_id LEFT JOIN departments d ON d.id=u.department_id JOIN company_users cu ON cu.user_id=u.id JOIN roles r ON r.id=cu.role_id WHERE pm.project_id=$1 ORDER BY u.name`, [p.id]),
    tickets: await query(`SELECT t.id, t.ticket_no, t.subject, t.status, t.priority, t.created_at, a.name AS assignee_name FROM tickets t LEFT JOIN users a ON a.id=t.assignee_id WHERE t.company_id=$1 AND t.project_id=$2 ${tsc ? 'AND ' + tsc : ''} ORDER BY t.created_at DESC LIMIT 50`, tp),
    tasks: await query(`SELECT k.id, k.task_no, k.title, k.status, k.priority, k.due_date::text AS due_date, u.name AS assignee_name FROM tasks k LEFT JOIN users u ON u.id=k.assigned_to WHERE k.project_id=$1 ${ksc ? 'AND ' + ksc : ''} ORDER BY k.due_date NULLS LAST LIMIT 100`, kp) });
});

const schema = z.object({ code: z.string().trim().max(20).optional().nullable(), name: z.string().trim().min(2).max(120), description: z.string().max(5000).optional().nullable(),
  status: z.enum(['planning', 'active', 'on_hold', 'completed', 'cancelled']).default('active'), start_date: z.string().optional().nullable(), due_date: z.string().optional().nullable(), manager_id: z.string().uuid().optional().nullable(),
  members: z.array(z.object({ user_id: z.string().uuid(), project_role: z.string().max(60).optional().nullable() })).optional() });
const dateOk = (d: any) => { if (d.start_date && d.due_date && d.due_date < d.start_date) throw bad('Due date cannot be before the start date'); };

async function setMembers(c: any, projectId: string, members: { user_id: string; project_role?: string | null }[], cid: string) {
  await c.query(`DELETE FROM project_members WHERE project_id=$1`, [projectId]);
  for (const m of members) await c.query(`INSERT INTO project_members (project_id, user_id, project_role) SELECT $1, u.id, $4 FROM users u JOIN company_users cu ON cu.user_id=u.id WHERE u.id=$2 AND cu.company_id=$3 ON CONFLICT DO NOTHING`, [projectId, m.user_id, cid, m.project_role || null]);
}
router.post('/', requireRole('admin'), async (req, res) => {
  const u = req.user!; const d = parse(schema, { ...req.body, start_date: req.body.start_date || null, due_date: req.body.due_date || null }); dateOk(d);
  const p = await withTransaction(async c => {
    const code = d.code || `PRJ-${String(((await c.query(`SELECT COUNT(*)::int n FROM projects WHERE company_id=$1`, [u.company_id])).rows[0].n) + 1).padStart(3, '0')}`;
    let row; try { row = (await c.query(`INSERT INTO projects (company_id, code, name, description, status, start_date, due_date, manager_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [u.company_id, code.toUpperCase(), d.name, d.description || null, d.status, d.start_date || null, d.due_date || null, d.manager_id || null, u.id])).rows[0]; }
    catch (e: any) { if (e.code === '23505') throw bad(`Project code ${code} is already used`); throw e; }
    await setMembers(c, row.id, [...(d.members || []), ...(d.manager_id ? [{ user_id: d.manager_id, project_role: 'Manager' }] : [])], u.company_id); return row;
  });
  await logAudit({ company_id: u.company_id, user_id: u.id, action: 'create', entity_type: 'project', entity_id: p.id, module: 'projects', description: `${u.name} created project ${p.code} ${p.name}` });
  for (const m of d.members || []) if (m.user_id !== u.id) await notify(u.company_id, m.user_id, 'project_added', `You were added to ${p.name}`, undefined, 'project', p.id);
  res.status(201).json(p);
});
router.patch('/:id', requireRole('admin'), async (req, res) => {
  const u = req.user!; const d = parse(schema.partial(), req.body); dateOk(d);
  const before = (await query<any>(`SELECT * FROM projects WHERE id=$1 AND company_id=$2`, [req.params.id, u.company_id]))[0]; if (!before) throw notFound('Project not found');
  const p = await withTransaction(async c => {
    const row = (await c.query(`UPDATE projects SET name=COALESCE($3,name), description=CASE WHEN $4::boolean THEN $5 ELSE description END, status=COALESCE($6,status), start_date=CASE WHEN $7::boolean THEN $8 ELSE start_date END, due_date=CASE WHEN $9::boolean THEN $10 ELSE due_date END, manager_id=CASE WHEN $11::boolean THEN $12 ELSE manager_id END, updated_at=now() WHERE id=$1 AND company_id=$2 RETURNING *`,
      [req.params.id, u.company_id, d.name ?? null, 'description' in d, d.description ?? null, d.status ?? null, 'start_date' in d, d.start_date || null, 'due_date' in d, d.due_date || null, 'manager_id' in d, d.manager_id ?? null])).rows[0];
    if (d.members) await setMembers(c, row.id, [...d.members, ...(row.manager_id && !d.members.some(m => m.user_id === row.manager_id) ? [{ user_id: row.manager_id, project_role: 'Manager' }] : [])], u.company_id);
    return row;
  });
  await logAudit({ company_id: u.company_id, user_id: u.id, action: 'update', entity_type: 'project', entity_id: p.id, module: 'projects', old_value: { status: before.status }, new_value: { status: p.status }, description: `${u.name} updated project ${p.code}` });
  res.json(p);
});
router.delete('/:id', requireRole('admin'), async (req, res) => {
  const u = req.user!; const r = (await query<any>(`DELETE FROM projects WHERE id=$1 AND company_id=$2 RETURNING code, name`, [req.params.id, u.company_id]))[0]; if (!r) throw notFound('Project not found');
  await logAudit({ company_id: u.company_id, user_id: u.id, action: 'delete', entity_type: 'project', entity_id: req.params.id, module: 'projects', description: `${u.name} deleted project ${r.code} ${r.name} (linked tickets and tasks were kept, unlinked)` }); res.json({ ok: true });
});

export default router;
