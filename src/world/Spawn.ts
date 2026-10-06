import { spawnRank } from './Biomes';
import { BLOCK, SOLID, getBlockDef } from './BlockRegistry';
import { hashString } from './Noise';
import type { WorldGenerator } from './WorldGenerator';
import { CHUNK_HEIGHT, SEA_LEVEL } from './constants';

/** Minecraft's `spawnRadius` default: new players appear within this many blocks of the world spawn. */
export const SPAWN_RADIUS = 10;
/** How far `findStandingSpot` looks around the target column for real ground. */
export const STANDING_SEARCH_RADIUS = 8;

/**
 * First spawn point of a terrain world: a spiral search around (0, 0) for a dry column that is not carved away.
 *
 * Generator version 3 prefers plains, forests, meadows and beaches close to sea level (rank 0 in `spawnRank`) and
 * accepts taiga, savanna, desert, cherry grove and snowy plains (rank 1) only when no rank-0 spot exists within
 * `PREFERRED_RADIUS`. Badlands, oceans, rivers, swamps, jungles and mountains are never chosen.
 * Versions 1 and 2 keep their old rule (plains/forest/taiga, height 65..84) so their worlds spawn where they always did.
 */
const PREFERRED_RADIUS = 1200;

export function findSpawnColumn(gen: WorldGenerator, genVersion: number, requireBiome = true): { x: number; z: number; h: number } | null {
  const v3 = genVersion >= 3;
  let fallback: { x: number; z: number; h: number } | null = null;
  for (let r = 0; r < 2000; r += 8) {
    if (fallback && r > PREFERRED_RADIUS) return fallback;
    const steps = Math.max(1, Math.floor((r * Math.PI * 2) / 16));
    for (let s = 0; s < steps; s++) {
      const a = (s / steps) * Math.PI * 2;
      const x = Math.round(Math.cos(a) * r), z = Math.round(Math.sin(a) * r);
      const h = gen.heightAt(x, z);
      const ok = v3 ? h >= SEA_LEVEL + 1 && h < 80 : h > SEA_LEVEL + 2 && h < 85;
      if (!ok) continue;
      const rank = requireBiome || v3 ? spawnRank(gen.biomeAt(x, z, Math.floor(h)), genVersion) : 0;
      if (rank < 0 || (rank > 0 && fallback)) continue;
      if (gen.surfaceOpen?.(x, z)) continue;
      if (rank === 0) return { x, z, h };
      fallback = { x, z, h };
    }
  }
  return fallback;
}

/**
 * A new multiplayer player's first position: a dry spot within `SPAWN_RADIUS` of the world spawn, picked from the
 * player's name (stable for a name, different between players), so two newcomers do not stand inside each other.
 * Falls back to the world spawn itself when no candidate is dry.
 */
export function spreadSpawn<T extends { x: number; z: number }>(
  spawn: T, name: string, isDry: (x: number, z: number) => boolean, radius = SPAWN_RADIUS,
): T {
  const key = hashString(name.toLowerCase());
  for (let i = 0; i < 8; i++) {
    const h = hashString(`${key}:${i}`);
    // Uniform over the ring between 2 blocks (the world spawn itself stays free) and `radius`.
    const r = 2 + Math.sqrt((h & 0xffff) / 0xffff) * (radius - 2);
    const a = ((h >>> 16) / 0x10000) * Math.PI * 2;
    const x = Math.floor(spawn.x + Math.cos(a) * r) + 0.5;
    const z = Math.floor(spawn.z + Math.sin(a) * r) + 0.5;
    if (isDry(Math.floor(x), Math.floor(z))) return { ...spawn, x, z };
  }
  return spawn;
}

/** Top blocks a spawn must not stand on: leaves and logs (a tree canopy), water and lava. */
const NOT_GROUND = new Uint8Array(256);
for (let id = 1; id < 256; id++) {
  const name = getBlockDef(id)?.name ?? '';
  if (name.endsWith('_leaves') || name.endsWith('_log') || id === BLOCK.WATER || id === BLOCK.LAVA) NOT_GROUND[id] = 1;
}

/**
 * Where a player placed at column (x, z) should stand: on the highest solid block of the nearest column (within
 * `radius`) whose top is real ground, not a tree canopy or a liquid; plants above the ground do not count. Returns
 * the feet position (block coordinates), or null when no such column exists (the caller keeps its old rule).
 */
export function findStandingSpot(
  getBlock: (x: number, y: number, z: number) => number, x: number, z: number, radius = STANDING_SEARCH_RADIUS,
): { x: number; y: number; z: number } | null {
  for (let r = 0; r <= radius; r++) {
    // Ring r of a square spiral; the nearest column of the ring wins.
    let best: { x: number; y: number; z: number } | null = null, bestD = Infinity;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const d = dx * dx + dz * dz;
        if (d >= bestD) continue;
        const cx = x + dx, cz = z + dz;
        let y = CHUNK_HEIGHT - 1;
        for (; y > 0; y--) {
          const id = getBlock(cx, y, cz);
          if (SOLID[id] || id === BLOCK.WATER || id === BLOCK.LAVA) break;
        }
        if (y <= 0 || NOT_GROUND[getBlock(cx, y, cz)]) continue;
        best = { x: cx, y: y + 1, z: cz };
        bestD = d;
      }
    }
    if (best) return best;
  }
  return null;
}
