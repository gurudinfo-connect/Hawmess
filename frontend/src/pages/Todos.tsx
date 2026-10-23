import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qs, roleOf, fmtDate, fmtDateTime, label, ago, getUser } from '../api';
import { Avatar, Badge, Empty, ErrorBox, Field, Ic, Modal, PageHead, Pager, Pri, Skeleton, useToast } from '../ui';
import { useLookup } from '../components';

export default function Todos() {
  const role = roleOf(); const [sp, setSp] = useSearchParams(); const tab = sp.get('tab') === 'requests' ? 'requests' : 'tasks';
  const summary = useQuery({ queryKey: ['task-summary'], queryFn: () => api('/tasks/summary') }); const s = summary.data || {};
  const go = (p: Record<string, string>) => setSp(p, { replace: true });
  return <><PageHead crumbs={[{ label: 'To-do' }, { label: tab === 'tasks' ? 'Tasks' : 'Requests & leave' }]} title="To-do" sub="Your tasks, team work and employee requests" />
    <div className="tabs" role="tablist"><button role="tab" aria-selected={tab === 'tasks'} className={`tab ${tab === 'tasks' ? 'on' : ''}`} onClick={() => go({})}><Ic n="todo" />Tasks{s.open !== undefined && <span className="n">{s.open}</span>}</button>
      <button role="tab" aria-selected={tab === 'requests'} className={`tab ${tab === 'requests' ? 'on' : ''}`} onClick={() => go({ tab: 'requests' })}><Ic n="calendar" />{role === 'employee' ? 'My requests & leave' : 'Requests & leave'}</button></div>
    {tab === 'tasks' ? <Tasks sp={sp} go={go} role={role} /> : <Requests sp={sp} go={go} role={role} />}</>;
}

