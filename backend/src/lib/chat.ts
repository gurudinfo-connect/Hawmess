import { query } from '../db/pool';
/** Every user belongs to the company-wide #general channel. */
export async function joinDefaultChannels(companyId: string, userId: string) {
  const ch = (await query<any>(`SELECT id FROM conversations WHERE company_id=$1 AND type='channel' AND direct_key='channel:general'`, [companyId]))[0];
  if (ch) await query(`INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [ch.id, userId]);
}
