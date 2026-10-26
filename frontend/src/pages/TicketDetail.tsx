import React, { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiForm, download, fmtDateTime, dur, label, roleOf, baseFor, PRIORITIES, STATUS_ORDER, ago } from '../api';
import { Avatar, Badge, Empty, ErrorBox, Field, Ic, Modal, PageHead, Pri, Skeleton, useToast } from '../ui';
import { ConfirmModal, fileSize, StarButton, useAssignable, useCategories, useTeams } from '../components';

const UPDATE_TEXT: Record<string, (x: any) => string> = {
  assigned: x => `Assigned to ${x.to_user_name || 'someone'}`, reassigned: x => `Reassigned to ${x.to_user_name || 'someone'}`,
  accepted: () => 'Accepted the ticket', declined: () => 'Declined the ticket',
  progress: x => `Progress update${x.progress != null ? ` · ${x.progress}%` : ''}${x.status ? ` · ${label(x.status)}` : ''}`,
};
export const AcceptBadge = ({ t }: { t: any }) => t.acceptance ? <span className={`badge b-${t.acceptance === 'pending' ? 'pending' : t.acceptance}`}>{t.acceptance === 'pending' ? 'Awaiting acceptance' : t.acceptance === 'accepted' ? 'Accepted' : 'Declined'}</span> : null;

const ACTION_LABEL: Record<string, string> = { open: 'Mark as open', assigned: 'Mark assigned', in_progress: 'Start work', pending: 'Set pending', resolved: 'Resolve', closed: 'Close ticket', cancelled: 'Cancel ticket' };

