import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import {
  type ClientMessage, NAME_PATTERN, PROTOCOL_VERSION, type PlayerRecord, type ServerMessage, type SnapshotEntry, sanitizeChat,
} from '../src/net/protocol';
import { ARENA_FLOOR_Y, DEFAULT_MAP, type MapId, type MapSetting, getMap, nextMap, parseMapId, parseMapSetting } from '../src/modes/maps';
import { type GameType, gameTypeDef } from '../src/modes/GameTypes';
import { GAME_MODES, type GameMode } from '../src/player/GameMode';
import { BLOCK, getBlockDef } from '../src/world/BlockRegistry';
import { isValidMeta } from '../src/world/BlockShapes';
import { packState, stateId, stateMeta } from '../src/world/BlockStates';
import { SEA_LEVEL } from '../src/world/constants';
import { hashString } from '../src/world/Noise';
import { arenaWorldType } from '../src/world/WorldGenerator';
import { TerrainGenerator } from '../src/world/TerrainGenerator';
import { Match, type MatchHost } from './Match';
import { ServerEntities } from './ServerEntities';
import { ServerWorld } from './ServerWorld';

const TICK_MS = 50; // 20 ticks per second, like Minecraft
const DAY_SECONDS = 1200;
const SAVE_INTERVAL_MS = 30_000;
const REACH = 8; // lenient server-side reach check (client uses 5)
const MAX_SPEED = 26; // blocks/second (fast flying + slack)
const ARENA_MAX_SPEED = 40; // arcade: sprint + jump + slack
const PING_INTERVAL_TICKS = 60; // arcade: measure the round trip every 3 s
/** Block changes per 'blocks' message (flowing water). */
const BLOCKS_PER_MESSAGE = 100;
const ARENA_DAY = 0.25; // arcade games are always noon

interface WorldData {
  name: string;
  seed: number;
  gameMode: GameMode;
  time: number;
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
}

/** Block change message; the meta field is left out for the default state to keep the common case small. */
function blockMessage(x: number, y: number, z: number, id: number, meta: number): Extract<ServerMessage, { t: 'block' }> {
  return meta ? { t: 'block', x, y, z, id, meta } : { t: 'block', x, y, z, id };
}

/** Token bucket rate limiter (per player, per message kind). */
class Bucket {
  private tokens: number;
  private last = Date.now();
  constructor(private readonly rate: number, private readonly burst: number) {
    this.tokens = burst;
  }
  take(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < 1) return false;
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
  /** Arcade: fire, reload, weapon and loadout requests. */
  fires: Bucket;
  actions: Bucket;
  violations: number;
  /** Round trip in ms (WebSocket ping/pong, arcade games). */
  pingMs: number;
  pingSentAt: number;
  /** After a server-side move (spawn) positions from before it are ignored until the client arrives. */
  awaiting: { x: number; y: number; z: number; until: number } | null;
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
  private timers: NodeJS.Timeout[] = [];
  /** Mobs, items, arrows and TNT for this world. */
  private readonly entities: ServerEntities | null;
  private entitiesActive = false;
  /** Arcade games: the match and the arena as bullets see it. */
  private readonly match: Match | null = null;
  private arena: ServerWorld | null = null;
  /** Arcade: the map setting of this game ("rotate" moves on to the next map after every match). */
  private mapSetting: MapSetting = DEFAULT_MAP;

