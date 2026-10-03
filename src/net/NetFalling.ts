import { FallingBlock } from '../world/BlockUpdates';
import type { FallEntry } from './protocol';

/** Falling blocks are drawn this far in the past so two 10 Hz snapshots always bracket the frame. */
const DELAY = 0.15;

interface Track { f: FallingBlock; t0: number; y0: number; t1: number; y1: number; x: number; z: number }

/**
 * Mirrors the server's falling sand and gravel (multiplayer). Each `fall` message lists every falling block near the
 * player; the positions are interpolated per frame. Nothing is simulated here: the block changes (the sand leaving
 * its cell, landing) arrive as ordinary block messages.
 */
export class NetFalling {
  readonly list: FallingBlock[] = [];
  private readonly tracks = new Map<number, Track>();

  apply(entries: FallEntry[], now: number): void {
    const seen = new Set<number>();
    for (const [id, block, meta, x, y, z] of entries) {
      seen.add(id);
      let tr = this.tracks.get(id);
      if (!tr) {
        const f = new FallingBlock(id, block, meta, x, y, z);
        tr = { f, t0: now, y0: y, t1: now, y1: y, x, z };
        this.tracks.set(id, tr);
        this.list.push(f);
        continue;
      }
      tr.t0 = tr.t1; tr.y0 = tr.y1;
      tr.t1 = now; tr.y1 = y;
      tr.x = x; tr.z = z;
    }
    for (const [id, tr] of this.tracks) {
      if (seen.has(id)) continue;
      tr.f.removed = true;
      this.tracks.delete(id);
    }
    let n = 0;
    for (const f of this.list) if (!f.removed) this.list[n++] = f;
    this.list.length = n;
  }

  /** Once per frame: place every mirrored block at its interpolated position (prev = current, alpha is not used). */
  update(now: number): void {
    const time = now - DELAY;
    for (const tr of this.tracks.values()) {
      const span = tr.t1 - tr.t0;
      const a = span > 0 ? Math.min(1, Math.max(0, (time - tr.t0) / span)) : 1;
      const f = tr.f;
      f.x = f.prevX = tr.x;
      f.z = f.prevZ = tr.z;
      f.y = f.prevY = tr.y0 + (tr.y1 - tr.y0) * a;
    }
  }

  clear(): void {
    for (const tr of this.tracks.values()) tr.f.removed = true;
    this.tracks.clear();
    this.list.length = 0;
  }
}
