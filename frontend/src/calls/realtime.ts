import { io, Socket } from 'socket.io-client';
import { useSyncExternalStore } from 'react';
import { BASE, getToken } from '../api';

export type Presence = 'available' | 'busy' | 'offline';

/** Socket.IO endpoint derived from the same base URL as the REST API (so nginx / the Vite proxy already route it). */
export function realtimeTarget(base = BASE, origin = typeof location !== 'undefined' ? location.href : 'http://localhost/') {
  const u = new URL(base, origin);
  return { url: u.origin, path: `${u.pathname.replace(/\/$/, '')}/realtime` };
}

// ---------------------------------------------------------------- presence (who is online / in a call)
let presence: Record<string, Presence> = {};
const subs = new Set<() => void>();
const setPresence = (p: Record<string, Presence>) => { presence = p; subs.forEach(f => f()); };
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
/** Presence of one colleague: 'available' | 'busy' (in a call) | 'offline'. Updated live by the server. */
export function usePresence(userId?: string | null): Presence {
  return useSyncExternalStore(subscribe, () => (userId && presence[userId]) || 'offline');
}
export const presenceLabel = (p: Presence) => (p === 'available' ? 'Available' : p === 'busy' ? 'Busy' : 'Offline');

// ---------------------------------------------------------------- the socket
let socket: Socket | null = null;
/** One authenticated connection per tab. The JWT is sent in the handshake; the server re-reads the user from the database. */
export function connectRealtime(): Socket {
  if (socket) return socket;
  const { url, path } = realtimeTarget();
  const s = io(url, { path, transports: ['websocket'], auth: cb => cb({ token: getToken() }), reconnection: true, reconnectionDelay: 500, reconnectionDelayMax: 4000, timeout: 8000 });
  s.on('presence:snapshot', (p: { users: Record<string, Presence> }) => setPresence({ ...(p?.users || {}) }));
  s.on('presence:update', (p: { user_id: string; status: Presence }) => { const next = { ...presence }; if (p.status === 'offline') delete next[p.user_id]; else next[p.user_id] = p.status; setPresence(next); });
  s.on('disconnect', () => setPresence({}));
  s.on('connect_error', (e: Error) => { if (e?.message === 'unauthorized' || e?.message === 'deactivated') s.disconnect(); });   // expired / revoked token: stop retrying (the REST API will send the user to /login)
  socket = s; return s;
}
export function closeRealtime() { socket?.removeAllListeners(); socket?.disconnect(); socket = null; setPresence({}); }
