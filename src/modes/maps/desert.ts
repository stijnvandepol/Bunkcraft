import { BLOCK } from '../../world/BlockRegistry';
import { type ArenaMapDef, type LayoutBuilder, TEAM } from './ArenaMap';
import { building, door, glass, stairs } from './helpers';

/** A market stall: a counter, two posts and a wool awning over it. */
function stall(b: LayoutBuilder, u: number, v: number, alongU: boolean, awning: number): void {
  const len = 4;
  if (alongU) {
    b.box(u, u + len - 1, v, v, 1, 1, BLOCK.BIRCH_PLANKS);
    b.box(u, u, v + 1, v + 1, 1, 3, BLOCK.OAK_LOG);
    b.box(u + len - 1, u + len - 1, v + 1, v + 1, 1, 3, BLOCK.OAK_LOG);
    b.box(u, u + len - 1, v, v + 1, 3, 3, awning);
  } else {
    b.box(u, u, v, v + len - 1, 1, 1, BLOCK.BIRCH_PLANKS);
    b.box(u + 1, u + 1, v, v, 1, 3, BLOCK.OAK_LOG);
    b.box(u + 1, u + 1, v + len - 1, v + len - 1, 1, 3, BLOCK.OAK_LOG);
    b.box(u, u + 1, v, v + len - 1, 3, 3, awning);
  }
}

/**
 * "Dust Bazaar": a long map of sand and sandstone (96 × 64). A market with striped stalls fills the
 * middle, flat-roofed houses line a long open lane with roof stairs, and each team holds a walled
 * compound behind a tall sniper tower at its end of the map.
 */
