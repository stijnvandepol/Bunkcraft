import { BLOCK } from '../../world/BlockRegistry';
import { type FreeArenaMapDef, type LayoutBuilder, TEAM } from './ArenaMap';
import { AIR, car, turn, turned } from './helpers';

/**
 * "Skyline Villa": a modern white hillside villa (inspired by the classic villa-with-a-pool map).
 * The villa fills the middle: two storeys of white concrete and floor-to-ceiling glass around an
 * open atrium, a roof terrace over the ground floor and a flat roof on the bedroom wing. A drained
 * pool lies north-west of it, a sunken basketball court south-east; a garage (cars) and a pool
 * house gym sit on the other two corners, a planted hillside berm runs along the long sides.
 *
 * Point symmetric: each half is the other turned 180° around the atrium, so the routes are fair,
 * but the pool and the court, the garage and the gym, and the furniture differ.
 */

interface Side {
  /** The pool (true) or the basketball court (false) on this side. */
  pool: boolean;
  /** The garage with cars (true) or the gym (false). */
  garage: boolean;
  deck: number;
  accent: number;
  sofa: number;
  car: number;
}

const RED_SIDE: Side = { pool: true, garage: true, deck: BLOCK.BIRCH_PLANKS, accent: BLOCK.YELLOW_WOOL, sofa: BLOCK.WHITE_WOOL, car: BLOCK.OBSIDIAN };
const BLUE_SIDE: Side = { pool: false, garage: false, deck: BLOCK.STONE_BRICKS, accent: BLOCK.GREEN_WOOL, sofa: BLOCK.CLAY, car: BLOCK.YELLOW_WOOL };

const WALL = BLOCK.CONCRETE;
const TRIM = BLOCK.SPRUCE_PLANKS;

const RED_SPAWNS: [number, number][] = [[-41, -11], [-38, -7], [-41, -3], [-38, 1], [-41, 5], [-38, 9]];
const FFA_WEST: [number, number][] = [[-40, -9], [-40, 8], [-40, -27], [-24, 24], [-11, -13], [-27, 8]];

/** A palm-ish tree: a birch trunk and a flat leaf crown. */
function palm(box: LayoutBuilder['box'], x: number, z: number, h = 5): void {
  box(x - 1, x + 1, z - 1, z + 1, h, h, BLOCK.OAK_LEAVES);
  box(x - 2, x + 2, z, z, h, h, BLOCK.OAK_LEAVES);
  box(x, x, z - 2, z + 2, h, h, BLOCK.OAK_LEAVES);
  box(x, x, z, z, 1, h, BLOCK.BIRCH_LOG);
}

