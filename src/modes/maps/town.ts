import { BLOCK } from '../../world/BlockRegistry';
import { type FreeArenaMapDef, type LayoutBuilder, TEAM } from './ArenaMap';
import { AIR, car, turn, turned } from './helpers';

/**
 * "Sundown": a dusty crossroads town (inspired by the classic standoff-in-a-village maps). A gas
 * station with a canopy and pumps sits on the crossing in the middle; around it a two-storey
 * cantina with a roof terrace, a market square with stalls and a well, a church whose bell tower
 * looks over the rooftops, and narrow alleys between shacks and houses with outside stairs to
 * their flat roofs. Each team spawns in a walled farmyard at its end of town.
 *
 * Point symmetric: the town is drawn once and turned 180° for the other half, with its own
 * colours: the red end has the church and a corral, the blue end a town hall with a clock tower.
 */

interface Side {
  /** Church with a bell tower (true) or town hall with a clock tower (false). */
  church: boolean;
  plaster: number;
  roof: number;
  awning: number;
  car: number;
}

const WEST: Side = { church: true, plaster: BLOCK.STAINED_TERRACOTTA, roof: BLOCK.BRICKS, awning: BLOCK.YELLOW_WOOL, car: BLOCK.GREEN_WOOL };
const EAST: Side = { church: false, plaster: BLOCK.SANDSTONE, roof: BLOCK.SPRUCE_PLANKS, awning: BLOCK.GREEN_WOOL, car: BLOCK.YELLOW_WOOL };

const RED_SPAWNS: [number, number][] = [[-38, -6], [-35, -5], [-38, -2], [-35, 1], [-38, 3], [-35, 5]];
const FFA_WEST: [number, number][] = [[-37, -10], [-37, 11], [-24, -18], [-12, 1], [-19, 29], [-6, -27]];

/** A market stall: a table and an awning on four posts. */
function stall(box: LayoutBuilder['box'], x: number, z: number, awning: number): void {
  box(x, x + 2, z, z + 1, 1, 1, BLOCK.SPRUCE_SLAB);
  for (const [px, pz] of [[x, z], [x + 2, z], [x, z + 1], [x + 2, z + 1]]) box(px, px, pz, pz, 2, 3, BLOCK.FENCE);
  box(x, x + 2, z, z + 1, 4, 4, awning);
  box(x + 1, x + 1, z, z + 1, 4, 4, BLOCK.WHITE_WOOL);
}

/** A dead tree: a bare trunk with a couple of branches and a few leaves. */
function deadTree(box: LayoutBuilder['box'], x: number, z: number): void {
  box(x, x, z, z, 1, 5, BLOCK.OAK_LOG);
  box(x + 1, x + 1, z, z, 4, 4, BLOCK.OAK_LOG);
  box(x, x, z - 1, z - 1, 5, 5, BLOCK.OAK_LOG);
  box(x - 1, x + 1, z - 1, z + 1, 6, 6, BLOCK.SPRUCE_LEAVES);
}

