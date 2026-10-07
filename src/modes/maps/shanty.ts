import { BLOCK } from '../../world/BlockRegistry';
import { type FreeArenaMapDef, type LayoutBuilder, TEAM } from './ArenaMap';
import { AIR, jumpPad, turn, turned } from './helpers';
import { C, car, crates, lamp, steps } from './props';

/**
 * "Tin Roofs": a hillside shanty town packed tight (64 × 44). Shacks of mud brick, planks and painted
 * concrete under rusty sheet roofs stand on both sides of narrow alleys; plank bridges join the roofs
 * of the two-storey houses with the flat roofs of the shacks across the alley, so there is a second
 * route over the town. In the middle a courtyard with a water tower on four legs and a basketball hoop.
 * Each team spawns in a walled yard at its end of town.
 *
 * Three lanes: the north alley (laundry lines, scooters, a shack row), the main street to the courtyard,
 * the south market alley (stalls under awnings, a car wreck). Point symmetric: one team's north alley is
 * the other team's market alley.
 */

interface Side {
  paint: number;
  paint2: number;
  house: number;
  roof: number;
  awning: number;
}

const WEST: Side = { paint: BLOCK.YELLOW_WOOL, paint2: C.TERRACOTTA, house: BLOCK.WHITE_WOOL, roof: C.COPPER_BLOCK, awning: BLOCK.YELLOW_WOOL };
const EAST: Side = { paint: BLOCK.GREEN_WOOL, paint2: C.CHERRY_PLANKS, house: C.CALCITE, roof: C.RAW_COPPER_BLOCK, awning: BLOCK.GREEN_WOOL };

const RED_SPAWNS: [number, number][] = [[-30, -8], [-27, -5], [-30, -2], [-27, 1], [-30, 5], [-27, 8]];
const FFA_WEST: [number, number][] = [[-29, -18], [-30, 17], [-19, -2], [-12, -18], [-15, 16], [-6, 5]];

type Box = LayoutBuilder['box'];

/** A one-storey shack: walls 3 high, a sheet roof at 4 (overhanging by one), hollow inside. */
function shack(box: Box, x0: number, x1: number, z0: number, z1: number, wall: number, roof: number): void {
  box(x0, x1, z0, z1, 1, 3, wall);
  box(x0 + 1, x1 - 1, z0 + 1, z1 - 1, 1, 3, AIR);
  box(x0, x1, z0, z1, 4, 4, roof);
}

/** A two-storey house: walls up to 7, an upper floor at 4, a flat roof at 8 with a low parapet. */
function house(box: Box, x0: number, x1: number, z0: number, z1: number, wall: number, roof: number): void {
  box(x0, x1, z0, z1, 1, 7, wall);
  box(x0 + 1, x1 - 1, z0 + 1, z1 - 1, 1, 3, AIR);
  box(x0 + 1, x1 - 1, z0 + 1, z1 - 1, 5, 7, AIR);
  box(x0 + 1, x1 - 1, z0 + 1, z1 - 1, 4, 4, BLOCK.SPRUCE_PLANKS);
  box(x0, x1, z0, z1, 8, 8, roof);
}