/** One half of the map in west-half coordinates (x < 0); `s = -1` turns it for the east half. */
function half(b: LayoutBuilder, s: 1 | -1, p: Side): void {
  const t = turned(b, s);
  const { box, paint } = t;

  // --- Spawn yard: a gravel forecourt behind a white wall with a hedge on top -------------------
  paint(-43, -36, -14, 13, BLOCK.GRAVEL);
  paint(-43, -42, -4, 3, TEAM);
  box(-35, -35, -14, 13, 1, 2, WALL);
  box(-35, -35, -14, 13, 3, 3, BLOCK.OAK_LEAVES);
  for (const z of [-14, -6, 5, 13]) box(-35, -35, z, z, 1, 3, TRIM);
  box(-35, -35, -1, -1, 4, 4, BLOCK.GLOWSTONE);
  car(t, -43, 9, false, p.car);
  // Gate posts at both ends of the yard.
  for (const z of [-15, 14]) {
    box(-43, -43, z, z, 1, 2, WALL);
    box(-43, -43, z, z, 3, 3, BLOCK.GLOWSTONE);
  }

  // --- Front lawn between the yard and the villa: a paved path, a fountain, hedge planters ---
  paint(-34, -17, -1, 0, BLOCK.STONE_BRICKS);
  box(-28, -24, -3, 2, 1, 1, BLOCK.STONE_BRICKS);
  box(-27, -25, -2, 1, 1, 1, BLOCK.BLUE_WOOL);
  box(-26, -26, -1, 0, 2, 3, BLOCK.STONE_BRICKS);
  box(-26, -26, -1, 0, 4, 4, BLOCK.GLOWSTONE);
  for (const z of [-10, 8]) {
    box(-32, -29, z, z + 1, 1, 1, BLOCK.STONE_BRICKS);
    box(-32, -29, z, z + 1, 2, 2, BLOCK.OAK_LEAVES);
  }
  box(-21, -20, -7, -6, 1, 2, BLOCK.OAK_LEAVES);
  box(-21, -20, 5, 6, 1, 2, BLOCK.OAK_LEAVES);
  box(-33, -33, -5, -4, 1, 1, BLOCK.WHITE_WOOL);
  box(-33, -33, 3, 4, 1, 1, BLOCK.WHITE_WOOL);

  // --- Pool house bar in the corner behind the yard -----------------------------------------
  box(-43, -38, -31, -25, 1, 3, WALL);
  box(-42, -38, -30, -26, 1, 2, AIR);
  box(-38, -38, -30, -28, 1, 1, TRIM);
  box(-44, -37, -31, -24, 4, 4, BLOCK.STONE_SLAB);
  box(-42, -40, -30, -30, 1, 1, p.garage ? BLOCK.FURNACE : BLOCK.CHEST);
  box(-42, -42, -29, -28, 1, 2, BLOCK.BOOKSHELF);
  box(-40, -40, -28, -28, 3, 3, BLOCK.GLOWSTONE);

  // --- Pool deck (or the court with bleachers): raised one block, the basin is sunken -------
  box(-34, -17, -29, -15, 1, 1, p.deck);
  box(-32, -19, -27, -17, 1, 1, p.pool ? BLOCK.WHITE_WOOL : BLOCK.STONE);
  box(-31, -20, -26, -18, 1, 1, AIR);
  if (p.pool) {
    paint(-31, -20, -26, -18, BLOCK.BLUE_WOOL);
    paint(-31, -20, -22, -22, BLOCK.WHITE_WOOL);
    paint(-31, -31, -26, -18, BLOCK.CLAY);
    // Diving board over the deep end, loungers and sun umbrellas on the deck.
    box(-33, -32, -22, -22, 2, 2, BLOCK.OAK_SLAB);
    for (const x of [-30, -26, -22]) {
      box(x, x + 1, -29, -29, 2, 2, BLOCK.WHITE_WOOL);
      box(x + 2, x + 2, -29, -29, 2, 3, BLOCK.FENCE);
      box(x + 1, x + 3, -29, -28, 4, 4, x === -26 ? BLOCK.WHITE_WOOL : p.accent);
    }
    box(-18, -17, -27, -26, 2, 2, BLOCK.SPRUCE_SLAB);
  } else {
    paint(-31, -20, -26, -18, BLOCK.OAK_PLANKS);
    paint(-26, -25, -26, -18, BLOCK.WHITE_WOOL);
    paint(-31, -29, -24, -20, BLOCK.WHITE_WOOL);
    paint(-22, -20, -24, -20, BLOCK.WHITE_WOOL);
    // Hoops at both ends: a post on the deck, a backboard and a rim over the court.
    for (const [x, rim] of [[-33, -32], [-18, -19]] as const) {
      box(x, x, -22, -22, 2, 4, BLOCK.FENCE);
      box(rim, rim, -23, -21, 4, 5, BLOCK.WHITE_WOOL);
      box(rim, rim, -22, -22, 4, 4, BLOCK.IRON_BARS);
    }
    // Bleachers along the north side.
    box(-30, -21, -29, -29, 2, 3, p.deck);
    box(-30, -21, -28, -28, 2, 2, BLOCK.STONE_SLAB);
  }
  palm(box, -36, -20, 6);
  palm(box, -18, -12, 5);

  // --- The villa (west half): white walls, glass, an open atrium in the middle -------------
  box(-16, -1, -10, 9, 1, 4, WALL);
  box(-15, -1, -9, 8, 1, 3, AIR);
  paint(-15, -1, -9, 8, BLOCK.BIRCH_PLANKS);
  box(-16, -1, -10, -10, 4, 4, TRIM);
  box(-16, -1, 9, 9, 4, 4, TRIM);
  box(-16, -16, -10, 9, 4, 4, TRIM);
  // West façade: floor-to-ceiling glass and the front door.
  box(-16, -16, -8, 7, 1, 3, BLOCK.STAINED_GLASS);
  box(-16, -16, -1, 0, 1, 2, AIR);
  box(-16, -16, -1, 0, 3, 3, p.accent);
  // North façade: glass towards the pool, a sliding door; south: a door to the garden.
  box(-14, -9, -10, -10, 1, 3, BLOCK.STAINED_GLASS);
  box(-5, -4, -10, -10, 1, 2, AIR);
  box(-12, -11, 9, 9, 1, 2, AIR);
  box(-7, -2, 9, 9, 2, 3, BLOCK.STAINED_GLASS);
  // The atrium: open to the sky, glass walls with doors, stone floor and planters in the corners.
  box(-7, -1, -6, 5, 1, 3, BLOCK.STAINED_GLASS);
  box(-6, -1, -5, 4, 1, 4, AIR);
  box(-7, -7, -1, 0, 1, 2, AIR);
  box(-3, -2, -6, -6, 1, 2, AIR);
  box(-3, -2, 5, 5, 1, 2, AIR);
  paint(-6, -1, -5, 4, BLOCK.STONE_BRICKS);
  paint(-4, -1, -2, 1, BLOCK.STONE);
  box(-6, -6, -5, -5, 1, 1, BLOCK.OAK_LEAVES);
  box(-6, -6, 4, 4, 1, 1, BLOCK.OAK_LEAVES);
  // Glass railing round the atrium hole on the terrace.
  box(-7, -1, -6, 5, 5, 5, BLOCK.STAINED_GLASS);
  box(-6, -1, -5, 4, 5, 5, AIR);

  // Ground floor: living room with a sofa, fireplace and TV wall, kitchen with an island.
  box(-14, -10, 2, 2, 1, 1, p.sofa);
  box(-14, -14, 3, 5, 1, 1, p.sofa);
  box(-12, -11, 4, 5, 1, 1, BLOCK.SPRUCE_SLAB);
  box(-14, -10, 8, 8, 1, 2, BLOCK.BOOKSHELF);
  box(-12, -12, 8, 8, 2, 2, BLOCK.OBSIDIAN);
  box(-15, -15, -6, -4, 1, 1, BLOCK.BRICKS);
  box(-15, -15, -5, -5, 1, 1, BLOCK.FURNACE);
  box(-6, -2, -9, -9, 1, 1, BLOCK.BIRCH_PLANKS);
  box(-5, -5, -9, -9, 1, 1, BLOCK.FURNACE);
  box(-3, -3, -9, -9, 1, 1, BLOCK.CRAFTING_TABLE);
  box(-5, -3, -8, -8, 2, 2, AIR);
  box(-13, -12, -5, -4, 1, 1, BLOCK.OAK_SLAB);
  box(-11, -11, 6, 6, 1, 2, BLOCK.OAK_LEAVES);
  box(-12, -12, -2, -2, 4, 4, BLOCK.GLOWSTONE);
  box(-12, -12, 5, 5, 4, 4, BLOCK.GLOWSTONE);
  box(-4, -4, -8, -8, 4, 4, BLOCK.GLOWSTONE);
  box(-4, -4, 7, 7, 4, 4, BLOCK.GLOWSTONE);

  // Stairs along the north wall up to the bedroom wing: three steps, a hole in the ceiling, a railing.
  box(-9, -9, -9, -8, 1, 1, TRIM);
  box(-10, -10, -9, -8, 1, 2, TRIM);
  box(-11, -11, -9, -8, 1, 3, TRIM);
  box(-11, -9, -9, -8, 4, 4, AIR);
  box(-11, -9, -7, -7, 5, 5, BLOCK.FENCE);

  // Bedroom wing upstairs (x -16..-9): glass towards the yard, a bed, doors out to the terrace.
  box(-16, -9, -10, 9, 5, 7, WALL);
  box(-15, -10, -9, 8, 5, 7, AIR);
  box(-16, -9, -10, 9, 8, 8, WALL);
  box(-16, -16, -7, 6, 5, 7, BLOCK.STAINED_GLASS);
  box(-14, -11, -10, -10, 5, 6, BLOCK.STAINED_GLASS);
  box(-14, -11, 9, 9, 5, 6, BLOCK.STAINED_GLASS);
  box(-9, -9, -3, -2, 5, 6, AIR);
  box(-9, -9, 4, 5, 5, 6, AIR);
  box(-14, -13, 5, 7, 5, 5, p.accent);
  box(-14, -13, 7, 7, 5, 6, BLOCK.WHITE_WOOL);
  box(-11, -10, 8, 8, 5, 6, BLOCK.BOOKSHELF);
  box(-15, -15, 0, 1, 5, 5, BLOCK.SPRUCE_SLAB);
  box(-12, -12, 0, 0, 8, 8, BLOCK.GLOWSTONE);
  box(-12, -12, -6, -6, 8, 8, BLOCK.GLOWSTONE);

  // Roof terrace over the ground floor (x -8..-1): glass railing on the outside edges, loungers,
  // and steps up onto the bedroom roof (which has a railing of its own).
  box(-8, -1, -10, -10, 5, 5, BLOCK.STAINED_GLASS);
  box(-8, -1, 9, 9, 5, 5, BLOCK.STAINED_GLASS);
  box(-6, -6, 7, 8, 5, 5, TRIM);
  box(-7, -7, 7, 8, 5, 6, TRIM);
  box(-8, -8, 7, 8, 5, 7, TRIM);
  box(-4, -3, -8, -8, 5, 5, BLOCK.WHITE_WOOL);
  box(-16, -16, -10, 9, 9, 9, BLOCK.FENCE);
  box(-16, -9, -10, -10, 9, 9, BLOCK.FENCE);
  box(-16, -9, 9, 9, 9, 9, BLOCK.FENCE);
  box(-14, -11, -4, -3, 9, 9, BLOCK.STONE_SLAB);

  // --- Garage (cars) or pool-house gym, its roof reached by steps at the back ---------------
  box(-33, -22, 13, 23, 1, 3, WALL);
  box(-32, -23, 14, 22, 1, 3, AIR);
  box(-33, -22, 13, 23, 4, 4, WALL);
  box(-33, -22, 13, 13, 4, 4, TRIM);
  paint(-32, -23, 14, 22, BLOCK.STONE);
  box(-31, -26, 13, 13, 1, 3, AIR);
  box(-22, -22, 18, 19, 1, 2, AIR);
  box(-33, -33, 15, 16, 2, 2, BLOCK.STAINED_GLASS);
  box(-34, -34, 19, 19, 1, 1, TRIM);
  box(-34, -34, 20, 20, 1, 2, TRIM);
  box(-34, -34, 21, 21, 1, 3, TRIM);
  box(-28, -28, 18, 18, 4, 4, BLOCK.GLOWSTONE);
  if (p.garage) {
    car(t, -31, 16, false, p.car);
    car(t, -27, 16, false, BLOCK.WHITE_WOOL);
    box(-32, -32, 21, 22, 1, 2, BLOCK.CHEST);
    box(-24, -23, 22, 22, 1, 1, BLOCK.CRAFTING_TABLE);
  } else {
    for (const x of [-31, -28]) {
      box(x, x + 1, 16, 16, 1, 1, BLOCK.SPRUCE_SLAB);
      box(x, x, 18, 18, 1, 2, BLOCK.IRON_BARS);
      box(x + 1, x + 1, 18, 18, 1, 1, BLOCK.ANVIL);
    }
    box(-24, -23, 21, 22, 1, 1, p.accent);
    box(-32, -32, 20, 22, 1, 2, BLOCK.BOOKSHELF);
  }
  // Driveway out of the garage towards the villa.
  paint(-31, -26, 10, 12, BLOCK.STONE);

  // --- Front garden south of the villa: planters, a sculpture and a parked car ------------
  paint(-20, -2, 13, 24, BLOCK.GRASS);
  paint(-14, -10, 10, 25, BLOCK.STONE_SLAB);
  box(-19, -16, 15, 16, 1, 1, BLOCK.STONE_BRICKS);
  box(-19, -16, 15, 16, 2, 2, BLOCK.OAK_LEAVES);
  box(-7, -4, 20, 21, 1, 1, BLOCK.STONE_BRICKS);
  box(-7, -4, 20, 21, 2, 2, BLOCK.OAK_LEAVES);
  box(-4, -3, 14, 14, 1, 3, WALL);
  box(-4, -4, 14, 14, 4, 4, p.accent);
  car(t, -9, 17, false, p.accent);
  palm(box, -18, 22, 6);
  box(-1, -1, 12, 12, 1, 3, BLOCK.FENCE);
  box(-1, -1, 12, 12, 4, 4, BLOCK.GLOWSTONE);

  // --- The hillside berm along the south wall: a terrace with a retaining wall and trees ---
  box(-43, -1, 27, 30, 1, 1, BLOCK.GRASS);
  box(-43, -1, 26, 26, 1, 1, BLOCK.STONE_BRICKS);
  box(-43, -1, 30, 30, 2, 2, BLOCK.OAK_LEAVES);
  palm(box, -38, 28, 7);
  palm(box, -6, 28, 6);
  box(-20, -18, 28, 29, 2, 2, BLOCK.OAK_LEAVES);
}

