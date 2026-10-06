import {
  BOX_KIND, CULL_SELF, DYE, DYE_RGB, FACE_LAYER, FACING, FRONT_FACE, MODELS, OPAQUE, PARTIAL, SHAPE_DOOR, SHAPE_MODEL, SHAPE_SLAB, SHAPE_STAIRS, SOLID, TINT, SHAPE, SHAPE_CROSS, SHAPE_CUBE,
  SHAPE_BOX, SHAPE_LIQUID, SWAY, VARIANT_LAYER, VARIANT_SHIFT, VARIANT_SLOT,
} from '../world/BlockRegistry';
import { liquidHeight } from '../world/Liquids';
import { BED_HEAD_BIT, BOX_BED, SIDE_BIT, visualBoxes } from '../world/BoxShapes';
import { connectsTo } from '../world/BlockShapes';
import { DUST_COLORS, dustConnectMask } from '../world/Redstone';
import { BOX_DUST, redstoneFaceSlot } from '../world/RedstoneShapes';
import { doorBox } from '../world/BlockShapes';
import {
  DOOR_UPPER_BIT, FACE_OCTANTS, OCT_ALL, STAIR_META_MASK, slabOctants, stairOctants, stairShape,
} from '../world/BlockStates';
import { CHUNK_HEIGHT, CHUNK_SIZE, CHUNK_VOLUME } from '../world/constants';
import { BLOCK } from '../world/BlockRegistry';
import { TINT_BIRCH, TINT_FOLIAGE, TINT_GRASS, TINT_SPRUCE, TINT_WATER, tintColor } from '../world/BiomeColors';
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

/** Returns an ArrayBuffer of at least the requested size (the worker recycles them through a pool). */
export type BufferAlloc = (bytes: number) => ArrayBuffer;

/** Worst case of `quad(flip, doubleSided = true)`: 12 indices per 4 vertices. */
const INDICES_PER_VERTEX = 3;

class GeometryBuilder {
  pos = new Uint16Array(4096 * 4);
  data = new Uint8Array(4096 * 4);
  tint = new Uint8Array(4096 * 4);
  /** Packed 0xRRGGBB applied to subsequently emitted vertices. */
  currentTint = 0xffffff;
  /**
   * Index scratch, INDICES_PER_VERTEX per vertex of capacity: a double-sided quad (cross plants)
   * emits 12 indices for its 4 vertices. Typed-array writes past the end are silently dropped, so a
   * smaller scratch loses indices and the result keeps stale pool bytes in their place.
   */
  idx = new Uint32Array(4096 * INDICES_PER_VERTEX);
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
    const idx = new Uint32Array(n * INDICES_PER_VERTEX); idx.set(this.idx); this.idx = idx;
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

  finish(alloc: BufferAlloc): GeometryData | null {
    if (this.indexCount === 0) return null;
    const v = this.vertexCount, n = this.indexCount;
    const packed = new Uint16Array(alloc(v * 8), 0, v * 4);
    packed.set(this.pos.subarray(0, v * 4));
    const data = new Uint8Array(alloc(v * 4), 0, v * 4);
    data.set(this.data.subarray(0, v * 4));
    const tint = new Uint8Array(alloc(v * 4), 0, v * 4);
    tint.set(this.tint.subarray(0, v * 4));
    const index = v <= 65535 ? new Uint16Array(alloc(n * 2), 0, n) : new Uint32Array(alloc(n * 4), 0, n);
    index.set(this.idx.subarray(0, n));
    return {
      packed, data, tint, index,
      minY: this.minY / 16,
      maxY: this.maxY / 16,
    };
  }
}

const MASK_SIZE = CHUNK_SIZE * CHUNK_HEIGHT;
const MAX_MERGE = 15;

