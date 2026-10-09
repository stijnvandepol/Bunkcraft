import { describe, expect, it } from 'vitest';
import { KB, KEYBINDS, conflictingActions, defaultKeybinds } from '../src/core/Keybinds';
import {
  FireControl, KILL_FEED_LIFETIME, KILL_FEED_MAX, KillFeed, SPECTATE_KILLER_SECONDS, cycleSlot, cycleTarget, currentSpread, damageAngle, formatClock, impactNormal, kdRatio,
  reloadProgress, sortRoster, spectateCandidates, spreadPixels, teamKills,
} from '../src/modes/ArcadeLogic';
import { WEAPONS, fireInterval, weaponDef } from '../src/modes/Weapons';
import type { RosterEntry } from '../src/net/protocol';

const rifle = weaponDef('rifle')!;
const sniper = weaponDef('sniper')!;

describe('crosshair size', () => {
  it('is zero for a perfect weapon and grows with the cone', () => {
    expect(spreadPixels(0, 70, 720)).toBe(0);
    expect(spreadPixels(4, 70, 720)).toBeGreaterThan(spreadPixels(2, 70, 720));
  });

  it('matches the projection of the cone on the screen', () => {
    // 45° vertical fov: half the screen height (tan 22.5° ↔ 360 px) per tan(spread).
    const px = spreadPixels(5, 45, 720);
    expect(px).toBeCloseTo((Math.tan((5 * Math.PI) / 180) / Math.tan((22.5 * Math.PI) / 180)) * 360, 6);
  });

  it('looks bigger on screen when zoomed in (narrower field of view)', () => {
    expect(spreadPixels(1, 35, 720)).toBeGreaterThan(spreadPixels(1, 70, 720));
  });

  it('tightens when aiming and loosens when moving or airborne', () => {
    expect(currentSpread(rifle, 0, false, false)).toBe(rifle.spread);
    expect(currentSpread(rifle, 1, false, false)).toBeCloseTo(rifle.adsSpread, 9);
    expect(currentSpread(rifle, 0.5, false, false)).toBeCloseTo((rifle.spread + rifle.adsSpread) / 2, 9);
    expect(currentSpread(rifle, 0, true, false)).toBeGreaterThan(rifle.spread);
    expect(currentSpread(rifle, 0, true, true)).toBeGreaterThan(currentSpread(rifle, 0, true, false));
    expect(currentSpread(sniper, 1, false, false)).toBeCloseTo(0, 9);
  });
});

describe('fire control', () => {
  /** Shots fired in `seconds` of holding (or clicking every frame) at a frame rate. */
  function shots(rpm: number, auto: boolean, seconds: number, fps: number, click: boolean): number {
    const fc = new FireControl();
    const interval = 60 / rpm;
    let n = 0;
    for (let f = 0; f < seconds * fps; f++) {
      if (fc.tryFire(1 + f / fps, interval, auto, true, click)) n++;
    }
    return n;
  }

  it('holds an automatic weapon to its rate, whatever the frame rate', () => {
    expect(shots(600, true, 2, 60, false)).toBeGreaterThanOrEqual(19);
    expect(shots(600, true, 2, 60, false)).toBeLessThanOrEqual(21);
    expect(shots(600, true, 2, 144, false)).toBeLessThanOrEqual(21);
    expect(shots(600, true, 2, 20, false)).toBeGreaterThanOrEqual(18);
  });

  it('semi-automatic weapons need a fresh click per shot and still respect the rate', () => {
    const fc = new FireControl();
    expect(fc.tryFire(1, 0.8, false, true, false)).toBe(false);
    expect(fc.tryFire(1, 0.8, false, true, true)).toBe(true);
    expect(fc.tryFire(1.2, 0.8, false, true, true)).toBe(false);
    expect(fc.tryFire(1.9, 0.8, false, true, true)).toBe(true);
  });

  it('never lets two clicks of a semi-automatic go out closer than its interval, however the clicks are paced (no rhythm debt)', () => {
    // Clicking a little slower than the fire rate used to build a debt that let a fast click follow only ~0.1 s after a shot;
    // the server holds the cadence strictly and dropped that shot (sound and kick here, nothing there).
    for (const [interval, pace] of [[0.25, 0.28], [0.25, 0.31], [0.15, 0.17], [0.5, 0.57], [1.33, 1.5]]) {
      const fc = new FireControl();
      let t = 1, last = -1e9, shotsOut = 0;
      for (let i = 0; i < 40; i++) {
        // Every few clicks a quick double click (the debt would have paid out here).
        for (const dt of i % 5 === 4 ? [0, 0.07, 0.1] : [0]) {
          if (fc.tryFire(t + dt, interval, false, true, true)) {
            expect(t + dt - last, `interval ${interval} pace ${pace} click ${i}`).toBeGreaterThanOrEqual(interval - 1e-9);
            last = t + dt;
            shotsOut++;
          }
        }
        t += pace;
      }
      expect(shotsOut).toBeGreaterThan(30);
    }
  });

  it('a rested trigger never makes two shots follow each other faster than the server accepts (taps and pauses of every length)', () => {
    // Every shot the client lets out must be one the server accepts (zero latency).
    for (const [interval, auto] of [[0.1, true], [0.0667, true], [0.5, false], [2, false], [1.33, false]] as const) {
      const fc = new FireControl();
      // The server's cadence (Match.fire: FIRE_SLACK = 0.04): a message earlier than nextFire - slack is dropped.
      let serverNext = 0, shotsOut = 0, seed = 7;
      const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
      let held = false, holdUntil = 0;
      for (let f = 0; f < 60 * 120; f++) {
        const now = 1 + f / 60;
        if (now >= holdUntil) { held = !held; holdUntil = now + (held ? 0.05 + rnd() * 1.5 : rnd() * interval * 2.2); }
        const click = held && holdUntil - now > 0 && now - (holdUntil - 0) < 0 && f % 7 === 0;
        if (fc.tryFire(now, interval, auto, held, auto ? held : click)) {
          expect(now, `${interval} ${auto} shot ${shotsOut}`).toBeGreaterThanOrEqual(serverNext - 0.04 - 1e-9);
          serverNext = Math.max(serverNext, now - 0.04) + interval;
          shotsOut++;
        }
      }
      expect(shotsOut).toBeGreaterThan(20);
    }
  });

  it('does not fire without the trigger, and does not burst after a pause', () => {
    const fc = new FireControl();
    expect(fc.tryFire(5, 0.1, true, false, false)).toBe(false);
    expect(fc.tryFire(10, 0.1, true, true, true)).toBe(true);
    expect(fc.tryFire(10.01, 0.1, true, true, false)).toBe(false);
  });

  it('delay blocks the trigger (weapon switch)', () => {
    const fc = new FireControl();
    fc.delay(1, 0.3);
    expect(fc.tryFire(1.1, 0.1, true, true, true)).toBe(false);
    expect(fc.tryFire(1.31, 0.1, true, true, true)).toBe(true);
  });

  it('the fire intervals of the weapon table are in seconds', () => {
    expect(fireInterval(rifle)).toBeCloseTo(60 / rifle.rpm, 9);
    expect(fireInterval(rifle)).toBeGreaterThan(0.09);
    for (const w of WEAPONS) expect(fireInterval(w)).toBeGreaterThan(0);
  });
});

