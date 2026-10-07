import { BLOCK } from '../../world/BlockRegistry';
import { type FreeArenaMapDef, type LayoutBuilder, TEAM } from './ArenaMap';
import { AIR, jumpPad, turn, turned } from './helpers';
import { C, bench, hedge, mannequin } from './props';

/**
 * "Galleria": an indoor shopping mall on two floors (64 × 44) under one roof with a skylight over the
 * atrium. Each team spawns in a department store at its end (mannequins behind the display windows, a
 * stock room with the flag). Shops line both long walls downstairs; a mezzanine runs round the atrium
 * upstairs, with an arcade hall and a cinema foyer, reached by escalators and a jump pad by the
 * carousel. Shops, stock rooms and back corridors make it a good map for hiding, too.
 *
 * Three lanes: the shop corridor along each wall (downstairs, or the mezzanine above it), and the
 * atrium with the food court and the carousel through the middle. Point symmetric.
 */

interface Side {
  floor: number;
  sign: number;
  stall: number;
}

const WEST: Side = { floor: C.POLISHED_DIORITE, sign: BLOCK.YELLOW_WOOL, stall: BLOCK.YELLOW_WOOL };
const EAST: Side = { floor: C.POLISHED_DIORITE, sign: BLOCK.GREEN_WOOL, stall: BLOCK.GREEN_WOOL };

const RED_SPAWNS: [number, number][] = [[-30, -8], [-27, -5], [-30, -2], [-27, 1], [-30, 4], [-27, 8]];
const FFA_WEST: [number, number][] = [[-28, -17], [-26, 16], [-19, -13], [-19, 12], [-8, -6], [-6, 12]];

const WALL = C.CALCITE;
const ROOF = 9;

/** A shop: walls to the mezzanine (3 high), a glass front with a door, a sign over it, lights inside. */
function shop(b: LayoutBuilder, x0: number, x1: number, z0: number, z1: number, front: number, door: [number, number], sign: number, floor: number): void {
  b.box(x0, x1, z0, z1, 1, 3, WALL);
  b.box(x0 + 1, x1 - 1, z0 + 1, z1 - 1, 1, 3, AIR);
  b.paint(x0 + 1, x1 - 1, z0 + 1, z1 - 1, floor);
  b.box(x0 + 1, x1 - 1, front, front, 1, 2, BLOCK.GLASS);
  b.box(door[0], door[1], front, front, 1, 2, AIR);
  b.box(x0, x1, front, front, 3, 3, sign);
  b.box(Math.round((x0 + x1) / 2), Math.round((x0 + x1) / 2), Math.round((z0 + z1) / 2), Math.round((z0 + z1) / 2), 3, 3, BLOCK.GLOWSTONE);
}

