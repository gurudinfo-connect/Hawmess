import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, qs, baseFor, fmtDateTime, label, roleOf } from '../api';
import { Badge, Empty, ErrorBox, PageHead, Pager, Skeleton, useDebounced } from '../ui';

const MODULES = ['auth', 'tickets', 'users', 'tasks', 'projects', 'requests', 'configuration', 'reports'];
export default function ActivityLog() {
  const role = roleOf(); const base = baseFor(role); const [f, setF] = useState({ module: '', action: '', from: '', to: '', search: '' }); const [page, setPage] = useState(1); const ds = useDebounced(f.search);
  const q = useQuery({ queryKey: ['audit', f.module, f.action, f.from, f.to, ds, page], queryFn: () => api(`/audit-logs${qs({ ...f, search: ds, page, pageSize: 30 })}`), placeholderData: p => p });
  const set = (k: string) => (e: any) => { setPage(1); setF(s => ({ ...s, [k]: e.target.value })); }; const rows: any[] = q.data?.data || [];
  const link = (r: any) => r.entity_type === 'ticket' ? `${base}/tickets/${r.entity_id}` : r.entity_type === 'project' ? `${base}/projects/${r.entity_id}` : r.entity_type === 'user' && role === 'admin' ? `${base}/people/${r.entity_id}` : null;
  return <><PageHead crumbs={[{ label: 'Activity log' }]} title="Activity log" sub={role === 'admin' ? 'Every sign-in, change and decision, with who did it and when' : 'Employee and ticket activity you are allowed to see'} />
    <div className="filters"><input type="search" className="grow" aria-label="Search activity" placeholder="Search description or person…" value={f.search} onChange={set('search')} />
      {role === 'admin' && <select aria-label="Module" value={f.module} onChange={set('module')}><option value="">All modules</option>{MODULES.map(m => <option key={m} value={m}>{label(m)}</option>)}</select>}
      <input aria-label="Action" placeholder="Action (e.g. assign)" style={{ width: 160 }} value={f.action} onChange={set('action')} /><input type="date" aria-label="From" value={f.from} onChange={set('from')} /><input type="date" aria-label="To" value={f.to} onChange={set('to')} /></div>
    <ErrorBox error={q.error} />
    {q.isLoading ? <div className="card"><Skeleton rows={8} /></div> : !rows.length ? <div className="card"><Empty icon="activity" title="No activity matches" /></div> :
      <div className="tbl"><table><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Details</th><th>Record</th></tr></thead><tbody>{rows.map(r => <tr key={r.id}><td style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(r.created_at)}</td><td>{r.user_name || 'System'}<div className="cell-sub">{label(r.role)}</div></td><td><span className="badge">{label(r.action)}</span><div className="cell-sub">{label(r.module)}</div></td>
        <td style={{ maxWidth: 520 }}>{r.description}{(r.old_value || r.new_value) && <details><summary className="cell-sub" style={{ cursor: 'pointer' }}>Changes</summary><code style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{JSON.stringify({ from: r.old_value, to: r.new_value })}</code></details>}</td><td>{link(r) ? <Link to={link(r)!}>Open</Link> : <span className="cell-sub">{r.entity_type ? label(r.entity_type) : '—'}</span>}</td></tr>)}</tbody></table>
        <Pager page={page} pageSize={30} total={q.data?.total || 0} onPage={setPage} /></div>}</>;
}
