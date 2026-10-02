import { DESTROY_STAGES } from '../world/BlockRegistry';
import { mulberry32 } from '../world/Noise';

/** Pixel-art painting kit shared by the procedural texture painters (see TextureAtlas, ContentPainters). */

export const TEX_SIZE = 16;
export const PX = TEX_SIZE * TEX_SIZE;

export type RGB = [number, number, number];

export function hex(c: string): RGB {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export class Img {
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

export type Rand = () => number;

export function shade(c: RGB, f: number): RGB {
  return [Math.min(255, c[0] * f), Math.min(255, c[1] * f), Math.min(255, c[2] * f)];
}

/** Tileable smooth value noise in [0,1], `cells` lattice cells across the tile. */
export function tileNoise(rand: Rand, cells: number): Float32Array {
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

export function pick(pal: RGB[], t: number): RGB {
  return pal[Math.max(0, Math.min(pal.length - 1, Math.floor(t * pal.length)))];
}

/** Palette noise: mix of smooth noise and per-pixel jitter, quantised to a palette. */
export function noisy(img: Img, rand: Rand, pal: RGB[], smooth = 0.5, cells = 4): void {
  const n = tileNoise(rand, cells);
  for (let y = 0; y < TEX_SIZE; y++) {
    for (let x = 0; x < TEX_SIZE; x++) {
      const t = n[y * TEX_SIZE + x] * smooth + rand() * (1 - smooth);
      img.set(x, y, pick(pal, t));
    }
  }
}

/** Tileable Voronoi cells: returns per-pixel cell id and edge distance (d2 - d1). */
export function voronoi(rand: Rand, count: number): { cell: Int32Array; edge: Float32Array; centers: number[] } {
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

export const P = (...cs: string[]) => cs.map(hex);

export const STONE = P('#6a6a6a', '#737373', '#7b7b7b', '#828282', '#8a8a8a', '#919191');
export const DIRT = P('#5e4130', '#6b4a34', '#79543a', '#866041', '#946b48');
export const GRASS = P('#4a8228', '#538f2e', '#5d9c34', '#68a93b', '#74b543');
export const SNOW = P('#dfeaee', '#e9f2f4', '#f1f8f9', '#f9fdfd');
export const SAND = P('#cfc086', '#d7c991', '#ddd09a', '#e3d7a4', '#e9dfb0');

export function paintStone(img: Img, r: Rand): void {
  noisy(img, r, STONE, 0.55, 4);
  for (let k = 0; k < 7; k++) {
    const x = Math.floor(r() * 16), y = Math.floor(r() * 16), len = 2 + Math.floor(r() * 3);
    for (let i = 0; i < len; i++) img.set((x + i) % 16, y, shade(img.get(x + i, y), 0.86));
  }
}

export function paintDirt(img: Img, r: Rand): void {
  noisy(img, r, DIRT, 0.35, 4);
  for (let k = 0; k < 6; k++) img.set(Math.floor(r() * 16), Math.floor(r() * 16), hex('#a07656'));
  for (let k = 0; k < 6; k++) img.set(Math.floor(r() * 16), Math.floor(r() * 16), hex('#4f3627'));
}

export function paintGrassTop(img: Img, r: Rand): void {
  noisy(img, r, GRASS, 0.45, 4);
  for (let k = 0; k < 10; k++) img.set(Math.floor(r() * 16), Math.floor(r() * 16), hex('#7fc04c'));
}

export function paintSideFringe(img: Img, r: Rand, pal: RGB[]): void {
  paintDirt(img, r);
  for (let x = 0; x < 16; x++) {
    const depth = 3 + (r() < 0.5 ? 1 : 0) + (r() < 0.25 ? 1 : 0);
    for (let y = 0; y < depth; y++) img.set(x, y, shade(pick(pal, r()), y === depth - 1 ? 0.88 : 1));
    if (r() < 0.3) img.set(x, depth, shade(pick(pal, r()), 0.8));
  }
}

export function paintPlanks(img: Img, r: Rand, pal: RGB[], gap: RGB): void {
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

export function paintLogSide(img: Img, r: Rand, pal: RGB[], dark: RGB): void {
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

export function paintBirchSide(img: Img, r: Rand): void {
  noisy(img, r, P('#cfcbc0', '#d8d5cc', '#e2dfd7', '#ebe8e1'), 0.3, 4);
  for (let k = 0; k < 9; k++) {
    const x = Math.floor(r() * 16), y = Math.floor(r() * 16), len = 2 + Math.floor(r() * 3);
    const c = r() < 0.6 ? hex('#2c2924') : hex('#5d584f');
    for (let i = 0; i < len; i++) img.set((x + i) % 16, y, c);
  }
}

export function paintLogTop(img: Img, r: Rand, bark: RGB[], light: RGB, dark: RGB): void {
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

export function paintLeaves(img: Img, r: Rand, pal: RGB[]): void {
  const n = tileNoise(r, 4);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      if (r() < 0.2 + n[y * 16 + x] * 0.12) { img.set(x, y, pal[0], 0); continue; }
      img.set(x, y, pick(pal, n[y * 16 + x] * 0.5 + r() * 0.5));
    }
  }
}

export function paintCobble(img: Img, r: Rand, mossy: boolean): void {
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

export function paintOre(img: Img, r: Rand, main: string, light: string, dark: string): void {
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

export function paintBricks(img: Img, r: Rand): void {
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

export function paintStoneBricks(img: Img, r: Rand): void {
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

export function paintWool(img: Img, r: Rand, base: string): void {
  const b = hex(base);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const weave = ((x + y) % 4 < 2 ? 1.04 : 0.95) * (0.94 + r() * 0.1);
      img.set(x, y, shade(b, weave));
    }
  }
}

export function paintGlass(img: Img, r: Rand): void {
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

export function paintWater(img: Img, r: Rand): void {
  noisy(img, r, P('#2a54b4', '#2f5cc0', '#3463ca', '#3a6bd3', '#4374db'), 0.7, 2);
  for (let k = 0; k < 9; k++) {
    const y = Math.floor(r() * 16), x = Math.floor(r() * 16), len = 3 + Math.floor(r() * 4);
    for (let i = 0; i < len; i++) img.set((x + i) % 16, y, hex('#5a8be6'));
  }
}

export function paintGlowstone(img: Img, r: Rand): void {
  const { cell, edge } = voronoi(r, 9);
  const pal = P('#a86b2c', '#c88a3b', '#ffbf5a', '#f6d58c', '#fff0b8');
  const lum = Array.from({ length: 9 }, () => 0.35 + r() * 0.65);
  for (let i = 0; i < PX; i++) {
    const t = edge[i] < 1 ? 0.1 : lum[cell[i]] * (0.8 + r() * 0.2);
    img.set(i % 16, Math.floor(i / 16), pick(pal, t));
  }
}

export function paintBookshelf(img: Img, r: Rand): void {
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

export function paintCactusSide(img: Img, r: Rand): void {
  noisy(img, r, P('#4f7d28', '#5b8c2f', '#669a36'), 0.3, 2);
  for (const x of [0, 15]) for (let y = 0; y < 16; y++) img.set(x, y, hex('#3a641c'));
  for (const x of [3, 7, 11]) for (let y = 0; y < 16; y++) img.set(x, y, shade(img.get(x, y), 0.82));
  for (let k = 0; k < 8; k++) img.set([2, 4, 6, 8, 10, 12][Math.floor(r() * 6)], Math.floor(r() * 16), hex('#d9d6a0'));
}

export function paintCactusTop(img: Img, r: Rand, dark: number): void {
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
    const c = d >= 7 ? hex('#3a641c') : Math.floor(d) % 3 === 0 ? hex('#4f7d28') : hex('#5f9333');
    img.set(x, y, shade(c, dark * (0.95 + r() * 0.1)));
  }
}

export function paintSandstone(img: Img, r: Rand, part: 'top' | 'side' | 'bottom'): void {
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

export function paintPlant(img: Img, r: Rand, kind: 'grass' | 'dandelion' | 'poppy' | 'dead'): void {
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
export function makeDestroyStages(): Img[] {
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
export function paintTorch(img: Img, r: Rand): void {
  img.clear();
  const wood = P('#5c4024', '#6e4e2c', '#7d5a33');
  for (let y = 8; y < 16; y++) for (let x = 7; x < 9; x++) img.set(x, y, pick(wood, r()));
  img.set(7, 6, hex('#ffd85a')); img.set(8, 6, hex('#fff6b0'));
  img.set(7, 7, hex('#ff9a1f')); img.set(8, 7, hex('#ffcb3a'));
}

/** Lava: bright orange cells with dark crusty seams (animated by scrolling in the shader). */
export function paintLava(img: Img, r: Rand): void {
  const { cell, edge } = voronoi(r, 12);
  const pal = P('#8a1d00', '#c23c00', '#e25d00', '#f78a12', '#ffb83a', '#ffe08a');
  const heat = Array.from({ length: 12 }, () => 0.45 + r() * 0.55);
  for (let i = 0; i < PX; i++) {
    const t = edge[i] < 0.9 ? 0.1 + r() * 0.15 : heat[cell[i]] * (0.85 + r() * 0.15);
    img.set(i % 16, Math.floor(i / 16), pick(pal, t));
  }
}

/** Crafting table: planks with a dark tool-grid top and tools on the side. */
export function paintCraftingTop(img: Img, r: Rand): void {
  paintPlanks(img, r, P('#8f7040', '#9a7a48', '#a2834f'), hex('#6e5532'));
  const dark = hex('#4a3620');
  for (let i = 0; i < 16; i++) { img.set(i, 0, dark); img.set(i, 15, dark); img.set(0, i, dark); img.set(15, i, dark); }
  for (let i = 2; i < 14; i++) { img.set(i, 5, dark); img.set(i, 10, dark); img.set(5, i, dark); img.set(10, i, dark); }
}

export function paintCraftingSide(img: Img, r: Rand): void {
  paintPlanks(img, r, P('#8f7040', '#9a7a48', '#a2834f'), hex('#6e5532'));
  for (let x = 0; x < 16; x++) for (let y = 0; y < 3; y++) img.set(x, y, shade(img.get(x, y), 0.8));
  const metal = hex('#9a9a9a'), handle = hex('#5c4024');
  for (let y = 5; y < 13; y++) img.set(4, y, handle);
  for (let x = 2; x < 7; x++) img.set(x, 5, metal);
  for (let y = 6; y < 13; y++) img.set(11, y, handle);
  for (let y = 4; y < 7; y++) for (let x = 10; x < 13; x++) img.set(x, y, metal);
}

export function paintFurnace(img: Img, r: Rand, front: boolean): void {
  paintCobble(img, r, false);
  if (!front) return;
  const dark = hex('#1e1e1e'), rim = hex('#5a5a5a');
  for (let y = 7; y < 14; y++) for (let x = 3; x < 13; x++) img.set(x, y, y === 7 || x === 3 || x === 12 ? rim : dark);
  for (let x = 4; x < 12; x++) img.set(x, 3, rim);
}

/** TNT: red paper sides with a white label band, fuse on top, plain bottom. */
export function paintTnt(img: Img, r: Rand, part: 'top' | 'side' | 'bottom'): void {
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

/**
 * Oak door halves: planks inside a darker frame. The lower half has two raised panels and the knob, the
 * upper half four window panes.
 */
export function paintDoor(img: Img, r: Rand, half: 'upper' | 'lower'): void {
  const pal = P('#8f7040', '#9a7a48', '#a2834f', '#b08f5a');
  const frame = hex('#5a4326'), inset = hex('#6e5532');
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      let c = pick(pal, r());
      if (x === 0 || x === 15) c = shade(frame, 0.9);
      else if (x === 1 || x === 14) c = frame;
      else if (half === 'upper' && y === 0) c = frame;
      else if (half === 'lower' && y === 15) c = shade(frame, 0.9);
      else if (half === 'lower' && y === 14) c = frame;
      img.set(x, y, c);
    }
  }
  if (half === 'upper') {
    // Four panes: dark recesses with a lighter glint, separated by the mullions.
    for (const [x0, y0] of [[3, 2], [9, 2], [3, 8], [9, 8]]) {
      for (let y = y0; y < y0 + 4; y++) for (let x = x0; x < x0 + 4; x++) img.set(x, y, y === y0 || x === x0 ? shade(inset, 0.75) : hex('#2a3138'));
      img.set(x0 + 1, y0 + 1, hex('#5d7585'));
    }
  } else {
    for (const y0 of [1, 8]) {
      for (let y = y0; y < y0 + 5; y++) for (let x = 3; x < 13; x++) img.set(x, y, y === y0 || x === 3 ? shade(frame, 1.3) : y === y0 + 4 || x === 12 ? shade(frame, 0.8) : shade(pick(pal, r()), 0.9));
    }
    // The knob.
    img.set(13, 7, hex('#d8d8d8')); img.set(12, 7, hex('#9a9a9a')); img.set(13, 8, hex('#7c7c7c')); img.set(12, 8, hex('#6a6a6a'));
  }
}

