import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db/pool';
import { requireAuth, requireRole, logAudit } from '../lib/auth';
import { isStaff } from '../lib/access';
import { bad, forbidden, notFound, parse } from '../lib/http';
import { sendEmail } from '../lib/email';
import { PRIORITIES, STAFF_NEXT, REQUESTER_NEXT, STATUSES } from './tickets.routes';

const router = Router();
router.use(requireAuth);
const admin = requireRole('admin');
const audit = (req: any, action: string, type: string, id: string | null, description: string, nv?: any) =>
  logAudit({ company_id: req.user.company_id, user_id: req.user.id, action, entity_type: type, entity_id: id, module: 'configuration', new_value: nv, description });
const dup = (e: any, what: string) => { if (e?.code === '23505') throw bad(`${what} already exists`); throw e; };

// ---------- departments ----------
router.get('/departments', async (req, res) => res.json({ data: await query(`SELECT d.*, (SELECT COUNT(*)::int FROM users u WHERE u.department_id=d.id AND u.is_active) AS member_count FROM departments d WHERE d.company_id=$1 ORDER BY d.name`, [req.user!.company_id]) }));
const deptSchema = z.object({ name: z.string().trim().min(2).max(80), description: z.string().max(300).optional().nullable() });
router.post('/departments', admin, async (req, res) => {
  const d = parse(deptSchema, req.body);
  try { const r = (await query<any>(`INSERT INTO departments (company_id, name, description) VALUES ($1,$2,$3) RETURNING *`, [req.user!.company_id, d.name, d.description || null]))[0]; await audit(req, 'create', 'department', r.id, `${req.user!.name} created department ${d.name}`); res.status(201).json(r); } catch (e) { dup(e, 'A department with this name'); }
});
router.patch('/departments/:id', admin, async (req, res) => {
  const d = parse(deptSchema.partial(), req.body);
  try { const r = (await query<any>(`UPDATE departments SET name=COALESCE($3,name), description=COALESCE($4,description) WHERE id=$1 AND company_id=$2 RETURNING *`, [req.params.id, req.user!.company_id, d.name ?? null, d.description ?? null]))[0]; if (!r) throw notFound(); await audit(req, 'update', 'department', r.id, `${req.user!.name} updated department ${r.name}`); res.json(r); } catch (e) { dup(e, 'A department with this name'); }
});
router.delete('/departments/:id', admin, async (req, res) => {
  const r = (await query<any>(`DELETE FROM departments WHERE id=$1 AND company_id=$2 RETURNING name`, [req.params.id, req.user!.company_id]))[0]; if (!r) throw notFound();
  await audit(req, 'delete', 'department', req.params.id, `${req.user!.name} deleted department ${r.name}`); res.json({ ok: true });
});

// ---------- teams ----------
router.get('/teams', async (req, res) => res.json({ data: await query(`SELECT t.*, d.name AS department_name, l.name AS lead_name,
  COALESCE((SELECT json_agg(json_build_object('id', u.id, 'name', u.name)) FROM team_members m JOIN users u ON u.id=m.user_id WHERE m.team_id=t.id), '[]') AS members
  FROM teams t LEFT JOIN departments d ON d.id=t.department_id LEFT JOIN users l ON l.id=t.lead_id WHERE t.company_id=$1 ORDER BY t.name`, [req.user!.company_id]) }));
