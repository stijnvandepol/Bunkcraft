import { describe, expect, it } from 'vitest';
import { createBulletTrace, shotSpread, spreadDirection, spreadRandom, traceBullet } from '../src/modes/Hitscan';
import { adsTimeFor, weaponDef } from '../src/modes/Weapons';
import { POSE } from '../src/player/ArcadeMove';
import { ADS_SLACK } from '../server/Match';
import { type Setup, live, place } from './helpers/matchHost';

/**
 * Aim down the sights is validated by the server: the spread of a shot follows the aim time the server saw (`ads` messages,
 * the weapon's aim time), never the `ads` flag of the `fire` message. Without a message (old clients, cheaters) it is hip fire.
 */

const SEED = 0x1234567;

/** A fresh duel: player 1 at the origin with a real spread seed, the opponent far away. */
function duel(): Setup {
  const s = live('ffa');
  s.match.players.get(1)!.spreadSeed = SEED; // the fake host deals 0 = no spread
  place(s, 1, 0.5, 65, 0.5);
  place(s, 2, 30.5, 65, 30.5);
  s.advance(0.3);
  return s;
}

/** Fires straight along +z claiming `claim`, and returns where the server's bullet ended and the one a given aim blend predicts. */
function shoot(s: Setup, claim: boolean, blend: number): { got: number[]; want: number[]; hip: number[]; full: number[] } {
  const p = s.match.players.get(1)!;
  const w = p.slots[p.slot].def;
  const n = p.shotN;
  s.host.clear();
  s.match.fire(1, { t: 'fire', slot: 0, ox: 0.5, oy: 66.62, oz: 0.5, dx: 0, dy: 0, dz: 1, ads: claim });
  const shot = s.host.of('shot')[0];
  const predict = (b: number): number[] => {
    const rand: [number, number] = [0, 0];
    const dir: [number, number, number] = [0, 0, 0];
    spreadRandom(SEED, n, 0, rand);
    spreadDirection(0, 0, 1, shotSpread(w, b, false, false), rand[0], rand[1], dir);
    const tr = traceBullet(s.host.blocks, 0.5, 66.62, 0.5, dir[0], dir[1], dir[2], w.maxRange, createBulletTrace());
    return [0.5 + dir[0] * tr.t, 66.62 + dir[1] * tr.t, 0.5 + dir[2] * tr.t];
  };
  return { got: [shot.ex, shot.ey, shot.ez], want: predict(blend), hip: predict(0), full: predict(1) };
}

function expectEnd(got: number[], want: number[]): void {
  for (let i = 0; i < 3; i++) expect(got[i]).toBeCloseTo(want[i], 1);
}

function farFrom(a: number[], b: number[]): boolean {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) > 0.05;
}

