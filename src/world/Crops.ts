import { CUBES, CUBE_FIRST } from './Content';

/**
 * Crop blocks (Minecraft Java 1.21 farming): data only, no behaviour, so the block registry, the mesher (workers), the
 * world generator (villages) and the server can all import it without pulling in the simulation. The rules that make
 * them grow live in Farming.ts.
 *
 * Block ids 235-240 (free range below the redstone ids 241+; the content tables grow upwards from 186). The growth stage
 * is the state byte, so every stage of a crop is one block id. Texture layers are scarce (8-bit layer index), so a crop
 * has ONE layer: its mature texture. Younger stages are drawn by the mesher as a shorter plant that shows part of that
 * texture (`vTop`: the top part, so carrot roots stay hidden until the crop is ripe) and tinted per stage (wheat turns
 * from green to gold, stems from green to orange exactly like Minecraft's stem colour). 6 layers in total: wheat,
 * carrots, potatoes, beetroots, stem, attached stem. Moist farmland reuses the dry texture, darkened by a vertex tint.
 *
 * State bytes:
 *  - wheat, carrots, potatoes: age 0-7 (bits 0-2); beetroots: age 0-3 (bits 0-1);
 *  - pumpkin and melon stems: age 0-7 (bits 0-2), bit 3 = attached to its fruit, bits 4-5 = direction of the fruit
 *    (0 north −z, 1 south +z, 2 west −x, 3 east +x);
 *  - farmland: moisture 0-7 (bits 0-2), 7 = wet (darker).
 */

export const CROP_BLOCK = {
  WHEAT: 235,
  CARROTS: 236,
  POTATOES: 237,
  BEETROOTS: 238,
  PUMPKIN_STEM: 239,
  MELON_STEM: 240,
} as const;

/** Farmland's block id (it lives in the content table). */
export const FARMLAND = CUBE_FIRST + CUBES.findIndex((c) => c.name === 'farmland');
export const FARMLAND_MOISTURE_MASK = 7;
/** Moisture of hydrated farmland (the only value that looks wet). */
export const FARMLAND_WET = 7;

export const STEM_AGE_MASK = 7;
export const STEM_ATTACHED_BIT = 8;
export const STEM_FACING_SHIFT = 4;
/** Fruit direction of an attached stem: dx, dz per facing (north, south, west, east). */
export const STEM_DX = [0, 0, -1, 1] as const;
export const STEM_DZ = [-1, 1, 0, 0] as const;

export type CropKind = 'wheat' | 'carrots' | 'potatoes' | 'beetroots' | 'pumpkin_stem' | 'melon_stem';

export interface CropSpec {
  id: number;
  kind: CropKind;
  /** Registry name of the block. */
  name: string;
  display: string;
  maxAge: number;
  /** Texture layer (the mature look). */
  texture: string;
  /** Item that plants it (and what an unripe crop drops). */
  seed: string;
  /** 1 = Minecraft's crop model (four planes in a # pattern), 2 = stem (a cross, the attached one a single bent plane). */
  style: 1 | 2;
  /** Height of the plant per age, in 1/16 block. */
  heights: number[];
  /** Show the top part of the texture for short stages (instead of the bottom part). */
  vTop: boolean;
  /** Vertex tint per age (0xRRGGBB); white for crops whose texture keeps its colours. */
  tints: number[];
  /** The fruit a stem grows (block name in the content table). */
  fruit?: string;
}

/** Minecraft's stem colour: r = age·32, g = 255 − age·8, b = age·4 (BlockColors). */
export function stemTint(age: number): number {
  return ((age * 32) << 16) | ((255 - age * 8) << 8) | (age * 4);
}
/** Minecraft's attached stem colour. */
export const ATTACHED_STEM_TINT = 0xe0c71c;

const WHITE = [0xffffff, 0xffffff, 0xffffff, 0xffffff, 0xffffff, 0xffffff, 0xffffff, 0xffffff];
const STEM_HEIGHTS = [2, 4, 6, 8, 10, 12, 14, 16];
const STEM_TINTS = STEM_HEIGHTS.map((_, a) => stemTint(a));

export const CROPS: CropSpec[] = [
  {
    id: CROP_BLOCK.WHEAT, kind: 'wheat', name: 'wheat_crop', display: 'Wheat Crops', maxAge: 7, texture: 'wheat_crop', seed: 'wheat_seeds', style: 1,
    heights: [3, 5, 7, 9, 11, 12, 14, 16], vTop: false,
    // Green shoots that ripen to gold (the texture is greyscale).
    tints: [0x5fb63a, 0x66b83a, 0x72ba3c, 0x80bc3e, 0x94bd40, 0xaabb44, 0xbfb64a, 0xf0d070],
  },
  {
    id: CROP_BLOCK.CARROTS, kind: 'carrots', name: 'carrots', display: 'Carrots', maxAge: 7, texture: 'carrots_crop', seed: 'carrot', style: 1,
    heights: [5, 5, 8, 8, 11, 11, 11, 16], vTop: true, tints: WHITE,
  },
  {
    id: CROP_BLOCK.POTATOES, kind: 'potatoes', name: 'potatoes', display: 'Potatoes', maxAge: 7, texture: 'potatoes_crop', seed: 'potato', style: 1,
    heights: [5, 5, 8, 8, 11, 11, 11, 16], vTop: true, tints: WHITE,
  },
  {
    id: CROP_BLOCK.BEETROOTS, kind: 'beetroots', name: 'beetroots', display: 'Beetroots', maxAge: 3, texture: 'beetroots_crop', seed: 'beetroot_seeds', style: 1,
    heights: [5, 8, 11, 16], vTop: true, tints: WHITE.slice(0, 4),
  },
  {
    id: CROP_BLOCK.PUMPKIN_STEM, kind: 'pumpkin_stem', name: 'pumpkin_stem', display: 'Pumpkin Stem', maxAge: 7, texture: 'stem', seed: 'pumpkin_seeds',
    style: 2, heights: STEM_HEIGHTS, vTop: false, tints: STEM_TINTS, fruit: 'pumpkin',
  },
  {
    id: CROP_BLOCK.MELON_STEM, kind: 'melon_stem', name: 'melon_stem', display: 'Melon Stem', maxAge: 7, texture: 'stem', seed: 'melon_seeds',
    style: 2, heights: STEM_HEIGHTS, vTop: false, tints: STEM_TINTS, fruit: 'melon',
  },
];

