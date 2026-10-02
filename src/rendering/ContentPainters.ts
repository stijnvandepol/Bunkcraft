import {
  type Img, type Rand, P, PX, hex, noisy, paintCobble, paintLeaves, paintLogSide, paintLogTop, paintOre, paintPlanks, paintStoneBricks,
  paintWool, pick, shade, tileNoise, voronoi,
} from './PaintKit';
import { NEW_WOODS, OLD_WOODS, WOODS } from '../world/Content';

/**
 * Procedural painters for the textures of the content tables (see world/Content.ts). Every texture the game
 * uses has one of these, so the game looks complete without a texture pack. Colours are the average hues of the
 * Minecraft 1.21 textures, drawn as plain pixel art (nothing is copied from the game).
 */
type Painter = (img: Img, r: Rand) => void;
export const CONTENT_PAINTERS: Record<string, Painter> = {};

const put = (name: string, p: Painter): void => { CONTENT_PAINTERS[name] = p; };

// ---------------------------------------------------------------- helpers

function each(_img: Img, f: (x: number, y: number) => void): void {
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) f(x, y);
}

/** Palette noise with a lighter top/left edge and darker bottom/right edge (polished and smooth stones). */
function polished(img: Img, r: Rand, pal: string[], bevel = true): void {
  noisy(img, r, P(...pal), 0.7, 2);
  if (!bevel) return;
  for (let i = 0; i < 16; i++) {
    img.set(i, 0, shade(img.get(i, 0), 1.1)); img.set(0, i, shade(img.get(0, i), 1.1));
    img.set(i, 15, shade(img.get(i, 15), 0.88)); img.set(15, i, shade(img.get(15, i), 0.88));
  }
}

/** A grid of bricks `bw`×`bh` pixels, every second row shifted; mortar lines are 1 px. */
function brickGrid(img: Img, r: Rand, pal: string[], mortar: string, bw: number, bh: number): void {
  const colours = P(...pal);
  const m = hex(mortar);
  each(img, (x, y) => {
    const row = Math.floor(y / bh);
    const lx = (x + (row % 2 === 1 ? bw / 2 : 0) + 16) % bw;
    const ly = y % bh;
    if (ly === bh - 1 || lx === bw - 1) img.set(x, y, m);
    else img.set(x, y, shade(pick(colours, r()), ly === 0 ? 1.08 : 1));
  });
}

function sprinkle(img: Img, r: Rand, colour: string, count: number): void {
  const c = hex(colour);
  for (let k = 0; k < count; k++) img.set(Math.floor(r() * 16), Math.floor(r() * 16), c);
}

function crack(img: Img, r: Rand, colour: string, count: number): void {
  const c = hex(colour);
  for (let k = 0; k < count; k++) {
    let x = Math.floor(r() * 16), y = Math.floor(r() * 16);
    const len = 3 + Math.floor(r() * 4);
    for (let i = 0; i < len; i++) {
      img.set(x, y, c);
      if (r() < 0.5) x = (x + (r() < 0.5 ? 1 : -1) + 16) % 16; else y = (y + 1) % 16;
    }
  }
}

// ---------------------------------------------------------------- stone family

const GRANITE = ['#8e5f50', '#9a6858', '#a5725f', '#b07d69', '#99665a'];
const DIORITE = ['#b9b9b9', '#c6c6c6', '#d3d3d3', '#e0dede', '#a8a8a8'];
const ANDESITE = ['#7d7d7d', '#868686', '#8e8e8e', '#979797', '#737373'];

