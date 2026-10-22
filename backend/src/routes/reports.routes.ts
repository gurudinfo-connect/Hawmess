import { Router } from 'express';
import { query } from '../db/pool';
import { requireAuth, logAudit, AuthUser } from '../lib/auth';
import { isAdmin, isStaff, ticketScope } from '../lib/access';
import { forbidden, notFound, toCsv, bad } from '../lib/http';
import { OVERDUE, RESOLVED_STATES, SLA_BREACHED, SLA_RESOLUTION_BREACHED, SLA_RESPONSE_BREACHED } from '../lib/sla';

const router = Router();
router.use(requireAuth);

type Col = { key: string; label: string };
interface Def { title: string; roles: ('admin' | 'hr' | 'employee')[]; cols: Col[]; sql: (w: string, ctx: { me: string; cid: string }) => string; extra?: (u: AuthUser) => string }
const hrs = (e: string) => `ROUND(EXTRACT(EPOCH FROM (${e}))/3600.0, 1)`;
const STAFF: Def['roles'] = ['admin', 'hr'];

const REPORTS: Record<string, Def> = {
  volume: { title: 'Ticket volume (created vs resolved per day)', roles: STAFF, cols: [{ key: 'date', label: 'Date' }, { key: 'created', label: 'Created' }, { key: 'resolved', label: 'Resolved' }],
    sql: (w) => `SELECT to_char(d.d,'YYYY-MM-DD') AS date, (SELECT COUNT(*)::int FROM tickets t WHERE ${w} AND t.created_at::date=d.d) AS created, (SELECT COUNT(*)::int FROM tickets t WHERE ${w} AND t.resolved_at::date=d.d) AS resolved FROM generate_series($FROM::date, $TO::date, '1 day') d(d) ORDER BY d.d` },
  status: { title: 'Tickets by status', roles: STAFF, cols: [{ key: 'status', label: 'Status' }, { key: 'count', label: 'Tickets' }], sql: (w) => `SELECT t.status, COUNT(*)::int AS count FROM tickets t WHERE ${w} GROUP BY t.status ORDER BY count DESC` },
  priority: { title: 'Tickets by priority', roles: STAFF, cols: [{ key: 'priority', label: 'Priority' }, { key: 'total', label: 'Total' }, { key: 'open', label: 'Open' }, { key: 'resolved', label: 'Resolved' }],
    sql: (w) => `SELECT t.priority, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE t.status NOT IN ${RESOLVED_STATES})::int AS open, COUNT(*) FILTER (WHERE t.status IN ('resolved','closed'))::int AS resolved FROM tickets t WHERE ${w} GROUP BY t.priority ORDER BY CASE t.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END` },
  category: { title: 'Tickets by category', roles: STAFF, cols: [{ key: 'category', label: 'Category' }, { key: 'total', label: 'Total' }, { key: 'open', label: 'Open' }, { key: 'resolved', label: 'Resolved' }, { key: 'avg_resolution_hours', label: 'Avg resolution (h)' }],
    sql: (w) => `SELECT COALESCE(c.name,'Uncategorised') AS category, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE t.status NOT IN ${RESOLVED_STATES})::int AS open, COUNT(*) FILTER (WHERE t.status IN ('resolved','closed'))::int AS resolved, ${hrs('AVG(t.resolved_at - t.created_at)')} AS avg_resolution_hours FROM tickets t LEFT JOIN ticket_categories c ON c.id=t.category_id WHERE ${w} GROUP BY c.name ORDER BY total DESC` },
  agents: { title: 'Agent performance', roles: ['admin'], cols: [{ key: 'agent', label: 'Agent' }, { key: 'assigned', label: 'Assigned' }, { key: 'open', label: 'Open' }, { key: 'resolved', label: 'Resolved' }, { key: 'avg_resolution_hours', label: 'Avg resolution (h)' }, { key: 'sla_breached', label: 'SLA breached' }],
    sql: (w) => `SELECT a.name AS agent, COUNT(*)::int AS assigned, COUNT(*) FILTER (WHERE t.status NOT IN ${RESOLVED_STATES})::int AS open, COUNT(*) FILTER (WHERE t.status IN ('resolved','closed'))::int AS resolved, ${hrs('AVG(t.resolved_at - t.created_at)')} AS avg_resolution_hours, COUNT(*) FILTER (WHERE ${SLA_BREACHED})::int AS sla_breached FROM tickets t JOIN users a ON a.id=t.assignee_id WHERE ${w} GROUP BY a.name ORDER BY assigned DESC` },
  teams: { title: 'Team performance', roles: ['admin'], cols: [{ key: 'team', label: 'Team' }, { key: 'total', label: 'Tickets' }, { key: 'open', label: 'Open' }, { key: 'resolved', label: 'Resolved' }, { key: 'avg_resolution_hours', label: 'Avg resolution (h)' }, { key: 'sla_breached', label: 'SLA breached' }],
    sql: (w) => `SELECT tm.name AS team, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE t.status NOT IN ${RESOLVED_STATES})::int AS open, COUNT(*) FILTER (WHERE t.status IN ('resolved','closed'))::int AS resolved, ${hrs('AVG(t.resolved_at - t.created_at)')} AS avg_resolution_hours, COUNT(*) FILTER (WHERE ${SLA_BREACHED})::int AS sla_breached FROM tickets t JOIN teams tm ON tm.id=t.team_id WHERE ${w} GROUP BY tm.name ORDER BY total DESC` },
  sla: { title: 'SLA compliance by priority', roles: STAFF, cols: [{ key: 'priority', label: 'Priority' }, { key: 'with_policy', label: 'Tickets with SLA' }, { key: 'response_breached', label: 'First response missed' }, { key: 'resolution_breached', label: 'Resolution missed' }, { key: 'compliance_pct', label: 'Resolved on time (%)' }],
    sql: (w) => `SELECT t.priority, COUNT(*) FILTER (WHERE t.resolution_due IS NOT NULL)::int AS with_policy, COUNT(*) FILTER (WHERE ${SLA_RESPONSE_BREACHED})::int AS response_breached, COUNT(*) FILTER (WHERE ${SLA_RESOLUTION_BREACHED})::int AS resolution_breached,
      CASE WHEN COUNT(*) FILTER (WHERE t.resolution_due IS NOT NULL AND t.resolved_at IS NOT NULL)=0 THEN NULL ELSE ROUND(100.0*COUNT(*) FILTER (WHERE t.resolution_due IS NOT NULL AND t.resolved_at IS NOT NULL AND t.resolved_at<=t.resolution_due)/COUNT(*) FILTER (WHERE t.resolution_due IS NOT NULL AND t.resolved_at IS NOT NULL),1) END AS compliance_pct
      FROM tickets t WHERE ${w} GROUP BY t.priority ORDER BY CASE t.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END` },
  resolution: { title: 'Resolution-time analysis', roles: STAFF, cols: [{ key: 'priority', label: 'Priority' }, { key: 'resolved', label: 'Resolved tickets' }, { key: 'avg_first_response_hours', label: 'Avg first response (h)' }, { key: 'avg_resolution_hours', label: 'Avg resolution (h)' }, { key: 'max_resolution_hours', label: 'Slowest (h)' }],
    sql: (w) => `SELECT t.priority, COUNT(*) FILTER (WHERE t.resolved_at IS NOT NULL)::int AS resolved, ${hrs('AVG(t.first_response_at - t.created_at)')} AS avg_first_response_hours, ${hrs('AVG(t.resolved_at - t.created_at)')} AS avg_resolution_hours, ${hrs('MAX(t.resolved_at - t.created_at)')} AS max_resolution_hours FROM tickets t WHERE ${w} GROUP BY t.priority ORDER BY CASE t.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END` },
  departments: { title: 'Department workload', roles: STAFF, cols: [{ key: 'department', label: 'Department' }, { key: 'total', label: 'Tickets' }, { key: 'open', label: 'Open' }, { key: 'resolved', label: 'Resolved' }, { key: 'sla_breached', label: 'SLA breached' }],
    sql: (w) => `SELECT COALESCE(d.name,'No department') AS department, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE t.status NOT IN ${RESOLVED_STATES})::int AS open, COUNT(*) FILTER (WHERE t.status IN ('resolved','closed'))::int AS resolved, COUNT(*) FILTER (WHERE ${SLA_BREACHED})::int AS sla_breached FROM tickets t LEFT JOIN departments d ON d.id=t.department_id WHERE ${w} GROUP BY d.name ORDER BY total DESC` },
  projects: { title: 'Project-related support', roles: STAFF, cols: [{ key: 'project', label: 'Project' }, { key: 'total', label: 'Tickets' }, { key: 'open', label: 'Open' }, { key: 'resolved', label: 'Resolved' }, { key: 'sla_breached', label: 'SLA breached' }],
    sql: (w) => `SELECT p.code || ' · ' || p.name AS project, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE t.status NOT IN ${RESOLVED_STATES})::int AS open, COUNT(*) FILTER (WHERE t.status IN ('resolved','closed'))::int AS resolved, COUNT(*) FILTER (WHERE ${SLA_BREACHED})::int AS sla_breached FROM tickets t JOIN projects p ON p.id=t.project_id WHERE ${w} GROUP BY p.id ORDER BY total DESC` },
  requests: { title: 'Employee requests', roles: STAFF, cols: [{ key: 'type', label: 'Type' }, { key: 'pending', label: 'Pending' }, { key: 'approved', label: 'Approved' }, { key: 'rejected', label: 'Rejected' }, { key: 'cancelled', label: 'Cancelled' }, { key: 'total', label: 'Total' }],
    sql: () => `SELECT r.type, COUNT(*) FILTER (WHERE r.status='pending')::int AS pending, COUNT(*) FILTER (WHERE r.status='approved')::int AS approved, COUNT(*) FILTER (WHERE r.status='rejected')::int AS rejected, COUNT(*) FILTER (WHERE r.status='cancelled')::int AS cancelled, COUNT(*)::int AS total FROM employee_requests r WHERE r.company_id=$CID AND r.created_at::date BETWEEN $FROM::date AND $TO::date GROUP BY r.type ORDER BY total DESC` },
  // ----- employee ("only personal or explicitly authorised information") -----
  'my-tickets': { title: 'My ticket history', roles: ['employee'], cols: [{ key: 'ticket_no', label: 'Ticket' }, { key: 'subject', label: 'Subject' }, { key: 'status', label: 'Status' }, { key: 'priority', label: 'Priority' }, { key: 'created', label: 'Created' }, { key: 'resolved', label: 'Resolved' }],
    sql: (w) => `SELECT t.ticket_no, t.subject, t.status, t.priority, to_char(t.created_at,'YYYY-MM-DD') AS created, to_char(t.resolved_at,'YYYY-MM-DD') AS resolved FROM tickets t WHERE ${w} ORDER BY t.created_at DESC LIMIT 500` },
  'my-status': { title: 'My ticket status summary', roles: ['employee'], cols: [{ key: 'status', label: 'Status' }, { key: 'count', label: 'Tickets' }], sql: (w) => `SELECT t.status, COUNT(*)::int AS count FROM tickets t WHERE ${w} GROUP BY t.status ORDER BY count DESC` },
  'my-tasks': { title: 'My task summary', roles: ['employee'], cols: [{ key: 'status', label: 'Status' }, { key: 'count', label: 'Tasks' }, { key: 'overdue', label: 'Overdue' }],
    sql: (_w, c) => `SELECT k.status, COUNT(*)::int AS count, COUNT(*) FILTER (WHERE k.due_date < CURRENT_DATE AND k.status IN ('pending','in_progress'))::int AS overdue FROM tasks k WHERE k.assigned_to='${c.me}' GROUP BY k.status ORDER BY count DESC` },
  'my-projects': { title: 'My project progress', roles: ['employee'], cols: [{ key: 'project', label: 'Project' }, { key: 'status', label: 'Status' }, { key: 'due', label: 'Due' }, { key: 'tasks_done', label: 'Tasks done' }, { key: 'tasks_total', label: 'Tasks' }],
    sql: (_w, c) => `SELECT p.code || ' · ' || p.name AS project, p.status, p.due_date::text AS due, (SELECT COUNT(*)::int FROM tasks k WHERE k.project_id=p.id AND k.status='completed') AS tasks_done, (SELECT COUNT(*)::int FROM tasks k WHERE k.project_id=p.id AND k.status<>'cancelled') AS tasks_total FROM projects p WHERE p.company_id='${c.cid}' AND (p.manager_id='${c.me}' OR EXISTS (SELECT 1 FROM project_members m WHERE m.project_id=p.id AND m.user_id='${c.me}')) ORDER BY p.due_date NULLS LAST` },
};

