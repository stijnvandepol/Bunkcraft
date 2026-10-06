/**
 * Performance smoke test (CI): runs the mesh, arena and mob benchmarks and fails on large regressions against
 * scripts/perf-budget.json. The budgets are generous ceilings (a shared CI runner is several times slower than a
 * laptop), so only real regressions (an accidental O(n^2), a lost cache) trip them, not noise.
 *
 *   npm run test:perf
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Budget {
  /** Multiplier applied to every budget on CI (process.env.CI). */
  ciFactor: number;
  mesh: { meanMs: number; p95Ms: number };
  arena: { tickMeanMs: number; tickP95Ms: number; handleMeanMs: number; outKiBps: number };
  mobs: { obstacleTickMeanMs: number; obstacleTickP95Ms: number; roomTickMeanMs: number; roomTickP95Ms: number; roomMobsMeanMs: number };
  visibility: { tickMeanMs: number; tickP95Ms: number };
}

const root = process.cwd();
const budget = JSON.parse(readFileSync(join(root, 'scripts', 'perf-budget.json'), 'utf8')) as Budget;
const factor = process.env.CI ? budget.ciFactor : 1;
const tsx = join(root, 'node_modules', '.bin', 'tsx');
const run = (script: string, args: string[]) => execFileSync(tsx, [join(root, 'scripts', script), ...args], { encoding: 'utf8', timeout: 300_000 });

const num = (re: RegExp, text: string, what: string): number => {
  const m = re.exec(text);
  if (!m) throw new Error(`could not read ${what} from:\n${text}`);
  return Number(m[1]);
};

const results: { name: string; value: number; limit: number; unit: string }[] = [];
const mesh = run('bench-mesh.ts', ['12345', '3', '3']);
results.push({ name: 'mesh mean', value: num(/mean ([\d.]+) ms/, mesh, 'mesh mean'), limit: budget.mesh.meanMs * factor, unit: 'ms' });
results.push({ name: 'mesh p95', value: num(/p95 ([\d.]+) ms/, mesh, 'mesh p95'), limit: budget.mesh.p95Ms * factor, unit: 'ms' });

const arena = run('bench-arena.ts', ['16', '20']);
results.push({ name: 'arena tick mean', value: num(/tick\(\):\s+mean ([\d.]+) ms/, arena, 'tick mean'), limit: budget.arena.tickMeanMs * factor, unit: 'ms' });
results.push({ name: 'arena tick p95', value: num(/tick\(\):\s+mean [\d.]+ ms, p95 ([\d.]+) ms/, arena, 'tick p95'), limit: budget.arena.tickP95Ms * factor, unit: 'ms' });
results.push({ name: 'arena handling mean', value: num(/message handling\/tick: mean ([\d.]+) ms/, arena, 'handling mean'), limit: budget.arena.handleMeanMs * factor, unit: 'ms' });
// Bandwidth does not depend on the machine: no CI factor.
results.push({ name: 'arena outgoing/player', value: num(/outgoing per player: ([\d.]+) KiB\/s/, arena, 'outgoing'), limit: budget.arena.outKiBps, unit: 'KiB/s' });

// Mob AI, path finding and spawning in CPU time (the unit tests count the work, this guards the milliseconds).
const mobs = run('bench-mobs.ts', []);
results.push({ name: 'mobs obstacles mean', value: num(/obstacles.*tick mean ([\d.]+) ms/, mobs, 'obstacles mean'), limit: budget.mobs.obstacleTickMeanMs * factor, unit: 'ms' });
results.push({ name: 'mobs obstacles p95', value: num(/obstacles.*p95 ([\d.]+) ms/, mobs, 'obstacles p95'), limit: budget.mobs.obstacleTickP95Ms * factor, unit: 'ms' });
results.push({ name: 'mobs room tick mean', value: num(/room.*tick mean ([\d.]+) ms/, mobs, 'room mean'), limit: budget.mobs.roomTickMeanMs * factor, unit: 'ms' });
results.push({ name: 'mobs room tick p95', value: num(/room.*p95 ([\d.]+) ms/, mobs, 'room p95'), limit: budget.mobs.roomTickP95Ms * factor, unit: 'ms' });
results.push({ name: 'mobs room AI mean', value: num(/room.*mobs mean ([\d.]+) ms/, mobs, 'room mobs'), limit: budget.mobs.roomMobsMeanMs * factor, unit: 'ms' });

// Arcade visibility culling (anti-wallhack) in CPU time; tests/anticheatVisibility.test.ts counts its rays and lookups.
const vis = run('bench-visibility.ts', []);
results.push({ name: 'visibility tick mean', value: num(/visibility.*tick mean ([\d.]+) ms/, vis, 'visibility mean'), limit: budget.visibility.tickMeanMs * factor, unit: 'ms' });
results.push({ name: 'visibility tick p95', value: num(/visibility.*p95 ([\d.]+) ms/, vis, 'visibility p95'), limit: budget.visibility.tickP95Ms * factor, unit: 'ms' });

let failed = false;
for (const r of results) {
  const ok = r.value <= r.limit;
  if (!ok) failed = true;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${r.name.padEnd(22)} ${r.value.toFixed(3).padStart(9)} ${r.unit}  (budget ${r.limit.toFixed(3)} ${r.unit})`);
}
if (failed) {
  console.error('Performance regression. If it is intended (more work per chunk, richer snapshots), raise scripts/perf-budget.json in the same commit.');
  process.exit(1);
}
