import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { ago, api, qs, roleLabel } from '../api';
import { Avatar, Empty, Ic, Skeleton } from '../ui';
import { useCall } from './CallProvider';
import { fmtClock } from './CallUI';

export const callLabel = (c: any) => {
  const out = c.direction === 'outgoing';
  if (c.status === 'completed') return out ? 'Outgoing' : 'Incoming';
  if (c.status === 'declined') return out ? 'Declined' : 'You declined';
  if (c.status === 'failed') return 'Failed';
  if (c.status === 'cancelled') return out ? 'Cancelled' : 'Missed';
  return out ? (c.end_reason === 'busy' ? 'Busy' : 'No answer') : 'Missed';
};
const bad = (c: any) => c.status === 'failed' || (c.direction === 'incoming' && (c.status === 'missed' || c.status === 'cancelled'));

/** My finished calls (optionally just with one colleague). Each row can start a new call back. */
export function CallHistory({ withUser, compact }: { withUser?: string; compact?: boolean }) {
  const { state, engine } = useCall(); const q = useQuery({ queryKey: ['call-history', withUser || ''], queryFn: () => api(`/calls/history${qs({ with: withUser })}`), refetchInterval: 15000 });
  const idle = state.phase === 'idle' || state.phase === 'ended';
  if (q.isLoading) return <div style={{ padding: 14 }}><Skeleton rows={3} /></div>;
  const rows: any[] = q.data?.data || [];
  if (!rows.length) return <Empty icon="phone" title="No calls yet">Calls you make and receive appear here.</Empty>;
  return <ul className="call-hist" aria-label="Call history">{rows.map(c => <li key={c.id}>
    <Avatar name={c.other_name} /><div className="tx"><b>{c.other_name}{!compact && <small> {roleLabel(c.other_role)}</small>}</b>
      <span className={bad(c) ? 'bad' : ''}><Ic n={c.call_type === 'video' ? 'video' : 'phone'} /> {callLabel(c)}{c.duration_seconds ? ` · ${fmtClock(c.duration_seconds)}` : ''} · {ago(c.started_at)}</span></div>
    {c.conversation_id && <div className="acts"><button className="btn ghost sm" disabled={!idle} title="Audio call" aria-label={`Audio call ${c.other_name}`} onClick={() => engine.startCall({ conversationId: c.conversation_id, peer: { id: c.other_user_id, name: c.other_name, role: c.other_role }, type: 'audio' })}><Ic n="phone" /></button>
      <button className="btn ghost sm" disabled={!idle} title="Video call" aria-label={`Video call ${c.other_name}`} onClick={() => engine.startCall({ conversationId: c.conversation_id, peer: { id: c.other_user_id, name: c.other_name, role: c.other_role }, type: 'video' })}><Ic n="video" /></button></div>}
  </li>)}</ul>;
}
