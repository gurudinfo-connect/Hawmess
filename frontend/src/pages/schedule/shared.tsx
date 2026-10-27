import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { useToast } from '../../ui';

export const pad = (n: number) => String(n).padStart(2, '0');
export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseYmd = (s: string) => new Date(`${s}T00:00:00`);
export const todayYmd = () => ymd(new Date());
export const niceDate = (s: string) => parseYmd(s).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
export const shortDate = (s: string) => parseYmd(s).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
export const t12 = (t: string) => { const [h, m] = t.split(':').map(Number); return `${h % 12 || 12}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`; };
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const KINDS: [string, string][] = [['meeting', 'Meeting'], ['call', 'Call'], ['review', 'Review'], ['training', 'Training'], ['interview', 'Interview'], ['personal', 'Personal reminder'], ['other', 'Other']];
export const KIND_COLOR: Record<string, string> = { meeting: 'var(--blue)', call: 'var(--orange)', review: 'var(--teal)', training: 'var(--green)', interview: 'var(--purple)', personal: 'var(--muted)', other: 'var(--amber)' };
export const kindLabel = (k: string) => KINDS.find(x => x[0] === k)?.[1] || k;

/** Alert choices: value = minutes before the start (null = no alert). */
export const ALERTS: [number | null, string][] = [[null, 'No alert'], [0, 'At start time'], [5, '5 minutes before'], [10, '10 minutes before'], [15, '15 minutes before'], [30, '30 minutes before'], [60, '1 hour before'], [120, '2 hours before'], [1440, '1 day before']];
export const alertLabel = (m: number | null | undefined) => ALERTS.find(a => a[0] === (m ?? null))?.[1] || `${m} minutes before`;
export const alertValue = (v: string) => (v === 'none' ? null : Number(v));
export const alertKey = (m: number | null | undefined) => (m === null || m === undefined ? 'none' : String(m));

/** Runs an API call, refreshes every schedule query and shows the result as a toast. */
export function useAct() {
  const qc = useQueryClient(); const toast = useToast();
  return async (path: string, method: string, body?: any, ok?: string) => {
    try { const r = await api(path, { method, body }); qc.invalidateQueries({ queryKey: ['meet'] }); qc.invalidateQueries({ queryKey: ['notifs'] }); if (ok) toast(ok); return r; }
    catch (e: any) { toast(e.message || 'Something went wrong', 'error'); return null; }
  };
}
