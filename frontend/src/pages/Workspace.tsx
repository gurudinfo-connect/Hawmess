import React, { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, qs, ago, label, roleOf, baseFor, PRIORITIES, STATUS_ORDER } from '../api';
import { Badge, Empty, ErrorBox, Ic, PageHead, Pager, Pri, Skeleton, useDebounced } from '../ui';
import { InvolvementChips, SlaChip, StarButton } from '../components';

/** Workspace = every ticket I am involved in: raised, assigned, escalated to me, watching, or commented/acted on. */
const TABS: [string, string, string][] = [['involved', 'All involved', 'ws_all'], ['requested', 'Raised by me', 'ws_requested'], ['mine', 'Assigned to me', 'ws_mine'], ['watching', 'Watching', 'watching'], ['commented', 'Commented', 'ws_commented'], ['escalated_me', 'Escalated to me', 'ws_escalated']];

export default function Workspace() {
  const role = roleOf(); const base = baseFor(role); const staff = role !== 'employee';
  const [sp, setSp] = useSearchParams(); const g = (k: string) => sp.get(k) || '';
  const set = (patch: Record<string, string | null>) => setSp(p => { const n = new URLSearchParams(p); for (const [k, v] of Object.entries(patch)) v ? n.set(k, v) : n.delete(k); if (!('page' in patch)) n.delete('page'); return n; }, { replace: true });
  const [search, setSearch] = useState(g('search')); const ds = useDebounced(search); useEffect(() => { if (ds !== g('search')) set({ search: ds || null }); }, [ds]);   // eslint-disable-line
  const view = TABS.some(t => t[0] === g('view')) ? g('view') : 'involved'; const page = Number(g('page') || 1);
  const open = g('open') === '1';
  const params = { view, status: g('status'), priority: g('priority'), search: g('search'), type: g('type'), sort: g('sort') || 'updated', dir: 'desc' };
  const list = useQuery({ queryKey: ['tickets', 'workspace', params, open, page], queryFn: () => api(`/tickets${qs({ ...params, ...(open && !params.status ? { status: 'new,open,assigned,in_progress,pending' } : {}), page, pageSize: 25 })}`), placeholderData: p => p });
  const nav = useQuery({ queryKey: ['ticket-nav'], queryFn: () => api('/tickets/nav'), refetchInterval: 30000 });
  const rows: any[] = list.data?.data || []; const c = nav.data || {};
  const stats = [['Open & active', c.ws_open, 'var(--blue)'], ['Raised by me', c.ws_requested, 'var(--teal)'], ['Assigned to me', c.ws_mine, 'var(--orange)'], ['Watching', c.watching, 'var(--purple)']];

  return <>
    <PageHead crumbs={[{ label: 'Workspace' }]} title="My workspace" sub="Every ticket you are involved in — raised, assigned, escalated to you, watching or commented on" />
    <div className="ws-stats">{stats.map(([l, n, col]) => <div className="card ws-stat" key={l as string} style={{ ['--c' as any]: col }}><b>{n ?? '…'}</b><span>{l}</span></div>)}</div>
    <div className="tabs" role="tablist">{TABS.map(([v, l, k]) => <button key={v} role="tab" aria-selected={view === v} className={`tab ${view === v ? 'on' : ''}`} onClick={() => set({ view: v === 'involved' ? null : v })}>{l}<span className="n">{c[k] ?? '…'}</span></button>)}</div>
    <div className="filters">
      <input type="search" aria-label="Search" placeholder="Search by ticket ID, subject, requester or assignee…" value={search} onChange={e => setSearch(e.target.value)} />
      <select aria-label="Status" value={g('status')} onChange={e => set({ status: e.target.value || null })}><option value="">Any status</option>{[...STATUS_ORDER, 'cancelled'].map(s => <option key={s} value={s}>{label(s)}</option>)}</select>
      <select aria-label="Priority" value={g('priority')} onChange={e => set({ priority: e.target.value || null })}><option value="">Any priority</option>{PRIORITIES.map(p => <option key={p} value={p}>{label(p)}</option>)}</select>
      <select aria-label="Type" value={g('type')} onChange={e => set({ type: e.target.value || null })}><option value="">Any type</option><option value="incident">Incidents</option><option value="service_request">Service requests</option><option value="question">Questions</option><option value="change">Changes</option></select>
      <label className="chk"><input type="checkbox" checked={open} onChange={e => set({ open: e.target.checked ? '1' : null })} /> Active only</label>
      {(g('search') || g('status') || g('priority') || g('type') || open || g('view')) && <button className="btn ghost sm" onClick={() => { setSearch(''); setSp({}, { replace: true }); }}>Clear</button>}
    </div>
    <ErrorBox error={list.error} />
    {list.isLoading ? <div className="card"><Skeleton rows={7} /></div> : !rows.length ? <div className="card"><Empty icon="inbox" title="Nothing here yet">{view === 'involved' ? 'Tickets you raise, work on, watch or comment on will show up in your workspace.' : 'No tickets match this tab.'}</Empty></div>
    : <div className="tbl"><table><thead><tr><th>Ticket</th><th>My role</th><th>Status</th><th>Priority</th>{staff && <th>Requester</th>}<th>Assignee</th><th>SLA</th><th>Updated</th></tr></thead>
      <tbody>{rows.map(t => <tr key={t.id}>
        <td><div className="tcell"><StarButton id={t.id} on={!!t.is_favorite} /><div><Link to={`${base}/tickets/${t.id}`}><span className="ticket-no">{t.ticket_no}</span><div style={{ fontWeight: 600, color: 'var(--text)', maxWidth: 360 }}>{t.subject}</div></Link>
          <div className="cell-sub">{label(t.request_type)}{t.category_name ? ` · ${t.category_name}` : ''}</div>{t.is_escalated && <Badge v="esc" text="Escalated" />}</div></div></td>
        <td><InvolvementChips list={t.involvement} /></td><td><Badge v={t.status} /></td><td><Pri v={t.priority} /></td>
        {staff && <td>{t.requester_name}<div className="cell-sub">{t.department_name}</div></td>}<td>{t.assignee_name || <span className="cell-sub">Unassigned</span>}</td><td><SlaChip t={t} /></td><td className="cell-sub">{ago(t.updated_at)}</td></tr>)}</tbody></table>
      <Pager page={page} pageSize={25} total={list.data?.total || 0} onPage={p => set({ page: String(p) })} /></div>}
  </>;
}
