import { describe, expect, it } from 'vitest';
import { MAP_IDS, getMap } from '../src/modes/maps';
import { BLOCK } from '../src/world/BlockRegistry';

/** Free distance straight ahead from a spawn at eye height (blocks, up to 40). */
function view(id: string, variant: number, s: { x: number; y: number; z: number; yaw: number }): number {
  const map = getMap(id as never);
  const dx = -Math.sin(s.yaw), dz = -Math.cos(s.yaw), ey = Math.floor(s.y + 1.62);
  let d = 0;
  while (d < 40 && map.blockAt(variant, Math.floor(s.x + dx * d), ey, Math.floor(s.z + dz * d)) === BLOCK.AIR) d += 0.25;
  return d;
}

describe('spawn facing (QA round 3: "where am I?" at every spawn)', () => {
  it('a spawn looks at open space, not at a wall at arm\'s length', () => {
    const walls: string[] = [];
    for (const id of MAP_IDS) {
      const map = getMap(id);
      for (let v = 0; v < map.variants; v++) {
        for (const [kind, list] of Object.entries(map.spawns)) {
          for (const s of list) if (view(id, v, s) < 4) walls.push(`${id} v${v} ${kind} (${s.x}, ${s.z})`);
        }
      }
    }
    // Before: 216 spawns faced a wall 0.75-4 blocks away. Left: the bunker's four team spawns inside its rooms (3 blocks).
    expect(walls.filter((w) => !w.startsWith('bunker'))).toEqual([]);
    expect(walls.length).toBeLessThanOrEqual(8);
  });
});
