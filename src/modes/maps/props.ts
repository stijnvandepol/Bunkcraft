import { BLOCK, blockId } from '../../world/BlockRegistry';
import type { LayoutBuilder } from './ArenaMap';

/**
 * Decoration for the free-form maps, in world block coordinates (pass the builder from `turned` to draw
 * a prop on either half). Every prop is made of solid blocks only (the arena may not hold plants, torches
 * or liquids), and none is taller than a player can see over unless it is meant to be cover.
 */

/** Content blocks without a legacy id, looked up once by name. */
export const C = {
  SMOOTH_STONE: blockId('smooth_stone'),
  POLISHED_ANDESITE: blockId('polished_andesite'),
  POLISHED_DIORITE: blockId('polished_diorite'),
  POLISHED_GRANITE: blockId('polished_granite'),
  ANDESITE: blockId('andesite'),
  CALCITE: blockId('calcite'),
  TUFF: blockId('tuff'),
  DEEPSLATE_TILES: blockId('deepslate_tiles'),
  DEEPSLATE_BRICKS: blockId('deepslate_bricks'),
  POLISHED_DEEPSLATE: blockId('polished_deepslate'),
  CRACKED_STONE_BRICKS: blockId('cracked_stone_bricks'),
  MOSSY_STONE_BRICKS: blockId('mossy_stone_bricks'),
  CHISELED_STONE_BRICKS: blockId('chiseled_stone_bricks'),
  TERRACOTTA: blockId('terracotta'),
  MUD_BRICKS: blockId('mud_bricks'),
  PACKED_MUD: blockId('packed_mud'),
  RED_SANDSTONE: blockId('red_sandstone'),
  CUT_SANDSTONE: blockId('cut_sandstone'),
  COARSE_DIRT: blockId('coarse_dirt'),
  DIRT_PATH: blockId('dirt_path'),
  PODZOL: blockId('podzol'),
  MOSS: blockId('moss_block'),
  COAL_BLOCK: blockId('coal_block'),
  IRON_BLOCK: blockId('iron_block'),
  GOLD_BLOCK: blockId('gold_block'),
  COPPER_BLOCK: blockId('copper_block'),
  LAPIS_BLOCK: blockId('lapis_block'),
  EMERALD_BLOCK: blockId('emerald_block'),
  DIAMOND_BLOCK: blockId('diamond_block'),
  REDSTONE_BLOCK: blockId('redstone_block'),
  RAW_IRON_BLOCK: blockId('raw_iron_block'),
  RAW_COPPER_BLOCK: blockId('raw_copper_block'),
  HAY: blockId('hay_block'),
  PUMPKIN: blockId('pumpkin'),
  MELON: blockId('melon'),
  PACKED_ICE: blockId('packed_ice'),
  ICE: blockId('ice'),
  SEA_LANTERN: blockId('sea_lantern'),
  BONE_BLOCK: blockId('bone_block'),
  JUNGLE_PLANKS: blockId('jungle_planks'),
  ACACIA_PLANKS: blockId('acacia_planks'),
  DARK_OAK_PLANKS: blockId('dark_oak_planks'),
  MANGROVE_PLANKS: blockId('mangrove_planks'),
  CHERRY_PLANKS: blockId('cherry_planks'),
  DARK_OAK_LOG: blockId('dark_oak_log'),
  ACACIA_LOG: blockId('acacia_log'),
  JUNGLE_LOG: blockId('jungle_log'),
  CHERRY_LOG: blockId('cherry_log'),
  STRIPPED_OAK_LOG: blockId('stripped_oak_log'),
  STRIPPED_SPRUCE_LOG: blockId('stripped_spruce_log'),
  CHERRY_LEAVES: blockId('cherry_leaves'),
  JUNGLE_LEAVES: blockId('jungle_leaves'),
  ACACIA_LEAVES: blockId('acacia_leaves'),
  DARK_OAK_LEAVES: blockId('dark_oak_leaves'),
} as const;

type B = LayoutBuilder;

/** A round tree: a trunk `trunk` high and a crown of leaves above it (radius 1 or 2). */
export function tree(b: B, x: number, z: number, log: number = BLOCK.OAK_LOG, leaves: number = BLOCK.OAK_LEAVES, trunk = 3, r: 1 | 2 = 2): void {
  const top = trunk + 1;
  if (r === 2) {
    b.box(x - 2, x + 2, z - 1, z + 1, top, top + 1, leaves);
    b.box(x - 1, x + 1, z - 2, z + 2, top, top + 1, leaves);
    b.box(x - 1, x + 1, z - 1, z + 1, top + 2, top + 2, leaves);
  } else {
    b.box(x - 1, x + 1, z - 1, z + 1, top, top + 1, leaves);
  }
  b.box(x, x, z, z, top + (r === 2 ? 3 : 2), top + (r === 2 ? 3 : 2), leaves);
  b.box(x, x, z, z, 1, trunk + 1, log);
}

