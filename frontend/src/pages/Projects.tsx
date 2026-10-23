import React, { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, baseFor, fmtDate, label, roleOf, qs } from '../api';
import { Avatar, Badge, Empty, ErrorBox, Field, Ic, Kpi, Modal, PageHead, Pri, Skeleton, useToast } from '../ui';
import { ConfirmModal, useLookup } from '../components';

export default function Projects() { const { id } = useParams(); return id ? <Detail id={id} /> : <List />; }

const Progress = ({ p }: { p: any }) => p.progress === null ? <span className="cell-sub">No tasks yet</span> : <div><div className="progress" role="progressbar" aria-valuenow={p.progress} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${p.progress}%` }} /></div><div className="cell-sub" style={{ marginTop: 3 }}>{p.progress}% · {p.task_done}/{p.task_total} tasks</div></div>;

function List() {
  const role = roleOf(); const base = baseFor(role); const admin = role === 'admin'; const [sp, setSp] = useSearchParams(); const status = sp.get('status') || ''; const [search, setSearch] = useState(''); const [edit, setEdit] = useState<any>(null);
  const q = useQuery({ queryKey: ['projects', status, search], queryFn: () => api(`/projects${qs({ status, search })}`) });
  const title = status === 'ongoing' ? 'Ongoing projects' : status === 'completed' ? 'Completed projects' : role === 'employee' ? 'My projects' : 'All projects';
  return <><PageHead crumbs={[{ label: 'Projects' }, { label: title }]} title={title} sub={role === 'employee' ? 'Projects you manage or belong to' : 'Teams, deadlines and related support'}>{admin && <button className="btn primary" onClick={() => setEdit({})}><Ic n="plus" />New project</button>}</PageHead>
    <div className="filters"><input type="search" aria-label="Search projects" placeholder="Search projects…" value={search} onChange={e => setSearch(e.target.value)} /><select aria-label="Status" value={status} onChange={e => setSp(e.target.value ? { status: e.target.value } : {}, { replace: true })}><option value="">All statuses</option><option value="ongoing">Ongoing</option>{['planning', 'active', 'on_hold', 'completed', 'cancelled'].map(s => <option key={s} value={s}>{label(s)}</option>)}</select></div>
    <ErrorBox error={q.error} />
    {q.isLoading ? <div className="card"><Skeleton /></div> : !q.data?.data.length ? <div className="card"><Empty icon="folder" title="No projects here">{role === 'employee' ? 'You have not been added to a project yet.' : 'Create a project to organise teams, tasks and related tickets.'}</Empty></div>
    : <div className="grid g3">{q.data.data.map((p: any) => <Link key={p.id} to={`${base}/projects/${p.id}`} className="card" style={{ color: 'var(--text)', display: 'block' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><span className="ticket-no">{p.code}</span><Badge v={p.status} /></div><h3 style={{ margin: '6px 0 4px', fontSize: 17 }}>{p.name}</h3>
      <p className="sub" style={{ minHeight: 42, overflow: 'hidden' }}>{(p.description || '').slice(0, 110)}</p><Progress p={p} />
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12, color: 'var(--muted)', fontSize: 12.5 }}><span><Ic n="users" /> {p.member_count} · <Ic n="ticket" /> {p.open_ticket_count} open</span><span className={p.is_overdue ? 'b-breached badge' : ''}>{p.due_date ? `Due ${fmtDate(p.due_date)}` : 'No deadline'}</span></div></Link>)}</div>}
    {edit && <ProjectModal project={edit} onClose={() => setEdit(null)} />}</>;
}

function Detail({ id }: { id: string }) {
  const role = roleOf(); const base = baseFor(role); const admin = role === 'admin'; const nav = useNavigate(); const qc = useQueryClient(); const toast = useToast(); const [edit, setEdit] = useState(false); const [del, setDel] = useState(false);
  const q = useQuery({ queryKey: ['project', id], queryFn: () => api(`/projects/${id}`) });
  if (q.isLoading) return <div className="card"><Skeleton rows={6} /></div>; if (q.error) return <div className="card"><Empty icon="lock" title="Project not found"><Link className="btn" to={`${base}/projects`}>Back to projects</Link></Empty></div>; const p = q.data;
  return <><PageHead crumbs={[{ label: 'Projects', to: `${base}/projects` }, { label: p.code }]} title={p.name} sub={p.description || undefined}><Badge v={p.status} />{admin && <><button className="btn" onClick={() => setEdit(true)}><Ic n="edit" />Edit</button><button className="btn danger" onClick={() => setDel(true)}><Ic n="trash" /></button></>}</PageHead>
    <div className="kpis"><Kpi label="Progress" value={p.progress === null ? '—' : `${p.progress}%`} hint={`${p.task_done}/${p.task_total} tasks done`} color="var(--green)" /><Kpi label="Open tickets" value={p.open_ticket_count} hint={`${p.ticket_count} total`} color="var(--c-orange)" /><Kpi label="Team" value={p.member_count} color="var(--blue)" /><Kpi label="Deadline" value={p.due_date ? fmtDate(p.due_date) : '—'} hint={p.is_overdue ? 'Overdue' : p.manager_name ? `Manager: ${p.manager_name}` : undefined} color={p.is_overdue ? 'var(--red)' : 'var(--c-teal)'} /></div>
    <div className="grid g-main"><div className="grid">
      <div className="card"><header><h3>Related tickets</h3>{role !== 'employee' && <Link to={`${base}/tickets?project_id=${p.id}`}>Filter all</Link>}</header>{p.tickets.length ? <ul className="list">{p.tickets.map((t: any) => <li key={t.id}><Link to={`${base}/tickets/${t.id}`}><span className="ticket-no">{t.ticket_no}</span> {t.subject}</Link><span style={{ display: 'flex', gap: 6 }}><Pri v={t.priority} /><Badge v={t.status} /></span></li>)}</ul> : <p className="sub">No tickets linked to this project.</p>}</div>
      <div className="card"><header><h3>Tasks</h3><Link to={`${base}/todos`}>My to-do</Link></header>{p.tasks.length ? <div className="tbl" style={{ border: 0, boxShadow: 'none' }}><table><thead><tr><th>Task</th><th>Assignee</th><th>Due</th><th>Status</th></tr></thead><tbody>{p.tasks.map((t: any) => <tr key={t.id}><td>{t.title}</td><td>{t.assignee_name || '—'}</td><td>{fmtDate(t.due_date)}</td><td><Badge v={t.status} /></td></tr>)}</tbody></table></div> : <p className="sub">No tasks yet.</p>}</div></div>
      <aside className="card"><h3>Team</h3><ul className="list">{p.members.map((m: any) => <li key={m.id}><span style={{ display: 'flex', gap: 10, alignItems: 'center' }}><Avatar name={m.name} size="sm" /><span>{role !== 'employee' ? <Link to={`${base}/people/${m.id}`}>{m.name}</Link> : m.name}<div className="cell-sub">{m.project_role || m.designation || ''}</div></span></span>{m.id === p.manager_id && <span className="badge b-open">Manager</span>}</li>)}</ul>
        <dl className="kv" style={{ marginTop: 14 }}><dt>Starts</dt><dd>{fmtDate(p.start_date)}</dd><dt>Due</dt><dd>{fmtDate(p.due_date)}</dd></dl></aside></div>
    {edit && <ProjectModal project={p} onClose={() => setEdit(false)} />}
    {del && <ConfirmModal danger title="Delete project?" text="The project and its team list are removed. Linked tickets and tasks are kept but unlinked." confirm="Delete" onClose={() => setDel(false)} onYes={async () => { await api(`/projects/${id}`, { method: 'DELETE' }); qc.invalidateQueries({ queryKey: ['projects'] }); toast('Project deleted'); nav(`${base}/projects`); }} />}</>;
}

function ProjectModal({ project, onClose }: { project: any; onClose: () => void }) {
  const toast = useToast(); const qc = useQueryClient(); const lookup = useLookup(); const isNew = !project.id;
  const [f, setF] = useState<any>({ code: project.code || '', name: project.name || '', description: project.description || '', status: project.status || 'active', start_date: project.start_date || '', due_date: project.due_date || '', manager_id: project.manager_id || '' });
  const [members, setMembers] = useState<string[]>((project.members || []).map((m: any) => m.id)); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const set = (k: string) => (e: any) => setF((s: any) => ({ ...s, [k]: e.target.value }));
  const save = async (e: React.FormEvent) => { e.preventDefault(); setBusy(true); setErr(''); try {
    const body = { ...f, code: f.code || null, description: f.description || null, start_date: f.start_date || null, due_date: f.due_date || null, manager_id: f.manager_id || null, members: members.map(user_id => ({ user_id, project_role: (project.members || []).find((m: any) => m.id === user_id)?.project_role || null })) };
    await api(isNew ? '/projects' : `/projects/${project.id}`, { method: isNew ? 'POST' : 'PATCH', body }); qc.invalidateQueries({ queryKey: ['projects'] }); qc.invalidateQueries({ queryKey: ['project'] }); toast('Project saved'); onClose(); } catch (x: any) { setErr(x.message); setBusy(false); } };
  const users: any[] = lookup.data?.data || [];
  return <Modal title={isNew ? 'New project' : `Edit ${project.code}`} onClose={onClose} width={720} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="projform" disabled={busy}>Save</button></>}>
    <form id="projform" className="form two" onSubmit={save}>{err && <div className="err full">{err}</div>}
      <Field label="Name" req><input value={f.name} onChange={set('name')} required /></Field><Field label="Code" hint="Leave blank to auto-generate"><input value={f.code} onChange={set('code')} maxLength={20} disabled={!isNew} /></Field>
      <Field label="Description" className="full"><textarea rows={3} value={f.description} onChange={set('description')} /></Field>
      <Field label="Status"><select value={f.status} onChange={set('status')}>{['planning', 'active', 'on_hold', 'completed', 'cancelled'].map(s => <option key={s} value={s}>{label(s)}</option>)}</select></Field><Field label="Project manager"><select value={f.manager_id} onChange={set('manager_id')}><option value="">None</option>{users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
      <Field label="Start date"><input type="date" value={f.start_date} onChange={set('start_date')} /></Field><Field label="Due date"><input type="date" value={f.due_date} min={f.start_date} onChange={set('due_date')} /></Field>
      <Field label="Team members" className="full"><div style={{ maxHeight: 170, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 9, padding: 8, display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(200px,1fr))', gap: 4 }}>{users.map(u => <label key={u.id} className="chk"><input type="checkbox" checked={members.includes(u.id)} onChange={e => setMembers(m => e.target.checked ? [...m, u.id] : m.filter(x => x !== u.id))} />{u.name}</label>)}</div></Field></form></Modal>;
}
