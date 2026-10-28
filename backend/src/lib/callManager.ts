/**
 * Call manager — the authoritative, transport-independent state machine for internal audio / video calls.
 *
 * It knows nothing about Socket.IO or Postgres: those are injected (`Transport`, `CallStore`, `Timers`), which keeps every
 * authorisation rule and every state transition unit-testable (tests/callManager.test.ts) and lets the Socket.IO glue
 * (lib/callSocket.ts) stay a thin, dumb adapter.
 *
 * Security model
 *  - The caller's identity is ALWAYS the authenticated socket user. The callee is derived server-side from the direct
 *    conversation (`CallStore.findDirectPeer`) — a browser-supplied user id is never trusted.
 *  - Calls follow the existing DM rule (anyone active in the company may message anyone else) because a call can only be
 *    started from a direct conversation that both people are members of.
 *  - Every later event (accept / decline / end / signal / media-state / rejoin) is checked against the call's two
 *    participants AND the specific socket that holds each role, so a third user — or a second tab — cannot join, inject
 *    SDP / ICE, or hang up somebody else's call.
 *  - Only call metadata is persisted. SDP, ICE candidates and media never touch the database.
 *
 * State is held in memory (single API instance). For several instances use the Socket.IO Redis adapter plus a shared store.
 */
import { randomUUID } from 'node:crypto';

export type CallType = 'audio' | 'video';
export type FinalStatus = 'completed' | 'missed' | 'declined' | 'failed' | 'cancelled';
export type Presence = 'available' | 'busy' | 'offline';
export type Role = 'admin' | 'hr' | 'employee';

export interface CallUser { id: string; name: string; role: Role; company_id: string }
export interface Party { id: string; name: string; role: Role }
export interface Peer extends Party { is_active: boolean }
export interface Ctx { socketId: string; user: CallUser }

export interface FinishedCall {
  id: string; company_id: string; conversation_id: string; type: CallType; caller: Party; callee: Party;
  status: FinalStatus; reason: string; duration_seconds: number; started_at: Date; ended_at: Date;
}

export interface CallStore {
  findDirectPeer(conversationId: string, callerId: string, companyId: string): Promise<Peer | null>;
  isActiveUser(userId: string, companyId: string): Promise<boolean>;
  /** Inserts the row and returns its id. A final status (busy / offline) is inserted already ended. */
  insertCall(c: { company_id: string; conversation_id: string; caller_id: string; callee_id: string; call_type: CallType; status: 'ringing' | FinalStatus; end_reason?: string }): Promise<string>;
  markActive(id: string, at: Date): Promise<void>;
  markConnected(id: string, at: Date): Promise<void>;
  finish(id: string, f: { status: FinalStatus; end_reason: string; ended_at: Date; duration_seconds: number }): Promise<void>;
}
export interface Transport {
  toSocket(socketId: string, event: string, payload: unknown): void;
  toCompany(companyId: string, event: string, payload: unknown): void;
}
export interface Timers { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void; now(): number }
export interface Options { ringTimeoutMs: number; reconnectGraceMs: number; inviteMinIntervalMs: number; maxSignalsPerWindow: number; signalWindowMs: number }
export interface Deps { store: CallStore; transport: Transport; timers?: Timers; options?: Partial<Options>; onFinished?: (c: FinishedCall) => void | Promise<void>; log?: (msg: string, err?: unknown) => void }

export type Ack<T = {}> = ({ ok: true } & T) | { ok: false; code: ErrorCode; message: string };
export type ErrorCode = 'invalid' | 'forbidden' | 'not_found' | 'busy' | 'offline' | 'already_in_call' | 'rate_limited' | 'gone' | 'conflict' | 'cancelled';

export const DEFAULT_OPTIONS: Options = { ringTimeoutMs: 45_000, reconnectGraceMs: 20_000, inviteMinIntervalMs: 1_500, maxSignalsPerWindow: 400, signalWindowMs: 10_000 };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_REASONS = new Set(['ice_failed', 'media_error', 'client_error']);
const MAX_SDP = 100_000;
const err = (code: ErrorCode, message: string): { ok: false; code: ErrorCode; message: string } => ({ ok: false, code, message });