describe('damage direction', () => {
  const forward = (yaw: number) => ({ x: -Math.sin(yaw), z: -Math.cos(yaw) });

  it('is 0 for an attacker straight ahead, whatever the view', () => {
    for (const yaw of [0, 1, -2.5, Math.PI]) {
      const f = forward(yaw);
      expect(damageAngle(f.x * 7, f.z * 7, yaw)).toBeCloseTo(0, 9);
    }
  });

  it('is +90° on the right, -90° on the left and 180° behind', () => {
    const yaw = 0.7;
    const f = forward(yaw);
    const right = { x: Math.cos(yaw), z: -Math.sin(yaw) };
    expect(damageAngle(right.x, right.z, yaw)).toBeCloseTo(Math.PI / 2, 9);
    expect(damageAngle(-right.x, -right.z, yaw)).toBeCloseTo(-Math.PI / 2, 9);
    expect(Math.abs(damageAngle(-f.x, -f.z, yaw))).toBeCloseTo(Math.PI, 9);
  });

  it('turns with the view', () => {
    // A source due north (−z) is ahead at yaw 0 and on the right when we turn left by 90°.
    expect(damageAngle(0, -5, 0)).toBeCloseTo(0, 9);
    expect(damageAngle(0, -5, Math.PI / 2)).toBeCloseTo(Math.PI / 2, 9);
  });
});

describe('scoreboard', () => {
  const p = (id: number, name: string, kills: number, deaths: number, team: 'red' | 'blue' | '' = ''): RosterEntry => ({ id, name, team, kills, deaths, ping: 0 });

  it('sorts by kills, then fewer deaths, then name, without touching the input', () => {
    const roster = [p(1, 'delta', 5, 2), p(2, 'alpha', 9, 4), p(3, 'charlie', 5, 1), p(4, 'bravo', 5, 2)];
    const sorted = sortRoster(roster);
    expect(sorted.map((r) => r.name)).toEqual(['alpha', 'charlie', 'bravo', 'delta']);
    expect(roster[0].name).toBe('delta');
  });

  it('sums team kills and ignores players without a team', () => {
    expect(teamKills([p(1, 'a', 4, 0, 'red'), p(2, 'b', 3, 0, 'red'), p(3, 'c', 5, 0, 'blue'), p(4, 'd', 9, 0)])).toEqual({ red: 7, blue: 5 });
  });

  it('formats K/D and the match clock', () => {
    expect(kdRatio(6, 3)).toBe('2.00');
    expect(kdRatio(4, 0)).toBe('4.00');
    expect(formatClock(605)).toBe('10:05');
    expect(formatClock(59.2)).toBe('1:00');
    expect(formatClock(-3)).toBe('0:00');
  });
});

