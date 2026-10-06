/**
 * Time budget of the arcade visibility culling (anti-wallhack; npm run test:perf reads its output, the unit
 * test tests/anticheatVisibility.test.ts counts the work instead): 16 players at 30 Hz, every pair checked
 * per tick (tests/helpers/visibilityScenario.ts).
 *
 * Main-thread CPU time (process.threadCpuUsage) per tick, best of several batches, so waiting for a core on a
 * busy machine does not count.
 *
 *   npx tsx scripts/bench-visibility.ts
 */
import { visibilityScenario } from '../tests/helpers/visibilityScenario';

const tc = (process as { threadCpuUsage?: () => NodeJS.CpuUsage }).threadCpuUsage;
const cpuMs = (): number => {
  const u = tc ? tc.call(process) : process.cpuUsage();
  return (u.user + u.system) / 1000;
};

const BATCHES = 7, TICKS = 300;
let best = Infinity, bestP95 = Infinity;
for (let b = 0; b < BATCHES; b++) {
  const sc = visibilityScenario();
  const times: number[] = [];
  for (let i = 0; i < TICKS; i++) {
    const t0 = cpuMs();
    sc.tick();
    times.push(cpuMs() - t0);
  }
  // The first batch warms the JIT up.
  if (b === 0) continue;
  times.sort((p, q) => p - q);
  best = Math.min(best, times.reduce((s, v) => s + v, 0) / TICKS);
  bestP95 = Math.min(bestP95, times[Math.floor(TICKS * 0.95)]);
}
console.log(`visibility (16 players, 30 Hz): tick mean ${best.toFixed(3)} ms, p95 ${bestP95.toFixed(3)} ms`);
