import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qs, baseFor, fmtDate, ago, label, roleOf, roleLabel, fmtDateTime } from '../api';
import { Avatar, Badge, Empty, ErrorBox, Field, Ic, Modal, PageHead, Pager, Skeleton, useDebounced, useToast } from '../ui';
import { ConfirmModal, useDepartments } from '../components';

export default function People() {
  const { id } = useParams(); return id ? <Person id={id} /> : <Directory />;
}

function Directory() {
  const role = roleOf(); const base = baseFor(role); const admin = role === 'admin'; const toast = useToast(); const qc = useQueryClient();
  const [sp, setSp] = useSearchParams(); const g = (k: string) => sp.get(k) || ''; const set = (p: Record<string, string | null>) => setSp(s => { const n = new URLSearchParams(s); for (const [k, v] of Object.entries(p)) v ? n.set(k, v) : n.delete(k); n.delete('page'); return n; }, { replace: true });
  const [search, setSearch] = useState(''); const ds = useDebounced(search); const [mode, setMode] = useState<'cards' | 'list'>((localStorage.getItem('hm_people') as any) || 'cards'); const [page, setPage] = useState(1);
  const [edit, setEdit] = useState<any>(null); const [deact, setDeact] = useState<any>(null);
  const status = g('status') || 'active';
  const q = useQuery({ queryKey: ['people', g('role'), g('department_id'), status, ds, page], queryFn: () => api(`/users/directory/list${qs({ role: g('role'), department_id: g('department_id'), status, search: ds, page, pageSize: 60 })}`), placeholderData: p => p });
  useEffect(() => setPage(1), [g('role'), g('department_id'), status, ds]);
  const rows: any[] = q.data?.data || []; const depts: any[] = q.data?.departments || [];
  const title = g('role') === 'hr' ? 'HR team' : g('role') === 'admin' ? 'Administrators' : g('role') === 'employee' ? (admin ? 'Employees' : 'Employee directory') : 'People';
  const toggleActive = useMutation({ mutationFn: (u: any) => api(`/users/${u.id}`, { method: 'PATCH', body: { is_active: !u.is_active } }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['people'] }); qc.invalidateQueries({ queryKey: ['lookup'] }); toast('Updated'); }, onError: (e: any) => toast(e.message, 'error') });
  return <>
    <PageHead crumbs={[{ label: 'People' }, { label: title }]} title={title} sub={`${q.data?.total ?? '…'} ${status === 'inactive' ? 'deactivated' : status === 'all' ? '' : 'active'} people`}>
      <div className="seg" role="group" aria-label="Layout"><button className={mode === 'cards' ? 'on' : ''} onClick={() => { setMode('cards'); localStorage.setItem('hm_people', 'cards'); }} aria-label="Cards"><Ic n="grid" /></button><button className={mode === 'list' ? 'on' : ''} onClick={() => { setMode('list'); localStorage.setItem('hm_people', 'list'); }} aria-label="List"><Ic n="list" /></button></div>
      {admin && <button className="btn primary" onClick={() => setEdit({})}><Ic n="userplus" />Add person</button>}</PageHead>
    <div className="side-layout"><nav className="side" aria-label="Departments"><h4>Department</h4>
      <button className={!g('department_id') ? 'on' : ''} onClick={() => set({ department_id: null })}>All<span>{depts.reduce((s, d) => s + d.count, 0)}</span></button>{depts.map(d => <button key={d.id} className={g('department_id') === d.id ? 'on' : ''} onClick={() => set({ department_id: d.id })}>{d.name}<span>{d.count}</span></button>)}</nav>
      <div className="main-col"><div className="filters"><input type="search" aria-label="Search people" placeholder="Search by name, email or designation…" value={search} onChange={e => setSearch(e.target.value)} />
        {admin && <select aria-label="Role" value={g('role')} onChange={e => set({ role: e.target.value || null })}><option value="">All roles</option><option value="employee">Employees</option><option value="hr">HR</option><option value="admin">Admins</option></select>}
        {admin && <select aria-label="Status" value={status} onChange={e => set({ status: e.target.value })}><option value="active">Active</option><option value="inactive">Deactivated</option><option value="all">All</option></select>}</div>
        <ErrorBox error={q.error} />
        {q.isLoading ? <div className="card"><Skeleton /></div> : !rows.length ? <div className="card"><Empty icon="users" title="No people found">Try a different search or department.</Empty></div>
        : mode === 'cards' ? <div className="people-grid">{rows.map(u => <Link key={u.id} to={`${base}/people/${u.id}`} className="pcard" style={{ opacity: u.is_active ? 1 : .6 }}><Avatar name={u.name} size="lg" /><div style={{ minWidth: 0 }}><div className="nm">{u.name}</div><div className="ln"><Ic n="user" />{u.designation || roleLabel(u.role)}</div><div className="ln"><Ic n="mail" />{u.email}</div>{u.phone && <div className="ln"><Ic n="phone" />{u.phone}</div>}<div style={{ display: 'flex', gap: 5, marginTop: 7, flexWrap: 'wrap' }}><Badge v={u.role === 'admin' ? 'critical' : u.role === 'hr' ? 'assigned' : 'open'} text={roleLabel(u.role)} />{u.department && <span className="badge">{u.department}</span>}{!u.is_active && <Badge v="inactive" text="Deactivated" />}</div></div></Link>)}</div>
        : <div className="tbl"><table><thead><tr><th>Name</th><th>Role</th><th>Department</th><th className="n">Tickets raised</th><th className="n">Open tasks</th><th>Last sign-in</th>{admin && <th />}</tr></thead><tbody>{rows.map(u => <tr key={u.id} className="click" onClick={e => { if (!(e.target as HTMLElement).closest('button')) location.assign(`${base}/people/${u.id}`); }}><td style={{ display: 'flex', gap: 10, alignItems: 'center' }}><Avatar name={u.name} size="sm" /><div><b>{u.name}</b><div className="cell-sub">{u.email}</div></div></td><td><Badge v={u.role === 'admin' ? 'critical' : u.role === 'hr' ? 'assigned' : 'open'} text={roleLabel(u.role)} />{!u.is_active && <Badge v="inactive" text="Deactivated" />}</td><td>{u.department || '—'}<div className="cell-sub">{u.designation}</div></td><td className="n">{u.tickets_raised}</td><td className="n">{u.open_tasks}</td><td className="cell-sub">{u.last_login_at ? ago(u.last_login_at) : 'Never'}</td>{admin && <td style={{ whiteSpace: 'nowrap' }}><button className="btn sm" onClick={() => setEdit(u)}><Ic n="edit" />Edit</button> <button className="btn sm" onClick={() => u.is_active ? setDeact(u) : toggleActive.mutate(u)}>{u.is_active ? 'Deactivate' : 'Reactivate'}</button></td>}</tr>)}</tbody></table><Pager page={page} pageSize={60} total={q.data?.total || 0} onPage={setPage} /></div>}</div></div>
    {edit && <UserModal user={edit} onClose={() => setEdit(null)} />}
    {deact && <ConfirmModal danger title={`Deactivate ${deact.name}?`} text="They will be signed out immediately and cannot sign in. Their tickets, tasks and history are kept." confirm="Deactivate" onClose={() => setDeact(null)} onYes={() => toggleActive.mutateAsync(deact)} />}
  </>;
}

