import { BLOCK } from '../../world/BlockRegistry';
import { type FreeArenaMapDef, type LayoutBuilder, TEAM } from './ArenaMap';
import { AIR, turn, turned } from './helpers';
import { C, crates, mannequin, steps } from './props';

/**
 * "Flight Deck": the flight deck of a carrier at sea (72 × 40). Each team spawns in the hangar at its
 * end of the deck; each has an island (the ship's tower) at the deck edge, with a bridge on the upper
 * floor whose open windows look over the deck, and a radar mast on top.
 *
 * Three lanes: the island lane along one edge (a row of jets with folded wings parked under the island),
 * the landing area through the middle (arresting wires, two jets on the catapults, tractors and munition
 * carts), and the elevator lane along the other edge, where a raised aircraft elevator with a helicopter
 * on it is the high ground. Point symmetric: one team's island lane is the other team's elevator lane.
 */

interface Side {
  tail: number;
  heli: number;
  vest: number;
  tractor: number;
}

const WEST: Side = { tail: BLOCK.YELLOW_WOOL, heli: BLOCK.GREEN_WOOL, vest: BLOCK.YELLOW_WOOL, tractor: BLOCK.YELLOW_WOOL };
const EAST: Side = { tail: BLOCK.GREEN_WOOL, heli: C.EMERALD_BLOCK, vest: BLOCK.GREEN_WOOL, tractor: BLOCK.WHITE_WOOL };

const RED_SPAWNS: [number, number][] = [[-34, -7], [-31, -5], [-34, -1], [-31, 2], [-34, 5], [-31, 7]];
const FFA_WEST: [number, number][] = [[-31, -16], [-33, 16], [-22, 1], [-11, -11], [-25, 10], [-5, 7]];

const DECK = C.POLISHED_DEEPSLATE;
const HULL = C.TUFF;
const GREY = C.POLISHED_ANDESITE;
const LIGHT = C.SMOOTH_STONE;

/**
 * A fighter jet, nose towards -x when `dir` is -1 (+x for 1), centred on row z: fuselage, glass canopy,
 * wings (folded when `folded`: two short stubs standing up), tail fins in the side's colour.
 */
function jet(b: LayoutBuilder, x: number, z: number, dir: 1 | -1, tail: number, folded = false): void {
  const X = (i: number) => x + dir * i;
  b.box(X(0), X(8), z, z, 1, 2, GREY);
  b.box(X(1), X(6), z - 1, z + 1, 1, 1, GREY);
  b.box(X(0), X(0), z, z, 1, 1, LIGHT);
  b.box(X(1), X(2), z, z, 3, 3, BLOCK.GLASS);
  if (folded) {
    b.box(X(4), X(5), z - 2, z - 2, 2, 3, LIGHT);
    b.box(X(4), X(5), z + 2, z + 2, 2, 3, LIGHT);
  } else {
    b.box(X(4), X(6), z - 3, z + 3, 2, 2, LIGHT);
    b.box(X(5), X(6), z - 4, z + 4, 2, 2, LIGHT);
  }
  b.box(X(7), X(8), z - 1, z - 1, 3, 4, tail);
  b.box(X(7), X(8), z + 1, z + 1, 3, 4, tail);
  b.box(X(8), X(8), z, z, 2, 2, C.COAL_BLOCK);
}

