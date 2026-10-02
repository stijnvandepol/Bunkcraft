import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CSP, SECURITY_HEADERS } from '../../server/security';

describe('security headers', () => {
  it('CSP forbids inline scripts, eval, plugins, framing and base tag injection', () => {
    expect(CSP).toContain("script-src 'self'");
    expect(CSP).not.toMatch(/script-src[^;]*'unsafe-/);
    expect(CSP).toContain("object-src 'none'");
    expect(CSP).toContain("frame-ancestors 'none'");
    expect(CSP).toContain("base-uri 'none'");
  });

  it('sets the standard hardening headers', () => {
    expect(SECURITY_HEADERS['x-content-type-options']).toBe('nosniff');
    expect(SECURITY_HEADERS['referrer-policy']).toBe('no-referrer');
    expect(SECURITY_HEADERS['permissions-policy']).toContain('camera=()');
  });

  it('the Caddyfile carries the same CSP so a proxy deployment is not weaker', () => {
    const caddy = readFileSync('Caddyfile', 'utf8');
    expect(caddy).toContain(CSP);
  });
});
