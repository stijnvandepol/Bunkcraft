import { describe, expect, it } from 'vitest';
import { ArcadeGuard } from '../server/anticheat/ArcadeGuard';
import { StanceTracker } from '../server/anticheat/Stance';
import { createBulletTrace, shotSpread, spreadDirection, spreadRandom, traceBullet } from '../src/modes/Hitscan';
import { weaponDef } from '../src/modes/Weapons';
import { live, place } from './helpers/matchHost';

/**
 * The spread of a shot (moving, airborne, sliding) comes from the position reports the server validated, never from the
 * `mv` / `air` claims of the `fire` message.
 */

describe('StanceTracker', () => {
  it('stands still on the ground by default', () => {
    const t = new StanceTracker();
    for (let i = 0; i < 5; i++) t.note(i * 0.05, 1, 1, true);
    expect(t.moving).toBe(false);
    expect(t.airborne).toBe(false);
  });

  it('moving needs two fast report intervals and clears as soon as the player stops', () => {
    const t = new StanceTracker();
    t.note(0, 0, 0, true);
    t.note(0.05, 0.3, 0, true); // 6 b/s
    expect(t.moving).toBe(false); // one interval is not enough
    t.note(0.1, 0.6, 0, true);
    expect(t.moving).toBe(true);
    t.note(0.15, 0.6, 0, true); // stopped: the player's screen is already still
    expect(t.moving).toBe(false);
  });

  it('airborne needs two reports in the air; a landing clears it at once', () => {
    const t = new StanceTracker();
    t.note(0, 0, 0, true);
    t.note(0.05, 0, 0, false);
    expect(t.airborne).toBe(false);
    t.note(0.1, 0, 0, false);
    expect(t.airborne).toBe(true);
    t.note(0.15, 0, 0, true);
    expect(t.airborne).toBe(false);
  });

  it('a reset (teleport, spawn) forgets everything', () => {
    const t = new StanceTracker();
    for (let i = 0; i < 4; i++) t.note(i * 0.05, i * 0.3, 0, false);
    expect(t.moving && t.airborne).toBe(true);
    t.reset();
    expect(t.moving || t.airborne).toBe(false);
  });
});

describe('ArcadeGuard ground contact', () => {
  const flat = { getBlock: (_x: number, y: number) => (y < 64 ? 1 : 0), getMeta: () => 0 };

  it('reports ground on the floor and air in the middle of a jump', () => {
    const g = new ArcadeGuard(flat, () => true);
    g.join(1, 'a');
    g.reset(1, 0.5, 64, 0.5, 0);
    expect(g.move(1, 0.5, 64, 0.5, 0.05).ok).toBe(true);
    expect(g.grounded(1)).toBe(true);
    expect(g.move(1, 0.5, 64.6, 0.5, 0.15).ok).toBe(true);
    expect(g.grounded(1)).toBe(false);
  });
});

describe('Match spread comes from the server stance', () => {
  const SEED = 0x1234567;

  /** Fires along +z with the given claims after the server derived `stance` ([moving, airborne]) and returns where the bullet ended. */
  function shoot(claim: { mv?: boolean; air?: boolean }, stance: [boolean, boolean], height?: number): { got: number[]; want: (m: boolean, a: boolean) => number[] } {
    const s = live('ffa');
    const p = s.match.players.get(1)!;
    p.spreadSeed = SEED;
    place(s, 1, 0.5, 65, 0.5);
    place(s, 2, 30.5, 65, 30.5);
    s.advance(0.3);
    if (height !== undefined) s.match.setPosition(1, 0.5, 65, 0.5, 0, 0, height);
    s.host.clear();
    const w = p.slots[p.slot].def;
    const n = p.shotN;
    s.match.setStance(1, stance[0], stance[1]);
    s.match.fire(1, { t: 'fire', slot: 0, ox: 0.5, oy: 66.1, oz: 0.5, dx: 0, dy: 0, dz: 1, ads: false, ...claim });
    const shot = s.host.of('shot')[0];
    return {
      got: [shot.ex, shot.ey, shot.ez],
      want: (m, a) => {
        const rand: [number, number] = [0, 0];
        const dir: [number, number, number] = [0, 0, 0];
        spreadRandom(SEED, n, 0, rand);
        spreadDirection(0, 0, 1, shotSpread(w, false, m, a), rand[0], rand[1], dir);
        const tr = traceBullet(s.host.blocks, 0.5, 66.1, 0.5, dir[0], dir[1], dir[2], w.maxRange, createBulletTrace());
        return [0.5 + dir[0] * tr.t, 66.1 + dir[1] * tr.t, 0.5 + dir[2] * tr.t];
      },
    };
  }
  const close = (a: number[], b: number[]): boolean => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 0.05;

  it('the weapon pays for moving and air (otherwise the cases below prove nothing)', () => {
    const w = weaponDef('rifle')!;
    expect(shotSpread(w, false, true, false)).toBeGreaterThan(shotSpread(w, false, false, false));
    expect(shotSpread(w, false, false, true)).toBeGreaterThan(shotSpread(w, false, false, false));
  });

  it('a client that claims still and grounded while the server saw it jump and run gets the air and move spread', () => {
    const r = shoot({ mv: false, air: false }, [true, true]);
    expect(close(r.got, r.want(true, true))).toBe(true);
    expect(close(r.got, r.want(false, false))).toBe(false);
  });

  it('claiming moving and airborne while the server saw it stand gets the plain spread', () => {
    const r = shoot({ mv: true, air: true }, [false, false]);
    expect(close(r.got, r.want(false, false))).toBe(true);
    expect(close(r.got, r.want(true, true))).toBe(false);
  });

  it('each flag counts on its own', () => {
    const a = shoot({}, [false, true]);
    expect(close(a.got, a.want(false, true))).toBe(true);
    const m = shoot({}, [true, false]);
    expect(close(m.got, m.want(true, false))).toBe(true);
  });

  it('a sliding hitbox counts as moving', () => {
    const r = shoot({ mv: false }, [false, false], 0.9);
    expect(close(r.got, r.want(true, false))).toBe(true);
  });
});
