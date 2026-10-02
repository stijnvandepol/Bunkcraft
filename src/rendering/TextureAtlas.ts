import * as THREE from 'three';
import { DESTROY_STAGES, TEXTURE_NAMES, TINTED_TEXTURES } from '../world/BlockRegistry';
import { defaultTint } from '../world/BiomeColors';
import type { PackImage } from './TexturePacks';
import { hashString, mulberry32 } from '../world/Noise';

/**
 * Procedural 16×16 pixel-art textures, packed into a WebGL2 texture *array*.
 *
 * A texture array is a texture atlas without the classic atlas problems: each layer
 * wraps independently (so greedy-merged quads can tile a texture with plain UVs > 1)
 * and mipmaps never bleed between neighbouring tiles.
 */

export const TEX_SIZE = 16;
const PX = TEX_SIZE * TEX_SIZE;

type RGB = [number, number, number];

function hex(c: string): RGB {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

class Img {
  readonly data = new Uint8ClampedArray(PX * 4);
  set(x: number, y: number, c: RGB, a = 255): void {
    if (x < 0 || y < 0 || x >= TEX_SIZE || y >= TEX_SIZE) return;
    const i = (y * TEX_SIZE + x) * 4;
    this.data[i] = c[0]; this.data[i + 1] = c[1]; this.data[i + 2] = c[2]; this.data[i + 3] = a;
  }
  get(x: number, y: number): RGB {
    const i = (((y + TEX_SIZE) % TEX_SIZE) * TEX_SIZE + ((x + TEX_SIZE) % TEX_SIZE)) * 4;
    return [this.data[i], this.data[i + 1], this.data[i + 2]];
  }
  alpha(x: number, y: number): number {
    return this.data[(y * TEX_SIZE + x) * 4 + 3];
  }
  fill(c: RGB, a = 255): void {
    for (let y = 0; y < TEX_SIZE; y++) for (let x = 0; x < TEX_SIZE; x++) this.set(x, y, c, a);
  }
  clear(): void {
    this.data.fill(0);
  }
}

type Rand = () => number;

function shade(c: RGB, f: number): RGB {
  return [Math.min(255, c[0] * f), Math.min(255, c[1] * f), Math.min(255, c[2] * f)];
}

/** Tileable smooth value noise in [0,1], `cells` lattice cells across the tile. */
function tileNoise(rand: Rand, cells: number): Float32Array {
  const grid = new Float32Array(cells * cells);
  for (let i = 0; i < grid.length; i++) grid[i] = rand();
  const out = new Float32Array(PX);
  const step = TEX_SIZE / cells;
  for (let y = 0; y < TEX_SIZE; y++) {
    for (let x = 0; x < TEX_SIZE; x++) {
      const gx = x / step, gy = y / step;
      const x0 = Math.floor(gx), y0 = Math.floor(gy);
      let tx = gx - x0, ty = gy - y0;
      tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
      const g = (ix: number, iy: number) => grid[((iy % cells) * cells) + (ix % cells)];
      const a = g(x0, y0) + (g(x0 + 1, y0) - g(x0, y0)) * tx;
      const b = g(x0, y0 + 1) + (g(x0 + 1, y0 + 1) - g(x0, y0 + 1)) * tx;
      out[y * TEX_SIZE + x] = a + (b - a) * ty;
    }
  }
  return out;
}

function pick(pal: RGB[], t: number): RGB {
  return pal[Math.max(0, Math.min(pal.length - 1, Math.floor(t * pal.length)))];
}

/** Palette noise: mix of smooth noise and per-pixel jitter, quantised to a palette. */
function noisy(img: Img, rand: Rand, pal: RGB[], smooth = 0.5, cells = 4): void {
  const n = tileNoise(rand, cells);
  for (let y = 0; y < TEX_SIZE; y++) {
    for (let x = 0; x < TEX_SIZE; x++) {
      const t = n[y * TEX_SIZE + x] * smooth + rand() * (1 - smooth);
      img.set(x, y, pick(pal, t));
    }
  }
}

/** Tileable Voronoi cells: returns per-pixel cell id and edge distance (d2 - d1). */
function voronoi(rand: Rand, count: number): { cell: Int32Array; edge: Float32Array; centers: number[] } {
  const pts: number[] = [];
  for (let i = 0; i < count; i++) pts.push(rand() * TEX_SIZE, rand() * TEX_SIZE);
  const cell = new Int32Array(PX);
  const edge = new Float32Array(PX);
  for (let y = 0; y < TEX_SIZE; y++) {
    for (let x = 0; x < TEX_SIZE; x++) {
      let d1 = 1e9, d2 = 1e9, best = 0;
      for (let i = 0; i < count; i++) {
        let dx = Math.abs(x + 0.5 - pts[i * 2]); let dy = Math.abs(y + 0.5 - pts[i * 2 + 1]);
        dx = Math.min(dx, TEX_SIZE - dx); dy = Math.min(dy, TEX_SIZE - dy);
        const d = Math.sqrt(dx * dx + dy * dy * 1.2);
        if (d < d1) { d2 = d1; d1 = d; best = i; } else if (d < d2) d2 = d;
      }
      cell[y * TEX_SIZE + x] = best;
      edge[y * TEX_SIZE + x] = d2 - d1;
    }
  }
  return { cell, edge, centers: pts };
}

const P = (...cs: string[]) => cs.map(hex);

const STONE = P('#6a6a6a', '#737373', '#7b7b7b', '#828282', '#8a8a8a', '#919191');
const DIRT = P('#5e4130', '#6b4a34', '#79543a', '#866041', '#946b48');
const GRASS = P('#4a8228', '#538f2e', '#5d9c34', '#68a93b', '#74b543');
const SNOW = P('#dfeaee', '#e9f2f4', '#f1f8f9', '#f9fdfd');
const SAND = P('#cfc086', '#d7c991', '#ddd09a', '#e3d7a4', '#e9dfb0');

function paintStone(img: Img, r: Rand): void {
  noisy(img, r, STONE, 0.55, 4);
  for (let k = 0; k < 7; k++) {
    const x = Math.floor(r() * 16), y = Math.floor(r() * 16), len = 2 + Math.floor(r() * 3);
    for (let i = 0; i < len; i++) img.set((x + i) % 16, y, shade(img.get(x + i, y), 0.86));
  }
}

function paintDirt(img: Img, r: Rand): void {
  noisy(img, r, DIRT, 0.35, 4);
  for (let k = 0; k < 6; k++) img.set(Math.floor(r() * 16), Math.floor(r() * 16), hex('#a07656'));
  for (let k = 0; k < 6; k++) img.set(Math.floor(r() * 16), Math.floor(r() * 16), hex('#4f3627'));
}

function paintGrassTop(img: Img, r: Rand): void {
  noisy(img, r, GRASS, 0.45, 4);
  for (let k = 0; k < 10; k++) img.set(Math.floor(r() * 16), Math.floor(r() * 16), hex('#7fc04c'));
}

function paintSideFringe(img: Img, r: Rand, pal: RGB[]): void {
  paintDirt(img, r);
  for (let x = 0; x < 16; x++) {
    const depth = 3 + (r() < 0.5 ? 1 : 0) + (r() < 0.25 ? 1 : 0);
    for (let y = 0; y < depth; y++) img.set(x, y, shade(pick(pal, r()), y === depth - 1 ? 0.88 : 1));
    if (r() < 0.3) img.set(x, depth, shade(pick(pal, r()), 0.8));
  }
}

function paintPlanks(img: Img, r: Rand, pal: RGB[], gap: RGB): void {
  for (let board = 0; board < 4; board++) {
    const seam = (board * 7 + 3 + Math.floor(r() * 3)) % 16;
    for (let row = 0; row < 4; row++) {
      const y = board * 4 + row;
      let streak = pick(pal, r());
      for (let x = 0; x < 16; x++) {
        if (r() < 0.25) streak = pick(pal, r());
        let c = streak;
        if (row === 3) c = gap;
        else if (x === seam) c = shade(gap, 1.1);
        else if (row === 0) c = shade(c, 1.07);
        img.set(x, y, c);
      }
    }
  }
}

function paintLogSide(img: Img, r: Rand, pal: RGB[], dark: RGB): void {
  for (let x = 0; x < 16; x++) {
    let c = pick(pal, r());
    for (let y = 0; y < 16; y++) {
      if (r() < 0.2) c = pick(pal, r());
      img.set(x, y, c);
    }
  }
  for (let k = 0; k < 5; k++) {
    const x = Math.floor(r() * 16); const y = Math.floor(r() * 16); const len = 3 + Math.floor(r() * 5);
    for (let i = 0; i < len; i++) img.set(x, (y + i) % 16, dark);
  }
}

function paintBirchSide(img: Img, r: Rand): void {
  noisy(img, r, P('#cfcbc0', '#d8d5cc', '#e2dfd7', '#ebe8e1'), 0.3, 4);
  for (let k = 0; k < 9; k++) {
    const x = Math.floor(r() * 16), y = Math.floor(r() * 16), len = 2 + Math.floor(r() * 3);
    const c = r() < 0.6 ? hex('#2c2924') : hex('#5d584f');
    for (let i = 0; i < len; i++) img.set((x + i) % 16, y, c);
  }
}

function paintLogTop(img: Img, r: Rand, bark: RGB[], light: RGB, dark: RGB): void {
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
      let c: RGB;
      if (d >= 7) c = pick(bark, r());
      else c = Math.floor(d) % 2 === 0 ? light : dark;
      if (d < 7 && r() < 0.15) c = shade(c, 0.92);
      img.set(x, y, c);
    }
  }
}

