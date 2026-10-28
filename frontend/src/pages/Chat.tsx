import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ago, getUser, roleLabel, roleOf } from '../api';
import { Avatar, Empty, Field, Ic, Modal, PageHead, Skeleton, useToast } from '../ui';
import { useLookup } from '../components';
import { useCall } from '../calls/CallProvider';
import { CallHistory } from '../calls/CallHistory';
import { presenceLabel, usePresence } from '../calls/realtime';

const fmtTime = (d: string) => new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const dayLabel = (d: string) => { const x = new Date(d); const t = new Date(); return x.toDateString() === t.toDateString() ? 'Today' : x.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); };

export default function Chat() {
  const me = getUser(); const role = roleOf(); const toast = useToast(); const qc = useQueryClient(); const [sp, setSp] = useSearchParams(); const sel = sp.get('c') || '';
  const lookup = useLookup(); const [newDm, setNewDm] = useState(false); const [newGroup, setNewGroup] = useState(false); const [search, setSearch] = useState(''); const tab: 'chats' | 'calls' = sp.get('tab') === 'calls' ? 'calls' : 'chats';
  const convs = useQuery({ queryKey: ['convs'], queryFn: () => api('/chat/conversations'), refetchInterval: 5000 });
  // deep link: /chat?user=<id> opens (or creates) a direct conversation
  useEffect(() => { const u = sp.get('user'); if (u) api('/chat/conversations', { method: 'POST', body: { type: 'direct', user_id: u } }).then(r => { qc.invalidateQueries({ queryKey: ['convs'] }); setSp({ c: r.id }, { replace: true }); }).catch(e => toast(e.message, 'error')); }, []);   // eslint-disable-line
  const list: any[] = (convs.data?.data || []).filter((c: any) => !search || (c.title || '').toLowerCase().includes(search.toLowerCase()));
  const cur = (convs.data?.data || []).find((c: any) => c.id === sel);
  const start = async (user_id: string) => { try { const r = await api('/chat/conversations', { method: 'POST', body: { type: 'direct', user_id } }); await qc.invalidateQueries({ queryKey: ['convs'] }); setSp({ c: r.id }); setNewDm(false); } catch (e: any) { toast(e.message, 'error'); } };
  return <><PageHead crumbs={[{ label: 'Messages' }]} title="Messages" sub="Chat with colleagues, HR and administrators" />
    <div className={`chat ${sel ? 'has-sel' : ''}`}><aside className="chat-list" aria-label="Conversations"><div className="chat-tabs" role="tablist"><button role="tab" aria-selected={tab === 'chats'} className={tab === 'chats' ? 'on' : ''} onClick={() => setSp(sel ? { c: sel } : {})}>Chats</button><button role="tab" aria-selected={tab === 'calls'} className={tab === 'calls' ? 'on' : ''} onClick={() => setSp(sel ? { c: sel, tab: 'calls' } : { tab: 'calls' })}><Ic n="phone" /> Calls</button></div>{tab === 'calls' ? <CallHistory /> : <><header><input type="search" aria-label="Search conversations" placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)} /><button className="btn primary sm" onClick={() => setNewDm(true)} aria-label="New message" title="New message"><Ic n="plus" /></button>{role !== 'employee' && <button className="btn sm" onClick={() => setNewGroup(true)} title="New group"><Ic n="users" /></button>}</header>
      {convs.isLoading ? <div style={{ padding: 14 }}><Skeleton /></div> : !list.length ? <Empty icon="chat" title="No conversations">Start one with the + button.</Empty> : list.map((c: any) => <div key={c.id} role="button" tabIndex={0} className={`conv ${c.id === sel ? 'on' : ''}`} onClick={() => setSp(sp.get('tab') === 'calls' ? { c: c.id, tab: 'calls' } : { c: c.id })} onKeyDown={e => e.key === 'Enter' && setSp({ c: c.id })}>
        {c.type === 'direct' ? <Avatar name={c.title} /> : <span className="avatar" style={{ background: 'var(--navy)' }}>#</span>}<div className="tx"><b><span>{c.type === 'channel' ? '# ' : ''}{c.title}</span>{c.unread > 0 && <span className="un">{c.unread}</span>}</b><span>{c.last_body ? `${c.last_sender === me?.name ? 'You: ' : c.type !== 'direct' ? c.last_sender + ': ' : ''}${c.last_body}` : 'No messages yet'}</span></div><small className="cell-sub">{c.last_at ? ago(c.last_at) : ''}</small></div>)}</>}</aside>
      {cur ? <Pane key={cur.id} conv={cur} me={me} onBack={() => setSp({})} /> : <section className="chat-pane" style={{ placeItems: 'center', display: 'grid' }}><Empty icon="chat" title="Select a conversation">Direct messages and groups appear on the left.</Empty></section>}</div>
    {newDm && <Modal title="New message" onClose={() => setNewDm(false)} width={460}><div className="form"><ul className="list" style={{ maxHeight: 360, overflow: 'auto' }}>{(lookup.data?.data || []).filter((u: any) => u.id !== me?.id).map((u: any) => <li key={u.id}><button className="btn ghost" style={{ width: '100%', justifyContent: 'flex-start', gap: 10 }} onClick={() => start(u.id)}><Avatar name={u.name} size="sm" /><span style={{ textAlign: 'left' }}>{u.name}<div className="cell-sub">{roleLabel(u.role)}{u.department ? ` · ${u.department}` : ''}</div></span></button></li>)}</ul></div></Modal>}
    {newGroup && <GroupModal users={(lookup.data?.data || []).filter((u: any) => u.id !== me?.id)} onClose={() => setNewGroup(false)} onDone={async id => { await qc.invalidateQueries({ queryKey: ['convs'] }); setSp({ c: id }); }} />}</>;
}

function Pane({ conv, me, onBack }: { conv: any; me: any; onBack: () => void }) {
  const qc = useQueryClient(); const toast = useToast(); const [msgs, setMsgs] = useState<any[]>([]); const [text, setText] = useState(''); const [busy, setBusy] = useState(false); const [loaded, setLoaded] = useState(false); const last = useRef<string | null>(null); const box = useRef<HTMLDivElement>(null); const stick = useRef(true);
  const merge = (rows: any[]) => setMsgs(prev => { const m = new Map(prev.map(x => [x.id, x])); rows.forEach(r => m.set(r.id, r)); return [...m.values()].sort((a, b) => a.created_at.localeCompare(b.created_at)); });
  const poll = async () => { try { const r = await api(`/chat/conversations/${conv.id}/messages${last.current ? `?after=${encodeURIComponent(last.current)}` : ''}`); if (r.data.length) { merge(r.data); last.current = r.data[r.data.length - 1].created_at; qc.invalidateQueries({ queryKey: ['chat-unread'] }); qc.invalidateQueries({ queryKey: ['convs'] }); } setLoaded(true); } catch { /* transient */ } };
  useEffect(() => { poll(); const t = setInterval(poll, 3000); return () => clearInterval(t); }, [conv.id]);   // eslint-disable-line
  useEffect(() => { const el = box.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [msgs]);
  const send = async (e?: React.FormEvent) => { e?.preventDefault(); const body = text.trim(); if (!body || busy) return; setBusy(true); try { const m = await api(`/chat/conversations/${conv.id}/messages`, { method: 'POST', body: { body } }); setText(''); stick.current = true; merge([m]); last.current = m.created_at; qc.invalidateQueries({ queryKey: ['convs'] }); } catch (x: any) { toast(x.message, 'error'); } finally { setBusy(false); } };
  let prevDay = '';
  return <section className="chat-pane"><header><button className="btn ghost sm" onClick={onBack} aria-label="Back" style={{ display: window.innerWidth < 760 ? 'inline-flex' : 'none' }}>←</button>{conv.type === 'direct' ? <Avatar name={conv.title} /> : <span className="avatar" style={{ background: 'var(--navy)' }}>#</span>}<div className="chat-who"><b>{conv.type === 'channel' ? '# ' : ''}{conv.title}</b>{conv.type === 'direct' ? <DirectStatus conv={conv} /> : <div className="cell-sub">{conv.member_count} members</div>}</div>{conv.type === 'direct' && <CallButtons conv={conv} />}</header>
    <div className="chat-msgs" ref={box} onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }} aria-live="polite">
      {!loaded ? <Skeleton /> : !msgs.length ? <p className="sub" style={{ textAlign: 'center', margin: 'auto' }}>No messages yet — say hello 👋</p> : msgs.map(m => { const d = dayLabel(m.created_at); const showDay = d !== prevDay; prevDay = d; const mine = m.sender_id === me?.id;
        return <React.Fragment key={m.id}>{showDay && <div className="day">{d}</div>}<div className={`cm ${mine ? 'me' : ''}`}>{!mine && conv.type !== 'direct' && <span className="by">{m.sender_name} <small style={{ color: 'var(--muted)', fontWeight: 400 }}>{roleLabel(m.sender_role)}</small></span>}{m.body}<time>{fmtTime(m.created_at)}</time></div></React.Fragment>; })}</div>
    <form className="chat-in" onSubmit={send}><textarea aria-label="Message" placeholder="Write a message…  (Enter to send, Shift+Enter for a new line)" value={text} maxLength={4000} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} /><button className="btn primary" disabled={!text.trim() || busy} aria-label="Send"><Ic n="send" /></button></form></section>;
}
function GroupModal({ users, onClose, onDone }: { users: any[]; onClose: () => void; onDone: (id: string) => void }) {
  const [name, setName] = useState(''); const [ids, setIds] = useState<string[]>([]); const [err, setErr] = useState('');
  return <Modal title="New group chat" onClose={onClose} width={500} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={name.trim().length < 2 || !ids.length} onClick={async () => { try { const r = await api('/chat/conversations', { method: 'POST', body: { type: 'group', name, user_ids: ids } }); onDone(r.id); onClose(); } catch (e: any) { setErr(e.message); } }}>Create</button></>}>
    <div className="form">{err && <div className="err">{err}</div>}<Field label="Group name" req><input value={name} onChange={e => setName(e.target.value)} maxLength={80} /></Field><Field label="Members"><div style={{ maxHeight: 260, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 9, padding: 8 }}>{users.map(u => <label key={u.id} className="chk" style={{ padding: '4px 0' }}><input type="checkbox" checked={ids.includes(u.id)} onChange={e => setIds(s => e.target.checked ? [...s, u.id] : s.filter(x => x !== u.id))} />{u.name} <small style={{ color: 'var(--muted)' }}>{roleLabel(u.role)}</small></label>)}</div></Field></div></Modal>;
}

