import React, { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { api, getToken, homeFor, roleOf, setSession } from '../api';
import { Ic } from '../ui';

const FEED = [
  { id: 'HW-1042', t: 'Laptop will not boot', who: 'IT Support', d: 0 },
  { id: 'HW-1043', t: 'Leave balance mismatch', who: 'HR Desk', d: -3 },
  { id: 'HW-1044', t: 'VPN access request', who: 'Admin', d: -6 },
];
const STAGES = ['Raised', 'Assigned', 'In progress', 'Resolved'];

/** Floating "live desk" card: counting stats + a new-ticket pop-up that rings the bell. */
function LiveDesk() {
  return <div className="live" aria-hidden="true">
    <div className="live-h"><span className="pulse" /> Live desk <svg className="bell" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 01-3.4 0" /></svg></div>
    <div className="live-s"><div><b className="cnt c-open-n" /><small>Open tickets</small></div><div><b className="cnt c-sla-n" /><small>SLA met</small></div><div><b className="cnt c-res-n" /><small>Resolved</small></div></div>
    <div className="toast-new"><span className="tn-ic">+</span><span><b>New ticket · HW-1045</b><small>Printer offline · 3rd floor</small></span></div>
  </div>;
}

/** Decorative, looping ticket-lifecycle animation (pure CSS, hidden from assistive tech). */
function TicketFlow({ compact }: { compact?: boolean }) {
  return <div className="tflow" aria-hidden="true">
    <div className="flow"><div className="flow-line"><i /></div>
      {STAGES.map((s, i) => <span key={s} className={`node n${i}`} style={{ left: `${i * 33.333}%` }}><b />{s}</span>)}
      <span className="flow-ticket"><u /><u /><u /></span></div>
    {!compact && <div className="feed">{FEED.map(f => <div key={f.id} className="fcard" style={{ animationDelay: `${f.d / 2}s` }}>
      <div className="fc-top"><b>{f.id}</b><span className="chips" style={{ ['--d' as any]: `${f.d}s` }}><em className="c-open">Open</em><em className="c-prog">In progress</em><em className="c-done">Resolved</em></span></div>
      <div className="fc-t">{f.t}</div><div className="fc-b"><small>{f.who}</small><span className="fsla"><i style={{ ['--d' as any]: `${f.d}s` }} /></span></div></div>)}</div>}
  </div>;
}
import { setTheme } from '../Shell';

export default function Login() {
  const nav = useNavigate(); const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  if (getToken()) return <Navigate to={homeFor(roleOf())} replace />;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try { const r = await api('/auth/login', { method: 'POST', body: { email, password } }); setSession(r.token, r.user); if (r.user.theme && !localStorage.getItem('hawmess_theme')) setTheme(r.user.theme, false); nav(r.user.home, { replace: true }); }
    catch (x: any) { setErr(x.message); } finally { setBusy(false); }
  };
  return <div className="login-wrap">
    <section className="login-art"><LiveDesk /><div className="bgt" aria-hidden="true">{[0,1,2,3,4,5].map(i => <span key={i} className={`bt bt${i}`} />)}</div><div className="lg"><img src="/hawmess-logo.png" alt="Hawmess - All your tickets, in one place" /></div>
      <div style={{ position: "relative", zIndex: 1 }}><h2>All your tickets, in one place.</h2><ul style={{ listStyle: 'none', padding: 0, marginTop: 22 }}>
        {['Raise and track support requests with live SLA clocks', 'Assign, escalate and resolve with a full audit trail', 'Chat with HR and admins without leaving the desk', 'Tasks, projects and leave requests alongside your tickets'].map(t => <li key={t}><Ic n="check" /> &nbsp;{t}</li>)}</ul><TicketFlow /></div>
      <small style={{ color: '#9fb4d3' }}>© Hawmess Helpdesk</small></section>
    <section className="login-form"><div className="m-flow"><TicketFlow compact /></div><form className="card form" onSubmit={submit} aria-label="Sign in">
      <div><img className="login-mark" src="/hawmess-logo-nav.png" alt="Hawmess" /><h1 style={{ fontSize: 26 }}>Welcome back</h1><p className="sub">Sign in to your Hawmess workspace</p></div>
      {err && <div className="err" role="alert">{err}</div>}
      <label>Email<input type="email" required autoFocus autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@company.com" /></label>
      <label>Password<input type="password" required autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} /></label>
      <button className="btn primary" style={{ justifyContent: 'center', padding: '10px' }} disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
    </form></section></div>;
}
