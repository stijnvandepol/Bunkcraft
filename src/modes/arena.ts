import { BLOCK } from '../world/BlockRegistry';
import { BIOME } from '../world/Biomes';
import { CHUNK_HEIGHT, CHUNK_SIZE, blockIndex } from '../world/constants';

/**
 * The fixed arena for the arcade game types: 96×96 blocks, mirror-symmetric in both axes
 * (red base on the left, blue on the right), with a raised centre platform, cover, corridors and
 * a 12 high wall around it. DOM-free: chunk workers, the server (hitscan) and the client share it.
 *
 * The whole map is described for ONE quadrant in (u, v) = distance from the two centre lines and
 * then mirrored, so symmetry holds by construction. Colour-bound blocks (TEAM) become red wool
 * on the left half (x < 0) and blue wool on the right half.
 */
export const ARENA_FLOOR_Y = 64;
export const ARENA_WALL_HEIGHT = 12;
/** Blocks x -48..47 and z -48..47; the outermost ring is the wall. */
export const ARENA_BOUNDS = { minX: -48, maxX: 48, minZ: -48, maxZ: 48 };
export const ARENA_VARIANTS = 3;

export interface Spawn { x: number; y: number; z: number; yaw: number }

/** Mirrors a quadrant coordinate (u, v) into the world: sign -1 = x/z < 0. */
function toWorld(u: number, sign: number): number {
  return sign < 0 ? -u - 0.5 : u + 0.5;
}

function spawnAt(u: number, v: number, sx: number, sz: number): Spawn {
  const x = toWorld(u, sx), z = toWorld(v, sz);
  // Three.js camera: yaw 0 looks along -Z, so facing the centre from (x, z) is atan2(x, z).
  const yaw = Math.round(Math.atan2(x, z) * 1000) / 1000;
  return { x, y: ARENA_FLOOR_Y + 1, z, yaw };
}

// Quadrant coordinates, mirrored over all four quadrants.
const TEAM_SPAWNS: [number, number][] = [[36, 2], [40, 1], [36, 9], [41, 6]];
const FFA_SPAWNS: [number, number][] = [[28, 10], [30, 28], [12, 40]];

export const ARENA_SPAWNS: { red: Spawn[]; blue: Spawn[]; ffa: Spawn[] } = {
  red: TEAM_SPAWNS.flatMap(([u, v]) => [spawnAt(u, v, -1, 1), spawnAt(u, v, -1, -1)]),
  blue: TEAM_SPAWNS.flatMap(([u, v]) => [spawnAt(u, v, 1, 1), spawnAt(u, v, 1, -1)]),
  ffa: FFA_SPAWNS.flatMap(([u, v]) => [
    spawnAt(u, v, -1, -1), spawnAt(u, v, 1, -1), spawnAt(u, v, -1, 1), spawnAt(u, v, 1, 1),
  ]),
};

export function arenaVariant(seed: number): number {
  return (seed >>> 0) % ARENA_VARIANTS;
}

// ---------------------------------------------------------------- quadrant layout

const N = 48; // quadrant size; u = 47 and v = 47 are the wall
const GH = 8; // tallest cover above the floor
const TEAM = 250; // placeholder resolved to red/blue wool

interface Layout {
  /** Block above the floor per (u, v, height−1), 0 = air. */
  cells: Uint8Array;
  floor: Uint8Array;
}