put('granite', (i, r) => { noisy(i, r, P(...GRANITE), 0.45, 4); sprinkle(i, r, '#c89a86', 14); sprinkle(i, r, '#6f4638', 8); });
put('diorite', (i, r) => { noisy(i, r, P(...DIORITE), 0.4, 4); sprinkle(i, r, '#6a6a6a', 14); sprinkle(i, r, '#ffffff', 10); });
put('andesite', (i, r) => { noisy(i, r, P(...ANDESITE), 0.5, 4); sprinkle(i, r, '#a8a8a0', 12); sprinkle(i, r, '#5e5e5e', 10); });
put('polished_granite', (i, r) => polished(i, r, ['#99665a', '#a2705f', '#aa7866']));
put('polished_diorite', (i, r) => polished(i, r, ['#c4c4c4', '#cccccc', '#d6d6d6']));
put('polished_andesite', (i, r) => polished(i, r, ['#828282', '#888888', '#909090']));
put('smooth_stone', (i, r) => polished(i, r, ['#9a9a9a', '#a0a0a0', '#a6a6a6'], false));
put('mossy_stone_bricks', (i, r) => {
  paintStoneBricks(i, r);
  const n = tileNoise(r, 4);
  const moss = P('#3f5a24', '#4d6b2c', '#5a7a32');
  each(i, (x, y) => { if (n[y * 16 + x] > 0.58 && r() < 0.85) i.set(x, y, pick(moss, r())); });
});
put('cracked_stone_bricks', (i, r) => { paintStoneBricks(i, r); crack(i, r, '#3e3e3e', 6); });
put('chiseled_stone_bricks', (i, r) => {
  polished(i, r, ['#7b7b7b', '#838383', '#8a8a8a'], false);
  const edge = hex('#4c4c4c'), hi = hex('#9c9c9c');
  for (let k = 0; k < 16; k++) { i.set(k, 0, edge); i.set(k, 15, edge); i.set(0, k, edge); i.set(15, k, edge); }
  for (let k = 2; k < 14; k++) { i.set(k, 2, hi); i.set(k, 13, edge); i.set(2, k, hi); i.set(13, k, edge); }
  for (let k = 5; k < 11; k++) { i.set(k, 5, edge); i.set(k, 10, edge); i.set(5, k, edge); i.set(10, k, edge); }
});
put('tuff', (i, r) => {
  noisy(i, r, P('#5f5f55', '#6b6b60', '#76766a', '#82827a'), 0.4, 3);
  sprinkle(i, r, '#8d8f80', 12); sprinkle(i, r, '#4e4e46', 12);
});
put('calcite', (i, r) => { noisy(i, r, P('#d8d9d3', '#e2e3dd', '#ececE7', '#f4f4f0'), 0.5, 3); sprinkle(i, r, '#bdbfb8', 8); });
put('deepslate', (i, r) => {
  noisy(i, r, P('#4a4a50', '#505057', '#56565e', '#5e5e66'), 0.55, 4);
  for (let y = 0; y < 16; y += 3) for (let x = 0; x < 16; x++) if (r() < 0.6) i.set(x, y, shade(i.get(x, y), 1.12));
});
put('deepslate_top', (i, r) => { noisy(i, r, P('#43434a', '#4a4a51', '#505058'), 0.6, 4); sprinkle(i, r, '#5f5f68', 12); });
put('cobbled_deepslate', (i, r) => {
  const { cell, edge } = voronoi(r, 10);
  const pal = P('#4b4b52', '#55555c', '#5f5f67', '#6a6a72');
  const cols = Array.from({ length: 10 }, () => pick(pal, r()));
  each(i, (x, y) => { const k = y * 16 + x; i.set(x, y, edge[k] < 1.1 ? hex('#303036') : shade(cols[cell[k]], 0.92 + r() * 0.14)); });
});
put('polished_deepslate', (i, r) => {
  brickGrid(i, r, ['#4e4e55', '#54545b', '#5a5a62'], '#35353b', 8, 8);
  each(i, (x, y) => { if (x % 8 === 7 || y % 8 === 7) i.set(x, y, hex('#35353b')); });
});
put('deepslate_bricks', (i, r) => brickGrid(i, r, ['#4a4a51', '#505057', '#565660'], '#2f2f35', 8, 4));
put('deepslate_tiles', (i, r) => {
  brickGrid(i, r, ['#44444b', '#4a4a52', '#50505a'], '#2c2c32', 8, 4);
  each(i, (x, y) => { if (x % 4 === 3 && y % 4 !== 3 && r() < 0.0) i.set(x, y, hex('#2c2c32')); });
});

// ---------------------------------------------------------------- sand family

const RED_SAND = ['#b3601d', '#bc6a24', '#c4742c', '#cc7e35', '#a85a1a'];
put('red_sand', (i, r) => noisy(i, r, P(...RED_SAND), 0.35, 4));
function sandy(img: Img, r: Rand, pal: string[], part: 'top' | 'side' | 'bottom'): void {
  noisy(img, r, P(...pal), part === 'top' ? 0.8 : 0.5, 4);
  if (part === 'side') {
    for (let x = 0; x < 16; x++) {
      for (let y = 0; y < 3; y++) img.set(x, y, shade(img.get(x, y), 1.06));
      img.set(x, 3, shade(img.get(x, 3), 0.86));
      if (r() < 0.6) img.set(x, 9, shade(img.get(x, 9), 0.9));
      for (let y = 13; y < 16; y++) img.set(x, y, shade(img.get(x, y), 0.88));
    }
  } else if (part === 'bottom') each(img, (x, y) => img.set(x, y, shade(img.get(x, y), 0.92)));
}
put('red_sandstone_top', (i, r) => sandy(i, r, RED_SAND, 'top'));
put('red_sandstone', (i, r) => sandy(i, r, RED_SAND, 'side'));
put('red_sandstone_bottom', (i, r) => sandy(i, r, RED_SAND, 'bottom'));
function chiseledSand(img: Img, r: Rand, pal: string[], cut: boolean): void {
  sandy(img, r, pal, 'top');
  const edge = shade(hex(pal[0]), 0.78);
  for (let k = 0; k < 16; k++) { img.set(k, 0, edge); img.set(k, 15, edge); }
  if (cut) {
    for (let k = 0; k < 16; k++) { img.set(k, 7, edge); img.set(k, 8, shade(edge, 1.1)); img.set(7, k, k < 8 ? edge : img.get(7, k)); }
    return;
  }
  const mid = hex(pal[2]);
  for (let x = 3; x < 13; x++) for (let y = 4; y < 12; y++) {
    const border = x === 3 || x === 12 || y === 4 || y === 11;
    const cross = x === 7 || x === 8 || y === 7 || y === 8;
    img.set(x, y, border ? edge : cross ? shade(mid, 0.9) : shade(mid, 1.05));
  }
}
const SAND_PAL = ['#cfc086', '#d7c991', '#ddd09a', '#e3d7a4', '#e9dfb0'];
put('chiseled_sandstone', (i, r) => chiseledSand(i, r, SAND_PAL, false));
put('cut_sandstone', (i, r) => chiseledSand(i, r, SAND_PAL, true));
put('chiseled_red_sandstone', (i, r) => chiseledSand(i, r, RED_SAND, false));
put('cut_red_sandstone', (i, r) => chiseledSand(i, r, RED_SAND, true));

// ---------------------------------------------------------------- earth

