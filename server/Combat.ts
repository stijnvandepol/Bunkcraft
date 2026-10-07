import { BULLET } from '../src/modes/Hitscan';

/**
 * Hitscan geometry for the arcade game types. The code lives in src/modes/Hitscan.ts because the client runs the
 * very same traces and spread (tracers that match the server's verdict); this module keeps the server's names.
 */
export {
  type BlockQuery, type BulletTrace, type HitPart, type PlayerHit, createBulletTrace, rayBox, rayPlayer, shotSpread,
  spreadDirection, spreadRandom, traceBlocks, traceBullet,
} from '../src/modes/Hitscan';

/** Whether a block stops a bullet outright (full solid blocks; see-through and shaped blocks are handled by traceBullet). */
export function blocksBullet(id: number): boolean {
  return BULLET[id] === 1;
}