function buildLayout(variant: number): Layout {
  const cells = new Uint8Array(N * N * GH);
  const floor = new Uint8Array(N * N).fill(BLOCK.STONE);
  /** Inclusive box in quadrant coordinates, heights h0..h1 above the floor (1 = first block). */
  const box = (u0: number, u1: number, v0: number, v1: number, h0: number, h1: number, id: number) => {
    for (let u = u0; u <= u1; u++) {
      for (let v = v0; v <= v1; v++) for (let h = h0; h <= h1; h++) cells[(u * N + v) * GH + h - 1] = id;
    }
  };
  const paint = (u0: number, u1: number, v0: number, v1: number, id: number) => {
    for (let u = u0; u <= u1; u++) for (let v = v0; v <= v1; v++) floor[u * N + v] = id;
  };

  // Floor markings: white centre lines and the team bases.
  paint(0, 0, 7, 46, BLOCK.WHITE_WOOL);
  paint(7, 46, 0, 0, BLOCK.WHITE_WOOL);
  paint(33, 46, 0, 16, TEAM);

  // Centre platform (3 high, planks on top) with steps on all four sides and corner cover.
  box(0, 6, 0, 6, 1, 2, BLOCK.STONE_BRICKS);
  box(0, 6, 0, 6, 3, 3, BLOCK.OAK_PLANKS);
  box(7, 7, 0, 3, 1, 2, BLOCK.OAK_PLANKS);
  box(8, 8, 0, 3, 1, 1, BLOCK.OAK_PLANKS);
  box(0, 3, 7, 7, 1, 2, BLOCK.OAK_PLANKS);
  box(0, 3, 8, 8, 1, 1, BLOCK.OAK_PLANKS);
  box(0, 1, 0, 1, 4, 5, BLOCK.STONE_BRICKS);
  box(6, 6, 4, 6, 4, 5, BLOCK.STONE_BRICKS);
  box(4, 5, 6, 6, 4, 5, BLOCK.STONE_BRICKS);

  // Team base: a front wall with a gap towards the centre, pillars and a raised sniper nest.
  box(33, 33, 8, 16, 1, 4, BLOCK.STONE_BRICKS);
  box(38, 39, 4, 5, 1, 4, TEAM);
  box(42, 42, 8, 14, 1, 1, BLOCK.OAK_PLANKS);
  box(43, 46, 8, 14, 1, 2, BLOCK.OAK_PLANKS);
  box(43, 46, 15, 15, 3, 3, BLOCK.STONE_BRICKS);

  // Two corridors (4 wide) with windows, one per quadrant edge.
  box(14, 30, 19, 19, 1, 4, BLOCK.STONE_BRICKS);
  box(14, 30, 24, 24, 1, 4, BLOCK.STONE_BRICKS);
  box(20, 23, 19, 19, 3, 4, BLOCK.GLASS);
  box(20, 23, 24, 24, 3, 4, BLOCK.GLASS);

  // Raised side perch with steps and a rail.
  box(20, 27, 36, 44, 1, 2, BLOCK.OAK_PLANKS);
  box(19, 19, 38, 42, 1, 1, BLOCK.OAK_PLANKS);
  box(22, 25, 35, 35, 1, 1, BLOCK.OAK_PLANKS);
  box(20, 27, 44, 44, 3, 3, BLOCK.STONE_BRICKS);

  // Cover that differs per variant.
  const crate = (u: number, v: number, w: number, d: number, h: number, id: number) =>
    box(u, u + w - 1, v, v + d - 1, 1, h, id);
  if (variant === 0) {
    crate(10, 14, 2, 2, 2, BLOCK.OAK_PLANKS);
    crate(22, 8, 2, 2, 2, BLOCK.OAK_PLANKS);
    crate(26, 28, 2, 2, 2, BLOCK.OAK_PLANKS);
    crate(34, 24, 2, 2, 2, BLOCK.OAK_PLANKS);
    crate(28, 3, 3, 1, 2, BLOCK.STONE_BRICKS);
    crate(11, 28, 1, 3, 2, BLOCK.STONE_BRICKS);
    crate(14, 8, 1, 1, 1, BLOCK.YELLOW_WOOL);
    crate(32, 36, 2, 1, 1, BLOCK.YELLOW_WOOL);
    crate(8, 20, 1, 1, 1, BLOCK.YELLOW_WOOL);
  } else if (variant === 1) {
    crate(12, 11, 3, 3, 2, BLOCK.OAK_PLANKS);
    crate(24, 12, 2, 2, 3, BLOCK.STONE_BRICKS);
    crate(32, 28, 2, 2, 2, BLOCK.OAK_PLANKS);
    crate(8, 30, 2, 2, 2, BLOCK.OAK_PLANKS);
    crate(30, 3, 1, 3, 2, BLOCK.STONE_BRICKS);
    crate(15, 33, 3, 1, 2, BLOCK.STONE_BRICKS);
    crate(10, 22, 1, 1, 1, BLOCK.YELLOW_WOOL);
    crate(34, 40, 1, 2, 1, BLOCK.YELLOW_WOOL);
    crate(20, 4, 2, 1, 1, BLOCK.YELLOW_WOOL);
  } else {
    crate(11, 10, 2, 2, 2, BLOCK.OAK_PLANKS);
    crate(26, 9, 4, 1, 2, BLOCK.STONE_BRICKS);
    crate(35, 22, 2, 3, 2, BLOCK.OAK_PLANKS);
    crate(9, 27, 3, 3, 2, BLOCK.OAK_PLANKS);
    crate(16, 14, 1, 3, 3, BLOCK.STONE_BRICKS);
    crate(31, 34, 2, 2, 2, BLOCK.STONE_BRICKS);
    crate(6, 18, 1, 1, 1, BLOCK.YELLOW_WOOL);
    crate(36, 31, 1, 1, 1, BLOCK.YELLOW_WOOL);
    crate(21, 29, 2, 1, 1, BLOCK.YELLOW_WOOL);
  }
  return { cells, floor };
}

