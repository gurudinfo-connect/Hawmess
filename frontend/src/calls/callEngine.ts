/**
 * CallEngine — the browser side of an internal audio / video call, independent of React.
 *
 * It owns the real media (getUserMedia) and the real RTCPeerConnection, talks to the server over the authenticated
 * Socket.IO connection, and exposes an observable state object for the UI. Browser APIs are injected (`EngineDeps`) so
 * the whole state machine can be unit-tested with fakes (tests/callEngine.test.ts) — but in the app they are the real
 * `navigator.mediaDevices`, `RTCPeerConnection` and `MediaStream`. Nothing here fakes a connection or a video feed.
 *
 * Privacy: the microphone / camera are requested only when the user starts a call or presses Accept, and every track is
 * stopped as soon as the call ends (hang-up, decline, failure, page close, component unmount).
 *
 * WebRTC negotiation uses the "perfect negotiation" pattern (caller = impolite, callee = polite) so that adding the
 * camera mid-call (audio → video), ICE restarts and simultaneous offers never deadlock.
 */

export type CallType = 'audio' | 'video';
export type Phase = 'idle' | 'calling' | 'ringing' | 'incoming' | 'connecting' | 'connected' | 'reconnecting' | 'ended';
export type EndKind = 'completed' | 'declined' | 'missed' | 'busy' | 'offline' | 'cancelled' | 'failed' | 'error';
export interface PeerInfo { id: string; name: string; role: string }
export interface CallEnd { kind: EndKind; message: string; durationSeconds?: number }
export interface CallState {
  phase: Phase; type: CallType; direction?: 'outgoing' | 'incoming'; callId?: string; conversationId?: string; peer?: PeerInfo;
  muted: boolean; cameraOn: boolean; remoteMuted: boolean; remoteVideoOn: boolean;
  connectedAt?: number; localStream?: MediaStream; remoteStream?: MediaStream; streamTick: number;
  notice?: string; end?: CallEnd;
}

export interface SocketLike {
  connected: boolean;
  emit(event: string, ...args: any[]): unknown;
  on(event: string, fn: (...a: any[]) => void): unknown;
  off(event: string, fn?: (...a: any[]) => void): unknown;
}
export interface EngineDeps {
  socket: SocketLike;
  /** undefined when the page is not a secure context (no HTTPS) or the browser has no media support */
  getUserMedia?: (c: MediaStreamConstraints) => Promise<MediaStream>;
  createPeer: (cfg: RTCConfiguration) => RTCPeerConnection;
  createStream: () => MediaStream;
  loadIce: () => Promise<{ iceServers: RTCIceServer[] }>;
  timers?: { setTimeout: (fn: () => void, ms: number) => any; clearTimeout: (h: any) => void; now: () => number };
  /** ms to wait for media to connect after the call is answered */
  connectTimeoutMs?: number;
}

const AUDIO: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const VIDEO: MediaTrackConstraints = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 }, facingMode: 'user' };
export const initialState = (): CallState => ({ phase: 'idle', type: 'audio', muted: false, cameraOn: false, remoteMuted: false, remoteVideoOn: false, streamTick: 0 });

/** Turns a getUserMedia failure into something a non-technical person can act on. */
export function describeMediaError(e: any, what: 'microphone' | 'camera' | 'microphone or camera'): string {
  const n = e?.name || '';
  if (n === 'InsecureContext') return 'Calls need a secure connection. Open this site over HTTPS (or http://localhost) and try again.';
  if (n === 'NotAllowedError' || n === 'PermissionDeniedError' || n === 'SecurityError') return `Access to your ${what} is blocked. Click the lock icon in the address bar, allow ${what} access for this site, then try again.`;
  if (n === 'NotFoundError' || n === 'DevicesNotFoundError' || n === 'OverconstrainedError') return `No ${what} was found. Connect one (or enable it in your system settings) and try again.`;
  if (n === 'NotReadableError' || n === 'TrackStartError' || n === 'AbortError') return `Your ${what} is being used by another app or browser tab. Close it and try again.`;
  return `Could not access your ${what}${n ? ` (${n})` : ''}. Check your browser and device settings.`;
}
const mediaErr = (name: string) => Object.assign(new Error(name), { name });

