import { query } from '../db/pool';

/** SLA targets come ONLY from configured policies: a category-specific policy wins over the generic priority policy. null = no policy configured. */
export async function slaTargets(companyId: string, priority: string, categoryId: string | null, createdAt: Date) {
  const rows = await query<any>(
    `SELECT first_response_minutes AS fr, resolution_minutes AS rs FROM sla_policies
     WHERE company_id=$1 AND priority=$2 AND is_active AND (category_id=$3 OR category_id IS NULL)
     ORDER BY (category_id IS NULL) ASC LIMIT 1`, [companyId, priority, categoryId]);
  if (!rows.length) return { first_response_due: null as Date | null, resolution_due: null as Date | null };
  const add = (m: number) => new Date(createdAt.getTime() + m * 60000);
  return { first_response_due: add(rows[0].fr), resolution_due: add(rows[0].rs) };
}

/** SQL fragments (alias t) so lists, dashboards and reports share ONE definition of "breached". */
export const RESOLVED_STATES = `('resolved','closed','cancelled')`;
export const SLA_RESOLUTION_BREACHED = `(t.resolution_due IS NOT NULL AND ((t.resolved_at IS NULL AND t.status NOT IN ${RESOLVED_STATES} AND now() > t.resolution_due) OR (t.resolved_at IS NOT NULL AND t.resolved_at > t.resolution_due)))`;
export const SLA_RESPONSE_BREACHED = `(t.first_response_due IS NOT NULL AND ((t.first_response_at IS NULL AND t.status NOT IN ${RESOLVED_STATES} AND now() > t.first_response_due) OR (t.first_response_at IS NOT NULL AND t.first_response_at > t.first_response_due)))`;
export const SLA_BREACHED = `(${SLA_RESOLUTION_BREACHED} OR ${SLA_RESPONSE_BREACHED})`;
export const OVERDUE = `(t.resolution_due IS NOT NULL AND t.resolved_at IS NULL AND t.status NOT IN ${RESOLVED_STATES} AND now() > t.resolution_due)`;
