import React, { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { baseFor, roleOf } from '../../api';
import { Ic } from '../../ui';
import { shortDate, t12, useAct } from './shared';

const when = (a: any) => (a.minutes_to_start > 0 ? `Starts in ${a.minutes_to_start} min` : a.minutes_to_start >= -1 ? 'Starting now' : 'In progress');

/** Meeting alerts that are due right now (the server decides, from each person's own alert setting). Shown on every screen until dismissed or snoozed; also as a desktop notification when allowed. */
export default function MeetingAlerts({ alerts }: { alerts?: any[] }) {
  const nav = useNavigate(); const base = baseFor(roleOf()); const act = useAct(); const shown = useRef(new Set<string>());
  useEffect(() => {
    const keys = new Set((alerts || []).map(a => `${a.id}|${a.meeting_date}|${a.start_time}|${a.my_alert_minutes}`));
    for (const k of [...shown.current]) if (!keys.has(k)) shown.current.delete(k);   // snoozed / dismissed alerts can notify again when they come back
    for (const a of alerts || []) {
      const k = `${a.id}|${a.meeting_date}|${a.start_time}|${a.my_alert_minutes}`; if (shown.current.has(k)) continue; shown.current.add(k);
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') { try { new Notification(`${when(a)}: ${a.title}`, { body: `${t12(a.start_time)}${a.location ? ` · ${a.location}` : ''}`, tag: k }); } catch { /* some browsers only allow it from a service worker */ } }
    }
  }, [alerts]);
  if (!alerts?.length) return null;
  return <div className="mt-alerts" role="alert" aria-live="assertive">{alerts.slice(0, 4).map(a => <div className="mt-alert" key={a.id}>
    <div className="mt-alert-i"><Ic n="bell" /></div>
    <div className="mt-alert-b"><b>{a.title}</b><span>{when(a)} · {shortDate(a.meeting_date)}, {t12(a.start_time)}{a.location ? ` · ${a.location}` : ''}</span>
      <div className="mt-alert-a">
        {a.meeting_link && <a className="btn sm primary" href={a.meeting_link} target="_blank" rel="noopener noreferrer">Join</a>}
        <button className="btn sm" onClick={() => nav(`${base}/schedule?meeting=${a.id}`)}>Open</button>
        <button className="btn sm" onClick={() => act(`/meetings/${a.id}/alerts/snooze`, 'POST', { minutes: 5 })}>Snooze 5 min</button>
        <button className="btn sm ghost" onClick={() => act(`/meetings/${a.id}/alerts/dismiss`, 'POST')}>Dismiss</button></div></div></div>)}
    {alerts.length > 4 && <div className="mt-more">+{alerts.length - 4} more alerts</div>}</div>;
}
