import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiForm, ago, label, roleOf, baseFor, getUser, PRIORITIES } from './api';
import { Badge, Field, Ic, Modal, PageHead, useToast } from './ui';

export const STATUS_COLORS: Record<string, string> = { new: 'var(--purple)', open: 'var(--blue)', assigned: 'var(--c-teal)', in_progress: 'var(--c-amber)', pending: 'var(--c-orange)', resolved: 'var(--green)', closed: 'var(--muted)', cancelled: 'var(--muted)' };
export const PRI_COLORS: Record<string, string> = { critical: 'var(--red)', high: 'var(--c-orange)', medium: 'var(--c-amber)', low: 'var(--c-teal)' };

export const useCategories = () => useQuery({ queryKey: ['categories'], queryFn: () => api('/config/categories'), staleTime: 60000 });
export const useLookup = () => useQuery({ queryKey: ['lookup'], queryFn: () => api('/users/lookup/all'), staleTime: 60000 });
export const useAssignable = () => useQuery({ queryKey: ['assignable'], queryFn: () => api('/tickets/assignable'), staleTime: 60000, enabled: roleOf() !== 'employee' });
export const useTeams = () => useQuery({ queryKey: ['teams'], queryFn: () => api('/config/teams'), staleTime: 60000 });
export const useDepartments = () => useQuery({ queryKey: ['departments'], queryFn: () => api('/config/departments'), staleTime: 60000 });

export function SlaChip({ t }: { t: any }) {
  if (!t.resolution_due) return <span className="cell-sub">No SLA</span>;
  if (['resolved', 'closed', 'cancelled'].includes(t.status)) return t.sla_breached ? <Badge v="breached" text="SLA missed" /> : <Badge v="ok" text="SLA met" />;
  const left = new Date(t.resolution_due).getTime() - Date.now(); const m = Math.round(Math.abs(left) / 60000);
  const txt = m >= 1440 ? `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h` : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
  return left < 0 ? <Badge v="breached" text={`Overdue ${txt}`} /> : <span className={`badge ${left < 3600000 ? 'b-medium' : 'b-ok'}`}><Ic n="clock" />{txt} left</span>;
}

/** Star / un-star a ticket (shows up under Favorites in the navbar). */
export function StarButton({ id, on }: { id: string; on: boolean }) {
  const qc = useQueryClient(); const toast = useToast();
  const m = useMutation({ mutationFn: (v: boolean) => api(`/tickets/${id}/favorite`, { method: 'POST', body: { on: v } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['tickets'] }); qc.invalidateQueries({ queryKey: ['ticket', id] }); qc.invalidateQueries({ queryKey: ['ticket-nav'] }); }, onError: (e: any) => toast(e.message, 'error') });
  return <button type="button" className={`star ${on ? 'on' : ''}`} aria-pressed={on} disabled={m.isPending} aria-label={on ? 'Remove from favorites' : 'Add to favorites'} title={on ? 'Remove from favorites' : 'Add to favorites'}
    onClick={e => { e.preventDefault(); e.stopPropagation(); m.mutate(!on); }}><Ic n="star" /></button>;
}
const INVOLVEMENT: Record<string, string> = { requester: 'Raised by me', assignee: 'Assigned to me', escalated: 'Escalated to me', watching: 'Watching', commented: 'Commented' };
export const InvolvementChips = ({ list }: { list?: string[] }) => <span className="inv-chips">{(list || []).map(k => <span key={k} className={`inv inv-${k}`}>{INVOLVEMENT[k] || k}</span>)}</span>;

const LEVELS = [['high', '1 - High'], ['medium', '2 - Medium'], ['low', '3 - Low']];
const CHANNELS = [['self_service', 'Self-service'], ['phone', 'Phone'], ['email', 'Email'], ['chat', 'Chat'], ['walk_in', 'Walk-in']];
/** Impact x urgency -> priority (ServiceNow matrix). [label shown, value sent to the API] */
const PRIORITY_MATRIX: Record<string, [string, string]> = {
  'high:high': ['1 - Critical', 'critical'], 'high:medium': ['2 - High', 'high'], 'medium:high': ['2 - High', 'high'],
  'medium:medium': ['3 - Moderate', 'medium'], 'high:low': ['3 - Moderate', 'medium'], 'low:high': ['3 - Moderate', 'medium'],
  'medium:low': ['4 - Low', 'low'], 'low:medium': ['4 - Low', 'low'], 'low:low': ['5 - Planning', 'low'],
};
const Row = ({ label: l, req, children }: { label: string; req?: boolean; children: React.ReactNode }) =>
  <label className="snow-row"><span className="snow-lbl">{req && <b className="req">*</b>}{l}</span><span className="snow-ctl">{children}</span></label>;

