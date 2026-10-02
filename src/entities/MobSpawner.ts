import { BLOCK, OPAQUE, SOLID } from '../world/BlockRegistry';
import { isLiquid } from '../world/Liquids';
import { CHUNK_HEIGHT, blockIndex, chunkKey } from '../world/constants';
import { hash2, mulberry32 } from '../world/Noise';
import type { ChunkLike, EntityWorld } from './EntityManager';
import type { Mob, MobTarget } from './Mob';
import type { MobKind } from './MobTypes';

/** Tunables, grouped so the tests and the F3 overlay can read them. */
export const SPAWN = {
  /** Hostile mobs alive at once for one player (Minecraft: 70 per 289 chunks); each extra player adds some. */
  hostileCap: 40,
  hostileCapPerExtraPlayer: 20,
  hostileCapMax: 100,
  /** Darkness (0 noon … 11 midnight) from which the full cap applies, and the share of it available by day. */
  fullDarkness: 7,
  daylightCapShare: 0.4,
  /** Pack spawn attempts per player per tick while below the cap (Minecraft attempts on every tick). */
  hostileAttemptsPerTick: 2,
  /** A hostile spawns 24–48 blocks away from a player, never closer. */
  minDistance: 24,
  maxDistance: 48,
  /** Hostile mobs further than this despawn at once; between `randomDespawn` and this at 1/800 per tick. */
  instantDespawn: 128,
  randomDespawn: 32,
  /** Extra daylight clean-up: surface hostiles out of reach fade away in the morning. */
  daylightDespawnChance: 1 / 240,
  /** Passive animals: cap on the whole world, ticks between top-up attempts and the herd probability per chunk. */
  passiveCap: 80,
  passiveNearCap: 28,
  passiveInterval: 200,
  herdChance: 0.25,
} as const;

interface SpawnEntry {
  kind: MobKind;
  weight: number;
  /** Pack size (inclusive). */
  min: number;
  max: number;
}

/** Overworld monster table: Minecraft weights (100 each), pack sizes as in the 1.21 spawner data. */
export const HOSTILE_TABLE: readonly SpawnEntry[] = [
  { kind: 'zombie', weight: 100, min: 4, max: 4 },
  { kind: 'skeleton', weight: 100, min: 4, max: 4 },
  { kind: 'creeper', weight: 100, min: 1, max: 1 },
  { kind: 'spider', weight: 100, min: 1, max: 2 },
];

/** Creature table: Minecraft weights (sheep 12, pig 10, chicken 10, cow 8). */
export const PASSIVE_TABLE: readonly SpawnEntry[] = [
  { kind: 'sheep', weight: 12, min: 2, max: 4 },
  { kind: 'pig', weight: 10, min: 2, max: 4 },
  { kind: 'chicken', weight: 10, min: 3, max: 4 },
  { kind: 'cow', weight: 8, min: 2, max: 4 },
];

export function pickEntry(table: readonly SpawnEntry[], roll: number): SpawnEntry {
  let total = 0;
  for (const e of table) total += e.weight;
  let r = roll * total;
  for (const e of table) {
    r -= e.weight;
    if (r < 0) return e;
  }
  return table[table.length - 1];
}

/**
 * Minecraft's monster light test: no block light at all, and the sky light (reduced by how dark
 * the day is) must not exceed a random value of 0–7. Open sky at midnight (15 − 11 = 4) therefore
 * spawns often, at noon never, and a cave (sky light 0) always.
 */
export function hostileLightOk(sky: number, block: number, darkness: number, roll: number): boolean {
  return block === 0 && sky - darkness <= Math.floor(roll * 8);
}

/** Despawn roll for a hostile mob `distance` blocks from the nearest player (`roll` is uniform 0..1). */
export function hostileDespawns(distance: number, roll: number): boolean {
  if (distance > SPAWN.instantDespawn) return true;
  return distance > SPAWN.randomDespawn && roll < 1 / 800;
}

/** Mobs alive at once: the full cap in the dark, 40 % of it in daylight (only caves and shade spawn then). */
export function hostileCap(players: number, darkness: number = SPAWN.fullDarkness): number {
  const full = Math.min(SPAWN.hostileCapMax, SPAWN.hostileCap + SPAWN.hostileCapPerExtraPlayer * Math.max(0, players - 1));
  return darkness >= SPAWN.fullDarkness ? full : Math.ceil(full * SPAWN.daylightCapShare);
}

/** What the spawner needs from the entity manager. */
export interface SpawnHost {
  readonly world: EntityWorld;
  readonly mobs: readonly Mob[];
  spawnMob(kind: MobKind, x: number, y: number, z: number): Mob;
}

