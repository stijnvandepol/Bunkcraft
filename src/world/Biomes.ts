export const BIOME = {
  OCEAN: 0,
  BEACH: 1,
  PLAINS: 2,
  FOREST: 3,
  DESERT: 4,
  TAIGA: 5,
  SNOWY: 6,
  MOUNTAINS: 7,
  // Generator version 3 (ids are appended: older worlds only ever produce 0..7).
  DEEP_OCEAN: 8,
  WARM_OCEAN: 9,
  COLD_OCEAN: 10,
  FROZEN_OCEAN: 11,
  RIVER: 12,
  FROZEN_RIVER: 13,
  JUNGLE: 14,
  SAVANNA: 15,
  SWAMP: 16,
  BADLANDS: 17,
  DARK_FOREST: 18,
  BIRCH_FOREST: 19,
  FLOWER_FOREST: 20,
  CHERRY_GROVE: 21,
  WINDSWEPT_HILLS: 22,
  MEADOW: 23,
  SNOWY_TAIGA: 24,
  SNOWY_BEACH: 25,
  STONY_SHORE: 26,
} as const;

export const BIOME_NAMES = [
  'Ocean', 'Beach', 'Plains', 'Forest', 'Desert', 'Taiga', 'Snowy Plains', 'Mountains',
  'Deep Ocean', 'Warm Ocean', 'Cold Ocean', 'Frozen Ocean', 'River', 'Frozen River', 'Jungle', 'Savanna',
  'Swamp', 'Badlands', 'Dark Forest', 'Birch Forest', 'Flower Forest', 'Cherry Grove', 'Windswept Hills', 'Meadow',
  'Snowy Taiga', 'Snowy Beach', 'Stony Shore',
];

const OCEANISH = new Set<number>([BIOME.OCEAN, BIOME.DEEP_OCEAN, BIOME.WARM_OCEAN, BIOME.COLD_OCEAN, BIOME.FROZEN_OCEAN]);

/** Sea and river biomes: the water bodies. */
export function isWaterBiome(b: number): boolean {
  return OCEANISH.has(b) || b === BIOME.RIVER || b === BIOME.FROZEN_RIVER;
}

/** Biomes without rain (hot and dry) and with snow instead of rain: weather and the F3 screen read these. */
export const DRY_BIOMES: readonly number[] = [BIOME.DESERT, BIOME.SAVANNA, BIOME.BADLANDS];
export const SNOWY_BIOMES: readonly number[] = [
  BIOME.SNOWY, BIOME.SNOWY_TAIGA, BIOME.SNOWY_BEACH, BIOME.FROZEN_OCEAN, BIOME.FROZEN_RIVER,
];

/**
 * How good a biome is for the first spawn point of a world (lower = better, -1 = never).
 * Generator versions below 3 keep their old rule (plains, forest, taiga) so existing worlds spawn where they did.
 */
export function spawnRank(biome: number, genVersion: number): number {
  if (genVersion < 3) return biome === BIOME.PLAINS || biome === BIOME.FOREST || biome === BIOME.TAIGA ? 0 : -1;
  switch (biome) {
    case BIOME.PLAINS: case BIOME.FOREST: case BIOME.BIRCH_FOREST: case BIOME.FLOWER_FOREST: case BIOME.MEADOW:
    case BIOME.BEACH:
      return 0;
    case BIOME.TAIGA: case BIOME.SAVANNA: case BIOME.CHERRY_GROVE: case BIOME.SNOWY: case BIOME.DESERT:
      return 1;
    default:
      return -1;
  }
}
