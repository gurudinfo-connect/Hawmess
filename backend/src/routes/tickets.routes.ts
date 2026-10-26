import { withRefRetry } from '../lib/refId';
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import fs from 'fs';
import { PoolClient } from 'pg';
import { query, withTransaction } from '../db/pool';
import { requireAuth, logAudit, AuthUser } from '../lib/auth';
import { commentedSql, favoriteSql, involvedSql, involvementSql, isAdmin, isStaff, loadTicketFor, ticketScope, UUID_RE, watchingSql } from '../lib/access';
import { HttpError, bad, forbidden, notFound, parse, pageParams } from '../lib/http';
import { OVERDUE, RESOLVED_STATES, SLA_BREACHED, SLA_RESOLUTION_BREACHED, SLA_RESPONSE_BREACHED, slaTargets } from '../lib/sla';
import { notify, notifyMany, staffIds } from '../lib/notify';
import { upload, filePath, removeFile } from '../lib/storage';

const router = Router();
router.use(requireAuth);

export const STATUSES = ['new', 'open', 'assigned', 'in_progress', 'pending', 'resolved', 'closed', 'cancelled'] as const;
export const PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
const TERMINAL = ['resolved', 'closed', 'cancelled'];
const REQUEST_TYPES = ['incident', 'service_request', 'question', 'change'];

/** Lifecycle: New → Open → Assigned → In Progress → Pending → Resolved → Closed (+ reopen, cancel). Enforced here, never in the UI. */
export const STAFF_NEXT: Record<string, string[]> = {
  new: ['open', 'assigned', 'in_progress', 'cancelled'],
  open: ['assigned', 'in_progress', 'pending', 'resolved', 'cancelled'],
  assigned: ['open', 'in_progress', 'pending', 'resolved', 'cancelled'],
  in_progress: ['assigned', 'pending', 'resolved', 'cancelled'],
  pending: ['in_progress', 'resolved', 'cancelled'],
  resolved: ['closed', 'open'],
  closed: ['open'],
  cancelled: [],
};
export const REQUESTER_NEXT: Record<string, string[]> = { new: ['cancelled'], open: ['cancelled'], assigned: ['cancelled'], resolved: ['closed', 'open'] };

/** An employee the ticket is assigned to can work it only AFTER accepting it: Start work → Pending ⇄ In progress → Resolve (the requester then confirms / closes). */
export const ASSIGNEE_NEXT: Record<string, string[]> = { assigned: ['in_progress'], open: ['in_progress'], in_progress: ['pending', 'resolved'], pending: ['in_progress', 'resolved'] };

function nextStatuses(u: AuthUser, t: any): string[] {
  if (isStaff(u)) return STAFF_NEXT[t.status] || [];
  const out = new Set<string>();
  if (t.requester_id === u.id) for (const s of REQUESTER_NEXT[t.status] || []) out.add(s);
  if (t.assignee_id === u.id && t.acceptance === 'accepted') for (const s of ASSIGNEE_NEXT[t.status] || []) out.add(s);
  return [...out];
}

/** Role name if `id` is an active user of the company (admin / hr / employee), else null. */
async function assigneeRole(cid: string, id: string): Promise<string | null> {
  const r = await query<any>(`SELECT r.name FROM users u JOIN company_users cu ON cu.user_id=u.id JOIN roles r ON r.id=cu.role_id WHERE u.id=$1 AND cu.company_id=$2 AND u.is_active AND r.name IN ('admin','hr','employee')`, [id, cid]);
  return r[0]?.name || null;
}
/** Employees must accept what is assigned to them; admin / HR assignees work it directly. */
const acceptanceFor = (role: string | null) => (role === 'employee' ? 'pending' : null);
async function logUpdate(c: PoolClient | null, ticketId: string, userId: string | null, type: string, o: { note?: string | null; progress?: number | null; status?: string | null; to_user_id?: string | null } = {}) {
  const args = [ticketId, userId, type, o.note || null, o.progress ?? null, o.status || null, o.to_user_id || null];
  const sql = `INSERT INTO ticket_updates (ticket_id, user_id, type, note, progress, status, to_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`;
  if (c) await c.query(sql, args); else await query(sql, args);
}
/** Who last assigned this ticket (gets told when the employee accepts / declines). */
async function lastAssigner(ticketId: string): Promise<string | null> {
  return (await query<any>(`SELECT changed_by FROM ticket_assignments WHERE ticket_id=$1 AND to_assignee IS NOT NULL ORDER BY created_at DESC LIMIT 1`, [ticketId]))[0]?.changed_by || null;
}

const SELECT = `SELECT t.*, c.name AS category_name, sc.name AS subcategory_name, rq.name AS requester_name, rq.email AS requester_email,
    a.name AS assignee_name, tm.name AS team_name, d.name AS department_name, p.name AS project_name, p.code AS project_code, eu.name AS escalated_to_name,
    ${SLA_BREACHED} AS sla_breached, ${OVERDUE} AS is_overdue
  FROM tickets t
  LEFT JOIN ticket_categories c ON c.id=t.category_id LEFT JOIN ticket_categories sc ON sc.id=t.subcategory_id
  LEFT JOIN users rq ON rq.id=t.requester_id LEFT JOIN users a ON a.id=t.assignee_id LEFT JOIN users eu ON eu.id=t.escalated_to
  LEFT JOIN teams tm ON tm.id=t.team_id LEFT JOIN departments d ON d.id=t.department_id LEFT JOIN projects p ON p.id=t.project_id`;

/** Same as SELECT plus per-user columns: is_favorite, is_watching and the caller's involvement chips. `me` is a $n placeholder. */
const selectWithMe = (me: string) => SELECT.replace('SELECT t.*,', `SELECT t.*, ${favoriteSql(me)} AS is_favorite, ${watchingSql(me)} AS is_watching, ${involvementSql(me)} AS involvement,`);