function paintLeaves(img: Img, r: Rand, pal: RGB[]): void {
  const n = tileNoise(r, 4);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      if (r() < 0.2 + n[y * 16 + x] * 0.12) { img.set(x, y, pal[0], 0); continue; }
      img.set(x, y, pick(pal, n[y * 16 + x] * 0.5 + r() * 0.5));
    }
  }
}

function paintCobble(img: Img, r: Rand, mossy: boolean): void {
  const { cell, edge, centers } = voronoi(r, 10);
  const shades = centers.map(() => 0.85 + r() * 0.3);
  const moss = tileNoise(r, 4);
  const mossPal = P('#3f5a24', '#4d6b2c', '#5a7a32', '#466528');
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const i = y * 16 + x;
      const id = cell[i];
      let c: RGB;
      if (edge[i] < 1.1) c = r() < 0.5 ? hex('#4b4b4b') : hex('#555555');
      else {
        const cx = centers[id * 2], cy = centers[id * 2 + 1];
        const hl = (x - cx) + (y - cy) < -2.5 ? 1.12 : 1;
        c = shade(pick(STONE, r() * 0.6 + 0.3), shades[id] * hl);
      }
      if (mossy && moss[i] > 0.55 && r() < 0.85) c = pick(mossPal, r());
      img.set(x, y, c);
    }
  }
}

