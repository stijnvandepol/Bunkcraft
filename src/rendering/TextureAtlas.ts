import * as THREE from 'three';
import { DYED_TEXTURES, TEXTURE_NAMES, TINTED_TEXTURES } from '../world/BlockRegistry';
import { defaultTint } from '../world/BiomeColors';
import { CONTENT_PAINTERS } from './ContentPainters';
import { ENCHANT_PAINTERS } from './EnchantPainters';
import type { PackImage } from './TexturePacks';
import { hashString, mulberry32 } from '../world/Noise';

/**
 * Procedural 16×16 pixel-art textures, packed into a WebGL2 texture *array*.
 *
 * A texture array is a texture atlas without the classic atlas problems: each layer
 * wraps independently (so greedy-merged quads can tile a texture with plain UVs > 1)
 * and mipmaps never bleed between neighbouring tiles.
 */

import { Img, TEX_SIZE, PX, P, hex, shade, pick, noisy, voronoi, SNOW, SAND, GRASS, makeDestroyStages, type Rand, paintStone, paintDirt, paintGrassTop, paintSideFringe, paintPlanks, paintLogSide, paintBirchSide, paintLogTop, paintLeaves, paintCobble, paintOre, paintBricks, paintStoneBricks, paintWool, paintGlass, paintWater, paintGlowstone, paintBookshelf, paintCactusSide, paintCactusTop, paintSandstone, paintPlant, paintTorch, paintLava, paintCraftingTop, paintCraftingSide, paintFurnace, paintTnt, paintDoor } from './PaintKit';
export { TEX_SIZE } from './PaintKit';

const PAINTERS: Record<string, (img: Img, r: Rand) => void> = {
  oak_door_upper: (i, r) => paintDoor(i, r, 'upper'),
  oak_door_lower: (i, r) => paintDoor(i, r, 'lower'),
  tnt_top: (i, r) => paintTnt(i, r, 'top'),
  tnt_side: (i, r) => paintTnt(i, r, 'side'),
  tnt_bottom: (i, r) => paintTnt(i, r, 'bottom'),
  torch: paintTorch,
  crafting_table_top: paintCraftingTop,
  crafting_table_side: paintCraftingSide,
  furnace_front: (i, r) => paintFurnace(i, r, true),
  furnace_top: (i, r) => paintFurnace(i, r, false),
  furnace_side: (i, r) => paintFurnace(i, r, false),
  lava: paintLava,
  stone: paintStone,
  dirt: paintDirt,
  grass_top: paintGrassTop,
  grass_side: (i, r) => paintSideFringe(i, r, GRASS),
  grass_snow_side: (i, r) => paintSideFringe(i, r, SNOW),
  snow: (i, r) => noisy(i, r, SNOW, 0.5, 4),
  cobblestone: (i, r) => paintCobble(i, r, false),
  mossy_cobblestone: (i, r) => paintCobble(i, r, true),
  oak_planks: (i, r) => paintPlanks(i, r, P('#8f7040', '#9a7a48', '#a2834f', '#b08f5a'), hex('#6e5532')),
  birch_planks: (i, r) => paintPlanks(i, r, P('#bba36a', '#c8b277', '#d7c185', '#e0cb90'), hex('#9d8a5a')),
  spruce_planks: (i, r) => paintPlanks(i, r, P('#5f4426', '#6d4f2c', '#7a5a34', '#84633b'), hex('#4a3520')),
  bedrock: (i, r) => noisy(i, r, P('#1c1c1c', '#2e2e2e', '#454545', '#5e5e5e', '#7a7a7a', '#8f8f8f'), 0.35, 8),
  sand: (i, r) => noisy(i, r, SAND, 0.35, 4),
  gravel: (i, r) => {
    const { cell, edge } = voronoi(r, 16);
    const pal = P('#5d5754', '#6b6461', '#7f7a78', '#8a7f78', '#958f8b', '#a39d98');
    const cols = Array.from({ length: 16 }, () => pick(pal, r()));
    for (let k = 0; k < PX; k++) i.set(k % 16, Math.floor(k / 16), edge[k] < 0.7 ? hex('#4e4846') : shade(cols[cell[k]], 0.92 + r() * 0.16));
  },
  oak_log: (i, r) => paintLogSide(i, r, P('#4f3a22', '#5d4529', '#6b5232', '#78603b'), hex('#3a2a17')),
  oak_log_top: (i, r) => paintLogTop(i, r, P('#4f3a22', '#5d4529', '#6b5232'), hex('#b4935c'), hex('#9a7a48')),
  birch_log: paintBirchSide,
  birch_log_top: (i, r) => paintLogTop(i, r, P('#cfcbc0', '#e2dfd7', '#3a3630'), hex('#d7c185'), hex('#c2ab72')),
  spruce_log: (i, r) => paintLogSide(i, r, P('#35250f', '#3f2c19', '#4a341e', '#523a23'), hex('#24180a')),
  spruce_log_top: (i, r) => paintLogTop(i, r, P('#35250f', '#3f2c19', '#4a341e'), hex('#84633b'), hex('#6d4f2c')),
  oak_leaves: (i, r) => paintLeaves(i, r, P('#2d5219', '#355e1d', '#3f6e22', '#4a7f2a', '#57902f')),
  birch_leaves: (i, r) => paintLeaves(i, r, P('#4e7a2b', '#5a8a32', '#679a3a', '#74a845')),
  spruce_leaves: (i, r) => paintLeaves(i, r, P('#243f25', '#2b4a2c', '#335635', '#3c6240')),
  glass: paintGlass,
  water: paintWater,
  coal_ore: (i, r) => paintOre(i, r, '#2b2b2b', '#454545', '#5a5a5a'),
  iron_ore: (i, r) => paintOre(i, r, '#d8af93', '#ecd0b6', '#a07c66'),
  gold_ore: (i, r) => paintOre(i, r, '#f5df3c', '#fffaa0', '#b8901c'),
  diamond_ore: (i, r) => paintOre(i, r, '#5decf5', '#b5fbfd', '#1f9aa3'),
  cactus_side: paintCactusSide,
  cactus_top: (i, r) => paintCactusTop(i, r, 1),
  cactus_bottom: (i, r) => paintCactusTop(i, r, 0.85),
  tall_grass: (i, r) => paintPlant(i, r, 'grass'),
  dandelion: (i, r) => paintPlant(i, r, 'dandelion'),
  poppy: (i, r) => paintPlant(i, r, 'poppy'),
  dead_bush: (i, r) => paintPlant(i, r, 'dead'),
  bricks: paintBricks,
  glowstone: paintGlowstone,
  sandstone_top: (i, r) => paintSandstone(i, r, 'top'),
  sandstone_side: (i, r) => paintSandstone(i, r, 'side'),
  sandstone_bottom: (i, r) => paintSandstone(i, r, 'bottom'),
  stone_bricks: paintStoneBricks,
  white_wool: (i, r) => paintWool(i, r, '#f2f2f2'),
  red_wool: (i, r) => paintWool(i, r, '#a12722'),
  blue_wool: (i, r) => paintWool(i, r, '#35399d'),
  yellow_wool: (i, r) => paintWool(i, r, '#f2bd25'),
  green_wool: (i, r) => paintWool(i, r, '#546d1b'),
  clay: (i, r) => noisy(i, r, P('#979ca8', '#9ea4b0', '#a5abb8', '#adb3bf'), 0.5, 4),
  obsidian: (i, r) => {
    noisy(i, r, P('#0f0b16', '#14101e', '#1b1529', '#221a33'), 0.55, 4);
    for (let k = 0; k < 10; k++) i.set(Math.floor(r() * 16), Math.floor(r() * 16), hex('#3b2856'));
  },
  bookshelf: paintBookshelf,
  ...CONTENT_PAINTERS,
  ...ENCHANT_PAINTERS,
};