function half(b: LayoutBuilder, s: 1 | -1, p: Side): void {
  const t = turned(b, s);
  const { box, paint } = t;

  // --- Streets: the west street, the cross street to the gas station, the south road --------
  paint(-31, -28, -24, 23, BLOCK.COBBLESTONE);
  paint(-39, -1, -11, -8, BLOCK.COBBLESTONE);
  paint(-39, -1, 9, 12, BLOCK.COBBLESTONE);
  paint(-13, -1, -7, 8, BLOCK.STONE);

  // --- Spawn yard: a walled farmyard, open to the cross street and the south road -----------
  paint(-39, -33, -7, 6, BLOCK.GRAVEL);
  paint(-39, -39, -3, 2, TEAM);
  box(-32, -32, -8, 7, 1, 3, p.plaster);
  box(-32, -32, -8, 7, 4, 4, p.roof);
  box(-32, -32, -1, 0, 3, 3, BLOCK.GLOWSTONE);
  box(-36, -36, -7, -7, 1, 2, BLOCK.YELLOW_WOOL);
  box(-37, -36, 6, 6, 1, 1, BLOCK.YELLOW_WOOL);
  box(-34, -33, -1, -1, 1, 1, BLOCK.SPRUCE_SLAB);
  box(-33, -33, -3, -2, 1, 1, BLOCK.FENCE);

  // --- Corral north of the yard: a fenced paddock with a water trough and a hay shed -------
  paint(-39, -32, -22, -13, BLOCK.DIRT);
  box(-39, -32, -22, -22, 1, 1, BLOCK.FENCE);
  box(-32, -32, -22, -16, 1, 1, BLOCK.FENCE);
  box(-36, -34, -13, -13, 1, 1, BLOCK.FENCE);
  box(-38, -37, -21, -21, 1, 1, BLOCK.STONE_BRICK_SLAB);
  box(-34, -32, -15, -13, 1, 3, BLOCK.SPRUCE_LOG);
  box(-33, -33, -14, -14, 1, 3, AIR);
  box(-35, -32, -16, -12, 4, 4, BLOCK.SPRUCE_SLAB);
  box(-34, -33, -14, -14, 1, 1, BLOCK.YELLOW_WOOL);

  // --- Graveyard (red) / town garden (blue) in the corner, behind a low wall ------------------
  box(-39, -27, -24, -24, 1, 1, BLOCK.COBBLESTONE);
  box(-34, -33, -24, -24, 1, 1, AIR);
  paint(-39, -27, -33, -25, p.church ? BLOCK.GRASS : BLOCK.GRAVEL);
  for (const x of [-37, -34, -31, -28]) {
    for (const z of [-31, -27]) {
      if (p.church) {
        box(x, x, z, z, 1, 2, BLOCK.COBBLESTONE);
        box(x, x, z + 1, z + 1, 1, 1, BLOCK.MOSSY_COBBLESTONE_SLAB);
      } else {
        box(x, x, z, z, 1, 1, BLOCK.BRICKS);
        box(x, x, z, z, 2, 2, BLOCK.OAK_LEAVES);
      }
    }
  }
  deadTree(box, -36, -29);

  // --- The church (or town hall) and its tower ------------------------------------------------
  const hall = p.church ? BLOCK.CONCRETE : BLOCK.BRICKS;
  box(-20, -6, -32, -24, 1, 6, hall);
  box(-19, -7, -31, -25, 1, 5, AIR);
  box(-20, -6, -32, -24, 7, 7, p.roof);
  box(-20, -6, -28, -28, 8, 8, p.roof);
  box(-14, -12, -24, -24, 1, 3, AIR);
  box(-6, -6, -28, -27, 1, 2, AIR);
  for (const x of [-18, -15, -9]) {
    box(x, x, -32, -32, 3, 5, BLOCK.STAINED_GLASS);
    box(x, x, -24, -24, 3, 5, BLOCK.STAINED_GLASS);
  }
  if (p.church) {
    for (const x of [-17, -15, -11, -9]) box(x, x + 1, -29, -26, 1, 1, BLOCK.SPRUCE_SLAB);
    box(-19, -19, -30, -26, 1, 1, BLOCK.CONCRETE);
    box(-19, -19, -28, -28, 2, 3, BLOCK.GOLD_ORE);
  } else {
    box(-17, -10, -28, -27, 1, 1, BLOCK.SPRUCE_PLANKS);
    box(-18, -18, -30, -26, 1, 2, BLOCK.BOOKSHELF);
    box(-8, -7, -31, -31, 1, 2, BLOCK.CHEST);
  }
  box(-16, -16, -28, -28, 6, 6, BLOCK.GLOWSTONE);
  box(-10, -10, -28, -28, 6, 6, BLOCK.GLOWSTONE);
  // Tower: a spiral stair up to the belfry (a floor at 6, arches at 7-8, a pointed roof).
  box(-25, -21, -32, -28, 1, 8, hall);
  box(-24, -22, -31, -29, 1, 8, AIR);
  box(-23, -23, -30, -30, 1, 6, hall);
  box(-24, -24, -28, -28, 1, 2, AIR);
  box(-24, -24, -30, -30, 1, 1, BLOCK.SPRUCE_PLANKS);
  box(-24, -24, -31, -31, 1, 2, BLOCK.SPRUCE_PLANKS);
  box(-23, -23, -31, -31, 1, 3, BLOCK.SPRUCE_PLANKS);
  box(-22, -22, -31, -31, 1, 4, BLOCK.SPRUCE_PLANKS);
  box(-22, -22, -30, -30, 1, 5, BLOCK.SPRUCE_PLANKS);
  box(-22, -22, -29, -29, 1, 6, BLOCK.SPRUCE_PLANKS);
  box(-24, -23, -31, -29, 6, 6, BLOCK.SPRUCE_PLANKS);
  box(-24, -24, -30, -30, 6, 6, BLOCK.SPRUCE_PLANKS);
  box(-25, -21, -30, -30, 7, 8, AIR);
  box(-23, -23, -32, -28, 7, 8, AIR);
  box(-25, -21, -32, -28, 9, 9, p.roof);
  box(-24, -22, -31, -29, 10, 10, p.roof);
  box(-23, -23, -30, -30, 8, 8, p.church ? BLOCK.GOLD_ORE : BLOCK.GLOWSTONE);
  if (!p.church) box(-23, -23, -28, -28, 5, 5, BLOCK.GLOWSTONE);

  // --- Market square: paved, stalls, a well with a little roof -------------------------------
  paint(-20, -2, -21, -12, BLOCK.STONE_BRICKS);
  stall(box, -19, -20, p.awning);
  stall(box, -19, -14, BLOCK.WHITE_WOOL);
  stall(box, -6, -20, p.awning);
  box(-12, -10, -18, -16, 1, 1, BLOCK.STONE_BRICKS);
  box(-11, -11, -17, -17, 1, 1, BLOCK.BLUE_WOOL);
  box(-12, -12, -18, -18, 2, 3, BLOCK.FENCE);
  box(-10, -10, -16, -16, 2, 3, BLOCK.FENCE);
  box(-12, -10, -18, -16, 4, 4, BLOCK.OAK_SLAB);
  box(-3, -2, -14, -13, 1, 1, BLOCK.OAK_PLANKS);
  box(-3, -3, -14, -14, 2, 2, BLOCK.OAK_PLANKS);

  // --- Gas station on the crossing: canopy, pumps, a shop --------------------------------------
  for (const z of [-4, 3]) box(-6, -6, z, z, 1, 3, BLOCK.WALL);
  box(-7, -1, -5, 4, 4, 4, BLOCK.STONE_SLAB);
  box(-7, -7, -5, 4, 4, 4, p.awning);
  box(-7, -1, -5, -5, 4, 4, p.awning);
  box(-7, -1, 4, 4, 4, 4, p.awning);
  box(-4, -4, -1, -1, 4, 4, BLOCK.GLOWSTONE);
  box(-3, -3, -3, -3, 1, 1, BLOCK.STONE_BRICKS);
  box(-3, -3, -3, -3, 2, 2, p.awning);
  box(-3, -3, 2, 2, 1, 1, BLOCK.STONE_BRICKS);
  box(-3, -3, 2, 2, 2, 2, BLOCK.WHITE_WOOL);
  car(t, -12, -6, true, p.car);
  // The shop: glass front to the forecourt, shelves, a counter; climb its roof from the crates.
  box(-14, -8, 4, 8, 1, 3, p.plaster);
  box(-13, -9, 5, 7, 1, 2, AIR);
  box(-14, -8, 4, 8, 4, 4, p.roof);
  box(-12, -10, 4, 4, 1, 2, BLOCK.GLASS);
  box(-9, -9, 4, 4, 1, 2, AIR);
  box(-13, -13, 5, 7, 1, 2, BLOCK.BOOKSHELF);
  box(-11, -10, 7, 7, 1, 1, BLOCK.SPRUCE_PLANKS);
  box(-11, -11, 6, 6, 3, 3, BLOCK.GLOWSTONE);
  box(-17, -17, 8, 8, 1, 1, BLOCK.OAK_PLANKS);
  box(-16, -16, 8, 8, 1, 2, BLOCK.OAK_PLANKS);
  box(-15, -15, 8, 8, 1, 3, BLOCK.OAK_PLANKS);
  box(-15, -15, 7, 7, 1, 1, BLOCK.OAK_PLANKS);

  // --- The cantina: two storeys, a bar downstairs, a roof terrace with a parapet ---------------
  box(-26, -17, -6, 6, 1, 7, p.plaster);
  box(-25, -18, -5, 5, 1, 3, AIR);
  box(-25, -18, -5, 5, 5, 7, AIR);
  box(-25, -18, -5, 5, 4, 4, BLOCK.SPRUCE_PLANKS);
  box(-27, -16, -7, 7, 8, 8, p.roof);
  box(-26, -17, -6, -6, 9, 9, p.plaster);
  box(-26, -17, 6, 6, 9, 9, p.plaster);
  box(-17, -17, -6, 6, 9, 9, p.plaster);
  box(-22, -21, -6, -6, 9, 9, AIR);
  box(-17, -17, -1, 0, 9, 9, AIR);
  // Doors on every side, windows on both floors.
  box(-17, -17, -1, 0, 1, 2, AIR);
  box(-26, -26, 2, 3, 1, 2, AIR);
  box(-23, -22, -6, -6, 1, 2, AIR);
  box(-21, -20, 6, 6, 1, 2, AIR);
  box(-17, -17, -4, -3, 2, 2, BLOCK.GLASS);
  box(-17, -17, 3, 4, 2, 2, BLOCK.GLASS);
  box(-17, -17, -4, -2, 5, 6, AIR);
  box(-17, -17, 2, 4, 5, 6, AIR);
  box(-26, -26, -4, -3, 5, 6, AIR);
  box(-21, -19, -6, -6, 5, 6, BLOCK.GLASS);
  box(-24, -23, 6, 6, 5, 6, AIR);
  box(-17, -17, -6, 6, 4, 4, p.roof);
  // Bar, tables, lights.
  box(-25, -25, -5, 1, 1, 1, BLOCK.SPRUCE_PLANKS);
  box(-25, -25, -5, -3, 2, 2, BLOCK.BOOKSHELF);
  for (const [x, z] of [[-21, -3], [-21, 2], [-19, -1]]) box(x, x, z, z, 1, 1, BLOCK.OAK_SLAB);
  box(-22, -22, 0, 0, 3, 3, BLOCK.GLOWSTONE);
  box(-22, -22, 0, 0, 7, 7, BLOCK.GLOWSTONE);
  // Stairs to the upper floor (along the south wall) and a step ladder to the roof.
  box(-19, -19, 4, 5, 1, 1, BLOCK.SPRUCE_PLANKS);
  box(-20, -20, 4, 5, 1, 2, BLOCK.SPRUCE_PLANKS);
  box(-21, -21, 4, 5, 1, 3, BLOCK.SPRUCE_PLANKS);
  box(-21, -19, 4, 5, 4, 4, AIR);
  box(-21, -19, 3, 3, 5, 5, BLOCK.FENCE);
  box(-25, -25, -1, -1, 5, 5, BLOCK.SPRUCE_PLANKS);
  box(-25, -25, 0, 0, 5, 6, BLOCK.SPRUCE_PLANKS);
  box(-25, -25, 1, 1, 5, 7, BLOCK.SPRUCE_PLANKS);
  // The roof hatch also clears the first step, or the ceiling stops the jump onto the second one.
  box(-25, -24, -1, 2, 8, 8, AIR);
  box(-25, -25, 2, 2, 5, 7, BLOCK.SPRUCE_PLANKS);
  box(-24, -24, 2, 2, 5, 5, BLOCK.WHITE_WOOL);
  box(-23, -22, -5, -4, 5, 5, p.awning);

  // --- Slum block south of the road: houses with outside stairs, shacks and alleys -----------
  // House with a roof terrace.
  box(-26, -18, 15, 22, 1, 7, p.plaster);
  box(-25, -19, 16, 21, 1, 3, AIR);
  box(-25, -19, 16, 21, 5, 7, AIR);
  box(-25, -19, 16, 21, 4, 4, BLOCK.OAK_PLANKS);
  box(-26, -18, 15, 22, 8, 8, p.roof);
  box(-22, -21, 15, 15, 1, 2, AIR);
  box(-26, -26, 18, 19, 1, 2, AIR);
  box(-24, -23, 15, 15, 5, 6, BLOCK.GLASS);
  box(-20, -19, 15, 15, 5, 6, AIR);
  box(-18, -18, 17, 18, 5, 6, AIR);
  box(-24, -23, 21, 21, 1, 1, BLOCK.WHITE_WOOL);
  box(-20, -20, 21, 21, 1, 2, BLOCK.FURNACE);
  box(-24, -24, 21, 21, 5, 5, p.awning);
  box(-21, -21, 18, 18, 3, 3, BLOCK.GLOWSTONE);
  // Outside stair up the east wall to the upper door and on to the roof.
  for (let i = 0; i < 7; i++) box(-17, -16, 22 - i, 22 - i, 1, i + 1, BLOCK.COBBLESTONE);
  box(-17, -16, 15, 15, 1, 7, BLOCK.COBBLESTONE);
  box(-18, -18, 16, 16, 8, 8, p.roof);
  for (const z of [15, 22]) box(-26, -18, z, z, 9, 9, BLOCK.FENCE);
  box(-26, -26, 15, 22, 9, 9, BLOCK.FENCE);
  // Shack: planks and a sheet roof.
  box(-13, -6, 19, 25, 1, 3, BLOCK.OAK_PLANKS);
  box(-12, -7, 20, 24, 1, 2, AIR);
  box(-13, -6, 19, 25, 4, 4, BLOCK.IRON_BARS);
  box(-12, -7, 20, 24, 4, 4, BLOCK.SPRUCE_SLAB);
  box(-10, -9, 19, 19, 1, 2, AIR);
  box(-6, -6, 22, 23, 1, 2, AIR);
  box(-13, -13, 21, 22, 2, 2, BLOCK.IRON_BARS);
  box(-12, -11, 24, 24, 1, 1, p.awning);
  box(-8, -7, 20, 20, 1, 1, BLOCK.CRAFTING_TABLE);
  // Laundry lines over the alley, a wrecked car, barrels and crates.
  box(-16, -14, 26, 26, 1, 4, BLOCK.FENCE);
  box(-16, -14, 26, 26, 1, 3, AIR);
  box(-16, -16, 26, 26, 1, 3, BLOCK.FENCE);
  box(-14, -14, 26, 26, 1, 3, BLOCK.FENCE);
  box(-15, -15, 26, 26, 3, 3, BLOCK.WHITE_WOOL);
  car(t, -25, 26, true, BLOCK.COBBLESTONE);
  box(-3, -2, 15, 16, 1, 2, BLOCK.SPRUCE_PLANKS);
  box(-3, -3, 15, 15, 3, 3, BLOCK.SPRUCE_PLANKS);
  box(-5, -5, 28, 29, 1, 1, BLOCK.FURNACE);
  box(-12, -10, 14, 14, 1, 1, BLOCK.COBBLESTONE_SLAB);
  paint(-26, -1, 13, 14, BLOCK.DIRT);
  paint(-22, -16, 23, 31, BLOCK.GRAVEL);
  // Barn in the south-west corner.
  box(-39, -30, 16, 25, 1, 4, BLOCK.SPRUCE_PLANKS);
  box(-38, -31, 17, 24, 1, 3, AIR);
  box(-39, -30, 16, 25, 5, 5, p.roof);
  box(-36, -33, 16, 16, 1, 3, AIR);
  box(-30, -30, 20, 21, 1, 2, AIR);
  box(-37, -36, 22, 24, 1, 2, BLOCK.YELLOW_WOOL);
  box(-38, -38, 18, 19, 1, 1, BLOCK.YELLOW_WOOL);
  box(-34, -34, 20, 20, 4, 4, BLOCK.GLOWSTONE);
  car(t, -38, 27, true, p.car);
  // Street lamps.
  for (const [x, z] of [[-27, -12], [-27, 13], [-14, -12]]) {
    box(x, x, z, z, 1, 3, BLOCK.FENCE);
    box(x, x, z, z, 4, 4, BLOCK.GLOWSTONE);
  }
}

