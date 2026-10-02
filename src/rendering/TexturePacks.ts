import { unzip } from 'fflate';

/**
 * Texture packs. A layout maps engine texture names to image files using a small spec
 * language:
 *   "a|b"          first alternative whose files all exist (renamed files across versions)
 *   "base^overlay" composite images on top of each other
 *   "img*#RRGGBB"  multiply by a colour (e.g. Minecraft's greyscale water)
 * Textures a pack does not provide keep the built-in procedural version.
 */
export interface PackLayout {
  textures: Record<string, string>;
  /** Image whose alpha marks the biome-tinted pixels (e.g. grass side overlay). */
  masks?: Record<string, string>;
  /** Tintable textures are already greyscale and designed for tinting: no normalisation. */
  greyscaleTints?: boolean;
}

export interface TexturePackInfo {
  id: string;
  name: string;
  credit: string;
  layout: PackLayout;
  /** Folder for built-in packs (served from /public). */
  path?: string;
}

export interface PackImage {
  data: ImageData;
  /** Per pixel 1 = biome tinted (only for masked textures). */
  mask?: Uint8Array;
}

export const PROCEDURAL_PACK_ID = 'procedural';
export const IMPORTED_PREFIX = 'import:';

const PIXEL_PERFECTION: PackLayout = {
  textures: {
    stone: 'default_stone',
    dirt: 'default_dirt',
    grass_top: 'default_grass',
    grass_side: 'default_dirt^default_grass_side',
    grass_snow_side: 'default_dirt^default_snow_side',
    snow: 'default_snow',
    cobblestone: 'default_cobble',
    mossy_cobblestone: 'default_mossycobble',
    oak_planks: 'default_wood',
    birch_planks: 'default_aspen_wood',
    spruce_planks: 'default_pine_wood',
    bedrock: 'bedrock',
    sand: 'default_sand',
    gravel: 'default_gravel',
    oak_log: 'default_tree',
    oak_log_top: 'default_tree_top',
    birch_log: 'default_aspen_tree',
    birch_log_top: 'default_aspen_tree_top',
    spruce_log: 'default_pine_tree',
    spruce_log_top: 'default_pine_tree_top',
    oak_leaves: 'default_leaves',
    birch_leaves: 'default_aspen_leaves',
    spruce_leaves: 'default_pine_needles',
    glass: 'default_glass',
    water: 'default_water_source_animated',
    coal_ore: 'default_stone^default_mineral_coal',
    iron_ore: 'default_stone^default_mineral_iron',
    gold_ore: 'default_stone^default_mineral_gold',
    diamond_ore: 'default_stone^default_mineral_diamond',
    cactus_side: 'default_cactus_side',
    cactus_top: 'default_cactus_top',
    cactus_bottom: 'default_cactus_top',
    tall_grass: 'default_grass_3',
    dandelion: 'flowers_dandelion_yellow',
    poppy: 'flowers_rose',
    dead_bush: 'default_dry_shrub',
    bricks: 'default_brick',
    sandstone_top: 'default_sandstone',
    sandstone_side: 'default_sandstone',
    sandstone_bottom: 'default_sandstone',
    stone_bricks: 'default_stone_brick',
    white_wool: 'wool_white',
    red_wool: 'wool_red',
    blue_wool: 'wool_blue',
    yellow_wool: 'wool_yellow',
    green_wool: 'wool_green',
    clay: 'default_clay',
    obsidian: 'default_obsidian',
    bookshelf: 'default_bookshelf',
    lava: 'default_lava',
    crafting_table_top: 'crafting_work_bench_top',
    crafting_table_side: 'crafting_work_bench_side',
    furnace_front: 'default_furnace_front',
    furnace_top: 'default_furnace_top',
    furnace_side: 'default_furnace_side',
    tnt_top: 'tnt_top',
    tnt_side: 'tnt_side',
    tnt_bottom: 'tnt_bottom',
    // The door sheet (38×32) holds both halves in its left 16 columns: "file@x,y,w,h,sheetHeight" crops a part.
    oak_door_upper: 'doors_door_wood@0,0,16,16,32',
    oak_door_lower: 'doors_door_wood@0,16,16,16,32',
  },
};

