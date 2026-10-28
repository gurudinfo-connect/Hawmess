import { createHmac } from 'node:crypto';

export interface IceServer { urls: string | string[]; username?: string; credential?: string }
type Env = Record<string, string | undefined>;

const SCHEME = /^(stun|stuns|turn|turns):/i;
const list = (v?: string) => (v || '').split(',').map(s => s.trim()).filter(s => SCHEME.test(s));
let warned = false;

/**
 * ICE servers handed to an AUTHENTICATED client (GET /calls/config). Nothing here is compiled into the frontend bundle.
 *
 *   WEBRTC_STUN_URLS        comma-separated stun: URLs (default Google's public STUN; set to "" to disable)
 *   WEBRTC_TURN_URLS        comma-separated turn:/turns: URLs of YOUR TURN server (needed on strict corporate NATs / firewalls)
 *   WEBRTC_TURN_SECRET      coturn `static-auth-secret` (use-auth-secret): short-lived per-user credentials are minted per request
 *   WEBRTC_TURN_TTL_SECONDS lifetime of those credentials (default 3600)
 *   WEBRTC_TURN_USERNAME / WEBRTC_TURN_CREDENTIAL   static long-term credentials, used only when no secret is set
 */
export function iceServersFor(userId: string, env: Env = process.env, nowMs = Date.now()): IceServer[] {
  const out: IceServer[] = [];
  const stun = env.WEBRTC_STUN_URLS === undefined ? ['stun:stun.l.google.com:19302'] : list(env.WEBRTC_STUN_URLS);
  if (stun.length) out.push({ urls: stun });
  const turn = list(env.WEBRTC_TURN_URLS);
  if (turn.length) {
    if (env.WEBRTC_TURN_SECRET) {
      const ttl = Math.max(60, parseInt(env.WEBRTC_TURN_TTL_SECONDS || '3600', 10) || 3600);
      const username = `${Math.floor(nowMs / 1000) + ttl}:${userId}`;
      out.push({ urls: turn, username, credential: createHmac('sha1', env.WEBRTC_TURN_SECRET).update(username).digest('base64') });
    } else if (env.WEBRTC_TURN_USERNAME && env.WEBRTC_TURN_CREDENTIAL) {
      out.push({ urls: turn, username: env.WEBRTC_TURN_USERNAME, credential: env.WEBRTC_TURN_CREDENTIAL });
    } else if (!warned) { warned = true; console.warn('WEBRTC_TURN_URLS is set but no TURN credentials (WEBRTC_TURN_SECRET or WEBRTC_TURN_USERNAME + WEBRTC_TURN_CREDENTIAL); TURN is disabled.'); }
  } else if (!warned && env.NODE_ENV === 'production') { warned = true; console.warn('Calling: no TURN server configured (WEBRTC_TURN_URLS). Calls will fail between users behind symmetric NAT / strict firewalls.'); }
  return out;
}
export const turnConfigured = (env: Env = process.env) => list(env.WEBRTC_TURN_URLS).length > 0 && !!(env.WEBRTC_TURN_SECRET || (env.WEBRTC_TURN_USERNAME && env.WEBRTC_TURN_CREDENTIAL));
