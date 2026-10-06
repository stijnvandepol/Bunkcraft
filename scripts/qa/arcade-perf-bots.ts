/**
 * A fleet of protocol bots for arcade performance runs: they join a room, pick a class (cycling
 * through the presets), run honest paths over the map and fire at the nearest enemy they can see at
 * their weapon's cadence, reloading when empty. Used by scripts/qa/arcade-perf.py, which adds a
 * real browser as the last player and measures its frame times.
 *
 *   npx tsx scripts/qa/arcade-perf-bots.ts <base=http://localhost:3488> <roomCode> [bots=15] [seconds=90] [map=classic]
 */
import { traceBlocks } from '../../server/Combat';
import { LOADOUT_PRESETS } from '../../src/modes/Loadouts';
import { getMap, parseMapId } from '../../src/modes/maps';
import { fireInterval, weaponDef } from '../../src/modes/Weapons';
import { BOT_SPEED, aimAt, arenaPath, follow } from '../lib/arenaPath';
import { Bot, sleep } from './lib';

const [base = 'http://localhost:3488', code = '', n = '15', secs = '90', mapArg = 'classic'] = process.argv.slice(2);
let map = getMap(parseMapId(mapArg) ?? 'classic');
const BOTS = Number(n), SECONDS = Number(secs);
const HZ = 20;

interface Runner {
  bot: Bot;
  route: [number, number][];
  team: string;
  weapon: string;
  nextFire: number;
  mag: number;
  others: Map<number, [number, number, number]>;
}

async function main(): Promise<void> {
  let variant = 0;
  const runners: Runner[] = [];
  for (let i = 0; i < BOTS; i++) {
    const bot = new Bot(`perf${i}`);
    try {
      await bot.connect(base, code || null);
    } catch (e) {
      // A full lobby (or a kick) ends the fleet here; run with the bots that got in.
      console.error(`bot ${i} could not join: ${(e as Error).message}`);
      break;
    }
    if (i === 0 && bot.welcome) {
      // The map the room plays now and its cover variant (classic changes its crates per seed): walking through a
      // variant crate the bot does not know about is noclip for the anti-cheat, and it kicks the bot.
      map = getMap(parseMapId(bot.welcome.match?.map ?? '') ?? map.id);
      variant = map.variantFor(bot.welcome.seed);
    }
    const preset = LOADOUT_PRESETS[i % LOADOUT_PRESETS.length];
    bot.send({ t: 'loadout', primary: preset.primary, secondary: preset.secondary, optic: preset.optic, perk: preset.perk });
    runners.push({ bot, route: [], team: '', weapon: preset.primary, nextFire: 0, mag: weaponDef(preset.primary)!.magazine, others: new Map() });
    await sleep(60);
  }
  const blocks = { getBlock: (x: number, y: number, z: number) => map.blockAt(variant, x, y, z) };
  const teams = new Map<number, string>();
  const randomCell = (): [number, number] => {
    const b = map.bounds;
    for (;;) {
      const x = Math.floor(b.minX + 2 + Math.random() * (b.maxX - b.minX - 4)), z = Math.floor(b.minZ + 2 + Math.random() * (b.maxZ - b.minZ - 4));
      if (map.blockAt(variant, x, 65, z) === 0 && map.blockAt(variant, x, 66, z) === 0) return [x + 0.5, z + 0.5];
    }
  };
  const start = performance.now();
  let shots = 0;
  let seen = 0;
  while (performance.now() - start < SECONDS * 1000) {
    const now = performance.now() / 1000;
    for (const r of runners) {
      const b = r.bot;
      // Read what arrived since the last step (snapshots, roster, ammo, spawn), then drop the log.
      for (const m of b.log.splice(0)) {
        if (m.t === 'snap') {
          r.others.clear();
          for (const e of m.players) if (e[0] !== b.id && !(e[6] & 8)) r.others.set(e[0], [e[1], e[2], e[3]]);
        } else if (m.t === 'roster') for (const p of m.players) teams.set(p.id, p.team);
        else if (m.t === 'ammo' && m.slot === 0) r.mag = m.reloading ? 0 : m.mag;
        else if (m.t === 'spawn') { r.weapon = m.primary; r.route = []; }
      }
      if (b.fresh) b.fresh = false;
      else {
        if (r.route.length === 0) r.route = arenaPath(map, variant, [b.x, b.z], randomCell()) ?? [];
        follow(b, r.route, BOT_SPEED / HZ);
      }
      const myTeam = teams.get(b.id) ?? '';
      let best: [number, number, number] | null = null, bestD = Infinity;
      for (const [id, p] of r.others) {
        if (myTeam && teams.get(id) === myTeam) continue;
        const d = Math.hypot(p[0] - b.x, p[2] - b.z);
        if (d > 1 && d < bestD) { bestD = d; best = p; }
      }
      const ox = b.x, oy = b.y + 1.62, oz = b.z;
      if (best) {
        const a = aimAt(ox, oy, oz, best[0], best[1] + 1.2, best[2]);
        const d = Math.hypot(best[0] - ox, best[1] + 1.2 - oy, best[2] - oz);
        if (traceBlocks(blocks, ox, oy, oz, a.dx, a.dy, a.dz, d) < d) best = null;
        else {
          b.yaw = Math.atan2(-a.dx, -a.dz);
          b.pitch = Math.asin(a.dy);
        }
      }
      b.send({ t: 'pos', x: b.x, y: b.y, z: b.z, yaw: b.yaw, pitch: b.pitch, flags: 4 | (best ? 16 : 0), held: 0 });
      if (best) seen++;
      const w = weaponDef(r.weapon);
      if (best && w && now >= r.nextFire) {
        if (r.mag <= 0) { b.send({ t: 'reload', slot: 0 }); r.nextFire = now + w.reloadSec; r.mag = w.magazine; continue; }
        b.send({ t: 'fire', slot: 0, ox, oy, oz, ...aimAt(ox, oy, oz, best[0], best[1] + 1.2, best[2]), ads: true });
        r.mag--;
        shots++;
        r.nextFire = now + Math.max(fireInterval(w), w.burst ? (w.burstCycleSec ?? 0.3) / w.burst : 0) + 0.02;
      }
    }
    await sleep(1000 / HZ);
  }
  console.log(JSON.stringify({ bots: BOTS, seconds: SECONDS, shots, seenFrames: seen }));
  for (const r of runners) r.bot.close();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