export function UserModal({ user, onClose }: { user: any; onClose: () => void }) {
  const toast = useToast(); const qc = useQueryClient(); const depts = useDepartments(); const isNew = !user.id;
  const [f, setF] = useState<any>({ name: user.name || '', email: user.email || '', phone: user.phone || '', designation: user.designation || '', department_id: user.department_id || '', role: user.role || 'employee', password: '', is_active: user.is_active ?? true }); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const set = (k: string) => (e: any) => setF((s: any) => ({ ...s, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const save = async (e: React.FormEvent) => { e.preventDefault(); setErr(''); setBusy(true); try {
    const body: any = { name: f.name, phone: f.phone || null, designation: f.designation || null, department_id: f.department_id || null, role: f.role }; if (isNew) { body.email = f.email; body.password = f.password; } else { body.is_active = f.is_active; }
    await api(isNew ? '/users' : `/users/${user.id}`, { method: isNew ? 'POST' : 'PATCH', body }); if (!isNew && f.password) await api(`/users/${user.id}/reset-password`, { method: 'POST', body: { password: f.password } }); qc.invalidateQueries({ queryKey: ['people'] }); qc.invalidateQueries({ queryKey: ['person'] }); qc.invalidateQueries({ queryKey: ['lookup'] }); toast(isNew ? 'Person added' : 'Changes saved'); onClose(); } catch (x: any) { setErr(x.message); } finally { setBusy(false); } };
  return <Modal title={isNew ? 'Add person' : `Edit ${user.name}`} onClose={onClose} width={620} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="userform" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></>}>
    <form id="userform" className="form two" onSubmit={save}>{err && <div className="err full" role="alert">{err}</div>}
      <Field label="Full name" req><input value={f.name} onChange={set('name')} required /></Field><Field label="Work email" req><input type="email" value={f.email} onChange={set('email')} required disabled={!isNew} /></Field>
      <Field label="Role" req><select value={f.role} onChange={set('role')}><option value="employee">Employee</option><option value="hr">HR</option><option value="admin">Admin</option></select></Field>
      <Field label="Department"><select value={f.department_id} onChange={set('department_id')}><option value="">None</option>{(depts.data?.data || []).map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
      <Field label="Designation"><input value={f.designation} onChange={set('designation')} /></Field><Field label="Phone"><input value={f.phone} onChange={set('phone')} /></Field>
      <Field label={isNew ? 'Temporary password' : 'Reset password'} req={isNew} hint="At least 8 characters with a letter and a number." className="full"><input type="password" autoComplete="new-password" value={f.password} onChange={set('password')} required={isNew} placeholder={isNew ? '' : 'Leave blank to keep the current password'} /></Field>
      {!isNew && <label className="chk full"><input type="checkbox" checked={f.is_active} onChange={set('is_active')} />Account is active</label>}</form></Modal>;
}

function Person({ id }: { id: string }) {
  const role = roleOf(); const base = baseFor(role); const nav = useNavigate(); const [edit, setEdit] = useState(false);
  const q = useQuery({ queryKey: ['person', id], queryFn: () => api(`/users/${id}`) });
  if (q.isLoading) return <div className="card"><Skeleton rows={6} /></div>; if (q.error) return <ErrorBox error={q.error} />; const u = q.data;
  return <>
    <PageHead crumbs={[{ label: 'People', to: `${base}/people` }, { label: u.name }]} title={u.name} sub={`${u.designation || roleLabel(u.role)}${u.department ? ' · ' + u.department : ''}`}>
      <Link className="btn" to={`${base}/chat?user=${u.id}`}><Ic n="chat" />Message</Link>{role === 'admin' && <button className="btn primary" onClick={() => setEdit(true)}><Ic n="edit" />Edit</button>}</PageHead>
    <div className="grid g-main"><div className="grid">
      <div className="card"><h3>Recent tickets{role === 'hr' ? ' (HR-visible only)' : ''}</h3>{u.tickets.length ? <ul className="list">{u.tickets.map((t: any) => <li key={t.id}><Link to={`${base}/tickets/${t.id}`}>{t.ticket_no} · {t.subject}</Link><Badge v={t.status} /></li>)}</ul> : <p className="sub">Nothing to show.</p>}</div>
      <div className="grid g2"><div className="card"><h3>Projects</h3>{u.projects.length ? <ul className="list">{u.projects.map((p: any) => <li key={p.id}><Link to={`${base}/projects/${p.id}`}>{p.code} · {p.name}</Link><Badge v={p.status} /></li>)}</ul> : <p className="sub">No projects.</p>}</div>
        <div className="card"><h3>Tasks</h3>{u.tasks.length ? <ul className="list">{u.tasks.map((t: any) => <li key={t.id}><span>{t.title}</span><Badge v={t.status} /></li>)}</ul> : <p className="sub">No tasks.</p>}</div></div>
      {role === 'admin' && <div className="card"><h3>Recent activity</h3><ul className="timeline">{u.activity.map((a: any, i: number) => <li key={i}>{a.description}<div className="m">{fmtDateTime(a.created_at)}</div></li>)}</ul></div>}</div>
      <aside className="card"><div style={{ textAlign: 'center', marginBottom: 14 }}><Avatar name={u.name} size="lg" /><h3 style={{ marginTop: 8 }}>{u.name}</h3><Badge v={u.is_active ? 'active' : 'inactive'} text={u.is_active ? 'Active' : 'Deactivated'} /></div>
        <dl className="kv"><dt>Role</dt><dd>{roleLabel(u.role)}</dd><dt>Email</dt><dd><a href={`mailto:${u.email}`}>{u.email}</a></dd><dt>Phone</dt><dd>{u.phone || '—'}</dd><dt>Department</dt><dd>{u.department || '—'}</dd><dt>Teams</dt><dd>{u.teams.map((t: any) => t.name).join(', ') || '—'}</dd><dt>Tickets raised</dt><dd>{u.tickets_raised}</dd><dt>Assigned (open)</dt><dd>{u.tickets_assigned}</dd><dt>Last sign-in</dt><dd>{u.last_login_at ? fmtDateTime(u.last_login_at) : 'Never'}</dd><dt>Joined</dt><dd>{fmtDate(u.created_at)}</dd></dl></aside></div>
    {edit && <UserModal user={u} onClose={() => setEdit(false)} />}</>;
}
