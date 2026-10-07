/**
 * QA round 3: shotgun and sniper before/after, with the server's own hit code (Combat.rayPlayer, spreadDirection,
 * pelletPattern, damageAt) on an open field. A player aims at the chest with a human error (normal, σ degrees) and
 * fires once: how often does that one shot kill?
 *
 *   npx tsx scripts/qa/r3-gunfeel.ts [sigma=0.6]
 */
import { pelletPattern, rayPlayer, spreadDirection } from '../../server/Combat';
import { PLAYER_MAX_HEALTH, type WeaponDef, damageAt, weaponDef } from '../../src/modes/Weapons';

const sigma = Number(process.argv[2] ?? 0.6);
const TRIALS = 4000;
let seed = 12345;
const rand = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());

/** Old stats (before QA round 3) next to the current ones. */
const OLD: Record<string, Partial<WeaponDef>> = {
  shotgun: { damage: 13, pellets: 10, rpm: 70, spread: 4.5, adsSpread: 3.5, range: 7, falloffEnd: 22, minDamage: 0.15 },
  sniper: { damage: 85, headshot: 1.6, adsTime: 0.42, range: 300, falloffEnd: 300, minDamage: 1 },
};

function oneShotKill(w: WeaponDef, dist: number, ads: boolean, oldPellets: boolean): { kill: boolean; hit: boolean } {
  const ox = 0, oy = 66.62, oz = 0;
  const tx = 0, ty = 65, tz = -dist;
  // Aim at the chest with a human error.
  const ax = tx - ox, ay = ty + 1.1 - oy, az = tz - oz;
  const len = Math.hypot(ax, ay, az);
  let dx = ax / len, dy = ay / len, dz = az / len;
  const yawErr = (gauss() * sigma * Math.PI) / 180, pitchErr = (gauss() * sigma * Math.PI) / 180;
  dx += yawErr; dy += pitchErr;
  const l2 = Math.hypot(dx, dy, dz); dx /= l2; dy /= l2; dz /= l2;
  const spread = ads ? w.adsSpread : w.spread;
  const dir: [number, number, number] = [0, 0, 0];
  const pp: [number, number] = [0, 0];
  const rot = rand();
  let dmg = 0;
  let hit = false;
  for (let k = 0; k < w.pellets; k++) {
    if (w.pellets > 1 && !oldPellets) { pelletPattern(k, w.pellets, rot, rand(), pp); spreadDirection(dx, dy, dz, spread, pp[0], pp[1], dir); }
    else spreadDirection(dx, dy, dz, spread, rand(), rand(), dir);
    const h = rayPlayer(ox, oy, oz, dir[0], dir[1], dir[2], tx, ty, tz);
    if (!h) continue;
    hit = true;
    dmg += damageAt(w, h.t) * (h.head ? w.headshot : 1);
  }
  return { kill: Math.round(dmg) >= PLAYER_MAX_HEALTH, hit };
}

function table(id: string, dists: number[], ads: boolean): void {
  const now = weaponDef(id)!;
  const old = { ...now, ...OLD[id] } as WeaponDef;
  console.log(`\n${now.name} (${ads ? 'aimed' : 'hip'}), aim error σ ${sigma}°: one shot kills / hits, ${TRIALS} shots per cell`);
  console.log('dist'.padEnd(8) + 'before'.padStart(16) + 'after'.padStart(16));
  for (const d of dists) {
    const run = (w: WeaponDef, oldP: boolean) => {
      let k = 0, h = 0;
      for (let i = 0; i < TRIALS; i++) { const r = oneShotKill(w, d, ads, oldP); if (r.kill) k++; if (r.hit) h++; }
      return `${Math.round((k / TRIALS) * 100)}% / ${Math.round((h / TRIALS) * 100)}%`;
    };
    console.log(`${d} m`.padEnd(8) + run(old, true).padStart(16) + run(now, false).padStart(16));
  }
}

table('shotgun', [3, 5, 7, 9, 11, 14], false);
table('shotgun', [5, 9, 12], true);
table('sniper', [15, 30, 50, 70, 90], true);