function paintOre(img: Img, r: Rand, main: string, light: string, dark: string): void {
  paintStone(img, r);
  const M = hex(main), L = hex(light), D = hex(dark);
  const clusters = 4 + Math.floor(r() * 2);
  const marked = new Uint8Array(PX);
  for (let c = 0; c < clusters; c++) {
    let x = 2 + Math.floor(r() * 12), y = 2 + Math.floor(r() * 12);
    const n = 3 + Math.floor(r() * 4);
    for (let k = 0; k < n; k++) {
      marked[y * 16 + x] = 1;
      img.set(x, y, r() < 0.3 ? L : M);
      if (r() < 0.5) x += r() < 0.5 ? 1 : -1; else y += r() < 0.5 ? 1 : -1;
      x = Math.max(1, Math.min(14, x)); y = Math.max(1, Math.min(14, y));
    }
  }
  for (let y = 1; y < 15; y++) {
    for (let x = 1; x < 15; x++) {
      if (marked[y * 16 + x]) continue;
      const adj = marked[y * 16 + x + 1] || marked[y * 16 + x - 1] || marked[(y + 1) * 16 + x] || marked[(y - 1) * 16 + x];
      if (adj && r() < 0.45) img.set(x, y, D);
    }
  }
}

function paintBricks(img: Img, r: Rand): void {
  const pal = P('#7f4033', '#8f4a3a', '#9c5241', '#a65a47');
  for (let row = 0; row < 4; row++) {
    const off = row % 2 === 0 ? 0 : 4;
    const brickShade: number[] = [0.9 + r() * 0.2, 0.9 + r() * 0.2, 0.9 + r() * 0.2];
    for (let ry = 0; ry < 4; ry++) {
      const y = row * 4 + ry;
      for (let x = 0; x < 16; x++) {
        if (ry === 3 || (x + 16 - off) % 8 === 0) { img.set(x, y, r() < 0.5 ? hex('#b2a89d') : hex('#a1978c')); continue; }
        const b = Math.floor(((x + 16 - off) % 16) / 8);
        img.set(x, y, shade(pick(pal, r()), brickShade[b] * (ry === 0 ? 1.08 : 1)));
      }
    }
  }
}

