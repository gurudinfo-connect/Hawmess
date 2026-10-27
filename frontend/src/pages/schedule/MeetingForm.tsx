import React, { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, getUser } from '../../api';
import { Avatar, ErrorBox, Field, Modal, useDebounced, useToast } from '../../ui';
import { ALERTS, KINDS, alertKey, alertValue, niceDate } from './shared';

/** Schedule or edit a meeting: when, where, who is invited, and the alert. Clashes with the invitees' own schedules are shown as a warning, never as a block. */
export default function MeetingForm({ initial, date, onClose, onSaved }: { initial?: any; date: string; onClose: () => void; onSaved?: (m: any) => void }) {
  const me = getUser(); const qc = useQueryClient(); const toast = useToast(); const edit = !!initial?.id;
  const [f, setF] = useState(() => ({ title: initial?.title || '', kind: initial?.kind || 'meeting', meeting_date: initial?.meeting_date || date, start_time: initial?.start_time || '10:00', end_time: initial?.end_time || '10:30',
    location: initial?.location || '', meeting_link: initial?.meeting_link || '', description: initial?.description || '', is_public: !!initial?.is_public,
    attendee_ids: (initial?.attendees || []).filter((a: any) => a.role === 'invitee' && a.user_id !== me?.id).map((a: any) => a.user_id) as string[], alert: alertKey(initial ? initial.my_alert_minutes : 15) }));
  const [find, setFind] = useState(''); const [err, setErr] = useState<any>(null);
  const set = (k: string) => (e: any) => setF(s => ({ ...s, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const people = useQuery({ queryKey: ['people-lookup'], queryFn: () => api('/users/lookup/all'), staleTime: 300000 });
  const all: any[] = (people.data?.data || []).filter((p: any) => p.id !== me?.id);
  const shown = useMemo(() => all.filter(p => !find.trim() || `${p.name} ${p.department || ''} ${p.designation || ''}`.toLowerCase().includes(find.trim().toLowerCase())), [all, find]);
  const personal = f.kind === 'personal'; const toggle = (id: string) => setF(s => ({ ...s, attendee_ids: s.attendee_ids.includes(id) ? s.attendee_ids.filter(x => x !== id) : [...s.attendee_ids, id] }));
  const slot = useDebounced({ d: f.meeting_date, s: f.start_time, e: f.end_time, a: personal ? [] : f.attendee_ids }, 500);
  const clash = useQuery({ queryKey: ['meet', 'conflicts', slot, initial?.id], enabled: !!slot.d && !!slot.s && !!slot.e && slot.e > slot.s,
    queryFn: () => api('/meetings/conflicts', { method: 'POST', body: { meeting_date: slot.d, start_time: slot.s, end_time: slot.e, attendee_ids: slot.a, exclude: initial?.id } }) });
  const save = useMutation({
    mutationFn: async () => { const r = await api(edit ? `/meetings/${initial.id}` : '/meetings', { method: edit ? 'PUT' : 'POST', body: { title: f.title, kind: f.kind, meeting_date: f.meeting_date, start_time: f.start_time, end_time: f.end_time, location: f.location, meeting_link: f.meeting_link, description: f.description, is_public: personal ? false : f.is_public, attendee_ids: personal ? [] : f.attendee_ids, alert_minutes: alertValue(f.alert) } });
      if (edit && initial.in_my_schedule && alertValue(f.alert) !== (initial.my_alert_minutes ?? null)) return api(`/meetings/${initial.id}/me`, { method: 'PATCH', body: { alert_minutes: alertValue(f.alert) } }).then(() => r);   // the editor's own alert
      return r; },
    onSuccess: m => { qc.invalidateQueries({ queryKey: ['meet'] }); toast(edit ? 'Meeting updated' : personal ? 'Reminder saved to your schedule' : `Meeting scheduled${f.attendee_ids.length ? ' - invitations sent' : ''}`); if (m.conflicts?.length) toast(`Heads up: ${m.conflicts.length} person(s) already have something at this time`, 'error'); onSaved?.(m); onClose(); },
    onError: e => setErr(e),
  });
  return <Modal title={edit ? 'Edit meeting' : 'Schedule a meeting'} onClose={onClose} width={720}
    footer={<><button className="btn" onClick={onClose}>Close</button><button className="btn primary" disabled={save.isPending || !f.title.trim()} onClick={() => { setErr(null); save.mutate(); }}>{save.isPending ? 'Saving…' : edit ? 'Save changes' : personal ? 'Save reminder' : 'Schedule & invite'}</button></>}>
    <ErrorBox error={err} />
    <div className="form two">
      <Field label="Title" req className="full"><input value={f.title} onChange={set('title')} placeholder="e.g. Sprint planning" maxLength={160} autoFocus /></Field>
      <Field label="Type"><select value={f.kind} onChange={set('kind')}>{KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
      <Field label="Date" req hint={f.meeting_date ? niceDate(f.meeting_date) : ''}><input type="date" value={f.meeting_date} onChange={set('meeting_date')} /></Field>
      <Field label="Starts (IST)" req><input type="time" value={f.start_time} onChange={set('start_time')} /></Field>
      <Field label="Ends (IST)" req><input type="time" value={f.end_time} onChange={set('end_time')} /></Field>
      <Field label="Location / room"><input value={f.location} onChange={set('location')} placeholder="Conference room, office, phone…" maxLength={200} /></Field>
      <Field label="Meeting link" hint="Google Meet, Teams, Zoom… (optional)"><input type="url" value={f.meeting_link} onChange={set('meeting_link')} placeholder="https://" /></Field>
      <Field label="Agenda / notes" className="full"><textarea value={f.description} onChange={set('description')} maxLength={4000} /></Field>
      {(!edit || initial.in_my_schedule) && <Field label="Alert me"><select value={f.alert} onChange={set('alert')}>{ALERTS.map(([v, l]) => <option key={l} value={alertKey(v)}>{l}</option>)}</select></Field>}
      {!personal && <Field label="Visibility"><label className="chk"><input type="checkbox" checked={f.is_public} onChange={set('is_public')} />Company-wide - everyone can see it and save it</label></Field>}
    </div>
    {clash.data?.data?.length > 0 && <div className="warnbox" style={{ marginTop: 12 }} role="status"><b>Schedule clash</b> - already booked at this time: {clash.data.data.map((c: any) => `${c.person} (${c.title}, ${c.start_time}-${c.end_time})`).join('; ')}. You can still schedule it.</div>}
    {!personal && <div style={{ marginTop: 14 }}><h4 style={{ margin: '0 0 6px' }}>Invite people <span className="sub">({f.attendee_ids.length} selected)</span></h4>
      <input type="search" placeholder="Search by name, department or designation…" value={find} onChange={e => setFind(e.target.value)} aria-label="Search people" />
      <div className="mt-pick">{people.isLoading && <p className="sub">Loading people…</p>}{shown.map(p => <label key={p.id} className={`mt-pick-i${f.attendee_ids.includes(p.id) ? ' on' : ''}`}><input type="checkbox" checked={f.attendee_ids.includes(p.id)} onChange={() => toggle(p.id)} /><Avatar name={p.name} size="sm" /><span><b>{p.name}</b><span className="sub"> {[p.designation, p.department].filter(Boolean).join(' · ')}</span></span></label>)}{!people.isLoading && !shown.length && <p className="sub">No one matches.</p>}</div></div>}
  </Modal>;
}
