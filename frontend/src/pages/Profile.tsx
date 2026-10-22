import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, fmtDateTime, getUser, roleLabel, setSession, getToken } from '../api';
import { Avatar, Badge, ErrorBox, Field, PageHead, Skeleton, useToast } from '../ui';
import { setTheme } from '../Shell';

export default function Profile() {
  const toast = useToast(); const qc = useQueryClient(); const q = useQuery({ queryKey: ['me'], queryFn: () => api('/users/me') }); const u = q.data;
  const [f, setF] = useState<any>(null); const [pw, setPw] = useState({ current_password: '', new_password: '', confirm: '' }); const [pwErr, setPwErr] = useState(''); const [err, setErr] = useState('');
  React.useEffect(() => { if (u) setF({ name: u.name, phone: u.phone || '', inapp: u.notif_prefs?.inapp !== false, email: u.notif_prefs?.email !== false, theme: u.theme }); }, [u]);
  if (q.isLoading || !f) return <div className="card"><Skeleton rows={6} /></div>; if (q.error) return <ErrorBox error={q.error} />;
  const save = async (e: React.FormEvent) => { e.preventDefault(); setErr(''); try {
    const r = await api('/users/me', { method: 'PATCH', body: { name: f.name, phone: f.phone || null, notif_prefs: { inapp: f.inapp, email: f.email }, theme: f.theme } }); setTheme(f.theme, false);
    setSession(getToken()!, { ...getUser(), name: r.name, theme: f.theme }); qc.invalidateQueries({ queryKey: ['me'] }); toast('Profile saved'); setTimeout(() => location.reload(), 600); } catch (x: any) { setErr(x.message); } };
  const changePw = async (e: React.FormEvent) => { e.preventDefault(); setPwErr(''); if (pw.new_password !== pw.confirm) return setPwErr('The new passwords do not match'); try { await api('/users/me/password', { method: 'POST', body: { current_password: pw.current_password, new_password: pw.new_password } }); setPw({ current_password: '', new_password: '', confirm: '' }); toast('Password changed'); } catch (x: any) { setPwErr(x.message); } };
  return <><PageHead crumbs={[{ label: 'Profile' }]} title="Profile & settings" sub="Your details, preferences and password" />
    <div className="grid g-main"><div className="grid">
      <form className="card form two" onSubmit={save}><h3 className="full">Personal details</h3>{err && <div className="err full">{err}</div>}
        <Field label="Full name"><input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} required /></Field><Field label="Phone"><input value={f.phone} onChange={e => setF({ ...f, phone: e.target.value })} /></Field>
        <Field label="Email" hint="Managed by your administrator"><input value={u.email} disabled /></Field><Field label="Department / designation" hint="Managed by your administrator"><input value={[u.department, u.designation].filter(Boolean).join(' · ') || '—'} disabled /></Field>
        <h3 className="full" style={{ marginTop: 6 }}>Preferences</h3>
        <Field label="Theme"><select value={f.theme} onChange={e => setF({ ...f, theme: e.target.value })}><option value="light">Light</option><option value="dark">Dark</option></select></Field><div />
        <label className="chk full"><input type="checkbox" checked={f.inapp} onChange={e => setF({ ...f, inapp: e.target.checked })} />Show in-app notifications</label><label className="chk full"><input type="checkbox" checked={f.email} onChange={e => setF({ ...f, email: e.target.checked })} />Send me email notifications (when the company has email configured)</label>
        <div className="full"><button className="btn primary">Save changes</button></div></form>
      <form className="card form" onSubmit={changePw} style={{ maxWidth: 520 }}><h3>Change password</h3>{pwErr && <div className="err" role="alert">{pwErr}</div>}
        <Field label="Current password"><input type="password" autoComplete="current-password" required value={pw.current_password} onChange={e => setPw({ ...pw, current_password: e.target.value })} /></Field><Field label="New password" hint="At least 8 characters with a letter and a number."><input type="password" autoComplete="new-password" required minLength={8} value={pw.new_password} onChange={e => setPw({ ...pw, new_password: e.target.value })} /></Field>
        <Field label="Confirm new password"><input type="password" autoComplete="new-password" required value={pw.confirm} onChange={e => setPw({ ...pw, confirm: e.target.value })} /></Field><div><button className="btn primary">Update password</button></div></form></div>
      <aside className="card" style={{ textAlign: 'center', alignSelf: 'start' }}><Avatar name={u.name} size="lg" /><h3 style={{ marginTop: 10 }}>{u.name}</h3><Badge v="open" text={roleLabel(u.role)} /><dl className="kv" style={{ marginTop: 16, textAlign: 'left' }}><dt>Department</dt><dd>{u.department || '—'}</dd><dt>Designation</dt><dd>{u.designation || '—'}</dd><dt>Last sign-in</dt><dd>{u.last_login_at ? fmtDateTime(u.last_login_at) : '—'}</dd></dl></aside></div></>;
}
