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
    // Woods, sapling, chest and metal blocks Pixel Perfection has an equivalent for (the rest stays procedural).
    jungle_planks: 'default_junglewood',
    jungle_log: 'default_jungletree',
    jungle_log_top: 'default_jungletree_top',
    jungle_leaves: 'default_jungleleaves',
    acacia_planks: 'default_acacia_wood',
    acacia_log: 'default_acacia_tree',
    acacia_log_top: 'default_acacia_tree_top',
    acacia_leaves: 'default_acacia_leaves',
    oak_sapling: 'default_sapling',
    birch_sapling: 'default_aspen_sapling',
    spruce_sapling: 'default_pine_sapling',
    jungle_sapling: 'default_junglesapling',
    acacia_sapling: 'default_acacia_sapling',
    chest_top: 'default_chest_top',
    chest_side: 'default_chest_side',
    chest_front: 'default_chest_front',
    coal_block: 'default_coal_block',
    iron_block: 'default_steel_block',
    gold_block: 'default_gold_block',
    diamond_block: 'default_diamond_block',
    copper_block: 'default_copper_block',
    copper_ore: 'default_stone^default_mineral_copper',
    red_sand: 'default_desert_sand',
    red_sandstone_top: 'default_desert_stone',
    red_sandstone: 'default_desert_stone',
    red_sandstone_bottom: 'default_desert_stone',
    cut_sandstone: 'default_sandstone_brick',
    cut_red_sandstone: 'default_desert_stone_brick',
    ice: 'default_ice',
    ladder: 'default_ladder_wood',
    sugar_cane: 'default_papyrus',
    fern: 'default_junglegrass',
    hay_top: 'farming_straw_top',
    hay_side: 'farming_straw',
    brown_mushroom: 'flowers_mushroom_brown',
    red_mushroom: 'flowers_mushroom_red',
    red_tulip: 'flowers_tulip',
    cornflower: 'flowers_geranium',
    allium: 'flowers_viola',
    azure_bluet: 'flowers_dandelion_white',
    oxeye_daisy: 'flowers_dandelion_white',
  },
};

/**
 * Layout of a Minecraft Java resource pack / client jar (1.13+ "block" folder names).
 * Used only for packs the player imports from their own files; nothing is bundled.
 */
/** Textures whose name is the same in the engine and in a Minecraft 1.21 pack (the content tables, see world/Content.ts). */
const MINECRAFT_SAME_NAME = [
  'granite', 'diorite', 'andesite', 'polished_granite', 'polished_diorite', 'polished_andesite', 'smooth_stone', 'mossy_stone_bricks',
  'cracked_stone_bricks', 'chiseled_stone_bricks', 'tuff', 'calcite', 'deepslate', 'deepslate_top', 'cobbled_deepslate', 'polished_deepslate',
  'deepslate_bricks', 'deepslate_tiles', 'red_sand', 'red_sandstone_top', 'red_sandstone', 'red_sandstone_bottom', 'chiseled_sandstone',
  'cut_sandstone', 'chiseled_red_sandstone', 'cut_red_sandstone', 'coarse_dirt', 'podzol_top', 'podzol_side', 'mycelium_top', 'mycelium_side',
  'dirt_path_top', 'dirt_path_side', 'mud', 'mud_bricks', 'packed_mud', 'terracotta', 'moss_block', 'copper_ore', 'lapis_ore', 'redstone_ore',
  'emerald_ore', 'coal_block', 'iron_block', 'gold_block', 'diamond_block', 'copper_block', 'lapis_block', 'emerald_block', 'redstone_block',
  'raw_iron_block', 'raw_copper_block', 'raw_gold_block', 'pumpkin_top', 'pumpkin_side', 'melon_top', 'melon_side', 'ice', 'packed_ice',
  'sea_lantern', 'bone_block_top', 'bone_block_side', 'cobweb', 'sponge', 'brown_mushroom', 'red_mushroom', 'blue_orchid', 'allium',
  'azure_bluet', 'red_tulip', 'orange_tulip', 'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'fern', 'sugar_cane', 'iron_bars', 'ladder',
  'white_concrete', 'white_stained_glass', 'oak_sapling', 'spruce_sapling', 'birch_sapling', 'jungle_sapling', 'acacia_sapling',
  'dark_oak_sapling', 'cherry_sapling', 'stripped_oak_log', 'stripped_oak_log_top', 'stripped_spruce_log', 'stripped_spruce_log_top',
  'stripped_birch_log', 'stripped_birch_log_top',
  ...['jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry'].flatMap((w) => [
    `${w}_planks`, `${w}_log`, `${w}_log_top`, `stripped_${w}_log`, `stripped_${w}_log_top`, `${w}_leaves`,
  ]),
];

export const MINECRAFT_LAYOUT: PackLayout = {
  greyscaleTints: true,
  textures: {
    ...Object.fromEntries(MINECRAFT_SAME_NAME.map((n) => [n, n])),
    farmland_top: 'farmland',
    hay_top: 'hay_block_top',
    hay_side: 'hay_block_side',
    carved_pumpkin_front: 'carved_pumpkin',
    jack_o_lantern_front: 'jack_o_lantern',
    dyed_terracotta: 'white_terracotta',
    dyed_glazed_terracotta: 'white_glazed_terracotta',
    ...Object.fromEntries(['spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry'].flatMap((w) => [
      [`${w}_door_upper`, `${w}_door_top`], [`${w}_door_lower`, `${w}_door_bottom`],
    ])),
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

const BLOCK_DIR = /^assets\/minecraft\/textures\/block\/([a-z0-9_]+)\.png$/;

/**
 * Extracts the block textures BunkCraft needs from a Minecraft client .jar or a
 * resource pack .zip (1.13+ layout). Only the needed files are decompressed.
 */
export async function importMinecraftArchive(file: File): Promise<ImportedPack> {
  const wanted = layoutFiles(MINECRAFT_LAYOUT);
  const buffer = new Uint8Array(await file.arrayBuffer());
  const files = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    unzip(buffer, {
      filter: (f) => {
        const m = BLOCK_DIR.exec(f.name);
        return !!m && wanted.has(m[1]);
      },
    }, (err, data) => (err ? reject(err) : resolve(data)));
  });
  const out: Record<string, Uint8Array> = {};
  for (const [path, bytes] of Object.entries(files)) out[BLOCK_DIR.exec(path)![1]] = bytes;
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
