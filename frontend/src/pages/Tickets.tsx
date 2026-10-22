import React, { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qs, ago, label, roleOf, baseFor, PRIORITIES, STATUS_ORDER } from '../api';
import { Badge, Empty, ErrorBox, Ic, Modal, PageHead, Pager, Pri, Skeleton, useDebounced, useToast, Avatar } from '../ui';
import { AcceptBadge } from './TicketDetail';
import { InvolvementChips, NewTicketPage, PRI_COLORS, SlaChip, STATUS_COLORS, StarButton, useAssignable, useCategories } from '../components';

const TITLES: Record<string, string> = { open: 'Open tickets', unassigned: 'Unassigned tickets', assigned: 'Assigned tickets', escalated: 'Escalated tickets', breached: 'SLA-breached tickets', overdue: 'Overdue tickets', mine: 'Assigned to me', requested: 'Raised by me', favorites: 'Starred tickets', watching: 'Tickets I am watching', involved: 'Tickets I am involved in', commented: 'Tickets I commented on', escalated_me: 'Escalated to me', awaiting_acceptance: 'Awaiting acceptance', accepted: 'Accepted by employee', declined: 'Declined tickets' };
const TYPE_NAMES: Record<string, string> = { incident: 'incidents', service_request: 'service requests', question: 'questions', change: 'changes' };

export default function Tickets() {
  const [sp, setSp] = useSearchParams();
  if (sp.get('new') === '1') return <NewTicketPage initial={{ category_id: sp.get('category_id') || '', subcategory_id: sp.get('subcategory_id') || '' }} defaultType={sp.get('type') || 'incident'} onClose={() => setSp(p => { const n = new URLSearchParams(p); n.delete('new'); return n; })} />;
  return <TicketList />;
}

