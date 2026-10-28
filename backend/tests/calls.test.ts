/**
 * Calling integration tests — run against a RUNNING API (real Socket.IO + Postgres), like helpdesk.test.ts:
 *   API_URL=http://localhost:4000/api/v1 ADMIN_EMAIL=... ADMIN_PASSWORD=... npm test
 * Needs `socket.io-client` (devDependency). Creates throw-away users. Covers authenticated sockets, employee→employee / HR / admin
 * calls, accept / decline, unauthorised joins, busy, signalling relay, disconnect + rejoin, and call-history persistence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { io, Socket } from 'socket.io-client';

const API = process.env.API_URL || 'http://localhost:4000/api/v1';
const ORIGIN = new URL(API).origin; const PATH = `${new URL(API).pathname.replace(/\/$/, '')}/realtime`;
const ADMIN = { email: process.env.ADMIN_EMAIL || 'admin@barid-in.com', password: process.env.ADMIN_PASSWORD || 'Admin@123' };
const stamp = Date.now(); const ctx: any = {}; const sockets: Socket[] = [];

async function call(method: string, path: string, token?: string, body?: any) {
  const r = await fetch(API + path, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* */ } return { status: r.status, json, text };
}
const login = async (email: string, password: string) => { const r = await call('POST', '/auth/login', undefined, { email, password }); assert.equal(r.status, 200, r.text); return r.json; };
const connect = (token: string) => new Promise<Socket>((res, rej) => { const s = io(ORIGIN, { path: PATH, transports: ['websocket'], auth: { token }, reconnection: false }); sockets.push(s); s.on('connect', () => res(s)); s.on('connect_error', rej); });
const ask = (s: Socket, ev: string, data: any) => new Promise<any>(res => s.emit(ev, data, res));
const once = (s: Socket, ev: string, ms = 4000) => new Promise<any>((res, rej) => { const t = setTimeout(() => rej(new Error(`timeout waiting for ${ev}`)), ms); s.once(ev, p => { clearTimeout(t); res(p); }); });
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const dm = async (a: any, bId: string) => (await call('POST', '/chat/conversations', a.token, { type: 'direct', user_id: bId })).json.id as string;
const mk = async (name: string, role: string) => { const email = `${name}.${stamp}@test.local`; const r = await call('POST', '/users', ctx.admin.token, { name, email, password: 'Passw0rd!x', role }); assert.equal(r.status, 201, r.text); const l = await login(email, 'Passw0rd!x'); return { id: r.json.id, token: l.token, name }; };

test('setup', async () => { ctx.admin = await login(ADMIN.email, ADMIN.password); ctx.e1 = await mk('callemp1', 'employee'); ctx.e2 = await mk('callemp2', 'employee'); ctx.e3 = await mk('callemp3', 'employee'); ctx.hr = await mk('callhr', 'hr'); });
test.after(() => sockets.forEach(s => s.close()));