function paintStoneBricks(img: Img, r: Rand): void {
  for (let y = 0; y < 16; y++) {
    const row = Math.floor(y / 8), ry = y % 8;
    for (let x = 0; x < 16; x++) {
      const lx = (x + (row === 1 ? 8 : 0)) % 16;
      let c = pick(STONE, 0.25 + r() * 0.6);
      if (ry === 7 || lx === 15) c = hex('#4c4c4c');
      else if (ry === 0 || lx === 0) c = hex('#9a9a9a');
      else if (ry === 6 || lx === 14) c = shade(c, 0.85);
      img.set(x, y, c);
    }
  }
}

function paintWool(img: Img, r: Rand, base: string): void {
  const b = hex(base);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const weave = ((x + y) % 4 < 2 ? 1.04 : 0.95) * (0.94 + r() * 0.1);
      img.set(x, y, shade(b, weave));
    }
  }
}

function paintGlass(img: Img, r: Rand): void {
  img.fill(hex('#c8e4ea'), 0);
  const frame = hex('#d6eef2'), corner = hex('#9cc4cc');
  for (let i = 0; i < 16; i++) {
    img.set(i, 0, frame); img.set(i, 15, shade(frame, 0.85));
    img.set(0, i, frame); img.set(15, i, shade(frame, 0.85));
  }
  img.set(0, 0, corner); img.set(15, 15, corner); img.set(0, 15, corner); img.set(15, 0, corner);
  const glint = hex('#ffffff');
  for (let i = 0; i < 4; i++) { img.set(3 + i, 6 - i, glint, 220); img.set(4 + i, 6 - i, glint, 160); }
  for (let i = 0; i < 2; i++) img.set(10 + i, 12 - i, glint, 200);
  void r;
}

function paintWater(img: Img, r: Rand): void {
  noisy(img, r, P('#2a54b4', '#2f5cc0', '#3463ca', '#3a6bd3', '#4374db'), 0.7, 2);
  for (let k = 0; k < 9; k++) {
    const y = Math.floor(r() * 16), x = Math.floor(r() * 16), len = 3 + Math.floor(r() * 4);
    for (let i = 0; i < len; i++) img.set((x + i) % 16, y, hex('#5a8be6'));
  }
}

