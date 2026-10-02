/**
 * Time-to-kill (TTK) tables for the arcade weapons: the current ones from src/modes/Weapons.ts plus
 * the proposed arsenal from docs/research/ARCADE.md. Design aid only; nothing in the game imports it.
 *
 *   npx tsx scripts/ttk-matrix.ts                # tables at 5 / 15 / 30 / 60 blocks
 *   npx tsx scripts/ttk-matrix.ts 15             # one distance
 *   npx tsx scripts/ttk-matrix.ts 15 --current   # current weapons only
 *   npx tsx scripts/ttk-matrix.ts 15 --aim=0.6   # human aim factor (share of shots whose centre is on the body)
 *
 * Model (approximations, no movement, no armour, health 100):
 *   perfect TTK   = time between the first and the last shot needed, every shot lands: (STK - 1) * interval
 *   spread hit %  = chance that a bullet aimed at the centre falls inside the body: min(1, (theta / spread)^2),
 *                   theta = atan(body radius / distance); bullets are uniform over the cone's disc (Combat.spreadDirection)
 *   realistic TTK = expected damage per shot = dmg * pellets * falloff * spread hit % * aim; STK = ceil(100 / that);
 *                   reloads are added when STK exceeds the magazine
 */
import { PLAYER_MAX_HEALTH, WEAPONS, type WeaponDef, damageAt, fireInterval } from '../src/modes/Weapons';

interface Burst { count: number; cycleSec: number; inBurstRpm: number }
type W = WeaponDef & { burstSpec?: Burst; proposed?: boolean };

const base = (id: string): WeaponDef => WEAPONS.find((w) => w.id === id)!;
const mk = (id: string, name: string, over: Partial<W>): W => ({ ...base('rifle'), id, name, proposed: true, ...over });

/** Proposed additions (numbers are starting points, see the balance section of ARCADE.md). */
const PROPOSED: W[] = [
  // Rebalanced versions of existing weapons (suffix 2).
  mk('smg2', 'SMG v2', { ...base('smg'), damage: 15, spread: 2.6, range: 16, falloffEnd: 50, moveSpeed: 1.08 }),
  mk('shotgun2', 'Shotgun v2', {
    ...base('shotgun'), damage: 13, pellets: 10, rpm: 70, spread: 4.5, adsSpread: 3.5, range: 6, falloffEnd: 20, minDamage: 0.15, maxRange: 40,
  }),
  mk('lmg', 'LMG', {
    slot: 'primary', auto: true, damage: 16, headshot: 1.8, rpm: 700, magazine: 60, reloadSec: 3.8, spread: 2.8, adsSpread: 1.0,
    range: 35, falloffEnd: 80, minDamage: 0.6, maxRange: 140, zoom: 0.85, moveSpeed: 0.9, recoil: 0.7,
  }),
  mk('dmr', 'DMR', {
    slot: 'primary', auto: false, damage: 34, headshot: 2, rpm: 270, magazine: 12, reloadSec: 2.0, spread: 3.5, adsSpread: 0.1,
    range: 60, falloffEnd: 140, minDamage: 0.7, maxRange: 250, zoom: 0.5, moveSpeed: 0.96, recoil: 1.6,
  }),
  mk('burst', 'Burst Rifle', {
    slot: 'primary', auto: false, damage: 22, headshot: 1.6, rpm: 900, magazine: 30, reloadSec: 1.7, spread: 2.0, adsSpread: 0.25,
    range: 45, falloffEnd: 100, minDamage: 0.6, maxRange: 160, zoom: 0.75, moveSpeed: 1, recoil: 1.2,
    burstSpec: { count: 3, cycleSec: 0.38, inBurstRpm: 900 },
  }),
  mk('akimbo', 'Akimbo SMGs', {
    slot: 'primary', auto: true, damage: 10, headshot: 1.5, rpm: 1400, magazine: 40, reloadSec: 2.1, spread: 4.0, adsSpread: 3.2,
    range: 14, falloffEnd: 40, minDamage: 0.4, maxRange: 70, zoom: 1, moveSpeed: 1.08, recoil: 0.5,
  }),
  mk('revolver', 'Revolver', {
    slot: 'primary', auto: false, damage: 52, headshot: 2, rpm: 150, magazine: 6, reloadSec: 2.4, spread: 2.5, adsSpread: 0.15,
    range: 30, falloffEnd: 70, minDamage: 0.6, maxRange: 150, zoom: 0.85, moveSpeed: 1, recoil: 4.5,
  }),
  mk('machete', 'Machete', {
    slot: 'melee', auto: false, damage: 70, headshot: 1, rpm: 90, magazine: 0, reloadSec: 0, spread: 0, adsSpread: 0, range: 2.4,
    falloffEnd: 2.4, minDamage: 1, maxRange: 2.4, zoom: 1, moveSpeed: 1.05, recoil: 0,
  }),
  mk('dagger', 'Dagger', {
    slot: 'melee', auto: false, damage: 36, headshot: 1, rpm: 220, magazine: 0, reloadSec: 0, spread: 0, adsSpread: 0, range: 2.2,
    falloffEnd: 2.2, minDamage: 1, maxRange: 2.2, zoom: 1, moveSpeed: 1.1, recoil: 0,
  }),
];

