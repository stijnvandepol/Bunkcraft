import { BLOCK } from '../../world/BlockRegistry';
import { type FreeArenaMapDef, type LayoutBuilder, TEAM } from './ArenaMap';
import { AIR, jumpPad, turn, turned } from './helpers';
import { C, bench, car, crates, hedge, lamp, mannequin, tree } from './props';

/**
 * "Atomic Lane": a 1950s test-site cul-de-sac (inspired by the classic two-houses-and-a-bus layout). A
 * yellow house (red team) and a mint house (blue team) face each other across a roundabout with a hedged
 * island and a big tree in the middle. Each house has two full storeys (kitchen and living room
 * downstairs, two bedrooms upstairs, a stair in the kitchen), open upstairs windows over the street, a
 * porch roof you can drop onto from the front bedroom, and a garage whose flat roof leads in through a
 * side window. The teams spawn in the fenced backyards; a side yard with a swing set runs along one side
 * of each house, a side yard with a pool along the other.
 *
 * Three lanes: the north lane behind the school bus, the street across the roundabout, the south lane
 * behind the moving truck (the bus and the truck are the same cover turned around). Both vehicles can
 * be run through. Parked cars, hedges, garden walls, mailboxes and trees break the street up so that the
 * two house fronts only see each other from the upstairs windows.
 *
 * The layout is point symmetric (each house is the other one turned 180° around the centre), so it is
 * fair, but the houses differ in colour and furniture.
 */

interface Palette {
  wall: number;
  trim: number;
  /** Stepped hip roof. */
  roof: number;
  /** Ground floor of the living room and the upper floor. */
  floor: number;
  rug: number;
  sofa: number;
  car: number;
  car2: number;
  /** Privacy fence boards. */
  fence: number;
}

const YELLOW_HOUSE: Palette = {
  wall: BLOCK.YELLOW_WOOL, trim: BLOCK.WHITE_WOOL, roof: C.MANGROVE_PLANKS, floor: BLOCK.OAK_PLANKS, rug: BLOCK.GREEN_WOOL,
  sofa: BLOCK.GREEN_WOOL, car: C.CHERRY_PLANKS, car2: BLOCK.WHITE_WOOL, fence: BLOCK.SPRUCE_PLANKS,
};
const MINT_HOUSE: Palette = {
  wall: C.EMERALD_BLOCK, trim: BLOCK.WHITE_WOOL, roof: C.DARK_OAK_PLANKS, floor: BLOCK.BIRCH_PLANKS, rug: BLOCK.YELLOW_WOOL,
  sofa: C.COPPER_BLOCK, car: C.LAPIS_BLOCK, car2: BLOCK.YELLOW_WOOL, fence: BLOCK.BIRCH_PLANKS,
};

/** The red team's spawns in the yellow backyard; blue gets the same spots turned 180°. */
const RED_SPAWNS: [number, number][] = [[-33, -11], [-30, -8], [-33, -3], [-30, 1], [-33, 6], [-30, 10]];
const FFA_WEST: [number, number][] = [[-29, -21], [-32, 19], [-20, -12], [-13, 21], [-6, -21], [-8, -3]];

