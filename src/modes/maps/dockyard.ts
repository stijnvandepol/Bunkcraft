import { BLOCK } from '../../world/BlockRegistry';
import { type ArenaMapDef, TEAM } from './ArenaMap';
import { building, container, door, glass, stairs } from './helpers';

/**
 * "Harbor Yard": a compact industrial map (88 × 64). Shipping-container stacks in wool colours
 * make the cover, a big warehouse stands in the middle, a crane deck on log pillars and the
 * bridge of a moored ship are the high ground. Each team starts in a ring of its own containers.
 */
export const DOCKYARD: ArenaMapDef = {
  id: 'dockyard',
  name: 'Harbor Yard',
  description: 'Industrial: container stacks, a central warehouse, a crane deck and a ship',
  halfX: 44,
  halfZ: 32,
  wallHeight: 13,
  wallBlock: BLOCK.COBBLESTONE,
  floorBlock: BLOCK.STONE,
  variants: 1,
  teamSpawns: [[40, 2], [39, 6], [42, 4], [37, 8]],
  ffaSpawns: [[7, 6], [28, 12], [16, 22], [38, 23], [4, 28]],
  objectives: {
    // Hardpoint order: under the crane, the two container yards, then the two ship decks.
    zones: [
      { name: 'Crane', x: 0, z: 24, r: 5 },
      { name: 'West Yard', x: -24.5, z: 8.5, r: 5 },
      { name: 'East Yard', x: 24.5, z: 8.5, r: 5 },
      { name: 'West Deck', x: -18.5, z: 25, r: 5 },
      { name: 'East Deck', x: 18.5, z: 25, r: 5 },
    ],
    dominationZones: [0, 1, 2],
    flags: [{ team: 'red', x: -40.5, z: 26.5 }, { team: 'blue', x: 40.5, z: 26.5 }],
    // Search and destroy: bomb sites in the blue half (see scripts/site-scan.ts).
    sites: [{ name: 'A', x: 15.5, z: -18.5, r: 3 }, { name: 'B', x: 15.5, z: 18.5, r: 3 }],
  },
  highGround: [[22, 17], [20, 27], [30, 27], [12, 2]],
  build(_variant, b) {
    const { box, paint } = b;

    // Yard markings: yellow lane lines, gravel patches, the team plaza.
    paint(0, 43, 13, 13, BLOCK.YELLOW_WOOL);
    paint(0, 0, 0, 30, BLOCK.WHITE_WOOL);
    paint(16, 30, 8, 12, BLOCK.GRAVEL);
    paint(34, 40, 14, 24, BLOCK.GRAVEL);
    paint(35, 42, 0, 12, TEAM);

    // The warehouse in the middle: planks and stone, two big doors, skylights and lamps, shelving inside.
    building(b, 0, 14, 0, 12, 5, BLOCK.SPRUCE_PLANKS, [
      { face: 'u1', from: 3, to: 7, h0: 1, h1: 3 }, door('v1', 0, 2), { face: 'v1', from: 9, to: 11, h0: 1, h1: 3 },
      glass('u1', 10, 11), glass('v1', 5, 6, 2, 3),
    ], BLOCK.STONE_BRICKS);
    box(3, 3, 0, 4, 1, 3, BLOCK.BOOKSHELF);
    box(8, 9, 0, 3, 1, 3, BLOCK.BOOKSHELF);
    box(5, 6, 8, 9, 1, 2, BLOCK.OAK_PLANKS);
    box(11, 12, 8, 10, 1, 1, BLOCK.OAK_PLANKS);
    for (const [lu, lv] of [[2, 3], [6, 6], [11, 3], [11, 9], [3, 10]]) box(lu, lu, lv, lv, 5, 5, BLOCK.GLOWSTONE);
    box(6, 7, 2, 3, 5, 5, BLOCK.GLASS);
    box(9, 10, 6, 7, 5, 5, BLOCK.GLASS);
    // A stair along the outside of the warehouse up to its roof.
    stairs(b, 'u', 5, 1, 4, 13, 14, BLOCK.OAK_PLANKS);
    box(9, 14, 12, 12, 6, 6, BLOCK.STONE_BRICKS);
    box(14, 14, 0, 12, 6, 6, BLOCK.STONE_BRICKS);

    // Crane: a deck on four log pillars with a stair, and the tower with its yellow jib.
    box(20, 25, 14, 19, 5, 5, BLOCK.OAK_PLANKS);
    for (const [pu, pv] of [[20, 14], [25, 14], [20, 19], [25, 19]]) box(pu, pu, pv, pv, 1, 4, BLOCK.OAK_LOG);
    stairs(b, 'u', 16, 1, 4, 15, 16, BLOCK.OAK_PLANKS);
    box(25, 25, 19, 19, 5, 9, BLOCK.OAK_LOG);
    box(19, 25, 19, 19, 9, 9, BLOCK.YELLOW_WOOL);
    box(22, 23, 14, 14, 6, 6, BLOCK.OAK_PLANKS);

    // The ship moored along the north edge: planks hull, a gangway and a bridge to snipe from.
    box(6, 36, 25, 30, 1, 4, BLOCK.SPRUCE_PLANKS);
    box(6, 36, 25, 25, 4, 4, BLOCK.WHITE_WOOL);
    box(28, 33, 26, 29, 5, 7, BLOCK.WHITE_WOOL);
    box(25, 25, 27, 28, 5, 5, BLOCK.OAK_PLANKS);
    box(26, 26, 27, 28, 5, 6, BLOCK.OAK_PLANKS);
    box(27, 27, 27, 28, 5, 7, BLOCK.OAK_PLANKS);
    box(12, 13, 26, 28, 5, 5, BLOCK.YELLOW_WOOL);
    stairs(b, 'v', 22, 1, 3, 14, 15, BLOCK.OAK_PLANKS);
    stairs(b, 'v', 22, 1, 3, 3, 4, BLOCK.OAK_PLANKS);

    // Containers: stacks one or two high in four colours (team colours on each team's own side).
    const Y = BLOCK.YELLOW_WOOL, G = BLOCK.GREEN_WOOL, W = BLOCK.WHITE_WOOL;
    container(b, 18, 3, true, 2, G);
    container(b, 26, 5, false, 1, Y);
    container(b, 18, 9, true, 1, W);
    container(b, 8, 15, true, 2, TEAM);
    container(b, 30, 16, false, 2, G);
    container(b, 36, 18, true, 1, W);
    container(b, 5, 21, true, 1, Y);
    container(b, 2, 17, false, 1, G);
    container(b, 31, 22, true, 1, TEAM);
    container(b, 14, 28, true, 1, Y);
    container(b, 21, 23, true, 2, W);
    container(b, 26, 25, false, 1, G);
    // Step crates up onto the one-high stacks.
    box(25, 25, 10, 10, 1, 1, BLOCK.OAK_PLANKS);
    box(17, 17, 9, 9, 1, 1, BLOCK.OAK_PLANKS);
    box(9, 9, 20, 20, 1, 1, BLOCK.OAK_PLANKS);
    box(35, 35, 18, 18, 1, 1, BLOCK.OAK_PLANKS);

    // The team ring: containers in the team colour in front of the plaza, an opening north.
    container(b, 33, 0, false, 2, TEAM);
    container(b, 33, 6, false, 2, TEAM);
    container(b, 37, 14, true, 1, TEAM);
    box(43, 43, 0, 12, 1, 3, BLOCK.COBBLESTONE);

    // Fuel tanks, pallets and barrels.
    box(12, 13, 24, 25, 1, 3, BLOCK.WHITE_WOOL);
    box(40, 41, 20, 21, 1, 3, BLOCK.WHITE_WOOL);
    box(5, 6, 12, 13, 1, 1, BLOCK.OAK_PLANKS);
    box(29, 30, 12, 13, 1, 1, BLOCK.OAK_PLANKS);
  },
};
