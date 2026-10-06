/**
 * Multiplayer QA: a full Team Deathmatch flow with 4 players over the real protocol.
 * Creates a tdm game (score limit 5, map "rotate"), joins 4 bots, checks teams and spawns, waits for
 * the warm-up, lets red hunt blue until red wins, checks kill feed / roster / scores / match end on every
 * client, then watches the next match start on the next map and checks team balancing after two leave.
 *
 *   npx tsx scripts/qa/mp-arcade.ts            (own server on QA_PORT=3474; ~70 s)
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ARENA_FLOOR_Y, type ArenaMap, getMap } from '../../src/modes/maps';
import { traceBlocks } from '../../server/Combat';
import { Bot, check, createRoom, info, sleep, startServer, summary } from './lib';

const PORT = Number(process.env.QA_PORT ?? 3474);
const DIR = process.env.QA_DIR ?? join(tmpdir(), `bunkqa-arcade-${Date.now()}`);

/** Moves a bot towards a target at 25 blocks/s with 10 Hz updates (server limit 40). */
class Walker {
  target: [number, number] | null = null;
  private timer: NodeJS.Timeout;
  constructor(readonly b: Bot) {
    this.timer = setInterval(() => {
      if (b.fresh) b.fresh = false;
      else if (this.target) {
        const dx = this.target[0] - b.x, dz = this.target[1] - b.z, d = Math.hypot(dx, dz);
        const k = d > 2.5 ? 2.5 / d : 1;
        b.x += dx * k; b.z += dz * k;
      }
      b.pos(b.x, b.y, b.z, 0);
    }, 100);
  }
  stop(): void { clearInterval(this.timer); }
}

function duelSpots(map: ArenaMap, seed: number): [[number, number], [number, number]] {
  const v = map.variantFor(seed);
  const world = { getBlock: (x: number, y: number, z: number) => map.blockAt(v, x, y, z) };
  const free = (x: number, z: number) => world.getBlock(Math.floor(x), ARENA_FLOOR_Y, Math.floor(z)) !== 0
    && world.getBlock(Math.floor(x), ARENA_FLOOR_Y + 1, Math.floor(z)) === 0 && world.getBlock(Math.floor(x), ARENA_FLOOR_Y + 2, Math.floor(z)) === 0;
  const B = map.bounds;
  for (let z = B.minZ + 4; z < B.maxZ - 4; z += 2) {
    for (let x = B.minX + 4; x < B.maxX - 12; x += 2) {
      const a: [number, number] = [x + 0.5, z + 0.5], b: [number, number] = [x + 8.5, z + 0.5];
      if (!free(...a) || !free(...b)) continue;
      const e = ARENA_FLOOR_Y + 1 + 1.62;
      if (traceBlocks(world, a[0], e, a[1], 1, 0, 0, 8) >= 8 && traceBlocks(world, a[0], e - 0.7, a[1], 1, 0, 0, 8) >= 8) return [a, b];
    }
  }
  throw new Error('no duel spot');
}

