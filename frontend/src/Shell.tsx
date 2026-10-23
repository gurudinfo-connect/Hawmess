import React, { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ago, baseFor, clearSession, getUser, Role, roleLabel, roleOf } from './api';
import { Avatar, Ic, useDebounced } from './ui';

type Child = { label: string; to?: string; icon?: string; badge?: number; heading?: boolean; hint?: boolean; divider?: boolean };
type Item = { label: string; to?: string; icon?: string; badge?: number; children?: Child[]; active?: (path: string, sp: URLSearchParams) => boolean };
const clip = (x: string, n = 38) => (x.length > n ? `${x.slice(0, n - 1)}…` : x);

/** Top row: Dashboard · Visual task boards · Incidents ▾ · Favorites ▾ · Workspace.  Everything else lives in the "more" (hamburger) menu. */
function menu(role: Role, nv: any = {}): { left: Item[]; more: Item[] } {
  const b = baseFor(role); const staff = role !== 'employee';
  const inc = (q = '') => `${b}/tickets?type=incident${q ? `&${q}` : ''}`;
  const t = (q: string) => `${b}/tickets${q}`;
  const onTickets = (p: string) => p === `${b}/tickets`;
  const dash: Item = { label: 'Dashboard', to: `${b}/dashboard`, icon: 'dashboard' };

  const boards: Item = { label: 'Visual task boards', to: t('?mode=kanban'), active: (p, sp) => onTickets(p) && sp.get('mode') === 'kanban' };
  const incidents: Item = { label: 'Incidents', icon: 'alert', active: (p, sp) => onTickets(p) && sp.get('type') === 'incident' && sp.get('mode') !== 'kanban',
    children: staff
      ? [{ label: 'Report an incident', to: inc('new=1'), icon: 'plus' }, { label: 'All incidents', to: inc() }, { label: 'Open', to: inc('view=open'), badge: nv.incidents_open }, { label: 'Unassigned', to: inc('view=unassigned') }, { label: 'Assigned to me', to: inc('view=mine') },
         { label: 'In progress', to: inc('status=in_progress') }, { label: 'Pending', to: inc('status=pending') }, { label: 'Escalated', to: inc('view=escalated'), badge: nv.incidents_escalated }, { label: 'SLA breached', to: inc('view=breached') },
         { label: 'Resolved', to: inc('status=resolved') }, { label: 'Closed', to: inc('status=closed') }]
      : [{ label: 'Report an incident', to: inc('new=1'), icon: 'plus' }, { label: 'My incidents', to: inc() }, { label: 'Open', to: inc('view=open'), badge: nv.incidents_open }, { label: 'In progress', to: inc('status=in_progress') },
         { label: 'Pending (needs me)', to: inc('status=pending') }, { label: 'Resolved', to: inc('status=resolved') }, { label: 'Closed', to: inc('status=closed') }] };

  const starred: Child[] = (nv.favorite_tickets || []).map((x: any) => ({ label: `${x.ticket_no} · ${clip(x.subject)}`, to: `${b}/tickets/${x.id}`, icon: 'ticket' }));
  const favorites: Item = { label: 'Favorites', icon: 'star', active: (p, sp) => onTickets(p) && ['favorites', 'watching'].includes(sp.get('view') || ''),
    children: [{ label: 'Starred tickets', to: t('?view=favorites'), icon: 'star', badge: nv.favorites }, { label: 'Tickets I am watching', to: t('?view=watching'), icon: 'eye', badge: nv.watching },
      { label: 'Quick access', heading: true }, ...(starred.length ? starred : [{ label: 'Star a ticket (☆) to pin it here.', hint: true }])] };

  const workspace: Item = { label: 'Workspace', icon: 'folder', to: `${b}/workspace`, badge: nv.ws_open };   // every ticket I am involved in

  // ---- hamburger menu: the rest of the app ----
  const people: Item = { label: 'People', icon: 'users', children: role === 'admin' ? [{ label: 'Employees', to: `${b}/people?role=employee` }, { label: 'HR team', to: `${b}/people?role=hr` }, { label: 'Administrators', to: `${b}/people?role=admin` }, { label: 'All people', to: `${b}/people` }] : [{ label: 'Employee directory', to: `${b}/people?role=employee` }, { label: 'HR team', to: `${b}/people?role=hr` }] };
  const projects: Item = role === 'employee' ? { label: 'Projects', icon: 'folder', children: [{ label: 'My projects', to: `${b}/projects` }, { label: 'Ongoing', to: `${b}/projects?status=ongoing` }] } : { label: 'Projects', icon: 'folder', children: [{ label: 'Project list', to: `${b}/projects` }, { label: 'Ongoing projects', to: `${b}/projects?status=ongoing` }, { label: 'Completed projects', to: `${b}/projects?status=completed` }, { label: 'Project reports', to: `${b}/reports?r=projects` }] };
  const reports: Item = { label: 'Reports', icon: 'chart', to: `${b}/reports` };
  const todo: Item = { label: 'To-do', icon: 'todo', children: role === 'admin' ? [{ label: 'All tasks', to: `${b}/todos?view=all` }, { label: 'My tasks', to: `${b}/todos?view=mine` }, { label: 'Team tasks', to: `${b}/todos?view=team` }, { label: 'Overdue', to: `${b}/todos?view=overdue` }, { label: 'Pending approvals', to: `${b}/todos?tab=requests&status=pending` }, { label: 'Leave & requests', to: `${b}/todos?tab=requests` }]
    : role === 'hr' ? [{ label: 'My tasks', to: `${b}/todos?view=mine` }, { label: 'Team tasks', to: `${b}/todos?view=team` }, { label: 'Pending HR requests', to: `${b}/todos?tab=requests&status=pending` }, { label: 'Leave requests', to: `${b}/todos?tab=requests&type=leave` }, { label: 'Overdue', to: `${b}/todos?view=overdue` }]
    : [{ label: 'My tasks', to: `${b}/todos?view=mine` }, { label: 'Overdue', to: `${b}/todos?view=overdue` }, { label: 'Completed', to: `${b}/todos?view=completed` }, { label: 'My requests & leave', to: `${b}/todos?tab=requests` }] };
  const tickets: Item = { label: 'All tickets (every type)', icon: 'ticket', children: role === 'employee'
    ? [{ label: 'Create a ticket', to: t('?new=1'), icon: 'plus' }, { label: 'My tickets', to: t('') }, { label: 'Service requests', to: t('?type=service_request') }, { label: 'Questions', to: t('?type=question') }, { label: 'Changes', to: t('?type=change') }]
    : [{ label: 'New ticket', to: t('?new=1'), icon: 'plus' }, { label: 'All tickets', to: t('') }, { label: 'Service requests', to: t('?type=service_request') }, { label: 'Questions', to: t('?type=question') }, { label: 'Changes', to: t('?type=change') }, { label: 'Board by status', to: t('?mode=kanban') }] };
  const config: Item[] = role === 'admin' ? [{ label: 'Configuration', to: `${b}/configuration`, icon: 'settings' }, { label: 'Activity log', to: `${b}/activity-log`, icon: 'activity' }] : role === 'hr' ? [{ label: 'Activity log', to: `${b}/activity-log`, icon: 'activity' }] : [];
  // ---- hamburger menu: "All" -> Self service / Incidents (structure requested by the business) ----
  const SS = (x: string): Child => ({ label: x, heading: true });
  const sep: Child = { label: '', divider: true };
  const all: Item = { label: 'All', icon: 'menu', children: [
    SS('Self service'),
    { label: 'My requests', to: t('?type=service_request&view=requested') },
    { label: 'Business applications', to: `${b}/business-applications` }, { label: 'Dashboards', to: `${b}/dashboard` }, { label: 'Service catalogue', to: `${b}/service-catalogue` },
    { label: 'Employee centre', to: `${b}/employee-centre` }, { label: 'Knowledge', to: `${b}/knowledge` },
    sep,
    { label: 'Requested items', to: t('?type=service_request') }, { label: 'Watched requested items', to: t('?type=service_request&view=watching') },
  ] };
  const more = [all];
  return { left: [dash, boards, incidents, favorites, workspace], more };
}