const DIRT_PAL = ['#5e4130', '#6b4a34', '#79543a', '#866041', '#946b48'];
put('coarse_dirt', (i, r) => {
  noisy(i, r, P(...DIRT_PAL), 0.25, 4);
  sprinkle(i, r, '#a79d94', 16); sprinkle(i, r, '#7d7a76', 8);
});
put('podzol_top', (i, r) => { noisy(i, r, P('#5a3d1d', '#684826', '#765430', '#82603a'), 0.45, 4); sprinkle(i, r, '#3f2a10', 12); });
function sideFringe(img: Img, r: Rand, pal: string[]): void {
  noisy(img, r, P(...DIRT_PAL), 0.35, 4);
  const top = P(...pal);
  for (let x = 0; x < 16; x++) {
    const depth = 3 + (r() < 0.5 ? 1 : 0);
    for (let y = 0; y < depth; y++) img.set(x, y, shade(pick(top, r()), y === depth - 1 ? 0.88 : 1));
  }
}
put('podzol_side', (i, r) => sideFringe(i, r, ['#5a3d1d', '#684826', '#765430']));
put('mycelium_top', (i, r) => { noisy(i, r, P('#6f6369', '#7a6e75', '#857983', '#8f8590'), 0.5, 4); sprinkle(i, r, '#5a4a6e', 12); });
put('mycelium_side', (i, r) => sideFringe(i, r, ['#6f6369', '#7a6e75', '#857983']));
put('farmland_top', (i, r) => {
  noisy(i, r, P('#5a3a22', '#67432a', '#744b2f'), 0.4, 4);
  for (let y = 1; y < 16; y += 3) for (let x = 0; x < 16; x++) i.set(x, y, shade(i.get(x, y), 0.8));
});
put('dirt_path_top', (i, r) => { noisy(i, r, P('#8a6a3a', '#97753f', '#a38045', '#ae8a4c'), 0.45, 4); sprinkle(i, r, '#6e5428', 10); });
put('dirt_path_side', (i, r) => {
  noisy(i, r, P(...DIRT_PAL), 0.35, 4);
  for (let x = 0; x < 16; x++) i.set(x, 0, shade(pick(P('#8a6a3a', '#97753f', '#a38045'), r()), 0.95));
});
put('mud', (i, r) => noisy(i, r, P('#3c3a40', '#443f46', '#4c4650', '#56505a'), 0.45, 3));
put('mud_bricks', (i, r) => brickGrid(i, r, ['#8a6a57', '#947260', '#9e7c69', '#a88672'], '#6e5547', 8, 4));
put('terracotta', (i, r) => noisy(i, r, P('#955f45', '#9c654a', '#a36b4f', '#ab7355'), 0.55, 3));
put('moss_block', (i, r) => { noisy(i, r, P('#4c6a24', '#58792b', '#648833', '#70953b'), 0.4, 4); sprinkle(i, r, '#86a94a', 14); });

// ---------------------------------------------------------------- ores and storage

const oreOn = (main: string, light: string, dark: string): Painter => (i, r) => paintOre(i, r, main, light, dark);
put('copper_ore', oreOn('#c4693b', '#e89a6a', '#7a3f20'));
put('lapis_ore', oreOn('#2a4cc4', '#5a82f0', '#14297a'));
put('redstone_ore', oreOn('#d01c1c', '#ff5a4a', '#7a0a0a'));
put('emerald_ore', oreOn('#17c24e', '#6bf09a', '#0d7a30'));

function block(img: Img, r: Rand, pal: string[], border: string, glint?: string): void {
  noisy(img, r, P(...pal), 0.55, 3);
  const b = hex(border);
  for (let k = 0; k < 16; k++) { img.set(k, 0, b); img.set(k, 15, shade(b, 0.8)); img.set(0, k, b); img.set(15, k, shade(b, 0.8)); }
  if (glint) {
    const g = hex(glint);
    for (let k = 0; k < 5; k++) { img.set(2 + k, 5 - k, g); }
    img.set(10, 11, g); img.set(11, 10, g);
  }
}
put('coal_block', (i, r) => { noisy(i, r, P('#141414', '#1c1c1c', '#262626', '#303030'), 0.4, 4); sprinkle(i, r, '#3b3b3b', 14); });
put('iron_block', (i, r) => block(i, r, ['#d4d4d4', '#dcdcdc', '#e4e4e4'], '#a8a8a8', '#ffffff'));
put('gold_block', (i, r) => block(i, r, ['#f2d03a', '#f7dc4e', '#fbe767'], '#c9a31c', '#fffbd0'));
put('diamond_block', (i, r) => block(i, r, ['#5fe0d8', '#6ee8e0', '#7df0e8'], '#2fb0a8', '#e8fffd'));
put('copper_block', (i, r) => block(i, r, ['#c4693b', '#cf7444', '#da804e'], '#9b4e28', '#f0b090'));
put('lapis_block', (i, r) => {
  noisy(i, r, P('#1d3aa0', '#254cc0', '#2e5ad0', '#3b68de'), 0.35, 4);
  sprinkle(i, r, '#8fb0ff', 14); sprinkle(i, r, '#0f2270', 12);
});
put('emerald_block', (i, r) => block(i, r, ['#2bd05e', '#3bda6c', '#4fe27c'], '#119a3c', '#d8ffe4'));
put('redstone_block', (i, r) => { noisy(i, r, P('#a81010', '#b81414', '#c81818', '#d82020'), 0.4, 3); sprinkle(i, r, '#ff5a4a', 14); sprinkle(i, r, '#6e0808', 10); });
function rawBlock(img: Img, r: Rand, pal: string[], hi: string, lo: string): void {
  const { cell, edge } = voronoi(r, 9);
  const cols = Array.from({ length: 9 }, () => pick(P(...pal), r()));
  each(img, (x, y) => {
    const k = y * 16 + x;
    img.set(x, y, edge[k] < 0.9 ? hex(lo) : shade(cols[cell[k]], 0.9 + r() * 0.2));
  });
  sprinkle(img, r, hi, 10);
}
put('raw_iron_block', (i, r) => rawBlock(i, r, ['#b88a6c', '#c49878', '#d0a684'], '#e8c8aa', '#6a4a36'));
put('raw_copper_block', (i, r) => rawBlock(i, r, ['#b85c34', '#c46a3e', '#d07848'], '#f0a070', '#6a3018'));
put('raw_gold_block', (i, r) => rawBlock(i, r, ['#d8a828', '#e4b634', '#f0c440'], '#fff08a', '#7a5a10'));

