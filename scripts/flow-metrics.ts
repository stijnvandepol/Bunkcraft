/**
 * Match pace and flow of the arcade shooters, measured with bot matches through the real GameServer (fake
 * sockets and a fake clock, like bench-arena.ts): the numbers behind "matches should feel fast" and the
 * before/after tables in docs/GAMEMODES.md.
 *
 *   npx tsx scripts/flow-metrics.ts [players=8] [seconds=300] [--maps=classic,suburb,quarter] [--type=tdm] [--seed=1]
 *
 * Per map: kills per minute (whole lobby), the average life, how long a fresh spawn takes to its first fight
 * (first damage dealt or taken), the quiet stretches between fights while alive, spawn kills (death within
 * 3 s of spawning; "passive": without having fired, so spawn protection could not have been dropped) and how often a spawn lands within 20 blocks of a living enemy. Bots walk honest paths
 * (BOT_SPEED, validated) between random cells and shoot the nearest enemy in clear sight.
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import { ARENA_FLOOR_Y, getMap, parseMapId } from '../src/modes/maps';
import { decodeBinary } from '../src/net/binary';
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '../src/net/protocol';
import { GameServer } from '../server/GameServer';
import { traceBlocks } from '../server/Combat';
import { BOT_SPEED, type RoutePoint, aimAt, arenaPath, follow } from './lib/arenaPath';

const pos = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const opt = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const PLAYERS = Number(pos[0] ?? 8);
const SECONDS = Number(pos[1] ?? 300);
const MAPS = opt('maps', 'classic,suburb,quarter,town').split(',').map((m) => parseMapId(m) ?? 'classic');
const TYPE = opt('type', 'tdm') as 'tdm' | 'ffa';
const HZ = 30;
const SPAWN_KILL = 3;
const COMBAT_GAP = 2;
/** Seconds a bot needs after spawning before it fires (orientation; a player does not shoot on frame one). */
const REACTION = 0.6;

let clock = 1_700_000_000_000;
Date.now = () => clock;
const now = () => clock / 1000;

interface Life { spawnAt: number; firstFight: number; lastFight: number; quiet: number[]; fired: boolean }