function GlobalSearch({ base }: { base: string }) {
  const [q, setQ] = useState(''); const d = useDebounced(q, 250); const nav = useNavigate(); const [open, setOpen] = useState(false); const box = useRef<HTMLDivElement>(null);
  const r = useQuery({ queryKey: ['gsearch', d], queryFn: () => api(`/search?q=${encodeURIComponent(d)}`), enabled: d.trim().length >= 2 });
  useEffect(() => { const h = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); }; document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h); }, []);
  const go = (to: string) => { setOpen(false); setQ(''); nav(to); };
  const sec = (title: string, items: any[], to: (x: any) => string, text: (x: any) => React.ReactNode, side: (x: any) => string) => items?.length ? <><h5>{title}</h5>{items.map(x => <a key={x.id} href={to(x)} onClick={e => { e.preventDefault(); go(to(x)); }}><span>{text(x)}</span><small style={{ color: 'var(--muted)' }}>{side(x)}</small></a>)}</> : null;
  const none = r.data && !['tickets', 'people', 'projects', 'tasks'].some(k => r.data[k]?.length);
  return <div className="gsearch" ref={box} role="search"><Ic n="search" /><input type="search" placeholder="Search tickets, people, projects…" aria-label="Global search" value={q} onChange={e => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onKeyDown={e => e.key === 'Escape' && setOpen(false)} />
    {open && d.trim().length >= 2 && <div className="gs-res">
      {r.isLoading && <p className="sub" style={{ padding: 10 }}>Searching…</p>}{none && <p className="sub" style={{ padding: 10 }}>No results for “{d}”</p>}
      {sec('Tickets', r.data?.tickets, x => `${base}/tickets/${x.id}`, x => <><b>{x.ticket_no}</b> {x.subject}</>, x => x.status.replace('_', ' '))}
      {sec('People', r.data?.people, x => (base === '/employee' ? `${base}/chat?user=${x.id}` : `${base}/people/${x.id}`), x => x.name, x => x.role)}
      {sec('Projects', r.data?.projects, x => `${base}/projects/${x.id}`, x => <><b>{x.code}</b> {x.name}</>, x => x.status)}
      {sec('Tasks', r.data?.tasks, () => `${base}/todos`, x => x.title, x => x.status.replace('_', ' '))}</div>}</div>;
}