/** Names of all textures that have a procedural painter (tests check that every texture the registry uses is among them). */
export const PAINTER_NAMES: ReadonlySet<string> = new Set(Object.keys(PAINTERS));

/**
 * Transparent pixels get the average colour of the opaque ones so mipmapping does not
 * produce dark fringes around leaves and glass at a distance.
 */
function bleedTransparent(img: Img): void {
  let r = 0, g = 0, b = 0, n = 0;
  const d = img.data;
  for (let i = 0; i < PX; i++) {
    if (d[i * 4 + 3] > 0) { r += d[i * 4]; g += d[i * 4 + 1]; b += d[i * 4 + 2]; n++; }
  }
  if (n === 0) return;
  for (let i = 0; i < PX; i++) {
    if (d[i * 4 + 3] === 0) { d[i * 4] = r / n; d[i * 4 + 1] = g / n; d[i * 4 + 2] = b / n; }
  }
}

/**
 * Converts a tintable texture to greyscale for biome tinting. Brightness is normalised so
 * that multiplying by the biome colour gives Minecraft-like values regardless of how the
 * source (procedural or texture pack) was coloured. Tinted pixels of opaque textures get
 * alpha 128 (the opaque shader reads alpha as the tint mask).
 */
function makeTintable(src: Img, name: string, packMask?: Uint8Array, normalise = true): Img {
  const spec = TINTED_TEXTURES[name];
  if (!spec) return src;
  const img = new Img();
  img.data.set(src.data);
  const d = img.data;
  const affected = new Uint8Array(PX);
  let sum = 0, n = 0;
  for (let i = 0; i < PX; i++) {
    const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2], a = d[i * 4 + 3];
    if (a === 0) continue;
    if (spec.mode === 'mask' && (packMask ? !packMask[i] : !(g > r * 1.08 && g > b * 1.05))) continue;
    affected[i] = 1;
    sum += 0.299 * r + 0.587 * g + 0.114 * b;
    n++;
  }
  if (n === 0) return src;
  const mean = sum / n;
  for (let i = 0; i < PX; i++) {
    if (!affected[i]) continue;
    const lum = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    // Packs made for tinting (Minecraft) are already greyscale with the right brightness.
    const v = normalise ? Math.max(0, Math.min(255, 255 * 0.68 * (1 + (lum / mean - 1) * 1.15))) : lum;
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
    if (spec.opaque) d[i * 4 + 3] = 128;
  }
  return img;
}