// ---------------- list ----------------
const SORTS: Record<string, string> = {
  created: 't.created_at', updated: 't.updated_at', sla: 't.resolution_due',
  priority: `CASE t.priority WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END`,
};
export function ticketFilters(u: AuthUser, q: any, params: any[]) {
  params.push(u.company_id); const conds = [`t.company_id=$${params.length}`];
  const sc = ticketScope(u, params); if (sc) conds.push(sc);
  const add = (sql: string, v: any) => { params.push(v); conds.push(sql.replace('?', `$${params.length}`)); };
  const view = String(q.view || '');
  if (view === 'open') conds.push(`t.status NOT IN ${RESOLVED_STATES}`);
  else if (view === 'unassigned') conds.push(`t.assignee_id IS NULL AND t.status NOT IN ${RESOLVED_STATES}`);
  else if (view === 'assigned') conds.push(`t.assignee_id IS NOT NULL AND t.status NOT IN ${RESOLVED_STATES}`);
  else if (view === 'escalated') conds.push(`t.is_escalated AND t.status NOT IN ${RESOLVED_STATES}`);
  else if (view === 'breached') conds.push(SLA_BREACHED);
  else if (view === 'overdue') conds.push(OVERDUE);
  else if (view === 'mine') add('t.assignee_id=?', u.id);
  else if (view === 'awaiting_acceptance') { conds.push(`t.acceptance='pending' AND t.status NOT IN ${RESOLVED_STATES}`); if (!isStaff(u)) add('t.assignee_id=?', u.id); }
  else if (view === 'accepted') { conds.push(`t.acceptance='accepted' AND t.status NOT IN ${RESOLVED_STATES}`); if (!isStaff(u)) add('t.assignee_id=?', u.id); }
  else if (view === 'declined') conds.push(`t.acceptance='declined' AND t.status NOT IN ${RESOLVED_STATES}`);
  else if (view === 'requested') add('t.requester_id=?', u.id);
  else if (view === 'awaiting_me') { add('t.requester_id=?', u.id); conds.push(`t.status='pending'`); }
  else if (['involved', 'watching', 'favorites', 'commented', 'escalated_me'].includes(view)) {   // Workspace + Favorites menus
    params.push(u.id); const me = `$${params.length}`;
    conds.push(view === 'involved' ? involvedSql(me) : view === 'watching' ? watchingSql(me) : view === 'favorites' ? favoriteSql(me) : view === 'commented' ? commentedSql(me) : `t.escalated_to=${me} AND t.status NOT IN ${RESOLVED_STATES}`);
  }
  const type = String(q.type || ''); if (type) { const list = type.split(',').filter(s => REQUEST_TYPES.includes(s)); if (list.length) add('t.request_type = ANY(?)', list); }
  const status = String(q.status || ''); if (status) { const list = status.split(',').filter(s => (STATUSES as readonly string[]).includes(s)); if (list.length) add('t.status = ANY(?)', list); }
  const pr = String(q.priority || ''); if (pr) { const list = pr.split(',').filter(s => (PRIORITIES as readonly string[]).includes(s)); if (list.length) add('t.priority = ANY(?)', list); }
  for (const [k, col] of [['category_id', 't.category_id'], ['department_id', 't.department_id'], ['assignee_id', 't.assignee_id'], ['team_id', 't.team_id'], ['project_id', 't.project_id'], ['requester_id', 't.requester_id']] as const)
    if (q[k]) { if (!UUID_RE.test(String(q[k]))) throw bad(`${k} is not valid`); add(`${col}=?`, q[k]); }
  if (q.from) add('t.created_at >= ?::date', String(q.from)); if (q.to) add(`t.created_at < (?::date + 1)`, String(q.to));
  const s = String(q.search || '').trim();
  if (s) { params.push(`%${s}%`); const n = `$${params.length}`; conds.push(`(t.ticket_no ILIKE ${n} OR t.subject ILIKE ${n} OR rq.name ILIKE ${n} OR a.name ILIKE ${n})`); }
  return conds.join(' AND ');
}

router.get('/', async (req, res) => {
  const u = req.user!; const params: any[] = []; const where = ticketFilters(u, req.query, params);
  const { page, pageSize, offset } = pageParams(req.query);
  const sort = SORTS[String(req.query.sort || 'created')] || SORTS.created; const dir = String(req.query.dir) === 'asc' ? 'ASC' : 'DESC';
  const total = (await query<any>(`SELECT COUNT(*)::int n FROM tickets t LEFT JOIN users rq ON rq.id=t.requester_id LEFT JOIN users a ON a.id=t.assignee_id WHERE ${where}`, params))[0].n;
  params.push(u.id);
  const rows = await query(`${selectWithMe(`$${params.length}`)} WHERE ${where} ORDER BY ${sort} ${dir} NULLS LAST, t.created_at DESC LIMIT ${pageSize} OFFSET ${offset}`, params);
  res.json({ data: rows, total, page, pageSize });
});

/** Kanban / tab counters for whatever the caller may see. */
router.get('/counts', async (req, res) => {
  const u = req.user!; const params: any[] = [u.company_id]; const sc = ticketScope(u, params);
  let w = `t.company_id=$1 ${sc ? 'AND ' + sc : ''}`;
  const types = String(req.query.type || '').split(',').filter(x => REQUEST_TYPES.includes(x)); if (types.length) { params.push(types); w += ` AND t.request_type = ANY($${params.length})`; }
  params.push(u.id); const me = `$${params.length}`; const mine = isStaff(u) ? 'true' : `t.assignee_id=${me}`;   // staff see the company-wide figure; an employee only what is assigned to them
  const r = (await query<any>(`SELECT
    COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE t.status NOT IN ${RESOLVED_STATES})::int AS open,
    COUNT(*) FILTER (WHERE t.assignee_id IS NULL AND t.status NOT IN ${RESOLVED_STATES})::int AS unassigned,
    COUNT(*) FILTER (WHERE t.assignee_id IS NOT NULL AND t.status NOT IN ${RESOLVED_STATES})::int AS assigned,
    COUNT(*) FILTER (WHERE t.is_escalated AND t.status NOT IN ${RESOLVED_STATES})::int AS escalated,
    COUNT(*) FILTER (WHERE ${SLA_BREACHED})::int AS breached,
    COUNT(*) FILTER (WHERE ${OVERDUE})::int AS overdue,
    COUNT(*) FILTER (WHERE t.acceptance='pending' AND t.status NOT IN ${RESOLVED_STATES} AND ${mine})::int AS awaiting_acceptance,
    COUNT(*) FILTER (WHERE t.acceptance='accepted' AND t.status NOT IN ${RESOLVED_STATES} AND ${mine})::int AS accepted,
    COUNT(*) FILTER (WHERE t.acceptance='declined' AND t.status NOT IN ${RESOLVED_STATES})::int AS declined,
    COUNT(*) FILTER (WHERE t.assignee_id=${me} AND t.status NOT IN ${RESOLVED_STATES})::int AS assigned_to_me,
    ${STATUSES.map(s => `COUNT(*) FILTER (WHERE t.status='${s}')::int AS s_${s}`).join(',')}
    FROM tickets t WHERE ${w}`, params))[0];
  res.json(r);
});

/** Everything the top navigation needs in one call: badge counts + the latest starred tickets. */
router.get('/nav', async (req, res) => {
  const u = req.user!; const params: any[] = [u.company_id]; const sc = ticketScope(u, params); params.push(u.id); const me = `$${params.length}`;
  const w = `t.company_id=$1 ${sc ? 'AND ' + sc : ''}`; const live = `t.status NOT IN ${RESOLVED_STATES}`;
  const c = (await query<any>(`SELECT
    COUNT(*) FILTER (WHERE t.request_type='incident' AND ${live})::int AS incidents_open,
    COUNT(*) FILTER (WHERE t.request_type='incident' AND t.is_escalated AND ${live})::int AS incidents_escalated,
    COUNT(*) FILTER (WHERE ${favoriteSql(me)})::int AS favorites,
    COUNT(*) FILTER (WHERE ${watchingSql(me)})::int AS watching,
    COUNT(*) FILTER (WHERE ${involvedSql(me)})::int AS ws_all,
    COUNT(*) FILTER (WHERE ${involvedSql(me)} AND ${live})::int AS ws_open,
    COUNT(*) FILTER (WHERE t.requester_id=${me})::int AS ws_requested,
    COUNT(*) FILTER (WHERE t.assignee_id=${me})::int AS ws_mine,
    COUNT(*) FILTER (WHERE ${commentedSql(me)})::int AS ws_commented,
    COUNT(*) FILTER (WHERE t.escalated_to=${me} AND ${live})::int AS ws_escalated
    FROM tickets t WHERE ${w}`, params))[0];
  const fp: any[] = [u.company_id]; const fsc = ticketScope(u, fp); fp.push(u.id); const fme = `$${fp.length}`;
  const favorites = await query(`SELECT t.id, t.ticket_no, t.subject, t.status, t.priority FROM tickets t WHERE t.company_id=$1 ${fsc ? 'AND ' + fsc : ''} AND ${favoriteSql(fme)}
    ORDER BY (SELECT f.created_at FROM ticket_favorites f WHERE f.ticket_id=t.id AND f.user_id=${fme}) DESC LIMIT 5`, fp);
  res.json({ ...c, favorite_tickets: favorites });
});