interface Active {
  id: string; ready: Promise<string>; finished: boolean;
  company_id: string; conversation_id: string; type: CallType; caller: Party; callee: Party;
  state: 'ringing' | 'active';
  callerSocket: string | null; calleeSocket: string | null; ringing: Set<string>;
  startedAt: number; answeredAt?: number; connectedAt?: number;
  ringTimer?: unknown; graceTimers: { caller?: unknown; callee?: unknown };
}

export class CallManager {
  private o: Options; private t: Timers; private store: CallStore; private tx: Transport; private log: (m: string, e?: unknown) => void;
  private byId = new Map<string, Active>();
  private byUser = new Map<string, Active>();                 // a user can be in ONE call at a time (this is also the "busy" state)
  private sockets = new Map<string, CallUser>();              // socketId -> authenticated user
  private userSockets = new Map<string, Set<string>>();
  private lastPresence = new Map<string, Presence>();
  private lastInvite = new Map<string, number>();
  private signalWindow = new Map<string, { start: number; n: number }>();
  private onFinished?: Deps['onFinished'];

  constructor(d: Deps) {
    this.store = d.store; this.tx = d.transport; this.o = { ...DEFAULT_OPTIONS, ...(d.options || {}) }; this.onFinished = d.onFinished;
    this.log = d.log || ((m, e) => console.error(m, e));
    this.t = d.timers || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: h => clearTimeout(h as any), now: () => Date.now() };
  }
  get options(): Options { return this.o; }

  // ------------------------------------------------------------------ presence
  presenceOf(userId: string): Presence { return !this.userSockets.get(userId)?.size ? 'offline' : this.byUser.has(userId) ? 'busy' : 'available'; }
  presenceSnapshot(companyId: string): Record<string, Presence> {
    const out: Record<string, Presence> = {};
    for (const [uid, set] of this.userSockets) { const u = set.size ? this.sockets.get([...set][0]) : null; if (u && u.company_id === companyId) out[uid] = this.presenceOf(uid); }
    return out;
  }
  private refreshPresence(userId: string, companyId: string) {
    const p = this.presenceOf(userId);
    if (this.lastPresence.get(userId) === p) return;
    if (p === 'offline') this.lastPresence.delete(userId); else this.lastPresence.set(userId, p);
    this.tx.toCompany(companyId, 'presence:update', { user_id: userId, status: p });
  }

  // ------------------------------------------------------------------ sockets
  connect(ctx: Ctx) {
    this.sockets.set(ctx.socketId, ctx.user);
    let set = this.userSockets.get(ctx.user.id); if (!set) this.userSockets.set(ctx.user.id, set = new Set());
    set.add(ctx.socketId); this.refreshPresence(ctx.user.id, ctx.user.company_id);
  }
  disconnect(socketId: string) {
    const u = this.sockets.get(socketId); if (!u) return;
    this.sockets.delete(socketId);
    const set = this.userSockets.get(u.id); set?.delete(socketId); if (set && !set.size) this.userSockets.delete(u.id);
    this.signalWindow.delete(socketId);
    const c = this.byUser.get(u.id); if (c && !c.finished) this.socketGone(c, u.id, socketId);
    this.refreshPresence(u.id, u.company_id);
  }
  private socketGone(c: Active, userId: string, socketId: string) {
    const isCaller = userId === c.caller.id;
    if (c.state === 'ringing') {
      if (isCaller && c.callerSocket === socketId) void this.finish(c, 'cancelled', 'caller_disconnected');
      else if (!isCaller) { c.ringing.delete(socketId); if (!c.ringing.size) void this.finish(c, 'missed', 'callee_disconnected'); }   // every device that was ringing is gone
      return;
    }
    const role = isCaller ? 'caller' : 'callee'; const mine = isCaller ? c.callerSocket : c.calleeSocket; if (mine !== socketId) return;
    if (isCaller) c.callerSocket = null; else c.calleeSocket = null;
    const peerSock = isCaller ? c.calleeSocket : c.callerSocket;
    if (peerSock) this.tx.toSocket(peerSock, 'call:peer-disconnected', { callId: c.id, graceMs: this.o.reconnectGraceMs });
    c.graceTimers[role] = this.t.setTimeout(() => { void this.finish(c, c.connectedAt ? 'completed' : 'failed', 'disconnected'); }, this.o.reconnectGraceMs);
  }

  // ------------------------------------------------------------------ invite
  async invite(ctx: Ctx, input: any): Promise<Ack<{ callId: string; ringTimeoutMs: number }>> {
    const type = input?.type, conversationId = input?.conversationId;
    if ((type !== 'audio' && type !== 'video') || typeof conversationId !== 'string' || !UUID_RE.test(conversationId)) return err('invalid', 'Invalid call request');
    const me = ctx.user; const now = this.t.now();
    if (now - (this.lastInvite.get(me.id) || 0) < this.o.inviteMinIntervalMs) return err('rate_limited', 'Please wait a moment before calling again');
    this.lastInvite.set(me.id, now);
    if (!(await this.store.isActiveUser(me.id, me.company_id))) return err('forbidden', 'Your account is not active');
    const peer = await this.store.findDirectPeer(conversationId, me.id, me.company_id);
    if (!peer || peer.id === me.id) return err('forbidden', 'You can only call someone you have a direct conversation with');
    if (!peer.is_active) return err('not_found', `${peer.name} is no longer active`);

    // ---- synchronous section: no await between the checks and the reservation, so two simultaneous invites cannot both win
    const mine = this.byUser.get(me.id);
    if (mine) { if (mine.state === 'active' && this.roleSocket(mine, me.id) === null) void this.finish(mine, mine.connectedAt ? 'completed' : 'failed', 'superseded'); else return err('already_in_call', 'You are already in a call'); }
    const base = { company_id: me.company_id, conversation_id: conversationId, caller_id: me.id, callee_id: peer.id, call_type: type as CallType };
    const calleeSockets = [...(this.userSockets.get(peer.id) || [])].filter(s => this.sockets.get(s)?.company_id === me.company_id);
    const busy = this.byUser.has(peer.id);
    if (busy || !calleeSockets.length) {
      const reason = busy ? 'busy' : 'offline'; const code = busy ? 'busy' : 'offline';
      try { const id = await this.store.insertCall({ ...base, status: 'missed', end_reason: reason }); await this.fire({ id, company_id: me.company_id, conversation_id: conversationId, type, caller: me, callee: peer, status: 'missed', reason, duration_seconds: 0, started_at: new Date(now), ended_at: new Date(now) }); } catch (e) { this.log('call: could not record missed call', e); }
      return err(code, busy ? `${peer.name} is on another call` : `${peer.name} is offline`);
    }
    const c: Active = { id: '', ready: undefined as any, finished: false, company_id: me.company_id, conversation_id: conversationId, type, caller: { id: me.id, name: me.name, role: me.role }, callee: { id: peer.id, name: peer.name, role: peer.role },
      state: 'ringing', callerSocket: ctx.socketId, calleeSocket: null, ringing: new Set(), startedAt: now, graceTimers: {} };
    this.byUser.set(me.id, c); this.byUser.set(peer.id, c);
    c.ready = this.store.insertCall({ ...base, status: 'ringing' });
    // ---- end synchronous section
    try { c.id = await c.ready; } catch (e) { this.log('call: could not create call', e); c.finished = true; this.release(c); return err('invalid', 'Could not start the call, please try again'); }
    if (c.finished) { return err('cancelled', 'The call was cancelled'); }       // caller vanished while the row was being written
    this.byId.set(c.id, c);
    const live = calleeSockets.filter(s => this.sockets.has(s));
    if (!live.length) { await this.finish(c, 'missed', 'offline'); return err('offline', `${peer.name} is offline`); }
    c.ringing = new Set(live);
    for (const s of live) this.tx.toSocket(s, 'call:incoming', { callId: c.id, conversationId, type, from: c.caller, ringTimeoutMs: this.o.ringTimeoutMs });
    c.ringTimer = this.t.setTimeout(() => { void this.finish(c, 'missed', 'timeout'); }, this.o.ringTimeoutMs);
    this.refreshPresence(me.id, me.company_id); this.refreshPresence(peer.id, me.company_id);
    return { ok: true, callId: c.id, ringTimeoutMs: this.o.ringTimeoutMs };
  }

  // ------------------------------------------------------------------ answer / end
  async accept(ctx: Ctx, input: any): Promise<Ack> {
    const c = this.lookup(input?.callId); if (!c) return err('gone', 'This call is no longer available');
    if (c.callee.id !== ctx.user.id || c.state !== 'ringing' || !c.ringing.has(ctx.socketId)) return err('forbidden', 'You cannot answer this call');
    if (!(await this.store.isActiveUser(ctx.user.id, ctx.user.company_id))) return err('forbidden', 'Your account is not active');
    if (c.finished || c.state !== 'ringing' || !c.ringing.has(ctx.socketId)) return err('gone', 'This call is no longer available');   // changed while we awaited
    c.state = 'active'; c.calleeSocket = ctx.socketId; c.answeredAt = this.t.now();
    if (c.ringTimer) { this.t.clearTimeout(c.ringTimer); c.ringTimer = undefined; }
    for (const s of c.ringing) if (s !== ctx.socketId) this.tx.toSocket(s, 'call:handled', { callId: c.id, reason: 'answered_elsewhere' });
    c.ringing.clear();
    if (c.callerSocket) this.tx.toSocket(c.callerSocket, 'call:accepted', { callId: c.id });
    this.store.markActive(c.id, new Date(c.answeredAt)).catch(e => this.log('call: markActive failed', e));
    return { ok: true };
  }
  async decline(ctx: Ctx, input: any): Promise<Ack> {
    const c = this.lookup(input?.callId); if (!c) return err('gone', 'This call is no longer available');
    if (c.callee.id !== ctx.user.id || c.state !== 'ringing' || !c.ringing.has(ctx.socketId)) return err('forbidden', 'You cannot decline this call');
    if (input?.reason === 'media_error') await this.finish(c, 'failed', 'media_error'); else await this.finish(c, 'declined', 'declined');
    return { ok: true };
  }
  async end(ctx: Ctx, input: any): Promise<Ack> {
    const c = this.lookup(input?.callId); if (!c) return { ok: true };            // already over — idempotent
    const uid = ctx.user.id; const isCaller = uid === c.caller.id; const isCallee = uid === c.callee.id;
    if (!isCaller && !isCallee) return err('forbidden', 'You are not part of this call');
    if (c.state === 'ringing') {
      if (isCaller) { if (c.callerSocket !== ctx.socketId) return err('forbidden', 'This call belongs to another session'); await this.finish(c, 'cancelled', 'cancelled'); }
      else { if (!c.ringing.has(ctx.socketId)) return err('forbidden', 'You cannot end this call'); await this.finish(c, 'declined', 'declined'); }
      return { ok: true };
    }
    if (this.roleSocket(c, uid) !== ctx.socketId) return err('forbidden', 'This call belongs to another session');
    await this.finish(c, c.connectedAt ? 'completed' : 'cancelled', c.connectedAt ? 'hangup' : 'hangup_before_connect');
    return { ok: true };
  }

  // ------------------------------------------------------------------ in-call events
  signal(ctx: Ctx, input: any): Ack {
    const c = this.participantCall(ctx, input?.callId); if ('ok' in c) return c;
    if (!this.allowSignal(ctx.socketId)) return err('rate_limited', 'Too many signaling messages');
    const clean = sanitizeSignal(input?.kind, input?.data); if (!clean) return err('invalid', 'Invalid signaling message');
    const peerSock = this.peerSocket(c.call, ctx.user.id); if (!peerSock) return err('gone', 'The other person is not connected right now');
    this.tx.toSocket(peerSock, 'call:signal', { callId: c.call.id, kind: input.kind, data: clean });
    return { ok: true };
  }
  mediaState(ctx: Ctx, input: any): Ack {
    const c = this.participantCall(ctx, input?.callId); if ('ok' in c) return c;
    if (typeof input?.audio !== 'boolean' || typeof input?.video !== 'boolean') return err('invalid', 'Invalid media state');
    const peerSock = this.peerSocket(c.call, ctx.user.id); if (peerSock) this.tx.toSocket(peerSock, 'call:media-state', { callId: c.call.id, audio: input.audio, video: input.video });
    return { ok: true };
  }
  connected(ctx: Ctx, input: any): Ack {
    const c = this.participantCall(ctx, input?.callId); if ('ok' in c) return c;
    if (!c.call.connectedAt) { c.call.connectedAt = this.t.now(); this.store.markConnected(c.call.id, new Date(c.call.connectedAt)).catch(e => this.log('call: markConnected failed', e)); }
    return { ok: true };
  }
  async failed(ctx: Ctx, input: any): Promise<Ack> {
    const c = this.participantCall(ctx, input?.callId); if ('ok' in c) return c;
    const reason = SAFE_REASONS.has(input?.reason) ? input.reason : 'client_error';
    await this.finish(c.call, c.call.connectedAt && reason === 'ice_failed' ? 'completed' : 'failed', reason);
    return { ok: true };
  }
  /** A reloaded socket (same authenticated user) takes its seat back within the grace window. */
  rejoin(ctx: Ctx, input: any): Ack<{ type: CallType; peer: Party; connected: boolean }> {
    const c = this.lookup(input?.callId); if (!c || c.state !== 'active') return err('gone', 'This call has ended');
    const uid = ctx.user.id; const isCaller = uid === c.caller.id; if (!isCaller && uid !== c.callee.id) return err('forbidden', 'You are not part of this call');
    const cur = this.roleSocket(c, uid); if (cur && cur !== ctx.socketId && this.sockets.has(cur)) return err('conflict', 'This call is active in another session');
    const role = isCaller ? 'caller' : 'callee';
    if (isCaller) c.callerSocket = ctx.socketId; else c.calleeSocket = ctx.socketId;
    if (c.graceTimers[role]) { this.t.clearTimeout(c.graceTimers[role]); c.graceTimers[role] = undefined; }
    const peerSock = this.peerSocket(c, uid); if (peerSock) this.tx.toSocket(peerSock, 'call:peer-rejoined', { callId: c.id });
    return { ok: true, type: c.type, peer: isCaller ? c.callee : c.caller, connected: !!c.connectedAt };
  }

  // ------------------------------------------------------------------ housekeeping
  /** Finish every open call (used on graceful shutdown). */
  async shutdown() { for (const c of [...new Set(this.byUser.values())]) await this.finish(c, c.connectedAt ? 'completed' : 'failed', 'server_shutdown'); }
  activeCallOf(userId: string) { const c = this.byUser.get(userId); return c ? { id: c.id, state: c.state } : null; }

  // ------------------------------------------------------------------ internals
  private lookup(id: unknown): Active | undefined { return typeof id === 'string' && UUID_RE.test(id) ? this.byId.get(id) : undefined; }
  private roleSocket(c: Active, uid: string) { return uid === c.caller.id ? c.callerSocket : c.calleeSocket; }
  private peerSocket(c: Active, uid: string) { return uid === c.caller.id ? c.calleeSocket : c.callerSocket; }
  private participantCall(ctx: Ctx, id: unknown): { call: Active } | { ok: false; code: ErrorCode; message: string } {
    const c = this.lookup(id); if (!c || c.state !== 'active') return err('gone', 'This call is not active');
    const uid = ctx.user.id; if (uid !== c.caller.id && uid !== c.callee.id) return err('forbidden', 'You are not part of this call');
    if (this.roleSocket(c, uid) !== ctx.socketId) return err('forbidden', 'This call belongs to another session');
    return { call: c };
  }
  private allowSignal(socketId: string) {
    const now = this.t.now(); const w = this.signalWindow.get(socketId);
    if (!w || now - w.start > this.o.signalWindowMs) { this.signalWindow.set(socketId, { start: now, n: 1 }); return true; }
    return ++w.n <= this.o.maxSignalsPerWindow;
  }
  private release(c: Active) { if (this.byUser.get(c.caller.id) === c) this.byUser.delete(c.caller.id); if (this.byUser.get(c.callee.id) === c) this.byUser.delete(c.callee.id); if (c.id) this.byId.delete(c.id); }
  private async fire(f: FinishedCall) { try { await this.onFinished?.(f); } catch (e) { this.log('call: onFinished hook failed', e); } }

  private async finish(c: Active, status: FinalStatus, reason: string) {
    if (c.finished) return; c.finished = true;
    for (const k of ['caller', 'callee'] as const) { const h = c.graceTimers[k]; if (h) this.t.clearTimeout(h); c.graceTimers[k] = undefined; }
    if (c.ringTimer) { this.t.clearTimeout(c.ringTimer); c.ringTimer = undefined; }
    this.release(c);
    const endedAt = this.t.now(); const duration = c.connectedAt ? Math.max(0, Math.round((endedAt - c.connectedAt) / 1000)) : 0;
    const payload = { callId: c.id, status, reason, duration_seconds: duration };
    const targets = new Set<string>([...c.ringing]); if (c.callerSocket) targets.add(c.callerSocket); if (c.calleeSocket) targets.add(c.calleeSocket);
    c.ringing.clear();
    for (const s of targets) this.tx.toSocket(s, 'call:ended', payload);
    this.refreshPresence(c.caller.id, c.company_id); this.refreshPresence(c.callee.id, c.company_id);
    let id = c.id; try { id = id || await c.ready; } catch { return; }                // the insert failed — nothing to update
    try { await this.store.finish(id, { status, end_reason: reason, ended_at: new Date(endedAt), duration_seconds: duration }); } catch (e) { this.log('call: could not save call result', e); }
    await this.fire({ id, company_id: c.company_id, conversation_id: c.conversation_id, type: c.type, caller: c.caller, callee: c.callee, status, reason, duration_seconds: duration, started_at: new Date(c.startedAt), ended_at: new Date(endedAt) });
  }
}