function runMap(mapId: string, seedBase: number) {
  const map = getMap(mapId);
  let variant = 0;
  let seed = seedBase;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  const randomCell = (): [number, number] => {
    const b = map.bounds;
    for (;;) {
      const x = Math.floor(b.minX + 2 + rnd() * (b.maxX - b.minX - 4)), z = Math.floor(b.minZ + 2 + rnd() * (b.maxZ - b.minZ - 4));
      if (map.blockAt(variant, x, ARENA_FLOOR_Y + 1, z) === 0 && map.blockAt(variant, x, ARENA_FLOOR_Y + 2, z) === 0) return [x + 0.5, z + 0.5];
    }
  };
  let kills = 0, spawnKills = 0, passiveSpawnKills = 0, spawns = 0, hotSpawns = 0;
  const lifeLengths: number[] = [], toFirstFight: number[] = [], quietGaps: number[] = [];
  const bots: Sink[] = [];

  class Sink extends EventEmitter {
    OPEN = 1;
    readyState = 1;
    bufferedAmount = 0;
    me = { id: 0, x: 0, y: 65, z: 0 };
    alive = false;
    fresh = false;
    route: RoutePoint[] = [];
    others = new Map<number, [number, number, number]>();
    life: Life | null = null;
    send(data: string | ArrayBuffer): void {
      const m = typeof data === 'string' ? JSON.parse(data) as ServerMessage : decodeBinary(data);
      if (!m) return;
      const t = now();
      if (m.t === 'welcome') { this.me.id = m.id; variant = map.variantFor(m.seed); }
      else if (m.t === 'spawn') {
        this.me.x = m.x; this.me.y = m.y; this.me.z = m.z; this.fresh = true; this.route = []; this.alive = true;
        this.endLife(t);
        this.life = { spawnAt: t, firstFight: NaN, lastFight: t, quiet: [], fired: false };
        if (live) {
          spawns++;
          // A spawn within 20 blocks of a living enemy (any bot that is alive on the other team).
          for (const o of bots) {
            if (o === this || !o.alive || (TYPE === 'tdm' && o.team === this.team)) continue;
            if (Math.hypot(o.me.x - m.x, o.me.z - m.z) < 20) { hotSpawns++; break; }
          }
        }
        this.team = m.team;
      } else if (m.t === 'teleport') {
        this.me.x = m.x; this.me.y = m.y; this.me.z = m.z; this.fresh = true; this.route = [];
      } else if (m.t === 'snap') {
        this.others.clear();
        for (const e of m.players) if (e[0] !== this.me.id && !(e[6] & 8)) this.others.set(e[0], [e[1], e[2], e[3]]);
      } else if (m.t === 'hit' || m.t === 'damaged') this.fight(t);
      else if (m.t === 'kill' && live) {
        if (m.killer !== m.victim && this === bots[0]) kills++;
        if (m.victim === this.me.id) {
          this.alive = false;
          if (this.life && t - this.life.spawnAt <= SPAWN_KILL) { spawnKills++; if (!this.life.fired) passiveSpawnKills++; }
          this.endLife(t);
        }
      }
    }
    team = '';
    fight(t: number): void {
      const l = this.life;
      if (!l || !live) return;
      if (l.firstFight !== l.firstFight) { l.firstFight = t; toFirstFight.push(t - l.spawnAt); }
      else if (t - l.lastFight > COMBAT_GAP) quietGaps.push(t - l.lastFight);
      l.lastFight = t;
    }
    endLife(t: number): void {
      const l = this.life;
      if (!l || !live) { this.life = null; return; }
      lifeLengths.push(t - l.spawnAt);
      this.life = null;
    }
    close(): void { this.readyState = 3; }
    terminate(): void { this.readyState = 3; }
    ping(): void { this.emit('pong'); }
    say(msg: ClientMessage): void { this.emit('message', Buffer.from(JSON.stringify(msg)), false); }
  }

  let live = false;
  const dir = mkdtempSync(join(tmpdir(), 'bunk-flow-'));
  const server = new GameServer({
    dataDir: dir, worldName: 'Flow', seed: String(seedBase), gameMode: 'survival', motd: '', maxPlayers: 32, quiet: true,
    gameType: TYPE, scoreLimit: 10000, timeLimitSec: 3600, mapId: mapId as never, arcadeTickHz: HZ,
  });
  const tick = () => (server as unknown as { tick(): void }).tick();
  for (let i = 0; i < PLAYERS; i++) {
    const ws = new Sink();
    server.accept(ws as unknown as WebSocket);
    ws.say({ t: 'hello', v: PROTOCOL_VERSION, name: `bot${i}` });
    bots.push(ws);
  }
  const dt = 1 / HZ;
  const blocks = { getBlock: (x: number, y: number, z: number) => map.blockAt(variant, x, y, z) };
  for (let t = 0; t < 11; t += dt) { clock += dt * 1000; for (const b of bots) b.say({ t: 'pos', x: b.me.x, y: b.me.y, z: b.me.z, yaw: 0, pitch: 0, flags: 4, held: 0 }); tick(); }
  live = true;
  const steps = Math.round(SECONDS * HZ);
  for (let step = 0; step < steps; step++) {
    clock += dt * 1000;
    for (const b of bots) {
      if (b.fresh) b.fresh = false;
      else if (b.alive) {
        if (b.route.length === 0) b.route = arenaPath(map, variant, [b.me.x, b.me.z, b.me.y], randomCell()) ?? [];
        follow(b.me, b.route, BOT_SPEED * dt);
      }
      b.say({ t: 'pos', x: b.me.x, y: b.me.y, z: b.me.z, yaw: 0, pitch: 0, flags: 4, held: 0 });
      if (!b.alive) continue;
      let best: [number, number, number] | null = null, bestD = Infinity;
      for (const [, p] of b.others) {
        const d = Math.hypot(p[0] - b.me.x, p[2] - b.me.z);
        if (d > 1 && d < bestD) { bestD = d; best = p; }
      }
      const ox = b.me.x, oy = b.me.y + 1.62, oz = b.me.z;
      if (best) {
        const a = aimAt(ox, oy, oz, best[0], best[1] + 1.2, best[2]), d = Math.hypot(best[0] - ox, best[1] + 1.2 - oy, best[2] - oz);
        if (traceBlocks(blocks, ox, oy, oz, a.dx, a.dy, a.dz, d) < d) best = null;
      }
      // Human-ish aim: a shot every third tick, and only when the bot "reacts" (half the chances).
      // A fresh spawn needs a moment to see what is going on (human reaction), then shoots.
      if (b.life && now() - b.life.spawnAt < REACTION) best = null;
      if (best && step % 3 === 0 && rnd() < 0.5) {
        if (b.life) b.life.fired = true;
        b.say({ t: 'fire', slot: 0, ox, oy, oz, ...aimAt(ox, oy, oz, best[0], best[1] + 1.2, best[2]), ads: false });
      }
    }
    tick();
  }
  server.shutdown();
  rmSync(dir, { recursive: true, force: true });
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
  return {
    map: mapId, kpm: kills / (SECONDS / 60), life: mean(lifeLengths), firstFight: median(toFirstFight), quiet: mean(quietGaps),
    spawnKill: spawns ? spawnKills / spawns : 0, passive: spawns ? passiveSpawnKills / spawns : 0, hot: spawns ? hotSpawns / spawns : 0, deaths: lifeLengths.length,
  };
}

const f = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '-');
console.log(`${PLAYERS} bots, ${TYPE}, ${SECONDS} s per map at ${HZ} Hz`);
console.log('map'.padEnd(10) + 'kills/min'.padStart(10) + 'life s'.padStart(8) + 'to fight s'.padStart(12) + 'quiet s'.padStart(9) + 'spawnkill%'.padStart(12) + 'passive%'.padStart(10) + 'hot spawn%'.padStart(12));
const rows = MAPS.map((m, i) => runMap(m, Number(opt('seed', '1')) * 1000 + i));
for (const r of rows) {
  console.log(r.map.padEnd(10) + f(r.kpm).padStart(10) + f(r.life).padStart(8) + f(r.firstFight).padStart(12) + f(r.quiet).padStart(9)
    + f(r.spawnKill * 100).padStart(12) + f(r.passive * 100).padStart(10) + f(r.hot * 100).padStart(12));
}
const avg = (k: keyof (typeof rows)[0]) => rows.reduce((a, r) => a + (r[k] as number), 0) / rows.length;
console.log('mean'.padEnd(10) + f(avg('kpm')).padStart(10) + f(avg('life')).padStart(8) + f(avg('firstFight')).padStart(12) + f(avg('quiet')).padStart(9)
  + f(avg('spawnKill') * 100).padStart(12) + f(avg('passive') * 100).padStart(10) + f(avg('hot') * 100).padStart(12));
process.exit(0);
