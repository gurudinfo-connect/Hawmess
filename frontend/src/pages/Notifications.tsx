import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ago, baseFor, roleOf } from '../api';
import { Empty, Ic, PageHead, Pager, Skeleton } from '../ui';

const ICON: Record<string, string> = { meeting_invite: 'calendar', meeting_update: 'calendar', meeting_cancelled: 'calendar', meeting_response: 'calendar', meeting_alert: 'bell', ticket_created: 'ticket', ticket_assigned: 'userplus', ticket_assignment: 'userplus', ticket_status: 'refresh', ticket_resolved: 'check', ticket_closed: 'check', ticket_reply: 'chat', info_request: 'alert', ticket_escalated: 'flag', ticket_priority: 'flag', task_assigned: 'todo', task_due: 'clock', request_decided: 'calendar', ticket_new: 'inbox' };
export default function Notifications() {
  const base = baseFor(roleOf()); const nav = useNavigate(); const qc = useQueryClient(); const [page, setPage] = useState(1); const [unread, setUnread] = useState(false);
  const q = useQuery({ queryKey: ['notifs-page', page, unread], queryFn: () => api(`/notifications?page=${page}&pageSize=20${unread ? '&unread=1' : ''}`), placeholderData: p => p });
  const target = (n: any) => n.entity_type === 'call' ? `${base}/chat?tab=calls` : n.entity_type === 'ticket' ? `${base}/tickets/${n.entity_id}` : n.entity_type === 'project' ? `${base}/projects/${n.entity_id}` : n.entity_type === 'meeting' ? `${base}/schedule?meeting=${n.entity_id}` : n.entity_type === 'task' ? `${base}/todos` : n.entity_type === 'employee_request' ? `${base}/todos?tab=requests` : null;
  const refresh = () => { qc.invalidateQueries({ queryKey: ['notifs'] }); qc.invalidateQueries({ queryKey: ['notifs-page'] }); };
  return <><PageHead crumbs={[{ label: 'Notifications' }]} title="Notifications" sub={`${q.data?.unread ?? 0} unread`}><label className="chk"><input type="checkbox" checked={unread} onChange={e => { setUnread(e.target.checked); setPage(1); }} />Unread only</label><button className="btn" onClick={async () => { await api('/notifications/read-all', { method: 'POST' }); refresh(); }}><Ic n="check" />Mark all read</button></PageHead>
    {q.isLoading ? <div className="card"><Skeleton /></div> : !q.data?.data.length ? <div className="card"><Empty icon="bell" title="You're all caught up">New ticket updates, assignments and reminders appear here.</Empty></div> :
      <div className="card" style={{ padding: 0 }}><ul className="list" style={{ padding: '0 6px' }}>{q.data.data.map((n: any) => <li key={n.id} style={{ padding: '12px 14px', background: n.is_read ? undefined : 'var(--sel)', borderRadius: 10, cursor: 'pointer' }} onClick={async () => { if (!n.is_read) { await api(`/notifications/${n.id}/read`, { method: 'POST' }); refresh(); } const t = target(n); if (t) nav(t); }}>
        <span style={{ display: 'flex', gap: 12, alignItems: 'center' }}><span className="avatar sm" style={{ background: n.is_read ? 'var(--grey-bg)' : undefined, color: n.is_read ? 'var(--muted)' : undefined }}><Ic n={ICON[n.type] || 'bell'} /></span><span><b style={{ fontWeight: n.is_read ? 500 : 700 }}>{n.title}</b>{n.message && <div className="cell-sub">{n.message}</div>}</span></span><span className="cell-sub">{ago(n.created_at)}</span></li>)}</ul>
        <Pager page={page} pageSize={20} total={q.data.total} onPage={setPage} /></div>}</>;
}