export class ChunkMesher {
  /** Output buffers come from here: exact-size by default, pooled power-of-two buffers in the worker. */
  alloc: BufferAlloc = (bytes) => new ArrayBuffer(bytes);
  private readonly region = new Uint8Array(REGION_VOLUME);
  /** 32-bit views of the region arrays: chunk rows (16 bytes, 4-byte aligned) are copied as four words, without allocating. */
  private readonly region32 = new Uint32Array(this.region.buffer);
  /** Block state bytes of the same region; only valid (non-zero) while `metaUsed` is set. */
  private readonly metaRegion = new Uint8Array(REGION_VOLUME);
  private readonly metaRegion32 = new Uint32Array(this.metaRegion.buffer);
  private metaUsed = false;
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
  private readonly cellTarget = new Uint8Array(MASK_SIZE);
  private readonly cellTint = new Int32Array(MASK_SIZE);
  /** Blurred biome colours per centre column (x + z*16), packed 0xRRGGBB. */
  private readonly grassTint = new Int32Array(256);
  private readonly foliageTint = new Int32Array(256);
  private readonly waterTint = new Int32Array(256);

  /**
   * neighbours[(dz + 1) * 3 + (dx + 1)] = chunk block arrays; `metas` the matching block state
   * arrays (null for chunks without any state, which is the common case).
   */
  mesh(neighbours: Uint8Array[], biomes: Uint8Array[], fancyLeaves: boolean, metas?: (Uint8Array | null)[]): MeshResult {
    this.buildRegion(neighbours, metas);
    this.computeTints(biomes);
    this.lighting.compute(this.region);
    this.opaque.reset();
    this.cutout.reset();
    this.water.reset();
    for (let f = 0; f < 6; f++) this.meshFace(f, fancyLeaves);
    this.meshCrosses();
    return {
      opaque: this.opaque.finish(this.alloc),
      cutout: this.cutout.finish(this.alloc),
      water: this.water.finish(this.alloc),
      light: this.extractLight(),
    };
  }

  private buildRegion(neighbours: Uint8Array[], metas?: (Uint8Array | null)[]): void {
    const r = this.region;
    const mr = this.metaRegion;
    const anyMeta = !!metas && metas.some((m) => m !== null);
    if (anyMeta || this.metaUsed) mr.fill(0);
    this.metaUsed = anyMeta;
    // Layer y = -1 is bedrock (never visible), layer y = 128 is open air.
    r.fill(BLOCK.BEDROCK, 0, REGION_AREA);
    r.fill(0, (REGION_HEIGHT - 1) * REGION_AREA, REGION_VOLUME);
    for (let n = 0; n < 9; n++) {
      const ox = (n % 3) * CHUNK_SIZE;
      const oz = Math.floor(n / 3) * CHUNK_SIZE;
      this.copyChunk(neighbours[n], r, this.region32, ox, oz);
      const m = anyMeta ? metas![n] : null;
      if (m) this.copyChunk(m, mr, this.metaRegion32, ox, oz);
    }
  }

