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
