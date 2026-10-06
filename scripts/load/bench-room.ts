/**
 * Deterministic CPU cost of survival rooms without the network: drives real GameServer instances with fake
 * sockets and a fake clock (like scripts/bench-arena.ts), 8 players per room at midnight (hostile mobs),
 * one explorer per room walking outward (new chunks) and the rest wandering around spawn.
 * Measures CPU time (process.cpuUsage) per room tick, so other processes on the machine do not skew it.
 *
 *   npx tsx scripts/load/bench-room.ts [rooms=4] [seconds=60] [explorers=1]
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import { PROTOCOL_VERSION, type ClientMessage } from '../../src/net/protocol';
import { GameServer } from '../../server/GameServer';
import type { ServerWorld } from '../../server/ServerWorld';

const ROOMS = Number(process.argv[2] ?? 4);
const SECONDS = Number(process.argv[3] ?? 60);
const EXPLORERS = Number(process.argv[4] ?? 1);
const PLAYERS = 8;

let clock = 1_700_000_000_000;
Date.now = () => clock;

class Sink extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  bytes = 0;
  send(data: string | ArrayBuffer): void { this.bytes += typeof data === 'string' ? data.length : data.byteLength; }
  close(): void { this.readyState = 3; }
  terminate(): void { this.readyState = 3; }
  ping(): void { this.emit('pong'); }
  say(msg: ClientMessage): void { this.emit('message', Buffer.from(JSON.stringify(msg)), false); }
}

interface FakePlayer { ws: Sink; x: number; y: number; z: number; a: number; r: number; explorer: boolean }

const dir = mkdtempSync(join(tmpdir(), 'bunk-bench-room-'));
const rooms: { server: GameServer; players: FakePlayer[]; world: ServerWorld; spawn: { x: number; z: number } }[] = [];
for (let r = 0; r < ROOMS; r++) {
  const server = new GameServer({
    dataDir: join(dir, String(r)), worldName: `Bench ${r}`, seed: `bench-${r}`, gameMode: 'survival', motd: '', maxPlayers: 16, quiet: true, ownerHash: undefined,
  });
  // Stop the server's own timers: the bench calls tick() with the fake clock.
  for (const t of (server as unknown as { timers: NodeJS.Timeout[] }).timers) clearInterval(t);
  const internals = server as unknown as { world: { spawn: { x: number; y: number; z: number }; time: number }; entities: { world: ServerWorld } };
  internals.world.time = 0.75; // midnight
  const spawn = internals.world.spawn;
  const players: FakePlayer[] = [];
  for (let i = 0; i < PLAYERS; i++) {
    const ws = new Sink();
    server.accept(ws as unknown as WebSocket);
    ws.say({ t: 'hello', v: PROTOCOL_VERSION, name: `bench${r}_${i}`, bin: true });
    players.push({ ws, x: spawn.x, y: spawn.y, z: spawn.z, a: (i / PLAYERS) * Math.PI * 2, r: 4 + i * 2, explorer: i < EXPLORERS });
  }
  rooms.push({ server, players, world: internals.entities.world, spawn });
}

const tick = (s: GameServer) => (s as unknown as { tick(): void }).tick();
const cpuMs = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
const perSecond: number[] = [];
let cpuTotal = 0;
for (let step = 0; step < SECONDS * 20; step++) {
  clock += 50;
  const c0 = cpuMs();
  for (const room of rooms) {
    for (const p of room.players) {
      if (p.explorer) {
        p.x += 5.6 * 0.05; // sprinting east
      } else {
        p.a += (4.3 * 0.05) / p.r; // walking a circle around spawn
        p.x = room.spawn.x + Math.cos(p.a) * p.r;
        p.z = room.spawn.z + Math.sin(p.a) * p.r;
      }
      const g = room.world.surfaceY(Math.floor(p.x), Math.floor(p.z));
      if (g >= 0) p.y = g + 1;
      p.ws.say({ t: 'pos', x: p.x, y: p.y, z: p.z, yaw: p.a, pitch: 0, flags: 4, held: 0 });
    }
    tick(room.server);
  }
  const dt = cpuMs() - c0;
  cpuTotal += dt;
  if (step % 20 === 19) perSecond.push(cpuTotal);
}
const secs = perSecond.map((v, i) => v - (perSecond[i - 1] ?? 0));
const sorted = [...secs].sort((a, b) => a - b);
const mobs = rooms.reduce((n, r) => n + (r.server as unknown as { entities: { mobCount: number } }).entities.mobCount, 0);
console.log(`${ROOMS} rooms × ${PLAYERS} players, ${SECONDS} s simulated, ${EXPLORERS} explorer(s) per room, midnight`);
console.log(`CPU per simulated second (all rooms): mean ${(cpuTotal / SECONDS).toFixed(1)} ms, median ${sorted[sorted.length >> 1].toFixed(1)} ms, max ${sorted[sorted.length - 1].toFixed(1)} ms`);
console.log(`CPU per room tick: ${(cpuTotal / (SECONDS * 20 * ROOMS)).toFixed(3)} ms; first 10 s ${(secs.slice(0, 10).reduce((a, b) => a + b, 0) / (200 * ROOMS)).toFixed(3)} ms, last 30 s ${(secs.slice(-30).reduce((a, b) => a + b, 0) / (600 * ROOMS)).toFixed(3)} ms`);
console.log(`=> one core runs about ${Math.floor(1000 / (cpuTotal / SECONDS / ROOMS))} such rooms at 100 % (no network, no GC of other work)`);
console.log(`mobs alive at the end: ${mobs} (${(mobs / ROOMS).toFixed(1)} per room); out ${(rooms[0].players[1].ws.bytes / SECONDS / 1024).toFixed(1)} KiB/s per player`);
for (const r of rooms) r.server.shutdown();
rmSync(dir, { recursive: true, force: true });
process.exit(0);