describe('server-validated ADS spread', () => {
  it('the weapon in the tests has a real ADS advantage (otherwise nothing below proves anything)', () => {
    const w = weaponDef('rifle')!;
    expect(shotSpread(w, true, false, false)).toBeLessThan(shotSpread(w, false, false, false) * 0.8);
  });

  it('claiming ADS without ever sending an ads message gets hip spread (old clients and cheaters)', () => {
    const s = duel();
    s.advance(2); // all the time in the world: still no message
    const r = shoot(s, true, 0);
    expectEnd(r.got, r.hip);
    // The aimed bullet would have gone elsewhere (so this is not a coincidence of the seed).
    expect(farFrom(r.got, r.full)).toBe(true);
  });

  it('claiming ADS right after the message gets (almost) hip spread: the aim time has not passed', () => {
    const s = duel();
    const p = s.match.players.get(1)!;
    s.match.setAds(1, true);
    const blend = s.match.adsBlend(p, s.host.now(), ADS_SLACK);
    const adsSec = adsTimeFor(p.slots[0].def, p.optic, p.perk);
    expect(blend).toBeCloseTo(ADS_SLACK / adsSec, 5);
    expect(blend).toBeLessThan(0.4);
    const r = shoot(s, true, blend);
    expectEnd(r.got, r.want);
  });

  it('after the weapon\'s aim time the sights count in full', () => {
    const s = duel();
    const p = s.match.players.get(1)!;
    s.match.setAds(1, true);
    s.advance(adsTimeFor(p.slots[0].def, p.optic, p.perk) + 0.1);
    expect(s.match.adsBlend(p, s.host.now())).toBe(1);
    const r = shoot(s, false, 1); // the claim does not matter, in either direction
    expectEnd(r.got, r.want);
    expect(farFrom(r.got, r.hip)).toBe(true);
  });

  it('halfway through the aim time the spread is halfway: the server wants the time, not the flag', () => {
    const s = duel();
    const p = s.match.players.get(1)!;
    const adsSec = adsTimeFor(p.slots[0].def, p.optic, p.perk);
    s.match.setAds(1, true);
    s.host.t += adsSec * 0.5;
    const blend = s.match.adsBlend(p, s.host.now(), ADS_SLACK);
    expect(blend).toBeCloseTo(0.5 + ADS_SLACK / adsSec, 5);
    const r = shoot(s, true, blend);
    expectEnd(r.got, r.want);
  });

  it('lowering the sights ends the bonus; flicking up and down gains nothing', () => {
    const s = duel();
    const p = s.match.players.get(1)!;
    const adsSec = adsTimeFor(p.slots[0].def, p.optic, p.perk);
    s.match.setAds(1, true);
    s.host.t += adsSec * 0.5;
    s.match.setAds(1, false);
    const kept = p.adsT;
    expect(kept).toBeCloseTo(0.5, 5);
    s.host.t += adsSec; // down for a while: it fell
    expect(s.match.adsBlend(p, s.host.now())).toBeLessThan(kept);
    s.match.setAds(1, true); // up again: from where it fell to, not from full
    expect(s.match.adsBlend(p, s.host.now())).toBeLessThan(kept);
    s.match.setAds(1, false);
    s.host.t += 5;
    expect(s.match.adsBlend(p, s.host.now())).toBe(0);
  });

  it('no sights while reloading: a request is ignored and a reload lowers them', () => {
    const s = duel();
    const p = s.match.players.get(1)!;
    const w = p.slots[0].def;
    s.match.setAds(1, true);
    s.advance(adsTimeFor(w, p.optic, p.perk) + 0.1);
    s.match.fire(1, { t: 'fire', slot: 0, ox: 0.5, oy: 66.62, oz: 0.5, dx: 0, dy: 0, dz: 1, ads: true }); // one round gone, so a reload is possible
    s.advance(0.5);
    s.match.reload(1, 0);
    expect(p.slots[0].reloadDoneAt).toBeGreaterThan(0);
    expect(p.adsOn).toBe(false);
    s.match.setAds(1, true);
    expect(p.adsOn).toBe(false);
    s.advance(0.2);
    expect(s.match.adsBlend(p, s.host.now(), ADS_SLACK)).toBeLessThan(1);
  });

  it('no sights while switching: the request is ignored until the switch delay is over, and a switch lowers them', () => {
    const s = duel();
    const p = s.match.players.get(1)!;
    s.match.setAds(1, true);
    s.advance(0.5);
    expect(p.adsOn).toBe(true);
    s.match.switchWeapon(1, 1);
    expect(p.adsOn).toBe(false);
    expect(p.adsT).toBe(0);
    s.match.setAds(1, true);
    expect(p.adsOn).toBe(false);
    s.advance(0.5);
    s.match.setAds(1, true);
    expect(p.adsOn).toBe(true);
  });

  it('no sights while sliding: a slide drops the aim time, a request during it is ignored', () => {
    const s = duel();
    const p = s.match.players.get(1)!;
    const w = p.slots[0].def;
    s.match.setAds(1, true);
    s.advance(adsTimeFor(w, p.optic, p.perk) + 0.1);
    s.match.setPosition(1, 0.5, 65, 0.5, 0, 0, POSE.SLIDE_HEIGHT);
    const r = shoot(s, true, 0);
    expectEnd(r.got, r.hip);
    expect(p.adsOn).toBe(false);
    s.advance(0.3);
    s.match.setAds(1, true);
    expect(p.adsOn).toBe(false);
    s.match.setPosition(1, 0.5, 65, 0.5, 0, 0);
    s.match.setAds(1, true);
    expect(p.adsOn).toBe(true);
  });

  it('the knife has no sights', () => {
    const s = duel();
    const p = s.match.players.get(1)!;
    s.match.switchWeapon(1, 2);
    s.advance(0.5);
    s.match.setAds(1, true);
    expect(p.adsOn).toBe(false);
  });

  it('a new life starts with the sights down', () => {
    const s = duel();
    const p = s.match.players.get(1)!;
    s.match.setAds(1, true);
    s.advance(0.5);
    expect(p.adsOn).toBe(true);
    s.match.giveGear(p, 'smg');
    expect(p.adsOn).toBe(false);
    expect(s.match.adsBlend(p, s.host.now())).toBe(0);
  });
});