/** Only well-formed SDP / ICE objects are relayed, and only the known fields — never arbitrary client JSON. */
export function sanitizeSignal(kind: unknown, data: any): Record<string, unknown> | null {
  if (kind === 'offer' || kind === 'answer') {
    if (!data || data.type !== kind || typeof data.sdp !== 'string' || !data.sdp.length || data.sdp.length > MAX_SDP) return null;
    return { type: data.type, sdp: data.sdp };
  }
  if (kind === 'candidate') {
    if (!data || typeof data.candidate !== 'string' || data.candidate.length > 2000) return null;
    const out: Record<string, unknown> = { candidate: data.candidate };
    if (typeof data.sdpMid === 'string' && data.sdpMid.length <= 64) out.sdpMid = data.sdpMid; else out.sdpMid = null;
    out.sdpMLineIndex = Number.isInteger(data.sdpMLineIndex) && data.sdpMLineIndex >= 0 && data.sdpMLineIndex < 64 ? data.sdpMLineIndex : null;
    if (typeof data.usernameFragment === 'string' && data.usernameFragment.length <= 256) out.usernameFragment = data.usernameFragment;
    return out;
  }
  return null;
}

/** In-memory store (tests and local experiments). Production uses PgCallStore in lib/callStore.ts. */
export class MemoryCallStore implements CallStore {
  rows = new Map<string, any>();
  conversations = new Map<string, { company_id: string; type: string; members: Peer[] }>();
  inactive = new Set<string>();
  async findDirectPeer(conversationId: string, callerId: string, companyId: string) {
    const c = this.conversations.get(conversationId); if (!c || c.type !== 'direct' || c.company_id !== companyId) return null;
    if (!c.members.some(m => m.id === callerId)) return null; return (c.members.find(m => m.id !== callerId) as Peer) || null;
  }
  async isActiveUser(userId: string) { return !this.inactive.has(userId); }
  async insertCall(c: any) { const id = randomUUID(); const final = c.status !== 'ringing'; this.rows.set(id, { id, ...c, started_at: new Date(), ended_at: final ? new Date() : null, duration_seconds: final ? 0 : null }); return id; }
  async markActive(id: string, at: Date) { Object.assign(this.rows.get(id), { status: 'active', answered_at: at }); }
  async markConnected(id: string, at: Date) { this.rows.get(id).connected_at = at; }
  async finish(id: string, f: any) { Object.assign(this.rows.get(id), f); }
}