/** The house, its yards and its half of the street, drawn for the west (yellow) house. */
function homestead(b: LayoutBuilder, s: 1 | -1, p: Palette): void {
  const t = turned(b, s);
  const { box, paint } = t;

  // --- Backyard (spawn): lawn, a patio, a privacy fence with two gates ---------------------
  paint(-29, -27, -5, 1, BLOCK.STONE_BRICKS);
  paint(-35, -35, -3, 2, TEAM);
  // Fence boards two high between posts; closes the yard from the side yards.
  const privacy = (x0: number, x1: number, z0: number, z1: number) => {
    box(x0, x1, z0, z1, 1, 2, p.fence);
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x += 4) for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z += 4) box(x, x, z, z, 1, 3, C.STRIPPED_SPRUCE_LOG);
  };
  privacy(-35, -27, -15, -15);
  privacy(-27, -27, -15, -11);
  privacy(-35, -27, 14, 14);
  privacy(-27, -27, 13, 14);
  box(-33, -32, -15, -15, 1, 3, AIR);
  box(-34, -33, 14, 14, 1, 3, AIR);
  // A team-coloured awning over the back door.
  box(-27, -27, -4, -1, 3, 3, TEAM);
  // Barbecue, picnic table, a clothes line with sheets (cover in the spawn), a kiddie pool.
  box(-28, -28, -7, -7, 1, 1, BLOCK.FURNACE);
  box(-28, -28, -8, -8, 1, 1, BLOCK.STONE_BRICKS);
  box(-32, -31, -1, -1, 1, 1, BLOCK.SPRUCE_PLANKS);
  bench(t, -32, -2, true, BLOCK.SPRUCE_SLAB);
  bench(t, -32, 0, true, BLOCK.SPRUCE_SLAB);
  box(-35, -35, 2, 2, 1, 3, BLOCK.FENCE);
  box(-35, -35, 7, 7, 1, 3, BLOCK.FENCE);
  box(-35, -35, 3, 6, 2, 3, BLOCK.WHITE_WOOL);
  box(-35, -35, 4, 4, 2, 3, p.rug);
  paint(-32, -31, 4, 5, C.DIAMOND_BLOCK);
  box(-28, -28, 4, 4, 1, 1, BLOCK.WHITE_WOOL);
  tree(t, -34, -9, BLOCK.OAK_LOG, BLOCK.OAK_LEAVES, 3, 1);
  // Crates stacked up to the garage roof.
  box(-29, -29, 6, 7, 1, 1, BLOCK.SPRUCE_PLANKS);
  box(-28, -28, 6, 7, 1, 2, BLOCK.SPRUCE_PLANKS);
  box(-27, -27, 6, 7, 1, 3, BLOCK.OAK_PLANKS);

  // --- The house: two storeys, white corner posts and band, a stepped hip roof ---------------
  box(-26, -15, -10, 4, 1, 7, p.wall);
  box(-26, -15, -10, 4, 4, 4, p.trim);
  for (const [x, z] of [[-26, -10], [-15, -10], [-26, 4], [-15, 4]]) box(x, x, z, z, 1, 7, p.trim);
  box(-25, -16, -9, 3, 1, 3, AIR);
  box(-25, -16, -9, 3, 5, 7, AIR);
  box(-25, -16, -9, 3, 4, 4, p.floor);
  box(-27, -14, -11, 5, 8, 8, p.roof);
  box(-26, -15, -10, 4, 9, 9, p.roof);
  box(-24, -17, -8, 2, 10, 10, p.roof);
  box(-24, -24, 1, 1, 9, 10, BLOCK.BRICKS);
  // Floors: a black-and-white checkered kitchen, planks and a rug in the living room.
  for (let x = -25; x <= -22; x++) for (let z = -9; z <= 3; z++) paint(x, x, z, z, (x + z) & 1 ? C.COAL_BLOCK : C.CALCITE);
  paint(-20, -16, -9, 3, p.floor);
  paint(-19, -17, -4, 0, p.rug);
  // Front (street side): door under a team-coloured lintel, ground windows, the two wide open
  // upstairs windows over the porch.
  box(-15, -15, -5, -4, 1, 2, AIR);
  box(-15, -15, -5, -4, 3, 3, TEAM);
  box(-15, -15, -8, -7, 2, 2, BLOCK.GLASS);
  box(-15, -15, 0, 2, 2, 2, BLOCK.GLASS);
  box(-15, -15, -8, -6, 5, 6, AIR);
  box(-15, -15, -1, 1, 5, 6, AIR);
  // Back: door to the patio, a kitchen window, a small upstairs window.
  box(-26, -26, -3, -2, 1, 2, AIR);
  box(-26, -26, 0, 1, 2, 2, BLOCK.GLASS);
  box(-26, -26, -6, -5, 2, 2, BLOCK.GLASS);
  box(-26, -26, -5, -4, 6, 6, BLOCK.GLASS);
  // North side: a window downstairs, an open window upstairs over the swing-set yard.
  box(-19, -18, -10, -10, 2, 2, BLOCK.GLASS);
  box(-19, -17, -10, -10, 5, 6, AIR);
  // South side: the upstairs window onto the garage roof.
  box(-23, -22, 4, 4, 5, 6, AIR);

  // Ground floor: kitchen at the back, living room at the front, a wall with two doorways.
  box(-21, -21, -9, 3, 1, 3, p.wall);
  box(-21, -21, -6, -5, 1, 2, AIR);
  box(-21, -21, 1, 2, 1, 2, AIR);
  // Kitchen: fridge, counter with a stove and a sink, a table with two chairs, lights.
  box(-25, -25, 3, 3, 1, 2, C.IRON_BLOCK);
  box(-24, -22, 3, 3, 1, 1, C.SMOOTH_STONE);
  box(-23, -23, 3, 3, 1, 1, BLOCK.FURNACE);
  box(-25, -25, 0, 1, 1, 1, C.SMOOTH_STONE);
  box(-24, -22, 3, 3, 3, 3, BLOCK.SPRUCE_PLANKS);
  box(-24, -23, -3, -3, 1, 1, BLOCK.SPRUCE_PLANKS);
  box(-24, -23, -4, -4, 1, 1, BLOCK.OAK_SLAB);
  box(-23, -23, -1, -1, 4, 4, BLOCK.GLOWSTONE);
  box(-23, -23, -6, -6, 4, 4, BLOCK.GLOWSTONE);
  // Stairs along the north wall of the kitchen: three steps up to a hole in the upper floor.
  box(-25, -25, -9, -8, 1, 1, p.floor);
  box(-24, -24, -9, -8, 1, 2, p.floor);
  box(-23, -23, -9, -8, 1, 3, p.floor);
  box(-25, -23, -9, -8, 4, 4, AIR);
  box(-25, -24, -7, -7, 5, 5, BLOCK.FENCE);
  // Living room: sofa, coffee table, a TV on a cabinet, a bookcase, a standard lamp.
  box(-20, -20, -3, 0, 1, 1, p.sofa);
  box(-18, -17, -2, -1, 1, 1, BLOCK.SPRUCE_SLAB);
  box(-19, -17, -9, -9, 1, 1, BLOCK.SPRUCE_PLANKS);
  box(-18, -18, -9, -9, 2, 2, C.COAL_BLOCK);
  box(-17, -16, 3, 3, 1, 2, BLOCK.BOOKSHELF);
  box(-16, -16, -9, -9, 1, 2, BLOCK.FENCE);
  box(-18, -18, -4, -4, 4, 4, BLOCK.GLOWSTONE);
  box(-18, -18, 1, 1, 4, 4, BLOCK.GLOWSTONE);

  // Upstairs: a wall between the kid's room (back) and the main bedroom (front).
  box(-21, -21, -9, 3, 5, 7, p.wall);
  box(-21, -21, -3, -2, 5, 6, AIR);
  // Kid's room: a bed, a desk, a toy chest; lights in the roof.
  box(-25, -24, 2, 3, 5, 5, BLOCK.BED);
  box(-22, -22, 3, 3, 5, 5, BLOCK.CRAFTING_TABLE);
  box(-25, -25, -1, -1, 5, 5, BLOCK.CHEST);
  box(-23, -23, -3, -3, 8, 8, BLOCK.GLOWSTONE);
  // Main bedroom: a double bed, a wardrobe, a dresser, and a mannequin watching the street.
  box(-17, -16, 1, 3, 5, 5, BLOCK.BED);
  box(-20, -20, 2, 3, 5, 6, C.DARK_OAK_PLANKS);
  box(-20, -20, -9, -8, 5, 5, BLOCK.SPRUCE_PLANKS);
  mannequin(t, -16, -9, 5, p.wall);
  box(-18, -18, -4, -4, 8, 8, BLOCK.GLOWSTONE);

  // --- Porch: plank floor, posts, a railing and a flat roof under the upstairs windows ------
  paint(-14, -12, -9, 0, BLOCK.OAK_PLANKS);
  for (const z of [-9, 0]) box(-12, -12, z, z, 1, 3, BLOCK.FENCE);
  box(-12, -12, -8, -7, 1, 1, BLOCK.FENCE);
  box(-12, -12, -2, -1, 1, 1, BLOCK.FENCE);
  box(-14, -12, -9, 0, 4, 4, BLOCK.OAK_SLAB);
  mannequin(t, -13, -8, 1, BLOCK.WHITE_WOOL);

  // --- Front yard: a brick garden wall with a gate, a mailbox, a tree, hedges --------------
  paint(-11, -11, -5, -4, C.DIRT_PATH);
  box(-11, -11, -13, -7, 1, 1, BLOCK.BRICKS);
  box(-11, -11, -2, 4, 1, 1, BLOCK.BRICKS);
  box(-11, -11, -6, -6, 1, 2, BLOCK.BRICKS);
  box(-11, -11, -3, -3, 1, 2, BLOCK.BRICKS);
  box(-11, -11, -9, -9, 2, 2, BLOCK.CHEST);
  tree(t, -13, -12, BLOCK.BIRCH_LOG, BLOCK.BIRCH_LEAVES, 3, 1);
  hedge(t, -14, -12, 2, 4, 2);

  // --- Garage with a car inside; its flat roof is reached from the crates in the backyard ---
  box(-26, -18, 5, 12, 1, 3, p.wall);
  box(-26, -18, 5, 12, 4, 4, p.trim);
  box(-25, -19, 6, 11, 1, 3, AIR);
  box(-18, -18, 7, 10, 1, 3, AIR);
  box(-18, -18, 7, 10, 3, 3, BLOCK.WHITE_WOOL);
  box(-26, -26, 10, 11, 1, 2, AIR);
  car(t, -24, 8, true, p.car2);
  box(-25, -25, 6, 7, 1, 2, BLOCK.BOOKSHELF);
  box(-21, -19, 6, 6, 1, 1, BLOCK.CRAFTING_TABLE);
  box(-20, -20, 6, 6, 1, 1, BLOCK.ANVIL);
  box(-25, -25, 11, 11, 1, 1, BLOCK.CHEST);
  box(-22, -22, 9, 9, 3, 3, BLOCK.GLOWSTONE);
  // On the roof: an air conditioner and a TV aerial (cover up there).
  box(-24, -23, 11, 12, 5, 5, C.IRON_BLOCK);
  box(-20, -20, 6, 6, 5, 7, BLOCK.FENCE);

  // --- Driveway with the second car ---------------------------------------------------------
  paint(-17, -11, 6, 11, BLOCK.GRAVEL);
  car(t, -16, 7, true, p.car);
  // A trampoline pad at the end of the driveway: up onto the garage roof, then in at the side window.
  jumpPad(t, -17, 12);
  box(-11, -11, 12, 12, 1, 1, BLOCK.WALL);
  box(-11, -11, 13, 13, 1, 1, BLOCK.WALL);

  // --- North side yard: shed, doghouse, swing set, sandbox, a tree, a picnic table ---------
  box(-35, -31, -23, -20, 1, 3, p.fence);
  box(-34, -32, -22, -21, 1, 2, AIR);
  box(-33, -32, -20, -20, 1, 2, AIR);
  box(-35, -31, -23, -20, 4, 4, BLOCK.SPRUCE_SLAB);
  box(-34, -34, -22, -22, 1, 1, C.HAY);
  box(-32, -32, -22, -22, 1, 1, BLOCK.ANVIL);
  box(-29, -28, -18, -17, 1, 2, BLOCK.OAK_PLANKS);
  box(-29, -28, -18, -17, 3, 3, BLOCK.BRICK_SLAB);
  box(-28, -28, -17, -17, 1, 1, AIR);
  for (const x of [-23, -18]) for (const z of [-19, -17]) box(x, x, z, z, 1, 3, BLOCK.FENCE);
  box(-23, -18, -18, -18, 4, 4, BLOCK.SPRUCE_PLANKS);
  box(-23, -23, -18, -18, 1, 3, BLOCK.FENCE);
  box(-18, -18, -18, -18, 1, 3, BLOCK.FENCE);
  box(-21, -21, -18, -18, 2, 3, BLOCK.FENCE);
  box(-21, -21, -18, -18, 1, 1, BLOCK.OAK_SLAB);
  paint(-16, -14, -22, -20, BLOCK.SAND);
  box(-16, -16, -22, -22, 1, 1, BLOCK.OAK_SLAB);
  tree(t, -25, -21, BLOCK.OAK_LOG, BLOCK.OAK_LEAVES, 3, 2);
  hedge(t, -14, -12, -15, -14, 2);

  // --- South side yard: an above-ground pool with loungers, a tree, a garden corner --------
  box(-24, -17, 16, 21, 1, 1, C.CALCITE);
  box(-23, -18, 17, 20, 1, 1, AIR);
  paint(-23, -18, 17, 20, C.DIAMOND_BLOCK);
  box(-21, -20, 18, 19, 1, 1, BLOCK.YELLOW_WOOL);
  box(-17, -17, 18, 18, 2, 2, BLOCK.FENCE);
  for (const x of [-15, -13]) box(x, x, 16, 17, 1, 1, BLOCK.WHITE_WOOL);
  tree(t, -29, 20, BLOCK.OAK_LOG, BLOCK.OAK_LEAVES, 3, 1);
  paint(-35, -34, 16, 22, C.PODZOL);
  box(-35, -35, 16, 22, 1, 1, C.HAY);
  hedge(t, -14, -12, 13, 14, 2);

  // --- Street, west kerb: a parked car, a hydrant, a civil defence siren -------------------
  paint(-10, -10, -23, 22, C.SMOOTH_STONE);
  car(t, -10, -12, false, p.car2, true);
  box(-10, -10, 2, 2, 1, 1, BLOCK.YELLOW_WOOL);
  box(-9, -9, 14, 14, 1, 5, BLOCK.FENCE);
  box(-9, -9, 14, 14, 6, 6, C.SMOOTH_STONE);
  box(-9, -9, 13, 13, 6, 6, BLOCK.YELLOW_WOOL);
  box(-9, -9, 15, 15, 6, 6, BLOCK.YELLOW_WOOL);
  box(-9, -9, 14, 14, 7, 7, BLOCK.STONE_SLAB);
  lamp(t, -10, -14, 4);
  lamp(t, -10, 9, 4);
  // A car parked on the roundabout, sandbags at the bus.
  car(t, -8, 3, true, p.car);
  box(-4, -2, -12, -12, 1, 1, C.PACKED_MUD);
  box(-3, -3, -12, -12, 2, 2, C.PACKED_MUD);

  // --- North lane behind the bus: a bus stop, a bench, a planter --------------------------
  box(-3, -3, -22, -22, 1, 3, BLOCK.FENCE);
  box(-3, -3, -22, -22, 4, 4, BLOCK.YELLOW_WOOL);
  bench(t, -6, -23, true, BLOCK.OAK_SLAB);
  box(-11, -10, -21, -20, 1, 1, BLOCK.BRICKS);
  box(-11, -10, -21, -20, 2, 2, BLOCK.OAK_LEAVES);
  box(-12, -12, -20, -20, 1, 2, BLOCK.WALL);
}

