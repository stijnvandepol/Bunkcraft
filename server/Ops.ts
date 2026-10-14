import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { sanitizeChat } from '../src/net/protocol';
import { LOBBY_SIZE_RANGE } from '../src/modes/Realms';
import type { AccountService } from './accounts/AccountService';
import { log } from './Log';
import { metrics } from './Metrics';
import { RateLimiter, bearer, safeEqual } from './Security';

/**
 * The ops dashboard (/ops) on the server side: who may use it, the settings it changes at run time and the audit
 * log of what admins did. The HTTP routes live in Admin.ts (one API under /api/admin/* for the CLI and under
 * /api/ops/* for the browser: Cloudflare's WAF blocks paths with "admin" in them).
 */

// ---------------------------------------------------------------------------------------------- authorization

export interface OpsAuthContext {
  /** ADMIN_TOKEN (undefined = no token login). */
  token?: string;
  /** Player accounts: a session of an admin account counts like the token (null = accounts off). */
  accounts: AccountService | null;
  failures: RateLimiter;
  clientIp(req: IncomingMessage): string;
  json(res: ServerResponse, status: number, body: unknown): void;
  /** The same-site check of the account API (App.sameSitePost): Origin and Sec-Fetch-Site. */
  sameSite(req: IncomingMessage): boolean;
}

export interface OpsIdentity {
  /** Account name, or "admin token". */
  who: string;
  via: 'token' | 'account';
}

/**
 * Who is asking, or null after writing the error response. The ADMIN_TOKEN (constant-time compare) or the session of
 * an admin account (ADMIN_ACCOUNTS or the account's admin flag): a session that is unknown, expired, logged out or of
 * a locked account is 401, a valid session of an account that is no admin 403. Failures count against the address in
 * the same limiter as wrong admin tokens (20 per 10 minutes, then 429). Changes (anything but GET) must come from this
 * site; a browser session must also send JSON.
 */
export function authorizeOps(ctx: OpsAuthContext, req: IncomingMessage, res: ServerResponse): OpsIdentity | null {
  const ip = ctx.clientIp(req);
  if (!ctx.failures.allowed(ip)) {
    metrics.rateLimited('admin_auth');
    ctx.json(res, 429, { error: 'Too many attempts' });
    return null;
  }
  const given = bearer(req.headers.authorization);
  let id: OpsIdentity | null = null;
  if (given && ctx.token && safeEqual(given, ctx.token)) {
    id = { who: 'admin token', via: 'token' };
  } else if (given?.startsWith('s1.') && ctx.accounts) {
    const a = ctx.accounts.adminOf(given);
    if (a === false) {
      ctx.failures.record(ip);
      log.warn('ops: account is no admin', { ip });
      ctx.json(res, 403, { error: 'Forbidden' });
      return null;
    }
    if (a) id = { who: a.name, via: 'account' };
  }
  if (!id) {
    ctx.failures.record(ip);
    log.warn('admin auth failed', { ip });
    ctx.json(res, 401, { error: 'Unauthorized' });
    return null;
  }
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    if (!ctx.sameSite(req)) {
      log.warn('ops: cross-site change refused', { ip, who: id.who });
      ctx.json(res, 403, { error: 'origin' });
      return null;
    }
    if (id.via === 'account' && method === 'POST' && !String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      ctx.json(res, 415, { error: 'JSON only' });
      return null;
    }
  }
  return id;
}

// ---------------------------------------------------------------------------------------------- audit log

export interface AuditEntry { at: number; who: string; action: string; detail: string; status: number; ip: string }

/** What admins changed: every entry goes to the log and the last `size` stay in memory for the dashboard. */
export class AuditLog {
  private readonly entries: AuditEntry[] = [];

  constructor(private readonly size = 200) {}

  record(e: AuditEntry): void {
    this.entries.push(e);
    if (this.entries.length > this.size) this.entries.shift();
    log.info('admin action', { who: e.who, action: e.action, detail: e.detail || undefined, status: e.status, ip: e.ip });
  }

  /** Newest first. */
  list(): AuditEntry[] {
    return [...this.entries].reverse();
  }
}