function half(b: LayoutBuilder, s: 1 | -1, p: Side): void {
  const t = turned(b, s);
  const { box, paint } = t;

  // --- Department store (spawn): display windows with mannequins, two entrances, racks ------
  paint(-31, -25, -11, 10, BLOCK.OAK_PLANKS);
  paint(-31, -31, -2, 1, TEAM);
  box(-24, -24, -11, 10, 1, 3, BLOCK.GLASS);
  box(-24, -24, -11, 10, 4, 4, WALL);
  box(-24, -24, -11, 10, 3, 3, TEAM);
  box(-24, -24, -9, -8, 1, 2, AIR);
  box(-24, -24, 6, 7, 1, 2, AIR);
  for (const z of [-5, -2, 1, 4]) mannequin(t, -25, z, 1, z % 2 ? BLOCK.WHITE_WOOL : p.sign);
  // Clothes racks (baffles behind the entrances), a till, changing booths.
  box(-26, -26, -10, -7, 1, 2, BLOCK.SPRUCE_PLANKS);
  box(-26, -26, 5, 8, 1, 2, BLOCK.SPRUCE_PLANKS);
  box(-29, -28, -11, -11, 1, 1, C.POLISHED_ANDESITE);
  box(-31, -31, 8, 10, 1, 3, BLOCK.WHITE_WOOL);
  box(-31, -29, 10, 10, 1, 3, BLOCK.WHITE_WOOL);
  for (const z of [-7, 0, 7]) box(-28, -28, z, z, 3, 3, BLOCK.GLOWSTONE);
  box(-31, -25, -11, 10, 4, 4, WALL);
  // Upstairs over the store: an office floor (not reachable), lights on the store ceiling.
  box(-31, -25, -11, 10, 5, 8, AIR);

  // --- Stock room behind the store (flag): shelves, boxes, a forklift --------------------------
  paint(-31, -24, -21, -12, C.SMOOTH_STONE);
  box(-31, -24, -12, -12, 1, 3, WALL);
  box(-27, -26, -12, -12, 1, 2, AIR);
  box(-24, -24, -21, -13, 1, 3, WALL);
  box(-24, -24, -15, -14, 1, 2, AIR);
  box(-31, -31, -20, -14, 1, 3, BLOCK.BOOKSHELF);
  box(-29, -28, -21, -21, 1, 2, BLOCK.SPRUCE_PLANKS);
  box(-26, -25, -17, -17, 1, 2, BLOCK.SPRUCE_PLANKS);
  box(-26, -25, -20, -19, 1, 1, BLOCK.YELLOW_WOOL);
  box(-26, -26, -20, -20, 2, 3, BLOCK.IRON_BARS);
  box(-28, -28, -16, -16, 3, 3, BLOCK.GLOWSTONE);
  box(-31, -24, -21, -12, 4, 4, WALL);

  // --- North shop row (downstairs): electronics, toys, sports, with a back corridor ----------
  paint(-23, -1, -15, -11, p.floor);
  shop(t, -23, -17, -21, -16, -16, [-20, -19], BLOCK.REDSTONE_LAMP, C.SMOOTH_STONE);
  box(-22, -18, -20, -20, 1, 2, C.COAL_BLOCK);
  box(-22, -18, -20, -20, 2, 2, BLOCK.REDSTONE_LAMP);
  box(-21, -21, -18, -18, 1, 1, C.POLISHED_ANDESITE);
  shop(t, -16, -10, -21, -16, -16, [-14, -13], p.sign, BLOCK.WHITE_WOOL);
  box(-15, -15, -20, -18, 1, 2, C.LAPIS_BLOCK);
  box(-12, -11, -20, -20, 1, 1, BLOCK.YELLOW_WOOL);
  box(-11, -11, -20, -20, 2, 2, C.PUMPKIN);
  box(-13, -12, -18, -18, 1, 1, C.MELON);
  shop(t, -9, -2, -21, -16, -16, [-6, -5], BLOCK.WHITE_WOOL, C.ACACIA_PLANKS);
  box(-8, -8, -20, -17, 1, 2, BLOCK.SPRUCE_PLANKS);
  box(-4, -3, -20, -20, 1, 1, C.IRON_BLOCK);
  box(-4, -4, -20, -20, 2, 2, BLOCK.ANVIL);
  // Back door between the shops (a service corridor along the wall).
  box(-17, -17, -20, -19, 1, 2, AIR);
  box(-10, -10, -20, -19, 1, 2, AIR);

  // --- North corridor: benches, planters, a kiosk, the escalator up to the mezzanine ---------
  bench(t, -21, -12, true);
  hedge(t, -12, -11, -12, -12, 1);
  box(-12, -11, -11, -11, 1, 1, BLOCK.BRICKS);
  box(-4, -3, -13, -12, 1, 1, p.stall);
  box(-4, -3, -13, -12, 2, 2, BLOCK.GLASS);
  box(-4, -3, -13, -12, 3, 3, p.stall);
  // Escalator: three steps up westwards to a landing at the mezzanine.
  for (let i = 0; i < 3; i++) box(-15 - i, -15 - i, -13, -12, 1, i + 1, C.POLISHED_ANDESITE);
  box(-15, -15, -14, -14, 1, 1, C.IRON_BLOCK);
  box(-17, -15, -11, -11, 1, 1, C.IRON_BLOCK);

  // --- Mezzanine (upstairs) over the north shops: an arcade hall and a cinema foyer ---------
  box(-23, -1, -21, -14, 4, 4, p.floor);
  box(-23, -18, -13, -11, 4, 4, p.floor);
  // Arcade hall: game cabinets in rows, neon lights, a prize counter.
  box(-23, -12, -21, -18, 5, 7, WALL);
  box(-22, -13, -20, -18, 5, 7, AIR);
  box(-22, -13, -18, -18, 5, 6, AIR);
  for (const x of [-21, -18, -15]) {
    box(x, x, -20, -20, 5, 6, C.COAL_BLOCK);
    box(x, x, -20, -20, 6, 6, C.SEA_LANTERN);
    box(x + 1, x + 1, -20, -20, 5, 5, BLOCK.GLAZED_TERRACOTTA);
  }
  box(-13, -13, -20, -19, 5, 5, BLOCK.CHEST);
  box(-17, -17, -19, -19, 7, 7, BLOCK.GLOWSTONE);
  // Cinema foyer: a ticket booth, a popcorn stand, posters.
  box(-9, -2, -21, -21, 5, 7, C.LAPIS_BLOCK);
  box(-8, -6, -20, -20, 5, 5, C.DARK_OAK_PLANKS);
  box(-7, -7, -20, -20, 6, 6, BLOCK.GLASS);
  box(-4, -4, -19, -19, 5, 5, BLOCK.YELLOW_WOOL);
  box(-4, -4, -19, -19, 6, 6, C.SEA_LANTERN);
  box(-9, -9, -21, -21, 6, 7, p.sign);
  bench(t, -6, -16, true, BLOCK.SPRUCE_SLAB);
  // Mezzanine edge: planters to hide behind (low, so you can still shoot down into the atrium).
  box(-11, -10, -14, -14, 5, 5, BLOCK.OAK_LEAVES);
  box(-3, -2, -14, -14, 5, 5, BLOCK.OAK_LEAVES);
  box(-20, -19, -11, -11, 5, 5, BLOCK.OAK_LEAVES);

  // --- Atrium (west half): the food court with tables and a burger stall --------------------
  paint(-10, -1, -10, 9, C.POLISHED_ANDESITE);
  for (const [x, z] of [[-8, -7], [-8, 5], [-5, -4], [-7, 1]]) {
    box(x, x, z, z, 1, 1, BLOCK.OAK_SLAB);
    box(x + 1, x + 1, z, z, 1, 1, BLOCK.SPRUCE_SLAB);
  }
  // Burger stall: counter, a grill, an awning.
  box(-14, -11, 2, 4, 1, 1, C.SMOOTH_STONE);
  box(-14, -14, 2, 4, 2, 3, WALL);
  box(-13, -13, 2, 2, 1, 1, BLOCK.FURNACE);
  box(-14, -11, 2, 4, 4, 4, p.stall);
  box(-13, -12, 3, 3, 1, 1, AIR);
  // Big planter with a palm-like tree, benches round it.
  box(-15, -13, -6, -4, 1, 1, BLOCK.BRICKS);
  box(-14, -14, -5, -5, 2, 6, C.JUNGLE_LOG);
  box(-16, -12, -5, -5, 7, 7, C.JUNGLE_LEAVES);
  box(-14, -14, -7, -3, 7, 7, C.JUNGLE_LEAVES);
  bench(t, -12, -8, true);

  // --- Restrooms in the south-west corner: stalls to hide in ------------------------------
  paint(-31, -25, 12, 20, C.CALCITE);
  box(-31, -24, 11, 11, 1, 3, WALL);
  box(-24, -24, 12, 20, 1, 3, WALL);
  box(-24, -24, 13, 14, 1, 2, AIR);
  box(-29, -28, 11, 11, 1, 2, AIR);
  for (const z of [14, 17]) box(-31, -29, z, z, 1, 2, BLOCK.SPRUCE_PLANKS);
  box(-29, -29, 15, 16, 1, 2, BLOCK.SPRUCE_PLANKS);
  box(-29, -29, 18, 20, 1, 2, BLOCK.SPRUCE_PLANKS);
  box(-29, -29, 16, 16, 1, 2, AIR);
  box(-29, -29, 19, 19, 1, 2, AIR);
  box(-31, -31, 15, 15, 1, 1, C.CALCITE);
  box(-31, -31, 18, 18, 1, 1, C.CALCITE);
  box(-26, -25, 20, 20, 1, 1, C.CALCITE);
  box(-27, -27, 16, 16, 3, 3, BLOCK.GLOWSTONE);
  box(-31, -24, 11, 20, 4, 4, WALL);

  // --- South shop row (downstairs): books, a café, fashion ------------------------------------
  paint(-23, -1, 10, 14, p.floor);
  shop(t, -23, -17, 15, 20, 15, [-20, -19], C.LAPIS_BLOCK, BLOCK.OAK_PLANKS);
  box(-22, -22, 16, 19, 1, 3, BLOCK.BOOKSHELF);
  box(-19, -18, 19, 19, 1, 2, BLOCK.BOOKSHELF);
  box(-20, -20, 17, 17, 1, 1, BLOCK.SPRUCE_SLAB);
  shop(t, -16, -10, 15, 20, 15, [-13, -12], C.COPPER_BLOCK, C.DARK_OAK_PLANKS);
  box(-15, -11, 19, 19, 1, 1, C.DARK_OAK_PLANKS);
  box(-14, -14, 19, 19, 2, 2, BLOCK.FURNACE);
  for (const x of [-15, -11]) box(x, x, 17, 17, 1, 1, BLOCK.OAK_SLAB);
  shop(t, -9, -2, 15, 20, 15, [-6, -5], BLOCK.WHITE_WOOL, BLOCK.BIRCH_PLANKS);
  for (const x of [-8, -3]) mannequin(t, x, 18, 1, x < -5 ? p.sign : BLOCK.WHITE_WOOL);
  box(-6, -5, 19, 19, 1, 2, BLOCK.SPRUCE_PLANKS);
  box(-10, -10, 18, 19, 1, 2, AIR);
  box(-17, -17, 18, 19, 1, 2, AIR);
  // South corridor: a fountain bench, a phone booth, the escalator up eastwards.
  bench(t, -21, 12, true);
  box(-18, -18, 10, 10, 1, 3, BLOCK.GLASS);
  box(-18, -18, 10, 10, 3, 3, C.LAPIS_BLOCK);
  for (let i = 0; i < 3; i++) box(-12 + i, -12 + i, 11, 12, 1, i + 1, C.POLISHED_ANDESITE);
  box(-12, -10, 10, 10, 1, 1, C.IRON_BLOCK);
  // Mezzanine over the south shops: a bowling alley and a play area.
  box(-23, -1, 13, 20, 4, 4, p.floor);
  box(-9, -1, 11, 12, 4, 4, p.floor);
  box(-12, -10, 13, 13, 4, 4, AIR);
  box(-23, -12, 17, 20, 4, 4, BLOCK.BIRCH_PLANKS);
  box(-23, -23, 17, 20, 5, 5, BLOCK.WHITE_WOOL);
  box(-23, -23, 18, 18, 5, 5, AIR);
  box(-23, -23, 20, 20, 5, 5, AIR);
  box(-21, -14, 16, 16, 5, 5, C.SMOOTH_STONE);
  box(-18, -17, 16, 16, 5, 5, AIR);
  box(-13, -12, 19, 20, 5, 5, C.COAL_BLOCK);
  box(-23, -12, 21, 21, 6, 7, C.SEA_LANTERN);
  for (const [x, z] of [[-8, 16], [-6, 18], [-4, 16], [-3, 19]]) box(x, x, z, z, 5, 5, (x + z) & 1 ? BLOCK.YELLOW_WOOL : C.LAPIS_BLOCK);
  box(-7, -6, 19, 20, 5, 6, BLOCK.YELLOW_WOOL);
  box(-5, -5, 19, 20, 5, 5, BLOCK.YELLOW_WOOL);
  box(-11, -10, 14, 14, 5, 5, BLOCK.OAK_LEAVES);

  // --- More cover: kiosks and planters in the corridors, booths in the food court -------------
  box(-17, -15, -3, -1, 1, 1, C.DARK_OAK_PLANKS);
  box(-16, -16, -2, -2, 1, 2, BLOCK.GLASS);
  box(-17, -15, -3, -1, 3, 3, p.sign);
  box(-16, -16, -2, -2, 3, 3, BLOCK.GLOWSTONE);
  hedge(t, -9, -8, -13, -13, 2);
  box(-9, -8, -12, -12, 1, 1, BLOCK.BRICKS);
  hedge(t, -19, -19, 6, 7, 2);
  box(-6, -5, -9, -9, 1, 2, C.DARK_OAK_PLANKS);
  box(-6, -5, -8, -8, 1, 1, BLOCK.SPRUCE_SLAB);
  box(-3, -3, 6, 8, 1, 2, C.DARK_OAK_PLANKS);
  box(-2, -2, 6, 8, 1, 1, BLOCK.SPRUCE_SLAB);
  box(-10, -10, 7, 8, 1, 2, BLOCK.OAK_LEAVES);
  box(-22, -21, 9, 9, 1, 1, BLOCK.SPRUCE_SLAB);

  // --- West corridor from the store to the atrium -------------------------------------------
  paint(-23, -11, -10, 9, p.floor);
  box(-20, -19, -1, 0, 1, 2, BLOCK.WHITE_WOOL);
  box(-20, -19, -1, 0, 3, 3, p.sign);
  box(-21, -21, 4, 4, 1, 3, C.POLISHED_ANDESITE);
  box(-21, -21, -6, -6, 1, 3, C.POLISHED_ANDESITE);
  box(-18, -17, 6, 6, 1, 1, BLOCK.SPRUCE_SLAB);

  // A jump pad in the corridor up onto the mezzanine.
  jumpPad(t, -7, -12);
}

