import { Router } from 'express';
import { query } from '../db/pool';
import { requireAuth, normRole } from '../lib/auth';
import { UUID_RE } from '../lib/access';
import { bad } from '../lib/http';
import { getCallManager } from '../lib/callSocket';
import { iceServersFor, turnConfigured } from '../lib/webrtcConfig';
import { DEFAULT_OPTIONS } from '../lib/callManager';

/** Call set-up for the signed-in user. Signalling itself runs over the authenticated Socket.IO connection (lib/callSocket.ts). */
const router = Router();
router.use(requireAuth);

/** ICE servers (STUN + optional TURN) and timing. Credentials are minted per request, so they are never part of the frontend bundle. */
router.get('/config', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const o = getCallManager()?.options || DEFAULT_OPTIONS;
  res.json({ ice_servers: iceServersFor(req.user!.id), turn_configured: turnConfigured(), ring_timeout_ms: o.ringTimeoutMs, reconnect_grace_ms: o.reconnectGraceMs });
});

/** My finished calls (as caller or callee), newest first. Optional ?with=<userId> and ?before=<ISO time> for paging. */
router.get('/history', async (req, res) => {
  const u = req.user!; const params: any[] = [u.id, u.company_id]; let extra = '';
  if (req.query.with) { const w = String(req.query.with); if (!UUID_RE.test(w)) throw bad('Invalid user'); params.push(w); extra += ` AND (c.caller_id=$${params.length} OR c.callee_id=$${params.length})`; }
  if (req.query.before) { const b = new Date(String(req.query.before)); if (isNaN(b.getTime())) throw bad('Invalid time'); params.push(b); extra += ` AND c.started_at < $${params.length}`; }
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '30'), 10) || 30)); params.push(limit);
  const rows = await query<any>(
    `SELECT c.id, c.conversation_id, c.call_type, c.status, c.end_reason, c.started_at, c.answered_at, c.ended_at, c.duration_seconds,
       CASE WHEN c.caller_id=$1 THEN 'outgoing' ELSE 'incoming' END AS direction,
       ou.id AS other_user_id, ou.name AS other_name,
       (SELECT r.name FROM company_users cu JOIN roles r ON r.id=cu.role_id WHERE cu.user_id=ou.id LIMIT 1) AS other_role
     FROM calls c JOIN users ou ON ou.id = CASE WHEN c.caller_id=$1 THEN c.callee_id ELSE c.caller_id END
     WHERE c.company_id=$2 AND (c.caller_id=$1 OR c.callee_id=$1) AND c.status NOT IN ('ringing','active')${extra}
     ORDER BY c.started_at DESC LIMIT $${params.length}`, params);
  res.json({ data: rows.map(r => ({ ...r, other_role: normRole(r.other_role || '') })) });
});

export default router;
