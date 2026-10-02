import { BLOCK } from '../../world/BlockRegistry';

/** Y of the arena floor, the same for every map. */
export const ARENA_FLOOR_Y = 64;
/** Quadrant storage size: maps may be smaller than 2 × 48, never larger. */
export const QUADRANT = 48;
/** Tallest cover/roof in blocks above the floor (the wall has its own height). */
export const MAX_COVER = 10;
/** Placeholder block resolved to red wool on the left half (x < 0) and blue wool on the right half. */
export const TEAM = 250;

export interface Spawn { x: number; y: number; z: number; yaw: number }

/** A capture zone (hardpoint hill / domination point) in world coordinates (the arena is centred on 0, 0). */
export interface ZoneDef { name: string; x: number; z: number; r: number }
/** A team's flag base in world coordinates: red on the left (x < 0), blue on the right. */
export interface FlagDef { team: 'red' | 'blue'; x: number; z: number }
/** Objective data of a map; a map without `zones` cannot host hardpoint/domination, without `flags` no capture the flag. */
export interface ObjectiveDef {
  /** Hardpoint plays them in this order; domination uses every zone with `domination` set (default: all). */
  zones?: ZoneDef[];
  /** Indices into `zones` that are domination points (default: all zones). */
  dominationZones?: number[];
  flags?: FlagDef[];
}
/** A zone with its standing level resolved (y = where a player's feet are). */
export interface Zone extends ZoneDef { y: number }
export interface Flag extends FlagDef { y: number }

/** Draws one quadrant: (u, v) = distance from the two centre lines (0 = next to the line). */
export interface LayoutBuilder {
  /** Inclusive box, heights h0..h1 above the floor (1 = first block). Later calls overwrite earlier ones. */
  box(u0: number, u1: number, v0: number, v1: number, h0: number, h1: number, id: number): void;
  /** Floor blocks (the layer at floor level). */
  paint(u0: number, u1: number, v0: number, v1: number, id: number): void;
}

/**
 * One arena map, described for a single quadrant and mirrored over both axes: red on the left
 * (x < 0), blue on the right, so a map is symmetric by construction.
 */
export interface ArenaMapDef {
  id: string;
  name: string;
  description: string;
  /** Half size of the arena in blocks; the outermost ring (u = halfX − 1 or v = halfZ − 1) is the wall. */
  halfX: number;
  halfZ: number;
  wallHeight: number;
  wallBlock: number;
  floorBlock: number;
  /** The seed picks one of this many cover layouts. */
  variants: number;
  /** Quadrant coordinates of spawns, mirrored into every quadrant (team spawns: the team's half). */
  teamSpawns: [number, number][];
  ffaSpawns: [number, number][];
  /** Quadrant coordinates of elevated spots (roofs, towers, decks) that must be reachable on foot. */
  highGround?: [number, number][];
  /** Zones and flags for the objective modes. */
  objectives?: ObjectiveDef;
  build(variant: number, b: LayoutBuilder): void;
}

interface Layout {
  cells: Uint8Array;
  floor: Uint8Array;
}

/** Quadrant coordinate of a world coordinate: distance from the centre line (0 = next to it). */
function quad(c: number): number {
  return c < 0 ? -1 - c : c;
}

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

/** A map ready for use: block lookup, bounds and spawns. DOM-free, shared by workers, server and client. */
export class ArenaMap {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly wallHeight: number;
  readonly variants: number;
  /** x in [minX, maxX), z in [minZ, maxZ). */
  readonly bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  readonly spawns: { red: Spawn[]; blue: Spawn[]; ffa: Spawn[] };
  /** World positions (x, z) of the elevated spots, all four mirrors. */
  readonly highGround: { x: number; z: number }[];
  private readonly layouts: Layout[] = [];
  private zoneCache: Zone[] | null = null;
  private flagCache: Flag[] | null = null;

  constructor(private readonly def: ArenaMapDef) {
    this.id = def.id;
    this.name = def.name;
    this.description = def.description;
    this.wallHeight = def.wallHeight;
    this.variants = def.variants;
    this.bounds = { minX: -def.halfX, maxX: def.halfX, minZ: -def.halfZ, maxZ: def.halfZ };
    this.highGround = (def.highGround ?? []).flatMap(([u, v]) => [
      { x: toWorld(u, -1), z: toWorld(v, -1) }, { x: toWorld(u, 1), z: toWorld(v, -1) },
      { x: toWorld(u, -1), z: toWorld(v, 1) }, { x: toWorld(u, 1), z: toWorld(v, 1) },
    ]);
    this.spawns = {
      red: def.teamSpawns.flatMap(([u, v]) => [spawnAt(u, v, -1, 1), spawnAt(u, v, -1, -1)]),
      blue: def.teamSpawns.flatMap(([u, v]) => [spawnAt(u, v, 1, 1), spawnAt(u, v, 1, -1)]),
      ffa: def.ffaSpawns.flatMap(([u, v]) => [
        spawnAt(u, v, -1, -1), spawnAt(u, v, 1, -1), spawnAt(u, v, -1, 1), spawnAt(u, v, 1, 1),
      ]),
    };
  }