function Notifications({ base }: { base: string }) {
  const [open, setOpen] = useState(false); const nav = useNavigate(); const qc = useQueryClient(); const box = useRef<HTMLDivElement>(null);
  const q = useQuery({ queryKey: ['notifs'], queryFn: () => api('/notifications?pageSize=8'), refetchInterval: 20000 });
  useEffect(() => { const h = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); }; document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h); }, []);
  const target = (n: any) => n.entity_type === 'ticket' ? `${base}/tickets/${n.entity_id}` : n.entity_type === 'project' ? `${base}/projects/${n.entity_id}` : n.entity_type === 'task' ? `${base}/todos` : n.entity_type === 'employee_request' ? `${base}/todos?tab=requests` : `${base}/notifications`;
  const click = async (n: any) => { setOpen(false); if (!n.is_read) { await api(`/notifications/${n.id}/read`, { method: 'POST' }).catch(() => {}); qc.invalidateQueries({ queryKey: ['notifs'] }); } nav(target(n)); };
  const unread = q.data?.unread || 0;
  return <div className="nav-item" ref={box}><button className="tool" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} aria-expanded={open} onClick={() => setOpen(o => !o)}><Ic n="bell" />{unread > 0 && <span className="dot">{unread > 99 ? '99+' : unread}</span>}</button>
    <div className={`dd notif-pop ${open ? 'open' : ''}`} style={{ display: open ? 'block' : 'none' }}><header><span>Notifications</span><button className="btn sm" style={{ width: 'auto' }} onClick={async () => { await api('/notifications/read-all', { method: 'POST' }); qc.invalidateQueries({ queryKey: ['notifs'] }); }}>Mark all read</button></header>
      {!q.data?.data?.length && <p className="sub" style={{ padding: 18, textAlign: 'center' }}>You're all caught up</p>}
      {q.data?.data?.map((n: any) => <a key={n.id} href={target(n)} onClick={e => { e.preventDefault(); click(n); }} style={{ background: n.is_read ? undefined : 'var(--sel)' }}><b style={{ display: 'block' }}>{n.title}</b>{n.message && <span style={{ color: 'var(--muted)', fontSize: 13 }}>{n.message.slice(0, 90)}</span>}<small style={{ display: 'block', color: 'var(--muted)' }}>{ago(n.created_at)}</small></a>)}
      <Link to={`${base}/notifications`} onClick={() => setOpen(false)} style={{ textAlign: 'center', justifyContent: 'center', fontWeight: 600 }}>View all notifications</Link></div></div>;
}