router.get('/watchable', async (req, res) => {   // people staff can add as watchers
  if (!isStaff(req.user!)) throw forbidden();
  res.json({ data: await query(`SELECT u.id, u.name, r.name AS role FROM users u JOIN company_users cu ON cu.user_id=u.id JOIN roles r ON r.id=cu.role_id WHERE cu.company_id=$1 AND u.is_active ORDER BY u.name`, [req.user!.company_id]) });
});

router.get('/assignable', async (req, res) => {   // who can a ticket be assigned to
  if (!isStaff(req.user!)) throw forbidden();
  res.json({ data: await query(`SELECT u.id, u.name, r.name AS role FROM users u JOIN company_users cu ON cu.user_id=u.id JOIN roles r ON r.id=cu.role_id
    WHERE cu.company_id=$1 AND u.is_active AND r.name IN ('admin','hr','employee') ORDER BY (r.name='employee'), u.name`, [req.user!.company_id]) });
});

/** Who can this ticket be handed to? Staff: anyone assignable. Accepted assignee (employee): any other active colleague. */
router.get('/:id/reassign-targets', async (req, res) => {
  const u = req.user!; const t = await loadTicketFor(u, req.params.id); if (!t) throw notFound('Ticket not found');
  if (!isStaff(u) && !(t.assignee_id === u.id && t.acceptance === 'accepted')) throw forbidden('You cannot reassign this ticket');
  res.json({ data: await query(`SELECT u.id, u.name, r.name AS role FROM users u JOIN company_users cu ON cu.user_id=u.id JOIN roles r ON r.id=cu.role_id
    WHERE cu.company_id=$1 AND u.is_active AND r.name IN ('admin','hr','employee') AND ($2::uuid IS NULL OR u.id <> $2) ORDER BY (r.name='employee'), u.name`, [u.company_id, isStaff(u) ? null : u.id]) });   // an employee can't hand it to themselves; staff keep the current assignee in the list
});

// ---------------- create ----------------
const createSchema = z.object({
  subject: z.string().trim().min(3).max(200), description: z.string().trim().min(3).max(10000),
  category_id: z.string().uuid(), subcategory_id: z.string().uuid().optional().nullable(),
  priority: z.enum(PRIORITIES).default('medium'), request_type: z.enum(['incident', 'service_request', 'question', 'change']).default('incident'),
  requester_id: z.string().uuid().optional().nullable(), department_id: z.string().uuid().optional().nullable(), project_id: z.string().uuid().optional().nullable(),
  team_id: z.string().uuid().optional().nullable(), assignee_id: z.string().uuid().optional().nullable(),
  channel: z.enum(['self_service', 'phone', 'email', 'chat', 'walk_in']).optional().nullable(),
  impact: z.enum(['high', 'medium', 'low']).optional().nullable(), urgency: z.enum(['high', 'medium', 'low']).optional().nullable(),
  service: z.string().trim().max(200).optional().nullable(), service_offering: z.string().trim().max(200).optional().nullable(), configuration_item: z.string().trim().max(200).optional().nullable(),
});
const blankToNull = (b: any) => Object.fromEntries(Object.entries(b || {}).map(([k, v]) => [k, v === '' ? null : v]));

async function saveAttachments(client: PoolClient, files: Express.Multer.File[] | undefined, ticketId: string, userId: string, commentId: string | null, internal: boolean) {
  for (const f of files || []) {
    await client.query(`INSERT INTO ticket_attachments (ticket_id, comment_id, uploaded_by, filename, mime_type, size_bytes, storage_key, is_internal) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [ticketId, commentId, userId, f.originalname.slice(0, 200), f.mimetype, f.size, f.filename, internal]);
  }
}
const cleanup = (files?: Express.Multer.File[]) => Promise.all((files || []).map(f => removeFile(f.filename)));

router.post('/', upload.array('files', 5), async (req, res) => {
  const u = req.user!; const files = req.files as Express.Multer.File[] | undefined;
  try {
    const d = parse(createSchema, blankToNull(req.body)); const cid = u.company_id;
    const cat = (await query<any>(`SELECT * FROM ticket_categories WHERE id=$1 AND company_id=$2 AND is_active AND parent_id IS NULL`, [d.category_id, cid]))[0];
    if (!cat) throw bad('Choose a valid category');
    if (d.subcategory_id && !(await query(`SELECT 1 FROM ticket_categories WHERE id=$1 AND parent_id=$2 AND is_active`, [d.subcategory_id, d.category_id])).length) throw bad('Subcategory does not belong to this category');
    let requesterId = u.id;
    if (d.requester_id && d.requester_id !== u.id) {
      if (!isStaff(u)) throw forbidden('Only staff can raise a ticket on behalf of someone else');
      if (!(await query(`SELECT 1 FROM users u JOIN company_users cu ON cu.user_id=u.id WHERE u.id=$1 AND cu.company_id=$2 AND u.is_active`, [d.requester_id, cid])).length) throw bad('Requester not found');
      requesterId = d.requester_id;
    }
    const reqUser = (await query<any>(`SELECT department_id FROM users WHERE id=$1`, [requesterId]))[0];
    if (d.project_id) {
      const ok = isStaff(u) ? await query(`SELECT 1 FROM projects WHERE id=$1 AND company_id=$2`, [d.project_id, cid])
        : await query(`SELECT 1 FROM projects p WHERE p.id=$1 AND p.company_id=$2 AND (p.manager_id=$3 OR EXISTS (SELECT 1 FROM project_members m WHERE m.project_id=p.id AND m.user_id=$3))`, [d.project_id, cid, u.id]);
      if (!ok.length) throw bad('You can only link a project you are part of');
    }
    // Assignment: staff may choose explicitly; otherwise the category's configured rule applies; otherwise the ticket stays in the unassigned queue (safe fallback).
    let teamId: string | null = null, assigneeId: string | null = null;
    if (isStaff(u) && (d.team_id || d.assignee_id)) { teamId = d.team_id || null; assigneeId = d.assignee_id || null; }
    else { teamId = cat.default_team_id; assigneeId = cat.default_assignee_id; }
    let acceptance: string | null = null;
    if (assigneeId) { const role = await assigneeRole(cid, assigneeId); if (!role) assigneeId = null; else acceptance = acceptanceFor(role); }   // employees must accept
    if (teamId && !(await query(`SELECT 1 FROM teams WHERE id=$1 AND company_id=$2 AND is_active`, [teamId, cid])).length) teamId = null;
    const status = assigneeId ? 'assigned' : teamId ? 'open' : 'new';
    const now = new Date(); const sla = await slaTargets(cid, d.priority, d.category_id, now);

    const ticket = await withRefRetry(() => withTransaction(async (c) => {
      const t = (await c.query(`INSERT INTO tickets (company_id, subject, description, category_id, subcategory_id, priority, request_type, requester_id, department_id, project_id, team_id, assignee_id, status, first_response_due, resolution_due, created_at, updated_at, channel, impact, urgency, service, service_offering, configuration_item, acceptance)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING *`,
        [cid, d.subject, d.description, d.category_id, d.subcategory_id || null, d.priority, d.request_type, requesterId, d.department_id || reqUser?.department_id || null, d.project_id || null, teamId, assigneeId, status, sla.first_response_due, sla.resolution_due, now, d.channel || null, d.impact || null, d.urgency || null, d.service || null, d.service_offering || null, d.configuration_item || null, acceptance])).rows[0];
      if (assigneeId) await logUpdate(c, t.id, u.id, 'assigned', { to_user_id: assigneeId, note: 'Assigned on creation' });
      await c.query(`INSERT INTO ticket_status_history (ticket_id, from_status, to_status, changed_by, note) VALUES ($1,NULL,$2,$3,'Ticket created')`, [t.id, status, u.id]);
      if (assigneeId || teamId) await c.query(`INSERT INTO ticket_assignments (ticket_id, to_assignee, to_team, changed_by, note) VALUES ($1,$2,$3,$4,$5)`, [t.id, assigneeId, teamId, u.id, assigneeId || teamId ? 'Assigned on creation' : null]);
      await saveAttachments(c, files, t.id, u.id, null, false);
      return t;
    }));
    await logAudit({ company_id: cid, user_id: u.id, action: 'create', entity_type: 'ticket', entity_id: ticket.id, module: 'tickets', description: `${u.name} created ticket ${ticket.ticket_no}: ${ticket.subject}` });
    // notifications
    await notify(cid, requesterId, 'ticket_created', `Ticket ${ticket.ticket_no} created`, `We received "${ticket.subject}". You'll be notified of every update.`, 'ticket', ticket.id);
    if (assigneeId) await notify(cid, assigneeId, 'ticket_assigned', `Ticket ${ticket.ticket_no} assigned to you`, acceptance ? `${ticket.subject} — please accept it to start working on it.` : ticket.subject, 'ticket', ticket.id);
    else {
      const targets = [...await staffIds(cid, ['admin']), ...(cat.hr_visible ? await staffIds(cid, ['hr']) : [])];
      await notifyMany(cid, targets, requesterId, 'ticket_new', `New ticket ${ticket.ticket_no}`, `${ticket.subject} (${ticket.priority})`, 'ticket', ticket.id);
    }
    res.status(201).json(ticket);
  } catch (e) { await cleanup(files); throw e; }
});