export default function TicketDetail() {
  const { id } = useParams(); const role = roleOf(); const base = baseFor(role); const staff = role !== 'employee'; const qc = useQueryClient(); const toast = useToast(); const nav = useNavigate();
  const q = useQuery({ queryKey: ['ticket', id], queryFn: () => api(`/tickets/${id}`), refetchInterval: 15000 });
  const [modal, setModal] = useState<null | { kind: 'assign' | 'resolve' | 'escalate' | 'cancel' | 'reopen' | 'status' | 'decline' | 'update'; status?: string }>(null);
  const [tab, setTab] = useState<'updates' | 'status' | 'assign'>('updates');
  const refresh = () => { qc.invalidateQueries({ queryKey: ['ticket', id] }); qc.invalidateQueries({ queryKey: ['tickets'] }); qc.invalidateQueries({ queryKey: ['ticket-counts'] }); qc.invalidateQueries({ queryKey: ['ticket-nav'] }); qc.invalidateQueries({ queryKey: ['dashboard'] }); qc.invalidateQueries({ queryKey: ['notifications'] }); };
  const act = useMutation({ mutationFn: (x: { path: string; body?: any; method?: string }) => api(`/tickets/${id}${x.path}`, { method: x.method || 'POST', body: x.body || {} }), onSuccess: () => { refresh(); toast('Ticket updated'); }, onError: (e: any) => toast(e.message, 'error') });
  const t = q.data;
  if (q.isLoading) return <div className="card"><Skeleton rows={8} /></div>;
  if (q.error || !t) return <div className="card"><Empty icon="lock" title="Ticket not found"><p>It may not exist, or you may not have access to it.</p><Link className="btn" to={`${base}/tickets`}>Back to tickets</Link></Empty></div>;
  const a = t.actions; const nextStatus: string[] = a.next_statuses || [];
  const startAction = (s: string) => { if (s === 'resolved') setModal({ kind: 'resolve' }); else if (s === 'cancelled') setModal({ kind: 'cancel' }); else if (s === 'open' && ['resolved', 'closed'].includes(t.status)) setModal({ kind: 'reopen' }); else if (s === 'assigned') setModal({ kind: 'assign' }); else act.mutate({ path: '/status', body: { status: s } }); };
  const idx = STATUS_ORDER.indexOf(t.status);
  const sla = t.sla;

  return <>
    <PageHead crumbs={[{ label: 'Tickets', to: `${base}/tickets` }, { label: t.ticket_no }]} title={t.subject} sub={`${t.ticket_no} · raised ${fmtDateTime(t.created_at)} by ${t.requester_name}`}>
      <StarButton id={t.id} on={!!t.is_favorite} /><button className={`btn sm ${t.is_watching ? 'primary' : ''}`} aria-pressed={!!t.is_watching} disabled={act.isPending} onClick={() => act.mutate({ path: '/watch', body: { on: !t.is_watching } })}><Ic n="eye" />{t.is_watching ? 'Watching' : 'Watch'}</button>
      <Badge v={t.status} /><Pri v={t.priority} />{t.is_escalated && <Badge v="esc" text="Escalated" />}
    </PageHead>
    {a.can_accept && <div className="card mb accept-bar"><div><b>This ticket was assigned to you</b><div className="cell-sub">Accept it to start working. Your admin is told as soon as you accept — then you can post progress updates until it is resolved.</div></div>
      <div style={{ display: 'flex', gap: 8 }}><button className="btn danger" disabled={act.isPending} onClick={() => setModal({ kind: 'decline' })}>Decline</button><button className="btn primary" disabled={act.isPending} onClick={() => act.mutate({ path: '/accept' })}><Ic n="check" />Accept ticket</button></div></div>}
    {t.acceptance === 'declined' && !t.assignee_id && staff && !['resolved', 'closed', 'cancelled'].includes(t.status) && <div className="warnbox mb"><b>The last assignee declined this ticket:</b> {t.acceptance_note} — reassign it to someone else (the ticket ID stays {t.ticket_no}).</div>}
    {t.status === 'cancelled' ? <div className="warnbox mb">This ticket was cancelled.</div> : <div className="stepper" aria-label="Lifecycle">{STATUS_ORDER.map((s, i) => <span key={s} className={`step ${i < idx ? 'done' : i === idx ? 'now' : ''}`}>{label(s)}</span>)}</div>}
    <div className="detail">
      <div>
        <section className="card mb"><h3>Description</h3><p style={{ whiteSpace: 'pre-wrap', margin: 0, overflowWrap: 'anywhere' }}>{t.description}</p>
          {t.attachments.filter((x: any) => !x.comment_id).length > 0 && <div className="files">{t.attachments.filter((x: any) => !x.comment_id).map((f: any) => <FileChip key={f.id} f={f} />)}</div>}
          {t.resolution_note && <div className="note" style={{ marginTop: 14 }}><b>Resolution:</b> {t.resolution_note}</div>}
          {t.is_escalated && <div className="warnbox" style={{ marginTop: 14 }}><b>Escalated{t.escalated_to_name ? ` to ${t.escalated_to_name}` : ''}:</b> {t.escalation_reason}</div>}</section>
        <section className="card" aria-label="Conversation"><h3>Conversation</h3>
          {!t.comments.length && <p className="sub">No replies yet.</p>}
          {t.comments.map((c: any) => <div key={c.id} className={`msg ${c.is_internal ? 'internal' : ''}`}><Avatar name={c.author_name} />
            <div className="bubble"><div className="who"><b>{c.author_name}</b><span className="badge">{c.author_role === 'hr' ? 'HR' : label(c.author_role)}</span>{c.is_internal && <span className="badge b-medium"><Ic n="lock" />Internal note</span>}{c.is_info_request && <span className="badge b-pending">Information requested</span>}<span className="when">{fmtDateTime(c.created_at)}</span></div>
              <p>{c.body}</p>{t.attachments.filter((x: any) => x.comment_id === c.id).length > 0 && <div className="files">{t.attachments.filter((x: any) => x.comment_id === c.id).map((f: any) => <FileChip key={f.id} f={f} />)}</div>}</div></div>)}
          {a.can_reply || a.can_internal ? <Composer ticket={t} staff={staff} onDone={refresh} /> : <p className="hint">This ticket is {t.status}. Reopen it to add a reply.</p>}</section>
      </div>
      <aside>
        <div className={`sla ${!sla.has_policy ? '' : sla.resolution_breached || sla.response_breached ? 'bad' : sla.remaining_minutes !== null && sla.remaining_minutes < 60 ? 'warn' : ''}`} style={!sla.has_policy ? { background: 'var(--grey-bg)', color: 'var(--muted)' } : undefined}>
          {!sla.has_policy ? <>No SLA policy applies to this ticket.</> : <>
            <small>{['resolved', 'closed', 'cancelled'].includes(t.status) ? (sla.resolution_breached ? 'Resolution target missed' : 'Resolved within SLA') : sla.is_overdue ? 'Overdue by' : 'Time remaining'}</small>
            <b>{['resolved', 'closed', 'cancelled'].includes(t.status) ? dur(sla.elapsed_minutes) : dur(sla.remaining_minutes)}</b>
            <small>Resolution due {fmtDateTime(sla.resolution_due)}</small>
            <small>First response {sla.first_response_at ? `after ${dur(sla.first_response_minutes)}${sla.response_breached ? ' (missed)' : ' (on time)'}` : `due ${fmtDateTime(sla.first_response_due)}${sla.response_breached ? ' (missed)' : ''}`}</small></>}</div>
        {(a.can_assign || a.can_reassign || a.can_update || nextStatus.length > 0 || a.can_escalate || a.can_deescalate) && <section className="card mb"><h3>Actions</h3><div style={{ display: 'grid', gap: 8 }}>
          {a.can_update && <button className="btn primary" onClick={() => setModal({ kind: 'update' })}><Ic n="refresh" />Update progress</button>}
          {(a.can_assign || a.can_reassign) && <button className="btn" onClick={() => setModal({ kind: 'assign' })}><Ic n="userplus" />{t.assignee_id ? 'Reassign' : 'Assign'}</button>}
          {nextStatus.filter(s => s !== 'assigned').map(s => <button key={s} className={`btn ${s === 'resolved' ? 'primary' : s === 'cancelled' ? 'danger' : ''}`} disabled={act.isPending} onClick={() => startAction(s)}>{s === 'open' && ['resolved', 'closed'].includes(t.status) ? 'Reopen ticket' : s === 'closed' && !staff ? 'Confirm & close' : ACTION_LABEL[s]}</button>)}
          {a.can_escalate && <button className="btn" onClick={() => setModal({ kind: 'escalate' })}><Ic n="flag" />Escalate</button>}
          {a.can_deescalate && <button className="btn" onClick={() => act.mutate({ path: '/deescalate' })}>Clear escalation</button>}
          {a.can_edit && !['resolved', 'closed', 'cancelled'].includes(t.status) && <Field label="Priority"><select value={t.priority} onChange={e => act.mutate({ path: '', method: 'PATCH', body: { priority: e.target.value } })}>{PRIORITIES.map(p => <option key={p} value={p}>{label(p)}</option>)}</select></Field>}</div></section>}
        {a.can_manage_watchers && <WatchersCard t={t} onChange={refresh} />}
        <section className="card mb"><h3>Details</h3><dl className="kv">
          <dt>Requester</dt><dd>{t.requester_name}<div className="cell-sub">{t.department_name}</div></dd><dt>Assignee</dt><dd>{t.assignee_name || <span className="cell-sub">Unassigned</span>} {t.acceptance && <AcceptBadge t={t} />}{t.accepted_at && <div className="cell-sub">Accepted {fmtDateTime(t.accepted_at)}</div>}</dd>{t.assignee_id && <><dt>Progress</dt><dd><div className="pbar" aria-label={`${t.progress}% complete`}><span style={{ width: `${t.progress}%` }} /></div><div className="cell-sub">{t.progress}% complete</div></dd></>}<dt>Team</dt><dd>{t.team_name || '—'}</dd>
          <dt>Category</dt><dd>{t.category_name}{t.subcategory_name ? ` › ${t.subcategory_name}` : ''}</dd><dt>Type</dt><dd>{label(t.request_type)}</dd>
          <dt>Project</dt><dd>{t.project_id ? <Link to={`${base}/projects/${t.project_id}`}>{t.project_code} · {t.project_name}</Link> : '—'}</dd><dt>Created</dt><dd>{fmtDateTime(t.created_at)}</dd><dt>Updated</dt><dd>{ago(t.updated_at)}</dd>{t.resolved_at && <><dt>Resolved</dt><dd>{fmtDateTime(t.resolved_at)}</dd></>}</dl></section>
        <section className="card"><div className="tabs">{(t.updates || []).length > 0 && <button className={`tab ${tab === 'updates' ? 'on' : ''}`} onClick={() => setTab('updates')}>Updates</button>}<button className={`tab ${tab === 'status' || (tab === 'updates' && !(t.updates || []).length) ? 'on' : ''}`} onClick={() => setTab('status')}>Status history</button>{(staff || t.assignment_history.length > 0) && <button className={`tab ${tab === 'assign' ? 'on' : ''}`} onClick={() => setTab('assign')}>Assignments</button>}</div>
          <ul className="timeline">{tab === 'updates' && (t.updates || []).length ? t.updates.map((x: any) => <li key={x.id}><b>{UPDATE_TEXT[x.type](x)}</b>{x.note && <div className="m" style={{ whiteSpace: 'pre-wrap' }}>{x.note}</div>}<div className="m">{x.user_name} · {fmtDateTime(x.created_at)}</div></li>)
            : tab === 'assign' ? (t.assignment_history.length ? t.assignment_history.map((h: any) => <li key={h.id}><b>{h.to_assignee_name ? `→ ${h.to_assignee_name}` : 'Unassigned'}{h.to_team_name ? ` · ${h.to_team_name}` : ''}</b><div className="m">{h.from_assignee_name ? `from ${h.from_assignee_name} · ` : ''}by {h.changed_by_name} · {fmtDateTime(h.created_at)}{h.note ? ` — ${h.note}` : ''}</div></li>) : <li>No assignments yet</li>)
            : t.status_history.map((h: any) => <li key={h.id}><b>{h.from_status ? `${label(h.from_status)} → ${label(h.to_status)}` : label(h.to_status)}</b><div className="m">{h.changed_by_name} · {fmtDateTime(h.created_at)}{h.note ? ` — ${h.note}` : ''}</div></li>)}</ul></section>
      </aside>
    </div>
    {modal?.kind === 'assign' && <AssignModal t={t} staff={staff} onClose={() => setModal(null)} onDone={() => { refresh(); if (!staff) nav(`${base}/tickets`); }} />}   {/* an employee who hands the ticket over loses access to it, so go back to the list */}
    {modal?.kind === 'decline' && <NoteModal title="Decline this ticket" cta="Decline" field="Why are you declining?" required help="The ticket goes back to the admin to be reassigned. They will see your reason." onClose={() => setModal(null)} onSubmit={async reason => { await api(`/tickets/${id}/decline`, { method: 'POST', body: { reason } }); refresh(); toast('Ticket declined'); nav(`${base}/tickets`); }} />}
    {modal?.kind === 'update' && <UpdateModal t={t} onClose={() => setModal(null)} onDone={refresh} />}
    {modal?.kind === 'resolve' && <NoteModal title="Resolve ticket" cta="Resolve" field="Resolution details" required onClose={() => setModal(null)} onSubmit={async note => { await api(`/tickets/${id}/status`, { method: 'POST', body: { status: 'resolved', note } }); refresh(); toast('Ticket resolved'); }} help="Describe what fixed the problem. The requester will see this." />}
    {modal?.kind === 'reopen' && <NoteModal title="Reopen ticket" cta="Reopen" field="Why is it being reopened?" onClose={() => setModal(null)} onSubmit={async note => { await api(`/tickets/${id}/status`, { method: 'POST', body: { status: 'open', note } }); refresh(); toast('Ticket reopened'); }} />}
    {modal?.kind === 'escalate' && <EscalateModal t={t} onClose={() => setModal(null)} onDone={refresh} />}
    {modal?.kind === 'cancel' && <ConfirmModal danger title="Cancel this ticket?" text="The ticket will be marked as cancelled and can no longer be worked on." confirm="Cancel ticket" onClose={() => setModal(null)} onYes={async () => { await api(`/tickets/${id}/status`, { method: 'POST', body: { status: 'cancelled' } }); refresh(); toast('Ticket cancelled'); }} />}
  </>;
}

