import { query } from '../db/pool';
import { normRole } from './auth';
import { CallStore, Peer } from './callManager';

/** PostgreSQL implementation of the call store: authorisation lookups + call-history metadata (never any media or SDP). */
export class PgCallStore implements CallStore {
  async findDirectPeer(conversationId: string, callerId: string, companyId: string): Promise<Peer | null> {
    const r = (await query<any>(
      `SELECT u.id, u.name, u.is_active, ro.name AS role
       FROM conversations c
       JOIN conversation_members me ON me.conversation_id=c.id AND me.user_id=$2
       JOIN conversation_members om ON om.conversation_id=c.id AND om.user_id<>$2
       JOIN users u ON u.id=om.user_id
       JOIN company_users cu ON cu.user_id=u.id AND cu.company_id=$3
       JOIN roles ro ON ro.id=cu.role_id
       WHERE c.id=$1 AND c.type='direct' AND c.company_id=$3 LIMIT 1`, [conversationId, callerId, companyId]))[0];
    return r ? { id: r.id, name: r.name, role: normRole(r.role), is_active: !!r.is_active } : null;
  }
  async isActiveUser(userId: string, companyId: string) {
    return (await query(`SELECT 1 FROM users u JOIN company_users cu ON cu.user_id=u.id WHERE u.id=$1 AND cu.company_id=$2 AND u.is_active`, [userId, companyId])).length > 0;
  }
  async insertCall(c: Parameters<CallStore['insertCall']>[0]) {
    const final = c.status !== 'ringing';
    return (await query<any>(
      `INSERT INTO calls (company_id, conversation_id, caller_id, callee_id, call_type, status, end_reason, ended_at, duration_seconds)
       VALUES ($1,$2,$3,$4,$5,$6,$7,${final ? 'now()' : 'NULL'},${final ? '0' : 'NULL'}) RETURNING id`,
      [c.company_id, c.conversation_id, c.caller_id, c.callee_id, c.call_type, c.status, c.end_reason || null]))[0].id as string;
  }
  async markActive(id: string, at: Date) { await query(`UPDATE calls SET status='active', answered_at=$2 WHERE id=$1 AND status='ringing'`, [id, at]); }
  async markConnected(id: string, at: Date) { await query(`UPDATE calls SET connected_at=$2 WHERE id=$1 AND connected_at IS NULL`, [id, at]); }
  async finish(id: string, f: { status: string; end_reason: string; ended_at: Date; duration_seconds: number }) {
    await query(`UPDATE calls SET status=$2, end_reason=$3, ended_at=$4, duration_seconds=$5 WHERE id=$1 AND status IN ('ringing','active')`, [id, f.status, f.end_reason, f.ended_at, f.duration_seconds]);
  }
}

/** Calls cannot survive an API restart (their signalling state lived in memory), so anything still open is closed as failed. */
export async function failStaleCalls(): Promise<number> {
  const r = await query<any>(`UPDATE calls SET status='failed', end_reason='server_restart', ended_at=now(), duration_seconds=0 WHERE status IN ('ringing','active') RETURNING id`);
  return r.length;
}
