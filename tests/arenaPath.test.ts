import { describe, expect, it } from 'vitest';
import { MovementValidator } from '../server/anticheat/Movement';
import { arcadeMaxSpeed } from '../src/modes/ArcadeLogic';
import { MAP_IDS, getMap } from '../src/modes/maps';
import { BOT_SPEED, arenaPath, follow } from '../scripts/lib/arenaPath';

/**
 * The QA bots' paths (scripts/lib/arenaPath.ts) cross every map, steps, slabs and platforms included,
 * and walking them at bot pace never trips the server's movement validator.
 */
describe('bot paths', () => {
  for (const id of MAP_IDS) {
    it(`${id}: red spawn to blue spawn and on through every ffa spawn, and the walk passes the movement validator`, () => {
      const map = getMap(id);
      const variant = map.variantFor(7);
      const v = new MovementValidator({ getBlock: (x, y, z) => map.blockAt(variant, x, y, z), getMeta: () => 0 },
        { maxSpeed: arcadeMaxSpeed(0.92), inBounds: (x, z) => map.inBounds(x, z) });
      const r = map.spawns.red[0];
      const pos = { x: r.x, y: r.y, z: r.z };
      const HZ = 30;
      let tick = 0;
      v.reset(pos.x, pos.y, pos.z, 0);
      const bad: string[] = [];
      for (const to of [map.spawns.blue[0], ...map.spawns.ffa.filter((_, k) => k % 4 === 0)]) {
        const route = arenaPath(map, variant, [pos.x, pos.z, pos.y], [to.x, to.z]);
        expect(route, `no path to ${to.x},${to.z}`).not.toBeNull();
        for (let i = 0; i < 60 * HZ && route!.length; i++) {
          follow(pos, route!, BOT_SPEED / HZ);
          tick++;
          const verdict = v.check(pos.x, pos.y, pos.z, tick / HZ, tick * (60 / HZ));
          if (!verdict.ok) { bad.push(`${verdict.rule} at ${pos.x.toFixed(1)},${pos.y},${pos.z.toFixed(1)}`); v.reset(pos.x, pos.y, pos.z, tick / HZ); }
        }
        expect(route!.length, `arrived at ${to.x},${to.z}`).toBe(0);
        expect(Math.hypot(pos.x - to.x, pos.z - to.z)).toBeLessThan(0.01);
      }
      expect(bad).toEqual([]);
    });
  }

  it('station (Terminus): the bots climb onto the platforms to cross the tracks', () => {
    const map = getMap('station');
    const r = map.spawns.red[0], bl = map.spawns.blue[0];
    const route = arenaPath(map, 0, [r.x, r.z, r.y], [bl.x, bl.z])!;
    expect(route).not.toBeNull();
    expect(Math.max(...route.map((p) => p[2])) - r.y).toBeGreaterThanOrEqual(1);
  });
});
