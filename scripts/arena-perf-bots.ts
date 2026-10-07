/**
 * Fills one arena room with protocol-level bots (scripts/load/bots.ts ArenaBot: they walk, aim at visible enemies,
 * fire at the weapon's rate and reload) so a browser client can be measured in a busy firefight.
 * Used by scripts/arena-perf.py; runs until killed.
 *
 *   npx tsx scripts/arena-perf-bots.ts <http://host:port> <roomCode> <ownerToken> <botCount>
 */
import { ArenaBot, RoomCtx } from './load/bots';
import { Stats } from './load/stats';

const [base, code, ownerToken, countArg] = process.argv.slice(2);
if (!base || !code) {
  console.error('usage: arena-perf-bots.ts <base> <code> <ownerToken> <count>');
  process.exit(2);
}
const count = Number(countArg ?? 15);
const stats = new Stats();
const ctx = new RoomCtx({ code, ownerToken: ownerToken ?? '', kind: 'arena' }, stats);
const bots: ArenaBot[] = [];

for (let i = 0; i < count; i++) {
  // Owner token on the first bot only (it may start the match); a distinct address per bot keeps per-IP limits happy.
  const bot = new ArenaBot(ctx, `bot${i}`, i === 0 && !!ownerToken, `10.77.0.${i + 1}`);
  ctx.bots.push(bot);
  bots.push(bot);
  void bot.connect(base);
  await new Promise((r) => setTimeout(r, 40));
}
console.log(`bots: ${bots.filter((b) => b.joined).length}/${count} joined`);

const stop = () => {
  for (const b of bots) b.close();
  setTimeout(() => process.exit(0), 200);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
