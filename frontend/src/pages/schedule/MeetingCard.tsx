import React, { useEffect, useRef, useState } from 'react';
import { getUser, roleOf } from '../../api';
import { Avatar, Ic } from '../../ui';
import { ALERTS, KIND_COLOR, alertKey, alertValue, kindLabel, t12, useAct } from './shared';

const RESP: Record<string, string> = { accepted: 'Going', declined: 'Declined', tentative: 'Maybe', pending: 'Invited' };

/** One meeting: time, place / link, who is invited, my response, my own alert, and (organizer / admin) edit and cancel. */
export default function MeetingCard({ m, onEdit, focus }: { m: any; onEdit: (m: any) => void; focus?: boolean }) {
  const me = getUser(); const act = useAct(); const [open, setOpen] = useState(!!focus); const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (focus) { setOpen(true); ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }); } }, [focus]);
  const manage = m.organizer_id === me?.id || roleOf() === 'admin'; const cancelled = m.status === 'cancelled'; const mine = !!m.in_my_schedule;
  const invitee = m.my_role === 'invitee';
  return <div ref={ref} className={`mt-card${cancelled ? ' off' : ''}${focus ? ' focus' : ''}`} style={{ ['--c' as any]: KIND_COLOR[m.kind] || 'var(--blue)' }}>
    <button className="mt-head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
      <span className="mt-time"><b>{t12(m.start_time)}</b><span>{t12(m.end_time)}</span></span>
      <span className="mt-main"><b className="mt-title">{m.title}</b>
        <span className="mt-meta">{kindLabel(m.kind)}{m.is_public ? ' · Company-wide' : ''}{m.location ? ` · ${m.location}` : ''} · by {m.organizer_id === me?.id ? 'you' : m.organizer_name}</span></span>
      <span className="mt-badges">{cancelled && <span className="badge b-cancelled">Cancelled</span>}{!cancelled && mine && <span className="badge b-completed" title="In your saved schedule">Saved</span>}{!cancelled && invitee && m.my_response === 'pending' && <span className="badge b-pending">Needs reply</span>}</span>
    </button>
    {open && <div className="mt-body">
      {m.description && <p className="mt-desc">{m.description}</p>}
      {m.meeting_link && <p><a className="btn sm primary" href={m.meeting_link} target="_blank" rel="noopener noreferrer"><Ic n="send" />Join meeting</a> <span className="sub" style={{ wordBreak: 'break-all' }}>{m.meeting_link}</span></p>}
      {m.attendees && <div className="mt-people"><span className="sub">Invited ({m.attendees.length})</span>{m.attendees.map((a: any) => <span className="mt-chip" key={a.user_id} title={RESP[a.response]}><Avatar name={a.name} size="sm" />{a.name}{a.role === 'organizer' ? ' (organizer)' : ''}<i className={`rs rs-${a.response}`}>{RESP[a.response]}</i></span>)}</div>}
      {!cancelled && <div className="mt-actions">
        {invitee && <div className="seg" role="group" aria-label="Your response">{(['accepted', 'tentative', 'declined'] as const).map(r => <button key={r} className={m.my_response === r ? 'on' : ''} onClick={() => act(`/meetings/${m.id}/me`, 'PATCH', { response: r }, r === 'accepted' ? 'You are going' : r === 'declined' ? 'Declined' : 'Marked as maybe')}>{RESP[r]}</button>)}</div>}
        {mine ? <label className="mt-alertsel"><Ic n="bell" /><select aria-label="My alert" value={alertKey(m.my_alert_minutes)} onChange={e => act(`/meetings/${m.id}/me`, 'PATCH', { alert_minutes: alertValue(e.target.value) }, 'Alert updated')}>{ALERTS.map(([v, l]) => <option key={l} value={alertKey(v)}>{l}</option>)}</select></label>
          : <button className="btn sm primary" onClick={() => act(`/meetings/${m.id}/save`, 'POST', { alert_minutes: 15 }, 'Saved to your schedule - alert 15 minutes before')}><Ic n="plus" />Save to my schedule</button>}
        {mine && m.my_role !== 'organizer' && <button className="btn sm" onClick={() => act(`/meetings/${m.id}/save`, 'DELETE', undefined, 'Removed from your schedule')}>Remove</button>}
      </div>}
      {manage && <div className="mt-actions">
        {!cancelled && <button className="btn sm" onClick={() => onEdit(m)}><Ic n="edit" />Edit</button>}
        {!cancelled ? <button className="btn sm" onClick={() => window.confirm('Cancel this meeting? Everyone invited will be told.') && act(`/meetings/${m.id}/cancel`, 'POST', undefined, 'Meeting cancelled')}>Cancel meeting</button>
          : <button className="btn sm" onClick={() => act(`/meetings/${m.id}/restore`, 'POST', undefined, 'Meeting is back on')}>Reinstate</button>}
        <button className="btn sm ghost" onClick={() => window.confirm('Delete this meeting for everyone?') && act(`/meetings/${m.id}`, 'DELETE', undefined, 'Meeting deleted')}><Ic n="trash" />Delete</button></div>}
    </div>}
  </div>;
}
