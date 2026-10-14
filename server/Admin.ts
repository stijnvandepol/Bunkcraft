import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { isIP } from 'node:net';
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import { normalizeCode, sanitizeChat } from '../src/net/protocol';
import { isSkinHash } from '../src/skins/SkinFormat';
import type { AccountService } from './accounts/AccountService';
import type { GameServer } from './GameServer';
import { log } from './Log';
import { type Gauges, metrics } from './Metrics';
import type { ControlPlane } from './match/ControlPlane';
import type { Rooms } from './Rooms';
import type { RoomServer } from './RoomServer';
import { type AuditLog, type OpsIdentity, type OpsSettings, auditDetail } from './Ops';
import { MAX_LOG_TAIL } from './match/Drivers';
import type { SkinService } from './skins/SkinService';
import { RateLimiter } from './Security';

/** Blocked client addresses (server-wide), persisted in DATA_DIR/ip-bans.json. */
export class IpBans {
  private readonly ips = new Set<string>();
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, 'ip-bans.json');
    try {
      if (existsSync(this.file)) for (const ip of JSON.parse(readFileSync(this.file, 'utf8')) as string[]) this.ips.add(ip);
    } catch (e) {
      log.error('ip-bans.json unreadable', { error: String(e) });
    }
  }

  has(ip: string): boolean {
    return this.ips.has(ip);
  }

  list(): string[] {
    return [...this.ips].sort();
  }

  add(ip: string): void {
    this.ips.add(ip);
    this.save();
  }

  remove(ip: string): boolean {
    const had = this.ips.delete(ip);
    if (had) this.save();
    return had;
  }

  private save(): void {
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.list()));
    renameSync(`${this.file}.tmp`, this.file);
  }
}

export interface AdminContext {
  token: string;
  rooms: Rooms | null;
  main: GameServer | null;
  bans: IpBans;
  /** Custom skins (null = switched off). */
  skins?: SkinService | null;
  /** Player accounts (null = switched off). */
  accounts?: AccountService | null;
  version: string;
  gauges(): Gauges;
  clientIp(req: IncomingMessage): string;
  readBody(req: IncomingMessage): Promise<string>;
  json(res: ServerResponse, status: number, body: unknown): void;
  /** Close the open connections of a just-blocked address. */
  dropIp?(ip: string): void;
  /** MATCH_ISOLATION=container: the match runners (null in-process). */
  control?: ControlPlane | null;
  /** Who is asking (authorizeOps); the audit log names them. */
  who?: OpsIdentity;
  audit?: AuditLog;
  /** Run-time settings of the ops dashboard (absent: GET/POST settings answer 404). */
  settings?: OpsSettings | null;
}

/** What the ops dashboard shows of one loaded game, wherever it runs. */
function gameView(code: string, server: RoomServer, remote: boolean): Record<string, unknown> {
  const i = server.info();
  const lobby = server.lobbyStatus();
  return {
    code, name: i.name, gameType: i.gameType, gameMode: i.gameMode, remote, players: server.playerCount, maxPlayers: server.maxPlayers,
    bots: server.botCount, reserved: server.reservedSeats, listed: server.listed, locked: server.locked,
    map: lobby?.map ?? (typeof i.map === 'string' ? i.map : null), phase: lobby?.phase ?? null, timeLeft: lobby ? Math.round(lobby.timeLeft) : null,
  };
}

/** 20 wrong tokens per address per 10 minutes, then 429: the token cannot be brute-forced over HTTP. */
export const newAuthLimiter = (): RateLimiter => new RateLimiter(20, 600_000);

/**
 * /api/admin/* (CLI, ADMIN_TOKEN) and /api/ops/* (the ops dashboard): overview, containers, games, kick, close,
 * address blocks, announce, save, accounts, skins, settings, audit. The caller has authorized the request
 * (authorizeOps); every change is written to the audit log with who did it and how it ended.
 */
