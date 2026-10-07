import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomInt } from 'node:crypto';
import { type GameType, gameTypeDef, parseGameType } from '../src/modes/GameTypes';
import { DEFAULT_MAP, MAP_IDS, type MapSetting, getMap, mapFor, parseMapId, parseMapSetting } from '../src/modes/maps';
import { CODE_ALPHABET, CODE_LENGTH, type MatchPhase, normalizeCode } from '../src/net/protocol';
import {
  LOBBY_SIZE_RANGE, type LobbyCandidate, type ListingKind, type ModeStats, REALMS_MODES, filterRooms, pickLobby, quickPlayName,
} from '../src/modes/Realms';
import { GAME_MODES, type GameMode } from '../src/player/GameMode';
import { GameServer, parseGameMode } from './GameServer';
import { log } from './Log';
import { RateLimiter } from './Security';
import type { ChunkGenPool } from './chunkgen/ChunkGenPool';
import type { ProfileService } from './progression/ProfileService';

export { RateLimiter };

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
  /** Passed on to every game (see ServerOptions). */
  adminToken?: string;
  failLimiter?: RateLimiter;
  /** Backups live in `<backupDir>/<CODE>/`; used to recover a corrupt world. */
  backupDir?: string;
  inventoryGuard?: 'enforce' | 'warn' | 'off';
  binary?: boolean;
  /** Chunk generation threads shared by all games (see ChunkGenPool). */
  genPool?: ChunkGenPool | null;
  /** Most games the public list shows (default 50). */
  listMax?: number;
  /** Realms progression shared by every game (absent = no XP). */
  profiles?: ProfileService | null;
}

/** Hashes and flags for a new game, computed by the caller (hashing is async). */
export interface RoomSecurity {
  ownerHash?: string;
  passwordHash?: string;
  listed?: boolean;
}

/** One row of the public server list. */
export interface ListedRoom {
  code: string;
  name: string;
  gameType: GameType;
  gameMode: GameMode;
  players: number;
  maxPlayers: number;
  locked: boolean;
  map?: MapSetting;
  /** Arcade lobbies with players: the match phase, seconds left in it and the map being played now. */
  phase?: MatchPhase;
  timeLeft?: number;
  currentMap?: string;
}

/** Answer of quick play: the lobby to join, and whether it was just opened. */
export type QuickPlayResult = { code: string; created: boolean } | { error: 'full' | 'limited' };

export interface AdminRoom {
  code: string; name: string; loaded: boolean; players: number; listed: boolean; locked: boolean; gameType: GameType; gameMode: GameMode;
}

/** Small sidecar next to world.json so listings never have to load a world. */
interface RoomMeta { name: string; gameType: GameType; gameMode: GameMode; map?: MapSetting; listed: boolean; locked: boolean; maxPlayers: number }

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
  /** A password is needed to join. */
  locked: boolean;
}

/** Match settings a client may ask for; the server clamps them. */
export interface MatchRequest {
  gameType?: unknown;
  scoreLimit?: unknown;
  timeLimitSec?: unknown;
  /** A map id or "rotate"; anything else becomes the default map. */
  mapId?: unknown;
  /** Arcade lobbies: players the game takes (clamped to 2..the server's limit). */
  maxPlayers?: unknown;
  /** Rotating arcade lobbies: the map of the first match (server-side only, quick play). */
  startMap?: unknown;
}

export const SCORE_LIMIT_RANGE = { min: 5, max: 100 };
export const TIME_LIMIT_RANGE = { min: 120, max: 1800 };

/** A map the game type can be played on: the chosen one when it has the data, "rotate" stays (the match skips maps without it). */
function mapSettingFor(setting: MapSetting, requires: readonly ('zones' | 'flags')[] | undefined): MapSetting {
  const id = parseMapId(setting);
  return id ? mapFor(id, requires) : setting;
}

