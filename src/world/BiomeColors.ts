import { BIOME } from './Biomes';

/**
 * Minecraft-style biome tinting. Tintable textures are stored in greyscale and multiplied
 * by a per-biome colour (values from the Minecraft Wiki biome table, Java defaults).
 */
export const TINT_NONE = 0;
export const TINT_GRASS = 1;
export const TINT_FOLIAGE = 2;
export const TINT_BIRCH = 3;
export const TINT_SPRUCE = 4;
export const TINT_WATER = 5;

type RGB = [number, number, number];

function hex(c: string): RGB {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const GRASS: Record<number, RGB> = {
  [BIOME.OCEAN]: hex('#8EB971'),
  [BIOME.BEACH]: hex('#91BD59'),
  [BIOME.PLAINS]: hex('#91BD59'),
  [BIOME.FOREST]: hex('#79C05A'),
  [BIOME.DESERT]: hex('#BFB755'),
  [BIOME.TAIGA]: hex('#86B783'),
  [BIOME.SNOWY]: hex('#80B497'),
  [BIOME.MOUNTAINS]: hex('#8AB689'),
  [BIOME.DEEP_OCEAN]: hex('#8EB971'),
  [BIOME.WARM_OCEAN]: hex('#8EB971'),
  [BIOME.COLD_OCEAN]: hex('#80B497'),
  [BIOME.FROZEN_OCEAN]: hex('#80B497'),
  [BIOME.RIVER]: hex('#79C05A'),
  [BIOME.FROZEN_RIVER]: hex('#80B497'),
  [BIOME.JUNGLE]: hex('#59C93C'),
  [BIOME.SAVANNA]: hex('#BFB755'),
  [BIOME.SWAMP]: hex('#6A7039'),
  [BIOME.BADLANDS]: hex('#90814D'),
  [BIOME.DARK_FOREST]: hex('#507A32'),
  [BIOME.BIRCH_FOREST]: hex('#88BB67'),
  [BIOME.FLOWER_FOREST]: hex('#79C05A'),
  [BIOME.CHERRY_GROVE]: hex('#B6DB61'),
  [BIOME.WINDSWEPT_HILLS]: hex('#8AB689'),
  [BIOME.MEADOW]: hex('#83BB6D'),
  [BIOME.SNOWY_TAIGA]: hex('#80B497'),
  [BIOME.SNOWY_BEACH]: hex('#83B593'),
  [BIOME.STONY_SHORE]: hex('#8AB689'),
};

const FOLIAGE: Record<number, RGB> = {
  [BIOME.OCEAN]: hex('#71A74D'),
  [BIOME.BEACH]: hex('#77AB2F'),
  [BIOME.PLAINS]: hex('#77AB2F'),
  [BIOME.FOREST]: hex('#59AE30'),
  [BIOME.DESERT]: hex('#AEA42A'),
  [BIOME.TAIGA]: hex('#68A464'),
  [BIOME.SNOWY]: hex('#60A17B'),
  [BIOME.MOUNTAINS]: hex('#6DA36B'),
  [BIOME.DEEP_OCEAN]: hex('#71A74D'),
  [BIOME.WARM_OCEAN]: hex('#71A74D'),
  [BIOME.COLD_OCEAN]: hex('#60A17B'),
  [BIOME.FROZEN_OCEAN]: hex('#60A17B'),
  [BIOME.RIVER]: hex('#59AE30'),
  [BIOME.FROZEN_RIVER]: hex('#60A17B'),
  [BIOME.JUNGLE]: hex('#30BB0B'),
  [BIOME.SAVANNA]: hex('#AEA42A'),
  [BIOME.SWAMP]: hex('#6A7039'),
  [BIOME.BADLANDS]: hex('#9E814D'),
  [BIOME.DARK_FOREST]: hex('#59AE30'),
  [BIOME.BIRCH_FOREST]: hex('#6BA941'),
  [BIOME.FLOWER_FOREST]: hex('#59AE30'),
  [BIOME.CHERRY_GROVE]: hex('#B6DB61'),
  [BIOME.WINDSWEPT_HILLS]: hex('#6DA36B'),
  [BIOME.MEADOW]: hex('#63A948'),
  [BIOME.SNOWY_TAIGA]: hex('#60A17B'),
  [BIOME.SNOWY_BEACH]: hex('#64A278'),
  [BIOME.STONY_SHORE]: hex('#6DA36B'),
};

/** Water colour per biome (Minecraft Java). The default is the colour the water texture is made for. */
export const DEFAULT_WATER = hex('#3F76E4');
const WATER: Record<number, RGB> = {
  [BIOME.WARM_OCEAN]: hex('#43D5EE'),
  [BIOME.COLD_OCEAN]: hex('#3D57D6'),
  [BIOME.FROZEN_OCEAN]: hex('#3938C9'),
  [BIOME.FROZEN_RIVER]: hex('#3938C9'),
  [BIOME.SWAMP]: hex('#617B64'),
  [BIOME.MEADOW]: hex('#0E4ECF'),
  [BIOME.CHERRY_GROVE]: hex('#5DB7EF'),
  [BIOME.SNOWY_TAIGA]: hex('#3D57D6'),
  [BIOME.SNOWY]: hex('#3D57D6'),
  [BIOME.SNOWY_BEACH]: hex('#3D57D6'),
};

const BIRCH = hex('#80A755');
const SPRUCE = hex('#619961');
const WHITE: RGB = [255, 255, 255];

export function tintColor(type: number, biome: number): RGB {
  switch (type) {
    case TINT_GRASS: return GRASS[biome] ?? GRASS[BIOME.PLAINS];
    case TINT_FOLIAGE: return FOLIAGE[biome] ?? FOLIAGE[BIOME.PLAINS];
    case TINT_BIRCH: return BIRCH;
    case TINT_SPRUCE: return SPRUCE;
    case TINT_WATER: return waterColor(biome);
    default: return WHITE;
  }
}

/** Water colour of a biome as RGB. */
export function waterColor(biome: number): RGB {
  return WATER[biome] ?? DEFAULT_WATER;
}

/** Default (plains) tint, used for inventory icons. */
export function defaultTint(type: number): RGB {
  return tintColor(type, BIOME.PLAINS);
}
