import { BLOCK } from '../../world/BlockRegistry';
import { type FreeArenaMapDef, type LayoutBuilder, TEAM } from './ArenaMap';
import { AIR, turn, turned } from './helpers';
import { C, bench, car, crates, hedge, lamp, mannequin, tree, umbrella } from './props';

/**
 * "Fountain Square": a small downtown square (68 × 48) around a big tiered fountain. Each team spawns in
 * the forecourt of its own block: a two-storey hotel (lobby downstairs, suites upstairs with a balcony
 * over the square) and a café with a roof terrace, joined over the forecourt gate by a footbridge.
 *
 * Three lanes: the tram street along one side (a tram at its stop, taxis, a news kiosk), the square with
 * the fountain, café terraces and planters in the middle, and a shop arcade along the other side whose
 * flat roof is a raised walkway from the café terrace to the square. Point symmetric: the tram street of
 * one team is the arcade of the other, so every lane has a bit of both.
 */

interface Side {
  hotel: number;
  /** Lobby carpet, sofas and the kiosk. */
  rug: number;
  sofa: number;
  kiosk: number;
  trim: number;
  awning: number;
  taxi: number;
  car: number;
  tile: number;
}

const WEST: Side = { hotel: C.TERRACOTTA, rug: C.MANGROVE_PLANKS, sofa: BLOCK.GREEN_WOOL, kiosk: BLOCK.GREEN_WOOL, trim: C.CALCITE, awning: BLOCK.YELLOW_WOOL, taxi: BLOCK.YELLOW_WOOL, car: C.CHERRY_PLANKS, tile: C.POLISHED_GRANITE };
const EAST: Side = { hotel: BLOCK.BRICKS, rug: BLOCK.WHITE_WOOL, sofa: C.COPPER_BLOCK, kiosk: C.LAPIS_BLOCK, trim: C.CALCITE, awning: BLOCK.GREEN_WOOL, taxi: BLOCK.YELLOW_WOOL, car: C.LAPIS_BLOCK, tile: C.POLISHED_DIORITE };

const RED_SPAWNS: [number, number][] = [[-31, -11], [-29, -7], [-32, -4], [-31, 4], [-29, 8], [-30, 12]];
const FFA_WEST: [number, number][] = [[-31, -17], [-31, 19], [-21, 0], [-13, -11], [-6, 20], [-9, 4]];