function TicketList() {
  const role = roleOf(); const base = baseFor(role); const staff = role !== 'employee'; const toast = useToast(); const qc = useQueryClient();
  const [sp, setSp] = useSearchParams(); const g = (k: string) => sp.get(k) || '';
  const set = (patch: Record<string, string | null>) => setSp(p => { const n = new URLSearchParams(p); for (const [k, v] of Object.entries(patch)) v ? n.set(k, v) : n.delete(k); if (!('page' in patch)) n.delete('page'); return n; }, { replace: true });
  const [search, setSearch] = useState(g('search')); const ds = useDebounced(search); useEffect(() => { if (ds !== g('search')) set({ search: ds || null }); }, [ds]);   // eslint-disable-line
  const filtered = !!(g('view') || g('status') || g('type'));
  const mode = g('mode') || (staff && !filtered ? 'kanban' : 'list'); const page = Number(g('page') || 1);
  const params = { view: g('view'), type: g('type'), status: g('status'), priority: g('priority'), category_id: g('category_id'), assignee_id: g('assignee_id'), from: g('from'), to: g('to'), search: g('search'), sort: g('sort') || 'created', dir: g('dir') || 'desc' };
  const list = useQuery({ queryKey: ['tickets', params, mode, page], queryFn: () => api(`/tickets${qs({ ...params, page: mode === 'kanban' ? 1 : page, pageSize: mode === 'kanban' ? 100 : 25 })}`), placeholderData: p => p });
  const counts = useQuery({ queryKey: ['ticket-counts', g('type')], queryFn: () => api(`/tickets/counts${qs({ type: g('type') })}`), refetchInterval: 30000 });
  const cats = useCategories(); const assignable = useAssignable();
  const [sel, setSel] = useState<string[]>([]); const [bulk, setBulk] = useState<'assign' | 'status' | 'priority' | null>(null);
  useEffect(() => setSel([]), [list.data]);
  const tn = TYPE_NAMES[g('type')] || 'tickets';   // 'incidents', 'questions'…
  const title = TITLES[g('view')] ? (g('type') ? `${TITLES[g('view')]} (${tn})` : TITLES[g('view')]) : g('status') ? `${label(g('status'))} ${tn}` : g('type') ? (role === 'employee' ? `My ${tn}` : `All ${tn}`) : role === 'employee' ? 'My tickets' : 'All tickets';
  const newLabel = g('type') === 'incident' ? 'Report incident' : g('type') === 'service_request' ? 'New request' : 'New ticket';
  const c = counts.data || {};
  const tabs = staff ? [['', 'All', c.total], ['open', 'Open', c.open], ['unassigned', 'Unassigned', c.unassigned], ['assigned', 'Assigned', c.assigned], ['awaiting_acceptance', 'Awaiting acceptance', c.awaiting_acceptance], ['accepted', 'Accepted', c.accepted], ['declined', 'Declined', c.declined], ['escalated', 'Escalated', c.escalated], ['breached', 'SLA breached', c.breached]]
    : [['', 'All', c.total], ['open', 'Open', c.open], ['awaiting_acceptance', 'To accept', c.awaiting_acceptance], ['mine', 'Assigned to me', c.assigned_to_me]];
  const rows: any[] = list.data?.data || [];
  const cols = mode === 'kanban' ? STATUS_ORDER.filter(s => !g('status') || g('status').split(',').includes(s)) : [];
  const tab = g('view');

  return <>
    <PageHead crumbs={[{ label: g('type') === 'incident' ? 'Incidents' : 'Tickets', to: g('type') ? `${base}/tickets?type=${g('type')}` : `${base}/tickets` }, { label: title }]} title={title} sub={g('view') === 'favorites' ? 'Tickets you starred — click the star on any ticket to add or remove it' : g('view') === 'watching' ? 'You get notified about updates on these tickets' : g('type') === 'incident' ? 'Something is broken or not working as expected' : staff ? 'Triage, assign and resolve support requests' : 'Everything you have raised with the helpdesk'}>
      <div className="seg" role="group" aria-label="View"><button className={mode === 'kanban' ? 'on' : ''} onClick={() => set({ mode: 'kanban' })} aria-pressed={mode === 'kanban'}><Ic n="grid" />Board</button><button className={mode === 'list' ? 'on' : ''} onClick={() => set({ mode: 'list' })} aria-pressed={mode === 'list'}><Ic n="list" />List</button></div>
      <button className="btn primary" onClick={() => set({ new: '1' })}><Ic n="plus" />{newLabel}</button>
    </PageHead>
    <div className="tabs" role="tablist">{tabs.map(([v, l, n]) => <button key={l as string} role="tab" aria-selected={tab === v && !g('status')} className={`tab ${tab === v && !g('status') ? 'on' : ''}`} onClick={() => set({ view: (v as string) || null, status: null })}>{l}<span className="n">{n ?? '…'}</span></button>)}</div>
    <div className="filters">
      <input type="search" aria-label="Search tickets" placeholder="Search by ticket ID, subject, requester or assignee…" value={search} onChange={e => setSearch(e.target.value)} />
      <select aria-label="Status" value={g('status')} onChange={e => set({ status: e.target.value || null })}><option value="">Any status</option>{[...STATUS_ORDER, 'cancelled'].map(s => <option key={s} value={s}>{label(s)}</option>)}</select>
      <select aria-label="Priority" value={g('priority')} onChange={e => set({ priority: e.target.value || null })}><option value="">Any priority</option>{PRIORITIES.map(p => <option key={p} value={p}>{label(p)}</option>)}</select>
      <select aria-label="Category" value={g('category_id')} onChange={e => set({ category_id: e.target.value || null })}><option value="">Any category</option>{(cats.data?.data || []).filter((x: any) => !x.parent_id).map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
      {staff && <select aria-label="Assignee" value={g('assignee_id')} onChange={e => set({ assignee_id: e.target.value || null })}><option value="">Any assignee</option>{(assignable.data?.data || []).map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>}
      <input type="date" aria-label="Created from" value={g('from')} onChange={e => set({ from: e.target.value || null })} /><input type="date" aria-label="Created to" value={g('to')} onChange={e => set({ to: e.target.value || null })} />
      <select aria-label="Sort" value={`${params.sort}:${params.dir}`} onChange={e => { const [s, d] = e.target.value.split(':'); set({ sort: s, dir: d }); }}><option value="created:desc">Newest first</option><option value="created:asc">Oldest first</option><option value="updated:desc">Recently updated</option><option value="priority:desc">Priority: high → low</option><option value="sla:asc">SLA deadline: soonest</option></select>
      {(g('search') || g('priority') || g('category_id') || g('assignee_id') || g('from') || g('to') || g('status') || g('view') || g('type')) && <button className="btn ghost sm" onClick={() => { setSearch(''); setSp({}, { replace: true }); }}>Clear</button>}
    </div>
    <ErrorBox error={list.error} />
    {list.isLoading ? <div className="card"><Skeleton rows={7} /></div> : !rows.length ? <div className="card"><Empty icon={g('view') === 'favorites' ? 'star' : 'ticket'} title={g('view') === 'favorites' ? 'No starred tickets yet' : g('view') === 'watching' ? 'You are not watching any tickets' : 'No tickets found'}>{g('view') === 'favorites' ? 'Open any ticket and click the star to pin it here.' : g('view') === 'watching' ? 'Use “Watch” on a ticket to follow it.' : filtered || g('search') ? 'Try clearing a filter.' : 'Create the first ticket to get started.'}<div style={{ marginTop: 12 }}><button className="btn primary" onClick={() => set({ new: '1' })}><Ic n="plus" />New ticket</button></div></Empty></div>
    : mode === 'kanban' ? <>
      <div className="kanban">{cols.map(s => { const items = rows.filter(t => t.status === s); return <section className="kcol" key={s} aria-label={label(s)}>
        <header>{label(s)}<span className="n">{items.length}</span></header><div className="kbar" style={{ ['--c' as any]: STATUS_COLORS[s] }} />
        {items.map(t => <Link key={t.id} to={`${base}/tickets/${t.id}`} className="kcard" style={{ ['--c' as any]: PRI_COLORS[t.priority] }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="ticket-no">{t.ticket_no}</span><span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>{t.is_escalated && <Badge v="esc" text="Escalated" />}<StarButton id={t.id} on={!!t.is_favorite} /></span></div>
          <div className="t">{t.subject}</div><div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}><Pri v={t.priority} /><AcceptBadge t={t} />{t.category_name && <span className="badge">{t.category_name}</span>}</div>
          <div className="f"><SlaChip t={t} /><span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>{staff && <span title={t.requester_name}>{t.requester_name.split(' ')[0]}</span>}{t.assignee_name ? <Avatar name={t.assignee_name} size="sm" /> : <span title="Unassigned" className="badge b-new">Unassigned</span>}</span></div>
        </Link>)}{!items.length && <p className="cell-sub" style={{ textAlign: 'center', padding: 14 }}>Nothing here</p>}</section>; })}</div>
      {list.data.total > 100 && <p className="hint">Showing the 100 most recent matches. Use the list view or filters to see more.</p>}</>
    : <>
      {staff && sel.length > 0 && <div className="card mb" style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '10px 14px' }}><b>{sel.length} selected</b><button className="btn sm" onClick={() => setBulk('assign')}>Assign</button><button className="btn sm" onClick={() => setBulk('status')}>Change status</button><button className="btn sm" onClick={() => setBulk('priority')}>Change priority</button><button className="btn ghost sm" onClick={() => setSel([])}>Clear</button></div>}
      <div className="tbl"><table><thead><tr>{staff && <th style={{ width: 36 }}><input type="checkbox" aria-label="Select all" checked={sel.length === rows.length} onChange={e => setSel(e.target.checked ? rows.map(r => r.id) : [])} /></th>}<th>Ticket</th><th>Status</th><th>Priority</th>{staff && <th>Requester</th>}<th>Assignee</th><th>Category</th><th>SLA</th><th>Updated</th></tr></thead>
        <tbody>{rows.map(t => <tr key={t.id}>{staff && <td><input type="checkbox" aria-label={`Select ${t.ticket_no}`} checked={sel.includes(t.id)} onChange={e => setSel(s => e.target.checked ? [...s, t.id] : s.filter(x => x !== t.id))} /></td>}
          <td><div className="tcell"><StarButton id={t.id} on={!!t.is_favorite} /><div><Link to={`${base}/tickets/${t.id}`}><span className="ticket-no">{t.ticket_no}</span><div style={{ fontWeight: 600, color: 'var(--text)', maxWidth: 380 }}>{t.subject}</div></Link>{t.is_escalated && <Badge v="esc" text="Escalated" />}{['favorites', 'watching', 'involved'].includes(g('view')) && <InvolvementChips list={t.involvement} />}</div></div></td>
          <td><Badge v={t.status} /></td><td><Pri v={t.priority} /></td>{staff && <td>{t.requester_name}<div className="cell-sub">{t.department_name}</div></td>}
          <td>{t.assignee_name || <span className="cell-sub">Unassigned</span>}{t.acceptance && <div><AcceptBadge t={t} /></div>}<div className="cell-sub">{t.team_name}</div></td><td>{t.category_name}<div className="cell-sub">{t.subcategory_name}</div></td><td><SlaChip t={t} /></td><td className="cell-sub">{ago(t.updated_at)}</td></tr>)}</tbody></table>
        <Pager page={page} pageSize={25} total={list.data?.total || 0} onPage={p => set({ page: String(p) })} /></div></>}
    {bulk && <BulkModal kind={bulk} ids={sel} onClose={() => setBulk(null)} onDone={() => { setSel([]); qc.invalidateQueries({ queryKey: ['tickets'] }); qc.invalidateQueries({ queryKey: ['ticket-counts'] }); qc.invalidateQueries({ queryKey: ['ticket-nav'] }); }} />}
  </>;
}