// ---------------------------------------------------------------- nature

put('hay_top', (i, r) => {
  noisy(i, r, P('#b8921c', '#c4a024', '#d0ac2e', '#dcb838'), 0.5, 3);
  for (let k = 0; k < 16; k++) { i.set(k, 0, hex('#8a6a10')); i.set(k, 15, hex('#8a6a10')); i.set(0, k, hex('#8a6a10')); i.set(15, k, hex('#8a6a10')); }
});
put('hay_side', (i, r) => {
  each(i, (x, y) => i.set(x, y, shade(pick(P('#c4a024', '#d0ac2e', '#dcb838', '#b8921c'), r()), x % 3 === 0 ? 0.92 : 1)));
  for (const y of [3, 4, 11, 12]) for (let x = 0; x < 16; x++) i.set(x, y, shade(hex('#6b4a1a'), 0.9 + r() * 0.2));
});
put('pumpkin_top', (i, r) => {
  noisy(i, r, P('#c8741a', '#d2801f', '#dc8c26'), 0.5, 3);
  for (let x = 6; x < 10; x++) for (let y = 6; y < 10; y++) i.set(x, y, hex('#5a7a22'));
  i.set(7, 5, hex('#5a7a22')); i.set(8, 4, hex('#3e5a16'));
});
function pumpkinSide(img: Img, r: Rand): void {
  each(img, (x, y) => {
    const rib = x % 4 === 0 ? 0.82 : x % 4 === 1 ? 1.06 : 1;
    img.set(x, y, shade(pick(P('#c8741a', '#d2801f', '#dc8c26'), r()), rib));
  });
}
put('pumpkin_side', pumpkinSide);
function pumpkinFace(img: Img, r: Rand, lit: boolean): void {
  pumpkinSide(img, r);
  const hole = lit ? hex('#ffd24a') : hex('#3a2208');
  const glow = lit ? hex('#fff2a0') : hex('#2a1804');
  for (const [x, y] of [[3, 4], [4, 4], [3, 5], [4, 5], [11, 4], [12, 4], [11, 5], [12, 5]]) img.set(x, y, hole);
  for (let x = 4; x < 12; x++) { img.set(x, 10, hole); if (x % 2 === 0) img.set(x, 9, hole); else img.set(x, 11, hole); }
  img.set(7, 7, glow); img.set(8, 7, glow);
}
put('carved_pumpkin_front', (i, r) => pumpkinFace(i, r, false));
put('jack_o_lantern_front', (i, r) => pumpkinFace(i, r, true));
put('melon_top', (i, r) => {
  noisy(i, r, P('#7ba02a', '#86ac30', '#91b836'), 0.5, 3);
  for (let k = 0; k < 16; k++) { i.set(k, 0, hex('#52701a')); i.set(k, 15, hex('#52701a')); i.set(0, k, hex('#52701a')); i.set(15, k, hex('#52701a')); }
});
put('melon_side', (i, r) => {
  each(i, (x, y) => i.set(x, y, shade(pick(P('#6f9a24', '#7ba02a', '#86ac30'), r()), x % 4 < 2 ? 1 : 0.8)));
});
put('ice', (i, r) => { noisy(i, r, P('#8fb4f0', '#9cc0f6', '#aaccfa', '#b8d8ff'), 0.6, 3); sprinkle(i, r, '#dff0ff', 10); });
put('packed_ice', (i, r) => { noisy(i, r, P('#7aa0e6', '#86acee', '#92b8f4'), 0.5, 4); sprinkle(i, r, '#c8e0ff', 14); sprinkle(i, r, '#5a80c8', 8); });
put('sea_lantern', (i, r) => {
  noisy(i, r, P('#c8e8e0', '#d8f2ec', '#e8faf4', '#f4fffb'), 0.5, 3);
  const f = hex('#7aa6a0');
  for (let k = 0; k < 16; k++) { i.set(k, 0, f); i.set(k, 15, f); i.set(0, k, f); i.set(15, k, f); }
  for (let k = 3; k < 13; k++) { i.set(k, 5, shade(f, 1.1)); i.set(5, k, shade(f, 1.1)); i.set(k, 10, shade(f, 1.1)); i.set(10, k, shade(f, 1.1)); }
});
put('bone_block_top', (i, r) => {
  noisy(i, r, P('#e4e0cc', '#ece8d6', '#f4f0e0'), 0.5, 3);
  for (let k = 0; k < 16; k++) { i.set(k, 0, hex('#b0ab92')); i.set(k, 15, hex('#b0ab92')); i.set(0, k, hex('#b0ab92')); i.set(15, k, hex('#b0ab92')); }
  for (let y = 5; y < 11; y++) for (let x = 5; x < 11; x++) i.set(x, y, shade(hex('#d6d2bc'), 0.95 + r() * 0.1));
});
put('bone_block_side', (i, r) => {
  each(i, (x, y) => i.set(x, y, shade(pick(P('#e4e0cc', '#ece8d6', '#f4f0e0'), r()), x % 5 === 0 ? 0.88 : 1)));
  for (let x = 0; x < 16; x++) { i.set(x, 0, hex('#b0ab92')); i.set(x, 15, hex('#b0ab92')); }
});
put('cobweb', (i) => {
  i.clear();
  const w = hex('#e8e8e8');
  for (let k = 0; k < 16; k++) { i.set(k, k, w); i.set(15 - k, k, w); i.set(7, k, w); i.set(8, k, w); i.set(k, 7, w); i.set(k, 8, w); }
  for (const d of [3, 5]) for (let a = d; a < 16 - d; a++) { i.set(a, d, w); i.set(a, 15 - d, w); i.set(d, a, w); i.set(15 - d, a, w); }
});
put('sponge', (i, r) => {
  noisy(i, r, P('#c8c04a', '#d4cc54', '#dfd75e'), 0.5, 3);
  for (let k = 0; k < 9; k++) { const x = Math.floor(r() * 14) + 1, y = Math.floor(r() * 14) + 1; i.set(x, y, hex('#7a7428')); i.set(x + 1, y, hex('#8f8830')); }
});

