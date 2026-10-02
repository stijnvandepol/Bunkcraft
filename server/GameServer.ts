import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import {
  type ClientMessage, NAME_PATTERN, PROTOCOL_VERSION, type PlayerRecord, type ServerMessage, type SnapshotEntry, sanitizeChat,
} from '../src/net/protocol';
import { GAME_MODES, type GameMode } from '../src/player/GameMode';
import { BLOCK, getBlockDef } from '../src/world/BlockRegistry';
import { SEA_LEVEL } from '../src/world/constants';
import { hashString } from '../src/world/Noise';
import { TerrainGenerator } from '../src/world/TerrainGenerator';

const TICK_MS = 50; // 20 ticks per second, like Minecraft
const DAY_SECONDS = 1200;
const SAVE_INTERVAL_MS = 30_000;
const REACH = 8; // lenient server-side reach check (client uses 5)
const MAX_SPEED = 26; // blocks/second (fast flying + slack)

interface WorldData {
  name: string;
  seed: number;
  gameMode: GameMode;
  time: number;
  spawn: { x: number; y: number; z: number };
  /** "x,y,z" → block id */
  edits: Record<string, number>;
  players: Record<string, PlayerRecord>;
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
  chat: Bucket;
  moves: Bucket;
  violations: number;
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

  constructor(private readonly opts: ServerOptions) {
    mkdirSync(opts.dataDir, { recursive: true });
    this.file = join(opts.dataDir, 'world.json');
    this.world = this.load();
    this.timers.push(setInterval(() => this.tick(), TICK_MS));
    this.timers.push(setInterval(() => this.save(), SAVE_INTERVAL_MS));
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
    const spawn = this.findSpawn(seed);
    const data: WorldData = {
      name: this.opts.worldName, seed, gameMode: this.opts.gameMode, time: 0.08, spawn, edits: {}, players: {},
    };
    this.log(`[world] created "${data.name}" (seed ${seed}, ${data.gameMode}) spawn ${spawn.x} ${spawn.y} ${spawn.z}`);
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

  info(): { name: string; gameMode: GameMode; players: number; maxPlayers: number } {
    return { name: this.world.name, gameMode: this.world.gameMode, players: this.sessions.size, maxPlayers: this.opts.maxPlayers };
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

    const record = this.world.players[name] ?? null;
    const start = record ?? this.world.spawn;
    const session: Session = {
      id: this.nextId++, name, ws,
      x: start.x, y: start.y, z: start.z, yaw: 0, pitch: 0, flags: 0, held: 0,
      hasPos: false, lastPosTime: Date.now(),
      edits: new Bucket(20, 40), chat: new Bucket(1, 5), moves: new Bucket(40, 80), violations: 0,
    };
    const edits: number[] = [];
    for (const [key, id] of Object.entries(this.world.edits)) {
      const [x, y, z] = key.split(',').map(Number);
      edits.push(x, y, z, id);
    }
    this.send(session, {
      t: 'welcome', id: session.id, worldName: this.world.name, seed: this.world.seed, gameMode: this.world.gameMode,
      time: this.world.time, spawn: this.world.spawn, edits, player: record,
      players: [...this.sessions.values()].map((s) => ({ id: s.id, name: s.name })),
      motd: this.opts.motd,
    });
    this.sessions.set(session.id, session);
    this.broadcast({ t: 'join', id: session.id, name }, session.id);
    this.broadcast({ t: 'chat', from: '', text: `${name} joined the game`, system: true });
    this.log(`[join] ${name} (${this.sessions.size} online)`);
    return session;
  }

  private logout(s: Session): void {
    if (!this.sessions.has(s.id)) return;
    this.storePlayer(s);
    this.sessions.delete(s.id);
    this.broadcast({ t: 'leave', id: s.id, name: s.name });
    this.broadcast({ t: 'chat', from: '', text: `${s.name} left the game`, system: true });
    this.log(`[leave] ${s.name} (${this.sessions.size} online)`);
  }

  private storePlayer(s: Session): void {
    if (!s.hasPos) return;
    const prev = this.world.players[s.name];
    this.world.players[s.name] = { ...prev, x: s.x, y: s.y, z: s.z, yaw: s.yaw, pitch: s.pitch };
    this.dirty = true;
  }

  // ---------------------------------------------------------------- messages

  private handle(s: Session, msg: ClientMessage): void {
    switch (msg.t) {
      case 'pos': return this.onPos(s, msg);
      case 'block': return this.onBlock(s, msg);
      case 'chat': return this.onChat(s, msg.text);
      case 'state':
        if (Array.isArray(msg.inventory) && msg.inventory.length <= 64 && Array.isArray(msg.stats) && msg.stats.length <= 8) {
          const prev = this.world.players[s.name] ?? { x: s.x, y: s.y, z: s.z, yaw: s.yaw, pitch: s.pitch };
          this.world.players[s.name] = { ...prev, inventory: msg.inventory, stats: msg.stats };
          this.dirty = true;
        }
        return;
    }
  }

  private onPos(s: Session, m: Extract<ClientMessage, { t: 'pos' }>): void {
    if (!s.moves.take()) return;
    const nums = [m.x, m.y, m.z, m.yaw, m.pitch];
    if (nums.some((n) => typeof n !== 'number' || !Number.isFinite(n))) return;
    const now = Date.now();
    if (s.hasPos) {
      // Movement sanity check: reject impossible speeds and snap the player back.
      const dt = Math.max(0.05, (now - s.lastPosTime) / 1000);
      const dist = Math.hypot(m.x - s.x, m.z - s.z);
      if (dist > MAX_SPEED * dt + 4 && m.y > -60) {
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
  }

  private onBlock(s: Session, m: Extract<ClientMessage, { t: 'block' }>): void {
    const { x, y, z, id, seq } = m;
    const reject = () => this.send(s, { t: 'reject', seq, x, y, z, id });
    if (![x, y, z, id].every(Number.isInteger)) return reject();
    if (!s.edits.take()) return reject();
    if (y < 1 || y > 127) return reject();
    if (id !== 0 && (!getBlockDef(id) || id === BLOCK.BEDROCK || id === BLOCK.UNLOADED)) return reject();
    // Reach: distance from the player's eyes to the block centre.
    const d = Math.hypot(x + 0.5 - s.x, y + 0.5 - (s.y + 1.62), z + 0.5 - s.z);
    if (!s.hasPos || d > REACH) return reject();
    const key = `${x},${y},${z}`;
    this.world.edits[key] = id;
    this.dirty = true;
    this.broadcast({ t: 'block', x, y, z, id }, s.id);
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
        return this.send(s, { t: 'teleport', ...this.world.spawn });
      case 'time': {
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
    if (this.sessions.size > 0) this.world.time = (this.world.time + dt / DAY_SECONDS) % 1;
    if (this.sessions.size === 0) return;
    const players: SnapshotEntry[] = [];
    for (const s of this.sessions.values()) {
      if (!s.hasPos) continue;
      players.push([s.id, round(s.x), round(s.y), round(s.z), round(s.yaw), round(s.pitch), s.flags, s.held]);
    }
    if (players.length > 0) this.broadcast({ t: 'snap', players });
    if (this.tickCount % 100 === 0) this.broadcast({ t: 'time', time: this.world.time });
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