export const VILLA: FreeArenaMapDef = {
  layout: 'free',
  id: 'villa',
  name: 'Skyline Villa',
  description: 'A white hillside villa with glass walls, a drained pool, a basketball court and a roof terrace',
  halfX: 44,
  halfZ: 32,
  wallHeight: 12,
  wallBlock: BLOCK.SANDSTONE,
  floorBlock: BLOCK.GRASS,
  variants: 1,
  redSpawns: RED_SPAWNS,
  blueSpawns: RED_SPAWNS.map(turn),
  ffaSpawns: [...FFA_WEST, ...FFA_WEST.map(turn)],
  highGround: [[-12, 0], turn([-12, 0]), [-4, 2], [-28, 18]],
  objectives: {
    zones: [
      { name: 'Atrium', x: 0, z: 0, r: 5 },
      { name: 'Pool', x: -25, z: -21.5, r: 4 },
      { name: 'Court', x: 25, z: 21.5, r: 4 },
      { name: 'South Garden', x: -12, z: 18.5, r: 4 },
      { name: 'North Garden', x: 12, z: -18.5, r: 4 },
    ],
    dominationZones: [0, 1, 2],
    flags: [{ team: 'red', x: -40.5, z: -20.5 }, { team: 'blue', x: 40.5, z: 20.5 }],
  },
  build(_variant, b) {
    half(b, 1, RED_SIDE);
    half(b, -1, BLUE_SIDE);
  },
};
