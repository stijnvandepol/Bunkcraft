import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { type AccountIssue, checkPassword, checkUsername, usernameKey } from '../../src/modes/progression/AccountRules';
import { log } from '../Log';
import { hashPassword, safeEqual, verifyPassword } from '../Security';
import { type AccountRec, AccountStore, type SessionRec } from './AccountStore';

/** What the account service needs from the profile side (ProfileService in production, a stub in unit tests). */
export interface ProfileHooks {
  /** A new, empty profile for a new account (null when the server keeps no more). */
  create(name: string): string | null;
  exists(id: string): boolean;
  /** Renames the profile to the account name. */
  rename(id: string, name: string): void;
  /** Removes the profile and everything hanging on it (skin assignment, file). */
  remove(id: string): void;
  /** Level of a profile for the admin list (optional). */
  level?(id: string): number;
}

export interface AccountOptions {
  /** `<DATA_DIR>`: accounts live in `<DATA_DIR>/accounts/`. */
  dataDir: string;
  maxAccounts: number;
  /** Session lifetime without use (default 30 days); it slides while the account is in use. */
  sessionDays?: number;
  /** Hard cap on one session whatever its use (default 180 days). */
  sessionMaxDays?: number;
  /** Failed attempts per name before the lockout starts (default 5). */
  lockAfter?: number;
  /** First lockout in ms; doubles with every further failure up to 15 minutes (default 15 s). */
  lockBaseMs?: number;
  profiles: ProfileHooks;
}

export type AccountFail = {
  ok: false;
  status: number;
  error: 'invalid_request' | AccountIssue | 'name_taken' | 'invalid_credentials' | 'locked' | 'full' | 'unauthorized' | 'already_account' | 'account_locked' | 'not_found' | 'disk';
  retryAfter?: number;
};
export type AccountOk<T> = { ok: true } & T;

export interface SessionInfo { token: string; profileId: string; name: string }

const DAY = 86_400_000;
const MAX_SESSIONS = 5;
const SESSION_TOKEN = /^s1\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{32})$/;
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const fail = (status: number, error: AccountFail['error'], retryAfter?: number): AccountFail => ({ ok: false, status, error, ...(retryAfter ? { retryAfter } : {}) });

/** A recovery code: 25 characters of Crockford base32 (125 bits) in groups of five. */
export function newRecoveryCode(): string {
  const bytes = randomBytes(25);
  let s = '';
  for (let i = 0; i < 25; i++) s += CODE_ALPHABET[bytes[i] & 31];
  return s.match(/.{5}/g)!.join('-');
}