const FileChip = ({ f }: { f: any }) => { const toast = useToast(); return <button className="file" onClick={() => download(`/tickets/attachments/${f.id}`, f.filename).catch(e => toast(e.message, 'error'))} title={`Uploaded by ${f.uploaded_by_name}`}><Ic n="clip" />{f.filename}<small style={{ color: 'var(--muted)' }}>{fileSize(f.size_bytes)}</small>{f.is_internal && <Ic n="lock" />}</button>; };

function Composer({ ticket, staff, onDone }: { ticket: any; staff: boolean; onDone: () => void }) {
  const toast = useToast(); const [body, setBody] = useState(''); const [internal, setInternal] = useState(false); const [info, setInfo] = useState(false); const [files, setFiles] = useState<File[]>([]); const [busy, setBusy] = useState(false); const [key, setKey] = useState(0);
  const canPublic = ticket.actions.can_reply;
  const send = async (e: React.FormEvent) => { e.preventDefault(); if (!body.trim()) return; setBusy(true); try { await apiForm(`/tickets/${ticket.id}/comments`, { body, is_internal: internal, request_info: info && !internal }, files); setBody(''); setFiles([]); setInfo(false); setKey(k => k + 1); onDone(); } catch (x: any) { toast(x.message, 'error'); } finally { setBusy(false); } };
  return <form onSubmit={send} style={{ borderTop: '1px solid var(--border)', paddingTop: 14, marginTop: 6 }} className="form">
    {staff && <div className="seg" style={{ width: 'fit-content' }} role="group" aria-label="Reply type">{canPublic && <button type="button" className={!internal ? 'on' : ''} onClick={() => setInternal(false)}>Reply to requester</button>}<button type="button" className={internal ? 'on' : ''} onClick={() => setInternal(true)}><Ic n="lock" />Internal note</button></div>}
    <textarea aria-label="Message" rows={internal ? 3 : 4} value={body} onChange={e => setBody(e.target.value)} placeholder={internal ? 'Only visible to admins and HR…' : 'Write a reply…'} style={internal ? { background: 'var(--yellow-bg)' } : undefined} />
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}><input key={key} type="file" multiple style={{ width: 'auto', maxWidth: 260 }} aria-label="Attach files" onChange={e => setFiles(Array.from(e.target.files || []).slice(0, 5))} />
      {staff && !internal && <label className="chk"><input type="checkbox" checked={info} onChange={e => setInfo(e.target.checked)} />Request more information (sets status to Pending)</label>}<div style={{ flex: 1 }} /><button className="btn primary" disabled={busy || !body.trim()}><Ic n="send" />{internal ? 'Add note' : 'Send reply'}</button></div></form>;
}