router.get('/', (req, res) => res.json({ data: Object.entries(REPORTS).filter(([, d]) => d.roles.includes(req.user!.role)).map(([key, d]) => ({ key, title: d.title })) }));

router.get('/:name', async (req, res) => {
  const u = req.user!; const def = REPORTS[req.params.name]; if (!def) throw notFound('Unknown report');
  if (!def.roles.includes(u.role)) throw forbidden('This report is not available to your role');
  const iso = /^\d{4}-\d{2}-\d{2}$/; const today = new Date().toISOString().slice(0, 10); const d30 = new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);
  const from = String(req.query.from || d30), to = String(req.query.to || today);
  if (!iso.test(from) || !iso.test(to) || from > to) throw bad('Choose a valid date range');
  if ((new Date(to).getTime() - new Date(from).getTime()) / 864e5 > 366) throw bad('The date range can be at most one year');
  const params: any[] = [u.company_id, from, to];   // $1 company, $2 from, $3 to
  const sc = ticketScope(u, params);
  const w = `t.company_id=$1 AND t.created_at::date BETWEEN $2::date AND $3::date ${sc ? 'AND ' + sc : ''}`;
  const sql = def.sql(w, { me: u.id, cid: u.company_id }).replace(/\$FROM/g, '$2').replace(/\$TO/g, '$3').replace(/\$CID/g, '$1');
  const used = Math.max(...[...sql.matchAll(/\$(\d+)/g)].map(m => +m[1]), 0);
  const rows = await query(sql, params.slice(0, used));
  if (req.query.format === 'csv') {
    const labelled = rows.map(r => Object.fromEntries(def.cols.map(c => [c.label, (r as any)[c.key]])));
    await logAudit({ company_id: u.company_id, user_id: u.id, action: 'export', entity_type: 'report', module: 'reports', description: `${u.name} exported report "${def.title}"` });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="hawmess-${req.params.name}-${from}_${to}.csv"`);
    return res.send('\uFEFF' + (labelled.length ? toCsv(labelled) : def.cols.map(c => c.label).join(',')));
  }
  res.json({ key: req.params.name, title: def.title, from, to, columns: def.cols, rows });
});
export default router;
