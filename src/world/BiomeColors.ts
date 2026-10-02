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
    default: return WHITE;
  }
}

/** Default (plains) tint, used for inventory icons. */
export function defaultTint(type: number): RGB {
  return tintColor(type, BIOME.PLAINS);
}