// ---------------------------------------------------------------- plants

function flower(img: Img, petals: string[], centre: string, kind: 'round' | 'tulip' | 'spike' | 'bells' | 'daisy'): void {
  img.clear();
  const stem = hex('#3f7a22'), leaf = hex('#4f9a2c');
  for (let y = 7; y < 16; y++) img.set(8, y, y % 4 === 0 ? shade(stem, 0.85) : stem);
  img.set(7, 11, leaf); img.set(6, 10, leaf); img.set(9, 13, leaf); img.set(10, 12, leaf);
  const p = petals.map(hex), c = hex(centre);
  if (kind === 'round' || kind === 'daisy') {
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const d = Math.abs(dx) + Math.abs(dy);
      if (d <= 3 && !(Math.abs(dx) === 3 && Math.abs(dy) === 0 && kind === 'round')) img.set(8 + dx, 4 + dy, p[(dx + dy + 8) % p.length]);
    }
    img.set(8, 4, c); img.set(7, 4, c);
  } else if (kind === 'tulip') {
    for (let y = 3; y < 8; y++) for (let x = 6; x < 11; x++) if (!(y === 3 && (x === 7 || x === 9))) img.set(x, y, p[(x + y) % p.length]);
    img.set(8, 3, shade(p[0], 1.2)); img.set(8, 2, p[0]);
  } else if (kind === 'spike') {
    for (let y = 1; y < 8; y++) for (let x = 5; x < 12; x++) { const d = Math.hypot(x - 8, y - 4.5); if (d < 3.4) img.set(x, y, p[(x * 3 + y) % p.length]); }
    for (const [x, y] of [[8, 0], [5, 4], [11, 4], [8, 8]]) img.set(x, y, p[0]);
  } else {
    for (const [x, y] of [[7, 5], [8, 6], [7, 7], [9, 4], [8, 3], [10, 5], [9, 7], [8, 8]]) { img.set(x, y, p[0]); img.set(x, y + 1, p[1 % p.length]); }
    for (let y = 2; y < 6; y++) img.set(6, y, stem);
  }
}
put('blue_orchid', (i) => flower(i, ['#2fc4e8', '#58d8f4', '#1b9bc0'], '#e8fbff', 'round'));
put('allium', (i) => flower(i, ['#b86ee8', '#c98af0', '#a050d0'], '#e6c8ff', 'spike'));
put('azure_bluet', (i) => flower(i, ['#f2f2f2', '#e2e2e8'], '#e0d048', 'daisy'));
put('red_tulip', (i) => flower(i, ['#d82a1e', '#e8442e'], '#f0a090', 'tulip'));
put('orange_tulip', (i) => flower(i, ['#f08a1e', '#f8a032'], '#ffd090', 'tulip'));
put('oxeye_daisy', (i) => flower(i, ['#f8f8f8', '#e8e8e8'], '#f0c020', 'daisy'));
put('cornflower', (i) => flower(i, ['#4670e0', '#5a86f0', '#3858c0'], '#c8d8ff', 'round'));
put('lily_of_the_valley', (i) => flower(i, ['#f8f8f8', '#e6f0e6'], '#ffffff', 'bells'));
put('fern', (i, r) => {
  i.clear();
  const g = P('#2f6a1c', '#3a7c24', '#468e2c');
  for (let f = 0; f < 5; f++) {
    const x0 = 3 + f * 2.2;
    for (let y = 2; y < 16; y++) {
      const spread = Math.max(0, Math.sin((y - 2) / 14 * Math.PI));
      i.set(Math.round(x0 + (f - 2) * (16 - y) / 6), y, pick(g, r()));
      if (y % 2 === 0) { i.set(Math.round(x0 + (f - 2) * (16 - y) / 6) + 1, y, pick(g, r())); }
      void spread;
    }
  }
});
put('brown_mushroom', (i) => {
  i.clear();
  const cap = ['#9a6a45', '#8a5c38', '#a8774f'].map(hex);
  for (let x = 4; x < 12; x++) for (let y = 7; y < 10; y++) if (!((y === 7) && (x < 6 || x > 9))) i.set(x, y, cap[(x + y) % 3]);
  for (let y = 10; y < 15; y++) { i.set(7, y, hex('#e8dcc8')); i.set(8, y, hex('#d2c4a8')); }
});
put('red_mushroom', (i) => {
  i.clear();
  const cap = ['#d82a2a', '#c42222'].map(hex);
  for (let x = 3; x < 13; x++) for (let y = 5; y < 10; y++) if (!(y === 5 && (x < 5 || x > 10)) && !(y === 9 && (x < 4 || x > 11))) i.set(x, y, cap[(x + y) % 2]);
  for (const [x, y] of [[5, 6], [8, 6], [10, 8], [6, 8]]) i.set(x, y, hex('#f4f0e8'));
  for (let y = 10; y < 15; y++) { i.set(7, y, hex('#e8e0d0')); i.set(8, y, hex('#d0c8b8')); }
});
put('sugar_cane', (i, r) => {
  i.clear();
  for (const x of [3, 8, 12]) {
    for (let y = 0; y < 16; y++) {
      i.set(x, y, y % 5 === 4 ? hex('#6f9a3e') : pick(P('#8ec05a', '#9ed066', '#82b44e'), r()));
      i.set(x + 1, y, y % 5 === 4 ? hex('#5a8030') : hex('#78a844'));
    }
    i.set(x - 1, 7, hex('#82b44e')); i.set(x + 2, 11, hex('#82b44e'));
  }
});
function sapling(img: Img, r: Rand, leaf: string[], trunk: string): void {
  img.clear();
  const l = P(...leaf);
  for (let y = 11; y < 16; y++) img.set(8, y, hex(trunk));
  for (let k = 0; k < 40; k++) {
    const x = 8 + Math.round((r() - 0.5) * 9), y = 3 + Math.round(r() * 8);
    if (Math.hypot(x - 8, (y - 7) * 1.2) < 4.6) img.set(x, y, pick(l, r()));
  }
  img.set(8, 7, l[0]); img.set(8, 8, l[1]);
}
put('oak_sapling', (i, r) => sapling(i, r, ['#2d5219', '#3f6e22', '#57902f'], '#5d4529'));
put('spruce_sapling', (i, r) => sapling(i, r, ['#243f25', '#335635', '#3c6240'], '#4a341e'));
put('birch_sapling', (i, r) => sapling(i, r, ['#4e7a2b', '#679a3a', '#74a845'], '#cfcbc0'));
put('jungle_sapling', (i, r) => sapling(i, r, ['#2f7b17', '#44a024', '#51b32b'], '#584619'));
put('acacia_sapling', (i, r) => sapling(i, r, ['#5f9b25', '#74b032', '#86c23c'], '#6b6359'));
put('dark_oak_sapling', (i, r) => sapling(i, r, ['#1f4a10', '#2a5a15', '#356a1c'], '#35240f'));
put('cherry_sapling', (i, r) => sapling(i, r, ['#e8a0c0', '#f2b3d0', '#ee90b4'], '#3e2d3a'));

