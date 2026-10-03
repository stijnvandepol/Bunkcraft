import { spawnRank } from './Biomes';
import type { WorldGenerator } from './WorldGenerator';
import { SEA_LEVEL } from './constants';

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
