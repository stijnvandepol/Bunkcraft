import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomInt } from 'node:crypto';
import { type GameType, gameTypeDef, parseGameType } from '../src/modes/GameTypes';
import { DEFAULT_MAP, type MapSetting, parseMapSetting } from '../src/modes/maps';
import { CODE_ALPHABET, CODE_LENGTH, normalizeCode } from '../src/net/protocol';
import { GAME_MODES, type GameMode } from '../src/player/GameMode';
import { GameServer, parseGameMode } from './GameServer';

export interface RoomOptions {
  /** Directory holding one sub-directory per room. */
  dataDir: string;
  maxRooms: number;
  maxPlayers: number;
  motd: string;
  /** Unload a room from memory after this long without players (it stays on disk). */
  idleUnloadMs: number;
  /** Delete rooms nobody joined for this many days (0 = keep forever). */
  expireDays: number;
}

export interface RoomInfo {
  code: string;
  name: string;
  gameMode: GameMode;
  players: number;
  maxPlayers: number;
  gameType: GameType;
  scoreLimit: number;
  timeLimitSec: number;
  /** Arcade games: the map setting (a map id or "rotate"). */
  map?: MapSetting;
}

/** Match settings a client may ask for; the server clamps them. */
export interface MatchRequest {
  gameType?: unknown;
  scoreLimit?: unknown;
  timeLimitSec?: unknown;
  /** A map id or "rotate"; anything else becomes the default map. */
  mapId?: unknown;
}

export const SCORE_LIMIT_RANGE = { min: 5, max: 100 };
export const TIME_LIMIT_RANGE = { min: 120, max: 1800 };

function clampSetting(v: unknown, range: { min: number; max: number }, dflt: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : dflt;
  return Math.min(range.max, Math.max(range.min, n));
}

/** Sliding-window limiter keyed by client address. */
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

  prune(): void {
    const now = Date.now();
    for (const [k, v] of this.hits) if (v.every((t) => now - t >= this.windowMs)) this.hits.delete(k);
  }
}

/**
 * Hosts any number of independent game rooms on one server. A room is a normal
 * GameServer (own world, players, time) stored in `<dataDir>/<CODE>/world.json`; players
 * reach it through its six-character code. Rooms are loaded on demand and unloaded when
 * empty, so hundreds can exist on disk while only the busy ones use memory.
 */
export class Rooms {
  private readonly loaded = new Map<string, { server: GameServer; lastActive: number }>();
  private readonly timer: NodeJS.Timeout;
  private onDisk = 0;

  constructor(private readonly opts: RoomOptions) {
    mkdirSync(opts.dataDir, { recursive: true });
    this.expire();
    this.timer = setInterval(() => this.maintain(), 60_000);
    this.timer.unref();
  }

  get count(): number {
    return this.onDisk;
  }

  get playerCount(): number {
    let n = 0;
    for (const r of this.loaded.values()) n += r.server.playerCount;
    return n;
  }

  /** Creates a new room and returns its code, or null when the server is full of rooms. */
  create(name: string, gameMode: string | undefined, seed: string | undefined, match: MatchRequest = {}): string | null {
    if (this.onDisk >= this.opts.maxRooms) return null;
    let code = '';
    do {
      code = Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
    } while (existsSync(join(this.opts.dataDir, code)));
    const cleanName = name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 32) || 'BunkCraft Game';
    const mode = GAME_MODES.includes(gameMode as GameMode) ? parseGameMode(gameMode) : 'survival';
    const cleanSeed = seed?.trim().slice(0, 32) || undefined;
    // Arcade game types ignore the Minecraft game mode and bring their own match settings.
    const type = gameTypeDef(parseGameType(match.gameType));
    const server = new GameServer({
      dataDir: join(this.opts.dataDir, code), worldName: cleanName, seed: cleanSeed, gameMode: mode,
      motd: this.opts.motd, maxPlayers: this.opts.maxPlayers, quiet: true,
      ...(type.arcade ? {
        gameType: type.id,
        scoreLimit: clampSetting(match.scoreLimit, SCORE_LIMIT_RANGE, type.scoreLimit),
        timeLimitSec: clampSetting(match.timeLimitSec, TIME_LIMIT_RANGE, type.timeLimitSec),
        mapId: parseMapSetting(match.mapId) ?? DEFAULT_MAP,
      } : {}),
    });
    this.loaded.set(code, { server, lastActive: Date.now() });
    this.onDisk++;
    console.log(`[room] created ${code} "${cleanName}" (${type.arcade ? type.id : mode}); ${this.onDisk} rooms`);
    return code;
  }

  /** The running room for a code, loading it from disk when needed; null if it doesn't exist. */
  get(raw: string): { code: string; server: GameServer } | null {
    const code = normalizeCode(raw);
    if (!code) return null;
    const live = this.loaded.get(code);
    if (live) {
      live.lastActive = Date.now();
      return { code, server: live.server };
    }
    const dir = join(this.opts.dataDir, code);
    if (!existsSync(join(dir, 'world.json'))) return null;
    const server = new GameServer({
      dataDir: dir, worldName: 'BunkCraft Game', gameMode: 'survival',
      motd: this.opts.motd, maxPlayers: this.opts.maxPlayers, quiet: true,
    });
    this.loaded.set(code, { server, lastActive: Date.now() });
    return { code, server };
  }

  info(raw: string): RoomInfo | null {
    const room = this.get(raw);
    return room ? { code: room.code, ...room.server.info() } : null;
  }

  shutdown(): void {
    clearInterval(this.timer);
    for (const r of this.loaded.values()) r.server.shutdown();
    this.loaded.clear();
  }

  private maintain(): void {
    const now = Date.now();
    for (const [code, r] of this.loaded) {
      if (r.server.playerCount > 0) {
        r.lastActive = now;
      } else if (now - r.lastActive > this.opts.idleUnloadMs) {
        r.server.shutdown(); // saves to disk
        this.loaded.delete(code);
        console.log(`[room] unloaded ${code} (idle)`);
      }
    }
    if (new Date().getHours() === 4 && now % 3_600_000 < 60_000) this.expire();
  }

  /** Counts the rooms on disk and removes the ones nobody has used for a long time. */
  private expire(): void {
    let n = 0;
    const cutoff = this.opts.expireDays > 0 ? Date.now() - this.opts.expireDays * 86_400_000 : 0;
    for (const entry of readdirSync(this.opts.dataDir)) {
      if (!/^[A-Z0-9]{6}$/.test(entry)) continue;
      const file = join(this.opts.dataDir, entry, 'world.json');
      if (!existsSync(file)) continue;
      if (cutoff && !this.loaded.has(entry) && statSync(file).mtimeMs < cutoff) {
        rmSync(join(this.opts.dataDir, entry), { recursive: true, force: true });
        console.log(`[room] expired ${entry}`);
        continue;
      }
      n++;
    }
    this.onDisk = n;
  }
}
