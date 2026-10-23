import React, { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, baseFor, download, label, qs, roleOf } from '../api';
import { BarList, Empty, ErrorBox, Ic, PageHead, Skeleton, useToast } from '../ui';

const PRETTY: Record<string, (v: any) => any> = { status: label, priority: label, type: label };
export default function Reports() {
  const role = roleOf(); const base = baseFor(role); const toast = useToast(); const [sp, setSp] = useSearchParams();
  const list = useQuery({ queryKey: ['report-list'], queryFn: () => api('/reports') }); const items: any[] = list.data?.data || [];
  const key = sp.get('r') && items.some(i => i.key === sp.get('r')) ? sp.get('r')! : items[0]?.key;
  const today = new Date().toISOString().slice(0, 10); const d30 = new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);
  const [from, setFrom] = useState(d30); const [to, setTo] = useState(today);
  const q = useQuery({ queryKey: ['report', key, from, to], queryFn: () => api(`/reports/${key}${qs({ from, to })}`), enabled: !!key });
  const rep = q.data; const personal = role === 'employee';
  const first = rep?.columns?.[0]?.key; const numCol = rep?.columns?.find((c: any, i: number) => i > 0 && typeof rep.rows[0]?.[c.key] === 'number')?.key;
  return <><PageHead crumbs={[{ label: 'Reports' }, { label: rep?.title || 'Reports' }]} title="Reports" sub={personal ? 'Your own tickets, tasks and projects' : role === 'hr' ? 'Employee-related tickets, response times and workload' : 'Ticket volume, SLA compliance, performance and workload'}>
      {rep && <button className="btn" onClick={() => download(`/reports/${key}${qs({ from, to, format: 'csv' })}`, `barid-in-${key}.csv`).then(() => toast('Report exported')).catch((e: any) => toast(e.message, 'error'))}><Ic n="download" />Export CSV</button>}</PageHead>
    <div className="side-layout"><nav className="side" aria-label="Reports"><h4>Reports</h4>{items.map(i => <button key={i.key} className={key === i.key ? 'on' : ''} onClick={() => setSp({ r: i.key }, { replace: true })}>{i.title}</button>)}</nav>
      <div className="main-col">{!personal && <div className="filters"><label className="chk">From <input type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} style={{ width: 'auto' }} /></label><label className="chk">To <input type="date" value={to} min={from} max={today} onChange={e => setTo(e.target.value)} style={{ width: 'auto' }} /></label><span className="hint">Ticket reports use the creation date.</span></div>}
        <ErrorBox error={q.error} />
        {q.isLoading || list.isLoading ? <div className="card"><Skeleton rows={6} /></div> : rep && <>
          {numCol && rep.rows.length > 0 && rep.rows.length <= 14 && <div className="card mb"><h3>{rep.title}</h3><BarList rows={rep.rows.map((r: any) => ({ label: String(PRETTY[first]?.(r[first]) ?? r[first] ?? '—'), value: Number(r[numCol]) || 0 }))} /><p className="hint">Chart shows “{rep.columns.find((c: any) => c.key === numCol).label}”.</p></div>}
          <div className="tbl">{!rep.rows.length ? <Empty icon="chart" title="No data for this period">Try widening the date range.</Empty> : <table><thead><tr>{rep.columns.map((c: any, i: number) => <th key={c.key} className={i > 0 && typeof rep.rows[0][c.key] === 'number' ? 'n' : ''}>{c.label}</th>)}</tr></thead>
            <tbody>{rep.rows.map((r: any, i: number) => <tr key={i}>{rep.columns.map((c: any, j: number) => { const v = r[c.key]; const num = typeof v === 'number'; return <td key={c.key} className={num ? 'n' : ''}>{v === null || v === undefined ? '—' : j === 0 && PRETTY[c.key] ? PRETTY[c.key](v) : String(v)}</td>; })}</tr>)}</tbody></table>}</div>
          <p className="hint">{rep.rows.length} row{rep.rows.length === 1 ? '' : 's'}{!personal && ` · ${rep.from} to ${rep.to}`}. Figures are calculated live from ticket timestamps and your SLA policies.</p></>}</div></div></>;
}