/**
 * Layout of a Minecraft Java resource pack / client jar (1.13+ "block" folder names).
 * Used only for packs the player imports from their own files; nothing is bundled.
 */
export const MINECRAFT_LAYOUT: PackLayout = {
  greyscaleTints: true,
  textures: {
    stone: 'stone',
    dirt: 'dirt',
    grass_top: 'grass_block_top',
    grass_side: 'dirt^grass_block_side_overlay',
    grass_snow_side: 'grass_block_snow',
    snow: 'snow',
    cobblestone: 'cobblestone',
    mossy_cobblestone: 'mossy_cobblestone',
    oak_planks: 'oak_planks',
    birch_planks: 'birch_planks',
    spruce_planks: 'spruce_planks',
    bedrock: 'bedrock',
    sand: 'sand',
    gravel: 'gravel',
    oak_log: 'oak_log',
    oak_log_top: 'oak_log_top',
    birch_log: 'birch_log',
    birch_log_top: 'birch_log_top',
    spruce_log: 'spruce_log',
    spruce_log_top: 'spruce_log_top',
    oak_leaves: 'oak_leaves',
    birch_leaves: 'birch_leaves',
    spruce_leaves: 'spruce_leaves',
    glass: 'glass',
    water: 'water_still*#3F76E4',
    coal_ore: 'coal_ore',
    iron_ore: 'iron_ore',
    gold_ore: 'gold_ore',
    diamond_ore: 'diamond_ore',
    cactus_side: 'cactus_side',
    cactus_top: 'cactus_top',
    cactus_bottom: 'cactus_bottom',
    tall_grass: 'short_grass|grass',
    dandelion: 'dandelion',
    poppy: 'poppy',
    dead_bush: 'dead_bush',
    bricks: 'bricks',
    glowstone: 'glowstone',
    sandstone_top: 'sandstone_top',
    sandstone_side: 'sandstone',
    sandstone_bottom: 'sandstone_bottom',
    stone_bricks: 'stone_bricks',
    white_wool: 'white_wool',
    red_wool: 'red_wool',
    blue_wool: 'blue_wool',
    yellow_wool: 'yellow_wool',
    green_wool: 'green_wool',
    clay: 'clay',
    obsidian: 'obsidian',
    bookshelf: 'bookshelf',
    torch: 'torch',
    lava: 'lava_still',
    crafting_table_top: 'crafting_table_top',
    crafting_table_side: 'crafting_table_front',
    furnace_front: 'furnace_front',
    furnace_top: 'furnace_top',
    furnace_side: 'furnace_side',
    tnt_top: 'tnt_top',
    tnt_side: 'tnt_side',
    tnt_bottom: 'tnt_bottom',
    oak_door_upper: 'oak_door_top',
    oak_door_lower: 'oak_door_bottom',
    ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`destroy_${i}`, `destroy_stage_${i}`])),
  },
  masks: { grass_side: 'grass_block_side_overlay' },
};

export const BUILTIN_PACKS: TexturePackInfo[] = [
  {
    id: 'pixel-perfection',
    name: 'Pixel Perfection',
    credit: 'Pixel Perfection by Hugh "XSSheep" Rutland & contributors — CC BY-SA 4.0',
    path: 'texturepacks/pixel-perfection/',
    layout: PIXEL_PERFECTION,
  },
];

export function findBuiltinPack(id: string): TexturePackInfo | undefined {
  return BUILTIN_PACKS.find((p) => p.id === id);
}

/** Resolves an image file name (without extension) to a loadable URL, or null. */
export type FileResolver = (file: string) => string | null;

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