export const TOWN: FreeArenaMapDef = {
  layout: 'free',
  id: 'town',
  name: 'Sundown',
  description: 'A dusty crossroads town: a gas station, a cantina, a market, a bell tower and narrow alleys',
  halfX: 40,
  halfZ: 34,
  wallHeight: 13,
  wallBlock: BLOCK.SANDSTONE,
  floorBlock: BLOCK.DIRT,
  variants: 1,
  redSpawns: RED_SPAWNS,
  blueSpawns: RED_SPAWNS.map(turn),
  ffaSpawns: [...FFA_WEST, ...FFA_WEST.map(turn)],
  highGround: [[-21, 0], turn([-21, 0]), [-22, 18], [-11, 6]],
  objectives: {
    zones: [
      { name: 'Gas Station', x: 0, z: 0, r: 5, level: 0 },
      { name: 'Market', x: -15, z: -16.5, r: 5, level: 0 },
      { name: 'Plaza', x: 15, z: 16.5, r: 5, level: 0 },
      { name: 'Graveyard', x: -32, z: -27.5, r: 4 },
      { name: 'Town Garden', x: 32, z: 27.5, r: 4 },
    ],
    dominationZones: [0, 1, 2],
    flags: [{ team: 'red', x: -36.5, z: -17.5 }, { team: 'blue', x: 36.5, z: 17.5 }],
  },
  build(_variant, b) {
    half(b, 1, WEST);
    half(b, -1, EAST);
  },
};
