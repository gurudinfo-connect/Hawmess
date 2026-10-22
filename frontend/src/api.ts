const BASE = (import.meta as any).env?.VITE_API_URL || '/api/v1';
export type Role = 'admin' | 'hr' | 'employee';
export const getToken = () => localStorage.getItem('hawmess_token');
export function setSession(token: string, user: any) { localStorage.setItem('hawmess_token', token); localStorage.setItem('hawmess_user', JSON.stringify(user)); }
export function clearSession() { localStorage.removeItem('hawmess_token'); localStorage.removeItem('hawmess_user'); }
export function getUser(): any { try { return JSON.parse(localStorage.getItem('hawmess_user') || 'null'); } catch { return null; } }
export const roleOf = (): Role => { const r = getUser()?.role; return r === 'admin' || r === 'hr' ? r : 'employee'; };
export const baseFor = (r: Role) => `/${r}`;
export const homeFor = (r: Role) => `/${r}/dashboard`;
export const roleLabel = (r?: string) => (r === 'hr' ? 'HR' : (r || '').replace(/^\w/, c => c.toUpperCase()));

async function handle(res: Response, path: string) {
  if (res.status === 401 && !path.startsWith('/auth/')) { clearSession(); location.href = '/login'; }
  if (!res.ok) { const data = await res.json().catch(() => ({})); const e: any = new Error(typeof data.error === 'string' ? data.error : 'Request failed'); e.status = res.status; throw e; }
  return res;
}
const auth = (): Record<string, string> => (getToken() ? { Authorization: `Bearer ${getToken()}` } : {});
export async function api<T = any>(path: string, opts: { method?: string; body?: any } = {}): Promise<T> {
  const res = await handle(await fetch(BASE + path, { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json', ...auth() }, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined }), path);
  return res.json().catch(() => ({}));
}
/** multipart upload (tickets / comments with files) */
export async function apiForm<T = any>(path: string, fields: Record<string, any>, files: File[] = []): Promise<T> {
  const f = new FormData(); for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null && v !== '') f.append(k, String(v)); files.forEach(x => f.append('files', x));
  return (await handle(await fetch(BASE + path, { method: 'POST', headers: auth(), body: f }), path)).json();
}
export async function download(path: string, filename: string) {
  const res = await handle(await fetch(BASE + path, { headers: auth() }), path); const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
}
export const qs = (o: Record<string, any>) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v)); const s = p.toString(); return s ? `?${s}` : ''; };

export const fmtDate = (d?: string | null) => (d ? new Date(d.length === 10 ? d + 'T00:00:00' : d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const fmtDateTime = (d?: string | null) => (d ? new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
export const ago = (d?: string | null) => { if (!d) return ''; const s = (Date.now() - new Date(d).getTime()) / 1000; if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)}m ago`; if (s < 86400) return `${Math.floor(s / 3600)}h ago`; if (s < 604800) return `${Math.floor(s / 86400)}d ago`; return fmtDate(d); };
export const dur = (mins?: number | null) => { if (mins === null || mins === undefined) return '—'; const a = Math.abs(mins); const t = a >= 1440 ? `${Math.floor(a / 1440)}d ${Math.floor((a % 1440) / 60)}h` : a >= 60 ? `${Math.floor(a / 60)}h ${a % 60}m` : `${a}m`; return t; };
export const label = (s?: string | null) => (s || '').replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
export const STATUS_ORDER = ['new', 'open', 'assigned', 'in_progress', 'pending', 'resolved', 'closed'];
export const PRIORITIES = ['low', 'medium', 'high', 'critical'];