export const DESERT: ArenaMapDef = {
  id: 'desert',
  name: 'Dust Bazaar',
  description: 'Long sight lines: a central market, rooftops and sniper towers at both ends',
  halfX: 48,
  halfZ: 32,
  wallHeight: 14,
  wallBlock: BLOCK.SANDSTONE,
  floorBlock: BLOCK.SAND,
  variants: 1,
  teamSpawns: [[43, 3], [41, 6], [44, 8], [40, 9]],
  ffaSpawns: [[12, 12], [24, 13], [33, 15], [11, 20]],
  highGround: [[4, 25], [23, 5], [23, 23], [42, 23]],
  objectives: {
    // Hardpoint order: the lane in the middle, the lanes by the houses, then the two ends of the market hall.
    zones: [
      { name: 'Lane', x: 0, z: 16, r: 5 },
      { name: 'West Houses', x: -24.5, z: 13.5, r: 4 },
      { name: 'East Houses', x: 24.5, z: 13.5, r: 4 },
      { name: 'West Hall', x: -12.5, z: -24.5, r: 4 },
      { name: 'East Hall', x: 12.5, z: -24.5, r: 4 },
    ],
    dominationZones: [0, 1, 2],
    // In the corner behind each compound, away from the towers.
    flags: [{ team: 'red', x: -43.5, z: -28.5 }, { team: 'blue', x: 43.5, z: -28.5 }],
    // Search and destroy: bomb sites in the blue half (see scripts/site-scan.ts).
    sites: [{ name: 'A', x: 16.5, z: -12.5, r: 3 }, { name: 'B', x: 16.5, z: 12.5, r: 3 }],
  },
  build(_variant, b) {
    const { box, paint } = b;
    const Y = BLOCK.YELLOW_WOOL, W = BLOCK.WHITE_WOOL, G = BLOCK.GREEN_WOOL;

    // Ground: a sandstone road down the middle lane, a paved market square, the team compounds.
    paint(0, 47, 10, 17, BLOCK.SANDSTONE);
    paint(0, 17, 0, 24, BLOCK.GRAVEL);
    paint(0, 0, 0, 30, W);
    paint(38, 45, 0, 10, TEAM);
    paint(36, 37, 0, 10, BLOCK.SANDSTONE);

    // Market square: striped stalls in rows, a broken fountain, a ruined arch.
    stall(b, 2, 3, true, Y);
    stall(b, 8, 3, true, W);
    stall(b, 13, 6, false, G);
    stall(b, 3, 8, true, G);
    stall(b, 9, 8, true, Y);
    stall(b, 5, 18, true, W);
    stall(b, 11, 18, true, Y);
    box(0, 1, 12, 13, 1, 1, BLOCK.SANDSTONE);
    box(0, 0, 12, 12, 2, 3, BLOCK.SANDSTONE);
    box(4, 4, 13, 13, 1, 4, BLOCK.SANDSTONE);
    box(4, 8, 13, 13, 4, 4, BLOCK.SANDSTONE);
    box(8, 8, 13, 13, 1, 4, BLOCK.SANDSTONE);
    box(14, 15, 12, 13, 1, 2, BLOCK.COBBLESTONE);

    // The market hall at the north end of the square: a roof to snipe from, half its walls broken.
    building(b, 0, 9, 22, 28, 4, BLOCK.SANDSTONE, [
      door('v0', 0, 3), door('v0', 6, 7), door('u1', 24, 26),
      glass('v1', 2, 3), glass('v1', 6, 7),
    ]);
    box(5, 6, 24, 25, 1, 2, BLOCK.OAK_PLANKS);
    box(0, 9, 28, 28, 5, 5, BLOCK.SANDSTONE);
    box(9, 9, 24, 28, 5, 5, BLOCK.SANDSTONE);
    stairs(b, 'u', 12, -1, 3, 22, 23, BLOCK.SANDSTONE);

    // Houses along the lane: flat roofs, a door to the lane, roof stairs next to the lane.
    building(b, 19, 27, 1, 8, 4, BLOCK.SANDSTONE, [
      door('v1', 22, 24), door('u0', 3, 4), glass('u1', 3, 4), glass('v0', 21, 22),
    ], BLOCK.BIRCH_PLANKS);
    box(23, 24, 3, 4, 1, 1, BLOCK.OAK_PLANKS);
    stairs(b, 'u', 19, 1, 3, 9, 9, BLOCK.SANDSTONE);
    building(b, 29, 34, 2, 7, 3, BLOCK.COBBLESTONE, [
      door('v1', 30, 31), door('u0', 4, 5), glass('u1', 4, 4, 2, 2),
    ], BLOCK.OAK_PLANKS);
    building(b, 19, 27, 19, 27, 4, BLOCK.SANDSTONE, [
      door('v0', 22, 24), door('u0', 22, 23), glass('u1', 22, 23), glass('v1', 21, 22),
    ], BLOCK.BIRCH_PLANKS);
    box(21, 22, 23, 24, 1, 2, BLOCK.OAK_PLANKS);
    stairs(b, 'u', 19, 1, 3, 18, 18, BLOCK.SANDSTONE);
    building(b, 28, 32, 20, 25, 3, BLOCK.COBBLESTONE, [
      door('v0', 29, 30), door('u0', 21, 22), glass('u1', 22, 23, 2, 2),
    ], BLOCK.OAK_PLANKS);

    // Ruined walls and rocks as cover along the lane.
    box(36, 36, 14, 17, 1, 2, BLOCK.COBBLESTONE);
    box(14, 14, 15, 16, 1, 1, BLOCK.MOSSY_COBBLESTONE);
    box(17, 18, 11, 11, 1, 2, BLOCK.COBBLESTONE);
    box(27, 28, 15, 16, 1, 2, BLOCK.MOSSY_COBBLESTONE);
    box(32, 33, 11, 12, 1, 1, BLOCK.COBBLESTONE);
    box(22, 23, 14, 14, 1, 1, BLOCK.COBBLESTONE);

    // Team compound: a front wall with an opening to the north, a banner and cover.
    box(36, 37, 0, 10, 1, 5, BLOCK.SANDSTONE);
    box(36, 37, 4, 5, 3, 5, TEAM);
    box(38, 39, 10, 10, 1, 3, TEAM);
    box(42, 43, 12, 12, 1, 2, BLOCK.SANDSTONE);
    box(40, 41, 3, 3, 1, 1, BLOCK.OAK_PLANKS);
    box(46, 46, 0, 10, 1, 2, BLOCK.SANDSTONE);

    // Sniper tower: a long stair up to a platform with a parapet, overlooking the whole lane.
    box(40, 44, 20, 26, 1, 6, BLOCK.SANDSTONE);
    stairs(b, 'u', 34, 1, 6, 22, 23, BLOCK.SANDSTONE);
    box(40, 44, 20, 20, 7, 7, BLOCK.SANDSTONE);
    box(40, 44, 26, 26, 7, 7, BLOCK.SANDSTONE);
    box(44, 44, 20, 26, 7, 7, BLOCK.SANDSTONE);
  },
};