// ---------------------------------------------------------------- wood

interface WoodPalette {
  planks: string[];
  gap: string;
  bark: string[];
  barkDark: string;
  ring: string;
  ringDark: string;
  leaves: string[];
  stripped: string[];
}

export const WOOD_PALETTES: Record<string, WoodPalette> = {
  oak: { planks: ['#8f7040', '#9a7a48', '#a2834f', '#b08f5a'], gap: '#6e5532', bark: ['#4f3a22', '#5d4529', '#6b5232', '#78603b'], barkDark: '#3a2a17', ring: '#b4935c', ringDark: '#9a7a48', leaves: ['#2d5219', '#355e1d', '#3f6e22', '#4a7f2a', '#57902f'], stripped: ['#a98557', '#b4905e', '#bf9c68'] },
  spruce: { planks: ['#5f4426', '#6d4f2c', '#7a5a34', '#84633b'], gap: '#4a3520', bark: ['#35250f', '#3f2c19', '#4a341e', '#523a23'], barkDark: '#24180a', ring: '#84633b', ringDark: '#6d4f2c', leaves: ['#243f25', '#2b4a2c', '#335635', '#3c6240'], stripped: ['#7a5a34', '#84633b', '#8f6d44'] },
  birch: { planks: ['#bba36a', '#c8b277', '#d7c185', '#e0cb90'], gap: '#9d8a5a', bark: ['#cfcbc0', '#d8d5cc', '#e2dfd7'], barkDark: '#2c2924', ring: '#d7c185', ringDark: '#c2ab72', leaves: ['#4e7a2b', '#5a8a32', '#679a3a', '#74a845'], stripped: ['#c8b277', '#d2bd82', '#dcc78e'] },
  jungle: { planks: ['#9a6f45', '#a67a4f', '#b58a5c', '#c09666'], gap: '#7a5535', bark: ['#4d3d1b', '#5a4822', '#675329', '#74602f'], barkDark: '#33280e', ring: '#b88a5b', ringDark: '#9a6f45', leaves: ['#2f7b17', '#3a8c1e', '#44a024', '#51b32b'], stripped: ['#ab7d52', '#b88a5b', '#c4966a'] },
  acacia: { planks: ['#a8522c', '#b85e33', '#c4683a', '#cf7442'], gap: '#823e20', bark: ['#6b6359', '#777066', '#857d72', '#928a7e'], barkDark: '#4a443c', ring: '#b5603a', ringDark: '#a8522c', leaves: ['#4f8a1e', '#5f9b25', '#6fac2c', '#7fbc34'], stripped: ['#b0592f', '#be6538', '#cb7242'] },
  dark_oak: { planks: ['#3f2810', '#4a3016', '#573a1b', '#623f20'], gap: '#2c1a08', bark: ['#2b1c0c', '#35240f', '#3e2a14', '#473219'], barkDark: '#1c1206', ring: '#4a3016', ringDark: '#3a2410', leaves: ['#1f4a10', '#2a5a15', '#356a1c', '#407a22'], stripped: ['#4a3016', '#573a1b', '#634424'] },
  mangrove: { planks: ['#7a3c3a', '#873f3b', '#964843', '#a4524c'], gap: '#5a2826', bark: ['#4a2a22', '#573027', '#64372c', '#713f33'], barkDark: '#321c16', ring: '#7b3a36', ringDark: '#64302d', leaves: ['#3e7a24', '#4a8a2a', '#559a30', '#60aa37'], stripped: ['#8a3f3a', '#984a44', '#a6564e'] },
  cherry: { planks: ['#d9a5a1', '#e3b2ad', '#ecbfba', '#f2cbc6'], gap: '#b57e7a', bark: ['#3e2d3a', '#4a3744', '#563f4f', '#62485a'], barkDark: '#2a1c27', ring: '#e3b2ad', ringDark: '#d09a96', leaves: ['#e8a0c0', '#f2b3d0', '#f7c4dc', '#ee90b4'], stripped: ['#e0aaa6', '#e8b6b2', '#f0c2be'] },
};

