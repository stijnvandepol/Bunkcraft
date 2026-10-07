import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Signed profile tokens: identity without accounts. The server hands a browser `v1.<id>.<sig>` once; `id` is
 * 128 random bits and `sig` an HMAC-SHA256 of it under a server secret. A token proves the profile was issued
 * by this server, so nobody can invent profile ids (no files created from thin air) or take over someone else's
 * profile without its token. The browser keeps the token in localStorage, like the owner tokens of games.
 *
 * Losing the secret (deleting DATA_DIR/profiles/secret.key) invalidates every token; set PROFILE_SECRET to
 * share one secret between several server instances.
 */
const PREFIX = 'v1';
const ID_BYTES = 16;
const TOKEN_PATTERN = /^v1\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;

export class ProfileSigner {
  private readonly secret: Buffer;

  constructor(secret: Buffer | string) {
    this.secret = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : secret;
    if (this.secret.length < 16) throw new Error('profile secret must be at least 16 bytes');
  }

  private sign(id: string): Buffer {
    return createHmac('sha256', this.secret).update(`bunkcraft-profile|${PREFIX}|${id}`).digest();
  }

  /** A new profile id and the token that proves it. */
  issue(): { id: string; token: string } {
    const id = randomBytes(ID_BYTES).toString('base64url');
    return { id, token: `${PREFIX}.${id}.${this.sign(id).toString('base64url')}` };
  }

  /** The profile id a token stands for, or null when it is malformed or not signed by this server. */
  verify(token: unknown): string | null {
    if (typeof token !== 'string' || token.length > 80) return null;
    const m = TOKEN_PATTERN.exec(token);
    if (!m) return null;
    const given = Buffer.from(m[2], 'base64url');
    const want = this.sign(m[1]);
    if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
    return m[1];
  }
}

/** The secret from PROFILE_SECRET, else from `file` (created with 256 random bits on first start, mode 0600). */
export function loadSecret(file: string, fromEnv?: string): Buffer {
  if (fromEnv && fromEnv.length >= 16) return Buffer.from(fromEnv, 'utf8');
  if (existsSync(file)) {
    const s = readFileSync(file);
    if (s.length >= 16) return s;
  }
  mkdirSync(dirname(file), { recursive: true });
  const secret = randomBytes(32);
  writeFileSync(file, secret, { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* not supported on this filesystem */ }
  return secret;
}
