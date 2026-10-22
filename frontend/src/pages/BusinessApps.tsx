import React from 'react';
import { Link } from 'react-router-dom';
import { baseFor, roleOf } from '../api';
import { Ic, PageHead } from '../ui';

export default function BusinessApps() {
  const role = roleOf(); const b = baseFor(role); const staff = role !== 'employee';
  const apps: { title: string; desc: string; to: string; icon: string; show?: boolean }[] = [
    { title: 'Incidents', desc: 'Report and track things that are broken', to: `${b}/tickets?type=incident`, icon: 'alert' },
    { title: 'Service requests', desc: 'Ask for access, equipment or services', to: `${b}/tickets?type=service_request`, icon: 'ticket' },
    { title: 'Questions', desc: 'Ask the helpdesk for guidance', to: `${b}/tickets?type=question`, icon: 'chat' },
    { title: 'Changes', desc: 'Plan and track changes', to: `${b}/tickets?type=change`, icon: 'refresh' },
    { title: 'All tickets', desc: 'Every ticket of every type', to: `${b}/tickets`, icon: 'list' },
    { title: 'Visual task boards', desc: 'Board view of tickets by status', to: `${b}/tickets?mode=kanban`, icon: 'grid' },
    { title: 'Workspace', desc: 'Everything you are involved in', to: `${b}/workspace`, icon: 'folder' },
    { title: 'Projects', desc: staff ? 'Project list, ongoing and completed' : 'Projects you are part of', to: `${b}/projects`, icon: 'folder' },
    { title: 'To-do', desc: 'Tasks, approvals and leave requests', to: `${b}/todos`, icon: 'todo' },
    { title: 'Reports', desc: 'Helpdesk and workload reports', to: `${b}/reports`, icon: 'chart' },
    { title: 'People', desc: 'Employees, HR team and administrators', to: `${b}/people`, icon: 'users', show: staff },
    { title: 'Messages', desc: 'Chat with your colleagues', to: `${b}/chat`, icon: 'chat' },
    { title: 'Knowledge', desc: 'Self-help articles', to: `${b}/knowledge`, icon: 'inbox' },
    { title: 'Service catalogue', desc: 'Browse and request services', to: `${b}/service-catalogue`, icon: 'building' },
    { title: 'Activity log', desc: 'Audit trail of changes', to: `${b}/activity-log`, icon: 'activity', show: staff },
    { title: 'Configuration', desc: 'Categories, teams, SLA and branding', to: `${b}/configuration`, icon: 'settings', show: role === 'admin' },
  ];
  return <>
    <PageHead crumbs={[{ label: 'Self service' }, { label: 'Business applications' }]} title="Business applications" sub="Every application you can use, in one place" />
    <div className="tiles">{apps.filter(a => a.show !== false).map(a => <Link key={a.title} to={a.to} className="tile"><div className="tile-ic"><Ic n={a.icon} /></div><h3>{a.title}</h3><p>{a.desc}</p></Link>)}</div>
  </>;
}