describe('kill feed', () => {
  const entry = (born: number) => ({ killer: 'a', victim: 'b', killerTeam: 'red' as const, victimTeam: 'blue' as const, weapon: 'rifle', head: false, born });

  it('expires entries after their lifetime and reports changes', () => {
    const feed = new KillFeed();
    feed.add(entry(0));
    feed.add(entry(4));
    expect(feed.prune(KILL_FEED_LIFETIME - 0.1)).toBe(false);
    expect(feed.prune(KILL_FEED_LIFETIME + 0.1)).toBe(true);
    expect(feed.entries).toHaveLength(1);
    expect(feed.prune(100)).toBe(true);
    expect(feed.entries).toHaveLength(0);
  });

  it('keeps only the newest few', () => {
    const feed = new KillFeed();
    for (let i = 0; i < KILL_FEED_MAX + 3; i++) feed.add(entry(i * 0.1));
    expect(feed.entries).toHaveLength(KILL_FEED_MAX);
    expect(feed.entries[KILL_FEED_MAX - 1].born).toBeCloseTo((KILL_FEED_MAX + 2) * 0.1, 9);
  });
});

describe('bullet impacts', () => {
  const n = { x: 0, y: 0, z: 0 };

  it('points the normal back against the bullet on the nearest block face', () => {
    impactNormal(10, 4.5, 3.5, 1, 0, 0, n); // hit the −x face of the block at x = 10
    expect(n).toEqual({ x: -1, y: 0, z: 0 });
    impactNormal(3.5, 7, 3.5, 0, -1, 0, n); // hit the top of a block
    expect(n).toEqual({ x: 0, y: 1, z: 0 });
    impactNormal(3.5, 4.5, 12, 0, 0, -1, n);
    expect(n).toEqual({ x: 0, y: 0, z: 1 });
  });
});

describe('weapon slots and reload', () => {
  it('cycles through the three slots in both directions', () => {
    expect(cycleSlot(0, 1)).toBe(1);
    expect(cycleSlot(2, 1)).toBe(0);
    expect(cycleSlot(0, -1)).toBe(2);
  });

  it('reload progress is clamped to 0..1', () => {
    expect(reloadProgress(0.8, 1.6)).toBeCloseTo(0.5, 9);
    expect(reloadProgress(5, 1.6)).toBe(1);
    expect(reloadProgress(-1, 1.6)).toBe(0);
    expect(reloadProgress(1, 0)).toBe(1);
  });
});

describe('arcade key binds', () => {
  it('default binds have no conflicts, although sandbox and arcade actions share keys', () => {
    expect(conflictingActions(defaultKeybinds()).size).toBe(0);
    // Digit1 is both Hotbar Slot 1 and Primary Weapon.
    const digit1 = KEYBINDS.filter((k) => k.defaultCode === 'Digit1');
    expect(digit1.length).toBe(2);
  });

  it('still flags two actions of the same game on one key', () => {
    const map = defaultKeybinds();
    map[KEYBINDS[KB.RELOAD].id] = map[KEYBINDS[KB.SCOREBOARD].id];
    const bad = conflictingActions(map);
    expect(bad.has(KB.RELOAD)).toBe(true);
    expect(bad.has(KB.SCOREBOARD)).toBe(true);
    // A shared action (Jump) on an arcade key conflicts too.
    const map2 = defaultKeybinds();
    map2[KEYBINDS[KB.JUMP].id] = map2[KEYBINDS[KB.RELOAD].id];
    expect(conflictingActions(map2).has(KB.JUMP)).toBe(true);
  });
});

describe('spectating after death', () => {
  const players = new Map<number, { team: string }>([
    [1, { team: 'red' }], [2, { team: 'red' }], [3, { team: 'blue' }], [4, { team: 'red' }], [5, { team: 'blue' }],
  ]);
  const alive = (id: number) => id !== 4;

  it('follows the killer for one second', () => {
    expect(SPECTATE_KILLER_SECONDS).toBe(1);
  });

  it('team deathmatch offers the living teammates only, never yourself', () => {
    expect(spectateCandidates(players, 1, 'red', true, alive, [])).toEqual([2]);
    expect(spectateCandidates(players, 3, 'blue', true, alive, [])).toEqual([5]);
  });

  it('free for all offers every other living player', () => {
    expect(spectateCandidates(players, 1, '', false, alive, [])).toEqual([2, 3, 5]);
  });

  it('reuses the output array and handles nobody being left', () => {
    const out = [99];
    expect(spectateCandidates(players, 1, 'red', true, () => false, out)).toBe(out);
    expect(out).toEqual([]);
    expect(cycleTarget(out, 0, 1)).toBe(0);
  });

  it('cycles forward and backward with wrap-around', () => {
    const list = [2, 3, 5];
    expect(cycleTarget(list, 2, 1)).toBe(3);
    expect(cycleTarget(list, 5, 1)).toBe(2);
    expect(cycleTarget(list, 2, -1)).toBe(5);
    expect(cycleTarget(list, 3, -1)).toBe(2);
  });

  it('starts at the first or last candidate when the current target is gone', () => {
    expect(cycleTarget([2, 3, 5], 9, 1)).toBe(2);
    expect(cycleTarget([2, 3, 5], 9, -1)).toBe(5);
    expect(cycleTarget([7], 7, 1)).toBe(7);
  });
});
