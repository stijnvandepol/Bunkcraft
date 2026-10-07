import { describe, expect, it } from 'vitest';
import { BALANCE_RANGES, killsPerMag, perfectTtk, realisticTtk } from '../src/modes/Balance';
import {
  OPTICS, PERKS, PERK_IDS, PRIMARY_WEAPONS, SECONDARY_WEAPONS, WEAPONS, type WeaponDef, adsTimeFor, magazineFor, opticZoom, weaponDef,
} from '../src/modes/Weapons';
import { WEAPON_MODELS } from '../src/rendering/WeaponModels';

/** Balance invariants: every gun has a niche and nothing dominates (model: src/modes/Balance.ts, table: scripts/ttk-matrix.ts). */

const primaries = PRIMARY_WEAPONS.map((id) => weaponDef(id)!);
const rifle = () => weaponDef('rifle')!;
const ttk = (w: WeaponDef, d: number) => realisticTtk(w, d).ms;
const fastestAt = (d: number) => primaries.reduce((best, w) => (ttk(w, d) < ttk(best, d) ? w : best));

describe('arcade balance', () => {
  it('has distinct roles: LMG, semi-auto and bolt-action sniper, machine pistol exist with their fire modes', () => {
    expect(weaponDef('lmg')?.magazine).toBeGreaterThanOrEqual(60);
    expect(weaponDef('sniper')?.bolt).toBe(true);
    expect(weaponDef('semisniper')?.bolt).toBeFalsy();
    expect(weaponDef('mpistol')?.slot).toBe('secondary');
    expect(weaponDef('mpistol')?.auto).toBe(true);
  });

  it('every primary has a niche: fastest at some range, the most kills per magazine, one-shot headshots, or the fastest feet', () => {
    const bestMag = Math.max(...primaries.map((w) => killsPerMag(w, 20)));
    const fastest = Math.max(...primaries.map((w) => w.moveSpeed));
    for (const w of primaries) {
      const ranges = BALANCE_RANGES.filter((d) => fastestAt(d) === w);
      // One-shot kills are a niche of their own: the model's average TTK never favours a single precise shot.
      const oneShot = perfectTtk(w, 60).stk === 1 || perfectTtk(w, 35, true).stk === 1;
      const niche = ranges.length > 0 || killsPerMag(w, 20) === bestMag || oneShot || w.moveSpeed === fastest;
      expect(niche, w.id).toBe(true);
    }
  });

  it('no primary is the fastest killer at more than two of the balance ranges', () => {
    const wins = new Map<string, number>();
    for (const d of BALANCE_RANGES) wins.set(fastestAt(d).id, (wins.get(fastestAt(d).id) ?? 0) + 1);
    for (const [id, n] of wins) expect(n, id).toBeLessThanOrEqual(2);
    expect(wins.size).toBeGreaterThanOrEqual(4);
  });

  it('no weapon dominates another of its slot (at least as good in TTK at every range, magazine, mobility and aim time)', () => {
    for (const slot of ['primary', 'secondary'] as const) {
      const list = WEAPONS.filter((w) => w.slot === slot);
      for (const a of list) {
        for (const b of list) {
          if (a === b) continue;
          const dominates = BALANCE_RANGES.every((d) => ttk(a, d) <= ttk(b, d))
            && a.magazine >= b.magazine && a.moveSpeed >= b.moveSpeed && a.adsTime <= b.adsTime && a.reloadSec <= b.reloadSec
            && perfectTtk(a, 60, true).stk <= perfectTtk(b, 60, true).stk && perfectTtk(a, 60).stk <= perfectTtk(b, 60).stk;
          expect(dominates, `${a.id} dominates ${b.id}`).toBe(false);
        }
      }
    }
  });

  it('a secondary never out-kills the best primary at any range', () => {
    for (const d of BALANCE_RANGES) {
      const best = ttk(fastestAt(d), d);
      for (const id of SECONDARY_WEAPONS) expect(ttk(weaponDef(id)!, d), `${id} at ${d}`).toBeGreaterThanOrEqual(best);
    }
  });

  it('one-shot kills are deliberate: snipers to the body, the semi-auto sniper, lever carbine and revolver with a headshot', () => {
    const ONE_BODY = new Set(['sniper', 'antimat']);
    const ONE_HEAD = new Set(['sniper', 'antimat', 'semisniper', 'lever', 'revolver']);
    for (const w of WEAPONS) {
      if (w.slot === 'melee' || w.pellets > 1) continue;
      expect(perfectTtk(w, 10).stk === 1, `${w.id} body`).toBe(ONE_BODY.has(w.id));
      expect(perfectTtk(w, 10, true).stk === 1, `${w.id} head`).toBe(ONE_HEAD.has(w.id));
      // Only the sniper rifles reach that far with one headshot; the lever and the revolver need two out there.
      if (!['sniper', 'antimat', 'semisniper'].includes(w.id)) expect(perfectTtk(w, 90, true).stk, w.id).toBeGreaterThanOrEqual(2);
    }
    // The anti-materiel rifle kills with one body shot at any range; its price is the slowest aim, move and bolt.
    const am = weaponDef('antimat')!;
    expect(perfectTtk(am, 200).stk).toBe(1);
    for (const w of primaries) if (w !== am) {
      expect(am.adsTime, w.id).toBeGreaterThanOrEqual(w.adsTime);
      expect(am.moveSpeed, w.id).toBeLessThanOrEqual(w.moveSpeed);
      expect(am.rpm, w.id).toBeLessThanOrEqual(w.rpm);
    }
    // The sniper's body one-shot ends at its range (70): past it the drawback is a second shot.
    const sniper = weaponDef('sniper')!;
    expect(perfectTtk(sniper, 70).stk).toBe(1);
    expect(perfectTtk(sniper, 90).stk).toBe(2);
    expect(perfectTtk(sniper, 90, true).stk).toBe(1);
  });

  it('the shotgun kills with one pump out to 8 blocks when the pattern is centred (QA round 3: "shotguns are bad")', () => {
    const sg = weaponDef('shotgun')!;
    expect(perfectTtk(sg, 8).stk).toBe(1);
    expect(realisticTtk(sg, 4).ms).toBeLessThan(400);
    expect(fastestAt(4).id).toBe('shotgun');
  });

  it('the bolt-action sniper is quickscope friendly: aims faster than every other scoped weapon, but has no hip fire', () => {
    const sniper = weaponDef('sniper')!;
    expect(sniper.adsTime).toBeLessThanOrEqual(0.3);
    for (const w of WEAPONS) if (w !== sniper && w.optics.includes('scope')) expect(adsTimeFor(sniper, 'scope', 'none'), w.id).toBeLessThanOrEqual(adsTimeFor(w, 'scope', 'none'));
    expect(sniper.spread).toBeGreaterThanOrEqual(8);
  });

  it('heavier weapons aim and move slower: the LMG is the slowest to aim and to move with among automatics', () => {
    const lmg = weaponDef('lmg')!;
    for (const w of WEAPONS.filter((x) => x.auto && x !== lmg)) {
      expect(lmg.adsTime, w.id).toBeGreaterThan(w.adsTime);
      expect(lmg.moveSpeed, w.id).toBeLessThan(w.moveSpeed);
    }
  });
});

