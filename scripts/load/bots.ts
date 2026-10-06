/**
 * Load-test bots: protocol-level players (no browser) that behave like real ones.
 *
 * - SurvivalBot walks over the real terrain (a mirror ServerWorld per room: same generator, same edits),
 *   with gravity and jumps, mines the block in front of it, drops and picks up the item like the client
 *   does, places blocks back, sends its inventory, chats now and then and fights mobs from the `ent` frames.
 * - ArenaBot walks between free cells of the arena map, keeps track of the other players from `snap`,
 *   fires at visible enemies at the weapon's rate, reloads, picks loadouts.
 *
 * Both negotiate binary snap/ent frames (`bin: true`), send `pos` at 20 Hz like NetClient and measure
 * latencies (ping/pong, chat echo, take→taken, fire→shot, edit propagation, snap gaps) into a Stats.
 */
import { WebSocket } from 'ws';
import { ARENA_FLOOR_Y, type ArenaMap, getMap } from '../../src/modes/maps';
import { PRIMARY_WEAPONS, fireInterval, weaponDef } from '../../src/modes/Weapons';
import { decodeBinary } from '../../src/net/binary';
import { type ClientMessage, type MobEntry, PROTOCOL_VERSION, type ServerMessage, type SnapshotEntry } from '../../src/net/protocol';
import { blockDrop, getItemDef } from '../../src/items/ItemRegistry';
import { BLOCK, getBlockDef } from '../../src/world/BlockRegistry';
import { traceBlocks } from '../../server/Combat';
import { type AABB, boxIntersectsSolid } from '../../src/player/Collision';
import { ServerWorld } from '../../server/ServerWorld';
import type { Stats } from './stats';

const POS_INTERVAL_MS = 50;
const WALK = 4.317;
const SPRINT = 5.612;
const GRAVITY = 32;
const JUMP_V = 8.4;
const REACH = 4.5;
const TAKE_REACH = 2.2;
const HOSTILE_FROM = 4; // NET_MOB_KINDS index of the first hostile mob (zombie)

export interface RoomSpec {
  code: string;
  ownerToken: string;
  kind: 'survival' | 'arena';
}

/** Shared per room inside one bot process: the mirror world and the edit-latency bookkeeping. */
export class RoomCtx {
  world: ServerWorld | null = null;
  arena: { map: ArenaMap; variant: number } | null = null;
  readonly bots: Bot[] = [];
  /** "x,y,z,id" → send time and how many other bots still have to see it. */
  readonly pendingEdits = new Map<string, { t: number; left: number }>();
  private lastUpdate = 0;

  constructor(readonly spec: RoomSpec, readonly stats: Stats) {}

  init(welcome: Extract<ServerMessage, { t: 'welcome' }>): void {
    if (this.world || this.arena) return;
    if (welcome.worldType === 'arena') {
      const map = getMap(welcome.match?.map ?? 'classic');
      this.arena = { map, variant: map.variantFor(welcome.seed) };
      return;
    }
    const edits: Record<string, number> = {};
    for (let i = 0; i + 4 < welcome.edits.length; i += 5) {
      const [x, y, z, id, meta] = welcome.edits.slice(i, i + 5);
      edits[`${x},${y},${z}`] = id | (meta << 8);
    }
    this.world = new ServerWorld(welcome.seed, edits, 'terrain', welcome.genVersion ?? 1);
  }

  /** Keeps the chunks around the bots loaded (a few times a second is plenty for walking). */
  maintain(now: number): void {
    if (!this.world || now - this.lastUpdate < 200) return;
    this.lastUpdate = now;
    const centers = this.bots.filter((b) => b.joined).map((b) => ({ x: b.x, z: b.z }));
    if (centers.length) this.world.update(centers);
    for (const [k, v] of this.pendingEdits) if (now - v.t > 10_000) this.pendingEdits.delete(k);
  }

