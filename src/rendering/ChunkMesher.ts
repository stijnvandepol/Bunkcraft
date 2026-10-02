import {
  CULL_SELF, FACE_LAYER, MODELS, OPAQUE, SHAPE_MODEL, TINT, SHAPE, SHAPE_CROSS, SHAPE_CUBE, SHAPE_LIQUID, SWAY,
} from '../world/BlockRegistry';
import { CHUNK_HEIGHT, CHUNK_SIZE, CHUNK_VOLUME } from '../world/constants';
import { BLOCK } from '../world/BlockRegistry';
import { TINT_BIRCH, TINT_FOLIAGE, TINT_GRASS, TINT_SPRUCE, tintColor } from '../world/BiomeColors';
import { LightEngine, REGION, REGION_AREA, REGION_HEIGHT, REGION_VOLUME } from './Lighting';

/**
 * Chunk mesher (runs in workers).
 *
 * Input: the chunk and its 8 neighbours, copied into one 48×48×130 region so every
 * neighbour lookup is a plain array index (no chunk boundary branches).
 *
 * Output: three compact geometries (opaque, alpha-tested cutout, water). Faces are emitted only
 * where a block touches a non-opaque neighbour, and coplanar faces with identical
 * texture, AO and light are merged with greedy meshing.
 *
 * Vertex format (12 bytes, every attribute 4-component: ANGLE/D3D11 has no 3-component
 * short or 2-component byte formats and would convert those on the CPU per upload):
 *   packed Uint16×4 — chunk-local x, y, z × 16 (1/16 block precision) and the texture
 *                     coordinate w = u16 + v16 * 241 (u, v in 1/16 texels, 0..240), so
 *                     non-cube models can map sub-rectangles of a texture
 *   data   Uint8×4  — [texture layer, normal | ao<<3 | flags<<5, sky light, block light]
 *   tint   Uint8×4  — biome colour (normalised), white for untinted blocks
 */

export interface GeometryData {
  packed: Uint16Array;
  data: Uint8Array;
  tint: Uint8Array;
  index: Uint16Array | Uint32Array;
  minY: number;
  maxY: number;
}

export interface MeshResult {
  /** Fully opaque cubes: rendered without alpha testing so early-Z stays enabled. */
  opaque: GeometryData | null;
  /** Alpha-tested geometry: leaves, glass, plants. */
  cutout: GeometryData | null;
  water: GeometryData | null;
  /** Packed light of the centre chunk: sky << 4 | block. */
  light: Uint8Array;
}

export const FLAG_SWAY = 1;
export const FLAG_WAVE = 2;
/** Lava: self-lit and animated. */
export const FLAG_LAVA = 4;

const SX = 1;
const SZ = REGION;
const SY = REGION_AREA;
const STRIDE = [SX, SY, SZ]; // indexed by axis 0=x, 1=y, 2=z
const DIM = [CHUNK_SIZE, CHUNK_HEIGHT, CHUNK_SIZE];

interface FaceDef {
  nAxis: number; nSign: number;
  uAxis: number; uSign: number;
  vAxis: number; vSign: number;
}

// U = "right", V = "up" as seen from outside the face, so corners (0,0)(1,0)(1,1)(0,1)
// are counter-clockwise (front-facing). Face order: +X −X +Y −Y +Z −Z.
const FACES: FaceDef[] = [
  { nAxis: 0, nSign: 1, uAxis: 2, uSign: -1, vAxis: 1, vSign: 1 },
  { nAxis: 0, nSign: -1, uAxis: 2, uSign: 1, vAxis: 1, vSign: 1 },
  { nAxis: 1, nSign: 1, uAxis: 0, uSign: 1, vAxis: 2, vSign: -1 },
  { nAxis: 1, nSign: -1, uAxis: 0, uSign: 1, vAxis: 2, vSign: 1 },
  { nAxis: 2, nSign: 1, uAxis: 0, uSign: 1, vAxis: 1, vSign: 1 },
  { nAxis: 2, nSign: -1, uAxis: 0, uSign: -1, vAxis: 1, vSign: 1 },
];
const CU = [0, 1, 1, 0];
const CV = [0, 0, 1, 1];

