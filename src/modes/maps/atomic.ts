import { BLOCK } from '../../world/BlockRegistry';
import { type FreeArenaMapDef, type LayoutBuilder, TEAM } from './ArenaMap';
import { AIR } from './helpers';

/**
 * "Atomic Lane": a 1960s test-site cul-de-sac (inspired by the classic two-houses-and-a-bus
 * layout). A yellow house (red team) and a green house (blue team) face each other across a
 * roundabout; each has two storeys with a street-facing upstairs window, a porch whose roof you
 * can jump onto from that window, a garage with a climbable roof and a fenced backyard where the
 * team spawns. A school bus blocks the north half of the street, a moving truck the south half.
 *
 * The layout is point symmetric (each house is the other one turned 180° around the centre), so
 * it is fair, but the houses differ in colour, furniture and the vehicle next to them.
 */

/** Per-house colours. */
interface Palette {
  wall: number;
  trim: number;
  roof: number;
  sofa: number;
  car: number;
}

const YELLOW_HOUSE: Palette = { wall: BLOCK.YELLOW_WOOL, trim: BLOCK.WHITE_WOOL, roof: BLOCK.BRICKS, sofa: BLOCK.GREEN_WOOL, car: BLOCK.WHITE_WOOL };
const GREEN_HOUSE: Palette = { wall: BLOCK.GREEN_WOOL, trim: BLOCK.WHITE_WOOL, roof: BLOCK.SPRUCE_PLANKS, sofa: BLOCK.YELLOW_WOOL, car: BLOCK.YELLOW_WOOL };

/** The red team's spawns in the yellow backyard; blue gets the same spots turned 180°. */
const RED_SPAWNS: [number, number][] = [[-36, -8], [-34, -5], [-37, -2], [-34, 2], [-37, 7], [-34, 10]];
const FFA_WEST: [number, number][] = [[-35, -9], [-35, 9], [-24, -20], [-24, 20], [-14, -1], [-8, -21]];
const turn = ([x, z]: [number, number]): [number, number] => [-1 - x, -1 - z];

/** A mannequin: a white body with a clay head. */
function mannequin(box: LayoutBuilder['box'], x: number, z: number, h = 1): void {
  box(x, x, z, z, h, h + 1, BLOCK.WHITE_WOOL);
  box(x, x, z, z, h + 2, h + 2, BLOCK.CLAY);
}

function tree(box: LayoutBuilder['box'], x: number, z: number): void {
  box(x - 1, x + 1, z - 1, z + 1, 4, 5, BLOCK.OAK_LEAVES);
  box(x, x, z, z, 6, 6, BLOCK.OAK_LEAVES);
  box(x, x, z, z, 1, 4, BLOCK.OAK_LOG);
}

/**
 * One house with its yards, drawn in the coordinates of the west (yellow) house. `s = -1` turns
 * everything 180° around the centre for the east house.
 */