  /** Surface height (top solid block) or −1 while the chunk is not generated yet. */
  ground(x: number, z: number): number {
    if (this.arena) return this.arena.map.heightAt(this.arena.variant, Math.floor(x), Math.floor(z));
    return this.world ? this.world.surfaceY(Math.floor(x), Math.floor(z)) : -1;
  }

  sentEdit(x: number, y: number, z: number, id: number): void {
    const others = this.bots.filter((b) => b.joined).length - 1;
    if (others > 0) this.pendingEdits.set(`${x},${y},${z},${id}`, { t: performance.now(), left: others });
  }

  sawEdit(x: number, y: number, z: number, id: number): void {
    const key = `${x},${y},${z},${id}`;
    const p = this.pendingEdits.get(key);
    if (!p) return;
    this.stats.hist.edit.add(performance.now() - p.t);
    if (--p.left <= 0) this.pendingEdits.delete(key);
  }
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

export abstract class Bot {
  id = 0;
  joined = false;
  x = 0; y = 0; z = 0;
  vy = 0;
  yaw = 0; pitch = 0;
  onGround = false;
  sprint = false;
  held = 0;
  protected ws: WebSocket | null = null;
  private posTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private pingAt = 0;
  private lastSnap = 0;
  private chatPending: { text: string; t: number } | null = null;
  private nextChat = 0;
  protected target: [number, number] | null = null;
  private stuck = 0;
  private closing = false;

  constructor(readonly room: RoomCtx, readonly name: string, readonly owner: boolean, private readonly xff: string) {}

  get stats(): Stats { return this.room.stats; }