test('sockets need a valid token', async () => {
  await assert.rejects(connect('garbage')); await assert.rejects(connect(''));
});
test('GET /calls/config serves ICE servers to signed-in users only; history starts empty', async () => {
  assert.equal((await call('GET', '/calls/config')).status, 401);
  const c = (await call('GET', '/calls/config', ctx.e1.token)).json; assert.ok(Array.isArray(c.ice_servers)); assert.ok(c.ring_timeout_ms > 0);
  assert.equal((await call('GET', '/calls/history', ctx.e1.token)).json.data.length, 0);
});
for (const [label, a, b] of [['employee → employee', 'e1', 'e2'], ['employee → HR', 'e1', 'hr'], ['employee → administrator', 'e1', 'admin']] as const) {
  test(`${label}: ring → accept → relay SDP / ICE → end; recorded as completed in both histories`, async () => {
    const A = ctx[a], B = ctx[b]; const [sa, sb] = [await connect(A.token), await connect(B.token)]; const conv = await dm(A, B.id);
    const incoming = once(sb, 'call:incoming'); const inv = await ask(sa, 'call:invite', { conversationId: conv, type: 'video' }); assert.equal(inv.ok, true, JSON.stringify(inv));
    const inc = await incoming; assert.equal(inc.from.id, A.id); assert.equal(inc.type, 'video');
    const accepted = once(sa, 'call:accepted'); assert.equal((await ask(sb, 'call:accept', { callId: inv.callId })).ok, true); await accepted;
    const off = once(sb, 'call:signal'); await ask(sa, 'call:signal', { callId: inv.callId, kind: 'offer', data: { type: 'offer', sdp: 'v=0\r\n' } }); assert.equal((await off).kind, 'offer');
    await ask(sa, 'call:connected', { callId: inv.callId }); await wait(1200);
    const ended = once(sa, 'call:ended'); assert.equal((await ask(sb, 'call:end', { callId: inv.callId })).ok, true); const e = await ended; assert.equal(e.status, 'completed');
    for (const u of [A, B]) { const h = (await call('GET', '/calls/history', u.token)).json.data.find((x: any) => x.id === inv.callId); assert.ok(h, 'in history'); assert.equal(h.status, 'completed'); assert.ok(h.duration_seconds >= 1); assert.equal(h.call_type, 'video'); }
    sa.close(); sb.close();
  });
}
test('decline is recorded; a non-member cannot invite, and a spoofed callee id is ignored', async () => {
  const [s1, s2, s3] = [await connect(ctx.e1.token), await connect(ctx.e2.token), await connect(ctx.e3.token)]; const conv = await dm(ctx.e1, ctx.e2.id);
  assert.equal((await ask(s3, 'call:invite', { conversationId: conv, type: 'audio' })).code, 'forbidden', 'not a member of the conversation');
  await wait(1700);
  const e3Rang = once(s3, 'call:incoming', 800).then(() => true, () => false); const incoming = once(s2, 'call:incoming');
  const inv = await ask(s1, 'call:invite', { conversationId: conv, type: 'audio', callee_id: ctx.e3.id, to: ctx.e3.id }); assert.equal(inv.ok, true);
  assert.equal((await incoming).from.id, ctx.e1.id); assert.equal(await e3Rang, false, 'the spoofed recipient is never rung');
  const ended = once(s1, 'call:ended'); assert.equal((await ask(s2, 'call:decline', { callId: inv.callId })).ok, true); assert.equal((await ended).status, 'declined'); await wait(300);
  const h = (await call('GET', '/calls/history', ctx.e2.token)).json.data.find((x: any) => x.id === inv.callId); assert.equal(h.status, 'declined'); assert.equal(h.direction, 'incoming');
  s1.close(); s2.close(); s3.close();
});
test('busy: a second caller gets "busy" while the callee is in a call', async () => {
  const [s1, s2, s3] = [await connect(ctx.e1.token), await connect(ctx.e2.token), await connect(ctx.e3.token)]; await wait(300);
  const c12 = await dm(ctx.e1, ctx.e2.id), c32 = await dm(ctx.e3, ctx.e2.id);
  const inv = await ask(s1, 'call:invite', { conversationId: c12, type: 'audio' }); assert.equal(inv.ok, true);
  const busy = await ask(s3, 'call:invite', { conversationId: c32, type: 'audio' }); assert.equal(busy.code, 'busy');
  assert.equal((await ask(s3, 'call:accept', { callId: inv.callId })).ok, false, 'a third user cannot answer');
  assert.equal((await ask(s3, 'call:signal', { callId: inv.callId, kind: 'offer', data: { type: 'offer', sdp: 'x' } })).ok, false);
  await ask(s1, 'call:end', { callId: inv.callId }); await wait(300);
  const h = (await call('GET', '/calls/history', ctx.e1.token)).json.data.find((x: any) => x.id === inv.callId); assert.equal(h.status, 'cancelled');
  const mine = (await call('GET', '/calls/history', ctx.e3.token)).json.data[0]; assert.equal(mine.status, 'missed'); assert.equal(mine.end_reason, 'busy');
  s1.close(); s2.close(); s3.close();
});
test('dropped connection mid-call: peer is notified and the user can rejoin within the grace window', async () => {
  const sa = await connect(ctx.e1.token), sb = await connect(ctx.e2.token); const conv = await dm(ctx.e1, ctx.e2.id);
  const inv = await ask(sa, 'call:invite', { conversationId: conv, type: 'audio' }); await ask(sb, 'call:accept', { callId: inv.callId });
  const gone = once(sb, 'call:peer-disconnected'); sa.close(); await gone;
  const sa2 = await connect(ctx.e1.token); const back = once(sb, 'call:peer-rejoined'); const r = await ask(sa2, 'call:rejoin', { callId: inv.callId }); assert.equal(r.ok, true); await back;
  await ask(sa2, 'call:end', { callId: inv.callId }); sa2.close(); sb.close();
});
