import { findSpawnColumn } from '../src/world/Spawn';
import { enchantsOf } from '../src/items/EnchantRules';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import {
  type ClientMessage, NAME_PATTERN, PROTOCOL_VERSION, type PlayerRecord, SNAP_FLAG_STALE, type ServerMessage, type SnapshotEntry, sanitizeChat,
} from '../src/net/protocol';
import { ARENA_FLOOR_Y, DEFAULT_MAP, type MapId, type MapSetting, getMap, mapFor, nextMap, parseMapId, parseMapSetting } from '../src/modes/maps';
import { type GameType, gameTypeDef } from '../src/modes/GameTypes';
import { GAME_MODES, type GameMode, hasSurvivalRules } from '../src/player/GameMode';
import { BINARY_VERSION, encodeBinary, encodeSnap, encodeSnapQ } from '../src/net/binary';
import { ARCADE_TICK_HZ, ARCADE_TICK_MAX, ARCADE_TICK_MIN, arcadeInterpDelay } from '../src/modes/ArcadeLogic';
import { decodeData } from '../src/items/ItemRegistry';
import { BLOCK, getBlockDef } from '../src/world/BlockRegistry';
import { isValidMeta } from '../src/world/BlockShapes';
import { needsSupport, plantCanStand } from '../src/world/PlantRules';
import { packState, stateId, stateMeta } from '../src/world/BlockStates';
import { hashString } from '../src/world/Noise';
import { Weather, type WeatherState, parseWeatherCommand } from '../src/world/Weather';
import { arenaWorldType } from '../src/world/WorldGenerator';
import { TerrainGenerator } from '../src/world/TerrainGenerator';
import { GEN_VERSION_CURRENT, GEN_VERSION_LEGACY } from '../src/world/GenVersion';
import { Match, type MatchHost } from './Match';
import { ServerEntities, dayFactorAt } from './ServerEntities';
import { ServerSurvival, type SurvivalData } from './SurvivalRules';
import { EffectSet } from '../src/player/Effects';
import { ServerWorld } from './ServerWorld';
import { ContainerService } from './Containers';
import type { SavedEntity } from '../src/world/BlockEntities';
import { type Actor, type BanEntry, type CommandHost, type Moderation, type Target, lc, runCommand } from './Commands';
import { InventoryGuard, parseInventory } from './InventoryGuard';
import { type ChildLogger, log } from './Log';
import { metrics } from './Metrics';
import { ArcadeGuard } from './anticheat/ArcadeGuard';
import { ORIGIN_TOLERANCE, isUnitVector, originError, viewDir } from './anticheat/AimCheck';
import { AimStats, SUSPICION } from './anticheat/Suspicion';
import { Send, type Viewer, Visibility } from './anticheat/Visibility';
import type { ShotReport } from './Match';
import { type RateLimiter, hashIp, newToken, safeEqual, tokenMatches, verifyPassword, hashToken } from './Security';

const TICK_MS = 50; // 20 ticks per second, like Minecraft
const DAY_SECONDS = 1200;
const SAVE_INTERVAL_MS = 30_000;
const REACH = 8; // lenient server-side reach check (client uses 4.5, creative 5)
const MAX_SPEED = 26; // blocks/second (fast flying + slack)
const PING_INTERVAL_SECONDS = 3; // arcade: measure the round trip every 3 s
/** Block changes per 'blocks' message (flowing water). */
const BLOCKS_PER_MESSAGE = 100;
const ARENA_DAY = 0.25; // arcade games are always noon
/** Horizontal limit for positions a client may report (Minecraft's world border). */
const WORLD_LIMIT = 29_999_984;
/** A client that lets this much outgoing data pile up is not reading: drop it instead of buffering without bound. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

/** Names that may claim an identity per game (bounds world.json). */
const MAX_CLAIMS = 500;

/** Saved status effects from a client: well-formed rows only, at most one per effect. */
function cleanEffects(rows: unknown[]): number[][] | undefined {
  const set = new EffectSet();
  set.load(rows.slice(0, 32));
  return set.serialize();
}

function rawLength(raw: unknown): number {
  if (Buffer.isBuffer(raw)) return raw.length;
  if (Array.isArray(raw)) return raw.reduce((n: number, b: Buffer) => n + b.length, 0);
  return (raw as ArrayBuffer | undefined)?.byteLength ?? 0;
}

interface WorldData extends SurvivalData {
  name: string;
  seed: number;
  /** Terrain generator version (src/world/GenVersion.ts); files from before versioning have none = 1. */
  genVersion?: number;
  gameMode: GameMode;
  time: number;
  /** Whole days played (moon phase); absent in older files = 0. */
  day?: number;
  /** Weather timers and flags; absent = a fresh clear cycle. */
  weather?: WeatherState;
  spawn: { x: number; y: number; z: number };
  /** "x,y,z" → packed state (block id | meta << 8); files from before block states hold plain ids. */
  edits: Record<string, number>;
  players: Record<string, PlayerRecord>;
  /** Arcade game type; absent = the Minecraft sandbox. */
  gameType?: GameType;
  scoreLimit?: number;
  timeLimitSec?: number;
  /** Arcade: a map id, or "rotate" for the next map after every match (absent = the default map). */
  mapId?: MapSetting;
  /** Hash of the owner token handed out when the game was created (see Security.ts). */
  ownerHash?: string;
  /** scrypt hash of the room password; never sent to clients. */
  passwordHash?: string;
  /** Show this game in the public server list (opt-in). */
  listed?: boolean;
  /** Moderation: operators, bans, whitelist. */
  ops?: string[];
  bans?: BanEntry[];
  whitelist?: { on: boolean; names: string[] };
  /** lowercase name → hash of the identity key that claimed it (stops name take-over). */
  claims?: Record<string, string>;
  /** Salt for the IP hashes in `bans`. */
  ipSalt?: string;
  /** Chests and furnaces: "x,y,z" → saved block entity (see src/world/BlockEntities). Absent in older files. */
  blockEntities?: Record<string, SavedEntity>;
}

/** Block change message; the meta field is left out for the default state to keep the common case small. */
function blockMessage(x: number, y: number, z: number, id: number, meta: number): Extract<ServerMessage, { t: 'block' }> {
  return meta ? { t: 'block', x, y, z, id, meta } : { t: 'block', x, y, z, id };
}

/** Token bucket rate limiter (per player, per message kind). */
class Bucket {
  private tokens: number;
  private last = Date.now();
  constructor(private readonly rate: number, private readonly burst: number, private readonly kind = '') {
    this.tokens = burst;
  }
  take(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < 1) {
      if (this.kind) metrics.rateLimited(this.kind);
      return false;
    }
    this.tokens -= 1;
    return true;
  }
}

interface Session {
  id: number;
  name: string;
  ws: WebSocket;
  x: number; y: number; z: number;
  yaw: number; pitch: number;
  flags: number; held: number;
  hasPos: boolean;
  lastPosTime: number;
  edits: Bucket;
  /** Melee, bow, drop and pickup requests (mob and item interaction). */
  attacks: Bucket;
  shots: Bucket;
  drops: Bucket;
  takes: Bucket;
  chat: Bucket;
  moves: Bucket;
  states: Bucket;
  /** Container open and click requests. */
  containers: Bucket;
  ip: string;
  /** Operator of this game (owner token, or listed in `ops` with a verified identity). */
  op: boolean;
  owner: boolean;
  /** The name is bound to this browser's identity key. */
  verified: boolean;
  /** Receives snap and ent as binary frames. */
  bin: boolean;
  /** Arcade: receives snapshots in the quantised binary format (binary version 2). */
  binq: boolean;
  guard: InventoryGuard;
  /** Arcade: fire, reload, weapon and loadout requests. */
  fires: Bucket;
  actions: Bucket;
  violations: number;
  /** Round trip in ms (WebSocket ping/pong, arcade games). */
  pingMs: number;
  pingSentAt: number;
  /** After a server-side move (spawn) positions from before it are ignored until the client arrives. */
  awaiting: { x: number; y: number; z: number; until: number } | null;
  /** Velocity between the last two accepted position reports (blocks/s), for the shot origin check. */
  velX: number; velY: number; velZ: number;
  /** Arcade: aim statistics (suspicion score) and the time of the last shot (ms). */
  aim: AimStats;
  lastFireAt: number;
}