function half(b: LayoutBuilder, s: 1 | -1, p: Side): void {
  const t = turned(b, s);
  const { box, paint } = t;

  // --- Spawn yard: a mud-brick wall with two gates, baffles, a water barrel, a team mural -----
  paint(-31, -25, -11, 10, C.COARSE_DIRT);
  box(-24, -24, -11, 10, 1, 3, C.MUD_BRICKS);
  box(-24, -24, -6, 4, 3, 3, TEAM);
  box(-31, -24, -12, -12, 1, 3, C.MUD_BRICKS);
  box(-31, -24, 11, 11, 1, 3, C.MUD_BRICKS);
  box(-24, -24, -9, -8, 1, 3, AIR);
  box(-24, -24, 7, 8, 1, 3, AIR);
  box(-29, -28, -12, -12, 1, 3, AIR);
  box(-28, -27, 11, 11, 1, 3, AIR);
  box(-26, -26, -10, -7, 1, 2, BLOCK.SPRUCE_PLANKS);
  box(-26, -26, 6, 9, 1, 2, BLOCK.SPRUCE_PLANKS);
  box(-31, -31, -3, 2, 1, 2, TEAM);
  box(-29, -28, -10, -10, 1, 2, C.STRIPPED_SPRUCE_LOG);
  box(-30, -30, 9, 10, 1, 1, C.HAY);
  lamp(t, -25, -1, 4);

  // --- House A (two storeys) on the north row, with an outside stair to its upper door --------
  house(box, -22, -16, -14, -9, p.paint, p.roof);
  box(-16, -16, -12, -11, 1, 2, AIR);
  box(-19, -18, -9, -9, 1, 2, AIR);
  box(-22, -22, -12, -11, 2, 2, BLOCK.GLASS);
  box(-20, -19, -14, -14, 5, 6, AIR);
  box(-16, -16, -11, -10, 5, 6, AIR);
  box(-19, -18, -9, -9, 5, 6, AIR);
  box(-21, -20, -13, -13, 1, 1, BLOCK.BED);
  box(-17, -17, -13, -13, 1, 2, BLOCK.FURNACE);
  box(-21, -21, -10, -10, 5, 5, BLOCK.CHEST);
  box(-19, -19, -11, -11, 3, 3, BLOCK.GLOWSTONE);
  box(-19, -19, -11, -11, 7, 7, BLOCK.GLOWSTONE);
  // Stair along the west wall: four steps up to the upper floor's back door.
  steps(t, -23, -9, 0, -1, 4, 1, C.MUD_BRICKS);
  box(-22, -22, -13, -13, 5, 6, AIR);
  box(-23, -23, -13, -13, 4, 4, C.MUD_BRICKS);
  // Roof: a parapet and a satellite dish.
  box(-22, -16, -14, -14, 9, 9, p.paint2);
  box(-22, -22, -14, -9, 9, 9, p.paint2);
  box(-20, -20, -12, -12, 9, 9, C.IRON_BLOCK);

  // --- Shack B across the alley, joined to house A's upper door by a plank bridge -------------
  shack(box, -14, -9, -13, -8, p.paint2, p.roof);
  box(-14, -14, -11, -10, 1, 2, AIR);
  box(-11, -10, -8, -8, 1, 2, AIR);
  box(-9, -9, -12, -12, 2, 2, BLOCK.GLASS);
  box(-12, -11, -12, -12, 1, 1, BLOCK.CRAFTING_TABLE);
  box(-15, -15, -11, -10, 4, 4, BLOCK.OAK_PLANKS);
  box(-12, -12, -10, -10, 3, 3, BLOCK.GLOWSTONE);
  // Rooftop clutter on B: a water barrel and a TV aerial.
  box(-10, -10, -12, -12, 5, 5, C.STRIPPED_SPRUCE_LOG);
  box(-13, -13, -9, -9, 5, 7, BLOCK.FENCE);

  // --- Shack C on the south row: a roof you climb from crates, a bridge to house D -------------
  shack(box, -22, -16, 5, 11, C.PACKED_MUD, p.roof);
  box(-16, -16, 7, 8, 1, 2, AIR);
  box(-20, -19, 5, 5, 1, 2, AIR);
  box(-22, -22, 8, 9, 2, 2, BLOCK.GLASS);
  box(-21, -21, 10, 10, 1, 2, BLOCK.BOOKSHELF);
  box(-18, -17, 10, 10, 1, 1, BLOCK.SPRUCE_SLAB);
  box(-19, -19, 8, 8, 3, 3, BLOCK.GLOWSTONE);
  crates(t, -23, 3, 1, 1, 1, BLOCK.SPRUCE_PLANKS);
  crates(t, -23, 4, 1, 1, 2, BLOCK.SPRUCE_PLANKS);
  box(-23, -23, 5, 5, 1, 3, BLOCK.SPRUCE_PLANKS);
  box(-21, -21, 6, 6, 5, 5, C.HAY);

  // --- House D (two storeys) with a balcony over the main street ---------------------------
  house(box, -12, -6, 6, 12, p.house, p.roof);
  box(-12, -12, 8, 9, 1, 2, AIR);
  box(-9, -8, 6, 6, 1, 2, AIR);
  box(-6, -6, 10, 11, 1, 2, AIR);
  box(-10, -10, 11, 11, 1, 1, BLOCK.CRAFTING_TABLE);
  box(-7, -7, 7, 7, 1, 1, BLOCK.BED);
  box(-9, -9, 9, 9, 3, 3, BLOCK.GLOWSTONE);
  // Inside stair to the upper floor (and a hole above it).
  box(-11, -11, 11, 11, 1, 1, BLOCK.SPRUCE_PLANKS);
  box(-11, -11, 10, 10, 1, 2, BLOCK.SPRUCE_PLANKS);
  box(-11, -11, 9, 9, 1, 3, BLOCK.SPRUCE_PLANKS);
  box(-11, -11, 9, 11, 4, 4, AIR);
  box(-10, -10, 9, 11, 5, 5, BLOCK.FENCE);
  box(-10, -10, 10, 10, 5, 5, AIR);
  // Upper floor: a door onto the bridge from shack C, the balcony over the street.
  box(-12, -12, 7, 8, 5, 6, AIR);
  box(-15, -13, 7, 8, 4, 4, BLOCK.OAK_PLANKS);
  box(-10, -8, 6, 6, 5, 6, AIR);
  box(-10, -8, 5, 5, 4, 4, BLOCK.OAK_PLANKS);
  box(-10, -8, 4, 4, 5, 5, BLOCK.FENCE);
  box(-9, -9, 9, 9, 7, 7, BLOCK.GLOWSTONE);
  box(-12, -6, 6, 6, 9, 9, BLOCK.IRON_BARS);
  box(-8, -8, 10, 10, 9, 10, C.STRIPPED_SPRUCE_LOG);

  // --- North alley: a row of small shacks, laundry lines, scooters, barrels -------------------
  paint(-23, -1, -21, -15, C.PACKED_MUD);
  shack(box, -23, -18, -21, -18, BLOCK.SPRUCE_PLANKS, p.roof);
  box(-21, -20, -18, -18, 1, 2, AIR);
  box(-19, -18, -21, -21, 1, 2, AIR);
  shack(box, -9, -4, -21, -17, p.paint, p.roof);
  box(-7, -6, -17, -17, 1, 2, AIR);
  box(-9, -9, -20, -19, 1, 2, AIR);
  box(-6, -6, -19, -19, 3, 3, BLOCK.GLOWSTONE);
  for (const x of [-16, -12]) {
    box(x, x, -20, -20, 1, 3, BLOCK.FENCE);
    box(x, x, -15, -15, 1, 3, BLOCK.FENCE);
  }
  box(-16, -16, -19, -16, 3, 3, BLOCK.WHITE_WOOL);
  box(-12, -12, -19, -17, 3, 3, p.awning);
  box(-14, -13, -20, -20, 1, 1, C.COAL_BLOCK);
  box(-14, -14, -20, -20, 2, 2, BLOCK.REDSTONE_LAMP);
  box(-2, -2, -21, -20, 1, 2, C.STRIPPED_SPRUCE_LOG);
  box(-3, -3, -16, -16, 1, 1, C.STRIPPED_SPRUCE_LOG);
  crates(t, -11, -16, 1, 2, 1, BLOCK.SPRUCE_PLANKS);
  // A jump pad up onto shack F's roof at the end of the alley.
  jumpPad(t, -3, -18);

  // --- Main street to the courtyard: a car wreck, barrels, a low wall -----------------------
  paint(-23, -10, -6, 3, C.DIRT_PATH);
  car(t, -21, -5, true, C.RAW_IRON_BLOCK);
  box(-14, -13, -3, -3, 1, 2, C.MUD_BRICKS);
  box(-15, -15, 2, 2, 1, 1, C.STRIPPED_SPRUCE_LOG);
  box(-11, -11, -5, -5, 1, 2, C.STRIPPED_SPRUCE_LOG);
  box(-8, -8, -1, 0, 1, 1, BLOCK.COBBLESTONE_SLAB);
  lamp(t, -15, -7, 5);
  // Courtyard edge: a tyre stack, crates, a handcart, a broken wall.
  box(-6, -6, -6, -6, 1, 2, C.COAL_BLOCK);
  crates(t, -9, 2, 1, 2, 2, BLOCK.SPRUCE_PLANKS);
  box(-10, -10, -4, -3, 1, 1, C.MUD_BRICKS);
  box(-10, -10, -4, -4, 2, 2, C.MUD_BRICKS);
  box(-5, -4, 7, 7, 1, 1, BLOCK.SPRUCE_SLAB);
  box(-5, -5, 7, 7, 2, 2, BLOCK.FENCE);

  // --- South market alley: stalls under awnings, a well, crates ------------------------------
  paint(-23, -1, 13, 20, C.COARSE_DIRT);
  for (const x of [-21, -15, -9]) {
    box(x, x + 3, 19, 20, 1, 1, BLOCK.SPRUCE_PLANKS);
    box(x, x, 18, 18, 1, 3, BLOCK.FENCE);
    box(x + 3, x + 3, 18, 18, 1, 3, BLOCK.FENCE);
    box(x, x + 3, 18, 20, 4, 4, x === -15 ? BLOCK.WHITE_WOOL : p.awning);
  }
  box(-20, -19, 19, 19, 2, 2, C.MELON);
  box(-14, -13, 19, 19, 2, 2, C.PUMPKIN);
  box(-8, -7, 19, 19, 2, 2, C.HAY);
  box(-18, -17, 14, 15, 1, 1, BLOCK.COBBLESTONE);
  crates(t, -5, 14, 2, 1, 2, BLOCK.SPRUCE_PLANKS);
  crates(t, -12, 15, 1, 1, 1, BLOCK.SPRUCE_PLANKS);
  box(-23, -22, 15, 16, 1, 2, C.MUD_BRICKS);
  lamp(t, -2, 13, 4);
}

