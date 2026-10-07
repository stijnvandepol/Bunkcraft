import { BLOCK } from '../../world/BlockRegistry';

/** Y of the arena floor, the same for every map. */
export const ARENA_FLOOR_Y = 64;
/** Quadrant storage size: maps may be smaller than 2 × 48, never larger. */
export const QUADRANT = 48;
/** Tallest cover/roof in blocks above the floor (the wall has its own height). */
export const MAX_COVER = 10;
/** Placeholder block resolved to red wool on the left half (x < 0) and blue wool on the right half. */
export const TEAM = 254;

export interface Spawn { x: number; y: number; z: number; yaw: number }

/** A capture zone (hardpoint hill / domination point) in world coordinates (the arena is centred on 0, 0). */
export interface ZoneDef {
  name: string; x: number; z: number; r: number;
  /** Standing level in blocks above the floor when it is not the surface of the column (inside a building: 0 = the floor). */
  level?: number;
}
/** A team's flag base in world coordinates: red on the left (x < 0), blue on the right. */
export interface FlagDef { team: 'red' | 'blue'; x: number; z: number; level?: number }
/**
 * A bomb site (search and destroy) in world coordinates. Both sites lie in the defenders' half (x > 0, the
 * blue spawns): the attackers always start from the red spawns (x < 0), whatever their colour.
 */
export interface SiteDef {
  name: string; x: number; z: number; r: number;
  /** Standing level in blocks above the floor (default 0: the floor, even under a roof). */
  level?: number;
}
/** Map data a game type can need (see `ArenaMap.supports`). */
export type MapRequirement = 'zones' | 'flags' | 'sites';

/** Objective data of a map; a map without `zones` cannot host hardpoint/domination, without `flags` no capture the flag. */
export interface ObjectiveDef {
  /** Hardpoint plays them in this order; domination uses every zone with `domination` set (default: all). */
  zones?: ZoneDef[];
  /** Indices into `zones` that are domination points (default: all zones). */
  dominationZones?: number[];
  flags?: FlagDef[];
  /** Bomb sites A and B (search and destroy); a map without exactly two cannot host it. */
  sites?: SiteDef[];
}
/** A zone with its standing level resolved (y = where a player's feet are). */
export interface Zone extends ZoneDef { y: number }
export interface Flag extends FlagDef { y: number }
export interface Site extends SiteDef { y: number }

/** Draws one quadrant: (u, v) = distance from the two centre lines (0 = next to the line). */
export interface LayoutBuilder {
  /** Inclusive box, heights h0..h1 above the floor (1 = first block). Later calls overwrite earlier ones. */
  box(u0: number, u1: number, v0: number, v1: number, h0: number, h1: number, id: number): void;
  /** Floor blocks (the layer at floor level). */
  paint(u0: number, u1: number, v0: number, v1: number, id: number): void;
}

/**
 * One mirrored arena map, described for a single quadrant and mirrored over both axes: red on the left
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

/**
 * A map drawn over the whole arena in world block coordinates, with no mirroring, so the two
 * halves can differ (Nuketown-style: two different houses). The builder takes (x0, x1, z0, z1)
 * instead of (u0, u1, v0, v1); ranges may be given in either order. Fairness is up to the map
 * (point symmetry of the layout is the usual trick) and is checked by tests instead.
 */
export interface FreeArenaMapDef {
  layout: 'free';
  id: string;
  name: string;
  description: string;
  /** x in [-halfX, halfX), z in [-halfZ, halfZ); the outermost ring is the wall. */
  halfX: number;
  halfZ: number;
  wallHeight: number;
  wallBlock: number;
  floorBlock: number;
  variants: number;
  /** World block coordinates (x, z). Red spawns lie at x < 0, blue at x >= 0. */
  redSpawns: [number, number][];
  blueSpawns: [number, number][];
  ffaSpawns: [number, number][];
  highGround?: [number, number][];
  /** Zones and flags for the objective modes (world coordinates, like on mirrored maps). */
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
  return facingCentre(toWorld(u, sx), toWorld(v, sz));
}

