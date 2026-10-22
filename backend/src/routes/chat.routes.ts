import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../db/pool';
import { requireAuth } from '../lib/auth';
import { isStaff, UUID_RE } from '../lib/access';
import { bad, forbidden, notFound, parse } from '../lib/http';

/** Chat between employees, HR and admins: direct messages, group chats (staff create them) and the company #general channel. Clients poll; unread counts come from last_read_at. */
const router = Router();
router.use(requireAuth);

async function memberOf(userId: string, convId: string) {
  if (!UUID_RE.test(convId)) throw notFound('Conversation not found');
  const c = (await query<any>(`SELECT c.* FROM conversations c JOIN conversation_members m ON m.conversation_id=c.id WHERE c.id=$1 AND m.user_id=$2`, [convId, userId]))[0];
  if (!c) throw notFound('Conversation not found'); return c;
}

router.get('/conversations', async (req, res) => {
  const u = req.user!;
  res.json({ data: await query(`
    SELECT c.id, c.type, c.name, c.created_at,
      CASE WHEN c.type='direct' THEN (SELECT ou.name FROM conversation_members om JOIN users ou ON ou.id=om.user_id WHERE om.conversation_id=c.id AND om.user_id<>$1 LIMIT 1) ELSE c.name END AS title,
      CASE WHEN c.type='direct' THEN (SELECT ou.id FROM conversation_members om JOIN users ou ON ou.id=om.user_id WHERE om.conversation_id=c.id AND om.user_id<>$1 LIMIT 1) END AS other_user_id,
      CASE WHEN c.type='direct' THEN (SELECT r.name FROM conversation_members om JOIN company_users cu ON cu.user_id=om.user_id JOIN roles r ON r.id=cu.role_id WHERE om.conversation_id=c.id AND om.user_id<>$1 LIMIT 1) END AS other_role,
      (SELECT COUNT(*)::int FROM conversation_members x WHERE x.conversation_id=c.id) AS member_count,
      lm.body AS last_body, lm.created_at AS last_at, lu.name AS last_sender,
      (SELECT COUNT(*)::int FROM messages m WHERE m.conversation_id=c.id AND m.created_at > me.last_read_at AND m.sender_id<>$1) AS unread
    FROM conversations c JOIN conversation_members me ON me.conversation_id=c.id AND me.user_id=$1
    LEFT JOIN LATERAL (SELECT body, created_at, sender_id FROM messages m WHERE m.conversation_id=c.id ORDER BY created_at DESC LIMIT 1) lm ON true LEFT JOIN users lu ON lu.id=lm.sender_id
    WHERE c.company_id=$2 ORDER BY COALESCE(lm.created_at, c.created_at) DESC`, [u.id, u.company_id]) });
});
router.get('/unread', async (req, res) => {
  res.json({ unread: (await query<any>(`SELECT COUNT(*)::int n FROM messages m JOIN conversation_members me ON me.conversation_id=m.conversation_id AND me.user_id=$1 WHERE m.created_at > me.last_read_at AND m.sender_id<>$1`, [req.user!.id]))[0].n });
});