export interface ServerOptions {
  dataDir: string;
  worldName: string;
  seed?: string;
  gameMode: GameMode;
  motd: string;
  maxPlayers: number;
  /** Skip per-player log lines (rooms log themselves). */
  quiet?: boolean;
  /** Game code or "main": a field on every log line. */
  label?: string;
  /** For a new game: hashes from the creation request (see Rooms.create). */
  ownerHash?: string;
  passwordHash?: string;
  listed?: boolean;
  /** Names that are operators from the start (OPS for the main world). */
  ops?: string[];
  /** Commands like /kick exist even without an owner (main world with OPS or ADMIN_TOKEN). */
  moderated?: boolean;
  /** Server administrator token: whoever sends it as `owner` is op in every game. */
  adminToken?: string;
  /** Failed password attempts per client address (shared by all games). */
  failLimiter?: RateLimiter;
  /** Where Backup.ts keeps copies of world.json; used to recover from a corrupt file. */
  backupDir?: string;
  /** Inventory checks for survival games: enforce (default), warn (log only) or off. */
  inventoryGuard?: 'enforce' | 'warn' | 'off';
  /** Send snap/ent as binary frames to clients that ask for it (default on). */
  binary?: boolean;
  /** Called when something changed that the room list shows (name, listing, password). */
  onMetaChange?: () => void;
  /** Arcade: server tick rate in Hz (default 30; env ARCADE_TICK_HZ, clamped to 10-60). */
  arcadeTickHz?: number;
  /** Arcade: leave enemies out of snapshots when they cannot be seen (default on; env ARCADE_CULLING=off). */
  culling?: boolean;
  /** Arcade: kick at this aim suspicion score (0 = never, the default; env ARCADE_AUTOKICK_SCORE). */
  autokickScore?: number;
  /** Arcade game type and match settings for a new world (a saved world keeps its own). */
  gameType?: GameType;
  scoreLimit?: number;
  timeLimitSec?: number;
  mapId?: MapSetting;
}

/**
 * Authoritative multiplayer server for one shared world: owns the edit list, the
 * time of day and saved player data, validates edits (reach, block id, rate) and
 * movement (speed), and relays positions and chat.
 */
export class GameServer {
  private readonly sessions = new Map<number, Session>();
  private nextId = 1;
  private world: WorldData;
  private readonly file: string;
  private dirty = false;
  private lastTick = Date.now();
  private tickCount = 0;
  /** Ticks per second: 20 (Minecraft), arcade rooms ARCADE_TICK_HZ (default 30). */
  private readonly tickHz: number = 20;
  /** Weather of this world (minecraft game types only; arcade rooms are always clear). */
  private readonly weather = new Weather();
  private weatherVersion = -1;
  private readonly strikeRoll = { dx: 0, dz: 0 };
  private timers: NodeJS.Timeout[] = [];
  /** Mobs, items, arrows and TNT for this world. */
  private readonly entities: ServerEntities | null;
  /** Difficulty, game rules and sleeping (Minecraft game types only). */
  private readonly survival: ServerSurvival | null = null;
  private entitiesActive = false;
  /** Arcade games: the match and the arena as bullets see it. */
  private readonly match: Match | null = null;
  private arena: ServerWorld | null = null;
  /** Arcade: movement validation against the arena (see anticheat/). */
  private readonly guard: ArcadeGuard | null = null;
  /** Arcade: per-recipient snapshot culling (anti-wallhack); null when switched off. */
  private readonly visibility: Visibility | null = null;
  private readonly viewers: Viewer[] = [];
  private readonly staleAt = { x: 0, y: 0, z: 0 };
  /** Chests and furnaces: who has which open, click validation, updates (null in arcade games). */
  private readonly containers: ContainerService | null = null;
  /** Arcade: the map setting of this game ("rotate" moves on to the next map after every match). */
  private mapSetting: MapSetting = DEFAULT_MAP;
  private readonly logger: ChildLogger;
  private closed = false;
  private readonly guardMode: 'enforce' | 'warn' | 'off';

  constructor(private readonly opts: ServerOptions) {
    mkdirSync(opts.dataDir, { recursive: true });
    this.file = join(opts.dataDir, 'world.json');
    this.logger = log.child({ room: opts.label ?? 'main' });
    this.guardMode = opts.inventoryGuard ?? 'enforce';
    this.world = this.load();
    this.world.ops ??= [];
    this.world.bans ??= [];
    this.world.whitelist ??= { on: false, names: [] };
    this.world.claims ??= {};
    for (const n of opts.ops ?? []) if (!this.world.ops.includes(lc(n))) this.world.ops.push(lc(n));
    this.weather.restore(this.world.weather);
    if (gameTypeDef(this.world.gameType ?? 'minecraft').arcade) this.weather.rainTime = this.weather.thunderTime = 0;
    const def = gameTypeDef(this.world.gameType ?? 'minecraft');
    if (def.arcade) {
      this.mapSetting = parseMapSetting(this.world.mapId) ?? DEFAULT_MAP;
      const first: MapId = mapFor(parseMapId(this.mapSetting) ?? DEFAULT_MAP, def.requires);
      this.loadArena(first);
      this.guard = new ArcadeGuard(
        { getBlock: (x, y, z) => this.arena!.getBlock(x, y, z), getMeta: (x, y, z) => this.arena!.getMeta(x, y, z) },
        (x, z) => this.match!.inBounds(x, z),
      );
      if (opts.culling ?? process.env.ARCADE_CULLING !== 'off') this.visibility = new Visibility({ getBlock: (x, y, z) => this.arena!.getBlock(x, y, z) });
      this.match = new Match(this.matchHost(), {
        type: def.id, scoreLimit: this.world.scoreLimit ?? def.scoreLimit, timeLimitSec: this.world.timeLimitSec ?? def.timeLimitSec,
        map: first,
      });
      this.entities = null;
    } else this.entities = new ServerEntities(this.world.seed, this.world.edits, this.world.gameMode, {
      send: (id, msg) => { const s = this.sessions.get(id); if (s) this.send(s, msg); },
      broadcast: (msg) => this.broadcast(msg),
      broadcastBlock: (x, y, z, id, meta) => this.broadcast(blockMessage(x, y, z, id, meta ?? 0)),
      broadcastBlocks: (edits) => {
        // At most 200 changes per tick come out of the simulation; split anyway to keep messages small.
        for (let i = 0; i < edits.length; i += 5 * BLOCKS_PER_MESSAGE) this.broadcast({ t: 'blocks', edits: edits.slice(i, i + 5 * BLOCKS_PER_MESSAGE) });
      },
      recordEdit: (x, y, z, id, meta) => { this.world.edits[`${x},${y},${z}`] = packState(id, meta); this.dirty = true; },
      skyDarkness: () => this.weather.skyDarkness,
    }, () => this.world.time, this.world.genVersion);
    if (this.entities) {
      const ents = this.entities;
      this.survival = new ServerSurvival({
        send: (id, msg) => { const ss = this.sessions.get(id); if (ss) this.send(ss, msg); },
        broadcast: (msg) => this.broadcast(msg),
        getBlock: (x, y, z) => ents.world.getBlock(x, y, z),
        getMeta: (x, y, z) => ents.world.getMeta(x, y, z),
        mobs: () => ents.manager.mobs,
        dayFactor: () => dayFactorAt(this.world.time),
        thundering: () => this.weather.thundering && this.weather.raining,
        skipNight: (time) => {
          if (this.world.time > time) this.world.day = (this.world.day ?? 0) + 1;
          this.world.time = time;
          if (this.weather.raining) this.weather.set('clear');
          this.dirty = true;
          this.broadcast({ t: 'time', time, day: this.world.day ?? 0 });
        },
        setBed: (name, bed) => {
          const prev = this.playerRecord(name);
          if (!prev) return;
          const next = { ...prev };
          if (bed) next.bed = bed; else delete next.bed;
          this.setPlayerRecord(name, next);
          this.dirty = true;
        },
      });
      this.survival.load(this.world);
      if (this.world.gameMode === 'hardcore') this.survival.difficulty = 'hard';
      ents.rules = this.survival.rules;
      ents.setDifficulty(this.survival.difficulty);
      ents.applyRules();
      const store = this.entities.world.blockEntities;
      store.load(this.world.blockEntities);
      this.containers = new ContainerService({
        store: () => store,
        send: (id, msg) => { const s = this.sessions.get(id); if (s) this.send(s, msg); },
        guarded: () => this.guarded(),
        reject: (name, reason) => {
          metrics.inventoryRejects++;
          this.logger.warn('container click rejected', { name, reason, mode: this.guardMode });
        },
        session: (id) => this.sessions.get(id),
      });
    }
    if (this.match) {
      const hz = this.opts.arcadeTickHz ?? (Number(process.env.ARCADE_TICK_HZ) || ARCADE_TICK_HZ);
      this.tickHz = Math.max(ARCADE_TICK_MIN, Math.min(ARCADE_TICK_MAX, Math.round(hz)));
    }
    this.timers.push(setInterval(() => this.tick(), this.match ? 1000 / this.tickHz : TICK_MS));
    this.timers.push(setInterval(() => {
      try {
        this.save();
      } catch (e) {
        // Disk full or gone: keep the world in memory and try again next time.
        this.dirty = true;
        this.logger.error('saving failed', { error: String(e) });
      }
    }, SAVE_INTERVAL_MS));
  }

