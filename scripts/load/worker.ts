/**
 * One bot process of the load test (forked by run.ts; several run in parallel so the load generator is never
 * the bottleneck). Talks to the orchestrator over IPC:
 *   ← { cmd: 'start', base, rooms: [{ spec, bots, index }] }  → { ev: 'joined', joined, failed }
 *   ← { cmd: 'reset' }   (start of the measurement window)
 *   ← { cmd: 'report' }  → { ev: 'report', stats }
 *   ← { cmd: 'stop' }    closes every bot and exits
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { ArenaBot, type Bot, RoomCtx, type RoomSpec, SurvivalBot } from './bots';
import { Stats } from './stats';

interface StartCmd { cmd: 'start'; base: string; rooms: { spec: RoomSpec; bots: number; index: number }[]; joinSpacingMs: number }
type Cmd = StartCmd | { cmd: 'reset' } | { cmd: 'report' } | { cmd: 'stop' };

const stats = new Stats();
const bots: Bot[] = [];
const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function start(c: StartCmd): Promise<void> {
  const joins: Promise<void>[] = [];
  for (const r of c.rooms) {
    const ctx = new RoomCtx(r.spec, stats);
    for (let i = 0; i < r.bots; i++) {
      // Unique per bot: names are bound per game, the address keeps per-IP limits realistic (8 households per game).
      const name = `lt${r.index}_${i}`;
      const xff = `10.${(r.index >> 8) & 255}.${r.index & 255}.${i + 1}`;
      const bot = r.spec.kind === 'arena' ? new ArenaBot(ctx, name, i === 0, xff) : new SurvivalBot(ctx, name, i === 0, xff, i);
      ctx.bots.push(bot);
      bots.push(bot);
      joins.push(bot.connect(c.base));
      await sleep(c.joinSpacingMs);
    }
  }
  await Promise.all(joins);
  process.send!({ ev: 'joined', joined: bots.filter((b) => b.joined).length, failed: bots.filter((b) => !b.joined).length });
}

process.on('message', (c: Cmd) => {
  switch (c.cmd) {
    case 'start': void start(c); return;
    case 'reset': stats.reset(); loop.reset(); return;
    case 'report':
      process.send!({ ev: 'report', stats: stats.toJSON(Math.max(0, loop.percentile(99) / 1e6 - 10), Math.max(0, loop.max / 1e6 - 10)) });
      return;
    case 'stop':
      for (const b of bots) b.close();
      setTimeout(() => process.exit(0), 500);
  }
});
process.on('disconnect', () => process.exit(0));
