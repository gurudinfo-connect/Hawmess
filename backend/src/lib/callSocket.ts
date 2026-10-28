/**
 * Socket.IO adapter for the CallManager. Everything security-relevant lives in callManager.ts; this file only
 *   1. authenticates the WebSocket handshake with the SAME JWT / users table as the REST API,
 *   2. forwards events to the manager with the server-derived user (never a browser-supplied id),
 *   3. delivers the manager's output to the right sockets, and
 *   4. writes audit entries / missed-call notifications when a call finishes.
 */
import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { authenticateToken, logAudit } from './auth';
import { CallManager, CallUser, FinishedCall } from './callManager';
import { failStaleCalls, PgCallStore } from './callStore';
import { notify } from './notify';

export const REALTIME_PATH = '/api/v1/realtime';   // under /api so the existing nginx / Vite proxy rules already match it
const num = (v: string | undefined, d: number) => { const n = parseInt(v || '', 10); return Number.isFinite(n) && n > 0 ? n : d; };
const label = (s: string) => s.replace(/_/g, ' ');
const fmtDur = (s: number) => `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;

let manager: CallManager | null = null;
export const getCallManager = () => manager;

async function onFinished(f: FinishedCall) {
  // metadata only — never SDP, ICE or media
  await logAudit({ company_id: f.company_id, user_id: f.caller.id, action: `call_${f.status}`, entity_type: 'call', entity_id: f.id, module: 'calls',
    new_value: { type: f.type, status: f.status, reason: f.reason, duration_seconds: f.duration_seconds, callee_id: f.callee.id },
    description: `${label(f.type)} call to ${f.callee.name} ${f.status}${f.duration_seconds ? ` (${fmtDur(f.duration_seconds)})` : ''}` });
  const unanswered = f.status === 'missed' || (f.status === 'cancelled' && (f.reason === 'cancelled' || f.reason === 'caller_disconnected'));
  if (unanswered) await notify(f.company_id, f.callee.id, 'missed_call', `Missed ${f.type} call from ${f.caller.name}`, undefined, 'call', f.id, { email: false });
}

export function attachCalls(http: HttpServer, allowedOrigins?: string[]) {
  const origins = allowedOrigins?.length ? allowedOrigins : process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true;
  const io = new Server(http, { path: REALTIME_PATH, cors: { origin: origins }, maxHttpBufferSize: 256 * 1024, pingInterval: 10_000, pingTimeout: 8_000, serveClient: false });
  const m = new CallManager({
    store: new PgCallStore(),
    transport: { toSocket: (id, ev, p) => { io.to(id).emit(ev, p); }, toCompany: (cid, ev, p) => { io.to(`company:${cid}`).emit(ev, p); } },
    options: { ringTimeoutMs: num(process.env.CALL_RING_TIMEOUT_MS, 45_000), reconnectGraceMs: num(process.env.CALL_RECONNECT_GRACE_MS, 20_000) },
    onFinished,
  });
  manager = m;
  failStaleCalls().then(n => { if (n) console.log(`Calling: closed ${n} call(s) left open by a previous run`); }).catch(e => console.error('Calling: could not clean stale calls', e));

  // Same identity source as REST: the JWT only names the user; role / active state come from the database.
  io.use(async (socket, next) => {
    try {
      const token = (socket.handshake.auth as any)?.token;
      if (typeof token !== 'string' || !token) return next(new Error('unauthorized'));
      const r = await authenticateToken(token);
      if ('error' in r) return next(new Error(r.status === 403 ? 'deactivated' : 'unauthorized'));
      const u: CallUser = { id: r.user.id, name: r.user.name, role: r.user.role, company_id: r.user.company_id };
      socket.data.user = u; socket.data.exp = r.exp;
      next();
    } catch (e) { console.error('socket auth failed', e); next(new Error('server_error')); }
  });

  io.on('connection', socket => {
    const user = socket.data.user as CallUser; const exp = socket.data.exp as number | undefined;
    const ctx = () => ({ socketId: socket.id, user });
    socket.join(`company:${user.company_id}`);
    m.connect(ctx());
    socket.emit('presence:snapshot', { users: m.presenceSnapshot(user.company_id) });

    const expired = () => exp !== undefined && Date.now() / 1000 >= exp;
    const on = (event: string, fresh: boolean, fn: (data: any) => any) => socket.on(event, async (data: any, ack?: any) => {
      const cb = typeof ack === 'function' ? ack : () => {};
      try {
        if (fresh && expired()) { cb({ ok: false, code: 'forbidden', message: 'Your session has expired. Please sign in again.' }); socket.emit('auth:expired'); return; }
        cb(await fn(data));
      } catch (e) { console.error(`socket ${event} failed`, e); cb({ ok: false, code: 'invalid', message: 'Something went wrong on the server' }); }
    });
    on('call:invite', true, d => m.invite(ctx(), d));
    on('call:accept', true, d => m.accept(ctx(), d));
    on('call:decline', false, d => m.decline(ctx(), d));
    on('call:end', false, d => m.end(ctx(), d));
    on('call:signal', false, d => m.signal(ctx(), d));
    on('call:media-state', false, d => m.mediaState(ctx(), d));
    on('call:connected', false, d => m.connected(ctx(), d));
    on('call:failed', false, d => m.failed(ctx(), d));
    on('call:rejoin', false, d => m.rejoin(ctx(), d));
    socket.on('disconnect', () => m.disconnect(socket.id));
  });

  return { io, manager: m, close: async () => { await m.shutdown(); await new Promise<void>(r => io.close(() => r())); } };
}