/** Texture of an attached stem (the bent one); every stem block carries it as its "front" texture. */
export const ATTACHED_STEM_TEXTURE = 'attached_stem';

// ---------------------------------------------------------------- flat tables (mesher, hot paths)

/** 0 = not a crop, else CropSpec.style. */
export const CROP_STYLE = new Uint8Array(256);
export const CROP_MAX_AGE = new Uint8Array(256);
/** Bits of the state byte that hold the age. */
export const CROP_AGE_MASK = new Uint8Array(256);
export const CROP_VTOP = new Uint8Array(256);
/** Per id and age (id * 8 + age): height in 1/16 block and vertex tint. */
export const CROP_HEIGHT = new Uint8Array(256 * 8);
export const CROP_TINT = new Int32Array(256 * 8).fill(0xffffff);

const SPEC_BY_ID: (CropSpec | undefined)[] = [];
for (const c of CROPS) {
  SPEC_BY_ID[c.id] = c;
  CROP_STYLE[c.id] = c.style;
  CROP_MAX_AGE[c.id] = c.maxAge;
  CROP_AGE_MASK[c.id] = c.maxAge === 3 ? 3 : 7;
  CROP_VTOP[c.id] = c.vTop ? 1 : 0;
  for (let a = 0; a <= c.maxAge; a++) {
    CROP_HEIGHT[c.id * 8 + a] = c.heights[a];
    CROP_TINT[c.id * 8 + a] = c.tints[a];
  }
}

/** Moist farmland is the dry texture darkened (Minecraft's farmland_moist is about 0.58/0.5/0.46 of the dry one). */
export const FARMLAND_WET_TINT = 0x94807a;

// ---------------------------------------------------------------- helpers (also for structure generation)

export function cropSpec(id: number): CropSpec | undefined {
  return SPEC_BY_ID[id];
}

/** Wheat, carrots, potatoes or beetroots (the blocks that stand on farmland and are harvested whole). */
export function isCrop(id: number): boolean {
  return CROP_STYLE[id] === 1;
}

/** Pumpkin or melon stem (attached or not). */
export function isStem(id: number): boolean {
  return CROP_STYLE[id] === 2;
}

/** Any farm plant that needs farmland under it. */
export function isFarmPlant(id: number): boolean {
  return CROP_STYLE[id] !== 0;
}

/** Growth age stored in a state byte. */
export function cropAge(id: number, meta: number): number {
  return meta & CROP_AGE_MASK[id];
}

export function isMature(id: number, meta: number): boolean {
  return CROP_STYLE[id] !== 0 && cropAge(id, meta) >= CROP_MAX_AGE[id];
}

/** Is this stem attached to a fruit? */
export function stemAttached(meta: number): boolean {
  return (meta & STEM_ATTACHED_BIT) !== 0;
}

export function stemFacing(meta: number): number {
  return (meta >> STEM_FACING_SHIFT) & 3;
}

/** State of an attached stem whose fruit lies in direction `facing` (0 north, 1 south, 2 west, 3 east). */
export function attachedStemMeta(facing: number): number {
  return 7 | STEM_ATTACHED_BIT | ((facing & 3) << STEM_FACING_SHIFT);
}

const KIND_ID: Record<CropKind, number> = {
  wheat: CROP_BLOCK.WHEAT, carrots: CROP_BLOCK.CARROTS, potatoes: CROP_BLOCK.POTATOES, beetroots: CROP_BLOCK.BEETROOTS,
  pumpkin_stem: CROP_BLOCK.PUMPKIN_STEM, melon_stem: CROP_BLOCK.MELON_STEM,
};

/**
 * Block and state of a crop at a growth stage, clamped to its range: `cropState('wheat', 7)` is ripe wheat,
 * `cropState('beetroots', 99)` ripe beetroots. For world generation (village farms) and commands.
 */
export function cropState(kind: CropKind, stage: number): { id: number; meta: number } {
  const id = KIND_ID[kind];
  const max = CROP_MAX_AGE[id];
  const age = Math.max(0, Math.min(max, Math.floor(Number.isFinite(stage) ? stage : 0)));
  return { id, meta: age };
}

/** Block id of a crop kind. */
export function cropBlock(kind: CropKind): number {
  return KIND_ID[kind];
}

/** Farmland state: wet (moisture 7, what a farm next to water has) or dry (0). */
export function farmlandState(wet: boolean): { id: number; meta: number } {
  return { id: FARMLAND, meta: wet ? FARMLAND_WET : 0 };
}