/**
 * Natural spawning: monster packs in the dark around each player (every tick, like Minecraft),
 * animal herds when a grassy chunk generates plus a slow top-up in daylight.
 */
export class MobSpawner {
  hostileCount = 0;
  passiveCount = 0;

  constructor(private readonly host: SpawnHost, private readonly seed: number, private readonly rng: () => number = Math.random) {}

  /** Recounts the living mobs; call once per tick before spawning. */
  recount(): void {
    let h = 0, p = 0;
    for (const m of this.host.mobs) {
      if (m.removed) continue;
      if (m.type.hostile) h++; else p++;
    }
    this.hostileCount = h;
    this.passiveCount = p;
  }

  /** Monster spawn attempts for this tick (the caller decides whether hostile spawning is on). */
  tickHostile(targets: readonly MobTarget[], darkness: number): void {
    const cap = hostileCap(targets.length, darkness);
    for (const t of targets) {
      for (let i = 0; i < SPAWN.hostileAttemptsPerTick && this.hostileCount < cap; i++) this.tryPack(t, targets, darkness, cap);
    }
  }

  /** Periodic daylight top-up of the animals near a player. */
  tickPassive(targets: readonly MobTarget[], darkness: number, tick: number): void {
    if (tick % SPAWN.passiveInterval !== 0 || targets.length === 0) return;
    const t = targets[(tick / SPAWN.passiveInterval) % targets.length];
    if (this.passiveCount >= SPAWN.passiveCap || darkness > 3) return;
    let near = 0;
    for (const m of this.host.mobs) {
      if (!m.type.hostile && !m.removed && Math.hypot(m.x - t.x, m.z - t.z) < 96) near++;
    }
    if (near >= SPAWN.passiveNearCap) return;
    const r = this.rng;
    const a = r() * Math.PI * 2, d = 24 + r() * 40;
    const x = Math.floor(t.x + Math.cos(a) * d), z = Math.floor(t.z + Math.sin(a) * d);
    const entry = pickEntry(PASSIVE_TABLE, r());
    const n = entry.min + Math.floor(r() * (entry.max - entry.min + 1));
    for (let i = 0; i < n; i++) {
      const px = i === 0 ? x : x + Math.floor((r() - 0.5) * 8), pz = i === 0 ? z : z + Math.floor((r() - 0.5) * 8);
      const y = this.floorY(px, pz, Math.min(CHUNK_HEIGHT - 3, Math.floor(t.y) + 24), 48, true);
      if (y < 0) continue;
      const light = this.host.world.getLight(px, y, pz);
      if ((light >> 4) - darkness < 9) continue;
      const m = this.host.spawnMob(entry.kind, px + 0.5, y, pz + 0.5);
      m.homeChunk = chunkKey(px >> 4, pz >> 4);
    }
  }

  /**
   * Herd for a freshly generated chunk (seeded by the chunk, so reloading it gives the same
   * herd): 2–4 animals of one kind on grass, close together.
   */
  onChunkReady(chunk: ChunkLike): void {
    if (!chunk.blocks || this.passiveCount >= SPAWN.passiveCap) return;
    const rand = mulberry32((hash2(this.seed ^ 0x51ed, chunk.cx, chunk.cz) * 4294967296) >>> 0);
    if (rand() >= SPAWN.herdChance) return;
    const entry = pickEntry(PASSIVE_TABLE, rand());
    const size = entry.min + Math.floor(rand() * (entry.max - entry.min + 1));
    // Starting point: the first of a few random columns with an open grass top.
    let sx = -1, sz = -1;
    for (let k = 0; k < 10 && sx < 0; k++) {
      const lx = Math.floor(rand() * 16), lz = Math.floor(rand() * 16);
      if (grassTop(chunk.blocks, lx, lz) >= 0) { sx = lx; sz = lz; }
    }
    if (sx < 0) return;
    for (let i = 0; i < size; i++) {
      for (let attempt = 0; attempt < 4; attempt++) {
        const lx = i === 0 && attempt === 0 ? sx : Math.min(15, Math.max(0, sx + Math.floor((rand() - 0.5) * 10)));
        const lz = i === 0 && attempt === 0 ? sz : Math.min(15, Math.max(0, sz + Math.floor((rand() - 0.5) * 10)));
        const y = grassTop(chunk.blocks, lx, lz);
        if (y < 0) continue;
        const m = this.host.spawnMob(entry.kind, chunk.cx * 16 + lx + 0.5, y + 1, chunk.cz * 16 + lz + 0.5);
        m.homeChunk = chunk.key;
        break;
      }
    }
  }

