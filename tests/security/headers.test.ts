import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CSP, SECURITY_HEADERS, clientAddress } from '../../server/HttpSecurity';

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

describe('clientAddress', () => {
  it('ignores X-Forwarded-For unless a proxy is trusted', () => {
    expect(clientAddress('6.6.6.6', '1.2.3.4', false)).toBe('1.2.3.4');
    expect(clientAddress(undefined, undefined, false)).toBe('unknown');
  });

  it('behind a proxy takes the entry the proxy appended, not the one the client made up', () => {
    expect(clientAddress('6.6.6.6, 1.2.3.4', '10.0.0.2', true)).toBe('1.2.3.4');
    expect(clientAddress(['6.6.6.6', '1.2.3.4'], '10.0.0.2', true)).toBe('1.2.3.4');
    expect(clientAddress('1.2.3.4', '10.0.0.2', true)).toBe('1.2.3.4');
    expect(clientAddress(undefined, '10.0.0.2', true)).toBe('10.0.0.2');
  });

  describe('Cloudflare Tunnel (CF-Connecting-IP)', () => {
    it('ignores the header unless TRUST_CLOUDFLARE is on, so a direct client cannot pick its address', () => {
      expect(clientAddress(undefined, '1.2.3.4', false, '6.6.6.6')).toBe('1.2.3.4');
      expect(clientAddress(undefined, '1.2.3.4', false, '6.6.6.6', false)).toBe('1.2.3.4');
      // also behind a trusted proxy: the header does not override X-Forwarded-For
      expect(clientAddress('5.5.5.5', '10.0.0.2', true, '6.6.6.6', false)).toBe('5.5.5.5');
    });

    it('uses the header when TRUST_CLOUDFLARE is on', () => {
      expect(clientAddress(undefined, '172.18.0.1', false, '203.0.113.7', true)).toBe('203.0.113.7');
      expect(clientAddress(undefined, '172.18.0.1', false, ' 2001:db8::1 ', true)).toBe('2001:db8::1');
      expect(clientAddress(undefined, '172.18.0.1', false, ['203.0.113.7', '6.6.6.6'], true)).toBe('203.0.113.7');
      // it wins over X-Forwarded-For
      expect(clientAddress('9.9.9.9', '172.18.0.1', true, '203.0.113.7', true)).toBe('203.0.113.7');
    });

    it('falls back when the header is missing or not an address', () => {
      expect(clientAddress(undefined, '172.18.0.1', false, undefined, true)).toBe('172.18.0.1');
      expect(clientAddress(undefined, '172.18.0.1', false, '', true)).toBe('172.18.0.1');
      expect(clientAddress(undefined, '172.18.0.1', false, 'not-an-ip, 1.1.1.1', true)).toBe('172.18.0.1');
      expect(clientAddress('9.9.9.9', '172.18.0.1', true, 'junk', true)).toBe('9.9.9.9');
    });
  });
});