class GeometryBuilder {
  pos = new Uint16Array(4096 * 4);
  data = new Uint8Array(4096 * 4);
  tint = new Uint8Array(4096 * 4);
  /** Packed 0xRRGGBB applied to subsequently emitted vertices. */
  currentTint = 0xffffff;
  idx = new Uint32Array(4096 * 1.5);
  vertexCount = 0;
  indexCount = 0;
  minY = 0;
  maxY = 0;

  reset(): void {
    this.vertexCount = 0;
    this.indexCount = 0;
    this.minY = 1e9;
    this.maxY = -1e9;
  }

  private grow(): void {
    const cap = this.pos.length / 4;
    const n = cap * 2;
    const pos = new Uint16Array(n * 4); pos.set(this.pos); this.pos = pos;
    const data = new Uint8Array(n * 4); data.set(this.data); this.data = data;
    const tint = new Uint8Array(n * 4); tint.set(this.tint); this.tint = tint;
    const idx = new Uint32Array(n * 1.5); idx.set(this.idx); this.idx = idx;
  }

  vertex(x: number, y: number, z: number, u: number, v: number, d0: number, d1: number, d2: number, d3: number): void {
    if (this.vertexCount * 4 + 4 > this.pos.length) this.grow();
    const i = this.vertexCount++;
    this.pos[i * 4] = x; this.pos[i * 4 + 1] = y; this.pos[i * 4 + 2] = z; this.pos[i * 4 + 3] = Math.round(u * 16) + Math.round(v * 16) * 241;
    this.data[i * 4] = d0; this.data[i * 4 + 1] = d1; this.data[i * 4 + 2] = d2; this.data[i * 4 + 3] = d3;
    const t = this.currentTint;
    this.tint[i * 4] = t >> 16; this.tint[i * 4 + 1] = (t >> 8) & 255; this.tint[i * 4 + 2] = t & 255; this.tint[i * 4 + 3] = 255;
    if (y < this.minY) this.minY = y;
    if (y > this.maxY) this.maxY = y;
  }

  /** Two triangles over the last 4 vertices; `flip` chooses the other diagonal. */
  quad(flip: boolean, doubleSided = false): void {
    const b = this.vertexCount - 4;
    const t = this.idx;
    let n = this.indexCount;
    if (!flip) { t[n++] = b; t[n++] = b + 1; t[n++] = b + 2; t[n++] = b; t[n++] = b + 2; t[n++] = b + 3; }
    else { t[n++] = b; t[n++] = b + 1; t[n++] = b + 3; t[n++] = b + 1; t[n++] = b + 2; t[n++] = b + 3; }
    if (doubleSided) { t[n++] = b; t[n++] = b + 2; t[n++] = b + 1; t[n++] = b; t[n++] = b + 3; t[n++] = b + 2; }
    this.indexCount = n;
  }

  finish(): GeometryData | null {
    if (this.indexCount === 0) return null;
    const v = this.vertexCount;
    const index = v <= 65535 ? Uint16Array.from(this.idx.subarray(0, this.indexCount)) : this.idx.slice(0, this.indexCount);
    return {
      packed: this.pos.slice(0, v * 4),
      data: this.data.slice(0, v * 4),
      tint: this.tint.slice(0, v * 4),
      index,
      minY: this.minY / 16,
      maxY: this.maxY / 16,
    };
  }
}

const MASK_SIZE = CHUNK_SIZE * CHUNK_HEIGHT;
const MAX_MERGE = 15;

export class ChunkMesher {
  private readonly region = new Uint8Array(REGION_VOLUME);
  private readonly lighting = new LightEngine();
  private readonly opaque = new GeometryBuilder();
  private readonly cutout = new GeometryBuilder();
  private readonly water = new GeometryBuilder();
  /** Indexed by cell target: 0 opaque, 1 cutout, 2 water. */
  private readonly builders = [this.opaque, this.cutout, this.water];

