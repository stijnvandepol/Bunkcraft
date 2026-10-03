// Prints line/branch/function coverage per area (src/world, server, ...) from coverage/coverage-summary.json.
// Run through `npm run test:coverage`. Optional arg: write the table to a file as well.
import { readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

interface Metric { total: number; covered: number }
interface Entry { lines: Metric; branches: Metric; functions: Metric }

const summary = JSON.parse(readFileSync('coverage/coverage-summary.json', 'utf8')) as Record<string, Entry>;
const root = resolve('.');
const areas = new Map<string, { lines: Metric; branches: Metric; functions: Metric; files: number }>();
for (const [file, e] of Object.entries(summary)) {
  if (file === 'total') continue;
  const parts = relative(root, file).split('\\').join('/').split('/');
  const area = parts[0] === 'server' ? 'server' : `${parts[0]}/${parts[1]}`;
  const a = areas.get(area) ?? { lines: { total: 0, covered: 0 }, branches: { total: 0, covered: 0 }, functions: { total: 0, covered: 0 }, files: 0 };
  for (const k of ['lines', 'branches', 'functions'] as const) { a[k].total += e[k].total; a[k].covered += e[k].covered; }
  a.files++;
  areas.set(area, a);
}
const pct = (m: Metric): string => (m.total === 0 ? '    - ' : `${((100 * m.covered) / m.total).toFixed(1).padStart(5)}%`);
const out: string[] = ['Coverage per area'.padEnd(24) + 'files   lines  branch   funcs'];
for (const [name, a] of [...areas].sort((x, y) => x[0].localeCompare(y[0]))) {
  out.push(`${name.padEnd(23)} ${String(a.files).padStart(4)}  ${pct(a.lines)} ${pct(a.branches)} ${pct(a.functions)}`);
}
const t = summary.total;
out.push(`${'TOTAL'.padEnd(23)} ${String(summary ? Object.keys(summary).length - 1 : 0).padStart(4)}  ${pct(t.lines)} ${pct(t.branches)} ${pct(t.functions)}`);
console.log('\n' + out.join('\n'));
if (process.argv[2]) writeFileSync(process.argv[2], out.join('\n') + '\n');
