/**
 * Access control helpers. Every restriction is applied INSIDE the SQL, never only in the UI.
 *   admin    : everything in the company
 *   hr       : tickets of HR-visible categories, tickets assigned to HR / their teams, their own tickets
 *   employee : the tickets they raised, tickets assigned to them, and tickets staff added them to as a watcher (read-only)
 */
import { AuthUser } from './auth';
import { query } from '../db/pool';

export const isAdmin = (u: AuthUser) => u.role === 'admin';
export const isStaff = (u: AuthUser) => u.role === 'admin' || u.role === 'hr';
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** SQL condition limiting tickets (alias `t.`) to what the user may see; '' = no restriction. Pushes its param onto `params`. */
export function ticketScope(u: AuthUser, params: any[], t = 't.'): string {
  if (u.role === 'admin') return '';
  params.push(u.id); const n = `$${params.length}`;
  const watching = `EXISTS (SELECT 1 FROM ticket_watchers w WHERE w.ticket_id=${t}id AND w.user_id=${n})`;   // staff add watchers; they get read-only access
  if (u.role === 'hr') return `(${t}requester_id=${n} OR ${t}assignee_id=${n} OR ${t}category_id IN (SELECT id FROM ticket_categories WHERE hr_visible) OR ${t}team_id IN (SELECT team_id FROM team_members WHERE user_id=${n}) OR ${watching})`;
  return `(${t}requester_id=${n} OR ${t}assignee_id=${n} OR ${watching})`;   // employees also see tickets assigned to them
}

/** SQL fragments about "me" for the Workspace / Favorites views. `me` is a placeholder such as $3. */
export const watchingSql = (me: string, t = 't.') => `EXISTS (SELECT 1 FROM ticket_watchers w WHERE w.ticket_id=${t}id AND w.user_id=${me})`;
export const favoriteSql = (me: string, t = 't.') => `EXISTS (SELECT 1 FROM ticket_favorites f WHERE f.ticket_id=${t}id AND f.user_id=${me})`;
export const commentedSql = (me: string, t = 't.') => `EXISTS (SELECT 1 FROM ticket_comments cm WHERE cm.ticket_id=${t}id AND cm.author_id=${me})`;
/** "Involved": raised it, is assigned, escalated to me, watching it, commented on it, or changed its status / assignment. */
export const involvedSql = (me: string, t = 't.') => `(${t}requester_id=${me} OR ${t}assignee_id=${me} OR ${t}escalated_to=${me} OR ${watchingSql(me, t)} OR ${commentedSql(me, t)}
  OR EXISTS (SELECT 1 FROM ticket_status_history h WHERE h.ticket_id=${t}id AND h.changed_by=${me})
  OR EXISTS (SELECT 1 FROM ticket_assignments a WHERE a.ticket_id=${t}id AND (a.changed_by=${me} OR a.to_assignee=${me})))`;
/** Which of my roles on the ticket (shown as chips in Workspace). */
export const involvementSql = (me: string, t = 't.') => `ARRAY_REMOVE(ARRAY[
  CASE WHEN ${t}requester_id=${me} THEN 'requester' END, CASE WHEN ${t}assignee_id=${me} THEN 'assignee' END, CASE WHEN ${t}escalated_to=${me} THEN 'escalated' END,
  CASE WHEN ${watchingSql(me, t)} THEN 'watching' END, CASE WHEN ${commentedSql(me, t)} THEN 'commented' END], NULL)`;

export async function loadTicketFor(u: AuthUser, id: string) {
  if (!UUID_RE.test(id)) return null;
  const params: any[] = [id, u.company_id]; const sc = ticketScope(u, params);
  return (await query<any>(`SELECT t.* FROM tickets t WHERE t.id=$1 AND t.company_id=$2 ${sc ? 'AND ' + sc : ''}`, params))[0] || null;
}

/** Task visibility: admin all; HR = mine + created by me + my teams' tasks; employee = assigned to me or created by me. */
export function taskScope(u: AuthUser, params: any[], t = 't.'): string {
  if (u.role === 'admin') return '';
  params.push(u.id); const n = `$${params.length}`;
  if (u.role === 'hr') return `(${t}assigned_to=${n} OR ${t}created_by=${n} OR ${t}team_id IN (SELECT team_id FROM team_members WHERE user_id=${n}) OR ${t}assigned_to IN (SELECT m2.user_id FROM team_members m1 JOIN team_members m2 ON m2.team_id=m1.team_id WHERE m1.user_id=${n}))`;
  return `(${t}assigned_to=${n} OR ${t}created_by=${n})`;
}