/** The fields of a request body worth an audit line (never passwords, tokens or codes: the admin API takes none). */
export function auditDetail(body: Record<string, unknown>): string {
  const out: string[] = [];
  for (const k of ['name', 'code', 'ip', 'hash', 'remove', 'admin', 'text', 'keys']) {
    const v = body[k];
    if (v === undefined) continue;
    out.push(`${k}=${(Array.isArray(v) ? v.join(',') : String(v)).slice(0, 80)}`);
  }
  const values = body.values;
  if (values && typeof values === 'object' && !Array.isArray(values)) {
    for (const [k, v] of Object.entries(values).slice(0, 16)) out.push(`${k.slice(0, 32)}=${String(v).slice(0, 80)}`);
  }
  return out.join(' ');
}

// ---------------------------------------------------------------------------------------------- settings

export interface OpsValues {
  maxMatchContainers: number;
  matchWarmPool: number;
  matchCpus: number;
  matchMemoryMb: number;
  matchIdleGraceSec: number;
  motd: string;
  roomMaxPlayers: number;
  quickPlayBots: number;
}
export type OpsKey = keyof OpsValues;

interface SettingDef {
  key: OpsKey;
  /** The environment variable it overrides. */
  env: string;
  kind: 'int' | 'num' | 'text';
  min?: number;
  max?: number;
  /** When it takes effect: at once, or for containers/lobbies opened from now on. */
  applies: 'now' | 'new';
  /** Only meaningful with MATCH_ISOLATION=container. */
  container: boolean;
}

const DEFS: SettingDef[] = [
  { key: 'maxMatchContainers', env: 'MAX_MATCH_CONTAINERS', kind: 'int', min: 1, max: 256, applies: 'now', container: true },
  { key: 'matchWarmPool', env: 'MATCH_WARM_POOL', kind: 'int', min: 0, max: 16, applies: 'now', container: true },
  { key: 'matchCpus', env: 'MATCH_CPUS', kind: 'num', min: 0.1, max: 8, applies: 'new', container: true },
  { key: 'matchMemoryMb', env: 'MATCH_MEMORY', kind: 'int', min: 96, max: 4096, applies: 'new', container: true },
  { key: 'matchIdleGraceSec', env: 'MATCH_IDLE_GRACE_SEC', kind: 'int', min: 5, max: 3600, applies: 'now', container: true },
  { key: 'motd', env: 'MOTD', kind: 'text', max: 120, applies: 'new', container: false },
  { key: 'roomMaxPlayers', env: 'ROOM_MAX_PLAYERS', kind: 'int', min: LOBBY_SIZE_RANGE.min, max: LOBBY_SIZE_RANGE.max, applies: 'new', container: false },
  { key: 'quickPlayBots', env: 'QUICKPLAY_BOTS', kind: 'int', min: 0, max: LOBBY_SIZE_RANGE.max, applies: 'new', container: false },
];

export interface SettingRow {
  key: OpsKey; env: string; value: number | string; envValue: number | string; overridden: boolean;
  kind: SettingDef['kind']; min?: number; max?: number; applies: SettingDef['applies']; container: boolean;
}

export type SetResult = { ok: true; changed: OpsKey[] } | { ok: false; key: string; error: string };

/**
 * Settings an admin changes at run time, over the environment: DATA_DIR/ops-settings.json holds only the values that
 * differ from it (reset = the env value again). Every value is checked against its range; `limits` narrows a range at
 * start-up (the Docker gate only allows CPU and memory up to MATCH_CPUS and MATCH_MEMORY, so those can only go down).
 * `onChange` applies them (App wires it to the pool, the control plane and Rooms).
 */
export class OpsSettings {
  private readonly file: string;
  private overrides: Partial<OpsValues> = {};
  onChange: ((v: OpsValues, changed: OpsKey[]) => void) | null = null;

