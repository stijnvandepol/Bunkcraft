/**
 * Server cost of an arcade game: N simulated players in one team deathmatch, walking honest paths
 * over the map (the movement validator checks every report) and firing at the nearest enemy they
 * know of, driven through the real GameServer with fake sockets and a fake clock (CPU time per tick,
 * without the network). Prints tick cost, anti-cheat corrections and outgoing bytes per player.
 *
 *   npx tsx scripts/bench-arena.ts [players=16] [seconds=60] [--hz=30] [--wire=json|bin|binq] [--cull=on|off] [--map=classic]
 *
 * Before/after table (docs/SECURITY.md): `--hz=20 --wire=json --cull=off` is the old behaviour.
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
import { metrics } from '../server/Metrics';
import { traceBlocks } from '../server/Combat';
import { BOT_SPEED, aimAt, arenaPath, follow } from './lib/arenaPath';

const pos = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const opt = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const PLAYERS = Number(pos[0] ?? 16);
const SECONDS = Number(pos[1] ?? 60);
const HZ = Number(opt('hz', '30'));
const WIRE = opt('wire', 'binq');
const CULL = opt('cull', 'on') !== 'off';
const MAP = parseMapId(opt('map', 'classic')) ?? 'classic';

let clock = 1_700_000_000_000;
let kills = 0;
Date.now = () => clock;

const map = getMap(MAP);
let variant = 0;

/** Random open floor cell. */
function randomCell(r: () => number): [number, number] {
  const b = map.bounds;
  for (;;) {
    const x = Math.floor(b.minX + 2 + r() * (b.maxX - b.minX - 4)), z = Math.floor(b.minZ + 2 + r() * (b.maxZ - b.minZ - 4));
    if (map.blockAt(variant, x, ARENA_FLOOR_Y + 1, z) === 0 && map.blockAt(variant, x, ARENA_FLOOR_Y + 2, z) === 0) return [x + 0.5, z + 0.5];
  }
}

let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);

class Sink extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  bytes = 0;
  snapBytes = 0;
  messages = 0;
  me = { id: 0, x: 0, y: 65, z: 0 };
  fresh = false;
  route: [number, number][] = [];
  others = new Map<number, [number, number, number]>();
  teleports = 0;
  send(data: string | ArrayBuffer): void {
    const m = typeof data === 'string' ? JSON.parse(data) as ServerMessage : decodeBinary(data);
    this.bytes += typeof data === 'string' ? data.length : data.byteLength;
    this.messages++;
    if (!m) return;
    if (m.t === 'snap') this.snapBytes += typeof data === 'string' ? data.length : data.byteLength;
    if (m.t === 'kill') kills++;
    if (m.t === 'welcome') { this.me.id = m.id; variant = map.variantFor(m.seed); }
    else if (m.t === 'spawn' || m.t === 'teleport') {
      this.me.x = m.x; this.me.y = m.y; this.me.z = m.z; this.fresh = true; this.route = [];
      if (m.t === 'teleport') this.teleports++;
    } else if (m.t === 'snap') {
      this.others.clear();
      for (const e of m.players) if (e[0] !== this.me.id && !(e[6] & 8)) this.others.set(e[0], [e[1], e[2], e[3]]);
    }
  }
  close(): void { this.readyState = 3; }
  terminate(): void { this.readyState = 3; }
  ping(): void { this.emit('pong'); }
  say(msg: ClientMessage): void { this.emit('message', Buffer.from(JSON.stringify(msg)), false); }
}

const dir = mkdtempSync(join(tmpdir(), 'bunk-bench-'));
const server = new GameServer({
  dataDir: dir, worldName: 'Bench', seed: '1', gameMode: 'survival', motd: '', maxPlayers: 32, quiet: true,
  gameType: 'tdm', scoreLimit: 1000, timeLimitSec: 1800, mapId: MAP, arcadeTickHz: HZ, culling: CULL, binary: WIRE !== 'json',
});
const tick = () => (server as unknown as { tick(): void }).tick();

const bots: Sink[] = [];
for (let i = 0; i < PLAYERS; i++) {
  const ws = new Sink();
  server.accept(ws as unknown as WebSocket);
  ws.say({ t: 'hello', v: PROTOCOL_VERSION, name: `bot${i}`, ...(WIRE !== 'json' ? { bin: true } : {}), ...(WIRE === 'binq' ? { binv: 2 } : {}) });
  bots.push(ws);
}