  /** The bullets' copy of the arena of a map. */
  private loadArena(map: MapId): void {
    this.arena = new ServerWorld(this.world.seed, {}, arenaWorldType(map));
    this.arena.preloadArena();
  }

  private load(): WorldData {
    if (existsSync(this.file)) {
      const data = this.readWorld();
      // World files from before generator versioning were made by version 1; keep them on it.
      if (data.genVersion === undefined) { data.genVersion = GEN_VERSION_LEGACY; this.dirty = true; }
      this.log(`[world] loaded "${data.name}" (seed ${data.seed}, ${Object.keys(data.edits).length} edits, ${Object.keys(data.players).length} players)`);
      return data;
    }
    const seedText = this.opts.seed;
    const seed = !seedText ? (Math.random() * 4294967296) >>> 0
      : /^-?\d+$/.test(seedText) ? Number(BigInt.asUintN(32, BigInt(seedText))) : hashString(seedText);
    const def = gameTypeDef(this.opts.gameType ?? 'minecraft');
    const mapSetting = parseMapSetting(this.opts.mapId) ?? DEFAULT_MAP;
    const spawn = def.arcade ? getMap(parseMapId(mapSetting) ?? DEFAULT_MAP).spawns.ffa[0] : this.findSpawn(seed, GEN_VERSION_CURRENT);
    const data: WorldData = {
      name: this.opts.worldName, seed, genVersion: GEN_VERSION_CURRENT, gameMode: this.opts.gameMode, time: def.arcade ? ARENA_DAY : 0.08, spawn, edits: {}, players: {},
    };
    if (this.opts.ownerHash) data.ownerHash = this.opts.ownerHash;
    if (this.opts.passwordHash) data.passwordHash = this.opts.passwordHash;
    if (this.opts.listed) data.listed = true;
    if (def.arcade) {
      data.gameType = def.id;
      data.scoreLimit = this.opts.scoreLimit ?? def.scoreLimit;
      data.timeLimitSec = this.opts.timeLimitSec ?? def.timeLimitSec;
      data.mapId = mapSetting;
    }
    this.log(`[world] created "${data.name}" (seed ${seed}, ${def.arcade ? def.id : data.gameMode}) spawn ${spawn.x} ${spawn.y} ${spawn.z}`);
    this.dirty = true;
    this.world = data;
    this.save();
    return data;
  }

