import { EntityManager } from '../src/entities/EntityManager';
import { explosionDamage, explosionDropChance } from '../src/entities/Explosion';
import type { Mob, MobEvents, MobSound, MobTarget } from '../src/entities/Mob';
import { type ItemStack, ITEM, blockDrop, encodeData, getItemDef, itemId } from '../src/items/ItemRegistry';
import { touchesPlate } from '../src/world/Redstone';
import { fireAspectTicks, levelOf, meleeBonus, powerBonus, punchKnockback } from '../src/items/EnchantRules';
import { canCarry } from '../src/items/Enchanting';
import {
  type ArrowEntry, type FallEntry, type ItemEntry, MOB_FLAG, type MobEntry, NET_MOB_KINDS, type OrbEntry, type ServerMessage, type TntEntry,
} from '../src/net/protocol';
import { type GameMode, hasSurvivalRules } from '../src/player/GameMode';
import { attackCharge, attackScale, attackSpeedOf, isSword, meleeDamage, planAttack, sweepDamage, sweepVictims } from '../src/player/Melee';
import { type Difficulty, hostilesAllowed } from '../src/world/Difficulty';
import type { RuleReader } from '../src/world/GameRules';
import { BLOCK, getBlockDef } from '../src/world/BlockRegistry';
import { boneMealTarget, useBoneMeal } from '../src/world/Growth';
import { ServerWorld } from './ServerWorld';
import type { TickPhases } from './TickPhases';
import { useOnMob } from '../src/entities/MobInteraction';
import type { ChunkGenPool } from './chunkgen/ChunkGenPool';
import { arrowEffect, meleeEffect, witchPotion } from '../src/entities/MobEffects';

/** Entities are sent to a player when they are this close (blocks). */
const SEND_RADIUS = 64;
const SEND_ITEM_RADIUS = 48;
/** Lenient reach checks (the client uses 4.5 for blocks, 5 in creative, and 3 for mobs). */
const ATTACK_REACH = 6.5;
const IGNITE_REACH = 8;
const BONE_MEAL_REACH = 8;
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
  /** View direction (endermen notice stares). */
  yaw?: number;
  pitch?: number;
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
  /** Sky light levels the weather takes away (rain and thunder count as darkness for spawning). */
  skyDarkness?(): number;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** Per player: what the server needs to scale melee damage by the attack cooldown without trusting the client. */