  private readonly mask = new Int32Array(MASK_SIZE);
  private readonly cellAO = new Uint8Array(MASK_SIZE * 4);
  private readonly cellSky = new Uint8Array(MASK_SIZE * 4);
  private readonly cellBlk = new Uint8Array(MASK_SIZE * 4);
  private readonly cellLayer = new Uint8Array(MASK_SIZE);
  private readonly cellFlags = new Uint8Array(MASK_SIZE);
  private readonly cellLowered = new Uint8Array(MASK_SIZE);
  private readonly cellTarget = new Uint8Array(MASK_SIZE);
  private readonly cellTint = new Int32Array(MASK_SIZE);
  /** Blurred biome colours per centre column (x + z*16), packed 0xRRGGBB. */
  private readonly grassTint = new Int32Array(256);
  private readonly foliageTint = new Int32Array(256);

  /** neighbours[(dz + 1) * 3 + (dx + 1)] = chunk block arrays. */
  mesh(neighbours: Uint8Array[], biomes: Uint8Array[], fancyLeaves: boolean): MeshResult {
    this.buildRegion(neighbours);
    this.computeTints(biomes);
    this.lighting.compute(this.region);
    this.opaque.reset();
    this.cutout.reset();
    this.water.reset();
    for (let f = 0; f < 6; f++) this.meshFace(f, fancyLeaves);
    this.meshCrosses();
    return {
      opaque: this.opaque.finish(),
      cutout: this.cutout.finish(),
      water: this.water.finish(),
      light: this.extractLight(),
    };
  }

  private buildRegion(neighbours: Uint8Array[]): void {
    const r = this.region;
    // Layer y = -1 is bedrock (never visible), layer y = 128 is open air.
    r.fill(BLOCK.BEDROCK, 0, REGION_AREA);
    r.fill(0, (REGION_HEIGHT - 1) * REGION_AREA, REGION_VOLUME);
    for (let n = 0; n < 9; n++) {
      const src = neighbours[n];
      const ox = (n % 3) * CHUNK_SIZE;
      const oz = Math.floor(n / 3) * CHUNK_SIZE;
      for (let y = 0; y < CHUNK_HEIGHT; y++) {
        const ry = (y + 1) * REGION_AREA;
        for (let z = 0; z < CHUNK_SIZE; z++) {
          const s = (y << 8) | (z << 4);
          r.set(src.subarray(s, s + CHUNK_SIZE), ry + (oz + z) * REGION + ox);
        }
      }
    }
  }

  /**
   * Biome colours with a 5×5 box blur across columns (like Minecraft's biome blend),
   * so grass and leaves fade smoothly at biome borders, also across chunk borders.
   */
  private computeTints(biomes: Uint8Array[]): void {
    const biomeAt = (x: number, z: number) => {
      const n = (Math.floor(z / 16) + 1) * 3 + Math.floor(x / 16) + 1;
      return biomes[n][(x & 15) + (z & 15) * 16];
    };
    for (const [type, out] of [[TINT_GRASS, this.grassTint], [TINT_FOLIAGE, this.foliageTint]] as const) {
      for (let z = 0; z < 16; z++) {
        for (let x = 0; x < 16; x++) {
          let r = 0, g = 0, b = 0;
          for (let dz = -2; dz <= 2; dz++) {
            for (let dx = -2; dx <= 2; dx++) {
              const c = tintColor(type, biomeAt(x + dx, z + dz));
              r += c[0]; g += c[1]; b += c[2];
            }
          }
          out[x + z * 16] = (Math.round(r / 25) << 16) | (Math.round(g / 25) << 8) | Math.round(b / 25);
        }
      }
    }
  }