function Tasks({ sp, go, role }: { sp: URLSearchParams; go: (p: Record<string, string>) => void; role: string }) {
  const toast = useToast(); const qc = useQueryClient(); const view = sp.get('view') || 'mine'; const [page, setPage] = useState(1); const [edit, setEdit] = useState<any>(null); const [open, setOpen] = useState<string | null>(null);
  const views: [string, string][] = [['mine', 'My tasks'], ...(role !== 'employee' ? [['team', 'Team tasks'] as [string, string]] : []), ...(role === 'admin' ? [['all', 'All tasks'] as [string, string]] : []), ['overdue', 'Overdue'], ['completed', 'Completed']];
  const q = useQuery({ queryKey: ['tasks', view, page], queryFn: () => api(`/tasks${qs({ view, page, pageSize: 25 })}`), placeholderData: p => p });
  const setStatus = useMutation({ mutationFn: (x: { id: string; status: string }) => api(`/tasks/${x.id}`, { method: 'PATCH', body: { status: x.status } }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['tasks'] }); qc.invalidateQueries({ queryKey: ['task-summary'] }); qc.invalidateQueries({ queryKey: ['dashboard'] }); }, onError: (e: any) => toast(e.message, 'error') });
  const rows: any[] = q.data?.data || [];
  return <><div className="filters"><div className="seg" role="group" aria-label="Task view">{views.map(([v, l]) => <button key={v} className={view === v ? 'on' : ''} onClick={() => { setPage(1); go({ view: v }); }}>{l}</button>)}</div><div style={{ flex: 1 }} /><button className="btn primary" onClick={() => setEdit({})}><Ic n="plus" />New task</button></div>
    <ErrorBox error={q.error} />
    {q.isLoading ? <div className="card"><Skeleton /></div> : !rows.length ? <div className="card"><Empty icon="todo" title={view === 'completed' ? 'Nothing completed yet' : 'No tasks here'}>{view === 'mine' ? 'You are all clear. Create a task to plan your work.' : ''}</Empty></div>
    : <div className="tbl"><table><thead><tr><th style={{ width: 40 }} /><th>Task</th><th>Priority</th><th>Assignee</th><th>Due</th><th>Project / ticket</th><th>Status</th></tr></thead><tbody>{rows.map(t => <tr key={t.id}>
      <td><input type="checkbox" aria-label={`Mark ${t.title} ${t.status === 'completed' ? 'not done' : 'done'}`} checked={t.status === 'completed'} disabled={!(t.assigned_to === getUser()?.id || role !== 'employee')} onChange={e => setStatus.mutate({ id: t.id, status: e.target.checked ? 'completed' : 'pending' })} /></td>
      <td><button className="btn ghost" style={{ padding: 0, textAlign: 'left', fontWeight: 600, color: 'var(--text)', textDecoration: t.status === 'completed' ? 'line-through' : 'none' }} onClick={() => setOpen(t.id)}>{t.title}</button><div className="cell-sub"><span className="ticket-no">{t.task_no}</span>{t.team_name ? ` · ${t.team_name}` : ''}</div></td>
      <td><Pri v={t.priority === 'urgent' ? 'critical' : t.priority} /></td><td>{t.assignee_name ? <span style={{ display: 'flex', gap: 7, alignItems: 'center' }}><Avatar name={t.assignee_name} size="sm" />{t.assignee_name}</span> : '—'}</td>
      <td>{t.due_date ? <span className={t.is_overdue ? 'badge b-breached' : ''}>{fmtDate(t.due_date)}</span> : '—'}</td><td>{t.project_code || t.ticket_no || '—'}</td>
      <td><select aria-label="Status" style={{ width: 'auto', padding: '3px 8px' }} value={t.status} disabled={!(t.assigned_to === getUser()?.id || role !== 'employee')} onChange={e => setStatus.mutate({ id: t.id, status: e.target.value })}>{['pending', 'in_progress', 'completed', 'cancelled'].map(s => <option key={s} value={s}>{label(s)}</option>)}</select></td></tr>)}</tbody></table>
      <Pager page={page} pageSize={25} total={q.data?.total || 0} onPage={setPage} /></div>}
    {edit && <TaskModal task={edit} role={role} onClose={() => setEdit(null)} />}{open && <TaskDetail id={open} onClose={() => setOpen(null)} onEdit={t => { setOpen(null); setEdit(t); }} />}</>;
}