/** The general range, widened where a game type offers values outside it (round time 60 s, 1 capture). */
function rangeFor(base: { min: number; max: number }, values: number[] | undefined): { min: number; max: number } {
  if (!values || values.length === 0) return base;
  return { min: Math.min(base.min, ...values), max: Math.max(base.max, ...values) };
}

function clampSetting(v: unknown, range: { min: number; max: number }, dflt: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : dflt;
  return Math.min(range.max, Math.max(range.min, n));
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
  /** Rooms that opted into the public list (from meta.json). */
  private readonly listedMeta = new Map<string, RoomMeta>();
  private listCache: { at: number; rooms: ListedRoom[] } | null = null;

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
  create(name: string | ((code: string) => string), gameMode: string | undefined, seed: string | undefined, match: MatchRequest = {}, security: RoomSecurity = {}): string | null {
    if (this.onDisk >= this.opts.maxRooms) return null;
    let code = '';
    do {
      code = Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
    } while (existsSync(join(this.opts.dataDir, code)));
    const cleanName = (typeof name === 'function' ? name(code) : name).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 32) || 'BunkCraft Game';
    const mode = GAME_MODES.includes(gameMode as GameMode) ? parseGameMode(gameMode) : 'survival';
    const cleanSeed = seed?.trim().slice(0, 32) || undefined;
    // Arcade game types ignore the Minecraft game mode and bring their own match settings.
    const type = gameTypeDef(parseGameType(match.gameType));
    const server = new GameServer({
      ...this.serverOptions(code),
      dataDir: join(this.opts.dataDir, code), worldName: cleanName, seed: cleanSeed, gameMode: mode,
      motd: this.opts.motd, maxPlayers: this.opts.maxPlayers, quiet: true,
      ownerHash: security.ownerHash, passwordHash: security.passwordHash, listed: security.listed,
      ...(type.arcade ? {
        gameType: type.id,
        // A type without a score option (gun game: the ladder) keeps its own limit.
        scoreLimit: type.options && type.options.score.length === 0 ? type.scoreLimit
          : clampSetting(match.scoreLimit, rangeFor(SCORE_LIMIT_RANGE, type.options?.score), type.scoreLimit),
        timeLimitSec: clampSetting(match.timeLimitSec, rangeFor(TIME_LIMIT_RANGE, type.options?.time), type.timeLimitSec),
        mapId: mapSettingFor(parseMapSetting(match.mapId) ?? DEFAULT_MAP, type.requires),
        ...(parseMapId(match.startMap) ? { startMap: parseMapId(match.startMap)! } : {}),
        ...(match.maxPlayers !== undefined ? {
          lobbySize: clampSetting(match.maxPlayers, { min: LOBBY_SIZE_RANGE.min, max: Math.min(LOBBY_SIZE_RANGE.max, this.opts.maxPlayers) }, this.opts.maxPlayers),
        } : {}),
      } : {}),
    });
    this.loaded.set(code, { server, lastActive: Date.now() });
    this.onDisk++;
    this.writeMeta(code, server);
    log.info('room created', { code, name: cleanName, type: type.arcade ? type.id : mode, rooms: this.onDisk, locked: !!security.passwordHash, listed: !!security.listed });
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
    let server: GameServer;
    try {
      server = new GameServer({
        ...this.serverOptions(code),
        dataDir: dir, worldName: 'BunkCraft Game', gameMode: 'survival',
        motd: this.opts.motd, maxPlayers: this.opts.maxPlayers, quiet: true,
      });
    } catch (e) {
      // A damaged world file makes that one game unavailable, nothing more.
      log.error('room could not be loaded', { code, error: String(e) });
      return null;
    }
    this.loaded.set(code, { server, lastActive: Date.now() });
    return { code, server };
  }

  private serverOptions(code: string) {
    return {
      label: code,
      adminToken: this.opts.adminToken,
      failLimiter: this.opts.failLimiter,
      backupDir: this.opts.backupDir ? join(this.opts.backupDir, code) : undefined,
      inventoryGuard: this.opts.inventoryGuard,
      binary: this.opts.binary,
      genPool: this.opts.genPool,
      profiles: this.opts.profiles,
      onMetaChange: () => { const r = this.loaded.get(code); if (r) this.writeMeta(code, r.server); },
    };
  }

  /** Writes the listing sidecar and refreshes the public list. */
  private writeMeta(code: string, server: GameServer): void {
    const info = server.info();
    const meta: RoomMeta = {
      name: info.name, gameType: info.gameType, gameMode: info.gameMode, map: info.map, listed: server.listed, locked: server.locked, maxPlayers: info.maxPlayers,
    };
    try {
      const file = join(this.opts.dataDir, code, 'meta.json');
      writeFileSync(`${file}.tmp`, JSON.stringify(meta));
      renameSync(`${file}.tmp`, file);
    } catch (e) {
      log.warn('room meta not written', { code, error: String(e) });
    }
    if (meta.listed) this.listedMeta.set(code, meta); else this.listedMeta.delete(code);
    this.listCache = null;
  }

  /**
   * The public server list: only games that opted in, most players first, capped and cached for a few seconds.
   * `kind` keeps Minecraft games (Multiplayer) or arcade lobbies (Realms); null = both (older clients).
   */
  listPublic(kind: ListingKind | null = null): ListedRoom[] {
    const now = Date.now();
    if (!this.listCache || now - this.listCache.at >= 5000) {
      const rooms: ListedRoom[] = [];
      for (const [code, m] of this.listedMeta) {
        const live = this.loaded.get(code);
        const players = live?.server.playerCount ?? 0;
        const status = players > 0 ? live!.server.lobbyStatus() : null;
        rooms.push({
          code, name: m.name, gameType: m.gameType, gameMode: m.gameMode, players,
          maxPlayers: m.maxPlayers, locked: m.locked, ...(m.map ? { map: m.map } : {}),
          ...(status ? { phase: status.phase, timeLeft: status.timeLeft, currentMap: status.map } : {}),
        });
      }
      rooms.sort((a, b) => b.players - a.players || a.name.localeCompare(b.name));
      this.listCache = { at: now, rooms };
    }
    return filterRooms(this.listCache.rooms, kind).slice(0, this.opts.listMax ?? 50);
  }

  /** What matchmaking knows about every public lobby of a mode (live state for the loaded ones). */
  lobbies(mode: GameType): LobbyCandidate[] {
    const out: LobbyCandidate[] = [];
    for (const [code, m] of this.listedMeta) {
      if (m.gameType !== mode) continue;
      const live = this.loaded.get(code);
      const status = live?.server.lobbyStatus() ?? null;
      out.push({
        code, gameType: m.gameType, players: live?.server.playerCount ?? 0, maxPlayers: live?.server.maxPlayers ?? m.maxPlayers,
        open: m.listed && !m.locked,
        ...(status && live!.server.playerCount > 0 ? { phase: status.phase, timeLeft: status.timeLeft, progress: status.progress } : {}),
      });
    }
    return out;
  }

  /**
   * Realms quick play: the fullest public lobby of the mode that has room and is not about to end, else a new
   * public lobby on rotating maps. `mayCreate` is asked only when a lobby has to be opened (room creation limit).
   */
  quickPlay(mode: GameType, mayCreate: () => boolean): QuickPlayResult {
    const def = gameTypeDef(mode);
    if (!def.arcade) return { error: 'full' };
    const pick = pickLobby(this.lobbies(mode), mode);
    if (pick) return { code: pick.code, created: false };
    if (!mayCreate()) return { error: 'limited' };
    // Named after its code so lobbies of one mode can be told apart in the list.
    // Every new lobby starts on a random map the mode can use, so not every lobby opens on the same arena.
    const maps = MAP_IDS.filter((id) => getMap(id).supports(def.requires));
    const startMap = maps[randomInt(maps.length)];
    const code = this.create((c) => quickPlayName(mode, c), undefined, undefined, { gameType: mode, mapId: 'rotate', startMap }, { listed: true });
    if (!code) return { error: 'full' };
    return { code, created: true };
  }

  /** Players and public lobbies with players per arcade mode (the Realms playlist). */
  modeStats(): ModeStats[] {
    const stats = new Map<GameType, ModeStats>(REALMS_MODES.map((g) => [g, { gameType: g, players: 0, lobbies: 0 }]));
    for (const [code, r] of this.loaded) {
      const n = r.server.playerCount;
      if (n === 0) continue;
      const st = stats.get(r.server.info().gameType);
      if (!st) continue;
      st.players += n;
      const m = this.listedMeta.get(code);
      if (m && !m.locked) st.lobbies++;
    }
    return [...stats.values()];
  }

  /** Every game for the admin page: loaded ones with players, plus the ones only on disk. */
  adminList(): AdminRoom[] {
    const out: AdminRoom[] = [];
    for (const entry of readdirSync(this.opts.dataDir)) {
      if (!/^[A-Z0-9]{6}$/.test(entry)) continue;
      const live = this.loaded.get(entry);
      if (live) {
        const i = live.server.info();
        out.push({ code: entry, name: i.name, loaded: true, players: i.players, listed: live.server.listed, locked: live.server.locked, gameType: i.gameType, gameMode: i.gameMode });
        continue;
      }
      try {
        const m = JSON.parse(readFileSync(join(this.opts.dataDir, entry, 'meta.json'), 'utf8')) as RoomMeta;
        out.push({ code: entry, name: m.name, loaded: false, players: 0, listed: m.listed, locked: m.locked, gameType: m.gameType, gameMode: m.gameMode });
      } catch {
        out.push({ code: entry, name: '(unknown)', loaded: false, players: 0, listed: false, locked: false, gameType: 'minecraft', gameMode: 'survival' });
      }
    }
    return out;
  }

  /** Disconnects everybody and unloads a game; `remove` also deletes its data. */
  close(raw: string, remove: boolean): boolean {
    const code = normalizeCode(raw);
    if (!code) return false;
    const live = this.loaded.get(code);
    const dir = join(this.opts.dataDir, code);
    if (!live && !existsSync(dir)) return false;
    if (live) {
      live.server.shutdown(undefined, 'This game was closed by the server administrator');
      this.loaded.delete(code);
    }
    if (remove) {
      rmSync(dir, { recursive: true, force: true });
      this.onDisk = Math.max(0, this.onDisk - 1);
      this.listedMeta.delete(code);
      this.listCache = null;
    }
    log.warn('room closed by admin', { code, removed: remove });
    return true;
  }

  get loadedCount(): number {
    return this.loaded.size;
  }

  /** Players of a loaded game (admin page). */
  players(raw: string): ReturnType<GameServer['playerList']> {
    const code = normalizeCode(raw);
    const live = code ? this.loaded.get(code) : undefined;
    return live ? live.server.playerList() : [];
  }

  /** Disconnects a player of a game by name (admin tools). */
  kickPlayer(raw: string, name: string, reason: string): boolean {
    const code = normalizeCode(raw);
    const live = code ? this.loaded.get(code) : undefined;
    return live ? live.server.kickPlayer(name, reason) : false;
  }

  info(raw: string): RoomInfo | null {
    const room = this.get(raw);
    return room ? { code: room.code, ...room.server.info() } : null;
  }

  shutdown(reconnectMs?: number): void {
    clearInterval(this.timer);
    for (const r of this.loaded.values()) r.server.shutdown(reconnectMs);
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
        log.debug('room unloaded (idle)', { code });
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
        if (this.listedMeta.delete(entry)) this.listCache = null;
        log.info('room expired', { code: entry });
        continue;
      }
      try {
        const m = JSON.parse(readFileSync(join(this.opts.dataDir, entry, 'meta.json'), 'utf8')) as RoomMeta;
        if (m.listed) this.listedMeta.set(entry, m);
      } catch {
        // Rooms from before the public list have no meta.json: they are simply not listed.
      }
      n++;
    }
    this.onDisk = n;
  }
}