export const ATOMIC: FreeArenaMapDef = {
  layout: 'free',
  id: 'atomic',
  name: 'Atomic Lane',
  description: 'Two houses, a bus and a roundabout: fast, close-range chaos',
  halfX: 36,
  halfZ: 24,
  wallHeight: 13,
  wallBlock: BLOCK.OAK_LEAVES,
  floorBlock: BLOCK.GRASS,
  variants: 1,
  redSpawns: RED_SPAWNS,
  blueSpawns: RED_SPAWNS.map(turn),
  ffaSpawns: [...FFA_WEST, ...FFA_WEST.map(turn)],
  highGround: [[-22, 9], turn([-22, 9]), [-13, -5], turn([-13, -5])],
  objectives: {
    // Point symmetric like the layout: every zone has its twin turned 180° around the roundabout.
    zones: [
      { name: 'Roundabout', x: 0, z: 0, r: 5, level: 0 },
      { name: 'School Bus', x: -6.5, z: -9.5, r: 4 },
      { name: 'Moving Truck', x: 6.5, z: 9.5, r: 4 },
      { name: 'Swing Set', x: -19.5, z: -13.5, r: 4 },
      { name: 'Mint Yard', x: 19.5, z: 13.5, r: 4 },
    ],
    dominationZones: [0, 1, 2],
    // In the pool-side corner of each backyard, out of sight of the other house.
    flags: [{ team: 'red', x: -31.5, z: 18.5 }, { team: 'blue', x: 31.5, z: -18.5 }],
  },
  build(_variant, b) {
    const { box, paint } = b;

    // The road: north to south past the houses, widening into the roundabout, a dashed centre line.
    paint(-9, 8, -23, 22, BLOCK.STONE);
    for (let x = -13; x <= 12; x++) {
      for (let z = -13; z <= 12; z++) if ((x + 0.5) ** 2 + (z + 0.5) ** 2 <= 11.5 ** 2 && x > -12 && x < 11) paint(x, x, z, z, BLOCK.STONE);
    }
    for (let z = -23; z <= -14; z += 3) paint(-1, 0, z, z + 1, BLOCK.YELLOW_WOOL);
    for (let z = 13; z <= 22; z += 3) paint(-1, 0, z - 1, z, BLOCK.YELLOW_WOOL);

    homestead(b, 1, YELLOW_HOUSE);
    homestead(b, -1, MINT_HOUSE);

    // The island: grass, a hedge ring open to the north and south, a big tree with a split trunk.
    for (let x = -6; x <= 5; x++) {
      for (let z = -6; z <= 5; z++) {
        const d = Math.hypot(x + 0.5, z + 0.5);
        if (d <= 4.2) paint(x, x, z, z, BLOCK.GRASS);
        if (d >= 3.2 && d <= 4.2 && Math.abs(x + 0.5) > 1.6) box(x, x, z, z, 1, 2, BLOCK.OAK_LEAVES);
      }
    }
    box(-1, -1, 0, 0, 1, 4, BLOCK.OAK_LOG);
    box(0, 0, -1, -1, 1, 4, BLOCK.OAK_LOG);
    box(-3, 2, -2, 1, 5, 6, BLOCK.OAK_LEAVES);
    box(-2, 1, -3, 2, 5, 6, BLOCK.OAK_LEAVES);
    box(-2, 1, -2, 1, 7, 7, BLOCK.OAK_LEAVES);

    // School bus (north-west): hollow, open windows along both sides, doors on both sides and at the back.
    const Y = BLOCK.YELLOW_WOOL;
    box(-14, -3, -18, -15, 1, 3, Y);
    box(-14, -3, -18, -15, 4, 4, BLOCK.WHITE_WOOL);
    box(-2, -2, -18, -15, 1, 2, Y);
    box(-13, -4, -17, -16, 1, 3, AIR);
    for (let x = -12; x <= -5; x++) if (x % 2 === 0) box(x, x, -18, -18, 2, 3, AIR), box(x, x, -15, -15, 2, 3, AIR);
    for (const x of [-12, -10, -8, -6]) box(x, x, -17, -17, 1, 1, BLOCK.SPRUCE_SLAB);
    box(-5, -4, -15, -15, 1, 3, AIR);
    box(-10, -9, -18, -18, 1, 2, AIR);
    box(-14, -14, -17, -16, 1, 2, AIR);
    box(-3, -3, -17, -16, 2, 3, BLOCK.GLASS);
    for (const x of [-12, -5]) for (const z of [-18, -15]) box(x, x, z, z, 1, 1, C.COAL_BLOCK);
    box(-2, -2, -18, -18, 1, 1, C.SEA_LANTERN);
    box(-2, -2, -15, -15, 1, 1, C.SEA_LANTERN);
    box(-14, -14, -18, -18, 3, 3, C.REDSTONE_BLOCK);
    box(-14, -14, -15, -15, 3, 3, C.REDSTONE_BLOCK);

    // Moving truck (south-east): a cargo box open at the back with furniture inside, a side door, a cab.
    box(1, 8, 14, 17, 1, 4, BLOCK.WHITE_WOOL);
    box(1, 8, 14, 17, 3, 3, C.COPPER_BLOCK);
    box(1, 7, 15, 16, 1, 3, AIR);
    box(5, 6, 17, 17, 1, 2, AIR);
    crates(b, 6, 15, 2, 1, 2, BLOCK.SPRUCE_PLANKS);
    box(4, 4, 16, 16, 1, 1, BLOCK.GREEN_WOOL);
    box(7, 7, 16, 16, 1, 2, BLOCK.WHITE_WOOL);
    box(9, 12, 14, 17, 1, 3, C.COPPER_BLOCK);
    box(10, 11, 15, 16, 2, 2, AIR);
    box(12, 12, 15, 16, 2, 2, BLOCK.GLASS);
    box(10, 10, 14, 14, 2, 2, BLOCK.GLASS);
    box(10, 10, 17, 17, 2, 2, BLOCK.GLASS);
    for (const x of [2, 7, 11]) for (const z of [14, 17]) box(x, x, z, z, 1, 1, C.COAL_BLOCK);
    box(12, 12, 14, 14, 1, 1, C.SEA_LANTERN);
    box(12, 12, 17, 17, 1, 1, C.SEA_LANTERN);
  },
};