  // ---------------------------------------------------------------- hostile packs

  /** One monster pack attempt around `t` (public for tests). */
  tryPack(t: MobTarget, all: readonly MobTarget[], darkness: number, cap: number): void {
    const r = this.rng;
    const a = r() * Math.PI * 2;
    const d = SPAWN.minDistance + r() * (SPAWN.maxDistance - SPAWN.minDistance);
    const x = Math.floor(t.x + Math.cos(a) * d), z = Math.floor(t.z + Math.sin(a) * d);
    // Half the attempts look at the surface (scan down from above the player), half anywhere
    // underground within reach (caves), so dark places spawn in daylight as well.
    const surface = r() < 0.5;
    const y = surface
      ? this.floorY(x, z, Math.min(CHUNK_HEIGHT - 3, Math.floor(t.y) + 16), 40, false)
      : this.floorY(x, z, Math.max(6, Math.floor(t.y) - 40 + Math.floor(r() * 52)), 8, false);
    if (y < 0 || !this.darkEnough(x, y, z, darkness)) return;
    const entry = pickEntry(HOSTILE_TABLE, r());
    const n = entry.min + Math.floor(r() * (entry.max - entry.min + 1));
    for (let i = 0; i < n && this.hostileCount < cap; i++) {
      // Members stand within a few blocks of the first one, on whatever floor is there; a spot
      // that is too bright, blocked or too close gets up to three retries (like Minecraft's pack walk).
      for (let attempt = 0; attempt < 3; attempt++) {
        let px = x, py = y, pz = z;
        if (i > 0 || attempt > 0) {
          px = x + Math.floor((r() - 0.5) * 8);
          pz = z + Math.floor((r() - 0.5) * 8);
          py = this.floorY(px, pz, y + 3, 7, false);
          if (py < 0 || !this.darkEnough(px, py, pz, darkness)) continue;
        }
        if (!farFromPlayers(all, px + 0.5, py, pz + 0.5)) continue;
        this.host.spawnMob(entry.kind, px + 0.5, py, pz + 0.5);
        this.hostileCount++;
        break;
      }
    }
  }

  private darkEnough(x: number, y: number, z: number, darkness: number): boolean {
    const light = this.host.world.getLight(x, y, z);
    return hostileLightOk(light >> 4, light & 15, darkness, this.rng());
  }

  /**
   * Highest standable y at or below `top` (searching `depth` blocks down): two blocks of air
   * above a solid opaque block. −1 if there is none or the column is not loaded. `grass` only
   * accepts grass blocks as the floor.
   */
  private floorY(x: number, z: number, top: number, depth: number, grass: boolean): number {
    const w = this.host.world;
    const bottom = Math.max(2, top - depth);
    for (let y = Math.min(top, CHUNK_HEIGHT - 3); y >= bottom; y--) {
      const below = w.getBlock(x, y - 1, z);
      if (below === BLOCK.UNLOADED) return -1;
      if (!SOLID[below] || !OPAQUE[below]) continue;
      if (grass && below !== BLOCK.GRASS) {
        // The first solid block of a grass search ends it (caves under the surface don't count).
        return -1;
      }
      // Solid below but blocked above: a roof, tree or water, keep looking down.
      if (!passable(w.getBlock(x, y, z)) || !passable(w.getBlock(x, y + 1, z))) continue;
      return y;
    }
    return -1;
  }
}

/** Air, grass tufts, flowers and other non-solid, non-liquid blocks: a mob can stand in them. */
function passable(b: number): boolean {
  return b === 0 || (!SOLID[b] && !isLiquid(b));
}

function farFromPlayers(targets: readonly MobTarget[], x: number, y: number, z: number): boolean {
  const min2 = SPAWN.minDistance * SPAWN.minDistance;
  for (const t of targets) {
    const dx = t.x - x, dy = t.y - y, dz = t.z - z;
    if (dx * dx + dy * dy + dz * dz < min2) return false;
  }
  return true;
}

/** y of the grass block at the top of a column of a generated chunk with air above it, else −1. */
function grassTop(blocks: Uint8Array, lx: number, lz: number): number {
  for (let y = CHUNK_HEIGHT - 2; y > 0; y--) {
    const b = blocks[blockIndex(lx, y, lz)];
    if (passable(b)) continue;
    return b === BLOCK.GRASS && passable(blocks[blockIndex(lx, y + 1, lz)]) ? y : -1;
  }
  return -1;
}