const layouts: Layout[] = [];
function layoutFor(variant: number): Layout {
  return (layouts[variant] ??= buildLayout(variant));
}

/** Quadrant coordinate of a world coordinate: distance from the centre line (0 = next to it). */
function quad(c: number): number {
  return c < 0 ? -1 - c : c;
}

/** Block at a world position for an arena variant; air outside the arena. */
export function arenaBlockAt(variant: number, x: number, y: number, z: number): number {
  if (x < ARENA_BOUNDS.minX || x >= ARENA_BOUNDS.maxX || z < ARENA_BOUNDS.minZ || z >= ARENA_BOUNDS.maxZ) return BLOCK.AIR;
  if (y <= 0) return BLOCK.BEDROCK;
  if (y < ARENA_FLOOR_Y) return BLOCK.STONE;
  const u = quad(x), v = quad(z);
  const team = x < 0 ? BLOCK.RED_WOOL : BLOCK.BLUE_WOOL;
  const lay = layoutFor(variant);
  if (y === ARENA_FLOOR_Y) {
    const f = lay.floor[u * N + v];
    return f === TEAM ? team : f;
  }
  const h = y - ARENA_FLOOR_Y;
  if (u === N - 1 || v === N - 1) return h <= ARENA_WALL_HEIGHT ? BLOCK.STONE_BRICKS : BLOCK.AIR;
  if (h > GH) return BLOCK.AIR;
  const id = lay.cells[(u * N + v) * GH + h - 1];
  return id === TEAM ? team : id;
}

/**
 * Same interface as TerrainGenerator for the parts the world code uses: chunk generation, a
 * cheap 2D height query and a biome (always plains). The seed only picks the cover layout.
 */
export class ArenaGenerator {
  readonly variant: number;

  constructor(readonly seed: number) {
    this.variant = arenaVariant(seed);
  }

  generate(cx: number, cz: number, blocks: Uint8Array, biomesOut?: Uint8Array): void {
    blocks.fill(0);
    if (biomesOut) biomesOut.fill(BIOME.PLAINS);
    const ox = cx * CHUNK_SIZE, oz = cz * CHUNK_SIZE;
    const top = Math.min(CHUNK_HEIGHT - 1, ARENA_FLOOR_Y + ARENA_WALL_HEIGHT);
    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        const wx = ox + x, wz = oz + z;
        if (wx < ARENA_BOUNDS.minX || wx >= ARENA_BOUNDS.maxX || wz < ARENA_BOUNDS.minZ || wz >= ARENA_BOUNDS.maxZ) continue;
        for (let y = 0; y <= top; y++) blocks[blockIndex(x, y, z)] = arenaBlockAt(this.variant, wx, y, wz);
      }
    }
  }

  /** Top solid block of a column (like TerrainGenerator.heightAt, the y of the surface block). */
  heightAt(x: number, z: number): number {
    const bx = Math.floor(x), bz = Math.floor(z);
    for (let y = ARENA_FLOOR_Y + ARENA_WALL_HEIGHT; y >= 0; y--) {
      if (arenaBlockAt(this.variant, bx, y, bz) !== BLOCK.AIR) return y;
    }
    return 0;
  }

  biomeAt(_x: number, _z: number, _h: number): number {
    return BIOME.PLAINS;
  }
}
