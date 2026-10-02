import { EntityManager } from '../src/entities/EntityManager';
import type { Mob, MobEvents, MobTarget } from '../src/entities/Mob';
import { type ItemStack, ITEM, blockDrop, getItemDef } from '../src/items/ItemRegistry';
import {
  type ArrowEntry, type ItemEntry, type MobEntry, NET_MOB_KINDS, type ServerMessage, type TntEntry,
} from '../src/net/protocol';
import { type GameMode, hasSurvivalRules } from '../src/player/GameMode';
import { BLOCK, getBlockDef } from '../src/world/BlockRegistry';
import { ServerWorld } from './ServerWorld';

/** Entities are sent to a player when they are this close (blocks). */
const SEND_RADIUS = 64;
const SEND_ITEM_RADIUS = 48;
/** Lenient reach checks (the client uses 5 for blocks and 3 for mobs). */
const ATTACK_REACH = 6.5;
const IGNITE_REACH = 8;
const TAKE_REACH = 2.6;
const SOUND_RADIUS = 24;
/** Player drops bypass the manager's item cap (death drops must not vanish), so the server caps them itself. */
const MAX_DROPPED_ITEMS = 400;

/** What the server needs to know about a connected player. */
export interface EntityPlayer {
  id: number;
  x: number; y: number; z: number;
  flags: number;
  held: number;
  hasPos: boolean;
}

export interface EntityHost {
  send(playerId: number, msg: ServerMessage): void;
  broadcast(msg: ServerMessage): void;
  /** A server-made block change that every client must see (the player edit path has its own). */
  broadcastBlock(x: number, y: number, z: number, id: number, meta?: number): void;
  /** Many block changes at once (x, y, z, id, meta tuples), e.g. flowing water. */
  broadcastBlocks(edits: number[]): void;
  /** Persist a block change. */
  recordEdit(x: number, y: number, z: number, id: number, meta: number): void;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** Time of day (0 sunrise … 0.25 noon … 0.75 midnight) → 0 night … 1 day, like the client's DayCycle. */
export function dayFactorAt(time: number): number {
  const a = time * Math.PI * 2;
  const y = Math.sin(a) / Math.hypot(Math.cos(a), Math.sin(a), 0.28);
  const t = Math.min(1, Math.max(0, (y + 0.18) / 0.4));
  return t * t * (3 - 2 * t);
}

/**
 * Mobs, dropped items, arrows and lit TNT for one game, simulated with the same
 * EntityManager and Mob AI as singleplayer. Players act on them through validated requests
 * (attack, shoot, ignite, take, drop) and receive snapshots plus effect messages.
 */
export class ServerEntities {
  readonly world: ServerWorld;
  readonly manager: EntityManager;
  private players: EntityPlayer[] = [];
  private tickCount = 0;
  private sentAnything = new Set<number>();

  constructor(
    seed: number,
    edits: Record<string, number>,
    private readonly mode: GameMode,
    private readonly host: EntityHost,
    private readonly getTime: () => number,
  ) {
    this.world = new ServerWorld(seed, edits);
    this.world.onEdit = (x, y, z, id, meta) => host.recordEdit(x, y, z, id, meta);
    this.world.liquids.onDestroyed = (x, y, z, id) => {
      // Plants and torches washed away drop themselves, like in survival Minecraft.
      const drop = hasSurvivalRules(this.mode) ? blockDrop(id, 0) : null;
      if (drop) this.manager.dropItem(drop, x + 0.5, y + 0.3, z + 0.5);
    };
    this.manager = new EntityManager(this.world, seed);
    this.world.onChunkReady = (c) => this.manager.onChunkReady(c);
    this.world.onChunkUnloaded = (k) => this.manager.onChunkUnloaded(k);
  }

  /** Drops everything that lives only while players are around (mobs respawn from the seed). */
  clear(): void {
    this.manager.clear();
    this.world.update([]);
    // Flowing liquid resumes from the saved edits when its chunks load again.
    this.world.liquids.clear();
    this.world.drainSimEdits();
    this.sentAnything.clear();
    this.tickCount = 0;
  }

  get mobCount(): number {
    return this.manager.mobs.length;
  }

  /** One 20 Hz tick with everyone who is in the game. */
  tick(players: EntityPlayer[]): void {
    this.players = players;
    const active = players.filter((p) => p.hasPos);
    if (active.length === 0) return;
    const attackable = hasSurvivalRules(this.mode);
    const targets: MobTarget[] = active.map((p) => ({ x: p.x, y: p.y, z: p.z, attackable, id: p.id }));
    this.world.update(targets);
    // Water and lava flow (budgeted per tick); what changed goes out as one batch.
    this.world.tickLiquids();
    const flowed = this.world.drainSimEdits();
    if (flowed.length > 0) this.host.broadcastBlocks(flowed);
    this.manager.targets = targets;
    const day = dayFactorAt(this.getTime());
    this.manager.tick(targets[0], Math.round((1 - day) * 11), this.events, null, day > 0.6);
    if (++this.tickCount % 2 === 0) this.sendSnapshots(active);
  }

