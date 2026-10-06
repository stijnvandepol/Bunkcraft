import { describe, expect, it } from 'vitest';
import { BREATH_HOLD_SEC, BREATH_SPENT_SEC, RecoilState, SCOPE_SWAY, ScopeBreath, swayOffset } from '../src/modes/ArcadeLogic';
import { AIM_CLIMB, WEAPONS, weaponDef } from '../src/modes/Weapons';
import {
  GUN_SOUNDS, MECH_KINDS, MULTI_KILL_WINDOW, RELOAD_STEPS, SUPPRESSED_EARSHOT, gunEarshot, medalFor, outdoorShare, reloadSteps,
} from '../src/core/audio/weaponSounds';
import { buildCatalog } from '../src/core/audio/catalog';
import { OPTIC_MODELS, WEAPON_MODELS, sightYFor, weaponGeometry } from '../src/rendering/WeaponModels';

describe('scope breath and sway', () => {
  it('holding Shift steadies the scope until the breath runs out, then it sways harder for a while', () => {
    const b = new ScopeBreath();
    let t = 0;
    const step = (sec: number, hold: boolean, scoped = true) => {
      const cues: string[] = [];
      for (let i = 0; i < sec * 60; i++) { t += 1 / 60; const c = b.update(1 / 60, t, scoped, hold, false); if (c) cues.push(c); }
      return cues;
    };
    step(1, false);
    expect(b.amp).toBeCloseTo(SCOPE_SWAY.idle, 2);
    expect(step(1, true)).toEqual(['hold']);
    expect(b.amp).toBeLessThan(SCOPE_SWAY.idle * 0.2);
    expect(step(BREATH_HOLD_SEC, true)).toEqual(['release']);
    expect(b.spent).toBe(true);
    expect(b.holding).toBe(false);
    step(0.5, true); // no holding while out of breath
    expect(b.amp).toBeGreaterThan(SCOPE_SWAY.idle);
    step(BREATH_SPENT_SEC + 3, false);
    expect(b.spent).toBe(false);
    expect(b.breath).toBe(1);
    // Not scoped: no holding at all.
    expect(step(1, true, false)).toEqual([]);
  });

  it('sway stays within its amplitude', () => {
    const o = { x: 0, y: 0 };
    for (let t = 0; t < 20; t += 0.05) {
      swayOffset(t, 0.3, o);
      expect(Math.abs(o.x)).toBeLessThanOrEqual(0.3 + 1e-9);
      expect(Math.abs(o.y)).toBeLessThanOrEqual(0.3 + 1e-9);
    }
  });
});

describe('recoil', () => {
  it('follows the weapon pattern, climbs less when aiming and recovers most of the climb after the trigger', () => {
    const lmg = weaponDef('lmg')!;
    const r = new RecoilState();
    const yaws: number[] = [];
    let pitch = 0;
    for (let i = 0; i < lmg.pattern.length; i++) {
      const k = r.kick(i * 0.08, lmg.recoil, lmg.recoilX, lmg.pattern, 0, AIM_CLIMB);
      yaws.push(k.yaw);
      pitch += k.pitch;
    }
    expect(yaws).toEqual(lmg.pattern.map((p) => p * lmg.recoilX));
    expect(pitch).toBeCloseTo(lmg.recoil * AIM_CLIMB * lmg.pattern.length, 9);
    let back = 0;
    for (let t = 1; t < 2; t += 1 / 60) back += r.recover(t, 1 / 60);
    expect(-back).toBeGreaterThan(pitch * 0.6);
    expect(-back).toBeLessThanOrEqual(pitch * 0.7 + 1e-9);
    const aimed = new RecoilState().kick(0, lmg.recoil, lmg.recoilX, lmg.pattern, 1, AIM_CLIMB);
    expect(aimed.pitch).toBeLessThan(lmg.recoil * AIM_CLIMB);
  });

  it('every gun has a recoil pattern', () => {
    for (const w of WEAPONS) expect(w.pattern.length, w.id).toBeGreaterThan(0);
  });
});