export async function adminApi(ctx: AdminContext, req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const parts = path.replace(/^\/api\/(admin|ops)\/?/, '').split('/').filter(Boolean);
  const method = req.method ?? 'GET';
  // A body is read once (changes only), so the audit line can name what was changed.
  let parsed: Record<string, unknown> = {};
  if (method !== 'GET') {
    try {
      const raw = JSON.parse((await ctx.readBody(req)) || '{}') as unknown;
      parsed = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    } catch {
      parsed = {};
    }
  }
  const body = async (): Promise<Record<string, unknown>> => parsed;
  const json: AdminContext['json'] = method === 'GET' ? ctx.json : (r, status, b) => {
    ctx.audit?.record({
      at: Date.now(), who: ctx.who?.who ?? 'admin token', action: `${method} ${parts.join('/')}`.slice(0, 120), detail: auditDetail(parsed),
      status, ip: ctx.clientIp(req),
    });
    ctx.json(r, status, b);
  };

  if (parts[0] === 'whoami' && method === 'GET') {
    return json(res, 200, { who: ctx.who?.who ?? 'admin token', via: ctx.who?.via ?? 'token', version: ctx.version });
  }
  if (parts[0] === 'audit' && method === 'GET') {
    return json(res, 200, { entries: ctx.audit?.list() ?? [] });
  }
  // The dashboard's top cards: one call, everything a glance needs.
  if (parts[0] === 'overview' && method === 'GET') {
    const snap = metrics.snapshot(ctx.gauges());
    const games = ctx.rooms?.loadedGames() ?? [];
    let matches = 0;
    let inMatches = 0;
    for (const g of games) {
      if (g.server.lobbyStatus()) matches++;
      inMatches += g.server.playerCount;
    }
    const c = ctx.control;
    const avgStart = c && c.pool.counters.startMs.length ? c.pool.counters.startMs.reduce((a, b) => a + b, 0) / c.pool.counters.startMs.length : 0;
    return json(res, 200, {
      version: ctx.version, uptimeSec: snap.uptimeSeconds, isolation: c ? 'container' : 'inprocess',
      driver: c?.pool.driver.kind ?? null, driverAvailable: c?.driverAvailable ?? null,
      matches, gamesLoaded: snap.roomsLoaded, gamesTotal: snap.roomsTotal,
      containers: c ? { total: c.pool.count(), assigned: c.pool.count('assigned'), warm: c.pool.count('idle'), starting: c.pool.count('starting'), stopping: c.pool.count('stopping'), max: c.pool.max, warmTarget: c.pool.warm } : null,
      fallbacks: c?.fallbacks ?? 0,
      counters: c ? { starts: c.pool.counters.starts, startFailures: c.pool.counters.startFailures, deaths: c.pool.counters.deaths, capped: c.pool.counters.capped, avgStartMs: Math.round(avgStart) } : null,
      playersInMatches: inMatches, playersOnline: snap.players, mainWorldPlayers: ctx.main?.playerCount ?? 0, connections: snap.connections,
      cpu: snap.cpu, rssBytes: snap.rssBytes, heapBytes: snap.heapUsedBytes,
      tickP99Ms: snap.tickP99Ms, loopLagP99Ms: snap.loopLagP99Ms, bytesOutPerSec: snap.bytesOutPerSec,
      host: { cpus: cpus().length, load: loadavg().map((l) => Math.round(l * 100) / 100), memTotal: totalmem(), memFree: freemem() },
    });
  }
  // Portainer-like: every match runner (container mode) and every loaded game, wherever it runs.
  if (parts[0] === 'containers' && parts.length === 1 && method === 'GET') {
    const c = ctx.control;
    const lim = c?.pool.driver.limits?.() ?? null;
    return json(res, 200, {
      isolation: c ? 'container' : 'inprocess', driver: c?.pool.driver.kind ?? null, image: c?.pool.driver.image ?? null, available: c?.driverAvailable ?? null,
      limits: lim, runners: c?.runners() ?? [],
      games: (ctx.rooms?.loadedGames() ?? []).map((g) => gameView(g.code, g.server, g.remote)),
    });
  }
  if (parts[0] === 'containers' && parts.length === 3) {
    const c = ctx.control;
    if (!c) return json(res, 404, { error: 'No match containers (MATCH_ISOLATION=inprocess)' });
    const id = parts[1];
    if (!/^[a-z0-9]{8,24}$/.test(id)) return json(res, 400, { error: 'Bad runner id' });
    if (parts[2] === 'stop' && method === 'POST') {
      const r = c.stopRunner(id);
      return json(res, r ? 200 : 404, r ? { ok: true, result: r } : { error: 'Runner not found' });
    }
    if (parts[2] === 'logs' && method === 'GET') {
      const q = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('tail') ?? 200);
      const tail = Math.max(1, Math.min(MAX_LOG_TAIL, Number.isFinite(q) ? Math.floor(q) : 200));
      try {
        const lines = await c.runnerLogs(id, tail);
        return lines ? json(res, 200, { lines }) : json(res, 404, { error: 'Runner not found' });
      } catch (e) {
        return json(res, 502, { error: `Logs unavailable: ${e instanceof Error ? e.message.slice(0, 120) : 'error'}` });
      }
    }
  }
  if (parts[0] === 'settings' && ctx.settings) {
    const s = ctx.settings;
    if (parts.length === 1 && method === 'GET') {
      return json(res, 200, { isolation: ctx.control ? 'container' : 'inprocess', settings: s.rows() });
    }
    if (parts.length === 1 && method === 'POST') {
      const values = parsed.values;
      if (!values || typeof values !== 'object' || Array.isArray(values)) return json(res, 400, { error: 'values must be an object' });
      const r = s.set(values as Record<string, unknown>);
      return r.ok ? json(res, 200, { ok: true, changed: r.changed, settings: s.rows() }) : json(res, 400, { error: `${r.key}: ${r.error}`, key: r.key });
    }
    if (parts[1] === 'reset' && parts.length === 2 && method === 'POST') {
      const r = s.reset(parsed.keys);
      return r.ok ? json(res, 200, { ok: true, changed: r.changed, settings: s.rows() }) : json(res, 400, { error: `${r.key}: ${r.error}`, key: r.key });
    }
  }

  if (parts[0] === 'stats' && method === 'GET') {
    return json(res, 200, { ...metrics.snapshot(ctx.gauges()), version: ctx.version });
  }
  if (parts[0] === 'rooms' && parts.length === 1 && method === 'GET') {
    return json(res, 200, {
      main: ctx.main ? { name: ctx.main.name, players: ctx.main.playerCount } : null,
      rooms: ctx.rooms?.adminList() ?? [],
    });
  }
  // Match containers: state, lobby, CPU, memory and tick p99 per runner (from heartbeats and Docker stats).
  if (parts[0] === 'matches' && parts.length === 1 && method === 'GET') {
    const c = ctx.control;
    if (!c) return json(res, 200, { isolation: 'inprocess', runners: [] });
    return json(res, 200, { isolation: 'container', driver: c.pool.driver.kind, image: c.pool.driver.image, fallbacks: c.fallbacks, counters: c.pool.counters, runners: c.runners() });
  }
  if (parts[0] === 'main' && ctx.main) {
    if (parts[1] === 'players' && method === 'GET') return json(res, 200, { players: ctx.main.playerList() });
    if (parts[1] === 'kick' && method === 'POST') {
      const name = String((await body()).name ?? '');
      const ok = ctx.main.kickPlayer(name, 'Kicked by the server administrator');
      log.warn('admin kick', { room: 'main', name, ok });
      return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'Player not online' });
    }
  }
  if (parts[0] === 'rooms' && parts.length >= 2 && ctx.rooms) {
    const code = normalizeCode(parts[1]);
    if (!code) return json(res, 400, { error: 'Bad code' });
    if (parts[2] === 'players' && method === 'GET') return json(res, 200, { players: ctx.rooms.players(code) });
    if (parts[2] === 'kick' && method === 'POST') {
      const name = String((await body()).name ?? '');
      const ok = ctx.rooms.kickPlayer(code, name, 'Kicked by the server administrator');
      log.warn('admin kick', { room: code, name, ok });
      return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'Player not online' });
    }
    if (parts[2] === 'close' && method === 'POST') {
      const remove = (await body()).remove === true;
      const ok = ctx.rooms.close(code, remove);
      return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'Game not found' });
    }
  }
  // Deploys (scripts/autoupdate.sh): warn every player in every game, and write every world to disk first.
  if (parts[0] === 'announce' && parts.length === 1 && method === 'POST') {
    const text = sanitizeChat(String((await body()).text ?? '')).slice(0, 200);
    if (!text) return json(res, 400, { error: 'Empty message' });
    ctx.main?.announce(text);
    const reached = (ctx.main?.playerCount ?? 0) + (ctx.rooms?.announce(text) ?? 0);
    log.warn('admin announce', { text, reached });
    return json(res, 200, { ok: true, reached });
  }
  if (parts[0] === 'save' && parts.length === 1 && method === 'POST') {
    ctx.main?.save();
    ctx.rooms?.saveAll();
    log.info('admin save');
    return json(res, 200, { ok: true });
  }
  // Skins: what players reported, and the hashes that are never served. Moderation is the operator's job (docs/SERVER.md).
  if (parts[0] === 'skins') {
    const skins = ctx.skins;
    if (!skins) return json(res, 404, { error: 'Skins are disabled' });
    if (parts.length === 1 && method === 'GET') {
      return json(res, 200, { reports: skins.listReports(), bans: skins.listBans(), count: skins.count, bytes: skins.storedBytes, maxBytes: skins.maxBytes });
    }
    if (parts.length === 2 && method === 'POST') {
      const hash = String((await body()).hash ?? '').toLowerCase();
      if (!isSkinHash(hash)) return json(res, 400, { error: 'Not a skin hash' });
      if (parts[1] === 'ban') {
        skins.ban(hash);
        return json(res, 200, { ok: true });
      }
      if (parts[1] === 'unban') return json(res, skins.unban(hash) ? 200 : 404, { ok: true });
      if (parts[1] === 'dismiss') return json(res, skins.dismiss(hash) ? 200 : 404, { ok: true });
      if (parts[1] === 'purge') return json(res, skins.purge(hash) ? 200 : 404, { ok: true });
    }
  }
  // Account moderation: list/search, lock, unlock, force logout, delete, a fresh recovery code (shown once). Names, never ids.
  if (parts[0] === 'accounts') {
    const accounts = ctx.accounts;
    if (!accounts) return json(res, 404, { error: 'Accounts are disabled' });
    if (parts.length === 1 && method === 'GET') {
      const q = new URL(req.url ?? '/', 'http://x').searchParams.get('q') ?? '';
      return json(res, 200, { count: accounts.count, accounts: accounts.adminList(q.slice(0, 32)) });
    }
    if (parts[1] === 'admin' && parts.length === 2 && method === 'POST') {
      const b = await body();
      if (typeof b.admin !== 'boolean') return json(res, 400, { error: 'admin must be true or false' });
      const r = accounts.adminSetAdmin(b.name, b.admin);
      if (!r.ok) return json(res, r.status, { error: r.error });
      return json(res, 200, { ok: true, name: r.name, admin: r.admin });
    }
    if (parts.length === 2 && method === 'POST') {
      const name = (await body()).name;
      const act = parts[1];
      const r = act === 'lock' ? accounts.adminLock(name, true)
        : act === 'unlock' ? accounts.adminLock(name, false)
          : act === 'logout' ? accounts.adminLogout(name)
            : act === 'delete' ? accounts.adminDelete(name)
              : act === 'recovery' ? accounts.adminRecoveryCode(name) : null;
      if (!r) return json(res, 404, { error: 'Not found' });
      log.warn('admin account', { action: act, ok: r.ok });
      if (!r.ok) return json(res, r.status, { error: r.error });
      const { ok: _ok, ...rest } = r;
      return json(res, 200, { ok: true, ...rest });
    }
  }
  if (parts[0] === 'ip-bans') {
    if (method === 'GET' && parts.length === 1) return json(res, 200, { ips: ctx.bans.list() });
    if (method === 'POST' && parts.length === 1) {
      const ip = String((await body()).ip ?? '').trim();
      if (!isIP(ip)) return json(res, 400, { error: 'Not an IP address' });
      ctx.bans.add(ip);
      ctx.dropIp?.(ip);
      log.warn('admin ip ban', { ip });
      return json(res, 200, { ok: true });
    }
    if (method === 'DELETE' && parts.length === 2) {
      const ip = decodeURIComponent(parts[1]);
      return json(res, ctx.bans.remove(ip) ? 200 : 404, { ok: true });
    }
  }
  return json(res, 404, { error: 'Not found' });
}