function half(b: LayoutBuilder, s: 1 | -1, p: Side): void {
  const t = turned(b, s);
  const { box, paint } = t;

  // --- Forecourt (spawn): paving, a wall with two gates to the lanes, a hedge baffle at the arch --
  paint(-33, -27, -14, 13, p.tile);
  paint(-33, -33, -3, 2, TEAM);
  box(-33, -27, -15, -15, 1, 2, BLOCK.STONE_BRICKS);
  box(-33, -27, 14, 14, 1, 2, BLOCK.STONE_BRICKS);
  box(-33, -27, -15, -15, 3, 3, BLOCK.STONE_BRICK_SLAB);
  box(-33, -27, 14, 14, 3, 3, BLOCK.STONE_BRICK_SLAB);
  box(-31, -30, -15, -15, 1, 3, AIR);
  box(-32, -31, 14, 14, 1, 3, AIR);
  hedge(t, -28, -28, -2, 2, 2);
  box(-28, -28, -3, -3, 1, 2, C.CALCITE);
  box(-28, -28, 3, 3, 1, 2, C.CALCITE);
  for (const z of [-12, 11]) {
    box(-33, -32, z, z, 1, 1, BLOCK.BRICKS);
    box(-33, -32, z, z, 2, 2, BLOCK.OAK_LEAVES);
  }
  bench(t, -33, -8, false, BLOCK.SPRUCE_SLAB);
  bench(t, -33, 6, false, BLOCK.SPRUCE_SLAB);
  lamp(t, -27, -13, 4);
  lamp(t, -27, 12, 4);

  // --- The hotel: two storeys over the north-west block --------------------------------------
  box(-26, -16, -14, -4, 1, 7, p.hotel);
  box(-26, -16, -14, -4, 4, 4, p.trim);
  for (const [x, z] of [[-26, -14], [-16, -14], [-26, -4], [-16, -4]]) box(x, x, z, z, 1, 8, p.trim);
  box(-25, -17, -13, -5, 1, 3, AIR);
  box(-25, -17, -13, -5, 5, 7, AIR);
  box(-25, -17, -13, -5, 4, 4, BLOCK.SPRUCE_PLANKS);
  box(-27, -15, -15, -3, 8, 8, p.trim);
  box(-26, -16, -14, -4, 9, 9, p.hotel);
  box(-25, -17, -13, -5, 9, 9, AIR);
  paint(-25, -17, -13, -5, BLOCK.BIRCH_PLANKS);
  paint(-22, -19, -11, -7, p.rug);
  // Doors: revolving front door to the square, a door to the forecourt, one to the tram street.
  box(-16, -16, -10, -8, 1, 3, AIR);
  box(-15, -15, -11, -7, 4, 4, p.awning);
  box(-26, -26, -13, -12, 1, 2, AIR);
  box(-22, -21, -14, -14, 1, 2, AIR);
  box(-23, -20, -14, -14, 3, 3, p.awning);
  // Windows: ground floor glass, upstairs open windows over the tram street and the square.
  for (const z of [-13, -12, -6, -5]) box(-16, -16, z, z, 2, 2, BLOCK.GLASS);
  box(-25, -24, -14, -14, 2, 2, BLOCK.GLASS);
  box(-19, -18, -14, -14, 2, 2, BLOCK.GLASS);
  box(-24, -23, -14, -14, 5, 6, AIR);
  box(-19, -18, -14, -14, 5, 6, AIR);
  box(-26, -26, -11, -10, 5, 6, BLOCK.GLASS);
  // Lobby: reception desk, sofas, a lift, plants, chandeliers.
  box(-24, -21, -6, -6, 1, 1, C.POLISHED_DIORITE);
  box(-24, -24, -6, -5, 1, 1, C.POLISHED_DIORITE);
  box(-25, -25, -9, -8, 1, 3, C.IRON_BLOCK);
  box(-19, -18, -12, -12, 1, 1, p.sofa);
  box(-18, -18, -12, -11, 1, 1, p.sofa);
  box(-17, -17, -5, -5, 1, 1, BLOCK.BRICKS);
  box(-17, -17, -5, -5, 2, 2, BLOCK.OAK_LEAVES);
  for (const [x, z] of [[-21, -9], [-18, -6], [-24, -9]]) box(x, x, z, z, 4, 4, BLOCK.GLOWSTONE);
  // Grand stair along the south wall of the lobby, up to the suites.
  box(-25, -25, -6, -5, 1, 1, BLOCK.SPRUCE_PLANKS);
  box(-24, -24, -5, -5, 1, 1, AIR);
  for (let i = 0; i < 3; i++) box(-22 + i, -22 + i, -5, -5, 1, i + 1, BLOCK.SPRUCE_PLANKS);
  box(-22, -20, -5, -5, 4, 4, AIR);
  box(-22, -20, -6, -6, 5, 5, BLOCK.FENCE);
  box(-24, -21, -6, -6, 1, 1, C.POLISHED_DIORITE);
  // Suites: a wall with a door, beds, a bath, the balcony door.
  box(-21, -21, -13, -7, 5, 7, p.hotel);
  box(-21, -21, -10, -9, 5, 6, AIR);
  box(-25, -24, -13, -12, 5, 5, BLOCK.BED);
  box(-19, -18, -13, -12, 5, 5, BLOCK.BED);
  box(-25, -25, -8, -7, 5, 5, C.CALCITE);
  box(-17, -17, -13, -13, 5, 6, C.DARK_OAK_PLANKS);
  mannequin(t, -17, -7, 5, p.awning);
  for (const [x, z] of [[-23, -10], [-18, -10]]) box(x, x, z, z, 8, 8, BLOCK.GLOWSTONE);
  // Balcony over the square: a door, a slab floor and a railing.
  box(-16, -16, -12, -10, 5, 6, AIR);
  box(-15, -14, -13, -9, 4, 4, C.SMOOTH_STONE);
  box(-14, -14, -13, -9, 5, 5, BLOCK.FENCE);
  box(-15, -15, -13, -13, 5, 5, BLOCK.FENCE);
  box(-15, -15, -9, -9, 5, 5, BLOCK.FENCE);
  box(-14, -14, -11, -11, 5, 5, AIR);

  // --- Footbridge over the forecourt gate, from the hotel suites to the café roof -------------
  box(-24, -21, -3, 3, 4, 4, p.trim);
  box(-24, -24, -3, 3, 5, 5, BLOCK.FENCE);
  box(-21, -21, -3, 3, 5, 5, BLOCK.FENCE);
  box(-23, -22, -4, -4, 5, 6, AIR);
  for (const z of [-3, 3]) box(-24, -21, z, z, 1, 3, p.trim), box(-23, -22, z, z, 1, 3, AIR);
  paint(-26, -17, -3, 3, C.SMOOTH_STONE);

  // --- The café: one storey, a counter and tables, a roof terrace reached by an outside stair ---
  box(-26, -18, 4, 13, 1, 3, p.hotel);
  box(-25, -19, 5, 12, 1, 3, AIR);
  box(-26, -18, 4, 13, 4, 4, p.trim);
  paint(-25, -19, 5, 12, BLOCK.OAK_PLANKS);
  box(-18, -18, 6, 7, 1, 2, AIR);
  box(-18, -18, 10, 11, 1, 2, AIR);
  box(-18, -18, 8, 9, 2, 2, BLOCK.GLASS);
  box(-17, -17, 5, 12, 3, 3, p.awning);
  box(-22, -21, 13, 13, 1, 2, AIR);
  box(-26, -26, 9, 10, 2, 2, BLOCK.GLASS);
  box(-25, -25, 6, 11, 1, 1, C.SMOOTH_STONE);
  box(-25, -25, 7, 7, 1, 1, BLOCK.FURNACE);
  box(-25, -25, 6, 6, 2, 2, BLOCK.BOOKSHELF);
  box(-23, -23, 6, 11, 1, 1, C.DARK_OAK_PLANKS);
  box(-23, -23, 8, 9, 1, 1, AIR);
  for (const z of [6, 10]) box(-20, -20, z, z, 1, 1, BLOCK.SPRUCE_PLANKS);
  box(-22, -22, 8, 8, 3, 3, BLOCK.GLOWSTONE);
  // Roof terrace: a railing, two umbrellas, planters; the stair runs up the forecourt side.
  box(-26, -18, 4, 4, 5, 5, BLOCK.FENCE);
  box(-18, -18, 4, 13, 5, 5, BLOCK.FENCE);
  box(-18, -18, 8, 9, 5, 5, AIR);
  box(-26, -26, 4, 7, 5, 5, BLOCK.FENCE);
  box(-24, -21, 4, 4, 5, 5, AIR);
  umbrella(t, -21, 7, p.awning === BLOCK.YELLOW_WOOL ? BLOCK.WHITE_WOOL : p.awning);
  for (let i = 0; i < 3; i++) box(-27, -27, 12 - i, 12 - i, 1, i + 1, C.CALCITE);
  box(-27, -27, 13, 13, 1, 1, C.CALCITE);
  box(-25, -24, 12, 12, 5, 5, BLOCK.OAK_LEAVES);

  // --- Café terrace on the square: umbrellas, tables, a low hedge -------------------------
  paint(-17, -13, 4, 13, C.POLISHED_ANDESITE);
  umbrella(t, -15, 6, p.awning);
  umbrella(t, -15, 11, BLOCK.WHITE_WOOL);
  hedge(t, -13, -13, 4, 6, 1);
  hedge(t, -13, -13, 10, 13, 1);
  box(-17, -16, 9, 9, 1, 1, BLOCK.SPRUCE_SLAB);

  // --- Shop arcade along the south lane: a colonnade with a walkable roof -----------------
  box(-26, -3, 14, 18, 4, 4, p.trim);
  for (let x = -26; x <= -3; x += 4) box(x, x, 18, 18, 1, 3, C.POLISHED_DIORITE);
  box(-26, -3, 14, 14, 1, 3, p.hotel);
  for (let x = -24; x <= -5; x += 4) box(x, x + 1, 14, 14, 1, 2, BLOCK.GLASS);
  box(-25, -3, 15, 17, 1, 3, AIR);
  box(-26, -3, 18, 18, 5, 5, BLOCK.FENCE);
  for (let x = -25; x <= -5; x += 4) box(x, x + 1, 18, 18, 5, 5, AIR);
  paint(-26, -3, 15, 22, C.POLISHED_ANDESITE);
  // Shop fronts: a bakery stall, a flower stall, a newsstand under the arcade.
  box(-23, -22, 15, 15, 1, 1, C.HAY);
  box(-16, -15, 15, 15, 1, 1, C.MOSS);
  box(-16, -15, 15, 15, 2, 2, BLOCK.OAK_LEAVES);
  box(-9, -8, 15, 15, 1, 2, BLOCK.BOOKSHELF);
  for (const x of [-22, -14, -6]) box(x, x, 16, 16, 3, 3, BLOCK.GLOWSTONE);
  // The roof walk: reached from the café terrace, a flower box and a lamp at the far end.
  box(-18, -17, 13, 13, 4, 4, p.trim);
  box(-4, -3, 15, 15, 5, 5, BLOCK.OAK_LEAVES);
  // Street furniture in the lane outside the arcade.
  bench(t, -20, 21, true, BLOCK.SPRUCE_SLAB);
  lamp(t, -12, 21, 4);
  crates(t, -26, 20, 2, 2, 2, BLOCK.SPRUCE_PLANKS);
  box(-25, -25, 19, 19, 1, 1, BLOCK.WALL);

  // --- Tram street (north lane): a stop with a shelter, taxis, a news kiosk ----------------
  paint(-26, -1, -23, -15, BLOCK.STONE);
  paint(-26, -1, -16, -16, C.SMOOTH_STONE);
  paint(-26, -1, -21, -21, C.IRON_BLOCK);
  paint(-26, -1, -19, -19, C.IRON_BLOCK);
  car(t, -20, -23, true, p.taxi);
  box(-18, -18, -22, -22, 3, 3, BLOCK.WHITE_WOOL);
  // Shelter: glass back wall, a roof, a bench.
  box(-18, -14, -17, -17, 1, 3, BLOCK.GLASS);
  box(-18, -18, -17, -17, 1, 3, C.IRON_BLOCK);
  box(-14, -14, -17, -17, 1, 3, C.IRON_BLOCK);
  box(-18, -14, -18, -17, 4, 4, p.trim);
  bench(t, -17, -18, true, BLOCK.SPRUCE_SLAB);
  // News kiosk: a little hut with a counter.
  box(-27, -25, -22, -19, 1, 3, p.kiosk);
  box(-26, -26, -21, -20, 1, 2, AIR);
  box(-25, -25, -21, -20, 2, 2, AIR);
  box(-25, -25, -21, -20, 1, 1, BLOCK.BOOKSHELF);
  box(-28, -24, -23, -18, 4, 4, p.awning);
  lamp(t, -13, -16, 4);
  hedge(t, -4, -2, -16, -16, 2);

  // The tram at its stop: open windows, doors on both sides, seats, a pantograph on the roof.
  box(-12, -1, -22, -19, 1, 1, C.COPPER_BLOCK);
  box(-12, -1, -22, -19, 2, 3, C.CALCITE);
  box(-12, -1, -22, -19, 4, 4, C.CALCITE);
  box(-11, -2, -21, -20, 1, 3, AIR);
  for (let x = -11; x <= -2; x++) if (x % 2 !== 0) box(x, x, -22, -22, 2, 3, AIR), box(x, x, -19, -19, 2, 3, AIR);
  box(-9, -8, -19, -19, 1, 3, AIR);
  box(-4, -3, -19, -19, 1, 3, AIR);
  box(-7, -6, -22, -22, 1, 2, AIR);
  for (const x of [-10, -5]) box(x, x, -21, -21, 1, 1, BLOCK.SPRUCE_SLAB);
  box(-12, -12, -21, -20, 2, 3, BLOCK.GLASS);
  box(-1, -1, -21, -20, 2, 3, BLOCK.GLASS);
  box(-7, -6, -21, -20, 5, 5, BLOCK.FENCE);
  box(-8, -5, -21, -21, 6, 6, C.IRON_BLOCK);
  box(-12, -12, -22, -22, 1, 1, C.SEA_LANTERN);
  box(-12, -12, -19, -19, 1, 1, C.SEA_LANTERN);

  // --- The square: planters with trees, benches, lamps, a statue on a plinth --------------
  paint(-16, -1, -14, 13, p.tile);
  for (let x = -16; x <= -1; x += 3) paint(x, x, -14, 13, C.SMOOTH_STONE);
  box(-12, -10, -10, -8, 1, 1, BLOCK.STONE_BRICKS);
  tree(t, -11, -9, BLOCK.OAK_LOG, BLOCK.OAK_LEAVES, 3, 2);
  box(-8, -6, 6, 8, 1, 1, BLOCK.STONE_BRICKS);
  tree(t, -7, 7, C.CHERRY_LOG, C.CHERRY_LEAVES, 3, 1);
  bench(t, -8, -6, true, BLOCK.SPRUCE_SLAB);
  box(-12, -12, 1, 2, 1, 2, BLOCK.STONE_BRICKS);
  box(-12, -12, 1, 1, 3, 4, C.POLISHED_ANDESITE);
  hedge(t, -12, -12, -3, -2, 2);
  lamp(t, -3, -11, 5);
  lamp(t, -15, -1, 4);
  car(t, -6, -13, true, p.car);
  crates(t, -4, 10, 2, 1, 2, BLOCK.OAK_PLANKS);
  box(-4, -4, 9, 9, 1, 1, BLOCK.OAK_PLANKS);
}