const BODY_RADIUS = 0.55; // blocks: radius of a circle with the area of the hit box seen from the front (0.6 x 1.8)
const HIP_RANGE = 7; // up to this distance the model assumes hip fire (close-range fights), beyond it ADS

function shotTime(w: W, n: number): number {
  // Time of shot number n (1-based), first shot at 0.
  if (!w.burstSpec) return (n - 1) * fireInterval(w);
  const k = n - 1;
  return Math.floor(k / w.burstSpec.count) * w.burstSpec.cycleSec + (k % w.burstSpec.count) * (60 / w.burstSpec.inBurstRpm);
}

function spreadHit(w: W, dist: number, ads: boolean): number {
  const s = ads ? w.adsSpread : w.spread;
  if (s <= 0 || w.range < 5) return 1;
  const theta = (Math.atan(BODY_RADIUS / Math.max(1, dist)) * 180) / Math.PI;
  return Math.min(1, (theta / s) ** 2);
}

/** Shots to kill and ms for a given damage per shot (already including pellets and falloff). */
function ttk(w: W, perShot: number): { stk: number; ms: number } {
  if (perShot <= 0) return { stk: Infinity, ms: Infinity };
  const stk = Math.ceil(PLAYER_MAX_HEALTH / perShot - 1e-9);
  let ms = shotTime(w, stk) * 1000;
  if (w.magazine > 0 && stk > w.magazine) ms += Math.floor((stk - 1) / w.magazine) * w.reloadSec * 1000;
  return { stk, ms: Math.round(ms) };
}

function perfect(w: W, dist: number, head: boolean): { stk: number; ms: number } {
  if (dist > w.maxRange) return { stk: Infinity, ms: Infinity };
  return ttk(w, damageAt(w, dist) * w.pellets * (head ? w.headshot : 1));
}

function realistic(w: W, dist: number, aim: number): { stk: number; ms: number } {
  if (dist > w.maxRange) return { stk: Infinity, ms: Infinity };
  const p = spreadHit(w, dist, dist > HIP_RANGE) * aim;
  return ttk(w, damageAt(w, dist) * w.pellets * p);
}

const fmt = (v: number, w = 6): string => (Number.isFinite(v) ? String(v) : '-').padStart(w);

function main(): void {
  const args = process.argv.slice(2);
  const dists = args.filter((a) => /^\d+(\.\d+)?$/.test(a)).map(Number);
  const aim = Number((args.find((a) => a.startsWith('--aim=')) ?? '--aim=0.75').slice(6));
  const list: W[] = (args.includes('--current') ? [...WEAPONS] : [...WEAPONS, ...PROPOSED]) as W[];
  const ranges = dists.length ? dists : [5, 15, 30, 60];
  const guns = list.filter((w) => w.slot !== 'melee');

  console.log(`Health ${PLAYER_MAX_HEALTH}, aim factor ${aim}, body radius ${BODY_RADIUS} blocks, hip fire up to ${HIP_RANGE} blocks. ms = first to last shot; * = proposed.\n`);

  console.log('--- Perfect aim (all shots land), STK = shots to kill, per distance (blocks)');
  console.log('weapon'.padEnd(14) + 'rpm'.padStart(6) + 'mag'.padStart(5) + ranges.map((d) => `${d}m body`.padStart(14) + `${d}m head`.padStart(14)).join(''));
  for (const w of list) {
    const row = ranges.map((d) => {
      const b = perfect(w, d, false), h = perfect(w, d, true);
      return `${fmt(b.stk, 3)}x ${fmt(b.ms, 5)}ms `.padStart(14) + `${fmt(h.stk, 3)}x ${fmt(h.ms, 5)}ms `.padStart(14);
    }).join('');
    console.log(((w.proposed ? '*' : ' ') + w.name).padEnd(14) + String(w.rpm).padStart(6) + String(w.magazine).padStart(5) + row);
  }

  for (const d of ranges) {
    console.log(`\n--- Realistic TTK at ${d} blocks (${d > HIP_RANGE ? 'ADS' : 'hip fire'}, spread hit % x aim ${aim}), body only`);
    console.log('weapon'.padEnd(14) + 'spread-hit%'.padStart(12) + 'STK'.padStart(6) + 'TTK ms'.padStart(9));
    for (const w of list) {
      const r = realistic(w, d, aim);
      console.log(((w.proposed ? '*' : ' ') + w.name).padEnd(14) + `${Math.round(spreadHit(w, d, d > HIP_RANGE) * 100)}%`.padStart(12) + fmt(r.stk) + fmt(r.ms, 9));
    }
    console.log(`\nDuel matrix at ${d} blocks: row TTK minus column TTK in ms (negative = row kills first; |x| < 150 = toss-up, reaction time)`);
    console.log(''.padEnd(14) + guns.map((w) => w.id.slice(0, 7).padStart(8)).join(''));
    for (const a of guns) {
      const ta = realistic(a, d, aim).ms;
      console.log(a.name.padEnd(14) + guns.map((b) => {
        const tb = realistic(b, d, aim).ms;
        if (!Number.isFinite(ta) && !Number.isFinite(tb)) return '       .';
        if (!Number.isFinite(ta)) return '    loss';
        if (!Number.isFinite(tb)) return '     win';
        const diff = ta - tb;
        return (Math.abs(diff) < 150 ? '~' : '').concat(String(diff)).padStart(8);
      }).join(''));
    }
  }
}

main();
