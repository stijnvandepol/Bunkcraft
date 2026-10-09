import { expect } from 'vitest';
import { HITBOX } from '../../src/modes/Weapons';
import { traceBlocks } from '../../server/Combat';
import { ServerWorld } from '../../server/ServerWorld';
import { arenaWorldType } from '../../src/world/WorldGenerator';
import { type MapId, getMap } from '../../src/modes/maps';
import { arenaPath, clientStep, follow } from '../../scripts/lib/arenaPath';
import { arcadeMaxSpeed } from '../../src/modes/ArcadeLogic';

/** Running pace of the victim: just under the rifle's run speed (the server allows 3 % on top). */
const PACE = arcadeMaxSpeed(1) * 0.97;
import type { ServerMessage } from '../../src/net/protocol';
import { Client, type TestServer, createRoom, sleep } from './harness';

type Spawn = Extract<ServerMessage, { t: 'spawn' }>;
const EYE = 1.62;

/** Reports the position the server just gave us (it ignores positions from before a spawn until we arrive). */
async function arrive(c: Client, after: number): Promise<Spawn> {
  const sp = await c.waitType('spawn', 8000, after);
  c.send({ t: 'pos', x: sp.x, y: sp.y, z: sp.z, yaw: sp.yaw, pitch: 0, flags: 4, held: 0, step: clientStep() });
  return sp;
}

/**
 * Can a bullet from `eye` reach the feet, the chest and the head of a player standing at `p`? Each of the three points
 * must be reachable in a straight line: no solid block between the eye and the point itself. (The trace used to run
 * 0.5 blocks past the point, so the floor behind a victim standing close by counted as "blocked", and a victim that
 * reached the shooter's own cell was never "in sight" on maps where cover hid the whole approach.)
 */
function inSight(world: ServerWorld, eye: { x: number; y: number; z: number }, p: { x: number; y: number; z: number }): boolean {
  for (const h of [0.2, 1.0, HITBOX.height - HITBOX.head / 2]) {
    const t = { x: p.x, y: p.y + h, z: p.z };
    const len = Math.hypot(t.x - eye.x, t.y - eye.y, t.z - eye.z);
    if (traceBlocks(world, eye.x, eye.y, eye.z, (t.x - eye.x) / len, (t.y - eye.y) / len, (t.z - eye.z) / len, len) < len - 0.05) return false;
  }
  return true;
}

/**
 * Walks a player like an honest client (the server validates movement against the map): along a floor
 * path towards `to`, at running pace with 30 Hz position reports, and stops as soon as `stop` says so.
 *
 * Like the real client it reports its physics clock (`step`, real time: never ahead of it, so the server times the
 * speed budget with the client's own clock instead of packet arrival times, which bunch up on a loaded machine), and
 * when the server rubber-bands it (`teleport`) it continues from where the server put it.
 */
async function walk(
  c: Client, from: { x: number; y: number; z: number }, to: { x: number; z: number }, mapId: MapId, seed: number,
  stop: (p: { x: number; y: number; z: number }) => boolean,
): Promise<{ x: number; y: number; z: number }> {
  const map = getMap(mapId);
  const variant = map.variantFor(seed);
  const pathFrom = (p: { x: number; y: number; z: number }) => {
    const r = arenaPath(map, variant, [p.x, p.z, p.y], [to.x, to.z]);
    expect(r, 'a walking path to the shooter').not.toBeNull();
    return r!;
  };
  const me = { x: from.x, y: from.y, z: from.z };
  let route = pathFrom(me);
  let seen = c.of('teleport').length;
  while (route.length && !stop(me)) {
    follow(me, route, PACE / 30);
    c.send({ t: 'pos', x: me.x, y: me.y, z: me.z, yaw: 0, pitch: 0, flags: 4, held: 0, step: clientStep() });
    await sleep(33);
    const tps = c.of('teleport');
    if (tps.length > seen) {
      const tp = tps[tps.length - 1];
      seen = tps.length;
      me.x = tp.x; me.y = tp.y; me.z = tp.z;
      route = pathFrom(me);
      c.send({ t: 'pos', x: me.x, y: me.y, z: me.z, yaw: 0, pitch: 0, flags: 4, held: 0, step: clientStep() });
    }
  }
  return me;
}

/**
 * Plays a real arcade match to its end over WebSockets: warm-up, live phase, headshots, kills,
 * respawns and the final `matchend`. Returns the clients for extra assertions.
 */
