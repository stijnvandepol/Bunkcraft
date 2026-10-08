import { isIP } from 'node:net';

/**
 * Security response headers for the static server. Keep the Caddyfile in sync (docs/SECURITY.md).
 *
 * - No inline script and no eval: everything is a same-origin module (the chunk worker is a bundled
 *   module worker; resource pack textures are blob: images).
 * - style-src-attr 'unsafe-inline' only because the UI sets a few style="" attributes (sizes and colours
 *   built from numbers and fixed colour tables, never from user text).
 * - connect-src allows any ws:/wss: host because Direct Connect lets players join other servers.
 *   Hosts that only want their own server can replace `ws: wss:` with `'self'`.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' ws: wss:",
  "worker-src 'self' blob:",
  "media-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), interest-cohort=()',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};

/**
 * The address used for rate limits.
 *
 * - Cloudflare Tunnel (TRUST_CLOUDFLARE=1): the `CF-Connecting-IP` header, set by Cloudflare's edge (a client cannot
 *   forge it through the tunnel). Only enable it when the server is reachable through Cloudflare alone: anyone who
 *   can reach the port directly could send the header themselves. Without the option the header is ignored.
 *   A missing or malformed header falls through to the rules below.
 * - Reverse proxy (TRUST_PROXY=1): X-Forwarded-For, and then its LAST entry: that is the one the proxy appended
 *   itself. Earlier entries are whatever the client sent, so a proxy that appends (nginx's
 *   $proxy_add_x_forwarded_for) would otherwise let anyone pick their own address.
 * - Otherwise the socket address.
 */
export function clientAddress(
  forwarded: string | string[] | undefined,
  remote: string | undefined,
  trustProxy: boolean,
  cfConnectingIp?: string | string[] | undefined,
  trustCloudflare = false,
): string {
  if (trustCloudflare) {
    const cf = (Array.isArray(cfConnectingIp) ? cfConnectingIp[0] : cfConnectingIp)?.trim();
    if (cf && isIP(cf)) return cf;
  }
  if (trustProxy) {
    const header = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
    const last = header?.split(',').pop()?.trim();
    if (last) return last;
  }
  return remote ?? 'unknown';
}