router.post('/conversations', async (req, res) => {
  const u = req.user!; const cid = u.company_id;
  const d = parse(z.object({ type: z.enum(['direct', 'group']), user_id: z.string().uuid().optional(), user_ids: z.array(z.string().uuid()).max(100).optional(), name: z.string().trim().min(2).max(80).optional() }), req.body);
  const activeUser = async (id: string) => (await query(`SELECT 1 FROM users x JOIN company_users cu ON cu.user_id=x.id WHERE x.id=$1 AND cu.company_id=$2 AND x.is_active`, [id, cid])).length > 0;
  if (d.type === 'direct') {
    if (!d.user_id || d.user_id === u.id) throw bad('Choose someone to message'); if (!(await activeUser(d.user_id))) throw notFound('User not found');
    const key = [u.id, d.user_id].sort().join(':');
    let conv = (await query<any>(`SELECT id FROM conversations WHERE direct_key=$1`, [key]))[0];
    if (!conv) conv = await withTransaction(async c => {
      const r = (await c.query(`INSERT INTO conversations (company_id, type, direct_key, created_by) VALUES ($1,'direct',$2,$3) ON CONFLICT (direct_key) DO UPDATE SET direct_key=EXCLUDED.direct_key RETURNING id`, [cid, key, u.id])).rows[0];
      for (const id of [u.id, d.user_id]) await c.query(`INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [r.id, id]); return r;
    });
    return res.json({ id: conv.id });
  }
  if (!isStaff(u)) throw forbidden('Only HR and admins can create group chats'); if (!d.name) throw bad('Name the group');
  const ids = [...new Set([u.id, ...(d.user_ids || [])])]; for (const id of ids) if (!(await activeUser(id))) throw bad('One of the members was not found');
  const conv = await withTransaction(async c => { const r = (await c.query(`INSERT INTO conversations (company_id, type, name, created_by) VALUES ($1,'group',$2,$3) RETURNING id`, [cid, d.name, u.id])).rows[0]; for (const id of ids) await c.query(`INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1,$2)`, [r.id, id]); return r; });
  res.status(201).json({ id: conv.id });
});

router.get('/conversations/:id', async (req, res) => {
  const c = await memberOf(req.user!.id, req.params.id);
  res.json({ ...c, members: await query(`SELECT u.id, u.name, r.name AS role FROM conversation_members m JOIN users u ON u.id=m.user_id JOIN company_users cu ON cu.user_id=u.id JOIN roles r ON r.id=cu.role_id WHERE m.conversation_id=$1 ORDER BY u.name`, [c.id]) });
});
router.post('/conversations/:id/members', async (req, res) => {
  const u = req.user!; const c = await memberOf(u.id, req.params.id); if (c.type === 'direct' || !isStaff(u)) throw forbidden('Only HR and admins can add people to a group');
  const d = parse(z.object({ user_ids: z.array(z.string().uuid()).min(1).max(100) }), req.body);
  for (const id of d.user_ids) await query(`INSERT INTO conversation_members (conversation_id, user_id) SELECT $1, x.id FROM users x JOIN company_users cu ON cu.user_id=x.id WHERE x.id=$2 AND cu.company_id=$3 AND x.is_active ON CONFLICT DO NOTHING`, [c.id, id, u.company_id]);
  res.json({ ok: true });
});

router.get('/conversations/:id/messages', async (req, res) => {
  const u = req.user!; const c = await memberOf(u.id, req.params.id);
  const after = req.query.after ? new Date(String(req.query.after)) : null; if (after && isNaN(after.getTime())) throw bad('Invalid time');
  const rows = await query(`SELECT * FROM (SELECT m.id, m.body, m.created_at, m.sender_id, s.name AS sender_name, (SELECT r.name FROM company_users cu JOIN roles r ON r.id=cu.role_id WHERE cu.user_id=s.id LIMIT 1) AS sender_role
    FROM messages m JOIN users s ON s.id=m.sender_id WHERE m.conversation_id=$1 ${after ? 'AND m.created_at >= $2' : ''} ORDER BY m.created_at DESC LIMIT 200) x ORDER BY created_at ASC`, after ? [c.id, after] : [c.id]);
  await query(`UPDATE conversation_members SET last_read_at=now() WHERE conversation_id=$1 AND user_id=$2`, [c.id, u.id]);
  res.json({ data: rows });
});
router.post('/conversations/:id/messages', async (req, res) => {
  const u = req.user!; const c = await memberOf(u.id, req.params.id); const d = parse(z.object({ body: z.string().trim().min(1).max(4000) }), req.body);
  const m = (await query<any>(`INSERT INTO messages (conversation_id, sender_id, body) VALUES ($1,$2,$3) RETURNING id, body, created_at, sender_id`, [c.id, u.id, d.body]))[0];
  await query(`UPDATE conversation_members SET last_read_at=now() WHERE conversation_id=$1 AND user_id=$2`, [c.id, u.id]);
  res.status(201).json({ ...m, sender_name: u.name, sender_role: u.role });
});
export default router;