interface CombatRecord {
  /** Clock time (ms) of the last attack and of the last change of the held item (both restart the cooldown). */
  lastAttack: number;
  heldSince: number;
  held: number;
  lastY: number;
  falling: boolean;
}

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
  private sentOrbs = new Set<number>();
  private readonly combat = new Map<number, CombatRecord>();
  /** Clock for the attack cooldown in ms (the tests replace it). */
  attackClock: () => number = () => Date.now();
  /** Game rules and difficulty of this world (set by GameServer; absent in the tests = defaults). */
  rules: RuleReader | null = null;
  private sentFalling = new Set<number>();
  /** Where the time of the last tick went (all zero after a tick without players). */
  readonly phaseMs: TickPhases = { world: 0, blocks: 0, spawn: 0, mobs: 0, other: 0, snapshots: 0 };

  constructor(
    seed: number,
    edits: Record<string, number>,
    private mode: GameMode,
    private readonly host: EntityHost,
    private readonly getTime: () => number,
    genVersion?: number,
    genPool: ChunkGenPool | null = null,
  ) {
    this.world = new ServerWorld(seed, edits, 'terrain', genVersion, genPool);
    this.world.onEdit = (x, y, z, id, meta) => host.recordEdit(x, y, z, id, meta);
    this.world.liquids.onDestroyed = (x, y, z, id) => {
      // Plants and torches washed away drop themselves, like in survival Minecraft.
      const drop = hasSurvivalRules(this.mode) ? blockDrop(id, 0) : null;
      if (drop) this.manager.dropItem(drop, x + 0.5, y + 0.3, z + 0.5);
    };
    // Decayed leaves, uprooted plants and sand that could not land drop their item (survival rules).
    this.world.onBlockDrop = (id, meta, x, y, z) => {
      const drop = hasSurvivalRules(this.mode) ? blockDrop(id, 0, meta) : null;
      if (drop) this.manager.dropItem(drop, x + 0.5, y + 0.3, z + 0.5);
    };
    this.world.skyDarkness = () => Math.round((1 - dayFactorAt(this.getTime())) * 11 + (this.host.skyDarkness?.() ?? 0));
    this.manager = new EntityManager(this.world, seed);
    // Redstone: pressure plates see players and mobs (oak plates also items); popped-off parts drop; powered TNT is lit.
    this.world.entitiesOn = (x, y, z, oak) => {
      let n = 0;
      for (const p of this.players) if (p.hasPos && touchesPlate(p.x, p.y, p.z, 0.3, 1.8, x, y, z)) n++;
      for (const m of this.manager.mobs) if (!m.dead && touchesPlate(m.x, m.y, m.z, m.width / 2, m.height, x, y, z)) n++;
      if (oak) for (const it of this.manager.items) if (!it.removed && touchesPlate(it.x, it.y, it.z, 0.125, 0.25, x, y, z)) n++;
      return n;
    };
    this.world.redstone.onBreak = (x, y, z, id, meta) => {
      const drop = hasSurvivalRules(this.mode) ? (id === BLOCK.REDSTONE_WIRE ? { id: itemId('redstone'), count: 1 } : blockDrop(id, 0, meta)) : null;
      if (drop) this.manager.dropItem(drop, x + 0.5, y + 0.3, z + 0.5);
    };
    this.world.redstone.onIgnite = (x, y, z) => {
      if (this.world.setBlock(x, y, z, BLOCK.AIR) < 0) return false;
      this.host.broadcastBlock(x, y, z, BLOCK.AIR);
      this.manager.primeTnt(x, y, z);
      return true;
    };
    // A broken chest or furnace spills its contents (survival rules; creative empties it, like Minecraft).
    this.world.blockEntities.onDrops = (x, y, z, stacks) => {
      if (!hasSurvivalRules(this.mode)) return;
      for (const st of stacks) this.manager.dropItem(st, x + 0.5, y + 0.5, z + 0.5, 10, undefined, true);
    };
    this.world.onChunkReady = (c) => this.manager.onChunkReady(c);
    this.world.onChunkUnloaded = (k) => this.manager.onChunkUnloaded(k);
    // Sheep grazing changes blocks: every client must see it.
    this.manager.blockHook = (x, y, z, id) => host.broadcastBlock(x, y, z, id);
  }

  /** Drops everything that lives only while players are around (mobs respawn from the seed). */
  clear(): void {
    this.manager.clear();
    this.world.update([]);
    // Flowing liquid resumes from the saved edits when its chunks load again.
    this.world.liquids.clear();
    this.world.redstone.clear();
    this.world.updates.clear();
    this.world.drainSimEdits();
    this.sentAnything.clear();
    this.sentOrbs.clear();
    this.tickCount = 0;
  }

  /** `/gamerule randomTickSpeed <n>` (the command UI is built elsewhere): picks per chunk section per tick. */
  setRandomTickSpeed(n: number): void {
    this.world.ticker.setSpeed(n);
  }

  get randomTickSpeed(): number {
    return this.world.ticker.speed;
  }

  /** The game mode changed (/gamemode): mobs and block drops follow the new rules. */
  setMode(mode: GameMode): void {
    this.mode = mode;
  }

  /** Peaceful removes the hostile mobs and stops them spawning. */
  setDifficulty(d: Difficulty): void {
    this.manager.peaceful = !hostilesAllowed(d);
  }

  /** Re-reads the rules that switch spawning (call after /gamerule). */
  applyRules(): void {
    this.manager.spawningEnabled = this.rules ? this.rules.get('doMobSpawning') : true;
    if (this.rules) this.setRandomTickSpeed(this.rules.get('randomTickSpeed'));
  }

  get mobCount(): number {
    return this.manager.mobs.length;
  }

  /** One 20 Hz tick with everyone who is in the game. */
  tick(players: EntityPlayer[]): void {
    this.players = players;
    for (const p of players) this.trackCombat(p);
    const active = players.filter((p) => p.hasPos);
    const ph = this.phaseMs;
    ph.world = ph.blocks = ph.spawn = ph.mobs = ph.other = ph.snapshots = 0;
    if (active.length === 0) return;
    const attackable = hasSurvivalRules(this.mode);
    const targets: MobTarget[] = active.map((p) => ({ x: p.x, y: p.y, z: p.z, attackable, id: p.id, held: p.held, yaw: p.yaw, pitch: p.pitch }));
    const t0 = performance.now();
    this.world.update(targets);
    const t1 = performance.now();
    // Water and lava flow (budgeted per tick); what changed goes out as one batch.
    this.world.tickLiquids();
    this.world.tickRedstone();
    // Random ticks and block updates; their changes join the liquid batch (one message, capped per tick).
    this.world.tickGrowth(targets);
    // Furnaces burn while their chunk is loaded; lighting up or going out is a block change like flowing water.
    this.world.blockEntities.tick();
    const flowed = this.world.drainSimEdits();
    if (flowed.length > 0) this.host.broadcastBlocks(flowed);
    this.manager.targets = targets;
    const day = dayFactorAt(this.getTime());
    const t2 = performance.now();
    this.manager.tick(targets[0], Math.round((1 - day) * 11 + (this.host.skyDarkness?.() ?? 0)), this.events, null, day > 0.6);
    const t3 = performance.now();
    if (++this.tickCount % 2 === 0) this.sendSnapshots(active);
    const perf = this.manager.perf;
    ph.world = t1 - t0;
    ph.blocks = t2 - t1;
    ph.spawn = perf.spawnMs;
    ph.mobs = perf.mobsMs;
    ph.other = perf.otherMs;
    ph.snapshots = performance.now() - t3;
  }

  /** Block edit by a player (already validated by the server). */
  setBlock(x: number, y: number, z: number, id: number, meta = 0): void {
    this.world.setBlock(x, y, z, id, meta);
  }

  // ---------------------------------------------------------------- player requests

  private trackCombat(p: EntityPlayer): CombatRecord {
    let r = this.combat.get(p.id);
    if (!r) {
      r = { lastAttack: -Infinity, heldSince: -Infinity, held: p.held, lastY: p.y, falling: false };
      this.combat.set(p.id, r);
    }
    if (p.held !== r.held) {
      // Switching items restarts the cooldown (no swapping between two swords for full hits).
      r.held = p.held;
      r.heldSince = this.attackClock();
    }
    r.falling = p.y < r.lastY - 1e-3;
    r.lastY = p.y;
    return r;
  }

  attack(p: EntityPlayer, mobId: number, ench?: Record<string, number>): void {
    const m = this.manager.mobs.find((e) => e.netId === mobId);
    if (!m || m.dead || m.removed || !p.hasPos) return;
    const d = Math.hypot(m.x - p.x, m.y + m.height / 2 - (p.y + 1.62), m.z - p.z);
    if (d > ATTACK_REACH) return;
    // The client reports nothing about its cooldown: the server counts it from the attacks it has seen, so spam
    // clicking only gets the weak, scaled hits (one tick of leniency for network jitter).
    const rec = this.trackCombat(p);
    const now = this.attackClock();
    const def = getItemDef(p.held);
    const speed = attackSpeedOf(def?.name);
    const ticks = (now - Math.max(rec.lastAttack, rec.heldSince)) / 50 + 1;
    rec.lastAttack = now;
    const plan = planAttack({
      charge: attackCharge(ticks, speed), onGround: (p.flags & 4) !== 0, fallDistance: rec.falling ? 1 : 0, inWater: false,
      sprinting: (p.flags & 1) !== 0, sword: isSword(def?.name),
    });
    // Only enchantments the held item can carry count (the client cannot claim Sharpness on a stick).
    const e = weaponEnchants(p.held, ench);
    const kind = m.type.kind;
    const enchantBonus = meleeBonus(e, kind === 'zombie' || kind === 'skeleton', kind === 'spider');
    const scale = attackScale(ticks, speed);
    const damage = meleeDamage({ base: def?.tool?.damage ?? 1, enchantBonus, scale, crit: plan.crit });
    m.looting = levelOf(e, 'looting');
    const edge = levelOf(e, 'sweeping_edge');
    // Sprint hits knock back further, like Minecraft; Knockback adds to it.
    if (m.hurt(damage, p.x, p.z, (plan.sprintKnock ? 1.6 : 1) + levelOf(e, 'knockback') * 0.6, true, { kind: 'player', byPlayer: true }, { x: p.x, y: p.y, z: p.z, attackable: true, id: p.id })) {
      this.mobSound(m, 'hurt');
      const fire = levelOf(e, 'fire_aspect');
      if (fire) m.igniteTicks = Math.max(m.igniteTicks, fireAspectTicks(fire));
      if (plan.sweep) {
        for (const o of sweepVictims(m, this.manager.mobs)) {
          if (!o.dead && !o.removed) o.hurt(sweepDamage(def?.tool?.damage ?? 1, edge / (edge + 1)), p.x, p.z, 0.4, true, { kind: 'player', byPlayer: true });
        }
      }
    }
  }

  /** Right click on a mob with the held item; the client pays for it when told (`mobused`). Riding is singleplayer only. */
  useMob(p: EntityPlayer, mobId: number): void {
    const m = this.manager.mobs.find((e) => e.netId === mobId);
    if (!m || m.dead || m.removed || !p.hasPos) return;
    if (Math.hypot(m.x - p.x, m.y + m.height / 2 - (p.y + 1.62), m.z - p.z) > ATTACK_REACH) return;
    // The mob's events (hearts, sounds) go through this server's handlers.
    m.events = this.events;
    m.world = this.manager;
    const r = useOnMob(m, p.held, p.id);
    if (r.action === 'none' || r.action === 'mount') return;
    this.host.send(p.id, { t: 'mobused', action: r.action, consume: r.consume, give: r.give, damageTool: r.damageTool });
  }

  shoot(p: EntityPlayer, x: number, y: number, z: number, dx: number, dy: number, dz: number, power: number, ench?: Record<string, number>): void {
    if (p.held !== ITEM.BOW || !p.hasPos) return;
    if (![x, y, z, dx, dy, dz, power].every(Number.isFinite) || power < 0.1 || power > 1) return;
    if (Math.hypot(x - p.x, y - (p.y + 1.62), z - p.z) > 4 || Math.hypot(dx, dy, dz) < 1e-6) return;
    // Player bow: speed 3 × power blocks/tick, inaccuracy 1, critical at full draw.
    const arrow = this.manager.shootArrow(x, y, z, dx, dy, dz, power * 3, 1, null, true, power >= 1, false);
    const e = weaponEnchants(p.held, ench);
    if (arrow) {
      arrow.powerBonus = powerBonus(levelOf(e, 'power'));
      arrow.punch = punchKnockback(levelOf(e, 'punch'));
      arrow.flame = levelOf(e, 'flame') > 0;
    }
  }

  ignite(p: EntityPlayer, x: number, y: number, z: number): void {
    if (p.held !== ITEM.FLINT_AND_STEEL || ![x, y, z].every(Number.isInteger) || !p.hasPos) return;
    if (Math.hypot(x + 0.5 - p.x, y + 0.5 - (p.y + 1.62), z + 0.5 - p.z) > IGNITE_REACH) return;
    if (this.world.getBlock(x, y, z) !== BLOCK.TNT) return;
    this.world.setBlock(x, y, z, BLOCK.AIR);
    this.host.broadcastBlock(x, y, z, BLOCK.AIR);
    this.manager.primeTnt(x, y, z);
  }

  /** Bone meal on a block: the player must hold it and be in reach; the growth goes out with the next block batch. */
  boneMeal(p: EntityPlayer, x: number, y: number, z: number): void {
    if (!p.hasPos || p.held !== itemId('bone_meal') || ![x, y, z].every(Number.isInteger)) return;
    if (Math.hypot(x + 0.5 - p.x, y + 0.5 - (p.y + 1.62), z + 0.5 - p.z) > BONE_MEAL_REACH) return;
    if (!boneMealTarget(this.world.getBlock(x, y, z))) return;
    useBoneMeal(this.world.ticker, x, y, z);
  }

  take(p: EntityPlayer, itemId: number): void {
    const orb = this.manager.orbs.find((e) => e.netId === itemId);
    if (orb) {
      if (orb.removed || !p.hasPos || Math.hypot(orb.x - p.x, orb.y - (p.y + 0.8), orb.z - p.z) > TAKE_REACH) return;
      orb.removed = true;
      this.host.send(p.id, { t: 'xpgain', id: orb.netId, value: orb.value });
      return;
    }
    const it = this.manager.items.find((e) => e.netId === itemId);
    if (!it || it.removed || it.pickupDelay > 0 || !p.hasPos) return;
    if (Math.hypot(it.x - p.x, it.y - (p.y + 0.8), it.z - p.z) > TAKE_REACH) return;
    it.removed = true;
    // The entity drops out of the snapshots at once and is compacted on the next tick.
    this.host.send(p.id, { t: 'taken', id: it.netId, itemId: it.stack.id, count: it.stack.count, damage: it.stack.damage, data: encodeData(it.stack.data) });
  }

  /** A client dropped something (block drop, Q, death). Validated like every other request. */
  drop(p: EntityPlayer, stack: ItemStack, x: number, y: number, z: number, yaw: number | undefined, delay: number | undefined): void {
    if (!p.hasPos || !Number.isInteger(stack.id) || !Number.isInteger(stack.count)) return;
    if (stack.count < 1 || stack.count > 64 || !getItemDef(stack.id)) return;
    if (this.manager.items.length >= MAX_DROPPED_ITEMS) return;
    const damage = typeof stack.damage === 'number' && Number.isInteger(stack.damage) && stack.damage >= 0 && stack.damage <= 100_000 ? stack.damage : undefined;
    if (![x, y, z].every(Number.isFinite) || Math.hypot(x - p.x, y - (p.y + 1), z - p.z) > 10) return;
    const pickupDelay = Number.isFinite(delay) ? Math.min(100, Math.max(0, delay as number)) : 10;
    this.manager.dropItem({ id: stack.id, count: stack.count, damage, data: stack.data }, x, y, z, pickupDelay,
      Number.isFinite(yaw) ? yaw : undefined, true);
  }

  // ---------------------------------------------------------------- effects

  private readonly events: MobEvents = {
    attack: (mob, damage, target) => {
      if (target.id === undefined) return;
      this.host.send(target.id, {
        t: 'hurt', amount: damage, cause: 'mob', by: mob.type.name, yaw: Math.atan2(target.x - mob.x, target.z - mob.z),
        effect: meleeEffect(mob) ?? undefined,
      });
    },
    potion: (mob, target) => {
      // The client picks nothing: the server does not know the player's health, so it assumes full health (onzeker).
      if (target.id === undefined) return;
      const effect = witchPotion(Math.hypot(target.x - mob.x, target.z - mob.z), 20, () => false, Math.random());
      this.host.send(target.id, { t: 'hurt', amount: 0, cause: 'mob', by: mob.type.name, yaw: Math.atan2(target.x - mob.x, target.z - mob.z), effect });
    },
    fx: (mob, fx) => {
      const msg: ServerMessage = { t: 'mobfx', id: mob.netId, fx };
      for (const p of this.players) if (p.hasPos && Math.hypot(p.x - mob.x, p.z - mob.z) < 48) this.host.send(p.id, msg);
    },
    explode: (mob) => this.explode(mob.type.name, mob.x, mob.y + 0.5, mob.z, 3, false, false),
    tntExplode: (t) => this.explode('', t.x, t.y + 0.49, t.z, 4, t.inWater, true),
    shoot: (mob, target) => {
      this.manager.skeletonShoot(mob, target.x, target.y, target.z);
      this.soundNear('', 'shoot', mob.x, mob.y, mob.z);
    },
    arrowHit: (arrow, damage, targetId) => {
      if (targetId === undefined) return;
      this.host.send(targetId, {
        t: 'hurt', amount: damage, cause: 'arrow', by: arrow.shooter ? arrow.shooter.type.name : '', yaw: Math.atan2(-arrow.vx, -arrow.vz),
        effect: arrowEffect(arrow.shooter) ?? undefined,
      });
    },
    arrowImpact: (arrow) => this.soundNear('', 'arrow', arrow.x, arrow.y, arrow.z),
    sound: (mob, kind) => this.mobSound(mob, kind),
    killed: () => undefined,
    playerArrowHit: () => undefined,
  };

  private mobSound(m: Mob, event: MobSound): void {
    this.soundNear(m.type.kind, event, m.x, m.y, m.z);
  }

  private soundNear(kind: string, event: MobSound | 'arrow' | 'shoot', x: number, y: number, z: number): void {
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
  private explode(by: string, x: number, y: number, z: number, power: number, inWater: boolean, tnt: boolean): void {
    const positions: number[] = [];
    const dropChance = explosionDropChance(power, tnt);
    // Creepers only break blocks while mobGriefing is on; TNT always does.
    const grief = tnt || !this.rules || this.rules.get('mobGriefing');
    const destroyed = inWater || !grief ? [] : this.world.explode(x, y, z, power * 1.3, positions);
    for (let i = 0; i < destroyed.length; i++) {
      const id = destroyed[i];
      if (id === BLOCK.TNT) {
        // Caught TNT lights with a short random fuse: chain reactions.
        this.manager.primeTnt(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2], 10 + Math.floor(Math.random() * 20));
        continue;
      }
      if (Math.random() < dropChance && getBlockDef(id)?.inInventory) {
        const drop = blockDrop(id, ITEM.DIAMOND_PICKAXE);
        if (drop) {
          this.manager.dropItem(drop, x + (Math.random() - 0.5) * power, y + Math.random() * power * 0.5, z + (Math.random() - 0.5) * power);
        }
      }
    }
    for (const m of this.manager.mobs) {
      const dmg = explosionDamage(Math.hypot(m.x - x, m.y - y, m.z - z), power);
      if (!m.removed && dmg > 0) m.hurt(dmg, x, z, 1.5);
    }
    this.host.broadcast({ t: 'boom', x: r2(x), y: r2(y), z: r2(z), power, by, water: inWater, blocks: positions });
  }

  /** A lightning strike: mobs within 3 blocks take 5 damage and burn (players handle their own damage on receipt). */
  lightning(x: number, y: number, z: number): void {
    for (const m of this.manager.mobs) {
      if (m.removed || m.dead) continue;
      if (Math.hypot(m.x - x, m.z - z) <= 3 && Math.abs(m.y - y) < 4) {
        m.hurt(5, x, z, 0.3);
        m.burning = Math.max(m.burning, 160);
      }
    }
  }

  // ---------------------------------------------------------------- snapshots

  private sendSnapshots(players: EntityPlayer[]): void {
    const { mobs, items, arrows, tnt, orbs } = this.manager;
    for (const p of players) {
      const m: MobEntry[] = [], i: ItemEntry[] = [], a: ArrowEntry[] = [], b: TntEntry[] = [];
      for (const e of mobs) {
        if (e.removed || Math.hypot(e.x - p.x, e.y - p.y, e.z - p.z) > SEND_RADIUS) continue;
        const kind = NET_MOB_KINDS.indexOf(e.type.kind as typeof NET_MOB_KINDS[number]);
        if (kind < 0) continue;
        m.push([e.netId, kind, r2(e.x), r2(e.y), r2(e.z), r2(e.yaw), r2(e.headYaw), r2(e.headPitch), mobFlags(e), e.hurtTime,
          e.type.kind === 'creeper' ? e.fuse : mobVariant(e), e.deathTime]);
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
      // Experience orbs travel in their own optional message (older clients ignore it).
      const o: OrbEntry[] = [];
      for (const e of orbs) {
        if (e.removed || Math.hypot(e.x - p.x, e.y - p.y, e.z - p.z) > SEND_ITEM_RADIUS) continue;
        o.push([e.netId, e.value, r2(e.x), r2(e.y), r2(e.z)]);
      }
      if (o.length > 0 || this.sentOrbs.has(p.id)) {
        this.host.send(p.id, { t: 'orbs', o });
        if (o.length > 0) this.sentOrbs.add(p.id); else this.sentOrbs.delete(p.id);
      }
      const any = m.length + i.length + a.length + b.length > 0;
      // An empty list is sent once so the client clears what it still shows.
      if (!any && !this.sentAnything.has(p.id)) continue;
      if (any) this.sentAnything.add(p.id); else this.sentAnything.delete(p.id);
      this.host.send(p.id, { t: 'ent', m, i, a, b });
    }
    this.sendFalling(players);
  }

  /** Falling sand and gravel: a separate small message so the binary entity frame stays as it is. */
  private sendFalling(players: EntityPlayer[]): void {
    const falling = this.world.updates.falling;
    for (const p of players) {
      const f: FallEntry[] = [];
      for (const e of falling) {
        if (e.removed || Math.hypot(e.x - p.x, e.y - p.y, e.z - p.z) > SEND_RADIUS) continue;
        f.push([e.netId, e.id, e.meta, r2(e.x), r2(e.y), r2(e.z)]);
      }
      if (f.length === 0 && !this.sentFalling.has(p.id)) continue;
      if (f.length > 0) this.sentFalling.add(p.id); else this.sentFalling.delete(p.id);
      this.host.send(p.id, { t: 'fall', f });
    }
  }

  forget(playerId: number): void {
    this.sentAnything.delete(playerId);
    this.sentOrbs.delete(playerId);
    this.combat.delete(playerId);
    this.sentFalling.delete(playerId);
  }
}

/** Snapshot flag bits of a mob (MOB_FLAG). */
export function mobFlags(e: Mob): number {
  return (e.onGround ? MOB_FLAG.GROUND : 0) | (e.burning > 0 ? MOB_FLAG.BURNING : 0) | (e.dead ? MOB_FLAG.DEAD : 0)
    | (e.baby ? MOB_FLAG.BABY : 0) | (e.sitting ? MOB_FLAG.SITTING : 0) | (e.tamed ? MOB_FLAG.TAMED : 0)
    | (e.angryTicks > 0 ? MOB_FLAG.ANGRY : 0) | (e.busy > 0 ? MOB_FLAG.BUSY : 0);
}

/** The kind-specific byte sent in the fuse slot (see MobEntry). */
export function mobVariant(e: Mob): number {
  if (e.type.kind === 'slime') return e.size;
  if (e.type.kind === 'horse') return (e.variant & 15) | (e.saddled ? 16 : 0);
  return e.variant & 255;
}

/** The enchantments a player claims for the held item, limited to what that item can carry. */
function weaponEnchants(held: number, ench: Record<string, number> | undefined): Record<string, number> | undefined {
  if (!ench) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(ench)) if (canCarry(held, k)) out[k] = v;
  return out;
}