function TaskModal({ task, role, onClose }: { task: any; role: string; onClose: () => void }) {
  const toast = useToast(); const qc = useQueryClient(); const lookup = useLookup(); const projects = useQuery({ queryKey: ['projects-all'], queryFn: () => api('/projects') }); const isNew = !task.id; const me = getUser()?.id;
  const [f, setF] = useState<any>({ title: task.title || '', description: task.description || '', assigned_to: task.assigned_to || me, priority: task.priority || 'medium', start_date: task.start_date || '', due_date: task.due_date || '', project_id: task.project_id || '' });
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const set = (k: string) => (e: any) => setF((s: any) => ({ ...s, [k]: e.target.value }));
  const save = async (e: React.FormEvent) => { e.preventDefault(); setBusy(true); setErr(''); try { const body: any = { ...f, project_id: f.project_id || null, start_date: f.start_date || null, due_date: f.due_date || null }; if (role === 'employee') delete body.assigned_to; await api(isNew ? '/tasks' : `/tasks/${task.id}`, { method: isNew ? 'POST' : 'PATCH', body }); qc.invalidateQueries({ queryKey: ['tasks'] }); qc.invalidateQueries({ queryKey: ['task-summary'] }); toast('Task saved'); onClose(); } catch (x: any) { setErr(x.message); setBusy(false); } };
  return <Modal title={isNew ? 'New task' : 'Edit task'} onClose={onClose} width={620} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="taskform" disabled={busy}>Save</button></>}>
    <form id="taskform" className="form two" onSubmit={save}>{err && <div className="err full">{err}</div>}<Field label="Title" req className="full"><input value={f.title} onChange={set('title')} required maxLength={200} /></Field><Field label="Description" className="full"><textarea rows={3} value={f.description} onChange={set('description')} /></Field>
      {role !== 'employee' ? <Field label="Assign to"><select value={f.assigned_to} onChange={set('assigned_to')}>{(lookup.data?.data || []).map((u: any) => <option key={u.id} value={u.id}>{u.name}{u.id === me ? ' (me)' : ''}</option>)}</select></Field> : <Field label="Assignee"><input value="Me" disabled /></Field>}
      <Field label="Priority"><select value={f.priority} onChange={set('priority')}>{['low', 'medium', 'high', 'urgent'].map(p => <option key={p} value={p}>{label(p)}</option>)}</select></Field>
      <Field label="Start date"><input type="date" value={f.start_date} onChange={set('start_date')} /></Field><Field label="Due date"><input type="date" value={f.due_date} min={f.start_date} onChange={set('due_date')} /></Field>
      <Field label="Related project" className="full"><select value={f.project_id} onChange={set('project_id')}><option value="">None</option>{(projects.data?.data || []).map((p: any) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}</select></Field></form></Modal>;
}
function TaskDetail({ id, onClose, onEdit }: { id: string; onClose: () => void; onEdit: (t: any) => void }) {
  const qc = useQueryClient(); const toast = useToast(); const q = useQuery({ queryKey: ['task', id], queryFn: () => api(`/tasks/${id}`) }); const [note, setNote] = useState(''); const t = q.data; const me = getUser()?.id;
  const add = async () => { try { await api(`/tasks/${id}/notes`, { method: 'POST', body: { note } }); setNote(''); qc.invalidateQueries({ queryKey: ['task', id] }); } catch (e: any) { toast(e.message, 'error'); } };
  return <Modal title={t ? `${t.task_no} · ${t.title}` : 'Task'} onClose={onClose} width={620} footer={t && (t.created_by === me || roleOf() !== 'employee') ? <button className="btn" onClick={() => onEdit(t)}><Ic n="edit" />Edit</button> : undefined}>
    {!t ? <Skeleton /> : <div className="form"><div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><Badge v={t.status} /><Pri v={t.priority === 'urgent' ? 'critical' : t.priority} />{t.is_overdue && <Badge v="breached" text="Overdue" />}</div>
      {t.description && <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{t.description}</p>}<dl className="kv"><dt>Assignee</dt><dd>{t.assignee_name || '—'}</dd><dt>Created by</dt><dd>{t.creator_name}</dd><dt>Start</dt><dd>{fmtDate(t.start_date)}</dd><dt>Due</dt><dd>{fmtDate(t.due_date)}</dd><dt>Project</dt><dd>{t.project_name || '—'}</dd><dt>Ticket</dt><dd>{t.ticket_no || '—'}</dd></dl>
      <h4>Updates</h4><ul className="timeline">{t.updates.map((u: any) => <li key={u.id}><b>{u.type === 'status_change' ? `Status → ${label(u.status)}` : u.type === 'assigned' ? 'Assignment' : 'Note'}</b>{u.note && <div>{u.note}</div>}<div className="m">{u.user_name} · {fmtDateTime(u.created_at)}</div></li>)}</ul>
      <div style={{ display: 'flex', gap: 8 }}><input value={note} onChange={e => setNote(e.target.value)} placeholder="Add a comment…" aria-label="Comment" onKeyDown={e => e.key === 'Enter' && note.trim() && add()} /><button className="btn primary" disabled={!note.trim()} onClick={add}>Post</button></div></div>}</Modal>;
}