  /** Block edit by a player (already validated by the server). */
  setBlock(x: number, y: number, z: number, id: number, meta = 0): void {
    this.world.setBlock(x, y, z, id, meta);
  }

  // ---------------------------------------------------------------- player requests

  attack(p: EntityPlayer, mobId: number): void {
    const m = this.manager.mobs.find((e) => e.netId === mobId);
    if (!m || m.dead || m.removed || !p.hasPos) return;
    const d = Math.hypot(m.x - p.x, m.y + m.height / 2 - (p.y + 1.62), m.z - p.z);
    if (d > ATTACK_REACH) return;
    const damage = getItemDef(p.held)?.tool?.damage ?? 1;
    // Sprint hits knock back further, like Minecraft.
    if (m.hurt(damage, p.x, p.z, p.flags & 1 ? 1.6 : 1, true)) this.mobSound(m, 'hurt');
  }

  shoot(p: EntityPlayer, x: number, y: number, z: number, dx: number, dy: number, dz: number, power: number): void {
    if (p.held !== ITEM.BOW || !p.hasPos) return;
    if (![x, y, z, dx, dy, dz, power].every(Number.isFinite) || power < 0.1 || power > 1) return;
    if (Math.hypot(x - p.x, y - (p.y + 1.62), z - p.z) > 4 || Math.hypot(dx, dy, dz) < 1e-6) return;
    // Player bow: speed 3 × power blocks/tick, inaccuracy 1, critical at full draw.
    this.manager.shootArrow(x, y, z, dx, dy, dz, power * 3, 1, null, true, power >= 1, false);
  }

  ignite(p: EntityPlayer, x: number, y: number, z: number): void {
    if (p.held !== ITEM.FLINT_AND_STEEL || ![x, y, z].every(Number.isInteger) || !p.hasPos) return;
    if (Math.hypot(x + 0.5 - p.x, y + 0.5 - (p.y + 1.62), z + 0.5 - p.z) > IGNITE_REACH) return;
    if (this.world.getBlock(x, y, z) !== BLOCK.TNT) return;
    this.world.setBlock(x, y, z, BLOCK.AIR);
    this.host.broadcastBlock(x, y, z, BLOCK.AIR);
    this.manager.primeTnt(x, y, z);
  }

  take(p: EntityPlayer, itemId: number): void {
    const it = this.manager.items.find((e) => e.netId === itemId);
    if (!it || it.removed || it.pickupDelay > 0 || !p.hasPos) return;
    if (Math.hypot(it.x - p.x, it.y - (p.y + 0.8), it.z - p.z) > TAKE_REACH) return;
    it.removed = true;
    // The entity drops out of the snapshots at once and is compacted on the next tick.
    this.host.send(p.id, { t: 'taken', id: it.netId, itemId: it.stack.id, count: it.stack.count, damage: it.stack.damage });
  }

  /** A client dropped something (block drop, Q, death). Validated like every other request. */
  drop(p: EntityPlayer, stack: ItemStack, x: number, y: number, z: number, yaw: number | undefined, delay: number | undefined): void {
    if (!p.hasPos || !Number.isInteger(stack.id) || !Number.isInteger(stack.count)) return;
    if (stack.count < 1 || stack.count > 64 || !getItemDef(stack.id)) return;
    if (this.manager.items.length >= MAX_DROPPED_ITEMS) return;
    const damage = typeof stack.damage === 'number' && Number.isInteger(stack.damage) && stack.damage >= 0 && stack.damage <= 100_000 ? stack.damage : undefined;
    if (![x, y, z].every(Number.isFinite) || Math.hypot(x - p.x, y - (p.y + 1), z - p.z) > 10) return;
    const pickupDelay = Number.isFinite(delay) ? Math.min(100, Math.max(0, delay as number)) : 10;
    this.manager.dropItem({ id: stack.id, count: stack.count, damage }, x, y, z, pickupDelay,
      Number.isFinite(yaw) ? yaw : undefined, true);
  }

  // ---------------------------------------------------------------- effects

  private readonly events: MobEvents = {
    attack: (mob, damage, target) => {
      if (target.id === undefined) return;
      this.host.send(target.id, { t: 'hurt', amount: damage, cause: 'mob', by: mob.type.name, yaw: Math.atan2(target.x - mob.x, target.z - mob.z) });
    },
    explode: (mob) => this.explode(mob.type.name, mob.x, mob.y + 0.5, mob.z, 3, false),
    tntExplode: (t) => this.explode('', t.x, t.y + 0.49, t.z, 4, t.inWater),
    shoot: (mob, target) => this.manager.skeletonShoot(mob, target.x, target.y, target.z),
    arrowHit: (arrow, damage, targetId) => {
      if (targetId === undefined) return;
      this.host.send(targetId, {
        t: 'hurt', amount: damage, cause: 'arrow', by: arrow.shooter ? arrow.shooter.type.name : '', yaw: Math.atan2(-arrow.vx, -arrow.vz),
      });
    },
    arrowImpact: (arrow) => this.soundNear('', 'arrow', arrow.x, arrow.y, arrow.z),
    sound: (mob, kind) => this.mobSound(mob, kind),
    killed: () => undefined,
    playerArrowHit: () => undefined,
  };