  connect(base: string): Promise<void> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws/${this.room.spec.code}`, { headers: { 'x-forwarded-for': this.xff } });
      this.ws = ws;
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      const failTimer = setTimeout(() => { if (!this.joined) { this.stats.inc('connectFail'); done(); } }, 30_000);
      ws.on('open', () => {
        this.send({ t: 'hello', v: PROTOCOL_VERSION, name: this.name, bin: true, key: `loadtest-key-${this.name}`, ...(this.owner ? { owner: this.room.spec.ownerToken } : {}) });
      });
      ws.on('message', (raw: Buffer, isBinary: boolean) => {
        this.stats.inc('msgIn');
        this.stats.inc('bytesIn', raw.length);
        let m: ServerMessage | null;
        if (isBinary) {
          this.stats.inc('binIn');
          m = decodeBinary(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer);
        } else m = JSON.parse(raw.toString()) as ServerMessage;
        if (!m) return;
        if (m.t === 'welcome') {
          clearTimeout(failTimer);
          this.onWelcome(m);
          done();
          return;
        }
        this.onMessage(m);
      });
      ws.on('pong', () => {
        if (this.pingAt) this.stats.hist.rtt.add(performance.now() - this.pingAt);
        this.pingAt = 0;
      });
      ws.on('error', () => { this.stats.inc('wsError'); });
      ws.on('close', () => {
        clearTimeout(failTimer);
        if (!this.closing) {
          if (this.joined) this.stats.inc('closedUnexpected'); else this.stats.inc('connectFail');
        }
        this.stop();
        done();
      });
    });
  }

  private onWelcome(m: Extract<ServerMessage, { t: 'welcome' }>): void {
    this.id = m.id;
    this.joined = true;
    this.stats.inc('joined');
    this.room.init(m);
    const start = m.player ?? m.spawn;
    this.x = start.x; this.y = start.y; this.z = start.z;
    this.nextChat = performance.now() + rand(5_000, 60_000);
    this.welcome(m);
    // Spread the 20 Hz position updates of all bots over the interval, like independent clients.
    setTimeout(() => {
      if (!this.joined) return;
      let last = performance.now();
      this.posTimer = setInterval(() => {
        const now = performance.now();
        const dt = Math.min(0.2, (now - last) / 1000);
        last = now;
        this.room.maintain(now);
        this.step(dt, now);
        this.send({ t: 'pos', x: this.x, y: this.y, z: this.z, yaw: this.yaw, pitch: this.pitch, flags: (this.sprint ? 1 : 0) | (this.onGround ? 4 : 0), held: this.held });
        if (now >= this.nextChat && !this.chatPending) {
          const text = `load ${this.name} ${Math.floor(now)}`;
          this.chatPending = { text, t: now };
          this.stats.inc('chats');
          this.send({ t: 'chat', text });
          this.nextChat = now + rand(30_000, 90_000);
        }
      }, POS_INTERVAL_MS);
    }, Math.random() * POS_INTERVAL_MS);
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      this.pingAt = performance.now();
      this.ws.ping();
    }, 2000 + Math.random() * 500);
  }

  protected onMessage(m: ServerMessage): void {
    switch (m.t) {
      case 'snap': {
        const now = performance.now();
        if (this.lastSnap) this.stats.hist.snapGap.add(now - this.lastSnap);
        this.lastSnap = now;
        this.onSnap(m.players);
        return;
      }
      case 'chat':
        if (this.chatPending && m.from === this.name && m.text === this.chatPending.text) {
          this.stats.hist.chat.add(performance.now() - this.chatPending.t);
          this.chatPending = null;
        }
        return;
      case 'kick': this.stats.inc('kicked'); return;
      case 'reject': this.stats.inc('reject'); return;
      case 'teleport':
        this.stats.inc('teleport');
        this.x = m.x; this.y = m.y; this.z = m.z; this.vy = 0;
        this.target = null;
        return;
      case 'hurt': this.stats.inc('hurt'); return;
      default: this.onOther(m);
    }
  }

  send(m: ClientMessage): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const data = JSON.stringify(m);
    this.stats.inc('msgOut');
    this.stats.inc('bytesOut', data.length);
    this.ws.send(data);
  }

  /** Physics-like walking towards `target`: walk/sprint speed, gravity, one-block steps by jumping. */
  protected walk(dt: number): 'moving' | 'arrived' | 'blocked' {
    const ground = this.room.ground(this.x, this.z);
    if (ground < 0) return 'moving'; // chunk not there yet: stand still
    let result: 'moving' | 'arrived' | 'blocked' = 'moving';
    if (this.target) {
      const dx = this.target[0] - this.x, dz = this.target[1] - this.z, d = Math.hypot(dx, dz);
      if (d < 0.6) {
        result = 'arrived';
      } else {
        this.yaw = Math.atan2(-dx, -dz);
        const step = Math.min(d, (this.sprint ? SPRINT : WALK) * dt);
        const nx = this.x + (dx / d) * step, nz = this.z + (dz / d) * step;
        const next = this.room.ground(nx, nz);
        const feet = next + 1;
        if (next < 0 || feet > this.y + 1.25 || !this.free(nx, Math.max(this.y, feet), nz)) {
          if (++this.stuck > 10) { this.stuck = 0; result = 'blocked'; }
        } else if (feet > this.y + 0.01) {
          // A one-block step: jump and move on once we are high enough.
          if (this.onGround) { this.vy = JUMP_V; this.onGround = false; }
          if (this.y >= feet - 0.05) { this.x = nx; this.z = nz; }
        } else {
          this.x = nx; this.z = nz;
          this.stuck = 0;
        }
      }
    }
    // Gravity.
    const floor = this.room.ground(this.x, this.z) + 1;
    this.vy -= GRAVITY * dt;
    this.y += this.vy * dt;
    if (this.y <= floor) { this.y = floor; this.vy = 0; this.onGround = true; } else this.onGround = false;
    return result;
  }

  /** Is the player box free of solid blocks here? (Arena: the server's movement check kicks for walking into walls.) */
  protected free(_x: number, _y: number, _z: number): boolean {
    return true;
  }

  stop(): void {
    this.joined = false;
    if (this.posTimer) clearInterval(this.posTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.posTimer = this.pingTimer = null;
  }

  close(): void {
    this.closing = true;
    this.stop();
    this.ws?.close();
  }

  protected abstract welcome(m: Extract<ServerMessage, { t: 'welcome' }>): void;
  protected abstract step(dt: number, now: number): void;
  protected abstract onSnap(players: SnapshotEntry[]): void;
  protected abstract onOther(m: ServerMessage): void;
}

// ---------------------------------------------------------------- survival

export class SurvivalBot extends Bot {
  private home: [number, number] = [0, 0];
  /** Some players explore (the server generates new chunks for them), most stay around the base. */
  private readonly explorer: boolean;
  private heading = Math.random() * Math.PI * 2;
  private inventory: [number, number][] = Array.from({ length: 36 }, () => [0, 0]);
  private mobs: MobEntry[] = [];
  private items: [number, number, number, number, number, number][] = [];
  private nextMine = 0;
  private nextPlace = 0;
  private nextState = 0;
  private nextAttack = 0;
  private takeAsked = new Map<number, number>();
  private pause = 0;

  constructor(room: RoomCtx, name: string, owner: boolean, xff: string, index: number) {
    super(room, name, owner, xff);
    this.explorer = index % 8 === 1; // one explorer per game of 8
  }

  protected welcome(m: Extract<ServerMessage, { t: 'welcome' }>): void {
    this.home = [m.spawn.x, m.spawn.z];
    const now = performance.now();
    this.nextMine = now + rand(2_000, 6_000);
    this.nextPlace = now + rand(4_000, 9_000);
    this.nextState = now + rand(5_000, 15_000);
    // The owner turns the night on: hostile mobs spawn around everybody.
    if (this.owner) setTimeout(() => this.send({ t: 'chat', text: '/time set midnight' }), 500);
  }

  protected step(dt: number, now: number): void {
    const world = this.room.world;
    if (!world) return;
    // Fight: hostile mobs within 16 blocks pull the bot in; anything within reach gets hit.
    let fight: MobEntry | null = null, fightD = 16;
    for (const e of this.mobs) {
      if (e[8] & 4) continue;
      const d = Math.hypot(e[2] - this.x, e[4] - this.z);
      if (d < 3 && now >= this.nextAttack && (e[1] >= HOSTILE_FROM || Math.random() < 0.02)) {
        this.send({ t: 'attack', id: e[0] });
        this.stats.inc('attacks');
        this.nextAttack = now + 625; // Minecraft's sword cooldown
      }
      if (e[1] >= HOSTILE_FROM && d < fightD) { fight = e; fightD = d; }
    }
    // Pick up items in reach (the real client asks for every item it can fit).
    for (const it of this.items) {
      const d = Math.hypot(it[3] - this.x, it[4] - (this.y + 0.8), it[5] - this.z);
      if (d > TAKE_REACH) continue;
      const asked = this.takeAsked.get(it[0]);
      if (asked && now - asked < 1000) continue;
      this.takeAsked.set(it[0], now);
      this.stats.inc('takes');
      this.send({ t: 'take', id: it[0] });
    }
    if (this.takeAsked.size > 200) this.takeAsked.clear();

    if (this.pause > now) { this.walk(dt); return; }
    if (fight) {
      this.target = [fight[2], fight[4]];
      this.sprint = true;
    } else if (!this.target) {
      this.sprint = this.explorer || Math.random() < 0.3;
      if (this.explorer) {
        this.heading += rand(-0.6, 0.6);
        this.target = [this.x + Math.sin(this.heading) * 24, this.z + Math.cos(this.heading) * 24];
      } else {
        const a = Math.random() * Math.PI * 2, r = rand(4, 28);
        this.target = [this.home[0] + Math.cos(a) * r, this.home[1] + Math.sin(a) * r];
      }
    }
    const res = this.walk(dt);
    if (res !== 'moving') {
      if (res === 'blocked' && this.explorer) this.heading += Math.PI / 2;
      this.target = null;
      if (Math.random() < 0.3) this.pause = now + rand(500, 2500); // look around
    }

    if (now >= this.nextMine) { this.nextMine = now + rand(3_000, 7_000); this.mine(world); }
    if (now >= this.nextPlace) { this.nextPlace = now + rand(4_000, 9_000); this.place(world); }
    if (now >= this.nextState) {
      this.nextState = now + rand(8_000, 12_000);
      this.send({ t: 'state', inventory: [...this.inventory.map((s) => [...s]), [0, 0], [0, 0], [0, 0], [0, 0]], stats: [20, 20, 5, 0, 300] });
    }
  }

  /** A column next to the bot, in the direction it looks. */
  private front(): [number, number] {
    const fx = Math.floor(this.x - Math.sin(this.yaw) * 1.5), fz = Math.floor(this.z - Math.cos(this.yaw) * 1.5);
    return [fx, fz];
  }

  /** Breaks the surface block in front, drops its item like the client does and picks it up again later. */
  private mine(world: ServerWorld): void {
    const [bx, bz] = this.front();
    const by = world.surfaceY(bx, bz);
    if (by < 2) return;
    const old = world.getBlock(bx, by, bz);
    if (old === BLOCK.AIR || old === BLOCK.WATER || old === BLOCK.LAVA || old === BLOCK.BEDROCK || old === BLOCK.UNLOADED) return;
    if (Math.hypot(bx + 0.5 - this.x, by + 0.5 - (this.y + 1.62), bz + 0.5 - this.z) > REACH) return;
    this.pause = performance.now() + 600; // stand still while mining
    world.setBlock(bx, by, bz, BLOCK.AIR);
    this.room.sentEdit(bx, by, bz, 0);
    this.send({ t: 'block', seq: Math.floor(Math.random() * 1e9), x: bx, y: by, z: bz, id: 0 });
    this.stats.inc('blocksBroken');
    const drop = blockDrop(old, this.held);
    if (drop) {
      this.stats.inc('drops');
      this.send({ t: 'drop', id: drop.id, count: drop.count, x: bx + 0.5, y: by + 0.3, z: bz + 0.5, delay: 10 });
    }
  }

  /** Places a block from the inventory on top of the column in front. */
  private place(world: ServerWorld): void {
    const slot = this.inventory.findIndex(([id, n]) => n > 0 && id < 256 && getBlockDef(id)?.solid && getBlockDef(id)?.shape === 'cube');
    if (slot < 0) return;
    const [bx, bz] = this.front();
    if (bx === Math.floor(this.x) && bz === Math.floor(this.z)) return;
    const by = world.surfaceY(bx, bz) + 1;
    if (by < 2 || by > 126 || world.getBlock(bx, by, bz) !== BLOCK.AIR) return;
    if (Math.hypot(bx + 0.5 - this.x, by + 0.5 - (this.y + 1.62), bz + 0.5 - this.z) > REACH) return;
    const id = this.inventory[slot][0];
    this.held = id;
    world.setBlock(bx, by, bz, id);
    this.room.sentEdit(bx, by, bz, id);
    this.send({ t: 'block', seq: Math.floor(Math.random() * 1e9), x: bx, y: by, z: bz, id });
    this.stats.inc('blocksPlaced');
    if (--this.inventory[slot][1] === 0) this.inventory[slot] = [0, 0];
  }

  protected onSnap(): void { /* other players do not steer a survival bot */ }

  protected onOther(m: ServerMessage): void {
    switch (m.t) {
      case 'ent':
        this.mobs = m.m;
        this.items = m.i;
        this.stats.inc('entFrames');
        this.stats.inc('mobsSeen', m.m.length);
        this.stats.inc('itemsSeen', m.i.length);
        return;
      case 'taken': {
        const asked = this.takeAsked.get(m.id);
        if (asked) this.stats.hist.take.add(performance.now() - asked);
        this.takeAsked.delete(m.id);
        this.stats.inc('taken');
        this.addItem(m.itemId, m.count);
        return;
      }
      case 'state':
        this.stats.inc('stateCorrection');
        this.inventory = Array.from({ length: 36 }, (_, i) => {
          const row = m.inventory[i];
          return row && row.length >= 2 ? [row[0], row[1]] as [number, number] : [0, 0] as [number, number];
        });
        return;
      case 'block': this.room.world?.setBlock(m.x, m.y, m.z, m.id, m.meta ?? 0); this.room.sawEdit(m.x, m.y, m.z, m.id); return;
      case 'blocks':
        for (let i = 0; i + 4 < m.edits.length; i += 5) this.room.world?.setBlock(m.edits[i], m.edits[i + 1], m.edits[i + 2], m.edits[i + 3], m.edits[i + 4]);
        return;
      case 'boom':
        for (let i = 0; i + 2 < m.blocks.length; i += 3) this.room.world?.setBlock(m.blocks[i], m.blocks[i + 1], m.blocks[i + 2], BLOCK.AIR);
        return;
      default:
    }
  }

  private addItem(id: number, count: number): void {
    const max = getItemDef(id)?.maxStack ?? 64;
    for (const s of this.inventory) {
      if (count <= 0) return;
      if (s[0] === id && s[1] < max) { const k = Math.min(max - s[1], count); s[1] += k; count -= k; }
    }
    for (const s of this.inventory) {
      if (count <= 0) return;
      if (s[1] === 0) { const k = Math.min(max, count); s[0] = id; s[1] = k; count -= k; }
    }
  }
}

// ---------------------------------------------------------------- arena

export class ArenaBot extends Bot {
  private team = '';
  private readonly teams = new Map<number, string>();
  private readonly others = new Map<number, [number, number, number]>();
  private readonly deadUntil = new Map<number, number>();
  private phase = 'warmup';
  private alive = false;
  private mag = 30;
  private reloading = false;
  private fireEvery = 100;
  private nextFire = 0;
  private firePending = 0;
  private aimAt: number | null = null;
  private ffa = false;
  private readonly box: AABB = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };

  protected free(x: number, y: number, z: number): boolean {
    const arena = this.room.arena;
    if (!arena) return true;
    const b = this.box, m = 0.05;
    b.minX = x - 0.3 - m; b.maxX = x + 0.3 + m; b.minZ = z - 0.3 - m; b.maxZ = z + 0.3 + m;
    b.minY = y + 0.01; b.maxY = y + 1.8;
    const { map, variant } = arena;
    return !boxIntersectsSolid(b, (bx, by, bz) => map.blockAt(variant, bx, by, bz));
  }

  protected welcome(m: Extract<ServerMessage, { t: 'welcome' }>): void {
    this.ffa = m.match?.type === 'ffa';
    this.phase = 'warmup';
    this.y = ARENA_FLOOR_Y + 1;
    // Everyone picks a primary; it applies from the next spawn.
    this.send({ t: 'loadout', primary: PRIMARY_WEAPONS[Math.floor(Math.random() * PRIMARY_WEAPONS.length)] });
  }

  private enemy(id: number): boolean {
    if (id === this.id) return false;
    if ((this.deadUntil.get(id) ?? 0) > performance.now()) return false;
    return this.ffa || (this.teams.get(id) ?? '') !== this.team;
  }

  protected step(dt: number, now: number): void {
    const arena = this.room.arena;
    if (!arena || !this.alive) return;
    const { map, variant } = arena;
    const blocks = { getBlock: (x: number, y: number, z: number) => map.blockAt(variant, x, y, z) };
    // Waypoints: free floor cells with a clear straight path (no walking through walls).
    if (!this.target) {
      const b = map.bounds;
      for (let tries = 0; tries < 12 && !this.target; tries++) {
        const tx = rand(b.minX + 3, b.maxX - 3), tz = rand(b.minZ + 3, b.maxZ - 3);
        const g = map.heightAt(variant, tx, tz);
        if (Math.abs(g + 1 - this.y) > 1.1 || !map.inBounds(tx, tz)) continue;
        const dx = tx - this.x, dz = tz - this.z, d = Math.hypot(dx, dz);
        if (d < 3 || d > 30) continue;
        if (traceBlocks(blocks, this.x, this.y + 0.6, this.z, dx / d, 0, dz / d, d) < d) continue;
        this.target = [tx, tz];
      }
      this.sprint = Math.random() < 0.7;
    }
    if (this.walk(dt) !== 'moving' || (this.target && !map.inBounds(this.target[0], this.target[1]))) this.target = null;
    if (!map.inBounds(this.x, this.z)) { this.x = Math.max(map.bounds.minX + 2, Math.min(map.bounds.maxX - 2, this.x)); this.z = Math.max(map.bounds.minZ + 2, Math.min(map.bounds.maxZ - 2, this.z)); }

    // Shoot the nearest visible enemy.
    if (this.firePending && now - this.firePending > 1000) this.firePending = 0;
    if (this.phase === 'ended' || this.reloading) return;
    const eye = this.y + 1.62;
    let best: [number, number, number] | null = null, bestD = 45;
    for (const [id, p] of this.others) {
      if (!this.enemy(id)) continue;
      const dx = p[0] - this.x, dy = p[1] + 1.2 - eye, dz = p[2] - this.z, d = Math.hypot(dx, dy, dz);
      if (d >= bestD || d < 0.5) continue;
      if (traceBlocks(blocks, this.x, eye, this.z, dx / d, dy / d, dz / d, d) < d) continue;
      best = p; bestD = d;
    }
    if (!best) { this.aimAt = null; return; }
    const dx = best[0] - this.x, dy = best[1] + 1.2 - eye, dz = best[2] - this.z;
    this.yaw = Math.atan2(-dx, -dz);
    this.pitch = Math.atan2(dy, Math.hypot(dx, dz));
    // Human reaction time before the first shot at a new target.
    if (this.aimAt === null) this.aimAt = now + rand(150, 350);
    if (now < this.aimAt || now < this.nextFire) return;
    if (this.mag <= 0) {
      this.reloading = true;
      this.stats.inc('reloads');
      this.send({ t: 'reload', slot: 0 });
      return;
    }
    const err = 0.04;
    this.nextFire = now + this.fireEvery + rand(0, 30);
    this.stats.inc('fires');
    if (!this.firePending) this.firePending = now;
    // The server only accepts a unit aim vector.
    const ax = dx + rand(-err, err) * bestD, ay = dy + rand(-err, err) * bestD, az = dz + rand(-err, err) * bestD, al = Math.hypot(ax, ay, az);
    this.send({ t: 'fire', slot: 0, ox: this.x, oy: eye, oz: this.z, dx: ax / al, dy: ay / al, dz: az / al, ads: Math.random() < 0.3 });
  }

  protected onSnap(players: SnapshotEntry[]): void {
    for (const p of players) if (p[0] !== this.id) this.others.set(p[0], [p[1], p[2], p[3]]);
  }

  protected onOther(m: ServerMessage): void {
    switch (m.t) {
      case 'spawn': {
        this.x = m.x; this.y = m.y; this.z = m.z; this.yaw = m.yaw; this.vy = 0;
        this.team = m.team;
        this.alive = true;
        this.target = null;
        this.reloading = false;
        const w = weaponDef(m.primary);
        this.fireEvery = w ? fireInterval(w) * 1000 : 100;
        this.mag = w?.magazine ?? 30;
        return;
      }
      case 'match': this.phase = m.phase; return;
      case 'roster':
        for (const p of m.players) this.teams.set(p.id, p.team);
        return;
      case 'ammo':
        if (m.slot === 0) { this.mag = m.mag; this.reloading = m.reloading; }
        return;
      case 'shot':
        if (m.id === this.id) {
          this.stats.inc('shots');
          if (this.firePending) { this.stats.hist.fire.add(performance.now() - this.firePending); this.firePending = 0; }
        }
        return;
      case 'hit': this.stats.inc('hits'); return;
      case 'kill':
        if (m.killer === this.id) this.stats.inc('kills');
        this.deadUntil.set(m.victim, performance.now() + 3500);
        if (m.victim === this.id) { this.alive = false; this.target = null; }
        return;
      case 'leave': this.others.delete(m.id); this.teams.delete(m.id); return;
      default:
    }
  }
}