/** Normalises what a player typed (case, dashes, spaces, look-alike letters) before hashing. */
export function normalizeRecoveryCode(v: unknown): string {
  if (typeof v !== 'string' || v.length > 64) return '';
  return v.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

const hashRecovery = (code: string): string => sha256(`bunkcraft-recovery|${normalizeRecoveryCode(code)}`);

/**
 * Player accounts: username + password, server-side progress. An account owns one profile; logging in hands the
 * browser a session token (`s1.<account>.<secret>`) that the profile layer accepts wherever it accepts a guest
 * token (HTTP bearer, WebSocket hello), so skins, parties, rejoin and XP follow the account without changes.
 * Passwords are scrypt-hashed with a per-user salt (server/Security.ts) and never logged; the recovery code and
 * session secrets are stored as SHA-256 only. Failures are counted per name (existing or not, so the lockout is
 * no oracle) with doubling backoff; the HTTP layer adds per-address limits.
 */
export class AccountService {
  readonly store: AccountStore;
  private readonly timer: NodeJS.Timeout;
  private readonly fails = new Map<string, { n: number; until: number; last: number }>();
  private dummy: Promise<string> | null = null;
  /** ADMIN_ACCOUNTS (lower-case names): admins besides the accounts with the persistent `admin` flag. */
  private adminNames = new Set<string>();
  private readonly opts: Required<Omit<AccountOptions, 'profiles' | 'dataDir'>> & { profiles: ProfileHooks };

  constructor(o: AccountOptions) {
    this.store = new AccountStore(join(o.dataDir, 'accounts'));
    this.opts = {
      maxAccounts: o.maxAccounts, sessionDays: o.sessionDays ?? 30, sessionMaxDays: o.sessionMaxDays ?? 180,
      lockAfter: o.lockAfter ?? 5, lockBaseMs: o.lockBaseMs ?? 15_000, profiles: o.profiles,
    };
    this.timer = setInterval(() => { this.store.flush(); this.prune(); }, 5000);
    this.timer.unref();
  }

  get count(): number { return this.store.count; }

  /** True when this profile belongs to an account (its old guest token no longer works). */
  isLinked(profileId: string): boolean { return this.store.isLinked(profileId); }

  /** The profile id of the account that holds this name or a look-alike of it (guests may not play under it), if any. */
  reservedProfile(name: string): string | null {
    return this.store.byIdentity(name)?.profile ?? null;
  }

  /** The account name of a profile, if it belongs to an account. */
  nameOf(profileId: string): string | undefined { return this.store.byProfileId(profileId)?.name; }

  // ----- lockout -----

  private lockLeft(key: string, now: number): number {
    const f = this.fails.get(key);
    return f && f.until > now ? Math.ceil((f.until - now) / 1000) : 0;
  }

  private failed(key: string, now: number): void {
    const f = this.fails.get(key) ?? { n: 0, until: 0, last: now };
    f.n++;
    f.last = now;
    if (f.n >= this.opts.lockAfter) f.until = now + Math.min(15 * 60_000, this.opts.lockBaseMs * 2 ** (f.n - this.opts.lockAfter));
    this.fails.set(key, f);
    if (this.fails.size > 20_000) { for (const k of this.fails.keys()) { this.fails.delete(k); if (this.fails.size <= 15_000) break; } }
  }

  private prune(now = Date.now()): void {
    for (const [k, f] of this.fails) if (f.until < now && now - f.last > 3_600_000) this.fails.delete(k);
  }

  // ----- sessions -----

  private issue(a: AccountRec, now: number): string {
    const secret = randomBytes(24).toString('base64url');
    const s: SessionRec = { h: sha256(secret), created: now, last: now, exp: now + this.opts.sessionDays * DAY };
    a.sessions = [...a.sessions.filter((x) => x.exp > now), s].slice(-MAX_SESSIONS);
    return `s1.${a.id}.${secret}`;
  }

  private find(token: unknown): { a: AccountRec; s: SessionRec } | null {
    if (typeof token !== 'string' || token.length > 80) return null;
    const m = SESSION_TOKEN.exec(token);
    if (!m) return null;
    const a = this.store.get(m[1]);
    if (!a) return null;
    const h = Buffer.from(sha256(m[2]), 'hex');
    let hit: SessionRec | null = null;
    for (const s of a.sessions) {
      const sh = Buffer.from(s.h, 'hex');
      if (sh.length === h.length && timingSafeEqual(sh, h)) hit = s;
    }
    return hit ? { a, s: hit } : null;
  }

  /** The profile id behind a session token (sync, memory only), or null (unknown, expired, logged out). Slides the expiry. */
  verifySession(token: unknown, now = Date.now()): string | null {
    const f = this.find(token);
    if (!f || f.s.exp <= now || f.a.locked) return null;
    if (now - f.s.last > 3_600_000) {
      f.s.last = now;
      f.s.exp = Math.min(now + this.opts.sessionDays * DAY, f.s.created + this.opts.sessionMaxDays * DAY);
      this.store.touch(f.a.id);
    }
    return f.a.profile;
  }

  /** ADMIN_ACCOUNTS: these account names (case-insensitive, exact) are admins as long as the setting lists them. */
  setAdminNames(names: string[]): void {
    this.adminNames = new Set(names.map((n) => usernameKey(n.trim())).filter((n) => n.length > 0));
  }

  /** Names in ADMIN_ACCOUNTS that no account holds yet: whoever registers such a name becomes an admin. */
  unclaimedAdminNames(): string[] {
    return [...this.adminNames].filter((k) => !this.store.byName(k));
  }

  isAdmin(a: AccountRec): boolean {
    return a.admin === true || this.adminNames.has(a.key);
  }

  /**
   * The admin account behind a session token: null when the token is no valid session (unknown, expired, logged out),
   * `false` for a session of an account that is no admin or is locked.
   */
  adminOf(token: unknown): { name: string } | false | null {
    const f = this.find(token);
    if (!f || f.s.exp <= Date.now()) return null;
    // A lock ends every session; should one survive (an edited file), a locked account is still refused.
    if (f.a.locked) return false;
    return this.isAdmin(f.a) ? { name: f.a.name } : false;
  }

  /** The account of a valid session token. */
  accountOf(token: unknown): AccountRec | null {
    const f = this.find(token);
    return f && f.s.exp > Date.now() && !f.a.locked ? f.a : null;
  }

  private async dummyHash(): Promise<string> {
    this.dummy ??= hashPassword(randomBytes(12).toString('base64'));
    return this.dummy;
  }

  private persist(a: AccountRec): AccountFail | null {
    try { this.store.save(a); return null; } catch (e) {
      log.error('saving account failed', { error: String(e) });
      return fail(503, 'disk');
    }
  }

  // ----- calls -----

  /**
   * Makes an account. `guestProfile` (a profile id the caller proved to own through its guest token) becomes the
   * account's profile with all its progress; without one a fresh profile is created.
   */
  async register(name: unknown, password: unknown, guestProfile?: string): Promise<AccountOk<SessionInfo & { recovery: string }> | AccountFail> {
    const bad = checkUsername(name) ?? checkPassword(password, typeof name === 'string' ? name : undefined);
    if (bad) return fail(400, bad);
    const uname = name as string;
    if (this.store.byIdentity(uname)) return fail(409, 'name_taken');
    if (this.store.count >= this.opts.maxAccounts) return fail(503, 'full');
    const pass = await hashPassword(password as string);
    // Everything from here is synchronous: two simultaneous registrations cannot both win a name or a profile.
    if (this.store.byIdentity(uname)) return fail(409, 'name_taken');
    let profile: string | null = null;
    if (guestProfile && this.opts.profiles.exists(guestProfile) && !this.store.isLinked(guestProfile)) profile = guestProfile;
    else profile = this.opts.profiles.create(uname);
    if (!profile) return fail(503, 'full');
    const now = Date.now();
    const recoveryCode = newRecoveryCode();
    const a: AccountRec = {
      v: 1, id: randomBytes(16).toString('base64url'), name: uname, key: usernameKey(uname), profile, pass,
      recovery: hashRecovery(recoveryCode), created: now, passChanged: now, sessions: [],
    };
    const token = this.issue(a, now);
    const err = this.persist(a);
    if (err) { this.store.delete(a.id); return err; }
    this.opts.profiles.rename(profile, uname);
    log.info('account created', { accounts: this.store.count, linked: profile === guestProfile });
    return { ok: true, token, profileId: profile, name: uname, recovery: recoveryCode };
  }

  /** Checks a password for a name; the same work and the same answer whether the name exists or not. */
  private async check(key: string, name: unknown, password: unknown, now: number): Promise<AccountRec | AccountFail> {
    const left = this.lockLeft(key, now);
    if (left > 0) return fail(429, 'locked', left);
    const a = typeof name === 'string' ? this.store.byName(usernameKey(name)) : undefined;
    const pw = typeof password === 'string' ? password : '';
    const ok = await verifyPassword(pw, a ? a.pass : await this.dummyHash());
    if (!a || !ok) {
      this.failed(key, now);
      return fail(401, 'invalid_credentials');
    }
    if (a.locked) return fail(403, 'account_locked');
    this.fails.delete(key);
    return a;
  }

  /** Logs in: a new session (rotation: the session the browser presented, if any, is ended). */
  async login(name: unknown, password: unknown, oldToken?: string): Promise<AccountOk<SessionInfo> | AccountFail> {
    const now = Date.now();
    const key = `l|${typeof name === 'string' ? usernameKey(name.slice(0, 32)) : ''}`;
    const a = await this.check(key, name, password, now);
    if ('ok' in a) return a;
    const old = this.find(oldToken);
    if (old && old.a.id === a.id) a.sessions = a.sessions.filter((s) => s !== old.s);
    const token = this.issue(a, now);
    const err = this.persist(a);
    return err ?? { ok: true, token, profileId: a.profile, name: a.name };
  }

  /** Ends one session on the server; the token is dead at once. */
  logout(token: unknown): boolean {
    const f = this.find(token);
    if (!f) return false;
    f.a.sessions = f.a.sessions.filter((s) => s !== f.s);
    return !this.persist(f.a);
  }

  async changePassword(token: unknown, oldPassword: unknown, newPassword: unknown): Promise<AccountOk<{ token: string }> | AccountFail> {
    const f = this.find(token);
    if (!f || f.s.exp <= Date.now()) return fail(401, 'unauthorized');
    const bad = checkPassword(newPassword, f.a.name);
    if (bad) return fail(400, bad);
    const now = Date.now();
    const a = await this.check(`l|${f.a.key}`, f.a.name, oldPassword, now);
    if ('ok' in a) return a;
    a.pass = await hashPassword(newPassword as string);
    a.passChanged = Date.now();
    a.sessions = [];
    const next = this.issue(a, now);
    return this.persist(a) ?? { ok: true, token: next };
  }

  /** Resets the password with the recovery code; the code is spent and a new one comes back. All sessions end. */
  async recover(name: unknown, code: unknown, newPassword: unknown): Promise<AccountOk<SessionInfo & { recovery: string }> | AccountFail> {
    const now = Date.now();
    const nm = typeof name === 'string' ? name.slice(0, 32) : '';
    const key = `r|${usernameKey(nm)}`;
    const left = this.lockLeft(key, now);
    if (left > 0) return fail(429, 'locked', left);
    const a = this.store.byName(usernameKey(nm));
    const given = hashRecovery(typeof code === 'string' ? code : '');
    const want = a ? a.recovery : sha256('bunkcraft-recovery|none');
    if (!a || !safeEqual(given, want) || normalizeRecoveryCode(code).length !== 25) {
      this.failed(key, now);
      return fail(401, 'invalid_credentials');
    }
    if (a.locked) return fail(403, 'account_locked');
    const bad = checkPassword(newPassword, a.name);
    if (bad) return fail(400, bad);
    a.pass = await hashPassword(newPassword as string);
    a.passChanged = Date.now();
    const fresh = newRecoveryCode();
    a.recovery = hashRecovery(fresh);
    a.sessions = [];
    this.fails.delete(key);
    this.fails.delete(`l|${a.key}`);
    const token = this.issue(a, now);
    return this.persist(a) ?? { ok: true, token, profileId: a.profile, name: a.name, recovery: fresh };
  }

  /** A fresh recovery code (the old one stops working); needs the password. */
  async newRecovery(token: unknown, password: unknown): Promise<AccountOk<{ recovery: string }> | AccountFail> {
    const f = this.find(token);
    if (!f || f.s.exp <= Date.now()) return fail(401, 'unauthorized');
    const a = await this.check(`l|${f.a.key}`, f.a.name, password, Date.now());
    if ('ok' in a) return a;
    const fresh = newRecoveryCode();
    a.recovery = hashRecovery(fresh);
    return this.persist(a) ?? { ok: true, recovery: fresh };
  }

  /** Deletes the account and its profile (level, XP, skin assignment) after a password check. */
  async remove(token: unknown, password: unknown): Promise<AccountOk<object> | AccountFail> {
    const f = this.find(token);
    if (!f || f.s.exp <= Date.now()) return fail(401, 'unauthorized');
    const a = await this.check(`l|${f.a.key}`, f.a.name, password, Date.now());
    if ('ok' in a) return a;
    this.store.delete(a.id);
    this.opts.profiles.remove(a.profile);
    log.info('account deleted', { accounts: this.store.count });
    return { ok: true };
  }

  // ----- admin (ADMIN_TOKEN-protected HTTP layer; no password needed) -----

  /** Accounts for the admin list (never hashes): newest first, optionally filtered by a name fragment. */
  adminList(query = '', limit = 200): { name: string; created: number; passChanged: number; sessions: number; locked: boolean; admin: boolean; level: number }[] {
    const q = query.trim().toLowerCase();
    return this.store.all()
      .filter((a) => !q || a.key.includes(q))
      .sort((x, y) => y.created - x.created).slice(0, limit)
      .map((a) => ({
        name: a.name, created: a.created, passChanged: a.passChanged,
        sessions: a.sessions.filter((s) => s.exp > Date.now()).length, locked: !!a.locked, admin: this.isAdmin(a),
        level: this.opts.profiles.level?.(a.profile) ?? 0,
      }));
  }

  private byAdminName(name: unknown): AccountRec | undefined {
    return typeof name === 'string' ? this.store.byName(usernameKey(name.slice(0, 32))) : undefined;
  }

  /** Locks (no login, sessions dead, name stays reserved) or unlocks an account. */
  adminLock(name: unknown, locked: boolean): AccountOk<object> | AccountFail {
    const a = this.byAdminName(name);
    if (!a) return fail(404, 'not_found');
    a.locked = locked || undefined;
    if (locked) a.sessions = [];
    log.info('account moderated', { action: locked ? 'lock' : 'unlock' });
    return this.persist(a) ?? { ok: true };
  }

  /** Grants or withdraws the persistent admin flag (an ADMIN_ACCOUNTS name stays admin while the setting lists it). */
  adminSetAdmin(name: unknown, admin: boolean): AccountOk<{ name: string; admin: boolean }> | AccountFail {
    const a = this.byAdminName(name);
    if (!a) return fail(404, 'not_found');
    a.admin = admin || undefined;
    log.info('account moderated', { action: admin ? 'admin on' : 'admin off' });
    return this.persist(a) ?? { ok: true, name: a.name, admin: this.isAdmin(a) };
  }

  /** Ends every session of an account. */
  adminLogout(name: unknown): AccountOk<{ ended: number }> | AccountFail {
    const a = this.byAdminName(name);
    if (!a) return fail(404, 'not_found');
    const ended = a.sessions.length;
    a.sessions = [];
    log.info('account moderated', { action: 'logout', ended });
    return this.persist(a) ?? { ok: true, ended };
  }

  /** Deletes an account and its profile. */
  adminDelete(name: unknown): AccountOk<object> | AccountFail {
    const a = this.byAdminName(name);
    if (!a) return fail(404, 'not_found');
    this.store.delete(a.id);
    this.opts.profiles.remove(a.profile);
    log.info('account moderated', { action: 'delete', accounts: this.store.count });
    return { ok: true };
  }

  /**
   * Recovery for an owner who lost password and code: a new recovery code (shown once to the admin, who hands it
   * over after the owner proved ownership out-of-band). The old code stops working and every session ends; the
   * owner then resets the password with it on the normal recovery screen. The failure counter is cleared.
   */
  adminRecoveryCode(name: unknown): AccountOk<{ name: string; recovery: string }> | AccountFail {
    const a = this.byAdminName(name);
    if (!a) return fail(404, 'not_found');
    const fresh = newRecoveryCode();
    a.recovery = hashRecovery(fresh);
    a.sessions = [];
    this.fails.delete(`r|${a.key}`);
    this.fails.delete(`l|${a.key}`);
    log.info('account moderated', { action: 'recovery' });
    return this.persist(a) ?? { ok: true, name: a.name, recovery: fresh };
  }

  close(): void {
    clearInterval(this.timer);
    this.store.flush();
  }
}
