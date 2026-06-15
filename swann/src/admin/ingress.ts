/**
 * Swann — admin ingress helpers.
 *
 * Home Assistant Ingress proxies the add-on's web UI behind HA auth. Two
 * concerns are handled here:
 *
 *  1. Source IP gating: when `admin.ingressOnly` is true, only the HA Ingress
 *     gateway (172.30.32.2) is allowed to reach the server. Everything else is
 *     rejected with 403. (HA itself performs user authentication; we only make
 *     sure traffic actually came through the Ingress proxy.)
 *
 *  2. Dynamic base path: Ingress rewrites the URL prefix and sends the real
 *     base path in the `X-Ingress-Path` header. The frontend must prefix every
 *     asset/API URL with it, so we read it per-request and expose it to routes.
 *
 * This module owns no Fastify-specific types beyond the request shape it needs,
 * keeping it trivially testable.
 */

/** The fixed IP the HA Supervisor Ingress proxy connects from. */
export const HA_INGRESS_GATEWAY_IP = '172.30.32.2';

/** Minimal request shape these helpers need (decoupled from Fastify types). */
export interface IngressRequestLike {
  readonly ip?: string;
  readonly socket?: { readonly remoteAddress?: string | null };
  readonly headers: Record<string, string | string[] | undefined>;
}

/**
 * Normalise a remote address. Node may report IPv4 addresses in the
 * IPv4-mapped IPv6 form (e.g. "::ffff:172.30.32.2"); strip that prefix so the
 * comparison against the gateway IP is reliable.
 */
export function normaliseIp(addr: string | null | undefined): string {
  if (!addr) return '';
  return addr.startsWith('::ffff:') ? addr.slice('::ffff:'.length) : addr;
}

/**
 * The genuine TCP peer address (socket-level), used for the SECURITY gate.
 * We deliberately do NOT use `req.ip` here: with `trustProxy` enabled Fastify
 * derives `req.ip` from the X-Forwarded-For header, which a client could spoof.
 * The socket remoteAddress is the real peer and cannot be forged.
 */
export function peerIp(req: IngressRequestLike): string {
  return normaliseIp(req.socket?.remoteAddress ?? '');
}

/** Best-known remote address for LOGGING/diagnostics (may reflect XFF). */
export function remoteIp(req: IngressRequestLike): string {
  return normaliseIp(req.ip ?? req.socket?.remoteAddress ?? '');
}

/**
 * Decide whether a request is allowed given the ingress-only policy.
 * When `ingressOnly` is false (dev / direct access) everything is allowed.
 * The decision is made on the unspoofable socket peer address.
 */
export function isRequestAllowed(req: IngressRequestLike, ingressOnly: boolean): boolean {
  if (!ingressOnly) return true;
  return peerIp(req) === HA_INGRESS_GATEWAY_IP;
}

/**
 * Read the dynamic Ingress base path. HA sends it without a trailing slash
 * (e.g. "/api/hassio_ingress/<token>"); we return it verbatim (trailing slash
 * stripped) so callers can build `${base}/foo`. Empty string when accessed
 * directly (dev) so URLs resolve relative to the server root.
 */
export function ingressBasePath(req: IngressRequestLike): string {
  const raw = req.headers['x-ingress-path'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return '';
  return value.endsWith('/') ? value.slice(0, -1) : value;
}