const teamSchema = z.object({ name: z.string().trim().min(2).max(80), description: z.string().max(300).optional().nullable(), department_id: z.string().uuid().optional().nullable(), lead_id: z.string().uuid().optional().nullable(), is_active: z.boolean().optional(), user_ids: z.array(z.string().uuid()).optional() });
async function setMembers(client: any, teamId: string, ids: string[], cid: string) {
  await client.query(`DELETE FROM team_members WHERE team_id=$1`, [teamId]);
  for (const uid of ids) await client.query(`INSERT INTO team_members (team_id, user_id) SELECT $1, u.id FROM users u JOIN company_users cu ON cu.user_id=u.id WHERE u.id=$2 AND cu.company_id=$3 ON CONFLICT DO NOTHING`, [teamId, uid, cid]);
}
router.post('/teams', admin, async (req, res) => {
  const d = parse(teamSchema, req.body); const cid = req.user!.company_id;
  try {
    const r = await withTransaction(async c => { const t = (await c.query(`INSERT INTO teams (company_id, name, description, department_id, lead_id) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [cid, d.name, d.description || null, d.department_id || null, d.lead_id || null])).rows[0]; await setMembers(c, t.id, d.user_ids || [], cid); return t; });
    await audit(req, 'create', 'team', r.id, `${req.user!.name} created team ${d.name}`); res.status(201).json(r);
  } catch (e) { dup(e, 'A team with this name'); }
});
router.patch('/teams/:id', admin, async (req, res) => {
  const d = parse(teamSchema.partial(), req.body); const cid = req.user!.company_id;
  try {
    const r = await withTransaction(async c => {
      const t = (await c.query(`UPDATE teams SET name=COALESCE($3,name), description=COALESCE($4,description), department_id=CASE WHEN $5::boolean THEN $6 ELSE department_id END, lead_id=CASE WHEN $7::boolean THEN $8 ELSE lead_id END, is_active=COALESCE($9,is_active) WHERE id=$1 AND company_id=$2 RETURNING *`,
        [req.params.id, cid, d.name ?? null, d.description ?? null, 'department_id' in d, d.department_id ?? null, 'lead_id' in d, d.lead_id ?? null, d.is_active ?? null])).rows[0];
      if (!t) throw notFound(); if (d.user_ids) await setMembers(c, t.id, d.user_ids, cid); return t;
    });
    await audit(req, 'update', 'team', r.id, `${req.user!.name} updated team ${r.name}`); res.json(r);
  } catch (e) { dup(e, 'A team with this name'); }
});
router.delete('/teams/:id', admin, async (req, res) => {
  const r = (await query<any>(`DELETE FROM teams WHERE id=$1 AND company_id=$2 RETURNING name`, [req.params.id, req.user!.company_id]))[0]; if (!r) throw notFound();
  await audit(req, 'delete', 'team', req.params.id, `${req.user!.name} deleted team ${r.name}`); res.json({ ok: true });
});

// ---------- ticket categories (+ assignment rules: default team / assignee) ----------
router.get('/categories', async (req, res) => res.json({ data: await query(`SELECT c.*, t.name AS default_team_name, u.name AS default_assignee_name, (SELECT COUNT(*)::int FROM tickets x WHERE x.category_id=c.id OR x.subcategory_id=c.id) AS ticket_count
  FROM ticket_categories c LEFT JOIN teams t ON t.id=c.default_team_id LEFT JOIN users u ON u.id=c.default_assignee_id
  WHERE c.company_id=$1 ${isStaff(req.user!) && req.query.all === '1' ? '' : 'AND c.is_active'} ORDER BY c.parent_id NULLS FIRST, c.name`, [req.user!.company_id]) }));
const catSchema = z.object({ name: z.string().trim().min(2).max(80), parent_id: z.string().uuid().optional().nullable(), default_team_id: z.string().uuid().optional().nullable(), default_assignee_id: z.string().uuid().optional().nullable(), hr_visible: z.boolean().optional(), is_active: z.boolean().optional() });
router.post('/categories', admin, async (req, res) => {
  const d = parse(catSchema, req.body);
  try { const r = (await query<any>(`INSERT INTO ticket_categories (company_id, name, parent_id, default_team_id, default_assignee_id, hr_visible) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [req.user!.company_id, d.name, d.parent_id || null, d.default_team_id || null, d.default_assignee_id || null, d.hr_visible ?? false]))[0]; await audit(req, 'create', 'category', r.id, `${req.user!.name} created category ${d.name}`); res.status(201).json(r); } catch (e) { dup(e, 'A category with this name'); }
});
router.patch('/categories/:id', admin, async (req, res) => {
  const d = parse(catSchema.partial(), req.body);
  try {
    const r = (await query<any>(`UPDATE ticket_categories SET name=COALESCE($3,name), default_team_id=CASE WHEN $4::boolean THEN $5 ELSE default_team_id END, default_assignee_id=CASE WHEN $6::boolean THEN $7 ELSE default_assignee_id END, hr_visible=COALESCE($8,hr_visible), is_active=COALESCE($9,is_active) WHERE id=$1 AND company_id=$2 RETURNING *`,
      [req.params.id, req.user!.company_id, d.name ?? null, 'default_team_id' in d, d.default_team_id ?? null, 'default_assignee_id' in d, d.default_assignee_id ?? null, d.hr_visible ?? null, d.is_active ?? null]))[0];
    if (!r) throw notFound(); await audit(req, 'update', 'category', r.id, `${req.user!.name} updated category ${r.name}`, d); res.json(r);
  } catch (e) { dup(e, 'A category with this name'); }
});
router.delete('/categories/:id', admin, async (req, res) => {   // categories with tickets are archived, never deleted
  const used = (await query<any>(`SELECT COUNT(*)::int n FROM tickets WHERE category_id=$1 OR subcategory_id=$1`, [req.params.id]))[0].n;
  const r = used ? (await query<any>(`UPDATE ticket_categories SET is_active=false WHERE id=$1 AND company_id=$2 RETURNING name`, [req.params.id, req.user!.company_id]))[0]
                 : (await query<any>(`DELETE FROM ticket_categories WHERE id=$1 AND company_id=$2 RETURNING name`, [req.params.id, req.user!.company_id]))[0];
  if (!r) throw notFound(); await audit(req, used ? 'archive' : 'delete', 'category', req.params.id, `${req.user!.name} ${used ? 'archived' : 'deleted'} category ${r.name}`); res.json({ ok: true, archived: used > 0 });
});

// ---------- SLA policies ----------
router.get('/sla', async (req, res) => { if (!isStaff(req.user!)) throw forbidden(); res.json({ data: await query(`SELECT s.*, c.name AS category_name FROM sla_policies s LEFT JOIN ticket_categories c ON c.id=s.category_id WHERE s.company_id=$1 ORDER BY (s.category_id IS NOT NULL), CASE s.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END`, [req.user!.company_id]) }); });
const slaSchema = z.object({ name: z.string().trim().min(2).max(80), priority: z.enum(PRIORITIES), category_id: z.string().uuid().optional().nullable(), first_response_minutes: z.number().int().min(1).max(525600), resolution_minutes: z.number().int().min(1).max(525600), is_active: z.boolean().optional() })
  .refine(d => d.resolution_minutes >= d.first_response_minutes, { message: 'Resolution time must be at least the first-response time', path: ['resolution_minutes'] });
router.post('/sla', admin, async (req, res) => {
  const d = parse(slaSchema, req.body);
  try { const r = (await query<any>(`INSERT INTO sla_policies (company_id, name, priority, category_id, first_response_minutes, resolution_minutes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [req.user!.company_id, d.name, d.priority, d.category_id || null, d.first_response_minutes, d.resolution_minutes]))[0]; await audit(req, 'create', 'sla_policy', r.id, `${req.user!.name} created SLA policy ${d.name}`); res.status(201).json(r); } catch (e) { dup(e, 'An SLA policy for this priority and category'); }
});
router.patch('/sla/:id', admin, async (req, res) => {
  const d = parse(z.object({ name: z.string().trim().min(2).max(80), first_response_minutes: z.number().int().min(1).max(525600), resolution_minutes: z.number().int().min(1).max(525600), is_active: z.boolean() }).partial(), req.body);
  const r = (await query<any>(`UPDATE sla_policies SET name=COALESCE($3,name), first_response_minutes=COALESCE($4,first_response_minutes), resolution_minutes=COALESCE($5,resolution_minutes), is_active=COALESCE($6,is_active) WHERE id=$1 AND company_id=$2 AND COALESCE($5,resolution_minutes) >= COALESCE($4,first_response_minutes) RETURNING *`,
    [req.params.id, req.user!.company_id, d.name ?? null, d.first_response_minutes ?? null, d.resolution_minutes ?? null, d.is_active ?? null]))[0];
  if (!r) throw bad('Policy not found, or resolution time is shorter than first-response time');
  await audit(req, 'update', 'sla_policy', r.id, `${req.user!.name} updated SLA policy ${r.name}`, d); res.json(r);
});
router.delete('/sla/:id', admin, async (req, res) => { const r = (await query<any>(`DELETE FROM sla_policies WHERE id=$1 AND company_id=$2 RETURNING name`, [req.params.id, req.user!.company_id]))[0]; if (!r) throw notFound(); await audit(req, 'delete', 'sla_policy', req.params.id, `${req.user!.name} deleted SLA policy ${r.name}`); res.json({ ok: true }); });

// ---------- read-only: lifecycle & role matrix (these are enforced in code, so they are shown, not edited) ----------
router.get('/lifecycle', async (_req, res) => res.json({ statuses: STATUSES, priorities: PRIORITIES, staff_transitions: STAFF_NEXT, requester_transitions: REQUESTER_NEXT }));
router.get('/roles', admin, async (_req, res) => res.json({ data: [
  { role: 'admin', can: ['Everything: users, configuration, SLA, all tickets, all projects, reports, activity log', 'Approve leave and employee requests', 'Clear escalations'] },
  { role: 'hr', can: ['Employee directory and requests', 'Tickets in HR-visible categories, tickets assigned to them or their teams', 'Assign / reply / resolve / escalate to admin', 'Approve leave and employee requests (never their own)', 'Team tasks, projects (read), reports, filtered activity log'], cannot: ['User management, configuration, SLA policies, categories', 'Tickets outside their categories/teams'] },
  { role: 'employee', can: ['Raise and track their own tickets, reply publicly, reopen / close / cancel their own', 'Their tasks, projects they belong to, their requests and leave', 'Chat with colleagues, HR and admins'], cannot: ['Internal notes, other people\'s tickets, assignment, admin pages'] },
] }));

// ---------- settings (key/value) ----------
const DEFAULTS: Record<string, any> = {
  general: { product_name: 'Barid-IN', support_email: '', timezone: 'Asia/Kolkata', working_hours_note: 'SLA clocks run on calendar time.' },
  branding: { primary_color: '#0b57c4', accent_color: '#01d8c2', default_theme: 'light' },
  notifications: { ticket_created: true, ticket_assigned: true, status_changed: true, new_reply: true, escalated: true, task_due: true, request_decided: true },
};
router.get('/settings', async (req, res) => {
  const rows = await query<any>(`SELECT key, value FROM app_settings WHERE company_id=$1`, [req.user!.company_id]);
  const out: any = {}; for (const k of Object.keys(DEFAULTS)) out[k] = { ...DEFAULTS[k], ...(rows.find(r => r.key === k)?.value || {}) };
  res.json(out);
});
const settingSchemas: Record<string, z.ZodTypeAny> = {
  general: z.object({ product_name: z.string().trim().min(1).max(60), support_email: z.string().email().or(z.literal('')), timezone: z.string().max(60), working_hours_note: z.string().max(300) }),
  branding: z.object({ primary_color: z.string().regex(/^#[0-9a-fA-F]{6}$/), accent_color: z.string().regex(/^#[0-9a-fA-F]{6}$/), default_theme: z.enum(['light', 'dark']) }),
  notifications: z.object(Object.fromEntries(Object.keys(DEFAULTS.notifications).map(k => [k, z.boolean()]))),
};
router.put('/settings/:key', admin, async (req, res) => {
  const schema = settingSchemas[req.params.key]; if (!schema) throw notFound('Unknown setting group');
  const v = parse(schema, req.body);
  await query(`INSERT INTO app_settings (company_id, key, value) VALUES ($1,$2,$3) ON CONFLICT (company_id, key) DO UPDATE SET value=$3, updated_at=now()`, [req.user!.company_id, req.params.key, JSON.stringify(v)]);
  await audit(req, 'update', 'settings', null, `${req.user!.name} updated ${req.params.key} settings`, v); res.json(v);
});

// ---------- email (secrets stay on the server; the UI only learns whether SMTP is configured) ----------
router.get('/email', admin, async (req, res) => {
  const configured = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD);
  res.json({ configured, host: configured ? process.env.SMTP_HOST : null, from: configured ? process.env.EMAIL_FROM || null : null,
    recent: await query(`SELECT to_email, subject, status, error, created_at FROM email_log WHERE company_id=$1 ORDER BY created_at DESC LIMIT 10`, [req.user!.company_id]) });
});
router.post('/email/test', admin, async (req, res) => {
  const r = await sendEmail({ to: req.user!.email, subject: '[Barid-IN] Test email', text: 'SMTP is working. This is a test message from Barid-IN.' });
  await query(`INSERT INTO email_log (company_id, user_id, to_email, subject, status, error) VALUES ($1,$2,$3,$4,$5,$6)`, [req.user!.company_id, req.user!.id, req.user!.email, 'Test email', r.ok ? 'sent' : 'failed', r.error || null]);
  if (!r.ok) throw bad(r.error || 'Could not send'); res.json({ ok: true, sent_to: req.user!.email });
});

export default router;
