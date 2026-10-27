import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { Empty, ErrorBox, Ic, PageHead, Skeleton } from '../../ui';
import MeetingCard from './MeetingCard';
import MeetingForm from './MeetingForm';
import { DOW, KIND_COLOR, MONTHS, niceDate, parseYmd, shortDate, t12, todayYmd, ymd } from './shared';

/** Desktop alerts need the browser's permission once; the in-app banner and bell work without it. */
function DesktopAlerts() {
  const [perm, setPerm] = useState<string>(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  if (perm === 'unsupported') return null;
  if (perm === 'granted') return <span className="badge b-completed"><Ic n="bell" />Desktop alerts on</span>;
  if (perm === 'denied') return <span className="sub" title="Allow notifications for this site in your browser settings">Desktop alerts are blocked in this browser</span>;
  return <button className="btn sm" onClick={() => Notification.requestPermission().then(setPerm)}><Ic n="bell" />Turn on desktop alerts</button>;
}

export default function Schedule() {
  const [sp, setSp] = useSearchParams(); const view = sp.get('view') === 'agenda' ? 'agenda' : sp.get('view') === 'past' ? 'past' : 'calendar';
  const today = todayYmd(); const focusId = sp.get('meeting') || '';
  const [sel, setSel] = useState(() => { const d = sp.get('date'); return d === 'today' || !d ? today : /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : today; });
  const [scope, setScope] = useState<'mine' | 'all'>('mine'); const [form, setForm] = useState<{ m?: any; date: string } | null>(() => (sp.get('new') === '1' ? { date: sel } : null));
  const selD = parseYmd(sel); const y = selD.getFullYear(), mo = selD.getMonth();
  useEffect(() => { if (sp.get('new') === '1' || sp.get('date')) { const n = new URLSearchParams(sp); n.delete('new'); n.delete('date'); setSp(n, { replace: true }); } }, []);   // eslint-disable-line

  // the 6-week grid that contains the selected month, Monday first
  const cells = useMemo(() => { const first = new Date(y, mo, 1); const start = new Date(y, mo, 1 - ((first.getDay() + 6) % 7)); return Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; }); }, [y, mo]);
  const from = ymd(cells[0]), to = ymd(cells[41]);
  const range = useQuery({ queryKey: ['meet', 'range', from, to, scope], queryFn: () => api(`/meetings?from=${from}&to=${to}&scope=${scope}`), placeholderData: p => p, enabled: view === 'calendar', refetchInterval: 60000 });
  const agenda = useQuery({ queryKey: ['meet', 'agenda', view], queryFn: () => api(`/meetings/agenda${view === 'past' ? '?past=1' : ''}`), enabled: view !== 'calendar', refetchInterval: 60000 });
  const focus = useQuery({ queryKey: ['meet', 'one', focusId], queryFn: () => api(`/meetings/${focusId}`), enabled: !!focusId, retry: false });
  useEffect(() => { if (focus.data?.meeting_date) { setSel(focus.data.meeting_date); if (view !== 'calendar') { const n = new URLSearchParams(sp); n.delete('view'); setSp(n, { replace: true }); } } }, [focus.data?.id]);   // eslint-disable-line

  const byDay = useMemo(() => { const m = new Map<string, any[]>(); for (const x of range.data?.data || []) (m.get(x.meeting_date) || m.set(x.meeting_date, []).get(x.meeting_date)!).push(x); return m; }, [range.data]);
  const day = byDay.get(sel) || []; const go = (d: Date) => setSel(ymd(d)); const monthStep = (n: number) => go(new Date(y, mo + n, 1));
  const setView = (v: string) => { const n = new URLSearchParams(); if (v !== 'calendar') n.set('view', v); setSp(n); };
  const open = (date: string, m?: any) => setForm({ date, m });
  const grouped = useMemo(() => { const g = new Map<string, any[]>(); for (const x of agenda.data?.data || []) (g.get(x.meeting_date) || g.set(x.meeting_date, []).get(x.meeting_date)!).push(x); return [...g.entries()]; }, [agenda.data]);

  return <div className="mt-theme"><PageHead crumbs={[{ label: 'Schedule' }]} title="Schedule" sub="Plan meetings, invite people, keep your own schedule and get alerted before it starts">
      <DesktopAlerts /><button className="btn primary" onClick={() => open(view === 'calendar' ? sel : today)}><Ic n="plus" />Schedule a meeting</button></PageHead>
    <div className="seg mt-views" role="tablist" aria-label="Schedule views">{([['calendar', 'Calendar'], ['agenda', 'My saved schedule'], ['past', 'Past meetings']] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={view === k} className={view === k ? 'on' : ''} onClick={() => setView(k)}>{l}</button>)}</div>

    {view === 'calendar' ? <div className="mt-layout">
      <div className="card mt-cal">
        <header className="mt-cal-h"><button className="btn sm" aria-label="Previous month" onClick={() => monthStep(-1)}><Ic n="down" className="rot90" /></button><h2>{MONTHS[mo]} {y}</h2><button className="btn sm" aria-label="Next month" onClick={() => monthStep(1)}><Ic n="down" className="rot-90" /></button>
          <button className="btn sm" onClick={() => setSel(today)}>Today</button><div className="sp" />
          <div className="seg" role="group" aria-label="Which meetings"><button className={scope === 'mine' ? 'on' : ''} onClick={() => setScope('mine')}>My schedule</button><button className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>All visible</button></div></header>
        <ErrorBox error={range.error} />
        <div className="mt-grid" role="grid" aria-label={`${MONTHS[mo]} ${y}`}>
          {DOW.map(d => <div className="mt-dow" key={d} role="columnheader">{d}</div>)}
          {cells.map(d => { const k = ymd(d); const list = byDay.get(k) || []; const live = list.filter(x => x.status !== 'cancelled');
            return <div key={k} role="gridcell" tabIndex={0} aria-selected={k === sel} aria-label={`${shortDate(k)}, ${live.length} meetings`} className={`mt-day${d.getMonth() !== mo ? ' out' : ''}${k === today ? ' today' : ''}${k === sel ? ' sel' : ''}`}
              onClick={() => setSel(k)} onDoubleClick={() => open(k)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSel(k); } }}>
              <span className="mt-dn">{d.getDate()}</span>
              {list.slice(0, 3).map(x => <span key={x.id} className={`mt-ev${x.status === 'cancelled' ? ' off' : ''}`} style={{ ['--c' as any]: KIND_COLOR[x.kind] || 'var(--blue)' }}><i>{t12(x.start_time).replace(':00', '')}</i> {x.title}</span>)}
              {list.length > 3 && <span className="mt-more-n">+{list.length - 3} more</span>}</div>; })}
        </div>
        <p className="hint" style={{ marginTop: 8 }}>Click a date to see its meetings · double-click a date to schedule one on it. Times are India Standard Time (IST).</p>
      </div>
      <aside className="card mt-side" aria-live="polite">
        <header><div><h3 style={{ margin: 0 }}>{sel === today ? 'Today' : shortDate(sel)}</h3><p className="sub" style={{ margin: 0 }}>{niceDate(sel)}</p></div><button className="btn sm primary" onClick={() => open(sel)}><Ic n="plus" />Add</button></header>
        {range.isLoading ? <Skeleton rows={4} /> : !day.length ? <Empty icon="calendar" title="Nothing scheduled">No meetings on this date{scope === 'mine' ? ' in your schedule' : ''}. <button className="btn sm" style={{ marginTop: 8 }} onClick={() => open(sel)}>Schedule one</button></Empty>
          : <div className="mt-list">{day.map(m => <MeetingCard key={m.id} m={m} focus={m.id === focusId} onEdit={x => open(x.meeting_date, x)} />)}</div>}
      </aside>
    </div> : <div className="mt-agenda">
      <div className="note" style={{ marginBottom: 12 }}>{view === 'agenda' ? 'Everything you organize, are invited to, or saved - with your own alert for each. Change an alert on any meeting and it applies only to you.' : 'Earlier meetings from your schedule.'}</div>
      <ErrorBox error={agenda.error} />
      {agenda.isLoading ? <div className="card"><Skeleton rows={6} /></div> : !grouped.length ? <div className="card"><Empty icon="calendar" title={view === 'agenda' ? 'Your saved schedule is empty' : 'No past meetings'}>{view === 'agenda' ? 'Schedule a meeting, or save a company-wide one from the calendar (All visible).' : ''}</Empty></div>
        : grouped.map(([d, list]) => <section key={d} className="mt-agenda-d"><h4>{niceDate(d)}{d === today ? ' · Today' : ''}</h4><div className="mt-list">{list.map(m => <MeetingCard key={m.id} m={m} focus={m.id === focusId} onEdit={x => open(x.meeting_date, x)} />)}</div></section>)}
    </div>}
    {form && <MeetingForm initial={form.m} date={form.date} onClose={() => setForm(null)} onSaved={m => m?.meeting_date && view === 'calendar' && setSel(m.meeting_date)} />}</div>;
}
