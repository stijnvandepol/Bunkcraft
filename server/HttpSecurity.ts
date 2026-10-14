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
 *   forge it through the tunnel), and only when the connection comes from a TRUSTED_PROXY_ADDRS address (the
 *   cloudflared host; default loopback): anyone else reaching the port directly could send the header themselves.
 *   Without the option the header is ignored.
 *   A missing or malformed header falls through to the rules below.
 * - Reverse proxy (TRUST_PROXY=1): X-Forwarded-For, and then its LAST entry: that is the one the proxy appended
 *   itself. Earlier entries are whatever the client sent, so a proxy that appends (nginx's
 *   $proxy_add_x_forwarded_for) would otherwise let anyone pick their own address.
 * - Otherwise the socket address.
 */
/** Default for TRUSTED_PROXY_ADDRS: only a cloudflared on this machine (loopback). */
export const LOOPBACK_PROXIES: readonly string[] = ['127.0.0.1', '::1'];

/** Whether `addr` matches one of the entries: an exact address or an IPv4 CIDR ("172.16.0.0/12"). IPv4-mapped IPv6 counts as IPv4. */
export function addressInList(addr: string | undefined, list: readonly string[]): boolean {
  if (!addr) return false;
  const a = addr.startsWith('::ffff:') && isIP(addr.slice(7)) === 4 ? addr.slice(7) : addr;
  const v4 = (ip: string): number | null => {
    if (isIP(ip) !== 4) return null;
    return ip.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
  };
  for (const entry of list) {
    const [net, bits] = entry.trim().split('/');
    if (bits === undefined) {
      if (net === a) return true;
      continue;
    }
    const an = v4(a), nn = v4(net), b = Number(bits);
    if (an === null || nn === null || !Number.isInteger(b) || b < 0 || b > 32) continue;
    const mask = b === 0 ? 0 : (~0 << (32 - b)) >>> 0;
    if ((an & mask) === (nn & mask)) return true;
  }
  return false;
}

/** The eight 16-bit groups of an IPv6 address (zone id dropped, embedded IPv4 converted), or null. */
function ipv6Groups(ip: string): number[] | null {
  let a = ip.split('%')[0];
  if (isIP(a) !== 6) return null;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (v4) {
    const p = v4[1].split('.').map(Number);
    a = `${a.slice(0, -v4[1].length)}${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const [head, tail] = a.includes('::') ? a.split('::') : [a, null];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = tail === null ? [] : new Array<string>(8 - h.length - t.length).fill('0');
  const groups = [...h, ...fill, ...t].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/**
 * The key an address is counted, limited and blocked under. IPv4 (also IPv4-mapped IPv6) as is; IPv6 as its /64
 * ("2001:db8:1:2::/64"), because one subscriber holds a whole /64 (often a /56) and could otherwise step through
 * 2^64 "new visitors" past every per-address limit, connection cap and block. A key given back in ("…::/64") stays
 * the same key, so the ops dashboard can block what it shows. Anything else (a test's "unknown") comes back unchanged.
 */
export function addressKey(ip: string): string {
  const s = ip.trim();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  if (mapped && isIP(mapped[1]) === 4) return mapped[1];
  if (isIP(s) === 4) return s;
  const net = s.endsWith('/64') ? s.slice(0, -3) : s;
  const g = ipv6Groups(net);
  if (!g) return s;
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}

/** An address (or an /64 key) an admin typed in to block, as its key; null when it is neither. */
export function blockKey(input: string): string | null {
  const s = input.trim();
  if (isIP(s) === 0 && !(s.endsWith('/64') && isIP(s.slice(0, -3)) === 6)) return null;
  return addressKey(s);
}

export function clientAddress(
  forwarded: string | string[] | undefined,
  remote: string | undefined,
  trustProxy: boolean,
  cfConnectingIp?: string | string[] | undefined,
  trustCloudflare = false,
  trustedFrom: readonly string[] = LOOPBACK_PROXIES,
): string {
  // CF-Connecting-IP only from the tunnel itself: anyone else reaching the port could forge it.
  if (trustCloudflare && addressInList(remote, trustedFrom)) {
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
