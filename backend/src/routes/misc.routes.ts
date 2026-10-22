import { Router } from 'express';
import { query } from '../db/pool';
import { requireAuth } from '../lib/auth';
import { isAdmin, isStaff, taskScope, ticketScope, UUID_RE } from '../lib/access';
import { forbidden, pageParams } from '../lib/http';

const router = Router();
router.use(requireAuth);

// ---------- notifications ----------
router.get('/notifications', async (req, res) => {
  const u = req.user!; const unreadOnly = req.query.unread === '1'; const { page, pageSize, offset } = pageParams(req.query, 100);
  const where = `user_id=$1 ${unreadOnly ? 'AND NOT is_read' : ''}`;
  res.json({ data: await query(`SELECT id, type, title, message, entity_type, entity_id, is_read, created_at FROM notifications WHERE ${where} ORDER BY created_at DESC LIMIT ${pageSize} OFFSET ${offset}`, [u.id]),
    unread: (await query<any>(`SELECT COUNT(*)::int n FROM notifications WHERE user_id=$1 AND NOT is_read`, [u.id]))[0].n, total: (await query<any>(`SELECT COUNT(*)::int n FROM notifications WHERE ${where}`, [u.id]))[0].n, page, pageSize });
});
router.post('/notifications/read-all', async (req, res) => { await query(`UPDATE notifications SET is_read=true WHERE user_id=$1 AND NOT is_read`, [req.user!.id]); res.json({ ok: true }); });
router.post('/notifications/:id/read', async (req, res) => { if (!UUID_RE.test(req.params.id)) return res.json({ ok: true }); await query(`UPDATE notifications SET is_read=true WHERE id=$1 AND user_id=$2`, [req.params.id, req.user!.id]); res.json({ ok: true }); });

// ---------- activity log ----------
router.get('/audit-logs', async (req, res) => {
  const u = req.user!; if (!isStaff(u)) throw forbidden('The activity log is not available to your role');
  const params: any[] = [u.company_id]; const conds = ['a.company_id=$1'];
  if (!isAdmin(u)) conds.push(`a.module IN ('tickets','requests','tasks','projects')`);   // HR: employee- and ticket-related activity only
  const add = (sql: string, v: any) => { params.push(v); conds.push(sql.replace('?', `$${params.length}`)); };
  if (req.query.module) add('a.module=?', String(req.query.module)); if (req.query.action) add('a.action=?', String(req.query.action));
  if (req.query.user_id && UUID_RE.test(String(req.query.user_id))) add('a.user_id=?', String(req.query.user_id));
  if (req.query.entity_id && UUID_RE.test(String(req.query.entity_id))) add('a.entity_id=?', String(req.query.entity_id));
  if (req.query.from) add('a.created_at >= ?::date', String(req.query.from)); if (req.query.to) add('a.created_at < (?::date + 1)', String(req.query.to));
  const s = String(req.query.search || '').trim(); if (s) { params.push(`%${s}%`); conds.push(`(a.description ILIKE $${params.length} OR us.name ILIKE $${params.length})`); }
  const { page, pageSize, offset } = pageParams(req.query, 100);
  const total = (await query<any>(`SELECT COUNT(*)::int n FROM audit_logs a LEFT JOIN users us ON us.id=a.user_id WHERE ${conds.join(' AND ')}`, params))[0].n;
  res.json({ data: await query(`SELECT a.id, a.created_at, a.action, a.module, a.entity_type, a.entity_id, a.description, a.role, a.ip_address, a.old_value, a.new_value, us.name AS user_name FROM audit_logs a LEFT JOIN users us ON us.id=a.user_id WHERE ${conds.join(' AND ')} ORDER BY a.created_at DESC LIMIT ${pageSize} OFFSET ${offset}`, params), total, page, pageSize });
});

// ---------- global search ----------
router.get('/search', async (req, res) => {
  const u = req.user!; const q = String(req.query.q || '').trim(); if (q.length < 2) return res.json({ tickets: [], people: [], projects: [], tasks: [] });
  const like = `%${q}%`;
  const tp: any[] = [u.company_id, like]; const tsc = ticketScope(u, tp);
  const pp: any[] = [u.company_id, like]; const pr = isStaff(u) ? '' : (pp.push(u.id), `AND (p.manager_id=$3 OR EXISTS (SELECT 1 FROM project_members m WHERE m.project_id=p.id AND m.user_id=$3))`);
  const kp: any[] = [u.company_id, like]; const ksc = taskScope(u, kp);
  res.json({
    tickets: await query(`SELECT t.id, t.ticket_no, t.subject, t.status FROM tickets t WHERE t.company_id=$1 AND (t.ticket_no ILIKE $2 OR t.subject ILIKE $2) ${tsc ? 'AND ' + tsc : ''} ORDER BY t.created_at DESC LIMIT 5`, tp),
    people: await query(`SELECT u.id, u.name, u.designation, r.name AS role FROM users u JOIN company_users cu ON cu.user_id=u.id JOIN roles r ON r.id=cu.role_id WHERE cu.company_id=$1 AND u.is_active AND (u.name ILIKE $2 OR u.email ILIKE $2) ORDER BY u.name LIMIT 5`, [u.company_id, like]),
    projects: await query(`SELECT p.id, p.code, p.name, p.status FROM projects p WHERE p.company_id=$1 AND (p.name ILIKE $2 OR p.code ILIKE $2) ${pr} LIMIT 5`, pp),
    tasks: await query(`SELECT t.id, t.task_no, t.title, t.status FROM tasks t WHERE t.company_id=$1 AND (t.title ILIKE $2 OR t.task_no ILIKE $2) ${ksc ? 'AND ' + ksc : ''} LIMIT 5`, kp),
  });
});

export default router;