export const SHANTY: FreeArenaMapDef = {
  layout: 'free',
  id: 'shanty',
  name: 'Tin Roofs',
  description: 'A packed shanty town: alleys, plank bridges over the roofs and a water tower in the middle',
  halfX: 32,
  halfZ: 22,
  wallHeight: 13,
  wallBlock: C.MUD_BRICKS,
  floorBlock: C.COARSE_DIRT,
  variants: 1,
  redSpawns: RED_SPAWNS,
  blueSpawns: RED_SPAWNS.map(turn),
  ffaSpawns: [...FFA_WEST, ...FFA_WEST.map(turn)],
  highGround: [[-11, -10], turn([-11, -10]), [-19, 8], turn([-19, 8]), [-6, -19], turn([-6, -19])],
  objectives: {
    zones: [
      { name: 'Water Tower', x: 0, z: 0, r: 5, level: 0 },
      { name: 'Main Street', x: -17.5, z: -0.5, r: 4 },
      { name: 'Hoop', x: 17.5, z: 0.5, r: 4 },
      { name: 'Laundry', x: -14.5, z: -15.5, r: 4 },
      { name: 'Market', x: 14.5, z: 15.5, r: 4 },
    ],
    dominationZones: [0, 1, 2],
    flags: [{ team: 'red', x: -28.5, z: -18.5 }, { team: 'blue', x: 28.5, z: 18.5 }],
  },
  build(_variant, b) {
    const { box, paint } = b;
    half(b, 1, WEST);
    half(b, -1, EAST);

    // The courtyard: packed earth, the water tower on four legs, a basketball hoop on each side.
    for (let x = -8; x <= 7; x++) for (let z = -8; z <= 7; z++) if (Math.hypot(x + 0.5, z + 0.5) <= 7.5) paint(x, x, z, z, C.PACKED_MUD);
    for (const [x, z] of [[-4, -4], [3, 3], [-4, 3], [3, -4]]) box(x, x, z, z, 1, 6, C.STRIPPED_SPRUCE_LOG);
    box(-4, 3, -4, 3, 6, 6, BLOCK.SPRUCE_SLAB);
    box(-3, 2, -3, 2, 7, 9, C.STRIPPED_SPRUCE_LOG);
    box(-2, 1, -2, 1, 7, 9, AIR);
    box(-3, 2, -3, 2, 10, 10, C.RAW_COPPER_BLOCK);
    box(-2, 1, -3, -3, 8, 8, BLOCK.YELLOW_WOOL);
    box(-2, 1, 2, 2, 8, 8, BLOCK.YELLOW_WOOL);
    box(-4, -4, -4, -4, 7, 7, BLOCK.FENCE);
    box(3, 3, 3, 3, 7, 7, BLOCK.FENCE);
    // Hoops: a pole, a white backboard and a ring of bars.
    for (const s of [1, -1] as const) {
      const t = turned(b, s);
      t.box(-8, -8, -1, -1, 1, 4, BLOCK.FENCE);
      t.box(-8, -8, -2, 0, 4, 5, BLOCK.WHITE_WOOL);
      t.box(-7, -7, -1, -1, 4, 4, BLOCK.IRON_BARS);
    }
  },
};