function homestead(b: LayoutBuilder, s: 1 | -1, p: Palette, variant: number): void {
  const X = (x: number) => (s > 0 ? x : -1 - x);
  const Z = (z: number) => (s > 0 ? z : -1 - z);
  const box = (x0: number, x1: number, z0: number, z1: number, h0: number, h1: number, id: number) => b.box(X(x0), X(x1), Z(z0), Z(z1), h0, h1, id);
  const paint = (x0: number, x1: number, z0: number, z1: number, id: number) => b.paint(X(x0), X(x1), Z(z0), Z(z1), id);

  // Backyard: a patio behind the back door, the team's colours on the lawn, picket fences that
  // close it off from the side yards (with a gate each), a sandbox and a picnic table.
  paint(-33, -31, -6, 0, BLOCK.STONE_BRICKS);
  paint(-39, -38, -5, 4, TEAM);
  for (const z of [-15, 16]) {
    box(-39, -31, z, z, 1, 1, BLOCK.FENCE);
    box(-35, -34, z, z, 1, 1, AIR);
  }
  paint(-38, -37, -14, -13, BLOCK.SAND);
  box(-32, -32, -4, -3, 1, 1, BLOCK.OAK_SLAB);

  // The house: two storeys, white corner posts and a white band at the upper floor.
  box(-30, -19, -10, 3, 1, 7, p.wall);
  box(-30, -19, -10, 3, 4, 4, p.trim);
  for (const [x, z] of [[-30, -10], [-19, -10], [-30, 3], [-19, 3]]) box(x, x, z, z, 1, 7, p.trim);
  box(-29, -20, -9, 2, 1, 3, AIR);
  box(-29, -20, -9, 2, 5, 7, AIR);
  box(-29, -20, -9, 2, 4, 4, BLOCK.OAK_PLANKS);
  box(-31, -18, -11, 4, 8, 8, p.roof);
  // Front (street side): door with a team-coloured lintel, ground windows, the wide open
  // upstairs window over the porch.
  box(-19, -19, -5, -4, 1, 2, AIR);
  box(-19, -19, -5, -4, 3, 3, TEAM);
  box(-19, -19, -8, -7, 2, 2, BLOCK.GLASS);
  box(-19, -19, 0, 1, 2, 2, BLOCK.GLASS);
  box(-19, -19, -8, -6, 5, 6, AIR);
  box(-19, -19, -1, 1, 5, 6, AIR);
  // Back: sliding door to the patio, windows.
  box(-30, -30, -2, -1, 1, 2, AIR);
  // Two wide, not three: bullets pass a window now, and the third pane lined up the spawn with the open front door
  // and the Roundabout.
  box(-30, -30, -6, -5, 2, 2, BLOCK.GLASS);
  box(-30, -30, -6, -5, 5, 6, BLOCK.GLASS);
  // Sides: a window on the north yard, an upstairs window on each side, a side door to the alley.
  box(-26, -25, -10, -10, 2, 2, BLOCK.GLASS);
  box(-24, -22, -10, -10, 5, 6, AIR);
  box(-27, -26, 3, 3, 1, 2, AIR);
  box(-23, -22, 3, 3, 5, 6, BLOCK.GLASS);

  // Ground floor: kitchen at the back, living room at the front, a wall with two doorways.
  box(-24, -24, -9, 2, 1, 3, p.wall);
  box(-24, -24, -6, -5, 1, 2, AIR);
  box(-24, -24, 0, 1, 1, 2, AIR);
  box(-29, -26, 2, 2, 1, 1, BLOCK.BIRCH_PLANKS);
  box(-28, -28, 2, 2, 1, 1, BLOCK.FURNACE);
  box(-26, -26, 2, 2, 1, 1, BLOCK.CRAFTING_TABLE);
  box(-25, -25, 2, 2, 1, 2, BLOCK.WHITE_WOOL);
  box(-27, -26, -4, -3, 1, 1, BLOCK.OAK_SLAB);
  box(-23, -21, -9, -9, 1, 1, p.sofa);
  box(-23, -22, 2, 2, 1, 2, BLOCK.BOOKSHELF);
  box(-22, -21, -7, -6, 1, 1, BLOCK.SPRUCE_SLAB);
  box(-20, -20, 0, 0, 1, 1, p.sofa);
  box(-22, -22, -3, -3, 4, 4, BLOCK.GLOWSTONE);
  box(-27, -27, -1, -1, 4, 4, BLOCK.GLOWSTONE);

  // Stairs along the north wall of the kitchen: three steps up to a hole in the upper floor,
  // with a railing upstairs.
  box(-28, -28, -9, -8, 1, 1, BLOCK.OAK_PLANKS);
  box(-27, -27, -9, -8, 1, 2, BLOCK.OAK_PLANKS);
  box(-26, -26, -9, -8, 1, 3, BLOCK.OAK_PLANKS);
  box(-29, -26, -9, -8, 4, 4, AIR);
  box(-29, -26, -7, -7, 5, 5, BLOCK.FENCE);

  // Upstairs: a landing at the back, a bedroom at the front behind the big window (with a
  // mannequin watching the street), lights in the roof.
  box(-24, -24, -9, 2, 5, 7, p.wall);
  box(-24, -24, -4, -3, 5, 6, AIR);
  box(-22, -21, 1, 2, 5, 5, BLOCK.WHITE_WOOL);
  box(-29, -29, 1, 2, 5, 6, BLOCK.BOOKSHELF);
  mannequin(box, -20, -8, 5);
  box(-22, -22, -4, -4, 8, 8, BLOCK.GLOWSTONE);
  box(-27, -27, -1, -1, 8, 8, BLOCK.GLOWSTONE);

  // Porch: plank floor, two posts, a railing and a flat roof you can reach from the window.
  paint(-18, -16, -7, -2, BLOCK.OAK_PLANKS);
  box(-16, -16, -7, -7, 1, 3, BLOCK.FENCE);
  box(-16, -16, -2, -2, 1, 3, BLOCK.FENCE);
  box(-16, -16, -6, -6, 1, 1, BLOCK.FENCE);
  box(-16, -16, -3, -3, 1, 1, BLOCK.FENCE);
  box(-18, -16, -8, -2, 4, 4, BLOCK.OAK_SLAB);
  mannequin(box, -18, -2);

  // Front yard: a path to the street, a mailbox, a tree, a mannequin on the lawn.
  paint(-15, -13, -5, -4, BLOCK.COBBLESTONE);
  box(-14, -14, -7, -7, 1, 1, BLOCK.FENCE);
  box(-14, -14, -7, -7, 2, 2, BLOCK.CHEST);
  tree(box, -15, -13);
  mannequin(box, -13, -9);

  // Garage with a car inside; crates in the backyard lead up onto its flat roof.
  box(-30, -21, 6, 14, 1, 3, p.wall);
  box(-30, -21, 6, 14, 4, 4, p.roof);
  box(-29, -22, 7, 13, 1, 3, AIR);
  box(-21, -21, 8, 12, 1, 3, AIR);
  box(-21, -21, 8, 12, 3, 3, BLOCK.WHITE_WOOL);
  box(-28, -27, 6, 6, 1, 2, AIR);
  box(-30, -30, 12, 13, 1, 2, AIR);
  box(-27, -24, 9, 10, 1, 1, p.car);
  box(-26, -25, 9, 10, 2, 2, BLOCK.GLASS);
  box(-29, -29, 7, 7, 1, 1, BLOCK.CRAFTING_TABLE);
  box(-29, -29, 9, 10, 1, 2, BLOCK.BOOKSHELF);
  box(-25, -25, 10, 10, 4, 4, BLOCK.GLOWSTONE);
  box(-31, -31, 7, 7, 1, 1, BLOCK.SPRUCE_PLANKS);
  box(-31, -31, 8, 8, 1, 2, BLOCK.SPRUCE_PLANKS);
  box(-31, -31, 9, 9, 1, 3, BLOCK.SPRUCE_PLANKS);

  // Driveway with the second car.
  paint(-20, -13, 8, 12, BLOCK.GRAVEL);
  box(-18, -15, 9, 10, 1, 1, p.car);
  box(-17, -16, 9, 10, 2, 2, BLOCK.GLASS);

  // North yard: a swing set and a sandbox; south yard: a tree and a planter.
  box(-26, -26, -19, -19, 1, 3, BLOCK.FENCE);
  box(-26, -26, -15, -15, 1, 3, BLOCK.FENCE);
  box(-26, -26, -19, -15, 4, 4, BLOCK.OAK_PLANKS);
  paint(-22, -20, -21, -19, BLOCK.SAND);
  tree(box, -17, -21);
  tree(box, -16, 19);
  box(-29, -26, 20, 20, 1, 1, BLOCK.BRICKS);
  paint(-29, -26, 21, 22, BLOCK.DIRT);

  // A parked car on the roundabout.
  box(-10, -7, 5, 6, 1, 1, p.car === BLOCK.WHITE_WOOL ? BLOCK.GREEN_WOOL : BLOCK.WHITE_WOOL);
  box(-9, -8, 5, 6, 2, 2, BLOCK.GLASS);

  // The variant moves the backyard clutter around a bit.
  if (variant === 1) box(-33, -33, 14, 14, 1, 1, BLOCK.SPRUCE_PLANKS);
}