function strippedSide(img: Img, r: Rand, pal: string[]): void {
  const cols = P(...pal);
  for (let x = 0; x < 16; x++) {
    let c = pick(cols, r());
    for (let y = 0; y < 16; y++) {
      if (r() < 0.18) c = pick(cols, r());
      img.set(x, y, shade(c, x % 4 === 0 ? 0.9 : 1));
    }
  }
}
function strippedTop(img: Img, r: Rand, pal: string[], ring: string, ringDark: string): void {
  paintLogTop(img, r, P(...pal), hex(ring), hex(ringDark));
}

for (const w of WOODS) {
  const p = WOOD_PALETTES[w.name];
  const n = w.name;
  put(`${n}_planks`, (i, r) => paintPlanks(i, r, P(...p.planks), hex(p.gap)));
  put(`${n}_log`, (i, r) => paintLogSide(i, r, P(...p.bark), hex(p.barkDark)));
  put(`${n}_log_top`, (i, r) => paintLogTop(i, r, P(...p.bark), hex(p.ring), hex(p.ringDark)));
  put(`stripped_${n}_log`, (i, r) => strippedSide(i, r, p.stripped));
  put(`stripped_${n}_log_top`, (i, r) => strippedTop(i, r, p.stripped, p.ring, p.ringDark));
  put(`${n}_leaves`, (i, r) => paintLeaves(i, r, P(...p.leaves)));
}
/** One half of a wooden door: vertical boards in a darker frame with two recessed panels and a knob on the lower half. */
function paintWoodDoor(img: Img, r: Rand, p: WoodPalette, half: 'upper' | 'lower'): void {
  const boards = P(...p.planks), gap = hex(p.gap);
  each(img, (x, y) => {
    const board = Math.floor(x / 4);
    const c = shade(boards[board % boards.length], 0.92 + r() * 0.16);
    img.set(x, y, c);
  });
  for (let k = 0; k < 16; k++) { img.set(0, k, gap); img.set(15, k, gap); }
  for (let x = 0; x < 16; x++) img.set(x, half === 'upper' ? 0 : 15, gap);
  const pane = (x0: number, y0: number, x1: number, y1: number): void => {
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const edge = x === x0 || y === y0;
      const c = shade(boards[(Math.floor(x / 4) + 1) % boards.length], edge ? 0.78 : 1.05);
      img.set(x, y, c);
    }
  };
  if (half === 'upper') { pane(3, 3, 12, 6); pane(3, 9, 12, 12); }
  else { pane(3, 2, 12, 6); pane(3, 9, 12, 13); }
  if (half === 'lower') { img.set(12, 8, hex('#c8c8c8')); img.set(12, 9, hex('#8a8a8a')); }
}
for (const w of WOODS) {
  if (w.name === 'oak') continue;
  const p = WOOD_PALETTES[w.name];
  put(`${w.name}_door_upper`, (i, r) => paintWoodDoor(i, r, p, 'upper'));
  put(`${w.name}_door_lower`, (i, r) => paintWoodDoor(i, r, p, 'lower'));
}

// The three woods with legacy ids keep their original painters in TextureAtlas; only the stripped logs are new.
for (const w of OLD_WOODS) {
  delete CONTENT_PAINTERS[`${w.name}_planks`];
  delete CONTENT_PAINTERS[`${w.name}_log`];
  delete CONTENT_PAINTERS[`${w.name}_log_top`];
  delete CONTENT_PAINTERS[`${w.name}_leaves`];
}
void NEW_WOODS;

// ---------------------------------------------------------------- dye bases (grey, tinted per vertex)

put('white_concrete', (i, r) => noisy(i, r, P('#e6e6e6', '#ececec', '#f2f2f2'), 0.2, 4));
put('dyed_terracotta', (i, r) => noisy(i, r, P('#d4d4d4', '#dadada', '#e0e0e0', '#e6e6e6'), 0.55, 3));
put('dyed_glazed_terracotta', (i, r) => {
  void r;
  const light = hex('#f0f0f0'), dark = hex('#b4b4b4'), mid = hex('#d8d8d8');
  each(i, (x, y) => {
    const qx = x % 8, qy = y % 8;
    const dx = qx < 4 ? qx : 7 - qx, dy = qy < 4 ? qy : 7 - qy;
    const d = Math.min(dx, dy);
    i.set(x, y, d === 0 ? dark : d === 1 ? light : (dx + dy) % 2 === 0 ? mid : light);
  });
  for (let k = 0; k < 16; k++) { i.set(k, 0, dark); i.set(0, k, dark); i.set(k, 15, dark); i.set(15, k, dark); }
});
put('white_stained_glass', (i) => {
  i.clear();
  const frame = hex('#f2f2f2'), dim = hex('#d0d0d0');
  for (let k = 0; k < 16; k++) {
    for (const t of [0, 1]) { i.set(k, t, t ? dim : frame); i.set(k, 15 - t, t ? dim : shade(frame, 0.9)); i.set(t, k, t ? dim : frame); i.set(15 - t, k, t ? dim : shade(frame, 0.9)); }
  }
  for (let k = 0; k < 6; k++) { i.set(3 + k, 8 - k, frame); i.set(4 + k, 8 - k, dim); }
  for (let k = 0; k < 3; k++) i.set(9 + k, 13 - k, frame);
  // Faint colour wash so a stained pane reads as coloured and not only framed.
  for (let y = 2; y < 14; y++) for (let x = 2; x < 14; x++) if ((x + y) % 4 === 0) i.set(x, y, dim);
});
// ---------------------------------------------------------------- thin and functional blocks