  constructor(dataDir: string, private readonly defaults: OpsValues, private readonly limits: Partial<Record<OpsKey, { min?: number; max?: number }>> = {}) {
    this.file = join(dataDir, 'ops-settings.json');
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { values?: Record<string, unknown> };
        for (const [k, v] of Object.entries(raw.values ?? {})) {
          const def = DEFS.find((d) => d.key === k);
          const ok = def ? this.check(def, v) : null;
          // A saved value outside today's range (the env changed) is dropped: the env value applies.
          if (def && ok && 'value' in ok) (this.overrides as Record<string, unknown>)[k] = ok.value;
          else log.warn('ops-settings.json: value ignored', { key: k });
        }
      }
    } catch (e) {
      log.error('ops-settings.json unreadable', { error: String(e) });
    }
  }

  private range(def: SettingDef): { min?: number; max?: number } {
    const l = this.limits[def.key] ?? {};
    return { min: l.min ?? def.min, max: l.max ?? def.max };
  }

  private check(def: SettingDef, v: unknown): { value: number | string } | { error: string } {
    const { min, max } = this.range(def);
    if (def.kind === 'text') {
      if (typeof v !== 'string') return { error: 'must be text' };
      const text = sanitizeChat(v).slice(0, max ?? 120);
      return text ? { value: text } : { error: 'must not be empty' };
    }
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    if (!Number.isFinite(n)) return { error: 'must be a number' };
    if (def.kind === 'int' && !Number.isInteger(n)) return { error: 'must be a whole number' };
    if ((min !== undefined && n < min) || (max !== undefined && n > max)) return { error: `must be between ${min} and ${max}` };
    return { value: def.kind === 'num' ? Math.round(n * 100) / 100 : n };
  }

  get values(): OpsValues {
    return { ...this.defaults, ...this.overrides };
  }

  rows(): SettingRow[] {
    const v = this.values;
    return DEFS.map((d) => ({
      key: d.key, env: d.env, value: v[d.key], envValue: this.defaults[d.key], overridden: d.key in this.overrides,
      kind: d.kind, ...this.range(d), applies: d.applies, container: d.container,
    }));
  }

  /** Validates every value first; nothing changes unless all of them are good. */
  set(patch: Record<string, unknown>): SetResult {
    const next: Partial<OpsValues> = { ...this.overrides };
    const changed: OpsKey[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const def = DEFS.find((d) => d.key === k);
      if (!def) return { ok: false, key: k.slice(0, 32), error: 'unknown setting' };
      const r = this.check(def, v);
      if ('error' in r) return { ok: false, key: k, error: r.error };
      if (r.value === this.defaults[def.key]) delete next[def.key];
      else (next as Record<string, unknown>)[def.key] = r.value;
      changed.push(def.key);
    }
    const merged = { ...this.defaults, ...next };
    if (merged.matchWarmPool > merged.maxMatchContainers) return { ok: false, key: 'matchWarmPool', error: 'must not exceed the container maximum' };
    return this.commit(next, changed);
  }

  /** Back to the environment value. */
  reset(keys: unknown): SetResult {
    if (!Array.isArray(keys)) return { ok: false, key: '', error: 'keys must be a list' };
    const next: Partial<OpsValues> = { ...this.overrides };
    const changed: OpsKey[] = [];
    for (const k of keys) {
      const def = DEFS.find((d) => d.key === k);
      if (!def) return { ok: false, key: String(k).slice(0, 32), error: 'unknown setting' };
      delete next[def.key];
      changed.push(def.key);
    }
    const merged = { ...this.defaults, ...next };
    if (merged.matchWarmPool > merged.maxMatchContainers) return { ok: false, key: 'matchWarmPool', error: 'must not exceed the container maximum' };
    return this.commit(next, changed);
  }

  private commit(next: Partial<OpsValues>, changed: OpsKey[]): SetResult {
    const before = this.overrides;
    this.overrides = next;
    try {
      writeFileSync(`${this.file}.tmp`, JSON.stringify({ v: 1, values: next }, null, 2));
      renameSync(`${this.file}.tmp`, this.file);
    } catch (e) {
      this.overrides = before;
      log.error('ops-settings.json not saved', { error: String(e) });
      return { ok: false, key: '', error: 'could not save' };
    }
    if (changed.length) this.onChange?.(this.values, changed);
    return { ok: true, changed };
  }
}