export async function playArcadeMatch(srv: TestServer, type: 'tdm' | 'ffa', mapId: MapId = 'classic'): Promise<{ shooter: Client; victim: Client; code: string }> {
  const code = await createRoom(srv, { gameType: type, scoreLimit: 5, timeLimitSec: 120, mapId });
  const shooter = await Client.join(`${srv.ws}/ws/${code}`, 'shooter');
  const victim = await Client.join(`${srv.ws}/ws/${code}`, 'victim');
  try {
    expect(shooter.welcome).toMatchObject({ gameType: type, worldType: 'arena', match: { type, scoreLimit: 5, timeLimitSec: 120, map: mapId } });
    const world = new ServerWorld(shooter.welcome.seed, {}, arenaWorldType(mapId));
    world.preloadArena();

    // Warm-up first, then live (10 s on the server clock).
    const warm = await shooter.waitFor<Extract<ServerMessage, { t: 'match' }>>((m) => m.t === 'match' && m.phase === 'warmup', 5000);
    expect(warm.info.type).toBe(type);
    await shooter.waitFor((m) => m.t === 'match' && m.phase === 'live', 20_000);

    // startLive respawns everybody just before it announces the live phase: take the latest spawn.
    await sleep(300);
    const latest = (c: Client): Spawn => {
      const sp = c.of('spawn').at(-1)!;
      c.send({ t: 'pos', x: sp.x, y: sp.y, z: sp.z, yaw: sp.yaw, pitch: 0, flags: 4, held: 0, step: clientStep() });
      return sp;
    };
    const shooterSpawn = latest(shooter);
    const victimSpawn = latest(victim);
    let vMark = victim.mark();
    if (type === 'tdm') {
      expect(shooterSpawn.team).not.toBe('');
      expect(shooterSpawn.team).not.toBe(victimSpawn.team);
    } else {
      expect(shooterSpawn.team).toBe('');
    }
    expect(shooterSpawn.health).toBe(100);
    const sp = shooterSpawn;

    const eye = { x: sp.x, y: sp.y + EYE, z: sp.z };
    const seed = shooter.welcome.seed;

    let at = victimSpawn;
    for (let kills = 1; kills <= 5; kills++) {
      // The victim walks towards the shooter until it stands in plain sight (or close by).
      const spot = await walk(victim, at, eye, mapId, seed, (p) => Math.hypot(p.x - eye.x, p.z - eye.z) < 25 && inSight(world, eye, p));
      if (process.env.FLOW_DEBUG) console.log(`kill ${kills} at ${Date.now()}: victim at ${spot.x.toFixed(1)},${spot.z.toFixed(1)} teleports ${victim.of('teleport').length}`);
      expect(inSight(world, eye, spot), 'victim in sight of the shooter').toBe(true);
      const head = { x: spot.x, y: spot.y + HITBOX.height - HITBOX.head / 2, z: spot.z };
      const len = Math.hypot(head.x - eye.x, head.y - eye.y, head.z - eye.z);
      const dir = { dx: (head.x - eye.x) / len, dy: (head.y - eye.y) / len, dz: (head.z - eye.z) / len };
      // Spawn protection lasts 2 s; the first life started a while ago, later ones just now.
      await sleep(kills === 1 ? 600 : 2300);
      // The server weighs the spread by the aim time it saw: sights up, then the rifle's aim time, before the head shots.
      shooter.send({ t: 'ads', on: true });
      await sleep(350);
      const mark = shooter.mark();
      let killed = false;
      let shots = 0;
      while (!killed && shots < 40) {
        shooter.send({ t: 'fire', slot: 0, ox: eye.x, oy: eye.y, oz: eye.z, ...dir, ads: true });
        shots++;
        await sleep(130);
        killed = shooter.msgs.slice(mark).some((m) => m.t === 'hit' && m.killed);
        if (shots === 1) {
          // The very first shot of the match is visible to everyone as a tracer.
          if (kills === 1) await victim.waitFor((m) => m.t === 'shot', 2000);
        }
      }
      expect(killed, `kill ${kills} within 40 shots`).toBe(true);
      const hits = shooter.msgs.slice(mark).filter((m): m is Extract<ServerMessage, { t: 'hit' }> => m.t === 'hit');
      expect(hits.every((h) => h.victim === victim.id)).toBe(true);
      expect(hits.some((h) => h.head)).toBe(true);
      const kill = await victim.waitFor<Extract<ServerMessage, { t: 'kill' }>>((m) => m.t === 'kill', 3000, vMark);
      expect(kill).toMatchObject({ killer: shooter.id, victim: victim.id, head: true });
      vMark = victim.mark();
      expect(victim.of('damaged').length).toBeGreaterThan(0);
      if (kills === 5) break;
      // Respawn after 3 s with full health at a (new) spawn point.
      const respawn = await arrive(victim, vMark);
      expect(respawn.health).toBe(100);
      at = respawn;
    }

    // Score limit reached: the match ends and names the winner.
    const end = await shooter.waitType('matchend', 5000);
    if (type === 'tdm') expect(end.winnerTeam).toBe(shooterSpawn.team);
    else expect(end.winnerId).toBe(shooter.id);
    expect(end.restartIn).toBeGreaterThan(0);
    const last = await shooter.waitFor<Extract<ServerMessage, { t: 'roster' }>>((m) => m.t === 'roster' && m.players.some((p) => p.kills >= 5), 5000);
    const row = last.players.find((p) => p.id === shooter.id)!;
    expect(row.kills).toBe(5);
    expect(last.players.find((p) => p.id === victim.id)!.deaths).toBe(5);
    return { shooter, victim, code };
  } catch (e) {
    console.error(`--- server log (tail) ---\n${srv.log().slice(-2500)}`);
    shooter.close();
    victim.close();
    throw e;
  }
}