  /** Copies a chunk's 128 layers into the region at (ox, oz), row by row (16 bytes = four 32-bit words per row). */
  private copyChunk(src: Uint8Array, dst: Uint8Array, dst32: Uint32Array, ox: number, oz: number): void {
    if (src.byteOffset & 3) {
      // Unaligned view (never from the workers): the slow, allocating way.
      for (let y = 0; y < CHUNK_HEIGHT; y++) {
        for (let z = 0; z < CHUNK_SIZE; z++) {
          const s = (y << 8) | (z << 4);
          dst.set(src.subarray(s, s + CHUNK_SIZE), (y + 1) * REGION_AREA + (oz + z) * REGION + ox);
        }
      }
      return;
    }
    const s32 = new Uint32Array(src.buffer, src.byteOffset, CHUNK_VOLUME >> 2);
    for (let y = 0; y < CHUNK_HEIGHT; y++) {
      const ry = (y + 1) * REGION_AREA;
      for (let z = 0; z < CHUNK_SIZE; z++) {
        const s = (y << 6) | (z << 2);
        const d = (ry + (oz + z) * REGION + ox) >> 2;
        dst32[d] = s32[s]; dst32[d + 1] = s32[s + 1]; dst32[d + 2] = s32[s + 2]; dst32[d + 3] = s32[s + 3];
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
    for (const [type, out] of [[TINT_GRASS, this.grassTint], [TINT_FOLIAGE, this.foliageTint], [TINT_WATER, this.waterTint]] as const) {
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
    const out = new Uint8Array(this.alloc(CHUNK_VOLUME), 0, CHUNK_VOLUME);
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
          if (shape !== SHAPE_CUBE) continue;
          const q = i + nOff;
          const nb = region[q];
          if (OPAQUE[nb]) continue;
          // A slab or stair that covers the whole touching face hides it, like an opaque block would.
          if (PARTIAL[nb] && (this.octantsAt(q) & FACE_OCTANTS[f ^ 1]) === FACE_OCTANTS[f ^ 1]) continue;
          if (nb === id && (CULL_SELF[id] || (!fancyLeaves && SWAY[id]))) continue;

          // Per-corner ambient occlusion and smooth light, sampled in the air cell q.
          const c4 = n * 4;
          this.cellTint[n] = DYE[id] ? DYE_RGB[this.metaRegion[i] & 15]
            : this.tintFor(id, nAxis === 0 ? s : uAxis === 0 ? a : b, nAxis === 2 ? s : uAxis === 2 ? a : b);
          let uniform = true;
          for (let k = 0; k < 4; k++) {
            const du = CU[k] ? uOff : -uOff;
            const dv = CV[k] ? vOff : -vOff;
            const s1 = q + du, s2 = q + dv, cc = q + du + dv;
            const o1 = OPAQUE[region[s1]], o2 = OPAQUE[region[s2]];
            const oc = o1 && o2 ? 1 : OPAQUE[region[cc]];
            let ao = o1 && o2 ? 0 : 3 - (o1 + o2 + oc);
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
          // Blocks with a front (furnace, chest, pumpkin) show it on the face their state points at.
          const layer = FACING[id] ? FACE_LAYER[id * 6 + (FRONT_FACE[this.metaRegion[i] & 3] === f ? 4 : 0)] : FACE_LAYER[id * 6 + f];
          const flags = SWAY[id] && fancyLeaves ? FLAG_SWAY : 0;
          this.cellLayer[n] = layer;
          this.cellFlags[n] = flags;
          this.cellTarget[n] = OPAQUE[id] ? 0 : 1;
          mask[n] = uniform
            ? (1 << 30) | layer | (cellAO[c4] << 8) | (cellSky[c4] << 10) | (cellBlk[c4] << 18) | (flags << 26)
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
    const c4 = cell * 4;
    const coord = [0, 0, 0];
    const nPlane = s + (face.nSign > 0 ? 1 : 0);
    for (let k = 0; k < 4; k++) {
      const cu = CU[k], cv = CV[k];
      coord[face.nAxis] = nPlane;
      coord[face.uAxis] = face.uSign > 0 ? a0 + cu * w : a0 + w - cu * w;
      coord[face.vAxis] = face.vSign > 0 ? b0 + cv * h : b0 + h - cv * h;
      geo.vertex(
        coord[0] * 16, coord[1] * 16, coord[2] * 16,
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

  // ---- Liquids: surface height follows the liquid level ----

  /** Heights (0..1) of the four top corners of a liquid cell, indexed xa | za << 1 for the corner (x + xa, z + za). */
  private readonly liquidCorners = [0, 0, 0, 0];
  private readonly liquidVerts = [0, 0, 0, 0];

  /**
   * Height of the liquid surface at one corner of a cell (Minecraft's LiquidBlockRenderer.getHeight): the average
   * over the four cells around the corner, full height when liquid of the same kind is above any of them, and
   * counting air as height 0 so the surface slopes down towards open edges.
   */
  private cornerHeight(i: number, kind: number, xa: number, za: number): number {
    const region = this.region;
    let sum = 0, count = 0;
    for (let b = za - 1; b <= za; b++) {
      for (let a = xa - 1; a <= xa; a++) {
        const j = i + a * SX + b * SZ;
        if (region[j + SY] === kind) return 1;
        const id = region[j];
        if (id === kind) {
          const h = liquidHeight(this.metaRegion[j]);
          if (h >= 0.8) { sum += h * 10; count += 10; } else { sum += h; count++; }
        } else if (!SOLID[id]) count++;
      }
    }
    return sum / count;
  }

  /** Is this face of a liquid cell hidden by the neighbour at region index q (liquid of the same kind, or something that covers it)? */
  private liquidFaceHidden(kind: number, q: number, f: number): boolean {
    const nb = this.region[q];
    if (nb === kind || OPAQUE[nb]) return true;
    return PARTIAL[nb] === 1 && (this.octantsAt(q) & FACE_OCTANTS[f ^ 1]) === FACE_OCTANTS[f ^ 1];
  }

  /**
   * One water or lava cell: the top follows the liquid level (sloping between neighbours of different level), the
   * sides reach up to that surface, and columns of liquid join into full-height walls. Lava goes to the opaque
   * geometry (it glows and hides what is under it), water to the blended one.
   */
  private emitLiquid(kind: number, x: number, y: number, z: number, i: number): void {
    const geo = kind === BLOCK.WATER ? this.water : this.opaque;
    geo.currentTint = kind === BLOCK.WATER ? this.waterTint[(x & 15) + (z & 15) * 16] : 0xffffff;
    const hc = this.liquidCorners;
    hc[0] = this.cornerHeight(i, kind, 0, 0);
    hc[1] = this.cornerHeight(i, kind, 1, 0);
    hc[2] = this.cornerHeight(i, kind, 0, 1);
    hc[3] = this.cornerHeight(i, kind, 1, 1);
    const ys = this.liquidVerts;
    for (let f = 0; f < 6; f++) {
      const face = FACES[f];
      const q = i + face.nSign * STRIDE[face.nAxis];
      if (this.liquidFaceHidden(kind, q, f)) continue;
      const layer = FACE_LAYER[kind * 6 + f];
      this.cornerSample(f, q);
      for (let k = 0; k < 4; k++) this.pAO[k] = 3; // liquids take no ambient occlusion
      const flags = kind === BLOCK.LAVA ? FLAG_LAVA : f === 2 ? FLAG_WAVE : 0;
      const coord = this.rectCoord;
      for (let k = 0; k < 4; k++) {
        const cu = CU[k], cv = CV[k];
        coord[face.nAxis] = face.nSign > 0 ? 1 : 0;
        coord[face.uAxis] = face.uSign > 0 ? cu : 1 - cu;
        coord[face.vAxis] = face.vSign > 0 ? cv : 1 - cv;
        // Height of this vertex: the surface at the top, the floor of the cell at the bottom.
        let h = 0;
        if (f === 2) h = hc[coord[0] | (coord[2] << 1)];
        else if (f !== 3 && cv === 1) h = hc[coord[0] | (coord[2] << 1)];
        ys[k] = Math.round(h * 16);
        const y16 = f === 2 ? ys[k] : f === 3 ? 0 : cv === 1 ? ys[k] : 0;
        const tv = f === 2 || f === 3 ? (face.vSign > 0 ? coord[face.vAxis] : 1 - coord[face.vAxis]) : y16 / 16;
        geo.vertex(
          (x + coord[0]) * 16, y * 16 + y16, (z + coord[2]) * 16,
          face.uSign > 0 ? coord[face.uAxis] : 1 - coord[face.uAxis], tv,
          layer, f | (3 << 3) | (flags << 5), Math.round(this.pSky[k] * 17), Math.round(this.pBlk[k] * 17),
        );
      }
      // Split the sloping surface along its ridge (the diagonal between the two higher corners).
      geo.quad(f === 2 && ys[0] + ys[2] < ys[1] + ys[3]);
    }
  }

  // ---- Slabs, stairs and doors: geometry that depends on the block state ----

  /** Stair meta (0-7) of the block at region index j, or −1 when it is not a stairs block. */
  private stairAt(j: number): number {
    return SHAPE[this.region[j]] === SHAPE_STAIRS ? this.metaRegion[j] & STAIR_META_MASK : -1;
  }

  /**
   * Octants (see BlockStates) a block fills, for hiding faces: opaque blocks fill all of them, slabs and
   * stairs their own, everything else (air, glass, plants) none.
   */
  private octantsAt(i: number): number {
    const id = this.region[i];
    if (OPAQUE[id]) return OCT_ALL;
    const shape = SHAPE[id];
    if (shape === SHAPE_SLAB) return slabOctants(this.metaRegion[i]);
    if (shape === SHAPE_STAIRS) {
      const meta = this.metaRegion[i] & STAIR_META_MASK;
      return stairOctants(meta, stairShape(meta, this.stairAt(i - SZ), this.stairAt(i + SZ), this.stairAt(i - SX), this.stairAt(i + SX)));
    }
    return 0;
  }

  // Per-corner ambient occlusion and light for the face that looks into cell q (filled by cornerSample).
  private readonly pAO = [0, 0, 0, 0];
  private readonly pSky = [0, 0, 0, 0];
  private readonly pBlk = [0, 0, 0, 0];
  private readonly rectCoord = [0, 0, 0];
  private readonly rectAO = [0, 0, 0, 0];
  private readonly octCoord = [0, 0, 0];
  private readonly doorScratch = [0, 0, 0, 0, 0, 0];

  /** The same corner sampling the cube faces use (see meshFace), kept as floats so partial faces can interpolate it. */
  private cornerSample(f: number, q: number): void {
    const face = FACES[f];
    const uOff = face.uSign * STRIDE[face.uAxis];
    const vOff = face.vSign * STRIDE[face.vAxis];
    const region = this.region, sky = this.lighting.sky, blk = this.lighting.block;
    for (let k = 0; k < 4; k++) {
      const du = CU[k] ? uOff : -uOff;
      const dv = CV[k] ? vOff : -vOff;
      const s1 = q + du, s2 = q + dv, cc = q + du + dv;
      const o1 = OPAQUE[region[s1]], o2 = OPAQUE[region[s2]];
      const oc = o1 && o2 ? 1 : OPAQUE[region[cc]];
      let ls = sky[q], lb = blk[q], cnt = 1;
      if (!o1) { ls += sky[s1]; lb += blk[s1]; cnt++; }
      if (!o2) { ls += sky[s2]; lb += blk[s2]; cnt++; }
      if (!oc) { ls += sky[cc]; lb += blk[cc]; cnt++; }
      this.pAO[k] = o1 && o2 ? 0 : 3 - (o1 + o2 + oc);
      this.pSky[k] = ls / cnt;
      this.pBlk[k] = lb / cnt;
    }
  }

  /**
   * One rectangle of a partial block's face. (ua, ub) and (va, vb) are the extent along the face's U and V
   * axes in 1/16 block (absolute coordinates), `plane` the position along the normal. Texture coordinates
   * follow the block, so a half-height slab shows the matching half of the texture. Light comes from
   * `cornerSample` (call it first) and is interpolated to each corner.
   */
  private emitRect(geo: GeometryBuilder, f: number, plane: number, ua: number, ub: number, va: number, vb: number, layer: number, x: number, y: number, z: number, mirrorU = false): void {
    const face = FACES[f];
    const coord = this.rectCoord, ao4 = this.rectAO;
    for (let k = 0; k < 4; k++) {
      const cu = CU[k], cv = CV[k];
      const cuv = face.uSign > 0 ? ua + cu * (ub - ua) : ub - cu * (ub - ua);
      const cvv = face.vSign > 0 ? va + cv * (vb - va) : vb - cv * (vb - va);
      coord[face.nAxis] = plane;
      coord[face.uAxis] = cuv;
      coord[face.vAxis] = cvv;
      let tu = face.uSign > 0 ? cuv : 16 - cuv;
      const tv = face.vSign > 0 ? cvv : 16 - cvv;
      // Bilinear weights of the four sampled corners.
      const fu = tu / 16, fv = tv / 16;
      const w0 = (1 - fu) * (1 - fv), w1 = fu * (1 - fv), w2 = fu * fv, w3 = (1 - fu) * fv;
      const ao = Math.round(w0 * this.pAO[0] + w1 * this.pAO[1] + w2 * this.pAO[2] + w3 * this.pAO[3]);
      const sk = Math.round((w0 * this.pSky[0] + w1 * this.pSky[1] + w2 * this.pSky[2] + w3 * this.pSky[3]) * 17);
      const bk = Math.round((w0 * this.pBlk[0] + w1 * this.pBlk[1] + w2 * this.pBlk[2] + w3 * this.pBlk[3]) * 17);
      ao4[k] = ao * 16 + sk / 16;
      if (mirrorU) tu = 16 - tu;
      geo.vertex(x * 16 + coord[0], y * 16 + coord[1], z * 16 + coord[2], tu / 16, tv / 16, layer, f | (ao << 3), sk, bk);
    }
    geo.quad(ao4[0] + ao4[2] < ao4[1] + ao4[3]);
  }

  /** Slab or stairs: every visible octant face, merged into 16×16, 16×8 or 8×8 rectangles. */
  private emitOctants(id: number, x: number, y: number, z: number, i: number): void {
    const mask = this.octantsAt(i);
    const geo = this.opaque;
    geo.currentTint = 0xffffff;
    const hc = this.octCoord;
    for (let f = 0; f < 6; f++) {
      const face = FACES[f];
      const a = face.nAxis, s = face.nSign;
      const nOff = s * STRIDE[a];
      const slot = VARIANT_SLOT[id];
      const layer = slot ? VARIANT_LAYER[(slot * 32 + ((this.metaRegion[i] >> VARIANT_SHIFT[id]) & 31)) * 6 + f] : FACE_LAYER[id * 6 + f];
      let nmask = -1;
      for (let h = 0; h < 2; h++) {
        // Octants of layer h along the normal whose face is not hidden by a neighbouring octant.
        let vis = 0;
        for (let b = 0; b < 4; b++) {
          const hu = b & 1, hv = b >> 1;
          hc[a] = h; hc[face.uAxis] = hu; hc[face.vAxis] = hv;
          if (!(mask & (1 << (hc[0] | (hc[2] << 1) | (hc[1] << 2))))) continue;
          const nh = h + s;
          let covered: boolean;
          if (nh >= 0 && nh <= 1) {
            hc[a] = nh;
            covered = (mask & (1 << (hc[0] | (hc[2] << 1) | (hc[1] << 2)))) !== 0;
          } else {
            if (nmask < 0) nmask = this.octantsAt(i + nOff);
            hc[a] = s > 0 ? 0 : 1;
            covered = (nmask & (1 << (hc[0] | (hc[2] << 1) | (hc[1] << 2)))) !== 0;
          }
          if (!covered) vis |= 1 << b;
        }
        if (!vis) continue;
        const plane = (h + (s > 0 ? 1 : 0)) * 8;
        // Faces on the block boundary are lit from the neighbouring cell, inner ones from this cell.
        this.cornerSample(f, plane === 0 || plane === 16 ? i + nOff : i);
        if (vis === 15) {
          this.emitRect(geo, f, plane, 0, 16, 0, 16, layer, x, y, z);
          continue;
        }
        for (let hv = 0; hv < 2; hv++) {
          const row = (vis >> (hv * 2)) & 3;
          if (row === 3) this.emitRect(geo, f, plane, 0, 16, hv * 8, hv * 8 + 8, layer, x, y, z);
          else if (row === 1) this.emitRect(geo, f, plane, 0, 8, hv * 8, hv * 8 + 8, layer, x, y, z);
          else if (row === 2) this.emitRect(geo, f, plane, 8, 16, hv * 8, hv * 8 + 8, layer, x, y, z);
        }
      }
    }
  }

  /** A door half: one thin box, textured with the lower or upper half of the door texture. */
  private emitDoor(id: number, x: number, y: number, z: number, i: number): void {
    const meta = this.metaRegion[i];
    const box = this.doorScratch;
    doorBox(meta, box);
    // The lower half uses the "side" texture slot and the upper half the "top" slot (see the door's BlockDef).
    const face = (meta & DOOR_UPPER_BIT) ? 2 : 0;
    const slot = VARIANT_SLOT[id];
    const layer = slot ? VARIANT_LAYER[(slot * 32 + ((meta >> VARIANT_SHIFT[id]) & 31)) * 6 + face] : FACE_LAYER[id * 6 + face];
    const geo = this.cutout;
    geo.currentTint = 0xffffff;
    const region = this.region;
    for (let f = 0; f < 6; f++) {
      const face = FACES[f];
      const a = face.nAxis;
      const plane = Math.round((face.nSign > 0 ? box[3 + a] : box[a]) * 16);
      const boundary = plane === 0 || plane === 16;
      const nOff = face.nSign * STRIDE[a];
      if (boundary && OPAQUE[region[i + nOff]]) continue;
      this.cornerSample(f, boundary ? i + nOff : i);
      const ua = Math.round(box[face.uAxis] * 16), ub = Math.round(box[3 + face.uAxis] * 16);
      const va = Math.round(box[face.vAxis] * 16), vb = Math.round(box[3 + face.vAxis] * 16);
      // The two big faces mirror with the hinge so the handle is always on the side away from it.
      this.emitRect(geo, f, plane, ua, ub, va, vb, layer, x, y, z, a !== 1 && (meta & 8) !== 0 && ub - ua > 8);
    }
  }

  private readonly boxScratch = new Float64Array(64);
  /** Region index of the dust being meshed; the getters read its neighbours by offset (no allocation per block). */
  private dustCenter = 0;
  private readonly dustGet = (dx: number, dy: number, dz: number): number => this.region[this.dustCenter + dx * SX + dy * SY + dz * SZ];
  private readonly dustMeta = (dx: number, dy: number, dz: number): number => this.metaRegion[this.dustCenter + dx * SX + dy * SY + dz * SZ];

  /**
   * Carpets, trapdoors, gates, fences, walls, panes, ladders and beds: a few boxes (BoxShapes), each face textured with
   * the part of the texture it covers. Fences, walls and panes join the neighbours they connect to.
   */
  private emitBoxShape(id: number, x: number, y: number, z: number, i: number): void {
    const kind = BOX_KIND[id];
    const meta = this.metaRegion[i];
    const region = this.region;
    let connect = 0;
    if (kind === BOX_DUST) {
      this.dustCenter = i;
      connect = dustConnectMask(this.dustGet, this.dustMeta, 0, 0, 0);
    } else {
      for (let s = 0; s < 4; s++) {
        const j = i + (s === 0 ? -SZ : s === 1 ? SZ : s === 2 ? -SX : SX);
        if (connectsTo(kind, region[j], this.metaRegion[j], s)) connect |= SIDE_BIT[s];
      }
    }
    const boxes = this.boxScratch;
    const n = visualBoxes(kind, meta, connect, boxes);
    const geo = this.cutout;
    geo.currentTint = DYE[id] ? DYE_RGB[meta & 15] : kind === BOX_DUST ? DUST_COLORS[meta & 15] : 0xffffff;
    const redstone = kind >= BOX_DUST;
    const slot = VARIANT_SLOT[id];
    const variant = slot ? slot * 32 + ((meta >> VARIANT_SHIFT[id]) & 31) : 0;
    for (let k = 0; k < n; k++) {
      const o = k * 6;
      for (let f = 0; f < 6; f++) {
        const face = FACES[f];
        const a = face.nAxis;
        const plane = Math.round((face.nSign > 0 ? boxes[o + 3 + a] : boxes[o + a]) * 16);
        const boundary = plane === 0 || plane === 16;
        const nOff = face.nSign * STRIDE[a];
        if (boundary && OPAQUE[region[i + nOff]]) continue;
        // The head half of a bed shows the pillow on top (its texture is in the bottom slot).
        const layerFace = redstone ? redstoneFaceSlot(kind, meta, k, f) : kind === BOX_BED && f === 2 && (meta & BED_HEAD_BIT) ? 3 : f;
        const layer = variant ? VARIANT_LAYER[variant * 6 + f] : FACE_LAYER[id * 6 + layerFace];
        this.cornerSample(f, boundary ? i + nOff : i);
        const ua = Math.round(boxes[o + face.uAxis] * 16), ub = Math.round(boxes[o + 3 + face.uAxis] * 16);
        const va = Math.round(boxes[o + face.vAxis] * 16), vb = Math.round(boxes[o + 3 + face.vAxis] * 16);
        this.emitRect(geo, f, plane, ua, ub, va, vb, layer, x, y, z);
      }
    }
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
          const shape = SHAPE[id];
          if (shape === SHAPE_LIQUID) {
            this.emitLiquid(id, x, y, z, i);
            continue;
          }
          if (shape >= SHAPE_SLAB) {
            if (shape === SHAPE_DOOR) this.emitDoor(id, x, y, z, i);
            else if (shape === SHAPE_BOX) this.emitBoxShape(id, x, y, z, i);
            else this.emitOctants(id, x, y, z, i);
            continue;
          }
          if (shape === SHAPE_MODEL) {
            this.emitModel(id, x, y, z, i);
            continue;
          }
          if (SHAPE[id] !== SHAPE_CROSS) continue;
          const slot = VARIANT_SLOT[id];
          const layer = slot ? VARIANT_LAYER[(slot * 32 + ((this.metaRegion[i] >> VARIANT_SHIFT[id]) & 31)) * 6] : FACE_LAYER[id * 6];
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