function half(b: LayoutBuilder, s: 1 | -1, p: Side): void {
  const t = turned(b, s);
  const { box, paint } = t;

  // --- Deck markings: the landing area's lines, a catapult track, the foul line ----------------
  paint(-35, -1, -1, 0, BLOCK.WHITE_WOOL);
  for (let x = -26; x <= -2; x += 4) paint(x, x + 1, -6, -6, BLOCK.YELLOW_WOOL);
  paint(-26, -3, 6, 6, BLOCK.YELLOW_WOOL);
  for (const x of [-6, -4]) paint(x, x, -10, 9, C.COAL_BLOCK);
  paint(-35, -2, -11, -11, BLOCK.WHITE_WOOL);

  // --- The hangar (spawn): walls with two openings and baffles, a jet under maintenance -------
  box(-35, -27, -10, 9, 1, 4, HULL);
  box(-34, -28, -9, 8, 1, 4, AIR);
  box(-35, -27, -10, 9, 5, 5, DECK);
  box(-27, -27, -10, 9, 4, 4, TEAM);
  paint(-34, -28, -9, 8, LIGHT);
  paint(-34, -34, -3, 2, TEAM);
  box(-27, -27, -8, -6, 1, 3, AIR);
  box(-27, -27, 5, 7, 1, 3, AIR);
  box(-29, -29, -9, -6, 1, 3, GREY);
  box(-29, -29, 4, 8, 1, 3, GREY);
  for (const [x, z] of [[-31, -3], [-31, 2], [-33, -9], [-33, 8]]) box(x, x, z, z, 4, 4, BLOCK.GLOWSTONE);
  // Tool cabinets and a missile rack along the walls.
  box(-34, -34, -9, -8, 1, 2, BLOCK.REDSTONE_LAMP);
  box(-34, -33, 7, 8, 1, 1, BLOCK.TNT);
  box(-34, -33, 7, 8, 2, 2, BLOCK.IRON_BARS);
  box(-31, -30, -9, -9, 1, 2, BLOCK.CHEST);

  // --- The island: two floors, a bridge with open windows, a radar mast ---------------------
  box(-23, -15, -19, -13, 1, 7, GREY);
  box(-22, -16, -18, -14, 1, 3, AIR);
  box(-22, -16, -18, -14, 5, 7, AIR);
  box(-22, -16, -18, -14, 4, 4, DECK);
  box(-24, -14, -20, -12, 8, 8, GREY);
  box(-23, -15, -19, -13, 4, 4, LIGHT);
  // Doors on both deck sides, a hatch to the elevator stair.
  box(-20, -19, -13, -13, 1, 3, AIR);
  box(-23, -23, -16, -15, 1, 2, AIR);
  box(-15, -15, -16, -15, 1, 2, AIR);
  // Inside: a stair to the bridge (three steps and a hole), consoles, lockers.
  box(-22, -22, -18, -18, 1, 1, LIGHT);
  box(-21, -21, -18, -18, 1, 2, LIGHT);
  box(-20, -20, -18, -18, 1, 3, LIGHT);
  box(-22, -20, -18, -18, 4, 4, AIR);
  box(-22, -21, -17, -17, 5, 5, BLOCK.FENCE);
  box(-16, -16, -18, -17, 1, 2, C.IRON_BLOCK);
  box(-18, -17, -14, -14, 1, 1, BLOCK.CRAFTING_TABLE);
  box(-19, -19, -16, -16, 3, 3, BLOCK.GLOWSTONE);
  // The bridge: windows all round the deck side, consoles, the captain's chair.
  box(-22, -16, -13, -13, 5, 6, AIR);
  box(-23, -23, -17, -14, 6, 6, AIR);
  box(-15, -15, -17, -14, 6, 6, AIR);
  for (const x of [-21, -18]) box(x, x, -14, -14, 5, 5, BLOCK.REDSTONE_LAMP);
  box(-17, -17, -16, -16, 5, 5, BLOCK.SPRUCE_STAIRS);
  box(-19, -19, -16, -16, 7, 7, BLOCK.GLOWSTONE);
  // Radar mast and antenna.
  box(-19, -19, -16, -16, 9, 10, BLOCK.FENCE);
  box(-21, -17, -16, -16, 10, 10, LIGHT);
  box(-22, -22, -18, -18, 9, 9, BLOCK.IRON_BARS);
  box(-16, -16, -14, -14, 9, 9, BLOCK.REDSTONE_LAMP);

  // --- Island lane: jets with folded wings parked in a row, chocks, a fuel cart ---------------
  jet(t, -11, -17, -1, p.tail, true);
  jet(t, -2, -16, 1, p.tail, true);
  box(-12, -12, -19, -18, 1, 1, BLOCK.YELLOW_WOOL);
  box(-25, -25, -11, -11, 1, 2, GREY);
  crates(t, -27, -17, 2, 2, 2, LIGHT);
  box(-27, -26, -17, -16, 3, 3, BLOCK.IRON_BARS);
  mannequin(t, -13, -13, 1, p.vest);

  // --- Landing area: a jet on the catapult, a tractor, munition carts -----------------------
  jet(t, -13, -5, 1, p.tail);
  box(-7, -5, 3, 4, 1, 1, p.tractor);
  box(-6, -6, 3, 4, 2, 2, BLOCK.GLASS);
  box(-5, -5, 3, 4, 2, 2, p.tractor);
  box(-8, -8, 3, 4, 1, 1, C.COAL_BLOCK);
  box(-17, -16, 4, 5, 1, 1, GREY);
  box(-17, -16, 4, 5, 2, 2, BLOCK.TNT);
  box(-14, -13, 7, 7, 1, 1, GREY);
  box(-14, -13, 7, 7, 2, 2, BLOCK.TNT);
  // Jet blast deflector behind the catapult: a raised steel panel, cover for the middle.
  box(-23, -23, -8, -3, 1, 3, C.IRON_BLOCK);
  box(-24, -24, -8, -3, 1, 2, GREY);
  mannequin(t, -9, -1, 1, p.vest);
  // Crash crane parked by the wires: a heavy body, a cab and its boom with the hook.
  box(-10, -7, 0, 2, 1, 2, p.tractor);
  box(-10, -10, 0, 2, 1, 1, C.COAL_BLOCK);
  box(-7, -7, 0, 2, 1, 1, C.COAL_BLOCK);
  box(-9, -9, 1, 1, 3, 3, BLOCK.GLASS);
  box(-8, -8, 1, 1, 3, 4, p.tractor);
  box(-7, -5, 1, 1, 5, 5, p.tractor);
  box(-5, -5, 1, 1, 4, 4, BLOCK.FENCE);
  // Munition carts and chocks across the landing area.
  box(-3, -2, -5, -4, 1, 1, GREY);
  box(-3, -2, -5, -4, 2, 2, BLOCK.TNT);
  box(-20, -19, 9, 10, 1, 1, GREY);
  box(-20, -20, 9, 10, 2, 2, LIGHT);
  box(-12, -11, 9, 9, 1, 2, C.REDSTONE_BLOCK);
  box(-18, -18, -10, -9, 1, 1, BLOCK.YELLOW_WOOL);
  box(-3, -2, -9, -9, 1, 1, LIGHT);

  // --- Elevator lane: a raised aircraft elevator with a helicopter on it, steps up -----------
  box(-22, -9, 12, 18, 1, 2, DECK);
  box(-22, -9, 12, 12, 2, 2, BLOCK.YELLOW_WOOL);
  steps(t, -24, 14, 1, 0, 2, 3, GREY);
  steps(t, -7, 15, -1, 0, 2, 3, GREY);
  // The helicopter: fuselage, glass nose, tail boom, rotor on a mast.
  box(-19, -14, 14, 16, 3, 5, p.heli);
  box(-18, -15, 15, 15, 3, 4, AIR);
  box(-15, -15, 14, 14, 3, 4, AIR);
  box(-19, -19, 14, 16, 4, 4, BLOCK.GLASS);
  box(-13, -9, 15, 15, 4, 4, GREY);
  box(-9, -9, 15, 15, 5, 6, p.tail);
  box(-17, -17, 15, 15, 6, 6, BLOCK.FENCE);
  box(-21, -13, 15, 15, 7, 7, LIGHT);
  box(-17, -17, 11, 19, 7, 7, LIGHT);
  // Deck edge clutter: life rafts, a firefighting cart, the LSO's platform.
  box(-30, -28, 17, 18, 1, 1, BLOCK.WHITE_WOOL);
  box(-30, -30, 17, 18, 2, 2, C.COPPER_BLOCK);
  box(-4, -2, 12, 12, 1, 1, C.REDSTONE_BLOCK);
  box(-3, -3, 12, 12, 2, 2, BLOCK.WHITE_WOOL);
  box(-35, -33, 11, 13, 1, 1, LIGHT);
  box(-35, -35, 11, 13, 2, 2, BLOCK.IRON_BARS);
}