  /** Capture zones with their standing level (the same in every variant: objectives stay off the variable cover). */
  get zones(): Zone[] {
    return this.zoneCache ??= (this.def.objectives?.zones ?? []).map((z) => ({ ...z, y: this.heightAt(0, z.x, z.z) + 1 }));
  }

  /** Indices of the domination points among `zones`. */
  get dominationZones(): number[] {
    return this.def.objectives?.dominationZones ?? this.zones.map((_, i) => i);
  }

  get flags(): Flag[] {
    return this.flagCache ??= (this.def.objectives?.flags ?? []).map((f) => ({ ...f, y: this.heightAt(0, f.x, f.z) + 1 }));
  }

  /** Whether the map has the data a game type asks for. */
  supports(requires: readonly ('zones' | 'flags')[] | undefined): boolean {
    return (requires ?? []).every((r) => (r === 'zones' ? this.zones.length >= 3 : this.flags.length === 2));
  }

  variantFor(seed: number): number {
    return (seed >>> 0) % this.variants;
  }

  /** Whether a position lies inside the walkable part (the wall ring is out). */
  inBounds(x: number, z: number): boolean {
    const b = this.bounds;
    return x > b.minX + 1 && x < b.maxX - 1 && z > b.minZ + 1 && z < b.maxZ - 1;
  }

  private layout(variant: number): Layout {
    let l = this.layouts[variant];
    if (l) return l;
    const cells = new Uint8Array(QUADRANT * QUADRANT * MAX_COVER);
    const floor = new Uint8Array(QUADRANT * QUADRANT).fill(this.def.floorBlock);
    const clampU = (n: number) => Math.max(0, Math.min(QUADRANT - 1, n));
    l = { cells, floor };
    this.def.build(variant, {
      box: (u0, u1, v0, v1, h0, h1, id) => {
        for (let u = clampU(u0); u <= clampU(u1); u++) {
          for (let v = clampU(v0); v <= clampU(v1); v++) {
            for (let h = Math.max(1, h0); h <= Math.min(MAX_COVER, h1); h++) cells[(u * QUADRANT + v) * MAX_COVER + h - 1] = id;
          }
        }
      },
      paint: (u0, u1, v0, v1, id) => {
        for (let u = clampU(u0); u <= clampU(u1); u++) for (let v = clampU(v0); v <= clampU(v1); v++) floor[u * QUADRANT + v] = id;
      },
    });
    this.layouts[variant] = l;
    return l;
  }

  /** Block at a world position; air outside the arena. */
  blockAt(variant: number, x: number, y: number, z: number): number {
    const b = this.bounds;
    if (x < b.minX || x >= b.maxX || z < b.minZ || z >= b.maxZ) return BLOCK.AIR;
    if (y <= 0) return BLOCK.BEDROCK;
    if (y < ARENA_FLOOR_Y) return BLOCK.STONE;
    const u = quad(x), v = quad(z);
    const team = x < 0 ? BLOCK.RED_WOOL : BLOCK.BLUE_WOOL;
    const lay = this.layout(variant);
    if (y === ARENA_FLOOR_Y) {
      const f = lay.floor[u * QUADRANT + v];
      return f === TEAM ? team : f;
    }
    const h = y - ARENA_FLOOR_Y;
    if (u === this.def.halfX - 1 || v === this.def.halfZ - 1) return h <= this.def.wallHeight ? this.def.wallBlock : BLOCK.AIR;
    if (h > MAX_COVER) return BLOCK.AIR;
    const id = lay.cells[(u * QUADRANT + v) * MAX_COVER + h - 1];
    return id === TEAM ? team : id;
  }

  /** Top solid block of a column (the y of the surface block). */
  heightAt(variant: number, x: number, z: number): number {
    const bx = Math.floor(x), bz = Math.floor(z);
    for (let y = ARENA_FLOOR_Y + this.wallHeight; y >= 0; y--) {
      if (this.blockAt(variant, bx, y, bz) !== BLOCK.AIR) return y;
    }
    return 0;
  }
}
