import { BLOCK } from '../../world/BlockRegistry';
import { type ArenaMapDef, TEAM } from './ArenaMap';
import { building, door } from './helpers';

/**
 * "Bunker Flag": a capture-the-flag map (64 × 40) after the concept in docs/research/ARCADE.md.
 * A dry river bed runs down the middle between banks two blocks high; it is crossed at two
 * bridges and through a covered culvert in the centre (the tunnel route). Each team's flag stands in a concrete bunker whose
 * only door faces the river, screened by a blast wall. The spawns sit in a walled yard behind
 * the bunker with one door, so nobody is shot while spawning.
 */
export const BUNKER: ArenaMapDef = {
  id: 'bunker',
  name: 'Bunker Flag',
  description: 'Capture the flag: a river bed with two bridges and a culvert, a flag bunker per team',
  halfX: 32,
  halfZ: 20,
  wallHeight: 9,
  wallBlock: BLOCK.MOSSY_COBBLESTONE,
  floorBlock: BLOCK.GRASS,
  variants: 1,
  teamSpawns: [[28, 9], [29, 12], [28, 15], [30, 17]],
  ffaSpawns: [[7, 9], [12, 17], [16, 8]],
  highGround: [[5, 10]],
  objectives: {
    // Hardpoint order: the culvert, then the two bridge heads, then the two fields in front of the bunkers.
    zones: [
      { name: 'Culvert', x: 0, z: 0, r: 4, level: 0 },
      { name: 'West Bridge', x: -9.5, z: 11.5, r: 4 },
      { name: 'East Bridge', x: 9.5, z: 11.5, r: 4 },
      { name: 'West Field', x: -11.5, z: -5.5, r: 4 },
      { name: 'East Field', x: 11.5, z: -5.5, r: 4 },
    ],
    dominationZones: [0, 1, 2],
    flags: [{ team: 'red', x: -23.5, z: 0, level: 0 }, { team: 'blue', x: 23.5, z: 0, level: 0 }],
  },
  build(_variant, b) {
    const { box, paint } = b;

    // The dry river bed (u 0..2, six wide over the mirror) between banks two high, open only at the
    // two bridges and the culvert.
    paint(0, 2, 0, 18, BLOCK.CLAY);
    box(3, 3, 0, 18, 1, 2, BLOCK.COBBLESTONE);
    box(3, 3, 0, 1, 1, 2, BLOCK.AIR);
    box(3, 3, 6, 8, 1, 2, BLOCK.AIR);
    box(3, 3, 14, 16, 1, 2, BLOCK.AIR);
    paint(0, 3, 6, 8, BLOCK.SPRUCE_PLANKS);
    paint(0, 3, 14, 16, BLOCK.SPRUCE_PLANKS);
    paint(0, 4, 0, 1, BLOCK.STONE_BRICKS);
    // Culvert: walls along the passage and a roof, two blocks of head room inside.
    box(0, 5, 2, 2, 1, 3, BLOCK.STONE_BRICKS);
    box(0, 5, 0, 2, 3, 3, BLOCK.STONE_BRICKS);
    box(5, 5, 2, 2, 1, 2, BLOCK.STONE_BRICKS);
    // A raised firing step on the bank, reached from the bridge side.
    box(5, 8, 10, 11, 1, 1, BLOCK.COBBLESTONE);
    box(5, 8, 12, 12, 1, 2, BLOCK.MOSSY_COBBLESTONE);

    // Gravel paths from the crossings to the bunker.
    paint(5, 18, 0, 2, BLOCK.GRAVEL);
    paint(4, 9, 6, 8, BLOCK.GRAVEL);
    paint(4, 9, 14, 16, BLOCK.GRAVEL);

    // Cover in the field: crates, a sandbag line and a ruined wall.
    box(8, 9, 3, 4, 1, 2, BLOCK.SPRUCE_PLANKS);
    box(12, 12, 6, 9, 1, 2, BLOCK.COBBLESTONE);
    box(13, 14, 13, 14, 1, 2, BLOCK.SPRUCE_PLANKS);
    box(18, 19, 9, 10, 1, 1, BLOCK.SPRUCE_PLANKS);
    box(9, 11, 18, 18, 1, 1, BLOCK.COBBLESTONE);

    // The flag bunker: one door towards the river, a blast wall in front of it, team colours on top.
    building(b, 19, 26, 0, 5, 4, BLOCK.STONE_BRICKS, [door('u0', 0, 1)]);
    box(19, 26, 5, 5, 4, 4, TEAM);
    box(26, 26, 0, 5, 4, 4, TEAM);
    paint(22, 24, 0, 1, TEAM);
    box(21, 21, 4, 4, 3, 3, BLOCK.GLOWSTONE);
    box(15, 15, 0, 3, 1, 3, BLOCK.STONE_BRICKS);

    // The spawn yard behind it: a wall with one door, a baffle in front of the door.
    box(26, 26, 6, 18, 1, 4, BLOCK.STONE_BRICKS);
    box(26, 30, 6, 6, 1, 4, BLOCK.STONE_BRICKS);
    box(26, 26, 13, 14, 1, 2, BLOCK.AIR);
    box(24, 24, 11, 16, 1, 3, BLOCK.STONE_BRICKS);
    box(26, 26, 6, 18, 4, 4, TEAM);
    paint(27, 30, 7, 18, TEAM);
  },
};