/** A hedge (leaves) over a box of cells, `h` high. */
export function hedge(b: B, x0: number, x1: number, z0: number, z1: number, h = 1, leaves: number = BLOCK.OAK_LEAVES): void {
  b.box(x0, x1, z0, z1, 1, h, leaves);
}

/**
 * A car, 5 long and 3 wide (from (x, z), along x or z): a body one block high with dark wheels at the
 * corners, a glass cabin with a roof-coloured top line, head lights at the front (+x / +z end, or the
 * other end with `back`).
 */
export function car(b: B, x: number, z: number, alongX: boolean, body: number, back = false): void {
  const L = 5, W = 3;
  const [x1, z1] = alongX ? [x + L - 1, z + W - 1] : [x + W - 1, z + L - 1];
  b.box(x, x1, z, z1, 1, 1, body);
  // Wheels on the corners, lights in the middle of both ends.
  for (const [cx, cz] of [[x, z], [x1, z], [x, z1], [x1, z1]]) b.box(cx, cx, cz, cz, 1, 1, C.COAL_BLOCK);
  if (alongX) {
    b.box(x + 1, x1 - 1, z, z1, 2, 2, BLOCK.GLASS);
    b.box(x + 2, x + 2, z + 1, z + 1, 2, 2, body);
    const front = back ? x : x1, rear = back ? x1 : x;
    b.box(front, front, z + 1, z + 1, 1, 1, C.SEA_LANTERN);
    b.box(rear, rear, z + 1, z + 1, 1, 1, C.REDSTONE_BLOCK);
  } else {
    b.box(x, x1, z + 1, z1 - 1, 2, 2, BLOCK.GLASS);
    b.box(x + 1, x + 1, z + 2, z + 2, 2, 2, body);
    const front = back ? z : z1, rear = back ? z1 : z;
    b.box(x + 1, x + 1, front, front, 1, 1, C.SEA_LANTERN);
    b.box(x + 1, x + 1, rear, rear, 1, 1, C.REDSTONE_BLOCK);
  }
}

/** A street lamp: a post `h - 1` high with a light on top. */
export function lamp(b: B, x: number, z: number, h = 4, light: number = BLOCK.GLOWSTONE): void {
  b.box(x, x, z, z, 1, h - 1, BLOCK.FENCE);
  b.box(x, x, z, z, h, h, light);
}

/** A mannequin: a body two blocks high with a clay head on top. */
export function mannequin(b: B, x: number, z: number, h = 1, body: number = BLOCK.WHITE_WOOL): void {
  b.box(x, x, z, z, h, h + 1, body);
  b.box(x, x, z, z, h + 2, h + 2, BLOCK.CLAY);
}

/** A stack of crates (w × d, h high) with log corners on the bottom layer. */
export function crates(b: B, x: number, z: number, w: number, d: number, h: number, id: number = BLOCK.SPRUCE_PLANKS): void {
  b.box(x, x + w - 1, z, z + d - 1, 1, h, id);
}

/** A café umbrella: a pole and a 3 × 3 canopy at height 3 (with a white middle). */
export function umbrella(b: B, x: number, z: number, canopy: number): void {
  b.box(x - 1, x + 1, z - 1, z + 1, 3, 3, canopy);
  b.box(x, x, z, z, 3, 3, BLOCK.WHITE_WOOL);
  b.box(x, x, z, z, 1, 2, BLOCK.FENCE);
}

/** A bench of two slabs. */
export function bench(b: B, x: number, z: number, alongX: boolean, id: number = BLOCK.SPRUCE_SLAB): void {
  if (alongX) b.box(x, x + 1, z, z, 1, 1, id);
  else b.box(x, x, z, z + 1, 1, 1, id);
}

/** A run of steps from (x, z): `steps` columns in direction (dx, dz), each one higher, `w` wide across. */
export function steps(b: B, x: number, z: number, dx: number, dz: number, count: number, w: number, id: number, from = 1): void {
  for (let i = 0; i < count; i++) {
    const cx = x + dx * i, cz = z + dz * i;
    if (dx !== 0) b.box(cx, cx, z, z + w - 1, 1, from + i, id);
    else b.box(x, x + w - 1, cz, cz, 1, from + i, id);
  }
}