describe('weapon sound design', () => {
  it('every gun has a layered gunshot, a reload sequence and carries less far suppressed', () => {
    for (const w of WEAPONS) {
      if (w.slot === 'melee') continue;
      expect(GUN_SOUNDS[w.id], w.id).toBeDefined();
      expect(RELOAD_STEPS[w.id], w.id).toBeDefined();
      const steps = reloadSteps(w.id);
      for (let i = 1; i < steps.length; i++) expect(steps[i][0]).toBeGreaterThan(steps[i - 1][0]);
      for (const [at, kind] of steps) {
        expect(at).toBeGreaterThan(0);
        expect(at).toBeLessThan(1);
        expect(MECH_KINDS).toContain(kind);
      }
      expect(gunEarshot(w.id, true)).toBe(SUPPRESSED_EARSHOT);
      expect(gunEarshot(w.id, false)).toBeGreaterThan(SUPPRESSED_EARSHOT * 2);
    }
    // Bigger guns are heard further away.
    expect(gunEarshot('sniper', false)).toBeGreaterThan(gunEarshot('smg', false));
    expect(gunEarshot('smg', false)).toBeGreaterThan(gunEarshot('mpistol', false));
  });

  it('splits the tail between open air and rooms by enclosure', () => {
    expect(outdoorShare(0)).toBe(1);
    expect(outdoorShare(1)).toBe(0);
    for (let e = 0; e < 1; e += 0.05) expect(outdoorShare(e + 0.05)).toBeLessThanOrEqual(outdoorShare(e));
  });

  it('medals: multi-kills win over streaks; streaks at 3, 5 and 10', () => {
    expect(MULTI_KILL_WINDOW).toBeGreaterThan(2);
    expect(medalFor(1, 1)).toBeNull();
    expect(medalFor(2, 2)).toBe('double');
    expect(medalFor(3, 3)).toBe('triple');
    expect(medalFor(5, 5)).toBe('multi');
    expect(medalFor(1, 3)).toBe('streak3');
    expect(medalFor(1, 4)).toBeNull();
    expect(medalFor(1, 5)).toBe('streak5');
    expect(medalFor(1, 10)).toBe('streak10');
  });

  it('the audio catalog covers every gun (also suppressed, indoors and distant), handling, medals and stingers', () => {
    const names = new Set(buildCatalog().map((e) => e.name));
    for (const w of WEAPONS) {
      expect(names.has(`weapon.${w.id}`), w.id).toBe(true);
      if (w.slot !== 'melee') for (const v of ['suppressed', 'indoors', 'distant']) expect(names.has(`weapon.${w.id}.${v}`), `${w.id}.${v}`).toBe(true);
    }
    for (const k of MECH_KINDS) expect(names.has(`weapon.mech.${k}`), k).toBe(true);
    for (const k of ['start', 'win', 'lose', 'draw']) expect(names.has(`arcade.stinger.${k}`)).toBe(true);
    expect(names.has('arcade.medal.double')).toBe(true);
    expect(names.has('player.remote.step')).toBe(true);
  });
});

describe('weapon models with optics', () => {
  it('an optic raises the sight line above the iron sights, and geometry is shared per combination', () => {
    for (const w of WEAPONS) {
      for (const o of w.optics) {
        if (o === 'iron') continue;
        expect(sightYFor(w.id, o), `${w.id}/${o}`).toBeGreaterThan(WEAPON_MODELS[w.id].rail[0]);
        expect(OPTIC_MODELS[o]).toBeDefined();
      }
    }
    const a = weaponGeometry('rifle', 'reddot', true), b = weaponGeometry('rifle', 'reddot', true), c = weaponGeometry('rifle', 'holo', false);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(weaponGeometry('rifle', 'reddot', false)!.getAttribute('position').count).toBeLessThan(a!.getAttribute('position').count);
  });
});
