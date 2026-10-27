import { query } from '../db/pool';
import { notify } from './notify';
import { ensureMeetingSchema } from '../routes/meetings.routes';

/** Task deadline reminders: tasks due today/tomorrow (or overdue) → one reminder per task per day. Runs on a timer; safe to run repeatedly. */
export async function runReminders() {
  const due = await query<any>(`SELECT t.id, t.company_id, t.assigned_to, t.title, t.due_date::text AS due_date, (t.due_date < CURRENT_DATE) AS overdue FROM tasks t JOIN users u ON u.id=t.assigned_to
    WHERE t.status IN ('pending','in_progress') AND t.due_date <= CURRENT_DATE + 1 AND u.is_active AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.entity_id=t.id AND n.type='task_due' AND n.user_id=t.assigned_to AND n.created_at::date=CURRENT_DATE)`);
  for (const t of due) await notify(t.company_id, t.assigned_to, 'task_due', t.overdue ? `Overdue task: ${t.title}` : `Task due ${t.due_date}`, t.overdue ? `This task was due on ${t.due_date}` : t.title, 'task', t.id);
  return due.length;
}
/** Meeting alerts: when a person's alert time (start - alert_minutes) is reached, send ONE bell notification (+ e-mail if SMTP is set). The row is claimed atomically, so two API instances never double-send. */
export async function runMeetingReminders() {
  await ensureMeetingSchema();
  const due = await query<any>(`SELECT a.meeting_id, a.user_id, m.company_id, m.title, m.meeting_date::text AS d, to_char(m.start_time,'HH24:MI') AS st, m.location
    FROM meeting_attendees a JOIN meetings m ON m.id=a.meeting_id JOIN users u ON u.id=a.user_id
    WHERE m.status='scheduled' AND a.response <> 'declined' AND a.alert_minutes IS NOT NULL AND a.alert_notified_at IS NULL AND u.is_active
      AND now() >= ((m.meeting_date + m.start_time) AT TIME ZONE m.timezone) - make_interval(mins => a.alert_minutes) AND now() < ((m.meeting_date + m.end_time) AT TIME ZONE m.timezone) LIMIT 500`);
  let sent = 0;
  for (const r of due) {
    const claimed = await query(`UPDATE meeting_attendees SET alert_notified_at=now() WHERE meeting_id=$1 AND user_id=$2 AND alert_notified_at IS NULL RETURNING 1`, [r.meeting_id, r.user_id]);
    if (!claimed.length) continue; sent++;
    await notify(r.company_id, r.user_id, 'meeting_alert', `Meeting alert: ${r.title}`, `Starts ${r.d} at ${r.st}${r.location ? ` · ${r.location}` : ''}`, 'meeting', r.meeting_id);
  }
  return sent;
}
export function startReminders() {
  const meet = () => runMeetingReminders().catch(e => console.error('meeting reminders failed', e?.message));
  setTimeout(meet, 20_000); setInterval(meet, 60_000).unref();
  const run = () => runReminders().catch(e => console.error('reminders failed', e?.message));
  setTimeout(run, 15_000); setInterval(run, 30 * 60_000).unref();
}
