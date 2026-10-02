import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Room passwords, owner and identity tokens, constant-time comparison.
 *
 * Passwords are stored as `scrypt$N$r$p$salt$hash` (base64) and are never sent back to clients.
 * Tokens are 192-bit random values; only their SHA-256 is stored (they carry enough entropy
 * that a slow hash adds nothing).
 */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
export const MAX_PASSWORD_LENGTH = 64;

function scryptAsync(password: string, salt: Buffer, N: number, r: number, p: number, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, keylen, { N, r, p, maxmem: 128 * N * r * 2 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Hashes a password for storage; async so the event loop keeps ticking (~50 ms of CPU). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password.slice(0, MAX_PASSWORD_LENGTH), salt, SCRYPT.N, SCRYPT.r, SCRYPT.p, SCRYPT.keylen);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (![N, r, p].every(Number.isInteger) || N > 1 << 20 || N < 2) return false;
  const expected = Buffer.from(parts[5], 'base64');
  if (expected.length === 0) return false;
  try {
    const key = await scryptAsync(String(password).slice(0, MAX_PASSWORD_LENGTH), Buffer.from(parts[4], 'base64'), N, r, p, expected.length);
    return timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

export function newToken(): string {
  return randomBytes(24).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time string comparison (hashes first, so lengths do not leak). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** True when `token` is a non-empty string whose hash equals the stored hash. */
export function tokenMatches(token: unknown, storedHash: string | undefined): boolean {
  if (typeof token !== 'string' || token.length === 0 || token.length > 128 || !storedHash) return false;
  return safeEqual(hashToken(token), storedHash);
}

/** Salted hash of an IP for ban lists (the raw address is not written to world.json). */
export function hashIp(ip: string, salt: string): string {
  return createHash('sha256').update(`${salt}|${ip}`).digest('hex').slice(0, 24);
}

/** Bearer token from an Authorization header, or null. */
export function bearer(header: string | string[] | undefined): string | null {
  const v = Array.isArray(header) ? header[0] : header;
  const m = /^Bearer\s+(\S+)$/i.exec(v ?? '');
  return m ? m[1] : null;
}

/** Sliding-window limiter keyed by client address (shared by the HTTP API and failed logins). */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly limit: number, private readonly windowMs: number) {}

  /** True when the action is allowed (and counts it). */
  take(key: string): boolean {
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  /** True while the key is under the limit; does not count (use `record` for failures). */
  allowed(key: string): boolean {
    const now = Date.now();
    return (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs).length < this.limit;
  }

  record(key: string): void {
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    recent.push(now);
    this.hits.set(key, recent);
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  prune(): void {
    const now = Date.now();
    for (const [k, v] of this.hits) if (v.every((t) => now - t >= this.windowMs)) this.hits.delete(k);
  }
}
