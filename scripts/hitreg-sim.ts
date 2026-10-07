/**
 * Hit registration report (headless): a shooter aims at random points on the drawn model of a moving target
 * through a simulated network, and the real server code decides. Prints miss rates per ping, jitter and movement.
 *
 *   npx tsx scripts/hitreg-sim.ts [--seconds=20]
 */
import { type Motion, type Part, runHitregSim } from '../tests/helpers/hitregSim';

const seconds = Number(process.argv.find((a) => a.startsWith('--seconds='))?.slice(10) ?? 20);
const pct = (v: number) => `${(v * 100).toFixed(1)}%`.padStart(6);
console.log('motion  rtt  jitter  shots   miss    head   body    arm    leg   head→body body→head');
for (const motion of ['still', 'strafe', 'jump', 'run'] as Motion[]) {
  for (const [rtt, jitter] of [[0, 0], [50, 10], [150, 30]]) {
    const res = runHitregSim({ rttMs: rtt, jitterMs: jitter, seconds, seed: 7, motion, distance: 18 });
    const part = (p: Part) => pct(res.byPart[p].shots ? res.byPart[p].misses / res.byPart[p].shots : 0);
    console.log(`${motion.padEnd(7)} ${String(rtt).padStart(3)}  ${String(jitter).padStart(6)}  ${String(res.shots.length).padStart(5)}  ${pct(res.missRate)}  ${part('head')} ${part('body')} ${part('arm')} ${part('leg')}   ${String(res.headLost).padStart(6)}    ${String(res.headFalse).padStart(6)}`);
  }
}
