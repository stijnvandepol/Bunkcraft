import { BLOCK, OPAQUE } from './BlockRegistry';
import { FACING_OPPOSITE, facingFromYaw } from './BlockStates';
import { dustCanStand } from './Redstone';
import { DOWN, FACING_DIR, UP } from './RedstoneShapes';

/** What placement needs to know (a subset of Placement's PlaceContext). */
export interface RedstonePlaceContext {
  id: number;
  hitX: number; hitY: number; hitZ: number;
  nx: number; ny: number; nz: number;
  yaw: number;
  /** Player pitch in radians (positive = looking up); decides whether a piston faces up or down. */
  pitch?: number;
  getBlock(x: number, y: number, z: number): number;
  getMeta(x: number, y: number, z: number): number;
}

/** Face-order direction of a unit vector. */
function dirOf(x: number, y: number, z: number): number {
  return x > 0 ? 0 : x < 0 ? 1 : y > 0 ? 2 : y < 0 ? 3 : z > 0 ? 4 : 5;
}

/**
 * State of a redstone component placed at (x, y, z) (Minecraft's placement rules), null when it cannot go there, undefined
 * when `c.id` is not a redstone component.
 *  - dust, pressure plates and repeaters need a sturdy top face below; a repeater sends its signal the way the player looks;
 *  - levers, buttons and redstone torches attach to the face that was clicked (torches not to a ceiling);
 *  - pistons face the player (up or down when looking steeply).
 */
export function redstonePlacement(c: RedstonePlaceContext, x: number, y: number, z: number): number | null | undefined {
  const g = (a: number, b: number, d: number) => c.getBlock(a, b, d), m = (a: number, b: number, d: number) => c.getMeta(a, b, d);
  switch (c.id) {
    case BLOCK.REDSTONE_WIRE: case BLOCK.PRESSURE_PLATE:
      return dustCanStand(g, m, x, y, z) && c.getBlock(x, y - 1, z) !== BLOCK.UNLOADED ? 0 : null;
    case BLOCK.REPEATER:
      return dustCanStand(g, m, x, y, z) && c.getBlock(x, y - 1, z) !== BLOCK.UNLOADED ? facingFromYaw(c.yaw) : null;
    case BLOCK.LEVER: case BLOCK.BUTTON: case BLOCK.REDSTONE_TORCH: {
      if (!OPAQUE[c.getBlock(c.hitX, c.hitY, c.hitZ)] || c.getBlock(c.hitX, c.hitY, c.hitZ) === BLOCK.UNLOADED) return null;
      const d = dirOf(-c.nx, -c.ny, -c.nz);
      if (c.id === BLOCK.REDSTONE_TORCH && d === UP) return null;
      return d;
    }
    case BLOCK.PISTON: case BLOCK.STICKY_PISTON: {
      const pitch = c.pitch ?? 0;
      if (pitch > 0.87) return DOWN;
      if (pitch < -0.87) return UP;
      return FACING_DIR[FACING_OPPOSITE[facingFromYaw(c.yaw)]];
    }
    default:
      return undefined;
  }
}