function paintGlowstone(img: Img, r: Rand): void {
  const { cell, edge } = voronoi(r, 9);
  const pal = P('#a86b2c', '#c88a3b', '#ffbf5a', '#f6d58c', '#fff0b8');
  const lum = Array.from({ length: 9 }, () => 0.35 + r() * 0.65);
  for (let i = 0; i < PX; i++) {
    const t = edge[i] < 1 ? 0.1 : lum[cell[i]] * (0.8 + r() * 0.2);
    img.set(i % 16, Math.floor(i / 16), pick(pal, t));
  }
}

function paintBookshelf(img: Img, r: Rand): void {
  paintPlanks(img, r, P('#9a7a48', '#a2834f', '#b08f5a'), hex('#6e5532'));
  const books = P('#7a2e2e', '#2e4f7a', '#2e7a3f', '#7a6a2e', '#5a2e7a', '#8a8579', '#9a4a22');
  for (const [y0, y1] of [[2, 7], [9, 14]]) {
    let x = 1;
    while (x < 15) {
      const w = 1 + Math.floor(r() * 2);
      const c = pick(books, r());
      const top = y0 + (r() < 0.3 ? 1 : 0);
      for (let bx = x; bx < Math.min(15, x + w); bx++) {
        for (let y = y0; y < y1; y++) img.set(bx, y, y < top ? hex('#3b2a17') : y === top ? shade(c, 1.25) : c);
      }
      x += w;
      if (x < 15 && r() < 0.35) { for (let y = y0; y < y1; y++) img.set(x, y, hex('#2b1d10')); x++; }
    }
    for (let x2 = 0; x2 < 16; x2++) img.set(x2, y0 - 1, hex('#6e5532'));
  }
}

function paintCactusSide(img: Img, r: Rand): void {
  noisy(img, r, P('#4f7d28', '#5b8c2f', '#669a36'), 0.3, 2);
  for (const x of [0, 15]) for (let y = 0; y < 16; y++) img.set(x, y, hex('#3a641c'));
  for (const x of [3, 7, 11]) for (let y = 0; y < 16; y++) img.set(x, y, shade(img.get(x, y), 0.82));
  for (let k = 0; k < 8; k++) img.set([2, 4, 6, 8, 10, 12][Math.floor(r() * 6)], Math.floor(r() * 16), hex('#d9d6a0'));
}

function paintCactusTop(img: Img, r: Rand, dark: number): void {
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
    const c = d >= 7 ? hex('#3a641c') : Math.floor(d) % 3 === 0 ? hex('#4f7d28') : hex('#5f9333');
    img.set(x, y, shade(c, dark * (0.95 + r() * 0.1)));
  }
}

function paintSandstone(img: Img, r: Rand, part: 'top' | 'side' | 'bottom'): void {
  noisy(img, r, SAND, part === 'top' ? 0.8 : 0.5, 4);
  if (part === 'side') {
    for (let x = 0; x < 16; x++) {
      for (let y = 0; y < 3; y++) img.set(x, y, shade(img.get(x, y), 1.06));
      img.set(x, 3, shade(img.get(x, 3), 0.86));
      if (r() < 0.6) img.set(x, 9, shade(img.get(x, 9), 0.9));
      for (let y = 13; y < 16; y++) img.set(x, y, shade(img.get(x, y), 0.88));
    }
  } else if (part === 'bottom') {
    for (let i = 0; i < PX; i++) img.set(i % 16, Math.floor(i / 16), shade(img.get(i % 16, Math.floor(i / 16)), 0.92));
  }
}

