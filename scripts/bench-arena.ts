/**
 * Server cost of an arcade game: 16 simulated players in one team deathmatch, all strafing and
 * firing their rifle at the nearest enemy, driven through the real GameServer with fake sockets
 * and a fake clock (so the numbers are CPU time per 20 Hz tick, without the network).
 *
 *   npx tsx scripts/bench-arena.ts [players=16] [seconds=60]
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '../src/net/protocol';
import { GameServer } from '../server/GameServer';

const PLAYERS = Number(process.argv[2] ?? 16);
const SECONDS = Number(process.argv[3] ?? 60);

let clock = 1_700_000_000_000;
let kills = 0;
Date.now = () => clock;

class Sink extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  bytes = 0;
  messages = 0;
  me = { id: 0, x: 0, y: 65, z: 0 };
  fresh = false;
  target: [number, number] = [0, 0];
  others = new Map<number, [number, number, number]>();
  send(data: string): void {
    this.bytes += data.length;
    this.messages++;
    const m = JSON.parse(data) as ServerMessage;
    if (m.t === 'kill') kills++;
    if (m.t === 'welcome') this.me.id = m.id;
    else if (m.t === 'spawn') { this.me.x = m.x; this.me.y = m.y; this.me.z = m.z; this.fresh = true; }
    else if (m.t === 'snap') for (const e of m.players) if (e[0] !== this.me.id) this.others.set(e[0], [e[1], e[2], e[3]]);
  }
  close(): void { this.readyState = 3; }
  ping(): void { this.emit('pong'); }
  say(msg: ClientMessage): void { this.emit('message', Buffer.from(JSON.stringify(msg)), false); }
}

const dir = mkdtempSync(join(tmpdir(), 'bunk-bench-'));
const server = new GameServer({
  dataDir: dir, worldName: 'Bench', seed: '1', gameMode: 'survival', motd: '', maxPlayers: 32, quiet: true,
  gameType: 'tdm', scoreLimit: 100, timeLimitSec: 1800,
});
const tick = () => (server as unknown as { tick(): void }).tick();

const bots: Sink[] = [];
for (let i = 0; i < PLAYERS; i++) {
  const ws = new Sink();
  server.accept(ws as unknown as WebSocket);
  ws.say({ t: 'hello', v: PROTOCOL_VERSION, name: `bot${i}` });
  // Everybody gathers on the centre platform (open, short lines of sight): the worst case for hitscan.
  const a = (i / PLAYERS) * Math.PI * 2;
  ws.target = [Math.cos(a) * 5.5, Math.sin(a) * 5.5];
  bots.push(ws);
}

const times: number[] = [];
const handleTimes: number[] = [];
let shots = 0;
for (let step = 0; step < SECONDS * 20; step++) {
  clock += 50;
  const h0 = performance.now();
  for (const b of bots) {
    // Position update (20 Hz) and fire at the nearest other player.
    if (b.fresh) b.fresh = false; // the first position after a spawn is the spawn itself
    else {
      const dx = b.target[0] - b.me.x, dz = b.target[1] - b.me.z, d = Math.hypot(dx, dz);
      const k = d > 5 ? 5 / d : 1;
      b.me.x += dx * k; b.me.z += dz * k; b.me.y = 68;
    }
    b.say({ t: 'pos', x: b.me.x, y: b.me.y, z: b.me.z, yaw: 0, pitch: 0, flags: 4, held: 0 });
    let best: [number, number, number] | null = null, bestD = Infinity;
    for (const [, p] of b.others) {
      const d = Math.hypot(p[0] - b.me.x, p[2] - b.me.z);
      if (d > 1 && d < bestD) { bestD = d; best = p; }
    }
    if (best && step % 2 === 0) {
      const ox = b.me.x, oy = b.me.y + 1.62, oz = b.me.z;
      b.say({ t: 'fire', slot: 0, ox, oy, oz, dx: best[0] - ox, dy: best[1] + 1.2 - oy, dz: best[2] - oz, ads: false });
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
console.log(`${PLAYERS} players, ${SECONDS} s simulated, ${shots} fire requests`);
console.log(`kills seen by all bots: ${kills / PLAYERS}`);
console.log(`tick():              ${stat(times)}`);
console.log(`message handling/tick: ${stat(handleTimes)}  (16 pos + fire messages incl. hitscan)`);
console.log(`budget per tick: 50 ms; used about ${(((times.reduce((a, b) => a + b, 0) + handleTimes.reduce((a, b) => a + b, 0)) / times.length) / 50 * 100).toFixed(2)} %`);
console.log(`outgoing per player: ${(bots[0].bytes / SECONDS / 1024).toFixed(1)} KiB/s, ${(bots[0].messages / SECONDS).toFixed(0)} msg/s`);
server.shutdown();
rmSync(dir, { recursive: true, force: true });
process.exit(0);