// ---------------- detail ----------------
function slaBlock(t: any) {
  const now = Date.now(); const created = new Date(t.created_at).getTime();
  const end = t.resolved_at ? new Date(t.resolved_at).getTime() : TERMINAL.includes(t.status) ? new Date(t.updated_at).getTime() : now;
  const mins = (ms: number) => Math.round(ms / 60000);
  const resDue = t.resolution_due ? new Date(t.resolution_due).getTime() : null;
  return {
    has_policy: !!t.resolution_due, first_response_due: t.first_response_due, first_response_at: t.first_response_at, resolution_due: t.resolution_due, resolved_at: t.resolved_at,
    elapsed_minutes: mins(end - created),
    first_response_minutes: t.first_response_at ? mins(new Date(t.first_response_at).getTime() - created) : null,
    remaining_minutes: resDue && !TERMINAL.includes(t.status) ? mins(resDue - now) : null,
    is_overdue: !!t.is_overdue, response_breached: !!(t.first_response_due && (t.first_response_at ? new Date(t.first_response_at) > new Date(t.first_response_due) : !TERMINAL.includes(t.status) && now > new Date(t.first_response_due).getTime())),
    resolution_breached: !!(resDue && (t.resolved_at ? new Date(t.resolved_at).getTime() > resDue : !TERMINAL.includes(t.status) && now > resDue)),
  };
}