export const MALL: FreeArenaMapDef = {
  layout: 'free',
  id: 'mall',
  name: 'Galleria',
  description: 'An indoor mall on two floors: shops, an arcade, a food court and a carousel under a skylight',
  halfX: 32,
  halfZ: 22,
  wallHeight: 13,
  wallBlock: WALL,
  floorBlock: C.POLISHED_DIORITE,
  variants: 1,
  redSpawns: RED_SPAWNS,
  blueSpawns: RED_SPAWNS.map(turn),
  ffaSpawns: [...FFA_WEST, ...FFA_WEST.map(turn)],
  objectives: {
    zones: [
      { name: 'Carousel', x: 0, z: 0, r: 5, level: 0 },
      { name: 'Burger Bar', x: -8.5, z: -1.5, r: 4, level: 0 },
      { name: 'Noodle Bar', x: 8.5, z: 1.5, r: 4, level: 0 },
      { name: 'Cinema Foyer', x: -6.5, z: -15.5, r: 4, level: 4 },
      { name: 'Box Office', x: 6.5, z: 15.5, r: 4, level: 4 },
    ],
    dominationZones: [0, 1, 2],
    flags: [{ team: 'red', x: -27.5, z: -15.5, level: 0 }, { team: 'blue', x: 27.5, z: 15.5, level: 0 }],
  },
  build(_variant, b) {
    const { box } = b;
    half(b, 1, WEST);
    half(b, -1, EAST);

    // The roof: solid over the shops, a glass skylight over the atrium.
    box(-31, 30, -21, 20, ROOF, ROOF, WALL);
    box(-10, 9, -10, 9, ROOF, ROOF, BLOCK.GLASS);
    for (let x = -10; x <= 9; x += 5) box(x, x, -10, 9, ROOF, ROOF, WALL);
    for (const s of [1, -1] as const) {
      const t = turned(b, s);
      for (let x = -30; x <= -2; x += 4) for (const z of [-19, -15, -11, 11, 15, 19]) t.box(x, x, z, z, ROOF, ROOF, BLOCK.GLOWSTONE);
      for (let x = -30; x <= -14; x += 4) for (const z of [-7, -3, 1, 5]) t.box(x, x, z, z, ROOF, ROOF, BLOCK.GLOWSTONE);
    }

    // The carousel: a centre post (split in two), a canopy, horses on poles round it.
    box(-1, -1, 0, 0, 1, 4, C.GOLD_BLOCK);
    box(0, 0, -1, -1, 1, 4, C.GOLD_BLOCK);
    for (let x = -4; x <= 3; x++) for (let z = -4; z <= 3; z++) if (Math.hypot(x + 0.5, z + 0.5) <= 4.3) box(x, x, z, z, 5, 5, (x + z) & 1 ? BLOCK.WHITE_WOOL : BLOCK.YELLOW_WOOL);
    box(-2, 1, -2, 1, 6, 6, BLOCK.WHITE_WOOL);
    box(-1, 0, -1, 0, 7, 7, C.GOLD_BLOCK);
    for (const [x, z] of [[-4, -1], [3, 0], [-1, 3], [0, -4]]) {
      box(x, x, z, z, 1, 1, BLOCK.WHITE_WOOL);
      box(x, x, z, z, 2, 4, BLOCK.FENCE);
    }
  },
};