function UpdateModal({ t, onClose, onDone }: { t: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast(); const [note, setNote] = useState(''); const [progress, setProgress] = useState<number>(t.progress || 0); const [status, setStatus] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const moves: string[] = (t.actions.next_statuses || []).filter((s: string) => ['in_progress', 'pending', 'resolved'].includes(s));
  const save = async () => { setBusy(true); setErr(''); try { await api(`/tickets/${t.id}/updates`, { method: 'POST', body: { note, progress: status === 'resolved' ? 100 : progress, status: status || null } }); onDone(); toast('Update posted'); onClose(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
  return <Modal title={`Update progress · ${t.ticket_no}`} onClose={onClose} width={500} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || note.trim().length < 3} onClick={save}>Post update</button></>}>
    <div className="form">{err && <div className="err">{err}</div>}
      <Field label="What has been done?" req hint={status === 'resolved' ? 'This becomes the resolution details the requester sees.' : 'The admin and the requester are notified.'}><textarea rows={4} value={note} onChange={e => setNote(e.target.value)} autoFocus /></Field>
      <Field label={`Progress — ${status === 'resolved' ? 100 : progress}%`}><input type="range" min={0} max={100} step={5} value={status === 'resolved' ? 100 : progress} disabled={status === 'resolved'} onChange={e => setProgress(Number(e.target.value))} /></Field>
      {moves.length > 0 && <Field label="Move ticket to (optional)"><select value={status} onChange={e => setStatus(e.target.value)}><option value="">Keep as {label(t.status)}</option>{moves.filter(s => s !== t.status).map(s => <option key={s} value={s}>{label(s)}</option>)}</select></Field>}</div></Modal>;
}
function AssignModal({ t, staff, onClose, onDone }: { t: any; staff: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast(); const teams = useTeams(); const [a, setA] = useState(staff ? t.assignee_id || '' : ''); const [team, setTeam] = useState(t.team_id || ''); const [note, setNote] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  // staff pick from everyone assignable; an employee (the accepted assignee) picks from the colleagues the server allows for this ticket
  const people = useQuery({ queryKey: ['reassign-targets', t.id], queryFn: () => api(`/tickets/${t.id}/reassign-targets`), staleTime: 30000 });
  const save = async () => { setBusy(true); setErr(''); try { await api(`/tickets/${t.id}/assign`, { method: 'POST', body: staff ? { assignee_id: a || null, team_id: team || null, note: note || null } : { assignee_id: a, note } }); onDone(); toast(staff ? 'Assignment updated' : 'Ticket reassigned'); onClose(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
  return <Modal title={t.assignee_id ? 'Reassign ticket' : 'Assign ticket'} onClose={onClose} width={480} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || (!staff && (!a || !note.trim()))} onClick={save}>{staff ? 'Save' : 'Reassign'}</button></>}><div className="form">{err && <div className="err">{err}</div>}
    {staff && <Field label="Team"><select value={team} onChange={e => setTeam(e.target.value)}><option value="">No team</option>{(teams.data?.data || []).filter((x: any) => x.is_active).map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>}
    <Field label={staff ? 'Assignee' : 'Reassign to'} req={!staff}><select value={a} onChange={e => setA(e.target.value)}><option value="">{staff ? 'Unassigned' : people.isLoading ? 'Loading…' : 'Choose a colleague…'}</option>{(people.data?.data || []).map((u: any) => <option key={u.id} value={u.id}>{u.name} ({u.role})</option>)}</select></Field>
    {staff ? <Field label="Note (optional)" hint={t.assignee_id ? `Same ticket (${t.ticket_no}) — the new assignee has to accept it, and the previous assignee is notified.` : 'An employee must accept the ticket before working on it.'}><input value={note} onChange={e => setNote(e.target.value)} maxLength={500} /></Field>
      : <Field label="Reason" req hint={`Same ticket (${t.ticket_no}) — they have to accept it, the admin is told, and you will no longer have access to it.`}><textarea rows={3} value={note} onChange={e => setNote(e.target.value)} maxLength={500} placeholder="Why are you handing this over?" /></Field>}</div></Modal>;
}
function NoteModal({ title, cta, field, required, help, onClose, onSubmit }: { title: string; cta: string; field: string; required?: boolean; help?: string; onClose: () => void; onSubmit: (note: string) => Promise<any> }) {
  const [note, setNote] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  return <Modal title={title} onClose={onClose} width={480} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || (required && !note.trim())} onClick={async () => { setBusy(true); try { await onSubmit(note); onClose(); } catch (e: any) { setErr(e.message); setBusy(false); } }}>{cta}</button></>}>
    <div className="form">{err && <div className="err">{err}</div>}<Field label={field} req={required} hint={help}><textarea rows={4} value={note} onChange={e => setNote(e.target.value)} autoFocus /></Field></div></Modal>;
}
function EscalateModal({ t, onClose, onDone }: { t: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast(); const assignable = useAssignable(); const [reason, setReason] = useState(''); const [to, setTo] = useState(''); const [err, setErr] = useState('');
  return <Modal title="Escalate ticket" onClose={onClose} width={480} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={reason.trim().length < 3} onClick={async () => { try { await api(`/tickets/${t.id}/escalate`, { method: 'POST', body: { reason, to_user_id: to || null } }); onDone(); toast('Ticket escalated'); onClose(); } catch (e: any) { setErr(e.message); } }}>Escalate</button></>}>
    <div className="form">{err && <div className="err">{err}</div>}<Field label="Escalate to" hint="Admins are notified immediately."><select value={to} onChange={e => setTo(e.target.value)}><option value="">All administrators</option>{(assignable.data?.data || []).filter((u: any) => u.role === 'admin').map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
      <Field label="Reason" req><textarea rows={3} value={reason} onChange={e => setReason(e.target.value)} placeholder="Why does this need senior attention?" /></Field></div></Modal>;
}

function WatchersCard({ t, onChange }: { t: any; onChange: () => void }) {
  const toast = useToast(); const people = useQuery({ queryKey: ['watchable'], queryFn: () => api('/tickets/watchable'), staleTime: 60000 }); const [pick, setPick] = useState('');
  const have = new Set((t.watchers || []).map((w: any) => w.id));
  const add = async () => { try { await api(`/tickets/${t.id}/watchers`, { method: 'POST', body: { user_id: pick } }); setPick(''); onChange(); toast('Watcher added'); } catch (e: any) { toast(e.message, 'error'); } };
  const remove = async (id: string) => { try { await api(`/tickets/${t.id}/watchers/${id}`, { method: 'DELETE' }); onChange(); } catch (e: any) { toast(e.message, 'error'); } };
  return <section className="card mb"><h3>Watchers</h3>
    {!t.watchers?.length ? <p className="hint" style={{ marginTop: 0 }}>Nobody is watching yet. Watchers get notified of public updates and can view this ticket (read-only).</p>
      : <ul className="watchers">{t.watchers.map((w: any) => <li key={w.id}><Avatar name={w.name} size="sm" /><span>{w.name}</span><button className="btn ghost sm" aria-label={`Remove ${w.name}`} onClick={() => remove(w.id)}><Ic n="x" /></button></li>)}</ul>}
    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}><select aria-label="Add watcher" value={pick} onChange={e => setPick(e.target.value)} style={{ flex: 1, minWidth: 0 }}><option value="">Add a watcher…</option>{(people.data?.data || []).filter((u: any) => !have.has(u.id) && u.id !== t.requester_id).map((u: any) => <option key={u.id} value={u.id}>{u.name} ({u.role})</option>)}</select><button className="btn sm" disabled={!pick} onClick={add}>Add</button></div></section>;
}