  /** Reads world.json; a corrupt file is replaced by the newest readable backup (the bad file is kept). */
  private readWorld(): WorldData {
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as WorldData;
    } catch (e) {
      this.logger.error('world.json is unreadable', { error: String(e) });
      const dir = this.opts.backupDir;
      const backups = dir && existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort().reverse() : [];
      for (const f of backups) {
        try {
          const data = JSON.parse(readFileSync(join(dir!, f), 'utf8')) as WorldData;
          copyFileSync(this.file, `${this.file}.corrupt-${Date.now()}`);
          this.logger.warn('restored world from backup', { backup: f });
          this.dirty = true;
          return data;
        } catch {
          // Try an older one.
        }
      }
      throw new Error(`world.json in ${this.opts.dataDir} is corrupt and no backup could be read: ${String(e)}`);
    }
  }

  /** Same dry-land spawn search as the client, using the shared terrain generator. */
  private findSpawn(seed: number, genVersion: number): { x: number; y: number; z: number } {
    const gen = new TerrainGenerator(seed, genVersion);
    // Versions 1 and 2 never checked the biome here; keep that so the server picks the spot it always did.
    const at = findSpawnColumn(gen, genVersion, false);
    if (at) return { x: at.x + 0.5, y: Math.floor(at.h) + 2, z: at.z + 0.5 };
    return { x: 0.5, y: 100, z: 0.5 };
  }

  save(): void {
    for (const s of this.sessions.values()) this.storePlayer(s);
    this.world.day = this.world.day ?? 0;
    if (!this.match) this.world.weather = this.weather.serialize();
    this.survival?.save(this.world);
    const store = this.entities?.world.blockEntities;
    if (store?.dirty) {
      this.world.blockEntities = store.serialize();
      store.dirty = false;
      this.dirty = true;
    }
    if (!this.dirty) return;
    const tmp = `${this.file}.tmp`;
    // Write-then-rename so a crash never leaves a half-written world file.
    writeFileSync(tmp, JSON.stringify(this.world));
    renameSync(tmp, this.file);
    this.dirty = false;
  }

  /** Saves and disconnects everybody; `reconnectMs` tells clients the server is coming back (restart). */
  shutdown(reconnectMs?: number, reason = 'Server closed'): void {
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.closed = true;
    this.dirty = true;
    this.save();
    for (const s of this.sessions.values()) {
      this.send(s, reconnectMs ? { t: 'kick', reason: 'Server restarting', reconnect: reconnectMs } : { t: 'kick', reason });
      try { s.ws.close(reconnectMs ? 1012 : 1001, 'Server closed'); } catch { /* already closed */ }
    }
    this.sessions.clear();
  }

  get playerCount(): number {
    return this.sessions.size;
  }

  get listed(): boolean {
    return !!this.world.listed;
  }

  get locked(): boolean {
    return !!this.world.passwordHash;
  }

  get name(): string {
    return this.world.name;
  }

  /** Online players for the admin page. */
  playerList(): { id: number; name: string; ip: string; op: boolean; pingMs: number; suspicion?: number; strikes?: number }[] {
    const now = Date.now() / 1000;
    return [...this.sessions.values()].map((s) => ({
      id: s.id, name: s.name, ip: s.ip, op: s.op, pingMs: s.pingMs,
      // Arcade anti-cheat (read-only): aim suspicion 0-100 and current movement strike points.
      ...(this.match ? { suspicion: s.aim.report().score, strikes: Math.round((this.guard?.strikes(s.id, now) ?? 0) * 10) / 10 } : {}),
    }));
  }

  /** Disconnects a player by name (admin tools); true if somebody was online. */
  kickPlayer(name: string, reason: string): boolean {
    const s = this.findSession(name);
    if (!s) return false;
    this.kickSession(s, reason);
    return true;
  }

  /** Changes the public settings of a game (listing, password hash) and saves. */
  configure(change: { listed?: boolean; passwordHash?: string | null }): void {
    if (change.listed !== undefined) this.world.listed = change.listed || undefined;
    if (change.passwordHash !== undefined) this.world.passwordHash = change.passwordHash ?? undefined;
    this.dirty = true;
    this.save();
    this.opts.onMetaChange?.();
  }

  info(): {
    name: string; gameMode: GameMode; players: number; maxPlayers: number; gameType: GameType; scoreLimit: number; timeLimitSec: number;
    /** A password is needed to join (the password itself is never sent). */
    locked: boolean;
    /** Arcade: the map setting (a map id or "rotate"). */
    map?: MapSetting;
  } {
    return {
      name: this.world.name, gameMode: this.world.gameMode, players: this.sessions.size, maxPlayers: this.opts.maxPlayers, locked: this.locked,
      gameType: this.match?.info.type ?? 'minecraft', scoreLimit: this.match?.info.scoreLimit ?? 0, timeLimitSec: this.match?.info.timeLimitSec ?? 0,
      ...(this.match ? { map: this.mapSetting } : {}),
    };
  }

  /** The match's view of this server: clock, messages, bullets' world and moving players. */
  private matchHost(): MatchHost {
    const gs = this;
    return {
      now: () => Date.now() / 1000,
      send: (id, msg) => { const s = this.sessions.get(id); if (s) this.send(s, msg); },
      broadcast: (msg, except) => this.broadcast(msg, except),
      blocks: { getBlock: (x, y, z) => this.arena!.getBlock(x, y, z) },
      moveTo: (id, x, y, z) => {
        const s = this.sessions.get(id);
        if (!s) return;
        s.x = x; s.y = y; s.z = z;
        s.hasPos = true;
        s.lastPosTime = Date.now();
        s.awaiting = { x, y, z, until: Date.now() + 1500 };
        this.guard?.reset(id, x, y, z, Date.now() / 1000);
        this.visibility?.resetTrail(id);
      },
      random: Math.random,
      ping: (id) => this.sessions.get(id)?.pingMs ?? 0,
      onShot: (r) => this.onShot(r),
      get interpDelay() { return arcadeInterpDelay(gs.tickHz); },
      nextMap: (current, requires) => {
        if (this.mapSetting !== 'rotate') return null;
        const next = nextMap(parseMapId(current) ?? DEFAULT_MAP, requires);
        this.loadArena(next);
        return next;
      },
    };
  }

  private log(line: string): void {
    if (this.opts.quiet) this.logger.debug(line);
    else this.logger.info(line);
  }

  // ---------------------------------------------------------------- connections

  accept(ws: WebSocket, meta: { ip?: string } = {}): void {
    const ip = meta.ip ?? 'unknown';
    let session: Session | null = null;
    let pending = false;
    const timeout = setTimeout(() => ws.close(1008, 'No hello'), 10_000);
    ws.on('message', (raw, isBinary) => {
      metrics.recvd(rawLength(raw));
      if (isBinary) return;
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        ws.close(1003, 'Bad message');
        return;
      }
      // JSON.parse also yields null, numbers, strings and arrays: only objects with a string type are messages.
      if (typeof msg !== 'object' || msg === null || Array.isArray(msg) || typeof msg.t !== 'string') return;
      try {
        if (!session) {
          if (msg.t !== 'hello' || pending) return;
          clearTimeout(timeout);
          const result = this.login(ws, ip, msg);
          if (result instanceof Promise) {
            // A password check takes a moment (scrypt runs off the event loop); other messages wait.
            pending = true;
            void result.then((s) => {
              pending = false;
              if (s && ws.readyState !== ws.OPEN) this.logout(s);
              else session = s;
            }, () => {
              pending = false;
              ws.close(1011, 'Server error');
            });
          } else session = result;
          return;
        }
        this.handle(session, msg);
      } catch (err) {
        // A malformed message must never take the whole server (and every other game) down.
        log.error('message handler failed', { error: err instanceof Error ? err.message : String(err) });
        ws.close(1011, 'Server error');
      }
    });
    ws.on('pong', () => {
      if (session && session.pingSentAt > 0) {
        const rtt = Date.now() - session.pingSentAt;
        session.pingMs = session.pingMs > 0 ? Math.round(session.pingMs * 0.5 + rtt * 0.5) : rtt;
        session.pingSentAt = 0;
      }
    });
    ws.on('close', () => {
      clearTimeout(timeout);
      if (session) this.logout(session);
    });
    ws.on('error', () => ws.close());
  }

  /** The ban matching this name or address, if any. */
  private banFor(name: string, ip: string): BanEntry | undefined {
    const salt = this.world.ipSalt;
    const ipHash = salt && ip !== 'unknown' ? hashIp(ip, salt) : null;
    return this.world.bans!.find((b) => lc(b.name) === lc(name) || (!!ipHash && b.ipHash === ipHash));
  }

  private login(ws: WebSocket, ip: string, hello: Extract<ClientMessage, { t: 'hello' }>): Session | null | Promise<Session | null> {
    const kick = (reason: string, code?: Extract<ServerMessage, { t: 'kick' }>['code']) => {
      if (code) {
        metrics.loginsFailed++;
        this.logger.info('login refused', { reason: code, ip });
      }
      ws.send(JSON.stringify({ t: 'kick', reason, ...(code ? { code } : {}) } satisfies ServerMessage));
      ws.close(1008, reason);
      return null;
    };
    if (this.closed) return kick('Server closed');
    if (hello.v !== PROTOCOL_VERSION) return kick(`Outdated client (server protocol ${PROTOCOL_VERSION})`);
    const name = String(hello.name ?? '');
    if (!NAME_PATTERN.test(name)) return kick('Invalid name (3–16 letters, digits or _)');
    const adminToken = this.opts.adminToken;
    const owner = tokenMatches(hello.owner, this.world.ownerHash)
      || (!!adminToken && typeof hello.owner === 'string' && safeEqual(hello.owner, adminToken));
    const key = typeof hello.key === 'string' && hello.key.length >= 16 && hello.key.length <= 128 ? hello.key : null;
    // The owner is never locked out of their own game.
    if (!owner) {
      const ban = this.banFor(name, ip);
      if (ban) return kick(`You are banned from this game: ${ban.reason}`, 'banned');
    }
    // A name belongs to the browser that first used it (identity key), so nobody can take over an operator.
    const claim = this.claimOf(name);
    if (claim && !owner && !tokenMatches(key, claim)) {
      return kick('This name is already used by another player. Pick another name.', 'identity');
    }
    const verified = owner || (!!key && (!claim || tokenMatches(key, claim)));
    const wl = this.world.whitelist!;
    if (wl.on && !owner && !wl.names.includes(lc(name)) && !(verified && this.world.ops!.includes(lc(name)))) {
      return kick('This game has a whitelist and you are not on it.', 'whitelist');
    }
    const proceed = () => this.finishLogin(ws, ip, name, hello, { owner, verified, key });
    const hash = this.world.passwordHash;
    if (!hash || owner) return proceed();
    // Password: refuse before doing any work when this address failed too often for THIS game (per game, so one
    // housemate's typos in one game do not lock the whole household out of every other game).
    const limiter = this.opts.failLimiter;
    const limitKey = `${this.opts.label ?? 'main'}|${ip}`;
    if (limiter && !limiter.allowed(limitKey)) {
      metrics.rateLimited('password');
      return kick('Too many wrong passwords. Try again in a few minutes.', 'password');
    }
    const password = typeof hello.password === 'string' ? hello.password : '';
    if (!password) return kick('This game needs a password.', 'password');
    return verifyPassword(password, hash).then((ok) => {
      if (this.closed || ws.readyState !== ws.OPEN) return null;
      if (!ok) {
        limiter?.record(limitKey);
        return kick('Wrong password.', 'password');
      }
      return proceed();
    });
  }

  private finishLogin(
    ws: WebSocket, ip: string, name: string, hello: Extract<ClientMessage, { t: 'hello' }>,
    who: { owner: boolean; verified: boolean; key: string | null },
  ): Session | null {
    // Logging in again from elsewhere replaces the old session, like Minecraft.
    for (const s of this.sessions.values()) {
      if (s.name.toLowerCase() === name.toLowerCase()) {
        this.send(s, { t: 'kick', reason: 'You logged in from another location' });
        s.ws.close();
        this.logout(s);
      }
    }
    if (this.sessions.size >= this.opts.maxPlayers) {
      metrics.loginsFailed++;
      ws.send(JSON.stringify({ t: 'kick', reason: 'The server is full', code: 'full' } satisfies ServerMessage));
      ws.close(1008, 'The server is full');
      return null;
    }
    // First login with an identity key claims the name (bounded, so names cannot bloat world.json).
    if (who.key && !this.claimOf(name) && Object.keys(this.world.claims!).length < MAX_CLAIMS) {
      // defineProperty: a name like "__proto__" must become an own entry, not touch the prototype.
      Object.defineProperty(this.world.claims!, lc(name), { value: hashToken(who.key), enumerable: true, writable: true, configurable: true });
      this.dirty = true;
    }
    if (who.owner && !this.world.ops!.includes(lc(name))) {
      this.world.ops!.push(lc(name)); // the creator is an operator
      this.dirty = true;
    }
    const op = who.owner || (who.verified && this.world.ops!.includes(lc(name)));

    const record = this.match ? null : this.playerRecord(name);
    const start = record ?? this.world.spawn;
    const initial = parseInventory(record?.inventory);
    const session: Session = {
      id: this.nextId++, name, ws, ip, op, owner: who.owner, verified: who.verified,
      bin: hello.bin === true && this.opts.binary !== false,
      binq: hello.bin === true && this.opts.binary !== false && !!this.match && Number(hello.binv) >= BINARY_VERSION,
      guard: new InventoryGuard(initial.error ? [] : initial.slots),
      x: start.x, y: start.y, z: start.z, yaw: 0, pitch: 0, flags: 0, held: 0,
      hasPos: false, lastPosTime: Date.now(),
      edits: new Bucket(20, 40, 'edits'), attacks: new Bucket(8, 12, 'attacks'), shots: new Bucket(3, 5, 'shots'),
      drops: new Bucket(30, 60, 'drops'), takes: new Bucket(20, 30, 'takes'),
      chat: new Bucket(1, 5, 'chat'), moves: new Bucket(40, 80, 'moves'), states: new Bucket(0.5, 10, 'states'), containers: new Bucket(20, 40, 'containers'),
      fires: new Bucket(25, 30, 'fires'), actions: new Bucket(15, 30, 'actions'), violations: 0,
      pingMs: 0, pingSentAt: 0, awaiting: null, velX: 0, velY: 0, velZ: 0, aim: new AimStats(), lastFireAt: 0,
    };
    const joined = this.match?.join(session.id, name) ?? null;
    if (joined) {
      session.x = joined.x; session.y = joined.y; session.z = joined.z; session.hasPos = true;
      this.guard?.join(session.id, name);
      this.guard?.reset(session.id, joined.x, joined.y, joined.z, Date.now() / 1000);
    }
    const edits: number[] = [];
    for (const [key, state] of Object.entries(this.world.edits)) {
      const [x, y, z] = key.split(',').map(Number);
      edits.push(x, y, z, stateId(state), stateMeta(state));
    }
    this.send(session, {
      t: 'welcome', id: session.id, worldName: this.world.name, seed: this.world.seed, genVersion: this.match ? undefined : this.world.genVersion, gameMode: this.world.gameMode,
      gameType: this.match?.info.type ?? 'minecraft', worldType: this.match ? 'arena' : 'terrain', match: this.match?.info,
      time: this.world.time, day: this.world.day ?? 0, spawn: joined ? { x: joined.x, y: joined.y, z: joined.z } : this.world.spawn, edits, player: record,
      players: [...this.sessions.values()].map((s) => ({ id: s.id, name: s.name, team: this.match?.players.get(s.id)?.team || undefined })),
      motd: this.opts.motd,
      ...(op ? { op: true } : {}),
      ...(session.bin ? { binary: true } : {}),
      ...(session.binq ? { binaryVersion: BINARY_VERSION } : {}),
      ...(this.match ? { tickHz: this.tickHz } : {}),
      ...(this.survival ? this.survival.welcome() : {}),
      ...(this.containers ? { containers: true } : {}),
    });
    if (!this.match) this.send(session, this.weatherMessage(true));
    this.sessions.set(session.id, session);
    this.broadcast({ t: 'join', id: session.id, name }, session.id);
    if (joined) {
      session.awaiting = { x: joined.x, y: joined.y, z: joined.z, until: Date.now() + 1500 };
      this.match!.ready(session.id);
    }
    this.broadcast({ t: 'chat', from: '', text: `${name} joined the game`, system: true });
    if (op && this.isModerated()) this.send(session, { t: 'chat', from: '', text: 'You are an operator of this game. Type /help for the commands you can use.', system: true });
    this.log(`[join] ${name} (${this.sessions.size} online)`);
    this.logger.debug('join', { name, ip, op, verified: who.verified });
    return session;
  }

  private logout(s: Session): void {
    if (!this.sessions.has(s.id)) return;
    this.storePlayer(s);
    this.sessions.delete(s.id);
    this.entities?.forget(s.id);
    this.survival?.forget(s.id);
    this.containers?.onLeave(s.id);
    this.match?.leave(s.id);
    this.guard?.leave(s.id);
    this.visibility?.forget(s.id);
    this.broadcast({ t: 'leave', id: s.id, name: s.name });
    this.broadcast({ t: 'chat', from: '', text: `${s.name} left the game`, system: true });
    this.log(`[leave] ${s.name} (${this.sessions.size} online)`);
  }

  /** The identity hash that claimed a name; own-property lookup so "constructor" and "__proto__" are ordinary names. */
  private claimOf(name: string): string | undefined {
    const claims = this.world.claims!;
    return Object.hasOwn(claims, lc(name)) ? claims[lc(name)] : undefined;
  }

  /** Own-property lookup: names like "constructor" or "__proto__" are valid names but must not hit Object.prototype. */
  private playerRecord(name: string): PlayerRecord | null {
    return Object.hasOwn(this.world.players, name) ? this.world.players[name] : null;
  }

  private setPlayerRecord(name: string, record: PlayerRecord): void {
    Object.defineProperty(this.world.players, name, { value: record, enumerable: true, writable: true, configurable: true });
  }

  private kickSession(s: Session, reason: string): void {
    this.send(s, { t: 'kick', reason });
    try { s.ws.close(1008, reason.slice(0, 100)); } catch { /* already closed */ }
    this.logout(s);
  }

  private findSession(name: string): Session | undefined {
    const want = lc(name);
    for (const s of this.sessions.values()) if (lc(s.name) === want) return s;
    return undefined;
  }

  private isModerated(): boolean {
    return !!this.world.ownerHash || !!this.opts.moderated;
  }

  private storePlayer(s: Session): void {
    if (!s.hasPos || this.match) return;
    const prev = this.playerRecord(s.name) ?? undefined;
    this.setPlayerRecord(s.name, { ...prev, x: s.x, y: s.y, z: s.z, yaw: s.yaw, pitch: s.pitch });
    this.dirty = true;
  }

  // ---------------------------------------------------------------- messages

  private handle(s: Session, msg: ClientMessage): void {
    if (this.match) return this.handleArcade(s, msg, this.match);
    const entities = this.entities!;
    switch (msg.t) {
      case 'pos': return this.onPos(s, msg);
      case 'block': return this.onBlock(s, msg);
      case 'chat': return this.onChat(s, msg.text);
      case 'attack': return void (s.attacks.take() && entities.attack(s, Number(msg.id), enchantData(msg.e)));
      case 'usemob': return void (s.attacks.take() && entities.useMob(s, Number(msg.id)));
      case 'shoot':
        return void (s.shots.take() && entities.shoot(s, msg.x, msg.y, msg.z, msg.dx, msg.dy, msg.dz, msg.power, enchantData(msg.e)));
      case 'ignite': return void (s.edits.take() && entities.ignite(s, msg.x, msg.y, msg.z));
      case 'take': return void (s.takes.take() && entities.take(s, Number(msg.id)));
      case 'bonemeal': return void (s.edits.take() && entities.boneMeal(s, msg.x, msg.y, msg.z));
      case 'drop':
        if (!s.drops.take()) return;
        if (!this.dropAllowed(s, msg)) return;
        return entities.drop(s, { id: msg.id, count: msg.count, damage: msg.damage, data: decodeData(Array.isArray(msg.data) ? msg.data.slice(0, MAX_ITEM_DATA).map(Number) : undefined) }, msg.x, msg.y, msg.z, msg.yaw, msg.delay);
      case 'state': return this.onState(s, msg);
      case 'bed':
        if (!s.actions.take() || !this.survival) return;
        return this.survival.bed(s, Number(msg.x), Number(msg.y), Number(msg.z), this.sessions.size);
      case 'wake': return this.survival?.wake(s.id);
      case 'container': return this.containers?.handle(s, msg);
    }
  }

  /** Survival games check inventories (see InventoryGuard); creative and spectator trust the client. */
  private guarded(): boolean {
    return this.guardMode !== 'off' && hasSurvivalRules(this.world.gameMode);
  }

  /** Item entities may only be created from stacks the player broke out of a block or holds. */
  private dropAllowed(s: Session, msg: Extract<ClientMessage, { t: 'drop' }>): boolean {
    if (!this.guarded()) return true;
    if (!Number.isInteger(msg.id) || !Number.isInteger(msg.count) || msg.count < 1) return false;
    if (s.guard.authorizeDrop(msg.id, msg.count, msg.damage)) return true;
    metrics.inventoryRejects++;
    this.logger.warn('unbacked drop', { name: s.name, item: msg.id, count: msg.count, mode: this.guardMode });
    return this.guardMode === 'warn';
  }

  private onState(s: Session, msg: Extract<ClientMessage, { t: 'state' }>): void {
    if (!s.states.take()) return;
    if (!Array.isArray(msg.inventory) || msg.inventory.length > 64 || !Array.isArray(msg.stats) || msg.stats.length > 8) return;
    if (!msg.stats.every((n) => typeof n === 'number' && Number.isFinite(n))) return;
    const inventory = cleanInventory(msg.inventory);
    if (this.guarded()) {
      const result = s.guard.check(msg.inventory);
      if (!result.ok) {
        metrics.inventoryRejects++;
        this.logger.warn('inventory rejected', { name: s.name, reason: result.reason, mode: this.guardMode });
        if (this.guardMode === 'enforce') {
          this.send(s, { t: 'state', inventory: result.correction, reason: result.reason });
          return;
        }
        s.guard.trustNextState();
        s.guard.check(msg.inventory);
      }
    } else if (parseInventory(msg.inventory).error) {
      return; // even creative inventories must be well formed
    }
    const prev = this.playerRecord(s.name) ?? { x: s.x, y: s.y, z: s.z, yaw: s.yaw, pitch: s.pitch };
    const effects = Array.isArray(msg.effects) ? cleanEffects(msg.effects) : prev.effects;
    this.setPlayerRecord(s.name, { ...prev, inventory, stats: msg.stats, ...(effects ? { effects } : {}) });
    this.dirty = true;
  }

  /** Arcade games: movement, chat and the weapon messages; building, mobs and items do not exist. */
  private handleArcade(s: Session, msg: ClientMessage, match: Match): void {
    switch (msg.t) {
      case 'pos': return this.onPos(s, msg);
      case 'chat': return this.onChat(s, msg.text);
      case 'fire': return void (s.fires.take() && this.onFire(s, msg, match));
      case 'reload': return void (s.actions.take() && match.reload(s.id, Number(msg.slot)));
      case 'weapon': return void (s.actions.take() && match.switchWeapon(s.id, Number(msg.slot)));
      case 'loadout': return void (s.actions.take() && match.setLoadout(s.id, String(msg.primary), msg.secondary === undefined ? undefined : String(msg.secondary)));
      case 'block':
        // Nobody builds in an arcade game: roll the client's guess back.
        return this.send(s, { t: 'reject', seq: msg.seq, x: msg.x, y: msg.y, z: msg.z, id: this.arena!.getBlock(msg.x | 0, msg.y | 0, msg.z | 0) });
      default: return;
    }
  }

  private onPos(s: Session, m: Extract<ClientMessage, { t: 'pos' }>): void {
    if (!s.moves.take()) return;
    const nums = [m.x, m.y, m.z, m.yaw, m.pitch];
    if (nums.some((n) => typeof n !== 'number' || !Number.isFinite(n))) return;
    // Inside Minecraft's world border; far-away positions would make the server generate chunks there.
    if (Math.abs(m.x) > WORLD_LIMIT || Math.abs(m.z) > WORLD_LIMIT || m.y < -512 || m.y > 1024) return;
    const now = Date.now();
    if (s.awaiting) {
      // We moved this player (spawn, rubber band): ignore positions from before the client got the message.
      const a = s.awaiting;
      if (Math.hypot(m.x - a.x, m.z - a.z) <= 2.5 && Math.abs(m.y - a.y) <= 3) {
        s.awaiting = null;
      } else {
        if (now > a.until) {
          a.until = now + 1500;
          this.send(s, { t: 'teleport', x: a.x, y: a.y, z: a.z });
          // Arcade: a client that keeps ignoring the correction is not lagging.
          const r = this.guard?.ignoredTeleport(s.id, now / 1000);
          if (r && !r.ok) this.onCheat(s, r);
        }
        return;
      }
    }
    if (this.match) {
      // Arcade: inside the arena, on or above the floor, and every move checked against the map.
      const outside = !this.match.inBounds(m.x, m.z) || m.y < ARENA_FLOOR_Y - 2 || m.y > ARENA_FLOOR_Y + 40;
      const p = this.match.players.get(s.id);
      if (p) {
        // The weapon in the hands sets the pace; a flag carrier (capture the flag) is params.carrySlow slower.
        const logic = this.match.logic as { isCarrier?(p: unknown): boolean };
        const carry = logic.isCarrier?.(p) ? 1 - (gameTypeDef(this.match.info.type).params?.carrySlow ?? 0.1) : 1;
        this.guard!.setMoveSpeed(s.id, p.slots[p.slot].def.moveSpeed * carry, now / 1000);
      }
      const r = outside ? this.guard!.flag(s.id, 'bounds', 2, now / 1000) : this.guard!.move(s.id, m.x, m.y, m.z, now / 1000);
      if (!r.ok) {
        this.onCheat(s, r);
        return;
      }
    } else if (s.hasPos) {
      // Movement sanity check: reject impossible speeds and snap the player back.
      const dt = Math.max(0.05, (now - s.lastPosTime) / 1000);
      const dist = Math.hypot(m.x - s.x, m.z - s.z);
      if (dist > MAX_SPEED * dt + 4) {
        if (++s.violations > 3) this.send(s, { t: 'teleport', x: s.x, y: s.y, z: s.z });
        return;
      }
    }
    s.violations = Math.max(0, s.violations - 1);
    const dtPos = (now - s.lastPosTime) / 1000;
    if (s.hasPos && dtPos > 0.005) {
      s.velX = (m.x - s.x) / dtPos; s.velY = (m.y - s.y) / dtPos; s.velZ = (m.z - s.z) / dtPos;
    }
    s.x = m.x; s.y = m.y; s.z = m.z;
    s.yaw = m.yaw; s.pitch = m.pitch;
    s.flags = m.flags | 0; s.held = m.held | 0;
    s.hasPos = true;
    s.lastPosTime = now;
    this.match?.setPosition(s.id, s.x, s.y, s.z, s.yaw, s.pitch);
  }

  /**
   * Arcade: a shot. The direction must be a unit vector (the client builds it from yaw and pitch); an
   * origin further than 0.6 blocks from the extrapolated eye is replaced by the server's eye.
   */
  private onFire(s: Session, msg: Extract<ClientMessage, { t: 'fire' }>, match: Match): boolean {
    if (!isUnitVector(msg.dx, msg.dy, msg.dz)) {
      metrics.cheat('aim-vector');
      return false;
    }
    const now = Date.now();
    let m = msg;
    const nums = [msg.ox, msg.oy, msg.oz];
    const err = nums.every((n) => typeof n === 'number' && Number.isFinite(n))
      ? originError(msg.ox, msg.oy, msg.oz, s.x, s.y, s.z, s.velX, s.velY, s.velZ, (now - s.lastPosTime) / 1000) : Infinity;
    if (err > ORIGIN_TOLERANCE) {
      metrics.cheat('origin');
      this.logger.debug('cheat', { name: s.name, kind: 'shot', rule: 'origin', error: Math.round(err * 100) / 100 });
      m = { ...msg, ox: s.x, oy: s.y + 1.62, oz: s.z };
    }
    s.lastFireAt = now;
    return match.fire(s.id, m);
  }

  /** Arcade: every resolved shot feeds the shooter's aim statistics. */
  private onShot(r: ShotReport): void {
    const s = this.sessions.get(r.shooter);
    const match = this.match;
    if (!s || !match) return;
    const me = match.players.get(r.shooter);
    // The opponent closest to the aim line is what the shot was meant for.
    let best = Infinity, dist = NaN;
    for (const o of match.players.values()) {
      if (o.id === r.shooter || !o.alive || (match.teams && me && o.team === me.team)) continue;
      const vx = o.x - r.ox, vy = o.y + 0.9 - r.oy, vz = o.z - r.oz, d = Math.hypot(vx, vy, vz) || 1;
      const ang = 1 - (vx * r.dx + vy * r.dy + vz * r.dz) / d;
      if (ang < best) { best = ang; dist = d; }
    }
    const view = s.hasPos ? viewDir(s.yaw, s.pitch, [0, 0, 0]) : null;
    s.aim.shot({ now: Date.now() / 1000, dx: r.dx, dy: r.dy, dz: r.dz, view, targetDist: dist, hit: r.hits.length > 0, head: r.hits.some((h) => h.head) });
    const rep = s.aim.report();
    const now = Date.now() / 1000;
    if (rep.score >= SUSPICION.WARN_AT && now - s.aim.warnedAt > 60) {
      s.aim.warnedAt = now;
      metrics.suspicionFlags++;
      this.logger.warn('cheat', { name: s.name, kind: 'aim', suspicion: rep.score, shots: rep.shots, hits: rep.hits,
        headRatio: round(rep.headRatio), farAccuracy: round(rep.farAccuracy), snapRatio: round(rep.snapRatio), mismatchRatio: round(rep.mismatchRatio) });
    }
    const autokick = this.opts.autokickScore ?? (Number(process.env.ARCADE_AUTOKICK_SCORE) || 0);
    if (autokick > 0 && rep.score >= autokick && rep.hits >= 20 && !s.owner) {
      metrics.cheatKicks++;
      this.logger.warn('cheat kick', { name: s.name, kind: 'aim', suspicion: rep.score });
      this.broadcast({ t: 'chat', from: '', text: `${s.name} was kicked by the anti-cheat`, system: true });
      this.kickSession(s, 'Kicked by the anti-cheat (aim)');
    }
  }

  /** Arcade anti-cheat verdict: rubber band to the last valid position, count, log, and kick or ban on repeat. */
  private onCheat(s: Session, r: Exclude<ReturnType<ArcadeGuard['move']>, { ok: true }>): void {
    metrics.cheat(r.lag ? 'lag' : r.rule);
    const at = this.guard!.lastValid(s.id) ?? { x: s.x, y: s.y, z: s.z };
    if (!r.lag) this.logger.warn('cheat', { name: s.name, kind: 'movement', rule: r.rule, strikes: Math.round(r.strikes * 10) / 10, action: r.action });
    if (r.action === 'correct' || s.owner) {
      s.x = at.x; s.y = at.y; s.z = at.z;
      s.awaiting = { x: at.x, y: at.y, z: at.z, until: Date.now() + 1500 };
      this.match?.setPosition(s.id, s.x, s.y, s.z, s.yaw, s.pitch);
      this.send(s, { t: 'teleport', x: at.x, y: at.y, z: at.z });
      this.guard!.reset(s.id, at.x, at.y, at.z, Date.now() / 1000);
      return;
    }
    if (r.action === 'ban' && !s.op) {
      metrics.cheatBans++;
      this.banByAnticheat(s, `anti-cheat (${r.rule})`);
      return;
    }
    metrics.cheatKicks++;
    this.broadcast({ t: 'chat', from: '', text: `${s.name} was kicked by the anti-cheat`, system: true });
    this.kickSession(s, `Kicked by the anti-cheat (${r.rule}). Lagging? Check your connection.`);
  }

  /** A name-only ban (no address: shared networks must not lock others out of the room). */
  private banByAnticheat(s: Session, reason: string): void {
    this.world.bans = this.world.bans!.filter((b) => lc(b.name) !== lc(s.name));
    this.world.bans.push({ name: s.name, reason, by: 'anti-cheat', at: Date.now() });
    this.dirty = true;
    this.logger.warn('cheat ban', { name: s.name, reason });
    this.broadcast({ t: 'chat', from: '', text: `${s.name} was banned by the anti-cheat`, system: true });
    this.kickSession(s, `You were banned: ${reason}`);
  }

  private onBlock(s: Session, m: Extract<ClientMessage, { t: 'block' }>): void {
    const { x, y, z, id, seq } = m;
    const meta = m.meta ?? 0;
    const reject = () => this.send(s, { t: 'reject', seq, x, y, z, id, meta });
    if (![x, y, z, id, meta].every(Number.isInteger)) return reject();
    if (!s.edits.take()) return reject();
    if (y < 1 || y > 127) return reject();
    if (id !== 0 && (!getBlockDef(id) || id === BLOCK.BEDROCK || id === BLOCK.UNLOADED)) return reject();
    if (!isValidMeta(id, meta)) return reject();
    // Saplings, sugar cane and cactus only where they can stand (the client checks the same rule).
    if (this.entities && needsSupport(id) && !plantCanStand(id, (a, b, c) => this.entities!.world.getBlock(a, b, c), x, y, z)) return reject();
    // Reach: distance from the player's eyes to the block centre.
    const d = Math.hypot(x + 0.5 - s.x, y + 0.5 - (s.y + 1.62), z + 0.5 - s.z);
    if (!s.hasPos || d > REACH) return reject();
    // Two players changed this block at the same moment: the one whose view is stale loses, and gets the server's
    // block back right after the reject (otherwise his screen keeps the other player's edit overwritten by his own).
    if (this.entities && typeof m.prev === 'number') {
      const current = this.entities.world.getBlock(x, y, z);
      if (current !== BLOCK.UNLOADED && current !== m.prev) {
        reject();
        return this.send(s, blockMessage(x, y, z, current, this.entities.world.getMeta(x, y, z)));
      }
    }
    if (this.entities && this.guarded()) {
      const w = this.entities.world;
      const raw = w.getBlock(x, y, z);
      const old = raw === BLOCK.UNLOADED ? BLOCK.AIR : raw;
      const oldMeta = raw === BLOCK.UNLOADED ? 0 : w.getMeta(x, y, z);
      // A placed block must come out of the inventory (or be crafted from it): no diamond ore out of nothing.
      if (!s.guard.authorizeEdit({ x, y, z }, old, oldMeta, id, meta, w.getBlock(x, y + 1, z))) {
        metrics.inventoryRejects++;
        this.logger.warn('unbacked place', { name: s.name, block: id, meta, mode: this.guardMode });
        if (this.guardMode === 'enforce') return reject();
      }
      // Breaking a block lets this player's client spawn its drop (see InventoryGuard.creditBreak).
      // The state byte matters: red wool drops red wool, a double slab two slabs.
      if (id === 0 && old > 0) s.guard.creditBreak(old, oldMeta);
    }
    this.entities?.setBlock(x, y, z, id, meta); // records the edit and updates what the mobs see
    this.broadcast(blockMessage(x, y, z, id, meta), s.id);
  }

  private onChat(s: Session, raw: string): void {
    if (!s.chat.take()) return;
    const text = sanitizeChat(String(raw ?? ''));
    if (!text) return;
    if (text.startsWith('/')) return this.command(s, text);
    this.log(`<${s.name}> ${text}`);
    this.broadcast({ t: 'chat', from: s.name, text });
  }

  /** Chat commands; permissions and arguments are checked in Commands.ts. */
  private command(s: Session, text: string): void {
    const actor: Actor = { name: s.name, op: s.op, owner: s.owner };
    runCommand(this.commandHost(), actor, text);
  }

  private cmdHost: CommandHost | null = null;

  /** The game as the command runner sees it. */
  private commandHost(): CommandHost {
    if (this.cmdHost) return this.cmdHost;
    const self = this;
    const target = (p: Session): Target => ({ name: p.name, op: p.op, owner: p.owner, x: p.x, y: p.y, z: p.z });
    const host: CommandHost = {
      get mod(): Moderation { return self.world as WorldData & Moderation; },
      get arcade() { return !!self.match; },
      setWeather: (kind, ticks) => {
        const parsed = parseWeatherCommand(ticks ? [kind, String(Math.ceil(ticks / 20))] : [kind]);
        if (self.match || !parsed) return false;
        self.weather.set(parsed.kind, parsed.ticks);
        return true;
      },
      get gameMode() { return self.world.gameMode; },
      get moderated() { return self.isModerated(); },
      online: () => [...self.sessions.values()].map(target),
      find: (name) => { const p = self.findSession(name); return p ? target(p) : null; },
      reply: (to, text) => { const p = self.findSession(to); if (p) self.send(p, { t: 'chat', from: '', text, system: true }); },
      broadcastSystem: (text) => self.broadcast({ t: 'chat', from: '', text, system: true }),
      say: (from, text) => self.broadcast({ t: 'chat', from, text }),
      kick: (name, reason) => { const p = self.findSession(name); if (p) self.kickSession(p, reason); },
      ban: (name, by, reason) => {
        const p = self.findSession(name);
        self.world.ipSalt ??= newToken();
        const ipHash = p && p.ip !== 'unknown' ? hashIp(p.ip, self.world.ipSalt) : undefined;
        self.world.bans = self.world.bans!.filter((b) => lc(b.name) !== lc(name));
        self.world.bans.push({ name, ...(ipHash ? { ipHash } : {}), reason: reason.slice(0, 100), by, at: Date.now() });
        self.dirty = true;
        self.save();
        self.logger.info('ban', { name, by });
        if (p) self.kickSession(p, `You were banned: ${reason}`);
      },
      unban: (name) => {
        const before = self.world.bans!.length;
        self.world.bans = self.world.bans!.filter((b) => lc(b.name) !== lc(name));
        if (self.world.bans.length === before) return false;
        self.dirty = true;
        self.save();
        return true;
      },
      setOp: (name, op) => {
        const ops = self.world.ops!;
        self.world.ops = op ? [...ops.filter((n) => n !== lc(name)), lc(name)] : ops.filter((n) => n !== lc(name));
        self.dirty = true;
        self.save();
        const p = self.findSession(name);
        if (p) {
          p.op = p.owner || (op && p.verified);
          self.send(p, { t: 'chat', from: '', text: op ? 'You are now an operator. Type /help for the commands you can use.' : 'You are no longer an operator.', system: true });
        }
        self.logger.info(op ? 'op' : 'deop', { name });
      },
      save: () => { self.dirty = true; self.save(); },
      teleport: (name, x, y, z) => {
        const p = self.findSession(name);
        if (!p) return;
        p.x = x; p.y = y; p.z = z;
        p.hasPos = true;
        p.awaiting = { x, y, z, until: Date.now() + 1500 };
        self.guard?.reset(p.id, x, y, z, Date.now() / 1000);
        self.send(p, { t: 'teleport', x, y, z });
      },
      setGameMode: (mode) => {
        self.world.gameMode = mode;
        self.entities?.setMode(mode);
        for (const p of self.sessions.values()) p.guard.trustNextState();
        self.dirty = true;
        self.broadcast({ t: 'gamemode', mode });
        self.opts.onMetaChange?.();
      },
      setTime: (time) => {
        self.world.time = time;
        self.broadcast({ t: 'time', time });
      },
      give: (name, itemId, count) => {
        const p = self.findSession(name);
        if (!p) return false;
        // Creative games do not check inventories; the client adds it like a pickup.
        self.send(p, { t: 'taken', id: -1, itemId, count });
        return true;
      },
      survival: self.survival ? {
        get difficulty() { return self.survival!.difficulty; },
        setDifficulty: (d) => {
          self.survival!.difficulty = d;
          self.entities?.setDifficulty(d);
          self.dirty = true;
          self.survival!.announce();
        },
        get rules() { return self.survival!.rules; },
        rulesChanged: () => {
          self.entities?.applyRules();
          self.dirty = true;
          self.survival!.announce();
        },
      } : undefined,
      setSpawnpoint: (name) => {
        const p = self.findSession(name);
        if (!p || !p.hasPos) return false;
        const bed = { x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100, z: Math.round(p.z * 100) / 100, point: true };
        self.storePlayer(p);
        const prev = self.playerRecord(p.name);
        if (prev) self.setPlayerRecord(p.name, { ...prev, bed });
        self.dirty = true;
        self.send(p, { t: 'spawnpoint', bed });
        return true;
      },
      effect: (name, action, effect, amp, ticks) => {
        const p = self.findSession(name);
        if (!p) return false;
        self.send(p, { t: 'effect', action, effect, amp, ticks });
        return true;
      },
      seed: () => self.world.seed,
      spawn: (name) => {
        const p = self.findSession(name);
        if (p) self.send(p, { t: 'teleport', ...self.world.spawn });
      },
    };
    this.cmdHost = host;
    return host;
  }

  // ---------------------------------------------------------------- tick

  private tick(): void {
    const t0 = performance.now();
    this.tickInner();
    if (this.sessions.size > 0) metrics.tick(performance.now() - t0);
  }

  private tickInner(): void {
    const now = Date.now();
    const dt = (now - this.lastTick) / 1000;
    this.lastTick = now;
    this.tickCount++;
    if (this.sessions.size > 0 && !this.match) {
      const rules = this.survival?.rules;
      if (!rules || rules.get('doDaylightCycle')) {
        const t = this.world.time + dt / DAY_SECONDS;
        if (t >= 1) { this.world.day = (this.world.day ?? 0) + Math.floor(t); this.dirty = true; }
        this.world.time = t % 1;
      }
      this.weather.timersFrozen = !!rules && !rules.get('doWeatherCycle');
      this.weather.advance(dt);
      if (this.weather.version !== this.weatherVersion) {
        this.weatherVersion = this.weather.version;
        this.broadcast(this.weatherMessage(false));
        this.dirty = true;
      }
      this.rollLightning();
    }
    if (this.sessions.size === 0) {
      // Nobody around: free the chunks and mobs (passive mobs respawn from the seed).
      if (this.entitiesActive) {
        this.entities?.clear();
        this.entitiesActive = false;
      }
      return;
    }
    this.entitiesActive = true;
    this.entities?.tick([...this.sessions.values()]);
    this.survival?.tick([...this.sessions.values()]);
    this.containers?.tick();
    if (this.match) {
      this.match.tick();
      if (this.tickCount % Math.round(PING_INTERVAL_SECONDS * this.tickHz) === 0) {
        for (const s of this.sessions.values()) {
          if (s.ws.readyState === s.ws.OPEN && s.pingSentAt === 0) { s.pingSentAt = Date.now(); s.ws.ping(); }
        }
      }
    }
    if (this.visibility && this.match && this.match.phase !== 'warmup' && this.match.phase !== 'ended') this.sendCulledSnapshots();
    else {
      const players: SnapshotEntry[] = [];
      for (const s of this.sessions.values()) {
        if (!s.hasPos) continue;
        players.push([s.id, round(s.x), round(s.y), round(s.z), round(s.yaw), round(s.pitch), s.flags, s.held]);
      }
      if (players.length > 0) this.broadcast({ t: 'snap', players });
    }
    if (this.tickCount % 100 === 0 && !this.match) this.broadcast({ t: 'time', time: this.world.time, day: this.world.day ?? 0 });
  }

  /** Arcade, live phase: every player gets only the enemies it may see (see anticheat/Visibility.ts). */
  private sendCulledSnapshots(): void {
    const vis = this.visibility!, match = this.match!;
    const now = Date.now() / 1000;
    const viewers = this.viewers;
    let n = 0;
    for (const s of this.sessions.values()) {
      const p = match.players.get(s.id);
      if (!s.hasPos || !p) continue;
      const v = viewers[n] ??= { id: 0, team: '', alive: false, x: 0, y: 0, z: 0, firedAt: -1e9 };
      v.id = s.id; v.team = p.team; v.alive = p.alive; v.x = s.x; v.y = s.y; v.z = s.z;
      v.firedAt = s.lastFireAt > 0 ? s.lastFireAt / 1000 : -1e9;
      vis.track(v, now);
      n++;
    }
    for (const r of this.sessions.values()) {
      if (r.ws.readyState !== r.ws.OPEN) continue;
      let rv: Viewer | null = null;
      for (let i = 0; i < n; i++) if (viewers[i].id === r.id) { rv = viewers[i]; break; }
      const players: SnapshotEntry[] = [];
      for (let i = 0; i < n; i++) {
        const v = viewers[i];
        if (v.id === r.id) continue;
        const s = this.sessions.get(v.id)!;
        const what = rv ? vis.select(rv, v, match.teams, now, this.staleAt) : Send.Fresh;
        if (what === Send.Fresh) players.push([s.id, round(s.x), round(s.y), round(s.z), round(s.yaw), round(s.pitch), s.flags, s.held]);
        else if (what === Send.Stale) {
          const a = this.staleAt;
          players.push([s.id, round(a.x), round(a.y), round(a.z), round(s.yaw), round(s.pitch), (s.flags & ~SNAP_FLAG_STALE) | SNAP_FLAG_STALE, s.held]);
        }
      }
      if (players.length > 0) this.send(r, { t: 'snap', players });
    }
  }

  /** The weather targets for the clients: flags as 0/1, they fade the level themselves. */
  private weatherMessage(snap: boolean): ServerMessage {
    const w = this.weather;
    return { t: 'weather', rain: w.raining ? 1 : 0, thunder: w.thundering ? 1 : 0, ticksToChange: w.ticksToChange, snap };
  }

  /** Thunderstorm: lightning near every player; the server picks the spot, everyone renders the same bolt. */
  private rollLightning(): void {
    const world = this.entities?.world;
    if (!world || this.weather.thunder < 0.9) return;
    for (const s of this.sessions.values()) {
      if (!s.hasPos || !this.weather.rollLightning(this.strikeRoll)) continue;
      const x = Math.floor(s.x + this.strikeRoll.dx), z = Math.floor(s.z + this.strikeRoll.dz);
      const y = world.surfaceY(x, z);
      if (y < 0) continue;
      this.entities!.lightning(x + 0.5, y + 1, z + 0.5);
      this.broadcast({ t: 'bolt', x: x + 0.5, y: y + 1, z: z + 0.5 });
    }
  }

  /** A client that lets too much outgoing data pile up is not reading: drop it instead of buffering without bound. */
  private overloaded(s: Session): boolean {
    if ((s.ws.bufferedAmount ?? 0) <= MAX_BUFFERED_BYTES) return false;
    s.ws.terminate(); // the 'close' handler logs the player out
    return true;
  }

  private send(s: Session, msg: ServerMessage): void {
    if (s.ws.readyState !== s.ws.OPEN || this.overloaded(s)) return;
    // A pickup the server approved is what lets the next inventory update contain the item.
    if (msg.t === 'taken' && msg.id >= 0) s.guard.creditPickup(msg.itemId, msg.count, msg.damage);
    // Using an item on a mob can hand one back (milking a cow gives a milk bucket).
    if (msg.t === 'mobused' && msg.give) s.guard.creditPickup(msg.give, 1);
    if (s.bin) {
      const frame = s.binq && msg.t === 'snap' ? encodeSnapQ(msg.players, 0, ARENA_FLOOR_Y, 0) : encodeBinary(msg);
      if (frame) {
        s.ws.send(frame);
        metrics.sent(frame.byteLength);
        return;
      }
    }
    const data = JSON.stringify(msg);
    s.ws.send(data);
    metrics.sent(data.length);
  }

  private broadcast(msg: ServerMessage, except = -1): void {
    const data = JSON.stringify(msg);
    let frame: ArrayBuffer | null | undefined;
    let frameQ: ArrayBuffer | undefined;
    for (const s of this.sessions.values()) {
      if (s.id === except || s.ws.readyState !== s.ws.OPEN || this.overloaded(s)) continue;
      if (s.binq && msg.t === 'snap') {
        frameQ ??= encodeSnapQ(msg.players, 0, ARENA_FLOOR_Y, 0);
        s.ws.send(frameQ);
        metrics.sent(frameQ.byteLength);
        continue;
      }
      if (s.bin && (msg.t === 'snap' || msg.t === 'ent')) {
        frame ??= msg.t === 'snap' ? encodeSnap(msg.players) : encodeBinary(msg);
        if (frame) {
          s.ws.send(frame);
          metrics.sent(frame.byteLength);
          continue;
        }
      }
      s.ws.send(data);
      metrics.sent(data.length);
    }
  }
}

/** Saved inventory: at most 64 rows of at most 8 finite numbers; anything else is dropped. */
export function cleanInventory(raw: unknown[]): number[][] {
  const out: number[][] = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length > 16) { out.push([]); continue; }
    out.push(row.map((n) => (typeof n === 'number' && Number.isFinite(n) ? n : 0)));
  }
  return out;
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

export function parseGameMode(v: string | undefined): GameMode {
  return GAME_MODES.includes(v as GameMode) ? (v as GameMode) : 'survival';
}

/** Numbers of item data a client may send with a stack (enchantments, repair cost and a custom name). */
const MAX_ITEM_DATA = 40;

/** Enchantments a client sent with an attack or shot (key/level pairs): decoded and clamped to real levels. */
function enchantData(raw: unknown): Record<string, number> | undefined {
  if (!Array.isArray(raw)) return undefined;
  return enchantsOf(decodeData(raw.slice(0, MAX_ITEM_DATA).map(Number)));
}
