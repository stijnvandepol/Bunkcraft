import { describe, expect, it } from 'vitest';
import { BREATH_HOLD_SEC, BREATH_SPENT_SEC, RECOIL_RECOVER, RecoilState, SCOPE_SETTLE, SCOPE_SWAY, ScopeBreath, swayOffset } from '../src/modes/ArcadeLogic';
import { AIM_CLIMB, WEAPONS, fireInterval, weaponDef } from '../src/modes/Weapons';
import {
  GUN_SOUNDS, MECH_KINDS, MULTI_KILL_WINDOW, RELOAD_STEPS, SUPPRESSED_EARSHOT, boltTimes, gunEarshot, medalFor, outdoorShare, reloadSteps,
} from '../src/core/audio/weaponSounds';
import { buildCatalog } from '../src/core/audio/catalog';
import { OPTIC_MODELS, WEAPON_MODELS, adsCutZ, sightYFor, weaponFrontGeometry, weaponGeometry } from '../src/rendering/WeaponModels';

describe('scope breath and sway', () => {
  it('holding Shift steadies the scope until the breath runs out, then it sways harder for a while', () => {
    const b = new ScopeBreath();
    let t = 0;
    const step = (sec: number, hold: boolean, scoped = true) => {
      const cues: string[] = [];
      for (let i = 0; i < sec * 60; i++) { t += 1 / 60; const c = b.update(1 / 60, t, scoped, hold, false); if (c) cues.push(c); }
      return cues;
    };
    step(2, false);
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

  it('quickscope window: the scope is steady right after scoping in and sways fully only after a while (QA round 3)', () => {
    const b = new ScopeBreath();
    let t = 0;
    const step = (sec: number, scoped: boolean) => { for (let i = 0; i < sec * 60; i++) { t += 1 / 60; b.update(1 / 60, t, scoped, false, false); } };
    step(0.4, true);
    expect(b.amp).toBeLessThanOrEqual(SCOPE_SWAY.idle * SCOPE_SETTLE.start + 1e-9);
    // 0.24° × 0.2 ≈ 0.05°: a head (0.4 blocks) at 60 blocks is 0.38° tall, so a quickscope lands where the reticle is.
    expect(b.amp).toBeLessThan(0.06);
    step(2, true);
    expect(b.amp).toBeCloseTo(SCOPE_SWAY.idle, 2);
    // Out of the scope and back in: steady again at once.
    step(0.2, false);
    step(0.1, true);
    expect(b.amp).toBeLessThanOrEqual(SCOPE_SWAY.idle * SCOPE_SETTLE.start + 1e-9);
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
    expect(-back).toBeGreaterThan(pitch * (RECOIL_RECOVER.share - 0.05));
    expect(-back).toBeLessThanOrEqual(pitch * RECOIL_RECOVER.share + 1e-9);
    const aimed = new RecoilState().kick(0, lmg.recoil, lmg.recoilX, lmg.pattern, 1, AIM_CLIMB);
    expect(aimed.pitch).toBeLessThan(lmg.recoil * AIM_CLIMB);
  });

  it('a held trigger keeps climbing at any fire rate; ~70% comes back after letting go', () => {
    // Frame by frame like the game: recover() every frame, kick() on every shot (the 600 rpm rifle fires every 0.1 s).
    for (const id of ['rifle', 'smg', 'lmg', 'mpistol']) {
      const w = weaponDef(id)!;
      const r = new RecoilState();
      const dt = 1 / 60;
      let pitch = 0, rise = 0, next = 0, shots = 0;
      for (let t = 0; shots < 20; t += dt) {
        pitch += r.recover(t, dt);
        if (t >= next) { const k = r.kick(t, w.recoil, w.recoilX, w.pattern, 0, AIM_CLIMB, fireInterval(w)); pitch += k.pitch; rise += k.pitch; next += fireInterval(w); shots++; }
      }
      expect(pitch, `${id}: no recovery during the spray`).toBeCloseTo(rise, 6);
      let back = 0;
      for (let t = 10; t < 11.5; t += dt) back += r.recover(t, dt);
      expect(-back / rise, id).toBeGreaterThan(0.65);
    }
  });

  it('every gun has a recoil pattern', () => {
    for (const w of WEAPONS) expect(w.pattern.length, w.id).toBeGreaterThan(0);
  });
});

describe('bolt and lever cycle', () => {
  it('the cycle (back, forward, and the hand animation) is over before the next shot can go out, for every bolt weapon', () => {
    for (const w of WEAPONS.filter((x) => x.bolt)) {
      const iv = fireInterval(w);
      const t = boltTimes(iv);
      expect(t.delay + t.forward, `${w.id} sounds`).toBeLessThanOrEqual(iv * 0.91);
      expect(t.delay + t.anim, `${w.id} animation`).toBeLessThanOrEqual(iv * 0.96 + 0.15);
      expect(t.delay, w.id).toBeGreaterThan(0.05);
    }
    // The slow rifles keep the full 0.32 s + 0.2 s cycle.
    expect(boltTimes(1.33)).toMatchObject({ delay: 0.32, forward: 0.2 });
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

  it('aiming through a red dot or holo shows nothing between the eye and the optic window (no receiver back in view)', () => {
    for (const w of WEAPONS) {
      for (const o of w.optics) {
        if (o !== 'reddot' && o !== 'holo') continue;
        const geo = weaponFrontGeometry(w.id, o, false)!;
        const pos = geo.getAttribute('position');
        let maxZ = -Infinity;
        for (let i = 0; i < pos.count; i++) maxZ = Math.max(maxZ, pos.getZ(i));
        // +z is towards the eye: the closest part is the optic housing, not the receiver behind it.
        const window = WEAPON_MODELS[w.id].rail[1] + OPTIC_MODELS[o].windowZ;
        expect(maxZ, `${w.id}/${o}`).toBeLessThanOrEqual(adsCutZ(w.id, o) + 1e-6);
        expect(adsCutZ(w.id, o) - window, `${w.id}/${o}`).toBeLessThan(0.02);
        // The rest of the gun is still there in front of the window.
        expect(pos.count, `${w.id}/${o}`).toBeGreaterThan(24 * 4);
      }
    }
  });
});