function facingCentre(x: number, z: number): Spawn {
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
  /** Whether the map is mirrored over both centre lines (false for free-form maps). */
  readonly mirrored: boolean;
  private readonly layouts: Layout[] = [];
  private zoneCache: Zone[] | null = null;
  private flagCache: Flag[] | null = null;
  private siteCache: Site[] | null = null;
  private readonly quadrant: ArenaMapDef | null;
  private readonly free: FreeArenaMapDef | null;
  /** Objective data (zones, flags) of either kind of map. */
  private readonly objectives: ObjectiveDef | undefined;

  constructor(def: ArenaMapDef | FreeArenaMapDef) {
    this.id = def.id;
    this.name = def.name;
    this.description = def.description;
    this.wallHeight = def.wallHeight;
    this.variants = def.variants;
    this.bounds = { minX: -def.halfX, maxX: def.halfX, minZ: -def.halfZ, maxZ: def.halfZ };
    this.objectives = def.objectives;
    if ('layout' in def) {
      this.mirrored = false;
      this.free = def;
      this.quadrant = null;
      const at = ([x, z]: [number, number]) => facingCentre(x + 0.5, z + 0.5);
      this.highGround = (def.highGround ?? []).map(([x, z]) => ({ x: x + 0.5, z: z + 0.5 }));
      this.spawns = { red: def.redSpawns.map(at), blue: def.blueSpawns.map(at), ffa: def.ffaSpawns.map(at) };
      return;
    }
    this.mirrored = true;
    this.free = null;
    this.quadrant = def;
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
    return this.zoneCache ??= (this.objectives?.zones ?? []).map((z) => ({ ...z, y: z.level !== undefined ? ARENA_FLOOR_Y + 1 + z.level : this.heightAt(0, z.x, z.z) + 1 }));
  }

  /** Indices of the domination points among `zones`. */
  get dominationZones(): number[] {
    return this.objectives?.dominationZones ?? this.zones.map((_, i) => i);
  }

  get flags(): Flag[] {
    return this.flagCache ??= (this.objectives?.flags ?? []).map((f) => ({ ...f, y: f.level !== undefined ? ARENA_FLOOR_Y + 1 + f.level : this.heightAt(0, f.x, f.z) + 1 }));
  }

  /** Bomb sites with their standing level (search and destroy). */
  get sites(): Site[] {
    // Sites may sit under a roof (a warehouse, a hall): the level is the floor unless the map says otherwise.
    return this.siteCache ??= (this.objectives?.sites ?? []).map((s) => ({ ...s, y: ARENA_FLOOR_Y + 1 + (s.level ?? 0) }));
  }

  /** Whether the map has the data a game type asks for. */
  supports(requires: readonly MapRequirement[] | undefined): boolean {
    return (requires ?? []).every((r) => (r === 'zones' ? this.zones.length >= 3 : r === 'flags' ? this.flags.length === 2 : this.sites.length === 2));
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
    if (this.free) return (this.layouts[variant] = this.freeLayout(this.free, variant));
    const cells = new Uint8Array(QUADRANT * QUADRANT * MAX_COVER);
    const floor = new Uint8Array(QUADRANT * QUADRANT).fill(this.quadrant!.floorBlock);
    const clampU = (n: number) => Math.max(0, Math.min(QUADRANT - 1, n));
    l = { cells, floor };
    this.quadrant!.build(variant, {
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

  /** Full-arena storage for a free-form map: column index (x − minX) · depth + (z − minZ). */
  private freeLayout(def: FreeArenaMapDef, variant: number): Layout {
    const w = def.halfX * 2, d = def.halfZ * 2;
    const cells = new Uint8Array(w * d * MAX_COVER);
    const floor = new Uint8Array(w * d).fill(def.floorBlock);
    const cx = (n: number) => Math.max(0, Math.min(w - 1, n + def.halfX));
    const cz = (n: number) => Math.max(0, Math.min(d - 1, n + def.halfZ));
    def.build(variant, {
      box: (x0, x1, z0, z1, h0, h1, id) => {
        for (let x = cx(Math.min(x0, x1)); x <= cx(Math.max(x0, x1)); x++) {
          for (let z = cz(Math.min(z0, z1)); z <= cz(Math.max(z0, z1)); z++) {
            for (let h = Math.max(1, h0); h <= Math.min(MAX_COVER, h1); h++) cells[(x * d + z) * MAX_COVER + h - 1] = id;
          }
        }
      },
      paint: (x0, x1, z0, z1, id) => {
        for (let x = cx(Math.min(x0, x1)); x <= cx(Math.max(x0, x1)); x++) {
          for (let z = cz(Math.min(z0, z1)); z <= cz(Math.max(z0, z1)); z++) floor[x * d + z] = id;
        }
      },
    });
    return { cells, floor };
  }

  /** Block at a world position; air outside the arena. */
  blockAt(variant: number, x: number, y: number, z: number): number {
    const b = this.bounds;
    if (x < b.minX || x >= b.maxX || z < b.minZ || z >= b.maxZ) return BLOCK.AIR;
    if (y <= 0) return BLOCK.BEDROCK;
    if (y < ARENA_FLOOR_Y) return BLOCK.STONE;
    if (this.free) return this.freeBlockAt(variant, x, y, z);
    const u = quad(x), v = quad(z);
    const team = x < 0 ? BLOCK.RED_WOOL : BLOCK.BLUE_WOOL;
    const lay = this.layout(variant);
    if (y === ARENA_FLOOR_Y) {
      const f = lay.floor[u * QUADRANT + v];
      return f === TEAM ? team : f;
    }
    const h = y - ARENA_FLOOR_Y;
    const def = this.quadrant!;
    if (u === def.halfX - 1 || v === def.halfZ - 1) return h <= def.wallHeight ? def.wallBlock : BLOCK.AIR;
    if (h > MAX_COVER) return BLOCK.AIR;
    const id = lay.cells[(u * QUADRANT + v) * MAX_COVER + h - 1];
    return id === TEAM ? team : id;
  }

  private freeBlockAt(variant: number, x: number, y: number, z: number): number {
    const b = this.bounds, def = this.free!;
    const team = x < 0 ? BLOCK.RED_WOOL : BLOCK.BLUE_WOOL;
    const lay = this.layout(variant);
    const col = (x - b.minX) * (def.halfZ * 2) + (z - b.minZ);
    if (y === ARENA_FLOOR_Y) {
      const f = lay.floor[col];
      return f === TEAM ? team : f;
    }
    const h = y - ARENA_FLOOR_Y;
    if (x === b.minX || x === b.maxX - 1 || z === b.minZ || z === b.maxZ - 1) return h <= def.wallHeight ? def.wallBlock : BLOCK.AIR;
    if (h > MAX_COVER) return BLOCK.AIR;
    const id = lay.cells[col * MAX_COVER + h - 1];
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
