/**
 * Simulated time-to-kill per weapon and range with the real Match combat (spread, falloff, hitboxes, recoil) and the
 * human-like duel bots of tests/helpers/botDuel.ts. Both sides carry the same weapon, so the numbers are what a player
 * feels when he dies: TTK = first hit to death of a victim that was killed in one burst of fire (no pause over 0.6 s between hits: a kill from full health).
 * The analytic table of scripts/ttk-matrix.ts is the design aid; this is the check against what the bots really do.
 *
 *   npx tsx scripts/ttk-sim.ts [rounds=60] [--ranges=5,12,20,35,50] [--profile=average|skilled|veteran] [--weapons=rifle,smg]
 */
import { BOT_SKILLS } from '../server/bots/BotSkill';
import { PRIMARY_WEAPONS } from '../src/modes/Weapons';
import { duel } from '../tests/helpers/botDuel';
import { HUMAN_AVERAGE, HUMAN_SKILLED } from '../tests/helpers/humanProfiles';

const pos = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const opt = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const ROUNDS = Number(pos[0] ?? 60);
const RANGES = opt('ranges', '5,12,20,35,50').split(',').map(Number);
const PROFILE = { average: HUMAN_AVERAGE, skilled: HUMAN_SKILLED, veteran: BOT_SKILLS.veteran }[opt('profile', 'average') as 'average'] ?? HUMAN_AVERAGE;
const WEAPONS = opt('weapons', PRIMARY_WEAPONS.join(',')).split(',');
const VERSUS = process.argv.includes('--versus');
const q = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : NaN; };
const ms = (v: number) => (Number.isFinite(v) ? String(Math.round(v * 1000)) : '-');

if (VERSUS) {
  // Win share of the row weapon against the column weapon (same skill on both sides) at the chosen range (default: random 10-40 blocks).
  const dist = opt('dist', '') === '' ? undefined : Number(opt('dist', ''));
  console.log(`win share row vs column (${ROUNDS} decided-or-drawn rounds per pair, ${dist === undefined ? 'random 10-40' : dist + ' blocks'}, ${opt('profile', 'average')}); mean over columns at the right`);
  console.log(''.padEnd(12) + WEAPONS.map((w) => w.slice(0, 6).padStart(7)).join('') + '   mean');
  const shares = WEAPONS.map(() => WEAPONS.map(() => NaN));
  for (let i = 0; i < WEAPONS.length; i++) for (let j = i + 1; j < WEAPONS.length; j++) {
    const r = duel(PROFILE, PROFILE, { rounds: ROUNDS, seed: 500 + i * 31 + j, primary: WEAPONS[i], primaryB: WEAPONS[j], optic: 'iron', dist });
    shares[i][j] = r.a / Math.max(1, r.a + r.b); shares[j][i] = 1 - shares[i][j];
  }
  WEAPONS.forEach((w, i) => {
    const row = shares[i].filter((v) => Number.isFinite(v));
    console.log(w.padEnd(12) + shares[i].map((v) => (Number.isFinite(v) ? (v * 100).toFixed(0) : '.').padStart(7)).join('') + (row.reduce((a, b) => a + b, 0) / row.length * 100).toFixed(0).padStart(7));
  });
  process.exit(0);
}
console.log(`profile ${opt('profile', 'average')}, ${ROUNDS} rounds per cell; cell = median TTK ms (p10..p90), hits to kill, chained kills/all kills`);
console.log('weapon'.padEnd(12) + RANGES.map((r) => `${r}m`.padStart(26)).join(''));
const fast: string[] = [];
for (const w of WEAPONS) {
  const cells = RANGES.map((dist, i) => {
    const r = duel(PROFILE, PROFILE, { rounds: ROUNDS, seed: 100 + i, primary: w, primaryB: w, optic: 'iron', dist });
    const t = r.kills.filter((k) => k.chained).map((k) => k.ttk), h = r.kills.map((k) => k.hits);
    const sub250 = t.filter((x) => x < 0.25).length;
    if (sub250 && !['sniper', 'antimat', 'shotgun', 'semisniper', 'lever', 'revolver'].includes(w)) fast.push(`${w}@${dist}m ${sub250}/${t.length} under 250 ms`);
    return `${ms(q(t, 0.5))} (${ms(q(t, 0.1))}..${ms(q(t, 0.9))}) ${q(h, 0.5)}h ${t.length}/${r.kills.length}`.padStart(26);
  });
  console.log(w.padEnd(12) + cells.join(''));
}
if (fast.length) console.log('\nkills under 250 ms:\n  ' + fast.join('\n  '));
process.exit(0);
