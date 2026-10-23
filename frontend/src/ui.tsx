import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { label, roleOf, baseFor } from './api';

// ---------- icons (lucide-style paths) ----------
const P: Record<string, string> = {
  dashboard: 'M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z', users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', chart: 'M3 3v18h18M7 15l4-4 3 3 5-6', check: 'M20 6 9 17l-5-5', todo: 'M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h9',
  ticket: 'M3 9a2 2 0 0 0 0 6v3a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-3a2 2 0 0 1 0-6V6a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1zM13 5v2M13 17v2M13 11v2', settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  activity: 'M22 12h-4l-3 9L9 3l-3 9H2', bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0', chat: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z', sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4', moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3', plus: 'M12 5v14M5 12h14', x: 'M18 6 6 18M6 6l12 12', down: 'm6 9 6 6 6-6', logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9', clip: 'm21.4 11-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5',
  send: 'm22 2-7 20-4-9-9-4zM22 2 11 13', grid: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z', list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01', user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  mail: 'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM22 6l-10 7L2 6', phone: 'M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2', alert: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01', trash: 'M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z', download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3', refresh: 'M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15', arrowup: 'M12 19V5M5 12l7-7 7 7',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', building: 'M3 21h18M5 21V7l8-4v18M19 21V11l-6-4M9 9h.01M9 13h.01M9 17h.01', calendar: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.1z',
  star: 'M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9z',
  flag: 'M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7', lock: 'M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2zM7 11V7a5 5 0 0 1 10 0v4', menu: 'M3 6h18M3 12h18M3 18h18', userplus: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM19 8v6M22 11h-6', eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
};
export const Ic = ({ n, className = '' }: { n: string; className?: string }) => (
  <svg className={`ic ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={P[n] || P.dashboard} /></svg>
);

// ---------- toasts ----------
const ToastCtx = createContext<(msg: string, kind?: 'success' | 'error') => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<{ id: number; msg: string; kind: string }[]>([]);
  const push = useCallback((msg: string, kind: 'success' | 'error' = 'success') => { const id = Date.now() + Math.random(); setItems(s => [...s, { id, msg, kind }]); setTimeout(() => setItems(s => s.filter(x => x.id !== id)), kind === 'error' ? 6000 : 3500); }, []);
  return <ToastCtx.Provider value={push}>{children}<div className="toasts" role="status" aria-live="polite">{items.map(t => <div key={t.id} className={`toast ${t.kind}`}>{t.msg}</div>)}</div></ToastCtx.Provider>;
}

// ---------- small components ----------
export const Badge = ({ v, text }: { v?: string | null; text?: string }) => v ? <span className={`badge b-${v}`}>{text ?? label(v)}</span> : null;
export const Pri = ({ v }: { v: string }) => <span className={`badge b-${v}`}><i className={`pri-dot pri-${v}`} />{label(v)}</span>;
export const initials = (n?: string) => (n || '?').split(/\s+/).slice(0, 2).map(w => w[0]).join('');
export const Avatar = ({ name, size = '' }: { name?: string; size?: 'sm' | 'lg' | '' }) => <span className={`avatar ${size}`} title={name} aria-hidden="true">{initials(name)}</span>;
export const Skeleton = ({ rows = 5 }: { rows?: number }) => <div aria-busy="true" aria-label="Loading">{Array.from({ length: rows }).map((_, i) => <div key={i} className="skel" style={{ width: `${95 - (i % 3) * 14}%` }} />)}</div>;
export const Empty = ({ icon = 'inbox', title, children }: { icon?: string; title: string; children?: React.ReactNode }) => <div className="empty"><Ic n={icon} /><h3>{title}</h3>{children && <div>{children}</div>}</div>;
export const ErrorBox = ({ error }: { error: any }) => error ? <div className="err" role="alert">{error.message || String(error)}</div> : null;
export const Crumbs = ({ items }: { items: { label: string; to?: string }[] }) => <nav className="crumbs" aria-label="Breadcrumb">{items.map((c, i) => <React.Fragment key={i}>{i > 0 && <span>/</span>}{c.to ? <Link to={c.to}>{c.label}</Link> : <b>{c.label}</b>}</React.Fragment>)}</nav>;
export const PageHead = ({ crumbs, title, sub, children }: { crumbs: { label: string; to?: string }[]; title: string; sub?: string; children?: React.ReactNode }) => (
  <><Crumbs items={crumbs} /><div className="bar"><div><h1>{title}</h1>{sub && <p className="sub">{sub}</p>}</div><div className="sp" />{children}</div></>);
export const Kpi = ({ label: l, value, hint, color, to, icon }: { label: string; value: any; hint?: string; color?: string; to?: string; icon?: string }) => {
  const inner = <><div className="l">{icon && <Ic n={icon} />}{l}</div><div className="v">{value ?? '—'}</div>{hint && <div className="h">{hint}</div>}</>;
  const style = { ['--c' as any]: color || 'var(--blue)' };
  return to ? <Link to={to} className="kpi" style={style}>{inner}</Link> : <div className="kpi" style={style}>{inner}</div>;
};
export function Field({ label: l, req, hint, children, className = '' }: { label: string; req?: boolean; hint?: string; children: React.ReactNode; className?: string }) {
  return <label className={`field ${className}`}><span style={{ display: 'block', marginBottom: 4 }}>{l}{req && <span className="req"> *</span>}</span>{children}{hint && <div className="hint">{hint}</div>}</label>;
}
export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize)); if (total <= pageSize) return <div className="pager"><span>{total} {total === 1 ? 'record' : 'records'}</span></div>;
  return <div className="pager"><span>{(page - 1) * pageSize + 1}–{Math.min(total, page * pageSize)} of {total}</span><div><button className="btn sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button><span>Page {page} / {pages}</span><button className="btn sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</button></div></div>;
}
export function Modal({ title, onClose, children, footer, width }: { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const prev = document.activeElement as HTMLElement | null; const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); document.addEventListener('keydown', k); ref.current?.querySelector<HTMLElement>('input,select,textarea,button.primary')?.focus(); return () => { document.removeEventListener('keydown', k); prev?.focus?.(); }; }, []);   // eslint-disable-line
  return <div className="modal-bg" onMouseDown={e => e.target === e.currentTarget && onClose()}><div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref} style={{ ['--w' as any]: `${width || 640}px` }}>
    <header><h3>{title}</h3><button className="btn ghost sm" onClick={onClose} aria-label="Close"><Ic n="x" /></button></header><div className="body">{children}</div>{footer && <div className="foot">{footer}</div>}</div></div>;
}
export function useDebounced<T>(v: T, ms = 300) { const [d, setD] = useState(v); useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]); return d; }
export const useBase = () => baseFor(roleOf());

// ---------- charts (dependency-free SVG/CSS) ----------
export function BarList({ rows, color = 'var(--c-teal)', empty = 'No data yet' }: { rows: { label: string; value: number; color?: string }[]; color?: string; empty?: string }) {
  const max = Math.max(1, ...rows.map(r => r.value)); if (!rows.length) return <p className="sub">{empty}</p>;
  return <div>{rows.map(r => <div className="hbar" key={r.label}><span className="lab" title={r.label}>{r.label}</span><span className="t"><i style={{ width: `${(r.value / max) * 100}%`, ['--c' as any]: r.color || color }} /></span><span className="v">{r.value}</span></div>)}</div>;
}
export function TrendChart({ data }: { data: { label: string; created: number; resolved: number }[] }) {
  const W = 640, H = 190, pad = 26; const max = Math.max(3, ...data.flatMap(d => [d.created, d.resolved])); const bw = (W - pad * 2) / data.length;
  const y = (v: number) => H - pad - (v / max) * (H - pad * 2);
  return <div><svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Tickets created and resolved over the last 14 days">
    {[0, 0.5, 1].map(f => <g key={f}><line x1={pad} x2={W - pad} y1={y(max * f)} y2={y(max * f)} stroke="var(--rule)" /><text x={4} y={y(max * f) + 4} fontSize="10" fill="var(--muted)">{Math.round(max * f)}</text></g>)}
    {data.map((d, i) => <g key={i}>
      <rect x={pad + i * bw + bw * 0.12} y={y(d.created)} width={bw * 0.36} height={H - pad - y(d.created)} rx="2" fill="var(--c-orange)"><title>{d.label}: {d.created} created</title></rect>
      <rect x={pad + i * bw + bw * 0.5} y={y(d.resolved)} width={bw * 0.36} height={H - pad - y(d.resolved)} rx="2" fill="var(--c-teal)"><title>{d.label}: {d.resolved} resolved</title></rect>
      {i % 2 === 0 && <text x={pad + i * bw + bw / 2} y={H - 8} fontSize="9.5" textAnchor="middle" fill="var(--muted)">{d.label}</text>}</g>)}
  </svg><div className="legend"><span><i style={{ background: 'var(--c-orange)' }} />Created</span><span><i style={{ background: 'var(--c-teal)' }} />Resolved</span></div></div>;
}
export const Donut = ({ parts }: { parts: { label: string; value: number; color: string }[] }) => {
  const total = parts.reduce((s, p) => s + p.value, 0); if (!total) return <p className="sub">No data yet</p>; let acc = 0; const R = 42, C = 2 * Math.PI * R;
  return <div style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' }}><svg viewBox="0 0 110 110" width="130" role="img" aria-label="Distribution"><g transform="rotate(-90 55 55)">{parts.map(p => { const len = (p.value / total) * C; const el = <circle key={p.label} cx="55" cy="55" r={R} fill="none" stroke={p.color} strokeWidth="16" strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-acc}><title>{p.label}: {p.value}</title></circle>; acc += len; return el; })}</g><text x="55" y="60" textAnchor="middle" fontSize="18" fontWeight="700" fill="var(--text)">{total}</text></svg>
    <div>{parts.map(p => <div key={p.label} style={{ fontSize: 13, margin: '3px 0' }}><i style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, background: p.color, marginRight: 7 }} />{p.label} <b>{p.value}</b></div>)}</div></div>;
};
