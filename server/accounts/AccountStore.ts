import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../Log';

export interface SessionRec {
  /** SHA-256 (hex) of the session secret; the secret itself is only in the browser. */
  h: string;
  created: number;
  last: number;
  exp: number;
}

export interface AccountRec {
  v: 1;
  /** Random 128-bit id (base64url); never shown to other players. */
  id: string;
  /** Username as typed at registration (display). */
  name: string;
  /** Lower-case name: accounts are unique case-insensitively. */
  key: string;
  /** The profile (level, XP, unlocks, skin) this account owns. */
  profile: string;
  /** `scrypt$...` hash of the password (server/Security.ts). */
  pass: string;
  /** SHA-256 (hex) of the one-time recovery code. */
  recovery: string;
  created: number;
  passChanged: number;
  sessions: SessionRec[];
}

const ID = /^[A-Za-z0-9_-]{22}$/;

function clean(raw: unknown): AccountRec | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  if (typeof r.id !== 'string' || !ID.test(r.id) || typeof r.name !== 'string' || typeof r.key !== 'string') return null;
  if (typeof r.profile !== 'string' || typeof r.pass !== 'string' || typeof r.recovery !== 'string') return null;
  const sessions = Array.isArray(r.sessions)
    ? r.sessions.filter((s): s is Record<string, unknown> => !!s && typeof s === 'object' && typeof (s as { h?: unknown }).h === 'string')
      .slice(0, 16).map((s) => ({ h: String(s.h), created: num(s.created), last: num(s.last), exp: num(s.exp) }))
    : [];
  return { v: 1, id: r.id, name: r.name, key: r.key, profile: r.profile, pass: r.pass, recovery: r.recovery, created: num(r.created), passChanged: num(r.passChanged), sessions };
}

/**
 * Accounts on disk: `<DATA_DIR>/accounts/<shard>/<id>.json`, one small file per account, written atomically
 * (temp file + rename, mode 0600). Every account is loaded at start (they are tiny and sessions are checked on
 * each request); `save` writes at once, `touch` defers to the next `flush` (used for the sliding session expiry).
 */
export class AccountStore {
  private readonly byId = new Map<string, AccountRec>();
  private readonly byKey = new Map<string, string>();
  private readonly byProfile = new Map<string, string>();
  private readonly dirty = new Set<string>();

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const shard of readdirSync(dir)) {
      if (!/^[A-Za-z0-9_-]{2}$/.test(shard)) continue;
      for (const f of readdirSync(join(dir, shard))) {
        if (!f.endsWith('.json')) continue;
        try {
          const a = clean(JSON.parse(readFileSync(join(dir, shard, f), 'utf8')));
          if (a && `${a.id}.json` === f) this.index(a);
        } catch (e) {
          log.warn('unreadable account file skipped', { file: f, error: String(e) });
        }
      }
    }
  }

  get count(): number { return this.byId.size; }
  get(id: string): AccountRec | undefined { return this.byId.get(id); }
  byName(key: string): AccountRec | undefined { const id = this.byKey.get(key); return id ? this.byId.get(id) : undefined; }
  byProfileId(profile: string): AccountRec | undefined { const id = this.byProfile.get(profile); return id ? this.byId.get(id) : undefined; }
  isLinked(profile: string): boolean { return this.byProfile.has(profile); }

  private index(a: AccountRec): void {
    this.byId.set(a.id, a);
    this.byKey.set(a.key, a.id);
    this.byProfile.set(a.profile, a.id);
  }

  private file(id: string): string { return join(this.dir, id.slice(0, 2), `${id}.json`); }

  /** Adds or updates an account and writes it to disk now (throws when the disk write fails). */
  save(a: AccountRec): void {
    this.index(a);
    this.dirty.delete(a.id);
    mkdirSync(join(this.dir, a.id.slice(0, 2)), { recursive: true, mode: 0o700 });
    const file = this.file(a.id);
    writeFileSync(`${file}.tmp`, JSON.stringify(a), { mode: 0o600 });
    try { chmodSync(`${file}.tmp`, 0o600); } catch { /* not supported on this filesystem */ }
    renameSync(`${file}.tmp`, file);
  }

  /** The account changed in a way that may wait for the next flush. */
  touch(id: string): void { if (this.byId.has(id)) this.dirty.add(id); }

  delete(id: string): void {
    const a = this.byId.get(id);
    if (!a) return;
    this.byId.delete(id);
    if (this.byKey.get(a.key) === id) this.byKey.delete(a.key);
    if (this.byProfile.get(a.profile) === id) this.byProfile.delete(a.profile);
    this.dirty.delete(id);
    rmSync(this.file(id), { force: true });
    rmSync(`${this.file(id)}.tmp`, { force: true });
  }

  flush(): void {
    for (const id of [...this.dirty]) {
      const a = this.byId.get(id);
      this.dirty.delete(id);
      if (!a) continue;
      try { this.save(a); } catch { this.dirty.add(id); }
    }
  }

  has(id: string): boolean { return existsSync(this.file(id)); }
}
