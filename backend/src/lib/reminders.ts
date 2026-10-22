import { query } from '../db/pool';
import { notify } from './notify';

/** Task deadline reminders: tasks due today/tomorrow (or overdue) → one reminder per task per day. Runs on a timer; safe to run repeatedly. */
export async function runReminders() {
  const due = await query<any>(`SELECT t.id, t.company_id, t.assigned_to, t.title, t.due_date::text AS due_date, (t.due_date < CURRENT_DATE) AS overdue FROM tasks t JOIN users u ON u.id=t.assigned_to
    WHERE t.status IN ('pending','in_progress') AND t.due_date <= CURRENT_DATE + 1 AND u.is_active AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.entity_id=t.id AND n.type='task_due' AND n.user_id=t.assigned_to AND n.created_at::date=CURRENT_DATE)`);
  for (const t of due) await notify(t.company_id, t.assigned_to, 'task_due', t.overdue ? `Overdue task: ${t.title}` : `Task due ${t.due_date}`, t.overdue ? `This task was due on ${t.due_date}` : t.title, 'task', t.id);
  return due.length;
}
export function startReminders() {
  const run = () => runReminders().catch(e => console.error('reminders failed', e?.message));
  setTimeout(run, 15_000); setInterval(run, 30 * 60_000).unref();
}