router.get('/attachments/:id', async (req, res) => {   // authenticated, permission-checked download
  const u = req.user!; if (!UUID_RE.test(req.params.id)) throw notFound();
  const a = (await query<any>(`SELECT * FROM ticket_attachments WHERE id=$1`, [req.params.id]))[0];
  if (!a) throw notFound();
  const t = await loadTicketFor(u, a.ticket_id);
  if (!t || (a.is_internal && !isStaff(u))) throw notFound();
  const p = filePath(a.storage_key); if (!fs.existsSync(p)) throw notFound('File is missing from storage');
  res.setHeader('Content-Type', a.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(a.filename)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  fs.createReadStream(p).pipe(res);
});

router.get('/:id', async (req, res) => {
  const u = req.user!; const base = await loadTicketFor(u, req.params.id); if (!base) throw notFound('Ticket not found');
  const t = (await query<any>(`${selectWithMe('$2')} WHERE t.id=$1`, [base.id, u.id]))[0]; const staff = isStaff(u);
  const watchers = staff ? await query(`SELECT w.user_id AS id, us.name, w.created_at, ab.name AS added_by_name FROM ticket_watchers w JOIN users us ON us.id=w.user_id LEFT JOIN users ab ON ab.id=w.added_by WHERE w.ticket_id=$1 ORDER BY us.name`, [t.id]) : [];
  const comments = await query(`SELECT cm.id, cm.body, cm.is_internal, cm.is_info_request, cm.created_at, cm.author_id, au.name AS author_name, r.name AS author_role
    FROM ticket_comments cm JOIN users au ON au.id=cm.author_id LEFT JOIN company_users cu ON cu.user_id=au.id LEFT JOIN roles r ON r.id=cu.role_id
    WHERE cm.ticket_id=$1 ${staff ? '' : 'AND NOT cm.is_internal'} ORDER BY cm.created_at`, [t.id]);
  const attachments = await query(`SELECT id, comment_id, filename, mime_type, size_bytes, created_at, is_internal, (SELECT name FROM users WHERE id=uploaded_by) AS uploaded_by_name FROM ticket_attachments WHERE ticket_id=$1 ${staff ? '' : 'AND NOT is_internal'} ORDER BY created_at`, [t.id]);
  const history = await query(`SELECT h.id, h.from_status, h.to_status, h.note, h.created_at, u.name AS changed_by_name FROM ticket_status_history h LEFT JOIN users u ON u.id=h.changed_by WHERE h.ticket_id=$1 ORDER BY h.created_at`, [t.id]);
  const involvedParty = staff || t.requester_id === u.id || t.assignee_id === u.id;
  const updates = involvedParty ? await query(`SELECT x.id, x.type, x.note, x.progress, x.status, x.created_at, au.name AS user_name, tu.name AS to_user_name
    FROM ticket_updates x LEFT JOIN users au ON au.id=x.user_id LEFT JOIN users tu ON tu.id=x.to_user_id WHERE x.ticket_id=$1 ORDER BY x.created_at DESC`, [t.id]) : [];
  const assignments = involvedParty ? await query(`SELECT a.id, a.note, a.created_at, fu.name AS from_assignee_name, tu.name AS to_assignee_name, ft.name AS from_team_name, tt.name AS to_team_name, cb.name AS changed_by_name
    FROM ticket_assignments a LEFT JOIN users fu ON fu.id=a.from_assignee LEFT JOIN users tu ON tu.id=a.to_assignee LEFT JOIN teams ft ON ft.id=a.from_team LEFT JOIN teams tt ON tt.id=a.to_team LEFT JOIN users cb ON cb.id=a.changed_by
    WHERE a.ticket_id=$1 ORDER BY a.created_at`, [t.id]) : [];
  const closedForReplies = ['closed', 'cancelled'].includes(t.status);
  res.json({
    ...t, comments, attachments, watchers, status_history: history, assignment_history: assignments, updates, sla: slaBlock(t),
    actions: {
      next_statuses: nextStatuses(u, t), can_reply: !closedForReplies && (staff || t.requester_id === u.id || t.assignee_id === u.id), can_internal: staff,
      can_accept: t.assignee_id === u.id && t.acceptance === 'pending' && !TERMINAL.includes(t.status), can_decline: t.assignee_id === u.id && t.acceptance === 'pending' && !TERMINAL.includes(t.status),
      can_update: !TERMINAL.includes(t.status) && (staff || (t.assignee_id === u.id && t.acceptance === 'accepted')),
      can_assign: staff, can_reassign: staff || (t.assignee_id === u.id && t.acceptance === 'accepted' && !TERMINAL.includes(t.status)), can_edit: staff, can_manage_watchers: staff, can_escalate: staff && !TERMINAL.includes(t.status) && !t.is_escalated, can_deescalate: isAdmin(u) && t.is_escalated,
    },
  });
});

// ---------------- core operations (shared by single + bulk) ----------------
async function addHistory(c: PoolClient, ticketId: string, from: string | null, to: string, by: string, note?: string | null) {
  await c.query(`INSERT INTO ticket_status_history (ticket_id, from_status, to_status, changed_by, note) VALUES ($1,$2,$3,$4,$5)`, [ticketId, from, to, by, note || null]);
}

export async function changeStatus(u: AuthUser, ticketId: string, to: string, note?: string | null) {
  const out = await withTransaction(async (c) => {
    const t = (await c.query(`SELECT * FROM tickets WHERE id=$1 AND company_id=$2 FOR UPDATE`, [ticketId, u.company_id])).rows[0];
    if (!t) throw notFound('Ticket not found');
    if (!nextStatuses(u, t).includes(to)) throw bad(`A ticket that is ${t.status.replace('_', ' ')} cannot be moved to ${to.replace('_', ' ')} by you`);
    if (to === 'resolved' && !(note || '').trim()) throw bad('Add resolution details before resolving the ticket');
    let assignee = t.assignee_id;
    if (to === 'assigned' && !assignee) throw bad('Assign the ticket to someone first');
    const sets = ['status=$2', 'updated_at=now()']; const vals: any[] = [t.id, to];
    if (to === 'in_progress' && !assignee && isStaff(u)) {   // taking a ticket assigns it to the person who starts working on it
      assignee = u.id; vals.push(u.id); sets.push(`assignee_id=$${vals.length}`);
      await c.query(`INSERT INTO ticket_assignments (ticket_id, from_assignee, to_assignee, changed_by, note) VALUES ($1,NULL,$2,$2,'Took ownership')`, [t.id, u.id]);
    }
    if (to === 'resolved') { vals.push((note || '').trim()); sets.push(`resolved_at=now()`, `resolution_note=$${vals.length}`, 'progress=100'); }
    if (to === 'closed') sets.push(`closed_at=now()`);
    if (to === 'open' && ['resolved', 'closed'].includes(t.status)) sets.push('resolved_at=NULL', 'closed_at=NULL');   // reopened
    await c.query(`UPDATE tickets SET ${sets.join(', ')} WHERE id=$1`, vals);
    await addHistory(c, t.id, t.status, to, u.id, to === 'open' && ['resolved', 'closed'].includes(t.status) ? (note || 'Reopened') : note);
    return { before: t, assignee };
  });
  const t = out.before; const label = to.replace('_', ' ');
  const type = to === 'resolved' ? 'ticket_resolved' : to === 'closed' ? 'ticket_closed' : 'ticket_status';
  const watchers = (await query<any>(`SELECT user_id FROM ticket_watchers WHERE ticket_id=$1`, [t.id])).map(w => w.user_id);
  await notifyMany(u.company_id, [t.requester_id, out.assignee, ...watchers], u.id, type, `Ticket ${t.ticket_no} is now ${label}`, to === 'resolved' ? note || t.subject : t.subject, 'ticket', t.id);
  await logAudit({ company_id: u.company_id, user_id: u.id, action: 'status_change', entity_type: 'ticket', entity_id: t.id, module: 'tickets', old_value: { status: t.status }, new_value: { status: to }, description: `${u.name} moved ${t.ticket_no} from ${t.status.replace('_', ' ')} to ${label}` });
}

/** Staff may assign / reassign anything. An employee may hand over a ticket that is assigned to them and that they have accepted — to another person only (never the team, never to nobody). */
export async function assignTicket(u: AuthUser, ticketId: string, assigneeId: string | null | undefined, teamId: string | null | undefined, note?: string | null) {
  const staff = isStaff(u);
  if (!staff) {
    if (teamId !== undefined) throw forbidden('Only staff can change the team');
    if (!assigneeId) throw bad('Choose who to reassign this ticket to');
    if (!(note || '').trim()) throw bad('Add a short reason for reassigning the ticket');
  }
  const cid = u.company_id;
  let newRole: string | null = null;
  if (assigneeId) { newRole = await assigneeRole(cid, assigneeId); if (!newRole) throw bad('Assignee must be an active user of your company'); }
  if (teamId && !(await query(`SELECT 1 FROM teams WHERE id=$1 AND company_id=$2 AND is_active`, [teamId, cid])).length) throw bad('Team not found');
  const before = await withTransaction(async (c) => {
    const t = (await c.query(`SELECT * FROM tickets WHERE id=$1 AND company_id=$2 FOR UPDATE`, [ticketId, cid])).rows[0];
    if (!t) throw notFound('Ticket not found');
    if (!staff) {
      if (t.assignee_id !== u.id) throw forbidden('Only the person this ticket is assigned to can reassign it');
      if (t.acceptance !== 'accepted') throw bad('Accept the ticket before reassigning it (or decline it to send it back to the admin)');
    }
    if (TERMINAL.includes(t.status)) throw bad('Reopen the ticket before reassigning it');
    const newAssignee = assigneeId === undefined ? t.assignee_id : assigneeId; const newTeam = teamId === undefined ? t.team_id : teamId;
    if (newAssignee === t.assignee_id && newTeam === t.team_id) throw bad('Nothing to change');
    const personChanged = newAssignee !== t.assignee_id;
    let status = t.status;
    // A new person has to pick the ticket up from the start: anything being worked on goes back to 'assigned' until they accept it.
    if (newAssignee && (['new', 'open'].includes(t.status) || (personChanged && ['in_progress', 'pending'].includes(t.status)))) status = 'assigned'; else if (!newAssignee && t.status === 'assigned') status = 'open';
    const acceptance = personChanged ? acceptanceFor(newRole) : t.acceptance;   // same ticket, same reference number — acceptance starts over for the new assignee
    await c.query(`UPDATE tickets SET assignee_id=$2, team_id=$3, status=$4, acceptance=$5, accepted_at=${personChanged ? 'NULL' : 'accepted_at'}, acceptance_note=${personChanged ? 'NULL' : 'acceptance_note'}, updated_at=now() WHERE id=$1`, [t.id, newAssignee, newTeam, status, acceptance]);
    if (personChanged && newAssignee) await logUpdate(c, t.id, u.id, t.assignee_id ? 'reassigned' : 'assigned', { to_user_id: newAssignee, note });
    await c.query(`INSERT INTO ticket_assignments (ticket_id, from_assignee, to_assignee, from_team, to_team, changed_by, note) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [t.id, t.assignee_id, newAssignee, t.team_id, newTeam, u.id, note || null]);
    if (status !== t.status) await addHistory(c, t.id, t.status, status, u.id, personChanged && newAssignee && t.assignee_id ? 'Reassigned — waiting for the new assignee' : 'Assignment changed');
    return { t, newAssignee, newTeam };
  });
  const { t, newAssignee } = before;
  if (newAssignee && newAssignee !== t.assignee_id) await notify(cid, newAssignee, 'ticket_assigned', `Ticket ${t.ticket_no} assigned to you`, acceptanceFor(newRole) ? `${t.subject} — please accept it to start working on it.` : t.subject, 'ticket', t.id);
  const admins = staff ? [] : await staffIds(cid, ['admin']);   // when an employee hands a ticket over, the admins are kept in the loop
  await notifyMany(cid, [t.requester_id, t.assignee_id !== newAssignee ? t.assignee_id : null, ...admins], u.id, 'ticket_assignment', `Ticket ${t.ticket_no} was ${newAssignee ? (t.assignee_id && t.assignee_id !== newAssignee ? 'reassigned' : 'assigned') : 'moved'}`, staff ? t.subject : `${u.name} reassigned it${note ? `: ${note.slice(0, 120)}` : ''}`, 'ticket', t.id);
  await logAudit({ company_id: cid, user_id: u.id, action: 'assign', entity_type: 'ticket', entity_id: t.id, module: 'tickets', old_value: { assignee_id: t.assignee_id, team_id: t.team_id }, new_value: { assignee_id: before.newAssignee, team_id: before.newTeam }, description: `${u.name} changed the assignment of ${t.ticket_no}` });
}

const statusSchema = z.object({ status: z.enum(STATUSES), note: z.string().trim().max(5000).optional().nullable() });
router.post('/:id/status', async (req, res) => {
  const u = req.user!; const t = await loadTicketFor(u, req.params.id); if (!t) throw notFound('Ticket not found');
  const d = parse(statusSchema, req.body); await changeStatus(u, t.id, d.status, d.note); res.json({ ok: true });
});

const assignSchema = z.object({ assignee_id: z.string().uuid().nullable().optional(), team_id: z.string().uuid().nullable().optional(), note: z.string().max(1000).optional().nullable() });
router.post('/:id/assign', async (req, res) => {
  const u = req.user!; const t = await loadTicketFor(u, req.params.id); if (!t) throw notFound('Ticket not found');
  const d = parse(assignSchema, req.body); if (d.assignee_id === undefined && d.team_id === undefined) throw bad('Choose an assignee or a team');
  await assignTicket(u, t.id, d.assignee_id, d.team_id, d.note); res.json({ ok: true });
});

// ---------------- employee acceptance + progress updates ----------------
router.post('/:id/accept', async (req, res) => {
  const u = req.user!; const t = await loadTicketFor(u, req.params.id); if (!t) throw notFound('Ticket not found');
  const d = parse(z.object({ note: z.string().trim().max(1000).optional().nullable() }), req.body || {});
  if (t.assignee_id !== u.id) throw forbidden('This ticket is not assigned to you');
  if (t.acceptance !== 'pending') throw bad(t.acceptance === 'accepted' ? 'You have already accepted this ticket' : 'This ticket does not need to be accepted');
  if (TERMINAL.includes(t.status)) throw bad('This ticket is already closed');
  await withTransaction(async (c) => {
    await c.query(`UPDATE tickets SET acceptance='accepted', accepted_at=now(), acceptance_note=$2, updated_at=now() WHERE id=$1`, [t.id, d.note || null]);
    await logUpdate(c, t.id, u.id, 'accepted', { note: d.note });
  });
  const assigner = await lastAssigner(t.id);
  await notifyMany(u.company_id, [assigner, t.requester_id, t.escalated_to, ...await staffIds(u.company_id, ['admin'])], u.id, 'ticket_accepted', `${u.name} accepted ${t.ticket_no}`, t.subject, 'ticket', t.id);
  await logAudit({ company_id: u.company_id, user_id: u.id, action: 'accept', entity_type: 'ticket', entity_id: t.id, module: 'tickets', description: `${u.name} accepted ticket ${t.ticket_no}` });
  res.json({ ok: true });
});

router.post('/:id/decline', async (req, res) => {
  const u = req.user!; const t = await loadTicketFor(u, req.params.id); if (!t) throw notFound('Ticket not found');
  const d = parse(z.object({ reason: z.string().trim().min(3, 'Tell us why you are declining').max(1000) }), req.body || {});
  if (t.assignee_id !== u.id) throw forbidden('This ticket is not assigned to you');
  if (t.acceptance !== 'pending') throw bad('Only a ticket you have not accepted yet can be declined');
  const assigner = await lastAssigner(t.id);
  await withTransaction(async (c) => {   // goes back to the queue (still the same ticket / reference number) for the admin to reassign
    const to = 'open';
    await c.query(`UPDATE tickets SET assignee_id=NULL, acceptance='declined', accepted_at=NULL, acceptance_note=$2, status=$3, updated_at=now() WHERE id=$1`, [t.id, d.reason, to]);
    await c.query(`INSERT INTO ticket_assignments (ticket_id, from_assignee, to_assignee, from_team, to_team, changed_by, note) VALUES ($1,$2,NULL,$3,$3,$2,$4)`, [t.id, u.id, t.team_id, `Declined: ${d.reason}`]);
    await addHistory(c, t.id, t.status, to, u.id, `Declined by assignee: ${d.reason}`);
    await logUpdate(c, t.id, u.id, 'declined', { note: d.reason });
  });
  await notifyMany(u.company_id, [assigner, ...await staffIds(u.company_id, ['admin'])], u.id, 'ticket_declined', `${u.name} declined ${t.ticket_no}`, d.reason, 'ticket', t.id);
  await logAudit({ company_id: u.company_id, user_id: u.id, action: 'decline', entity_type: 'ticket', entity_id: t.id, module: 'tickets', description: `${u.name} declined ticket ${t.ticket_no}: ${d.reason}` });
  res.json({ ok: true });
});

/** "Update the process": the assignee (or staff) posts a progress note, optionally a % complete and a status move (start / pending / resolve). */
const updateSchema = z.object({ note: z.string().trim().min(3, 'Write a short update').max(3000), progress: z.coerce.number().int().min(0).max(100).optional().nullable(), status: z.enum(['in_progress', 'pending', 'resolved']).optional().nullable() });
router.post('/:id/updates', async (req, res) => {
  const u = req.user!; const t = await loadTicketFor(u, req.params.id); if (!t) throw notFound('Ticket not found');
  const d = parse(updateSchema, req.body || {});
  if (!isStaff(u) && t.assignee_id !== u.id) throw forbidden('Only the person working on this ticket can post updates');
  if (!isStaff(u) && t.acceptance !== 'accepted') throw bad('Accept the ticket before posting updates');
  if (TERMINAL.includes(t.status)) throw bad('This ticket is already closed — reopen it to post updates');
  if (d.status && d.status !== t.status) await changeStatus(u, t.id, d.status, d.note);   // validates the move; 'resolved' needs the note as resolution details
  await withTransaction(async (c) => {
    await logUpdate(c, t.id, u.id, 'progress', { note: d.note, progress: d.progress, status: d.status && d.status !== t.status ? d.status : null });
    if (d.progress !== undefined && d.progress !== null && d.status !== 'resolved') await c.query(`UPDATE tickets SET progress=$2, updated_at=now() WHERE id=$1`, [t.id, d.progress]);
    else await c.query(`UPDATE tickets SET updated_at=now() WHERE id=$1`, [t.id]);
  });
  const assigner = await lastAssigner(t.id);
  if (!d.status || d.status === t.status) await notifyMany(u.company_id, [t.requester_id, assigner, t.escalated_to], u.id, 'ticket_progress', `Update on ${t.ticket_no}${d.progress != null ? ` · ${d.progress}% done` : ''}`, d.note.slice(0, 140), 'ticket', t.id);   // a status move already notified everyone
  await logAudit({ company_id: u.company_id, user_id: u.id, action: 'progress_update', entity_type: 'ticket', entity_id: t.id, module: 'tickets', description: `${u.name} posted a progress update on ${t.ticket_no}` });
  res.json({ ok: true });
});

const patchSchema = z.object({ priority: z.enum(PRIORITIES).optional(), category_id: z.string().uuid().optional(), project_id: z.string().uuid().nullable().optional(), subject: z.string().trim().min(3).max(200).optional() }).strict();
export async function patchTicket(u: AuthUser, ticketId: string, d: z.infer<typeof patchSchema>) {
  if (!isStaff(u)) throw forbidden('Only staff can edit ticket fields');
  const t = (await query<any>(`SELECT * FROM tickets WHERE id=$1 AND company_id=$2`, [ticketId, u.company_id]))[0]; if (!t) throw notFound('Ticket not found');
  if (TERMINAL.includes(t.status)) throw bad('Reopen the ticket before editing it');
  const f: string[] = []; const v: any[] = [t.id];
  const set = (col: string, val: any) => { v.push(val); f.push(`${col}=$${v.length}`); };
  if (d.subject) set('subject', d.subject);
  if (d.category_id) { if (!(await query(`SELECT 1 FROM ticket_categories WHERE id=$1 AND company_id=$2 AND parent_id IS NULL AND is_active`, [d.category_id, u.company_id])).length) throw bad('Invalid category'); set('category_id', d.category_id); set('subcategory_id', null); }
  if (d.project_id !== undefined) { if (d.project_id && !(await query(`SELECT 1 FROM projects WHERE id=$1 AND company_id=$2`, [d.project_id, u.company_id])).length) throw bad('Invalid project'); set('project_id', d.project_id); }
  const pr = d.priority || t.priority; const cat = d.category_id || t.category_id;
  if (d.priority || d.category_id) {   // SLA is recalculated from the ORIGINAL creation time against the policy that now applies
    if (d.priority) set('priority', d.priority);
    const sla = await slaTargets(u.company_id, pr, cat, new Date(t.created_at)); set('first_response_due', sla.first_response_due); set('resolution_due', sla.resolution_due);
  }
  if (!f.length) throw bad('Nothing to change');
  await query(`UPDATE tickets SET ${f.join(', ')}, updated_at=now() WHERE id=$1`, v);
  if (d.priority && d.priority !== t.priority) {
    await notifyMany(u.company_id, [t.requester_id, t.assignee_id], u.id, 'ticket_priority', `Ticket ${t.ticket_no} priority is now ${d.priority}`, t.subject, 'ticket', t.id);
    await logAudit({ company_id: u.company_id, user_id: u.id, action: 'priority_change', entity_type: 'ticket', entity_id: t.id, module: 'tickets', old_value: { priority: t.priority }, new_value: { priority: d.priority }, description: `${u.name} changed priority of ${t.ticket_no} from ${t.priority} to ${d.priority}` });
  } else await logAudit({ company_id: u.company_id, user_id: u.id, action: 'update', entity_type: 'ticket', entity_id: t.id, module: 'tickets', new_value: d, description: `${u.name} updated ${t.ticket_no}` });
}
router.patch('/:id', async (req, res) => {
  const u = req.user!; const t = await loadTicketFor(u, req.params.id); if (!t) throw notFound('Ticket not found');
  await patchTicket(u, t.id, parse(patchSchema, req.body)); res.json({ ok: true });
});

// ---------------- conversation ----------------
const commentSchema = z.object({ body: z.string().trim().min(1).max(10000), is_internal: z.coerce.boolean().optional(), request_info: z.coerce.boolean().optional() });
router.post('/:id/comments', upload.array('files', 5), async (req, res) => {
  const u = req.user!; const files = req.files as Express.Multer.File[] | undefined;
  try {
    const t = await loadTicketFor(u, req.params.id); if (!t) throw notFound('Ticket not found');
    const raw = { ...req.body, is_internal: req.body.is_internal === 'true' || req.body.is_internal === true, request_info: req.body.request_info === 'true' || req.body.request_info === true };
    const d = parse(commentSchema, raw); const staff = isStaff(u);
    const isRequester = t.requester_id === u.id;
    const isAssignee = t.assignee_id === u.id;
    if (!staff && !isRequester && !isAssignee) throw forbidden();
    if (d.is_internal && !staff) throw forbidden('Only staff can write internal notes');
    if (!d.is_internal && ['closed', 'cancelled'].includes(t.status)) throw bad('This ticket is closed. Reopen it to reply.');
    const internal = !!d.is_internal; const infoReq = staff && !internal && !!d.request_info && !TERMINAL.includes(t.status);
    const comment = await withTransaction(async (c) => {
      const cm = (await c.query(`INSERT INTO ticket_comments (ticket_id, author_id, body, is_internal, is_info_request) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [t.id, u.id, d.body, internal, infoReq])).rows[0];
      await saveAttachments(c, files, t.id, u.id, cm.id, internal);
      const sets = ['updated_at=now()'];
      if (staff && !internal && !t.first_response_at && t.requester_id !== u.id) sets.push('first_response_at=now()');   // SLA clock: first PUBLIC reply from staff
      if (infoReq && t.status !== 'pending') { sets.push(`status='pending'`); await addHistory(c, t.id, t.status, 'pending', u.id, 'More information requested'); }
      if (isRequester && !staff && t.status === 'pending') { const to = t.assignee_id ? 'in_progress' : 'open'; sets.push(`status='${to}'`); await addHistory(c, t.id, 'pending', to, u.id, 'Requester replied'); }
      if (isRequester && !staff && t.status === 'resolved') { sets.push(`status='open'`, 'resolved_at=NULL'); await addHistory(c, t.id, 'resolved', 'open', u.id, 'Requester replied — reopened'); }
      await c.query(`UPDATE tickets SET ${sets.join(', ')} WHERE id=$1`, [t.id]);
      return cm;
    });
    const cid = u.company_id;
    if (internal) { await notifyMany(cid, [t.assignee_id, t.escalated_to], u.id, 'ticket_note', `Internal note on ${t.ticket_no}`, d.body.slice(0, 140), 'ticket', t.id); }
    else {
      if (u.id === t.requester_id) { const targets = t.assignee_id ? [t.assignee_id] : await staffIds(cid, ['admin']); await notifyMany(cid, targets, u.id, 'ticket_reply', `${u.name} replied on ${t.ticket_no}`, d.body.slice(0, 140), 'ticket', t.id); }
      else await notify(cid, t.requester_id, infoReq ? 'info_request' : 'ticket_reply', infoReq ? `More information needed on ${t.ticket_no}` : `New reply on ${t.ticket_no}`, d.body.slice(0, 140), 'ticket', t.id);
      const watchers = (await query<any>(`SELECT user_id FROM ticket_watchers WHERE ticket_id=$1`, [t.id])).map(w => w.user_id);   // public replies only, never internal notes
      await notifyMany(cid, watchers, u.id, 'ticket_reply', `New reply on ${t.ticket_no}`, d.body.slice(0, 140), 'ticket', t.id);
    }
    await logAudit({ company_id: cid, user_id: u.id, action: internal ? 'internal_note' : 'comment', entity_type: 'ticket', entity_id: t.id, module: 'tickets', description: `${u.name} ${internal ? 'added an internal note to' : 'replied on'} ${t.ticket_no}` });
    res.status(201).json(comment);
  } catch (e) { await cleanup(files); throw e; }
});

