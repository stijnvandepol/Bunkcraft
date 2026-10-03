/**
 * Server-side cost of snapshot fan-out: one Node process (ws) broadcasting a 8-player snapshot at 20 Hz to
 * N sockets, with and without permessage-deflate. Clients run in a worker thread so we measure only the server's
 * CPU (process.cpuUsage of the main thread's process minus the worker is not separable, so we use
 * `performance.eventLoopUtilization()` of the main thread, which is the server's loop).
 *
 *   npx tsx scripts/experiments/bench-ws-fanout.ts
 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { WebSocket, WebSocketServer } from 'ws';

const PORT = 3911;

if (!isMainThread) {
  const { n } = workerData as { n: number };
  let got = 0;
  for (let i = 0; i < n; i++) {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    ws.on('message', () => { got++; });
  }
  parentPort!.postMessage('ready');
  setInterval(() => parentPort!.postMessage(got), 1000);
} else {
  const players = 8;
  const snap = JSON.stringify({ t: 'snap', players: Array.from({ length: players }, (_, i) => [i + 1, 123.456 + i, 64.25, -88.125, 1.5707, -0.3, 5, 261]) });
  const run = async (n: number, deflate: boolean): Promise<void> => {
    const wss = new WebSocketServer({ port: PORT, perMessageDeflate: deflate ? { threshold: 0 } : false });
    const clients = new Set<import('ws').WebSocket>();
    wss.on('connection', (ws) => clients.add(ws));
    const w = new Worker(new URL(import.meta.url), { workerData: { n }, execArgv: ['--import', 'tsx'] });
    await new Promise<void>((r) => w.once('message', () => r()));
    while (clients.size < n) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 300));
    const elu0 = performance.eventLoopUtilization();
    const cpu0 = process.cpuUsage();
    let ticks = 0;
    const t0 = performance.now();
    await new Promise<void>((res) => {
      const iv = setInterval(() => {
        for (const c of clients) c.send(snap);
        if (++ticks >= 100) { clearInterval(iv); res(); }
      }, 50);
    });
    const dt = performance.now() - t0;
    const cpu = process.cpuUsage(cpu0);
    const elu = performance.eventLoopUtilization(elu0);
    console.log(`${String(n).padStart(4)} sockets, deflate ${deflate ? 'on ' : 'off'}: event loop ${(elu.utilization * 100).toFixed(1)}% busy, process CPU ${(((cpu.user + cpu.system) / 1000) / dt * 100).toFixed(1)}% of a core (incl. worker clients), ${(((cpu.user + cpu.system) / 1000) / ticks / n * 1000).toFixed(1)} us per send+receive`);
    await w.terminate();
    for (const c of clients) c.terminate();
    await new Promise<void>((r) => wss.close(() => r()));
    await new Promise((r) => setTimeout(r, 300));
  };
  for (const n of [16, 64, 256]) {
    await run(n, false);
    await run(n, true);
  }
  process.exit(0);
}
