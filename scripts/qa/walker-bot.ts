/**
 * A protocol bot that walks a straight line back and forth at exactly 4.317 blocks/s (Minecraft walking) with
 * 20 Hz position updates, so a browser can measure how smoothly a remote player is drawn.
 *   npx tsx scripts/qa/walker-bot.ts <http base> <CODE> [seconds=20] [name=Walker]
 */
import { Bot, sleep } from './lib';

const [base, code, secs = '20', name = 'Walker'] = process.argv.slice(2);
const bot = new Bot(name);
await bot.connect(base, code, { bin: true });
const s = bot.welcome.spawn;
const t0 = performance.now();
const timer = setInterval(() => {
  const t = (performance.now() - t0) / 1000;
  const phase = (t * 4.317) % 24; // 12 blocks out, 12 back
  const off = phase < 12 ? phase : 24 - phase;
  bot.yaw = phase < 12 ? -Math.PI / 2 : Math.PI / 2;
  bot.pos(s.x + 2 + off, s.y, s.z + 2);
}, 50);
await sleep(Number(secs) * 1000);
clearInterval(timer);
bot.close();
process.exit(0);
