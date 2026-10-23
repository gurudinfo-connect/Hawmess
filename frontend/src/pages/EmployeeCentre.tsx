import React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, ago, baseFor, getUser, qs, roleOf } from '../api';
import { Badge, Empty, Ic, Kpi, PageHead, Skeleton } from '../ui';

export default function EmployeeCentre() {
  const b = baseFor(roleOf()); const user = getUser();
  const nav = useQuery({ queryKey: ['ticket-nav'], queryFn: () => api('/tickets/nav') });
  const mine = useQuery({ queryKey: ['ec-mine'], queryFn: () => api(`/tickets${qs({ view: 'requested', pageSize: 5 })}`) });
  const kb = useQuery({ queryKey: ['ec-kb'], queryFn: () => api(`/knowledge${qs({ pageSize: 4 })}`) });
  const n = nav.data || {}; const rows: any[] = mine.data?.data || []; const arts: any[] = kb.data?.data || [];
  const actions = [
    { label: 'Request a service', to: `${b}/service-catalogue`, icon: 'building' },
    { label: 'Leave & requests', to: `${b}/todos?tab=requests`, icon: 'calendar' }, { label: 'Message HR', to: `${b}/chat`, icon: 'chat' },
  ];
  return <>
    <PageHead crumbs={[{ label: 'Self service' }, { label: 'Employee centre' }]} title="Employee centre" sub={`Welcome${user?.name ? `, ${user.name.split(' ')[0]}` : ''} — everything you need in one place`} />
    <div className="grid g4" style={{ marginBottom: 16 }}>
      <Kpi label="My open items" value={n.ws_open} icon="ticket" color="var(--blue)" to={`${b}/workspace`} />
      <Kpi label="Raised by me" value={n.ws_requested} icon="user" color="var(--c-teal)" to={`${b}/tickets?view=requested`} />
      <Kpi label="Watching" value={n.watching} icon="eye" color="var(--c-amber)" to={`${b}/tickets?view=watching`} />
      <Kpi label="Starred" value={n.favorites} icon="star" color="var(--c-orange)" to={`${b}/tickets?view=favorites`} /></div>
    <h2 className="sec-h">Quick actions</h2>
    <div className="tiles" style={{ marginBottom: 20 }}>{actions.map(a => <Link key={a.label} to={a.to} className="tile row"><div className="tile-ic"><Ic n={a.icon} /></div><h3>{a.label}</h3></Link>)}</div>
    <div className="grid g2">
      <section className="card"><h2 className="sec-h">My recent tickets</h2>
        {mine.isLoading ? <Skeleton rows={4} /> : !rows.length ? <Empty icon="ticket" title="Nothing raised yet">Use a quick action above to get started.</Empty>
          : <div className="ec-list">{rows.map(t => <Link key={t.id} to={`${b}/tickets/${t.id}`}><span><b className="ticket-no">{t.ticket_no}</b> {t.subject}</span><span className="cell-sub"><Badge v={t.status} /> {ago(t.updated_at)}</span></Link>)}</div>}</section>
      <section className="card"><h2 className="sec-h">Latest knowledge</h2>
        {kb.isLoading ? <Skeleton rows={4} /> : !arts.length ? <Empty icon="inbox" title="No articles yet" />
          : <div className="ec-list">{arts.map(a => <Link key={a.id} to={`${b}/knowledge/${a.id}`}><span>{a.title}</span><span className="cell-sub">{a.category}</span></Link>)}</div>}</section></div>
  </>;
}