  private tintFor(id: number, x: number, z: number): number {
    switch (TINT[id]) {
      case TINT_GRASS: return this.grassTint[x + z * 16];
      case TINT_FOLIAGE: return this.foliageTint[x + z * 16];
      case TINT_BIRCH: case TINT_SPRUCE: {
        const c = tintColor(TINT[id], 0);
        return (c[0] << 16) | (c[1] << 8) | c[2];
      }
      default: return 0xffffff;
    }
  }

  /**
   * Small non-cube models (torch): every box face is emitted with texture coordinates
   * taken from the same 1/16 rectangle of the texture, like Minecraft block models.
   */
  private emitModel(id: number, x: number, y: number, z: number, i: number): void {
    const boxes = MODELS[id];
    if (!boxes) return;
    const geo = this.cutout;
    geo.currentTint = 0xffffff;
    const layer = FACE_LAYER[id * 6];
    const ls = this.lighting.sky[i] * 17, lb = this.lighting.block[i] * 17;
    const bx = x * 16, by = y * 16, bz = z * 16;
    for (const [x0, y0, z0, x1, y1, z1] of boxes) {
      const quad = (pts: number[][], uv: number[][], normal: number) => {
        for (let k = 0; k < 4; k++) {
          geo.vertex(bx + pts[k][0], by + pts[k][1], bz + pts[k][2], uv[k][0] / 16, uv[k][1] / 16, layer, normal | (3 << 3), ls, lb);
        }
        geo.quad(false);
      };
      // Sides: u follows the box width, v the height (texture rows counted from the bottom).
      const side = (u0: number, u1: number) => [[u0, y0], [u1, y0], [u1, y1], [u0, y1]];
      quad([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], side(z0, z1), 0);
      quad([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], side(z0, z1), 1);
      quad([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], side(x0, x1), 4);
      quad([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], side(x0, x1), 5);
      // Top shows the 2×2 just below the tip; bottom the stick end.
      const top = [[x0, y1 - 2], [x1, y1 - 2], [x1, y1], [x0, y1]];
      quad([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], top, 2);
      quad([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [[x0, 0], [x1, 0], [x1, 2], [x0, 2]], 3);
    }
  }

  private extractLight(): Uint8Array {
    const out = new Uint8Array(CHUNK_VOLUME);
    const sky = this.lighting.sky, blk = this.lighting.block;
    for (let y = 0; y < CHUNK_HEIGHT; y++) {
      for (let z = 0; z < CHUNK_SIZE; z++) {
        const ri = (y + 1) * REGION_AREA + (z + 16) * REGION + 16;
        const ci = (y << 8) | (z << 4);
        for (let x = 0; x < CHUNK_SIZE; x++) out[ci + x] = (sky[ri + x] << 4) | blk[ri + x];
      }
    }
    return out;
  }

  private meshFace(f: number, fancyLeaves: boolean): void {
    const face = FACES[f];
    const { nAxis, nSign, uAxis, uSign, vAxis, vSign } = face;
    const dimN = DIM[nAxis], dimA = DIM[uAxis], dimB = DIM[vAxis];
    const nOff = nSign * STRIDE[nAxis];
    const uOff = uSign * STRIDE[uAxis];
    const vOff = vSign * STRIDE[vAxis];
    const strideA = STRIDE[uAxis], strideB = STRIDE[vAxis], strideN = STRIDE[nAxis];
    const region = this.region;
    const sky = this.lighting.sky, blk = this.lighting.block;
    const mask = this.mask;
    const cellAO = this.cellAO, cellSky = this.cellSky, cellBlk = this.cellBlk;
    // Region index of chunk-local (0,0,0).
    const base = 16 * SX + 16 * SZ + 1 * SY;

    for (let s = 0; s < dimN; s++) {
      // ---- 1. Build the face mask for this slice ----
      let n = 0;
      for (let b = 0; b < dimB; b++) {
        for (let a = 0; a < dimA; a++, n++) {
          const i = base + s * strideN + a * strideA + b * strideB;
          const id = region[i];
          const shape = SHAPE[id];
          mask[n] = 0;
          if (shape !== SHAPE_CUBE && shape !== SHAPE_LIQUID) continue;
          const q = i + nOff;
          const nb = region[q];
          if (OPAQUE[nb]) continue;
          if (nb === id && (CULL_SELF[id] || (!fancyLeaves && SWAY[id]))) continue;
          const liquid = shape === SHAPE_LIQUID;
          if (liquid && nb === id) continue;

          // Per-corner ambient occlusion and smooth light, sampled in the air cell q.
          const c4 = n * 4;
          this.cellTint[n] = this.tintFor(id, nAxis === 0 ? s : uAxis === 0 ? a : b, nAxis === 2 ? s : uAxis === 2 ? a : b);
          let uniform = true;
          for (let k = 0; k < 4; k++) {
            const du = CU[k] ? uOff : -uOff;
            const dv = CV[k] ? vOff : -vOff;
            const s1 = q + du, s2 = q + dv, cc = q + du + dv;
            const o1 = OPAQUE[region[s1]], o2 = OPAQUE[region[s2]];
            const oc = o1 && o2 ? 1 : OPAQUE[region[cc]];
            let ao = liquid ? 3 : o1 && o2 ? 0 : 3 - (o1 + o2 + oc);
            let ls = sky[q], lb = blk[q], cnt = 1;
            if (!o1) { ls += sky[s1]; lb += blk[s1]; cnt++; }
            if (!o2) { ls += sky[s2]; lb += blk[s2]; cnt++; }
            if (!oc) { ls += sky[cc]; lb += blk[cc]; cnt++; }
            if (ao < 0) ao = 0;
            cellAO[c4 + k] = ao;
            cellSky[c4 + k] = Math.round((ls * 17) / cnt);
            cellBlk[c4 + k] = Math.round((lb * 17) / cnt);
            if (k > 0 && (cellAO[c4 + k] !== cellAO[c4] || cellSky[c4 + k] !== cellSky[c4] || cellBlk[c4 + k] !== cellBlk[c4])) {
              uniform = false;
            }
          }
          const layer = FACE_LAYER[id * 6 + f];
          let flags = 0;
          let lowered = 0;
          if (liquid) {
            // Water surface sits 2/16 lower when there is no water above it.
            lowered = region[i + SY] !== id ? 1 : 0;
            if (id === BLOCK.LAVA) flags = FLAG_LAVA;
            else if (f === 2) flags = FLAG_WAVE;
            // Never merge water: the surface is displaced per vertex in the shader, and
            // merged quads would create T-junction cracks with smaller neighbours.
            uniform = false;
          } else if (SWAY[id] && fancyLeaves) {
            flags = FLAG_SWAY;
          }
          this.cellLayer[n] = layer;
          this.cellFlags[n] = flags;
          this.cellLowered[n] = lowered;
          // Water is blended; lava is drawn opaque (it glows and hides what is under it).
          this.cellTarget[n] = liquid ? (id === BLOCK.WATER ? 2 : 0) : OPAQUE[id] ? 0 : 1;
          mask[n] = uniform
            ? (1 << 30) | layer | (cellAO[c4] << 8) | (cellSky[c4] << 10) | (cellBlk[c4] << 18) | (flags << 26) | ((liquid ? 1 : 0) << 28) | (lowered << 29)
            : -(n + 1);
        }
      }

      // ---- 2. Greedy merge identical neighbouring cells into rectangles ----
      n = 0;
      for (let b = 0; b < dimB; b++) {
        for (let a = 0; a < dimA;) {
          const key = mask[n];
          if (key === 0) { a++; n++; continue; }
          let w = 1;
          const tint = this.cellTint[n];
          // Merged quads are capped at 15 blocks so the packed texture coordinate fits.
          while (a + w < dimA && w < MAX_MERGE && mask[n + w] === key && this.cellTint[n + w] === tint) w++;
          let h = 1;
          grow: while (b + h < dimB && h < MAX_MERGE) {
            const row = n + h * dimA;
            for (let k = 0; k < w; k++) if (mask[row + k] !== key || this.cellTint[row + k] !== tint) break grow;
            h++;
          }
          this.emitQuad(face, f, s, a, b, w, h, n);
          for (let hh = 0; hh < h; hh++) mask.fill(0, n + hh * dimA, n + hh * dimA + w);
          a += w;
          n += w;
        }
      }
    }
  }

  private emitQuad(face: FaceDef, f: number, s: number, a0: number, b0: number, w: number, h: number, cell: number): void {
    const geo = this.builders[this.cellTarget[cell]];
    geo.currentTint = this.cellTint[cell];
    const layer = this.cellLayer[cell];
    const flags = this.cellFlags[cell];
    const lowered = this.cellLowered[cell];
    const c4 = cell * 4;
    const coord = [0, 0, 0];
    const nPlane = s + (face.nSign > 0 ? 1 : 0);
    for (let k = 0; k < 4; k++) {
      const cu = CU[k], cv = CV[k];
      coord[face.nAxis] = nPlane;
      coord[face.uAxis] = face.uSign > 0 ? a0 + cu * w : a0 + w - cu * w;
      coord[face.vAxis] = face.vSign > 0 ? b0 + cv * h : b0 + h - cv * h;
      let y16 = coord[1] * 16;
      if (lowered && (f === 2 || (f !== 3 && cv === 1))) y16 -= 2;
      geo.vertex(
        coord[0] * 16, y16, coord[2] * 16,
        cu * w, cv * h,
        layer, f | (this.cellAO[c4 + k] << 3) | (flags << 5), this.cellSky[c4 + k], this.cellBlk[c4 + k],
      );
    }
    const ao = this.cellAO;
    const l0 = ao[c4] * 16 + this.cellSky[c4] / 16, l1 = ao[c4 + 1] * 16 + this.cellSky[c4 + 1] / 16;
    const l2 = ao[c4 + 2] * 16 + this.cellSky[c4 + 2] / 16, l3 = ao[c4 + 3] * 16 + this.cellSky[c4 + 3] / 16;
    // Pick the triangulation diagonal that keeps AO gradients symmetric (avoids "creases").
    geo.quad(l0 + l2 < l1 + l3);
  }

  private meshCrosses(): void {
    const region = this.region;
    const sky = this.lighting.sky, blk = this.lighting.block;
    const geo = this.cutout;
    for (let y = 0; y < CHUNK_HEIGHT; y++) {
      for (let z = 0; z < CHUNK_SIZE; z++) {
        let i = (y + 1) * SY + (z + 16) * SZ + 16;
        for (let x = 0; x < CHUNK_SIZE; x++, i++) {
          const id = region[i];
          if (SHAPE[id] === SHAPE_MODEL) {
            this.emitModel(id, x, y, z, i);
            continue;
          }
          if (SHAPE[id] !== SHAPE_CROSS) continue;
          const layer = FACE_LAYER[id * 6];
          geo.currentTint = this.tintFor(id, x, z);
          const ls = sky[i] * 17, lb = blk[i] * 17;
          const sway = SWAY[id] ? FLAG_SWAY << 5 : 0;
          const x0 = x * 16 + 2, x1 = x * 16 + 14, z0 = z * 16 + 2, z1 = z * 16 + 14;
          const y0 = y * 16, y1 = y * 16 + 16;
          const d = 6 | (3 << 3);
          for (let p = 0; p < 2; p++) {
            const za = p === 0 ? z0 : z1, zb = p === 0 ? z1 : z0;
            geo.vertex(x0, y0, za, 0, 0, layer, d, ls, lb);
            geo.vertex(x1, y0, zb, 1, 0, layer, d, ls, lb);
            geo.vertex(x1, y1, zb, 1, 1, layer, d | sway, ls, lb);
            geo.vertex(x0, y1, za, 0, 1, layer, d | sway, ls, lb);
            geo.quad(false, true);
          }
        }
      }
    }
  }
}