put('packed_mud', (i, r) => noisy(i, r, P('#8c6a4c', '#96745a', '#a07e62', '#aa886c'), 0.5, 3));

put('bed_foot_top', (i, r) => {
  noisy(i, r, P('#dcdcdc', '#e2e2e2', '#e8e8e8'), 0.5, 3);
  for (let k = 0; k < 16; k++) { i.set(k, 15, hex('#b8b8b8')); i.set(0, k, hex('#c4c4c4')); i.set(15, k, hex('#c4c4c4')); }
  for (let x = 0; x < 16; x++) i.set(x, 2, hex('#c8c8c8'));
});
put('bed_head_top', (i, r) => {
  noisy(i, r, P('#dcdcdc', '#e2e2e2', '#e8e8e8'), 0.5, 3);
  for (let k = 0; k < 16; k++) { i.set(k, 0, hex('#c4c4c4')); i.set(0, k, hex('#c4c4c4')); i.set(15, k, hex('#c4c4c4')); }
  // The pillow: lighter, with a soft edge.
  for (let y = 2; y < 8; y++) for (let x = 2; x < 14; x++) i.set(x, y, shade(hex('#f6f6f6'), 0.97 + r() * 0.05));
  for (let x = 2; x < 14; x++) i.set(x, 8, hex('#d0d0d0'));
});
put('bed_side', (i, r) => {
  each(i, (x, y) => i.set(x, y, y < 8 ? shade(pick(P('#d8d8d8', '#e0e0e0', '#e8e8e8'), r()), x % 4 === 0 ? 0.96 : 1) : shade(hex('#b8b8b8'), 0.95 + r() * 0.08)));
  for (let x = 0; x < 16; x++) i.set(x, 8, hex('#a8a8a8'));
});

put('iron_bars', (i) => {
  i.clear();
  const bar = hex('#8e9094'), hi = hex('#c8cacd'), lo = hex('#5a5c60');
  for (let x = 1; x < 16; x += 3) for (let y = 0; y < 16; y++) { i.set(x, y, hi); i.set(x + 1, y, bar); }
  for (const y of [1, 14]) for (let x = 0; x < 16; x++) { i.set(x, y, bar); i.set(x, y + 1 > 15 ? 15 : y + 1, lo); }
  for (let y = 0; y < 16; y++) { i.set(7, y, hi); i.set(8, y, bar); }
});

put('ladder', (i, r) => {
  i.clear();
  const wood = P('#8a6a3a', '#9a7a46', '#7a5a2c');
  for (let y = 0; y < 16; y++) for (const x of [2, 3, 12, 13]) i.set(x, y, shade(pick(wood, r()), x % 2 === 0 ? 1 : 0.85));
  for (const y of [2, 3, 7, 8, 12, 13]) for (let x = 4; x < 12; x++) i.set(x, y, shade(pick(wood, r()), y % 5 === 2 || y === 7 || y === 12 ? 1.08 : 0.82));
});

put('chest_top', (i, r) => {
  noisy(i, r, P('#a06f2f', '#ac7a36', '#b8853e'), 0.4, 3);
  const edge = hex('#5a3c14');
  for (let k = 0; k < 16; k++) { i.set(k, 0, edge); i.set(k, 15, edge); i.set(0, k, edge); i.set(15, k, edge); }
  for (let k = 1; k < 15; k++) { i.set(k, 1, shade(i.get(k, 1), 1.15)); i.set(1, k, shade(i.get(1, k), 1.1)); }
});
function chestSide(img: Img, r: Rand, front: boolean): void {
  each(img, (x, y) => img.set(x, y, shade(pick(P('#a06f2f', '#ac7a36', '#b8853e'), r()), y % 8 === 7 ? 0.8 : 1)));
  const dark = hex('#5a3c14');
  for (let k = 0; k < 16; k++) { img.set(k, 15, dark); img.set(k, 0, dark); img.set(k, 6, hex('#7a5220')); img.set(0, k, dark); img.set(15, k, dark); }
  for (let k = 7; k < 15; k++) { img.set(1, k, shade(dark, 1.2)); img.set(14, k, shade(dark, 1.2)); }
  if (front) {
    // The latch: a small iron plate with a hook over the lid seam.
    for (let y = 4; y < 9; y++) for (let x = 7; x < 9; x++) img.set(x, y, y === 4 ? hex('#e2e2e2') : hex('#9a9a9a'));
    img.set(7, 8, hex('#6a6a6a')); img.set(8, 8, hex('#6a6a6a'));
  }
}
put('chest_side', (i, r) => chestSide(i, r, false));
put('chest_front', (i, r) => chestSide(i, r, true));

put('lantern', (i) => {
  i.clear();
  const frame = hex('#3c3c40'), frameHi = hex('#5a5a60'), glow = P('#ffb83a', '#ffd85a', '#fff2a8');
  // Lower box: block y 0..6 → image rows 15..9, x 5..10.
  for (let y = 9; y <= 15; y++) for (let x = 5; x <= 10; x++) {
    const edge = x === 5 || x === 10 || y === 15 || y === 9;
    i.set(x, y, edge ? (x === 5 || y === 9 ? frameHi : frame) : glow[(x + y) % 3]);
  }
  // Upper box (cap and ring): block y 7..8 → rows 8..7, x 6..9.
  for (let y = 7; y <= 8; y++) for (let x = 6; x <= 9; x++) i.set(x, y, x === 6 || x === 9 || y === 7 ? frame : frameHi);
});

void PX;
void paintCobble;
void paintWool;
