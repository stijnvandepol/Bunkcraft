/**
 * Time-to-kill (TTK) tables for the arcade weapons in src/modes/Weapons.ts, with the model from
 * src/modes/Balance.ts (also used by tests/arcadeBalance.test.ts). Design aid only.
 *
 *   npx tsx scripts/ttk-matrix.ts                # tables at the balance ranges (4 / 10 / 20 / 35 / 60 / 90 blocks)
 *   npx tsx scripts/ttk-matrix.ts 15 30          # chosen distances
 *   npx tsx scripts/ttk-matrix.ts --aim=0.6      # human aim factor (share of shots whose centre is on the body)
 *   npx tsx scripts/ttk-matrix.ts --summary      # one table: realistic TTK per range, best per column marked, niches
 */
import {
  BALANCE_RANGES, BODY_RADIUS, DEFAULT_AIM, HIP_RANGE, killsPerMag, perfectTtk, realisticTtk, spreadHit,
} from '../src/modes/Balance';
import { PLAYER_MAX_HEALTH, WEAPONS, fireMode } from '../src/modes/Weapons';

const fmt = (v: number, w = 6): string => (Number.isFinite(v) ? String(v) : '-').padStart(w);

function main(): void {
  const args = process.argv.slice(2);
  const dists = args.filter((a) => /^\d+(\.\d+)?$/.test(a)).map(Number);
  const aim = Number((args.find((a) => a.startsWith('--aim=')) ?? `--aim=${DEFAULT_AIM}`).slice(6));
  const ranges = dists.length ? dists : [...BALANCE_RANGES];
  const guns = WEAPONS.filter((w) => w.slot !== 'melee');

  console.log(`Health ${PLAYER_MAX_HEALTH}, aim factor ${aim}, body radius ${BODY_RADIUS} blocks, hip fire up to ${HIP_RANGE} blocks (beyond: ADS time added).\n`);

  console.log('--- Realistic TTK (ms, body, ADS time included past hip range); * = fastest primary at that range');
  console.log('weapon'.padEnd(20) + 'mode'.padStart(6) + 'mag'.padStart(5) + 'ads'.padStart(6) + 'move'.padStart(6) + ranges.map((d) => `${d}m`.padStart(8)).join('') + '  kills/mag@20');
  for (const w of guns) {
    const cells = ranges.map((d) => {
      const t = realisticTtk(w, d, aim).ms;
      const best = w.slot === 'primary' && guns.filter((o) => o.slot === 'primary').every((o) => realisticTtk(o, d, aim).ms >= t);
      return (fmt(t, 6) + (best ? '*' : ' ')).padStart(8);
    }).join('');
    console.log(w.name.padEnd(20) + fireMode(w).padStart(6) + String(w.magazine).padStart(5) + w.adsTime.toFixed(2).padStart(6)
      + w.moveSpeed.toFixed(2).padStart(6) + cells + killsPerMag(w, 20, aim).toFixed(1).padStart(8));
  }
  if (args.includes('--summary')) return;

  console.log('\n--- Perfect aim (all shots land), STK = shots to kill');
  console.log('weapon'.padEnd(20) + ranges.map((d) => `${d}m body`.padStart(13) + `${d}m head`.padStart(13)).join(''));
  for (const w of guns) {
    const row = ranges.map((d) => {
      const b = perfectTtk(w, d), h = perfectTtk(w, d, true);
      return `${fmt(b.stk, 3)}x${fmt(b.ms, 5)}ms`.padStart(13) + `${fmt(h.stk, 3)}x${fmt(h.ms, 5)}ms`.padStart(13);
    }).join('');
    console.log(w.name.padEnd(20) + row);
  }

  for (const d of ranges) {
    console.log(`\n--- ${d} blocks (${d > HIP_RANGE ? 'ADS' : 'hip fire'}): spread hit %, duel matrix row TTK minus column TTK in ms (negative = row kills first; ~ = toss-up under 150 ms)`);
    console.log(''.padEnd(20) + 'hit%'.padStart(6) + guns.map((w) => w.id.slice(0, 7).padStart(8)).join(''));
    for (const a of guns) {
      const ta = realisticTtk(a, d, aim).ms;
      console.log(a.name.padEnd(20) + `${Math.round(spreadHit(a, d, d > HIP_RANGE) * 100)}%`.padStart(6) + guns.map((b) => {
        const tb = realisticTtk(b, d, aim).ms;
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
