/**
 * LAN-facing HTTP access policy for the daemon hub (GitHub issue #145).
 *
 * The daemon deliberately listens on all interfaces — companion apps, ESP32
 * boards, and pull-sync e-ink clients all live on the LAN — so the security
 * boundary is authentication, not the bind address. The rules here are the
 * single chokepoint the request handler consults before dispatching routes:
 *
 * - Same-machine connections (loopback or any of this host's own addresses)
 *   are fully trusted, matching the WS server's long-standing policy.
 * - A remote request is authorized only by pairing token (`?token=` query or
 *   `Authorization: Bearer`).
 * - Unauthorized remote requests reach exactly one route: a minimal
 *   `GET /health` that carries **no pairing token, no module/device
 *   inventory, and no session state** — just enough for a companion app to
 *   recognize a daemon and know that pairing is required. Everything else
 *   is 401.
 *
 * Kept as pure functions (no server state) so the deny matrix and the
 * secret-free public payload are unit-testable without booting a daemon.
 */
import type { IncomingMessage } from 'http';
import { isLocalConnection, validateToken } from './auth.js';

export type HttpGateDecision = 'allow' | 'public-health' | 'deny';

/** True when the request is same-machine or carries a valid pairing token. */
export function isAuthorizedHttpRequest(
  req: Pick<IncomingMessage, 'url' | 'headers'> & { socket: { remoteAddress?: string } },
): boolean {
  const ip = req.socket.remoteAddress ?? '';
  if (isLocalConnection(ip)) return true;

  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const queryToken = url.searchParams.get('token');
    if (queryToken && validateToken(queryToken)) return true;
  } catch {
    // Unparseable URL — fall through to header check.
  }

  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ') && validateToken(auth.slice(7))) {
    return true;
  }
  return false;
}

/** Route an (un)authorized request: full dispatch, public health, or 401. */
export function gateHttpRequest(method: string, pathname: string, authorized: boolean): HttpGateDecision {
  if (authorized) return 'allow';
  if (method === 'GET' && pathname === '/health') return 'public-health';
  return 'deny';
}

/**
 * The `/health` payload served to unauthenticated LAN peers. Discovery-grade
 * only: enough for a companion app to identify a daemon (`mode`) and for a
 * remote worker to see the attach capability bit — never credentials,
 * device inventory, or session state. `authRequired` tells clients to open
 * their pairing flow instead of retrying.
 */
export function buildPublicHealth(port: number): Record<string, unknown> {
  return {
    status: 'ok',
    mode: 'daemon',
    port,
    sameSocketControl: true,
    authRequired: true,
  };
}