export const ATOMIC: FreeArenaMapDef = {
  layout: 'free',
  id: 'atomic',
  name: 'Atomic Lane',
  description: 'Two houses, a bus and a roundabout: fast, close-range chaos',
  halfX: 40,
  halfZ: 26,
  wallHeight: 11,
  wallBlock: BLOCK.SPRUCE_PLANKS,
  floorBlock: BLOCK.GRASS,
  variants: 1,
  redSpawns: RED_SPAWNS,
  blueSpawns: RED_SPAWNS.map(turn),
  ffaSpawns: [...FFA_WEST, ...FFA_WEST.map(turn)],
  highGround: [[-25, 10], turn([-25, 10])],
  objectives: {
    // Point symmetric like the layout: every zone has its twin turned 180° around the roundabout.
    zones: [
      { name: 'Roundabout', x: 0, z: 0, r: 5 },
      { name: 'Yellow Kerb', x: -10.5, z: 10.5, r: 4 },
      { name: 'Green Kerb', x: 10.5, z: -10.5, r: 4 },
      { name: 'Bus Stop', x: -6.5, z: -18.5, r: 4 },
      { name: 'Truck', x: 6.5, z: 18.5, r: 4 },
    ],
    dominationZones: [0, 1, 2],
    // In the side yard of each house, out of sight of the other house.
    flags: [{ team: 'red', x: -24.5, z: -20.5 }, { team: 'blue', x: 24.5, z: 20.5 }],
    // Search and destroy: bomb sites in the blue half (see scripts/site-scan.ts).
    sites: [{ name: 'A', x: 18.5, z: -15.5, r: 3 }, { name: 'B', x: 23.5, z: 16.5, r: 3 }],
  },
  build(variant, b) {
    const { box, paint } = b;

    // The roundabout and the road out to the north, with a dashed centre line.
    for (let x = -14; x <= 13; x++) {
      for (let z = -14; z <= 13; z++) if ((x + 0.5) ** 2 + (z + 0.5) ** 2 <= 12.5 ** 2) paint(x, x, z, z, BLOCK.STONE);
    }
    paint(-4, 3, -25, -12, BLOCK.STONE);
    for (let z = -25; z <= -14; z += 3) paint(-1, 0, z, z + 1, BLOCK.YELLOW_WOOL);

    homestead(b, 1, YELLOW_HOUSE, variant);
    homestead(b, -1, GREEN_HOUSE, variant);

    // The island in the middle: grass, a kerb and a street lamp.
    for (let x = -4; x <= 3; x++) {
      for (let z = -4; z <= 3; z++) if ((x + 0.5) ** 2 + (z + 0.5) ** 2 <= 3.5 ** 2) paint(x, x, z, z, BLOCK.GRASS);
    }
    box(-1, 0, -1, 0, 1, 1, BLOCK.STONE_BRICKS);
    box(-1, -1, -1, -1, 2, 4, BLOCK.FENCE);
    box(-1, -1, -1, -1, 5, 5, BLOCK.GLOWSTONE);

    // School bus (north): hollow, windows along both sides, a door towards the roundabout and an
    // emergency door at the back.
    box(-14, -3, -17, -15, 1, 3, BLOCK.YELLOW_WOOL);
    box(-14, -3, -17, -15, 3, 3, BLOCK.WHITE_WOOL);
    box(-13, -4, -16, -16, 1, 2, AIR);
    for (let x = -12; x <= -5; x += 2) {
      box(x, x, -17, -17, 2, 2, BLOCK.GLASS);
      box(x, x, -15, -15, 2, 2, BLOCK.GLASS);
    }
    box(-13, -13, -15, -15, 1, 2, AIR);
    box(-3, -3, -16, -16, 1, 2, AIR);
    box(-14, -14, -17, -17, 1, 1, BLOCK.GLOWSTONE);
    box(-14, -14, -15, -15, 1, 1, BLOCK.GLOWSTONE);

    // Moving truck (south): an open cargo box facing the roundabout and a cab with a windscreen.
    box(2, 9, 14, 16, 1, 3, BLOCK.WHITE_WOOL);
    box(2, 8, 15, 15, 1, 2, AIR);
    box(10, 12, 14, 16, 1, 2, BLOCK.WHITE_WOOL);
    box(10, 12, 14, 16, 3, 3, BLOCK.STONE_BRICKS);
    box(13, 13, 14, 16, 1, 1, BLOCK.WHITE_WOOL);
    box(13, 13, 14, 16, 2, 2, BLOCK.GLASS);
    box(11, 11, 14, 14, 2, 2, BLOCK.GLASS);
    box(11, 11, 16, 16, 2, 2, BLOCK.GLASS);
  },
};