export const PLAZA: FreeArenaMapDef = {
  layout: 'free',
  id: 'plaza',
  name: 'Fountain Square',
  description: 'Downtown square: a tiered fountain, a hotel, café terraces, a tram stop and a shop arcade',
  halfX: 34,
  halfZ: 24,
  wallHeight: 13,
  wallBlock: BLOCK.BRICKS,
  floorBlock: C.SMOOTH_STONE,
  variants: 1,
  redSpawns: RED_SPAWNS,
  blueSpawns: RED_SPAWNS.map(turn),
  ffaSpawns: [...FFA_WEST, ...FFA_WEST.map(turn)],
  highGround: [[-14, -11], turn([-14, -11]), [-22, 8], turn([-22, 8]), [-10, 16], turn([-10, 16]), [-22, 0], turn([-22, 0])],
  objectives: {
    zones: [
      { name: 'Fountain', x: 0, z: 0, r: 5, level: 0 },
      { name: 'Tram Stop', x: -8.5, z: -16.5, r: 4, level: 0 },
      { name: 'Tram Depot', x: 8.5, z: 16.5, r: 4, level: 0 },
      { name: 'Café Terrace', x: -14.5, z: 1.5, r: 4 },
      { name: 'Hotel Steps', x: 14.5, z: -1.5, r: 4 },
    ],
    dominationZones: [0, 1, 2],
    flags: [{ team: 'red', x: -30.5, z: -20.5 }, { team: 'blue', x: 30.5, z: 20.5 }],
  },
  build(_variant, b) {
    const { box, paint } = b;
    half(b, 1, WEST);
    half(b, -1, EAST);

    // The fountain: an outer basin, an inner tier on two pillars, a gold statue and a spout.
    for (let x = -7; x <= 6; x++) {
      for (let z = -7; z <= 6; z++) {
        const d = Math.hypot(x + 0.5, z + 0.5);
        if (d <= 5.9) paint(x, x, z, z, d >= 5 ? C.CALCITE : C.LAPIS_BLOCK);
        if (d >= 5 && d <= 5.9) box(x, x, z, z, 1, 1, C.POLISHED_DIORITE);
        if (d >= 1.6 && d <= 2.4) box(x, x, z, z, 1, 1, C.CALCITE);
      }
    }
    // Gaps in the basin rim where the paths come in.
    for (const [x, z] of [[-6, -1], [-6, 0], [5, -1], [5, 0], [-1, -6], [0, -6], [-1, 5], [0, 5]]) box(x, x, z, z, 1, 1, AIR);
    box(-1, -1, 0, 0, 1, 4, C.CALCITE);
    box(0, 0, -1, -1, 1, 4, C.CALCITE);
    box(-2, 1, -2, 1, 5, 5, C.POLISHED_DIORITE);
    box(-1, 0, -1, 0, 6, 6, C.GOLD_BLOCK);
    box(-1, 0, -1, 0, 7, 7, C.SEA_LANTERN);
    paint(-1, 0, -1, 0, C.SEA_LANTERN);
  },
};
