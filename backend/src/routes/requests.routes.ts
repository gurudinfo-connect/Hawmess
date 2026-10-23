import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool';
import { requireAuth, logAudit } from '../lib/auth';
import { isStaff, UUID_RE } from '../lib/access';
import { bad, forbidden, notFound, pageParams, parse } from '../lib/http';
import { notify, notifyMany, staffIds } from '../lib/notify';

/** Employee requests, including leave. Approval is HR/Admin only and nobody can decide their own request. */
const router = Router();
router.use(requireAuth);

const SELECT = `SELECT r.*, r.start_date::text AS start_date, r.end_date::text AS end_date, u.name AS requester_name, d.name AS department_name, dc.name AS decided_by_name, ru.name AS requester_role_name
  FROM employee_requests r JOIN users u ON u.id=r.user_id LEFT JOIN departments d ON d.id=u.department_id LEFT JOIN users dc ON dc.id=r.decided_by
  LEFT JOIN company_users cu ON cu.user_id=u.id LEFT JOIN roles ru ON ru.id=cu.role_id`;

router.get('/', async (req, res) => {
  const u = req.user!; const params: any[] = [u.company_id]; const conds = ['r.company_id=$1'];
  if (!isStaff(u) || req.query.mine === '1') { params.push(u.id); conds.push(`r.user_id=$${params.length}`); }
  else if (u.role === 'hr') { params.push(u.id); conds.push(`(r.user_id=$${params.length} OR r.send_to IN ('hr','both'))`); }   // HR only sees what was sent to HR
  for (const k of ['status', 'type']) if (req.query[k]) { params.push(String(req.query[k])); conds.push(`r.${k}=$${params.length}`); }
  const { page, pageSize, offset } = pageParams(req.query);
  const total = (await query<any>(`SELECT COUNT(*)::int n FROM employee_requests r WHERE ${conds.join(' AND ')}`, params))[0].n;
  res.json({ data: await query(`${SELECT} WHERE ${conds.join(' AND ')} ORDER BY (r.status='pending') DESC, r.created_at DESC LIMIT ${pageSize} OFFSET ${offset}`, params), total, page, pageSize });
});

const schema = z.object({ type: z.enum(['leave', 'equipment', 'document', 'other']), leave_type: z.enum(['annual', 'sick', 'casual', 'unpaid', 'other']).optional().nullable(), title: z.string().trim().min(2).max(160).optional(), reason: z.string().max(2000).optional().nullable(), start_date: z.string().optional().nullable(), end_date: z.string().optional().nullable(), send_to: z.enum(['hr', 'admin', 'both']).optional().nullable() });
router.post('/', async (req, res) => {
  const u = req.user!; const body = Object.fromEntries(Object.entries(req.body || {}).map(([k, v]) => [k, v === '' ? null : v])); const d = parse(schema, body);
  if (d.type === 'leave') {
    if (!d.leave_type) throw bad('Choose a leave type'); if (!d.start_date || !d.end_date) throw bad('Choose the leave dates'); if (d.end_date < d.start_date) throw bad('End date cannot be before the start date');
    if ((await query(`SELECT 1 FROM employee_requests WHERE user_id=$1 AND type='leave' AND status IN ('pending','approved') AND daterange(start_date, end_date, '[]') && daterange($2::date, $3::date, '[]')`, [u.id, d.start_date, d.end_date])).length) throw bad('You already have a leave request covering some of these dates');
  } else if (!d.title) throw bad('Add a title');
  const title = d.title || `${(d.leave_type || '').replace(/^\w/, c => c.toUpperCase())} leave`;
  const sendTo = u.role === 'employee' ? (d.send_to || 'both') : 'admin';   // HR / admin requests are always decided by an admin
  const r = (await query<any>(`INSERT INTO employee_requests (company_id, user_id, type, leave_type, title, reason, start_date, end_date, send_to) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [u.company_id, u.id, d.type, d.type === 'leave' ? d.leave_type : null, title, d.reason || null, d.start_date || null, d.end_date || null, sendTo]))[0];
  await notifyMany(u.company_id, await staffIds(u.company_id, sendTo === 'both' ? ['admin', 'hr'] : [sendTo]), u.id, 'request_new', `${u.name} submitted a ${d.type} request`, title, 'employee_request', r.id);
  await logAudit({ company_id: u.company_id, user_id: u.id, action: 'create', entity_type: 'employee_request', entity_id: r.id, module: 'requests', description: `${u.name} submitted ${d.type} request ${r.request_no}` });
  res.status(201).json(r);
});

router.post('/:id/decide', async (req, res) => {
  const u = req.user!; if (!isStaff(u)) throw forbidden('Only HR or an admin can decide requests'); if (!UUID_RE.test(req.params.id)) throw notFound();
  const d = parse(z.object({ decision: z.enum(['approved', 'rejected']), note: z.string().max(1000).optional().nullable() }), req.body);
  const r = (await query<any>(`SELECT r.*, (SELECT ro.name FROM company_users cu JOIN roles ro ON ro.id=cu.role_id WHERE cu.user_id=r.user_id LIMIT 1) AS requester_role FROM employee_requests r WHERE r.id=$1 AND r.company_id=$2`, [req.params.id, u.company_id]))[0]; if (!r) throw notFound('Request not found');
  if (r.user_id === u.id) throw forbidden('You cannot approve or reject your own request');
  if (u.role === 'hr' && ['admin', 'hr'].includes(r.requester_role)) throw forbidden('Requests from HR and admin users are decided by an admin');
  if (u.role === 'hr' && r.send_to === 'admin') throw forbidden('This request was sent to the admin only');
  if (r.status !== 'pending') throw bad(`This request is already ${r.status}`);
  if (d.decision === 'rejected' && !(d.note || '').trim()) throw bad('Add a reason when rejecting a request');
  await query(`UPDATE employee_requests SET status=$2, decided_by=$3, decided_at=now(), decision_note=$4 WHERE id=$1`, [r.id, d.decision, u.id, d.note || null]);
  await notify(u.company_id, r.user_id, 'request_decided', `Your request was ${d.decision}`, `${r.title}${d.note ? ' — ' + d.note : ''}`, 'employee_request', r.id);
  await logAudit({ company_id: u.company_id, user_id: u.id, action: d.decision === 'approved' ? 'approve' : 'reject', entity_type: 'employee_request', entity_id: r.id, module: 'requests', description: `${u.name} ${d.decision} request ${r.request_no}` });
  res.json({ ok: true });
});
router.post('/:id/cancel', async (req, res) => {
  const u = req.user!; if (!UUID_RE.test(req.params.id)) throw notFound();
  const r = (await query<any>(`UPDATE employee_requests SET status='cancelled' WHERE id=$1 AND user_id=$2 AND status='pending' RETURNING request_no`, [req.params.id, u.id]))[0]; if (!r) throw bad('Only your own pending requests can be cancelled');
  await logAudit({ company_id: u.company_id, user_id: u.id, action: 'cancel', entity_type: 'employee_request', entity_id: req.params.id, module: 'requests', description: `${u.name} cancelled request ${r.request_no}` }); res.json({ ok: true });
});
export default router;
