import { BIOME } from '../../world/Biomes';

/**
 * What the listener's surroundings sound like. The game fills one of these a few times per second
 * (see {@link scanEnvironment}); the ambience layer turns it into loop levels and random events.
 * Pure logic: world access goes through callbacks, so it is testable without a world.
 */
export interface AudioEnvironment {
  x: number; y: number; z: number;
  /** Sky light 0..15 at the head. */
  skyLight: number;
  /** 0 (open air) .. 1 (small closed space), from {@link estimateEnclosure}. */
  enclosure: number;
  underwater: boolean;
  /** 0 at night, 1 by day (DayCycle.dayFactor). */
  dayFactor: number;
  biome: number;
  /** Distance to the nearest lava / flowing water block (Infinity when none within scan range) and its position. */
  lavaDist: number; lavaX: number; lavaY: number; lavaZ: number;
  waterDist: number; waterX: number; waterY: number; waterZ: number;
  /** Burning fire block nearby (hook for the fire crackle): distance. */
  fireDist: number;
}

export function createEnvironment(): AudioEnvironment {
  return {
    x: 0, y: 64, z: 0, skyLight: 15, enclosure: 0, underwater: false, dayFactor: 1, biome: BIOME.PLAINS,
    lavaDist: Infinity, lavaX: 0, lavaY: 0, lavaZ: 0, waterDist: Infinity, waterX: 0, waterY: 0, waterZ: 0, fireDist: Infinity,
  };
}

// 18 sample directions (6 axes + 12 edge diagonals), normalised once.
const DIRS: Float32Array = (() => {
  const raw: number[][] = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
    [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [0, 1, 1], [0, 1, -1], [0, -1, 1], [0, -1, -1],
    [1, 0, 1], [1, 0, -1], [-1, 0, 1], [-1, 0, -1],
  ];
  const out = new Float32Array(raw.length * 3);
  raw.forEach((d, i) => {
    const l = Math.hypot(d[0], d[1], d[2]);
    out[i * 3] = d[0] / l; out[i * 3 + 1] = d[1] / l; out[i * 3 + 2] = d[2] / l;
  });
  return out;
})();

/**
 * Cheap enclosure estimate: marches 18 rays up to `maxDist` blocks and averages how soon they hit a solid
 * block (a hit at distance d weighs 1 - d/(2·maxDist)). Outdoors the sky rays escape (~0.25 on flat ground);
 * a corridor or cave gives 0.8+. About 150 block reads, run a few times per second.
 */
export function estimateEnclosure(isSolid: (x: number, y: number, z: number) => boolean, x: number, y: number, z: number, maxDist = 8): number {
  const n = DIRS.length / 3;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const dx = DIRS[i * 3], dy = DIRS[i * 3 + 1], dz = DIRS[i * 3 + 2];
    for (let s = 1; s <= maxDist; s++) {
      if (isSolid(Math.floor(x + dx * s), Math.floor(y + dy * s), Math.floor(z + dz * s))) {
        sum += 1 - (s - 1) / (2 * maxDist); // nearer hits weigh more
        break;
      }
    }
  }
  return sum / n;
}

function sstep(a: number, b: number, v: number): number {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** 0..1: how much the listener is in a cave (dark, enclosed, and the deeper the surer). */
export function caveFactor(skyLight: number, enclosure: number, y: number): number {
  const dark = 1 - sstep(4, 11, skyLight);
  const closed = sstep(0.4, 0.72, enclosure);
  const depth = 0.5 + 0.5 * sstep(66, 36, y);
  return dark * closed * depth;
}

/** 0..1 wind: strong on mountains and at altitude, gone indoors. */
export function windFactor(env: AudioEnvironment): number {
  const open = 1 - sstep(0.25, 0.6, env.enclosure);
  const altitude = sstep(78, 118, env.y);
  const mountain = env.biome === BIOME.MOUNTAINS ? 0.55 : env.biome === BIOME.SNOWY ? 0.25 : 0;
  return Math.min(1, Math.max(altitude, mountain * sstep(60, 75, env.y))) * open * sstep(8, 14, env.skyLight);
}

/** 0..1 crickets: night in grassland, outdoors. */
export function cricketFactor(env: AudioEnvironment): number {
  const grassy = env.biome === BIOME.PLAINS || env.biome === BIOME.FOREST ? 1 : env.biome === BIOME.TAIGA ? 0.4 : 0;
  const night = 1 - sstep(0.15, 0.45, env.dayFactor);
  const open = 1 - sstep(0.3, 0.65, env.enclosure);
  return grassy * night * open * (env.underwater ? 0 : 1) * sstep(50, 58, env.y);
}

/** 0..1 birds: daytime, forests (a little over plains), outdoors. */
export function birdFactor(env: AudioEnvironment): number {
  const biome = env.biome === BIOME.FOREST ? 1 : env.biome === BIOME.PLAINS ? 0.4 : env.biome === BIOME.TAIGA ? 0.3 : 0;
  const day = sstep(0.55, 0.85, env.dayFactor);
  const open = 1 - sstep(0.3, 0.65, env.enclosure);
  return biome * day * open * (env.underwater ? 0 : 1);
}

/**
 * Nearest lava and flowing water within `r` blocks of the listener (the ambience places a crackle or
 * a flow sound there). Fills the `lava*`/`water*` fields of `env`. About 700 block reads for r = 4.
 */
export function scanFluids(
  env: AudioEnvironment,
  getBlock: (x: number, y: number, z: number) => number,
  getMeta: (x: number, y: number, z: number) => number,
  ids: { water: number; lava: number; fire?: number },
  r = 4,
): void {
  const px = Math.floor(env.x), py = Math.floor(env.y), pz = Math.floor(env.z);
  let lava = Infinity, water = Infinity, fire = Infinity;
  for (let dy = -r; dy <= r; dy++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = px + dx, y = py + dy, z = pz + dz;
        const b = getBlock(x, y, z);
        if (b === ids.lava) {
          const d = Math.hypot(dx, dy, dz);
          if (d < lava) { lava = d; env.lavaX = x + 0.5; env.lavaY = y + 0.5; env.lavaZ = z + 0.5; }
        } else if (b === ids.water) {
          if (getMeta(x, y, z) === 0) continue; // still source blocks are silent; flowing water gurgles
          const d = Math.hypot(dx, dy, dz);
          if (d < water) { water = d; env.waterX = x + 0.5; env.waterY = y + 0.5; env.waterZ = z + 0.5; }
        } else if (ids.fire !== undefined && b === ids.fire) {
          fire = Math.min(fire, Math.hypot(dx, dy, dz));
        }
      }
    }
  }
  env.lavaDist = lava;
  env.waterDist = water;
  env.fireDist = fire;
}
