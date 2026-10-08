import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { isIP } from 'node:net';
import { normalizeCode, sanitizeChat } from '../src/net/protocol';
import { isSkinHash } from '../src/skins/SkinFormat';
import type { GameServer } from './GameServer';
import { log } from './Log';
import { type Gauges, metrics } from './Metrics';
import type { Rooms } from './Rooms';
import type { SkinService } from './skins/SkinService';
import { RateLimiter, bearer, safeEqual } from './Security';

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
  version: string;
  gauges(): Gauges;
  clientIp(req: IncomingMessage): string;
  readBody(req: IncomingMessage): Promise<string>;
  json(res: ServerResponse, status: number, body: unknown): void;
  /** Close the open connections of a just-blocked address. */
  dropIp?(ip: string): void;
}

/** 20 wrong tokens per address per 10 minutes, then 429: the token cannot be brute-forced over HTTP. */
export const newAuthLimiter = (): RateLimiter => new RateLimiter(20, 600_000);

/** True when the request carries the admin token (constant-time compare). Writes the error response otherwise. */
export function authorizeAdmin(
  ctx: Pick<AdminContext, 'token' | 'clientIp' | 'json'> & { failures: RateLimiter }, req: IncomingMessage, res: ServerResponse,
): boolean {
  const authFailures = ctx.failures;
  const ip = ctx.clientIp(req);
  if (!authFailures.allowed(ip)) {
    metrics.rateLimited('admin_auth');
    ctx.json(res, 429, { error: 'Too many attempts' });
    return false;
  }
  const given = bearer(req.headers.authorization);
  if (!given || !safeEqual(given, ctx.token)) {
    authFailures.record(ip);
    log.warn('admin auth failed', { ip });
    ctx.json(res, 401, { error: 'Unauthorized' });
    return false;
  }
  return true;
}

/** /api/admin/*: overview, games, kick, close, address blocks, announce, save. The caller has checked the token. */
export async function adminApi(ctx: AdminContext, req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const { json } = ctx;
  const parts = path.replace(/^\/api\/admin\/?/, '').split('/').filter(Boolean);
  const method = req.method ?? 'GET';
  const body = async (): Promise<Record<string, unknown>> => {
    try {
      const parsed = JSON.parse((await ctx.readBody(req)) || '{}') as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };

  if (parts[0] === 'stats' && method === 'GET') {
    return json(res, 200, { ...metrics.snapshot(ctx.gauges()), version: ctx.version });
  }
  if (parts[0] === 'rooms' && parts.length === 1 && method === 'GET') {
    return json(res, 200, {
      main: ctx.main ? { name: ctx.main.name, players: ctx.main.playerCount } : null,
      rooms: ctx.rooms?.adminList() ?? [],
    });
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
