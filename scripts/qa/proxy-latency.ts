/**
 * What the control plane's WebSocket proxy (server/match/WsProxy.ts) adds to a round trip, on one host.
 *
 *   node --import tsx scripts/qa/proxy-latency.ts [rounds=2000] [bytes=200]
 *
 * An echo server stands in for the match runner; the same client measures round trips directly and through the bridge
 * (in this process, like the control plane). Prints p50/p99 of both and the difference.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { bridge } from '../../server/match/WsProxy';

const rounds = Number(process.argv[2] ?? 2000);
const bytes = Number(process.argv[3] ?? 200);

async function main(): Promise<void> {
  const echo = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  echo.on('connection', (ws) => ws.on('message', (d, bin) => ws.send(d, { binary: bin })));
  await new Promise((r) => echo.once('listening', r));
  const upUrl = `ws://127.0.0.1:${(echo.address() as AddressInfo).port}`;
  const http = createServer();
  const front = new WebSocketServer({ server: http });
  front.on('connection', (client) => bridge(client, {
    connect: async () => {
      const u = new WebSocket(upUrl, { autoPong: false, perMessageDeflate: false });
      await new Promise((r, j) => { u.once('open', r); u.once('error', j); });
      return { upstream: u };
    },
  }));
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  const frontUrl = `ws://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const payload = Buffer.alloc(bytes, 7);

  const measure = async (url: string): Promise<number[]> => {
    const ws = new WebSocket(url, { perMessageDeflate: false });
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
    const next = () => new Promise<void>((r) => ws.once('message', () => r()));
    ws.send('{"t":"hello"}');
    await next();
    for (let i = 0; i < 200; i++) { ws.send(payload); await next(); } // warm-up (JIT)
    const out: number[] = [];
    for (let i = 0; i < rounds; i++) {
      const t0 = process.hrtime.bigint();
      ws.send(payload);
      await next();
      out.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    ws.close();
    return out.sort((a, b) => a - b);
  };
  const q = (a: number[], p: number) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
  const direct = await measure(upUrl);
  const proxied = await measure(frontUrl);
  const fmt = (v: number) => Math.round(v * 1000) / 1000;
  console.log(JSON.stringify({
    rounds, bytes,
    directMs: { p50: fmt(q(direct, 0.5)), p99: fmt(q(direct, 0.99)) },
    proxiedMs: { p50: fmt(q(proxied, 0.5)), p99: fmt(q(proxied, 0.99)) },
    addedMs: { p50: fmt(q(proxied, 0.5) - q(direct, 0.5)), p99: fmt(q(proxied, 0.99) - q(direct, 0.99)) },
  }));
  front.close();
  http.close();
  echo.close();
}

void main();