// ---------------- favorites & watchers ----------------
const onSchema = z.object({ on: z.boolean() });
router.post('/:id/favorite', async (req, res) => {   // star / un-star for myself
  const u = req.user!; const t = await loadTicketFor(u, req.params.id); if (!t) throw notFound('Ticket not found');
  const { on } = parse(onSchema, req.body);
  if (on) await query(`INSERT INTO ticket_favorites (user_id, ticket_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [u.id, t.id]);
  else await query(`DELETE FROM ticket_favorites WHERE user_id=$1 AND ticket_id=$2`, [u.id, t.id]);
  res.json({ ok: true, is_favorite: on });
});
router.post('/:id/watch', async (req, res) => {   // follow / unfollow for myself (only tickets I can already see)
  const u = req.user!; const t = await loadTicketFor(u, req.params.id); if (!t) throw notFound('Ticket not found');
  const { on } = parse(onSchema, req.body);
  if (on) await query(`INSERT INTO ticket_watchers (ticket_id, user_id, added_by) VALUES ($1,$2,$2) ON CONFLICT DO NOTHING`, [t.id, u.id]);
  else {
    await query(`DELETE FROM ticket_watchers WHERE ticket_id=$1 AND user_id=$2`, [t.id, u.id]);
  }
  res.json({ ok: true, is_watching: on });
});
router.post('/:id/watchers', async (req, res) => {   // staff add someone else as a (read-only) watcher
  const u = req.user!; if (!isStaff(u)) throw forbidden('Only staff can add watchers'); const t = await loadTicketFor(u, req.params.id); if (!t) throw notFound('Ticket not found');
  const d = parse(z.object({ user_id: z.string().uuid() }), req.body);
  if (!(await query(`SELECT 1 FROM users x JOIN company_users cu ON cu.user_id=x.id WHERE x.id=$1 AND cu.company_id=$2 AND x.is_active`, [d.user_id, u.company_id])).length) throw bad('Choose an active user from your company');
  const ins = await query<any>(`INSERT INTO ticket_watchers (ticket_id, user_id, added_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING user_id`, [t.id, d.user_id, u.id]);
  if (ins.length) {
    await notify(u.company_id, d.user_id, 'ticket_watch', `You were added to ${t.ticket_no}`, t.subject, 'ticket', t.id);
    await logAudit({ company_id: u.company_id, user_id: u.id, action: 'add_watcher', entity_type: 'ticket', entity_id: t.id, module: 'tickets', description: `${u.name} added a watcher to ${t.ticket_no}` });
  }
  res.json({ ok: true });
});
router.delete('/:id/watchers/:userId', async (req, res) => {
  const u = req.user!; if (!isStaff(u)) throw forbidden('Only staff can remove watchers'); const t = await loadTicketFor(u, req.params.id); if (!t) throw notFound('Ticket not found');
  if (!UUID_RE.test(req.params.userId)) throw bad('Invalid user');
  await query(`DELETE FROM ticket_watchers WHERE ticket_id=$1 AND user_id=$2`, [t.id, req.params.userId]);
  res.json({ ok: true });
});

// ---------------- escalation ----------------
router.post('/:id/escalate', async (req, res) => {
  const u = req.user!; if (!isStaff(u)) throw forbidden('Only staff can escalate'); const t = await loadTicketFor(u, req.params.id); if (!t) throw notFound('Ticket not found');
  const d = parse(z.object({ reason: z.string().trim().min(3).max(1000), to_user_id: z.string().uuid().optional().nullable() }), req.body);
  if (TERMINAL.includes(t.status)) throw bad('Resolved or closed tickets cannot be escalated'); if (t.is_escalated) throw bad('Ticket is already escalated');
  if (d.to_user_id && !(await query(`SELECT 1 FROM users u JOIN company_users cu ON cu.user_id=u.id JOIN roles r ON r.id=cu.role_id WHERE u.id=$1 AND cu.company_id=$2 AND u.is_active AND r.name='admin'`, [d.to_user_id, u.company_id])).length) throw bad('Escalate to an active admin');
  await withTransaction(async (c) => {
    await c.query(`UPDATE tickets SET is_escalated=true, escalated_at=now(), escalated_to=$2, escalation_reason=$3, updated_at=now() WHERE id=$1`, [t.id, d.to_user_id || null, d.reason]);
    await c.query(`INSERT INTO ticket_comments (ticket_id, author_id, body, is_internal) VALUES ($1,$2,$3,true)`, [t.id, u.id, `Escalated: ${d.reason}`]);
  });
  const targets = d.to_user_id ? [d.to_user_id] : await staffIds(u.company_id, ['admin']);
  await notifyMany(u.company_id, [...targets, t.assignee_id], u.id, 'ticket_escalated', `Ticket ${t.ticket_no} escalated`, d.reason, 'ticket', t.id);
  await notify(u.company_id, t.requester_id, 'ticket_escalated', `Ticket ${t.ticket_no} was escalated`, 'It has been raised with senior staff for faster attention.', 'ticket', t.id);
  await logAudit({ company_id: u.company_id, user_id: u.id, action: 'escalate', entity_type: 'ticket', entity_id: t.id, module: 'tickets', new_value: { reason: d.reason }, description: `${u.name} escalated ${t.ticket_no}: ${d.reason}` });
  res.json({ ok: true });
});
router.post('/:id/deescalate', async (req, res) => {
  const u = req.user!; if (!isAdmin(u)) throw forbidden('Only an admin can clear an escalation'); const t = await loadTicketFor(u, req.params.id); if (!t) throw notFound('Ticket not found');
  await query(`UPDATE tickets SET is_escalated=false, escalated_to=NULL, escalation_reason=NULL, updated_at=now() WHERE id=$1`, [t.id]);
  await logAudit({ company_id: u.company_id, user_id: u.id, action: 'deescalate', entity_type: 'ticket', entity_id: t.id, module: 'tickets', description: `${u.name} cleared the escalation on ${t.ticket_no}` });
  res.json({ ok: true });
});

// ---------------- bulk ----------------
router.post('/bulk', async (req, res) => {
  const u = req.user!; if (!isStaff(u)) throw forbidden('Only staff can run bulk updates');
  const d = parse(z.object({ ids: z.array(z.string().uuid()).min(1).max(100), action: z.enum(['assign', 'status', 'priority']), assignee_id: z.string().uuid().nullable().optional(), status: z.enum(STATUSES).optional(), priority: z.enum(PRIORITIES).optional(), note: z.string().max(2000).optional() }), req.body);
  if (d.action === 'assign' && d.assignee_id === undefined) throw bad('Choose who to assign to');
  if (d.action === 'status' && !d.status) throw bad('Choose a status'); if (d.action === 'priority' && !d.priority) throw bad('Choose a priority');
  const failed: { id: string; error: string }[] = []; let updated = 0;
  for (const id of d.ids) {
    try {
      const t = await loadTicketFor(u, id); if (!t) throw notFound('Ticket not found');
      if (d.action === 'assign') await assignTicket(u, id, d.assignee_id, undefined, d.note);
      else if (d.action === 'status') await changeStatus(u, id, d.status!, d.note);
      else await patchTicket(u, id, { priority: d.priority });
      updated++;
    } catch (e: any) { failed.push({ id, error: e.message }); }
  }
  res.json({ updated, failed });
});

export default router;