function paintPlant(img: Img, r: Rand, kind: 'grass' | 'dandelion' | 'poppy' | 'dead'): void {
  img.clear();
  if (kind === 'grass') {
    for (let b = 0; b < 11; b++) {
      let x = 1 + Math.floor(r() * 14);
      const h = 5 + Math.floor(r() * 9);
      const c = pick(GRASS, r());
      for (let i = 0; i < h; i++) {
        img.set(x, 15 - i, i > h - 3 ? shade(c, 1.12) : c);
        if (i > 3 && r() < 0.18) x += r() < 0.5 ? 1 : -1;
      }
    }
  } else if (kind === 'dead') {
    const c = hex('#7a5a2b'), c2 = hex('#5e4320');
    const branch = (x: number, y: number, dx: number, len: number) => {
      for (let i = 0; i < len; i++) {
        img.set(x, y, i % 3 === 0 ? c2 : c);
        y--; if (r() < 0.5) x += dx;
      }
    };
    branch(7, 15, 0, 5); branch(7, 11, -1, 6); branch(8, 11, 1, 6); branch(7, 9, 1, 5); branch(7, 12, -1, 4);
  } else {
    const stem = hex('#3f7a24');
    for (let y = 8; y < 16; y++) img.set(7, y, stem);
    img.set(6, 12, stem); img.set(5, 11, stem); img.set(8, 13, stem); img.set(9, 12, stem);
    if (kind === 'dandelion') {
      const Y = hex('#f5d630'), Y2 = hex('#e7a51c');
      for (let y = 5; y < 9; y++) for (let x = 6; x < 9; x++) img.set(x, y, (x + y) % 2 ? Y : Y2);
      img.set(7, 4, Y);
    } else {
      const R = hex('#c8231e'), R2 = hex('#9b1712');
      for (let y = 4; y < 8; y++) for (let x = 5; x < 10; x++) if (!((x === 5 || x === 9) && (y === 4 || y === 7))) img.set(x, y, y === 7 ? R2 : R);
      img.set(7, 5, hex('#2a1a10'));
    }
  }
}

/** Crack overlay: random-walk cracks revealed progressively per stage. */
function makeDestroyStages(): Img[] {
  const r = mulberry32(1337);
  const order = new Float32Array(PX).fill(1e9);
  let step = 0;
  for (let b = 0; b < 7; b++) {
    let x = 7 + Math.floor(r() * 2), y = 7 + Math.floor(r() * 2);
    const dx = r() * 2 - 1, dy = r() * 2 - 1;
    for (let i = 0; i < 12; i++) {
      const k = y * 16 + x;
      order[k] = Math.min(order[k], i + r() * 2);
      x += Math.round(dx + (r() - 0.5) * 1.4);
      y += Math.round(dy + (r() - 0.5) * 1.4);
      if (x < 0 || y < 0 || x > 15 || y > 15) break;
      step++;
    }
  }
  const imgs: Img[] = [];
  for (let s = 0; s < DESTROY_STAGES; s++) {
    const img = new Img();
    const limit = ((s + 1) / DESTROY_STAGES) * 12.5;
    for (let i = 0; i < PX; i++) {
      if (order[i] <= limit) img.set(i % 16, Math.floor(i / 16), order[i] < limit * 0.5 ? hex('#262626') : hex('#3c3c3c'));
    }
    imgs.push(img);
  }
  return imgs;
}

/** Torch: 2 px stick (columns 7–8, rows 6–15) with a glowing tip, like the classic torch. */
function paintTorch(img: Img, r: Rand): void {
  img.clear();
  const wood = P('#5c4024', '#6e4e2c', '#7d5a33');
  for (let y = 8; y < 16; y++) for (let x = 7; x < 9; x++) img.set(x, y, pick(wood, r()));
  img.set(7, 6, hex('#ffd85a')); img.set(8, 6, hex('#fff6b0'));
  img.set(7, 7, hex('#ff9a1f')); img.set(8, 7, hex('#ffcb3a'));
}

/** Lava: bright orange cells with dark crusty seams (animated by scrolling in the shader). */
function paintLava(img: Img, r: Rand): void {
  const { cell, edge } = voronoi(r, 12);
  const pal = P('#8a1d00', '#c23c00', '#e25d00', '#f78a12', '#ffb83a', '#ffe08a');
  const heat = Array.from({ length: 12 }, () => 0.45 + r() * 0.55);
  for (let i = 0; i < PX; i++) {
    const t = edge[i] < 0.9 ? 0.1 + r() * 0.15 : heat[cell[i]] * (0.85 + r() * 0.15);
    img.set(i % 16, Math.floor(i / 16), pick(pal, t));
  }
}

