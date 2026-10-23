import { query } from '../db/pool';
import { sendEmail } from './email';

/**
 * In-app notification + (optional) email. Email is best-effort: SMTP missing or failing is logged in email_log and never breaks the request.
 * Users can switch in-app / email off in their profile (users.notif_prefs).
 */
export async function notify(companyId: string, userId: string | null | undefined, type: string, title: string, message?: string, entityType?: string, entityId?: string, opts: { email?: boolean } = {}) {
  if (!userId) return;
  const u = (await query<any>(`SELECT email, name, is_active, notif_prefs FROM users WHERE id=$1`, [userId]))[0];
  if (!u || !u.is_active) return;
  const prefs = u.notif_prefs || {};
  if (prefs.inapp !== false) {
    await query(`INSERT INTO notifications (company_id, user_id, type, title, message, entity_type, entity_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [companyId, userId, type, title, message || null, entityType || null, entityId || null]);
  }
  if (opts.email !== false && prefs.email !== false && process.env.SMTP_HOST) {
    void (async () => {   // fire and forget
      try {
        const r = await sendEmail({ to: u.email, subject: `[Barid-IN] ${title}`, text: `${message || title}\n\nOpen Barid-IN to view the details.` });
        await query(`INSERT INTO email_log (company_id, user_id, to_email, subject, status, error) VALUES ($1,$2,$3,$4,$5,$6)`, [companyId, userId, u.email, title, r.ok ? 'sent' : 'failed', r.error || null]);
      } catch (e: any) { console.error('email log failed', e?.message); }
    })();
  }
}

export async function notifyMany(companyId: string, userIds: (string | null | undefined)[], exceptId: string | null, type: string, title: string, message?: string, entityType?: string, entityId?: string) {
  const seen = new Set<string>();
  for (const id of userIds) if (id && id !== exceptId && !seen.has(id)) { seen.add(id); await notify(companyId, id, type, title, message, entityType, entityId); }
}

/** Every active admin (and optionally HR) except the actor. */
export async function staffIds(companyId: string, roles: string[]) {
  return (await query<any>(`SELECT u.id FROM company_users cu JOIN roles r ON r.id=cu.role_id JOIN users u ON u.id=cu.user_id WHERE cu.company_id=$1 AND r.name = ANY($2) AND u.is_active`, [companyId, roles])).map(r => r.id as string);
}