function Requests({ sp, go, role }: { sp: URLSearchParams; go: (p: Record<string, string>) => void; role: string }) {
  const toast = useToast(); const qc = useQueryClient(); const staff = role !== 'employee'; const status = sp.get('status') || ''; const type = sp.get('type') || ''; const [page, setPage] = useState(1); const [mine, setMine] = useState(false); const [newReq, setNew] = useState(sp.get('new') === 'leave'); const [decide, setDecide] = useState<any>(null);
  const q = useQuery({ queryKey: ['requests', status, type, page, mine], queryFn: () => api(`/requests${qs({ status, type, page, pageSize: 25, mine: mine ? 1 : '' })}`), placeholderData: p => p }); const rows: any[] = q.data?.data || []; const me = getUser()?.id;
  useEffect(() => { if (sp.get('new') === 'leave') setNew(true); }, [sp]);
  const cancel = useMutation({ mutationFn: (id: string) => api(`/requests/${id}/cancel`, { method: 'POST' }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['requests'] }); toast('Request cancelled'); }, onError: (e: any) => toast(e.message, 'error') });
  const canDecide = (r: any) => staff && r.status === 'pending' && r.user_id !== me && !(role === 'hr' && (['admin', 'hr'].includes(r.requester_role_name) || r.send_to === 'admin'));
  const sentTo = (r: any) => r.send_to === 'hr' ? 'HR' : r.send_to === 'admin' ? 'Admin' : 'HR & Admin';
  return <><div className="filters"><select aria-label="Status" value={status} onChange={e => { setPage(1); go({ tab: 'requests', ...(e.target.value ? { status: e.target.value } : {}), ...(type ? { type } : {}) }); }}><option value="">Any status</option>{['pending', 'approved', 'rejected', 'cancelled'].map(s => <option key={s} value={s}>{label(s)}</option>)}</select>
      <select aria-label="Type" value={type} onChange={e => { setPage(1); go({ tab: 'requests', ...(status ? { status } : {}), ...(e.target.value ? { type: e.target.value } : {}) }); }}><option value="">Any type</option>{['leave', 'equipment', 'document', 'other'].map(s => <option key={s} value={s}>{label(s)}</option>)}</select>
      {staff && <label className="chk"><input type="checkbox" checked={mine} onChange={e => setMine(e.target.checked)} />Only my own</label>}<div style={{ flex: 1 }} /><button className="btn primary" onClick={() => setNew(true)}><Ic n="plus" />New request</button></div>
    <ErrorBox error={q.error} />
    {q.isLoading ? <div className="card"><Skeleton /></div> : !rows.length ? <div className="card"><Empty icon="calendar" title="No requests">Submit leave or equipment requests here and track their approval.</Empty></div> :
      <div className="tbl"><table><thead><tr><th>Request</th>{staff && <th>Employee</th>}<th>Dates</th><th>Sent to</th><th>Status</th><th>Decision</th><th /></tr></thead><tbody>{rows.map(r => <tr key={r.id}>
        <td><b>{r.title}</b><div className="cell-sub"><span className="ticket-no">{r.request_no}</span> · {label(r.type)}{r.leave_type ? ` (${r.leave_type})` : ''}</div>{r.reason && <div className="cell-sub">{r.reason}</div>}</td>{staff && <td>{r.requester_name}<div className="cell-sub">{r.department_name}</div></td>}
        <td>{r.start_date ? `${fmtDate(r.start_date)} → ${fmtDate(r.end_date)}` : '—'}</td><td>{sentTo(r)}</td><td><Badge v={r.status} /></td><td className="cell-sub">{r.decided_by_name ? `${r.decided_by_name} · ${ago(r.decided_at)}` : '—'}{r.decision_note && <div>{r.decision_note}</div>}</td>
        <td style={{ whiteSpace: 'nowrap' }}>{canDecide(r) && <><button className="btn sm primary" onClick={() => setDecide({ r, d: 'approved' })}>Approve</button> <button className="btn sm danger" onClick={() => setDecide({ r, d: 'rejected' })}>Reject</button></>}{r.user_id === me && r.status === 'pending' && <button className="btn sm" onClick={() => cancel.mutate(r.id)}>Cancel</button>}</td></tr>)}</tbody></table>
        <Pager page={page} pageSize={25} total={q.data?.total || 0} onPage={setPage} /></div>}
    {newReq && <RequestModal role={role} onClose={() => { setNew(false); if (sp.get('new')) go({ tab: 'requests' }); }} />}{decide && <DecideModal {...decide} onClose={() => setDecide(null)} />}</>;
}
function RequestModal({ onClose, role }: { onClose: () => void; role: string }) {
  const toast = useToast(); const qc = useQueryClient(); const [f, setF] = useState<any>({ type: 'leave', leave_type: 'annual', title: '', reason: '', start_date: '', end_date: '', send_to: 'both' }); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const set = (k: string) => (e: any) => setF((s: any) => ({ ...s, [k]: e.target.value }));
  const save = async (e: React.FormEvent) => { e.preventDefault(); setBusy(true); setErr(''); try { await api('/requests', { method: 'POST', body: f }); qc.invalidateQueries({ queryKey: ['requests'] }); toast('Request submitted'); onClose(); } catch (x: any) { setErr(x.message); setBusy(false); } };
  return <Modal title="New request" onClose={onClose} width={560} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="reqform" disabled={busy}>Submit</button></>}><form id="reqform" className="form two" onSubmit={save}>{err && <div className="err full">{err}</div>}
    <Field label="Type"><select value={f.type} onChange={set('type')}><option value="leave">Leave</option><option value="equipment">Equipment</option><option value="document">Document</option><option value="other">Other</option></select></Field>
    {f.type === 'leave' ? <Field label="Leave type"><select value={f.leave_type} onChange={set('leave_type')}>{['annual', 'sick', 'casual', 'unpaid', 'other'].map(s => <option key={s} value={s}>{label(s)}</option>)}</select></Field> : <Field label="Title" req><input value={f.title} onChange={set('title')} required /></Field>}
    {f.type === 'leave' && <><Field label="From" req><input type="date" required value={f.start_date} onChange={set('start_date')} /></Field><Field label="To" req><input type="date" required value={f.end_date} min={f.start_date} onChange={set('end_date')} /></Field></>}
    {role === 'employee' && <Field label="Send to" req className="full"><select value={f.send_to} onChange={set('send_to')}><option value="hr">HR</option><option value="admin">Admin</option><option value="both">HR & Admin</option></select></Field>}
    <Field label="Reason" className="full"><textarea rows={3} value={f.reason} onChange={set('reason')} /></Field></form></Modal>;
}
function DecideModal({ r, d, onClose }: { r: any; d: 'approved' | 'rejected'; onClose: () => void }) {
  const toast = useToast(); const qc = useQueryClient(); const [note, setNote] = useState(''); const [err, setErr] = useState('');
  return <Modal title={`${d === 'approved' ? 'Approve' : 'Reject'} request`} onClose={onClose} width={460} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className={`btn ${d === 'approved' ? 'primary' : 'danger'}`} disabled={d === 'rejected' && !note.trim()} onClick={async () => { try { await api(`/requests/${r.id}/decide`, { method: 'POST', body: { decision: d, note } }); qc.invalidateQueries({ queryKey: ['requests'] }); qc.invalidateQueries({ queryKey: ['dashboard'] }); toast(`Request ${d}`); onClose(); } catch (e: any) { setErr(e.message); } }}>{d === 'approved' ? 'Approve' : 'Reject'}</button></>}>
    <div className="form">{err && <div className="err">{err}</div>}<p style={{ margin: 0 }}><b>{r.requester_name}</b> — {r.title}{r.start_date ? ` (${fmtDate(r.start_date)} → ${fmtDate(r.end_date)})` : ''}</p><Field label={d === 'rejected' ? 'Reason (required)' : 'Note (optional)'}><textarea rows={3} value={note} onChange={e => setNote(e.target.value)} /></Field></div></Modal>;
}