interface ParsedLayer {
  file: string;
  /**
   * Source rectangle x, y, w, h and the sheet height they were measured on ("file@x,y,w,h,sheetH"), so an HD
   * version of the same sheet is cropped at the same place. null = the first square frame.
   */
  rect: [number, number, number, number, number] | null;
}

interface ParsedAlt {
  layers: ParsedLayer[];
  multiply: [number, number, number] | null;
}

function parseSpec(spec: string): ParsedAlt[] {
  return spec.split('|').map((alt) => {
    const [files, color] = alt.split('*');
    const c = color ? parseInt(color.slice(1), 16) : -1;
    const layers = files.split('^').map((l): ParsedLayer => {
      const [file, rect] = l.split('@');
      const r = rect ? rect.split(',').map(Number) : null;
      return { file, rect: r && r.length === 5 ? [r[0], r[1], r[2], r[3], r[4]] : null };
    });
    return { layers, multiply: c >= 0 ? [(c >> 16) & 255, (c >> 8) & 255, c & 255] : null };
  });
}

/**
 * Loads every texture of a layout and composites it to `size`×`size` RGBA images.
 * Tall images (animation strips) contribute their first square frame; larger
 * (HD) textures are downscaled with nearest-neighbour sampling.
 */
export async function loadPack(layout: PackLayout, resolve: FileResolver, size: number): Promise<Map<string, PackImage>> {
  const files = new Set<string>();
  for (const spec of Object.values(layout.textures)) for (const alt of parseSpec(spec)) alt.layers.forEach((l) => files.add(l.file));
  for (const m of Object.values(layout.masks ?? {})) files.add(m);
  const images = new Map<string, HTMLImageElement>();
  await Promise.all([...files].map(async (f) => {
    const url = resolve(f);
    const img = url ? await loadImage(url) : null;
    if (img) images.set(f, img);
  }));

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = false;
  const draw = (img: HTMLImageElement, rect: ParsedLayer['rect'] = null) => {
    const frame = Math.min(img.width, img.height);
    if (rect) {
      const k = img.height / rect[4];
      ctx.drawImage(img, rect[0] * k, rect[1] * k, rect[2] * k, rect[3] * k, 0, 0, size, size);
    } else ctx.drawImage(img, 0, 0, frame, frame, 0, 0, size, size);
  };

  const out = new Map<string, PackImage>();
  for (const [name, spec] of Object.entries(layout.textures)) {
    const alt = parseSpec(spec).find((a) => a.layers.every((l) => images.has(l.file)));
    if (!alt) continue;
    ctx.clearRect(0, 0, size, size);
    for (const l of alt.layers) draw(images.get(l.file)!, l.rect);
    const data = ctx.getImageData(0, 0, size, size);
    if (alt.multiply) {
      const [r, g, b] = alt.multiply;
      for (let i = 0; i < data.data.length; i += 4) {
        data.data[i] = (data.data[i] * r) / 255;
        data.data[i + 1] = (data.data[i + 1] * g) / 255;
        data.data[i + 2] = (data.data[i + 2] * b) / 255;
      }
    }
    let mask: Uint8Array | undefined;
    const maskFile = layout.masks?.[name];
    if (maskFile && images.has(maskFile)) {
      ctx.clearRect(0, 0, size, size);
      draw(images.get(maskFile)!);
      const m = ctx.getImageData(0, 0, size, size).data;
      mask = new Uint8Array(size * size);
      for (let i = 0; i < mask.length; i++) mask[i] = m[i * 4 + 3] > 0 ? 1 : 0;
    }
    out.set(name, { data, mask });
  }
  return out;
}

export function builtinResolver(pack: TexturePackInfo): FileResolver {
  const base = import.meta.env.BASE_URL + (pack.path ?? '');
  return (f) => `${base}${f}.png`;
}

