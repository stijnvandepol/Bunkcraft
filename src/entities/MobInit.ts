import type { Mob } from './Mob';
import { HORSE_COATS } from './MobTypes';

/** Wool colour index (DYES order: 0 white … 15 black). */
export const WOOL = { WHITE: 0, PINK: 6, GRAY: 7, LIGHT_GRAY: 8, BROWN: 12, RED: 14, BLACK: 15 } as const;

/**
 * Natural sheep colours (Minecraft Java): white 81.836 %, black, gray and light gray 5 % each, brown 3 %,
 * pink 0.164 %.
 */
export function sheepColor(roll: number): number {
  if (roll < 0.05) return WOOL.BLACK;
  if (roll < 0.10) return WOOL.GRAY;
  if (roll < 0.15) return WOOL.LIGHT_GRAY;
  if (roll < 0.18) return WOOL.BROWN;
  if (roll < 0.18164) return WOOL.PINK;
  return WOOL.WHITE;
}

/** Horse jump strength (0.4-1.0) to the height it clears in blocks (wiki fit of the Java physics). */
export function horseJumpHeight(j: number): number {
  return -0.1817584952 * j ** 3 + 3.689713992 * j ** 2 + 2.128599134 * j - 0.343930367;
}

/**
 * Per-kind state of a freshly spawned mob: sheep colour, slime size, horse stats and coat, the wolf's red collar.
 * Random rolls use Math.random (spawns themselves are seeded by the spawner where it matters).
 */
export function initMob(m: Mob, rnd: () => number = Math.random): void {
  switch (m.type.kind) {
    case 'sheep':
      m.variant = sheepColor(rnd());
      break;
    case 'slime':
      m.size = 1 << Math.floor(rnd() * 3);
      m.refreshSize();
      m.health = m.size * m.size;
      break;
    case 'wolf':
      m.variant = WOOL.RED;
      break;
    case 'horse': {
      // Minecraft: health 15 + rand(8) + rand(9); speed attribute (0.45 + 3 × rand(0.3)) × 0.25, ×43.17 = blocks/s;
      // jump strength 0.4 + 3 × rand(0.2).
      m.health = 15 + Math.floor(rnd() * 8) + Math.floor(rnd() * 9);
      m.rideSpeed = (0.45 + rnd() * 0.3 + rnd() * 0.3 + rnd() * 0.3) * 0.25 * 43.17;
      const jump = 0.4 + rnd() * 0.2 + rnd() * 0.2 + rnd() * 0.2;
      // Launch speed that reaches the jump height under the game's gravity (32 blocks/s²).
      m.rideJump = Math.sqrt(2 * 32 * horseJumpHeight(jump));
      m.variant = Math.floor(rnd() * HORSE_COATS.length);
      break;
    }
    default:
      break;
  }
}
