/**
 * Unit tests for the call state machine (lib/callManager.ts) and ICE configuration (lib/webrtcConfig.ts).
 * No database, network or Socket.IO needed: the manager's store / transport / timers are injected, so every
 * authorisation rule and state transition is exercised deterministically.
 *   npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CallManager, CallUser, Ctx, FinishedCall, MemoryCallStore, Peer, Role, sanitizeSignal } from '../src/lib/callManager';
import { iceServersFor, turnConfigured } from '../src/lib/webrtcConfig';

// ---------------------------------------------------------------- harness
class Clock {
  t = 1_700_000_000_000; private q: { at: number; fn: () => void; id: number }[] = []; private n = 0;
  setTimeout = (fn: () => void, ms: number) => { const id = ++this.n; this.q.push({ at: this.t + ms, fn, id }); return id; };
  clearTimeout = (h: unknown) => { this.q = this.q.filter(x => x.id !== h); };
  now = () => this.t;
  advance(ms: number) { const end = this.t + ms; for (;;) { const next = this.q.filter(x => x.at <= end).sort((a, b) => a.at - b.at)[0]; if (!next) break; this.q = this.q.filter(x => x !== next); this.t = next.at; next.fn(); } this.t = end; }
}
const flush = () => new Promise<void>(r => setImmediate(r));
const COMPANY = 'c0000000-0000-4000-8000-000000000001';
const mkUser = (name: string, role: Role, company = COMPANY): CallUser => ({ id: randomUUID(), name, role, company_id: company });
const asPeer = (u: CallUser, is_active = true): Peer => ({ id: u.id, name: u.name, role: u.role, is_active });

function setup(opts: Record<string, number> = {}) {
  const clock = new Clock(); const store = new MemoryCallStore(); const events: { to: string; ev: string; p: any }[] = []; const finished: FinishedCall[] = [];
  const m = new CallManager({ store, timers: clock, options: opts, log: () => {}, onFinished: f => { finished.push(f); },
    transport: { toSocket: (to, ev, p) => { events.push({ to, ev, p }); }, toCompany: (to, ev, p) => { events.push({ to: `company:${to}`, ev, p }); } } });
  let sock = 0;
  const connect = (u: CallUser): Ctx => { const c = { socketId: `s${++sock}-${u.name}`, user: u }; m.connect(c); return c; };
  const dm = (a: CallUser, b: CallUser, company = COMPANY, type = 'direct') => { const id = randomUUID(); store.conversations.set(id, { company_id: company, type, members: [asPeer(a), asPeer(b)] }); return id; };
  const got = (to: string, ev: string) => events.filter(e => e.to === to && e.ev === ev);
  return { clock, store, m, events, finished, connect, dm, got };
}
type S = ReturnType<typeof setup>;
async function ring(s: S, a: CallUser, b: CallUser, type: 'audio' | 'video' = 'audio') {
  const A = s.connect(a), B = s.connect(b); const conv = s.dm(a, b); const r: any = await s.m.invite(A, { conversationId: conv, type }); assert.equal(r.ok, true, JSON.stringify(r)); return { A, B, conv, callId: r.callId as string };
}
async function answer(s: S, a: CallUser, b: CallUser, type: 'audio' | 'video' = 'audio') {
  const x = await ring(s, a, b, type); assert.equal((await s.m.accept(x.B, { callId: x.callId })).ok, true); return x;
}
const row = (s: S, id: string) => s.store.rows.get(id);

// ---------------------------------------------------------------- who may call whom
const pairs: [string, Role, Role][] = [['employee → employee', 'employee', 'employee'], ['employee → HR', 'employee', 'hr'], ['employee → administrator', 'employee', 'admin'], ['HR → employee', 'hr', 'employee'], ['administrator → HR', 'admin', 'hr'], ['administrator → employee', 'admin', 'employee']];
for (const [name, ra, rb] of pairs) {
  test(`${name}: callee is notified with the caller's real name and role, both become busy`, async () => {
    const s = setup(); const a = mkUser('Caller', ra), b = mkUser('Callee', rb); const { A, B, callId } = await ring(s, a, b, 'video');
    const inc = s.got(B.socketId, 'call:incoming'); assert.equal(inc.length, 1);
    assert.deepEqual(inc[0].p.from, { id: a.id, name: 'Caller', role: ra }); assert.equal(inc[0].p.type, 'video'); assert.equal(inc[0].p.callId, callId);
    assert.equal(s.got(A.socketId, 'call:incoming').length, 0, 'the caller is never rung');
    assert.equal(s.m.presenceOf(a.id), 'busy'); assert.equal(s.m.presenceOf(b.id), 'busy');
    assert.equal(row(s, callId).status, 'ringing'); assert.equal(row(s, callId).caller_id, a.id); assert.equal(row(s, callId).callee_id, b.id);
  });
}

test('accept: caller is told, the other devices of the callee stop ringing, row becomes active', async () => {
  const s = setup(); const a = mkUser('A', 'employee'), b = mkUser('B', 'hr'); const A = s.connect(a), B1 = s.connect(b), B2 = s.connect(b); const conv = s.dm(a, b);
  const { callId } = await s.m.invite(A, { conversationId: conv, type: 'audio' }) as any;
  assert.equal(s.got(B1.socketId, 'call:incoming').length, 1); assert.equal(s.got(B2.socketId, 'call:incoming').length, 1, 'every device of the callee rings');
  assert.equal((await s.m.accept(B2, { callId })).ok, true);
  assert.equal(s.got(A.socketId, 'call:accepted').length, 1); assert.equal(s.got(B1.socketId, 'call:handled').length, 1); assert.equal(s.got(B2.socketId, 'call:handled').length, 0);
  await flush(); assert.equal(row(s, callId).status, 'active'); assert.ok(row(s, callId).answered_at);
  const late = await s.m.accept(B1, { callId }); assert.equal(late.ok, false, 'the second device cannot also answer');
});
test('decline: caller gets the outcome, row is declined, both are available again', async () => {
  const s = setup(); const a = mkUser('A', 'employee'), b = mkUser('B', 'employee'); const { A, B, callId } = await ring(s, a, b);
  assert.equal((await s.m.decline(B, { callId })).ok, true); await flush();
  assert.equal(s.got(A.socketId, 'call:ended')[0].p.status, 'declined'); assert.equal(row(s, callId).status, 'declined'); assert.ok(row(s, callId).ended_at);
  assert.equal(s.m.presenceOf(a.id), 'available'); assert.equal(s.m.presenceOf(b.id), 'available'); assert.equal(s.m.activeCallOf(a.id), null);
});
test('decline with media_error (callee has no usable microphone) is recorded as failed', async () => {
  const s = setup(); const { B, callId } = await ring(s, mkUser('A', 'employee'), mkUser('B', 'employee')); await s.m.decline(B, { callId, reason: 'media_error' }); await flush();
  assert.equal(row(s, callId).status, 'failed'); assert.equal(row(s, callId).end_reason, 'media_error');
});
test('caller cancels while ringing: callee stops ringing, recorded as cancelled', async () => {
  const s = setup(); const { A, B, callId } = await ring(s, mkUser('A', 'employee'), mkUser('B', 'admin')); await s.m.end(A, { callId }); await flush();
  assert.equal(s.got(B.socketId, 'call:ended')[0].p.status, 'cancelled'); assert.equal(row(s, callId).status, 'cancelled');
  assert.equal(s.finished[0].status, 'cancelled', 'the finished hook lets the server raise a missed-call notification');
});
test('ring timeout: nobody answers → missed for both, history row + hook', async () => {
  const s = setup({ ringTimeoutMs: 30_000 }); const a = mkUser('A', 'employee'), b = mkUser('B', 'hr'); const { A, B, callId } = await ring(s, a, b);
  s.clock.advance(29_000); assert.equal(s.got(A.socketId, 'call:ended').length, 0); s.clock.advance(1_500); await flush();
  for (const x of [A, B]) { const e = s.got(x.socketId, 'call:ended'); assert.equal(e.length, 1); assert.equal(e[0].p.status, 'missed'); assert.equal(e[0].p.reason, 'timeout'); }
  assert.equal(row(s, callId).status, 'missed'); assert.equal(s.finished[0].status, 'missed'); assert.equal(s.finished[0].callee.id, b.id);
});

// ---------------------------------------------------------------- authorisation
test('cannot call someone without a direct conversation, via a group / channel, across companies, or with a bad id', async () => {
  const s = setup(); const a = mkUser('A', 'employee'), b = mkUser('B', 'employee'), stranger = mkUser('S', 'employee'); const A = s.connect(a); s.connect(b); s.connect(stranger);
  const other = s.dm(b, stranger);                                         // A is not a member
  assert.equal((await s.m.invite(A, { conversationId: other, type: 'audio' }) as any).code, 'forbidden');
  s.clock.advance(2000); assert.equal((await s.m.invite(A, { conversationId: s.dm(a, b, COMPANY, 'group'), type: 'audio' }) as any).code, 'forbidden');
  s.clock.advance(2000); assert.equal((await s.m.invite(A, { conversationId: s.dm(a, b, 'c0000000-0000-4000-8000-000000000002'), type: 'audio' }) as any).code, 'forbidden');
  s.clock.advance(2000); assert.equal((await s.m.invite(A, { conversationId: 'not-a-uuid', type: 'audio' }) as any).code, 'invalid');
  s.clock.advance(2000); assert.equal((await s.m.invite(A, { conversationId: randomUUID(), type: 'audio' }) as any).code, 'forbidden');
  s.clock.advance(2000); assert.equal((await s.m.invite(A, { conversationId: other, type: 'screen' }) as any).code, 'invalid');
  assert.equal(s.store.rows.size, 0, 'rejected attempts leave no call rows');
});
test('recipient spoofing: a user id sent by the browser is ignored — the callee comes from the conversation', async () => {
  const s = setup(); const a = mkUser('A', 'employee'), b = mkUser('B', 'employee'), victim = mkUser('V', 'admin'); const A = s.connect(a), B = s.connect(b), V = s.connect(victim); const conv = s.dm(a, b);
  const r: any = await s.m.invite(A, { conversationId: conv, type: 'audio', calleeId: victim.id, callee_id: victim.id, to: victim.id, from: victim.id }); assert.equal(r.ok, true);
  assert.equal(s.got(V.socketId, 'call:incoming').length, 0); assert.equal(s.got(B.socketId, 'call:incoming').length, 1);
  assert.equal(row(s, r.callId).caller_id, a.id); assert.equal(row(s, r.callId).callee_id, b.id);
});
test('inactive people cannot call or be called', async () => {
  const s = setup(); const a = mkUser('A', 'employee'), b = mkUser('B', 'employee'); const A = s.connect(a); s.connect(b); const conv = s.dm(a, b);
  s.store.conversations.get(conv)!.members[1].is_active = false; assert.equal((await s.m.invite(A, { conversationId: conv, type: 'audio' }) as any).code, 'not_found');
  s.clock.advance(2000); s.store.conversations.get(conv)!.members[1].is_active = true; s.store.inactive.add(a.id); assert.equal((await s.m.invite(A, { conversationId: conv, type: 'audio' }) as any).code, 'forbidden');
});
test('a third user cannot accept, decline, end, signal, rejoin, report state or fail somebody else\'s call', async () => {
  const s = setup(); const a = mkUser('A', 'employee'), b = mkUser('B', 'hr'), mallory = mkUser('M', 'admin'); const { A, B, callId } = await ring(s, a, b); const M = s.connect(mallory);
  for (const r of [await s.m.accept(M, { callId }), await s.m.decline(M, { callId }), await s.m.end(M, { callId })]) assert.equal(r.ok, false);
  assert.equal(s.m.activeCallOf(a.id)?.state, 'ringing', 'the call is untouched');
  await s.m.accept(B, { callId });
  const offer = { type: 'offer', sdp: 'v=0\r\n' };
  for (const r of [s.m.signal(M, { callId, kind: 'offer', data: offer }), s.m.mediaState(M, { callId, audio: true, video: true }), s.m.connected(M, { callId }), await s.m.failed(M, { callId, reason: 'ice_failed' }), s.m.rejoin(M, { callId }), await s.m.end(M, { callId })]) assert.equal((r as any).ok, false);
  assert.equal(s.got(A.socketId, 'call:signal').length + s.got(B.socketId, 'call:signal').length, 0); assert.equal(s.m.activeCallOf(a.id)?.state, 'active');
  assert.equal(s.m.presenceOf(mallory.id), 'available');
});
test('a second browser tab of a participant cannot signal or end the call held by the first tab', async () => {
  const s = setup(); const a = mkUser('A', 'employee'), b = mkUser('B', 'employee'); const { A, B, callId } = await answer(s, a, b); const A2 = s.connect(a); const B2 = s.connect(b);
  for (const [who, tab] of [['caller', A2], ['callee', B2]] as const) {
    assert.equal(s.m.signal(tab, { callId, kind: 'offer', data: { type: 'offer', sdp: 'x' } }).ok, false, who);
    assert.equal((await s.m.end(tab, { callId })).ok, false, who); assert.equal(s.m.rejoin(tab, { callId }).ok, false, `${who} rejoin while the original tab is still connected`);
  }
  assert.equal(s.m.activeCallOf(a.id)?.state, 'active'); assert.equal(s.got(B.socketId, 'call:signal').length, 0); void A;
});
test('signals before the call is answered are refused', async () => {
  const s = setup(); const { A, callId } = await ring(s, mkUser('A', 'employee'), mkUser('B', 'employee')); assert.equal(s.m.signal(A, { callId, kind: 'offer', data: { type: 'offer', sdp: 'x' } }).ok, false);
});

// ---------------------------------------------------------------- busy / duplicates
test('busy: a third person calling someone who is already in a call is told "busy" and a missed call is recorded', async () => {
  const s = setup(); const a = mkUser('A', 'employee'), b = mkUser('B', 'hr'), c = mkUser('C', 'employee'); await answer(s, a, b); const C = s.connect(c); const conv = s.dm(c, b);
  const r: any = await s.m.invite(C, { conversationId: conv, type: 'audio' }); assert.equal(r.ok, false); assert.equal(r.code, 'busy');
  const rows = [...s.store.rows.values()].filter(x => x.caller_id === c.id); assert.equal(rows.length, 1); assert.equal(rows[0].status, 'missed'); assert.equal(rows[0].end_reason, 'busy');
  assert.equal(s.finished.at(-1)!.status, 'missed'); assert.equal(s.finished.at(-1)!.callee.id, b.id, 'the busy callee gets a missed-call notification');
  assert.equal(s.m.presenceOf(c.id), 'available', 'the rejected caller is not left busy');
});
test('offline callee: the call is not started, recorded as missed', async () => {
  const s = setup(); const a = mkUser('A', 'employee'), b = mkUser('B', 'employee'); const A = s.connect(a); const conv = s.dm(a, b);
  const r: any = await s.m.invite(A, { conversationId: conv, type: 'video' }); assert.equal(r.code, 'offline'); const rows = [...s.store.rows.values()]; assert.equal(rows[0].status, 'missed'); assert.equal(rows[0].end_reason, 'offline');
});
test('duplicate initiation is refused; simultaneous invites to the same person: exactly one wins', async () => {
  const s = setup(); const a = mkUser('A', 'employee'), b = mkUser('B', 'employee'), c = mkUser('C', 'hr'); const A = s.connect(a), C = s.connect(c); s.connect(b); const ab = s.dm(a, b), cb = s.dm(c, b);
  const [r1, r2]: any[] = await Promise.all([s.m.invite(A, { conversationId: ab, type: 'audio' }), s.m.invite(C, { conversationId: cb, type: 'audio' })]);
  assert.deepEqual([r1.ok, r2.ok].sort(), [false, true]); assert.equal([r1, r2].find(r => !r.ok).code, 'busy');
  s.clock.advance(2000); const again: any = await s.m.invite(r1.ok ? A : C, { conversationId: r1.ok ? ab : cb, type: 'audio' }); assert.equal(again.code, 'already_in_call');
});
test('invites are rate limited per user', async () => {
  const s = setup(); const a = mkUser('A', 'employee'), b = mkUser('B', 'employee'); const A = s.connect(a); const conv = s.dm(a, b);
  assert.equal((await s.m.invite(A, { conversationId: conv, type: 'audio' }) as any).code, 'offline'); assert.equal((await s.m.invite(A, { conversationId: conv, type: 'audio' }) as any).code, 'rate_limited');
});

// ---------------------------------------------------------------- signalling + media state
test('SDP / ICE are relayed only to the other participant and only well-formed, whitelisted fields', async () => {
  const s = setup(); const a = mkUser('A', 'employee'), b = mkUser('B', 'employee'); const { A, B, callId } = await answer(s, a, b, 'video');
  assert.equal(s.m.signal(A, { callId, kind: 'offer', data: { type: 'offer', sdp: 'v=0', evil: '<script>' } }).ok, true);
  const o = s.got(B.socketId, 'call:signal')[0].p; assert.deepEqual(o, { callId, kind: 'offer', data: { type: 'offer', sdp: 'v=0' } });
  assert.equal(s.m.signal(B, { callId, kind: 'answer', data: { type: 'answer', sdp: 'v=0' } }).ok, true); assert.equal(s.got(A.socketId, 'call:signal').length, 1);
  assert.equal(s.m.signal(A, { callId, kind: 'candidate', data: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host', sdpMid: '0', sdpMLineIndex: 0, junk: 1 } }).ok, true);
  assert.deepEqual(s.got(B.socketId, 'call:signal')[1].p.data, { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host', sdpMid: '0', sdpMLineIndex: 0 });
  for (const bad of [{ kind: 'offer', data: { type: 'answer', sdp: 'x' } }, { kind: 'offer', data: { type: 'offer', sdp: 'x'.repeat(100_001) } }, { kind: 'hack', data: {} }, { kind: 'candidate', data: null }, { kind: 'candidate', data: { candidate: 5 } }])
    assert.equal(s.m.signal(A, { callId, ...bad }).ok, false);
  assert.equal(s.m.signal(A, { callId: randomUUID(), kind: 'offer', data: { type: 'offer', sdp: 'x' } }).ok, false);
});
test('signalling is rate limited per socket', async () => {
  const s = setup({ maxSignalsPerWindow: 5 }); const { A, callId } = await answer(s, mkUser('A', 'employee'), mkUser('B', 'employee'));
  const res = Array.from({ length: 8 }, () => s.m.signal(A, { callId, kind: 'candidate', data: { candidate: 'c' } }).ok); assert.deepEqual(res, [true, true, true, true, true, false, false, false]);
  s.clock.advance(11_000); assert.equal(s.m.signal(A, { callId, kind: 'candidate', data: { candidate: 'c' } }).ok, true);
});
test('mute / camera state is relayed to the peer and validated', async () => {
  const s = setup(); const { A, B, callId } = await answer(s, mkUser('A', 'employee'), mkUser('B', 'employee'), 'video');
  assert.equal(s.m.mediaState(A, { callId, audio: false, video: true }).ok, true); assert.deepEqual(s.got(B.socketId, 'call:media-state')[0].p, { callId, audio: false, video: true });
  assert.equal(s.m.mediaState(A, { callId, audio: 'no', video: 1 }).ok, false);
});
test('sanitizeSignal accepts only offer / answer / candidate', () => {
  assert.equal(sanitizeSignal('offer', { type: 'offer', sdp: 'v=0' })?.sdp, 'v=0'); assert.equal(sanitizeSignal('answer', { type: 'offer', sdp: 'v=0' }), null);
  assert.equal(sanitizeSignal('candidate', { candidate: 'x', sdpMLineIndex: -1 })?.sdpMLineIndex, null); assert.equal(sanitizeSignal('rollback', {}), null);
});

// ---------------------------------------------------------------- ending, duration, history
test('a connected call that is hung up is completed with the real duration; the peer is told', async () => {
  const s = setup(); const a = mkUser('A', 'employee'), b = mkUser('B', 'hr'); const { A, B, callId } = await answer(s, a, b, 'video');
  s.clock.advance(1_000); s.m.connected(B, { callId }); s.m.connected(A, { callId }); s.clock.advance(125_400); await s.m.end(B, { callId }); await flush();
  const ended = s.got(A.socketId, 'call:ended')[0].p; assert.equal(ended.status, 'completed'); assert.equal(ended.duration_seconds, 125);
  const r = row(s, callId); assert.equal(r.status, 'completed'); assert.equal(r.duration_seconds, 125); assert.equal(r.end_reason, 'hangup'); assert.ok(r.ended_at && r.connected_at && r.answered_at);
  assert.equal(s.m.presenceOf(a.id), 'available'); assert.equal(s.finished[0].duration_seconds, 125);
  assert.equal((await s.m.end(B, { callId })).ok, true, 'ending twice is harmless');
});
test('hanging up before media connected is cancelled (never "completed")', async () => {
  const s = setup(); const { A, callId } = await answer(s, mkUser('A', 'employee'), mkUser('B', 'employee')); await s.m.end(A, { callId }); await flush();
  assert.equal(row(s, callId).status, 'cancelled'); assert.equal(row(s, callId).duration_seconds, 0);
});
test('client-reported connection failure ends the call as failed', async () => {
  const s = setup(); const { B, A, callId } = await answer(s, mkUser('A', 'employee'), mkUser('B', 'employee')); await s.m.failed(B, { callId, reason: 'ice_failed' }); await flush();
  assert.equal(row(s, callId).status, 'failed'); assert.equal(row(s, callId).end_reason, 'ice_failed'); assert.equal(s.got(A.socketId, 'call:ended')[0].p.status, 'failed');
});
test('a call can be started again after it ends', async () => {
  const s = setup(); const a = mkUser('A', 'employee'), b = mkUser('B', 'employee'); const { A, B, conv, callId } = await answer(s, a, b); await s.m.end(A, { callId }); s.clock.advance(2000);
  assert.equal((await s.m.invite(B, { conversationId: conv, type: 'audio' }) as any).ok, true);
});

// ---------------------------------------------------------------- disconnect / reconnect
test('network drop mid-call: peer is warned, and the original user can rejoin inside the grace window', async () => {
  const s = setup({ reconnectGraceMs: 20_000 }); const a = mkUser('A', 'employee'), b = mkUser('B', 'employee'); const { A, B, callId } = await answer(s, a, b); s.m.connected(A, { callId });
  s.m.disconnect(A.socketId); assert.equal(s.got(B.socketId, 'call:peer-disconnected')[0].p.graceMs, 20_000); assert.equal(s.m.presenceOf(a.id), 'offline');
  s.clock.advance(10_000); const A2 = s.connect(a); const r: any = s.m.rejoin(A2, { callId }); assert.equal(r.ok, true); assert.equal(r.peer.id, b.id); assert.equal(r.connected, true);
  assert.equal(s.got(B.socketId, 'call:peer-rejoined').length, 1); s.clock.advance(60_000); await flush(); assert.equal(s.m.activeCallOf(a.id)?.state, 'active', 'the grace timer was cancelled');
  assert.equal(s.m.signal(A2, { callId, kind: 'offer', data: { type: 'offer', sdp: 'x' } }).ok, true, 'the new socket now holds the caller seat');
  assert.equal(s.m.signal(A, { callId, kind: 'offer', data: { type: 'offer', sdp: 'x' } }).ok, false, 'the dead socket does not');
});
test('no rejoin within the grace window: a connected call completes, an unconnected one fails', async () => {
  for (const connected of [true, false]) {
    const s = setup({ reconnectGraceMs: 5_000 }); const { A, B, callId } = await answer(s, mkUser('A', 'employee'), mkUser('B', 'employee')); if (connected) { s.m.connected(A, { callId }); s.clock.advance(3_000); }
    s.m.disconnect(B.socketId); s.clock.advance(5_100); await flush();
    assert.equal(row(s, callId).status, connected ? 'completed' : 'failed'); assert.equal(row(s, callId).end_reason, 'disconnected'); assert.equal(s.got(A.socketId, 'call:ended').length, 1);
  }
});
test('another person cannot rejoin a call that is in its grace window', async () => {
  const s = setup(); const a = mkUser('A', 'employee'), b = mkUser('B', 'employee'), m = mkUser('M', 'hr'); const { A, callId } = await answer(s, a, b); s.m.disconnect(A.socketId);
  assert.equal(s.m.rejoin(s.connect(m), { callId }).ok, false);
});
test('caller closes the tab while it is ringing → cancelled and the callee stops ringing', async () => {
  const s = setup(); const { A, B, callId } = await ring(s, mkUser('A', 'employee'), mkUser('B', 'employee')); s.m.disconnect(A.socketId); await flush();
  assert.equal(row(s, callId).status, 'cancelled'); assert.equal(s.got(B.socketId, 'call:ended')[0].p.reason, 'caller_disconnected');
});
test('callee closes every device while it is ringing → missed; closing one of two devices keeps ringing', async () => {
  const s = setup(); const a = mkUser('A', 'employee'), b = mkUser('B', 'employee'); const A = s.connect(a), B1 = s.connect(b), B2 = s.connect(b); const conv = s.dm(a, b);
  const { callId } = await s.m.invite(A, { conversationId: conv, type: 'audio' }) as any; s.m.disconnect(B1.socketId); await flush(); assert.equal(row(s, callId).status, 'ringing');
  s.m.disconnect(B2.socketId); await flush(); assert.equal(row(s, callId).status, 'missed'); assert.equal(s.got(A.socketId, 'call:ended')[0].p.status, 'missed');
});
test('a caller who reloaded the page (old call stuck in its grace window) can start a new call; the stale one is closed', async () => {
  const s = setup(); const a = mkUser('A', 'employee'), b = mkUser('B', 'employee'); const { A, B, conv, callId } = await answer(s, a, b); s.m.disconnect(A.socketId); s.clock.advance(2000);
  const A2 = s.connect(a); const r: any = await s.m.invite(A2, { conversationId: conv, type: 'audio' }); await flush(); assert.equal(r.ok, true);
  assert.equal(row(s, callId).status, 'failed'); assert.equal(row(s, callId).end_reason, 'superseded'); assert.equal(s.got(B.socketId, 'call:ended')[0].p.callId, callId); assert.equal(s.got(B.socketId, 'call:incoming').length, 2, 'the new call rings the callee');
});

// ---------------------------------------------------------------- presence + shutdown
test('presence: available → busy → available → offline, broadcast to the company, snapshot for newcomers', async () => {
  const s = setup(); const a = mkUser('A', 'employee'), b = mkUser('B', 'employee'), other = mkUser('X', 'employee', 'c0000000-0000-4000-8000-000000000002');
  const A = s.connect(a); s.connect(other); assert.equal(s.m.presenceOf(a.id), 'available');
  assert.deepEqual(s.m.presenceSnapshot(COMPANY), { [a.id]: 'available' }, 'other companies are never included');
  const B = s.connect(b); const conv = s.dm(a, b); const { callId } = await s.m.invite(A, { conversationId: conv, type: 'audio' }) as any; assert.equal(s.m.presenceOf(b.id), 'busy');
  await s.m.decline(B, { callId }); await flush(); assert.equal(s.m.presenceOf(b.id), 'available'); s.m.disconnect(B.socketId); assert.equal(s.m.presenceOf(b.id), 'offline');
  const updates = s.events.filter(e => e.to === `company:${COMPANY}` && e.ev === 'presence:update' && e.p.user_id === b.id).map(e => e.p.status); assert.deepEqual(updates, ['available', 'busy', 'available', 'offline']);
});
test('shutdown closes open calls and records them', async () => {
  const s = setup(); const { callId, A } = await answer(s, mkUser('A', 'employee'), mkUser('B', 'employee')); await s.m.shutdown(); await flush();
  assert.equal(row(s, callId).status, 'failed'); assert.equal(row(s, callId).end_reason, 'server_shutdown'); assert.equal(s.got(A.socketId, 'call:ended').length, 1);
});

// ---------------------------------------------------------------- ICE configuration
test('ICE: default public STUN, TURN only when configured, short-lived HMAC credentials with a secret', () => {
  assert.deepEqual(iceServersFor('u1', {}), [{ urls: ['stun:stun.l.google.com:19302'] }]);
  assert.deepEqual(iceServersFor('u1', { WEBRTC_STUN_URLS: '' }), []);
  assert.deepEqual(iceServersFor('u1', { WEBRTC_STUN_URLS: 'stun:a:3478, http://evil, stun:b:3478' }), [{ urls: ['stun:a:3478', 'stun:b:3478'] }]);
  const env = { WEBRTC_TURN_URLS: 'turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349', WEBRTC_TURN_SECRET: 's3cret', WEBRTC_TURN_TTL_SECONDS: '600' };
  const t = iceServersFor('user-1', env, 1_700_000_000_000).find(x => x.username)!; assert.equal(t.username, '1700000600:user-1'); assert.match(String(t.credential), /^[A-Za-z0-9+/]+=*$/);
  assert.notEqual(t.credential, iceServersFor('user-2', env, 1_700_000_000_000).find(x => x.username)!.credential, 'credentials are per user');
  assert.deepEqual(iceServersFor('u', { WEBRTC_STUN_URLS: '', WEBRTC_TURN_URLS: 'turn:t:3478', WEBRTC_TURN_USERNAME: 'bob', WEBRTC_TURN_CREDENTIAL: 'pw' }), [{ urls: ['turn:t:3478'], username: 'bob', credential: 'pw' }]);
  assert.deepEqual(iceServersFor('u', { WEBRTC_STUN_URLS: '', WEBRTC_TURN_URLS: 'turn:t:3478' }), [], 'TURN without credentials is not offered');
  assert.equal(turnConfigured({ WEBRTC_TURN_URLS: 'turn:t:3478', WEBRTC_TURN_SECRET: 'x' }), true); assert.equal(turnConfigured({}), false);
});