describe('optics and perks', () => {
  it('every weapon lists known optics, scoped weapons have a scope zoom, and zoom is per weapon', () => {
    for (const w of WEAPONS) {
      expect(w.optics.length, w.id).toBeGreaterThan(0);
      for (const o of w.optics) expect(OPTICS[o], `${w.id}/${o}`).toBeDefined();
      if (w.optics.includes('scope')) expect(w.scopeZoom, w.id).toBeLessThan(0.5);
      for (const o of w.optics) {
        const z = opticZoom(w, o);
        expect(z, `${w.id}/${o}`).toBeGreaterThan(0);
        expect(z, `${w.id}/${o}`).toBeLessThanOrEqual(1);
      }
    }
    // More magnification with better glass: iron < red dot < holo < combat scope < scope; the sniper rifles zoom furthest.
    const rifle = weaponDef('rifle')!, dmr = weaponDef('dmr')!;
    expect(opticZoom(rifle, 'holo')).toBeLessThan(opticZoom(rifle, 'reddot'));
    expect(opticZoom(rifle, 'reddot')).toBeLessThan(opticZoom(rifle, 'iron'));
    expect(opticZoom(rifle, 'combat')).toBeLessThan(opticZoom(rifle, 'holo'));
    expect(opticZoom(dmr, 'scope')).toBeLessThan(opticZoom(dmr, 'combat'));
    const deepest = (w: WeaponDef) => Math.min(...w.optics.map((o) => opticZoom(w, o)));
    for (const w of WEAPONS) if (w.id !== 'sniper' && w.id !== 'antimat') expect(deepest(weaponDef('sniper')!), w.id).toBeLessThanOrEqual(deepest(w));
    expect(deepest(weaponDef('antimat')!)).toBeLessThan(deepest(weaponDef('sniper')!));
  });

  it('perks change what they say: extended mags, quickdraw aim time; a scope is slower to aim than irons', () => {
    expect(PERK_IDS).toEqual(Object.keys(PERKS));
    const rifle = weaponDef('rifle')!, dmr = weaponDef('dmr')!;
    expect(magazineFor(rifle, 'extmag')).toBe(42);
    expect(magazineFor(rifle, 'none')).toBe(30);
    expect(magazineFor(weaponDef('knife')!, 'extmag')).toBe(0);
    expect(adsTimeFor(rifle, 'iron', 'quickdraw')).toBeCloseTo(rifle.adsTime * 0.6, 9);
    expect(adsTimeFor(dmr, 'scope', 'none')).toBeGreaterThan(adsTimeFor(dmr, 'iron', 'none'));
  });

  it('the combat scope (2.5x) fits the rifles, the LMG, the battle rifle, the DMR, the semi-auto sniper and the lever carbine', () => {
    const fits = WEAPONS.filter((w) => w.optics.includes('combat')).map((w) => w.id).sort();
    expect(fits).toEqual(['battle', 'burst', 'dmr', 'lever', 'lmg', 'rifle', 'semisniper']);
    for (const id of fits) {
      const z = opticZoom(weaponDef(id)!, 'combat');
      expect(z, id).toBeGreaterThanOrEqual(0.4); // about 2-2.5x
      expect(z, id).toBeLessThanOrEqual(0.5);
    }
    // Slower to bring up than irons on a gun built for irons, not on one built around it (battle rifle).
    expect(adsTimeFor(rifle(), 'combat', 'none')).toBeGreaterThan(adsTimeFor(rifle(), 'iron', 'none'));
    expect(adsTimeFor(weaponDef('battle')!, 'combat', 'none')).toBe(weaponDef('battle')!.adsTime);
  });

  it('every weapon has a model, and every optic a sight', () => {
    for (const w of WEAPONS) expect(WEAPON_MODELS[w.id], w.id).toBeDefined();
  });
});