export function NewTicketPage({ onClose, defaultType = 'incident', initial = {} }: { onClose: () => void; defaultType?: string; initial?: { category_id?: string; subcategory_id?: string } }) {
  const role = roleOf(); const nav = useNavigate(); const qc = useQueryClient(); const toast = useToast(); const staff = role !== 'employee';
  const cats = useCategories(); const lookup = useLookup(); const assignable = useAssignable(); const teams = useTeams(); const projects = useQuery({ queryKey: ['projects-all'], queryFn: () => api('/projects') });
  const [f, setF] = useState<any>({ subject: '', description: '', category_id: initial.category_id || '', subcategory_id: initial.subcategory_id || '', request_type: defaultType, project_id: '', requester_id: '', assignee_id: '', team_id: '', channel: 'self_service', impact: 'low', urgency: 'low', service: '', service_offering: '', configuration_item: '' });
  const [files, setFiles] = useState<File[]>([]); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const set = (k: string) => (e: any) => setF((s: any) => ({ ...s, [k]: e.target.value, ...(k === 'category_id' ? { subcategory_id: '' } : {}) }));
  const parents = (cats.data?.data || []).filter((c: any) => !c.parent_id); const subs = (cats.data?.data || []).filter((c: any) => c.parent_id === f.category_id);
  const [priLabel, priority] = PRIORITY_MATRIX[`${f.impact}:${f.urgency}`];
  const me = getUser();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try { const t = await apiForm('/tickets', { ...f, priority }, files); qc.invalidateQueries({ queryKey: ['tickets'] }); qc.invalidateQueries({ queryKey: ['dashboard'] }); toast(`Ticket ${t.ticket_no} created`); onClose(); nav(`${baseFor(role)}/tickets/${t.id}`); }
    catch (x: any) { setErr(x.message); } finally { setBusy(false); }
  };
  const isInc = defaultType === 'incident'; const base = baseFor(role);
  const actions = <><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="newticket" disabled={busy}>{busy ? 'Submitting…' : 'Submit'}</button></>;
  return <div className="snow-page">
    <PageHead crumbs={[{ label: isInc ? 'Incidents' : defaultType === 'service_request' ? 'Service requests' : 'Tickets', to: `${base}/tickets${defaultType !== 'incident' && defaultType !== 'service_request' ? '' : `?type=${defaultType}`}` }, { label: 'New record' }]} title={isInc ? 'Incident' : defaultType === 'service_request' ? 'Service request' : 'Ticket'} sub="New record">{actions}</PageHead>
    <div className="card snow-card">
    <form id="newticket" onSubmit={submit}>
      {err && <div className="err" role="alert" style={{ marginBottom: 10 }}>{err}</div>}
      <div className="snow">
        <div className="snow-col">
          <Row label="Identification ID"><input value="Auto-generated on submit" readOnly disabled /></Row>
          <Row label="Created by" req>{staff
            ? <select value={f.requester_id} onChange={set('requester_id')}><option value="">{me ? `${me.name} (me)` : 'Myself'}</option>{(lookup.data?.data || []).filter((u: any) => u.id !== me?.id).map((u: any) => <option key={u.id} value={u.id}>{u.name} ({u.role})</option>)}</select>
            : <input value={me?.name || 'Me'} readOnly disabled />}</Row>
          <Row label="Reason for creation" req><select value={f.category_id} onChange={set('category_id')} required><option value="">-- None --</option>{parents.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Row>
          <Row label="Specific task"><select value={f.subcategory_id} onChange={set('subcategory_id')} disabled={!subs.length}><option value="">-- None --</option>{subs.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Row>
          <Row label="Service requirement"><input value={f.service} onChange={set('service')} maxLength={200} /></Row>
          <Row label="Service offering"><input value={f.service_offering} onChange={set('service_offering')} maxLength={200} /></Row>
          <Row label="Configuration item"><input value={f.configuration_item} onChange={set('configuration_item')} maxLength={200} /></Row>
          <Row label="Short description" req><input value={f.subject} onChange={set('subject')} maxLength={200} minLength={3} required /></Row>
        </div>
        <div className="snow-col">
          <Row label="Channel"><select value={f.channel} onChange={set('channel')}><option value="">-- None --</option>{CHANNELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Row>
          <Row label="State"><input value="New" readOnly disabled /></Row>
          <Row label="Request type"><select value={f.request_type} onChange={set('request_type')}><option value="incident">Incident</option><option value="service_request">Service request</option><option value="question">Question</option><option value="change">Change</option></select></Row>
          <Row label="Impact"><select value={f.impact} onChange={set('impact')}>{LEVELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Row>
          <Row label="Urgency"><select value={f.urgency} onChange={set('urgency')}>{LEVELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Row>
          <Row label="Priority"><input value={priLabel} readOnly disabled /></Row>
          {staff && <>
            <Row label="Assignment group"><select value={f.team_id} onChange={set('team_id')}><option value="">Automatic</option>{(teams.data?.data || []).filter((t: any) => t.is_active).map((t: any) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Row>
            <Row label="Assigned to"><select value={f.assignee_id} onChange={set('assignee_id')}><option value="">Unassigned</option>{(assignable.data?.data || []).map((u: any) => <option key={u.id} value={u.id}>{u.name} ({u.role})</option>)}</select></Row></>}
          <Row label="Related project"><select value={f.project_id} onChange={set('project_id')}><option value="">None</option>{(projects.data?.data || []).filter((p: any) => p.status !== 'completed' && p.status !== 'cancelled').map((p: any) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}</select></Row>
        </div>
      </div>
      <div className="snow-wide">
        <Row label="Detailed Description" req><textarea rows={5} value={f.description} onChange={set('description')} required minLength={3} /></Row>
        <Row label="Attachments"><input type="file" multiple onChange={e => setFiles(Array.from(e.target.files || []).slice(0, 5))} /></Row>
        <div className="hint snow-hint">Up to 5 files, 10 MB each. The SLA clock starts when you submit.</div>
      </div>
    </form>
    <div className="snow-foot">{actions}</div>
    </div></div>;
}

export function ConfirmModal({ title, text, confirm = 'Confirm', danger, onYes, onClose }: { title: string; text: string; confirm?: string; danger?: boolean; onYes: () => Promise<any> | void; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return <Modal title={title} onClose={onClose} width={440} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className={`btn ${danger ? 'danger' : 'primary'}`} disabled={busy} onClick={async () => { setBusy(true); try { await onYes(); onClose(); } finally { setBusy(false); } }}>{confirm}</button></>}><p style={{ margin: 0 }}>{text}</p></Modal>;
}
export const fileSize = (n: number) => n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
export { ago };