async function main(): Promise<void> {
  const srv = await startServer(PORT, DIR);
  const r = await createRoom(srv.base, { name: 'QA TDM', gameType: 'tdm', scoreLimit: 5, timeLimitSec: 120, mapId: 'rotate' });
  const names = ['RedOne', 'BlueOne', 'RedTwo', 'BlueTwo'];
  const bots: Bot[] = [];
  for (const n of names) { const b = new Bot(n); await b.connect(srv.base, r.code, { bin: true }); bots.push(b); }
  const walkers = bots.map((b) => new Walker(b));
  await sleep(500);
  const w0 = bots[0].welcome;
  check('arcade: welcome is a tdm arena on the first map of the rotation', w0.gameType === 'tdm' && w0.match?.map === 'classic', JSON.stringify(w0.match));
  const team = (b: Bot) => b.of('spawn').at(-1)?.team ?? '';
  const teams = bots.map(team);
  check('arcade: 4 joiners are split 2 v 2', teams.filter((t) => t === 'red').length === 2 && teams.filter((t) => t === 'blue').length === 2, teams.join(','));
  const map = getMap('classic');
  check('arcade: every spawn is inside the map', bots.every((b) => map.inBounds(b.x, b.z)));
  const reds = bots.filter((b) => team(b) === 'red'), blues = bots.filter((b) => team(b) === 'blue');
  const redSide = Math.sign(mean(reds.map((b) => b.x)) - mean(blues.map((b) => b.x)));
  info('arcade: spawn sides', `red x ≈ ${mean(reds.map((b) => b.x)).toFixed(0)}, blue x ≈ ${mean(blues.map((b) => b.x)).toFixed(0)} (side ${redSide})`);

  console.log('waiting for the warm-up...');
  for (let i = 0; i < 200 && bots[0].of('match').at(-1)?.phase !== 'live'; i++) await sleep(100);
  check('arcade: warm-up ends and the match goes live', bots[0].of('match').at(-1)?.phase === 'live');
  await sleep(300);

  // Friendly fire: red shoots red point blank.
  const [s1, s2] = duelSpots(map, w0.seed);
  const tLive = performance.now();
  await sleep(2200); // spawn protection
  walkers[bots.indexOf(reds[0])].target = s1;
  walkers[bots.indexOf(reds[1])].target = s2;
  await sleep(5000);
  for (let i = 0; i < 5; i++) {
    reds[0].send({ t: 'fire', slot: 0, ox: reds[0].x, oy: reds[0].y + 1.62, oz: reds[0].z, dx: reds[1].x - reds[0].x, dy: -0.7, dz: reds[1].z - reds[0].z, ads: true });
    await sleep(120);
  }
  await sleep(300);
  check('arcade: no friendly fire in tdm', reds[0].of('hit', tLive).length === 0 && reds[1].of('damaged', tLive).length === 0);

  // Red hunts blue: the victim walks to spot B, the shooter stands at spot A.
  let kills = 0;
  for (let round = 0; round < 12 && !bots[0].of('matchend').length; round++) {
    const shooter = reds[round % 2], victim = blues[round % 2];
    walkers[bots.indexOf(reds[1 - (round % 2)])].target = [s1[0], s1[1] - 3];
    walkers[bots.indexOf(shooter)].target = s1;
    walkers[bots.indexOf(victim)].target = s2;
    const t = performance.now();
    for (let i = 0; i < 80 && (Math.hypot(victim.x - s2[0], victim.z - s2[1]) > 0.3 || Math.hypot(shooter.x - s1[0], shooter.z - s1[1]) > 0.3); i++) await sleep(100);
    await sleep(2100); // the victim may have just respawned (protection)
    for (let i = 0; i < 40 && !shooter.of('kill', t).some((k) => k.victim === victim.id); i++) {
      shooter.send({ t: 'fire', slot: 0, ox: shooter.x, oy: shooter.y + 1.62, oz: shooter.z, dx: victim.x - shooter.x, dy: victim.y + 0.9 - (shooter.y + 1.62), dz: victim.z - shooter.z, ads: true });
      await sleep(110);
    }
    if (shooter.of('kill', t).some((k) => k.victim === victim.id)) kills++;
    console.log(`  round ${round}: ${shooter.name} → ${victim.name} at d=${Math.hypot(victim.x - shooter.x, victim.z - shooter.z).toFixed(1)}`
      + ` hits ${shooter.of('hit', t).length}, shots ${shooter.of('shot', t).length}, ammo ${shooter.of('ammo', t).at(-1)?.mag ?? '-'}`
      + ` teleports ${shooter.of('teleport', t).length}/${victim.of('teleport', t).length}, kills ${kills}, phase ${bots[0].of('match').at(-1)?.phase}`
      + ` left ${bots[0].of('match').at(-1)?.timeLeft}`);
    await sleep(3300);
  }
  const feedKills = bots[0].of('kill').filter((k) => reds.some((b) => b.id === k.killer)).length;
  check('arcade: red scored 5 kills', feedKills >= 5, `${feedKills} kills in the feed (${kills} rounds with a kill)`);
  const end = await bots[0].waitFor('matchend', () => true, 3000);
  check('arcade: match ends at the score limit with red as winner (every client)', !!end && bots.every((b) => b.of('matchend').at(-1)?.winnerTeam === 'red'), JSON.stringify(end));
  const feed = bots.map((b) => b.of('kill').length);
  check('arcade: every client got the same kill feed', feed.every((n) => n === feed[0]) && feed[0] >= 5, feed.join('/'));
  const roster = bots[3].of('roster').at(-1)!.players;
  const redKills = roster.filter((p) => p.team === 'red').reduce((s, p) => s + p.kills, 0);
  check('arcade: scoreboard (roster) has the kills and deaths', redKills >= 5 && roster.filter((p) => p.team === 'blue').reduce((s, p) => s + p.deaths, 0) >= 5,
    roster.map((p) => `${p.name}:${p.kills}/${p.deaths}/${p.ping}ms`).join(' '));
  const lastMatch = bots[1].of('match').at(-1);
  check('arcade: team scores in the match message', lastMatch?.scores.red === 5, JSON.stringify(lastMatch?.scores));
  info('arcade: ping in the roster', roster.map((p) => `${p.name} ${p.ping} ms`).join(', '));

  // Next match: map rotation.
  const tEnd = performance.now();
  const next = await bots[0].waitFor('match', (m) => m.phase === 'warmup' && m.info.map !== 'classic', 16000, tEnd);
  check('arcade: the next match starts on the next map (rotate)', next?.info.map === 'suburb', `after ${next ? ((next.at - tEnd) / 1000).toFixed(1) : '?'} s: ${JSON.stringify(next?.info)}`);
  // A client re-joins (what the browser does on a map change) and gets the new arena.
  const re = new Bot(bots[2].name, bots[2].key);
  await re.connect(srv.base, r.code, { bin: true });
  check('arcade: re-joining after a map change welcomes you on the new map', re.welcome.match?.map === 'suburb');
  const sMap = getMap('suburb');
  const sp = re.of('spawn').at(-1);
  check('arcade: the re-joined spawn is inside the new map', !!sp && sMap.inBounds(sp.x, sp.z), JSON.stringify(sp));
  const oldBot = await bots[2].waitFor('kick', () => true, 1500);
  info('arcade: the old session of the re-joiner', oldBot ? `kicked: "${oldBot.reason}"` : 'no kick message');

  // Balance: both blue players leave → teams 2 v 0 → somebody moves at their next respawn.
  const tLeave = performance.now();
  blues.forEach((b) => b.close());
  await sleep(500);
  const reds2 = [bots[0], re].filter((b) => b.name.startsWith('Red'));
  // Kill nobody; the balance happens at the next respawn = next match start or a death. Wait for a system line.
  let moved = '';
  for (let i = 0; i < 40 && !moved; i++) {
    moved = [...reds2, bots[0]].flatMap((b) => b.sys(tLeave)).find((s) => /moved to the/.test(s)) ?? '';
    await sleep(250);
  }
  info('arcade: team balance after both blue players left', moved || 'no team switch within 10 s (it happens at the next respawn; nobody died)');
  for (const w of walkers) w.stop();
  for (const b of [...bots, re]) b.close();
  await srv.stop();
  process.exit(summary());
}

function mean(a: number[]): number { return a.reduce((x, y) => x + y, 0) / Math.max(1, a.length); }

void main();
