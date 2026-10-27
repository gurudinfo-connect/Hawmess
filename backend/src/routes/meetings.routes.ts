import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { PoolClient } from 'pg';
import { pool, query, withTransaction } from '../db/pool';
import { requireAuth, logAudit } from '../lib/auth';
import { bad, forbidden, notFound, parse } from '../lib/http';
import { UUID_RE } from '../lib/access';
import { notify } from '../lib/notify';

/**
 * Schedule calendar. Any signed-in user (admin, HR, employee) can schedule a meeting and invite people.
 * Visibility: organizer + invitees + people who saved it; "public" meetings are visible to the whole company; admin sees everything except other people's personal entries.
 * Every attendee row is that person's saved schedule entry and carries their own response and alert.
 */
let schemaReady: Promise<void> | null = null;
export const ensureMeetingSchema = () => (schemaReady ??= (async () => {
  const chk = (await query<any>(`SELECT to_regclass('public.meetings') IS NOT NULL AS m, to_regclass('public.meeting_attendees') IS NOT NULL AS a`))[0];
  if (chk.m && chk.a) return;
  await withTransaction(async client => {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())`);
    await client.query(fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', '026_meetings.sql'), 'utf-8'));
    await client.query(`INSERT INTO schema_migrations(name) VALUES ('026_meetings.sql') ON CONFLICT DO NOTHING`);
  });
  console.log('meetings: applied pending database migration 026_meetings.sql');
})().catch(e => { schemaReady = null; console.error('meetings: database check/repair failed -', e?.message || e); throw e; }));

const router = Router();
router.use((_rq, _rs, next) => { ensureMeetingSchema().then(() => next(), next); });
router.use(requireAuth);
router.param('id', (_req, _res, next, id) => (UUID_RE.test(id) ? next() : next(notFound('Meeting not found'))));

export const KINDS = ['meeting', 'interview', 'review', 'training', 'call', 'personal', 'other'] as const;
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 14:30');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-27').refine(d => !Number.isNaN(Date.parse(d + 'T00:00:00Z')) && new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) === d, 'That date does not exist');
const text = (max: number) => z.string().trim().max(max).optional().nullable().transform(v => (v ? v : null));
const meetingSchema = z.object({
  title: z.string().trim().min(1, 'Enter a title for the meeting').max(160),
  description: text(4000), kind: z.enum(KINDS).default('meeting'),
  meeting_date: isoDate, start_time: hhmm, end_time: hhmm, location: text(200),
  meeting_link: text(500).refine(v => !v || /^https?:\/\/\S+$/i.test(v), 'The meeting link must start with http:// or https://'),
  is_public: z.boolean().default(false),
  attendee_ids: z.array(z.string().regex(UUID_RE, 'Invalid person')).max(200).default([]),
  alert_minutes: z.number().int().min(0).max(10080).nullable().default(15),
}).refine(v => v.end_time > v.start_time, { message: 'The end time must be after the start time', path: ['end_time'] });
type MeetingInput = z.infer<typeof meetingSchema>;

const TS_START = `((m.meeting_date + m.start_time) AT TIME ZONE m.timezone)`, TS_END = `((m.meeting_date + m.end_time) AT TIME ZONE m.timezone)`;
const FMT = `m.id, m.title, m.description, m.kind, m.meeting_date::text AS meeting_date, to_char(m.start_time,'HH24:MI') AS start_time, to_char(m.end_time,'HH24:MI') AS end_time, m.timezone, m.location, m.meeting_link, m.is_public, m.status, m.organizer_id, o.name AS organizer_name`;
const ME = `me.role AS my_role, me.response AS my_response, me.alert_minutes AS my_alert_minutes, (me.user_id IS NOT NULL) AS in_my_schedule`;
const FROM = `FROM meetings m JOIN users o ON o.id=m.organizer_id LEFT JOIN meeting_attendees me ON me.meeting_id=m.id AND me.user_id=$2`;
/** Visibility rule, $1 = company, $2 = me. */
const visible = (role: string) => role === 'admin' ? `(m.kind <> 'personal' OR me.user_id IS NOT NULL OR m.organizer_id=$2)` : `(m.organizer_id=$2 OR m.is_public OR me.user_id IS NOT NULL)`;

async function attach(rows: any[]) {
  if (!rows.length) return rows;
  const at = await query<any>(`SELECT a.meeting_id, a.user_id, u.name, a.role, a.response FROM meeting_attendees a JOIN users u ON u.id=a.user_id WHERE a.meeting_id = ANY($1::uuid[]) ORDER BY (a.role='organizer') DESC, u.name`, [rows.map(r => r.id)]);
  const by = new Map<string, any[]>(); for (const a of at) { (by.get(a.meeting_id) || by.set(a.meeting_id, []).get(a.meeting_id)!).push({ user_id: a.user_id, name: a.name, role: a.role, response: a.response }); }
  return rows.map(r => ({ ...r, attendees: by.get(r.id) || [] }));
}
const load = async (id: string, u: { id: string; company_id: string; role: string }) =>
  (await attach(await query<any>(`SELECT ${FMT}, ${ME} ${FROM} WHERE m.id=$3 AND m.company_id=$1 AND ${visible(u.role)}`, [u.company_id, u.id, id])))[0] || null;
const canManage = (m: any, u: { id: string; role: string }) => m.organizer_id === u.id || u.role === 'admin';
const whenText = (m: { meeting_date: string; start_time: string; end_time: string; location?: string | null }) => `${m.meeting_date} ${m.start_time}-${m.end_time}${m.location ? ` · ${m.location}` : ''}`;

/** People (active, same company) that exist from a list of ids. */
async function validPeople(client: { query: (q: string, p?: any[]) => Promise<any> }, companyId: string, ids: string[]): Promise<string[]> {
  if (!ids.length) return [] as string[];
  const r = await client.query(`SELECT u.id FROM users u JOIN company_users cu ON cu.user_id=u.id WHERE cu.company_id=$1 AND u.is_active AND u.id = ANY($2::uuid[])`, [companyId, ids]);
  return r.rows.map((x: any) => x.id as string);
}
/** People who already have something that overlaps the slot - a warning only, never a block. */
async function conflictsFor(companyId: string, userIds: string[], v: { meeting_date: string; start_time: string; end_time: string }, exclude?: string) {
  if (!userIds.length) return [];
  return query<any>(`SELECT u.name AS person, m.title, to_char(m.start_time,'HH24:MI') AS start_time, to_char(m.end_time,'HH24:MI') AS end_time
    FROM meeting_attendees a JOIN meetings m ON m.id=a.meeting_id JOIN users u ON u.id=a.user_id
    WHERE a.user_id = ANY($1::uuid[]) AND m.company_id=$2 AND m.status='scheduled' AND a.response <> 'declined' AND m.meeting_date=$3 AND m.start_time < $5::time AND m.end_time > $4::time AND ($6::uuid IS NULL OR m.id <> $6::uuid)
    ORDER BY m.start_time LIMIT 20`, [userIds, companyId, v.meeting_date, v.start_time, v.end_time, exclude || null]);
}

// ------------------------------------------------------------------ calendar data
/** GET /meetings?from=&to=&scope=mine|all  - meetings between two dates (max 400 days). `mine` = my saved schedule, `all` = everything I may see. */
router.get('/', async (rq, rs) => {
  const u = rq.user!; const from = String(rq.query.from || ''), to = String(rq.query.to || '');
  if (!isoDate.safeParse(from).success || !isoDate.safeParse(to).success) throw bad('Choose a valid date range');
  if (to < from || (Date.parse(to) - Date.parse(from)) / 86400000 > 400) throw bad('The date range is too large');
  const mine = rq.query.scope !== 'all';
  const rows = await query<any>(`SELECT ${FMT}, ${ME}, (SELECT COUNT(*)::int FROM meeting_attendees x WHERE x.meeting_id=m.id) AS attendee_count ${FROM}
    WHERE m.company_id=$1 AND m.meeting_date BETWEEN $3::date AND $4::date AND ${visible(u.role)} ${mine ? 'AND me.user_id IS NOT NULL' : ''} ORDER BY m.meeting_date, m.start_time LIMIT 1500`, [u.company_id, u.id, from, to]);
  rs.json({ data: await attach(rows) });
});

/** My upcoming saved schedule (agenda). `past=1` lists earlier ones instead. */
router.get('/agenda', async (rq, rs) => {
  const u = rq.user!; const past = rq.query.past === '1';
  const rows = await query<any>(`SELECT ${FMT}, ${ME}, (SELECT COUNT(*)::int FROM meeting_attendees x WHERE x.meeting_id=m.id) AS attendee_count ${FROM}
    WHERE m.company_id=$1 AND me.user_id IS NOT NULL AND ${past ? `${TS_END} < now()` : `${TS_END} >= now()`} ORDER BY ${past ? `${TS_START} DESC` : TS_START} LIMIT 200`, [u.company_id, u.id]);
  rs.json({ data: await attach(rows) });
});

/** One poll for the app shell: today's count, the next meeting and every alert that is due right now. */
router.get('/summary', async (rq, rs) => {
  const u = rq.user!;
  const today = (await query<any>(`SELECT COUNT(*)::int n FROM meetings m JOIN meeting_attendees a ON a.meeting_id=m.id AND a.user_id=$2 WHERE m.company_id=$1 AND m.status='scheduled' AND a.response <> 'declined' AND m.meeting_date = (now() AT TIME ZONE m.timezone)::date`, [u.company_id, u.id]))[0].n;
  const next = (await query<any>(`SELECT ${FMT}, ${ME} ${FROM} WHERE m.company_id=$1 AND me.user_id IS NOT NULL AND m.status='scheduled' AND me.response <> 'declined' AND ${TS_END} >= now() ORDER BY ${TS_START} LIMIT 1`, [u.company_id, u.id]))[0] || null;
  const alerts = await query<any>(`SELECT ${FMT}, ${ME}, ROUND(EXTRACT(EPOCH FROM (${TS_START} - now()))/60)::int AS minutes_to_start ${FROM}
    WHERE m.company_id=$1 AND me.user_id IS NOT NULL AND m.status='scheduled' AND me.response <> 'declined' AND me.alert_minutes IS NOT NULL AND me.dismissed_at IS NULL
      AND now() >= COALESCE(me.snoozed_until, ${TS_START} - make_interval(mins => me.alert_minutes)) AND now() < ${TS_END} ORDER BY ${TS_START}`, [u.company_id, u.id]);
  rs.json({ today, next, alerts });
});

/** Live clash check while the form is filled in. */
router.post('/conflicts', async (rq, rs) => {
  const u = rq.user!; const b = parse(z.object({ meeting_date: isoDate, start_time: hhmm, end_time: hhmm, attendee_ids: z.array(z.string().regex(UUID_RE)).max(200).default([]), exclude: z.string().regex(UUID_RE).optional() }), rq.body);
  if (b.end_time <= b.start_time) return rs.json({ data: [] });
  const ids = await validPeople(pool, u.company_id, [...new Set([u.id, ...b.attendee_ids])]);
  rs.json({ data: await conflictsFor(u.company_id, ids, b, b.exclude) });
});

// ------------------------------------------------------------------ create / read / update / cancel / delete
async function writeAttendees(client: PoolClient, id: string, organizerId: string, invitees: string[], alert: number | null) {
  await client.query(`INSERT INTO meeting_attendees (meeting_id, user_id, role, response, alert_minutes) VALUES ($1,$2,'organizer','accepted',$3) ON CONFLICT (meeting_id, user_id) DO NOTHING`, [id, organizerId, alert]);
  for (const uid of invitees) await client.query(`INSERT INTO meeting_attendees (meeting_id, user_id, role, response, alert_minutes) VALUES ($1,$2,'invitee','pending',$3) ON CONFLICT (meeting_id, user_id) DO NOTHING`, [id, uid, alert]);
}

router.post('/', async (rq, rs) => {
  const u = rq.user!; const v: MeetingInput = parse(meetingSchema, rq.body);
  const invitees = (await validPeople(pool, u.company_id, [...new Set(v.attendee_ids)])).filter(x => x !== u.id);
  if (v.attendee_ids.filter(x => x !== u.id).length !== invitees.length) throw bad('One of the selected people is not an active user');
  const conflicts = await conflictsFor(u.company_id, [u.id, ...invitees], v);
  const id = await withTransaction(async client => {
    const m = (await client.query(`INSERT INTO meetings (company_id, title, description, kind, meeting_date, start_time, end_time, location, meeting_link, is_public, organizer_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`, [u.company_id, v.title, v.description, v.kind, v.meeting_date, v.start_time, v.end_time, v.location, v.meeting_link, v.kind === 'personal' ? false : v.is_public, u.id])).rows[0];
    await writeAttendees(client, m.id, u.id, v.kind === 'personal' ? [] : invitees, v.alert_minutes); return m.id as string;
  });
  const m = await load(id, u);
  for (const uid of v.kind === 'personal' ? [] : invitees) await notify(u.company_id, uid, 'meeting_invite', `Meeting scheduled: ${v.title}`, `${u.name} invited you · ${whenText(m)}`, 'meeting', id);
  await logAudit({ company_id: u.company_id, user_id: u.id, action: 'create', entity_type: 'meeting', entity_id: id, module: 'schedule', description: `${u.role} scheduled "${v.title}" on ${v.meeting_date}` });
  rs.status(201).json({ ...m, conflicts });
});

router.get('/:id', async (rq, rs) => { const m = await load(rq.params.id, rq.user!); if (!m) throw notFound('Meeting not found'); rs.json(m); });

router.put('/:id', async (rq, rs) => {
  const u = rq.user!; const cur = await load(rq.params.id, u); if (!cur) throw notFound('Meeting not found'); if (!canManage(cur, u)) throw forbidden('Only the organizer or an administrator can change this meeting');
  const v: MeetingInput = parse(meetingSchema, rq.body);
  const invitees = (await validPeople(pool, u.company_id, [...new Set(v.attendee_ids)])).filter(x => x !== cur.organizer_id);
  const conflicts = await conflictsFor(u.company_id, [cur.organizer_id, ...invitees], v, cur.id);
  const moved = cur.meeting_date !== v.meeting_date || cur.start_time !== v.start_time || cur.end_time !== v.end_time; const changed = moved || cur.location !== v.location || cur.meeting_link !== v.meeting_link || cur.title !== v.title;
  const existing = new Set<string>(cur.attendees.map((a: any) => a.user_id)); const added = invitees.filter(x => !existing.has(x));
  await withTransaction(async client => {
    await client.query(`UPDATE meetings SET title=$2, description=$3, kind=$4, meeting_date=$5, start_time=$6, end_time=$7, location=$8, meeting_link=$9, is_public=$10, updated_at=now() WHERE id=$1`,
      [cur.id, v.title, v.description, v.kind, v.meeting_date, v.start_time, v.end_time, v.location, v.meeting_link, v.kind === 'personal' ? false : v.is_public]);
    await client.query(`DELETE FROM meeting_attendees WHERE meeting_id=$1 AND role='invitee' AND NOT (user_id = ANY($2::uuid[]))`, [cur.id, invitees]);   // people who saved it themselves stay
    for (const uid of added) await client.query(`INSERT INTO meeting_attendees (meeting_id, user_id, role, response, alert_minutes) VALUES ($1,$2,'invitee','pending',$3) ON CONFLICT DO NOTHING`, [cur.id, uid, v.alert_minutes]);
    if (moved) await client.query(`UPDATE meeting_attendees SET alert_notified_at=NULL, dismissed_at=NULL, snoozed_until=NULL, response=CASE WHEN role='invitee' THEN 'pending' ELSE response END WHERE meeting_id=$1`, [cur.id]);   // new time -> alerts fire again, invitees re-confirm
  });
  const m = await load(cur.id, u);
  for (const uid of added) await notify(u.company_id, uid, 'meeting_invite', `Meeting scheduled: ${v.title}`, `${u.name} invited you · ${whenText(m)}`, 'meeting', cur.id);
  if (changed) for (const a of m.attendees) if (a.user_id !== u.id && !added.includes(a.user_id)) await notify(u.company_id, a.user_id, 'meeting_update', `${moved ? 'Meeting rescheduled' : 'Meeting updated'}: ${v.title}`, whenText(m), 'meeting', cur.id);
  await logAudit({ company_id: u.company_id, user_id: u.id, action: moved ? 'reschedule' : 'update', entity_type: 'meeting', entity_id: cur.id, module: 'schedule', description: `${u.role} ${moved ? 'rescheduled' : 'updated'} "${v.title}"` });
  rs.json({ ...m, conflicts });
});

router.post('/:id/cancel', async (rq, rs) => {
  const u = rq.user!; const cur = await load(rq.params.id, u); if (!cur) throw notFound('Meeting not found'); if (!canManage(cur, u)) throw forbidden('Only the organizer or an administrator can cancel this meeting');
  await query(`UPDATE meetings SET status='cancelled', updated_at=now() WHERE id=$1`, [cur.id]);
  for (const a of cur.attendees) if (a.user_id !== u.id) await notify(u.company_id, a.user_id, 'meeting_cancelled', `Meeting cancelled: ${cur.title}`, whenText(cur), 'meeting', cur.id);
  await logAudit({ company_id: u.company_id, user_id: u.id, action: 'cancel', entity_type: 'meeting', entity_id: cur.id, module: 'schedule', description: `${u.role} cancelled "${cur.title}"` });
  rs.json(await load(cur.id, u));
});
router.post('/:id/restore', async (rq, rs) => {
  const u = rq.user!; const cur = await load(rq.params.id, u); if (!cur) throw notFound('Meeting not found'); if (!canManage(cur, u)) throw forbidden('Only the organizer or an administrator can change this meeting');
  await query(`UPDATE meetings SET status='scheduled', updated_at=now() WHERE id=$1`, [cur.id]);
  await query(`UPDATE meeting_attendees SET alert_notified_at=NULL, dismissed_at=NULL, snoozed_until=NULL WHERE meeting_id=$1`, [cur.id]);
  for (const a of cur.attendees) if (a.user_id !== u.id) await notify(u.company_id, a.user_id, 'meeting_update', `Meeting back on: ${cur.title}`, whenText(cur), 'meeting', cur.id);
  rs.json(await load(cur.id, u));
});
router.delete('/:id', async (rq, rs) => {
  const u = rq.user!; const cur = await load(rq.params.id, u); if (!cur) throw notFound('Meeting not found'); if (!canManage(cur, u)) throw forbidden('Only the organizer or an administrator can delete this meeting');
  await query(`DELETE FROM meetings WHERE id=$1`, [cur.id]);
  if (cur.status === 'scheduled') for (const a of cur.attendees) if (a.user_id !== u.id) await notify(u.company_id, a.user_id, 'meeting_cancelled', `Meeting removed: ${cur.title}`, whenText(cur));
  await logAudit({ company_id: u.company_id, user_id: u.id, action: 'delete', entity_type: 'meeting', entity_id: cur.id, module: 'schedule', description: `${u.role} deleted "${cur.title}"` });
  rs.json({ ok: true });
});

// ------------------------------------------------------------------ my saved schedule + alerts
const alertSchema = z.number().int().min(0).max(10080).nullable();
/** Save a meeting (for example a company-wide one) to my own schedule, with my own alert. */
router.post('/:id/save', async (rq, rs) => {
  const u = rq.user!; const m = await load(rq.params.id, u); if (!m) throw notFound('Meeting not found');
  const alert = parse(z.object({ alert_minutes: alertSchema.optional() }), rq.body || {}).alert_minutes;
  await query(`INSERT INTO meeting_attendees (meeting_id, user_id, role, response, alert_minutes) VALUES ($1,$2,'saved','accepted',$3) ON CONFLICT (meeting_id, user_id) DO NOTHING`, [m.id, u.id, alert === undefined ? 15 : alert]);
  rs.json(await load(m.id, u));
});
router.delete('/:id/save', async (rq, rs) => {
  const u = rq.user!; const m = await load(rq.params.id, u); if (!m) throw notFound('Meeting not found'); if (m.organizer_id === u.id) throw bad('You organize this meeting - cancel or delete it instead');
  await query(`DELETE FROM meeting_attendees WHERE meeting_id=$1 AND user_id=$2`, [m.id, u.id]); rs.json({ ok: true });
});
/** My response (accept / decline / maybe) and my own alert time. */
router.patch('/:id/me', async (rq, rs) => {
  const u = rq.user!; const m = await load(rq.params.id, u); if (!m || !m.in_my_schedule) throw notFound('This meeting is not in your schedule');
  const b = parse(z.object({ response: z.enum(['accepted', 'declined', 'tentative']).optional(), alert_minutes: alertSchema.optional() }), rq.body || {});
  if (b.response !== undefined) await query(`UPDATE meeting_attendees SET response=$3 WHERE meeting_id=$1 AND user_id=$2`, [m.id, u.id, b.response]);
  if (b.alert_minutes !== undefined) await query(`UPDATE meeting_attendees SET alert_minutes=$3, alert_notified_at=NULL, dismissed_at=NULL, snoozed_until=NULL WHERE meeting_id=$1 AND user_id=$2`, [m.id, u.id, b.alert_minutes]);
  if (b.response && b.response !== m.my_response && m.organizer_id !== u.id) await notify(u.company_id, m.organizer_id, 'meeting_response', `${u.name} ${b.response === 'accepted' ? 'accepted' : b.response === 'declined' ? 'declined' : 'may attend'}: ${m.title}`, whenText(m), 'meeting', m.id);
  rs.json(await load(m.id, u));
});
router.post('/:id/alerts/dismiss', async (rq, rs) => { await query(`UPDATE meeting_attendees SET dismissed_at=now() WHERE meeting_id=$1 AND user_id=$2`, [rq.params.id, rq.user!.id]); rs.json({ ok: true }); });
router.post('/:id/alerts/snooze', async (rq, rs) => {
  const b = parse(z.object({ minutes: z.number().int().min(1).max(120).default(5) }), rq.body || {});
  await query(`UPDATE meeting_attendees SET snoozed_until = now() + make_interval(mins => $3), dismissed_at=NULL WHERE meeting_id=$1 AND user_id=$2`, [rq.params.id, rq.user!.id, b.minutes]); rs.json({ ok: true });
});

export default router;