export function setTheme(t: 'light' | 'dark', persist = true) { document.documentElement.dataset.theme = t; localStorage.setItem('hawmess_theme', t); if (persist) api('/users/me', { method: 'PATCH', body: { theme: t } }).catch(() => {}); }

export default function Shell() {
  const role = roleOf(); const base = baseFor(role); const user = getUser(); const loc = useLocation(); const nav = useNavigate();
  const [open, setOpen] = useState(false); const [pm, setPm] = useState(false); const [mm, setMm] = useState(false); const mbox = useRef<HTMLDivElement>(null); const [theme, setT] = useState<'light' | 'dark'>((document.documentElement.dataset.theme as any) || 'light'); const pbox = useRef<HTMLDivElement>(null);
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api('/config/settings'), staleTime: 300000 });
  useEffect(() => { const b = settings.data?.branding; if (b?.primary_color) { const r = document.documentElement.style; r.setProperty('--primary', b.primary_color); r.setProperty('--primary-h', b.primary_color); r.setProperty('--orange', b.primary_color); if (b.accent_color) r.setProperty('--amber', b.accent_color); } }, [settings.data]);
  const navq = useQuery({ queryKey: ['ticket-nav'], queryFn: () => api('/tickets/nav'), refetchInterval: 30000 });
  const { left, more } = menu(role, navq.data || {}); const chat = useQuery({ queryKey: ['chat-unread'], queryFn: () => api('/chat/unread'), refetchInterval: 8000 });
  useEffect(() => { setOpen(false); setPm(false); setMm(false); window.scrollTo(0, 0); }, [loc.pathname, loc.search]);
  useEffect(() => { const h = (e: MouseEvent) => { if (!pbox.current?.contains(e.target as Node)) setPm(false); if (!mbox.current?.contains(e.target as Node)) setMm(false); }; document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h); }, []);
  useEffect(() => { if (user?.theme && !localStorage.getItem('hawmess_theme')) { setTheme(user.theme, false); setT(user.theme); } }, []);   // eslint-disable-line
  const toggle = () => { const n = theme === 'dark' ? 'light' : 'dark'; setT(n); setTheme(n); };
  const logout = async () => { await api('/auth/logout', { method: 'POST' }).catch(() => {}); clearSession(); nav('/login'); };
  const [sp] = useSearchParams();
  const isActive = (it: Item) => it.active ? it.active(loc.pathname, sp) : it.to ? loc.pathname.startsWith(it.to.split('?')[0]) : false;
  const badge = (n?: number) => n ? <span className="nbadge">{n > 99 ? '99+' : n}</span> : null;
  const child = (c: Child, i: number) => c.divider ? <div key={i} className="dd-sep" /> : c.heading ? <div key={i} className="dd-h">{c.label}</div> : c.hint ? <div key={i} className="dd-hint">{c.label}</div>
    : <Link key={`${c.label}${i}`} to={c.to!} title={c.label}>{c.icon && <Ic n={c.icon} />}<span className="dd-t">{c.label}</span>{badge(c.badge)}</Link>;
  const render = (it: Item) => it.children ? (
    <div className="nav-item" key={it.label}><button className={`nav-link ${isActive(it) ? 'active' : ''}`} aria-haspopup="true"><Ic n={it.icon || 'dashboard'} />{it.label}<Ic n="down" /></button>
      <div className="dd">{it.children.map(child)}</div></div>
  ) : <NavLink key={it.label} to={it.to!} className={`nav-link ${isActive(it) ? 'active' : ''}`}><Ic n={it.icon || 'dashboard'} />{it.label}{badge(it.badge)}</NavLink>;
  return <>
    <a className="skip" href="#main">Skip to content</a>
    <header className={`nav ${open ? 'open' : ''}`}>
      <nav className="nav-l" aria-label="Main">{left.map(render)}
        {more.map(it => <div className="m-only" key={it.label}>{render(it)}</div>)}</nav>
      <div className="nav-r">
        <GlobalSearch base={base} />
        <Link to={`${base}/chat`} className="tool" aria-label={`Messages${chat.data?.unread ? `, ${chat.data.unread} unread` : ''}`}><Ic n="chat" />{chat.data?.unread > 0 && <span className="dot">{chat.data.unread}</span>}</Link>
        <Notifications base={base} />
        <button className="tool" onClick={toggle} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} title="Theme"><Ic n={theme === 'dark' ? 'sun' : 'moon'} /></button>
        <div className="nav-item" ref={pbox}><button className="tool tool-user" aria-label="Profile menu" aria-expanded={pm} onClick={() => setPm(o => !o)}><span className="u-name">{user?.name}</span><span className="u-role">{roleLabel(role)}</span></button>
          <div className="dd" style={{ display: pm ? 'block' : 'none', minWidth: 240 }}>
            <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', marginBottom: 4 }}><b>{user?.name}</b><div className="cell-sub">{user?.email}</div><span className="role-chip" style={{ marginTop: 6, display: 'inline-block' }}>{roleLabel(role)}</span></div>
            <Link to={`${base}/profile`}><Ic n="user" />Profile & settings</Link><Link to={`${base}/notifications`}><Ic n="bell" />Notifications</Link><button onClick={logout}><Ic n="logout" />Sign out</button></div></div>
        <Link to={`${base}/dashboard`} className="brand" aria-label="Hawmess home"><img src="/hawmess-logo-nav.png" alt="Hawmess" /></Link>
        <div className="nav-item more" ref={mbox}><button className="tool tool-menu" aria-label="More" aria-haspopup="true" aria-expanded={mm} onClick={() => setMm(o => !o)}><Ic n={mm ? 'x' : 'menu'} /><span>Menu</span></button>
          <div className="dd more-panel" style={{ display: mm ? 'block' : 'none' }}>
            {more.map(it => it.children ? <div key={it.label} className="mgroup"><div className="dd-h"><Ic n={it.icon || 'dashboard'} />{it.label}</div>{it.children.map(child)}</div>
              : <Link key={it.label} to={it.to!} className="mtop"><Ic n={it.icon || 'dashboard'} /><span className="dd-t">{it.label}</span></Link>)}
            <div className="mgroup"><Link to={role === 'employee' ? `${base}/chat` : `${base}/people?role=employee`}><Ic n="users" />All Employees</Link><Link to={`${base}/reports`}><Ic n="chart" />Resource & Data</Link><Link to={`${base}/profile`}><Ic n="user" />Profile & settings</Link><button onClick={logout}><Ic n="logout" />Sign out</button></div></div></div>
        <button className="tool burger" aria-label="Menu" aria-expanded={open} onClick={() => setOpen(o => !o)}><Ic n={open ? 'x' : 'menu'} /></button>
      </div>
    </header>
    <main id="main" className="page"><Outlet /></main>
  </>;
}