function DirectStatus({ conv }: { conv: any }) {
  const p = usePresence(conv.other_user_id);
  return <div className="cell-sub">{roleLabel(conv.other_role)} · <span className={`pres pres-${p}`}><i />{presenceLabel(p)}</span></div>;
}
/** Audio / video call buttons + the "more" menu in a direct-message header. Calls are placed over the existing direct conversation. */
function CallButtons({ conv }: { conv: any }) {
  const { state, engine } = useCall(); const [menu, setMenu] = useState(false); const [hist, setHist] = useState(false); const box = useRef<HTMLDivElement>(null);
  const free = state.phase === 'idle' || state.phase === 'ended';
  useEffect(() => { const h = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setMenu(false); }; document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h); }, []);
  const peer = { id: conv.other_user_id, name: conv.title, role: conv.other_role };
  const go = (type: 'audio' | 'video') => engine.startCall({ conversationId: conv.id, peer, type });
  return <div className="call-actions-h" ref={box}>
    <button className="btn sm call-start" disabled={!free} onClick={() => go('audio')} title={free ? 'Start audio call' : 'You are already in a call'} aria-label={`Audio call ${conv.title}`}><Ic n="phone" /></button>
    <button className="btn primary sm call-start" disabled={!free} onClick={() => go('video')} title={free ? 'Start video call' : 'You are already in a call'} aria-label={`Video call ${conv.title}`}><Ic n="video" /></button>
    <div className="nav-item"><button className="btn ghost sm" aria-haspopup="menu" aria-expanded={menu} aria-label="More actions" onClick={() => setMenu(m => !m)}><Ic n="more" /></button>
      {menu && <div className="dd open" role="menu" style={{ right: 0, left: 'auto' }}><button role="menuitem" onClick={() => { setMenu(false); setHist(true); }}><Ic n="clock" /> Call history with {conv.title}</button></div>}</div>
    {hist && <Modal title={`Calls with ${conv.title}`} onClose={() => setHist(false)} width={480}><CallHistory withUser={conv.other_user_id} compact /></Modal>}
  </div>;
}