export const CARRIER: FreeArenaMapDef = {
  layout: 'free',
  id: 'carrier',
  name: 'Flight Deck',
  description: 'A carrier deck at sea: jets on the catapults, two islands with bridges, a raised elevator',
  halfX: 36,
  halfZ: 20,
  wallHeight: 13,
  wallBlock: LIGHT,
  floorBlock: DECK,
  variants: 1,
  redSpawns: RED_SPAWNS,
  blueSpawns: RED_SPAWNS.map(turn),
  ffaSpawns: [...FFA_WEST, ...FFA_WEST.map(turn)],
  highGround: [[-12, 13], turn([-12, 13]), [-22, 17], turn([-22, 17])],
  objectives: {
    zones: [
      { name: 'Wires', x: 0, z: 0, r: 5, level: 0 },
      { name: 'Bow Catapult', x: -17.5, z: 0.5, r: 4 },
      { name: 'Stern Catapult', x: 17.5, z: -0.5, r: 4 },
      { name: 'Island', x: -10.5, z: -11.5, r: 4 },
      { name: 'Elevator', x: 10.5, z: 11.5, r: 4 },
    ],
    dominationZones: [0, 1, 2],
    flags: [{ team: 'red', x: -31.5, z: -15.5 }, { team: 'blue', x: 31.5, z: 15.5 }],
    // Search and destroy: bomb sites in the blue (defenders') half, placed with scripts/site-scan.ts.
    sites: [{ name: 'A', x: 23.5, z: -12.5, r: 3 }, { name: 'B', x: 19.5, z: 14.5, r: 3 }],
  },
  build(_variant, b) {
    half(b, 1, WEST);
    half(b, -1, EAST);
  },
};