  private mobSound(m: Mob, event: 'idle' | 'hurt' | 'death' | 'fuse'): void {
    this.soundNear(m.type.kind, event, m.x, m.y, m.z);
  }

  private soundNear(kind: string, event: 'idle' | 'hurt' | 'death' | 'fuse' | 'arrow', x: number, y: number, z: number): void {
    const msg: ServerMessage = { t: 'msound', kind, event, x: r2(x), y: r2(y), z: r2(z) };
    for (const p of this.players) {
      if (p.hasPos && Math.hypot(p.x - x, p.y - y, p.z - z) < SOUND_RADIUS) this.host.send(p.id, msg);
    }
  }

  /**
   * Creeper or TNT explosion: the world changes here; every client gets the destroyed
   * blocks and plays the effects and takes its own damage by distance. Under water the
   * blocks stay (like Minecraft) but mobs are still hurt.
   */
  private explode(by: string, x: number, y: number, z: number, power: number, inWater: boolean): void {
    const positions: number[] = [];
    const destroyed = inWater ? [] : this.world.explode(x, y, z, power * 1.3, positions);
    for (let i = 0; i < destroyed.length; i++) {
      const id = destroyed[i];
      if (id === BLOCK.TNT) {
        // Caught TNT lights with a short random fuse: chain reactions.
        this.manager.primeTnt(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2], 10 + Math.floor(Math.random() * 20));
        continue;
      }
      if (Math.random() < 1 / power && getBlockDef(id)?.inInventory) {
        const drop = blockDrop(id, ITEM.DIAMOND_PICKAXE);
        if (drop) {
          this.manager.dropItem(drop, x + (Math.random() - 0.5) * power, y + Math.random() * power * 0.5, z + (Math.random() - 0.5) * power);
        }
      }
    }
    const reach = power * 2;
    for (const m of this.manager.mobs) {
      const md = Math.hypot(m.x - x, m.y - y, m.z - z);
      if (!m.removed && md < reach) m.hurt(Math.floor((1 - md / reach) * 7 * power), x, z, 1.5);
    }
    this.host.broadcast({ t: 'boom', x: r2(x), y: r2(y), z: r2(z), power, by, water: inWater, blocks: positions });
  }

  // ---------------------------------------------------------------- snapshots

  private sendSnapshots(players: EntityPlayer[]): void {
    const { mobs, items, arrows, tnt } = this.manager;
    for (const p of players) {
      const m: MobEntry[] = [], i: ItemEntry[] = [], a: ArrowEntry[] = [], b: TntEntry[] = [];
      for (const e of mobs) {
        if (e.removed || Math.hypot(e.x - p.x, e.y - p.y, e.z - p.z) > SEND_RADIUS) continue;
        const kind = NET_MOB_KINDS.indexOf(e.type.kind as typeof NET_MOB_KINDS[number]);
        if (kind < 0) continue;
        m.push([e.netId, kind, r2(e.x), r2(e.y), r2(e.z), r2(e.yaw), r2(e.headYaw), r2(e.headPitch),
          (e.onGround ? 1 : 0) | (e.burning > 0 ? 2 : 0) | (e.dead ? 4 : 0), e.hurtTime, e.fuse, e.deathTime]);
      }
      for (const e of items) {
        if (e.removed || Math.hypot(e.x - p.x, e.y - p.y, e.z - p.z) > SEND_ITEM_RADIUS) continue;
        i.push([e.netId, e.stack.id, e.stack.count, r2(e.x), r2(e.y), r2(e.z)]);
      }
      for (const e of arrows) {
        if (e.removed || Math.hypot(e.x - p.x, e.y - p.y, e.z - p.z) > SEND_RADIUS) continue;
        a.push([e.netId, r2(e.x), r2(e.y), r2(e.z), r2(e.yaw), r2(e.pitch), e.inGround ? 1 : 0]);
      }
      for (const e of tnt) {
        if (e.removed || Math.hypot(e.x - p.x, e.y - p.y, e.z - p.z) > SEND_RADIUS) continue;
        b.push([e.netId, r2(e.x), r2(e.y), r2(e.z), e.fuse]);
      }
      const any = m.length + i.length + a.length + b.length > 0;
      // An empty list is sent once so the client clears what it still shows.
      if (!any && !this.sentAnything.has(p.id)) continue;
      if (any) this.sentAnything.add(p.id); else this.sentAnything.delete(p.id);
      this.host.send(p.id, { t: 'ent', m, i, a, b });
    }
  }

  forget(playerId: number): void {
    this.sentAnything.delete(playerId);
  }
}
