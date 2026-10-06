/**
 * Multiplayer QA: load and network numbers for one survival game with 4 players at night.
 * Starts its own server, joins 4 bots (binary snap/ent like the browser), walks them around at
 * 4.3 blocks/s with 20 Hz position updates, sets midnight and measures:
 *   - mobs alive near the players, server CPU (process_cpu_seconds_total), tick p50/p99,
 *   - bytes per second per player and in total, message rates,
 *   - snapshot rate and inter-arrival jitter as a client sees it.
 *
 *   npx tsx scripts/qa/mp-load.ts [warmupSec=60] [measureSec=30]
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NET_MOB_KINDS } from '../../src/net/protocol';
import { Bot, createRoom, info, metrics, sleep, startServer } from './lib';

const WARMUP = Number(process.argv[2] ?? 60), MEASURE = Number(process.argv[3] ?? 30);
const PORT = Number(process.env.QA_PORT ?? 3473);
const DIR = process.env.QA_DIR ?? join(tmpdir(), `bunkqa-load-${Date.now()}`);

const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0; };
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);

async function window(label: string, bots: Bot[], base: string, seconds: number): Promise<void> {
  const m0 = await metrics(base);
  const t0 = performance.now();
  const b0 = bots.map((b) => b.bytesIn);
  await sleep(seconds * 1000);
  const m1 = await metrics(base);
  const dt = (performance.now() - t0) / 1000;
  const cpu = (m1.process_cpu_seconds_total - m0.process_cpu_seconds_total) / dt;
  const sent = (m1.bunkcraft_ws_bytes_sent_total - m0.bunkcraft_ws_bytes_sent_total) / dt;
  const recv = (m1.bunkcraft_ws_bytes_received_total - m0.bunkcraft_ws_bytes_received_total) / dt;
  const msgs = (m1.bunkcraft_ws_messages_sent_total - m0.bunkcraft_ws_messages_sent_total) / dt;
  const ent = bots[0].of('ent', t0).at(-1);
  const kinds: Record<string, number> = {};
  for (const e of ent?.m ?? []) kinds[NET_MOB_KINDS[e[1]]] = (kinds[NET_MOB_KINDS[e[1]]] ?? 0) + 1;
  const allMobs = new Set<number>();
  for (const b of bots) for (const e of b.of('ent').at(-1)?.m ?? []) allMobs.add(e[0]);
  info(`${label}: mobs`, `${allMobs.size} distinct mobs around the 4 players (player 1 sees ${JSON.stringify(kinds)})`);
  info(`${label}: server CPU`, `${(cpu * 100).toFixed(1)} % of one core; tick p50 ${(m1['bunkcraft_tick_duration_seconds{quantile="0.5"}'] * 1000).toFixed(2)} ms, p99 ${(m1['bunkcraft_tick_duration_seconds{quantile="0.99"}'] * 1000).toFixed(2)} ms (budget 50 ms); RSS ${(m1.process_resident_memory_bytes / 1e6).toFixed(0)} MB`);
  info(`${label}: bandwidth`, `server out ${(sent / 1024).toFixed(1)} KiB/s (${msgs.toFixed(0)} msg/s), in ${(recv / 1024).toFixed(1)} KiB/s; per player in: ${bots.map((b, i) => ((b.bytesIn - b0[i]) / dt / 1024).toFixed(1)).join(' / ')} KiB/s`);
  const perType: Record<string, number> = {};
  for (const m of bots[0].log) if (m.at >= t0) perType[m.t] = (perType[m.t] ?? 0) + m.bytes;
  info(`${label}: player 1 bytes by message`, Object.entries(perType).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(v / dt / 1024).toFixed(2)} KiB/s`).join(', '));
  // Snapshot cadence as a client receives it.
  const snaps = bots[0].of('snap', t0).map((s) => s.at);
  const gaps = snaps.slice(1).map((t, i) => t - snaps[i]);
  info(`${label}: snapshot cadence`, `${(snaps.length / dt).toFixed(1)}/s; gap mean ${mean(gaps).toFixed(1)} ms, p50 ${pct(gaps, 0.5).toFixed(1)}, p95 ${pct(gaps, 0.95).toFixed(1)}, p99 ${pct(gaps, 0.99).toFixed(1)}, max ${Math.max(...gaps).toFixed(1)} ms`);
  const ents = bots[0].of('ent', t0).map((s) => s.at);
  const eg = ents.slice(1).map((t, i) => t - ents[i]);
  info(`${label}: entity cadence`, `${(ents.length / dt).toFixed(1)}/s; gap p50 ${pct(eg, 0.5).toFixed(1)} ms, p99 ${pct(eg, 0.99).toFixed(1)} ms`);
}

async function main(): Promise<void> {
  const srv = await startServer(PORT, DIR);
  const r = await createRoom(srv.base, { name: 'Load', gameMode: 'survival', seed: 'qa-load' });
  const bots: Bot[] = [];
  for (let i = 0; i < 4; i++) {
    const b = new Bot(`Loader${i}`);
    await b.connect(srv.base, r.code, i === 0 ? { owner: r.ownerToken, bin: true } : { bin: true });
    bots.push(b);
  }
  const s = bots[0].welcome.spawn;
  // Each walks a circle of radius 12 around its own corner, 4.3 blocks/s (walking speed), 20 Hz updates.
  const corners = [[0, 0], [24, 0], [0, 24], [24, 24]];
  const start = performance.now();
  const timer = setInterval(() => {
    const t = (performance.now() - start) / 1000;
    bots.forEach((b, i) => {
      const a = t * (4.3 / 12) + i;
      b.yaw = a;
      b.pos(s.x + corners[i][0] + Math.cos(a) * 12, s.y, s.z + corners[i][1] + Math.sin(a) * 12, 0);
    });
  }, 50);
  await sleep(5000);
  await window('day, 4 players', bots, srv.base, 15);
  bots[0].chat('/time set midnight');
  console.log(`(night: ${WARMUP} s for mobs to spawn)`);
  await sleep(WARMUP * 1000);
  await window('midnight, 4 players', bots, srv.base, MEASURE);
  clearInterval(timer);
  for (const b of bots) b.close();
  await srv.stop();
  process.exit(0);
}

void main();