/** All file names (without extension) a layout may reference. */
function layoutFiles(layout: PackLayout): Set<string> {
  const files = new Set<string>();
  for (const spec of Object.values(layout.textures)) for (const alt of parseSpec(spec)) alt.layers.forEach((l) => files.add(l.file));
  for (const m of Object.values(layout.masks ?? {})) files.add(m);
  return files;
}

export interface ImportedPack {
  id: string;
  name: string;
  /** PNG bytes per file name (only the textures BunkCraft uses). */
  files: Record<string, Uint8Array>;
  created: number;
}

/** Limits for user-supplied archives (zip bombs, decompression bombs and oversized images). */
export const PACK_LIMITS = {
  /** Archive size; a Minecraft client jar is about 25 MB. */
  archiveBytes: 512 * 1024 * 1024,
  /** Uncompressed size of one texture (a 1024x1024 PNG is well below this). */
  fileBytes: 4 * 1024 * 1024,
  /** Uncompressed size of everything extracted. */
  totalBytes: 48 * 1024 * 1024,
  /** Width and height of one texture in pixels (decoded RGBA size is bounded by this). */
  imageSize: 2048,
};

/** True for a PNG whose header (signature, IHDR) says it is at most PACK_LIMITS.imageSize pixels square-ish. */
export function isSafePng(bytes: Uint8Array): boolean {
  if (bytes.length < 33) return false;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (sig.some((b, i) => bytes[i] !== b)) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(12) !== 0x49484452) return false; // "IHDR"
  const w = view.getUint32(16), h = view.getUint32(20);
  return w > 0 && h > 0 && w <= PACK_LIMITS.imageSize && h <= PACK_LIMITS.imageSize * 64;
}

const BLOCK_DIR = /^assets\/minecraft\/textures\/block\/([a-z0-9_]+)\.png$/;

/**
 * Extracts the block textures BunkCraft needs from a Minecraft client .jar or a
 * resource pack .zip (1.13+ layout). Only the needed files are decompressed.
 */
export async function importMinecraftArchive(file: File): Promise<ImportedPack> {
  const wanted = layoutFiles(MINECRAFT_LAYOUT);
  if (file.size > PACK_LIMITS.archiveBytes) throw new Error('This file is too large to be a Minecraft jar or resource pack.');
  let budget = PACK_LIMITS.totalBytes;
  const buffer = new Uint8Array(await file.arrayBuffer());
  const files = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    unzip(buffer, {
      filter: (f) => {
        const m = BLOCK_DIR.exec(f.name);
        if (!m || !wanted.has(m[1])) return false;
        // Check the declared sizes before anything is inflated (a zip bomb inflates a tiny entry to gigabytes).
        if (f.originalSize > PACK_LIMITS.fileBytes || (budget -= f.originalSize) < 0) return false;
        return true;
      },
    }, (err, data) => (err ? reject(err) : resolve(data)));
  });
  const out: Record<string, Uint8Array> = {};
  for (const [path, bytes] of Object.entries(files)) {
    if (bytes.length <= PACK_LIMITS.fileBytes && isSafePng(bytes)) out[BLOCK_DIR.exec(path)![1]] = bytes;
  }
  if (Object.keys(out).length < 10) {
    throw new Error('No Minecraft 1.13+ block textures found in this file (expected assets/minecraft/textures/block/*.png).');
  }
  return {
    id: `${Date.now().toString(36)}`,
    name: file.name.replace(/\.(jar|zip)$/i, ''),
    files: out,
    created: Date.now(),
  };
}

/** Resolver backed by object URLs; call the returned dispose() when done. */
export function importedResolver(pack: ImportedPack): { resolve: FileResolver; dispose(): void } {
  const urls = new Map<string, string>();
  for (const [name, bytes] of Object.entries(pack.files)) {
    urls.set(name, URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/png' })));
  }
  return {
    resolve: (f) => urls.get(f) ?? null,
    dispose: () => urls.forEach((u) => URL.revokeObjectURL(u)),
  };
}
