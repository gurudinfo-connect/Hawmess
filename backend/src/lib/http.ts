import { z, ZodTypeAny } from 'zod';
export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
export const bad = (m: string) => new HttpError(400, m);
export const forbidden = (m = 'Forbidden') => new HttpError(403, m);
export const notFound = (m = 'Not found') => new HttpError(404, m);
export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) { const i = r.error.issues[0]; throw bad(`${i.path.join('.') || 'request'}: ${i.message}`); }
  return r.data;
}
export const pageParams = (q: any, max = 100) => {
  const page = Math.max(1, parseInt(String(q.page || '1'), 10) || 1);
  const pageSize = Math.min(max, Math.max(1, parseInt(String(q.pageSize || '25'), 10) || 25));
  return { page, pageSize, offset: (page - 1) * pageSize };
};
export const csvEscape = (v: any) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export const toCsv = (rows: any[]) => { if (!rows.length) return ''; const cols = Object.keys(rows[0]); return [cols.join(','), ...rows.map(r => cols.map(c => csvEscape(r[c] instanceof Date ? r[c].toISOString() : r[c])).join(','))].join('\n'); };