  constructor(private readonly opts: ServerOptions) {
    mkdirSync(opts.dataDir, { recursive: true });
    this.file = join(opts.dataDir, 'world.json');
    this.world = this.load();
    const def = gameTypeDef(this.world.gameType ?? 'minecraft');
    if (def.arcade) {
      this.mapSetting = parseMapSetting(this.world.mapId) ?? DEFAULT_MAP;
      const first: MapId = parseMapId(this.mapSetting) ?? DEFAULT_MAP;
      this.loadArena(first);
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
    }, () => this.world.time);
    this.timers.push(setInterval(() => this.tick(), TICK_MS));
    this.timers.push(setInterval(() => this.save(), SAVE_INTERVAL_MS));
  }

  /** The bullets' copy of the arena of a map. */
  private loadArena(map: MapId): void {
    this.arena = new ServerWorld(this.world.seed, {}, arenaWorldType(map));
    this.arena.preloadArena();
  }

  private load(): WorldData {
    if (existsSync(this.file)) {
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as WorldData;
      this.log(`[world] loaded "${data.name}" (seed ${data.seed}, ${Object.keys(data.edits).length} edits, ${Object.keys(data.players).length} players)`);
      return data;
    }
    const seedText = this.opts.seed;
    const seed = !seedText ? (Math.random() * 4294967296) >>> 0
      : /^-?\d+$/.test(seedText) ? Number(BigInt.asUintN(32, BigInt(seedText))) : hashString(seedText);
    const def = gameTypeDef(this.opts.gameType ?? 'minecraft');
    const mapSetting = parseMapSetting(this.opts.mapId) ?? DEFAULT_MAP;
    const spawn = def.arcade ? getMap(parseMapId(mapSetting) ?? DEFAULT_MAP).spawns.ffa[0] : this.findSpawn(seed);
    const data: WorldData = {
      name: this.opts.worldName, seed, gameMode: this.opts.gameMode, time: def.arcade ? ARENA_DAY : 0.08, spawn, edits: {}, players: {},
    };
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

  /** Same dry-land spawn search as the client, using the shared terrain generator. */
  private findSpawn(seed: number): { x: number; y: number; z: number } {
    const gen = new TerrainGenerator(seed);
    for (let r = 0; r < 2000; r += 8) {
      const steps = Math.max(1, Math.floor((r * Math.PI * 2) / 16));
      for (let s = 0; s < steps; s++) {
        const a = (s / steps) * Math.PI * 2;
        const x = Math.round(Math.cos(a) * r), z = Math.round(Math.sin(a) * r);
        const h = gen.heightAt(x, z);
        if (h > SEA_LEVEL + 2 && h < 85) return { x: x + 0.5, y: Math.floor(h) + 2, z: z + 0.5 };
      }
    }
    return { x: 0.5, y: 100, z: 0.5 };
  }

  save(): void {
    for (const s of this.sessions.values()) this.storePlayer(s);
    if (!this.dirty) return;
    const tmp = `${this.file}.tmp`;
    // Write-then-rename so a crash never leaves a half-written world file.
    writeFileSync(tmp, JSON.stringify(this.world));
    renameSync(tmp, this.file);
    this.dirty = false;
  }

  shutdown(): void {
    this.timers.forEach(clearInterval);
    for (const s of this.sessions.values()) this.send(s, { t: 'kick', reason: 'Server closed' });
    this.dirty = true;
    this.save();
  }

  get playerCount(): number {
    return this.sessions.size;
  }

  info(): {
    name: string; gameMode: GameMode; players: number; maxPlayers: number; gameType: GameType; scoreLimit: number; timeLimitSec: number;
    /** Arcade: the map setting (a map id or "rotate"). */
    map?: MapSetting;
  } {
    return {
      name: this.world.name, gameMode: this.world.gameMode, players: this.sessions.size, maxPlayers: this.opts.maxPlayers,
      gameType: this.match?.info.type ?? 'minecraft', scoreLimit: this.match?.info.scoreLimit ?? 0, timeLimitSec: this.match?.info.timeLimitSec ?? 0,
      ...(this.match ? { map: this.mapSetting } : {}),
    };
  }

  /** The match's view of this server: clock, messages, bullets' world and moving players. */
  private matchHost(): MatchHost {
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
      },
      random: Math.random,
      ping: (id) => this.sessions.get(id)?.pingMs ?? 0,
      nextMap: (current) => {
        if (this.mapSetting !== 'rotate') return null;
        const next = nextMap(parseMapId(current) ?? DEFAULT_MAP);
        this.loadArena(next);
        return next;
      },
    };
  }

  private log(line: string): void {
    if (!this.opts.quiet) console.log(line);
  }

  // ---------------------------------------------------------------- connections

  accept(ws: WebSocket): void {
    let session: Session | null = null;
    const timeout = setTimeout(() => ws.close(1008, 'No hello'), 10_000);
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        ws.close(1003, 'Bad message');
        return;
      }
      if (!session) {
        if (msg.t !== 'hello') return;
        clearTimeout(timeout);
        session = this.login(ws, msg.name, msg.v);
        return;
      }
      this.handle(session, msg);
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

  private login(ws: WebSocket, rawName: string, version: number): Session | null {
    const kick = (reason: string) => {
      ws.send(JSON.stringify({ t: 'kick', reason } satisfies ServerMessage));
      ws.close(1008, reason);
      return null;
    };
    if (version !== PROTOCOL_VERSION) return kick(`Outdated client (server protocol ${PROTOCOL_VERSION})`);
    const name = String(rawName ?? '');
    if (!NAME_PATTERN.test(name)) return kick('Invalid name (3–16 letters, digits or _)');
    // Logging in again from elsewhere replaces the old session, like Minecraft.
    for (const s of this.sessions.values()) {
      if (s.name.toLowerCase() === name.toLowerCase()) {
        this.send(s, { t: 'kick', reason: 'You logged in from another location' });
        s.ws.close();
        this.logout(s);
      }
    }
    if (this.sessions.size >= this.opts.maxPlayers) return kick('The server is full');

    const record = this.match ? null : this.world.players[name] ?? null;
    const start = record ?? this.world.spawn;
    const session: Session = {
      id: this.nextId++, name, ws,
      x: start.x, y: start.y, z: start.z, yaw: 0, pitch: 0, flags: 0, held: 0,
      hasPos: false, lastPosTime: Date.now(),
      edits: new Bucket(20, 40), attacks: new Bucket(8, 12), shots: new Bucket(3, 5), drops: new Bucket(30, 60), takes: new Bucket(20, 30),
      chat: new Bucket(1, 5), moves: new Bucket(40, 80), fires: new Bucket(25, 30), actions: new Bucket(15, 30), violations: 0,
      pingMs: 0, pingSentAt: 0, awaiting: null,
    };
    const joined = this.match?.join(session.id, name) ?? null;
    if (joined) { session.x = joined.x; session.y = joined.y; session.z = joined.z; session.hasPos = true; }
    const edits: number[] = [];
    for (const [key, state] of Object.entries(this.world.edits)) {
      const [x, y, z] = key.split(',').map(Number);
      edits.push(x, y, z, stateId(state), stateMeta(state));
    }
    this.send(session, {
      t: 'welcome', id: session.id, worldName: this.world.name, seed: this.world.seed, gameMode: this.world.gameMode,
      gameType: this.match?.info.type ?? 'minecraft', worldType: this.match ? 'arena' : 'terrain', match: this.match?.info,
      time: this.world.time, spawn: joined ? { x: joined.x, y: joined.y, z: joined.z } : this.world.spawn, edits, player: record,
      players: [...this.sessions.values()].map((s) => ({ id: s.id, name: s.name, team: this.match?.players.get(s.id)?.team || undefined })),
      motd: this.opts.motd,
    });
    this.sessions.set(session.id, session);
    this.broadcast({ t: 'join', id: session.id, name }, session.id);
    if (joined) {
      session.awaiting = { x: joined.x, y: joined.y, z: joined.z, until: Date.now() + 1500 };
      this.match!.ready(session.id);
    }
    this.broadcast({ t: 'chat', from: '', text: `${name} joined the game`, system: true });
    this.log(`[join] ${name} (${this.sessions.size} online)`);
    return session;
  }

  private logout(s: Session): void {
    if (!this.sessions.has(s.id)) return;
    this.storePlayer(s);
    this.sessions.delete(s.id);
    this.entities?.forget(s.id);
    this.match?.leave(s.id);
    this.broadcast({ t: 'leave', id: s.id, name: s.name });
    this.broadcast({ t: 'chat', from: '', text: `${s.name} left the game`, system: true });
    this.log(`[leave] ${s.name} (${this.sessions.size} online)`);
  }

  private storePlayer(s: Session): void {
    if (!s.hasPos || this.match) return;
    const prev = this.world.players[s.name];
    this.world.players[s.name] = { ...prev, x: s.x, y: s.y, z: s.z, yaw: s.yaw, pitch: s.pitch };
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
      case 'attack': return void (s.attacks.take() && entities.attack(s, Number(msg.id)));
      case 'shoot':
        return void (s.shots.take() && entities.shoot(s, msg.x, msg.y, msg.z, msg.dx, msg.dy, msg.dz, msg.power));
      case 'ignite': return void (s.edits.take() && entities.ignite(s, msg.x, msg.y, msg.z));
      case 'take': return void (s.takes.take() && entities.take(s, Number(msg.id)));
      case 'drop':
        return void (s.drops.take() && entities.drop(s, { id: msg.id, count: msg.count, damage: msg.damage }, msg.x, msg.y, msg.z, msg.yaw, msg.delay));
      case 'state':
        if (Array.isArray(msg.inventory) && msg.inventory.length <= 64 && Array.isArray(msg.stats) && msg.stats.length <= 8) {
          const prev = this.world.players[s.name] ?? { x: s.x, y: s.y, z: s.z, yaw: s.yaw, pitch: s.pitch };
          this.world.players[s.name] = { ...prev, inventory: msg.inventory, stats: msg.stats };
          this.dirty = true;
        }
        return;
    }
  }

  /** Arcade games: movement, chat and the weapon messages; building, mobs and items do not exist. */
  private handleArcade(s: Session, msg: ClientMessage, match: Match): void {
    switch (msg.t) {
      case 'pos': return this.onPos(s, msg);
      case 'chat': return this.onChat(s, msg.text);
      case 'fire': return void (s.fires.take() && match.fire(s.id, msg));
      case 'reload': return void (s.actions.take() && match.reload(s.id, Number(msg.slot)));
      case 'weapon': return void (s.actions.take() && match.switchWeapon(s.id, Number(msg.slot)));
      case 'loadout': return void (s.actions.take() && match.setLoadout(s.id, String(msg.primary)));
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
    const now = Date.now();
    if (s.awaiting) {
      // We moved this player (spawn): ignore positions from before the client got the message.
      const a = s.awaiting;
      if (Math.hypot(m.x - a.x, m.z - a.z) <= 2.5 && Math.abs(m.y - a.y) <= 3) {
        s.awaiting = null;
      } else {
        if (now > a.until) {
          a.until = now + 1500;
          this.send(s, { t: 'teleport', x: a.x, y: a.y, z: a.z });
        }
        return;
      }
    }
    if (this.match) {
      // Arcade: inside the arena, on or above the floor.
      if (!this.match.inBounds(m.x, m.z) || m.y < ARENA_FLOOR_Y - 2 || m.y > ARENA_FLOOR_Y + 40) {
        if (++s.violations > 3) this.send(s, { t: 'teleport', x: s.x, y: s.y, z: s.z });
        return;
      }
    }
    if (s.hasPos) {
      // Movement sanity check: reject impossible speeds and snap the player back.
      const dt = Math.max(0.05, (now - s.lastPosTime) / 1000);
      const dist = Math.hypot(m.x - s.x, m.z - s.z);
      if (dist > (this.match ? ARENA_MAX_SPEED : MAX_SPEED) * dt + 4 && m.y > -60) {
        if (++s.violations > 3) this.send(s, { t: 'teleport', x: s.x, y: s.y, z: s.z });
        return;
      }
    }
    s.violations = Math.max(0, s.violations - 1);
    s.x = m.x; s.y = m.y; s.z = m.z;
    s.yaw = m.yaw; s.pitch = m.pitch;
    s.flags = m.flags | 0; s.held = m.held | 0;
    s.hasPos = true;
    s.lastPosTime = now;
    this.match?.setPosition(s.id, s.x, s.y, s.z, s.yaw, s.pitch);
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
    // Reach: distance from the player's eyes to the block centre.
    const d = Math.hypot(x + 0.5 - s.x, y + 0.5 - (s.y + 1.62), z + 0.5 - s.z);
    if (!s.hasPos || d > REACH) return reject();
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

  /** A few vanilla-style commands. */
  private command(s: Session, text: string): void {
    const [cmd, ...args] = text.slice(1).split(/\s+/);
    const reply = (t: string) => this.send(s, { t: 'chat', from: '', text: t, system: true });
    switch (cmd.toLowerCase()) {
      case 'help':
        return reply('Commands: /list, /time set day|noon|night|midnight, /spawn, /seed');
      case 'list':
        return reply(`${this.sessions.size} online: ${[...this.sessions.values()].map((p) => p.name).join(', ')}`);
      case 'seed':
        return reply(`Seed: [${this.world.seed}]`);
      case 'spawn':
        if (this.match) return reply('Not available in this game type');
        return this.send(s, { t: 'teleport', ...this.world.spawn });
      case 'time': {
        if (this.match) return reply('The time is fixed in this game type');
        const times: Record<string, number> = { day: 0.04, noon: 0.25, night: 0.55, midnight: 0.75 };
        if (args[0] === 'set' && args[1] in times) {
          this.world.time = times[args[1]];
          this.broadcast({ t: 'time', time: this.world.time });
          this.broadcast({ t: 'chat', from: '', text: `${s.name} set the time to ${args[1]}`, system: true });
          return;
        }
        return reply('Usage: /time set day|noon|night|midnight');
      }
      default:
        return reply(`Unknown command: /${cmd}. Type /help for help.`);
    }
  }

  // ---------------------------------------------------------------- tick

  private tick(): void {
    const now = Date.now();
    const dt = (now - this.lastTick) / 1000;
    this.lastTick = now;
    this.tickCount++;
    if (this.sessions.size > 0 && !this.match) this.world.time = (this.world.time + dt / DAY_SECONDS) % 1;
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
    if (this.match) {
      this.match.tick();
      if (this.tickCount % PING_INTERVAL_TICKS === 0) {
        for (const s of this.sessions.values()) {
          if (s.ws.readyState === s.ws.OPEN && s.pingSentAt === 0) { s.pingSentAt = Date.now(); s.ws.ping(); }
        }
      }
    }
    const players: SnapshotEntry[] = [];
    for (const s of this.sessions.values()) {
      if (!s.hasPos) continue;
      players.push([s.id, round(s.x), round(s.y), round(s.z), round(s.yaw), round(s.pitch), s.flags, s.held]);
    }
    if (players.length > 0) this.broadcast({ t: 'snap', players });
    if (this.tickCount % 100 === 0 && !this.match) this.broadcast({ t: 'time', time: this.world.time });
  }

  private send(s: Session, msg: ServerMessage): void {
    if (s.ws.readyState === s.ws.OPEN) s.ws.send(JSON.stringify(msg));
  }

  private broadcast(msg: ServerMessage, except = -1): void {
    const data = JSON.stringify(msg);
    for (const s of this.sessions.values()) {
      if (s.id !== except && s.ws.readyState === s.ws.OPEN) s.ws.send(data);
    }
  }
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

export function parseGameMode(v: string | undefined): GameMode {
  return GAME_MODES.includes(v as GameMode) ? (v as GameMode) : 'survival';
}
