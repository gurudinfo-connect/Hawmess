import React, { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { api } from '../api';
import { CallEngine, CallState, SocketLike } from './callEngine';
import { closeRealtime, connectRealtime } from './realtime';
import { CallLayer } from './CallUI';

interface Ctx { state: CallState; engine: CallEngine }
const C = createContext<Ctx | null>(null);
export const useCall = () => { const c = useContext(C); if (!c) throw new Error('useCall must be used inside <CallProvider>'); return c; };

/** Mounted once inside the signed-in shell, so incoming calls ring on any page and an active call survives navigation. */
export function CallProvider({ children }: { children: React.ReactNode }) {
  const ref = useRef<CallEngine | null>(null);
  if (!ref.current) {
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;   // undefined on non-HTTPS pages → the engine explains why
    ref.current = new CallEngine({
      socket: connectRealtime() as unknown as SocketLike,
      getUserMedia: md?.getUserMedia ? c => md.getUserMedia(c) : undefined,
      createPeer: cfg => new RTCPeerConnection(cfg), createStream: () => new MediaStream(),
      loadIce: async () => { const r = await api('/calls/config'); return { iceServers: r.ice_servers || [] }; },
    });
  }
  const engine = ref.current;
  const state = useSyncExternalStore(engine.subscribe, engine.getState);
  useEffect(() => {
    const leave = () => engine.dispose();                 // closing / reloading the tab hangs up and releases the camera + microphone
    window.addEventListener('pagehide', leave);
    return () => { window.removeEventListener('pagehide', leave); engine.dispose(); closeRealtime(); };
  }, [engine]);
  const value = useMemo(() => ({ state, engine }), [state, engine]);
  return <C.Provider value={value}>{children}<CallLayer /></C.Provider>;
}
