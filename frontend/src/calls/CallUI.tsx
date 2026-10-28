import React, { useEffect, useRef, useState } from 'react';
import { Avatar, Ic } from '../ui';
import { roleLabel } from '../api';
import { useCall } from './CallProvider';
import { startRing } from './ringtone';

export const fmtClock = (sec: number) => { const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60; return `${h ? h + ':' + String(m).padStart(2, '0') : m}:${String(s).padStart(2, '0')}`; };
function useTicker(since?: number) { const [, f] = useState(0); useEffect(() => { if (!since) return; const t = setInterval(() => f(x => x + 1), 1000); return () => clearInterval(t); }, [since]); return since ? Math.max(0, Math.floor((Date.now() - since) / 1000)) : 0; }
function useStream(ref: React.RefObject<HTMLMediaElement>, stream?: MediaStream, tick?: number) { useEffect(() => { const el = ref.current; if (el && el.srcObject !== (stream || null)) el.srcObject = stream || null; }, [stream, tick]); }   // eslint-disable-line

const STATUS: Record<string, string> = { calling: 'Calling…', ringing: 'Ringing…', connecting: 'Connecting…', connected: 'Connected', reconnecting: 'Reconnecting…' };

export function CallLayer() {
  const { state: s, engine } = useCall();
  useEffect(() => { if (s.phase === 'incoming') return startRing('incoming'); if (s.phase === 'ringing') return startRing('outgoing'); }, [s.phase]);
  useEffect(() => { if (s.phase !== 'ended') return; const t = setTimeout(() => engine.dismiss(), s.end?.kind === 'completed' ? 3500 : 6000); return () => clearTimeout(t); }, [s.phase, s.end, engine]);
  if (s.phase === 'idle') return null;
  if (s.phase === 'incoming') return <Incoming />;
  if (s.phase === 'ended') return <Ended />;
  return <Screen />;
}

function Incoming() {
  const { state: s, engine } = useCall(); const ok = useRef<HTMLButtonElement>(null); useEffect(() => { ok.current?.focus(); }, []);
  return <div className="call-bg" role="alertdialog" aria-modal="true" aria-labelledby="inc-t" aria-live="assertive"><div className="call-card">
    <div className="call-pulse"><Avatar name={s.peer?.name} size="lg" /></div>
    <h3 id="inc-t">{s.peer?.name}</h3><p className="sub">{roleLabel(s.peer?.role)} · Incoming {s.type} call</p>
    {s.notice && <p className="call-note" role="status">{s.notice}</p>}
    <div className="call-actions"><button className="call-btn end" onClick={() => engine.declineIncoming()} aria-label="Decline"><Ic n="phone" className="hang" /><span>Decline</span></button>
      <button ref={ok} className="call-btn accept" onClick={() => engine.acceptIncoming()} aria-label={`Accept ${s.type} call`}><Ic n={s.type === 'video' ? 'video' : 'phone'} /><span>Accept</span></button></div></div></div>;
}

function Ended() {
  const { state: s, engine } = useCall(); const e = s.end!;
  return <div className={`call-toast ${e.kind}`} role="status" aria-live="polite"><Ic n={e.kind === 'completed' ? 'check' : 'phone'} /><div><b>{e.message}</b>{e.durationSeconds ? <small> Duration {fmtClock(e.durationSeconds)}</small> : null}</div>
    <button className="btn ghost sm" onClick={() => engine.dismiss()} aria-label="Dismiss"><Ic n="x" /></button></div>;
}

function Screen() {
  const { state: s, engine } = useCall(); const secs = useTicker(s.connectedAt);
  const rv = useRef<HTMLVideoElement>(null), lv = useRef<HTMLVideoElement>(null);
  useStream(rv, s.remoteStream, s.streamTick); useStream(lv, s.localStream, s.streamTick);
  const showRemote = s.remoteVideoOn && !!s.remoteStream?.getVideoTracks().length; const video = s.cameraOn || showRemote;
  const status = s.phase === 'connected' ? fmtClock(secs) : STATUS[s.phase];
  return <div className={`call-screen ${video ? 'is-video' : ''}`} role="dialog" aria-label={`${s.type} call with ${s.peer?.name}`}>
    <header><div><b>{s.peer?.name}</b><span>{roleLabel(s.peer?.role)}</span></div>
      <span className={`call-state st-${s.phase}`} role="status" aria-live="polite">{s.phase === 'connected' && <i className="live" />}{status}</span></header>
    <div className="call-stage">
      <video ref={rv} className={`remote ${showRemote ? '' : 'off'}`} autoPlay playsInline aria-label={`${s.peer?.name} video`} />
      {!showRemote && <div className="call-avatar"><div className={s.phase === 'connected' ? '' : 'call-pulse'}><Avatar name={s.peer?.name} size="lg" /></div><h3>{s.peer?.name}</h3>
        <p className="sub">{s.phase === 'connected' ? (s.remoteVideoOn ? 'Camera starting…' : 'Camera is off') : STATUS[s.phase]}</p></div>}
      {s.remoteMuted && s.phase === 'connected' && <span className="call-tag"><Ic n="micoff" /> {s.peer?.name} is muted</span>}
      {s.cameraOn && <video ref={lv} className="local" autoPlay playsInline muted aria-label="Your camera preview" />}
    </div>
    {s.notice && <div className="call-banner" role="status">{s.notice}</div>}
    <div className="call-actions">
      <button className={`call-btn ${s.muted ? 'on' : ''}`} onClick={() => engine.toggleMute()} aria-pressed={s.muted} aria-label={s.muted ? 'Unmute microphone' : 'Mute microphone'}><Ic n={s.muted ? 'micoff' : 'mic'} /><span>{s.muted ? 'Unmute' : 'Mute'}</span></button>
      <button className={`call-btn ${s.cameraOn ? '' : 'on'}`} onClick={() => engine.toggleCamera()} aria-pressed={s.cameraOn} aria-label={s.cameraOn ? 'Turn camera off' : 'Turn camera on'}><Ic n={s.cameraOn ? 'video' : 'videooff'} /><span>{s.cameraOn ? 'Camera off' : 'Camera on'}</span></button>
      <button className="call-btn end" onClick={() => engine.hangup()} aria-label="End call"><Ic n="phone" className="hang" /><span>End call</span></button>
    </div></div>;
}
