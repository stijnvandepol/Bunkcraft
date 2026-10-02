import { LIGHT_EMIT, LIGHT_FILTER, OPAQUE } from '../world/BlockRegistry';
import { CHUNK_HEIGHT as WORLD_HEIGHT } from '../world/constants';

/**
 * Mesh-time voxel lighting (runs in workers).
 *
 * Lighting is computed over a 48×48 region (the chunk plus its 8 neighbours). Light
 * falls off by 1 per block from a maximum of 15, so any source that can influence the
 * centre chunk (+1 block border for smooth lighting) lies inside this region. That makes
 * the result exact without a persistent global light map.
 *
 *  - Sky light: 15 straight down until something opaque, then a BFS flood sideways.
 *  - Block light: BFS from emitters (glowstone).
 */
export const REGION = 48;
export const REGION_AREA = REGION * REGION;
/** One padding layer below (bedrock) and above (open air) the world. */
export const REGION_HEIGHT = WORLD_HEIGHT + 2;
export const REGION_VOLUME = REGION_AREA * REGION_HEIGHT;

const QUEUE_SIZE = 1 << 19;
const QUEUE_MASK = QUEUE_SIZE - 1;

export class LightEngine {
  readonly sky = new Uint8Array(REGION_VOLUME);
  readonly block = new Uint8Array(REGION_VOLUME);
  private readonly queue = new Int32Array(QUEUE_SIZE);
  private readonly columnTop = new Int16Array(REGION_AREA);

  compute(blocks: Uint8Array): void {
    const sky = this.sky;
    const blk = this.block;
    sky.fill(0);
    blk.fill(0);
    const top = this.columnTop;

    // 1. Vertical sky light per column.
    for (let c = 0; c < REGION_AREA; c++) {
      let l = 15;
      let highest = -1;
      for (let y = REGION_HEIGHT - 1; y >= 0; y--) {
        const i = c + y * REGION_AREA;
        const b = blocks[i];
        if (b !== 0 && highest < 0) highest = y;
        if (OPAQUE[b]) break;
        l -= LIGHT_FILTER[b];
        if (l <= 0) break;
        sky[i] = l;
      }
      top[c] = highest;
    }

    // 2. Seed BFS only where sideways spreading can matter: below the highest
    //    neighbouring column top. Open air above all neighbours is already final.
    const q = this.queue;
    let head = 0;
    let tail = 0;
    for (let z = 0; z < REGION; z++) {
      for (let x = 0; x < REGION; x++) {
        const c = x + z * REGION;
        let maxTop = top[c];
        if (x > 0 && top[c - 1] > maxTop) maxTop = top[c - 1];
        if (x < REGION - 1 && top[c + 1] > maxTop) maxTop = top[c + 1];
        if (z > 0 && top[c - REGION] > maxTop) maxTop = top[c - REGION];
        if (z < REGION - 1 && top[c + REGION] > maxTop) maxTop = top[c + REGION];
        for (let y = 0; y <= maxTop + 1 && y < REGION_HEIGHT; y++) {
          const i = c + y * REGION_AREA;
          if (sky[i] > 1) {
            q[tail] = i;
            tail = (tail + 1) & QUEUE_MASK;
          }
        }
      }
    }
    this.flood(blocks, sky, head, tail);

    // 3. Block light from emitters.
    head = 0;
    tail = 0;
    for (let i = 0; i < REGION_VOLUME; i++) {
      const e = LIGHT_EMIT[blocks[i]];
      if (e) {
        blk[i] = e;
        q[tail] = i;
        tail = (tail + 1) & QUEUE_MASK;
      }
    }
    if (tail !== head) this.flood(blocks, blk, head, tail);
  }

  private flood(blocks: Uint8Array, light: Uint8Array, head: number, tail: number): void {
    const q = this.queue;
    const maxY = REGION_HEIGHT - 1;
    while (head !== tail) {
      const i = q[head];
      head = (head + 1) & QUEUE_MASK;
      const l = light[i];
      if (l <= 1) continue;
      const x = i % REGION;
      const z = ((i / REGION) | 0) % REGION;
      const y = (i / REGION_AREA) | 0;
      // Unrolled neighbour visits.
      if (x > 0) tail = this.spread(blocks, light, i - 1, l, tail);
      if (x < REGION - 1) tail = this.spread(blocks, light, i + 1, l, tail);
      if (z > 0) tail = this.spread(blocks, light, i - REGION, l, tail);
      if (z < REGION - 1) tail = this.spread(blocks, light, i + REGION, l, tail);
      if (y > 0) tail = this.spread(blocks, light, i - REGION_AREA, l, tail);
      if (y < maxY) tail = this.spread(blocks, light, i + REGION_AREA, l, tail);
    }
  }

  private spread(blocks: Uint8Array, light: Uint8Array, j: number, l: number, tail: number): number {
    const b = blocks[j];
    if (OPAQUE[b]) return tail;
    const nl = l - 1 - LIGHT_FILTER[b];
    if (nl > light[j]) {
      light[j] = nl;
      this.queue[tail] = j;
      return (tail + 1) & QUEUE_MASK;
    }
    return tail;
  }
}