/** Crafting table: planks with a dark tool-grid top and tools on the side. */
function paintCraftingTop(img: Img, r: Rand): void {
  paintPlanks(img, r, P('#8f7040', '#9a7a48', '#a2834f'), hex('#6e5532'));
  const dark = hex('#4a3620');
  for (let i = 0; i < 16; i++) { img.set(i, 0, dark); img.set(i, 15, dark); img.set(0, i, dark); img.set(15, i, dark); }
  for (let i = 2; i < 14; i++) { img.set(i, 5, dark); img.set(i, 10, dark); img.set(5, i, dark); img.set(10, i, dark); }
}

function paintCraftingSide(img: Img, r: Rand): void {
  paintPlanks(img, r, P('#8f7040', '#9a7a48', '#a2834f'), hex('#6e5532'));
  for (let x = 0; x < 16; x++) for (let y = 0; y < 3; y++) img.set(x, y, shade(img.get(x, y), 0.8));
  const metal = hex('#9a9a9a'), handle = hex('#5c4024');
  for (let y = 5; y < 13; y++) img.set(4, y, handle);
  for (let x = 2; x < 7; x++) img.set(x, 5, metal);
  for (let y = 6; y < 13; y++) img.set(11, y, handle);
  for (let y = 4; y < 7; y++) for (let x = 10; x < 13; x++) img.set(x, y, metal);
}

function paintFurnace(img: Img, r: Rand, front: boolean): void {
  paintCobble(img, r, false);
  if (!front) return;
  const dark = hex('#1e1e1e'), rim = hex('#5a5a5a');
  for (let y = 7; y < 14; y++) for (let x = 3; x < 13; x++) img.set(x, y, y === 7 || x === 3 || x === 12 ? rim : dark);
  for (let x = 4; x < 12; x++) img.set(x, 3, rim);
}

/** TNT: red paper sides with a white label band, fuse on top, plain bottom. */
function paintTnt(img: Img, r: Rand, part: 'top' | 'side' | 'bottom'): void {
  const red = P('#c8301e', '#d63a26', '#b82a1a'), paper = P('#e8e2d4', '#d9d2c2');
  if (part !== 'side') {
    noisy(img, r, P('#b5341f', '#c43c24', '#a62e1c'), 0.4, 3);
    if (part === 'top') {
      for (let y = 6; y < 10; y++) for (let x = 6; x < 10; x++) img.set(x, y, hex('#2a2a2a'));
      img.set(7, 7, hex('#6a6a6a')); img.set(8, 8, hex('#6a6a6a'));
    }
    return;
  }
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const band = y >= 5 && y <= 10;
    img.set(x, y, band ? pick(paper, r()) : shade(pick(red, r()), x % 4 === 0 ? 0.82 : 1));
  }
  // "TNT" lettering on the label.
  const ink = hex('#1e1e1e');
  const T = [[0, 0], [1, 0], [2, 0], [1, 1], [1, 2], [1, 3]];
  const N = [[0, 0], [0, 1], [0, 2], [0, 3], [1, 1], [2, 2], [3, 0], [3, 1], [3, 2], [3, 3]];
  for (const [x, y] of T) img.set(2 + x, 6 + y, ink);
  for (const [x, y] of N) img.set(6 + x, 6 + y, ink);
  for (const [x, y] of T) img.set(11 + x, 6 + y, ink);
}

const PAINTERS: Record<string, (img: Img, r: Rand) => void> = {
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
  white_wool: (i, r) => paintWool(i, r, '#e4e8e8'),
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
};

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

/** Display version of a texture for UI icons: tinted with the default (plains) colour. */
function displayImage(img: Img, name: string): Img {
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
    img = makeTintable(img, name);
    procedural.set(name, img);
    current.set(name, img);
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
        upload(name, layer, img);
      });
      canvases.clear();
      texture.needsUpdate = true;
    },
  };
}
