import { Router } from 'express';
import { query } from '../db/pool';
import { requireAuth } from '../lib/auth';
import { ticketScope } from '../lib/access';
import { OVERDUE, RESOLVED_STATES, SLA_BREACHED } from '../lib/sla';

const router = Router();
router.use(requireAuth);

/** SLA compliance = of the tickets whose resolution target is already decided (resolved, or already breached), the share resolved on time. null when nothing is decided yet. */
const JUDGED = `(t.resolution_due IS NOT NULL AND (t.resolved_at IS NOT NULL OR (t.status NOT IN ${RESOLVED_STATES} AND now() > t.resolution_due)))`;
const SLA_COMPLIANCE = `CASE WHEN COUNT(*) FILTER (WHERE ${JUDGED}) = 0 THEN NULL
  ELSE ROUND(100.0 * COUNT(*) FILTER (WHERE t.resolution_due IS NOT NULL AND t.resolved_at IS NOT NULL AND t.resolved_at <= t.resolution_due) / COUNT(*) FILTER (WHERE ${JUDGED}), 1) END`;

router.get('/', async (req, res) => {
  const u = req.user!; const cid = u.company_id;
  const params: any[] = [cid]; const sc = ticketScope(u, params); const w = `t.company_id=$1 ${sc ? 'AND ' + sc : ''}`;
  const unreadN = (await query<any>(`SELECT COUNT(*)::int n FROM notifications WHERE user_id=$1 AND NOT is_read`, [u.id]))[0].n;

  if (u.role === 'employee') {
    const k = (await query<any>(`SELECT COUNT(*) FILTER (WHERE t.status NOT IN ${RESOLVED_STATES})::int AS open_tickets, COUNT(*) FILTER (WHERE t.status='pending')::int AS awaiting_response,
      COUNT(*) FILTER (WHERE t.status IN ('resolved','closed'))::int AS resolved_tickets, COUNT(*)::int AS total_tickets,
      COUNT(*) FILTER (WHERE t.acceptance='pending' AND t.assignee_id=$${params.length + 1} AND t.status NOT IN ${RESOLVED_STATES})::int AS awaiting_acceptance FROM tickets t WHERE ${w}`, [...params, u.id]))[0];
    const [tasks] = await query<any>(`SELECT COUNT(*) FILTER (WHERE status IN ('pending','in_progress'))::int AS open_tasks, COUNT(*) FILTER (WHERE status IN ('pending','in_progress') AND due_date < CURRENT_DATE)::int AS overdue_tasks FROM tasks WHERE assigned_to=$1`, [u.id]);
    const [reqs] = await query<any>(`SELECT COUNT(*)::int AS pending_requests FROM employee_requests WHERE user_id=$1 AND status='pending'`, [u.id]);
    res.json({ role: 'employee', kpis: { ...k, ...tasks, ...reqs, unread_notifications: unreadN },
      recent_tickets: await query(`SELECT t.id, t.ticket_no, t.subject, t.status, t.priority, t.updated_at FROM tickets t WHERE ${w} ORDER BY t.updated_at DESC LIMIT 6`, params),
      awaiting: await query(`SELECT t.id, t.ticket_no, t.subject, t.updated_at FROM tickets t WHERE ${w} AND t.status='pending' ORDER BY t.updated_at DESC LIMIT 5`, params),
      to_accept: await query(`SELECT t.id, t.ticket_no, t.subject, t.priority, t.updated_at FROM tickets t WHERE t.company_id=$1 AND t.assignee_id=$2 AND t.acceptance='pending' AND t.status NOT IN ${RESOLVED_STATES} ORDER BY t.updated_at DESC LIMIT 6`, [cid, u.id]),
      my_tasks: await query(`SELECT id, title, priority, status, due_date::text AS due_date, (due_date < CURRENT_DATE) AS is_overdue FROM tasks WHERE assigned_to=$1 AND status IN ('pending','in_progress') ORDER BY due_date NULLS LAST LIMIT 6`, [u.id]),
      my_projects: await query(`SELECT p.id, p.code, p.name, p.status, p.due_date::text AS due_date FROM projects p WHERE p.company_id=$1 AND p.status IN ('planning','active','on_hold') AND (p.manager_id=$2 OR EXISTS (SELECT 1 FROM project_members m WHERE m.project_id=p.id AND m.user_id=$2)) ORDER BY p.due_date NULLS LAST LIMIT 5`, [cid, u.id]),
      notifications: await query(`SELECT id, title, message, type, entity_type, entity_id, is_read, created_at FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 5`, [u.id]) });
    return;
  }

  const k = (await query<any>(`SELECT COUNT(*)::int AS total_tickets,
    COUNT(*) FILTER (WHERE t.status NOT IN ${RESOLVED_STATES})::int AS open_tickets,
    COUNT(*) FILTER (WHERE t.status='new')::int AS new_tickets,
    COUNT(*) FILTER (WHERE t.assignee_id IS NULL AND t.status NOT IN ${RESOLVED_STATES})::int AS unassigned_tickets,
    COUNT(*) FILTER (WHERE t.status='in_progress')::int AS in_progress_tickets,
    COUNT(*) FILTER (WHERE t.status='pending')::int AS pending_tickets,
    COUNT(*) FILTER (WHERE t.status IN ('resolved','closed'))::int AS resolved_tickets,
    COUNT(*) FILTER (WHERE ${OVERDUE})::int AS overdue_tickets,
    COUNT(*) FILTER (WHERE ${SLA_BREACHED})::int AS breached_tickets,
    COUNT(*) FILTER (WHERE t.is_escalated AND t.status NOT IN ${RESOLVED_STATES})::int AS escalated_tickets,
    COUNT(*) FILTER (WHERE t.status NOT IN ${RESOLVED_STATES} AND (t.assignee_id=$${params.length + 1} OR t.assignee_id IS NULL))::int AS awaiting_me,
    COUNT(*) FILTER (WHERE t.acceptance='pending' AND t.status NOT IN ${RESOLVED_STATES})::int AS awaiting_acceptance,
    COUNT(*) FILTER (WHERE t.acceptance='accepted' AND t.status NOT IN ${RESOLVED_STATES})::int AS accepted_tickets,
    COUNT(*) FILTER (WHERE t.acceptance='declined' AND t.status NOT IN ${RESOLVED_STATES})::int AS declined_tickets,
    ${SLA_COMPLIANCE} AS sla_compliance FROM tickets t WHERE ${w}`, [...params, u.id]))[0];
  const [pe] = await query<any>(`SELECT COUNT(*) FILTER (WHERE r.status='pending')::int AS pending_requests, COUNT(*) FILTER (WHERE r.status='pending' AND r.type='leave')::int AS pending_leave
    FROM employee_requests r ${u.role === 'hr' ? `WHERE r.company_id=$1 AND r.user_id<>$2 AND NOT EXISTS (SELECT 1 FROM company_users cu JOIN roles ro ON ro.id=cu.role_id WHERE cu.user_id=r.user_id AND ro.name IN ('admin','hr'))` : 'WHERE r.company_id=$1 AND r.user_id<>$2'}`, [cid, u.id]);
  const [pp] = await query<any>(`SELECT COUNT(*) FILTER (WHERE status='active')::int AS active_projects, COUNT(*)::int AS all_projects FROM projects WHERE company_id=$1`, [cid]);
  const [ep] = await query<any>(`SELECT COUNT(*)::int AS total_employees FROM users x JOIN company_users cu ON cu.user_id=x.id WHERE cu.company_id=$1 AND x.is_active`, [cid]);
  const trend = await query(`SELECT to_char(d.d,'DD Mon') AS label, (SELECT COUNT(*)::int FROM tickets t WHERE ${w} AND t.created_at::date=d.d) AS created, (SELECT COUNT(*)::int FROM tickets t WHERE ${w} AND t.resolved_at::date=d.d) AS resolved
    FROM generate_series(CURRENT_DATE - 13, CURRENT_DATE, '1 day') d(d) ORDER BY d.d`, params);
  const workload = await query(`SELECT COALESCE(a.name,'Unassigned') AS name, COUNT(*)::int AS open, COUNT(*) FILTER (WHERE ${SLA_BREACHED})::int AS breached FROM tickets t LEFT JOIN users a ON a.id=t.assignee_id WHERE ${w} AND t.status NOT IN ${RESOLVED_STATES} GROUP BY a.name ORDER BY open DESC LIMIT 8`, params);
  const byStatus = await query(`SELECT t.status, COUNT(*)::int AS count FROM tickets t WHERE ${w} GROUP BY t.status`, params);
  const byPriority = await query(`SELECT t.priority, COUNT(*)::int AS count FROM tickets t WHERE ${w} AND t.status NOT IN ${RESOLVED_STATES} GROUP BY t.priority`, params);
  const recentTickets = await query(`SELECT t.id, t.ticket_no, t.subject, t.status, t.priority, t.created_at, rq.name AS requester_name, (${SLA_BREACHED}) AS sla_breached FROM tickets t JOIN users rq ON rq.id=t.requester_id WHERE ${w} ORDER BY t.created_at DESC LIMIT 6`, params);
  const modFilter = u.role === 'admin' ? '' : `AND a.module IN ('tickets','requests','tasks','projects')`;
  const activity = await query(`SELECT a.created_at, a.description, a.action, a.module, us.name AS user_name FROM audit_logs a LEFT JOIN users us ON us.id=a.user_id WHERE a.company_id=$1 ${modFilter} ORDER BY a.created_at DESC LIMIT 8`, [cid]);
  // what employees did with the tickets handed to them: accepted / declined / progress notes
  const acceptances = await query(`SELECT x.id, x.type, x.note, x.progress, x.created_at, t.id AS ticket_id, t.ticket_no, t.subject, us.name AS user_name
    FROM ticket_updates x JOIN tickets t ON t.id=x.ticket_id JOIN users us ON us.id=x.user_id WHERE ${w} AND x.type IN ('accepted','declined','progress') AND x.user_id<>t.requester_id ORDER BY x.created_at DESC LIMIT 8`, params);
  res.json({ role: u.role, kpis: { ...k, ...pe, ...pp, ...ep, unread_notifications: unreadN }, acceptances, trend, workload, by_status: byStatus, by_priority: byPriority, recent_tickets: recentTickets, activity });
});

export default router;
