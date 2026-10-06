/**
 * Does opening a new lobby stall the matches already running? Two bots play in one arena; meanwhile new arcade
 * rooms are created (POST /api/rooms, like Quick Play opening a lobby) and joined once (which builds the arena).
 * Reports the longest gap between snapshots the playing bots saw, before and during the room churn, and the
 * creation/join times.
 *
 *   npx tsx scripts/qa/room-stall.ts [http://localhost:3523] [rooms=6] [map=station]
 */
import { Bot, check, createRoom, info, sleep, summary } from './lib';

const [base = 'http://localhost:3523', n = '6', map = 'station'] = process.argv.slice(2);

function maxGap(bot: Bot, from: number, to: number): number {
  const at = bot.log.filter((m) => m.t === 'snap' && m.at >= from && m.at <= to).map((m) => m.at);
  let gap = 0;
  for (let i = 1; i < at.length; i++) gap = Math.max(gap, at[i] - at[i - 1]);
  return gap;
}

async function main(): Promise<void> {
  const { code } = await createRoom(base, { name: 'Stall', gameMode: 'creative', seed: 'st', gameType: 'tdm', scoreLimit: 50, timeLimitSec: 900, mapId: 'classic' });
  const a = new Bot('stall_a'), b = new Bot('stall_b');
  await a.connect(base, code);
  await b.connect(base, code);
  a.autoPos(33); b.autoPos(33);
  await sleep(3000);
  const t0 = performance.now();
  await sleep(5000);
  const quiet = Math.max(maxGap(a, t0, performance.now()), maxGap(b, t0, performance.now()));
  info('longest snapshot gap, no new rooms', `${quiet.toFixed(0)} ms`);

  const t1 = performance.now();
  const creates: number[] = [], joins: number[] = [];
  for (let i = 0; i < Number(n); i++) {
    const c0 = performance.now();
    const r = await createRoom(base, { name: `Churn ${i}`, gameMode: 'creative', seed: `c${i}`, gameType: 'domination', scoreLimit: 100, timeLimitSec: 600, mapId: map });
    creates.push(performance.now() - c0);
    const j = new Bot(`churn${i}`);
    const j0 = performance.now();
    await j.connect(base, r.code);
    joins.push(performance.now() - j0);
    j.close();
    await sleep(400);
  }
  await sleep(1000);
  const churn = Math.max(maxGap(a, t1, performance.now()), maxGap(b, t1, performance.now()));
  info('create / first join per room', `${creates.map((x) => x.toFixed(0)).join(', ')} ms / ${joins.map((x) => x.toFixed(0)).join(', ')} ms`);
  info('longest snapshot gap while rooms were created', `${churn.toFixed(0)} ms (snapshots every ~33 ms)`);
  check('opening lobbies does not stall a running match by more than 150 ms', churn < 150, `${churn.toFixed(0)} ms`);
  a.close(); b.close();
  process.exit(summary() ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