const dt = 1 / HZ;
const blocks = { getBlock: (x: number, y: number, z: number) => map.blockAt(variant, x, y, z) };
// Warm-up first (10 s), not measured.
for (let t = 0; t < 11; t += dt) { clock += dt * 1000; for (const b of bots) b.say({ t: 'pos', x: b.me.x, y: b.me.y, z: b.me.z, yaw: 0, pitch: 0, flags: 4, held: 0 }); tick(); }
for (const b of bots) { b.bytes = 0; b.snapBytes = 0; b.messages = 0; b.teleports = 0; }
const cheatBefore = [...metrics.cheatEvents.values()].reduce((a, c) => a + c, 0);

const times: number[] = [];
const handleTimes: number[] = [];
let shots = 0;
const steps = Math.round(SECONDS * HZ);
for (let step = 0; step < steps; step++) {
  clock += dt * 1000;
  const h0 = performance.now();
  for (const b of bots) {
    if (b.fresh) b.fresh = false; // the first report after a spawn or correction is that position
    else {
      if (b.route.length === 0) b.route = arenaPath(map, variant, [b.me.x, b.me.z], randomCell(rnd)) ?? [];
      follow(b.me, b.route, BOT_SPEED * dt);
    }
    b.say({ t: 'pos', x: b.me.x, y: b.me.y, z: b.me.z, yaw: 0, pitch: 0, flags: 4, held: 0 });
    let best: [number, number, number] | null = null, bestD = Infinity;
    for (const [, p] of b.others) {
      const d = Math.hypot(p[0] - b.me.x, p[2] - b.me.z);
      if (d > 1 && d < bestD) { bestD = d; best = p; }
    }
    // Fire only with a clear line (a real player does not shoot into walls; shots reveal the shooter).
    const ox = b.me.x, oy = b.me.y + 1.62, oz = b.me.z;
    if (best) {
      const a = aimAt(ox, oy, oz, best[0], best[1] + 1.2, best[2]), d = Math.hypot(best[0] - ox, best[1] + 1.2 - oy, best[2] - oz);
      if (traceBlocks(blocks, ox, oy, oz, a.dx, a.dy, a.dz, d) < d) best = null;
    }
    if (best && step % 3 === 0) {
      b.say({ t: 'fire', slot: 0, ox, oy, oz, ...aimAt(ox, oy, oz, best[0], best[1] + 1.2, best[2]), ads: false });
      shots++;
    }
  }
  const h1 = performance.now();
  tick();
  times.push(performance.now() - h1);
  handleTimes.push(h1 - h0);
}

const stat = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return `mean ${mean.toFixed(3)} ms, p95 ${s[Math.floor(s.length * 0.95)].toFixed(3)} ms, max ${s[s.length - 1].toFixed(3)} ms`;
};
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const bytes = bots.reduce((a, b) => a + b.bytes, 0) / bots.length / SECONDS;
console.log(`${PLAYERS} players on ${MAP}, ${SECONDS} s at ${HZ} Hz, wire ${WIRE}, culling ${CULL ? 'on' : 'off'}; ${shots} fire requests, ${kills / PLAYERS} kills`);
console.log(`tick():                ${stat(times)}`);
console.log(`message handling/tick: ${stat(handleTimes)}  (pos + fire incl. movement validation and hitscan)`);
console.log(`CPU per second: ${((mean(times) + mean(handleTimes)) * HZ).toFixed(2)} ms (${(((mean(times) + mean(handleTimes)) * HZ) / 10).toFixed(2)} % of a core)`);
const snapBytes = bots.reduce((a, b) => a + b.snapBytes, 0) / bots.length / SECONDS;
console.log(`outgoing per player: ${(bytes / 1024).toFixed(2)} KiB/s (${bytes.toFixed(0)} B/s), of which snapshots ${snapBytes.toFixed(0)} B/s; ${(bots[0].messages / SECONDS).toFixed(0)} msg/s`);
console.log(`anti-cheat corrections of honest bots: ${[...metrics.cheatEvents.values()].reduce((a, c) => a + c, 0) - cheatBefore} (teleports ${bots.reduce((a, b) => a + b.teleports, 0)})`);
console.log(`phase at the end: ${(server as unknown as { match: { phase: string } }).match.phase}`);
server.shutdown();
rmSync(dir, { recursive: true, force: true });
process.exit(0);