function BulkModal({ kind, ids, onClose, onDone }: { kind: 'assign' | 'status' | 'priority'; ids: string[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast(); const assignable = useAssignable(); const [v, setV] = useState(''); const [note, setNote] = useState(''); const [busy, setBusy] = useState(false); const [res, setRes] = useState<any>(null); const [err, setErr] = useState('');
  const run = async () => { setBusy(true); setErr(''); try { const body: any = { ids, action: kind, note: note || undefined }; if (kind === 'assign') body.assignee_id = v || null; if (kind === 'status') body.status = v; if (kind === 'priority') body.priority = v; const r = await api('/tickets/bulk', { method: 'POST', body }); setRes(r); onDone(); if (!r.failed.length) { toast(`${r.updated} ticket(s) updated`); onClose(); } } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
  return <Modal title={`Bulk ${kind === 'assign' ? 'assignment' : kind === 'status' ? 'status change' : 'priority change'} · ${ids.length} tickets`} onClose={onClose} width={520} footer={<><button className="btn" onClick={onClose}>{res ? 'Close' : 'Cancel'}</button>{!res && <button className="btn primary" disabled={busy || (kind !== 'assign' && !v)} onClick={run}>Apply</button>}</>}>
    <div className="form"><ErrorBox error={err ? { message: err } : null} />
      {kind === 'assign' && <label>Assign to<select value={v} onChange={e => setV(e.target.value)}><option value="">Unassign</option>{(assignable.data?.data || []).map((u: any) => <option key={u.id} value={u.id}>{u.name} ({u.role})</option>)}</select></label>}
      {kind === 'status' && <label>New status<select value={v} onChange={e => setV(e.target.value)}><option value="">Select…</option>{['open', 'assigned', 'in_progress', 'pending', 'resolved', 'closed', 'cancelled'].map(s => <option key={s} value={s}>{label(s)}</option>)}</select></label>}
      {kind === 'priority' && <label>New priority<select value={v} onChange={e => setV(e.target.value)}><option value="">Select…</option>{PRIORITIES.map(p => <option key={p} value={p}>{label(p)}</option>)}</select></label>}
      {kind !== 'priority' && <label>{v === 'resolved' ? 'Resolution details (required to resolve)' : 'Note (optional)'}<textarea rows={2} value={note} onChange={e => setNote(e.target.value)} /></label>}
      <p className="hint">Each ticket is validated on its own — tickets that cannot make the change are skipped and reported.</p>
      {res && <div className={res.failed.length ? 'warnbox' : 'note'}><b>{res.updated} updated, {res.failed.length} skipped.</b>{res.failed.slice(0, 6).map((f: any) => <div key={f.id}>• {f.error}</div>)}</div>}</div></Modal>;
}
