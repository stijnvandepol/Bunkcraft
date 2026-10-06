/**
 * Deterministic CPU cost of survival rooms without the network: drives real GameServer instances with fake
 * sockets and a fake clock (like scripts/bench-arena.ts), 8 players per room at midnight (hostile mobs),
 * one explorer per room walking outward (new chunks) and the rest wandering around spawn.
 * Measures CPU time (process.cpuUsage) per room tick, so other processes on the machine do not skew it.
 *
 *   npx tsx scripts/load/bench-room.ts [rooms=4] [seconds=60] [explorers=1] [--warmup s] [--spread blocks]
 *
 * --spread n: the non-explorers wander around their own points n blocks apart instead of all around spawn, so every
 *             player has its own mob cap area (the full hostile cap, many more mobs per room).
 * --warmup s: simulated seconds before the steady-state statistics start (chunks around the players generate
 *             synchronously here, which dominates the first seconds).
 *
 * Besides the averages it prints the steady-state distribution of the main-thread CPU time per room tick
 * (p50/p99/max) and the time per tick phase (world, blocks, spawn, mobs, other, snapshots).
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import { PROTOCOL_VERSION, type ClientMessage } from '../../src/net/protocol';
import { GameServer } from '../../server/GameServer';
import type { ServerEntities } from '../../server/ServerEntities';
import type { ServerWorld } from '../../server/ServerWorld';
import { TICK_PHASES } from '../../server/TickPhases';
import { pathStats } from '../../src/entities/ai/Pathfinder';
import { EntityManager } from '../../src/entities/EntityManager';

const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !(all[i - 1] ?? '').startsWith('--'));
const flag = (name: string, def: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : def;
};
const ROOMS = Number(positional[0] ?? 4);
const SECONDS = Number(positional[1] ?? 60);
const EXPLORERS = Number(positional[2] ?? 1);
const WARMUP = flag('warmup', 0);
const SPREAD = flag('spread', 0);
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

interface FakePlayer { ws: Sink; x: number; y: number; z: number; a: number; r: number; cx: number; cz: number; explorer: boolean }

const dir = mkdtempSync(join(tmpdir(), 'bunk-bench-room-'));
const rooms: { server: GameServer; players: FakePlayer[]; world: ServerWorld; entities: ServerEntities; spawn: { x: number; z: number } }[] = [];
for (let r = 0; r < ROOMS; r++) {
  const server = new GameServer({
    dataDir: join(dir, String(r)), worldName: `Bench ${r}`, seed: `bench-${r}`, gameMode: 'survival', motd: '', maxPlayers: 16, quiet: true, ownerHash: undefined,
  });
  // Stop the server's own timers: the bench calls tick() with the fake clock.
  for (const t of (server as unknown as { timers: NodeJS.Timeout[] }).timers) clearInterval(t);
  const internals = server as unknown as { world: { spawn: { x: number; y: number; z: number }; time: number }; entities: ServerEntities };
  internals.world.time = 0.75; // midnight
  const spawn = internals.world.spawn;
  const players: FakePlayer[] = [];
  for (let i = 0; i < PLAYERS; i++) {
    const ws = new Sink();
    server.accept(ws as unknown as WebSocket);
    ws.say({ t: 'hello', v: PROTOCOL_VERSION, name: `bench${r}_${i}`, bin: true });
    // Spread: the players stand on a ring of points SPREAD blocks apart around spawn.
    const ring = (i / PLAYERS) * Math.PI * 2;
    const ringR = SPREAD > 0 ? SPREAD / (2 * Math.sin(Math.PI / PLAYERS)) : 0;
    const cx = spawn.x + Math.cos(ring) * ringR, cz = spawn.z + Math.sin(ring) * ringR;
    players.push({ ws, x: cx, y: spawn.y, z: cz, a: ring, r: 4 + i * 2, cx, cz, explorer: i < EXPLORERS });
  }
  rooms.push({ server, players, world: internals.entities.world, entities: internals.entities, spawn });
}

const tick = (s: GameServer) => (s as unknown as { tick(): void }).tick();
const cpuMs = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
const threadCpu = (process as { threadCpuUsage?: () => NodeJS.CpuUsage }).threadCpuUsage;
const threadMs = threadCpu ? () => { const u = threadCpu.call(process); return (u.user + u.system) / 1000; } : cpuMs;
// Phase timings in CPU time too (a busy machine would otherwise smear its waiting over the phases).
EntityManager.clock = threadMs;
const perSecond: number[] = [];
const steadyTicks: number[] = [];
const phaseTotals: Record<string, number> = Object.fromEntries(TICK_PHASES.map((k) => [k, 0]));
const phaseTicks: Record<string, number[]> = Object.fromEntries(TICK_PHASES.map((k) => [k, []]));
let cpuTotal = 0;
let paths0 = 0, nodes0 = 0, deferred0 = 0;
const warmupSteps = WARMUP * 20;
for (let step = 0; step < (SECONDS + WARMUP) * 20; step++) {
  clock += 50;
  const steady = step >= warmupSteps;
  if (step === warmupSteps) { paths0 = pathStats.searches; nodes0 = pathStats.nodes; deferred0 = pathStats.deferred; }
  const c0 = cpuMs();
  for (const room of rooms) {
    for (const p of room.players) {
      if (p.explorer) {
        p.x += 5.6 * 0.05; // sprinting east
      } else {
        p.a += (4.3 * 0.05) / p.r; // walking a circle around its point
        p.x = (SPREAD > 0 ? p.cx : room.spawn.x) + Math.cos(p.a) * p.r;
        p.z = (SPREAD > 0 ? p.cz : room.spawn.z) + Math.sin(p.a) * p.r;
      }
      const g = room.world.surfaceY(Math.floor(p.x), Math.floor(p.z));
      if (g >= 0) p.y = g + 1;
      p.ws.say({ t: 'pos', x: p.x, y: p.y, z: p.z, yaw: p.a, pitch: 0, flags: 4, held: 0 });
    }
    const t0 = threadMs();
    tick(room.server);
    if (steady) {
      steadyTicks.push(threadMs() - t0);
      const ph = room.entities.phaseMs;
      for (const k of TICK_PHASES) {
        phaseTotals[k] += ph[k];
        phaseTicks[k].push(ph[k]);
      }
    }
  }
  const dt = cpuMs() - c0;
  if (step >= warmupSteps) {
    cpuTotal += dt;
    if ((step - warmupSteps) % 20 === 19) perSecond.push(cpuTotal);
  }
}
const secs = perSecond.map((v, i) => v - (perSecond[i - 1] ?? 0));
const sorted = [...secs].sort((a, b) => a - b);
const mobs = rooms.reduce((n, r) => n + r.entities.mobCount, 0);
console.log(`${ROOMS} rooms × ${PLAYERS} players, ${SECONDS} s simulated after ${WARMUP} s warm-up, ${EXPLORERS} explorer(s) per room, midnight${SPREAD ? `, players ${SPREAD} blocks apart` : ''}`);
console.log(`CPU per simulated second (all rooms): mean ${(cpuTotal / SECONDS).toFixed(1)} ms, median ${sorted[sorted.length >> 1].toFixed(1)} ms, max ${sorted[sorted.length - 1].toFixed(1)} ms`);
console.log(`CPU per room tick: ${(cpuTotal / (SECONDS * 20 * ROOMS)).toFixed(3)} ms; first 10 s ${(secs.slice(0, 10).reduce((a, b) => a + b, 0) / (200 * ROOMS)).toFixed(3)} ms, last 30 s ${(secs.slice(-30).reduce((a, b) => a + b, 0) / (600 * ROOMS)).toFixed(3)} ms`);
console.log(`=> one core runs about ${Math.floor(1000 / (cpuTotal / SECONDS / ROOMS))} such rooms at 100 % (no network, no GC of other work)`);
console.log(`mobs alive at the end: ${mobs} (${(mobs / ROOMS).toFixed(1)} per room); out ${(rooms[0].players[1].ws.bytes / (SECONDS + WARMUP) / 1024).toFixed(1)} KiB/s per player`);
const st = [...steadyTicks].sort((a, b) => a - b);
const q = (f: number) => st[Math.min(st.length - 1, Math.floor(f * st.length))];
const n = steadyTicks.length;
console.log(`room tick CPU (main thread): p50 ${q(0.5).toFixed(3)} p99 ${q(0.99).toFixed(3)} p99.9 ${q(0.999).toFixed(3)} max ${st[n - 1].toFixed(3)} ms over ${n} ticks`);
const pq = (k: string, f: number) => { const a = phaseTicks[k].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(f * a.length))]; };
console.log(`phases, mean / p99 / max ms per room tick (CPU): ${TICK_PHASES.map((k) => `${k} ${(phaseTotals[k] / n).toFixed(3)}/${pq(k, 0.99).toFixed(2)}/${pq(k, 1).toFixed(2)}`).join(', ')}`);
console.log(`path searches: ${((pathStats.searches - paths0) / (SECONDS * ROOMS)).toFixed(1)}/s per room, ${((pathStats.nodes - nodes0) / Math.max(1, pathStats.searches - paths0)).toFixed(0)} nodes each, ${((pathStats.deferred - deferred0) / (SECONDS * ROOMS)).toFixed(1)}/s per room deferred to a later tick`);
for (const r of rooms) r.server.shutdown();
rmSync(dir, { recursive: true, force: true });
process.exit(0);