/** Opaque dye-family textures: alpha 128 on every pixel makes the opaque shader multiply them by the vertex tint. */
function makeDyed(src: Img, name: string): Img {
  if (!DYED_TEXTURES[name]?.opaque) return src;
  const img = new Img();
  img.data.set(src.data);
  for (let i = 0; i < PX; i++) img.data[i * 4 + 3] = 128;
  return img;
}

/** Display version of a texture for UI icons: tinted with the default (plains) colour. */
function displayImage(img: Img, name: string): Img {
  if (DYED_TEXTURES[name]?.opaque) {
    const out = new Img();
    out.data.set(img.data);
    for (let i = 0; i < PX; i++) out.data[i * 4 + 3] = 255;
    return out;
  }
  const spec = TINTED_TEXTURES[name];
  if (!spec) return img;
  const out = new Img();
  out.data.set(img.data);
  const d = out.data;
  const t = defaultTint(spec.type);
  for (let i = 0; i < PX; i++) {
    const a = d[i * 4 + 3];
    const tinted = spec.opaque ? a < 200 : a > 0;
    if (!tinted) continue;
    d[i * 4] = (d[i * 4] * t[0]) / 255;
    d[i * 4 + 1] = (d[i * 4 + 1] * t[1]) / 255;
    d[i * 4 + 2] = (d[i * 4 + 2] * t[2]) / 255;
    if (spec.opaque) d[i * 4 + 3] = 255;
  }
  return out;
}

export interface TextureSet {
  texture: THREE.DataArrayTexture;
  /** Unflipped 16×16 canvas per texture name (for UI icons). */
  canvas(name: string): HTMLCanvasElement;
  /** Replace layers with texture-pack images; textures missing from the map revert to procedural. */
  applyPack(images: Map<string, PackImage> | null, greyscaleTints?: boolean): void;
  layers: number;
}

export function buildTextures(maxAnisotropy: number): TextureSet {
  const layers = TEXTURE_NAMES.length;
  const data = new Uint8Array(PX * 4 * layers);
  const procedural = new Map<string, Img>();
  const current = new Map<string, Img>();
  const destroy = makeDestroyStages();

  const upload = (name: string, layer: number, img: Img) => {
    const tmp = new Img();
    tmp.data.set(img.data);
    if (!name.startsWith('destroy_')) bleedTransparent(tmp);
    // Flip rows: layer row 0 = bottom of the image, so v points "up" on side faces.
    for (let y = 0; y < TEX_SIZE; y++) {
      const src = (TEX_SIZE - 1 - y) * TEX_SIZE * 4;
      data.set(tmp.data.subarray(src, src + TEX_SIZE * 4), layer * PX * 4 + y * TEX_SIZE * 4);
    }
  };

  TEXTURE_NAMES.forEach((name, layer) => {
    let img: Img;
    if (name.startsWith('destroy_')) img = destroy[Number(name.slice(8))];
    else {
      img = new Img();
      const painter = PAINTERS[name];
      if (!painter) throw new Error(`No painter for texture ${name}`);
      painter(img, mulberry32(hashString(name)));
    }
    procedural.set(name, makeTintable(img, name));
    img = makeDyed(procedural.get(name)!, name);
    current.set(name, procedural.get(name)!);
    upload(name, layer, img);
  });

  const texture = new THREE.DataArrayTexture(data, TEX_SIZE, TEX_SIZE, layers);
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestMipmapLinearFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.generateMipmaps = true;
  texture.anisotropy = Math.min(4, maxAnisotropy);
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;

  const canvases = new Map<string, HTMLCanvasElement>();
  return {
    texture,
    layers,
    canvas(name: string) {
      let c = canvases.get(name);
      if (!c) {
        const raw = current.get(name);
        if (!raw) throw new Error(`Unknown texture ${name}`);
        const img = displayImage(raw, name);
        c = document.createElement('canvas');
        c.width = c.height = TEX_SIZE;
        c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), TEX_SIZE, TEX_SIZE), 0, 0);
        canvases.set(name, c);
      }
      return c;
    },
    applyPack(images, greyscaleTints = false) {
      TEXTURE_NAMES.forEach((name, layer) => {
        const packed = images?.get(name);
        let img = procedural.get(name)!;
        if (packed && packed.data.width === TEX_SIZE && packed.data.height === TEX_SIZE) {
          img = new Img();
          img.data.set(packed.data.data);
          img = makeTintable(img, name, packed.mask, !greyscaleTints);
        }
        current.set(name, img);
        upload(name, layer, makeDyed(img, name));
      });
      canvases.clear();
      texture.needsUpdate = true;
    },
  };
}
