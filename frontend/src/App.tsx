import React from 'react';
import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { getToken, homeFor, roleOf, Role } from './api';
import { ToastProvider } from './ui';
import Shell from './Shell';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Tickets from './pages/Tickets';
import TicketDetail from './pages/TicketDetail';
import Workspace from './pages/Workspace';
import People from './pages/People';
import Projects from './pages/Projects';
import Reports from './pages/Reports';
import Todos from './pages/Todos';
import Configuration from './pages/Configuration';
import ActivityLog from './pages/ActivityLog';
import Notifications from './pages/Notifications';
import Profile from './pages/Profile';
import Chat from './pages/Chat';
import BusinessApps from './pages/BusinessApps';
import ServiceCatalogue from './pages/ServiceCatalogue';
import EmployeeCentre from './pages/EmployeeCentre';
import Knowledge, { KnowledgeArticle, KnowledgeEditor } from './pages/Knowledge';

/** The server enforces every permission; this guard only keeps people on screens that make sense for their role. */
function RoleGate({ role, children }: { role: Role; children: React.ReactNode }) {
  if (!getToken()) return <Navigate to="/login" replace />;
  return roleOf() === role ? <>{children}</> : <Navigate to={homeFor(roleOf())} replace />;
}
function Only({ roles, children }: { roles: Role[]; children: React.ReactNode }) { return roles.includes(roleOf()) ? <>{children}</> : <Navigate to={homeFor(roleOf())} replace />; }

const RoleRoutes = ({ role }: { role: Role }) => (
  <Route path={`/${role}`} element={<RoleGate role={role}><Shell /></RoleGate>}>
    <Route index element={<Navigate to="dashboard" replace />} />
    <Route path="dashboard" element={<Dashboard />} />
    <Route path="tickets" element={<Tickets />} />
    <Route path="tickets/:id" element={<TicketDetail />} />
    <Route path="workspace" element={<Workspace />} />
    <Route path="business-applications" element={<BusinessApps />} />
    <Route path="service-catalogue" element={<ServiceCatalogue />} />
    <Route path="employee-centre" element={<EmployeeCentre />} />
    <Route path="knowledge" element={<Knowledge />} />
    {role !== 'employee' && <Route path="knowledge/new" element={<KnowledgeEditor />} />}
    <Route path="knowledge/:id" element={<KnowledgeArticle />} />
    {role !== 'employee' && <Route path="knowledge/:id/edit" element={<KnowledgeEditor />} />}
    <Route path="projects" element={<Projects />} />
    <Route path="projects/:id" element={<Projects />} />
    <Route path="reports" element={<Reports />} />
    <Route path="todos" element={<Todos />} />
    <Route path="notifications" element={<Notifications />} />
    <Route path="chat" element={<Chat />} />
    <Route path="profile" element={<Profile />} />
    {role !== 'employee' && <Route path="people" element={<People />} />}
    {role !== 'employee' && <Route path="people/:id" element={<People />} />}
    {role !== 'employee' && <Route path="activity-log" element={<ActivityLog />} />}
    {role === 'admin' && <Route path="configuration" element={<Configuration />} />}
    <Route path="*" element={<Navigate to="dashboard" replace />} />
  </Route>
);
function ProfileRedirect() { return getToken() ? <Navigate to={`/${roleOf()}/profile`} replace /> : <Navigate to="/login" replace />; }

export default function App() {
  return <ToastProvider><Routes>
    <Route path="/login" element={<Login />} />
    <Route path="/profile" element={<ProfileRedirect />} />
    {RoleRoutes({ role: 'admin' })}{RoleRoutes({ role: 'hr' })}{RoleRoutes({ role: 'employee' })}
    <Route path="*" element={<Navigate to={getToken() ? homeFor(roleOf()) : '/login'} replace />} />
  </Routes></ToastProvider>;
}