export class CallEngine {
  private s: CallState = initialState();
  private subs = new Set<() => void>();
  private d: EngineDeps;
  private tm: NonNullable<EngineDeps['timers']>;
  private pc: RTCPeerConnection | null = null;
  private local: MediaStream | null = null;
  private remote: MediaStream | null = null;
  private videoSender: RTCRtpSender | null = null;
  private ice: Promise<{ iceServers: RTCIceServer[] }> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private polite = false; private makingOffer = false; private ignoreOffer = false; private negotiationEnabled = false;
  private attempt = 0;                       // bumps on every new call / end — lets stale async continuations bail out
  private restarts = 0;
  private connectTimer: any; private unstableTimer: any; private disposed = false;
  private handlers: [string, (...a: any[]) => void][] = [];

  constructor(d: EngineDeps) {
    this.d = d; this.tm = d.timers || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: h => clearTimeout(h), now: () => Date.now() };
    const on = (ev: string, fn: (...a: any[]) => void) => { this.handlers.push([ev, fn]); d.socket.on(ev, fn); };
    on('call:incoming', p => this.onIncoming(p));
    on('call:accepted', p => this.onAccepted(p));
    on('call:signal', p => { if (p?.callId === this.s.callId) this.enqueue(() => this.onSignal(p)); });
    on('call:ended', p => this.onEnded(p));
    on('call:handled', p => { if (p?.callId === this.s.callId && this.s.phase === 'incoming') this.reset(); });
    on('call:media-state', p => { if (p?.callId === this.s.callId) this.set({ remoteMuted: !p.audio, remoteVideoOn: !!p.video }); });
    on('call:peer-disconnected', p => { if (p?.callId === this.s.callId && this.inCall()) this.set({ notice: `${this.s.peer?.name || 'The other person'} lost their connection. Waiting for them to reconnect…` }); });
    on('call:peer-rejoined', p => { if (p?.callId === this.s.callId && this.inCall()) { this.set({ notice: undefined }); this.restartIce(); } });
    on('connect', () => this.onSocketConnect());
    on('disconnect', () => this.onSocketDisconnect());
  }

  // ------------------------------------------------------------------ observable state
  getState = () => this.s;
  subscribe = (fn: () => void) => { this.subs.add(fn); return () => { this.subs.delete(fn); }; };
  private set(p: Partial<CallState>) { this.s = { ...this.s, ...p }; this.subs.forEach(f => f()); }
  private bump() { this.set({ streamTick: this.s.streamTick + 1 }); }
  private inCall() { return this.s.phase === 'connecting' || this.s.phase === 'connected' || this.s.phase === 'reconnecting'; }
  private busy() { return this.s.phase !== 'idle' && this.s.phase !== 'ended'; }
  private emit(ev: string, data: any): Promise<any> {
    return new Promise(resolve => {
      let done = false; const t = this.tm.setTimeout(() => { if (!done) { done = true; resolve({ ok: false, code: 'timeout', message: 'The server did not respond. Check your connection and try again.' }); } }, 10_000);
      try { this.d.socket.emit(ev, data, (r: any) => { if (done) return; done = true; this.tm.clearTimeout(t); resolve(r || { ok: false, code: 'invalid', message: 'No response from the server' }); }); } catch { if (!done) { done = true; this.tm.clearTimeout(t); resolve({ ok: false, code: 'invalid', message: 'Could not reach the server' }); } }
    });
  }
  private fire(ev: string, data: any) { try { this.d.socket.emit(ev, data, () => {}); } catch { /* best effort */ } }

  // ------------------------------------------------------------------ user actions
  async startCall(o: { conversationId: string; peer: PeerInfo; type: CallType }) {
    if (this.busy() || this.disposed) return;
    const me = ++this.attempt; this.resetMedia();
    this.s = { ...initialState(), phase: 'calling', type: o.type, direction: 'outgoing', conversationId: o.conversationId, peer: o.peer, notice: 'Waiting for your browser to allow the microphone…' }; this.subs.forEach(f => f());
    if (!this.d.socket.connected) return this.finish({ kind: 'error', message: 'You are offline from the server. Check your connection and try again.' });
    this.ice = this.d.loadIce().catch(() => ({ iceServers: [] }));
    let media; try { media = await this.acquire(o.type); } catch (e: any) { if (me === this.attempt) this.finish({ kind: 'error', message: e.message }); return; }
    if (me !== this.attempt) { media.stream.getTracks().forEach(t => t.stop()); return; }       // hung up while the permission prompt was open
    this.local = media.stream; this.set({ localStream: media.stream, cameraOn: media.stream.getVideoTracks().length > 0, notice: media.notice });
    const r = await this.emit('call:invite', { conversationId: o.conversationId, type: o.type });
    if (me !== this.attempt) { if (r.ok && r.callId) this.fire('call:end', { callId: r.callId }); return; }   // hung up while the invite was in flight — don't leave it ringing
    if (!r.ok) return this.finish({ kind: r.code === 'busy' ? 'busy' : r.code === 'offline' ? 'offline' : 'error', message: r.message || 'Could not start the call' });
    this.set({ callId: r.callId, phase: 'ringing' });
  }

  async acceptIncoming() {
    if (this.s.phase !== 'incoming' || !this.s.callId) return;
    const me = this.attempt; const callId = this.s.callId; const type = this.s.type;
    this.set({ notice: 'Waiting for your browser to allow the microphone…' });
    let media; try { media = await this.acquire(type); } catch (e: any) { if (me === this.attempt) { this.fire('call:decline', { callId, reason: 'media_error' }); this.finish({ kind: 'error', message: e.message }); } return; }
    if (me !== this.attempt || this.s.phase !== 'incoming') { media.stream.getTracks().forEach(t => t.stop()); return; }   // caller gave up while the prompt was open
    this.local = media.stream; this.set({ localStream: media.stream, cameraOn: media.stream.getVideoTracks().length > 0, phase: 'connecting', notice: media.notice });
    this.ice = this.ice || this.d.loadIce().catch(() => ({ iceServers: [] }));
    try { await this.setupPeer(false); } catch (e) { this.fire('call:decline', { callId, reason: 'media_error' }); this.finish({ kind: 'error', message: 'Could not set up the connection.' }); return; }
    const r = await this.emit('call:accept', { callId });
    if (me !== this.attempt) return;
    if (!r.ok) return this.finish({ kind: 'error', message: r.message || 'The call is no longer available' });
    this.armConnectTimeout();
  }

  declineIncoming() {
    if (this.s.phase !== 'incoming' || !this.s.callId) return;
    this.fire('call:decline', { callId: this.s.callId }); this.attempt++; this.reset();
  }

  hangup() {
    const { phase, callId } = this.s;
    if (phase === 'idle' || phase === 'ended') return;
    if (phase === 'incoming') return this.declineIncoming();
    this.attempt++;                                                      // invalidates any pending permission prompt / invite continuation
    if (callId) this.fire('call:end', { callId });
    this.finish(this.s.connectedAt ? { kind: 'completed', message: 'Call ended', durationSeconds: this.duration() } : { kind: 'cancelled', message: phase === 'ringing' || phase === 'calling' ? 'Call cancelled' : 'Call ended' });
  }

  toggleMute() {
    const t = this.local?.getAudioTracks()[0]; if (!t) return;
    t.enabled = !t.enabled; this.set({ muted: !t.enabled }); this.sendMediaState();
  }

  /** Camera off stops the track (the camera light goes out). Camera on re-acquires it; on an audio call this upgrades it to video. */
  async toggleCamera() {
    if (!this.local || !this.inCallOrRinging()) return;
    const cur = this.local.getVideoTracks()[0];
    if (cur) {
      this.local.removeTrack(cur); cur.stop(); try { await this.videoSender?.replaceTrack(null); } catch { /* ignore */ }
      this.set({ cameraOn: false, localStream: this.local }); this.bump(); this.sendMediaState(); return;
    }
    const me = this.attempt;
    let v: MediaStream; try { v = await this.mustGum({ video: VIDEO }); } catch (e: any) { this.set({ notice: describeMediaError(e, 'camera') }); return; }
    const track = v.getVideoTracks()[0];
    if (me !== this.attempt || !this.local || !track) { v.getTracks().forEach(t => t.stop()); return; }
    this.local.addTrack(track);
    try {
      if (this.pc) { if (this.videoSender) await this.videoSender.replaceTrack(track); else this.videoSender = this.pc.addTrack(track, this.local); }
    } catch { track.stop(); this.local.removeTrack(track); this.set({ notice: 'Could not turn the camera on during this call.' }); return; }
    this.set({ cameraOn: true, notice: undefined }); this.bump(); this.sendMediaState();
  }
  private inCallOrRinging() { return this.inCall() || this.s.phase === 'ringing' || this.s.phase === 'calling'; }

  /** Close the end-of-call banner. */
  dismiss() { if (this.s.phase === 'ended') this.reset(); }

  /** Called when the page is closing or the provider unmounts: tell the server, stop the camera / microphone. */
  dispose() {
    if (this.disposed) return; this.disposed = true;
    const { phase, callId } = this.s;
    if (callId && phase !== 'idle' && phase !== 'ended') this.fire(phase === 'incoming' ? 'call:decline' : 'call:end', { callId });
    this.attempt++; this.resetMedia(); this.clearTimers();
    for (const [ev, fn] of this.handlers) this.d.socket.off(ev, fn); this.handlers = []; this.subs.clear();
  }

  // ------------------------------------------------------------------ media
  private async mustGum(c: MediaStreamConstraints) {
    if (!this.d.getUserMedia) throw mediaErr('InsecureContext');
    return this.d.getUserMedia(c);
  }
  private async acquire(type: CallType): Promise<{ stream: MediaStream; notice?: string }> {
    try { return { stream: await this.mustGum({ audio: AUDIO, video: type === 'video' ? VIDEO : false }) }; }
    catch (e: any) {
      if (type !== 'video' || e?.name === 'InsecureContext') throw mediaErr2(e, 'microphone');
      // The failure could be the camera alone: fall back to audio-only rather than refusing the call.
      try { const stream = await this.mustGum({ audio: AUDIO, video: false }); return { stream, notice: `${describeMediaError(e, 'camera')} You are on audio only; press the camera button to turn video on.` }; }
      catch (e2: any) { throw mediaErr2(e2?.name === 'NotFoundError' && e?.name === 'NotFoundError' ? e : e2, 'microphone or camera'); }
    }
  }
  private resetMedia() {
    this.local?.getTracks().forEach(t => { try { t.stop(); } catch { /* ignore */ } }); this.local = null;
    this.remote?.getTracks().forEach(t => { try { t.stop(); } catch { /* ignore */ } }); this.remote = null;
    this.videoSender = null;
    if (this.pc) { const pc = this.pc; this.pc = null; pc.onicecandidate = pc.ontrack = pc.onconnectionstatechange = pc.onnegotiationneeded = null; try { pc.close(); } catch { /* ignore */ } }
    this.chain = Promise.resolve(); this.makingOffer = false; this.ignoreOffer = false; this.negotiationEnabled = false; this.restarts = 0;
  }
  private sendMediaState() { if (this.s.callId && this.inCall()) this.fire('call:media-state', { callId: this.s.callId, audio: !this.s.muted, video: this.s.cameraOn }); }

  // ------------------------------------------------------------------ peer connection (perfect negotiation)
  private async setupPeer(initiator: boolean) {
    const { iceServers } = await (this.ice || Promise.resolve({ iceServers: [] }));
    const pc = this.d.createPeer({ iceServers, bundlePolicy: 'max-bundle' }); this.pc = pc; this.polite = !initiator; this.negotiationEnabled = initiator;
    this.remote = this.d.createStream(); this.set({ remoteStream: this.remote, remoteVideoOn: this.s.type === 'video', remoteMuted: false });
    pc.onicecandidate = e => { if (e.candidate) this.sendSignal('candidate', e.candidate.toJSON ? e.candidate.toJSON() : e.candidate); };
    pc.ontrack = e => { const r = this.remote; if (r && !r.getTracks().includes(e.track)) { r.addTrack(e.track); this.bump(); } e.track.onunmute = () => this.bump(); };
    pc.onconnectionstatechange = () => this.onConnState(pc);
    pc.onnegotiationneeded = async () => {
      if (!this.negotiationEnabled || this.pc !== pc) return;
      try { this.makingOffer = true; await pc.setLocalDescription(); const d = pc.localDescription; if (d) this.sendSignal('offer', { type: d.type, sdp: d.sdp }); }
      catch (err) { console.warn('negotiation failed', err); } finally { this.makingOffer = false; }
    };
    const stream = this.local!;
    for (const t of stream.getTracks()) { const sender = pc.addTrack(t, stream); if (t.kind === 'video') this.videoSender = sender; }
  }
  private sendSignal(kind: 'offer' | 'answer' | 'candidate', data: any) { if (this.s.callId) this.fire('call:signal', { callId: this.s.callId, kind, data }); }
  private enqueue(fn: () => Promise<void>) { this.chain = this.chain.then(fn).catch(e => console.warn('signal handling failed', e)); }

  private async onSignal(m: { kind: 'offer' | 'answer' | 'candidate'; data: any }) {
    const pc = this.pc; if (!pc) return;
    if (m.kind === 'candidate') { try { await pc.addIceCandidate(m.data); } catch (e) { if (!this.ignoreOffer) console.warn('addIceCandidate failed', e); } return; }
    const collision = m.kind === 'offer' && (this.makingOffer || pc.signalingState !== 'stable');
    this.ignoreOffer = !this.polite && collision; if (this.ignoreOffer) return;
    await pc.setRemoteDescription({ type: m.kind, sdp: m.data.sdp });
    if (m.kind === 'offer') { await pc.setLocalDescription(); const d = pc.localDescription; if (d) this.sendSignal('answer', { type: d.type, sdp: d.sdp }); this.negotiationEnabled = true; }
  }

  private onConnState(pc: RTCPeerConnection) {
    if (pc !== this.pc) return; const st = pc.connectionState;
    if (st === 'connected') {
      this.tm.clearTimeout(this.connectTimer); this.tm.clearTimeout(this.unstableTimer); this.restarts = 0;
      const first = !this.s.connectedAt;
      this.set({ phase: 'connected', connectedAt: this.s.connectedAt || this.tm.now(), notice: this.s.notice?.startsWith('Connection unstable') ? undefined : this.s.notice });
      if (first && this.s.callId) this.fire('call:connected', { callId: this.s.callId }); this.sendMediaState();
    } else if (st === 'disconnected') {
      if (this.s.phase === 'connected') this.set({ phase: 'reconnecting', notice: 'Connection unstable. Trying to reconnect…' });
      this.tm.clearTimeout(this.unstableTimer); this.unstableTimer = this.tm.setTimeout(() => { if (this.pc === pc && pc.connectionState !== 'connected') this.restartIce(); }, 5000);
    } else if (st === 'failed') { this.restartIce(true); }
  }
  /** Try to heal a broken path (network change, brief outage). After two failed attempts the call is ended as failed. */
  private restartIce(fromFailure = false) {
    const pc = this.pc; if (!pc || !this.inCall()) return;
    if (fromFailure && this.restarts >= 2) {
      if (this.s.callId) this.fire('call:failed', { callId: this.s.callId, reason: 'ice_failed' });
      return this.finish({ kind: 'failed', message: 'The connection was lost and could not be restored. If this keeps happening, ask IT to configure a TURN server for calls.' });
    }
    if (fromFailure) this.restarts++;
    if (pc.connectionState !== 'connected') this.set({ phase: this.s.connectedAt ? 'reconnecting' : this.s.phase, notice: 'Connection unstable. Trying to reconnect…' });
    try { pc.restartIce(); } catch { /* older browsers: renegotiation below */ }
    this.tm.clearTimeout(this.unstableTimer);
    this.unstableTimer = this.tm.setTimeout(() => { if (this.pc === pc && pc.connectionState !== 'connected') this.restartIce(true); }, 10_000);
  }
  private armConnectTimeout() {
    this.tm.clearTimeout(this.connectTimer);
    this.connectTimer = this.tm.setTimeout(() => {
      if (this.s.phase !== 'connecting') return;
      if (this.s.callId) this.fire('call:failed', { callId: this.s.callId, reason: 'ice_failed' });
      this.finish({ kind: 'failed', message: 'Could not connect the call. Your network may block direct calls; ask IT to configure a TURN server.' });
    }, this.d.connectTimeoutMs ?? 30_000);
  }

  // ------------------------------------------------------------------ server events
  private onIncoming(p: any) {
    if (this.disposed || !p?.callId || !p.from) return;
    if (this.busy()) { this.fire('call:decline', { callId: p.callId }); return; }       // this tab is already in a call
    ++this.attempt; this.resetMedia();
    this.s = { ...initialState(), phase: 'incoming', type: p.type === 'video' ? 'video' : 'audio', direction: 'incoming', callId: p.callId, conversationId: p.conversationId, peer: { id: p.from.id, name: String(p.from.name), role: String(p.from.role) } }; this.subs.forEach(f => f());
    this.ice = this.d.loadIce().catch(() => ({ iceServers: [] }));       // warm up while it rings
  }
  private onAccepted(p: any) {
    if (p?.callId !== this.s.callId || this.s.phase !== 'ringing') return;
    this.set({ phase: 'connecting', notice: undefined });
    this.enqueue(async () => { if (this.s.phase !== 'connecting') return; await this.setupPeer(true); this.armConnectTimeout(); });
  }
  private onEnded(p: any) {
    if (!p || p.callId !== this.s.callId || this.s.phase === 'idle' || this.s.phase === 'ended') return;
    const name = this.s.peer?.name || 'The other person'; const incoming = this.s.direction === 'incoming'; const dur = p.duration_seconds || 0;
    let end: CallEnd;
    switch (p.status) {
      case 'completed': end = { kind: 'completed', message: 'Call ended', durationSeconds: dur }; break;
      case 'declined': end = { kind: 'declined', message: `${name} declined the call` }; break;
      case 'missed': end = incoming ? { kind: 'missed', message: `Missed call from ${name}` } : p.reason === 'busy' ? { kind: 'busy', message: `${name} is on another call` } : { kind: 'missed', message: `${name} did not answer` }; break;
      case 'cancelled': end = incoming ? { kind: 'missed', message: `Missed call from ${name}` } : { kind: 'cancelled', message: 'Call cancelled' }; break;
      default: end = { kind: 'failed', message: p.reason === 'disconnected' ? `The call was dropped because ${name} lost their connection.` : p.reason === 'media_error' ? `${name} could not start their microphone or camera.` : 'The call could not be completed.' };
    }
    this.finish(end);
  }
  private onSocketDisconnect() {
    const { phase } = this.s;
    if (phase === 'calling' || phase === 'ringing' || phase === 'incoming') { this.attempt++; this.finish({ kind: 'failed', message: 'Lost connection to the server before the call was answered.' }); return; }
    if (this.inCall()) this.set({ phase: 'reconnecting', notice: 'Connection to the server lost. Reconnecting…' });
  }
  private async onSocketConnect() {
    if (!this.inCall() || !this.s.callId) return;
    const r = await this.emit('call:rejoin', { callId: this.s.callId });
    if (!this.inCall()) return;
    if (!r.ok) return this.finish({ kind: 'failed', message: 'The call ended while you were disconnected.' });
    this.set({ notice: undefined, phase: this.pc?.connectionState === 'connected' ? 'connected' : this.s.phase === 'reconnecting' ? 'connecting' : this.s.phase });
    this.restartIce();
  }

  // ------------------------------------------------------------------ finishing
  private duration() { return this.s.connectedAt ? Math.max(0, Math.round((this.tm.now() - this.s.connectedAt) / 1000)) : 0; }
  private clearTimers() { this.tm.clearTimeout(this.connectTimer); this.tm.clearTimeout(this.unstableTimer); }
  private finish(end: CallEnd) {
    this.clearTimers(); this.resetMedia();
    this.s = { ...this.s, phase: 'ended', end, localStream: undefined, remoteStream: undefined, cameraOn: false, muted: false, notice: undefined }; this.subs.forEach(f => f());
  }
  private reset() { this.clearTimers(); this.resetMedia(); this.s = initialState(); this.subs.forEach(f => f()); }
}
const mediaErr2 = (e: any, what: 'microphone' | 'camera' | 'microphone or camera') => Object.assign(new Error(describeMediaError(e, what)), { name: e?.name });
