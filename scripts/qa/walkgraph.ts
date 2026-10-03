/**
 * QA helper: walk graph of an arena map. A node is a standing spot (solid block below, two blocks of
 * air); moves follow the arcade movement rules: step up one block with a jump, walk or drop down any
 * height, and jump over a one-wide gap to a spot at the same height or one lower.
 */
import { ARENA_FLOOR_Y } from '../../src/modes/maps';
import type { ArenaMap, Spawn } from '../../src/modes/maps/ArenaMap';
import { BLOCK, SOLID } from '../../src/world/BlockRegistry';

export interface Node { x: number; y: number; z: number }

export const TOP = ARENA_FLOOR_Y + 16;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export class WalkGraph {
  readonly nodes: Node[] = [];
  private readonly stand: Uint8Array;
  private readonly W: number;
  private readonly D: number;
  private readonly H: number;

  constructor(readonly map: ArenaMap, readonly variant: number) {
    const b = map.bounds;
    this.W = b.maxX - b.minX; this.D = b.maxZ - b.minZ; this.H = TOP - ARENA_FLOOR_Y + 1;
    this.stand = new Uint8Array(this.W * this.D * this.H);
    for (let x = b.minX; x < b.maxX; x++) for (let z = b.minZ; z < b.maxZ; z++) {
      for (let y = ARENA_FLOOR_Y + 1; y <= TOP - 2; y++) {
        if (this.solid(x, y - 1, z) && !this.solid(x, y, z) && !this.solid(x, y + 1, z)) {
          this.stand[this.key({ x, y, z })] = 1;
          this.nodes.push({ x, y, z });
        }
      }
    }
  }

  get size(): number { return this.W * this.D * this.H; }

  solid(x: number, y: number, z: number): boolean {
    const id = this.map.blockAt(this.variant, x, y, z);
    return id !== BLOCK.AIR && SOLID[id] === 1;
  }

  key(n: Node): number {
    const b = this.map.bounds;
    return ((n.x - b.minX) * this.D + (n.z - b.minZ)) * this.H + (n.y - ARENA_FLOOR_Y);
  }

  fromKey(k: number): Node {
    const b = this.map.bounds;
    const y = k % this.H, r = (k - y) / this.H, z = r % this.D, x = (r - z) / this.D;
    return { x: x + b.minX, y: y + ARENA_FLOOR_Y, z: z + b.minZ };
  }

  isStand(x: number, y: number, z: number): boolean {
    const b = this.map.bounds;
    return x >= b.minX && x < b.maxX && z >= b.minZ && z < b.maxZ && y > ARENA_FLOOR_Y && y <= TOP - 2 && this.stand[this.key({ x, y, z })] === 1;
  }

  private landing(x: number, y: number, z: number): number {
    for (let yy = y; yy > ARENA_FLOOR_Y; yy--) {
      if (this.solid(x, yy, z)) return -1;
      if (this.isStand(x, yy, z)) return yy;
    }
    return -1;
  }

  moves(n: Node, out: Node[]): Node[] {
    out.length = 0;
    const b = this.map.bounds;
    const headroomJump = !this.solid(n.x, n.y + 2, n.z);
    for (const [dx, dz] of DIRS) {
      const x = n.x + dx, z = n.z + dz;
      if (x < b.minX || x >= b.maxX || z < b.minZ || z >= b.maxZ) continue;
      if (headroomJump && this.isStand(x, n.y + 1, z)) out.push({ x, y: n.y + 1, z });
      if (!this.solid(x, n.y, z) && !this.solid(x, n.y + 1, z)) {
        const l = this.landing(x, n.y, z);
        if (l > 0) out.push({ x, y: l, z });
        if (headroomJump && !this.solid(x, n.y + 2, z)) {
          const x2 = n.x + 2 * dx, z2 = n.z + 2 * dz;
          for (const y2 of [n.y, n.y - 1]) if (l !== n.y && this.isStand(x2, y2, z2)) out.push({ x: x2, y: y2, z: z2 });
        }
      }
    }
    return out;
  }

  /** BFS distances (in moves) and parents from a set of start spots. */
  bfs(starts: Node[]): { dist: Int32Array; parent: Int32Array } {
    const dist = new Int32Array(this.size).fill(-1);
    const parent = new Int32Array(this.size).fill(-1);
    const q: number[] = [];
    for (const s of starts) {
      if (!this.isStand(s.x, s.y, s.z)) continue;
      const k = this.key(s);
      if (dist[k] < 0) { dist[k] = 0; q.push(k); }
    }
    const tmp: Node[] = [];
    for (let i = 0; i < q.length; i++) {
      const k = q[i];
      for (const m of this.moves(this.fromKey(k), tmp)) {
        const mk = this.key(m);
        if (dist[mk] < 0) { dist[mk] = dist[k] + 1; parent[mk] = k; q.push(mk); }
      }
    }
    return { dist, parent };
  }

  path(from: Node, to: Node): Node[] | null {
    const { parent, dist } = this.bfs([from]);
    let k = this.key(to);
    if (dist[k] < 0) return null;
    const out: Node[] = [];
    while (k >= 0) { out.push(this.fromKey(k)); k = parent[k]; }
    return out.reverse();
  }
}

export function spawnNode(s: Spawn): Node {
  return { x: Math.floor(s.x), y: Math.round(s.y), z: Math.floor(s.z) };
}
